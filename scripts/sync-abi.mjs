#!/usr/bin/env node
/**
 * ABI drift guard. Every hand-maintained parseAbi surface MUST be a
 * selector-level subset of its vendored ABI — the shroom_launchpad monorepo
 * had a silent-drift incident in 2026-06 that broke three mirrors at once,
 * so drift here is a hard failure, not a warning.
 *
 * Two surfaces are checked:
 *   src/venues/shroom/abi.ts   ⊆ abi/LaunchpadCore.abi.json   (our contract)
 *   src/identity/abi.ts        ⊆ abi/IdentityRegistry.abi.json (ERC-8004)
 *
 * The second one matters MORE, not less, for being someone else's: the
 * registry is an upgradeable proxy, so the implementation behind those
 * selectors can be swapped without any redeploy of ours. The weekly CI run is
 * the only thing that would notice.
 *
 * Modes:
 *   node scripts/sync-abi.mjs --check     assert surface ⊆ vendored (CI; needs `npm run build` first)
 *   node scripts/sync-abi.mjs --refresh   re-copy the ABIs from $SHROOM_REPO / $AGENT_SDK_REPO
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toFunctionSelector } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Each checked surface: vendored artifact ← built module export. */
const SURFACES = [
  {
    label: "LaunchpadCore",
    vendored: join(root, "abi", "LaunchpadCore.abi.json"),
    module: "dist/venues/shroom/abi.js",
    exportName: "LAUNCHPAD_ABI",
    source: "src/venues/shroom/abi.ts",
    refresh: {
      env: "SHROOM_REPO",
      path: "contracts/out/LaunchpadCore.sol/LaunchpadCore.json",
      pick: (artifact) => artifact.abi,
    },
  },
  {
    label: "IdentityRegistry (ERC-8004)",
    vendored: join(root, "abi", "IdentityRegistry.abi.json"),
    module: "dist/identity/abi.js",
    exportName: "IDENTITY_REGISTRY_ABI",
    source: "src/identity/abi.ts",
    refresh: {
      env: "AGENT_SDK_REPO",
      path: "packages/sdk/src/abi/IdentityRegistry.json",
      // Injective's SDK ships a bare ABI array, not a Foundry artifact.
      pick: (artifact) => (Array.isArray(artifact) ? artifact : artifact.abi),
    },
  },
];

const mode = process.argv.includes("--refresh") ? "refresh" : "check";

if (mode === "refresh") {
  let refreshed = 0;
  for (const s of SURFACES) {
    const repo = process.env[s.refresh.env];
    if (!repo) {
      console.log(`skipping ${s.label}: ${s.refresh.env} is not set`);
      continue;
    }
    const abi = s.refresh.pick(JSON.parse(readFileSync(join(repo, s.refresh.path), "utf-8")));
    writeFileSync(s.vendored, `${JSON.stringify(abi, null, 2)}\n`);
    console.log(`refreshed ${s.vendored} (${abi.length} entries)`);
    refreshed++;
  }
  if (refreshed === 0) {
    console.error("nothing refreshed — set SHROOM_REPO and/or AGENT_SDK_REPO");
    process.exit(1);
  }
  process.exit(0);
}

// --check: compare each built surface against its vendored ABI.
let failed = false;
for (const s of SURFACES) {
  const vendored = JSON.parse(readFileSync(s.vendored, "utf-8"));
  const vendoredSelectors = new Map(
    vendored.filter((e) => e.type === "function").map((e) => [toFunctionSelector(e), e.name]),
  );

  const mod = await import(join(root, s.module)).catch((e) => {
    console.error(`could not load ${s.module} — run \`npm run build\` first`);
    console.error(String(e));
    process.exit(1);
  });
  const surface = mod[s.exportName];
  if (!surface) {
    console.error(`${s.module} does not export ${s.exportName}`);
    process.exit(1);
  }

  let surfaceFailed = false;
  for (const entry of surface) {
    if (entry.type !== "function") continue;
    const sel = toFunctionSelector(entry);
    if (!vendoredSelectors.has(sel)) {
      console.error(`DRIFT: ${s.label} surface function ${entry.name} (${sel}) not in the vendored ABI`);
      surfaceFailed = true;
    }
  }
  if (surfaceFailed) {
    console.error(
      `\nThe ${s.source} surface no longer matches the deployed contract. Refresh the vendored\n` +
        `ABI (${s.refresh.env}=... node scripts/sync-abi.mjs --refresh) and fix the surface\n` +
        "before publishing — a drifted mirror fails with opaque reverts.",
    );
    failed = true;
    continue;
  }
  console.log(`abi-sync OK: ${s.label} surface ⊆ vendored (${vendoredSelectors.size} on-chain functions)`);
}

if (failed) process.exit(1);
