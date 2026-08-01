/**
 * `trippy-mcp connect` — wire this install into the coding agents on this
 * machine. Flag parsing, passphrase policy and human output; the config file
 * mechanics live in harness.ts.
 */

import { homeDir } from "../config.js";
import { loadKeystore } from "../keystore.js";
import {
  CLIENTS,
  CLIENT_LABELS,
  SERVER_NAME_RE,
  connect,
  detectClients,
  isClientId,
  type ClientId,
  type ConnectResult,
  type Scope,
} from "./harness.js";
import { clientSnippets } from "./snippets.js";

interface ConnectFlags {
  clients: ClientId[] | null;
  scope: Scope;
  serverName: string;
  noPassphrase: boolean;
  print: boolean;
}

function parseFlags(argv: string[], out: (s: string) => void): ConnectFlags | null {
  const flags: ConnectFlags = {
    clients: null,
    scope: "user",
    serverName: "trippy",
    noPassphrase: false,
    print: false,
  };
  const picked: ClientId[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--client" || a === "--clients") {
      const value = argv[++i];
      if (!value) {
        out("--client needs a value (claude, codex, cursor, windsurf, or all)");
        return null;
      }
      for (const part of value.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (part === "all") {
          picked.push(...CLIENTS);
        } else if (isClientId(part)) {
          picked.push(part);
        } else {
          out(`unknown client "${part}" — expected one of ${CLIENTS.join(", ")}, or all`);
          return null;
        }
      }
    } else if (a === "--scope") {
      const value = argv[++i];
      if (value !== "user" && value !== "project") {
        out('--scope must be "user" or "project"');
        return null;
      }
      flags.scope = value;
    } else if (a === "--name") {
      const value = argv[++i] ?? "";
      if (!SERVER_NAME_RE.test(value)) {
        out("--name must be 1-32 chars: letters, digits, _ or -");
        return null;
      }
      flags.serverName = value;
    } else if (a === "--no-passphrase") {
      flags.noPassphrase = true;
    } else if (a === "--print") {
      flags.print = true;
    } else {
      out(`unknown flag: ${a}`);
      return null;
    }
  }

  if (picked.length > 0) flags.clients = [...new Set(picked)];
  return flags;
}

/** Encrypted keystore + a passphrase we can see = embed it, unless told not to. */
function resolveEnv(noPassphrase: boolean): { env?: Record<string, string>; note?: string } {
  let encrypted: boolean;
  try {
    encrypted = loadKeystore(homeDir()).kind === "encrypted";
  } catch {
    return { note: "No keystore found yet — run `trippy-mcp init` first." };
  }
  if (!encrypted) return {};
  if (noPassphrase) {
    return { note: "Passphrase not written (--no-passphrase). Supply TRIPPY_MCP_PASSPHRASE yourself." };
  }
  const passphrase = process.env.TRIPPY_MCP_PASSPHRASE;
  if (!passphrase) {
    return {
      note:
        "Keystore is encrypted but TRIPPY_MCP_PASSPHRASE is not set in this shell, so it was " +
        "not written into the config. Re-run with it exported, or add it to the entry by hand — " +
        "until then the tools will report a locked keystore.",
    };
  }
  return { env: { TRIPPY_MCP_PASSPHRASE: passphrase } };
}

export async function connectCommand(argv: string[]): Promise<void> {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const flags = parseFlags(argv, out);
  if (!flags) {
    process.exitCode = 1;
    return;
  }

  if (flags.print) {
    const encrypted = (() => {
      try {
        return loadKeystore(homeDir()).kind === "encrypted";
      } catch {
        return true;
      }
    })();
    out(clientSnippets({ encrypted }));
    return;
  }

  const clients = flags.clients ?? detectClients();
  if (clients.length === 0) {
    out("No coding agents detected on this machine.");
    out("Pick one explicitly, e.g. `trippy-mcp connect --client claude`, or paste a snippet:");
    out(clientSnippets({ encrypted: true }));
    process.exitCode = 1;
    return;
  }

  const { env, note } = resolveEnv(flags.noPassphrase);
  const results = connect({
    clients,
    scope: flags.scope,
    serverName: flags.serverName,
    env,
  });

  report(results, flags, out);
  if (note) {
    out("");
    out(`! ${note}`);
  }
}

export function report(
  results: ConnectResult[],
  flags: { serverName: string },
  out: (s: string) => void,
): void {
  const verb = { created: "added", updated: "updated", unchanged: "already set" };
  for (const r of results) {
    out(`✓ ${CLIENT_LABELS[r.client]}: "${flags.serverName}" ${verb[r.action]} in ${r.file}`);
    for (const n of r.notes) out(`    ! ${n}`);
  }
  const touched = results.filter((r) => r.action !== "unchanged");
  if (touched.length > 0) {
    out("");
    out("Restart the agent (or reload its MCP servers) to pick up the change.");
  }
}
