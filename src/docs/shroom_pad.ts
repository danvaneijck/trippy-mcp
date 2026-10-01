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

🔴 **An ATOMIC core skips all of that** — and new launches are created on one on
both networks (mainnet since 2026-09-13, testnet since 2026-09-11). It issues
the token through its own \`LaunchTokenFactory\`, binds it and opens the curve
INSIDE \`createLaunch\`, in the creator's own transaction — so a launch is
Trading the moment the create lands, there is no Reserved state to poll, no
keeper, no bind deadline and therefore no Cancelled-on-missed-bind exit. It also
numbers its on-chain ids from 10000 on mainnet (1000 on testnet), never from 0.
The older cores stay live for the launches already on them, so a launch's core
decides its rules; the tools resolve that per launch. Consequences an agent
will hit:

- \`msg.value\` must be EXACTLY the creation fee (plus the opening buy on a wINJ
  quote); an overshoot reverts rather than refunding.
- The exclusive pre-open window works differently. \`buy()\` there has NO creator
  exemption — the creator's one exclusive buy is the opening buy carried inside
  \`createLaunchWithOptions\`, in the same transaction. A delayed open plus a
  separate buy, which is what the window meant on every earlier core, would lock
  the creator out of their own window. \`create_token\` refuses
  \`devBuyDelaySeconds\` on such a core rather than sell you one.
- Only the quote slots the core has enabled take a new launch, and it reports
  them live: \`explain("shroom_pad_fees")\` lists them, and \`create_token\`
  refuses a disabled one before spending anything. INJ also has a higher FEE
  TIER on its own quote slot (\`create_token\`'s \`tradeFeeBps\`): same asset,
  higher trade fee, frozen onto the launch.

## Curve math

Constant product (xy=k) over VIRTUAL reserves, so the curve has a finite,
non-zero starting price with no seeded liquidity:

    price = (virtualPair + realPair) / (virtualToken - tokensSold)

${
    q && q.virtualPair && q.virtualToken
      ? `\`virtualPair\` and \`virtualToken\` are per-quote-asset constants (currently ${q.virtualPair} ${q.symbol} / ${q.virtualToken} tokens on ${q.symbol}).`
      : "`virtualPair` and `virtualToken` are chosen PER LAUNCH from the curve registry, so two launches on the same quote asset can have completely different curves. Read a specific launch's own numbers with `token_info` — there is no single curve for a quote asset."
  }
Buys move along the curve and raise the price; sells move back down it. There
is no orderbook and no counterparty — the curve is always willing to trade.

## Supply

Total supply is fixed at 1,000,000,000 tokens, split at bind time:
${
  q && q.curveSupply && q.graduationTokenReserve
    ? `  - ${q.curveSupply} sold through the curve
  - ${q.graduationTokenReserve} held back as the graduation pool reserve`
    : "  - a curve tranche sold through the curve\n  - a reserve tranche held back for the graduation pool\n\nThe exact split is set by the launch's curve preset, so it varies per launch."
}

Unsold curve supply lives in the launch's own sink contract, not with the
creator. Supply admin is renounced when the keeper binds, so nobody can mint
more afterwards. (On an atomic core there is no sink and no keeper: unsold
supply sits on the core itself, and the token's owner is renounced by the
factory at issue — inside the create transaction.)

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

Where the liquidity goes depends on the launch's core, and the position is
locked forever either way:

- **Atomic core** — graduation is permissionless and atomic: whoever crosses
  the target triggers it, and \`InfinitySettler\` seeds a **Choice v2** pool
  (PancakeSwap Infinity CL, on Injective EVM) in the same transaction. The pool
  is wINJ-quoted and keyed to a launch hook: recent graduates charge the
  launch's OWN trade fee through \`LaunchPoolFeeHook\` (LP fee 0), while the
  earliest ones charge an ordinary LP fee instead.
- **Older cores** — a Choice v1 (CosmWasm) CLMM pool at the 0.30% tier.

After that the token trades on Choice, not on the curve — a direct curve call
would revert.

## The token itself

One token, two interfaces: a Cosmos bank denom AND an ERC20, sharing ONE
balance. On the older cores the bank side is a tokenfactory denom with a
per-launch salt; on an atomic core it is a bank-precompile ERC20 whose denom is
\`erc20:\` plus the CHECKSUMMED token address. Launch tokens are always
18-decimal. A bank transfer and an ERC20 transfer move the same coins,
so holder snapshots taken from either side are complete.

## Anti-snipe controls (set by the creator at launch)

- \`tradingOpensAt\` — a timestamp before which buys revert. Combined with a
  creator-exclusive first buy, this is how a creator takes a dev position
  without racing bots. The delay has to outlast the KEEPER BIND, not just the
  buy: create-to-first-trade has measured 28-65s on mainnet, so a 60s window is
  a coin flip and \`create_token\` refuses anything under 180s by default.
- guard window (\`guardWindowEndsAt\` + \`maxBuyBpsInGuardWindow\`) — caps
  CUMULATIVE buys per wallet at a fraction of the graduation target while it
  is open. \`quote\` warns when one is active; the cap is per wallet, so
  splitting a buy across transactions does not evade it.
- holder gate (\`gate\`) — restricts buying to holders of a gate token during a
  window. See the \`shroom_pad_fees\` topic; \`token_info\` reports whether THIS
  agent currently qualifies.

None of these are visible to \`quoteBuy\`/\`quoteSell\` — the quote functions
model the curve only. Everything else is prechecked before a trade is built.

## After the launch: what a creator has to manage

A launch does not report to you. Three things keep accruing quietly and none of
them move on their own:

- **Creator fees.** Every trade pays them into a per-launch ledger ON THE CORE,
  keyed by the launch's on-chain id. They are not a balance and they never
  reach the wallet until \`claim_fees\` is called.
- **The dev bag.** Bought on the curve like anyone else's, so it is priced by
  the curve and only realised by selling.
- **The window that already happened.** \`tradingOpensAt\` is frozen at
  creation and is the only record of how much exclusivity the launch really
  got, once the keeper bind has eaten its share. On an atomic core nothing eats
  it: the opening buy is in the create transaction, and \`tradingOpensAt\` is
  the next second.

\`my_launches\` reads all three for every launch this wallet created — the fee
ledger straight off the core, the bag at a live exit quote, the window as it
actually landed. It signs nothing, and neither does \`claim_fees\` with
\`preview: true\`. Collecting is the only step that costs gas.

${SNAPSHOT_NOTE}`;
}
