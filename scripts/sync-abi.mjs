#!/usr/bin/env node
/**
 * ABI drift guard. The hand-maintained parseAbi surface in
 * src/venues/shroom/abi.ts MUST be a selector-level subset of the vendored
 * Foundry ABI (abi/LaunchpadCore.abi.json) — the shroom_launchpad monorepo
 * had a silent-drift incident in 2026-06 that broke three mirrors at once,
 * so drift here is a hard failure, not a warning.
 *
 * Modes:
 *   node scripts/sync-abi.mjs --check     assert surface ⊆ vendored (CI; needs `npm run build` first)
 *   node scripts/sync-abi.mjs --refresh   re-copy the ABI from $SHROOM_REPO's Foundry artifact
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toFunctionSelector } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendoredPath = join(root, "abi", "LaunchpadCore.abi.json");

const mode = process.argv.includes("--refresh") ? "refresh" : "check";

if (mode === "refresh") {
  const repo = process.env.SHROOM_REPO;
  if (!repo) {
    console.error("set SHROOM_REPO to the shroom_launchpad checkout to refresh");
    process.exit(1);
  }
  const artifact = JSON.parse(
    readFileSync(join(repo, "contracts/out/LaunchpadCore.sol/LaunchpadCore.json"), "utf-8"),
  );
  writeFileSync(vendoredPath, `${JSON.stringify(artifact.abi, null, 2)}\n`);
  console.log(`refreshed ${vendoredPath} (${artifact.abi.length} entries)`);
  process.exit(0);
}

// --check: compare the built surface against the vendored ABI.
const vendored = JSON.parse(readFileSync(vendoredPath, "utf-8"));
const vendoredSelectors = new Map(
  vendored
    .filter((e) => e.type === "function")
    .map((e) => [toFunctionSelector(e), e.name]),
);

const { LAUNCHPAD_ABI } = await import(join(root, "dist/venues/shroom/abi.js")).catch((e) => {
  console.error("could not load dist/venues/shroom/abi.js — run `npm run build` first");
  console.error(String(e));
  process.exit(1);
});

let failed = false;
for (const entry of LAUNCHPAD_ABI) {
  if (entry.type !== "function") continue;
  const sel = toFunctionSelector(entry);
  if (!vendoredSelectors.has(sel)) {
    console.error(`DRIFT: surface function ${entry.name} (${sel}) not in the vendored ABI`);
    failed = true;
  }
}

if (failed) {
  console.error(
    "\nThe parseAbi surface no longer matches the deployed contract. Refresh the vendored ABI\n" +
      "(SHROOM_REPO=... node scripts/sync-abi.mjs --refresh) and fix the surface in\n" +
      "src/venues/shroom/abi.ts before publishing — a drifted mirror fails with opaque reverts.",
  );
  process.exit(1);
}
console.log(`abi-sync OK: surface ⊆ vendored (${vendoredSelectors.size} on-chain functions)`);
