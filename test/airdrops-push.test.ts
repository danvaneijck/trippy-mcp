import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  chunk,
  clearCheckpoint,
  loadCheckpoint,
  recordChunkPaid,
  recordFailure,
} from "../src/airdrops/checkpoint.js";
import { PolicySchema } from "../src/config.js";
import { PolicyError, ToolError } from "../src/errors.js";
import { PolicyEngine } from "../src/policy/policy.js";
import {
  isPreBroadcastRejection,
  MAX_PUSH_RECIPIENTS,
  PUSH_CHUNK_SIZE,
  verdictFrom,
  type PendingAttempt,
} from "../src/airdrops/push.js";
import { BANK_MULTISEND_TARGET } from "../src/chain/cosmos.js";

const home = (): string => mkdtempSync(join(tmpdir(), "push-"));
const PLAN = "a".repeat(32);
const base = { planId: PLAN, sender: "inj1sender", denom: "inj", total: 3 };

describe("push checkpoint", () => {
  it("records a paid chunk as a SET, so a reordered plan still resumes correctly", () => {
    const h = home();
    recordChunkPaid(h, base, ["inj1a", "inj1b"], "0xhash");
    const cp = loadCheckpoint(h, PLAN)!;
    expect(new Set(cp.paid)).toEqual(new Set(["inj1a", "inj1b"]));
    expect(cp.txHashes).toEqual(["0xhash"]);

    // A second chunk merges rather than replaces, and a repeat never duplicates.
    recordChunkPaid(h, base, ["inj1b", "inj1c"], "0xhash2");
    const after = loadCheckpoint(h, PLAN)!;
    expect(new Set(after.paid)).toEqual(new Set(["inj1a", "inj1b", "inj1c"]));
    expect(after.txHashes).toEqual(["0xhash", "0xhash2"]);
  });

  it("records a chunk confirmed WITHOUT a tx hash — landed is landed", () => {
    // The "it threw but it landed" path. Losing the hash and losing the money
    // are entirely different facts, and only one of them is true here.
    const h = home();
    recordChunkPaid(h, base, ["inj1a"], null);
    const cp = loadCheckpoint(h, PLAN)!;
    expect(cp.paid).toEqual(["inj1a"]);
    expect(cp.txHashes).toEqual([]);
  });

  it("records an unsendable address once, with its reason", () => {
    const h = home();
    recordFailure(h, base, "inj1module", "is not allowed to receive funds");
    recordFailure(h, base, "inj1module", "again");
    const cp = loadCheckpoint(h, PLAN)!;
    expect(cp.failed).toHaveLength(1);
    expect(cp.failed[0]!.reason).toMatch(/not allowed/);
  });

  it("survives a missing or cleared checkpoint", () => {
    const h = home();
    expect(loadCheckpoint(h, PLAN)).toBeNull();
    recordChunkPaid(h, base, ["inj1a"], null);
    clearCheckpoint(h, PLAN);
    expect(loadCheckpoint(h, PLAN)).toBeNull();
  });

  it("chunks preserve order and cover everything", () => {
    const rows = Array.from({ length: 7 }, (_, i) => i);
    expect(chunk(rows, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(chunk(rows, 100)).toEqual([rows]);
    expect(chunk([], 10)).toEqual([]);
  });
});

describe("did it land — the question a throw does not answer", () => {
  const attempt = (over: Partial<PendingAttempt> = {}): PendingAttempt => ({
    addresses: ["inj1a", "inj1b"],
    probe: "inj1a",
    probeBalanceBefore: "100",
    probeExpected: "25",
    sequenceBefore: 41,
    at: new Date().toISOString(),
    ...over,
  });

  it("a probe balance that rose by the expected amount means it LANDED", () => {
    expect(verdictFrom(attempt(), { sequence: 42, probeBalance: 125n }, 0)).toBe("landed");
    // More than expected still means landed — someone else paying them too does
    // not un-pay them, and the bias has to point away from double-sending.
    expect(verdictFrom(attempt(), { sequence: 42, probeBalance: 900n }, 0)).toBe("landed");
  });

  it("a sequence past ours with no balance change means it can NEVER land", () => {
    // A transaction is valid at exactly one sequence. Once the account has
    // moved past it, resending is safe — this is the only rigorous signal here.
    expect(verdictFrom(attempt(), { sequence: 42, probeBalance: 100n }, 0)).toBe("did_not_land");
  });

  it("an unmoved sequence is UNRESOLVED — it may still be in the mempool", () => {
    expect(verdictFrom(attempt(), { sequence: 41, probeBalance: 100n }, 0)).toBe("unresolved");
    // ...and stays unresolved when the chain cannot be read at all, rather than
    // defaulting to the answer that resends.
    expect(verdictFrom(attempt(), { sequence: null, probeBalance: null }, 0)).toBe("unresolved");
  });

  it("gives up on an unmoved sequence only after the stale window", () => {
    const old = 11 * 60 * 1000;
    expect(verdictFrom(attempt(), { sequence: 41, probeBalance: 100n }, old)).toBe("did_not_land");
    expect(verdictFrom(attempt(), { sequence: 41, probeBalance: 100n }, 60_000)).toBe("unresolved");
  });

  it("a landing beats a stale window — the balance is checked first", () => {
    expect(verdictFrom(attempt(), { sequence: 41, probeBalance: 125n }, 1e9)).toBe("landed");
  });
});

describe("a rejected simulation is not an uncertain send", () => {
  it("is recognised by its own code, so the group is bisected instead of stalling", () => {
    // The common failure is one bank-blocked recipient, which is refused during
    // SIMULATION — nothing signed, no sequence used. From the outside that looks
    // exactly like a transaction pending in the mempool, and treating it as one
    // would stop the whole run instead of routing around the bad address.
    expect(isPreBroadcastRejection(new ToolError("simulate_rejected", "blocked"))).toBe(true);
    expect(isPreBroadcastRejection(new ToolError("broadcast_failed", "timeout"))).toBe(false);
    expect(isPreBroadcastRejection(new Error("socket hang up"))).toBe(false);
    expect(isPreBroadcastRejection(undefined)).toBe(false);
  });
});

describe("push sizing", () => {
  it("one campaign is one transaction, because the cap is enforced per transaction", () => {
    // If a push drop spanned two txs, each would be capped on its own and a
    // drop worth 2x airdropCapUsd would go through as two legal halves.
    expect(PUSH_CHUNK_SIZE).toBe(MAX_PUSH_RECIPIENTS);
  });
});

describe("push policy", () => {
  const engine = (over: Record<string, unknown> = {}) =>
    new PolicyEngine(
      PolicySchema.parse(over),
      new Set([BANK_MULTISEND_TARGET]),
      "0xowner",
      { spent: () => 0, record: () => {} } as never,
    );

  const intent = (spendUsd: number | null) => ({
    kind: "airdrop" as const,
    target: BANK_MULTISEND_TARGET,
    detail: "push drop",
    spendUsd,
  });

  it("the bank target is on the allowlist and still governed by airdropCapUsd", () => {
    expect(() => engine().enforce(intent(999))).not.toThrow();
    expect(() => engine({ airdropCapUsd: 100 }).enforce(intent(101))).toThrow(/per-campaign cap/);
    expect(() => engine({ airdropCapUsd: 0 }).enforce(intent(1))).toThrow(/disabled by policy/);
  });

  it("a cap denial is a PolicyError, which the send loop must never bisect", () => {
    // Bisecting a cap denial would halve the group until each piece fit under
    // the cap, i.e. spend straight through it. push.ts rethrows PolicyError
    // before the retry/bisect path; this pins the type that check relies on.
    let thrown: unknown;
    try {
      engine({ airdropCapUsd: 10 }).enforce(intent(50));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PolicyError);
  });

  it("an unpriceable push is refused, allowUnpricedSpend or not", () => {
    expect(() => engine({ allowUnpricedSpend: true }).enforce(intent(null))).toThrow(
      /cannot price/,
    );
  });
});
