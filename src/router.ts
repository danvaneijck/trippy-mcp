/**
 * Token resolution + venue routing.
 *
 * A user-facing token reference can be: a SHROOM launch id ("123"), a launch
 * token 0x address, a symbol/name, or a Choice token id (bank denom / CW20).
 * The router resolves it and decides the venue:
 *  - launchpad launch in Trading(1..3)            → curve (SHROOM venue)
 *  - Graduated(4) on the ATOMIC core              → Choice v2 (EVM pool)
 *  - Graduated(4) on an older core                → Choice v1 (its bank denom)
 *  - a plain 0x ERC20                             → whichever venue lists it
 *  - bank denoms / CW20 contracts                 → Choice v1
 *  - anything else                                → Choice resolve
 *
 * A token with liquidity on BOTH Choice venues carries the other one as an
 * alternative (`v2Token` / `v1TokenId`), and the trade tools quote both and
 * take the better output (`pickBetterQuote`).
 */

import { getAddress, type Address } from "viem";

import { asApiLaunchId, type ApiLaunch } from "./api/pump.js";
import type { V2Pool } from "./api/choiceV2.js";
import { ToolError } from "./errors.js";
import { decodeMetadataUri } from "./metadata.js";
import type { Runtime } from "./runtime.js";
import { LaunchState } from "./venues/shroom/abi.js";

export type ResolvedTarget =
  | { venue: "curve"; launch: ApiLaunch; launchId: bigint }
  /** `v2Token`: the same asset also has a Choice v2 pool against wINJ. */
  | { venue: "choice"; tokenId: string; launch?: ApiLaunch; v2Token?: Address }
  /** `v1TokenId`: the same asset is also listed on Choice v1. */
  | { venue: "choiceV2"; token: Address; launch?: ApiLaunch; v1TokenId?: string }
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
    // A bare number from a caller means the id the tools report, which is the
    // surrogate — the only launch id any user-facing surface ever prints.
    const launch = await rt.pump.getLaunch(asApiLaunchId(q)).catch(() => null);
    if (!launch) throw new ToolError("not_found", `no SHROOM launch #${q}`);
    return routeLaunch(rt, launch);
  }

  // 0x address → launch token first, else whichever Choice venue lists it.
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const hit = await rt.pump.listLaunches({ q, limit: 3 }).catch(() => ({ items: [] as ApiLaunch[] }));
    const exact = hit.items.find((l) => l.token.toLowerCase() === q.toLowerCase());
    if (exact) return routeLaunch(rt, exact);
    return routeErc20(rt, getAddress(q));
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
  if (padExact.length > 1) return { venue: "ambiguous", candidates: padExact.map(launchCandidate) };

  // Choice resolve payload: {q, matches: [{type, address, symbol, name, price_usd}], ambiguous}
  const choiceHit = (await rt.choiceApi.resolve(q, "token").catch(() => null)) as {
    matches?: { address?: string; denom?: string; symbol?: string; name?: string }[];
    ambiguous?: boolean;
  } | null;
  const matches = choiceHit?.matches ?? [];
  const choiceExact = matches.filter((m) => m.symbol?.trim().toLowerCase() === wanted);
  // Choice v2 lists EVM tokens v1 has never heard of (every atomic graduate,
  // DojoFun). Only an EXACT symbol counts, same rule as v1.
  const v2Exact = rt.choiceV2Api && rt.net?.choiceV2
    ? (await rt.choiceV2Api.tokens(q, 10).catch(() => [])).filter(
        (t) => t.symbol?.trim().toLowerCase() === wanted,
      )
    : [];

  // Exact on BOTH venues. Launch metadata is author-supplied, so a launch can
  // declare any symbol it likes — including one an established Choice token
  // already answers to. Resolving that silently would send a `buy USDC` to
  // whichever venue this function happened to check first, so it is a question
  // for the caller instead.
  //
  // But a GRADUATED launch is exact on both venues by construction: graduating
  // is what lists the token, so the pad answers the launch and Choice answers
  // the very denom it graduated into. Those are one asset wearing two names, and
  // treating them as rivals made every graduated launch — the ones with real
  // liquidity — unresolvable by symbol. Only a match that is NOT this launch's
  // own denom is a genuine collision.
  if (padExact.length === 1) {
    // The launch's own listings on either venue are the launch, not rivals:
    // its graduated v1 denom, and its token address (v2, or v1's `erc20:` form).
    const own = new Set(
      [padExact[0]!.graduatedPoolDenom, padExact[0]!.token]
        .filter((x): x is string => !!x)
        .map((x) => x.toLowerCase()),
    );
    const rivals = [
      ...choiceExact
        .filter((m) => !own.has(stripErc20(String(m.address ?? m.denom ?? ""))))
        .map(choiceCandidate),
      ...v2Exact.filter((t) => !own.has(t.address.toLowerCase())).map(v2Candidate),
    ];
    if (rivals.length > 0) {
      return { venue: "ambiguous", candidates: [launchCandidate(padExact[0]!), ...rivals] };
    }
    return routeLaunch(rt, padExact[0]!);
  }

  // One asset per DISTINCT identity: v1's `erc20:0xA` and v2's `0xA` are the
  // same token, listed twice.
  const v1Ids = choiceExact.map((m) => String(m.address ?? m.denom ?? "")).filter(Boolean);
  const v2Only = v2Exact.filter((t) => !v1Ids.some((id) => stripErc20(id) === t.address.toLowerCase()));
  if (v1Ids.length + v2Only.length > 1) {
    return {
      venue: "ambiguous",
      candidates: [...choiceExact.map(choiceCandidate), ...v2Only.map(v2Candidate)],
    };
  }
  if (v1Ids.length === 1) {
    const id = v1Ids[0]!;
    // An ERC20 listed on v1 may have a v2 pool as well.
    if (/^erc20:0x[0-9a-fA-F]{40}$/i.test(id)) return routeErc20(rt, getAddress(id.slice(6)));
    return { venue: "choice", tokenId: id };
  }
  if (v2Only.length === 1) return routeErc20(rt, getAddress(v2Only[0]!.address));

  // Nothing matched the symbol outright. Surface every near-miss rather than picking one.
  const nearMisses = [...pad.items.map(launchCandidate), ...matches.slice(0, 5).map(choiceCandidate)];
  if (nearMisses.length > 1) return { venue: "ambiguous", candidates: nearMisses };
  if (pad.items.length === 1) return routeLaunch(rt, pad.items[0]!);
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

function v2Candidate(t: { address: string; symbol: string | null; name: string | null }): Record<string, unknown> {
  return { venue: "choiceV2", token: t.address, symbol: t.symbol, name: t.name };
}

/** `erc20:0xAbC…` → `0xabc…`; anything else lowercased as is. */
function stripErc20(id: string): string {
  return id.replace(/^erc20:/i, "").toLowerCase();
}

/**
 * Does Choice v2 list a live CL pool pairing `token` with wINJ behind an
 * allowed hook? A cheap API read used only to decide WHERE to quote — the venue
 * re-derives and verifies the pool on chain before anything is quoted or signed.
 */
export async function hasV2Pool(rt: Runtime, token: string): Promise<boolean> {
  const cfg = rt.net?.choiceV2;
  if (!cfg || !rt.choiceV2Api) return false;
  const pools = await rt.choiceV2Api.pools(token, 20).catch(() => [] as V2Pool[]);
  const t = token.toLowerCase();
  const winj = cfg.winj.toLowerCase();
  const hookOk = (h: string) =>
    /^0x0{40}$/i.test(h) || cfg.allowedHooks.some((a) => a.address.toLowerCase() === h.toLowerCase());
  return pools.some((p) => {
    const pair = [p.currency0.toLowerCase(), p.currency1.toLowerCase()];
    return p.poolType === "cl" && pair.includes(t) && pair.includes(winj) && hookOk(p.hooks) && BigInt(p.liquidity || "0") > 0n;
  });
}

/** Does Choice v1 list this ERC20 (as `erc20:<checksummed>`) with liquidity? */
async function v1ListsErc20(rt: Runtime, token: Address): Promise<string | null> {
  const id = `erc20:${token}`;
  const t = (await rt.choiceApi.token(id).catch(() => null)) as { liquidity_usd?: unknown } | null;
  const liq = Number(t?.liquidity_usd);
  return t && Number.isFinite(liq) && liq > 0 ? id : null;
}

/**
 * A plain EVM token: route to whichever Choice venue lists it, carrying the
 * other as an alternative when both do. Neither = Choice v1 by its raw address,
 * exactly what this returned before v2 existed, so v1's own refusal explains it.
 */
async function routeErc20(rt: Runtime, token: Address): Promise<ResolvedTarget> {
  const [v2, v1] = await Promise.all([hasV2Pool(rt, token), v1ListsErc20(rt, token)]);
  if (v2) return { venue: "choiceV2", token, ...(v1 ? { v1TokenId: v1 } : {}) };
  if (v1) return { venue: "choice", tokenId: v1 };
  return { venue: "choice", tokenId: token };
}

/** Did this launch graduate onto Choice v2? Its own settler says, or the indexer does. */
export function graduatesToChoiceV2(rt: Runtime, launch: ApiLaunch): boolean {
  const settler = launch.settler?.toLowerCase();
  const settlers = rt.net?.choiceV2?.infinitySettlers ?? [];
  if (settler && settlers.some((s) => s.toLowerCase() === settler)) return true;
  return launch.graduationVenue === "choice_v2";
}

/**
 * The better of two quotes for the same input, by expected output in the SAME
 * human units. A venue that failed to quote (null) never wins; ties keep v1,
 * the venue this package has always used.
 */
export function pickBetterQuote(v1Out: number | null, v2Out: number | null): "choice" | "choiceV2" | null {
  const ok = (x: number | null): x is number => x !== null && Number.isFinite(x) && x > 0;
  if (!ok(v1Out) && !ok(v2Out)) return null;
  if (!ok(v2Out)) return "choice";
  if (!ok(v1Out)) return "choiceV2";
  return v2Out > v1Out ? "choiceV2" : "choice";
}

/**
 * This launch's id ON ITS OWN CORE — the only id a chain call may use.
 *
 * `ApiLaunch.id` is the API's surrogate: unique across cores, and equal to the
 * on-chain id only while one core exists. Mainnet's first v2 launch is
 * surrogate 16 and on-chain 0, so feeding a surrogate to `getLaunch`/`buy`
 * reads a real but DIFFERENT launch. Falls back to `id` only for an API old
 * enough not to serve the column, which is also an API old enough to have one
 * core.
 */
function onchainIdOf(launch: ApiLaunch): bigint {
  return BigInt(launch.onchainId ?? launch.id);
}

async function routeLaunch(rt: Runtime, launch: ApiLaunch): Promise<ResolvedTarget> {
  if (CURVE_STATES.has(launch.state)) {
    return { venue: "curve", launch, launchId: onchainIdOf(launch) };
  }
  // An atomic-core graduate has NO Choice v1 pool — its liquidity went to a
  // Choice v2 pool on the EVM, keyed by its token address.
  if (launch.state === LaunchState.Graduated && rt.net?.choiceV2 && graduatesToChoiceV2(rt, launch)) {
    return { venue: "choiceV2", token: getAddress(launch.token), launch };
  }
  // `graduatedPoolDenom` and nothing else. `bankDenom` reads like a fallback
  // but it is the launch's QUOTE asset (SAI on every mainnet launch today), not
  // its token — so falling back to it would resolve `buy SKIBI` to SAI and buy
  // the wrong asset outright. A graduated launch whose denom has not been
  // indexed yet drops through to the curve branch, where the tools explain the
  // state, which is the safe way to be briefly unable to answer.
  if (launch.state === LaunchState.Graduated && launch.graduatedPoolDenom) {
    // Its token can ALSO have a v2 pool (MOTION does), which makes it a
    // two-venue asset: same balance, two markets.
    const v2 = (await hasV2Pool(rt, launch.token)) ? getAddress(launch.token) : undefined;
    return { venue: "choice", tokenId: launch.graduatedPoolDenom, launch, ...(v2 ? { v2Token: v2 } : {}) };
  }
  // Cancelled/refunded/etc — still return curve so tools can explain why.
  return { venue: "curve", launch, launchId: onchainIdOf(launch) };
}
