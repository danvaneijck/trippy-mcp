/**
 * Recipient sources — where a drop's wallet list comes from.
 *
 * Phase 1 ships the three that need no backend work and cover the cases an
 * agent actually has: a pasted list, the holders of any token, and the holders
 * of a launch it created. All are public-endpoint reads.
 *
 * Every source returns `SourceRow[]` (address + weight) and the allocator does
 * the rest, so adding NFT/gov/mito/buyback later is a fetcher and a switch arm.
 */

import { formatUnits } from "viem";

import { denomDecimals } from "../api/lcd.js";
import { ToolError } from "../errors.js";
import { evmToInj } from "../keystore.js";
import type { Runtime } from "../runtime.js";
import { LaunchState } from "../venues/shroom/abi.js";
import { exclusionSet } from "./address.js";
import type { SourceRow } from "./allocate.js";

export type SourceKind = "csv" | "token_holders" | "launch_holders";

export interface CsvSource {
  kind: "csv";
  /** Fixed per-address amounts in WHOLE tokens — bypasses the allocator. */
  rows: { address: string; amount: string }[];
}

export interface TokenHoldersSource {
  kind: "token_holders";
  /** Bank denom (factory/…, peggy0x…, ibc/…, inj, erc20:0x…). */
  denom: string;
}

export interface LaunchHoldersSource {
  kind: "launch_holders";
  /** SHROOM Pad launch id. */
  launchId: string;
}

export type Source = CsvSource | TokenHoldersSource | LaunchHoldersSource;

export interface SourceResult {
  rows: SourceRow[];
  /** Addresses excluded as non-wallets, for the preview to report. */
  excluded: string[];
  excludedCount: number;
  /** What was snapshotted, in words, for the campaign meta and the audit log. */
  description: string;
  /** ISO time the snapshot was taken — every source here is live-at-query. */
  snapshotAt: string;
  /** Decimals of the SOURCE asset (weights are in whole units of it). */
  sourceDecimals: number;
}

/** Page every holder of a bank denom. */
async function denomOwners(
  lcdUrl: string,
  denom: string,
  decimals: number,
): Promise<{ address: string; weight: number }[]> {
  const out: { address: string; weight: number }[] = [];
  let nextKey: string | null = null;
  // 1000/page against a hard page cap: a denom with >500k holders is not a
  // list any single drop should be built from, and an unbounded loop against a
  // public LCD is how you get rate-limited mid-snapshot.
  for (let page = 0; page < 500; page++) {
    const params = new URLSearchParams({ "pagination.limit": "1000" });
    if (nextKey) params.set("pagination.key", nextKey);
    const url = `${lcdUrl.replace(/\/$/, "")}/cosmos/bank/v1beta1/denom_owners/${encodeURIComponent(denom)}?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new ToolError(
        "holders_query_failed",
        `could not page holders of ${denom} (HTTP ${res.status})`,
        page === 0 ? "check the denom is exactly as the chain spells it" : undefined,
      );
    }
    const body = (await res.json()) as {
      denom_owners?: { address: string; balance?: { amount?: string } }[];
      pagination?: { next_key?: string | null };
    };
    for (const o of body.denom_owners ?? []) {
      const raw = BigInt(o.balance?.amount ?? "0");
      if (raw <= 0n) continue;
      out.push({ address: o.address, weight: Number(formatUnits(raw, decimals)) });
    }
    nextKey = body.pagination?.next_key ?? null;
    if (!nextKey) return out;
  }
  throw new ToolError(
    "holders_too_many",
    `${denom} has more holders than one snapshot will page (>500k)`,
    "narrow the list with filters.topN",
  );
}

/**
 * The tool schema types every kind-specific field as optional (one object,
 * three shapes), so the discriminant is checked here rather than trusted — a
 * `{kind: "token_holders"}` with no denom must be a clear error, not a crash
 * inside a URL builder.
 */
function requireField<K extends string>(
  source: Record<string, unknown>,
  field: K,
  kind: string,
): string {
  const v = source[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ToolError("bad_input", `source.${field} is required when source.kind is "${kind}"`);
  }
  return v.trim();
}

export async function loadSource(rt: Runtime, source: Source): Promise<SourceResult> {
  const snapshotAt = new Date().toISOString();
  const raw = source as unknown as Record<string, unknown>;

  if (source.kind === "csv") {
    if (!Array.isArray(source.rows) || source.rows.length === 0) {
      throw new ToolError(
        "bad_input",
        'source.rows is required when source.kind is "csv"',
        "each row is {address, amount} with amount in whole tokens",
      );
    }
    // Fixed amounts: no weights, no exclusions applied here. The leaf builder
    // validates and filters, because that is where the counts get reported.
    return {
      rows: source.rows.map((r) => ({ address: r.address, weight: 0 })),
      excluded: [],
      excludedCount: 0,
      description: `explicit list of ${source.rows.length} addresses`,
      snapshotAt,
      sourceDecimals: 0,
    };
  }

  if (source.kind === "token_holders") {
    const denom = requireField(raw, "denom", "token_holders");
    const decimals = await denomDecimals(rt.net.lcdUrl, denom);
    const all = await denomOwners(rt.net.lcdUrl, denom, decimals);
    return filterHolders(all, [], `holders of ${denom}`, snapshotAt, decimals);
  }

  return launchHolders(rt, requireField(raw, "launchId", "launch_holders"), snapshotAt);
}

/**
 * Holders of a launch's token.
 *
 * The launch token is a tokenfactory bank denom AND an erc20-module ERC20
 * sharing ONE balance, so `denom_owners` on the bank denom sees every holder
 * including anyone who only ever touched the ERC20 side. Curve-phase holders
 * are therefore included, which is the point: this is the "reward the people
 * who bought my token" case, and most of them bought before graduation.
 *
 * The launch-aware exclusions matter more here than anywhere else. The single
 * largest holder of an un-graduated launch token is the launch's own SINK,
 * which holds all the unsold curve supply — a proportionate drop that missed it
 * would send most of the total to a contract that cannot claim.
 */
async function launchHolders(
  rt: Runtime,
  launchIdRaw: string,
  snapshotAt: string,
): Promise<SourceResult> {
  if (!/^\d+$/.test(launchIdRaw)) {
    throw new ToolError("bad_input", `launchId must be numeric, got "${launchIdRaw}"`);
  }
  const launchId = BigInt(launchIdRaw);
  const live = await rt.shroom.getLaunchView(launchId);
  if (live.state === LaunchState.Reserved || live.state === LaunchState.Created) {
    throw new ToolError(
      "not_bound",
      `launch #${launchIdRaw} has no bank denom yet (still binding)`,
      "wait for the keeper to bind it, then snapshot again",
    );
  }
  if (!live.bankDenom) {
    throw new ToolError("no_denom", `launch #${launchIdRaw} has no bank denom to snapshot`);
  }

  // Launch tokens are always 18-decimal.
  const all = await denomOwners(rt.net.lcdUrl, live.bankDenom, 18);
  // The EVM-side contracts hold the token under their bech32 mirror — the same
  // 20 bytes, addressed the way the bank module indexes them.
  const launchOwned = [live.sink, rt.net.addresses.launchpadCore, rt.net.addresses.feeTreasury].map(
    (a) => evmToInj(a as `0x${string}`),
  );
  return filterHolders(
    all,
    launchOwned,
    `holders of launch #${launchIdRaw} (${live.bankDenom})`,
    snapshotAt,
    18,
  );
}

function filterHolders(
  all: { address: string; weight: number }[],
  extraExclusions: string[],
  description: string,
  snapshotAt: string,
  sourceDecimals: number,
): SourceResult {
  const isExcluded = exclusionSet(extraExclusions);
  const rows: SourceRow[] = [];
  const excluded: string[] = [];
  for (const h of all) {
    if (isExcluded(h.address)) {
      excluded.push(h.address);
      continue;
    }
    rows.push(h);
  }
  rows.sort((a, b) => b.weight - a.weight);
  return {
    rows,
    excluded: excluded.slice(0, 20),
    excludedCount: excluded.length,
    description,
    snapshotAt,
    sourceDecimals,
  };
}
