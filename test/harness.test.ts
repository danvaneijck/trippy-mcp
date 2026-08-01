import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { connect, detectClients, targetFile } from "../src/cli/harness.js";

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "trippy-harness-"));
}

const BASE = { serverName: "trippy", scope: "user" as const };
const PASS = { TRIPPY_MCP_PASSPHRASE: "hunter2" };

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf-8"));
}

describe("targetFile", () => {
  it("uses .mcp.json for Claude Code project scope, not .claude/settings.json", () => {
    expect(targetFile("claude", "project", "/home/x", "/repo")).toBe("/repo/.mcp.json");
    expect(targetFile("claude", "user", "/home/x", "/repo")).toBe("/home/x/.claude.json");
  });

  it("maps the other clients to their real config paths", () => {
    expect(targetFile("cursor", "user", "/home/x", "/repo")).toBe("/home/x/.cursor/mcp.json");
    expect(targetFile("cursor", "project", "/home/x", "/repo")).toBe("/repo/.cursor/mcp.json");
    expect(targetFile("codex", "user", "/home/x", "/repo")).toBe("/home/x/.codex/config.toml");
    expect(targetFile("windsurf", "user", "/home/x", "/repo")).toBe(
      "/home/x/.codeium/windsurf/mcp_config.json",
    );
  });
});

describe("detectClients", () => {
  it("finds only what exists", () => {
    const home = fakeHome();
    expect(detectClients(home)).toEqual([]);
    writeFileSync(join(home, ".claude.json"), "{}");
    mkdirSync(join(home, ".codex"), { recursive: true });
    expect(detectClients(home).sort()).toEqual(["claude", "codex"]);
  });
});

describe("connect — JSON clients", () => {
  it("creates the entry and reports created/unchanged/updated honestly", () => {
    const home = fakeHome();
    const opts = { ...BASE, clients: ["claude" as const], home, cwd: home };

    const first = connect(opts)[0]!;
    expect(first.action).toBe("created");
    expect(readJson(first.file).mcpServers.trippy).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "trippy-mcp", "serve"],
    });

    expect(connect(opts)[0]!.action).toBe("unchanged");
    expect(connect({ ...opts, env: PASS })[0]!.action).toBe("updated");
  });

  it("preserves unrelated state in ~/.claude.json and leaves a backup", () => {
    const home = fakeHome();
    const file = join(home, ".claude.json");
    writeFileSync(
      file,
      JSON.stringify({ projects: { "/repo": { history: [1, 2] } }, mcpServers: { other: {} } }),
    );

    connect({ ...BASE, clients: ["claude"], home, cwd: home });

    const after = readJson(file);
    expect(after.projects).toEqual({ "/repo": { history: [1, 2] } });
    expect(after.mcpServers.other).toEqual({});
    expect(after.mcpServers.trippy.command).toBe("npx");
    expect(readJson(`${file}.trippy-bak`).mcpServers.other).toEqual({});
    expect(existsSync(`${file}.trippy-tmp`)).toBe(false);
  });

  it("refuses to clobber a config file it cannot parse", () => {
    const home = fakeHome();
    writeFileSync(join(home, ".claude.json"), "{ half a file");
    expect(() => connect({ ...BASE, clients: ["claude"], home, cwd: home })).toThrow(
      /not valid JSON/,
    );
  });

  it("honours a custom server name", () => {
    const home = fakeHome();
    const r = connect({ ...BASE, serverName: "trippy-testnet", clients: ["cursor"], home, cwd: home })[0]!;
    expect(Object.keys(readJson(r.file).mcpServers)).toEqual(["trippy-testnet"]);
  });
});

describe("connect — secret handling", () => {
  it("embeds the passphrase in user scope and locks the file to 0600", () => {
    const home = fakeHome();
    const r = connect({ ...BASE, clients: ["claude"], env: PASS, home, cwd: home })[0]!;
    expect(r.envEmbedded).toBe(true);
    expect(readJson(r.file).mcpServers.trippy.env).toEqual(PASS);
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
  });

  it("keeps the passphrase out of project files, which get committed", () => {
    const home = fakeHome();
    const r = connect({
      ...BASE,
      scope: "project",
      clients: ["claude"],
      env: PASS,
      home,
      cwd: home,
    })[0]!;
    expect(r.file).toBe(join(home, ".mcp.json"));
    expect(r.envEmbedded).toBe(false);
    expect(readJson(r.file).mcpServers.trippy.env).toBeUndefined();
    expect(r.notes.join(" ")).toMatch(/committed to git/);
  });

  it("redirects project scope to the user file where the client has no project config", () => {
    const home = fakeHome();
    for (const client of ["codex", "windsurf"] as const) {
      const r = connect({ ...BASE, scope: "project", clients: [client], home, cwd: home })[0]!;
      expect(r.file).toBe(targetFile(client, "user", home, home));
      expect(r.notes.join(" ")).toMatch(/no per-project MCP config/);
    }
  });
});

describe("connect — Codex TOML", () => {
  it("appends a block without disturbing existing content", () => {
    const home = fakeHome();
    const file = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(file, '# my notes\nmodel = "gpt-5"\n');

    const r = connect({ ...BASE, clients: ["codex"], env: PASS, home, cwd: home })[0]!;
    const text = readFileSync(file, "utf-8");
    expect(r.action).toBe("created");
    expect(text).toContain("# my notes");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain("[mcp_servers.trippy]");
    expect(text).toContain('args = ["-y", "trippy-mcp", "serve"]');
    expect(text).toContain('env = { TRIPPY_MCP_PASSPHRASE = "hunter2" }');
  });

  it("never rewrites an entry the user already has", () => {
    const home = fakeHome();
    const opts = { ...BASE, clients: ["codex" as const], home, cwd: home };
    connect(opts);
    const again = connect(opts)[0]!;
    expect(again.action).toBe("unchanged");
    expect(again.notes.join(" ")).toMatch(/already exists/);
    expect(readFileSync(again.file, "utf-8").match(/\[mcp_servers\.trippy\]/g)).toHaveLength(1);
  });

  it("escapes quotes in an embedded passphrase", () => {
    const home = fakeHome();
    const r = connect({
      ...BASE,
      clients: ["codex"],
      env: { TRIPPY_MCP_PASSPHRASE: 'a"b\\c' },
      home,
      cwd: home,
    })[0]!;
    expect(readFileSync(r.file, "utf-8")).toContain('TRIPPY_MCP_PASSPHRASE = "a\\"b\\\\c"');
  });
});
