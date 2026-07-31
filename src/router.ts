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
import type { Runtime } from "./runtime.js";
import { LaunchState } from "./venues/shroom/abi.js";

export type ResolvedTarget =
  | { venue: "curve"; launch: ApiLaunch; launchId: bigint }
  | { venue: "choice"; tokenId: string; launch?: ApiLaunch }
  | { venue: "ambiguous"; candidates: unknown[] };

const CURVE_STATES = new Set<number>([
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
  const pad = await rt.pump.listLaunches({ q, limit: 5 }).catch(() => ({ items: [] as ApiLaunch[] }));
  if (pad.items.length === 1) return routeLaunch(pad.items[0]!);
  if (pad.items.length > 1) {
    // Prefer an exact symbol match in the metadata; otherwise surface choices.
    return {
      venue: "ambiguous",
      candidates: pad.items.map((l) => ({
        launchId: l.id,
        token: l.token,
        state: l.state,
        metadataURI: l.metadataURI.slice(0, 120),
      })),
    };
  }

  const choiceHit = (await rt.choiceApi.resolve(q, "token").catch(() => null)) as {
    match?: { id?: string; token_id?: string; denom?: string };
    alternatives?: unknown[];
  } | null;
  const id = choiceHit?.match?.id ?? choiceHit?.match?.token_id ?? choiceHit?.match?.denom;
  if (id) return { venue: "choice", tokenId: String(id) };

  throw new ToolError(
    "not_found",
    `could not resolve "${query}" to a SHROOM launch or Choice token`,
    "try a launch id, token address or bank denom",
  );
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
