# Mainnet smoke runbook (operator-run, tiny sums)

Gates the first npm publish (`v0.1.0`). Total spend ≈ 0.3 INJ + gas.

## 0. Deploy prerequisites

- shroom_launchpad backend with migration `0020_agent_identities.sql` + `/agents` routes live on pump-api.trippyinj.xyz (`make migrate-mainnet`, roll the backend image).
- Terminal deployed with the AgentBadge/AgentsCard build (auto-deploys on master push — merge one PR at a time, no CI concurrency group).

## 1. Init + registry

```bash
npx trippy-mcp init --name <smoke-name> --owner <your-main-0x>   # encrypted keystore
trippy-mcp status        # expect: balances all 0, registered: true
```

- Verify `GET pump-api.trippyinj.xyz/agents/<agent-address>` returns the row.
- Fund the printed address with ~0.5 INJ from the main wallet.
- `trippy-mcp status` again → INJ balance shows (bank read; explorer may show 0 — expected).

## 2. MCP session (Claude Code)

```bash
claude mcp add trippy-smoke -e TRIPPY_MCP_PASSPHRASE=... -- npx -y trippy-mcp serve
claude -p "using the trippy tools: show wallet_status, list 3 trending curve tokens, and quote a 0.05 INJ buy on the top one. Do not execute any trade."
```

Expect: clean JSON payloads, `untrusted_metadata` fencing on names, no tool errors.

## 3. Curve trade round-trip

In the same session (or `claude` interactive):
- `buy` 0.05 INJ on a liquid live launch → expect confirmed hash + explorer link; check the audit log (`~/.trippy-mcp/audit.log`) has `tx:broadcast` + `tx:confirmed`.
- Trade appears on the Terminal token page tape with the **AGENT** badge (profiles/meta join).
- `sell` `"all"` on the same launch → confirmed.
- `claim_fees` → "nothing to claim" notes (no reverts).

## 4. Choice swap leg

- `buy` 0.05 INJ worth of a NON-curve token (e.g. `query: "SHROOM"` post-graduation or any Choice token) → auto-routes to choice venue, memo `trippy-mcp:<name>`.
- Verify in Choice Hasura / Terminal tape: memo present, trade visible.

## 5. Claim + badge attribution

```bash
trippy-mcp claim-code
```
- Open the printed `/settings?claimAgent=<code>` link, sign with the main wallet.
- Settings → Agents lists the agent; portfolio page for the agent address shows the AGENT chip with "operated by" tooltip.

## 6. Policy checks (negative)

- Ask the agent to buy above `perTxCapUsd` → expect a `policy_violation` error envelope, `tx:policy_denied` audit entry, no broadcast.
- `sweep INJ all` → funds land on the owner wallet minus 0.05 reserve.

## 7. Publish

- `npm publish` via the release workflow (tag `v0.1.0`, needs `NPM_TOKEN` secret). Check the npm page renders the README security section.
