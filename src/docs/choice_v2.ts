/**
 * Topic: Choice v2 — the EVM DEX an atomic-core launch graduates onto, and how
 * this package trades it without trusting the API that indexes it.
 */

import type { LiveParams } from "./params.js";

export const id = "choice_v2";
export const title = "Choice v2: the EVM pools graduated launches trade in";
export const summary =
  "Where atomic-core launches go at graduation, how quote/buy/sell route there, and what is (and is not) trusted on the way.";

export const sources = [
  "choice_v2_contracts deployments/injective_mainnet.json (UniversalRouter, CLQuoter, Permit2, launch hooks)",
  "PancakeSwap Infinity universal router (Commands / Actions)",
  "evm-api.choice.exchange (read-only indexer)",
];

export function render(_p: LiveParams): string {
  return `# Choice v2 — Infinity CL pools on Injective EVM

Choice has two DEXs. **Choice v1** is CosmWasm: the aggregator behind
\`topic: choice\`, where launches on the older SHROOM Pad cores graduated.
**Choice v2** is a PancakeSwap Infinity fork on Injective EVM, and it is where
every launch on the ATOMIC core graduates — in the same permissionless
transaction that fills the curve. Those launches have NO Choice v1 pool; v2 is
their only market. Many other EVM tokens (DojoFun launches among them) trade
only there too.

## How the tools route

- A graduated atomic-core launch -> Choice v2, its own pool.
- A graduated launch on an older core -> Choice v1, as always.
- A plain 0x token -> whichever venue lists it.
- A bank denom or CW20 -> Choice v1.
- Listed on BOTH (one balance, two markets — MOTION is one): \`quote\` prices
  the trade on both and reports the better one with the other as
  \`alternative\`; \`buy\`/\`sell\` execute on the better one.

Pools are wINJ-quoted, but you trade native INJ: the router wraps it on the way
in and unwraps it on the way out, in the same transaction. Routes are
SINGLE-HOP — the token has to be paired directly with the counter asset.

## The pools a launch graduates into

- **LaunchPoolFeeHook** pools (most graduates): LP fee zero, and the hook
  charges the launch's OWN trade fee on the quote side of every swap, for life,
  crediting the creator. The fee is inside every quote.
- **LaunchPoolGuardHook** pools (the earliest graduates): the hook only guards
  pool creation and never runs on a swap; the pool charges an ordinary LP fee.

A pool behind any OTHER hook is refused: a hook runs code inside the swap and
can take any cut it likes.

## What is trusted, and what is not

The v2 indexer API is read-only to this package. It is never asked for a quote
and its \`/route\` calldata is never signed — a compromised API could otherwise
hand back a plan that pays someone else.

- **Which pool**: a launch's pool is read off the chain (its settler's
  position locker names the position, the position names the pool). Other
  tokens' pools are nominated by the API, then re-hashed to their id and
  confirmed live on the pinned pool manager; the best on-chain quote among them
  wins.
- **How much**: the CLQuoter contract simulates the swap through the hook; the
  minimum out is that quote less your slippage.
- **What is signed**: built locally and re-decoded before signing — only the
  expected commands, the exact input, a floor no lower than the quote's, and
  every recipient the wallet itself.
- **What is approved**: selling an ERC20 approves Permit2 for EXACTLY the
  amount, and Permit2 lets the router pull exactly that amount for a few
  minutes. Never unlimited, never open-ended — the policy engine refuses
  anything else.

## Read tools

\`token_info\` shows the token's indexer price and every pool verified on
chain; \`recent_trades\` and \`candles\` read the v2 tape and USD candles of the
token's pool; \`portfolio\` prices v2-only holdings off the v2 indexer while a
live pool stands behind the mark.

## Not covered yet

The graduated pool's own creator-fee rail on v2 (the fee hook's per-launch
ledger, or the v2 position locker) is not read or collected by \`claim_fees\`.`;
}
