/**
 * Topic: the airdrop rail.
 *
 * Written to answer the questions an agent gets wrong on this surface, in the
 * order they bite: that preview does not move money, that execute is one
 * irreversible transaction, that recipients must claim, and that a perpetual
 * drop can never be recovered.
 */

import type { LiveParams } from "./params.js";

export const id = "airdrops";
export const title = "Airdrops: the claim-drop rail";
export const summary =
  "How to snapshot holders and fund a merkle claim drop in one transaction — the two-step commit, the caps, and what is irreversible.";

export const sources = [
  "choice-claim-drops contract Config (live read) — fee_bps and paused state",
  "local policy config.json — airdropCapUsd, dailyBudgetUsd",
];

export function render(_p: LiveParams): string {
  return `# Airdrops — the claim-drop rail

An airdrop here is a **merkle claim drop**: you publish a list of allocations,
fund the total in ONE transaction, and recipients claim their share from the
contract. One transaction regardless of whether the list has 10 wallets or
10,000 — there is no per-recipient send to retry, resume or bisect.

The trade-off is that recipients must claim. Nobody receives anything
passively. If a token must LAND in wallets without action, this rail is the
wrong one.

## The two-step commit

    airdrop_preview {source, filters?, allocation, delivery?}  -> planId
    airdrop_execute {planId, confirm: true}                    -> campaignId, claimUrl

**\`airdrop_preview\` moves nothing.** It snapshots holders, allocates, builds
the merkle tree and writes the whole plan to disk. Read what it returns:
recipient count, the exact total, the top recipients, what got filtered out,
and whether the wallet can even fund it.

**\`airdrop_execute\` takes a planId and nothing else.** You cannot go from
criteria straight to a broadcast — the exact recipient set is fixed and
inspectable between the two calls. Plans expire after an hour, because a holder
snapshot goes stale and funding an old one pays the wrong wallets.

If a preview looks wrong, do not "adjust and execute". Preview again: any
change to the allocation produces a different plan and a different merkle root.

## Sources

- \`csv\` — an explicit list of {address, amount}. Amounts are fixed and the
  allocator is bypassed, so \`allocation.total\` is ignored.
- \`token_holders\` — everyone holding a bank denom, weighted by balance.
- \`launch_holders\` — everyone holding a SHROOM Pad launch's token. Because the
  launch token is one balance across its bank denom and its ERC20, this
  includes people who bought during the curve phase, which is usually the whole
  point.

Snapshots are taken live at preview time and the timestamp is recorded.

## Allocation

- \`fair\` — everyone gets the same amount.
- \`proportionate\` — split by weight (holdings), largest-remainder method.

Both are exact BigInt splits: the allocations sum to the requested total to the
base unit, with nothing held back. That is a contract requirement, not a
preference — the attached funds must equal the sum of the leaves exactly.

Filters: \`topN\`, \`minWeight\` (source-asset units), \`minAmount\` (drop-asset
units, re-splits the total across whoever survives), \`exclude\`.

## What gets dropped from your list, and why

- **module accounts and burn addresses** — they hold balances and no keys, so
  an allocation to one is funds locked in the contract forever
- **a launch's own sink** — it holds the entire unsold curve supply, and it is
  the largest "holder" of any un-graduated launch. Not excluding it would send
  most of the drop back to the protocol
- **addresses failing bech32 CHECKSUM validation** — not just charset. A claim
  drop never shows an address to a chain rule that would reject a typo; it goes
  straight into a leaf hash, gets funded, and freezes. One wrong character
  permanently strands that allocation
- **zero allocations** — an unclaimable leaf

Every count comes back in the preview. If a number surprises you, that is the
signal to look before executing.

## Irreversible things

- The campaign **freezes on creation**. The root, the total and the recipient
  list cannot be changed afterwards. There is no edit.
- **Expiry defaults to 30 days**, and expiry is what makes unclaimed funds
  recoverable later.
- **\`perpetual: true\` means unclaimed funds can NEVER be clawed back.** They
  stay in the contract forever. Only use it when that is genuinely intended.
- **A plan is single-use.** It is marked the moment a broadcast is attempted,
  before the result is known, so a second \`airdrop_execute\` on the same planId
  is refused. That is deliberate: a transaction can LAND and still return an
  error (the client stops waiting while it sits in the mempool), and the
  natural response to "broadcast failed" is a retry that would fund the whole
  drop twice. Execute also checks the chain for a campaign already carrying
  this root before it does anything, and re-checks after a failure — so a
  failure that says the funds did not move has been verified against the chain,
  not assumed.
- If execute returns without a campaign id, the drop is still LIVE. Use
  \`airdrop_status\` with the planId to find it. Never execute again.

## Limits

An airdrop is the only action this agent can take that sends value to addresses
its operator never named, so it is capped separately from trading:
\`policy.airdropCapUsd\` bounds one campaign, and the campaign ALSO consumes the
shared 24h \`dailyBudgetUsd\`. A drop that cannot be priced in USD is refused
outright — an uncappable transfer is not permitted, and unlike trades there is
no \`allowUnpricedSpend\` escape.

The cap is applied at EXECUTE time against a fresh price of the funds actually
being attached, not against the preview's figure. A token that moves inside the
plan's hour can therefore turn a preview that passed into an execute that is
refused. The preview's \`policyCheck\` is indicative.

Set \`airdropCapUsd\` to 0 in config.json and these tools are not registered at
all.

## Recipients

Claim at the campaign's URL, returned by execute. The drop is created by this
agent's wallet, and its on-chain metadata records which agent made it.`;
}
