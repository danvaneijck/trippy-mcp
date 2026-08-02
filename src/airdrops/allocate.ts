/**
 * Turning weighted source rows into exact per-address allocations.
 *
 * One allocator for every rail, and it is the BigInt one. The push-airdrop
 * allocator this is NOT — that one works in JS numbers and holds back a dust
 * haircut, which is fine when each transfer is rounded at send time and a few
 * unspent units cost nothing. A claim drop is the opposite on both counts:
 *
 *   1. the amount IS the bytes inside the leaf hash, so a float artifact is not
 *      a rounding error, it is an unclaimable leaf; and
 *   2. the contract's solvency check demands the attached funds equal the
 *      declared total exactly, and the declared total is the sum of the leaves.
 *
 * So everything here is BigInt in base units, and the proportionate split uses
 * largest-remainder: the sum of allocations equals the requested total to the
 * base unit, always, with no haircut and nothing left over.
 *
 * Determinism is the other requirement. The same list must always produce the
 * same tree and therefore the same merkle root — that is what makes a retry
 * after a failed broadcast reuse the published leaves instead of orphaning them.
 */

export interface SourceRow {
  address: string;
  /** Tokens held, NFTs owned, INJ committed — source-dependent. */
  weight: number;
  /**
   * Gov sources only: the option this wallet voted for, so a drop can go to
   * (say) only the wallets that voted yes. Carried on the row rather than in a
   * side map because filters run before allocation and the allocator's dedupe
   * discards everything it does not need.
   */
  voteOption?: string;
}

export type DistMode = "fair" | "proportionate";

export interface Allocation {
  address: string;
  /** Base units, exact — this becomes the leaf. */
  amountBase: string;
  weight: number;
}

export interface AllocationResult {
  allocations: Allocation[];
  /** Sum of `allocations` in base units — the drop's real total. */
  totalBase: string;
  /** Rows that allocated to 0 base units and were dropped (dust holders). */
  droppedZero: number;
  /** Rows folded into an address that already appeared (weights summed). */
  mergedRows: number;
}

// Weights arrive as JS numbers from every source, so they are pinned to a fixed
// precision before any integer math. 6 places is far beyond what a holder
// ranking needs and keeps the largest-remainder comparison deterministic.
const WEIGHT_DP = 6;
const WEIGHT_SCALE = 10n ** BigInt(WEIGHT_DP);

/**
 * A weight as an exact integer. `toFixed` switches to exponential notation at
 * 1e21, which produces a string `BigInt()` rejects, so very large weights (a
 * whale's balance in whole tokens) take the integer path — they carry no
 * meaningful fractional part at that magnitude anyway.
 */
export function weightToInt(weight: number): bigint {
  if (!Number.isFinite(weight) || weight <= 0) return 0n;
  if (weight >= 1e21) return BigInt(Math.round(weight)) * WEIGHT_SCALE;
  const [whole, frac = ""] = weight.toFixed(WEIGHT_DP).split(".");
  return BigInt(whole + frac.padEnd(WEIGHT_DP, "0"));
}

/** Deduplicate by address, summing weights. */
function dedupe(rows: SourceRow[]): { rows: SourceRow[]; mergedRows: number } {
  const byAddress = new Map<string, SourceRow>();
  let mergedRows = 0;
  for (const row of rows) {
    const address = (row.address || "").trim();
    if (!address) continue;
    const existing = byAddress.get(address);
    if (existing) {
      existing.weight += Number(row.weight) || 0;
      mergedRows += 1;
    } else {
      byAddress.set(address, { address, weight: Number(row.weight) || 0 });
    }
  }
  return { rows: [...byAddress.values()], mergedRows };
}

/**
 * Split `totalBase` across `rows`.
 *
 * `fair` gives everyone the same amount; the base units that do not divide
 * evenly go one each to the lowest addresses, so the split lands exactly on
 * total rather than short. `proportionate` floors each share then hands the
 * remaining units to the largest fractional remainders (ties broken by
 * address) — the standard largest-remainder method, and the only way to stay
 * exactly on total without giving anyone a fractional base unit.
 *
 * A source with no weights at all falls back to a fair split rather than
 * dividing by zero.
 */
export function allocateExact(
  rows: SourceRow[],
  totalBase: bigint,
  mode: DistMode,
): AllocationResult {
  const { rows: unique, mergedRows } = dedupe(rows);
  // Address order is the tiebreaker everywhere below, so identical inputs
  // always produce an identical tree and therefore an identical root.
  unique.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));

  if (unique.length === 0 || totalBase <= 0n) {
    return { allocations: [], totalBase: "0", droppedZero: 0, mergedRows };
  }

  const weights = unique.map((r) => weightToInt(r.weight));
  const weightSum = weights.reduce((s, w) => s + w, 0n);
  const useFair = mode === "fair" || weightSum === 0n;

  const amounts: bigint[] = [];
  if (useFair) {
    const n = BigInt(unique.length);
    const share = totalBase / n;
    const remainder = Number(totalBase % n);
    for (let i = 0; i < unique.length; i++) {
      amounts.push(share + (i < remainder ? 1n : 0n));
    }
  } else {
    const remainders: { index: number; rem: bigint }[] = [];
    let assigned = 0n;
    for (let i = 0; i < unique.length; i++) {
      const numerator = totalBase * weights[i]!;
      const share = numerator / weightSum;
      amounts.push(share);
      assigned += share;
      remainders.push({ index: i, rem: numerator % weightSum });
    }
    // Largest remainder first; `unique` is already address-sorted, so a stable
    // sort leaves equal remainders in address order.
    remainders.sort((a, b) => (a.rem === b.rem ? 0 : a.rem > b.rem ? -1 : 1));
    let leftover = totalBase - assigned;
    for (const { index } of remainders) {
      if (leftover <= 0n) break;
      amounts[index] = amounts[index]! + 1n;
      leftover -= 1n;
    }
  }

  // A zero leaf is unclaimable noise. Dropping it means the drop's total is the
  // sum of what actually survived, which is what gets funded.
  const allocations: Allocation[] = [];
  let droppedZero = 0;
  let sum = 0n;
  for (let i = 0; i < unique.length; i++) {
    if (amounts[i]! <= 0n) {
      droppedZero += 1;
      continue;
    }
    sum += amounts[i]!;
    allocations.push({
      address: unique[i]!.address,
      amountBase: amounts[i]!.toString(),
      weight: unique[i]!.weight,
    });
  }

  return { allocations, totalBase: sum.toString(), droppedZero, mergedRows };
}

/** Keep only the `n` heaviest wallets (ties broken by address, as everywhere). */
export function applyTopN(rows: SourceRow[], n: number): SourceRow[] {
  if (!Number.isFinite(n) || n <= 0 || n >= rows.length) return rows;
  return [...rows]
    .sort((a, b) => {
      const d = (Number(b.weight) || 0) - (Number(a.weight) || 0);
      if (d !== 0) return d;
      return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    })
    .slice(0, n);
}

/** Keep only wallets holding at least `minWeight` of the source asset. */
export function applyMinWeight(rows: SourceRow[], minWeight: number): SourceRow[] {
  if (!Number.isFinite(minWeight) || minWeight <= 0) return rows;
  return rows.filter((r) => (Number(r.weight) || 0) >= minWeight);
}

/**
 * Keep only the wallets that voted one of `options` (gov sources).
 *
 * Rows with no `voteOption` at all are kept: the filter is meaningless on a
 * token snapshot, and dropping every row because the source does not carry the
 * field would turn a nonsensical filter into an empty drop rather than a no-op.
 */
export function applyVoteOptions(rows: SourceRow[], options: string[]): SourceRow[] {
  const wanted = new Set(options);
  if (wanted.size === 0) return rows;
  return rows.filter((r) => r.voteOption === undefined || wanted.has(r.voteOption));
}

/**
 * Drop everyone whose share would land under `minBase`, then re-split the whole
 * total across the wallets that remain — so trimming dust raises everyone
 * else's allocation instead of leaving the drop under-funded.
 *
 * One pass is enough: re-running can only push more wallets over the line,
 * never under it, so a second pass would remove nobody.
 */
export function applyMinAmount(
  rows: SourceRow[],
  totalBase: bigint,
  mode: DistMode,
  minBase: bigint,
): SourceRow[] {
  if (minBase <= 0n) return rows;
  const { allocations } = allocateExact(rows, totalBase, mode);
  const keep = new Set(
    allocations.filter((a) => BigInt(a.amountBase) >= minBase).map((a) => a.address),
  );
  return rows.filter((r) => keep.has((r.address || "").trim()));
}
