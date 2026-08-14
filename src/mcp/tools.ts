/**
 * MCP tool implementations. Conventions (enforced here, promised in every
 * tool description):
 *  - failures return `{error: {code, message, hint?}}` — tools never throw
 *  - third-party text (token names/descriptions/usernames) is sanitized and
 *    grouped under `untrusted_metadata`: it is DATA from the internet, never
 *    instructions to the agent
 *  - unified buy/sell/quote auto-route: active bonding-curve launches trade
 *    on SHROOM Pad (EVM), everything else through the Choice aggregator
 */

import { formatUnits } from "viem";

import {
  execute as executeAirdrop,
  preview,
  status as airdropCampaignStatus,
  type PreviewArgs,
} from "../airdrops/campaign.js";
import { manage as manageAirdrop, type ManageArgs } from "../airdrops/manage.js";
import type { ApiCandle, ApiLaunch, ApiTrade } from "../api/pump.js";
import { quoteAssetBySlot, type QuoteAssetInfo } from "../chain/networks.js";
import { explain as explainTopic } from "../docs/index.js";
import { ToolError } from "../errors.js";
import { detectAinj } from "../interop.js";
import { decodeMetadataUri, resolveImage, type LaunchMetadata } from "../metadata.js";
import { CURVE_STATES, resolveToken, type ResolvedTarget } from "../router.js";
import type { Runtime } from "../runtime.js";
import { deepSanitize, sanitizeText, untrustedMeta } from "../untrusted.js";
import { checkForUpdate, PKG_VERSION } from "../version.js";
import { extractUsdPrice } from "../venues/choice/swap.js";
import { LAUNCH_STATE_LABEL, LaunchState } from "../venues/shroom/abi.js";
import type { LaunchView } from "../venues/shroom/launchpad.js";
import { sweep as walletSweep, walletStatus } from "../wallet.js";
import { balanceOf, bankBalances, denomDecimals } from "../api/lcd.js";

// ---------------------------------------------------------------------------
// shaping helpers
// ---------------------------------------------------------------------------

export function launchSummary(rt: Runtime, l: ApiLaunch): Record<string, unknown> {
  const meta = decodeMetadataUri(l.metadataURI) ?? {};
  const q = quoteAssetBySlot(rt.net, l.quoteAsset);
  return {
    launchId: l.id,
    token: l.token,
    state: LAUNCH_STATE_LABEL[l.state] ?? String(l.state),
    quote: q?.symbol ?? `slot${l.quoteAsset}`,
    raisedPair: q ? formatUnits(BigInt(l.realPair || "0"), q.decimals) : l.realPair,
    volume24h: q ? formatUnits(BigInt(l.volume24h || "0"), q.decimals) : l.volume24h,
    holderCount: l.userHolderCount,
    createdAt: l.createdAt,
    ...(l.graduatedPoolDenom ? { graduatedDenom: l.graduatedPoolDenom } : {}),
    ...(l.flagged ? { flagged: true } : {}),
    untrusted_metadata: untrustedMeta({
      name: (meta as LaunchMetadata).name,
      symbol: (meta as LaunchMetadata).symbol,
      description: (meta as LaunchMetadata).description,
      website: (meta as LaunchMetadata).website,
      twitter: (meta as LaunchMetadata).twitter,
    }),
  };
}

/**
 * launchId → its quote asset, memoised for the process.
 *
 * A launch's quote asset is copied onto it at createLaunch and can never
 * change, so a hit is good forever. The tape spans launches with DIFFERENT
 * quote assets (and USDC is 6-decimal against everything else's 18), so the
 * slot has to be resolved per launch rather than assumed.
 */
const quoteAssetCache = new WeakMap<Runtime, Map<string, QuoteAssetInfo | null>>();

function quoteAssetMemo(rt: Runtime): Map<string, QuoteAssetInfo | null> {
  let memo = quoteAssetCache.get(rt);
  if (!memo) {
    memo = new Map();
    quoteAssetCache.set(rt, memo);
  }
  return memo;
}

/** Seed the memo from a launch already in hand, to save a round trip. */
function rememberQuoteAsset(rt: Runtime, launch: ApiLaunch): void {
  quoteAssetMemo(rt).set(launch.id, quoteAssetBySlot(rt.net, launch.quoteAsset) ?? null);
}

async function quoteAssetForLaunch(rt: Runtime, launchId: string): Promise<QuoteAssetInfo | null> {
  const memo = quoteAssetMemo(rt);
  const hit = memo.get(launchId);
  if (hit !== undefined) return hit;
  // Fails soft: an unpriceable row is still a row worth showing, minus its USD.
  const info = await rt.pump
    .getLaunch(launchId)
    .then((l) => quoteAssetBySlot(rt.net, l.quoteAsset) ?? null)
    .catch(() => null);
  memo.set(launchId, info);
  return info;
}

/**
 * One curve trade, sized in quote units and in USD.
 *
 * The API's `quoteUsd` is the quote asset's USD RATE at that trade, NOT the
 * trade's value: a 0.02 INJ buy carries `4.87`, which is the INJ price. It used
 * to be published as `usd` directly, which overstated small INJ trades ~50x and
 * understated SAI-quoted trades ~200x. The notional is computed here and the
 * rate keeps a name that says what it is.
 */
export function tradeSummary(t: ApiTrade, q: QuoteAssetInfo | null): Record<string, unknown> {
  const rate = t.quoteUsd === null ? null : Number(t.quoteUsd);
  const hasRate = rate !== null && Number.isFinite(rate) && rate > 0;
  const pairBase = BigInt(t.pairAmount || "0");
  const pair = q ? Number(formatUnits(pairBase, q.decimals)) : null;
  return {
    launchId: t.launchId,
    side: t.side,
    trader: t.trader,
    ...(q
      ? { pairAmount: formatUnits(pairBase, q.decimals), quoteSymbol: q.symbol }
      : { quoteSymbol: null }),
    tokenAmount: formatUnits(BigInt(t.tokenAmount || "0"), 18),
    usd: pair !== null && hasRate ? pair * rate : null,
    quoteRateUsd: hasRate ? rate : null,
    pairAmountBase: t.pairAmount,
    tokenAmountBase: t.tokenAmount,
    at: t.blockTime,
    txHash: t.txHash,
  };
}

async function tradeSummaries(rt: Runtime, items: ApiTrade[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(items.map((t) => t.launchId))];
  const resolved = await Promise.all(
    ids.map(async (id) => [id, await quoteAssetForLaunch(rt, id)] as const),
  );
  const byLaunch = new Map(resolved);
  return items.map((t) => tradeSummary(t, byLaunch.get(t.launchId) ?? null));
}

type RoutedTarget = Extract<ResolvedTarget, { venue: "curve" } | { venue: "choice" }>;

async function routed(rt: Runtime, query: string): Promise<RoutedTarget> {
  const target = await resolveToken(rt, query);
  if (target.venue === "ambiguous") {
    throw new ToolError(
      "ambiguous",
      `"${query}" matches multiple tokens — pick one by launch id or address`,
      JSON.stringify(deepSanitize(target.candidates)),
    );
  }
  return target as RoutedTarget;
}

const DEFAULT_COUNTER = "inj";

// ---------------------------------------------------------------------------
// data tools
// ---------------------------------------------------------------------------

export async function searchTokens(rt: Runtime, args: { query: string }): Promise<unknown> {
  const target = await resolveToken(rt, args.query);
  if (target.venue === "ambiguous") {
    return { matches: deepSanitize(target.candidates) };
  }
  if (target.venue === "curve") {
    return { venue: "curve", launch: launchSummary(rt, target.launch) };
  }
  return { venue: "choice", tokenId: target.tokenId };
}

export async function tokenInfo(rt: Runtime, args: { query: string }): Promise<unknown> {
  const target = await routed(rt, args.query);
  if (target.venue === "curve") {
    const live = await rt.shroom.getLaunchView(target.launchId);
    const q = rt.shroom.quoteInfo(live.quoteAsset);
    const progress =
      live.graduationPairTarget > 0n
        ? Number((live.realPair * 10_000n) / live.graduationPairTarget) / 100
        : null;
    return {
      venue: "curve",
      launch: launchSummary(rt, target.launch),
      live: {
        state: LAUNCH_STATE_LABEL[live.state] ?? String(live.state),
        raised: `${formatUnits(live.realPair, q.decimals)} ${q.symbol}`,
        graduationTarget: `${formatUnits(live.graduationPairTarget, q.decimals)} ${q.symbol}`,
        graduationProgressPct: progress,
        tokensSold: formatUnits(live.tokensSold, 18),
      },
      terms: await launchTerms(rt, live),
      terminalUrl: rt.net.terminalBase ? `${rt.net.terminalBase}/t/shroom-curve%3A${target.launch.id}` : undefined,
    };
  }
  const payload = await rt.choiceApi.token(target.tokenId);
  return { venue: "choice", tokenId: target.tokenId, data: deepSanitize(payload) };
}

/**
 * This launch's OWN fee and gate terms.
 *
 * These belong here and not in `explain` because they are queryable state, not
 * documentation: LaunchpadCore snapshots the quote-asset config onto a launch
 * at createLaunch, so a launch created before a parameter changed keeps the old
 * terms forever. `explain` answers "what would a new launch get"; this answers
 * "what does THIS one charge me".
 *
 * `qualifies` is the question an agent actually has — "does holding the gate
 * token cut my fee here?" — and it is reported for this agent's own wallet,
 * which is the wallet that would trade. It is advisory: the authoritative
 * answer is a `quote`, because quoteBuy/quoteSell take an account and apply the
 * discount per-account, so a quote is already bit-exact.
 */
async function launchTerms(rt: Runtime, live: LaunchView): Promise<Record<string, unknown>> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const gated = live.gate.gateToken !== ZERO_ADDRESS && live.gate.minBalance > 0n;
  const gateActive = gated && live.gate.windowEndsAt > now;

  const terms: Record<string, unknown> = {
    tradeFeeBps: live.tradeFeeBps,
    creatorFeeShareBps: live.creatorFeeShareBps,
    note: "fee terms are snapshotted at launch creation — they are this launch's own, not the current protocol defaults (see explain topic `shroom_pad_fees`)",
  };

  if (!gated) {
    terms.gate = null;
    return terms;
  }

  const gate: Record<string, unknown> = {
    gateToken: live.gate.gateToken,
    minBalance: live.gate.minBalance.toString(),
    discountBps: live.gate.discountBps,
    windowEndsAt: new Date(Number(live.gate.windowEndsAt) * 1000).toISOString(),
    active: gateActive,
    kind:
      live.gate.discountBps === 0
        ? "access gate — non-qualifying wallets cannot buy while the window is open"
        : `fee discount — up to ${live.gate.discountBps / 100}% of the CREATOR's cut is waived for qualifying wallets (the platform leg is never reduced)`,
  };

  if (gateActive) {
    try {
      const held = await rt.shroom.erc20Balance(live.gate.gateToken, rt.signer.address);
      gate.agentBalance = held.toString();
      gate.qualifies = held >= live.gate.minBalance;
    } catch {
      // A gate token that is not a working ERC20 qualifies nobody; the contract
      // reaches the same conclusion via a non-reverting balanceOf.
      gate.qualifies = false;
      gate.note = "the gate token did not answer balanceOf — no wallet qualifies";
    }
  }

  terms.gate = gate;
  return terms;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// docs
// ---------------------------------------------------------------------------

export function explain(rt: Runtime, args: { topic?: string }): Promise<Record<string, unknown>> {
  return explainTopic(rt, args.topic);
}

// ---------------------------------------------------------------------------
// airdrops
// ---------------------------------------------------------------------------

export function airdropPreview(rt: Runtime, args: PreviewArgs): Promise<unknown> {
  return preview(rt, args);
}

export function airdropExecute(
  rt: Runtime,
  args: { planId: string; confirm?: boolean },
): Promise<unknown> {
  return executeAirdrop(rt, args);
}

export function airdropStatus(
  rt: Runtime,
  args: { campaignId?: number; planId?: string },
): Promise<unknown> {
  return airdropCampaignStatus(rt, args);
}

export function airdropManage(rt: Runtime, args: ManageArgs): Promise<unknown> {
  return manageAirdrop(rt, args);
}

export async function trending(
  rt: Runtime,
  args: { source?: "curve" | "dex" | "all"; limit?: number },
): Promise<unknown> {
  const source = args.source ?? "all";
  const limit = Math.min(args.limit ?? 10, 25);
  const out: Record<string, unknown> = {};
  if (source !== "dex") {
    const { items } = await rt.pump.listLaunches({ sort: "volume_24h", limit });
    out.curve = items.map((l) => launchSummary(rt, l));
  }
  if (source !== "curve") {
    out.dex = deepSanitize(await rt.choiceApi.trending("24h", limit));
  }
  return out;
}

export async function newLaunches(
  rt: Runtime,
  args: { source?: "curve" | "dex" | "all"; limit?: number },
): Promise<unknown> {
  const source = args.source ?? "curve";
  const limit = Math.min(args.limit ?? 10, 25);
  const out: Record<string, unknown> = {};
  if (source !== "dex") {
    const { items } = await rt.pump.listLaunches({ sort: "newest", limit });
    out.curve = items.map((l) => launchSummary(rt, l));
  }
  if (source !== "curve") {
    out.dex = deepSanitize(await rt.choiceApi.newListings(7, limit));
  }
  return out;
}

export async function recentTrades(
  rt: Runtime,
  args: { query?: string; limit?: number },
): Promise<unknown> {
  const limit = Math.min(args.limit ?? 20, 50);
  if (args.query) {
    const target = await routed(rt, args.query);
    if (target.venue === "curve") {
      rememberQuoteAsset(rt, target.launch);
      const { items } = await rt.pump.getTrades(target.launchId, limit);
      return { trades: await tradeSummaries(rt, items) };
    }
    // A graduated launch IS a SHROOM launch — saying otherwise sends the reader
    // looking for the wrong mistake. Its curve tape simply ended at graduation.
    if (target.launch) {
      throw new ToolError(
        "graduated",
        `launch #${target.launch.id} has graduated — its curve tape ended there and it now trades on Choice`,
        "use candles or token_info for its DEX market",
      );
    }
    throw new ToolError(
      "not_curve",
      "this is a Choice token, and per-token trade history here covers SHROOM Pad curve trades only",
      "use token_info for Choice market data",
    );
  }
  const { items } = await rt.pump.recentTrades(limit);
  return { trades: await tradeSummaries(rt, items) };
}

export async function myActivity(
  rt: Runtime,
  args: { limit?: number; days?: number } = {},
): Promise<unknown> {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const days = Math.min(Math.max(args.days ?? 30, 1), 365);
  const out: Record<string, unknown> = { agent: rt.signer.address, injAddress: rt.injAddress };
  // Each venue fails soft: one API being down should not blank the other's history.
  try {
    const { items } = await rt.pump.profileTrades(rt.signer.address.toLowerCase(), 50);
    out.trades = await tradeSummaries(rt, items);
  } catch (e) {
    out.curveNote = `SHROOM Pad history unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    out.choice = deepSanitize(await rt.choiceApi.wallet(rt.injAddress, limit, days));
  } catch (e) {
    out.choiceNote = `Choice swap history unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// candles
// ---------------------------------------------------------------------------

export const CANDLE_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export interface CandlesArgs {
  query: string;
  interval?: CandleInterval;
  limit?: number;
}

/**
 * Candles go out as CSV rows under a `columns` header rather than as one object
 * per bucket.
 *
 * The reason is size, not taste: the MCP result is pretty-printed JSON, so an
 * object per bucket spends a LINE on every field name. At the schema's own
 * `limit: 500` that shaping produced a 66KB payload that clients refuse
 * outright — the tool's documented maximum could not be read. One row per line
 * says the same thing in a third of the bytes.
 */
export const CURVE_CANDLE_COLUMNS = ["t", "o", "h", "l", "c", "v", "n", "rateUsd", "cUsd", "vUsd"];
export const CHOICE_CANDLE_COLUMNS = ["t", "o", "h", "l", "c", "v"];

/** Significant digits kept per field — enough for sub-satoshi curve prices. */
const sig = (n: number): string => (Number.isFinite(n) ? String(Number(n.toPrecision(8))) : "");

const csvRow = (cells: (number | string | null)[]): string =>
  cells.map((c) => (c === null || c === "" ? "" : typeof c === "number" ? sig(c) : c)).join(",");

/**
 * Curve candles arrive as raw spot_price_wad values: the base-unit pair/token
 * ratio scaled by 1e18. Launch tokens are always 18-decimal, so the human
 * quote-per-token price is wad/1e18 × 10^(18 − pairDecimals). Volume is raw
 * quote base units. `rateUsd` (quote→USD at the bucket's close trade) converts
 * close/volume to USD without rescaling history by today's rate.
 */
export function shapeCurveCandles(items: ApiCandle[], pairDecimals: number): string[] {
  const px = (v: string): number => (Number(v) / 1e18) * 10 ** (18 - pairDecimals);
  return items.map((cd) => {
    const close = px(cd.c);
    const vol = Number(cd.v) / 10 ** pairDecimals;
    const rate = cd.rateUsd == null ? null : Number(cd.rateUsd);
    const hasRate = rate !== null && Number.isFinite(rate) && rate > 0;
    return csvRow([
      cd.t,
      px(cd.o),
      px(cd.h),
      px(cd.l),
      close,
      vol,
      cd.n,
      hasRate ? rate : null,
      hasRate ? close * rate : null,
      hasRate ? vol * rate : null,
    ]);
  });
}

/** Choice agent-API candles are compact oldest→newest [t,o,h,l,c,v] arrays. */
export function shapeChoiceCandles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const row of raw.slice(0, 500)) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map((x) => Number(x));
    if (!Number.isFinite(t as number)) continue;
    out.push(csvRow([t as number, o as number, h as number, l as number, c as number, v as number]));
  }
  return out;
}

export async function candles(rt: Runtime, args: CandlesArgs): Promise<unknown> {
  const interval = args.interval ?? "1h";
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const target = await routed(rt, args.query);

  if (target.venue === "curve") {
    const q = rt.shroom.quoteInfo(target.launch.quoteAsset);
    const res = await rt.pump.getCandles(target.launchId, { interval, limit });
    const rows = shapeCurveCandles(res.items, q.decimals);
    return {
      venue: "curve",
      launchId: target.launch.id,
      interval: res.interval,
      pricedIn: q.symbol,
      columns: CURVE_CANDLE_COLUMNS,
      count: rows.length,
      candles: rows,
      note: `each candle is one CSV row of \`columns\`, oldest first. o/h/l/c are ${q.symbol} per token; cUsd/vUsd use each bucket's quote→USD rate (rateUsd), and are empty when the bucket has no rate. Only buckets containing trades are returned.`,
    };
  }

  const payload = await rt.choiceApi.marketCandles(target.tokenId, interval, limit);
  const rows = shapeChoiceCandles(payload.candles);
  return {
    venue: "choice",
    tokenId: target.tokenId,
    pair: sanitizeText(payload.pair),
    kind: payload.kind,
    interval: payload.interval ?? interval,
    pricedIn: "USD",
    columns: CHOICE_CANDLE_COLUMNS,
    count: rows.length,
    candles: rows,
    note: "each candle is one CSV row of `columns`, oldest first. o/h/l/c/v are USD when the backend has USD marks for the bucket, else raw quote prices.",
  };
}

// ---------------------------------------------------------------------------
// quote / trade
// ---------------------------------------------------------------------------

export interface QuoteArgs {
  query: string;
  side: "buy" | "sell";
  amount: string;
  slippageBps?: number;
  counterToken?: string;
}

/**
 * What `buy`/`sell` would refuse about this quote, in words.
 *
 * `quote` is the step every caller is told to run first, and it already holds
 * both numbers the trade is refused on — the USD spend and the wallet balance.
 * Withholding them meant the only way to discover a $2,300 quote against a $200
 * per-tx cap, or a sell of a token the wallet does not hold, was to attempt the
 * trade. Nothing here enforces anything: the caps live in `PolicyEngine.enforce`
 * inside the signers and the balance checks in the venues, exactly as before.
 * This reports the same limits one step earlier.
 */
export function policyWarnings(rt: Runtime, spendUsd: number | null): string[] {
  const p = rt.policy.snapshot() as {
    tradingEnabled: boolean;
    perTxCapUsd: number;
    remainingDailyUsd: number;
  };
  const out: string[] = [];
  if (!p.tradingEnabled) {
    out.push("trading is disabled by policy — this quote cannot be executed");
  }
  if (spendUsd === null) return out;
  if (spendUsd > p.perTxCapUsd) {
    out.push(
      `spends ~$${spendUsd.toFixed(2)}, over the $${p.perTxCapUsd} per-tx cap — buy/sell would refuse this`,
    );
  } else if (spendUsd > p.remainingDailyUsd) {
    out.push(
      `spends ~$${spendUsd.toFixed(2)}, over the $${p.remainingDailyUsd.toFixed(2)} left of the 24h budget — buy/sell would refuse this`,
    );
  }
  return out;
}

/** The other thing the venues refuse on: not holding what the quote spends. */
export function shortfallWarning(
  held: bigint,
  needed: bigint,
  decimals: number,
  label: string,
): string | null {
  if (held >= needed) return null;
  return `wallet holds ${formatUnits(held, decimals)} ${label} but this quote spends ${formatUnits(needed, decimals)} — buy/sell would refuse this`;
}

export async function quote(rt: Runtime, args: QuoteArgs): Promise<unknown> {
  const slippageBps = rt.policy.clampSlippageBps(args.slippageBps);
  const target = await routed(rt, args.query);

  if (target.venue === "curve") {
    const { launch, warnings } = await rt.shroom.precheckTrade(target.launchId, args.side);
    const q = rt.shroom.quoteInfo(launch.quoteAsset);
    if (args.side === "buy") {
      const pairIn = parseHuman(args.amount, q.decimals);
      const res = await rt.shroom.quoteBuy(target.launchId, pairIn, rt.signer.address);
      // Both legs priced off the same rate read, so they cannot disagree.
      const [amountInUsd, feeUsd, refundUsd, held] = await Promise.all([
        rt.shroom.usdValue(launch.quoteAsset, pairIn),
        rt.shroom.usdValue(launch.quoteAsset, res.fee),
        res.refund > 0n ? rt.shroom.usdValue(launch.quoteAsset, res.refund) : Promise.resolve(null),
        bankBalances(rt.net.lcdUrl, rt.injAddress)
          .then((all) => balanceOf(all, q.bankDenom))
          .catch(() => null),
      ]);
      const shortfall =
        held === null ? null : shortfallWarning(held, pairIn, q.decimals, q.symbol);
      warnings.push(...policyWarnings(rt, amountInUsd), ...(shortfall ? [shortfall] : []));
      return {
        venue: "curve",
        launchId: target.launch.id,
        side: "buy",
        quoteAsset: q.symbol,
        amountIn: `${args.amount} ${q.symbol}`,
        amountInUsd,
        tokenOut: formatUnits(res.tokenOut, 18),
        fee: `${formatUnits(res.fee, q.decimals)} ${q.symbol}`,
        feeUsd,
        ...(res.refund > 0n
          ? {
              refund: `${formatUnits(res.refund, q.decimals)} ${q.symbol} (buy crosses graduation)`,
              refundUsd,
            }
          : {}),
        slippageBps,
        warnings,
      };
    }
    const tokenIn = parseHuman(args.amount, 18);
    const res = await rt.shroom.quoteSell(target.launchId, tokenIn, rt.signer.address);
    const [pairOutUsd, feeUsd, held] = await Promise.all([
      rt.shroom.usdValue(launch.quoteAsset, res.pairOut),
      rt.shroom.usdValue(launch.quoteAsset, res.fee),
      rt.shroom.erc20Balance(launch.token, rt.signer.address).catch(() => null),
    ]);
    // A curve sell converts back to the quote asset, so it spends no USD budget
    // (launchpad passes spendUsd: 0) — balance is the only thing it refuses on.
    const shortfall = held === null ? null : shortfallWarning(held, tokenIn, 18, "tokens");
    warnings.push(...policyWarnings(rt, null), ...(shortfall ? [shortfall] : []));
    return {
      venue: "curve",
      launchId: target.launch.id,
      side: "sell",
      quoteAsset: q.symbol,
      amountIn: `${args.amount} tokens`,
      pairOut: `${formatUnits(res.pairOut, q.decimals)} ${q.symbol} (net of fee)`,
      pairOutUsd,
      fee: `${formatUnits(res.fee, q.decimals)} ${q.symbol}`,
      feeUsd,
      slippageBps,
      warnings,
    };
  }

  const counter = args.counterToken ?? DEFAULT_COUNTER;
  const [tokenIn, tokenOut] =
    args.side === "buy" ? [counter, target.tokenId] : [target.tokenId, counter];
  const q = await rt.choice.quote(tokenIn, tokenOut, args.amount, slippageBps / 100);
  const expectedOutput = String(q.summary.expected_output);
  // Priced from the token overviews, so an unpriceable token reports null
  // rather than failing a quote that is otherwise fine.
  const [amountInUsd, expectedOutputUsd, held, inDecimals] = await Promise.all([
    rt.choice.usdValueIn(tokenIn, args.amount),
    rt.choice.usdValueIn(tokenOut, expectedOutput),
    bankBalances(rt.net.lcdUrl, rt.injAddress)
      .then((all) => balanceOf(all, tokenIn))
      .catch(() => null),
    denomDecimals(rt.net.lcdUrl, tokenIn),
  ]);
  // A swap spends its INPUT whichever side it is called, so both directions are
  // budgeted — matching what ChoiceVenue.swap passes to the policy engine.
  const warnings = policyWarnings(rt, amountInUsd);
  if (inDecimals === null) {
    warnings.push(
      `the chain publishes no decimals for ${tokenIn} — sizing it by "all" is refused, and the balance below is not checked`,
    );
  } else if (held !== null) {
    try {
      const shortfall = shortfallWarning(held, parseHuman(args.amount, inDecimals), inDecimals, tokenIn);
      if (shortfall) warnings.push(shortfall);
    } catch {
      // The SOR accepted this amount string; if our own parse disagrees, that
      // is a reason to skip the warning, never to fail a good quote.
    }
  }
  return {
    venue: "choice",
    side: args.side,
    tokenIn,
    tokenOut,
    amountIn: args.amount,
    amountInUsd,
    expectedOutput,
    expectedOutputUsd,
    minimumReceive: String(q.summary.minimum_receive),
    route: q.summary.route_venues,
    slippageBps,
    warnings,
  };
}

export async function buy(rt: Runtime, args: Omit<QuoteArgs, "side">): Promise<unknown> {
  const slippageBps = rt.policy.clampSlippageBps(args.slippageBps);
  const target = await routed(rt, args.query);
  if (target.venue === "curve") {
    return rt.shroom.buy(target.launchId, args.amount, slippageBps);
  }
  const counter = args.counterToken ?? DEFAULT_COUNTER;
  return rt.choice.swap(counter, target.tokenId, args.amount, slippageBps / 100);
}

export async function sell(rt: Runtime, args: Omit<QuoteArgs, "side">): Promise<unknown> {
  const slippageBps = rt.policy.clampSlippageBps(args.slippageBps);
  const target = await routed(rt, args.query);
  if (target.venue === "curve") {
    return rt.shroom.sell(target.launchId, args.amount === "all" ? "all" : args.amount, slippageBps);
  }
  const counter = args.counterToken ?? DEFAULT_COUNTER;
  let amount = args.amount;
  if (amount === "all") {
    // Bank-denom balances are readable via LCD; CW20 positions need an amount.
    const balances = await bankBalances(rt.net.lcdUrl, rt.injAddress);
    const bal = balanceOf(balances, target.tokenId);
    if (bal <= 0n) {
      throw new ToolError(
        "no_balance",
        `no bank balance of ${target.tokenId}`,
        'for CW20 tokens pass an explicit amount instead of "all"',
      );
    }
    // Choice quotes take HUMAN units, so this exponent decides how much of the
    // position actually goes. Guessing is not an option here: 18-for-6 offers a
    // trillionth of the balance, which either fails as "rounds to zero" or —
    // above ~1e6 tokens — sells that trillionth and reports success.
    const decimals = await denomDecimals(rt.net.lcdUrl, target.tokenId);
    if (decimals === null) {
      throw new ToolError(
        "unknown_decimals",
        `the chain publishes no decimals for ${target.tokenId}, so "all" cannot be sized`,
        "pass an explicit amount in whole tokens instead",
      );
    }
    amount = formatUnits(bal, decimals);
  }
  return rt.choice.swap(target.tokenId, counter, amount, slippageBps / 100);
}

// ---------------------------------------------------------------------------
// launch / claims / wallet / agent
// ---------------------------------------------------------------------------

export interface CreateTokenArgs {
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  imagePath?: string;
  twitter?: string;
  website?: string;
  telegram?: string;
  quoteAsset?: "INJ" | "USDC" | "SAI";
  initialBuy?: string;
}

export async function createToken(rt: Runtime, args: CreateTokenArgs): Promise<unknown> {
  if (!args.name.trim() || !args.symbol.trim()) {
    throw new ToolError("bad_input", "name and symbol are required");
  }
  const image = await resolveImage(rt.pump, args.imageUrl, args.imagePath);
  const created = await rt.shroom.createLaunch({
    meta: {
      name: args.name.trim(),
      symbol: args.symbol.trim().toUpperCase(),
      description: args.description,
      image,
      twitter: args.twitter,
      website: args.website,
      telegram: args.telegram,
    },
    quoteSymbol: args.quoteAsset ?? "INJ",
  });

  let initialBuy: unknown = undefined;
  if (args.initialBuy && created.state === "Trading") {
    try {
      initialBuy = await rt.shroom.buy(
        BigInt(created.launchId),
        args.initialBuy,
        rt.policy.clampSlippageBps(undefined),
      );
    } catch (e) {
      initialBuy = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    ...created,
    ...(initialBuy !== undefined ? { initialBuy } : {}),
    ...(rt.net.terminalBase
      ? { terminalUrl: `${rt.net.terminalBase}/t/shroom-curve%3A${created.launchId}` }
      : {}),
  };
}

export async function claimFees(rt: Runtime, args: { launchIds?: string[] }): Promise<unknown> {
  const ids = (args.launchIds ?? []).map((s) => {
    if (!/^\d+$/.test(s)) throw new ToolError("bad_input", `launchIds must be numeric, got "${s}"`);
    return BigInt(s);
  });
  const res = await rt.shroom.claimAll(ids);
  if (!args.launchIds?.length) {
    res.notes.push(
      "creator fees are only checked for launch ids you pass in `launchIds` — referral fees and refunds were checked for the agent wallet",
    );
  }
  return res;
}

export async function walletStatusTool(rt: Runtime): Promise<unknown> {
  const status = await walletStatus(rt);
  const other = detectAinj({ injAddress: rt.injAddress });
  return other ? { ...status, otherAgentWallets: { ainj: other } } : status;
}

// ---------------------------------------------------------------------------
// portfolio
// ---------------------------------------------------------------------------

export interface PortfolioRow {
  denom: string;
  symbol: string | null;
  amount: number;
  priceUsd: number | null;
  valueUsd: number | null;
  pricedVia: "quote-rate" | "curve" | "choice" | "unpriced";
  launchId?: string;
  /** Set when the chain publishes no exponent: `amount` assumes 18, so it may
   *  be off by orders of magnitude and the row is deliberately left unpriced. */
  decimalsUnknown?: true;
  /** Raw bank amount, so an unknown-exponent row is still exact in base units. */
  amountBase?: string;
  untrusted_metadata?: Record<string, string>;
}

/**
 * Human amount for a bank balance, and whether we had to assume the exponent.
 *
 * The quantity is the number a caller is most likely to act on, so an unknown
 * exponent is surfaced rather than smoothed over — and a row that had to assume
 * one is never priced, because `price × wrong quantity` is a confident wrong
 * USD figure that would otherwise land in `totalUsd`.
 */
async function humanAmount(
  rt: Runtime,
  denom: string,
  raw: bigint,
): Promise<{ amount: number; decimalsUnknown?: true; amountBase?: string }> {
  const decimals = await denomDecimals(rt.net.lcdUrl, denom);
  if (decimals === null) {
    return { amount: Number(formatUnits(raw, 18)), decimalsUnknown: true, amountBase: raw.toString() };
  }
  return { amount: Number(formatUnits(raw, decimals)) };
}

export function portfolioTotals(rows: PortfolioRow[]): { totalUsd: number; unpriced: number } {
  let totalUsd = 0;
  let unpriced = 0;
  for (const r of rows) {
    if (r.valueUsd !== null && Number.isFinite(r.valueUsd)) totalUsd += r.valueUsd;
    else unpriced += 1;
  }
  return { totalUsd, unpriced };
}

/** Most balances a single portfolio call will try to price via lookups. */
const MAX_PRICE_LOOKUPS = 25;

export async function portfolio(rt: Runtime): Promise<unknown> {
  const all = await bankBalances(rt.net.lcdUrl, rt.injAddress);
  const quoteByDenom = new Map(Object.values(rt.net.quoteAssets).map((q) => [q.bankDenom, q]));
  const rows: PortfolioRow[] = [];
  let lookups = 0;

  for (const b of all) {
    const raw = BigInt(b.amount);
    if (raw <= 0n) continue;

    const q = quoteByDenom.get(b.denom);
    if (q) {
      const amount = Number(formatUnits(raw, q.decimals));
      const valueUsd = await rt.shroom.usdValue(q.slot, raw);
      rows.push({
        denom: b.denom,
        symbol: q.symbol,
        amount,
        priceUsd: valueUsd !== null && amount > 0 ? valueUsd / amount : null,
        valueUsd,
        pricedVia: valueUsd !== null ? "quote-rate" : "unpriced",
      });
      continue;
    }

    if (lookups >= MAX_PRICE_LOOKUPS) {
      // Past the lookup cap: still report the holding in human units (the
      // decimals lookup is cached/cheap), just skip price discovery.
      rows.push({
        denom: b.denom,
        symbol: null,
        ...(await humanAmount(rt, b.denom, raw)),
        priceUsd: null,
        valueUsd: null,
        pricedVia: "unpriced",
      });
      continue;
    }
    lookups += 1;

    const erc20 = /^erc20:(0x[0-9a-fA-F]{40})$/.exec(b.denom);
    const launch =
      (await launchFromDenom(rt, b.denom)) ??
      (erc20 ? await findLaunchByToken(rt, erc20[1]!) : null);

    if (launch && CURVE_STATES.has(launch.state)) {
      rows.push(await curveHoldingRow(rt, b.denom, raw, launch));
      continue;
    }
    rows.push(await choiceHoldingRow(rt, b.denom, raw, launch, erc20?.[1]));
  }

  rows.sort((a, z) => (z.valueUsd ?? -1) - (a.valueUsd ?? -1));
  const { totalUsd, unpriced } = portfolioTotals(rows);
  return {
    agent: rt.signer.address,
    injAddress: rt.injAddress,
    holdings: rows,
    totalUsd,
    ...(unpriced > 0 ? { unpricedHoldings: unpriced } : {}),
    note: "prices are indicative (quote-rate feed / last curve trade / Choice stats) — always `quote` before trading on them; token names under untrusted_metadata are third-party text",
  };
}

/**
 * The launch behind a held bank denom, when that denom is a launch token.
 *
 * Launch tokens ride `factory/<issuer>/<prefix>_<launchId>_<hash>` — NOT
 * `erc20:0x…`, whose bank supply for a launch token is 0. That mismatch is why
 * this exists: matching only the erc20 form meant no holding ever resolved to a
 * launch, so every curve position fell through to the Choice pricer, which does
 * not know a token that has not graduated, and came back `unpriced` while
 * `curveHoldingRow` — written for exactly this case — never ran.
 *
 * The issuer prefix is the check. Tokenfactory only lets an address mint under
 * its own namespace, so a denom under the launchpad's issuer cannot be spoofed
 * and the launch id it carries can be trusted without a second lookup.
 */
export async function launchFromDenom(rt: Runtime, denom: string): Promise<ApiLaunch | null> {
  const issuer = rt.net.launchDenomIssuer;
  if (!issuer || !denom.startsWith(`factory/${issuer}/`)) return null;
  const subdenom = denom.slice(`factory/${issuer}/`.length);
  // `<prefix>_<launchId>_<hash>` — the prefix is a deploy-time setting
  // ("shroom" on mainnet, "shroom_t" on testnet), so anchor on the tail.
  const id = /^[A-Za-z][A-Za-z_]*_(\d+)_[0-9a-fA-F]+$/.exec(subdenom)?.[1];
  if (!id) return null;
  return rt.pump.getLaunch(id).catch(() => null);
}

async function findLaunchByToken(rt: Runtime, token: string): Promise<ApiLaunch | null> {
  try {
    const { items } = await rt.pump.listLaunches({ q: token, limit: 3 });
    return items.find((l) => l.token.toLowerCase() === token.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/** Active-curve launch token: last trade's spot price × current quote→USD rate. */
async function curveHoldingRow(
  rt: Runtime,
  denom: string,
  raw: bigint,
  launch: ApiLaunch,
): Promise<PortfolioRow> {
  const meta = (decodeMetadataUri(launch.metadataURI) ?? {}) as LaunchMetadata;
  const amount = Number(formatUnits(raw, 18)); // launch tokens are always 18-decimal
  let priceUsd: number | null = null;
  try {
    const q = rt.shroom.quoteInfo(launch.quoteAsset);
    const { items } = await rt.pump.getTrades(launch.id, 1);
    const wad = items[0]?.spotPriceWad;
    if (wad) {
      const priceQuote = (Number(wad) / 1e18) * 10 ** (18 - q.decimals);
      const rate = await rt.shroom.usdValue(q.slot, 10n ** BigInt(q.decimals));
      if (rate !== null && Number.isFinite(priceQuote)) priceUsd = priceQuote * rate;
    }
  } catch {
    // leave unpriced
  }
  return {
    denom,
    symbol: null,
    amount,
    priceUsd,
    valueUsd: priceUsd !== null ? priceUsd * amount : null,
    pricedVia: priceUsd !== null ? "curve" : "unpriced",
    launchId: launch.id,
    untrusted_metadata: untrustedMeta({
      symbol: meta.symbol,
      name: meta.name,
    }),
  };
}

/** Anything else: Choice token stats (try the held denom, then the raw 0x). */
async function choiceHoldingRow(
  rt: Runtime,
  denom: string,
  raw: bigint,
  launch: ApiLaunch | null,
  erc20Token?: string,
): Promise<PortfolioRow> {
  // Launch tokens are always 18-decimal; anything else has to be looked up, and
  // an unknown exponent means the quantity is a guess — so the row stays
  // unpriced rather than multiplying a real price by a wrong amount.
  const sized = launch
    ? { amount: Number(formatUnits(raw, 18)) }
    : await humanAmount(rt, denom, raw);
  const { amount } = sized;
  let priceUsd: number | null = null;
  let overview: Record<string, unknown> | null = null;
  for (const query of [denom, ...(erc20Token ? [erc20Token] : [])]) {
    try {
      overview = await rt.choiceApi.token(query);
      priceUsd = extractUsdPrice(overview);
      if (priceUsd !== null) break;
    } catch {
      // try the next query form
    }
  }
  if (sized.decimalsUnknown) priceUsd = null;
  return {
    denom,
    symbol: null,
    ...sized,
    priceUsd,
    valueUsd: priceUsd !== null ? priceUsd * amount : null,
    pricedVia: priceUsd !== null ? "choice" : "unpriced",
    untrusted_metadata: untrustedMeta({
      symbol: (overview as { symbol?: unknown } | null)?.symbol,
      name: (overview as { name?: unknown } | null)?.name,
    }),
  };
}

export async function sweepTool(rt: Runtime, args: { asset: string; amount: string }): Promise<unknown> {
  return walletSweep(rt, args.asset, args.amount === "all" ? "all" : args.amount);
}

export async function agentInfo(rt: Runtime): Promise<unknown> {
  let agent = null;
  try {
    agent = (await rt.pump.getAgent(rt.signer.address.toLowerCase())).agent;
  } catch {
    // registry unreachable
  }
  const other = detectAinj({ injAddress: rt.injAddress });
  // Identity is what an agent reads at the start of a session, so it is the one place a
  // stale install is guaranteed to be told it is stale. Cached + fail-soft: null when the
  // registry is unreachable, and the field is simply absent.
  const version = await checkForUpdate();
  return {
    agentName: rt.cfg.agentName,
    evmAddress: rt.signer.address,
    injAddress: rt.injAddress,
    registered: !!agent && !agent.revoked,
    ownerClaimed: !!agent?.ownerAddress,
    ownerAddress: agent?.ownerAddress ?? null,
    howToClaim:
      "the human operator runs `trippy-mcp claim-code` on this machine, then enters the code in Trippy Terminal → Settings → Agents (or opens the printed link) and signs with their main wallet — that links the agent to their profile",
    ...(version ? { version } : { version: { running: PKG_VERSION } }),
    ...(other ? { otherAgentWallets: { ainj: other } } : {}),
  };
}

function parseHuman(amount: string, decimals: number): bigint {
  try {
    const v = parseUnitsSafe(amount, decimals);
    if (v <= 0n) throw new Error("non-positive");
    return v;
  } catch {
    throw new ToolError("bad_amount", `cannot parse amount "${amount}"`);
  }
}

function parseUnitsSafe(amount: string, decimals: number): bigint {
  const [i, f = ""] = amount.trim().split(".");
  const frac = f.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
