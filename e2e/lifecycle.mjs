#!/usr/bin/env node
/**
 * Testnet lifecycle driver — exercises the REAL MCP path (stdio JSON-RPC into
 * `dist/index.js serve`), not the internals.
 *
 * Usage:
 *   1. TRIPPY_MCP_HOME=/tmp/trippy-e2e node dist/index.js init \
 *        --network testnet --plaintext --name e2e-agent --owner 0x<your-main-wallet>
 *   2. fund the printed address with testnet INJ (faucet)
 *   3. TRIPPY_MCP_HOME=/tmp/trippy-e2e node e2e/lifecycle.mjs [--create]
 *
 * Without --create it runs the read/quote path (safe, no spend); with
 * --create it drives create_token → buy → sell "all" → claim_fees → sweep.
 * Testnet has no public pump API by default, so data tools may report no_api —
 * set pumpApiBase in the e2e home's config.json to a local backend
 * (`make up` in shroom_launchpad) to exercise the registry too.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doCreate = process.argv.includes("--create");

const proc = spawn("node", [join(root, "dist/index.js"), "serve"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

let buf = "";
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function call(name, args = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text);
  const status = res.result?.isError ? "ERR " : "ok  ";
  console.log(`\n── ${status}${name}(${JSON.stringify(args)})`);
  console.log(text.length > 1500 ? `${text.slice(0, 1500)}…` : text);
  return parsed;
}

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "lifecycle-e2e", version: "0" },
});
notify("notifications/initialized");

// ---- read path (always) -----------------------------------------------------
const status = await call("wallet_status");
if (status.error) {
  console.error("\nwallet_status failed — did you run init with TRIPPY_MCP_HOME set?");
  process.exit(1);
}
await call("agent_info");
await call("new_launches", { source: "curve", limit: 3 });

if (!doCreate) {
  console.log("\nread path done. Re-run with --create for the full spend lifecycle.");
  proc.kill();
  process.exit(0);
}

// ---- spend lifecycle (--create) --------------------------------------------
const created = await call("create_token", {
  name: "trippy-mcp e2e",
  symbol: "TME2E",
  description: "throwaway e2e launch",
  quoteAsset: "INJ",
});
if (created.error) {
  proc.kill();
  process.exit(1);
}
const id = created.launchId;

await call("quote", { query: id, side: "buy", amount: "0.2" });
await call("buy", { query: id, amount: "0.2" });
await call("sell", { query: id, amount: "all" });
await call("claim_fees", { launchIds: [id] });
await call("my_activity");
await call("sweep", { asset: "INJ", amount: "0.05" });

console.log("\nlifecycle complete.");
proc.kill();
process.exit(0);
