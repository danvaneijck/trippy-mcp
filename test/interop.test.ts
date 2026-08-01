import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectAinj } from "../src/interop.js";
import { toolName, toolPrefix } from "../src/mcp/naming.js";

const ADDR_A = "inj1lr5qnxn8qem0psflh8we7cdeyecutenzgcxjjg";
const ADDR_B = "inj19tynv2ufr2e6p5nn909z8rzp2apl3nj5zqseqj";

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "trippy-interop-"));
}

function withAinjKeys(home: string, files: Record<string, unknown>): void {
  const dir = join(home, ".injective-agent", "keys");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  }
}

describe("detectAinj", () => {
  it("returns null on a machine with no Injective SDK install", () => {
    expect(detectAinj({ home: fakeHome() })).toBeNull();
  });

  it("reads addresses from keystore filenames", () => {
    const home = fakeHome();
    withAinjKeys(home, {
      [`${ADDR_A}.json`]: { address: ADDR_A, salt: "aa", ciphertext: "bb" },
      "notes.txt": "ignored",
    });
    const found = detectAinj({ home });
    expect(found?.wallets).toEqual([ADDR_A]);
    expect(found?.truncated).toBe(false);
    expect(found?.keystoreDir).toBe(join(home, ".injective-agent", "keys"));
  });

  it("falls back to the address field when the file was renamed", () => {
    const home = fakeHome();
    withAinjKeys(home, { "backup-copy.json": { address: ADDR_B } });
    expect(detectAinj({ home })?.wallets).toEqual([ADDR_B]);
  });

  it("survives unreadable and malformed key files", () => {
    const home = fakeHome();
    withAinjKeys(home, {
      "broken.json": "{ not json",
      "empty.json": {},
      "wrong-shape.json": { address: 42 },
      [`${ADDR_A}.json`]: { address: ADDR_A },
    });
    expect(detectAinj({ home })?.wallets).toEqual([ADDR_A]);
  });

  it("detects an `ainj install` with no wallets yet", () => {
    const home = fakeHome();
    mkdirSync(join(home, ".ainj"), { recursive: true });
    writeFileSync(join(home, ".ainj", "config.json"), "{}");
    const found = detectAinj({ home });
    expect(found?.sdkConfigured).toBe(true);
    expect(found?.wallets).toEqual([]);
    expect(found?.keystoreDir).toBeNull();
  });

  it("names this agent's address in the note so the two never get confused", () => {
    const home = fakeHome();
    withAinjKeys(home, { [`${ADDR_A}.json`]: { address: ADDR_A } });
    const note = detectAinj({ home, injAddress: ADDR_B })!.note;
    expect(note).toContain(ADDR_B);
    expect(note).toContain("sweep");
  });
});

describe("toolPrefix", () => {
  it("is off by default", () => {
    expect(toolPrefix({})).toBe("");
    expect(toolName("buy", {})).toBe("buy");
  });

  it("appends a single separating underscore", () => {
    expect(toolName("buy", { TRIPPY_MCP_TOOL_PREFIX: "trippy" })).toBe("trippy_buy");
    expect(toolName("buy", { TRIPPY_MCP_TOOL_PREFIX: "trippy_" })).toBe("trippy_buy");
    expect(toolName("buy", { TRIPPY_MCP_TOOL_PREFIX: "  TRIPPY  " })).toBe("trippy_buy");
  });

  it("sanitizes characters MCP tool names cannot carry", () => {
    expect(toolName("buy", { TRIPPY_MCP_TOOL_PREFIX: "my trippy!" })).toBe("my_trippy_buy");
    expect(toolName("buy", { TRIPPY_MCP_TOOL_PREFIX: "--" })).toBe("buy");
    expect(toolName("buy", { TRIPPY_MCP_TOOL_PREFIX: "" })).toBe("buy");
  });

  it("caps runaway prefixes", () => {
    expect(toolPrefix({ TRIPPY_MCP_TOOL_PREFIX: "a".repeat(80) })).toBe(`${"a".repeat(24)}_`);
  });
});
