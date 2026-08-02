# Testing the airdrop rails against a real chain

How the 2026-08-02 sweep was run, so the next one starts where that one
finished rather than rediscovering the setup. Results and what the chain
contradicted live in `DESIGN-protocol-docs-and-airdrops.md`; this is the
mechanics.

## Never test against `~/.trippy-mcp`

That is the live mainnet install (`fable-agent`, claimed, registered, wired into
Claude Code, holds real INJ). Every command below points `TRIPPY_MCP_HOME` at a
scratch directory instead. Nothing in the sweep touched the live install and
nothing in the next one should either.

```bash
export TRIPPY_MCP_HOME=/tmp/…/scratchpad/mcp-home
mkdir -p "$TRIPPY_MCP_HOME"
node dist/index.js init --network testnet --name sweep-tester \
  --owner 0x000000000000000000000000000000000000dEaD \
  --plaintext --no-connect < /dev/null
```

`--no-connect` matters: without it, `init` writes an MCP entry into the real
`~/.claude.json`.

**Do not run `init --network mainnet` for read-only work.** It registers the
agent name on the PRODUCTION registry as a side effect — the last sweep left a
throwaway `sweep-reader` row there. For mainnet previews, hand-write
`config.json` + `keystore.json` into a scratch home instead.

## Testnet cannot price anything until you fix that

Valuation reads the **pump API**, not the LaunchpadCore, and the testnet
`NetworkDef` ships an empty `pumpApiBase`. An airdrop that cannot be priced is
refused outright with no `allowUnpricedSpend` escape, so *every* testnet airdrop
fails until the scratch config carries:

```jsonc
{ "pumpApiBase": "https://pump-api.trippyinj.xyz", "dryRun": true }
```

The USD rates are network-independent, so the mainnet feed is the right one.
Preview reports `policyCheck.whyUnpriced` if this is ever missing again.

Start with `dryRun: true` for a first pass through each path, then flip it off.
Note a claim-drop dry run still publishes leaves to Hasura — harmless and
content-addressed, but it is a real write.

## Funding

The faucet is captcha-gated (`POST {lambdaApi}/faucet` with a captcha token), so
it cannot be scripted — ask Dan to send testnet INJ. About 2 INJ covers a full
sweep. Sweep wallet, still funded:

```
inj120sh4mtk5u6gfea8r74e46fcq5vc6jmth6k237
0x53e17aed76A73484E7a71fab9aE93805198D4b6b
```

## Driving the tools

The MCP layer only wraps `src/mcp/tools.ts`, so a tiny driver exercises the same
code an agent hits, without a stdio harness:

```js
import { buildRuntime } from "…/dist/runtime.js";
import * as t from "…/dist/mcp/tools.js";
const rt = buildRuntime(process.env.TRIPPY_MCP_PASSPHRASE);
console.log(JSON.stringify(await t.airdropPreview(rt, args), null, 2));
```

Calling `airdropPreview` directly also bypasses the zod schema, which is how the
sweep reached a sub-day expiry (`expiryDays: 0.0012` ≈ 100s) to test clawback
without waiting a day. The MCP schema floors it at 1.

## Testing the bisection path

Only 12 of the 20 module accounts in `BLOCKED_RECIPIENTS` are actually refused
by the bank keeper — the rest accept and keep the funds. Pick a **refused** one
(`wasm`, `mint`, `auction`, `txfees`, …), never an accepting one, or the send
simply succeeds and the tokens are gone.

Since the leaf builder filters them all, temporarily remove the chosen address
from the built `dist/airdrops/address.js` rather than from `src/` — `dist/` is
gitignored, so the tweak cannot reach a commit:

```bash
cp dist/airdrops/address.js dist/airdrops/address.js.orig
sed -i 's|^\s*"inj1xds4f0m87…".*$|  // TEMP|' dist/airdrops/address.js
# … run the push …
cp dist/airdrops/address.js.orig dist/airdrops/address.js
```

## Testing crash-resume

Racing a real SIGKILL is awkward: the window between "broadcast submitted" and
"checkpoint written" is under a second, and the lazy `@injectivelabs/sdk-ts`
import means the pending file appears several seconds before anything is sent.
Polling for `<home>/airdrops/push/<planId>.pending.json` and killing 1.8s later
reliably produced the *never-landed* branch; 5s let the run finish.

For the *landed-but-uncheckpointed* branch, reconstruct the on-disk state
instead — let a send complete, then delete the checkpoint and hand-write the
pending file with the pre-send probe balance and sequence. That is exactly what
the crash leaves, and it is deterministic.

Either way the assertion is the same: recipients paid **exactly once**, and the
account sequence advanced by the number of sends that actually happened.

## State left behind on testnet

| Campaign | State |
|---|---|
| #5 | live, frozen, 0.03 INJ unclaimed, expiry 2026-10-01, unpaused |
| #6 | **perpetual** — frozen with no expiry, so 0.001 INJ is locked in it forever by design |
| #7 | swept (clawed back), closed |

Campaign #5 is a ready-made subject for claim-flow testing.

## Not yet exercised

- **A recipient actually claiming.** Campaign #5 has three funded leaves and
  zero claimants — the claim page was only checked for HTTP 200, never driven
  through a real proof-and-claim.
- **`token_holders`, `launch_holders`, `buyback_round`** sources, and the plain
  **CW721** path (only CW404 was diffed). `buyback_round` is mainnet-only.
- **A mainnet drop of either rail.** Everything that broadcast did so on testnet.
- **A large list** — the biggest run was 5 recipients. The claim rail is capped
  at 50k and the push rail at 1000; neither ceiling has been near.
- **The `explain` tool** against a live chain (it is read-only, so this is cheap).
- **`claimUrl` across networks** — `/claim/<id>` resolves against whatever
  network the visitor's site store is on, and campaign ids are per-contract, so
  testnet #5 and a future mainnet #5 collide on the same URL.
