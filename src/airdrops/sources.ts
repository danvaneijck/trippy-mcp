/**
 * Recipient sources — where a drop's wallet list comes from.
 *
 * Every source returns `SourceRow[]` (address + weight) and the exact BigInt
 * allocator does the rest, so a new criterion is a fetcher and a switch arm.
 * All of them are public-endpoint reads: nothing here needs a backend.
 *
 * The site's versions of these live on a browser class that reports progress
 * through React callbacks and returns floats. Only the READS are ported — the
 * shapes are ours, and the weights stay in whole units of whatever the source
 * counts (tokens held, NFTs owned, INJ committed) so `filters.minWeight` means
 * something a caller can reason about without knowing a denom's decimals.
 */

import { formatUnits } from "viem";

import { denomDecimals } from "../api/lcd.js";
import { ToolError } from "../errors.js";
import { evmToInj } from "../keystore.js";
import type { Runtime } from "../runtime.js";
import { LaunchState } from "../venues/shroom/abi.js";
import { exclusionSet } from "./address.js";
import type { SourceRow } from "./allocate.js";
import { findBlockBeforeTime } from "./blocks.js";
import { contractStatePage, lcdGetJson, mapPrefix, smartQuery, startsWith } from "./wasm.js";

export type SourceKind =
  | "csv"
  | "token_holders"
  | "launch_holders"
  | "nft_holders"
  | "gov_voters";

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

export interface NftHoldersSource {
  kind: "nft_holders";
  /** CW721 (or CW404) collection contract address. */
  collection: string;
  /** True for a CW404 hybrid, whose holders live in a raw balance map. */
  is404?: boolean;
}

export interface GovVotersSource {
  kind: "gov_voters";
  proposalId: string;
  /** Snapshot height. Omitted → the last block before voting closed. */
  height?: number;
}

export type Source =
  | CsvSource
  | TokenHoldersSource
  | LaunchHoldersSource
  | NftHoldersSource
  | GovVotersSource;

export interface SourceResult {
  rows: SourceRow[];
  /** Addresses excluded as non-wallets, for the preview to report. */
  excluded: string[];
  excludedCount: number;
  /** What was snapshotted, in words, for the campaign meta and the audit log. */
  description: string;
  /** ISO time the snapshot was taken. */
  snapshotAt: string;
  /**
   * Height the snapshot was read AT, when the source is a historical one.
   * Absent means live-at-query, which is every source except gov voters.
   */
  snapshotHeight?: number;
  /** Decimals of the SOURCE asset (weights are in whole units of it). */
  sourceDecimals: number;
  /** What one unit of `weight` means, in words — surfaced in the preview. */
  weightUnit: string;
  /** Source-specific caveats the preview must repeat to the caller. */
  warnings?: string[];
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
 * five shapes), so the discriminant is checked here rather than trusted — a
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
      weightUnit: "none — a csv carries its own amounts",
    };
  }

  if (source.kind === "token_holders") {
    const denom = requireField(raw, "denom", "token_holders");
    const decimals = await denomDecimals(rt.net.lcdUrl, denom);
    const all = await denomOwners(rt.net.lcdUrl, denom, decimals);
    return filterHolders(all, [], `holders of ${denom}`, snapshotAt, decimals, "whole tokens held");
  }

  if (source.kind === "nft_holders") {
    return nftHolders(
      rt,
      requireField(raw, "collection", "nft_holders"),
      raw.is404 === true,
      snapshotAt,
    );
  }

  if (source.kind === "gov_voters") {
    return govVoters(rt, requireField(raw, "proposalId", "gov_voters"), source.height, snapshotAt);
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
    "whole tokens held",
  );
}

// ---------------------------------------------------------------------------
// NFT / CW404 collections
// ---------------------------------------------------------------------------

/**
 * Above this, stop rather than page on. Enumerating a CW721 costs one query per
 * page plus one `owner_of` per token that does not carry its owner inline, and
 * a 100k-supply collection would be a six-figure request count against a public
 * LCD — a snapshot that fails halfway is worse than one that refuses up front,
 * because a truncated holder list still allocates and still freezes.
 */
const MAX_NFT_TOKENS = 20_000;
/** cw721-base caps `all_tokens` at 30 per page regardless of what is asked. */
const NFT_PAGE = 30;
/** Concurrent `owner_of` lookups. Enough to matter, gentle enough not to 429. */
const OWNER_BATCH = 8;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Token ids out of an `all_tokens` page, which may be strings or objects. */
function tokenEntries(
  page: unknown,
): { id: string; owner: string | null }[] {
  const tokens = (page as { tokens?: unknown; ids?: unknown }).tokens ?? (page as { ids?: unknown }).ids;
  if (!Array.isArray(tokens)) return [];
  const out: { id: string; owner: string | null }[] = [];
  for (const t of tokens) {
    if (typeof t === "string") {
      out.push({ id: t, owner: null });
      continue;
    }
    if (typeof t !== "object" || t === null) continue;
    const rec = t as Record<string, unknown>;
    const id = rec.token_id ?? rec.id;
    if (typeof id !== "string" && typeof id !== "number") continue;
    out.push({
      id: String(id),
      owner: typeof rec.owner === "string" && rec.owner.startsWith("inj1") ? rec.owner : null,
    });
  }
  return out;
}

async function nftHolders(
  rt: Runtime,
  collection: string,
  is404: boolean,
  snapshotAt: string,
): Promise<SourceResult> {
  if (!collection.startsWith("inj1")) {
    throw new ToolError(
      "bad_input",
      `source.collection must be a contract address, got "${collection}"`,
    );
  }
  return is404
    ? cw404Holders(rt, collection, snapshotAt)
    : cw721Holders(rt, collection, snapshotAt);
}

/**
 * CW721 holders, weighted by how many tokens of the collection they hold.
 *
 * There is no "list holders" query in the CW721 spec, so the only route is to
 * enumerate every token and resolve its owner. Some contracts (Talis among
 * them) return the owner inline on `all_tokens`, which skips the per-token
 * lookup entirely; the rest need one `owner_of` each.
 */
async function cw721Holders(
  rt: Runtime,
  collection: string,
  snapshotAt: string,
): Promise<SourceResult> {
  const lcd = rt.net.lcdUrl;
  const info = await smartQuery<{ name?: string; symbol?: string }>(
    lcd,
    collection,
    { contract_info: {} },
    { errorCode: "not_a_collection" },
  ).catch(() => null);

  const counted = await smartQuery<{ count?: number }>(lcd, collection, { num_tokens: {} }).catch(
    () => null,
  );
  const supply = Number(counted?.count ?? 0);
  if (supply > MAX_NFT_TOKENS) {
    throw new ToolError(
      "collection_too_large",
      `${collection} has ${supply} tokens, above the ${MAX_NFT_TOKENS} this snapshot will enumerate`,
      "enumerating a CW721 costs one query per token — use token_holders on a wrapped denom, or drop to a list you already have via the csv source",
    );
  }

  const balances = new Map<string, number>();
  const pending: string[] = [];
  let startAfter: string | null = null;
  let seen = 0;

  for (let page = 0; page < Math.ceil(MAX_NFT_TOKENS / NFT_PAGE) + 2; page++) {
    const body = await smartQuery<unknown>(lcd, collection, {
      all_tokens: { start_after: startAfter, limit: NFT_PAGE },
    });
    const entries = tokenEntries(body);
    if (entries.length === 0) break;
    for (const e of entries) {
      seen += 1;
      if (e.owner) balances.set(e.owner, (balances.get(e.owner) ?? 0) + 1);
      else pending.push(e.id);
    }
    if (seen > MAX_NFT_TOKENS) {
      throw new ToolError(
        "collection_too_large",
        `${collection} has more than ${MAX_NFT_TOKENS} tokens`,
        "narrow the drop with the csv source, or snapshot a wrapped denom with token_holders",
      );
    }
    const last = entries[entries.length - 1]!.id;
    // A contract that ignores `start_after` would page the same window forever.
    if (last === startAfter) break;
    startAfter = last;
  }

  if (seen === 0) {
    throw new ToolError(
      "no_tokens",
      `${collection} returned no tokens from all_tokens`,
      "if this is a CW404 hybrid, set source.is404 = true — its holders live in a balance map, not in token ids",
    );
  }

  // Resolve the owners the listing did not carry.
  let unresolved = 0;
  for (let i = 0; i < pending.length; i += OWNER_BATCH) {
    const batch = pending.slice(i, i + OWNER_BATCH);
    const owners = await Promise.all(
      batch.map((id) =>
        smartQuery<{ owner?: string }>(lcd, collection, { owner_of: { token_id: id } })
          .then((r) => r.owner ?? null)
          .catch(() => null),
      ),
    );
    for (const owner of owners) {
      if (owner) balances.set(owner, (balances.get(owner) ?? 0) + 1);
      else unresolved += 1;
    }
    if (i + OWNER_BATCH < pending.length) await sleep(120);
  }

  const label = info?.symbol || info?.name || collection;
  const warnings: string[] = [];
  if (unresolved > 0) {
    warnings.push(
      `${unresolved} of ${seen} tokens in ${label} had no resolvable owner (burned or a failed query) and are not represented in the weights`,
    );
  }

  return filterHolders(
    [...balances.entries()].map(([address, weight]) => ({ address, weight })),
    [],
    `holders of NFT collection ${label} (${collection}), ${seen} tokens`,
    snapshotAt,
    0,
    "NFTs held",
    warnings,
  );
}

/** cw-storage-plus namespace CW404 contracts keep their balance map under. */
const CW404_BALANCE_NS = "balance";

/**
 * CW404 holders, read straight out of the contract's raw state.
 *
 * A CW404 is a fungible token wearing an NFT interface: its holders are rows in
 * a `Map<Addr, Uint128>`, and cw-storage-plus maps have no query behind them.
 * So this walks the raw key/value store, starting AT the map rather than at the
 * contract's first key — `mapPrefix` builds the same `0x00 <len> "balance"`
 * prefix the contract writes under, which is what turns a scan of the entire
 * contract state into a scan of just the balances.
 *
 * (The site's version carries a hand-collected table of per-contract start keys
 * to achieve the same skip. Deriving the prefix works for every CW404 instead
 * of the handful someone got round to recording.)
 */
async function cw404Holders(
  rt: Runtime,
  collection: string,
  snapshotAt: string,
): Promise<SourceResult> {
  const lcd = rt.net.lcdUrl;
  const info = await smartQuery<{ decimals?: number; symbol?: string; name?: string }>(
    lcd,
    collection,
    { token_info: {} },
    { errorCode: "not_a_cw404" },
  );
  const decimals = Number(info.decimals ?? 0);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new ToolError("not_a_cw404", `${collection} reported unusable decimals (${info.decimals})`);
  }

  const prefix = mapPrefix(CW404_BALANCE_NS);
  const rows: { address: string; weight: number }[] = [];
  let startKey: Uint8Array | string | null = prefix;
  let malformed = 0;

  for (let page = 0; page < 2_000; page++) {
    const { models, nextKey } = await contractStatePage(lcd, collection, startKey, 100);
    if (models.length === 0) break;
    let leftTheMap = false;
    for (const m of models) {
      // The scan started at the map's first key, so the first key that no
      // longer carries the prefix is the end of the map — everything after it
      // belongs to some other part of the contract's state.
      if (!startsWith(m.key, prefix)) {
        leftTheMap = true;
        break;
      }
      const address = Buffer.from(m.key.slice(prefix.length)).toString("utf8");
      // Uint128 is stored as a JSON string, quotes included.
      const raw = Buffer.from(m.value).toString("utf8").trim().replace(/^"|"$/g, "");
      let amount: bigint;
      try {
        amount = BigInt(raw);
      } catch {
        malformed += 1;
        continue;
      }
      if (amount <= 0n) continue;
      rows.push({ address, weight: Number(formatUnits(amount, decimals)) });
    }
    if (leftTheMap || !nextKey) break;
    startKey = nextKey;
  }

  const label = info.symbol || info.name || collection;
  const warnings: string[] = [];
  if (malformed > 0) {
    warnings.push(`${malformed} balance rows in ${label} could not be decoded and were skipped`);
  }
  if (rows.length === 0) {
    throw new ToolError(
      "no_holders",
      `no balance entries found in ${collection}`,
      "if this is a plain CW721, leave source.is404 unset",
    );
  }

  return filterHolders(
    rows,
    [],
    `holders of CW404 ${label} (${collection})`,
    snapshotAt,
    decimals,
    "whole tokens held",
    warnings,
  );
}

// ---------------------------------------------------------------------------
// Governance voters
// ---------------------------------------------------------------------------

/** Full gov v1 option names, keyed by the short form an agent will type. */
const VOTE_ALIASES: Record<string, string> = {
  yes: "VOTE_OPTION_YES",
  no: "VOTE_OPTION_NO",
  abstain: "VOTE_OPTION_ABSTAIN",
  no_with_veto: "VOTE_OPTION_NO_WITH_VETO",
  nowithveto: "VOTE_OPTION_NO_WITH_VETO",
  veto: "VOTE_OPTION_NO_WITH_VETO",
};

/** `yes` / `VOTE_OPTION_YES` / `1` all mean the same thing. */
export function normalizeVoteOption(option: string): string {
  const t = (option || "").trim().toLowerCase();
  if (t.startsWith("vote_option_")) return t.toUpperCase();
  return VOTE_ALIASES[t.replace(/[\s-]/g, "_")] ?? t.toUpperCase();
}

interface GovVote {
  voter?: string;
  options?: { option?: string; weight?: string }[];
}

/**
 * Everyone who voted on a proposal, as of the height voting closed.
 *
 * This is the ONE source that is not live-at-query, and it has to be: votes are
 * deleted from state when a proposal is tallied on some chains and are in any
 * case still mutable while voting is open, so "who voted" is only a stable
 * question with a height attached. The `x-cosmos-block-height` header is the
 * only true at-height read the LCD offers.
 *
 * The weight returned is the WEIGHT OF THE VOTE (1.0 for an ordinary vote,
 * split across options for a weighted one) — not the voter's stake. Nothing
 * here knows how much INJ anyone had bonded, so a `proportionate` split over
 * this source is an equal split with extra steps. That is called out as a
 * warning rather than silently produced.
 */
async function govVoters(
  rt: Runtime,
  proposalIdRaw: string,
  heightArg: number | undefined,
  snapshotAt: string,
): Promise<SourceResult> {
  if (!/^\d+$/.test(proposalIdRaw)) {
    throw new ToolError("bad_input", `proposalId must be numeric, got "${proposalIdRaw}"`);
  }
  const lcd = rt.net.lcdUrl.replace(/\/$/, "");
  const warnings: string[] = [];

  let height = heightArg;
  let heightSource = `height ${heightArg} as supplied`;
  if (height === undefined) {
    const prop = await lcdGetJson<{
      proposal?: { voting_end_time?: string; status?: string };
    }>(`${lcd}/cosmos/gov/v1/proposals/${proposalIdRaw}`, { errorCode: "no_such_proposal" });
    const endTime = prop.proposal?.voting_end_time;
    if (!endTime || !Number.isFinite(Date.parse(endTime))) {
      throw new ToolError(
        "no_voting_period",
        `proposal #${proposalIdRaw} has no voting end time to snapshot at`,
        "pass source.height to snapshot at a height you choose",
      );
    }
    const found = await findBlockBeforeTime(lcd, Date.parse(endTime));
    height = found.height;
    heightSource = `height ${found.height} — the last block before voting closed at ${endTime}`;
    if (found.atTip) {
      warnings.push(
        `voting on proposal #${proposalIdRaw} has NOT closed yet (ends ${endTime}) — this snapshot is of an in-progress vote and the list will still change`,
      );
    }
  }

  const rows: SourceRow[] = [];
  let nextKey: string | null = null;
  let total = 0;
  for (let page = 0; page < 500; page++) {
    const params = new URLSearchParams({ "pagination.limit": "1000" });
    if (nextKey) params.set("pagination.key", nextKey);
    const body = await lcdGetJson<{
      votes?: GovVote[];
      pagination?: { next_key?: string | null; total?: string };
    }>(`${lcd}/cosmos/gov/v1/proposals/${proposalIdRaw}/votes?${params}`, {
      headers: { "x-cosmos-block-height": String(height) },
      errorCode: "votes_query_failed",
    }).catch((e) => {
      throw new ToolError(
        "votes_query_failed",
        `could not read proposal #${proposalIdRaw} votes at height ${height}: ${e instanceof Error ? e.message : String(e)}`,
        "an at-height read needs a node that still has that height — most public LCDs are pruned, so point config.lcdUrl at an archive node or pass a recent source.height",
      );
    });

    for (const v of body.votes ?? []) {
      if (typeof v.voter !== "string" || !v.voter.startsWith("inj1")) continue;
      const options = (v.options ?? []).filter((o) => typeof o.option === "string");
      if (options.length === 0) continue;
      // A weighted vote splits across options; the heaviest is the one that
      // represents the voter for filtering purposes.
      const heaviest = options.reduce((a, b) =>
        (Number(b.weight) || 0) > (Number(a.weight) || 0) ? b : a,
      );
      const weight = options.reduce((s, o) => s + (Number(o.weight) || 0), 0);
      rows.push({ address: v.voter, weight, voteOption: heaviest.option });
    }
    const reported = Number(body.pagination?.total ?? 0);
    if (reported > 0) total = reported;
    nextKey = body.pagination?.next_key || null;
    if (!nextKey) break;
  }

  if (rows.length === 0) {
    throw new ToolError(
      "no_voters",
      `proposal #${proposalIdRaw} has no votes at height ${height}`,
      "check the proposal id, or pass a source.height inside its voting period",
    );
  }
  if (total > 0 && rows.length < total) {
    warnings.push(
      `paged ${rows.length} of ${total} votes the node reported — the snapshot may be short`,
    );
  }
  warnings.push(
    "a gov snapshot carries no stake weight: every voter's weight is their VOTE's weight (~1), so a proportionate split over this source is an equal split. Use mode 'fair'.",
  );

  const result = filterHolders(
    rows,
    [],
    `voters on proposal #${proposalIdRaw} at ${heightSource}`,
    snapshotAt,
    0,
    "vote weight (~1 per wallet — NOT stake)",
    warnings,
  );
  result.snapshotHeight = height;
  return result;
}

// ---------------------------------------------------------------------------

function filterHolders(
  all: SourceRow[],
  extraExclusions: string[],
  description: string,
  snapshotAt: string,
  sourceDecimals: number,
  weightUnit: string,
  warnings: string[] = [],
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
    weightUnit,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
