/**
 * Hasura persistence for claim-drop leaves and the campaign registry — the same
 * public tables the trippytools site writes, so an agent-created drop is
 * indistinguishable to the claim page at /claim/<id>.
 *
 * Leaves are CONTENT-ADDRESSED BY MERKLE ROOT: the same tree always maps to the
 * same row, the `leaves_uri` is known before the create tx, and re-publishing
 * is idempotent. A claim page resolves campaign id -> root (on-chain) -> leaves
 * (here), rebuilds the tree locally and derives its own proof.
 *
 * Both mutations are ON CONFLICT DO NOTHING (`update_columns: []`), and `anon`
 * has no update grant — so a published row can never be rewritten by a later
 * insert. A conflicting insert returns null instead of the row, which is what
 * makes the squat check below both necessary and possible.
 *
 * Plain fetch rather than a GraphQL client: two mutations and one query do not
 * justify a dependency in a package that ships to npm.
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

const INSERT_CAMPAIGN = `
  mutation InsertClaimDropCampaign(
    $contract: String!, $campaign_id: bigint!, $root: String!, $denom: String!,
    $symbol: String, $decimals: Int, $meta: jsonb, $creator: String!,
    $tx_hash: String, $network: String!
  ) {
    insert_claim_drop_campaign_one(
      object: {
        contract: $contract, campaign_id: $campaign_id, root: $root, denom: $denom,
        symbol: $symbol, decimals: $decimals, meta: $meta, creator: $creator,
        tx_hash: $tx_hash, network: $network
      }
      on_conflict: { constraint: claim_drop_campaign_pkey, update_columns: [] }
    ) { campaign_id }
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

export async function recordCampaign(
  hasuraUrl: string,
  row: {
    network: string;
    contract: string;
    campaignId: number;
    root: string;
    denom: string;
    symbol: string | null;
    decimals: number;
    meta: Record<string, unknown>;
    creator: string;
    txHash: string | null;
  },
): Promise<void> {
  await gql(hasuraUrl, INSERT_CAMPAIGN, {
    network: row.network,
    contract: row.contract,
    campaign_id: row.campaignId,
    root: row.root,
    denom: row.denom,
    symbol: row.symbol,
    decimals: row.decimals,
    meta: row.meta,
    creator: row.creator,
    tx_hash: row.txHash,
  });
}
