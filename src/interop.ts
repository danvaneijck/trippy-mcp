/**
 * Coexistence with the Injective AI SDK (`@injectivelabs/ainj`).
 *
 * That SDK ships its own MCP server whose `wallet_generate` / `wallet_import`
 * tools keep keys in a SEPARATE keystore at ~/.injective-agent/keys/. When both
 * servers are installed, an agent that generates a wallet there and then calls
 * a trippy tool is on a DIFFERENT address holding DIFFERENT funds — far and
 * away the most likely source of confusion. Detecting it lets `wallet_status`
 * and `agent_info` say so out loud instead of reporting a puzzling zero.
 *
 * We deliberately do NOT read, import, or share those keys. The two custody
 * models are incompatible on purpose: ainj signs with no spend policy and takes
 * the keystore password as a tool argument, so importing this agent's budgeted
 * burner into it would route around the per-tx cap, the 24h budget, and the
 * fixed sweep destination. Detection here is read-only and reports addresses
 * only — never key material, never the keystore contents.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where @injectivelabs/mcp-server-core stores its encrypted keys. */
const AINJ_KEYSTORE_SUBPATH = [".injective-agent", "keys"];
/** Where `ainj install` writes its own state. */
const AINJ_STATE_SUBPATH = [".ainj", "config.json"];

const INJ_ADDRESS_RE = /^inj1[a-z0-9]{38}$/;

/** Keep the payload small — this is context every wallet_status call pays for. */
const MAX_LISTED = 10;

export interface AinjPresence {
  /** The Injective AI SDK's own keystore directory, when it exists. */
  keystoreDir: string | null;
  /** inj1 addresses found there. Addresses only — never key material. */
  wallets: string[];
  /** True when more wallets exist than `wallets` lists. */
  truncated: boolean;
  /** True when `ainj install` has written its state file. */
  sdkConfigured: boolean;
  note: string;
}

function ainjNote(injAddress: string): string {
  return [
    "The Injective AI SDK (@injectivelabs/ainj) is installed on this machine and manages",
    "its own separate wallet(s) in its own keystore. Those are NOT this agent's wallet and",
    "hold different funds — never report their balances as this agent's, and never assume a",
    "wallet created with the SDK's `wallet_generate`/`wallet_import` can trade here.",
    "",
    "The two surfaces are complementary, not interchangeable:",
    `  - trippy tools  → spot: SHROOM Pad bonding curves + Choice-routed swaps, from ${injAddress}`,
    "  - Injective SDK → Helix perpetuals, subaccounts, bridges, transfers, chain queries",
    "",
    `To fund this agent, send INJ to ${injAddress} (the SDK's \`transfer_send\` can do it).`,
    "To move funds back out, use trippy `sweep` — it only ever pays the owner address fixed at init.",
  ].join("\n");
}

/**
 * Read-only probe for a co-installed Injective AI SDK. Returns null when
 * nothing is found, so the field stays absent for the common single-server
 * setup rather than adding noise to every status payload.
 */
export function detectAinj(
  opts: { home?: string; injAddress?: string } = {},
): AinjPresence | null {
  const home = opts.home ?? homedir();
  const keystoreDir = join(home, ...AINJ_KEYSTORE_SUBPATH);
  const statePath = join(home, ...AINJ_STATE_SUBPATH);

  const sdkConfigured = safeExists(statePath);
  const dirExists = safeExists(keystoreDir);
  if (!sdkConfigured && !dirExists) return null;

  const all = dirExists ? readWallets(keystoreDir) : [];
  return {
    keystoreDir: dirExists ? keystoreDir : null,
    wallets: all.slice(0, MAX_LISTED),
    truncated: all.length > MAX_LISTED,
    sdkConfigured,
    note: ainjNote(opts.injAddress ?? "this agent's inj address"),
  };
}

function readWallets(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    // The filename IS the address in that keystore layout; fall back to the
    // `address` field so a renamed file still resolves.
    const fromName = entry.slice(0, -".json".length);
    if (INJ_ADDRESS_RE.test(fromName)) {
      found.add(fromName);
      continue;
    }
    const fromBody = readAddressField(join(dir, entry));
    if (fromBody) found.add(fromBody);
  }
  return [...found].sort();
}

function readAddressField(file: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    const address = (parsed as { address?: unknown }).address;
    return typeof address === "string" && INJ_ADDRESS_RE.test(address) ? address : null;
  } catch {
    return null;
  }
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
