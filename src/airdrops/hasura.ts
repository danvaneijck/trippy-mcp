/**
 * Persistence for claim-drop leaves and the campaign registry — the same public
 * tables the trippytools site writes, so an agent-created drop is
 * indistinguishable to the claim page at /claim/<id>.
 *
 * Leaves are CONTENT-ADDRESSED BY MERKLE ROOT: the same tree always maps to the
 * same row, the `leaves_uri` is known before the create tx, and re-publishing
 * is idempotent. A claim page resolves campaign id -> root (on-chain) -> leaves
 * (here), rebuilds the tree locally and derives its own proof.
 *
 * The leaves mutation is ON CONFLICT DO NOTHING (`update_columns: []`), and
 * `anon` has no update grant — so a published row can never be rewritten by a
 * later insert. A conflicting insert returns null instead of the row, which is
 * what makes the squat check below both necessary and possible.
 *
 * Campaign rows are not written through Hasura: `recordCampaign` asks trippinj
 * to record the campaign, and trippinj builds the row from the contract's state.
 *
 * Plain fetch rather than a GraphQL client: a few mutations and one query do
 * not justify a dependency in a package that ships to npm.
 */

import { ToolError } from "../errors.js";
import { buildTree, type LeafInput } from "./merkle.js";

const UPSERT_LEAVES = `
  mutation UpsertClaimDropLeaves($root: String!, $total: String!, $leaves: jsonb!, $created_by: String!) {
    insert_claim_drop_leaves_one(
      object: { root: $root, total: $total, leaves: $leaves, created_by: $created_by }
      on_conflict: { constraint: claim_drop_leaves_pkey, update_columns: [] }
    ) { root }
  }`;

const GET_LEAVES_BY_ROOT = `
  query GetClaimDropLeaves($root: String!) {
    claim_drop_leaves_by_pk(root: $root) { root total leaves }
  }`;

async function gql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new ToolError("hasura_error", `leaves store returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message?: string }[] };
  if (body.errors?.length) {
    throw new ToolError("hasura_error", `leaves store rejected the write: ${body.errors[0]?.message ?? "unknown"}`);
  }
  if (!body.data) throw new ToolError("hasura_error", "leaves store returned no data");
  return body.data;
}

/** Narrow an untrusted JSON payload to leaves without trusting any field. */
function asLeaves(value: unknown): LeafInput[] | null {
  if (!Array.isArray(value)) return null;
  const out: LeafInput[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { address, amount } = entry as Record<string, unknown>;
    if (typeof address !== "string" || typeof amount !== "string") return null;
    out.push({ address, amount });
  }
  return out;
}

export async function fetchStoredLeaves(
  hasuraUrl: string,
  root: string,
): Promise<{ leaves: LeafInput[]; total: string } | null> {
  const data = await gql<{
    claim_drop_leaves_by_pk: { root: string; total: string; leaves: unknown } | null;
  }>(hasuraUrl, GET_LEAVES_BY_ROOT, { root });
  const row = data.claim_drop_leaves_by_pk;
  if (!row) return null;
  const leaves = asLeaves(row.leaves);
  return leaves ? { leaves, total: row.total } : null;
}

/**
 * Publish the leaves, and prove that what is stored under this root really is
 * our tree before its URL goes on-chain.
 *
 * The subtle failure this guards: the table is insert-only and keyed by root,
 * which makes a published row un-rewritable — but it also means whoever
 * inserts a root FIRST owns that key forever, and nothing at the database level
 * checks that the stored leaves actually hash to it. A drop whose allocation
 * list is predictable therefore has a predictable root, and a squatted row
 * would leave the campaign frozen around a leaves_uri serving a list that
 * rebuilds to a different root: every claim page would refuse to build a proof,
 * permanently, with the funds already inside the contract.
 *
 * Cheap to check. Impossible to fix if missed.
 */
export async function publishLeaves(
  hasuraUrl: string,
  rootHex: string,
  total: string,
  leaves: LeafInput[],
  createdBy: string,
): Promise<{ inserted: boolean }> {
  const data = await gql<{ insert_claim_drop_leaves_one: { root: string } | null }>(
    hasuraUrl,
    UPSERT_LEAVES,
    { root: rootHex, total, leaves, created_by: createdBy },
  );
  if (data.insert_claim_drop_leaves_one) return { inserted: true };

  // null = the insert hit an existing row for this root. Verify it.
  const stored = await fetchStoredLeaves(hasuraUrl, rootHex);
  const matches = (() => {
    if (!stored) return false;
    try {
      return buildTree(stored.leaves).rootHex.toLowerCase() === rootHex.toLowerCase();
    } catch {
      return false;
    }
  })();
  if (!matches) {
    throw new ToolError(
      "leaves_root_mismatch",
      "a leaves document is already stored for this merkle root and it does NOT rebuild to it — refusing to publish a campaign nobody could claim from",
      "change the allocation (any change produces a different root) and preview again",
    );
  }
  return { inserted: false };
}

// ---- push-drop history ----------------------------------------------------
// The site's airdrop history is a different set of tables from the claim-drop
// registry above, because a push drop has no campaign to register — it is just
// transactions. Recording it is what makes an agent's push drops show up in the
// same history as the ones a human ran, with the criteria string the plan
// already carries.
//
// trippinj writes the row (`POST /airdrops/log`) from the transactions: the
// sender, token, recipients and amounts are read off the MsgMultiSends, so only
// the hashes and the free text go up, and anon can no longer insert history,
// token or wallet rows through Hasura.

/** The backend's per-request cap on tx hashes. */
const MAX_HASHES_PER_RECORD = 200;

export interface AirdropLogRow {
  criteria: string;
  description: string;
  txHashes: string[];
}

/**
 * Batches of at most MAX_HASHES_PER_RECORD; each one after the first repeats a
 * hash of the one before, so the backend adds it to the same history row.
 */
export function recordBatches(txHashes: string[]): string[][] {
  const batches: string[][] = [];
  let i = 0;
  while (i < txHashes.length) {
    const carry = batches.length > 0 ? [txHashes[i - 1]] : [];
    const take = MAX_HASHES_PER_RECORD - carry.length;
    batches.push([...carry, ...txHashes.slice(i, i + take)]);
    i += take;
  }
  return batches;
}

/**
 * Log a completed push drop to the site's history.
 *
 * Best-effort by contract: the transactions have already landed by the time
 * this runs, so a logging failure is a missing history row, not a failed drop.
 * The caller reports it as a note and moves on. A 404 (the LCD has not indexed
 * the newest tx yet) or a 502 is retried; any other refusal is final.
 */
export async function recordAirdropLog(
  airdropLogUrl: string,
  row: AirdropLogRow,
  opts: { retryDelayMs?: number } = {},
): Promise<void> {
  const delay = opts.retryDelayMs ?? 3000;
  for (const batch of recordBatches(row.txHashes)) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(airdropLogUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx_hashes: batch, criteria: row.criteria, description: row.description }),
      });
      if (res.ok) break;
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if ((res.status !== 404 && res.status !== 502) || attempt >= 3) {
        throw new ToolError(
          "hasura_error",
          `airdrop history returned HTTP ${res.status}${body?.error ? `: ${body.error}` : ""}`,
        );
      }
      await new Promise((r) => setTimeout(r, delay * attempt));
    }
  }
}

/**
 * Record a published campaign in the trippinj campaign index (the claim page's
 * "my drops"). Only the campaign's coordinates are sent: trippinj reads the row
 * from the contract, and keeps `txHash` only if that tx checks out on-chain.
 * Idempotent, so a retry just re-syncs the row.
 */
export async function recordCampaign(
  campaignsUrl: string,
  row: { network: string; contract: string; campaignId: number; txHash: string | null },
): Promise<void> {
  const res = await fetch(campaignsUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      network: row.network,
      contract: row.contract,
      campaign_id: row.campaignId,
      tx_hash: row.txHash,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ToolError("hasura_error", `campaign index returned HTTP ${res.status}${body?.error ? `: ${body.error}` : ""}`);
  }
}
