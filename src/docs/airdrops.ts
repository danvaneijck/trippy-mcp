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
export const title = "Airdrops: the claim-drop and push rails";
export const summary =
  "How to snapshot holders and pay them — merkle claim drop or direct push — the two-step commit, the caps, and what is irreversible.";

export const sources = [
  "choice-claim-drops contract Config (live read) — fee_bps and paused state",
  "local policy config.json — airdropCapUsd, dailyBudgetUsd",
];

export function render(_p: LiveParams): string {
  return `# Airdrops

Two rails, chosen with \`delivery.rail\`.

**\`claim_drop\` (default)** — a merkle claim drop. You publish a list of
allocations, fund the total in ONE transaction, and recipients claim their
share from a link. One transaction whether the list has 10 wallets or 10,000:
there is no per-recipient send to retry, resume or bisect, and unclaimed funds
come back to you after the expiry.

**\`push\`** — MsgMultiSend straight to every wallet. Nobody has to claim.

Pick \`push\` when recipients must not have to do anything, and only then. It
is capped at 1000 recipients, it is irreversible with no expiry and no
clawback, and a wrong address is not an unclaimed leaf sitting in a contract —
it is somebody else's money. Everything else is better served by a claim drop.

## The two-step commit

    airdrop_preview {source, filters?, allocation, delivery?}  -> planId
    airdrop_execute {planId, confirm: true}                    -> campaignId, claimUrl
    airdrop_manage  {campaignId, action?, …}                   -> what is possible / does it

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
- \`nft_holders\` — a CW721 collection's owners, weighted by how many they hold.
  Set \`is404: true\` for a CW404 hybrid, whose holders are balances in the
  contract's state rather than token ids. Enumerating a CW721 costs one query
  per token, so collections above 20,000 supply are refused rather than paged
  for an hour.
- \`gov_voters\` — everyone who voted on a governance proposal. Filter with
  \`filters.voteOptions: ["yes"]\` etc.
- \`mito_vault\` — LP holders of a Mito vault, weighted by LP held or (with
  \`holderType: "stake"\`) by LP staked. Staked LP is credited back to the wallet
  that staked it; the staking contract itself is also returned as a "holder" of
  that same LP and is excluded, so it is never paid twice.
- \`buyback_round\` — everyone who committed INJ in a Community BuyBack round,
  weighted by how much (mainnet only). Whitelisted-but-never-bid wallets hold a
  zero-deposit row in the same map and are not participants; they are excluded.

Every source except \`gov_voters\` is read live at preview time and the
timestamp is recorded.

### Governance voters are the one at-height source

Votes are still mutable while a proposal is open, so "who voted on N" is only a
stable question with a height attached. Omit \`height\` and the last block before
voting closed is found for you (a seeded binary search over block timestamps);
that height comes back in the preview.

Two things follow. An at-height read needs a node that still HAS that height, so
an old proposal against a pruned LCD fails — pass a \`height\` or point
\`config.lcdUrl\` at an archive node. And the weight on a gov row is the weight
of the VOTE (~1 per wallet), not the voter's stake: nothing here reads
delegations, so \`proportionate\` over a gov snapshot is an equal split with
extra steps. It therefore defaults to \`fair\`.

## Allocation

- \`fair\` — everyone gets the same amount.
- \`proportionate\` — split by weight (holdings), largest-remainder method.

Both are exact BigInt splits: the allocations sum to the requested total to the
base unit, with nothing held back. That is a contract requirement, not a
preference — the attached funds must equal the sum of the leaves exactly.

Filters: \`topN\`, \`minWeight\` (source-asset units — whole tokens held, NFTs
owned, whatever the source counts), \`minAmount\` (drop-asset units, re-splits
the total across whoever survives), \`exclude\`, \`voteOptions\` (gov only).

## What gets dropped from your list, and why

- **module accounts and burn addresses** — they hold balances and no keys. On a
  claim drop that allocation sits in the contract unclaimable forever; on a push
  it is sent, accepted and gone
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

- A **push** drop is irreversible the instant it lands and has no expiry,
  clawback or claim page. Everything below is about \`claim_drop\`.
- The campaign **freezes on creation**. The root, the total and the recipient
  list cannot be changed afterwards. There is no edit.
- **Expiry defaults to 30 days**, and expiry is what makes unclaimed funds
  recoverable later.
- **\`perpetual: true\` means unclaimed funds can NEVER be clawed back.** They
  stay in the contract forever. Only use it when that is genuinely intended.
- **A claim_drop plan is single-use.** It is marked the moment a broadcast is attempted,
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

## The push rail specifically

One MsgMultiSend pays everyone, because the per-campaign policy cap is enforced
per signed transaction — splitting the drop over two transactions would let
one worth twice the cap through, a legal half at a time. That is where the 1000
ceiling comes from, not from gas.

Two failure modes shape everything else about it, and both are worth knowing
before you run one:

- **A transaction can land and still throw.** The client gives up on the
  inclusion wait while the transaction sits in the mempool. So an error from a
  send is never read as "it failed" — it is read as UNKNOWN and settled against
  the chain (the account sequence proves whether that transaction can still
  land; the first recipient's balance says which way it went). If it cannot be
  settled, the run STOPS with the attempt saved rather than resending, because
  resending something that lands pays those wallets twice.
- **Some addresses cannot receive, and some can but should not.** The bank
  module refuses about half of its own module accounts, and that refusal fires
  during gas simulation, so one such recipient reverts the whole transaction and
  strands everyone in it. An unknown one causes the group to be halved and
  retried down to single addresses, so it only ever strands itself. The other
  half ACCEPT a transfer and simply keep it — no error, no way to detect it
  afterwards, and no key anywhere that can move it again. Both kinds are
  filtered out at preview, and that filter, not the retry logic, is what stops a
  drop burning tokens on an address nobody controls.

**A push execute is resumable, and that is what makes it safe.** If it stops
partway — an unresolved send, an interrupted process, an empty wallet — call
\`airdrop_execute\` again with the SAME planId. It settles whatever was in the
air, skips everyone a landed transaction already paid, and finishes the rest.
That is the only correct response to a partial push run: do not preview again,
which would build a fresh plan that knows nothing about who has been paid.

\`airdrop_status\` on a push planId reports paid/total, the landed tx hashes,
any unsendable addresses and whether a send is still in the air. Push drops on
MAINNET are written to the site's airdrop history with the plan's criteria
string, including the recipients a resumed run settled rather than sent; that
history has no notion of networks, so drops on any other network are left out of
it deliberately.

## After it is live: \`airdrop_manage\`

\`airdrop_manage {campaignId}\` with no action reads the campaign and returns an
availability table — which of \`clawback\`, \`set_expiry\`, \`freeze\` and \`pause\`
the contract will accept right now, and the reason for each one it will not.
That check is local, so use it instead of signing to find out.

- **\`clawback\`** sweeps the unclaimed remainder back to this wallet. Only the
  creator, only after the expiry has passed, and only once — the campaign is
  closed permanently and nobody can claim afterwards. Needs \`confirm: true\`.
- **\`set_expiry {expiryDays}\`** extends the deadline. It can only ever be
  extended: the contract rejects any date at or before the one recipients were
  already told. Giving a perpetual drop an expiry for the first time is a
  wind-down and takes at least 7 days' notice.
- **\`freeze\`** locks the recipient list forever. Drops from this rail are
  already frozen at creation, so this is normally reported as unavailable.
- **\`pause\` / \`pause {paused:false}\`** stops and resumes claims. Reversible,
  and it changes nothing about what is owed — the window is just shut, e.g.
  while a bad list is investigated before the expiry lets you sweep.

None of these are capped: they either move nothing, or move funds toward this
wallet along a path the contract fixes and no argument can redirect.

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
