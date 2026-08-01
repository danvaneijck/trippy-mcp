/**
 * Harness wiring — `trippy-mcp connect` writes the MCP server entry straight
 * into Claude Code / Codex / Cursor / Windsurf instead of printing a snippet
 * for the user to paste.
 *
 * Three rules this file exists to get right:
 *
 *  1. Correct file per client+scope. Claude Code reads PROJECT servers from
 *     `.mcp.json`, not `.claude/settings.json` (that one only holds pointers
 *     like `enabledMcpjsonServers`), so a project install written to the
 *     settings file is silently ignored.
 *  2. Never lose the host's state. These files hold unrelated config —
 *     `~/.claude.json` is the entire Claude Code profile — so every write is
 *     parse, merge, tmp-file, rename, with a `.trippy-bak` copy kept behind.
 *  3. Never commit a secret. The keystore passphrase goes into USER-scope
 *     files only (chmod 0600). Project files land in git, so we leave the env
 *     out and tell the caller how to supply it.
 *
 * Codex config is TOML and routinely hand-edited with comments, so it is
 * appended to rather than round-tripped through a parser.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CLIENTS = ["claude", "codex", "cursor", "windsurf"] as const;
export type ClientId = (typeof CLIENTS)[number];
export type Scope = "user" | "project";

export const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface ConnectOptions {
  clients: ClientId[];
  scope: Scope;
  serverName: string;
  /** Env to embed. Dropped for project scope — those files get committed. */
  env?: Record<string, string>;
  home?: string;
  cwd?: string;
}

export interface ConnectResult {
  client: ClientId;
  file: string;
  action: "created" | "updated" | "unchanged";
  /** Whether the passphrase (or any env) actually made it into the file. */
  envEmbedded: boolean;
  notes: string[];
}

export const CLIENT_LABELS: Record<ClientId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  windsurf: "Windsurf",
};

export function isClientId(v: string): v is ClientId {
  return (CLIENTS as readonly string[]).includes(v);
}

/**
 * Config file for a client+scope.
 *
 * Codex has no per-project config, so it always resolves to the user file;
 * `connect` reports that rather than writing somewhere the harness won't read.
 */
export function targetFile(
  client: ClientId,
  scope: Scope,
  home: string = homedir(),
  cwd: string = process.cwd(),
): string {
  switch (client) {
    case "claude":
      return scope === "user" ? join(home, ".claude.json") : join(cwd, ".mcp.json");
    case "cursor":
      return scope === "user"
        ? join(home, ".cursor", "mcp.json")
        : join(cwd, ".cursor", "mcp.json");
    case "windsurf":
      return join(home, ".codeium", "windsurf", "mcp_config.json");
    case "codex":
      return join(home, ".codex", "config.toml");
  }
}

/** Clients that already exist on this machine, so `connect` can pick sensibly. */
export function detectClients(home: string = homedir()): ClientId[] {
  const probes: Record<ClientId, string[]> = {
    claude: [join(home, ".claude.json"), join(home, ".claude")],
    codex: [join(home, ".codex")],
    cursor: [join(home, ".cursor")],
    windsurf: [join(home, ".codeium", "windsurf")],
  };
  return CLIENTS.filter((c) => probes[c].some(safeExists));
}

export function connect(opts: ConnectOptions): ConnectResult[] {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  return opts.clients.map((client) => connectOne(client, opts, home, cwd));
}

function connectOne(
  client: ClientId,
  opts: ConnectOptions,
  home: string,
  cwd: string,
): ConnectResult {
  const notes: string[] = [];
  let scope = opts.scope;

  if (client === "windsurf" && scope === "project") {
    scope = "user";
    notes.push("Windsurf has no per-project MCP config — wrote the user config instead.");
  }
  if (client === "codex" && scope === "project") {
    scope = "user";
    notes.push("Codex has no per-project MCP config — wrote ~/.codex/config.toml instead.");
  }

  // A project file is a committed file. Secrets never go in one.
  const wantEnv = opts.env && Object.keys(opts.env).length > 0;
  const embedEnv = wantEnv && scope === "user";
  if (wantEnv && !embedEnv) {
    notes.push(
      "Left TRIPPY_MCP_PASSPHRASE out of this file — project config is committed to git. " +
        "Export it in your shell, or connect with --scope user.",
    );
  }

  const file = targetFile(client, scope, home, cwd);
  const env = embedEnv ? opts.env : undefined;
  const action =
    client === "codex"
      ? writeCodex(file, opts.serverName, env, notes)
      : writeJsonConfig(file, client, opts.serverName, env, scope);

  return { client, file, action, envEmbedded: !!env, notes };
}

// ---------------------------------------------------------------------------
// JSON clients (Claude Code, Cursor, Windsurf)
// ---------------------------------------------------------------------------

function serverEntry(
  client: ClientId,
  env: Record<string, string> | undefined,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    // `type` is meaningful to Claude Code and ignored elsewhere.
    ...(client === "claude" ? { type: "stdio" } : {}),
    command: "npx",
    args: ["-y", "trippy-mcp", "serve"],
  };
  if (env) entry.env = { ...env };
  return entry;
}

function writeJsonConfig(
  file: string,
  client: ClientId,
  serverName: string,
  env: Record<string, string> | undefined,
  scope: Scope,
): ConnectResult["action"] {
  const existing = readJsonObject(file);
  const servers = isPlainObject(existing.mcpServers) ? { ...existing.mcpServers } : {};
  const entry = serverEntry(client, env);
  const previous = servers[serverName];

  if (previous !== undefined && stableStringify(previous) === stableStringify(entry)) {
    return "unchanged";
  }

  servers[serverName] = entry;
  const merged = { ...existing, mcpServers: servers };
  // Secrets present → 0600. Project files carry none and want to be readable.
  writeFileAtomic(file, `${JSON.stringify(merged, null, 2)}\n`, {
    defaultMode: env ? 0o600 : scope === "project" ? 0o644 : 0o600,
    forceMode: env ? 0o600 : undefined,
  });
  return previous === undefined ? "created" : "updated";
}

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // Absent or unreadable. Unparseable is the dangerous case: bail loudly
    // rather than replace a file we failed to understand.
    if (existsSync(file) && readFileSync(file, "utf-8").trim() !== "") {
      throw new Error(
        `${file} exists but is not valid JSON — refusing to overwrite it. Fix or move it, then retry.`,
      );
    }
    return {};
  }
}

// ---------------------------------------------------------------------------
// Codex (TOML, append-only)
// ---------------------------------------------------------------------------

function writeCodex(
  file: string,
  serverName: string,
  env: Record<string, string> | undefined,
  notes: string[],
): ConnectResult["action"] {
  const existing = safeExists(file) ? readFileSync(file, "utf-8") : "";
  const header = `[mcp_servers.${serverName}]`;
  const present = new RegExp(
    `^\\s*\\[mcp_servers\\.${escapeRegExp(serverName)}\\]`,
    "m",
  ).test(existing);

  if (present) {
    notes.push(
      `${header} already exists — left it untouched. Edit ${file} by hand to change it.`,
    );
    return "unchanged";
  }

  const lines = [
    header,
    'command = "npx"',
    'args = ["-y", "trippy-mcp", "serve"]',
    ...(env
      ? [
          `env = { ${Object.entries(env)
            .map(([k, v]) => `${k} = ${tomlString(v)}`)
            .join(", ")} }`,
        ]
      : []),
  ];
  const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileAtomic(file, `${existing}${separator}${lines.join("\n")}\n`, {
    defaultMode: 0o600,
    forceMode: env ? 0o600 : undefined,
  });
  return "created";
}

function tomlString(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

function writeFileAtomic(
  file: string,
  contents: string,
  opts: { defaultMode: number; forceMode?: number },
): void {
  mkdirSync(dirname(file), { recursive: true });

  let mode = opts.defaultMode;
  if (safeExists(file)) {
    try {
      mode = statSync(file).mode & 0o777;
    } catch {
      // keep the default
    }
    // ~/.claude.json is the whole Claude Code profile. Keep a copy.
    copyFileSync(file, `${file}.trippy-bak`);
  }
  if (opts.forceMode !== undefined) mode = opts.forceMode;

  const tmp = `${file}.trippy-tmp`;
  writeFileSync(tmp, contents, { mode });
  renameSync(tmp, file);
}

/** Key-order-insensitive compare, so a re-run reports `unchanged` honestly. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
