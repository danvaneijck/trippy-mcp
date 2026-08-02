/**
 * Topic: the Choice aggregator, written around the failure modes rather than
 * the feature list.
 *
 * Every gotcha below is one we have actually been bitten by in production, and
 * each has the same shape: the quote succeeds and the broadcast does not. An
 * agent that does not know them reads a clean quote as a guarantee, retries the
 * identical call, and fails identically.
 */

import type { LiveParams } from "./params.js";

export const id = "choice";
export const title = "Choice: routing, venues and the failure modes that matter";
export const summary =
  "How swaps route across Injective DEXs and the orderbook, and the four ways a clean quote still fails at broadcast.";

export const sources = [
  "Choice aggregator API (POST /api/quote) — route and fees are per-response",
  "choice.exchange venue coverage",
];

export function render(_p: LiveParams): string {
  return `# Choice — routing and its failure modes

Choice is a smart-order-router over most Injective liquidity: its own XYK and
CLMM pools, DojoSwap, Astroport, White Whale, and the Helix orderbook. You give
it a token pair and an amount; it returns a route and a ready-to-broadcast
execute message. \`quote\` shows you the route, \`buy\`/\`sell\` sign it.

Fees are per route and visible in the quote response, not a single protocol
number — a two-leg route through two venues pays both venues' fees. Read them
off the quote rather than assuming a rate.

## The four gotchas

**1. A quote can pass and the broadcast still fail on min_notional.**
Simulation does not check the exchange module's minimum notional, so a
sub-notional sell quotes cleanly and dies at broadcast. This mostly bites when
dumping dust. If a sell fails for no visible reason, check that it is worth
more than a few dollars before retrying it unchanged.

**2. Astroport legs assert a 0.5% max_spread that simulation cannot see.**
The aggregator sends \`max_spread: None\` and Astroport substitutes its own
default. The assert lives inside the leg, so a route can simulate clean and
revert on execution. The fix is a higher slippage tolerance, not a retry of the
same numbers — but slippage here is clamped by local policy, so an unreachable
tolerance means the trade genuinely should not be taken.

**3. \`total_liquidity_usd\` on a token is AMM-only.** It sums pool liquidity
and ignores orderbook depth entirely, so a token that trades mainly on Helix
reads as far thinner than it is. Use it as a floor, never as the answer to
"can this size fill".

**4. Rate limiting surfaces as a CORS error**, not as a 429. An unexplained
network-shaped failure on a burst of calls is usually throughput, so back off
rather than treating it as an outage.

## Attribution

Every swap this server signs carries the memo \`trippy-mcp:<agent-name>\`, which
is how trades made by an agent are attributed back to it in the Terminal. It
identifies the agent; it does not authorise anything.

## Routing boundary with the curve

Active bonding-curve launches trade on SHROOM Pad and NOT through Choice — a
graduated token is the opposite. The trading tools resolve this for you, but it
explains the errors: a curve call against a graduated launch reverts, and a
Choice route for an un-graduated launch finds no liquidity because there is
none to find until it graduates.`;
}
