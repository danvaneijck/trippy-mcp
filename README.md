# trippy-mcp

Let your coding agent trade on Injective. `trippy-mcp` is a stdio [MCP](https://modelcontextprotocol.io) server that plugs into **Claude Code, Codex, Cursor** (any MCP client) and gives it tools to:

- **launch tokens** on [SHROOM Pad](https://pump.trippyinj.xyz) (bonding curve → graduates to a Choice CLMM pool)
- **trade bonding-curve tokens** (buy/sell/quote, on-chain-exact quotes)
- **swap any Injective token** through the [Choice](https://choice.exchange) aggregation router (AMM + CLMM + orderbook smart order routing)
- carry an **agent identity**: trades from your agent get an AGENT badge on [Trippy Terminal](https://trade.trippyinj.xyz), optionally linked to your profile

**Non-custodial by construction.** `init` generates a fresh key on *your* machine; no server ever sees it. The agent wallet is a budgeted burner you fund from your main wallet — never your main key.

## Quickstart

```bash
npx trippy-mcp init      # generate the agent wallet, pick a name, register,
                         # and wire up every coding agent found on this machine
# then fund the printed address with a small INJ budget
```

Then just talk to your agent: *"what's trending on shroom pad? quote a 0.5 INJ buy on the top one"* — or *"launch a token called ... with this logo"*.

`init` writes the MCP entry for you. To add more clients later, or to wire up a repo:

```bash
trippy-mcp connect --client claude,codex,cursor,windsurf   # or --client all
trippy-mcp connect --scope project                         # writes ./.mcp.json
trippy-mcp connect --print                                 # just show the snippets
```

Writes are merge-then-rename with a `.trippy-bak` copy kept behind, so nothing else in `~/.claude.json` (or your Codex TOML, comments and all) is disturbed. The keystore passphrase is only ever embedded in **user-scope** files, chmod `0600` — project config gets committed to git, so it is left out with a note.

## Security model

The key never leaves your machine, and four independent layers stand between a misbehaving (or prompt-injected) model and your funds:

1. **Budgeted burner** — the wallet only ever holds what you send it. Your main wallet is never touched.
2. **Policy engine in the signer** (not in the tools, not in the model): per-tx USD cap, rolling 24h budget, slippage ceiling, and a hard contract allowlist (LaunchpadCore, its quote assets, the Choice aggregator, the claim-drops contract — nothing else). Configured in `~/.trippy-mcp/config.json`; changing it is a human action.
3. **Sweep is one-way home** — `sweep` takes no destination. Funds can only go to the owner address you fixed at `init`. Airdrops are the one exception that sends value to addresses you did not name, so they carry their own ceiling (`airdropCapUsd`, separate from the trade cap), are never allowed to skip USD valuation, and require a previewed plan id rather than raw criteria.
4. **Untrusted-data discipline** — token names/descriptions are attacker-controlled internet text; tools sanitize them and fence them under `untrusted_metadata` so your agent treats them as data, not instructions.

Plus: encrypted keystore by default (scrypt + AES-256-GCM), append-only audit log (`~/.trippy-mcp/audit.log`), `dryRun` mode, and a `tradingEnabled` kill switch. `export-key` exists but shouts at you.

## Tools

| Tool | What it does |
|---|---|
| `explain` | how the protocols work — curve mechanics, quote-asset choice, every fee/discount/gate, Choice routing gotchas, the agent's own policy. Every number is read from the chain at call time, so the docs cannot go stale between releases |
| `search_tokens` / `token_info` | resolve + inspect any token (curve state, graduation progress, this launch's own fee/gate terms, Choice market data) |
| `trending` / `new_launches` / `recent_trades` | discovery + tape |
| `candles` | OHLCV price history — curve launches (quote-priced + per-bucket USD rate) or Choice markets (USD-priced) |
| `my_activity` | the agent's own history on both venues: curve trades + Choice swaps, orderbook fills, window-flow PnL |
| `quote` | preview a buy/sell — auto-routes curve vs Choice |
| `buy` / `sell` | execute — curve trades on SHROOM Pad, everything else via the Choice aggregator |
| `create_token` | launch on the bonding curve (image upload → IPFS, ~0.2 INJ creation fee, optional initial buy) |
| `claim_fees` | creator fees, referral fees, cancelled-launch refunds (reads first, only claims non-zero) |
| `wallet_status` / `sweep` | balances + policy budget; send funds home |
| `portfolio` | every holding valued in USD (quote-rate feed / last curve trade / Choice stats) |
| `agent_info` | identity + how to claim the agent to your Terminal profile |
| `airdrop_preview` / `airdrop_execute` / `airdrop_status` | merkle claim drops to token or launch holders — one tx for any list size. Two-step commit: preview publishes and broadcasts nothing, execute funds only a previewed plan. Capped by `policy.airdropCapUsd`; set it to `0` and these tools are not registered at all |

`buy`/`sell`/`quote`/`portfolio`/`sweep` state their scope in their descriptions, so a model with the Injective MCP also connected picks the right server (and the right wallet) — see [below](#alongside-the-injective-ai-sdk).

Tool names are bare verbs. Claude Code namespaces them for you (`mcp__trippy__buy`); in harnesses that show a flat list, set `TRIPPY_MCP_TOOL_PREFIX=trippy` in the server env to register `trippy_buy`, `trippy_sell` and so on.

## Alongside the Injective AI SDK

[`@injectivelabs/ainj`](https://github.com/InjectiveLabs/ainj) ships its own MCP server, and the two are meant to be run together — nothing collides by name and the split is clean:

| Concern | trippy-mcp | Injective MCP (`ainj mcp main`) |
|---|---|---|
| Owns | spot: bonding curves, aggregator swaps, launches | perps, subaccounts, bridges, transfers, authz, chain queries |
| Trade | `buy` / `sell` / `quote` | `trade_open` / `trade_close` / `trade_limit_*` |
| Balances | `portfolio`, `wallet_status` | `account_balances`, `account_positions` |
| Token data | `token_info` (market + curve state) | `token_metadata` (on-chain denom metadata) |

**They sign for different wallets.** The Injective MCP's `wallet_generate` / `wallet_import` write to `~/.injective-agent/keys/`; those addresses cannot trade here. When that keystore is present, `wallet_status` and `agent_info` report it under `otherAgentWallets` so the model says so out loud instead of reporting a confusing zero.

Keep it that way. The intended pairing is a funding loop — fund this agent from your own wallet (the Injective MCP's `transfer_send` works fine), `sweep` profits back — **not** a shared key. That server signs with no spend policy and takes the keystore password as a tool argument, so importing this agent's key into it would void the per-tx cap, the daily budget and the fixed sweep destination in one move.

There is a [skill](./skills/injective-memecoin-trading/SKILL.md) that teaches an agent all of the above:

```bash
npx skills add danvaneijck/trippy-mcp --skill injective-memecoin-trading
```

## Agent identity

`init` registers your agent's name with the Trippy registry (signed by the agent key — proof of key control, nothing custodial). From then on its trades show an **AGENT** badge on Trippy Terminal. To attach it to your profile ("operated by you"), run `trippy-mcp claim-code` and enter the code in **Terminal → Settings → Agents** with your main wallet.

Give the agent a profile image with `--avatar` (at `init` or any later `register`): pass an https URL, or a local `.png`/`.jpg`/`.webp`/`.gif` — local files are uploaded to IPFS through the SHROOM API. The image shows wherever the Terminal shows profile avatars for the agent's address. Re-registering without `--avatar` keeps the current image.

## CLI

```
trippy-mcp init          create wallet + identity, then connect detected clients
                         (interactive; --plaintext, --network testnet, --avatar <url|path>, --no-connect)
trippy-mcp serve         run the MCP server (this is what your agent client launches)
trippy-mcp connect       write the MCP entry into your coding agent's config
                         (--client claude|codex|cursor|windsurf|all, --scope user|project,
                          --name <server-name>, --no-passphrase, --print)
trippy-mcp status        balances (bank-authoritative), policy budget, registration
trippy-mcp register      re-register / rename; --avatar <url|path> sets the profile image
trippy-mcp claim-code    mint a profile-link code
trippy-mcp sweep <asset> <amount|all>
trippy-mcp export-key --yes-i-understand
```

## Config (`~/.trippy-mcp/config.json`)

```jsonc
{
  "network": "mainnet",
  "agentName": "my-agent",
  "ownerSweepAddress": "0x…",        // immutable — the only sweep destination
  "policy": {
    "perTxCapUsd": 200,
    "dailyBudgetUsd": 1000,
    "maxSlippageBps": 300,
    "tradingEnabled": true,
    "allowUnpricedSpend": false,
    "airdropCapUsd": 1000            // max USD per airdrop campaign; 0 = airdrop tools not registered
  },
  "dryRun": false
  // optional: rpcUrls, lcdUrl, pumpApiBase, choiceApiBase, gasBufferPct, gasPriceWei, referrer
}
```

## Injective quirks this package handles for you

- `eth_getBalance` can report **0** for funded accounts on Injective's EVM RPC — balances are read from the Cosmos bank (LCD), and a transport shim keeps viem's preflight honest. Explorers/MetaMask may show 0 for the agent wallet; `trippy-mcp status` is authoritative.
- Gas is billed at the **limit**, not usage — the signer estimates and adds a small buffer instead of flat limits.
- Public RPCs 502 intermittently and receipts lag — requests retry across endpoints, and a missing receipt triggers a state re-read instead of a false failure.
- Launches start **Reserved** until the keeper binds them (~seconds): `create_token` waits and reports honestly.

## Development

```bash
npm ci && npm run typecheck && npm test && npm run build
node scripts/sync-abi.mjs --check     # ABI-drift guard against the vendored artifact
SHROOM_REPO=../shroom_launchpad node scripts/sync-abi.mjs --refresh
```

MIT
