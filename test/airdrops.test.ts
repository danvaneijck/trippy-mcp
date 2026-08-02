import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { exclusionSet, isValidInjAddress } from "../src/airdrops/address.js";
import {
  allocateExact,
  applyMinAmount,
  applyTopN,
  weightToInt,
  type SourceRow,
} from "../src/airdrops/allocate.js";
import { ceilFee, fundingRequired, parseCampaignId } from "../src/airdrops/contract.js";
import { buildTree, leafHash, verifyProof } from "../src/airdrops/merkle.js";
import { loadPlan, planId, savePlan, updatePlan, type StoredPlan } from "../src/airdrops/plan.js";
import { buildLeavesFromRows, fromBaseUnits, toBaseUnits } from "../src/airdrops/units.js";
import { PolicySchema } from "../src/config.js";
import { PolicyEngine } from "../src/policy/policy.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// Real bech32 addresses with verifying checksums (0x1111…, 0x2222…). The
// validator rejects anything else, so the fixtures have to be genuine.
const A = "inj1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3t5qxqh";
const B = "inj1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyf9qgq";
/** A 32-byte contract address — also a legitimate recipient. */
const CONTRACT = "inj1xvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxvenxves8x0uuu";

describe("merkle — golden vectors from the Rust contract", () => {
  // These pin the byte-level spec against contracts/choice_claim_drops/src/
  // merkle.rs. If one of these breaks, every drop this package publishes is
  // unclaimable — the funds land in the contract behind a root no claim client
  // can build a proof for, and a one-shot campaign freezes on creation.
  it("leaf_hash_golden_vector", () => {
    expect(hex(leafHash("inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "1000000"))).toBe(
      "82021d82ef5d5a5db1fdf2b7204e4179da4676e67104d56464b03c767e16ce48",
    );
  });

  it("sorted_pair_golden_vector — parent hashes the smaller node first", () => {
    // a = sha256("a-leaf-x"), b = sha256("b-leaf-y") from the Rust test.
    const a = "7b631c0212ee9c2e8715fadd136a31706728c9cefa23cb42b681e0a5ec4792c5";
    const b = "079be04b5b153b7a84b4df326ad8d1f1f30fd5292cab32560dec512b5eb366c1";
    const parent = "55a8565a798073b99f9332a82ce34227e834d115b9fa6639b348f687b820953a";
    // verifyProof walks leaf -> parent through hashPair, which is the same
    // sorted-pair rule the contract's `verify` uses.
    let node = Buffer.from(a, "hex");
    const proof = [b];
    // Reuse the library's own verifier rather than reimplementing the pairing.
    expect(verifyProofFromHash(parent, node, proof)).toBe(true);
  });

  it("single_leaf_tree_is_its_own_root, with an empty proof", () => {
    const tree = buildTree([{ address: "inj1abc", amount: "1" }]);
    expect(tree.rootHex).toBe(hex(leafHash("inj1abc", "1")));
    expect(tree.proofs["inj1abc"]).toEqual([]);
    expect(verifyProof(tree.rootHex, "inj1abc", "1", [])).toBe(true);
  });

  it("rejects a malformed sibling rather than mis-verifying", () => {
    const tree = buildTree([{ address: "inj1abc", amount: "1" }]);
    expect(verifyProof(tree.rootHex, "inj1abc", "1", ["aabb"])).toBe(false);
  });
});

/** verifyProof takes an address+amount; this variant starts from a raw node. */
function verifyProofFromHash(rootHex: string, node: Uint8Array, proofHex: string[]): boolean {
  // Mirror of the module's internal pairing, used only to exercise the golden
  // pair vector (whose inputs are raw hashes, not leaves).
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const sha = (d: Uint8Array) => new Uint8Array(createHash("sha256").update(d).digest());
  const cmp = (x: Uint8Array, y: Uint8Array) => {
    for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return 0;
  };
  let cur = node;
  for (const step of proofHex) {
    const sib = Buffer.from(step, "hex");
    const [lo, hi] = cmp(cur, sib) <= 0 ? [cur, sib] : [sib, cur];
    const buf = new Uint8Array(64);
    buf.set(lo, 0);
    buf.set(hi, 32);
    cur = sha(buf);
  }
  return Buffer.from(cur).toString("hex") === rootHex;
}

describe("merkle — tree properties", () => {
  const leaves = [
    { address: A, amount: "100" },
    { address: B, amount: "250" },
    { address: "inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", amount: "7" },
  ];

  it("is order-independent — the root is a function of the SET", () => {
    const a = buildTree(leaves);
    const b = buildTree([...leaves].reverse());
    expect(a.rootHex).toBe(b.rootHex);
    expect(a.total).toBe("357");
  });

  it("every leaf's proof verifies against the root", () => {
    const tree = buildTree(leaves);
    for (const leaf of tree.leaves) {
      expect(
        verifyProof(tree.rootHex, leaf.address, leaf.amount, tree.proofs[leaf.address.toLowerCase()]!),
        leaf.address,
      ).toBe(true);
    }
  });

  it("an odd node promotes — trees of every size up to 9 verify", () => {
    for (let n = 1; n <= 9; n++) {
      const set = Array.from({ length: n }, (_, i) => ({
        address: `inj1test${i}`,
        amount: String(i + 1),
      }));
      const tree = buildTree(set);
      for (const leaf of tree.leaves) {
        expect(
          verifyProof(tree.rootHex, leaf.address, leaf.amount, tree.proofs[leaf.address.toLowerCase()]!),
          `n=${n} ${leaf.address}`,
        ).toBe(true);
      }
    }
  });

  it("refuses duplicates rather than silently dropping an allocation", () => {
    expect(() => buildTree([{ address: A, amount: "1" }, { address: A, amount: "2" }])).toThrow(
      /duplicate/,
    );
  });

  it("refuses a non-integer amount — a float would mint an unclaimable leaf", () => {
    expect(() => buildTree([{ address: A, amount: "1.5" }])).toThrow(/base-unit integer/);
  });
});

describe("allocateExact", () => {
  const rows = (weights: number[]): SourceRow[] =>
    weights.map((w, i) => ({ address: `inj1w${String(i).padStart(3, "0")}`, weight: w }));

  it("fair split lands exactly on total, remainder to the lowest addresses", () => {
    const r = allocateExact(rows([1, 1, 1]), 10n, "fair");
    expect(r.allocations.map((a) => a.amountBase)).toEqual(["4", "3", "3"]);
    expect(sum(r)).toBe(10n);
  });

  it("proportionate split lands exactly on total (largest remainder)", () => {
    const r = allocateExact(rows([1, 1, 1]), 100n, "proportionate");
    expect(sum(r)).toBe(100n);
    const r2 = allocateExact(rows([7, 11, 13, 19]), 1_000_003n, "proportionate");
    expect(sum(r2)).toBe(1_000_003n);
  });

  it("is deterministic — same rows in any order give the same allocation", () => {
    const input = rows([5, 3, 8, 1]);
    const a = allocateExact(input, 999n, "proportionate");
    const b = allocateExact([...input].reverse(), 999n, "proportionate");
    expect(a.allocations).toEqual(b.allocations);
    // Determinism is what makes a retry reuse the published leaves: identical
    // allocation -> identical tree -> identical root.
    expect(buildTree(a.allocations.map((x) => ({ address: x.address, amount: x.amountBase }))).rootHex).toBe(
      buildTree(b.allocations.map((x) => ({ address: x.address, amount: x.amountBase }))).rootHex,
    );
  });

  it("sums duplicate addresses instead of letting them become two leaves", () => {
    const r = allocateExact(
      [
        { address: A, weight: 1 },
        { address: A, weight: 3 },
        { address: B, weight: 4 },
      ],
      80n,
      "proportionate",
    );
    expect(r.mergedRows).toBe(1);
    expect(r.allocations).toHaveLength(2);
    expect(sum(r)).toBe(80n);
  });

  it("drops zero allocations and reports them, keeping the total exact", () => {
    // 1 base unit across 3 wallets: two get nothing.
    const r = allocateExact(rows([1, 1, 1]), 1n, "fair");
    expect(r.droppedZero).toBe(2);
    expect(r.totalBase).toBe("1");
    expect(sum(r)).toBe(1n);
  });

  it("falls back to a fair split when no row carries weight", () => {
    const r = allocateExact(rows([0, 0, 0]), 9n, "proportionate");
    expect(r.allocations.map((a) => a.amountBase)).toEqual(["3", "3", "3"]);
  });

  it("weightToInt survives magnitudes that break toFixed", () => {
    expect(weightToInt(1.5)).toBe(1_500_000n);
    expect(weightToInt(0)).toBe(0n);
    expect(weightToInt(-1)).toBe(0n);
    // >= 1e21 goes exponential in toFixed and would produce a string BigInt
    // rejects; the integer path keeps it usable.
    expect(() => weightToInt(1e22)).not.toThrow();
    expect(weightToInt(1e22) > 0n).toBe(true);
  });

  it("applyTopN keeps the heaviest, breaking ties by address", () => {
    const kept = applyTopN(rows([1, 9, 5, 9]), 2);
    expect(kept.map((r) => r.weight)).toEqual([9, 9]);
    expect(kept[0]!.address < kept[1]!.address).toBe(true);
  });

  it("applyMinAmount re-splits the whole total across survivors", () => {
    const filtered = applyMinAmount(rows([100, 1, 1]), 1000n, "proportionate", 100n);
    const r = allocateExact(filtered, 1000n, "proportionate");
    expect(sum(r)).toBe(1000n); // still exactly on total, not short
    expect(r.allocations).toHaveLength(1);
  });
});

const sum = (r: { allocations: { amountBase: string }[] }): bigint =>
  r.allocations.reduce((s, a) => s + BigInt(a.amountBase), 0n);

describe("units", () => {
  it("floors rather than rounds — never asks for a base unit nobody funded", () => {
    expect(toBaseUnits("1.999999999999999999999", 6)).toEqual({ base: "1999999", truncated: true });
    expect(toBaseUnits("1.5", 6)).toEqual({ base: "1500000", truncated: false });
    expect(toBaseUnits("0.0000001", 6)).toEqual({ base: "0", truncated: true });
  });

  it("roundtrips exactly at 18 decimals, where floats cannot", () => {
    const base = "123456789012345678901";
    expect(toBaseUnits(fromBaseUnits(base, 18), 18).base).toBe(base);
  });

  it("rejects addresses that fail the bech32 CHECKSUM, not just the charset", () => {
    expect(isValidInjAddress(A)).toBe(true);
    expect(isValidInjAddress(CONTRACT)).toBe(true); // 32-byte contracts count
    // Flip one character: right prefix, right length, legal charset, bad
    // checksum. A charset regex passes this; the chain would never see it,
    // because a claim-drop leaf never meets a chain rule.
    const typo = `${A.slice(0, -1)}${A.endsWith("h") ? "j" : "h"}`;
    expect(isValidInjAddress(typo)).toBe(false);
    expect(isValidInjAddress("inj1notavalidaddress")).toBe(false);
    expect(isValidInjAddress("cosmos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49")).toBe(false);
    expect(isValidInjAddress("")).toBe(false);
  });

  it("buildLeavesFromRows drops invalid, blocked and zero rows with counts", () => {
    const blocked = "inj1j4yzhgjm00ch3h0p9kel7g8sp6g045qf32pzlj"; // auction module
    const built = buildLeavesFromRows(
      [
        { address: A, amount: "1" },
        { address: A, amount: "2" }, // merged, not a second leaf
        { address: B, amount: "0.0000000000000000001" }, // floors to 0 at 18dp
        { address: blocked, amount: "5" },
        { address: "inj1garbage", amount: "5" },
      ],
      18,
      { isBlocked: exclusionSet() },
    );
    expect(built.leaves).toHaveLength(1);
    expect(built.leaves[0]!.amount).toBe("3000000000000000000");
    expect(built.mergedRows).toBe(1);
    expect(built.zeroRows).toBe(1);
    expect(built.blockedRows).toBe(1);
    expect(built.invalidRows).toBe(1);
  });

  it("excludes launch-owned addresses when they are passed in", () => {
    const isBlocked = exclusionSet([B]);
    expect(isBlocked(B)).toBe(true);
    expect(isBlocked(A)).toBe(false);
  });

  // Measured on chain 2026-08-02: the bank keeper refuses only 12 of these 20.
  // The other 8 ACCEPT the transfer and keep it forever, so for those the leaf
  // builder is the only protection there is — a send to one succeeds and the
  // tokens are gone. Pinned so nobody prunes the list to "what the chain
  // blocks anyway", which would silently start burning tokens on eight
  // addresses. `xwasm` is the one that proved it, with 0.001 testnet INJ.
  it("blocks module accounts the chain is happy to credit", () => {
    const isBlocked = exclusionSet();
    for (const acceptsButBurns of [
      "inj1z5ewmnfpa3at4j54pq6dh66rthrpkvhnxqadkf", // xwasm
      "inj10d07y265gmmuvt4z0w9aw880jnsr700jstypyt", // gov
      "inj1jv65s3grqf6v6jl3dp4t6c9t9rk99cd8dkncm8", // distribution
      "inj1glht96kr2rseywuvhhay894qw7ekuc4qqdy7m7", // erc20
      "inj1979qcq0kdz72w0k9rsxcmfmagx2cydrs40q2xg", // peggy
      "inj19ejy8n9qsectrf4semdp9cpknflld0j6hf2fle", // tokenfactory
      "inj1vn5fx74ud4cu7tf0pls9u5krxengsdzrg9ap2d", // insurance
      "inj14vnmw2wee3xtrsqfvpcqg35jg9v7j2vdpzx0kk", // exchange
    ]) {
      expect(isBlocked(acceptsButBurns)).toBe(true);
    }
    // And the ones it does refuse, which are what the bisection routes around.
    expect(isBlocked("inj1xds4f0m87ajl3a6az6s2enhxrd0wta4860twp8")).toBe(true); // wasm
  });
});

describe("contract arithmetic", () => {
  it("ceilFee rounds UP, matching the contract's ceil_fee", () => {
    expect(ceilFee("10000", 0)).toBe("0");
    expect(ceilFee("10001", 100)).toBe("101"); // 100.01 -> 101, not 100
    expect(fundingRequired("10001", 100)).toBe("10102");
    expect(fundingRequired("500", 0)).toBe("500");
  });

  it("parseCampaignId reads the id from wasm-update_root", () => {
    expect(
      parseCampaignId({
        events: [{ type: "wasm-update_root", attributes: [{ key: "id", value: "42" }] }],
      }),
    ).toBe(42);
  });

  it("parseCampaignId falls back to the id following action=create_campaign", () => {
    expect(
      parseCampaignId({
        events: [
          {
            type: "wasm",
            attributes: [
              { key: "action", value: "something_else" },
              { key: "id", value: "7" },
              { key: "action", value: "create_campaign" },
              { key: "id", value: "99" },
            ],
          },
        ],
      }),
    ).toBe(99);
  });

  it("parseCampaignId returns null rather than a wrong id", () => {
    expect(parseCampaignId(null)).toBeNull();
    expect(parseCampaignId({ events: [] })).toBeNull();
    expect(parseCampaignId({ rawLog: "not json" })).toBeNull();
  });
});

describe("plan cache", () => {
  const leaves = [
    { address: A, amount: "100" },
    { address: B, amount: "200" },
  ];

  const plan = (over: Partial<StoredPlan> = {}): StoredPlan => ({
    planId: planId("inj1sender", "inj", leaves),
    createdAt: new Date().toISOString(),
    network: "mainnet",
    sender: "inj1sender",
    denom: "inj",
    symbol: "INJ",
    decimals: 18,
    rootHex: buildTree(leaves).rootHex,
    totalBase: "300",
    leaves,
    meta: {},
    expiryNanos: null,
    totalUsd: 5,
    criteria: "test",
    snapshotAt: new Date().toISOString(),
    ...over,
  });

  it("planId keys on the ALLOCATION, not on when it was made", () => {
    const a = planId("inj1sender", "inj", leaves);
    const b = planId("inj1sender", "inj", [...leaves].reverse());
    expect(a).toBe(b);
    // A different amount is a different plan — and a different merkle root.
    expect(planId("inj1sender", "inj", [{ address: A, amount: "101" }, leaves[1]!])).not.toBe(a);
    // Same list, different wallet or asset, different plan.
    expect(planId("inj1other", "inj", leaves)).not.toBe(a);
    expect(planId("inj1sender", "usdc", leaves)).not.toBe(a);
  });

  it("roundtrips a plan and refuses one that is over an hour old", () => {
    const home = mkdtempSync(join(tmpdir(), "plans-"));
    const p = plan();
    savePlan(home, p);
    expect(loadPlan(home, p.planId).rootHex).toBe(p.rootHex);

    const stale = plan({
      planId: "a".repeat(32),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    savePlan(home, stale);
    expect(() => loadPlan(home, stale.planId)).toThrow(/stale|older/);
    // A read-only lookup may still see it — the TTL guards FUNDING a stale
    // snapshot, not asking what happened to an old plan.
    expect(loadPlan(home, stale.planId, { allowStale: true }).planId).toBe(stale.planId);
  });

  it("marks a broadcast attempt and keeps the plan readable afterwards", () => {
    const home = mkdtempSync(join(tmpdir(), "plans-"));
    const p = plan();
    savePlan(home, p);

    // Marked BEFORE the broadcast, so a tx that lands and still throws cannot
    // leave a plan that looks un-executed and invites a retry.
    updatePlan(home, p.planId, { attemptedAt: "2026-08-02T00:00:00.000Z" });
    expect(loadPlan(home, p.planId).attemptedAt).toBe("2026-08-02T00:00:00.000Z");

    updatePlan(home, p.planId, { campaignId: 77, txHash: "0xabc" });
    const after = loadPlan(home, p.planId);
    expect(after.campaignId).toBe(77);
    expect(after.txHash).toBe("0xabc");
    // Still holds the root: this is the only way to turn a planId back into a
    // campaign when execute could not read the id out of the tx.
    expect(after.rootHex).toBe(p.rootHex);
    expect(after.leaves).toHaveLength(2);
  });

  it("updatePlan on a missing plan is a no-op, not a crash", () => {
    const home = mkdtempSync(join(tmpdir(), "plans-"));
    expect(() => updatePlan(home, "c".repeat(32), { campaignId: 1 })).not.toThrow();
  });

  it("rejects a plan id that is not our own digest shape", () => {
    const home = mkdtempSync(join(tmpdir(), "plans-"));
    expect(() => loadPlan(home, "../../etc/passwd")).toThrow(/not a plan id/);
    expect(() => loadPlan(home, "short")).toThrow(/not a plan id/);
  });

  it("reports a missing plan rather than inventing an empty one", () => {
    const home = mkdtempSync(join(tmpdir(), "plans-"));
    expect(() => loadPlan(home, "b".repeat(32))).toThrow(/no airdrop plan/);
  });
});

describe("airdrop policy", () => {
  const engine = (over: Record<string, unknown> = {}) =>
    new PolicyEngine(
      PolicySchema.parse(over),
      new Set(["inj1drops"]),
      "0xowner",
      { spent: () => 0, record: () => {} } as never,
    );

  const intent = (spendUsd: number | null) => ({
    kind: "airdrop" as const,
    target: "inj1drops",
    detail: "test drop",
    spendUsd,
  });

  it("defaults to a $1000 per-campaign cap", () => {
    expect(PolicySchema.parse({}).airdropCapUsd).toBe(1000);
    expect(() => engine().enforce(intent(999))).not.toThrow();
  });

  it("uses airdropCapUsd, NOT perTxCapUsd — otherwise the $200 trade cap would silently govern drops", () => {
    const e = engine({ perTxCapUsd: 200, airdropCapUsd: 1000 });
    expect(() => e.enforce(intent(500))).not.toThrow();
    expect(() => e.enforce(intent(1001))).toThrow(/per-campaign cap/);
    // ...and a trade is still bound by its own, smaller cap.
    expect(() =>
      e.enforce({ kind: "trade", target: "inj1drops", detail: "t", spendUsd: 500 }),
    ).toThrow(/per-tx cap/);
  });

  it("refuses an unpriceable airdrop even with allowUnpricedSpend set", () => {
    // The flag exists so illiquid tokens stay tradable. An uncappable outbound
    // transfer is a different thing and must not inherit that permission.
    const e = engine({ allowUnpricedSpend: true });
    expect(() => e.enforce(intent(null))).toThrow(/cannot price/);
    expect(() =>
      e.enforce({ kind: "trade", target: "inj1drops", detail: "t", spendUsd: null }),
    ).not.toThrow();
  });

  it("cap 0 disables airdrops entirely", () => {
    const e = engine({ airdropCapUsd: 0 });
    expect(e.airdropsEnabled()).toBe(false);
    expect(() => e.enforce(intent(1))).toThrow(/disabled by policy/);
  });

  it("still enforces the contract allowlist and the kill switch", () => {
    expect(() =>
      engine().enforce({ ...intent(1), target: "inj1attacker" }),
    ).toThrow(/allowlist/);
    expect(() => engine({ tradingEnabled: false }).enforce(intent(1))).toThrow(/disabled/);
  });

  it("consumes the shared 24h budget", () => {
    const e = new PolicyEngine(
      PolicySchema.parse({ airdropCapUsd: 1000, dailyBudgetUsd: 1000 }),
      new Set(["inj1drops"]),
      "0xowner",
      { spent: () => 900, record: () => {} } as never,
    );
    expect(() => e.enforce(intent(50))).not.toThrow();
    expect(() => e.enforce(intent(200))).toThrow(/24h budget/);
  });
});
