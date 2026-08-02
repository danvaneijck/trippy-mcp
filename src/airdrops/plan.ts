/**
 * The plan cache — what makes `airdrop_preview` -> `airdrop_execute` a real
 * two-step commit rather than two names for one action.
 *
 * `airdrop_execute` accepts a planId and nothing else. An agent can therefore
 * never go from "criteria" straight to "broadcast": the exact recipient set
 * that will be funded is written to disk, inspectable, and unchanged between
 * the two calls. If the model's second call disagrees with its first, the
 * disagreement is visible in the plan file rather than silently authoritative.
 *
 * planId is a hash of (sender | asset | sorted address:amount pairs), so it is
 * a function of the ALLOCATION, not of when it was made. Same list, same id,
 * same merkle root — which is what lets a retry after a failed broadcast reuse
 * the already-published leaves instead of orphaning them.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ToolError } from "../errors.js";
import type { LeafInput } from "./merkle.js";

/** Plans go stale so a snapshot taken an hour ago cannot fund a drop today. */
export const PLAN_TTL_MS = 60 * 60 * 1000;

export interface StoredPlan {
  planId: string;
  createdAt: string;
  network: string;
  /** The agent wallet that previewed it — a plan is not portable between wallets. */
  sender: string;
  denom: string;
  symbol: string | null;
  decimals: number;
  rootHex: string;
  totalBase: string;
  leaves: LeafInput[];
  meta: Record<string, unknown>;
  expiryNanos: string | null;
  /** USD value at preview time — what the policy check was made against. */
  totalUsd: number | null;
  criteria: string;
  snapshotAt: string;
  /**
   * Set immediately BEFORE the create tx is broadcast, and never cleared.
   *
   * This is the double-funding guard, and it is written ahead of the broadcast
   * rather than after it on purpose. The failure it exists for is a tx that
   * LANDS and still throws — the sdk broadcaster gives up on the inclusion wait
   * while the transaction is happily sitting in the mempool. Marking after a
   * successful return would leave that plan looking un-executed and still
   * inside its TTL, and the natural response to a "broadcast failed" error is
   * to retry, which would fund the whole drop a second time.
   *
   * The cost of marking early is a plan that is refused after a broadcast that
   * genuinely never landed. That is recoverable (preview again); funding twice
   * is not.
   */
  attemptedAt?: string;
  /** Set once the create tx is known to have landed. */
  txHash?: string | null;
  campaignId?: number | null;
}

export function planId(sender: string, denom: string, leaves: LeafInput[]): string {
  const body = [...leaves]
    .map((l) => `${l.address}:${l.amount}`)
    .sort()
    .join("|");
  return createHash("sha256")
    .update(`${sender.toLowerCase()}|${denom}|${body}`)
    .digest("hex")
    .slice(0, 32);
}

function plansDir(home: string): string {
  return join(home, "airdrops");
}

function planPath(home: string, id: string): string {
  // `id` is our own hex digest, never caller text — but this path is built from
  // a tool argument on the read side, so it is constrained rather than trusted.
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw new ToolError("bad_plan_id", `"${id}" is not a plan id`);
  }
  return join(plansDir(home), `${id}.json`);
}

export function savePlan(home: string, plan: StoredPlan): void {
  const dir = plansDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(planPath(home, plan.planId), JSON.stringify(plan, null, 1), { mode: 0o600 });
}

/**
 * `allowStale` is for read-only lookups (status re-resolving a campaign by its
 * root). The TTL exists to stop a stale SNAPSHOT from being funded, not to stop
 * anyone from asking what happened to an old plan.
 */
export function loadPlan(
  home: string,
  id: string,
  opts: { now?: number; allowStale?: boolean } = {},
): StoredPlan {
  const now = opts.now ?? Date.now();
  const path = planPath(home, id);
  if (!existsSync(path)) {
    throw new ToolError(
      "no_such_plan",
      `no airdrop plan ${id}`,
      "run airdrop_preview first — execute only ever funds a plan that was previewed",
    );
  }
  const plan = JSON.parse(readFileSync(path, "utf-8")) as StoredPlan;
  const age = now - Date.parse(plan.createdAt);
  if (!opts.allowStale && (!Number.isFinite(age) || age > PLAN_TTL_MS)) {
    throw new ToolError(
      "plan_expired",
      `airdrop plan ${id} is older than an hour and its snapshot is stale`,
      "run airdrop_preview again — holder lists move, and funding an old snapshot pays the wrong wallets",
    );
  }
  return plan;
}

export function listPlans(home: string, now = Date.now()): StoredPlan[] {
  const dir = plansDir(home);
  if (!existsSync(dir)) return [];
  const out: StoredPlan[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const plan = JSON.parse(readFileSync(join(dir, f), "utf-8")) as StoredPlan;
      if (now - Date.parse(plan.createdAt) <= PLAN_TTL_MS) out.push(plan);
    } catch {
      // A half-written or hand-edited plan file is not worth failing a list over.
    }
  }
  return out.sort((a, z) => Date.parse(z.createdAt) - Date.parse(a.createdAt));
}

/**
 * Update a plan in place. Used to mark a broadcast attempt and, later, its
 * outcome — the plan file is KEPT after execution rather than deleted, because
 * it is the only thing that can turn a planId back into a merkle root when the
 * campaign id could not be read out of the tx. Deleting it would break the
 * exact recovery path that `airdrop_status` advertises.
 */
export function updatePlan(home: string, id: string, patch: Partial<StoredPlan>): void {
  const path = planPath(home, id);
  if (!existsSync(path)) return;
  const plan = JSON.parse(readFileSync(path, "utf-8")) as StoredPlan;
  writeFileSync(path, JSON.stringify({ ...plan, ...patch }, null, 1), { mode: 0o600 });
}

/** Only for tests and hand cleanup — the normal flow never deletes a plan. */
export function deletePlan(home: string, id: string): void {
  try {
    unlinkSync(planPath(home, id));
  } catch {
    // Already gone is the desired state.
  }
}
