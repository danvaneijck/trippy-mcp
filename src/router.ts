/**
 * Token resolution + venue routing.
 *
 * A user-facing token reference can be: a SHROOM launch id ("123"), a launch
 * token 0x address, a symbol/name, or a Choice token id (bank denom / CW20).
 * The router resolves it and decides the venue:
 *  - launchpad launch in Trading(1..3) → curve (SHROOM venue)
 *  - launchpad launch Graduated(4)     → Choice (its bank denom)
 *  - anything else                     → Choice resolve
 */

import type { ApiLaunch } from "./api/pump.js";
import { ToolError } from "./errors.js";
import { decodeMetadataUri } from "./metadata.js";
import type { Runtime } from "./runtime.js";
import { LaunchState } from "./venues/shroom/abi.js";

export type ResolvedTarget =
  | { venue: "curve"; launch: ApiLaunch; launchId: bigint }
  | { venue: "choice"; tokenId: string; launch?: ApiLaunch }
  | { venue: "ambiguous"; candidates: unknown[] };

export const CURVE_STATES = new Set<number>([
  LaunchState.Trading,
  LaunchState.CurveFilled,
  LaunchState.PendingSettlement,
  LaunchState.Reserved,
]);

export async function resolveToken(rt: Runtime, query: string): Promise<ResolvedTarget> {
  const q = query.trim();

  // Bank denoms / CW20 addresses are unambiguous Choice ids.
  if (/^(factory\/|peggy0x|ibc\/|erc20:)/i.test(q) || /^inj1[a-z0-9]{38,58}$/.test(q) || q === "inj") {
    return { venue: "choice", tokenId: q };
  }

  // Numeric → launch id.
  if (/^\d+$/.test(q)) {
    const launch = await rt.pump.getLaunch(q).catch(() => null);
    if (!launch) throw new ToolError("not_found", `no SHROOM launch #${q}`);
    return routeLaunch(launch);
  }

  // 0x address → launch token first, else Choice (peggy/EVM-native tokens).
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const hit = await rt.pump.listLaunches({ q, limit: 3 }).catch(() => ({ items: [] as ApiLaunch[] }));
    const exact = hit.items.find((l) => l.token.toLowerCase() === q.toLowerCase());
    if (exact) return routeLaunch(exact);
    return { venue: "choice", tokenId: q };
  }

  // Symbol/name — search the launchpad, then Choice.
  //
  // A launchpad hit is a SUBSTRING match over name/description, so "SHROOM" matches the
  // unrelated "ANSHROOM" launch. buy/sell/quote all resolve through here, so a fuzzy
  // launch must never outrank a token whose symbol IS the query — that spends funds on a
  // different asset than the caller named. Exact symbol wins on either venue; a merely
  // fuzzy launch is taken only when Choice knows nothing better.
  const wanted = q.toLowerCase();
  const pad = await rt.pump.listLaunches({ q, limit: 5 }).catch(() => ({ items: [] as ApiLaunch[] }));
  const padExact = pad.items.filter((l) => launchSymbol(l)?.toLowerCase() === wanted);
  if (padExact.length === 1) return routeLaunch(padExact[0]!);
  if (padExact.length > 1) return { venue: "ambiguous", candidates: padExact.map(launchCandidate) };

  // Choice resolve payload: {q, matches: [{type, address, symbol, name, price_usd}], ambiguous}
  const choiceHit = (await rt.choiceApi.resolve(q, "token").catch(() => null)) as {
    matches?: { address?: string; denom?: string; symbol?: string; name?: string }[];
    ambiguous?: boolean;
  } | null;
  const matches = choiceHit?.matches ?? [];
  const choiceExact = matches.filter((m) => m.symbol?.trim().toLowerCase() === wanted);
  if (choiceExact.length === 1) {
    const hit = choiceExact[0]!.address ?? choiceExact[0]!.denom;
    if (hit) return { venue: "choice", tokenId: String(hit) };
  }

  // Nothing matched the symbol outright. Surface every near-miss rather than picking one.
  const nearMisses = [...pad.items.map(launchCandidate), ...matches.slice(0, 5).map(choiceCandidate)];
  if (nearMisses.length > 1) return { venue: "ambiguous", candidates: nearMisses };
  if (pad.items.length === 1) return routeLaunch(pad.items[0]!);
  const id = matches[0]?.address ?? matches[0]?.denom;
  if (id) return { venue: "choice", tokenId: String(id) };

  throw new ToolError(
    "not_found",
    `could not resolve "${query}" to a SHROOM launch or Choice token`,
    "try a launch id, token address or bank denom",
  );
}

/** A launch's declared symbol. The metadata is inline base64 — no network call. */
function launchSymbol(launch: ApiLaunch): string | undefined {
  return decodeMetadataUri(launch.metadataURI)?.symbol?.trim();
}

/** Launch shown in an `ambiguous` list — symbol/name, not a truncated data: URI. */
function launchCandidate(launch: ApiLaunch): Record<string, unknown> {
  const meta = decodeMetadataUri(launch.metadataURI);
  return {
    venue: "curve",
    launchId: launch.id,
    token: launch.token,
    state: launch.state,
    symbol: meta?.symbol,
    name: meta?.name,
  };
}

function choiceCandidate(m: { address?: string; denom?: string; symbol?: string; name?: string }): Record<string, unknown> {
  return { venue: "choice", tokenId: m.address ?? m.denom, symbol: m.symbol, name: m.name };
}

function routeLaunch(launch: ApiLaunch): ResolvedTarget {
  if (CURVE_STATES.has(launch.state)) {
    return { venue: "curve", launch, launchId: BigInt(launch.id) };
  }
  if (launch.state === LaunchState.Graduated) {
    const denom = launch.graduatedPoolDenom ?? launch.bankDenom;
    if (denom) return { venue: "choice", tokenId: denom, launch };
  }
  // Cancelled/refunded/etc — still return curve so tools can explain why.
  return { venue: "curve", launch, launchId: BigInt(launch.id) };
}
