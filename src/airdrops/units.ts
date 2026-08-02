/**
 * Whole-token <-> base-unit conversion and leaf assembly.
 *
 * Every conversion here is string/BigInt math, never float. An allocation is
 * the BYTES a leaf hash commits to: a rounding artifact is not an off-by-a-dust
 * error that nobody notices, it is a leaf whose proof verifies against a root
 * that no claim can be built from.
 */

import { isValidInjAddress } from "./address.js";
import type { LeafInput } from "./merkle.js";

/** One row as supplied by a caller: an address and a WHOLE-token amount. */
export interface AmountRow {
  address: string;
  amount: string;
}

export interface LeafBuild {
  leaves: LeafInput[];
  totalBase: string;
  /** Rows folded into an address that already appeared (amounts summed). */
  mergedRows: number;
  /** Rows carrying more precision than the denom has decimals (floored). */
  truncatedRows: number;
  /** Rows dropped because they floor to 0 base units. */
  zeroRows: number;
  /** Rows dropped for being a bank-blocked or excluded address. */
  blockedRows: number;
  /** Rows dropped for failing bech32 validation, with the offending values. */
  invalidRows: number;
  invalidSamples: string[];
}

const AMOUNT_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

export const isValidAmount = (amount: string): boolean => AMOUNT_RE.test((amount || "").trim());

/**
 * Whole tokens -> base units, FLOORED at `decimals`.
 *
 * Flooring rather than rounding is the safe direction: the attached funds must
 * cover the sum of the leaves exactly, and rounding up would ask the contract
 * for a base unit that was never funded. `truncated` reports when real
 * precision was dropped, so a preview can say so instead of quietly shaving.
 */
export function toBaseUnits(amount: string, decimals: number): { base: string; truncated: boolean } {
  const trimmed = (amount || "").trim();
  if (!AMOUNT_RE.test(trimmed)) throw new Error(`invalid amount: "${amount}"`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const kept = frac.slice(0, decimals);
  const dropped = frac.slice(decimals);
  return {
    base: BigInt((whole || "0") + kept.padEnd(decimals, "0")).toString(),
    truncated: /[1-9]/.test(dropped),
  };
}

/** Base units -> a whole-token decimal string (exact, trailing zeros trimmed). */
export function fromBaseUnits(base: string, decimals: number): string {
  const negative = base.startsWith("-");
  const digits = (negative ? base.slice(1) : base).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Turn rows into the leaf set.
 *
 * Duplicate addresses are SUMMED here (unlike `buildTree`, which rejects them):
 * a leaf is a lifetime cumulative total, so "listed twice" means one wallet
 * with the combined allocation. The counts are reported so a preview can say
 * exactly what happened to the caller's list rather than presenting a silently
 * different one.
 */
export function buildLeavesFromRows(
  rows: AmountRow[],
  decimals: number,
  opts: { isBlocked?: (address: string) => boolean } = {},
): LeafBuild {
  const isBlocked = opts.isBlocked ?? (() => false);

  const byAddress = new Map<string, bigint>();
  const order: string[] = [];
  let mergedRows = 0;
  let truncatedRows = 0;
  let zeroRows = 0;
  let blockedRows = 0;
  let invalidRows = 0;
  const invalidSamples: string[] = [];

  for (const row of rows) {
    const address = (row.address || "").trim();

    // Full bech32 CHECKSUM validation, not a charset regex. A push airdrop is a
    // bank send and the chain rejects a bad address before any money moves; a
    // claim drop never shows the address to a chain rule at all — it goes
    // straight into a leaf hash, gets funded, and freezes. A single mistyped
    // character therefore strands real value permanently.
    if (!isValidInjAddress(address)) {
      invalidRows += 1;
      if (invalidSamples.length < 5) invalidSamples.push(address.slice(0, 64));
      continue;
    }
    if (isBlocked(address)) {
      blockedRows += 1;
      continue;
    }

    const { base, truncated } = toBaseUnits(row.amount, decimals);
    if (truncated) truncatedRows += 1;
    if (base === "0") {
      zeroRows += 1;
      continue;
    }

    const existing = byAddress.get(address);
    if (existing === undefined) {
      byAddress.set(address, BigInt(base));
      order.push(address);
    } else {
      byAddress.set(address, existing + BigInt(base));
      mergedRows += 1;
    }
  }

  let total = 0n;
  const leaves: LeafInput[] = order.map((address) => {
    const amount = byAddress.get(address)!;
    total += amount;
    return { address, amount: amount.toString() };
  });

  return {
    leaves,
    totalBase: total.toString(),
    mergedRows,
    truncatedRows,
    zeroRows,
    blockedRows,
    invalidRows,
    invalidSamples,
  };
}
