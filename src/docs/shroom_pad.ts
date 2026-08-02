/**
 * Topic: how SHROOM Pad works. Lifecycle + curve mechanics.
 *
 * Content is a render function rather than a `{{slot}}` template on purpose:
 * a mistyped placeholder in a string is invisible until an agent reads it and
 * quotes "{{graduationTarget}}" back at a user, whereas a mistyped property
 * here fails `npm run typecheck`. Same "prose carries no numbers" discipline,
 * enforced by the compiler.
 */

import { fee, SNAPSHOT_NOTE, type LiveParams } from "./params.js";

export const id = "shroom_pad";
export const title = "SHROOM Pad: lifecycle and curve mechanics";
export const summary =
  "How a bonding-curve launch is born, trades, fills and graduates — states, xy=k math, supply split, anti-snipe controls.";

export const sources = [
  "LaunchpadCore.getLaunch / getQuoteAssetConfig / denomCreationFeeInj (live reads)",
  "shroom_launchpad MAINNET_DEPLOYMENT.md",
];

export function render(p: LiveParams): string {
  const q = p.quotes[0];
  return `# SHROOM Pad — lifecycle and curve mechanics

A launch is a bonding curve that sells a fixed token supply for a quote asset,
then converts the raised amount into a permanent DEX pool.

## Lifecycle

createLaunch (costs ${fee(p)}, escrowed)
  -> Reserved(7)    the keeper must mint the bank denom and bind it
  -> Trading(1)     tradable; buy/sell against the curve
  -> CurveFilled(2) the graduation target was reached
  -> PendingSettlement(3) -> Graduated(4)  liquidity is in a Choice CLMM pool

Two side exits: Cancelled(8) if the keeper misses the bind deadline (contract
default 1 hour) — the creation fee is refundable with \`claim_fees\` — and
SettlementFailed(5)/Refunded(6) if graduation itself cannot complete.

The important consequence for an agent: **createLaunch does not produce a
tradable token.** It returns a launchId in state Reserved. Trading only opens
when the keeper flips it to Trading, usually within seconds. \`create_token\`
polls for this and tells you the state it ended on.

## Curve math

Constant product (xy=k) over VIRTUAL reserves, so the curve has a finite,
non-zero starting price with no seeded liquidity:

    price = (virtualPair + realPair) / (virtualToken - tokensSold)

\`virtualPair\` and \`virtualToken\` are per-quote-asset constants${
    q ? ` (currently ${q.virtualPair} ${q.symbol} / ${q.virtualToken} tokens on ${q.symbol})` : ""
  }.
Buys move along the curve and raise the price; sells move back down it. There
is no orderbook and no counterparty — the curve is always willing to trade.

## Supply

Total supply is fixed at 1,000,000,000 tokens, split at bind time:
${
  q
    ? `  - ${q.curveSupply} sold through the curve
  - ${q.graduationTokenReserve} held back as the graduation pool reserve`
    : "  - a curve tranche sold through the curve\n  - a reserve tranche held back for the graduation pool"
}

Unsold curve supply lives in the launch's own sink contract, not with the
creator. Supply admin is renounced when the keeper binds, so nobody can mint
more afterwards.

## Graduation

The target is a **raised amount** in the quote asset${
    q ? ` (${q.graduationPairTarget} ${q.symbol} on ${q.symbol})` : ""
  }, NOT a
market cap. Progress is \`realPair / graduationPairTarget\` and \`token_info\`
reports it directly.

A buy that would cross the target is **capped and partially refunded inside the
same transaction** — you get the tokens up to the target and the excess quote
asset back, and the launch graduates. This is not a failure and needs no retry;
\`quote\` shows the refund before you commit.

Graduated liquidity goes into a Choice CLMM pool at the 0.30% tier and the
position is locked forever. After that the token trades on Choice, not on the
curve — the trading tools auto-route, but a direct curve call would revert.

## The token itself

One token, two interfaces: a Cosmos tokenfactory bank denom AND an
erc20-module ERC20 at the same address, sharing ONE balance. Launch tokens are
always 18-decimal. A bank transfer and an ERC20 transfer move the same coins,
so holder snapshots taken from either side are complete.

## Anti-snipe controls (set by the creator at launch)

- \`tradingOpensAt\` — a timestamp before which buys revert. Combined with a
  creator-exclusive first buy, this is how a creator takes a dev position
  without racing bots.
- guard window (\`guardWindowEndsAt\` + \`maxBuyBpsInGuardWindow\`) — caps
  CUMULATIVE buys per wallet at a fraction of the graduation target while it
  is open. \`quote\` warns when one is active; the cap is per wallet, so
  splitting a buy across transactions does not evade it.
- holder gate (\`gate\`) — restricts buying to holders of a gate token during a
  window. See the \`shroom_pad_fees\` topic; \`token_info\` reports whether THIS
  agent currently qualifies.

None of these are visible to \`quoteBuy\`/\`quoteSell\` — the quote functions
model the curve only. Everything else is prechecked before a trade is built.

${SNAPSHOT_NOTE}`;
}
