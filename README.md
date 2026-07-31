# trippy-mcp

Let your coding agent trade on Injective. `trippy-mcp` is a stdio [MCP](https://modelcontextprotocol.io) server that plugs into **Claude Code, Codex, Cursor** (any MCP client) and gives it tools to:

- **launch tokens** on [SHROOM Pad](https://pump.trippyinj.xyz) (bonding curve → graduates to a Choice CLMM pool)
- **trade bonding-curve tokens** (buy/sell/quote, on-chain-exact quotes)
- **swap any Injective token** through the [Choice](https://choice.exchange) aggregation router (AMM + CLMM + orderbook smart order routing)
- carry an **agent identity**: trades from your agent get an AGENT badge on [Trippy Terminal](https://trade.trippyinj.xyz), optionally linked to your profile

**Non-custodial by construction.** `init` generates a fresh key on *your* machine; no server ever sees it. The agent wallet is a budgeted burner you fund from your main wallet — never your main key.

## Quickstart

```bash
npx trippy-mcp init      # generate the agent wallet, pick a name, register
# fund the printed address with a small INJ budget, then connect a client:
claude mcp add trippy -e TRIPPY_MCP_PASSPHRASE=... -- npx -y trippy-mcp serve
```

Then just talk to your agent: *"what's trending on shroom pad? quote a 0.5 INJ buy on the top one"* — or *"launch a token called ... with this logo"*.

## Security model

The key never leaves your machine, and four independent layers stand between a misbehaving (or prompt-injected) model and your funds:

1. **Budgeted burner** — the wallet only ever holds what you send it. Your main wallet is never touched.
2. **Policy engine in the signer** (not in the tools, not in the model): per-tx USD cap, rolling 24h budget, slippage ceiling, and a hard contract allowlist (LaunchpadCore, its quote assets, the Choice aggregator — nothing else). Configured in `~/.trippy-mcp/config.json`; changing it is a human action.
3. **Sweep is one-way home** — `sweep` takes no destination. Funds can only go to the owner address you fixed at `init`.
4. **Untrusted-data discipline** — token names/descriptions are attacker-controlled internet text; tools sanitize them and fence them under `untrusted_metadata` so your agent treats them as data, not instructions.

Plus: encrypted keystore by default (scrypt + AES-256-GCM), append-only audit log (`~/.trippy-mcp/audit.log`), `dryRun` mode, and a `tradingEnabled` kill switch. `export-key` exists but shouts at you.

## Tools

| Tool | What it does |
|---|---|
| `search_tokens` / `token_info` | resolve + inspect any token (curve state, graduation progress, Choice market data) |
| `trending` / `new_launches` / `recent_trades` / `my_activity` | discovery + tape |
| `quote` | preview a buy/sell — auto-routes curve vs Choice |
| `buy` / `sell` | execute — curve trades on SHROOM Pad, everything else via the Choice aggregator |
| `create_token` | launch on the bonding curve (image upload → IPFS, ~0.2 INJ creation fee, optional initial buy) |
| `claim_fees` | creator fees, referral fees, cancelled-launch refunds (reads first, only claims non-zero) |
| `wallet_status` / `sweep` | balances + policy budget; send funds home |
| `agent_info` | identity + how to claim the agent to your Terminal profile |

## Agent identity

`init` registers your agent's name with the Trippy registry (signed by the agent key — proof of key control, nothing custodial). From then on its trades show an **AGENT** badge on Trippy Terminal. To attach it to your profile ("operated by you"), run `trippy-mcp claim-code` and enter the code in **Terminal → Settings → Agents** with your main wallet.

## CLI

```
trippy-mcp init          create wallet + identity (interactive; --plaintext, --network testnet)
trippy-mcp serve         run the MCP server (this is what your agent client launches)
trippy-mcp status        balances (bank-authoritative), policy budget, registration
trippy-mcp register      re-register / rename
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
    "allowUnpricedSpend": false
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
