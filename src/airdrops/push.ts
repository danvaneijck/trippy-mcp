/**
 * The push rail: pay everyone directly with MsgMultiSend, no claim step.
 *
 * The claim rail's whole appeal is that it is ONE transaction with a
 * deterministic total. This one is the opposite trade — recipients receive
 * passively, and in exchange the sender owns a partial-failure surface. Almost
 * everything here exists for one of two failure modes:
 *
 * 1. A transaction can LAND and still throw. The SDK broadcaster gives up on
 *    the inclusion wait while the transaction is sitting happily in the
 *    mempool, and the natural response to "broadcast failed" is to send again —
 *    which pays everyone in that chunk twice. So a throw is never treated as
 *    "failed". It is treated as UNKNOWN, and resolved against the chain before
 *    anything is resent. If it cannot be resolved, the run stops with the
 *    attempt written to disk, and the next run resolves it before doing
 *    anything else. Stopping is the correct outcome: there is no third option
 *    that is not either double-paying or stranding.
 *
 * 2. Some addresses cannot receive at all. The bank keeper refuses a subset of
 *    the x/auth module accounts — 12 of the 20, measured, not all of them as
 *    this comment once claimed (see address.ts) — and that refusal fires during
 *    gas SIMULATION, so one bad recipient reverts the whole chunk and strands
 *    the other 999 with it. The known ones are filtered at the leaf builder;
 *    the unknown ones (a future module, an EVM precompile) are why a failed
 *    group is BISECTED down to single addresses, so an unsendable recipient
 *    only ever strands itself.
 *
 *    Note the OTHER 8 module accounts accept the transfer and simply keep it.
 *    Nothing here can detect that — a send to one succeeds — which is why the
 *    leaf-builder exclusion, not this bisection, is what actually protects a
 *    drop from burning tokens on a keyless account.
 *
 * Those two interact, which is why the signer simulates as a separate step. A
 * rejected simulation and a lost broadcast look identical from outside — no
 * sequence consumed, no balance moved — but the first must be bisected
 * immediately and the second must never be resent until it is resolved. Failure
 * mode 2 is the COMMON one, so collapsing them would mean the ordinary case of
 * one blocked recipient stopping the entire run.
 *
 * Progress lives in a checkpoint keyed by planId, so a resumed run skips
 * whoever a landed transaction already paid.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BANK_MULTISEND_TARGET } from "../chain/cosmos.js";
import { PolicyError, ToolError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import {
  chunk,
  loadCheckpoint,
  recordChunkPaid,
  recordFailure,
  type CheckpointBase,
  type PushCheckpoint,
} from "./checkpoint.js";
import type { LeafInput } from "./merkle.js";
import type { StoredPlan } from "./plan.js";
import {
  accountSequence,
  balanceOfAddress,
  denomBalance,
  findTxHashAtSequence,
  usdValue,
} from "./pricing.js";
import { fromBaseUnits } from "./units.js";

/**
 * Ceiling on one push campaign, and the size of one transaction — deliberately
 * THE SAME NUMBER.
 *
 * `airdropCapUsd` is described as a per-campaign cap, but the policy engine
 * runs once per signed transaction, so it is only a per-campaign cap while a
 * campaign is one transaction. Splitting 1,500 recipients across two chunks
 * would let a drop worth twice the cap through, one legal half at a time.
 *
 * One chunk it is, then, and the ceiling comes from gas rather than from
 * policy: a bank output costs a dead-linear ~44k gas, so 1,000 outputs at the
 * 1.3x buffer is ~57M gasWanted — 38% of the block limit, and a routine size on
 * Injective. Raising this ceiling above one chunk means revisiting what
 * `airdropCapUsd` means first.
 */
export const MAX_PUSH_RECIPIENTS = 1000;
export const PUSH_CHUNK_SIZE = MAX_PUSH_RECIPIENTS;

/** How long to keep asking the chain whether an uncertain send landed. */
const RESOLVE_TIMEOUT_MS = 90_000;
const RESOLVE_POLL_MS = 3_000;
/**
 * After this long with the account sequence still unmoved, an unresolved
 * attempt is treated as never having landed.
 *
 * This is the one judgement call in the module, so it is stated plainly: a
 * transaction is valid at exactly one sequence, and if that sequence has not
 * advanced in ten minutes then nothing this wallet signed has been included in
 * roughly nine hundred blocks. The transaction is not coming. It is a judgement
 * and not a proof, which is why the alternative — never resolving, and leaving
 * the drop permanently half-paid — is the thing it is being weighed against.
 */
const PENDING_STALE_MS = 10 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A send whose outcome the client did not learn, persisted for the next run. */
export interface PendingAttempt {
  addresses: string[];
  /** One recipient of the attempt, watched to tell a landing from a revert. */
  probe: string;
  probeBalanceBefore: string;
  probeExpected: string;
  sequenceBefore: number | null;
  at: string;
}

export type SendVerdict = "landed" | "did_not_land" | "unresolved";

/**
 * Did this failure happen BEFORE anything was signed?
 *
 * The whole uncertainty machinery below applies only to failures that could
 * have left a transaction in the mempool. A rejected simulation could not:
 * nothing was signed, no sequence was consumed, and no amount of waiting will
 * change the answer. The signer separates the two cases precisely so this
 * question has an answer — see `CosmosSigner.bankMultiSend`.
 */
export function isPreBroadcastRejection(e: unknown): boolean {
  return e instanceof ToolError && e.code === "simulate_rejected";
}

/**
 * Decide whether an attempt landed, from state the chain still holds.
 *
 * Two signals, and the order matters. The account SEQUENCE is the rigorous one:
 * once it has moved past the sequence the transaction was signed at, that
 * transaction can never be included, so whatever happened has finished
 * happening. The probe recipient's BALANCE then says which way it went.
 *
 * A balance that rose is read as "landed" even though the recipient could in
 * principle have been paid by someone else in the same window. That bias is
 * chosen: being wrong in this direction strands a chunk, and being wrong in the
 * other direction pays it twice.
 */
export function verdictFrom(
  attempt: PendingAttempt,
  now: { sequence: number | null; probeBalance: bigint | null },
  ageMs: number,
): SendVerdict {
  if (now.probeBalance !== null) {
    const before = BigInt(attempt.probeBalanceBefore);
    const expected = BigInt(attempt.probeExpected);
    if (now.probeBalance >= before + expected) return "landed";
  }
  if (
    attempt.sequenceBefore !== null &&
    now.sequence !== null &&
    now.sequence > attempt.sequenceBefore
  ) {
    // The slot is spent and the recipient was not paid: the transaction was
    // included and reverted, or never existed. Either way it cannot land now.
    return "did_not_land";
  }
  if (ageMs > PENDING_STALE_MS) return "did_not_land";
  return "unresolved";
}

async function observe(
  rt: Runtime,
  denom: string,
  probe: string,
): Promise<{ sequence: number | null; probeBalance: bigint | null }> {
  const [sequence, probeBalance] = await Promise.all([
    accountSequence(rt),
    balanceOfAddress(rt, probe, denom),
  ]);
  return { sequence, probeBalance };
}

async function resolveAttempt(
  rt: Runtime,
  denom: string,
  attempt: PendingAttempt,
  opts: { poll: boolean },
): Promise<SendVerdict> {
  const deadline = Date.now() + (opts.poll ? RESOLVE_TIMEOUT_MS : 0);
  for (;;) {
    const now = await observe(rt, denom, attempt.probe);
    const verdict = verdictFrom(attempt, now, Date.now() - Date.parse(attempt.at));
    if (verdict !== "unresolved") return verdict;
    if (Date.now() >= deadline) return "unresolved";
    await sleep(RESOLVE_POLL_MS);
  }
}

// ---------------------------------------------------------------------------

interface RunState {
  base: CheckpointBase;
  denom: string;
  decimals: number;
  symbol: string;
  paid: Set<string>;
  /**
   * Only what THIS invocation paid. The history log is written per run, so a
   * drop finished across two calls produces two rows that partition the
   * recipients rather than two overlapping rows that double-count them.
   */
  paidThisRun: Set<string>;
  failed: Map<string, string>;
  txHashes: string[];
  /** Hashes THIS invocation landed, for the same reason `paidThisRun` exists. */
  txHashesThisRun: string[];
  /**
   * Sends confirmed by re-reading the chain whose hash could not be recovered
   * afterwards either. A send confirmed by re-read but matched back to its hash
   * does NOT count here — it is indistinguishable from an ordinary one.
   */
  confirmedWithoutHash: number;
  /** Set when the signer reported dryRun — the run stops after the first group. */
  dryRun: boolean;
}

/** Persist a confirmed payment, then mirror it into the in-memory run state. */
function markPaid(
  rt: Runtime,
  st: RunState,
  addresses: string[],
  txHash: string | null,
): void {
  recordChunkPaid(rt.home, st.base, addresses, txHash);
  for (const a of addresses) {
    st.paid.add(a);
    st.paidThisRun.add(a);
  }
  if (txHash) {
    st.txHashes.push(txHash);
    st.txHashesThisRun.push(txHash);
  }
}

type GroupOutcome =
  | { kind: "paid" }
  | { kind: "dry-run" }
  | { kind: "failed"; reason: string }
  | { kind: "unresolved"; reason: string };

/**
 * Send one group, retrying a send that provably never landed.
 *
 * Every attempt records what it is about to do BEFORE broadcasting, so an
 * attempt that disappears with the process can still be resolved by the next
 * run. That write is the reason a push drop can be interrupted at all.
 */
async function trySend(
  rt: Runtime,
  st: RunState,
  group: LeafInput[],
): Promise<GroupOutcome> {
  const attempts = 3;
  let lastReason = "unknown";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const probe = group[0]!;
    const [sequenceBefore, probeBalanceBefore] = await Promise.all([
      accountSequence(rt),
      balanceOfAddress(rt, probe.address, st.denom),
    ]);
    const pending: PendingAttempt = {
      addresses: group.map((g) => g.address),
      probe: probe.address,
      probeBalanceBefore: (probeBalanceBefore ?? 0n).toString(),
      probeExpected: probe.amount,
      sequenceBefore,
      at: new Date().toISOString(),
    };

    const totalBase = group.reduce((s, g) => s + BigInt(g.amount), 0n);
    const spendUsd = await usdValue(rt, st.denom, fromBaseUnits(totalBase.toString(), st.decimals));

    savePending(rt.home, st.base, pending);
    try {
      const res = await rt.cosmos.bankMultiSend(
        { denom: st.denom, outputs: group.map((g) => ({ address: g.address, amount: g.amount })) },
        {
          intent: {
            kind: "airdrop",
            target: BANK_MULTISEND_TARGET,
            detail: `push airdrop: ${group.length} recipients, ${fromBaseUnits(totalBase.toString(), st.decimals)} ${st.symbol}`,
            spendUsd,
          },
          memo: `trippy-mcp:${rt.cfg.agentName}`,
        },
      );
      if (res.status === "dry-run") {
        clearPending(rt.home, st.base);
        return { kind: "dry-run" };
      }
      // Checkpoint BEFORE clearing the pending marker, never after. Dying
      // between the two leaves a resume that sees both, resolves the attempt as
      // landed and writes the same addresses again — which is a no-op on a set.
      // The other order leaves a resume that sees neither and resends.
      markPaid(rt, st, pending.addresses, res.txHash);
      clearPending(rt.home, st.base);
      return { kind: "paid" };
    } catch (e) {
      // A policy denial is FINAL. It must never be retried and must never be
      // bisected: bisecting a cap denial would keep halving the group until
      // each piece fit under the cap, which is a way of spending straight
      // through it. Let it out untouched.
      if (e instanceof PolicyError) {
        clearPending(rt.home, st.base);
        throw e;
      }
      lastReason = e instanceof Error ? e.message : String(e);

      // A rejected SIMULATION signed nothing and consumed no sequence, so there
      // is nothing to resolve and nothing that can turn up later. Fail the group
      // straight away so the bisection can find the address that poisoned it.
      // Without this the common case — one blocked recipient — would be
      // indistinguishable from a transaction pending in the mempool, and the
      // whole run would stop instead of routing around one bad address.
      if (isPreBroadcastRejection(e)) {
        clearPending(rt.home, st.base);
        return { kind: "failed", reason: lastReason };
      }

      const verdict = await resolveAttempt(rt, st.denom, pending, { poll: true });
      if (verdict === "landed") {
        // It landed, so it has a hash somewhere — the client just never got
        // told. Match it back by the sequence it was signed at, so the history
        // row and the checkpoint point at the real transaction.
        const recovered = await findTxHashAtSequence(rt, pending.sequenceBefore, pending.probe);
        markPaid(rt, st, pending.addresses, recovered);
        clearPending(rt.home, st.base);
        if (recovered === null) st.confirmedWithoutHash += 1;
        return { kind: "paid" };
      }
      if (verdict === "unresolved") return { kind: "unresolved", reason: lastReason };
      clearPending(rt.home, st.base);
      if (attempt < attempts - 1) await sleep(1_000 * (attempt + 1));
    }
  }
  return { kind: "failed", reason: lastReason };
}

/**
 * Send a group; on failure, halve it and try each side.
 *
 * The recursion bottoms out at a single address, which — if it still fails
 * alone — is the one that was poisoning the batch. It is recorded with its
 * reason and skipped, and its former chunk-mates all get paid.
 */
async function processGroup(rt: Runtime, st: RunState, group: LeafInput[]): Promise<void> {
  const pending = group.filter((g) => !st.paid.has(g.address) && !st.failed.has(g.address));
  if (pending.length === 0) return;

  const outcome = await trySend(rt, st, pending);
  if (outcome.kind === "dry-run") {
    st.dryRun = true;
    return;
  }
  if (outcome.kind === "paid") return;
  if (outcome.kind === "unresolved") {
    throw new ToolError(
      "send_unresolved",
      `a send of ${pending.length} recipients could not be confirmed either way within ${RESOLVE_TIMEOUT_MS / 1000}s — it may still be in the mempool`,
      `STOPPED without resending, because resending a transaction that lands would pay those wallets twice. The attempt is saved: run airdrop_execute with this same planId again in a few minutes and it will resolve the attempt against the chain first, then carry on from wherever it actually got to. Last error: ${outcome.reason}`,
    );
  }

  if (pending.length === 1) {
    const only = pending[0]!;
    recordFailure(rt.home, st.base, only.address, outcome.reason);
    st.failed.set(only.address, outcome.reason);
    return;
  }

  const mid = Math.ceil(pending.length / 2);
  await processGroup(rt, st, pending.slice(0, mid));
  await processGroup(rt, st, pending.slice(mid));
}

// ---- pending-attempt persistence ------------------------------------------
// Its own file next to the checkpoint, written before every broadcast and
// deleted the moment the outcome is known. A checkpoint says what definitely
// happened; this says what might be happening right now, which is the state a
// crash otherwise destroys.

function pendingPath(home: string, planId: string): string {
  return join(home, "airdrops", "push", `${planId}.pending.json`);
}

function savePending(home: string, base: CheckpointBase, attempt: PendingAttempt): void {
  // NOT best-effort. This file is the only thing that lets a process which dies
  // mid-broadcast find out afterwards whether that broadcast landed; without it
  // the next run has no "before" to compare the probe's balance against and
  // would resend blind. If it cannot be written, the send does not happen.
  mkdirSync(join(home, "airdrops", "push"), { recursive: true, mode: 0o700 });
  writeFileSync(pendingPath(home, base.planId), JSON.stringify(attempt, null, 1), {
    mode: 0o600,
  });
}

function loadPending(home: string, planId: string): PendingAttempt | null {
  try {
    const p = pendingPath(home, planId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as PendingAttempt;
  } catch {
    return null;
  }
}

function clearPending(home: string, base: CheckpointBase): void {
  try {
    unlinkSync(pendingPath(home, base.planId));
  } catch {
    // Already gone is the desired state.
  }
}

// ---------------------------------------------------------------------------

export interface PushResult extends Record<string, unknown> {
  status: string;
}

export interface PushRun {
  result: PushResult;
  /**
   * Recipients THIS invocation paid, for the history log. Returned separately
   * rather than on `result` because it can be a thousand addresses long and the
   * result is a tool response an agent pays context for.
   */
  paidThisRun: string[];
  /** Hashes landed by THIS invocation, paired with `paidThisRun`. */
  txHashesThisRun: string[];
}

/**
 * Run (or resume) a push plan.
 *
 * The resume path runs FIRST, before a single new message is built: if the last
 * run left an attempt in the air, its outcome is settled against the chain
 * before anything else happens. Doing this in any other order is the bug the
 * whole module is arranged around.
 */
export async function executePush(
  rt: Runtime,
  plan: StoredPlan,
  opts: { decimals: number; symbol: string },
): Promise<PushRun> {
  const base: CheckpointBase = {
    planId: plan.planId,
    sender: plan.sender,
    denom: plan.denom,
    total: plan.leaves.length,
  };
  const prior = loadCheckpoint(rt.home, plan.planId);
  const st: RunState = {
    base,
    denom: plan.denom,
    decimals: opts.decimals,
    symbol: opts.symbol,
    paid: new Set(prior?.paid ?? []),
    paidThisRun: new Set(),
    txHashesThisRun: [],
    failed: new Map((prior?.failed ?? []).map((f) => [f.address, f.reason])),
    txHashes: [...(prior?.txHashes ?? [])],
    confirmedWithoutHash: 0,
    dryRun: false,
  };

  const notes: string[] = [];

  // ---- settle anything left in the air ------------------------------------
  const inFlight = loadPending(rt.home, plan.planId);
  if (inFlight) {
    const verdict = await resolveAttempt(rt, plan.denom, inFlight, { poll: false });
    if (verdict === "landed") {
      const recovered = await findTxHashAtSequence(rt, inFlight.sequenceBefore, inFlight.probe);
      markPaid(rt, st, inFlight.addresses, recovered);
      if (recovered === null) st.confirmedWithoutHash += 1;
      notes.push(
        `an unconfirmed send from a previous run DID land — ${inFlight.addresses.length} recipients were already paid and have been skipped` +
          (recovered ? ` (recovered its tx ${recovered})` : ""),
      );
      clearPending(rt.home, base);
    } else if (verdict === "did_not_land") {
      notes.push(
        `an unconfirmed send from a previous run did not land (the account sequence has moved past it), so its ${inFlight.addresses.length} recipients are being sent to now`,
      );
      clearPending(rt.home, base);
    } else {
      throw new ToolError(
        "send_still_unresolved",
        `the previous run left a send of ${inFlight.addresses.length} recipients that still cannot be confirmed either way`,
        "the account sequence has not moved since, so that transaction may yet be included. Wait a few minutes and run airdrop_execute with this planId again rather than forcing it — resending now would double-pay if it lands.",
      );
    }
  }

  // ---- what is left to do -------------------------------------------------
  const remaining = plan.leaves.filter(
    (l) => !st.paid.has(l.address) && !st.failed.has(l.address),
  );
  if (remaining.length === 0) {
    // NOT an empty paidThisRun. Reaching here after settling an in-flight
    // attempt means this invocation is the one that established those
    // recipients were paid — and the run that actually sent to them died
    // before it could log anything, so if this call reports nothing, that
    // drop never appears in the history at all.
    return {
      result: summarize(rt, plan, st, notes, "already-complete"),
      paidThisRun: [...st.paidThisRun],
      txHashesThisRun: [...st.txHashesThisRun],
    };
  }

  const remainingBase = remaining.reduce((s, l) => s + BigInt(l.amount), 0n);
  const balance = await denomBalance(rt, plan.denom);
  if (balance !== null && balance < remainingBase) {
    throw new ToolError(
      "insufficient_funds",
      `this wallet holds ${fromBaseUnits(balance.toString(), opts.decimals)} ${opts.symbol} but ${remaining.length} unpaid recipients need ${fromBaseUnits(remainingBase.toString(), opts.decimals)}`,
      st.paid.size > 0
        ? `${st.paid.size} recipients have already been paid — top the wallet up and run airdrop_execute with this planId again to finish the rest`
        : "fund the wallet, then execute again",
    );
  }

  // ---- send ---------------------------------------------------------------
  for (const group of chunk(remaining, PUSH_CHUNK_SIZE)) {
    await processGroup(rt, st, group);
    // The signer still runs the policy check in dry-run, so reaching here means
    // the drop was permitted — there is just nothing more to learn from
    // simulating the rest of it.
    if (st.dryRun) break;
  }

  if (st.dryRun) {
    return {
      paidThisRun: [],
      txHashesThisRun: [],
      result: {
      status: "dry-run",
      planId: plan.planId,
      rail: "push",
      wouldPay: remaining.length,
      wouldSend: `${fromBaseUnits(remainingBase.toString(), opts.decimals)} ${opts.symbol}`,
      chunks: chunk(remaining, PUSH_CHUNK_SIZE).length,
      note: "dryRun is set in config.json — the policy check ran and passed, but nothing was broadcast",
      },
    };
  }

  return {
    result: summarize(rt, plan, st, notes, "broadcast"),
    paidThisRun: [...st.paidThisRun],
    txHashesThisRun: [...st.txHashesThisRun],
  };
}

function summarize(
  rt: Runtime,
  plan: StoredPlan,
  st: RunState,
  notes: string[],
  status: string,
): PushResult {
  const paidLeaves = plan.leaves.filter((l) => st.paid.has(l.address));
  const paidBase = paidLeaves.reduce((s, l) => s + BigInt(l.amount), 0n);
  const unpaid = plan.leaves.filter((l) => !st.paid.has(l.address));
  const failed = [...st.failed.entries()].map(([address, reason]) => ({ address, reason }));

  if (st.confirmedWithoutHash > 0) {
    notes.push(
      `${st.confirmedWithoutHash} send(s) threw but were confirmed landed by re-reading the chain — their recipients ARE paid, and their tx hashes are missing rather than their money`,
    );
  }
  if (failed.length > 0) {
    notes.push(
      `${failed.length} address(es) the chain refuses even on their own were skipped after bisection — these are addresses no retry will fix (module accounts, precompiles), and every other recipient was paid`,
    );
  }

  return {
    status,
    planId: plan.planId,
    rail: "push",
    denom: plan.denom,
    recipientsPaid: paidLeaves.length,
    recipientsPaidThisRun: st.paidThisRun.size,
    recipientsTotal: plan.leaves.length,
    totalSent: `${fromBaseUnits(paidBase.toString(), plan.decimals)} ${plan.symbol ?? plan.denom}`,
    txHashes: st.txHashes,
    explorerUrls: st.txHashes.map((h) => `${rt.net.explorerTxBase}${h}`),
    unsendable: failed,
    unpaid: unpaid.length,
    complete: unpaid.length === failed.length,
    notes,
  };
}

/** Progress of a push plan, for `airdrop_status`. */
export function pushStatus(
  rt: Runtime,
  plan: StoredPlan,
  cp: PushCheckpoint | null,
): Record<string, unknown> {
  const paid = new Set(cp?.paid ?? []);
  const paidBase = plan.leaves
    .filter((l) => paid.has(l.address))
    .reduce((s, l) => s + BigInt(l.amount), 0n);
  return {
    planId: plan.planId,
    rail: "push",
    denom: plan.denom,
    recipientsPaid: paid.size,
    recipientsTotal: plan.leaves.length,
    sent: `${fromBaseUnits(paidBase.toString(), plan.decimals)} ${plan.symbol ?? plan.denom}`,
    txHashes: cp?.txHashes ?? [],
    explorerUrls: (cp?.txHashes ?? []).map((h) => `${rt.net.explorerTxBase}${h}`),
    unsendable: cp?.failed ?? [],
    inFlight: loadPending(rt.home, plan.planId) !== null,
    complete: paid.size + (cp?.failed.length ?? 0) >= plan.leaves.length,
    note:
      cp === null
        ? "this push plan has not been executed yet"
        : "re-running airdrop_execute with this planId resumes from here — the addresses above are never paid twice",
  };
}
