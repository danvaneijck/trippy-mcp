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

import { formatUnits, parseUnits, type Address } from "viem";

import {
  execute as executeAirdrop,
  preview,
  status as airdropCampaignStatus,
  type PreviewArgs,
} from "../airdrops/campaign.js";
import { manage as manageAirdrop, type ManageArgs } from "../airdrops/manage.js";
import { cw20Balance, cw20TokenInfo, isCw20Id } from "../api/cw20.js";
import {
  asApiLaunchId,
  type ApiCandle,
  type ApiLaunch,
  type ApiLaunchId,
  type ApiProfileHolding,
  type ApiProfileLaunch,
  type ApiTrade,
} from "../api/pump.js";
import {
  coreDeploymentFor,
  coreDeployments,
  quoteAssetBySlot,
  type QuoteAssetInfo,
} from "../chain/networks.js";
import { isWinjDenom, unwrapWinj, winjBalance } from "../chain/winj.js";
import { smartQuery } from "../airdrops/wasm.js";
import { evmToInj } from "../keystore.js";
import { explain as explainTopic } from "../docs/index.js";
import { ToolError } from "../errors.js";
import { IdentityRegistry } from "../identity/registry.js";
import { loadIdentityState } from "../identity/state.js";
import { detectAinj } from "../interop.js";
import { decodeMetadataUri, resolveImage, type LaunchMetadata } from "../metadata.js";
import { CURVE_STATES, resolveToken, type ResolvedTarget } from "../router.js";
import type { Runtime } from "../runtime.js";
import { deepSanitize, sanitizeText, untrustedMeta } from "../untrusted.js";
import { checkForUpdate, PKG_VERSION } from "../version.js";
import { extractUsdPrice } from "../venues/choice/swap.js";
import { LAUNCH_STATE_LABEL, LaunchState } from "../venues/shroom/abi.js";
import {
  presetAllowedOnQuote,
  priceRunX,
  resolveCurveChoice,
  THIN_DEV_BUY_MARGIN_SECONDS,
  type CurvePreset,
} from "../venues/shroom/curves.js";
import type { LaunchView } from "../venues/shroom/launchpad.js";
import { legBpsFor, lockerPending, prepareCollect, shareOf } from "../venues/shroom/locker.js";
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

async function quoteAssetForLaunch(rt: Runtime, launchId: ApiLaunchId): Promise<QuoteAssetInfo | null> {
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
    const live = await rt.shroom.forLaunch(target.launch).getLaunchView(target.launchId);
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
      curve: await launchCurve(rt, live),
      terminalUrl: rt.net.terminalBase ? `${rt.net.terminalBase}/t/shroom-curve%3A${target.launch.id}` : undefined,
    };
  }
  const payload = await rt.choiceApi.token(target.tokenId);
  return { venue: "choice", tokenId: target.tokenId, data: deepSanitize(payload) };
}

/**
 * Which curve THIS launch was created on.
 *
 * Worth reporting to a buyer, not just a creator: the preset decides how much
 * of the supply reaches the market and how far the price travels to
 * graduation, and two launches on the same quote asset can now differ
 * completely. Before the registry there was one curve per quote and this was
 * not a question anyone could ask.
 *
 * Null on a launch created before the registry (no `curveId` on its tuple), and
 * null rather than a number if the menu will not read — a bare id names
 * nothing an agent can reason about.
 */
async function launchCurve(rt: Runtime, live: LaunchView): Promise<unknown> {
  if (live.curveId === null || !rt.shroom.curvesSelectable) return null;
  const presets = await rt.shroom.curvePresets().catch(() => null);
  const preset = presets?.find((c) => c.id === live.curveId);
  if (!preset) return null;
  return {
    ...curveSummary(preset),
    note: "the curve is frozen onto the launch at creation — retiring or adding presets later does not change it",
  };
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
      // The API is keyed by the SURROGATE id; `target.launchId` is the
      // on-chain one and fetches a different launch's tape.
      const { items } = await rt.pump.getTrades(target.launch.id, limit);
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
  // Creating a launch is activity, and it was the one kind this tool could not
  // see: the tape carries trades, so a launch of your own showed up as the buy
  // that followed it and nothing else — indistinguishable from buying a
  // stranger's coin. The row is deliberately thin (no chain reads here);
  // `my_launches` is where a creator's launches get valued.
  try {
    const { createdLaunches } = await rt.pump.profile(rt.signer.address);
    if (createdLaunches.length > 0) {
      out.created = createdLaunches.map((l) => createdLaunchDigest(rt, l));
      out.createdNote = "launches created by this wallet — `my_launches` values them and shows the creator fees each one is owed";
    }
  } catch (e) {
    out.createdNote = `created-launch history unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
  return out;
}

/**
 * A created launch at a glance, from API fields alone.
 *
 * ⛔ Never reach for `volume24h`/`holderCount` here: the profile endpoint's
 * created-launches query does not select them and the serialiser fills in "0",
 * so reporting them would state that a busy launch is dead. `ApiProfileLaunch`
 * omits the three fields for exactly that reason — see `my_launches`, which
 * refetches the full row when the numbers matter.
 */
function createdLaunchDigest(rt: Runtime, l: ApiProfileLaunch): Record<string, unknown> {
  const meta = decodeMetadataUri(l.metadataURI) ?? {};
  const q = quoteAssetBySlot(rt.net, l.quoteAsset);
  return {
    launchId: l.id,
    state: LAUNCH_STATE_LABEL[l.state] ?? String(l.state),
    createdAt: l.createdAt,
    raised: q ? `${formatUnits(BigInt(l.realPair || "0"), q.decimals)} ${q.symbol}` : l.realPair,
    untrusted_metadata: untrustedMeta({
      name: (meta as LaunchMetadata).name,
      symbol: (meta as LaunchMetadata).symbol,
    }),
  };
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

/** Significant digits kept per PRICE/VOLUME field — enough for sub-satoshi curve prices. */
const sig = (n: number): string => (Number.isFinite(n) ? String(Number(n.toPrecision(8))) : "");

/**
 * The bucket timestamp goes out VERBATIM, and takes its own parameter so it can
 * never be fed through `sig()` again.
 *
 * `sig()` is a significant-FIGURE round and a unix second is 10 digits, so at 8
 * s.f. a timestamp snaps to the nearest 100 seconds. 1m buckets are 60s apart,
 * so four in every five landed on a neighbour's value — 1787945760 and
 * 1787945820 both emitted as 1787945800 — and the series came back with
 * duplicate `t`s and buckets that appeared to jump 100s at a time. Every
 * coarser interval (300s, 900s, 3600s, ...) is a multiple of 100 and was
 * therefore untouched, which is exactly why only 1m read wrong.
 */
const timeCell = (t: number): string => (Number.isFinite(t) ? String(Math.trunc(t)) : "");

const csvRow = (t: number, cells: (number | string | null)[]): string =>
  [timeCell(t), ...cells.map((c) => (c === null || c === "" ? "" : typeof c === "number" ? sig(c) : c))].join(",");

/**
 * Curve candles arrive as NORMALISED spot_price_wad values: display-quote per
 * display-token, scaled by 1e18. The decimal gap is already folded in by the
 * indexer (backend shared/curve.ts scales before dividing; migration sql/0024
 * rewrote history), so the human quote-per-token price is just wad/1e18.
 *
 * ⛔ Do NOT re-apply a `10 ** (18 − pairDecimals)` correction here. It used to
 * live in this function and made every USDC-quoted launch read 1e12 too high;
 * it was invisible on INJ/SAI/SHROOM because the factor is exactly 1 at 18
 * decimals. `pairDecimals` is still needed for volume, which IS raw base units.
 *
 * `rateUsd` (quote→USD at the bucket's close trade) converts close/volume to
 * USD without rescaling history by today's rate.
 */
export function shapeCurveCandles(items: ApiCandle[], pairDecimals: number): string[] {
  const px = (v: string): number => Number(v) / 1e18;
  return items.map((cd) => {
    const close = px(cd.c);
    const vol = Number(cd.v) / 10 ** pairDecimals;
    const rate = cd.rateUsd == null ? null : Number(cd.rateUsd);
    const hasRate = rate !== null && Number.isFinite(rate) && rate > 0;
    return csvRow(cd.t, [
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
    out.push(csvRow(t as number, [o as number, h as number, l as number, c as number, v as number]));
  }
  return out;
}

export async function candles(rt: Runtime, args: CandlesArgs): Promise<unknown> {
  const interval = args.interval ?? "1h";
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const target = await routed(rt, args.query);

  if (target.venue === "curve") {
    const q = rt.shroom.quoteInfo(target.launch.quoteAsset);
    // Surrogate id — see `getTrades` above. This one was the worse of the two:
    // the payload is labelled with the id the caller asked for.
    const res = await rt.pump.getCandles(target.launch.id, { interval, limit });
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

  const shape = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
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
      ...extra,
      note: "each candle is one CSV row of `columns`, oldest first. o/h/l/c/v are USD when the backend has USD marks for the bucket, else raw quote prices.",
    };
  };

  // Ask about the token itself, and check what came back is actually its series.
  // A backend that orients its own candles says so in `priced`; one that does not
  // charts whichever market has the most volume, from that market's BASE leg —
  // and a SHROOM Pad graduation lists against SAI, which sorts as the base. Both
  // reads are done together because the token overview is needed either way.
  const [picked, direct] = await Promise.all([
    choiceCandleMarket(rt, target.tokenId),
    rt.choiceApi.marketCandles(target.tokenId, interval, limit).catch(() => null),
  ]);
  if (direct && (picked.symbol === null || seriesPrices(direct, picked.symbol))) {
    return shape(direct);
  }

  // It charted something else. Name a market this token is the BASE of — the
  // workaround for a backend that has not been fixed yet. Some tokens are only
  // ever the quote side, and for those there is nothing to name.
  if (picked.chartsSomethingElse) {
    // Returning the series anyway, labelled, was the other option. It carries
    // no information about the token that was asked for, so it is not returned.
    return {
      venue: "choice",
      tokenId: target.tokenId,
      symbol: picked.symbol,
      interval,
      pricedIn: "USD",
      columns: CHOICE_CANDLE_COLUMNS,
      count: 0,
      candles: [],
      priceUsd: picked.priceUsd,
      warnings: [
        `no price series is available for ${picked.symbol}: Choice lists it only as the QUOTE side (${picked.markets.join(", ")}), and this deployment's candles endpoint charts a market's BASE asset — so the only series it can return is the counter asset's, not this token's. \`priceUsd\` above is ${picked.symbol}'s current price.`,
      ],
      note: "candles is empty on purpose — see warnings. Use token_info for current price and liquidity.",
    };
  }

  const payload = await rt.choiceApi.marketCandles(picked.market ?? target.tokenId, interval, limit);
  const warnings: string[] = [];
  // Last line of defence: whatever was asked for, the series belongs to whatever
  // the backend answered with.
  if (picked.symbol && !seriesPrices(payload, picked.symbol)) {
    warnings.push(
      `these candles are ${String(sanitizeText(payload.pair) ?? "").split("/")[0]}'s price series, not ${picked.symbol}'s — this endpoint charts the pair's BASE asset`,
    );
  } else if (picked.thin) {
    warnings.push(
      `${String(sanitizeText(payload.pair))} is the only market ${picked.symbol} is the base of, and it traded $0 in the last 24h — the series is stale or sparse, and a stale close can sit multiples away from the real price`,
    );
  }
  // A correct anchor for exactly the cases where the series is not one.
  return shape(payload, warnings.length > 0 ? { warnings, priceUsd: picked.priceUsd ?? null } : {});
}

/**
 * Whether a candles payload is the price series of `symbol`.
 *
 * `priced` is the backend naming the token it charted — authoritative when
 * present. Without it the only signal is the pair, whose BASE leg is what a
 * market's candles are expressed in.
 */
export function seriesPrices(payload: Record<string, unknown>, symbol: string): boolean {
  const priced = typeof payload.priced === "string" ? payload.priced : null;
  const subject = priced ?? String(payload.pair ?? "").split("/")[0] ?? "";
  return subject.trim().toUpperCase() === symbol.trim().toUpperCase();
}

interface ChoiceMarketRef {
  pair?: string;
  vol24h_usd?: number;
}

/**
 * Which market to chart a Choice token from.
 *
 * The candles endpoint charts a market's BASE asset in USD. Asked by token id
 * it answers from whichever market has the most volume — and a SHROOM Pad
 * graduation lists against SAI, which sorts as the base — so the series that
 * came back was SAI's price, with nothing in the payload saying so. Live before
 * this: `candles SKIBI` returned ~$0.047 for a token trading at $0.0000016, and
 * `candles MOON` the same, ~130,000x out.
 *
 * The endpoint also accepts a "BASE/QUOTE" pair name, so the fix is to name a
 * market this token is the base of. Some tokens are only ever the quote side —
 * for those there is no series to return and the caller is told that instead.
 */
export async function choiceCandleMarket(
  rt: Runtime,
  tokenId: string,
): Promise<{
  chartsSomethingElse: boolean;
  symbol: string | null;
  market?: string;
  thin?: boolean;
  priceUsd?: number | null;
  markets: string[];
}> {
  const info = await rt.choiceApi.token(tokenId).catch(() => null);
  const symbolRaw = (info as { symbol?: unknown } | null)?.symbol;
  const symbol = typeof symbolRaw === "string" && symbolRaw.trim() ? symbolRaw.trim() : null;
  const listed = (info as { top_markets?: unknown } | null)?.top_markets;
  const markets: ChoiceMarketRef[] = Array.isArray(listed) ? (listed as ChoiceMarketRef[]) : [];
  const pairs = markets.map((m) => String(m.pair ?? "")).filter(Boolean);
  if (!symbol || markets.length === 0) return { chartsSomethingElse: false, symbol, markets: pairs };

  const own = markets
    .filter((m) => String(m.pair ?? "").split("/")[0]?.trim().toUpperCase() === symbol.toUpperCase())
    .sort((a, z) => (z.vol24h_usd ?? 0) - (a.vol24h_usd ?? 0));

  if (own.length === 0) {
    return {
      chartsSomethingElse: true,
      symbol,
      priceUsd: extractUsdPrice((info ?? {}) as Record<string, unknown>),
      markets: pairs,
    };
  }
  return {
    chartsSomethingElse: false,
    symbol,
    market: String(own[0]!.pair),
    thin: (own[0]!.vol24h_usd ?? 0) === 0,
    priceUsd: extractUsdPrice((info ?? {}) as Record<string, unknown>),
    markets: pairs,
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
    allowUnpricedSpend: boolean;
  };
  const out: string[] = [];
  if (!p.tradingEnabled) {
    out.push("trading is disabled by policy — this quote cannot be executed");
  }
  // `null` is "nobody could price this", and the signers refuse an unpriceable
  // spend unless the operator opted in. That is the likeliest refusal of all on
  // a thinly-traded token — the exact case this tool exists to trade — so it
  // has to be said here rather than discovered by attempting the trade.
  // Callers that mean "this spends nothing" pass 0, not null.
  if (spendUsd === null) {
    if (!p.allowUnpricedSpend) {
      out.push(
        "no USD price for this trade, and policy.allowUnpricedSpend is false — buy/sell would refuse this",
      );
    }
    return out;
  }
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

/**
 * What the wallet holds of a Choice input, and the exponent it is denominated
 * in — from whichever module actually holds it.
 *
 * A CW20 position is not bank state, so reading it from `bankBalances` reports
 * 0 and reading its exponent from denom metadata finds nothing. Both are real,
 * they just live in the token contract. `decimals: null` therefore means "no
 * source knows", which is the only case worth warning about.
 */
async function inputPosition(
  rt: Runtime,
  tokenId: string,
): Promise<{ held: bigint | null; decimals: number | null; label: string }> {
  if (isCw20Id(tokenId)) {
    const [held, info] = await Promise.all([
      cw20Balance(rt.net.lcdUrl, tokenId, rt.injAddress).catch(() => null),
      cw20TokenInfo(rt.net.lcdUrl, tokenId).catch(() => null),
    ]);
    // The contract knows its own ticker, and "0 SHROOM" reads better than 0
    // followed by 42 characters of bech32.
    return { held, decimals: info?.decimals ?? null, label: info?.symbol ?? tokenId };
  }
  const [held, decimals] = await Promise.all([
    bankBalances(rt.net.lcdUrl, rt.injAddress)
      .then((all) => balanceOf(all, tokenId))
      .catch(() => null),
    denomDecimals(rt.net.lcdUrl, tokenId),
  ]);
  return { held, decimals, label: tokenId };
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

/**
 * Size `sell … "all"` against the live position, in human units.
 *
 * Bank denoms and CW20 contracts both answer for a position, just not in the
 * same module — `inputPosition` asks the right one. Choice quotes take HUMAN
 * units, so this exponent decides how much of the position actually goes:
 * guessing is not an option, because 18-for-6 offers a trillionth of the
 * balance, which either fails as "rounds to zero" or — above ~1e6 tokens —
 * sells that trillionth and reports success.
 *
 * Shared by `quote` and `sell` on purpose. They used to disagree: `sell` took
 * `"all"` and sized it here, while `quote` rejected the sentinel at the SOR
 * amount parser, so liquidating a position was the one trade that could not be
 * previewed — you had to read the quantity out of `portfolio` and retype it,
 * which is exactly the manual decimals step that produced the trillionth-of-a-
 * position bug. A preview that cannot express the trade is not a preview.
 */
async function sizeChoiceSellAll(rt: Runtime, tokenId: string): Promise<string> {
  const { held, decimals, label } = await inputPosition(rt, tokenId);
  if (held === null) {
    throw new ToolError(
      "balance_unavailable",
      `could not read a balance of ${tokenId}`,
      'pass an explicit amount instead of "all"',
    );
  }
  if (held <= 0n) {
    throw new ToolError("no_balance", `this wallet holds no ${label}`);
  }
  if (decimals === null) {
    throw new ToolError(
      "unknown_decimals",
      `nothing publishes decimals for ${label}, so "all" cannot be sized`,
      "pass an explicit amount in whole tokens instead",
    );
  }
  return formatUnits(held, decimals);
}

export async function quote(rt: Runtime, args: QuoteArgs): Promise<unknown> {
  const slippageBps = rt.policy.clampSlippageBps(args.slippageBps);
  const target = await routed(rt, args.query);
  // `"all"` on a buy is left alone: there is no position to size it against, and
  // the venues reject it with a clearer error than anything here could invent.
  const sellAll = args.side === "sell" && args.amount === "all";
  // The Choice leg resolves ONCE, up front, so every leg below — the SOR call,
  // the USD legs, the shortfall warning and the reported `amountIn` — describes
  // the same concrete size the executor would send. The curve leg resolves
  // inside its own branch, where it already reads the position anyway.
  const amount =
    sellAll && target.venue === "choice" ? await sizeChoiceSellAll(rt, target.tokenId) : args.amount;

  if (target.venue === "curve") {
    const { launch, warnings } = await rt.shroom.forLaunch(target.launch).precheckTrade(target.launchId, args.side);
    const q = rt.shroom.quoteInfo(launch.quoteAsset);
    if (args.side === "buy") {
      const pairIn = parseHuman(amount, q.decimals);
      const res = await rt.shroom.forLaunch(target.launch).quoteBuy(target.launchId, pairIn, rt.signer.address);
      // Both legs priced off the same rate read, so they cannot disagree.
      const [amountInUsd, feeUsd, refundUsd, held] = await Promise.all([
        rt.shroom.usdValue(launch.quoteAsset, pairIn),
        rt.shroom.usdValue(launch.quoteAsset, res.fee),
        res.refund > 0n ? rt.shroom.usdValue(launch.quoteAsset, res.refund) : Promise.resolve(null),
        bankBalances(rt.net.lcdUrl, rt.injAddress)
          .then((all) => balanceOf(all, q.bankDenom))
          .catch(() => null),
      ]);
      // The cap is enforced on what actually FILLS: a buy that crosses the
      // graduation target refunds the remainder in the same tx, and
      // launchpad.buy sizes its intent off `pairIn - refund`. Warning off the
      // gross would announce a refusal that is not going to happen. Both legs
      // came off the same rate read, so the subtraction cannot disagree.
      const spendUsd =
        amountInUsd !== null && refundUsd !== null ? amountInUsd - refundUsd : amountInUsd;
      // Balance, though, is checked against the gross — the tx moves the whole
      // `pairIn` and the refund comes back within it.
      const shortfall =
        held === null ? null : shortfallWarning(held, pairIn, q.decimals, q.symbol);
      warnings.push(...policyWarnings(rt, spendUsd), ...(shortfall ? [shortfall] : []));
      return {
        venue: "curve",
        launchId: target.launch.id,
        side: "buy",
        quoteAsset: q.symbol,
        amountIn: `${amount} ${q.symbol}`,
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
    // Read the position BEFORE sizing: a launch token is always an 18-dec ERC20,
    // so this one read both resolves `"all"` and backs the shortfall warning.
    // `launch.token` is typed `Address` here, which `target.launch.token` (plain
    // API text) is not — the reason this arm sizes itself rather than up front.
    const held = await rt.shroom.erc20Balance(launch.token, rt.signer.address).catch(() => null);
    if (sellAll && held === null) {
      throw new ToolError(
        "balance_unavailable",
        `could not read a balance of launch #${target.launch.id}`,
        'pass an explicit amount instead of "all"',
      );
    }
    if (sellAll && held !== null && held <= 0n) {
      throw new ToolError(
        "no_balance",
        `the agent wallet holds no tokens of launch #${target.launch.id}`,
      );
    }
    const tokenIn = sellAll && held !== null ? held : parseHuman(amount, 18);
    const res = await rt.shroom.forLaunch(target.launch).quoteSell(target.launchId, tokenIn, rt.signer.address);
    const [pairOutUsd, feeUsd] = await Promise.all([
      rt.shroom.usdValue(launch.quoteAsset, res.pairOut),
      rt.shroom.usdValue(launch.quoteAsset, res.fee),
    ]);
    // A curve sell converts back to the quote asset, so it spends no USD budget
    // — 0, not null: the launchpad enforces spendUsd: 0 here, and null would
    // now read as "unpriceable" and warn about a refusal that cannot happen.
    const shortfall = held === null ? null : shortfallWarning(held, tokenIn, 18, "tokens");
    warnings.push(...policyWarnings(rt, 0), ...(shortfall ? [shortfall] : []));
    return {
      venue: "curve",
      launchId: target.launch.id,
      side: "sell",
      quoteAsset: q.symbol,
      // Report what was sized, never the sentinel — the whole point is that the
      // preview states the concrete quantity the sell would send.
      amountIn: `${formatUnits(tokenIn, 18)} tokens`,
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
  const q = await rt.choice.quote(tokenIn, tokenOut, amount, slippageBps / 100);
  const expectedOutput = String(q.summary.expected_output);
  // Priced from the token overviews, so an unpriceable token reports null
  // rather than failing a quote that is otherwise fine.
  const [amountInUsd, expectedOutputUsd, position] = await Promise.all([
    rt.choice.usdValueIn(tokenIn, amount),
    rt.choice.usdValueIn(tokenOut, expectedOutput),
    inputPosition(rt, tokenIn),
  ]);
  const { held, decimals: inDecimals, label } = position;
  // A swap spends its INPUT whichever side it is called, so both directions are
  // budgeted — matching what ChoiceVenue.swap passes to the policy engine.
  const warnings = policyWarnings(rt, amountInUsd);
  if (inDecimals === null) {
    warnings.push(
      `nothing publishes decimals for ${tokenIn} — sizing it by "all" is refused, and the wallet balance is not checked here`,
    );
  } else if (held !== null) {
    try {
      const shortfall = shortfallWarning(held, parseHuman(amount, inDecimals), inDecimals, label);
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
    amountIn: amount,
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
    const res = await rt.shroom.forLaunch(target.launch).buy(target.launchId, args.amount, slippageBps);
    return { ...res, launchId: target.launch.id };
  }
  const counter = args.counterToken ?? DEFAULT_COUNTER;
  return rt.choice.swap(counter, target.tokenId, args.amount, slippageBps / 100);
}

export async function sell(rt: Runtime, args: Omit<QuoteArgs, "side">): Promise<unknown> {
  const slippageBps = rt.policy.clampSlippageBps(args.slippageBps);
  const target = await routed(rt, args.query);
  if (target.venue === "curve") {
    const res = await rt.shroom
      .forLaunch(target.launch)
      .sell(target.launchId, args.amount === "all" ? "all" : args.amount, slippageBps);
    return { ...res, launchId: target.launch.id };
  }
  const counter = args.counterToken ?? DEFAULT_COUNTER;
  // Same sizing `quote` reports, so the preview and the broadcast agree.
  const amount = args.amount === "all" ? await sizeChoiceSellAll(rt, target.tokenId) : args.amount;
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
  /**
   * Bonding curve, by preset name or curveId. Only where a CurveRegistry
   * exists; omitted = curveId 0, which reproduces the pre-registry curve.
   */
  curve?: string;
  initialBuy?: string;
  /** Seconds to delay public trading, making `initialBuy` exclusive to the creator. */
  devBuyDelaySeconds?: number;
  /** Cap on that pre-open buy, in bps of the raise. Default 2000 (the maximum). */
  devBuyMaxBps?: number;
  /** Launch with a delay shorter than the keeper bind reliably fits inside. */
  allowShortDevBuyWindow?: boolean;
  /** "INJ"/"USDC"/"SAI" or an 0x ERC20 address. */
  gateToken?: string;
  gateMinBalance?: string;
  gateDiscountBps?: number;
  gateWindowEndsAt?: number;
}

/**
 * Turn the flat gate arguments into the contract's `LaunchGate`.
 *
 * `gateToken` takes a quote-asset symbol as well as an address because those
 * are the tokens a creator actually gates on, and they are the ones the admin
 * allowlist holds. `minBalance` is human units, so the token's decimals have to
 * be resolved — from the network config for a known quote asset, from the ERC20
 * itself otherwise.
 */
async function resolveGateArgs(
  rt: Runtime,
  args: CreateTokenArgs,
): Promise<
  { gateToken: Address; minBalance: bigint; discountBps: number; windowEndsAt: bigint } | undefined
> {
  if (!args.gateToken) {
    if (args.gateMinBalance || args.gateDiscountBps) {
      throw new ToolError("bad_gate", "gateMinBalance and gateDiscountBps need a gateToken");
    }
    return undefined;
  }
  const known = rt.net.quoteAssets[args.gateToken.toUpperCase()];
  let token: Address;
  let decimals: number;
  if (known) {
    token = known.pairAsset as Address;
    decimals = known.decimals;
  } else if (/^0x[0-9a-fA-F]{40}$/.test(args.gateToken)) {
    token = args.gateToken as Address;
    decimals = await rt.shroom.erc20Decimals(token).catch(() => {
      throw new ToolError(
        "bad_gate",
        `${args.gateToken} does not answer decimals() — it is not an ERC20 this chain knows`,
        "gate on a quote asset symbol, or check the address",
      );
    });
  } else {
    throw new ToolError(
      "bad_gate",
      `gateToken must be a quote asset symbol (${Object.keys(rt.net.quoteAssets).join("/")}) or an 0x address, got "${args.gateToken}"`,
    );
  }
  if (!args.gateMinBalance) {
    throw new ToolError("bad_gate", "gateToken needs gateMinBalance — the threshold to qualify on");
  }
  const discountBps = args.gateDiscountBps ?? 0;
  // Only DISCOUNT gates are held to the admin allowlist; checking it up front
  // turns an opaque `GateTokenNotAllowed` revert into something actionable.
  if (discountBps > 0 && !(await rt.shroom.isAllowedGateToken(token))) {
    throw new ToolError(
      "bad_gate",
      `${args.gateToken} is not on the launchpad's allowed gate-token list, so it cannot back a fee discount`,
      "ask an admin to allowlist it, or use gateDiscountBps 0 for a plain access gate (any token works there)",
    );
  }
  return {
    gateToken: token,
    minBalance: parseUnits(args.gateMinBalance, decimals),
    discountBps,
    windowEndsAt: BigInt(args.gateWindowEndsAt ?? 0),
  };
}

export async function createToken(rt: Runtime, args: CreateTokenArgs): Promise<unknown> {
  if (!args.name.trim() || !args.symbol.trim()) {
    throw new ToolError("bad_input", "name and symbol are required");
  }
  const quoteSymbol = args.quoteAsset ?? "INJ";
  const chosen = await resolveCurve(rt, args.curve, quoteSymbol);
  const gate = await resolveGateArgs(rt, args);
  if (args.devBuyMaxBps && !args.devBuyDelaySeconds) {
    throw new ToolError(
      "bad_dev_buy",
      "devBuyMaxBps only means anything with devBuyDelaySeconds — without a delay there is no exclusive window to cap",
    );
  }
  if (args.allowShortDevBuyWindow && !args.devBuyDelaySeconds) {
    throw new ToolError(
      "bad_dev_buy",
      "allowShortDevBuyWindow waives the floor on devBuyDelaySeconds, and no delay was given",
    );
  }
  if (args.devBuyDelaySeconds && !args.initialBuy) {
    throw new ToolError(
      "bad_dev_buy",
      "devBuyDelaySeconds holds public trading closed so the CREATOR can buy first, but no initialBuy was given",
      "pass initialBuy, or drop the delay so trading opens immediately",
    );
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
    quoteSymbol,
    curveId: chosen?.curveId,
    ...(args.devBuyDelaySeconds
      ? {
          devBuy: {
            openDelaySeconds: args.devBuyDelaySeconds,
            // Left undefined on purpose: the venue defaults it to the most
            // THIS curve allows, which differs per preset.
            maxBuyBps: args.devBuyMaxBps,
            allowShortWindow: args.allowShortDevBuyWindow,
          },
        }
      : {}),
    ...(gate ? { gate } : {}),
  });

  let initialBuy: unknown = undefined;
  if (args.initialBuy && created.state === "Trading") {
    try {
      // On-chain id, on the core we just created against — the chain's namespace.
      initialBuy = await rt.shroom.buy(
        BigInt(created.onchainId),
        args.initialBuy,
        rt.policy.clampSlippageBps(undefined),
      );
    } catch (e) {
      initialBuy = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  // What the window actually did, now that the bind and the buy have both
  // happened. The floor in `resolveLaunchTiming` is a prediction from measured
  // bind latency; this is the measurement itself, and it is the only place the
  // caller can learn what the next launch should ask for.
  //
  // Report the near miss as well as the miss. A window that held by 8 seconds
  // reads as a clean success from the result alone, and BOOTS is exactly that
  // launch — 52.2s of bind against a 60s window. Nothing in the output said so.
  if (created.tradingOpensAt > 0 && initialBuy !== undefined) {
    const openedAt = created.tradingOpensAt * 1000;
    const spareSeconds = Math.round((openedAt - Date.now()) / 1000);
    if (spareSeconds <= 0) {
      created.warnings.push(
        `the exclusive window closed at ${new Date(openedAt).toISOString()}, before the opening buy landed — that buy competed with everyone else. Bind latency ate the delay; use a longer devBuyDelaySeconds next time.`,
      );
    } else if (spareSeconds < THIN_DEV_BUY_MARGIN_SECONDS) {
      created.warnings.push(
        `the opening buy landed with ${spareSeconds}s left of the exclusive window — it held, but barely. Bind latency varies by tens of seconds; use a longer devBuyDelaySeconds next time.`,
      );
    }
  }

  // Everything the caller does next — token_info, quote, the Terminal link —
  // speaks the API's surrogate id, and it is NOT the id the chain just assigned
  // (the next launch is on-chain 114, which is an unrelated existing coin as a
  // surrogate). The token address is the only handle that crosses, so resolve
  // through it rather than printing an id that names someone else's launch.
  // The indexer trails the chain by a moment, and this runs right after the
  // keeper bind — a couple of short retries is the difference between handing
  // back a usable id and handing back null on a launch that worked.
  let row: ApiLaunch | null = null;
  for (let attempt = 0; created.token && !row && attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    row = await findLaunchByToken(rt, created.token);
  }
  const warnings = [...created.warnings];
  if (created.status !== "dry-run" && !row) {
    warnings.push(
      "the pad API has not indexed this launch yet, so it has no launch id to quote at — look it up by its token address in a moment",
    );
  }

  return {
    ...created,
    launchId: row?.id ?? null,
    ...(initialBuy && typeof initialBuy === "object" && "onchainId" in initialBuy
      ? { initialBuy: { ...initialBuy, launchId: row?.id ?? null } }
      : {}),
    ...(chosen ? { curve: curveSummary(chosen.preset) } : {}),
    ...(rt.net.terminalBase && row
      ? { terminalUrl: `${rt.net.terminalBase}/t/shroom-curve%3A${row.id}` }
      : {}),
    warnings,
    note: "`launchId` is the id every other tool takes; `onchainId` is this launch's id on its own core and is only for raw chain calls",
  };
}

/**
 * Turn a `curve` argument into a curveId, or refuse with the menu attached.
 *
 * Refusing here rather than letting `createLaunch` revert matters: the revert
 * costs gas and says nothing an agent can act on, while `quoteMask` and
 * `enabled` are both readable up front. A wrong pick is also not recoverable —
 * the curve is frozen onto the launch forever.
 *
 * Returns null when no choice was expressed, which is a no-op: curveId 0 is
 * `standard` and reproduces the pre-registry curve exactly.
 */
async function resolveCurve(
  rt: Runtime,
  choice: string | undefined,
  quoteSymbol: "INJ" | "USDC" | "SAI",
): Promise<{ curveId: number; preset: CurvePreset } | null> {
  if (choice === undefined || choice === "") return null;
  if (!rt.shroom.curvesSelectable) {
    // Dropping it silently would hand back a launch on a curve the caller did
    // not pick, permanently, and report success.
    throw new ToolError(
      "bad_curve",
      "this network runs the v1 launchpad, where the curve is fixed per quote asset",
      "omit `curve` — there is nothing to choose here",
    );
  }
  const slot = rt.net.quoteAssets[quoteSymbol]?.slot;
  if (slot === undefined) {
    throw new ToolError("bad_input", `unknown quote asset ${quoteSymbol}`);
  }
  const presets = await rt.shroom.curvePresets();
  if (!presets || presets.length === 0) {
    throw new ToolError("bad_curve", "the curve registry returned no presets");
  }
  const picked = resolveCurveChoice(presets, choice, slot);
  if ("error" in picked) {
    throw new ToolError(
      "bad_curve",
      picked.error,
      `curves available on ${quoteSymbol}: ${
        presets
          .filter((c) => presetAllowedOnQuote(c, slot))
          .map((c) => `${c.name} (id ${c.id})`)
          .join(", ") || "none"
      } — see explain("shroom_pad_curves")`,
    );
  }
  return picked;
}

/** The preset, as reported back on a launch. */
function curveSummary(c: CurvePreset): Record<string, unknown> {
  return {
    curveId: c.id,
    name: c.name,
    floatPct: c.floatBps === null ? null : c.floatBps / 100,
    poolLiquidityPct: c.lpBps === null ? null : c.lpBps / 100,
    priceRunX: Number(priceRunX(c.rBps).toFixed(2)),
    raiseMultiplier: c.targetMulBps / 10_000,
  };
}

// ---------------------------------------------------------------------------
// launches this wallet created
// ---------------------------------------------------------------------------

/** Most created launches one call will read the chain for. */
const MAX_CREATED_ROWS = 25;

/**
 * The launches this wallet created, valued, with what each one owes it.
 *
 * The gap this fills: nothing else could answer "which launches are mine".
 * `my_activity` carries trades, `portfolio` carries balances, and
 * `create_token` reports a launch once and then forgets it — so a creator's own
 * launch was visible only as the dev buy that followed it, and the creator-fee
 * ledger accruing underneath it was reachable only by broadcasting a claim.
 *
 * Three sources, because no one of them knows everything:
 *  - the pad profile knows WHICH launches are this wallet's, and its own flow
 *    through each (`realizableValuePair` is a live exit quote, not spot x size)
 *  - `getLaunch` knows the launch's activity — the profile's created rows do
 *    not select those columns and serialise them as "0"
 *  - the chain knows the fee ledger, the live curve state and the dev-buy
 *    window, none of which the API serves
 *
 * Every per-launch read fails soft. One unreachable core or one launch whose
 * view reverts must not blank the rest of a creator's portfolio.
 */
export async function myLaunches(rt: Runtime, args: { limit?: number } = {}): Promise<unknown> {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), MAX_CREATED_ROWS);
  const profile = await rt.pump.profile(rt.signer.address);
  const shown = profile.createdLaunches.slice(0, limit);
  // The wallet's own flow per launch, keyed by surrogate id — a creator who
  // never dev-bought simply has no row.
  const flow = new Map(profile.holdings.map((h) => [String(h.launchId), h]));

  const launches = await Promise.all(
    shown.map((l) => createdLaunchRow(rt, l, flow.get(String(l.id)) ?? null)),
  );

  const notes: string[] = [];
  if (profile.createdLaunches.length > shown.length) {
    notes.push(
      `showing ${shown.length} of ${profile.createdLaunches.length} launches — raise \`limit\` for the rest`,
    );
  }
  const owedTotals = totalOwedByQuote(launches);
  if (owedTotals.length > 0) {
    notes.push(
      "creator fees accrue to a per-launch ledger on the core, NOT to the wallet — `claim_fees` moves them",
    );
  }
  return {
    agent: rt.signer.address,
    created: profile.createdLaunches.length,
    launches,
    creatorFeesOwed: owedTotals,
    notes,
  };
}

/** Sum the unclaimed creator fees across the rows, per quote asset. */
function totalOwedByQuote(rows: Record<string, unknown>[]): { symbol: string; amount: string }[] {
  const byQuote = new Map<string, number>();
  for (const r of rows) {
    const fees = r.fees as { owed?: string | null } | undefined;
    if (!fees?.owed) continue;
    const [amount, symbol] = fees.owed.split(" ");
    const n = Number(amount);
    if (!symbol || !Number.isFinite(n) || n === 0) continue;
    byQuote.set(symbol, (byQuote.get(symbol) ?? 0) + n);
  }
  return [...byQuote].map(([symbol, amount]) => ({ symbol, amount: String(Number(amount.toPrecision(12))) }));
}

async function createdLaunchRow(
  rt: Runtime,
  l: ApiProfileLaunch,
  flow: ApiProfileHolding | null,
): Promise<Record<string, unknown>> {
  const meta = decodeMetadataUri(l.metadataURI) ?? {};
  const q = quoteAssetBySlot(rt.net, l.quoteAsset);
  const row: Record<string, unknown> = {
    launchId: l.id,
    // Both ids, deliberately: `launchId` is what every other tool takes, and
    // `onchainId` is the only one a raw chain call may use.
    onchainId: l.onchainId ?? null,
    core: l.core ?? null,
    state: LAUNCH_STATE_LABEL[l.state] ?? String(l.state),
    quote: q?.symbol ?? `slot${l.quoteAsset}`,
    createdAt: l.createdAt,
    untrusted_metadata: untrustedMeta({
      name: (meta as LaunchMetadata).name,
      symbol: (meta as LaunchMetadata).symbol,
    }),
    ...(rt.net.terminalBase ? { terminalUrl: `${rt.net.terminalBase}/t/shroom-curve%3A${l.id}` } : {}),
  };

  // The launch's own activity — refetched because the profile's created rows
  // serialise volume and holders as "0" whatever the launch is doing.
  const full = await rt.pump.getLaunch(l.id).catch(() => null);
  if (full) {
    row.activity = {
      volume24h: q ? formatUnits(BigInt(full.volume24h || "0"), q.decimals) : full.volume24h,
      holders: full.userHolderCount,
      lastTradedAt: full.lastTradedAt,
    };
  }

  if (!coreDeploymentFor(rt.net, l.core)) {
    row.note = `lives on LaunchpadCore ${l.core ?? "(unnamed)"}, which this build does not know — upgrade trippy-mcp to read its curve and fee ledger`;
    return row;
  }
  const venue = rt.shroom.forLaunch({ core: l.core });
  const onchainId = BigInt(l.onchainId ?? l.id);

  const live = await venue.getLaunchView(onchainId).catch(() => null);
  if (live && q) {
    row.progress = {
      raised: `${formatUnits(live.realPair, q.decimals)} ${q.symbol}`,
      graduationTarget: `${formatUnits(live.graduationPairTarget, q.decimals)} ${q.symbol}`,
      pct:
        live.graduationPairTarget > 0n
          ? Number((live.realPair * 10_000n) / live.graduationPairTarget) / 100
          : null,
    };
    row.devBuyWindow = devBuyWindowSummary(l, live);
  }

  // The headline: a plain view, so asking costs nothing. It used to be
  // legible only by broadcasting `claim_fees`.
  const owed = await venue.creatorFeesOwed(onchainId).catch(() => null);
  row.fees = {
    tradeFeeBps: full?.tradeFeeBps ?? live?.tradeFeeBps ?? null,
    creatorFeeShareBps: full?.creatorFeeShareBps ?? live?.creatorFeeShareBps ?? null,
    owed: owed === null || !q ? null : `${formatUnits(owed, q.decimals)} ${q.symbol}`,
    owedUsd: owed === null || !q ? null : await rt.shroom.usdValue(q.slot, owed),
    ...(owed !== null && owed > 0n ? { claimWith: `claim_fees launchIds:["${l.id}"]` } : {}),
  };

  // Rail 2. A graduated launch keeps earning on its Choice pool, and that fee
  // is nowhere near the core — see venues/shroom/locker.ts. Reported alongside
  // `fees` rather than folded into it: the two accrue in different places, pay
  // out through different chains, and the pool leg arrives partly in the
  // launch's own token rather than in the quote asset.
  const pool = await poolFeesSummary(rt, l);
  if (pool) row.poolFees = pool;

  if (flow && q) row.myPosition = positionSummary(flow, q, owed);
  return row;
}

// ---------------------------------------------------------------------------
// graduated-pool fees — the locker rail
// ---------------------------------------------------------------------------

/** Enough of a launch row to find and value its locker. Both sources carry it. */
type LockerRow = {
  id: ApiLaunchId;
  quoteAsset: number;
  /**
   * The LAUNCH TOKEN's bank denom.
   *
   * 🔴 NOT `bankDenom`, which on a launch row is the QUOTE denom — "inj" on an
   * INJ-quoted launch, not the coin the launch minted. Labelling the pool's
   * two fee legs off `bankDenom` silently files the token leg under "other",
   * which is what it did before this comment existed.
   */
  graduatedPoolDenom?: string | null;
  lockerAddr?: string | null;
};

/**
 * USD value of a raw amount of one bank denom.
 *
 * The quote leg goes through the pad's own quote-price feed (the same rate
 * every other USD figure in this package uses); the token leg has no such feed
 * and is priced off Choice, which is where a graduated launch trades anyway.
 */
async function denomUsd(rt: Runtime, denom: string, raw: bigint, q: QuoteAssetInfo | undefined): Promise<number | null> {
  if (q && denom === q.bankDenom) return rt.shroom.usdValue(q.slot, raw);
  const overview = await rt.choiceApi.token(denom).catch(() => null);
  const price = overview ? extractUsdPrice(overview) : null;
  if (price === null) return null;
  // Launch denoms are 18-decimal by construction; anything else has to say so,
  // and an unknown exponent leaves the row unpriced rather than off by 1e12.
  const decimals = denom.startsWith(`factory/${rt.net.launchDenomIssuer}/`)
    ? 18
    : await denomDecimals(rt.net.lcdUrl, denom);
  if (decimals === null) return null;
  return Number(formatUnits(raw, decimals)) * price;
}

/**
 * What this launch's graduated pool has accrued and not yet paid out.
 *
 * Null when the launch has no locker — which is every launch that has not
 * graduated, and every XYK graduation (those mint no position NFT and lock
 * their LP instead, so there is nothing to collect). A locker that will not
 * answer returns a row saying so rather than nothing: silence here reads as
 * "no pool fees", which is the exact under-report this whole rail exists to
 * fix.
 */
async function poolFeesSummary(rt: Runtime, l: LockerRow): Promise<Record<string, unknown> | null> {
  const locker = l.lockerAddr;
  if (!locker) return null;

  const pending = await lockerPending(rt.net.lcdUrl, locker).catch((e: unknown) => {
    return e instanceof Error ? e.message : String(e);
  });
  if (typeof pending === "string") {
    return {
      locker,
      pending: null,
      note: `could not read the fee locker (${pending}) — pool fees are UNKNOWN, not zero`,
    };
  }

  const q = quoteAssetBySlot(rt.net, l.quoteAsset);
  const yourShareBps = legBpsFor(pending.config, rt.injAddress);
  const rows: Record<string, unknown>[] = [];
  let grossUsd: number | null = 0;

  for (const o of pending.owed) {
    const usd = await denomUsd(rt, o.denom, o.gross, q);
    if (usd === null) grossUsd = null;
    else if (grossUsd !== null) grossUsd += usd;
    const decimals = q && o.denom === q.bankDenom ? q.decimals : 18;
    rows.push({
      denom: o.denom,
      // Which side of the pool this is, named without trusting any metadata:
      // the quote asset is pinned in the network def and the launch names its
      // own bank denom.
      leg:
        q && o.denom === q.bankDenom
          ? q.symbol
          : o.denom === l.graduatedPoolDenom
            ? "launch token"
            : "other",
      gross: formatUnits(o.gross, decimals),
      yours: formatUnits(shareOf(o.gross, pending.config, rt.injAddress), decimals),
    });
  }

  const yoursUsd = grossUsd === null ? null : (grossUsd * yourShareBps) / 10_000;
  return {
    locker,
    positionTokenIds: pending.tokenIds,
    yourShareBps,
    // Uncollected fees sitting in the position, GROSS of the split.
    pending: rows,
    pendingGrossUsd: grossUsd,
    pendingYoursUsd: yoursUsd,
    ...(yourShareBps === 0
      ? { note: "this wallet is neither leg of this locker's split — it earns nothing here" }
      : rows.length > 0
        ? { collectWith: `claim_fees launchIds:["${l.id}"]` }
        : {}),
  };
}

/** Most lockers one `claim_fees` call will collect. Each is its own cosmos tx. */
const MAX_LOCKER_COLLECTS = 10;

/**
 * Read — and unless previewing, collect — the pool-fee rail for these launches.
 *
 * Every collect is a separate CosmWasm execute, so this reads first and skips
 * the lockers with nothing in them: `collect_fees` on an empty position still
 * costs gas and still succeeds, which is the worst combination for a tool that
 * runs with no id and covers everything a wallet created.
 */
async function collectPoolFees(
  rt: Runtime,
  rows: LockerRow[],
  preview: boolean,
): Promise<{ poolFees: Record<string, unknown>[]; txHashes: string[]; notes: string[] }> {
  const poolFees: Record<string, unknown>[] = [];
  const txHashes: string[] = [];
  const notes: string[] = [];
  const withLocker = rows.filter((r) => r.lockerAddr);
  let collects = 0;

  for (const l of withLocker) {
    const summary = await poolFeesSummary(rt, l);
    if (!summary) continue;
    const pending = summary.pending as Record<string, unknown>[] | null;
    // Unreadable, empty, or not ours: report it and never sign for it.
    if (pending === null || pending.length === 0 || summary.yourShareBps === 0) {
      if (pending === null) poolFees.push({ launchId: l.id, ...summary });
      continue;
    }
    if (preview) {
      poolFees.push({ launchId: l.id, ...summary });
      continue;
    }
    if (collects >= MAX_LOCKER_COLLECTS) {
      notes.push(
        `stopped after ${MAX_LOCKER_COLLECTS} pool-fee collects — each is its own transaction; call again to collect the rest`,
      );
      break;
    }
    collects += 1;
    try {
      const msg = await prepareCollect(
        { lcdUrl: rt.net.lcdUrl, injAddress: rt.injAddress, policy: rt.policy },
        l.lockerAddr!,
      );
      const res = await rt.cosmos.execute([msg], {
        intent: { kind: "claim", target: l.lockerAddr!, detail: `collect_fees launch #${l.id}` },
        memo: "",
      });
      if (res.txHash) txHashes.push(res.txHash);
      poolFees.push({
        launchId: l.id,
        ...summary,
        collected: res.status === "dry-run" ? "dry-run" : true,
        txHash: res.txHash,
      });
    } catch (e) {
      // One locker failing must not lose the core-side claim that already
      // broadcast, or the other launches behind it in the loop.
      poolFees.push({
        launchId: l.id,
        ...summary,
        collected: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (poolFees.length > 0) {
    notes.push(
      preview
        ? "pool fees are GROSS in `pending` — `yours` is this wallet's cut, and it pays out partly in the launch's own token"
        : "collecting a pool splits it on-chain: this wallet gets its leg, the treasury gets the rest — partly in the launch's own token",
    );
  }
  return { poolFees, txHashes, notes };
}

/**
 * What the creator's exclusive window actually was.
 *
 * `tradingOpensAt` is the only record that a dev-buy window existed at all —
 * the API serves no field for it — and it is what makes a launch auditable
 * after the fact: the delay is frozen at createLaunch and the keeper bind eats
 * an unpredictable 28-65s of it, so the gap between creation and open is the
 * measurement that tells the next launch what to ask for.
 */
function devBuyWindowSummary(l: ApiProfileLaunch, live: LaunchView): Record<string, unknown> | null {
  const opensAt = Number(live.tradingOpensAt);
  if (!opensAt) return null;
  const createdMs = Date.parse(l.createdAt);
  const seconds = Number.isFinite(createdMs) ? Math.round(opensAt - createdMs / 1000) : null;
  return {
    tradingOpenedAt: new Date(opensAt * 1000).toISOString(),
    exclusiveSecondsAfterCreate: seconds,
    maxBuyBpsInGuardWindow: live.maxBuyBpsInGuardWindow,
    open: Date.now() / 1000 >= opensAt,
  };
}

/**
 * This wallet's own stake in a launch it created, valued at the exit.
 *
 * `netIfSoldNow` counts the creator's two revenue lines — the bag and the fee
 * ledger — against what the wallet actually put in. It deliberately excludes
 * the creation fee (the launch row does not record what it cost, and the
 * protocol fee is owner-settable, so any figure here would be a guess) and any
 * fees already claimed, which have left the ledger and landed in the wallet.
 */
function positionSummary(
  flow: ApiProfileHolding,
  q: QuoteAssetInfo,
  owed: bigint | null,
): Record<string, unknown> {
  const buys = BigInt(flow.sumBuyPair || "0");
  const sells = BigInt(flow.sumSellPair || "0");
  const realizable = flow.realizableValuePair === null ? null : BigInt(flow.realizableValuePair);
  const net = realizable === null ? null : realizable + sells + (owed ?? 0n) - buys;
  return {
    tokens: formatUnits(BigInt(flow.currentBalance || "0"), 18),
    boughtFor: `${formatUnits(buys, q.decimals)} ${q.symbol}`,
    soldFor: `${formatUnits(sells, q.decimals)} ${q.symbol}`,
    sellAllValue: realizable === null ? null : `${formatUnits(realizable, q.decimals)} ${q.symbol}`,
    netIfSoldNow:
      net === null ? null : `${net >= 0n ? "+" : "-"}${formatUnits(net < 0n ? -net : net, q.decimals)} ${q.symbol}`,
    note: "counts the bag at its live exit quote plus unclaimed creator fees, against this wallet's own buys — excludes the creation fee and any fees already claimed",
  };
}

/**
 * Claim EVERYTHING a launch pays out: creator fees, referral fees and refunds
 * across every deployed core, plus the graduated pool's own swap fees.
 *
 * Three things this has to get right. Two broke when a second core deployed:
 * the ids a caller passes are the surrogates every other tool prints, so they
 * are resolved through the API rather than handed to the chain, where they
 * would name a different launch; and each core keeps its OWN referral and
 * refund ledgers, so the superseded core has to be visited even when no launch
 * id names it — otherwise everything owed on it is simply unreachable.
 *
 * The third is that a launch does not stop paying when it graduates. Its pool
 * fees accrue in a CosmWasm locker with no connection to the core, on the other
 * chain half, and were unreachable from this package entirely until 0.13.0 —
 * so "claim everything" quietly meant "claim the curve". See
 * venues/shroom/locker.ts. The pool leg runs AFTER the core loop and never
 * throws into it: a locker that will not answer must not lose a core claim
 * that already broadcast.
 */
/**
 * Convert the claim's WINJ leg back to spendable INJ.
 *
 * LaunchpadCore pays the curve creator fee in the quote's ERC20 pair asset.
 * For USDC and SAI that IS the bank denom and there is nothing to do — but
 * INJ's pair asset is WINJ9, so an INJ-quoted launch pays wrapped INJ that
 * cannot buy anything here and cannot pay gas. Claiming was the only thing
 * that ever created that balance, so unwinding it belongs in the same call
 * rather than in a tool the model has to remember to reach for.
 *
 * It sweeps the WHOLE balance, not just this claim's share: nothing in this
 * package holds WINJ on purpose, the conversion is 1:1 into the same wallet,
 * and going by balance rather than by a per-launch sum means a claim that
 * lands wrapped for any other reason self-heals on the next one. That is what
 * clears residue left by every claim made before this shipped.
 */
async function settleWinj(
  rt: Runtime,
  preview: boolean,
  enabled: boolean,
): Promise<{ unwrappedInj: string | null; txHashes: string[]; notes: string[] }> {
  const none = { unwrappedInj: null, txHashes: [] as string[], notes: [] as string[] };
  if (!enabled) return none;

  const balance = await winjBalance(rt.signer, rt.net).catch(() => null);
  if (balance === null) {
    // Never fatal: the claim itself already landed, and reporting it as failed
    // because a follow-up read flaked would be the worse lie.
    return { ...none, notes: ["could not read the WINJ balance — any wrapped INJ was left wrapped"] };
  }
  if (balance <= 0n) return none;

  const human = formatUnits(balance, 18);
  if (preview) {
    return {
      unwrappedInj: human,
      txHashes: [],
      notes: [
        `${human} WINJ (wrapped INJ, from the curve creator-fee rail) would be unwrapped to native INJ — pass unwrap:false to keep it wrapped`,
      ],
    };
  }

  try {
    const res = await unwrapWinj(rt.signer, rt.net, balance);
    return {
      unwrappedInj: human,
      txHashes: res.hash ? [res.hash] : [],
      notes:
        res.status === "reverted"
          ? [`the WINJ unwrap reverted — ${human} WINJ is still wrapped and claimable with claim_fees again`]
          : [],
    };
  } catch (e) {
    return {
      ...none,
      notes: [
        `claimed, but unwrapping ${human} WINJ to INJ failed (${e instanceof Error ? e.message : String(e)}) — the fees ARE in the wallet, as wrapped INJ`,
      ],
    };
  }
}

export async function claimFees(
  rt: Runtime,
  args: { launchIds?: string[]; preview?: boolean; unwrap?: boolean },
): Promise<unknown> {
  const rows: ClaimRow[] = [];
  const notes = new Set<string>();

  for (const raw of args.launchIds ?? []) {
    if (!/^\d+$/.test(raw)) {
      throw new ToolError("bad_input", `launchIds must be numeric, got "${raw}"`);
    }
    const row = await rt.pump.getLaunch(asApiLaunchId(raw)).catch(() => null);
    if (!row) throw new ToolError("not_found", `no SHROOM launch #${raw}`);
    // Refuse a core this build cannot name rather than dropping the launch out
    // of every per-core batch below and reporting "nothing to claim".
    if (!coreDeploymentFor(rt.net, row.core)) {
      throw new ToolError(
        "unknown_core",
        `launch #${raw} lives on LaunchpadCore ${row.core ?? "(unnamed)"}, which this build does not know. Upgrade trippy-mcp.`,
      );
    }
    rows.push(row);
  }

  // No ids: claim everything this wallet is owed. Creator fees are per-launch,
  // so "everything" means every launch it created — which the caller had to
  // know by heart before, since nothing listed them. Silently doing referral
  // and refunds only was the old behaviour and it left creator fees behind.
  const discovered = rows.length === 0;
  if (discovered) {
    const created = await rt.pump
      .profile(rt.signer.address)
      .then((p) => p.createdLaunches)
      .catch((e: unknown) => {
        notes.add(
          `could not list this wallet's launches (${e instanceof Error ? e.message : String(e)}) — creator fees were NOT checked; pass launchIds to claim them`,
        );
        return [] as ApiProfileLaunch[];
      });
    for (const l of created) {
      // A launch on an unknown core is skipped rather than fatal here: the
      // caller named no ids, so one unreadable launch must not block the
      // ledgers that ARE reachable.
      if (!coreDeploymentFor(rt.net, l.core)) {
        notes.add(`launch #${l.id} is on LaunchpadCore ${l.core ?? "(unnamed)"}, which this build does not know — skipped`);
        continue;
      }
      rows.push(l);
    }
  }

  const creatorFees: { launchId: string; amount: string }[] = [];
  const referralFees: { pairAsset: string; symbol: string; amount: string }[] = [];
  const txHashes: string[] = [];
  let refundBase = 0n;

  for (const dep of coreDeployments(rt.net)) {
    const mine = rows.filter(
      (r) => coreDeploymentFor(rt.net, r.core)?.core.toLowerCase() === dep.core.toLowerCase(),
    );
    const bySurrogate = new Map(mine.map((r) => [String(r.onchainId ?? r.id), r.id]));
    const venue = rt.shroom.forLaunch({ core: dep.core });
    const ids = mine.map((r) => BigInt(r.onchainId ?? r.id));

    // Preview reads the same three ledgers the claim path reads first, and
    // stops there. Nothing is signed, so this is the safe way to ask what a
    // launch is owed — previously the only way to find out was to collect it.
    if (args.preview) {
      const owed = await venue.claimable(ids);
      for (const c of owed.creator) {
        creatorFees.push({
          launchId: bySurrogate.get(c.launchId.toString()) ?? c.launchId.toString(),
          amount: `${formatUnits(c.amount, c.quote.decimals)} ${c.quote.symbol}`,
        });
      }
      for (const r of owed.referral) {
        referralFees.push({
          pairAsset: r.quote.pairAsset,
          symbol: r.quote.symbol,
          amount: formatUnits(r.amount, r.quote.decimals),
        });
      }
      refundBase += owed.refund;
      continue;
    }

    const res = await venue.claimAll(ids);
    for (const c of res.creatorFees) {
      creatorFees.push({ launchId: bySurrogate.get(c.onchainId) ?? c.onchainId, amount: c.amount });
    }
    referralFees.push(...res.referralFees);
    txHashes.push(...res.txHashes);
    for (const n of res.notes) {
      // "nothing to claim" is only worth saying once, about all cores at once.
      if (!n.startsWith("nothing to claim")) notes.add(n);
    }
    if (res.refundInj) {
      // Base units, not floats: this is a token amount, and two cores can both
      // owe one (a cancelled launch refunds on the core it was created on).
      refundBase += parseUnits(res.refundInj, 18);
    }
  }

  const pool = await collectPoolFees(rt, rows, args.preview === true);
  txHashes.push(...pool.txHashes);
  for (const n of pool.notes) notes.add(n);

  // After both rails: the core ledger is what pays in WINJ, so this has to see
  // the balance the claim above just produced.
  const winj = await settleWinj(rt, args.preview === true, args.unwrap !== false);
  txHashes.push(...winj.txHashes);
  for (const n of winj.notes) notes.add(n);

  const refundInj = refundBase > 0n ? formatUnits(refundBase, 18) : null;
  const nothing =
    creatorFees.length === 0 &&
    referralFees.length === 0 &&
    refundInj === null &&
    pool.poolFees.length === 0 &&
    winj.unwrappedInj === null;
  if (nothing) {
    notes.add("nothing to claim — every core ledger and every graduated pool is zero");
  } else if (args.preview) {
    notes.add("preview only — nothing was broadcast. Call claim_fees again without `preview` to collect this.");
  }
  if (discovered && rows.length > 0) {
    notes.add(`creator fees were checked for all ${rows.length} launch(es) this wallet created`);
  }
  return {
    ...(args.preview ? { preview: true } : {}),
    creatorFees,
    referralFees,
    poolFees: pool.poolFees,
    refundInj,
    ...(winj.unwrappedInj !== null ? { unwrappedInj: winj.unwrappedInj } : {}),
    txHashes,
    notes: [...notes],
  };
}

/**
 * The only fields a claim needs off a launch — satisfied by both an
 * `/launches` row and a profile's created row, which carry different columns.
 * `id` is the API surrogate and `onchainId` is what the core takes; the two
 * name different launches and are never interchangeable.
 */
type ClaimRow = {
  id: ApiLaunchId;
  core?: string;
  onchainId?: string;
  /** Quote slot + the launch token's denom, so the pool rail can name its legs. */
  quoteAsset: number;
  graduatedPoolDenom?: string | null;
  /** The post-graduation fee locker — null until the launch graduates. */
  lockerAddr?: string | null;
};

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
  /** Set when Choice quoted a price but the token has no liquidity and no 24h
   *  volume: the mark is not something anyone traded, so it is left out of
   *  `valueUsd`/`totalUsd` rather than presented as real money. */
  staleMark?: true;
  /** WINJ. Worth the same as INJ and counted in `totalUsd`, but it cannot pay
   *  gas or fund `buyNative` until `claim_fees` unwraps it. */
  wrappedInj?: true;
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

  // CW20 holdings are probed, not discovered: they are absent from
  // `bankBalances` and there is no "which CW20s does this address hold" query,
  // so a position is only ever visible if its contract is known up front.
  // Balances first — only a non-zero one is worth a price lookup. Every read is
  // fail-soft: one unreachable contract must not take down the whole portfolio.
  //
  // Done BEFORE the bank walk on purpose. This list is short and curated, while
  // bank balances are an unbounded dust tail, so walking bank first let 26 junk
  // denoms exhaust MAX_PRICE_LOOKUPS and leave a CW20 worth 88% of the wallet
  // unpriced — and therefore missing from `totalUsd`.
  const cw20Balances = await Promise.all(
    rt.net.cw20Tokens.map(async (contract) => ({
      contract,
      raw: await cw20Balance(rt.net.lcdUrl, contract, rt.injAddress).catch(() => 0n),
    })),
  );
  for (const { contract, raw } of cw20Balances) {
    if (raw <= 0n) continue;
    const priceLookup = lookups < MAX_PRICE_LOOKUPS;
    if (priceLookup) lookups += 1;
    rows.push(await cw20HoldingRow(rt, contract, raw, priceLookup));
  }

  for (const b of all) {
    const raw = BigInt(b.amount);
    if (raw <= 0n) continue;

    // WINJ before the quote-asset lookup, because it will never hit it: INJ's
    // `bankDenom` is "inj", so its pair asset is not in `quoteByDenom` and this
    // row used to fall all the way through to the Choice pricer, which does not
    // know it — leaving the curve creator-fee payout `unpriced` and therefore
    // MISSING from `totalUsd`. It is INJ, 1:1 and 18 decimals, so it prices off
    // the INJ quote rate; only the symbol distinguishes it.
    if (isWinjDenom(rt.net, b.denom)) {
      const inj = rt.net.quoteAssets.INJ;
      const amount = Number(formatUnits(raw, 18));
      // No INJ quote slot on this network means no rate to price against — the
      // row is still reported, just without a mark, rather than dropped.
      const valueUsd = inj ? await rt.shroom.usdValue(inj.slot, raw) : null;
      rows.push({
        denom: b.denom,
        symbol: "WINJ",
        amount,
        priceUsd: valueUsd !== null && amount > 0 ? valueUsd / amount : null,
        valueUsd,
        pricedVia: valueUsd !== null ? "quote-rate" : "unpriced",
        wrappedInj: true,
      });
      continue;
    }

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
 * its own namespace, so a denom under the launchpad's issuer cannot be spoofed.
 *
 * 🔴 The id it carries is the launch's id ON ITS OWN CORE, and every core mints
 * under the SAME issuer — so it is neither unique nor in the API's namespace.
 * Mainnet's two cores collide outright on ids 0..15 (`shroom_9_31dcaf…` and
 * `shroom_9_f28bdc…` are different tokens), and handing that id to the API
 * resolves a real but unrelated launch: `shroom_108_…` is INJEGG, while API
 * launch 108 is PEDRO. So the id is resolved against each core in turn, and the
 * salt in the subdenom breaks a tie.
 */
export async function launchFromDenom(rt: Runtime, denom: string): Promise<ApiLaunch | null> {
  const issuer = rt.net.launchDenomIssuer;
  if (!issuer || !denom.startsWith(`factory/${issuer}/`)) return null;
  const subdenom = denom.slice(`factory/${issuer}/`.length);
  // `<prefix>_<onchainId>_<salt>` — the prefix is a deploy-time setting
  // ("shroom" on mainnet, "shroom_t" on testnet), so anchor on the tail.
  const onchainId = /^[A-Za-z][A-Za-z_]*_(\d+)_[0-9a-fA-F]+$/.exec(subdenom)?.[1];
  if (!onchainId) return null;

  // Index first. `portfolio` resolves one of these per launch-token holding, so
  // a per-denom chain read is paid ~40 times on a real wallet — the listing
  // already carries `core`, `onchainId` and `sinkAddr` on every row, and one
  // pass over it answers the unambiguous majority for free.
  const byId = (await launchIndex(rt)).get(onchainId) ?? [];
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) return disambiguateBySink(rt, byId, denom);

  // Index miss: the listing omits some launches (hidden, and everything the
  // backend filters), so a held token can be absent from it. Fall back to
  // asking each core directly rather than reporting the holding as unknown.
  const hits: ApiLaunch[] = [];
  for (const dep of coreDeployments(rt.net)) {
    const live = await rt.shroom
      .forLaunch({ core: dep.core })
      .getLaunchView(BigInt(onchainId))
      .catch(() => null);
    if (!live) continue;
    // The token address is the launch's identity across both namespaces: the
    // chain gave it to us for (core, onchainId), and the API row it resolves to
    // has to agree about both before it names the same launch.
    const row = await findLaunchByToken(rt, live.token);
    if (!row) continue;
    if (row.core && row.core.toLowerCase() !== dep.core.toLowerCase()) continue;
    if (String(row.onchainId ?? row.id) !== onchainId) continue;
    hits.push({ ...row, sinkAddr: row.sinkAddr ?? evmToInj(live.sink) });
  }
  if (hits.length <= 1) return hits[0] ?? null;
  return disambiguateBySink(rt, hits, denom);
}

/**
 * Which of several same-id launches minted `denom`.
 *
 * Both mainnet cores mint under one tokenfactory issuer and both numbered their
 * launches from 0, so ids 0..15 name two different tokens. Nothing on a launch
 * derives the subdenom's salt — it is not a hash of the token, the sink, the
 * creator or the metadata — so the sink is asked what it actually minted.
 * Guessing the newer core instead would mislabel and misprice a holding in the
 * caller's own wallet, silently.
 *
 * Answered from a map built for EVERY colliding launch at once, because
 * `portfolio` hits this per holding: on a real wallet that was a dozen
 * sequential round trips, against one parallel batch here.
 */
async function disambiguateBySink(
  rt: Runtime,
  candidates: ApiLaunch[],
  denom: string,
): Promise<ApiLaunch | null> {
  const known = (await collidingDenoms(rt)).get(denom);
  if (known) return known;
  // Not in the batch (its sink would not answer, or the launch came from the
  // chain fallback rather than the listing) — ask this launch's own sinks.
  const answers = await Promise.all(
    candidates.map(async (row) => {
      if (!row.sinkAddr) return null;
      const minted = await sinkDenom(rt, row.sinkAddr);
      return minted === denom ? row : null;
    }),
  );
  return answers.find((r): r is ApiLaunch => r !== null) ?? null;
}

function sinkDenom(rt: Runtime, sink: string): Promise<string | null> {
  return smartQuery<{ token_denom?: string }>(rt.net.lcdUrl, sink, { sink_config: {} })
    .then((c) => c.token_denom ?? null)
    .catch(() => null);
}

const collidingDenomCache = new WeakMap<Runtime, { at: number; byDenom: Map<string, ApiLaunch> }>();

/**
 * `token_denom` -> launch, for every launch whose on-chain id is shared with a
 * launch on another core.
 *
 * Only the colliding ids are worth asking about: an id that exists on exactly
 * one core is already answered by the index for free. Mainnet's superseded core
 * is closed at 16 launches, so this is a bounded, one-shot batch.
 */
async function collidingDenoms(rt: Runtime): Promise<Map<string, ApiLaunch>> {
  const hit = collidingDenomCache.get(rt);
  if (hit && Date.now() - hit.at < LAUNCH_INDEX_TTL_MS) return hit.byDenom;

  const contested = [...(await launchIndex(rt)).values()]
    .filter((rows) => rows.length > 1)
    .flat()
    .filter((row) => row.sinkAddr);
  const resolved = await Promise.all(
    contested.map(async (row) => [await sinkDenom(rt, row.sinkAddr!), row] as const),
  );
  const byDenom = new Map<string, ApiLaunch>();
  for (const [minted, row] of resolved) if (minted) byDenom.set(minted, row);

  collidingDenomCache.set(rt, { at: Date.now(), byDenom });
  return byDenom;
}

/** How many listing pages to walk before giving up and using the chain path. */
const LAUNCH_INDEX_MAX_PAGES = 20;
const LAUNCH_INDEX_PAGE = 50;
const LAUNCH_INDEX_TTL_MS = 60_000;

const launchIndexCache = new WeakMap<
  Runtime,
  { at: number; byOnchainId: Map<string, ApiLaunch[]> }
>();

/**
 * Every listed launch, grouped by its ON-CHAIN id across all cores.
 *
 * Grouped by on-chain id and not by surrogate because that is the only id a
 * bank denom carries, and the point of the index is to answer "which launch is
 * this denom" without a chain read per holding. A group of more than one is a
 * cross-core collision, not an error.
 */
async function launchIndex(rt: Runtime): Promise<Map<string, ApiLaunch[]>> {
  const hit = launchIndexCache.get(rt);
  if (hit && Date.now() - hit.at < LAUNCH_INDEX_TTL_MS) return hit.byOnchainId;

  const byOnchainId = new Map<string, ApiLaunch[]>();
  try {
    let cursor: number | undefined = 0;
    for (let page = 0; page < LAUNCH_INDEX_MAX_PAGES; page++) {
      const res: { items: ApiLaunch[]; cursor?: number } = await rt.pump.listLaunches({
        limit: LAUNCH_INDEX_PAGE,
        cursor,
      });
      for (const row of res.items) {
        const key = String(row.onchainId ?? row.id);
        const bucket = byOnchainId.get(key);
        if (bucket) bucket.push(row);
        else byOnchainId.set(key, [row]);
      }
      if (res.items.length < LAUNCH_INDEX_PAGE || res.cursor === undefined) break;
      cursor = res.cursor;
    }
  } catch {
    // A partial or empty index is fine — every miss falls through to the chain.
  }
  launchIndexCache.set(rt, { at: Date.now(), byOnchainId });
  return byOnchainId;
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
      // Already normalised by the indexer — no decimal correction here.
      const priceQuote = Number(wad) / 1e18;
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
  const stale = priceUsd !== null && overview !== null && isDeadMarket(overview);
  if (stale) priceUsd = null;
  return {
    denom,
    symbol: null,
    ...sized,
    priceUsd,
    valueUsd: priceUsd !== null ? priceUsd * amount : null,
    pricedVia: priceUsd !== null ? "choice" : "unpriced",
    ...(stale ? { staleMark: true as const } : {}),
    untrusted_metadata: untrustedMeta({
      symbol: (overview as { symbol?: unknown } | null)?.symbol,
      name: (overview as { name?: unknown } | null)?.name,
    }),
  };
}

/**
 * Whether a Choice overview's price is a mark nobody has traded against.
 *
 * Choice will serve a stale quote for a token with no liquidity and no volume,
 * and `portfolio` multiplied it out unconditionally: 10,000 of one dead factory
 * denom marked at $541 contributed **$5.4M of a $5.4M total** on a wallet that
 * actually held dust. The decimals were right and the amount was right — only
 * the mark was junk, which is why no exponent guard catches this.
 *
 * That matters because `totalUsd` is what an agent reads to decide how big it
 * is, and anyone can airdrop such a token into a wallet unsolicited. So the
 * same rule as an unknown exponent applies: report the quantity, and keep a
 * number you do not trust out of the total.
 */
function isDeadMarket(overview: Record<string, unknown>): boolean {
  // Alive if anything is pooled in it OR anyone traded it today. Note Choice
  // OMITS `liquidity_usd` entirely for a token with no pools rather than
  // sending 0 — treating a missing field as "unknown, assume alive" made this
  // check inert against the very token that motivated it, while every real
  // asset sampled (INJ, USDT, QUNT, SHROOM, the launch denoms) carries it.
  const liq = Number(overview["liquidity_usd"]);
  if (Number.isFinite(liq) && liq > 0) return false;
  const markets = overview["top_markets"];
  if (!Array.isArray(markets)) return true;
  const vol = markets.reduce((a: number, m: unknown) => {
    const v = Number((m as Record<string, unknown> | null)?.["vol24h_usd"]);
    return a + (Number.isFinite(v) ? v : 0);
  }, 0);
  return vol <= 0;
}

/**
 * What the wallet holds of a known CW20 contract.
 *
 * Mirrors `choiceHoldingRow`, except every number is asked of the token
 * contract: a CW20 balance is not bank state and its exponent is not denom
 * metadata. Choice indexes CW20s under their contract address, so the same
 * price lookup works — `pricedVia` stays "choice".
 */
async function cw20HoldingRow(
  rt: Runtime,
  contract: string,
  raw: bigint,
  priceLookup: boolean,
): Promise<PortfolioRow> {
  const info = await cw20TokenInfo(rt.net.lcdUrl, contract).catch(() => null);
  // No token_info means no exponent from any source — same rule as a bank denom
  // with no metadata: report the exact base amount, assume 18 for the human
  // figure, and never price it, because price × guessed quantity is a confident
  // wrong number landing in `totalUsd`.
  const decimals = info?.decimals ?? null;
  const amount = Number(formatUnits(raw, decimals ?? 18));

  let priceUsd: number | null = null;
  let overview: Record<string, unknown> | null = null;
  if (priceLookup && decimals !== null) {
    try {
      overview = await rt.choiceApi.token(contract);
      priceUsd = extractUsdPrice(overview);
    } catch {
      // leave it unpriced; the holding itself still reports
    }
  }
  // Same rule as a bank denom: a mark on a market nobody trades is not money.
  const stale = priceUsd !== null && overview !== null && isDeadMarket(overview);
  if (stale) priceUsd = null;

  return {
    denom: contract,
    symbol: null,
    amount,
    ...(decimals === null ? { decimalsUnknown: true as const, amountBase: raw.toString() } : {}),
    priceUsd,
    valueUsd: priceUsd !== null ? priceUsd * amount : null,
    pricedVia: priceUsd !== null ? "choice" : "unpriced",
    ...(stale ? { staleMark: true as const } : {}),
    // The contract's own ticker is still third-party text, exactly like the
    // Choice overview's — it goes in the untrusted bucket, not `symbol`.
    untrusted_metadata: untrustedMeta({
      symbol: info?.symbol,
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
  const erc8004 = await erc8004Info(rt, agent?.erc8004AgentId ?? null);
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
    erc8004,
    ...(version ? { version } : { version: { running: PKG_VERSION } }),
    ...(other ? { otherAgentWallets: { ainj: other } } : {}),
  };
}

/**
 * The agent's ERC-8004 identity — Injective's ecosystem-wide on-chain agent
 * registry, which is a different thing from the SHROOM Pad `registered` flag
 * above (that one is the badge; this one is the portable, cross-chain passport).
 *
 * FAILS SOFT, deliberately: the registry is an upgradeable proxy behind a public
 * RPC, and `agent_info` is what a session reads first. A registry read that
 * flakes must degrade to `null` rather than break identity for the whole
 * session — so every failure path here returns the unregistered shape.
 */
async function erc8004Info(rt: Runtime, backendAgentId: string | null): Promise<unknown> {
  const nudge =
    "not registered in Injective's on-chain agent registry (ERC-8004). The human operator can mint one with `trippy-mcp identity register` — one transaction, about $0.0006 of gas.";
  try {
    const registry = new IdentityRegistry(rt.net, rt.signer);
    if (!registry.available) return null;
    const local = loadIdentityState(rt.home);
    const id = local?.agentId ?? backendAgentId;
    if (!id) return { registered: false, howToRegister: nudge };
    const view = await registry.view(BigInt(id));
    return {
      registered: true,
      agentId: view.agentId,
      owner: view.owner,
      agentWallet: view.agentWallet,
      custody: view.custody,
      cardUri: view.cardUri,
      identityTuple: view.identityTuple,
      // Omitted when the network has no explorer page: an empty string reads as
      // a link to the model, and it would offer it to the user.
      ...(view.scanUrl ? { scanUrl: view.scanUrl } : {}),
      ...(view.custody === "unlinked"
        ? {
            warning:
              "agentWallet is 0x0 — the identity was transferred and not re-linked, so trades from this wallet are not attributable to it. The operator runs `trippy-mcp identity link` and completes it in Trippy Terminal → Settings → Agents.",
          }
        : {}),
    };
  } catch {
    return null;
  }
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
