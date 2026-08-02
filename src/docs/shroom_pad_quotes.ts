/**
 * Topic: choosing a quote asset for a launch.
 *
 * Tone is mechanics plus a light comparative frame — enough that an agent can
 * pick deliberately instead of defaulting, without the docs turning into a
 * playbook that steers trades.
 *
 * The quote table is built entirely from live reads, including slots this
 * package ships no name for: the owner can enable a new quote asset with
 * `setQuoteAssetConfig` and no redeploy, and a hard-coded list of three would
 * hide it forever.
 */

import { SNAPSHOT_NOTE, UNKNOWN, type LiveParams, type QuoteParams } from "./params.js";

export const id = "shroom_pad_quotes";
export const title = "SHROOM Pad: choosing a quote asset";
export const summary =
  "What INJ / USDC / SAI (and any newer slot) actually change about a launch — creator take, graduation target, decimals.";

export const sources = [
  "LaunchpadCore.getQuoteAssetConfig(slot) for slots 0-7 (live read)",
  "LaunchpadCore.referralShareBps (live read)",
];

/** Qualitative notes per quote asset. Mechanics only — no numbers live here. */
const CHARACTER: Record<string, string> = {
  INJ: "The native, most liquid quote. Buys and sells go through buyNative/sellNative with msg.value, so a trade needs no ERC20 approval and no wrapping step. This is the default for `create_token` and the counter asset Choice routes against by default, which makes it the cheapest option to enter and exit.",
  USDC: "A stable-denominated raise: the graduation target is a dollar amount rather than a moving INJ amount, so the size of the raise is knowable up front. FOOTGUN: USDC is 6-decimal, not 18. Every base-unit amount on a USDC launch is 1e6-scaled. The tools convert for you, but any arithmetic you do yourself against raw amounts must use 6.",
  SAI: "The creator-incentive quote: the creator's share of the trade fee is set far above the other quotes, so the creator earns materially more per unit of volume — and keeps earning it after graduation, because the CLMM pool's fees stream on the same split. SAI is also the only asset allowlisted as a holder-discount gate token, so a SAI-quoted launch is the one that can reward SAI holders with a fee discount.",
};

function row(q: QuoteParams): string {
  const flag = q.enabled ? "" : "  [DISABLED — new launches cannot use it]";
  return `### ${q.symbol} (slot ${q.slot})${flag}

  graduation target      ${q.graduationPairTarget} ${q.symbol}
  virtual reserves       ${q.virtualPair} ${q.symbol} / ${q.virtualToken} tokens
  curve supply           ${q.curveSupply} tokens
  graduation reserve     ${q.graduationTokenReserve} tokens
  trade fee              ${q.tradeFeeBps} bps (${q.tradeFeeBps / 100}%)
  creator share of fee   ${q.creatorFeeShareBps} bps (${q.creatorFeeShareBps / 100}%)
  creator take per trade ~${q.creatorTakePct.toFixed(4)}% of trade size
  decimals               ${q.decimals}
  bank denom             ${q.bankDenom}
  pair asset (ERC20)     ${q.pairAsset}

${CHARACTER[q.symbol] ?? "No qualitative notes shipped for this quote asset — it was enabled after this package was published. The parameters above are read live and are authoritative."}`;
}

export function render(p: LiveParams): string {
  const table = p.quotes.length > 0 ? p.quotes.map(row).join("\n\n") : UNKNOWN;
  const takes = p.quotes
    .filter((q) => q.enabled)
    .sort((a, b) => b.creatorTakePct - a.creatorTakePct)
    .map((q) => `${q.symbol} ~${q.creatorTakePct.toFixed(4)}%`)
    .join(" > ");

  return `# Choosing a quote asset

The quote asset is the currency a launch raises in. It is fixed at
createLaunch and cannot be changed afterwards. It decides four things: what
buyers must hold to buy, how large the raise is, how much the creator earns
per trade, and the decimal scale of every amount on the launch.

## Live terms

${table}

## How to pick

Creator take per unit of volume, highest first: ${takes || UNKNOWN}

- Launching to **earn from volume** — the highest creator-share quote pays the
  most per trade, and keeps paying after graduation because the graduated pool
  streams fees on the same split.
- Launching to **maximise reach and easy exits** — INJ is what most wallets
  already hold and what the aggregator routes against by default.
- Launching with a **fixed dollar raise** — USDC makes the graduation target a
  stable number instead of one that moves with the INJ price.

None of these is a recommendation about whether to launch, or about which
token will trade well. The quote asset changes the terms, not the outcome.

## Two things that bite

1. **Decimals are per quote asset.** A 6-decimal quote (USDC) means base-unit
   amounts are 1e6, not 1e18. Mixing the two silently produces amounts wrong by
   a factor of a trillion.
2. **Slots beyond the ones listed can exist.** Quote assets are keyed by a
   uint8 and can be added by the owner without a contract redeploy. The table
   above is read from the chain at call time for slots 0-7, so it shows what
   is actually enabled right now, not what this package shipped knowing about.

${SNAPSHOT_NOTE}`;
}
