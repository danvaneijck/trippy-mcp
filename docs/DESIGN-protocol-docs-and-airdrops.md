# Design: protocol knowledge + airdrop tools for trippy-mcp

Status: **ALL FOUR PRs BUILT AND SWEPT** (2026-08-02, branch `feat/explain-and-airdrops`, unpushed). Every rail has now been broadcast on testnet — claim drop, `airdrop_manage` including a real clawback, push with bisection, and crash-resume — plus read-only mainnet previews of every source. Results, five things the chain contradicted, and what is still open are in "Full-rail sweep" at the bottom; the "Decisions" sections above it supersede the original "Open questions" list.
Scope: (1) endpoints that teach agents how Shroom Pad and Choice work (quote choice, fees, discounts, mechanics); (2) airdrop endpoints replicating the trippytools criteria types; (3) hooks for future work (liquidity positions, streaming rewards).

---

## Part 1 — Protocol knowledge endpoints

### 1.1 Shape: one `explain` tool + mirrored MCP resources

- **Primary: a single tool `explain { topic?: enum }`.** Tools are the only surface every MCP client lets the model call autonomously; resources need user attachment in most clients. One tool with a topic enum keeps the tool count flat (16 → 17 for this part).
- Called with no topic → returns the topic index (id + one-liner each) so agents can discover what's explainable.
- **Secondary: register the same topics as MCP resources** (`trippy://docs/<topic>`). The installed SDK (1.30.0, floor ^1.12.0) already supports `registerResource` — no version bump. Zero extra content cost since they share the content module.
- Update the existing `trippy_usage` prompt (src/mcp/server.ts:209) to mention `explain` as the first stop.

### 1.2 The hard rule: prose carries no numbers

Everything numeric is **hydrated live at call time**; the static prose describes mechanics only. This is forced by real drift we've already hit: the deploy scripts say 1 INJ creation fee but mainnet was lowered post-deploy to 0.2 INJ via `setDenomCreationFeeInj` — a baked number in an npm package would lie until the next release.

Live sources per fact:

| Fact | Live read |
|---|---|
| Creation fee | `denomCreationFeeInj()` on LaunchpadCore (viem read) |
| Per-quote params (virtualPair, graduationPairTarget, tradeFeeBps, creatorFeeShareBps, pairAsset, bankDenom, decimals) | `getQuoteAssetConfig(slot)` for slots 0..3 (+probe higher slots) |
| Referral share | `referralShareBps()` (global, NOT snapshotted — say so in prose) |
| Choice venue coverage / route fees | Choice API (fees are visible per-route in quote responses; coverage listed qualitatively) |

Each `explain` response: `{ topic, content, live_params, sources, fetched_at }` with a note that per-quote params are **createLaunch-time snapshots** — "these are the terms for NEW launches; existing launches keep the config they launched with" (LaunchpadCore snapshots the whole QuoteAssetConfig onto the launch).

Content lives in `src/docs/<topic>.ts` as template strings with `{{param}}` slots; a small hydrator merges the live reads. Keep each topic ≤ ~1.5k tokens — agents pay context for what they fetch, so topics are split fine-grained.

### 1.3 Topics (v1)

1. **`shroom_pad`** — lifecycle + curve mechanics: reserve → keeper bind (1h deadline, fee refunded on miss) → Trading → CurveFilled → graduation → Graduated. xy=k with virtual reserves, formulas, fixed 1B supply (800M curve / 200M graduation reserve), graduation is a **raised-amount** target not a market cap, overshooting buy is capped + refunded in-tx, anti-snipe options (tradingOpensAt + creator-exclusive first buy, guard-window max-buy bps), token = tokenfactory denom + erc20-module ERC20 (one unified balance), supply admin renounced at bind.
2. **`shroom_pad_quotes`** — the "how to choose quote" decision guide the user asked for. Qualitative frame + live numbers: **SAI** = creator-incentive quote (creatorFeeShareBps 9000 → creator earns ~0.9% of every trade, and the same split streams from the graduated pool; only SAI is allowlisted as a holder-discount gate token); **INJ** = the liquid/native quote, 10% creator share, native buy/sell convenience paths; **USDC** = stable-denominated raise, 10% creator share, **6 decimals** (all its amounts are 1e6, a real footgun). Graduation targets and virtual reserves hydrated live. Note slots 4–255 exist — new quotes can appear without redeploy.
3. **`shroom_pad_fees`** — creation fee (live; escrowed and refunded if the launch is cancelled/never binds), 1% trade fee (off input on buys, off output on sells), creator/platform split per quote, **referrer** = 10% of the *creator's* cut, buys only (effective ~9bps on SAI, ~1bp on INJ/USDC), **holder discount gates**: per-launch, creator-configured, up to 100% of the creator cut (treasury leg never reduced), qualification via non-reverting balanceOf, `discountBps=0` means hard access gate instead. No graduation fee; graduated CLMM pool is 0.30% tier, position locked forever, fees stream on the same snapshot split.
4. **`choice`** — aggregator/SOR over Choice XYK + CLMM, DojoSwap, Astroport, White Whale, and the Helix orderbook. The gotchas an agent actually needs: quotes can pass but **broadcast can fail on min_notional** (simulation doesn't check it — keep sells above ~minimum notional); **Astroport legs default to 0.5% max_spread** and that assert is invisible to simulation (a clean quote can still revert; retry with higher slippage); `total_liquidity_usd` on tokens is **AMM-only** and ignores orderbook depth; all trippy-mcp swaps carry the `trippy-mcp:<agent>` memo for attribution.
5. **`agent_wallet`** — how this server itself works: curve-vs-Choice routing, policy engine (caps, allowlist, sweep pin), gas billed at limit on Injective EVM, identity registration + operator claim. Much of this exists as file-header docstrings; this surfaces it to the agent.
6. **`airdrops`** — added with Part 2: rails, criteria, fees, claim link format.

Future topics slot in the same way (e.g. `liquidity` when position tools land).

### 1.4 Per-launch facts belong in `token_info`, not `explain`

A launch's *own* gate/discount/fee snapshot is queryable state, not documentation. Extend `token_info` for curve tokens with: `tradeFeeBps`, `creatorFeeShareBps`, `gate { gateToken, minBalance, discountBps, windowEndsAt }` (and whether the calling agent currently qualifies — `quoteBuy(launchId, amount, account)` already applies the discount per-account, so quotes stay bit-exact). This is how an agent learns "holding ≥X SAI cuts your fee on THIS launch."

---

## Part 2 — Airdrop endpoints

### 2.1 Two delivery rails, claim-drop first

| | Claim drop (merkle) | Push (MsgMultiSend) |
|---|---|---|
| Txs | **1**, any list size | N/1000 chunks, resume/bisection complexity |
| Recipient effort | must claim on trippytools `/claim/:id` | receives passively |
| Contract | LIVE mainnet code 2066, Dan's instance `inj1nwqzch9…w82n`, fee_bps 0, audited, one-shot campaigns are permissionless | none (bank msg) |
| Failure modes | leaves-publish ordering, root squat (both already solved in trippytools) | partial runs, per-recipient failures |
| Agent risk | bounded: one tx, deterministic total | unbounded tail of retries |

*(Built: claim drop in PR 2, push in PR 4. The push rail's ceiling ended up at 1000 recipients for a policy reason rather than a gas one — see decision 10.)*

**Phase 1 ships the claim-drop rail only.** One tx regardless of size is the right shape for an autonomous agent, the contract + backend (Hasura leaves at `api.trippyinj.xyz/claim-drops/leaves/<root>.json`, anon insert-only) are live and battle-tested, and the claim page already exists. Push comes in phase 2 for small lists (≤1 chunk / 1000 recipients initially) where "recipients shouldn't have to claim" matters.

Cosmos-side signing is not new ground — `ChoiceVenue.swap` already signs MsgExecuteContract via sdk-ts with the same key; `create_campaign` + the SHROOM fee transfers are the same message family.

### 2.2 Tool surface: two-step commit

Three tools (16+1 → 20 total with `explain`):

```
airdrop_preview {
  source:     { kind: csv | token_holders | launch_holders | nft_holders |
                       gov_voters | mito_vault | buyback_round, …kind-specific }
  filters?:   { topN?, minWeight?, exclude?: address[], voteOptions? }
  allocation: { mode: fair | proportionate, total: string, asset: string }
  delivery:   { rail: claim_drop (| push later), title?, description?,
                expiryDays? (default 30; perpetual requires explicit flag) }
}
→ { planId, recipientCount, totalBase, topRecipients (10), droppedZero,
    truncatedRows, blockedRows, mergedRows, feeEstimate, policyCheck,
    snapshotAt, warnings[] }

airdrop_execute { planId, confirm: true }
→ { campaignId, claimUrl, txHash, root, funded }

airdrop_status { planId? | campaignId? }
→ plan state / campaign state (claimed_total, claimants, remaining, expiry)
```

- **Preview snapshots + allocates + prices, then caches the full plan** (rows, root, fee quote) at `~/.trippy-mcp/airdrops/<planId>.json`. `planId` = hash of `sender|asset|sorted(address:amount)` — the same order-independent keying trippytools' checkpoint uses, so it doubles as the push-resume key later.
- **Execute only accepts a planId** — the agent can never go straight from "criteria" to "broadcast"; the exact recipient set that will be funded is inspectable between the two calls. Plans expire (1h) so stale snapshots can't fire.
- The trippytools ordering discipline is kept verbatim: leaves → Hasura **before** anything else (with the root-squat re-verify on conflict), then fee, then the single create+fund+auto-freeze tx, then campaign row insert + Telegram. A failed leaves publish hard-stops before any value moves.
- Default **30-day expiry** → clawback stays possible. Perpetual (frozen forever, un-clawback-able) only via an explicit `perpetual: true`.
- v1 is one-shot campaigns only on Dan's instance. Streaming campaigns / manage tools (freeze early, extend expiry, clawback after expiry) are a later `airdrop_manage` tool — smaller surface for the risky first release. Clawback is the one we'll want soonest. *(Built in PR 3: `clawback` / `set_expiry` / `freeze` / `pause`, plus a no-action mode that returns which of them the contract will accept and why not.)*

### 2.3 Criteria: the six trippytools sources, phased

(Confirmed: trippytools has exactly six — there is no volume-based source there.)

| Source | Inputs | Backing read | Phase |
|---|---|---|---|
| `csv` | rows `[{address, amount}]` inline or file path | none (fixed amounts, bypasses allocator) | 1 — **gated, see 2.5** |
| `token_holders` | bank denom OR CW20 address | `denom_owners` paging over gRPC-web (the LCD does not implement it); CW20 `fetchContractAccountsBalance` + bank-wrapped half merged (÷10^decimals) | 1 |
| `launch_holders` | launchId or token query | the launch token's bank denom via sink `token_denom` → `denom_owners` (bank+ERC20 are one balance, so curve-phase holders included). Prefer a pump-api holders endpoint if present | 1 — the agent-native case: "reward my token's holders" |
| `nft_holders` | collection address (+is404) | `all_tokens` paging + owner batch resolve; CW404 raw-state scan | 2 — built, capped at 20k supply |
| `gov_voters` | proposal id (+height or auto-find) | LCD votes with `x-cosmos-block-height` (the only true at-height snapshot) + the binary-search block finder | 2 |
| `mito_vault` | vault address, stake\|non-stake | IndexerGrpcMitoApi `fetchLPHolders` | 3 |
| `buyback_round` | round (`expectedTotalInj` is read from the round, not asked for) | raw contract-state paging with the hand-built key prefix | 3 |

All sources are public-endpoint reads — they port into `src/airdrops/sources/` with no backend work. Everything except gov is live-at-query (snapshotAt recorded in the plan and campaign meta).

**Exclusions ported as data**: the 20 hard-coded bank module accounts, CW20 adapter, burn addresses, Mito staking/exchange contracts — plus **launch-aware exclusions** for `launch_holders` that trippytools doesn't need but we do: the LaunchpadCore bech32 mirror (holds unsold curve supply), the sink/seeder, the locker, and the treasury. Missing these would airdrop most of the total to the protocol's own contracts.

### 2.4 Allocation: port `allocateExact`, drop the float allocator

One allocator for all rails: the ClaimDrop BigInt path (dedupe summing weights → sort by address → fair = equal split with remainder units to lowest addresses / proportionate = largest-remainder; Σ == total exactly; deterministic → same list, same root, fee never double-charged on retry). The push tool's float+DUST_HAIRCUT allocator is a legacy artifact; exactness costs nothing and the claim-drop contract *requires* it (funds must equal Σ leaves to the base unit). Merkle: `sha256("{addr}:{amount}")`, sorted-pair parents, odd promotes — port with the Rust golden vectors as fixtures. Full bech32 checksum validation on every recipient (a typo'd address in a frozen campaign is permanently unclaimable — charset regex isn't enough).

### 2.5 Safety & policy — airdrops are outbound value transfer

An airdrop is exactly what the sweep-destination pin exists to prevent: value leaving to arbitrary addresses. A prompt-injected agent "airdropping" to attacker wallets must be bounded:

1. **Off by default.** New policy knob `airdropCapUsd` (per-campaign, USD-valued via the existing pricing paths); `0`/absent = airdrop tools not registered at all. Operator opts in at init.
2. **Counts against the daily budget** through the same SpendLedger — a $200 airdrop consumes $200 of `dailyBudgetUsd`.
3. **`csv` source gated separately** (`allowArbitraryRecipients: true`) — chain-derived snapshots are hard to steer toward attacker addresses; a pasted list is trivially the exfiltration vector. Default off.
4. Enforcement **inside the signer path** like everything else (the cosmos tx builder for `create_campaign` runs `PolicyEngine.enforce` before signing), never in the tool layer. Allowlist additions in runtime.ts: claim-drops contract, SHROOM CW20 + adapter (fee), later the multisend path.
5. Any token metadata surfaced in previews goes through `untrustedMeta` like every other third-party string.

### 2.6 Fee: parity with trippytools

**25,000 SHROOM, 90/10 collector/burn**, same collector, charged after leaves-publish and flagged by root so a retry never double-pays — identical to the site. Rationale: the MCP must not be the free bypass of the paid tool. Port `ensureCw20ShroomMessages` (bank→CW20 convert prepended when the CW20 balance is short) so an agent only needs bank-denom SHROOM. Preview's `feeEstimate` returns the SHROOM cost, its USD value, and whether the wallet can cover it. *(Open: Dan may prefer a different price for agents — the amount is one constant.)*

### 2.7 Logging

Claim drops self-log (leaves + campaign rows land in Hasura as part of the flow; Telegram notify kept, marked as agent-created with the agent name). When the push rail lands, mirror the `airdrop_tracker_airdroplog` insert so agent drops appear in the site's history with the `criteria` string the plan already generates.

---

## Part 3 — Future: liquidity positions (sketch only)

Mentioned as future scope; the docs/airdrop design leaves room:

- `explain("liquidity")` topic slots in with zero structural change.
- Likely tools: `lp_preview` / `lp_open` / `lp_positions` / `lp_close` on Choice CLMM (and the one-sided CLMM path SHROOM graduation uses). Same two-step commit pattern as airdrops; same policy valuation (USD of deposited amounts).
- Not designed here — CLMM tick/range selection for an agent deserves its own doc.

---

## Rollout

| PR | Contents | Risk |
|---|---|---|
| 1 | `explain` tool + resources + live param hydration; `token_info` gate/discount fields; `trippy_usage` prompt update | none — read-only |
| 2 | Claim-drop rail: `src/airdrops/` (sources csv+token+launch, allocateExact+merkle w/ golden vectors, plan cache), 3 tools, policy knob, SHROOM fee, Hasura publish + squat guard | new signing path — full testnet e2e against instance `inj1f2ht…` (campaigns cost ~0.22M gas), then one small real mainnet drop |
| 3 | Sources: nft, gov (+block finder); `airdrop_manage` (clawback/extend/freeze/pause) | low |
| 4 | Push rail (≤1000 recipients, checkpoint+bisection in `~/.trippy-mcp`), mito + buyback sources, history logging | medium |

All four are built. PR 4 turned out to be the risky one, not for the reason the table guessed: the checkpoint is straightforward, and the hard part is that a broadcast which throws has not told you whether it happened.

Each PR follows the house pattern: impl in `tools.ts` (pure pieces exported for vitest), registration in `server.ts`, ToolError envelopes, CI typecheck/test/pack-gate.

## Decisions (2026-08-02) — supersedes the open questions

1. **SHROOM fee: none.** Agent-created drops are not charged. `ensureCw20ShroomMessages` and the whole fee step (§2.6) were dropped from the build, which also removes the fee-paid flag and the "never bill for a drop the chain will refuse" balance re-read.
2. **`airdropCapUsd` defaults to 1000** (the whole daily budget), not 0. It REPLACES `perTxCapUsd` for airdrop intents rather than stacking under it — otherwise the $200 trade cap would silently govern every drop and the knob would be inert. The campaign still consumes the shared 24h budget. `0` still means the tools are not registered at all.
3. **`csv` is allowed by default.** No `allowArbitraryRecipients` flag. The blocked-address list is applied to csv rows too (it is not applied by the snapshot path there, so it is applied at the leaf builder).
4. **Claim page: trippytools `/claim/:id`, flagged as agent-made.** The plan meta carries `createdBy: "trippy-mcp:<agent>"`, which is written on-chain as the campaign meta and stored on the campaign row; the claim page renders an AGENT chip from it (trippytools branch `feat/claim-drop-agent-badge`, **not pushed** — that repo auto-deploys).
5. **`explain` tone: mechanics + a light "why you'd pick each quote."** As assumed.
6. **Curve-buy `referrer` keeps the feeTreasury default.** Documented plainly in the `shroom_pad_fees` topic, including that referralShareBps is a share of the creator's cut (~1bp on INJ, ~9bps on SAI) and that the contract zeroes it when the referrer is the buyer or the creator.

### Built differently from the design

- **Topic content is a `render(params)` function, not a `{{slot}}` template.** Same "prose carries no numbers" rule, but a mistyped slot fails typecheck instead of shipping `{{graduationTarget}}` to an agent. A test asserts the prose stays numberless when every live read fails.
- **Quote-asset slots 0-7 are probed live** rather than read off the vendored registry, so a quote asset enabled without a redeploy appears the day it exists. Unknown slots get their symbol/decimals from the ERC20.
- **Duplicate-funding guard is three-part**, added after an audit found the original ordering could double-fund: execute checks the chain for a campaign already at this root before acting, marks the plan BEFORE broadcasting (a tx can land and still throw when the client stops waiting), and on failure re-asks the chain whether it landed instead of reporting that nothing moved. The plan file is **kept** after execution, not deleted — it is the only thing that maps a planId back to a root when the campaign id cannot be read out of the tx.
- **The policy cap is applied at execute time** to a fresh price of the funds actually attached (total + the instance's fee), not to the preview's figure, which can be an hour old.
- **`allowUnpricedSpend` does not extend to airdrops.** It is a trading convenience for illiquid tokens; an uncappable outbound transfer is refused outright.
- Cosmos signing went into a shared `CosmosSigner` (policy enforced inside it, plus a check that the built messages target the contract the policy check was made against). `ChoiceVenue` still has its own broadcast path and was left alone.

## Decisions (PRs 3 and 4, 2026-08-02)

7. **`airdrop_manage` actions are all `kind: "claim"`, not `kind: "airdrop"`.** Three of the four move nothing. Clawback moves the campaign's remainder TOWARD this wallet along a path the contract fixes and no argument can redirect, so capping it under `airdropCapUsd` would mean a wallet that had spent its budget could not recover its own expired funds. The allowlist and kill switch still apply.
8. **`airdrop_manage` is registered with the rest of the airdrop tools**, so `airdropCapUsd: 0` also removes clawback. Noted at the config field: wind campaigns down before turning airdrops off, or do it from the site.
9. **Gov snapshots default to `fair`.** The weight available is the weight of the VOTE (~1 per wallet), not stake — nothing here reads delegations — so `proportionate` over a gov source is an equal split with extra steps. It defaults the other way and warns if asked for explicitly.
10. **Push is capped at 1000 recipients AND 1000 per transaction — the same number, for a policy reason rather than a gas one.** `PolicyEngine.enforce` runs once per signed transaction, so a campaign split across two chunks would pass twice `airdropCapUsd` as two legal halves. One transaction per campaign is what makes the per-campaign cap true. Raising the ceiling above one chunk requires revisiting the cap first.
11. **A push plan is re-executable; a claim plan is not.** The single-use mark exists to stop a second campaign being funded for the same list. For push it is the opposite — re-running the same planId IS the resume — so push skips the mark and the TTL, but only once the checkpoint shows progress. A push plan with nothing paid is just an un-executed plan and its snapshot goes stale like any other.

### Built differently from the design (PRs 3 and 4)

- **The signer simulates as a separate step on the push path.** A rejected simulation and a lost broadcast are indistinguishable from outside — no sequence consumed, no balance moved — but the first must be bisected at once and the second must never be resent before it is resolved. The rejected simulation is the COMMON case (a bank-blocked recipient is refused during simulation), so collapsing them would mean one bad address halting a whole drop rather than being routed around. `bankMultiSend` reports `simulate_rejected` distinctly for that reason.
- **"Did it land" is answered by the account SEQUENCE plus a probe recipient's balance**, persisted to a pending-attempt file written before every broadcast. A transaction is valid at exactly one sequence, so a sequence that has moved past it proves it can never be included; the probe's balance then says which way it went. Unresolvable means the run STOPS with the attempt saved, not that it resends.
- **CW404 holders come out of raw contract state with a derived `0x00 <len> "balance"` prefix**, so the scan starts at the balance map instead of the contract's first key. The site needs a hand-collected table of per-contract start keys for the same effect; deriving it works for every CW404.
- **The block finder brackets directionally from a block-interval seed**, not `[1, tip]` — a plain bisection would open by asking a pruned public LCD for a height it discarded years ago.
- **`buyback_round` reads the round's own `total_deposit`** rather than taking `expectedTotalInj` from the caller, and uses it to stop the scan as soon as every committed INJ is accounted for.
- **Push history rows are per RUN, not cumulative**, so a drop finished across two invocations produces two rows that partition the recipients instead of two that double-count them.
- `airdrop_manage` with no `action` returns the availability table instead of doing anything — the rules are a local restatement of the contract's, so "what can I do" costs nothing.
- Valuation/decimals/balance helpers moved to `airdrops/pricing.ts` so both rails share them without an import cycle.

### Still not built

Nothing from the rollout table.

## Full-rail sweep (2026-08-02) — first broadcasts

Every rail has now been run against a chain. Testnet: a scratch install
(`TRIPPY_MCP_HOME`, agent `sweep-tester`, wallet
`inj120sh4mtk5u6gfea8r74e46fcq5vc6jmth6k237`) against claim-drops instance
`inj1f2ht…`. Mainnet: read-only previews only, which broadcast nothing.

### What passed

| # | Test | Result |
|---|---|---|
| 1 | Claim drop end to end (testnet) | **campaign #5**. Leaves published + squat-verified, create+fund+auto-freeze in ONE tx, campaign id read straight from the tx events (fallback path not needed), row indexed with `network: testnet`, `leaves_uri` serves the document, on-chain state frozen/funded/unclaimed. |
| 2 | `airdrop_manage` | Availability table correct. `set_expiry` extend broadcast; shortening refused locally. `pause`/`unpause` broadcast; second pause → `no_change`. **Real clawback** on expired campaign #7 recovered 0.002 INJ and left `swept: true`. Every refusal reason cross-checked against the contract by simulation — see below. |
| 3 | Push with a bank-refused recipient | `simulate_rejected` matched Injective's real error shape (`… is not allowed to receive funds: unauthorized`) — the classification the whole bisection depends on. Group of 5 bisected into 2 landed txs paying 4; the blocked address stranded alone with the chain's own reason. No recipient appeared in both txs. |
| 4 | Kill mid-broadcast, resume | Both branches. **Landed-but-uncheckpointed**: resume read the probe balance, reported "an unconfirmed send DID land", skipped — account sequence advanced by exactly 1, so nothing was re-signed. **Never-landed**: resume refused to resend (`send_still_unresolved`), then after `PENDING_STALE_MS` resolved `did_not_land` and resent. All recipients paid exactly once in both. |
| 5 | `nft_holders` CW404 | Diffed against a full contract-state scan. PANDA: **exact match**, 143/143. SUSHI: 2986 leaves + 220 dropped-to-zero + 1 excluded = **3207**, equal to the full scan. A back-to-back A/B of both algorithms differed by zero. The derived `0x00 <len> "balance"` prefix is correct and needs no per-contract start-key table. |
| 6 | `gov_voters` | Proposal #678 at height 176542274 — the seeded finder converged and the public LCD served it (no archive node needed at ~2 days old). 593 voters, exactly the chain's own `pagination.total` at that height. |
| 7 | `mito_vault` | Both modes work; staked LP does resolve to wallets. But see finding E. |

### What the chain said that the code did not

**A. Testnet airdrops were unpriceable, so every one of them was refused.**
§1.2 and this doc's own gotcha list say INJ is priced via the LaunchpadCore.
It is not: `ShroomVenue.usdValue` reads the **pump API** `/quote-prices`, and
the testnet `NetworkDef` ships an empty `pumpApiBase`. So `usdValue` returned
null, and an unpriceable airdrop is refused outright with no
`allowUnpricedSpend` escape — the entire testnet rail was unreachable until
`pumpApiBase` was set in the scratch config. Preview now reports **why** it
could not price (`policyCheck.whyUnpriced`) instead of a bare refusal. Whether
testnet should carry a default `pumpApiBase` is left open.

**B. The push history insert had no network guard.** The claim-drop tables
carry a `network` column; `airdrop_tracker_airdroplog` does not, and its
foreign keys point at the site's *shared* `token_tracker_token` and
`wallet_tracker_wallet` registries. A testnet push would have put a testnet
denom in the site's token table and a row with unresolvable tx hashes in the
live airdrop history, unfilterable. `logPushDrop` is now mainnet-only and says
so in the result notes.

**C. `BLOCKED_RECIPIENTS` was wrong about why it exists.** Its docstring — and
the push module header that justifies the bisection with it — claimed the bank
keeper refuses all 20 x/auth module accounts. Simulated against each: **only 12
are refused. The other 8 accept the transfer and keep it.** Proven the
expensive way: the first run of test 3 picked `xwasm` as its "blocked" probe,
the send succeeded, and 0.001 testnet INJ is now in a module account with no
key. So the list is not "addresses the chain stops you paying" — it is
"addresses that are never a wallet", and for 8 of them the leaf-builder
exclusion is the *only* thing between an allocation and a permanent burn.
Docstrings corrected, per-entry refused/accepts annotation added, and a test
pins the 8 so nobody prunes the list to match the chain's smaller blocked set.

**D. `manageActions` is stricter than the contract in two places.** It bills
itself as "a pure restatement of the contract's own rules", and for clawback
timing, expiry extend-only, the 7-day perpetual wind-down, the frozen-perpetual
lock and `Swept` it matches exactly — the frozen-perpetual reason is almost
word for word the contract's `a frozen perpetual campaign cannot be given an
expiry`. But **`freeze` on an already-frozen campaign and `pause` on a swept one
are both accepted on chain** (`freeze` is idempotent; `set_campaign_paused`
checks only the creator). Withholding them is still right — they are no-ops that
cost gas — so the behaviour stands and the *reasons* were reworded to stop
attributing the refusal to the contract. Tested.

**E. The Mito staking argument does not do what the comment says.** Passing
`stakingContractAddress` populates `stakedAmount` and folds staked LP into each
wallet's `amount` — but it does **not** remove the staking contract from the
response. It comes back as a holder carrying an `amount` equal to the sum of
everyone's `stakedAmount`: the same LP, twice. On BLACK-INJ-v1 that row was 47%
of total weight. What keeps a default `non-stake` drop from sending half of
itself to a keyless contract is `NON_WALLET_HOLDERS`, not the argument.
Docstring corrected.

### Fixed after the sweep

**A crashed-then-resumed push drop now writes its history row.** It did not:
the resume returned `already-complete` with a hardcoded empty `paidThisRun`,
`logPushDrop` skipped anything that was not `broadcast`, and the landed tx's
hash had been thrown away (`markPaid(…, null)`) — so a drop that moved real
money appeared in the site's history nowhere, and there was nothing to point a
row at anyway. Three changes: the resume reports what it settled, `logPushDrop`
accepts `already-complete` (guarded by `paidThisRun`, so an idle re-run still
writes nothing), and a landed send's hash is recovered by searching this
signer's transactions for the one signed at the attempt's sequence — exact,
because a transaction is valid at exactly one sequence, and cross-checked
against the probe recipient so a sequence consumed by something else yields
null rather than a stranger's hash. Rows now carry `txHashesThisRun` rather
than the checkpoint's whole history, so two rows still partition. Verified on
testnet by reproducing the crash state against a send that really landed: the
resume recovered `042BA0F5…`, reported 2 recipients, and re-signed nothing
(sequence advanced by one, recipients paid once).

### Open, not fixed

- **`claimUrl` is network-ambiguous.** `/claim/<id>` resolves against whatever
  network the visitor's site store is set to, and campaign ids are per-contract,
  so testnet #5 and a future mainnet #5 share a URL.
- **The clawback success path needs a sub-day expiry to test.** The MCP schema
  floors `expiryDays` at 1; the sweep reached it by calling `preview` under the
  schema with `0.0012`. Normal use has to wait a day.
- A throwaway agent `sweep-reader` was registered on the **production** agent
  registry as a side effect of running `init --network mainnet` for the
  read-only previews. Unfunded, but it is a real row.
