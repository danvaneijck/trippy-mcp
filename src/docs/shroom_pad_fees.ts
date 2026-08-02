/**
 * Topic: every fee on SHROOM Pad and who ends up with it.
 *
 * The referral figure is the one to get right: `referralShareBps` is a share
 * of the CREATOR's cut, not of the trade, so the effective rate on a trade is
 * tradeFee x creatorShare x referralShare — three multiplications deep. An
 * agent that reads it as a share of the trade overestimates referral income by
 * two orders of magnitude, which is exactly the kind of error that turns into
 * a confidently wrong answer to a user.
 */

import { bps, fee, SNAPSHOT_NOTE, UNKNOWN, type LiveParams } from "./params.js";

export const id = "shroom_pad_fees";
export const title = "SHROOM Pad: fees, discounts and gates";
export const summary =
  "Creation fee, the trade fee and its creator/platform split, referral share, holder discounts, and what graduation costs.";

export const sources = [
  "LaunchpadCore.denomCreationFeeInj / referralShareBps / getQuoteAssetConfig (live reads)",
  "LaunchpadCore.getLaunch(launchId).gate — per-launch, surfaced by token_info",
];

export function render(p: LiveParams): string {
  const referralRows =
    p.referralShareBps === null
      ? UNKNOWN
      : p.quotes
          .filter((q) => q.enabled)
          .map((q) => {
            const effective =
              (q.tradeFeeBps / 10_000) *
              (q.creatorFeeShareBps / 10_000) *
              (p.referralShareBps! / 10_000) *
              10_000;
            return `  ${q.symbol.padEnd(6)} ~${effective.toFixed(4)} bps of the buy`;
          })
          .join("\n");

  const splitRows =
    p.quotes.length === 0
      ? UNKNOWN
      : p.quotes
          .filter((q) => q.enabled)
          .map(
            (q) =>
              `  ${q.symbol.padEnd(6)} fee ${String(q.tradeFeeBps).padStart(4)} bps -> creator ${q.creatorFeeShareBps / 100}% / platform ${(10_000 - q.creatorFeeShareBps) / 100}%   (creator keeps ~${q.creatorTakePct.toFixed(4)}% of trade size)`,
          )
          .join("\n");

  return `# Fees, discounts and gates

## 1. Creation fee

${fee(p)}, paid in INJ with createLaunch. It is **escrowed, not spent**: if the
launch never binds and goes Cancelled, it is refundable — \`claim_fees\` picks
it up along with everything else owed to the wallet.

Owner-settable (\`setDenomCreationFeeInj\`) and it HAS changed on mainnet since
deploy, which is why this figure is read live rather than written down.

## 2. Trade fee

Charged on every curve buy and sell, and taken from different sides:

- buys  — off the INPUT (you pay quote asset, the fee comes out before the
          curve math, so tokenOut is computed on the net amount)
- sells — off the OUTPUT (pairOut in a sell quote is already NET of fee, and
          minPairOut is compared against that same net basis on-chain)

Per-quote fee and split:

${splitRows}

The creator's side accrues to a claimable ledger, not to their wallet — call
\`claim_fees\` with the launchIds to collect. The platform side goes to the fee
treasury${p.treasury ? ` (${p.treasury})` : ""}.

## 3. Referral

\`referralShareBps\` = ${bps(p.referralShareBps)} of the **creator's cut** — not
of the trade. Buys only; sells pay no referral. So the effective rate a
referrer earns on a buy is fee x creatorShare x referralShare:

${referralRows}

Two contract rules that silently zero it: the referrer may not be the buyer,
and may not be the launch creator. This server passes the platform treasury as
the default referrer and automatically substitutes address(0) when the agent is
itself the creator, so a self-launch is never affected.

Unlike everything in the quote-asset config, referralShareBps is GLOBAL and not
snapshotted onto a launch — a change applies to every existing launch at once.

Referral fees accrue per (referrer, pairAsset) and are claimed with
\`claim_fees\`.

## 4. Holder discounts and access gates

Per-launch, set by the creator at createLaunch, and inspectable for any launch
through \`token_info\`. The gate is four fields: \`gateToken\`, \`minBalance\`,
\`discountBps\`, \`windowEndsAt\`.

- A wallet qualifies if its \`balanceOf(gateToken)\` is at least \`minBalance\`.
  Qualification is checked with a non-reverting call, so a gate token that is
  not a working ERC20 simply fails to qualify anyone.
- \`discountBps\` > 0 — qualifying buyers get up to that fraction of the
  **creator's** cut waived, capped at 100% of it. The platform's leg is never
  reduced, so the fee can never reach zero.
- \`discountBps\` = 0 — the gate is a hard ACCESS gate instead of a discount:
  non-qualifying wallets cannot buy at all while the window is open.
- \`windowEndsAt\` — after this timestamp the gate stops applying entirely.

You never have to model the discount yourself: \`quoteBuy\`/\`quoteSell\` take
an \`account\` argument and apply that account's discount, so a quote is
bit-exact for the wallet that will actually trade. \`token_info\` reports both
the gate and whether this agent currently qualifies.

## 5. Graduation

No graduation fee. Liquidity moves into a Choice CLMM pool at the 0.30% tier
and the position is locked permanently. Pool fees stream to the creator and the
platform on the SAME split the curve used, so a launch keeps paying its creator
after it stops trading on the curve.

${SNAPSHOT_NOTE}`;
}
