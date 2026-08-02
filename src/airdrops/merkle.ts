/**
 * Merkle tree for the `choice-claim-drops` contract.
 *
 * The hashing MUST match the contract byte for byte
 * (`contracts/choice_claim_drops/src/merkle.rs`), whose golden vectors are
 * reproduced in this package's tests:
 *
 *   leaf   = sha256(utf8("{bech32_address}:{cumulative_amount_base_units}"))
 *   parent = sha256(concat(min(a, b), max(a, b)))   // sorted pair, no L/R flags
 *
 * - Address: canonical lowercase bech32 (`inj1…`), exactly as the chain stores it.
 * - Amount: decimal string of the LIFETIME CUMULATIVE allocation in base units.
 * - An odd node at any level promotes unchanged (its proof omits that level).
 * - Single-leaf tree: the leaf IS the root, and its proof is empty.
 *
 * A one-shot campaign freezes its root in the same block it is funded, so an
 * error here is not a bug you fix in the next release — it is a drop that is
 * funded, immutable and provably claimable by nobody.
 *
 * Uses node:crypto rather than a hashing dependency: this package is Node-only
 * (unlike the browser tool this is ported from), and the fewer libraries stand
 * between us and the contract's byte layout, the better.
 */

import { createHash } from "node:crypto";

export interface LeafInput {
  /** Canonical bech32 address (inj1…). */
  address: string;
  /** Lifetime cumulative allocation, base units, decimal string. */
  amount: string;
}

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(data).digest());

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const compare = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
};

/** leaf = sha256("{address}:{amount}") over the utf8 bytes. */
export function leafHash(address: string, amount: string): Uint8Array {
  return sha256(new TextEncoder().encode(`${address}:${amount}`));
}

/** parent = sha256(min(a,b) ++ max(a,b)). */
function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const buf = new Uint8Array(64);
  buf.set(lo, 0);
  buf.set(hi, 32);
  return sha256(buf);
}

export interface BuiltTree {
  /** 32-byte root, lowercase hex, no 0x — what `initial.root` expects. */
  rootHex: string;
  /** The deduplicated, hash-sorted leaves backing the root. */
  leaves: LeafInput[];
  /** Sum of every leaf amount — the campaign's declared `total`. */
  total: string;
  /** Proof per leaf, keyed by lowercase address. */
  proofs: Record<string, string[]>;
}

/**
 * Build the tree.
 *
 * Duplicate addresses are REJECTED rather than merged: a claim-drop leaf is a
 * lifetime cumulative total, so two leaves for one address make the smaller one
 * unclaimable noise — and silently dropping either is worse than refusing.
 * Callers that need duplicates summed do it upstream, where the count can be
 * reported (see `buildLeavesFromRows`).
 *
 * Leaves are sorted by leaf hash, so the tree is deterministic regardless of
 * input order: the publisher and every claim client derive identical proofs.
 */
export function buildTree(input: LeafInput[]): BuiltTree {
  if (input.length === 0) throw new Error("cannot build a tree with no leaves");

  const seen = new Set<string>();
  const leaves: { leaf: LeafInput; hash: Uint8Array }[] = [];
  let total = 0n;
  for (const { address, amount } of input) {
    const addr = address.trim();
    if (!/^[0-9]+$/.test(amount)) {
      throw new Error(`amount for ${addr} must be a base-unit integer string, got "${amount}"`);
    }
    const key = addr.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate address in leaves: ${addr}`);
    seen.add(key);
    total += BigInt(amount);
    leaves.push({ leaf: { address: addr, amount }, hash: leafHash(addr, amount) });
  }

  leaves.sort((x, y) => compare(x.hash, y.hash));

  let level = leaves.map((l) => l.hash);
  const levels: Uint8Array[][] = [level];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!);
    }
    levels.push(next);
    level = next;
  }

  const proofs: Record<string, string[]> = {};
  leaves.forEach((l, leafIdx) => {
    const proof: string[] = [];
    let idx = leafIdx;
    for (let lvl = 0; lvl < levels.length - 1; lvl++) {
      const sib = idx ^ 1;
      if (sib < levels[lvl]!.length) proof.push(toHex(levels[lvl]![sib]!));
      idx = Math.floor(idx / 2);
    }
    proofs[l.leaf.address.toLowerCase()] = proof;
  });

  return {
    rootHex: toHex(levels[levels.length - 1]![0]!),
    leaves: leaves.map((l) => l.leaf),
    total: total.toString(),
    proofs,
  };
}

/** Verify a proof locally — mirrors the contract's verifier. */
export function verifyProof(
  rootHex: string,
  address: string,
  amount: string,
  proofHex: string[],
): boolean {
  let node = leafHash(address.trim(), amount);
  for (const stepHex of proofHex) {
    if (!/^[0-9a-fA-F]{64}$/.test(stepHex)) return false;
    node = hashPair(node, Buffer.from(stepHex, "hex"));
  }
  return toHex(node) === rootHex.toLowerCase();
}
