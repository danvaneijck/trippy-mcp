# Design: protocol knowledge + airdrop tools for trippy-mcp

Status: DRAFT for review — nothing built.
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
- v1 is one-shot campaigns only on Dan's instance. Streaming campaigns / manage tools (freeze early, extend expiry, clawback after expiry) are a later `airdrop_manage` tool — smaller surface for the risky first release. Clawback is the one we'll want soonest.

### 2.3 Criteria: the six trippytools sources, phased

(Confirmed: trippytools has exactly six — there is no volume-based source there.)

| Source | Inputs | Backing read | Phase |
|---|---|---|---|
| `csv` | rows `[{address, amount}]` inline or file path | none (fixed amounts, bypasses allocator) | 1 — **gated, see 2.5** |
| `token_holders` | bank denom OR CW20 address | LCD `denom_owners` paging; CW20 `fetchContractAccountsBalance` + bank-wrapped half merged (÷10^decimals) | 1 |
| `launch_holders` | launchId or token query | the launch token's bank denom via sink `token_denom` → `denom_owners` (bank+ERC20 are one balance, so curve-phase holders included). Prefer a pump-api holders endpoint if present | 1 — the agent-native case: "reward my token's holders" |
| `nft_holders` | collection address (+is404) | `all_tokens` paging + owner batch resolve; CW404 raw-state scan | 2 |
| `gov_voters` | proposal id (+height or auto-find) | LCD votes with `x-cosmos-block-height` (the only true at-height snapshot) + the binary-search block finder | 2 |
| `mito_vault` | vault address, stake\|non-stake | IndexerGrpcMitoApi `fetchLPHolders` | 3 |
| `buyback_round` | round, expectedTotalInj | raw contract-state paging with the hand-built key prefix | 3 |

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
| 3 | Sources: nft, gov (+block finder); `airdrop_manage` (clawback/extend) | low |
| 4 | Push rail (≤1000 recipients, checkpoint+bisection in `~/.trippy-mcp`), mito + buyback sources, history logging | medium |

Each PR follows the house pattern: impl in `tools.ts` (pure pieces exported for vitest), registration in `server.ts`, ToolError envelopes, CI typecheck/test/pack-gate.

## Open questions for Dan

1. **SHROOM fee**: keep 25k parity for agent-created drops? (Design assumes yes.)
2. **`airdropCapUsd` default 0 (feature off until configured)** — confirm.
3. **CSV recipients behind `allowArbitraryRecipients`, default off** — confirm.
4. **Claim URL**: reuse trippytools `/claim/:id` as the canonical claim page for agent drops? (Design assumes yes; the alternative is a claim view in the Terminal.)
5. `explain` content tone: pure mechanics, or also strategy guidance ("SAI quote maximizes your creator take", "set a dev-buy guard window")? Design assumes mechanics + a light "why you'd pick each quote."
6. Related loose end from the smoke: curve-buy `referrer` currently defaults to the feeTreasury — still unconfirmed as the intended default; the fees doc topic will document whatever we settle on.
