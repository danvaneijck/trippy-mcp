import { afterEach, describe, expect, it, vi } from "vitest";

import { ChoiceApi } from "../src/api/choice.js";
import { ChoiceV2Api } from "../src/api/choiceV2.js";
import { CLIENT_ID, apiFetch } from "../src/api/http.js";
import { PumpApi } from "../src/api/pump.js";
import { PKG_VERSION } from "../src/version.js";

/** Records every request and answers `body` with a 200. */
function recordFetch(body: unknown) {
  const seen: Array<{ url: string; headers: Headers; method: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    seen.push({ url: String(url), headers: new Headers(init.headers), method: init.method ?? "GET" });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("our apis are called with X-Client (the 2026-10-14 api gate)", () => {
  it("apiFetch names the client and keeps the caller's own headers", async () => {
    const seen = recordFetch({});
    await apiFetch("https://example.test/x", { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(CLIENT_ID).toBe(`trippy-mcp/${PKG_VERSION}`);
    expect(seen[0]!.headers.get("x-client")).toBe(CLIENT_ID);
    expect(seen[0]!.headers.get("user-agent")).toBe(CLIENT_ID);
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.method).toBe("POST");
  });

  it("the pad, Choice v1 and Choice v2 clients all send it", async () => {
    const seen = recordFetch({ data: [], pools: [], summary: {}, execute: {} });
    await new PumpApi("https://pump-api.example").profile("0xABC").catch(() => undefined);
    await new ChoiceApi("https://api.choice.example").quote("inj", "usdt", "1", 0.5).catch(() => undefined);
    await new ChoiceV2Api("https://evm-api.choice.example").pools("inj").catch(() => undefined);
    expect(seen.map((s) => new URL(s.url).host)).toEqual([
      "pump-api.example",
      "api.choice.example",
      "evm-api.choice.example",
    ]);
    for (const s of seen) expect(s.headers.get("x-client")).toBe(CLIENT_ID);
  });
});
