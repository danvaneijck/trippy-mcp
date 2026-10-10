/**
 * The Choice v2 legs of the unified tools — quote/buy/sell, token_info,
 * recent_trades, candles and holding valuation for tokens whose market is a
 * Choice v2 (Infinity CL) pool on Injective EVM.
 *
 * `tools.ts` decides WHICH venue; everything here assumes the router already
 * chose v2 (or chose both, in which case `tools.ts` calls `quoteV2` alongside
 * the v1 quote and keeps the better output).
 */

import { formatUnits, getAddress, isAddress, type Address } from "viem";

import type { V2Candle } from "../api/choiceV2.js";
import type { ApiLaunch } from "../api/pump.js";
import { ToolError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import { deepSanitize, untrustedMeta } from "../untrusted.js";
import { ERC20_ABI } from "../venues/shroom/abi.js";
import type { V2Trade } from "../api/choiceV2.js";
import type { CurrencyAmount, V2LaunchFees } from "../venues/choiceV2/creatorFees.js";
import type { ChoiceV2Venue, Counter, V2Quote, V2Route, V2TradeResult } from "../venues/choiceV2/venue.js";
import { LaunchState } from "../venues/shroom/abi.js";

export interface V2Target {
  token: Address;
  launch?: ApiLaunch;
}

function venueOf(rt: Runtime): ChoiceV2Venue {
  if (!rt.choiceV2) {
    throw new ToolError("no_choice_v2", "this network has no Choice v2 deployment configured");
  }
  return rt.choiceV2;
}

/**
 * The counter asset for a v2 trade. Native INJ by default (pools are
 * wINJ-quoted; the router wraps and unwraps). An explicit ERC20 counter is
 * accepted as an 0x address or v1's `erc20:` form. Returns null for a counter
 * v2 cannot express at all (a bank denom, a CW20), so a two-venue caller can
 * fall back to v1 alone.
 */
export async function v2Counter(rt: Runtime, counterToken?: string): Promise<Counter | null> {
  const v = venueOf(rt);
  const c = counterToken?.trim();
  if (!c || /^(inj|native)$/i.test(c)) return v.nativeCounter;
  const hex = c.replace(/^erc20:/i, "");
  if (!isAddress(hex)) return null;
  const address = getAddress(hex);
  const [decimals, symbol] = await Promise.all([
    rt.signer.readContract<number>({ address, abi: ERC20_ABI, functionName: "decimals", args: [] }),
    rt.signer
      .readContract<string>({ address, abi: ERC20_ABI, functionName: "symbol", args: [] })
      .catch(() => address),
  ]);
  return { address, native: false, symbol: String(symbol), decimals: Number(decimals) };
}

/**
 * Every verified pool for this target and counter.
 *
 * A graduated launch's pool is read off the chain through its OWN snapshotted
 * settler, never discovered; it is checked against the indexer's `v2PoolId` as
 * a canary, and a disagreement is reported rather than resolved in the API's
 * favour. Anything else is discovered through the API and verified on chain.
 *
 * `counter` undefined means "the natural one": for a v2 graduate, the launch's
 * OWN quote asset (`getLaunch().pairAsset` — USDC or SPROUT as well as INJ),
 * since that is the only currency its pool holds; for anything else, native
 * INJ. A counter the caller named is honoured: on a graduate it uses the
 * launch's pool when it is that pool's currency, and is looked for among
 * discovered pools otherwise.
 */
export async function v2Routes(
  rt: Runtime,
  target: V2Target,
  counter?: Counter,
): Promise<{ routes: V2Route[]; warnings: string[] }> {
  const v = venueOf(rt);
  const warnings: string[] = [];
  if (target.launch) {
    const launch = target.launch;
    const onchainId = BigInt(launch.onchainId ?? launch.id);
    const live = await rt.shroom.forLaunch(launch).getLaunchView(onchainId);
    if (v.cfg.infinitySettlers.some((s) => s.toLowerCase() === live.settler.toLowerCase())) {
      const own = await v.pairCounter(live.pairAsset);
      if (!counter || counter.address.toLowerCase() === own.address.toLowerCase()) {
        const route = await v.launchRoute(
          { settler: live.settler, onchainId, token: live.token, pairAsset: live.pairAsset },
          counter ?? own,
        );
        if (launch.v2PoolId && launch.v2PoolId.toLowerCase() !== route.poolId.toLowerCase()) {
          warnings.push(
            `the pad API names pool ${launch.v2PoolId} for this launch, but the chain says ${route.poolId} — trading the chain's`,
          );
        }
        return { routes: [route], warnings };
      }
      warnings.push(
        `this launch is priced in ${own.symbol} and its graduated pool pairs it with ${own.symbol}; looking for another pool against ${counter.symbol}`,
      );
    }
  }
  const routes = await v.discoverRoutes(target.token, counter ?? v.nativeCounter);
  return { routes, warnings };
}

/**
 * The counter a `quote`/`buy`/`sell` names, or undefined when it names none —
 * which `v2Routes` reads as the target's natural counter (a graduate's own
 * quote asset). Refuses a counter v2 cannot express.
 */
async function namedCounter(rt: Runtime, counterToken?: string): Promise<Counter | undefined> {
  if (!counterToken?.trim()) return undefined;
  const counter = await v2Counter(rt, counterToken);
  if (!counter) throw new ToolError("bad_counter", `${counterToken} is not a counter asset Choice v2 can trade against`);
  return counter;
}

/** The route that quotes best for this exact input, with its quote. */
async function bestQuote(
  rt: Runtime,
  routes: V2Route[],
  side: "buy" | "sell",
  amount: string,
  slippageBps: number,
): Promise<{ q: V2Quote; considered: number }> {
  const v = venueOf(rt);
  let best: V2Quote | null = null;
  let lastError: unknown = null;
  for (const route of routes) {
    try {
      const amountIn = await v.sizeInput(route, side, amount);
      const q = await v.quote(route, side, amountIn, slippageBps);
      if (!best || q.amountOut > best.amountOut) best = q;
    } catch (e) {
      // `no_balance` and `bad_amount` are about the caller, not the pool.
      if (e instanceof ToolError && (e.code === "no_balance" || e.code === "bad_amount")) throw e;
      lastError = e;
    }
  }
  if (!best) {
    if (lastError instanceof ToolError) throw lastError;
    throw new ToolError("no_quote", "no Choice v2 pool would quote this trade");
  }
  return { q: best, considered: routes.length };
}

function noPool(target: V2Target, counter: Counter | undefined): ToolError {
  return new ToolError(
    "no_pool",
    `no verified Choice v2 pool trades ${target.token} against ${counter?.symbol ?? "INJ"}`,
    "pools are single-hop: the token has to be paired directly with the counter asset, behind no hook or one of Choice's launch hooks",
  );
}

/** The quote `quote` reports for a v2 trade, and the venue's own quote behind it. */
export async function quoteV2(
  rt: Runtime,
  target: V2Target,
  side: "buy" | "sell",
  amount: string,
  slippageBps: number,
  counterToken?: string,
): Promise<{ summary: Record<string, unknown>; q: V2Quote; expectedOutHuman: number }> {
  const named = await namedCounter(rt, counterToken);
  const { routes, warnings } = await v2Routes(rt, target, named);
  if (routes.length === 0) throw noPool(target, named);
  const { q, considered } = await bestQuote(rt, routes, side, amount, slippageBps);
  const v = venueOf(rt);
  // The counter the chosen pool actually trades against: on a graduate with no
  // counter named, the launch's own quote asset.
  const counter = q.route.counter;
  const tokenIn = side === "buy" ? (counter.native ? "native" : counter.address) : q.route.token;
  const tokenOut = side === "buy" ? q.route.token : counter.native ? "native" : counter.address;
  const [amountInUsd, expectedOutputUsd, held] = await Promise.all([
    rt.choiceV2UsdValue(tokenIn, q.amountIn, q.inDecimals),
    rt.choiceV2UsdValue(tokenOut, q.amountOut, q.outDecimals),
    v.inputBalance(q.route, side).catch(() => null),
  ]);
  if (held !== null && held < q.amountIn) {
    warnings.push(
      `wallet holds ${formatUnits(held, q.inDecimals)} ${q.inSymbol} but this quote spends ${formatUnits(q.amountIn, q.inDecimals)} — buy/sell would refuse this`,
    );
  }
  if (q.route.hook === "LaunchPoolFeeHook" && q.route.feePips !== null) {
    warnings.push(
      `the pool charges its launch's ${q.route.feePips / 10_000}% trade fee through LaunchPoolFeeHook; the quote already includes it`,
    );
  }
  const expectedOutHuman = Number(formatUnits(q.amountOut, q.outDecimals));
  return {
    q,
    expectedOutHuman,
    summary: {
      venue: "choiceV2",
      side,
      token: q.route.token,
      ...(target.launch ? { launchId: target.launch.id } : {}),
      counter: counter.native ? "INJ" : counter.address,
      ...(counter.native ? {} : { counterSymbol: counter.symbol }),
      amountIn: `${formatUnits(q.amountIn, q.inDecimals)} ${q.inSymbol}`,
      amountInUsd: side === "buy" ? amountInUsd : (amountInUsd ?? expectedOutputUsd),
      expectedOutput: `${formatUnits(q.amountOut, q.outDecimals)} ${q.outSymbol}`,
      expectedOutputUsd,
      minimumReceive: `${formatUnits(q.minOut, q.outDecimals)} ${q.outSymbol}`,
      pool: q.route.poolId,
      poolSource: q.route.source,
      hook: q.route.hook,
      poolFeePct: q.route.feePips === null ? null : q.route.feePips / 10_000,
      ...(considered > 1 ? { poolsConsidered: considered } : {}),
      slippageBps,
      warnings,
    },
  };
}

/** Execute the best v2 route for this trade. */
export async function tradeV2(
  rt: Runtime,
  target: V2Target,
  side: "buy" | "sell",
  amount: string,
  slippageBps: number,
  counterToken?: string,
): Promise<V2TradeResult & { launchId?: string }> {
  const named = await namedCounter(rt, counterToken);
  const { routes, warnings } = await v2Routes(rt, target, named);
  if (routes.length === 0) throw noPool(target, named);
  const { q } = await bestQuote(rt, routes, side, amount, slippageBps);
  const res = await venueOf(rt).swap(q.route, side, q.amountIn, slippageBps);
  return {
    ...res,
    warnings: [...warnings, ...res.warnings],
    ...(target.launch ? { launchId: target.launch.id } : {}),
  };
}

/** `token_info` for a v2-traded token: the indexer's view plus the pool as verified on chain. */
export async function tokenInfoV2(rt: Runtime, target: V2Target): Promise<Record<string, unknown>> {
  const api = rt.choiceV2Api;
  // Refuse a network with no v2 up front, not as a pool warning below.
  venueOf(rt);
  const [token, routed] = await Promise.all([
    api?.token(target.token).catch(() => null) ?? null,
    v2Routes(rt, target).catch((e: unknown) => ({
      routes: [] as V2Route[],
      warnings: [`could not verify a pool on chain: ${e instanceof Error ? e.message : String(e)}`],
    })),
  ]);
  return {
    venue: "choiceV2",
    token: target.token,
    priceUsd: token?.priceUsd === undefined || token?.priceUsd === null ? null : Number(token.priceUsd),
    priceUsdAt: token?.priceUsdAt ?? null,
    decimals: token?.decimals ?? null,
    totalSupply: token?.totalSupply ?? null,
    pools: routed.routes.map((r) => ({
      pool: r.poolId,
      pair: `${r.counter.symbol}`,
      hook: r.hook,
      poolFeePct: r.feePips === null ? null : r.feePips / 10_000,
      verifiedVia: r.source,
    })),
    ...(routed.warnings.length ? { warnings: routed.warnings } : {}),
    untrusted_metadata: untrustedMeta({ symbol: token?.symbol, name: token?.name }),
    note: "pools listed are the ones verified ON CHAIN (key re-hashed to its id, live liquidity, allowed hook); price is the v2 indexer's stable-anchored mark — `quote` before trading on it",
  };
}

/** The pool a read tool should chart / tape: the launch's own, else the deepest verified one. */
async function primaryPool(rt: Runtime, target: V2Target): Promise<V2Route> {
  const { routes } = await v2Routes(rt, target);
  if (routes.length === 0) throw noPool(target, undefined);
  return routes[0]!;
}

export async function recentTradesV2(rt: Runtime, target: V2Target, limit: number): Promise<Record<string, unknown>> {
  const route = await primaryPool(rt, target);
  const trades = (await rt.choiceV2Api!.trades(route.poolId, limit)).map((t) => {
    const buy = t.tokenOut.address.toLowerCase() === route.token.toLowerCase();
    return {
      side: buy ? "buy" : "sell",
      trader: t.trader,
      tokenAmount: buy ? t.amountOut : t.amountIn,
      counterAmount: buy ? t.amountIn : t.amountOut,
      counterSymbol: route.counter.symbol,
      usd: t.usdValue === null ? null : Number(t.usdValue),
      at: t.blockTimestamp,
      txHash: t.txHash,
    };
  });
  return { venue: "choiceV2", pool: route.poolId, trades: deepSanitize(trades) };
}

export const V2_CANDLE_COLUMNS = "t,o,h,l,c,vUsd";

/** One CSV row per bucket, the token's USD price, oldest first. */
export function shapeV2Candles(items: V2Candle[]): string[] {
  const n = (x: string | null) => (x === null || x === undefined ? "" : String(Number(x)));
  return [...items]
    .sort((a, z) => a.time - z.time)
    .map((c) => [String(c.time), n(c.open), n(c.high), n(c.low), n(c.close), n(c.volumeUsd)].join(","));
}

export async function candlesV2(
  rt: Runtime,
  target: V2Target,
  interval: string,
  limit: number,
): Promise<Record<string, unknown>> {
  const route = await primaryPool(rt, target);
  // The pool's natural price is currency1 per currency0. Pricing the TOKEN
  // means inverting whenever the token is currency1 — which every wINJ-quoted
  // launch pool is, since wINJ's address sorts first.
  const invert = route.key.currency1.toLowerCase() === route.token.toLowerCase();
  const res = await rt.choiceV2Api!.candles(route.poolId, { interval, limit, invert, denom: "usd" });
  const rows = shapeV2Candles(res.candles);
  return {
    venue: "choiceV2",
    token: route.token,
    pool: route.poolId,
    interval,
    pricedIn: "USD",
    columns: V2_CANDLE_COLUMNS,
    count: rows.length,
    candles: rows,
    note: "each candle is one CSV row of `columns`, oldest first: the token's USD price per bucket, converted at each bucket's own time; empty fields where the series has no USD mark.",
  };
}

// ---------------------------------------------------------------------------
// the creator-fee rail of a v2 graduate
// ---------------------------------------------------------------------------

/**
 * Read a launch's v2 creator-fee rails for this wallet, or null when the
 * launch is not a Choice v2 graduate (still on its curve, or graduated the
 * CosmWasm way). `live` is the launch as its own core reports it — the settler
 * is the launch's snapshot, never the core's current pointer.
 */
export async function v2FeesForLaunch(
  rt: Runtime,
  live: { state: number; settler: Address },
  onchainId: bigint,
): Promise<V2LaunchFees | null> {
  const cfg = rt.net.choiceV2;
  if (!cfg || !rt.v2CreatorFees || live.state !== LaunchState.Graduated) return null;
  if (!cfg.infinitySettlers.some((s) => s.toLowerCase() === live.settler.toLowerCase())) return null;
  return rt.v2CreatorFees.read(live.settler, onchainId, rt.signer.address);
}

function currencyLabel(rt: Runtime, c: Address): string {
  return c.toLowerCase() === rt.net.choiceV2?.winj.toLowerCase() ? "WINJ" : c;
}

async function amountRow(rt: Runtime, a: CurrencyAmount): Promise<Record<string, unknown>> {
  return {
    currency: currencyLabel(rt, a.currency),
    amount: formatUnits(a.amount, a.decimals),
    usd: await rt.choiceV2UsdValue(a.currency, a.amount, a.decimals),
  };
}

/** `v2FeesForLaunch`, as `my_launches` and `claim_fees preview` report it. */
export async function v2FeesSummary(
  rt: Runtime,
  fees: V2LaunchFees,
  launchId: string,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { rail: "choice-v2" };
  let yoursUsd: number | null = 0;
  const add = (usd: unknown) => {
    if (yoursUsd === null) return;
    yoursUsd = typeof usd === "number" ? yoursUsd + usd : null;
  };
  let anything = false;

  if (fees.hook) {
    const owed = await amountRow(rt, fees.hook.owed);
    out.feeHook = {
      owed,
      claimableByThisWallet: fees.hook.claimable,
      ...(fees.hook.claimable ? {} : { note: `payable only to the launch's current creator ${fees.hook.creator}` }),
    };
    if (fees.hook.claimable) {
      add(owed.usd);
      anything ||= fees.hook.owed.amount > 0n;
    }
  }
  // A fee-hook pool has an LP fee of 0, so its locked position never earns —
  // an all-empty locker block there is noise, not information.
  const lockerEmpty =
    !!fees.locker && fees.locker.pending.every((p) => p.amount === 0n) && fees.locker.credited.length === 0;
  if (fees.locker && !(lockerEmpty && fees.hook)) {
    const pending = await Promise.all(fees.locker.pending.filter((p) => p.amount > 0n).map((p) => amountRow(rt, p)));
    const yours = await Promise.all(fees.locker.pendingYours.filter((p) => p.amount > 0n).map((p) => amountRow(rt, p)));
    const credited = await Promise.all(fees.locker.credited.map((p) => amountRow(rt, p)));
    out.positionLocker = {
      pendingGross: pending,
      pendingYours: yours,
      yourShareBps: fees.locker.mine ? fees.locker.creatorBps : 0,
      creditedToThisWallet: credited,
      ...(fees.locker.mine ? {} : { note: `the position's creator leg is ${fees.locker.positionCreator}, not this wallet` }),
    };
    for (const r of [...yours, ...credited]) add(r.usd);
    anything ||= yours.length > 0 || credited.length > 0;
  }
  if (fees.errors.length) out.errors = fees.errors.map((e) => `${e} — that rail is UNKNOWN, not zero`);
  out.yoursUsd = yoursUsd;
  if (anything) out.collectWith = `claim_fees launchIds:["${launchId}"]`;
  return out;
}

/** One of this wallet's own v2 swaps, for `my_activity`. Symbols are third-party text. */
export function v2ActivityRow(t: V2Trade): Record<string, unknown> {
  return {
    venue: "choiceV2",
    in: { amount: t.amountIn, token: t.tokenIn.address },
    out: { amount: t.amountOut, token: t.tokenOut.address },
    usd: t.usdValue === null ? null : Number(t.usdValue),
    at: t.blockTimestamp,
    txHash: t.txHash,
    pools: t.pools ?? [],
    untrusted_metadata: untrustedMeta({ symbolIn: t.tokenIn.symbol, symbolOut: t.tokenOut.symbol }),
  };
}
