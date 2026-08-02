/**
 * Topic: how this server itself works.
 *
 * Most of this already exists as file-header docstrings across the package,
 * which is exactly where an agent cannot read it. Surfacing it matters because
 * the commonest failure on this surface is not a bad trade, it is an agent
 * that does not understand its own constraints: it retries around a policy
 * denial, or reports another keystore's balance as its own.
 */

import { fee, type LiveParams } from "./params.js";

export const id = "agent_wallet";
export const title = "This agent: wallet, policy engine and identity";
export const summary =
  "How the agent's own wallet, spend policy, gas and identity work — and what it is structurally unable to do.";

export const sources = [
  "trippy-mcp config.json (policy) — inspect with wallet_status",
  "LaunchpadCore.denomCreationFeeInj (live read)",
];

export function render(p: LiveParams): string {
  return `# This agent's wallet, policy and identity

## One key, two address forms

The wallet is a single secp256k1 key generated at \`trippy-mcp init\` and stored
encrypted on this machine. It is never uploaded anywhere. The same 20 bytes are
addressed two ways: \`0x…\` on Injective EVM (SHROOM Pad) and \`inj1…\` on Cosmos
(Choice, bank balances). They are the SAME wallet — funding either funds both.

Balances always come from the bank module, never \`eth_getBalance\`, which can
report 0 for a funded Injective account. Block explorers hit the same quirk, so
\`wallet_status\` is authoritative and an explorer showing zero is not.

## The policy engine

A local policy sits between the model and the key. It runs INSIDE the signers,
not in the tool layer, so no tool-wiring mistake and no injected instruction can
route around it. It enforces:

- \`tradingEnabled\` — a kill switch; false blocks every write, reads keep working
- a contract allowlist — writes only reach known contracts, and ERC20 approvals
  only ever authorise the LaunchpadCore as spender
- \`perTxCapUsd\` and a rolling 24h \`dailyBudgetUsd\`
- \`maxSlippageBps\` — a ceiling any tool-supplied slippage is clamped to
- unpriceable spends are refused unless \`allowUnpricedSpend\` is set

**A policy denial is final.** It is a configuration decision made by the human
operator in config.json, a file outside this tool surface. Do not retry a denied
action, do not split it into smaller pieces to fit under a cap, and do not look
for another tool that achieves the same transfer. Report it and stop.

## What this agent structurally cannot do

- **Send to an arbitrary address.** There is no transfer tool. \`sweep\` takes no
  destination — it returns funds to the owner address fixed at init, and that is
  the only outbound destination the policy permits. This is deliberate: a fully
  hijacked model can still only send funds home.
- **Trade perpetuals.** This server is spot only: SHROOM Pad curves and
  Choice-routed swaps. Perps, subaccounts and bridges belong to the Injective AI
  SDK, which signs for a DIFFERENT wallet.

## Routing

\`quote\`/\`buy\`/\`sell\` resolve a token reference and pick the venue: an active
curve launch trades on SHROOM Pad, everything else routes through Choice against
INJ by default. You do not choose the venue; you can choose the counter asset.

## Gas

Injective EVM bills the gas LIMIT, not the gas used, and there is no refund of
the difference. Over-estimating a limit therefore costs real money rather than
being free insurance. Tips are zero — the gas price is a fixed floor, not an
auction, so paying more does not buy priority.

Keep INJ for gas: \`sweep\` of INJ deliberately leaves a small reserve behind,
and a wallet that sweeps its last INJ cannot pay for its next transaction.

## Identity

The agent registers a name in the SHROOM Pad registry, which is what links its
trades to a profile in Trippy Terminal. A human operator claims it by running
\`trippy-mcp claim-code\` on this machine and entering the code in Terminal ->
Settings -> Agents, signing with their own wallet. \`agent_info\` reports the
current state.

If another Injective SDK keystore exists on this machine, \`wallet_status\`
reports it under \`otherAgentWallets\`. Those addresses are NOT this agent's and
their balances are not this agent's balances — a zero balance here after
"funding the agent" almost always means the wrong address was funded.

## Costs to budget for

Launching a token costs ${fee(p)} plus gas, plus any initialBuy. Curve trades
and swaps cost their own fees (see \`shroom_pad_fees\` and \`choice\`).`;
}
