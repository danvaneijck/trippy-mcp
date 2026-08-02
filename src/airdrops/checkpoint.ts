/**
 * Durable progress for a push airdrop.
 *
 * A claim drop is one transaction, so it needs no progress at all — that is
 * most of why it shipped first. A push drop is N signed bank transfers, and
 * without a record of which ones landed, a run that dies on chunk 2 of 2 and is
 * re-run pays the first 500 recipients a second time. This file is that record.
 *
 * It stores the SET OF PAID ADDRESSES, not the index of the last completed
 * chunk. Chunk indices are only stable if the recipient list keeps a
 * byte-identical order, and the list is rebuilt from a plan file whose leaves
 * can be re-serialised in a different order by anything that touches them; a
 * shifted boundary would then skip exactly the wrong people. A paid-set is
 * order-independent and stays correct however the plan is reloaded.
 *
 * The same reasoning applies to `failed`: an address the chain refuses (a
 * module account, a precompile) is refused every time, so it is recorded with
 * the reason and never retried into a fresh failure.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = 1;

export interface PushFailure {
  address: string;
  reason: string;
}

export interface PushCheckpoint {
  v: number;
  planId: string;
  sender: string;
  denom: string;
  /** Recipients in the plan, for progress reporting. */
  total: number;
  /** Addresses a landed transaction is known to have paid. */
  paid: string[];
  /** Landed tx hashes, in confirmation order. */
  txHashes: string[];
  /** Addresses the chain refused even when sent alone. */
  failed: PushFailure[];
  startedAt: string;
  updatedAt: string;
}

function dir(home: string): string {
  return join(home, "airdrops", "push");
}

function path(home: string, planId: string): string {
  // planId is our own hex digest; constrained rather than trusted because the
  // read side is reached from a tool argument.
  if (!/^[0-9a-f]{32}$/.test(planId)) throw new Error(`"${planId}" is not a plan id`);
  return join(dir(home), `${planId}.json`);
}

export function loadCheckpoint(home: string, planId: string): PushCheckpoint | null {
  try {
    const p = path(home, planId);
    if (!existsSync(p)) return null;
    const cp = JSON.parse(readFileSync(p, "utf-8")) as PushCheckpoint;
    return cp && cp.v === VERSION ? cp : null;
  } catch {
    return null;
  }
}

function write(home: string, cp: PushCheckpoint): void {
  mkdirSync(dir(home), { recursive: true, mode: 0o700 });
  writeFileSync(path(home, cp.planId), JSON.stringify(cp, null, 1), { mode: 0o600 });
}

export interface CheckpointBase {
  planId: string;
  sender: string;
  denom: string;
  total: number;
}

function seed(home: string, base: CheckpointBase): PushCheckpoint {
  const now = new Date().toISOString();
  return (
    loadCheckpoint(home, base.planId) ?? {
      v: VERSION,
      planId: base.planId,
      sender: base.sender,
      denom: base.denom,
      total: base.total,
      paid: [],
      txHashes: [],
      failed: [],
      startedAt: now,
      updatedAt: now,
    }
  );
}

/**
 * Merge a chunk that is known to have landed.
 *
 * Written before anything else can throw, and — critically — this is the ONLY
 * function that adds to `paid`. A chunk whose broadcast returned an error but
 * whose landing was afterwards confirmed against the chain goes through here
 * too, with `txHash` null, because "we could not read the hash" and "the
 * recipients were not paid" are entirely different facts.
 */
export function recordChunkPaid(
  home: string,
  base: CheckpointBase,
  addresses: string[],
  txHash: string | null,
): PushCheckpoint {
  const cp = seed(home, base);
  const paid = new Set(cp.paid);
  for (const a of addresses) paid.add(a);
  cp.paid = [...paid];
  if (txHash && !cp.txHashes.includes(txHash)) cp.txHashes.push(txHash);
  cp.updatedAt = new Date().toISOString();
  write(home, cp);
  return cp;
}

/** Record an address the chain refuses, so a later resume does not retry it. */
export function recordFailure(
  home: string,
  base: CheckpointBase,
  address: string,
  reason: string,
): PushCheckpoint {
  const cp = seed(home, base);
  if (!cp.failed.some((f) => f.address === address)) {
    cp.failed.push({ address, reason: reason.slice(0, 300) });
  }
  cp.updatedAt = new Date().toISOString();
  write(home, cp);
  return cp;
}

/** Only for tests and hand cleanup — a finished run keeps its checkpoint. */
export function clearCheckpoint(home: string, planId: string): void {
  try {
    unlinkSync(path(home, planId));
  } catch {
    // Already gone is the desired state.
  }
}

/** Split a list into fixed-size chunks, preserving order. */
export function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
