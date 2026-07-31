import { mkdtempSync } from "node:fs";
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
