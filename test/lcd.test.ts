import { afterEach, describe, expect, it, vi } from "vitest";

import { denomDecimals } from "../src/api/lcd.js";

/** Each test gets its own LCD: the catalogue is cached per network, by design. */
let seq = 0;
const nextLcd = () => `https://lcd.test.${(seq += 1)}`;
const realFetch = globalThis.fetch;

/**
 * The shape that produced the bug: Injective's gateway serves
 * `denoms_metadata/{denom}` only when the denom is ONE path segment, so
 * `factory/…` and `ibc/…` — which percent-decode back into separators — answer
 * 501, while the list endpoint serves everything.
 */
function injectiveLcd(catalogue: Record<string, number>, opts: { listFails?: boolean } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const single = /denoms_metadata\/(.+)$/.exec(url);
    if (single) {
      const denom = decodeURIComponent(single[1]!);
      if (denom.includes("/")) {
        return new Response(JSON.stringify({ code: 12, message: "Not Implemented" }), { status: 501 });
      }
      const dec = catalogue[denom];
      if (dec === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ metadata: { base: denom, decimals: dec } }), { status: 200 });
    }
    if (opts.listFails) return new Response("boom", { status: 500 });
    return new Response(
      JSON.stringify({
        metadatas: Object.entries(catalogue).map(([base, decimals]) => ({ base, decimals })),
        pagination: { next_key: null },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("denomDecimals", () => {
  it("reads a slashed denom off the list endpoint instead of answering 18", async () => {
    const LCD = nextLcd();
    // The whole bug in one assertion: the per-denom route 501s for `factory/…`,
    // and the old code took that as "assume 18". QUNT is 6, so `sell all` used
    // to offer a trillionth of the position.
    injectiveLcd({ "factory/inj127l5a2/qunt": 6 });
    expect(await denomDecimals(LCD, "factory/inj127l5a2/qunt")).toBe(6);
  });

  it("still uses the cheap per-denom route for an unslashed denom", async () => {
    const LCD = nextLcd();
    const calls = injectiveLcd({ peggy0xdAC17: 6 });
    expect(await denomDecimals(LCD, "peggy0xdAC17")).toBe(6);
    expect(calls.every((u) => u.includes("denoms_metadata/"))).toBe(true);
    expect(calls.some((u) => u.includes("pagination.limit"))).toBe(false);
  });

  it("never spends a request confirming a slashed denom will 501", async () => {
    const LCD = nextLcd();
    const calls = injectiveLcd({ "factory/inj1skip/tok": 9 });
    await denomDecimals(LCD, "factory/inj1skip/tok");
    expect(calls.some((u) => /denoms_metadata\/factory/.test(u))).toBe(false);
  });

  it("answers null — not 18 — for a denom the chain says nothing about", async () => {
    const LCD = nextLcd();
    injectiveLcd({ "factory/inj1nul/known": 6 });
    expect(await denomDecimals(LCD, "factory/inj1nul/unknown")).toBeNull();
  });

  it("treats a placeholder `decimals: 0` entry as unknown rather than 0", async () => {
    const LCD = nextLcd();
    // Guessing 18 under-reports by 1e12; guessing 0 OVER-reports by 1e18, and
    // only one of those can overdraw a wallet.
    injectiveLcd({ "ibc/4971C5": 0 });
    expect(await denomDecimals(LCD, "ibc/4971C5")).toBeNull();
  });

  it("hardcodes inj without any network call", async () => {
    const LCD = nextLcd();
    const calls = injectiveLcd({});
    expect(await denomDecimals(LCD, "inj")).toBe(18);
    expect(calls).toHaveLength(0);
  });

  it("fetches the catalogue once across many slashed denoms", async () => {
    const LCD = nextLcd();
    const calls = injectiveLcd({ "factory/inj1once/one": 6, "factory/inj1once/two": 9 });
    await denomDecimals(LCD, "factory/inj1once/one");
    await denomDecimals(LCD, "factory/inj1once/two");
    await denomDecimals(LCD, "factory/inj1once/one");
    expect(calls.filter((u) => u.includes("pagination.limit"))).toHaveLength(1);
  });

  it("does not cache a transient failure as a permanent unknown", async () => {
    const LCD = nextLcd();
    injectiveLcd({ "factory/inj1flap/tok": 6 }, { listFails: true });
    expect(await denomDecimals(LCD, "factory/inj1flap/tok")).toBeNull();
    // Endpoint recovers — the next call must go back out rather than reuse null.
    injectiveLcd({ "factory/inj1flap/tok": 6 });
    expect(await denomDecimals(LCD, "factory/inj1flap/tok")).toBe(6);
  });

  it("keeps networks apart — testnet decimals never answer for mainnet", async () => {
    injectiveLcd({ "factory/inj1net/tok": 6 });
    expect(await denomDecimals("https://lcd.mainnet", "factory/inj1net/tok")).toBe(6);
    injectiveLcd({ "factory/inj1net/tok": 18 });
    expect(await denomDecimals("https://lcd.testnet", "factory/inj1net/tok")).toBe(18);
  });
});
