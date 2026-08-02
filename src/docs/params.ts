/**
 * Live protocol parameters for the `explain` topics.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: the prose in `src/docs/*.ts` carries
 * no numbers. Every figure an agent reads is fetched here, at call time.
 *
 * That is not fastidiousness, it is a bug we already shipped once: the deploy
 * scripts say the launch creation fee is 1 INJ, and mainnet was lowered to 0.2
 * INJ post-deploy through `setDenomCreationFeeInj`. A number baked into an npm
 * package would have kept saying 1 INJ until somebody cut a release — and an
 * agent budgeting a launch off it would have been wrong every single time.
 *
 * Everything here fails SOFT. A topic that can't reach the chain is still worth
 * reading for its mechanics; it just says which figures are missing instead of
 * inventing them.
 */

import { formatUnits, type Address } from "viem";

import { quoteAssetBySlot } from "../chain/networks.js";
import type { Runtime } from "../runtime.js";

/** One quote asset's terms for a NEW launch (see `snapshotNote`). */
export interface QuoteParams {
  symbol: string;
  slot: number;
  enabled: boolean;
  pairAsset: string;
  bankDenom: string;
  decimals: number;
  /** Human units of the quote asset. */
  virtualPair: string;
  graduationPairTarget: string;
  /** Human units of the launch token (always 18-decimal). */
  virtualToken: string;
  curveSupply: string;
  graduationTokenReserve: string;
  tradeFeeBps: number;
  creatorFeeShareBps: number;
  /** Convenience for prose: creatorFeeShareBps as a % of every trade. */
  creatorTakePct: number;
}

export interface LiveParams {
  creationFeeInj: string | null;
  referralShareBps: number | null;
  treasury: string | null;
  quotes: QuoteParams[];
  /** Reads that failed, so a topic can say "unavailable" rather than guess. */
  errors: string[];
  fetchedAt: string;
}

/**
 * Slots probed beyond the vendored registry. LaunchpadCore keys quote assets by
 * a uint8, and the owner can enable a new one with `setQuoteAssetConfig` and no
 * redeploy — so an agent asking "what can I launch against?" must be answered
 * from the chain, not from our bundled list, or it will never see a quote asset
 * added after this package was published.
 */
const PROBE_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7];

const LIVE_TTL_MS = 60_000;

let cache: { at: number; value: LiveParams } | null = null;

/** Drop the memo — tests and long-lived servers that want a forced refetch. */
export function resetLiveParamsCache(): void {
  cache = null;
}

export async function loadLiveParams(rt: Runtime, now = Date.now()): Promise<LiveParams> {
  if (cache && now - cache.at < LIVE_TTL_MS) return cache.value;
  const value = await readLiveParams(rt);
  cache = { at: now, value };
  return value;
}

async function readLiveParams(rt: Runtime): Promise<LiveParams> {
  const errors: string[] = [];

  const [creationFeeInj, referralShareBps, treasury] = await Promise.all([
    rt.shroom
      .denomCreationFeeInj()
      .then((wei) => formatUnits(wei, 18))
      .catch((e: unknown) => {
        errors.push(`denomCreationFeeInj: ${reason(e)}`);
        return null;
      }),
    rt.shroom.referralShareBps().catch((e: unknown) => {
      errors.push(`referralShareBps: ${reason(e)}`);
      return null;
    }),
    rt.shroom.treasury().catch(() => null),
  ]);

  const quotes: QuoteParams[] = [];
  const probed = await Promise.all(
    PROBE_SLOTS.map(async (slot) => {
      try {
        return { slot, cfg: await rt.shroom.getQuoteAssetConfig(slot) };
      } catch {
        // An unconfigured slot may revert rather than return a zeroed struct.
        // That is a normal answer to "is anything here?", not an error worth
        // showing the agent.
        return null;
      }
    }),
  );

  for (const hit of probed) {
    if (!hit) continue;
    const { slot, cfg } = hit;
    const known = quoteAssetBySlot(rt.net, slot);
    // Skip empty slots, but never skip one we ship a name for: a quote asset
    // the registry knows about that reads as disabled is itself information.
    if (!cfg.enabled && !known) continue;
    if (cfg.pairAsset === "0x0000000000000000000000000000000000000000" && !known) continue;

    const decimals = await rt.shroom.quoteDecimals(slot, cfg.pairAsset as Address);
    const symbol = known?.symbol ?? (await rt.shroom.erc20Symbol(cfg.pairAsset as Address)) ?? `slot${slot}`;
    quotes.push({
      symbol,
      slot,
      enabled: cfg.enabled,
      pairAsset: cfg.pairAsset,
      bankDenom: cfg.bankDenom,
      decimals,
      virtualPair: formatUnits(cfg.virtualPair, decimals),
      graduationPairTarget: formatUnits(cfg.graduationPairTarget, decimals),
      virtualToken: formatUnits(cfg.virtualToken, 18),
      curveSupply: formatUnits(cfg.curveSupply, 18),
      graduationTokenReserve: formatUnits(cfg.graduationTokenReserve, 18),
      tradeFeeBps: cfg.tradeFeeBps,
      creatorFeeShareBps: cfg.creatorFeeShareBps,
      creatorTakePct: (cfg.tradeFeeBps / 10_000) * (cfg.creatorFeeShareBps / 10_000) * 100,
    });
  }

  if (quotes.length === 0) errors.push("getQuoteAssetConfig: no quote assets readable");

  return {
    creationFeeInj,
    referralShareBps,
    treasury,
    quotes,
    errors,
    fetchedAt: new Date().toISOString(),
  };
}

function reason(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return (msg.split("\n")[0] ?? msg).slice(0, 120);
}

// ---------------------------------------------------------------------------
// small formatting helpers shared by the topic modules
// ---------------------------------------------------------------------------

/** A figure we could not read. Never renders as a plausible-looking number. */
export const UNKNOWN = "(unavailable — chain read failed)";

export function fee(p: LiveParams): string {
  return p.creationFeeInj === null ? UNKNOWN : `${p.creationFeeInj} INJ`;
}

export function bps(value: number | null, suffix = ""): string {
  return value === null ? UNKNOWN : `${value} bps (${value / 100}%)${suffix}`;
}

export function quoteBySymbol(p: LiveParams, symbol: string): QuoteParams | undefined {
  return p.quotes.find((q) => q.symbol === symbol);
}

/**
 * The single most misread fact about these parameters, repeated in every topic
 * that quotes one.
 */
export const SNAPSHOT_NOTE =
  "These are the terms for NEW launches. LaunchpadCore copies the whole quote-asset config onto a launch at createLaunch, so an existing launch keeps whatever it launched with — read a specific launch's own numbers with `token_info`. The one exception is referralShareBps, which is global and applies to every launch immediately.";
