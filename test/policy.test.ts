import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { PolicySchema } from "../src/config.js";
import { PolicyError } from "../src/errors.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { SpendLedger } from "../src/policy/spend.js";

const CORE = "0xebf62508f322137ee0986935ee3b4a60a3f0d227";
const OWNER = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";

function makeEngine(overrides: Partial<ReturnType<typeof PolicySchema.parse>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trippy-mcp-test-"));
  const ledger = new SpendLedger(dir);
  const cfg = PolicySchema.parse({ perTxCapUsd: 100, dailyBudgetUsd: 250, ...overrides });
  return { engine: new PolicyEngine(cfg, new Set([CORE]), OWNER, ledger), ledger };
}

describe("PolicyEngine", () => {
  let engine: PolicyEngine;
  let ledger: SpendLedger;
  beforeEach(() => {
    ({ engine, ledger } = makeEngine());
  });

  it("allows an in-cap trade to an allowlisted target", () => {
    expect(() =>
      engine.enforce({ kind: "trade", target: CORE, detail: "t", spendUsd: 50 }),
    ).not.toThrow();
  });

  it("rejects writes to unlisted targets", () => {
    expect(() =>
      engine.enforce({ kind: "trade", target: STRANGER, detail: "t", spendUsd: 1 }),
    ).toThrow(PolicyError);
  });

  it("rejects spends over the per-tx cap", () => {
    expect(() =>
      engine.enforce({ kind: "trade", target: CORE, detail: "t", spendUsd: 101 }),
    ).toThrow(/per-tx cap/);
  });

  it("rejects when the 24h budget would be exceeded", () => {
    ledger.record(200, "prior");
    expect(() =>
      engine.enforce({ kind: "trade", target: CORE, detail: "t", spendUsd: 60 }),
    ).toThrow(/24h budget/);
  });

  it("refuses unpriced spend by default, allows with the flag", () => {
    expect(() =>
      engine.enforce({ kind: "swap", target: CORE, detail: "s", spendUsd: null }),
    ).toThrow(/cannot price/);
    const { engine: loose } = makeEngine({ allowUnpricedSpend: true });
    expect(() =>
      loose.enforce({ kind: "swap", target: CORE, detail: "s", spendUsd: null }),
    ).not.toThrow();
  });

  it("blocks trades when tradingEnabled=false but still allows claims and sweeps", () => {
    const { engine: killed } = makeEngine({ tradingEnabled: false });
    expect(() =>
      killed.enforce({ kind: "trade", target: CORE, detail: "t", spendUsd: 1 }),
    ).toThrow(/disabled/);
    expect(() => killed.enforce({ kind: "claim", target: CORE, detail: "c" })).not.toThrow();
    expect(() => killed.enforce({ kind: "sweep", target: OWNER, detail: "s" })).not.toThrow();
  });

  it("sweeps only to the owner destination", () => {
    expect(() => engine.enforce({ kind: "sweep", target: OWNER, detail: "s" })).not.toThrow();
    expect(() => engine.enforce({ kind: "sweep", target: STRANGER, detail: "s" })).toThrow(
      /owner address/,
    );
  });

  it("approvals are target-checked (spender), not capped", () => {
    expect(() => engine.enforce({ kind: "approve", target: CORE, detail: "a" })).not.toThrow();
    expect(() => engine.enforce({ kind: "approve", target: STRANGER, detail: "a" })).toThrow(
      PolicyError,
    );
  });

  it("clamps slippage to the policy ceiling", () => {
    expect(engine.clampSlippageBps(50)).toBe(50);
    expect(engine.clampSlippageBps(5000)).toBe(300); // default maxSlippageBps
    expect(engine.clampSlippageBps(0)).toBe(1);
    expect(engine.clampSlippageBps(undefined)).toBe(100);
  });

  it("records spend and reports remaining budget", () => {
    engine.recordSpend({ kind: "trade", target: CORE, detail: "t", spendUsd: 40 });
    expect(engine.remainingDailyUsd()).toBe(210);
  });
});

describe("unpriced spends still consume the 24h budget", () => {
  // `allowUnpricedSpend` let a spend of unknown USD through AND recorded
  // nothing, so the budget counted only the trades it could price — an agent
  // could push out unlimited value in tokens with no feed while policy.ts
  // called the budget "the real bound".
  const unpriced = { kind: "swap" as const, target: CORE, detail: "swap x", spendUsd: null };

  it("charges an unpriced spend at the per-tx cap", () => {
    const { engine, ledger } = makeEngine({ allowUnpricedSpend: true });
    engine.enforce(unpriced);
    engine.recordSpend(unpriced);
    expect(ledger.spent()).toBe(100);
  });

  it("refuses once unpriced spends have exhausted the budget", () => {
    const { engine } = makeEngine({ allowUnpricedSpend: true });
    for (let i = 0; i < 2; i += 1) {
      engine.enforce(unpriced);
      engine.recordSpend(unpriced);
    }
    // 2 x $100 assumed against a $250 budget leaves $50 < the $100 assumption.
    expect(() => engine.enforce(unpriced)).toThrow(PolicyError);
  });

  it("does not charge a claim, which spends nothing at all", () => {
    // `undefined` is "no spend"; only `null` is "spend of unknown value".
    const { engine, ledger } = makeEngine({ allowUnpricedSpend: true });
    engine.recordSpend({ kind: "claim", target: CORE, detail: "claim fees" });
    expect(ledger.spent()).toBe(0);
  });

  it("still refuses an unpriced spend when the operator has not opted in", () => {
    const { engine } = makeEngine();
    expect(() => engine.enforce(unpriced)).toThrow(PolicyError);
  });
});

describe("SpendLedger durability", () => {
  it("refuses to enforce against an unreadable ledger instead of reading it as $0 spent", () => {
    // Returning [] on a parse failure silently handed back the full 24h budget
    // to an agent that had already spent it — fail-open on the one bound that
    // is supposed to hold.
    const dir = mkdtempSync(join(tmpdir(), "trippy-mcp-test-"));
    const ledger = new SpendLedger(dir);
    ledger.record(200, "earlier spend");
    writeFileSync(join(dir, "spend.json"), "{ this is not json");
    expect(() => ledger.spent()).toThrow(PolicyError);
  });

  it("ignores malformed entries inside an otherwise valid ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "trippy-mcp-test-"));
    writeFileSync(
      join(dir, "spend.json"),
      JSON.stringify({ entries: [{ t: Date.now(), usd: 5, detail: "ok" }, null, { usd: 9 }] }),
    );
    expect(new SpendLedger(dir).spent()).toBe(5);
  });
});
