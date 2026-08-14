/**
 * Finding the block height a governance proposal's voting period closed on.
 *
 * Governance voters are the only source here that is NOT live-at-query. A vote
 * list read "now" is the list as it stands now — but the answer everyone means
 * by "who voted on proposal N" is the list as it stood when voting ENDED, and
 * that is a height, not a time. The chain indexes proposals by time, so this
 * estimates a height from the average block interval and then brackets and
 * binary-searches to the boundary.
 *
 * Probes stay near the estimate on purpose. A plain binary search over
 * [1, latest] would open by asking a ~180M-height chain for block 90M, which a
 * pruned public LCD does not have — so the search would fail on its first probe
 * for every proposal, recent or not. Seeding from the block interval keeps every
 * probe inside a window the node plausibly still stores.
 */

import { ToolError } from "../errors.js";
import { lcdGetJson } from "./wasm.js";

/** Average Injective block time in ms. Only ever used to SEED the search. */
export const BLOCK_MS = 690;

export interface BlockRef {
  height: number;
  timeMs: number;
  timeIso: string;
}

/** Host of an LCD URL, for error text that names the endpoint not the whole path. */
function hostOf(lcdUrl: string): string {
  try {
    return new URL(lcdUrl).host;
  } catch {
    return lcdUrl;
  }
}

interface BlockResponse {
  block?: { header?: { height?: string; time?: string } };
}

/** Tendermint's answer when the node it hit has pruned past the height asked for. */
const PRUNED_RE = /lowest height is (\d+)/i;

export async function fetchBlock(lcdUrl: string, height: number | "latest"): Promise<BlockRef> {
  const url = `${lcdUrl.replace(/\/$/, "")}/cosmos/base/tendermint/v1beta1/blocks/${height}`;
  let body: BlockResponse;
  try {
    // A public LCD host is a load balancer over nodes with DIFFERENT retention,
    // so "height not available" is a property of the node that answered, not of
    // the chain: an immediate retry lands on a different node and usually
    // succeeds. That makes fast, frequent retries the right shape here — the
    // slow doubling ladder used for rate-limited paging would just wait out a
    // failure that a second request fixes.
    body = await lcdGetJson<BlockResponse>(url, {
      attempts: 8,
      backoffMs: 250,
      maxBackoffMs: 2_000,
      errorCode: "block_query_failed",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const pruned = PRUNED_RE.exec(msg);
    if (pruned) {
      throw new ToolError(
        "block_pruned",
        `block ${height} is not retained by ${hostOf(lcdUrl)} — the nodes answering there keep history from ~${pruned[1]} up`,
        "pass `height` explicitly to snapshot at a height the node still has, or point config.lcdUrl at an archive node",
      );
    }
    throw e;
  }
  const h = Number(body.block?.header?.height);
  const t = body.block?.header?.time;
  if (!Number.isInteger(h) || h <= 0 || !t) {
    throw new ToolError("block_query_failed", `block ${height} came back without a usable header`);
  }
  const timeMs = Date.parse(t);
  if (!Number.isFinite(timeMs)) {
    throw new ToolError("block_query_failed", `block ${h} has an unparseable timestamp "${t}"`);
  }
  return { height: h, timeMs, timeIso: new Date(timeMs).toISOString() };
}

/**
 * Where to start looking: how many blocks back from `latest` a given time is,
 * assuming a steady block interval.
 *
 * Pure so the seeding arithmetic is testable without a chain — it is the part
 * that decides whether the search converges in ten probes or thirty.
 */
export function seedHeight(latest: BlockRef, targetMs: number): number {
  const drift = latest.timeMs - targetMs;
  const guess = latest.height - Math.round(drift / BLOCK_MS);
  return Math.min(latest.height, Math.max(1, guess));
}

export interface BlockSearchResult {
  /** Last block whose timestamp is strictly before the target. */
  height: number;
  timeIso: string;
  /** How many blocks were fetched — useful when an LCD is rate-limiting. */
  probes: number;
  /** Set when the target is at or past the chain tip. */
  atTip?: boolean;
}

/** First bracket step, in blocks — roughly an hour of chain. */
const FIRST_STEP = 512;

/**
 * Height of the last block committed BEFORE `targetMs`.
 *
 * Three phases: seed from the block interval, expand a bracket in ONE direction
 * (doubling the step) until it straddles the target, then binary-search that
 * bracket. The invariant carried through phases two and three is
 * `block(lo).time < target <= block(hi).time`, so the answer is always `lo`.
 *
 * The expansion is directional rather than "seed to tip" because the bracket
 * width is what the binary search pays for: a bracket a few thousand blocks
 * wide converges in a dozen probes, while [seed, tip] would cost the same ~27
 * probes as searching the whole chain and would spend most of them on heights
 * far from the target.
 */
export async function findBlockBeforeTime(
  lcdUrl: string,
  targetMs: number,
): Promise<BlockSearchResult> {
  let probes = 0;
  const at = async (height: number): Promise<BlockRef> => {
    probes += 1;
    return fetchBlock(lcdUrl, Math.max(1, Math.round(height)));
  };

  probes += 1;
  const latest = await fetchBlock(lcdUrl, "latest");
  if (targetMs > latest.timeMs) {
    // Voting has not closed yet. Snapshotting "now" would freeze a list that is
    // still changing, so this is reported rather than quietly returning tip.
    return { height: latest.height, timeIso: latest.timeIso, probes, atTip: true };
  }

  // ---- phase 1: seed ------------------------------------------------------
  const seed = await at(seedHeight(latest, targetMs));

  // ---- phase 2: bracket ---------------------------------------------------
  let loRef: BlockRef | null = null;
  let hiRef: BlockRef | null = null;
  if (seed.timeMs < targetMs) {
    loRef = seed;
    hiRef = seed.height >= latest.height ? latest : null;
    let step = FIRST_STEP;
    for (let i = 0; i < 25 && hiRef === null; i++) {
      const next = Math.min(latest.height, loRef.height + step);
      const ref = await at(next);
      if (ref.timeMs >= targetMs) hiRef = ref;
      else if (next >= latest.height) hiRef = latest;
      else loRef = ref;
      step *= 2;
    }
  } else {
    hiRef = seed;
    let step = FIRST_STEP;
    for (let i = 0; i < 25 && loRef === null; i++) {
      const next = Math.max(1, hiRef.height - step);
      const ref = await at(next);
      if (ref.timeMs < targetMs) loRef = ref;
      else if (next <= 1) break; // the whole retained chain is after the target
      else hiRef = ref;
      step *= 2;
    }
  }

  if (!loRef || !hiRef) {
    throw new ToolError(
      "block_search_failed",
      `could not bracket ${new Date(targetMs).toISOString()} in this node's block history`,
      "the LCD is likely pruned past that date — pass `height` explicitly, or point config.lcdUrl at an archive node",
    );
  }

  // ---- phase 3: binary search --------------------------------------------
  let lo = loRef.height;
  let hi = hiRef.height;
  for (let i = 0; i < 40 && hi - lo > 1; i++) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const ref = await at(mid);
    if (ref.timeMs < targetMs) {
      lo = ref.height;
      loRef = ref;
    } else {
      hi = ref.height;
    }
  }

  return { height: loRef.height, timeIso: loRef.timeIso, probes };
}
