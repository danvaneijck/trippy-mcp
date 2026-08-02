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
  | "gov_voters"
  | "mito_vault"
  | "buyback_round";

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

export interface MitoVaultSource {
  kind: "mito_vault";
  /** Mito vault contract address. */
  vault: string;
  /** `stake` weights by staked LP only; `non-stake` (default) by total LP held. */
  holderType?: "stake" | "non-stake";
}

export interface BuybackRoundSource {
  kind: "buyback_round";
  /** Community BuyBack round number. Mainnet only. */
  round: number;
}

export type Source =
  | CsvSource
  | TokenHoldersSource
  | LaunchHoldersSource
  | NftHoldersSource
  | GovVotersSource
  | MitoVaultSource
  | BuybackRoundSource;

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

/**
 * Page every holder of a bank denom.
 *
 * Over gRPC-web, not the LCD. The bank module's `DenomOwners` query is not
 * implemented on any public LCD — mainnet or testnet, it answers code 12 "Not
 * Implemented" — so the REST version of this could only ever work against a
 * self-hosted indexed node. The same query over the public gRPC-web gateway
 * answers fine, which is what the Choice backend and the trippytools airdrop
 * UI have always used.
 *
 * Two shape differences from the REST endpoint, both load-bearing: the
 * pagination cursor is `pagination.next` rather than `next_key`, and
 * `pagination.total` comes back as 0, so paging must terminate on the cursor
 * and never on a count.
 */
async function denomOwners(
  grpcUrl: string,
  denom: string,
  decimals: number,
): Promise<{ address: string; weight: number }[]> {
  const { ChainGrpcBankApi } = await import("@injectivelabs/sdk-ts");
  const api = new ChainGrpcBankApi(grpcUrl);

  const out: { address: string; weight: number }[] = [];
  let key: string | undefined;
  // 1000/page against a hard page cap: a denom with >500k holders is not a
  // list any single drop should be built from, and an unbounded loop against a
  // public endpoint is how you get rate-limited mid-snapshot.
  for (let page = 0; page < 500; page++) {
    let res: Awaited<ReturnType<InstanceType<typeof ChainGrpcBankApi>["fetchDenomOwners"]>>;
    try {
      res = await api.fetchDenomOwners(denom, { limit: 1000, key });
    } catch (e) {
      throw new ToolError(
        "holders_query_failed",
        `could not page holders of ${denom}: ${e instanceof Error ? e.message : String(e)}`,
        page === 0 ? "check the denom is exactly as the chain spells it" : undefined,
      );
    }
    for (const o of res.denomOwners ?? []) {
      const raw = BigInt(o.balance?.amount ?? "0");
      if (raw <= 0n) continue;
      out.push({ address: o.address, weight: Number(formatUnits(raw, decimals)) });
    }
    key = res.pagination?.next || undefined;
    if (!key) return out;
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
    const all = await denomOwners(rt.net.grpcUrl, denom, decimals);
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

  if (source.kind === "mito_vault") {
    return mitoVaultHolders(
      rt,
      requireField(raw, "vault", "mito_vault"),
      source.holderType === "stake" ? "stake" : "non-stake",
      snapshotAt,
    );
  }

  if (source.kind === "buyback_round") {
    const round = Number(raw.round);
    if (!Number.isInteger(round) || round < 1) {
      throw new ToolError(
        "bad_input",
        'source.round is required when source.kind is "buyback_round" (the round number)',
      );
    }
    return buybackParticipants(rt, round, snapshotAt);
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
  // NOT `live.bankDenom`.
  //
  // That field is the launch's PAIR/QUOTE denom — `inj` for an INJ-quoted
  // launch, the SAI factory denom for a SAI-quoted one — so snapshotting it
  // targets every holder of the quote asset instead of the launch's own
  // holders. On launch #2 that is every INJ holder on mainnet.
  //
  // The launch token's own denom carries a per-launch salt in its subdenom, so
  // it cannot be derived from the launch fields. It lives on the sink, from
  // token-bind onward — which covers the whole curve phase, and the curve
  // phase is usually the point of snapshotting a launch.
  const sink = evmToInj(live.sink as `0x${string}`);
  const sinkConfig = await smartQuery<{ token_denom?: string }>(
    rt.net.lcdUrl,
    sink,
    { sink_config: {} },
    { errorCode: "no_denom" },
  );
  const tokenDenom = sinkConfig.token_denom;
  if (!tokenDenom) {
    throw new ToolError(
      "no_denom",
      `launch #${launchIdRaw}'s sink did not report a token_denom`,
      "the launch may not be bound yet — wait for the keeper and snapshot again",
    );
  }

  // Launch tokens are always 18-decimal.
  const all = await denomOwners(rt.net.grpcUrl, tokenDenom, 18);
  // The EVM-side contracts hold the token under their bech32 mirror — the same
  // 20 bytes, addressed the way the bank module indexes them.
  const launchOwned = [live.sink, rt.net.addresses.launchpadCore, rt.net.addresses.feeTreasury].map(
    (a) => evmToInj(a as `0x${string}`),
  );
  return filterHolders(
    all,
    launchOwned,
    `holders of launch #${launchIdRaw} (${tokenDenom})`,
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
// Mito vaults
// ---------------------------------------------------------------------------

/** Mito's own staking contract — LP staked here is held on holders' behalf. */
const MITO_STAKING_CONTRACT = "inj1gtze7qm07nky47n7mwgj4zatf2s77xqvh3k2n8";

const MITO_ENDPOINT: Record<string, string> = {
  mainnet: "https://k8s.mainnet.mito.grpc-web.injective.network",
  testnet: "https://k8s.testnet.mito.grpc-web.injective.network",
};

interface MitoHolder {
  holderAddress?: string;
  amount?: string;
  stakedAmount?: string;
}

/**
 * Mito vault LP holders.
 *
 * The one source that does not come from a chain endpoint: LP holdings are
 * indexed by Mito's own service. Passing it the staking contract is what
 * populates each holder's `stakedAmount` and credits staked LP back into the
 * wallet's own `amount`.
 *
 * What it does NOT do — checked against mainnet vaults, 2026-08-02 — is remove
 * the staking contract from the response. It comes back as a holder in its own
 * right, carrying an `amount` equal to the sum of everyone's `stakedAmount`:
 * the same LP, counted twice. On BLACK-INJ-v1 that row was 47% of the total
 * weight. So the thing that keeps a `non-stake` drop from sending half of
 * itself to a keyless contract is the exclusion list (MITO_STAKING_CONTRACT is
 * in NON_WALLET_HOLDERS), not this argument. Remove it from there and the
 * argument alone will not save the drop.
 *
 * `non-stake` weights by `amount`, which already includes staked LP, so it
 * means "total LP held" as documented. `stake` weights by `stakedAmount` alone.
 */
async function mitoVaultHolders(
  rt: Runtime,
  vault: string,
  holderType: "stake" | "non-stake",
  snapshotAt: string,
): Promise<SourceResult> {
  if (!vault.startsWith("inj1")) {
    throw new ToolError("bad_input", `source.vault must be a Mito vault address, got "${vault}"`);
  }
  const endpoint = MITO_ENDPOINT[rt.net.name];
  if (!endpoint) {
    throw new ToolError("unsupported_network", `Mito vaults are not indexed on ${rt.net.name}`);
  }

  const { IndexerGrpcMitoApi } = await import("@injectivelabs/sdk-ts");
  const api = new IndexerGrpcMitoApi(endpoint);

  const holders: MitoHolder[] = [];
  let total = 0;
  for (let page = 0; page < 200; page++) {
    const res = await api
      .fetchLPHolders({
        limit: 100,
        skip: holders.length,
        vaultAddress: vault,
        stakingContractAddress: MITO_STAKING_CONTRACT,
      })
      .catch((e: unknown) => {
        throw new ToolError(
          "mito_query_failed",
          `Mito would not list holders of ${vault}: ${e instanceof Error ? e.message : String(e)}`,
          "check the vault address — it is the vault contract, not its LP denom",
        );
      });
    const batch = (res.holders ?? []) as MitoHolder[];
    if (batch.length === 0) break;
    holders.push(...batch);
    total = Number(res.pagination?.total ?? 0);
    if (total > 0 && holders.length >= total) break;
  }

  if (holders.length === 0) {
    throw new ToolError("no_holders", `Mito reports no LP holders for vault ${vault}`);
  }

  // Mito LP is a tokenfactory denom minted at 18 decimals. Scaling here is what
  // makes filters.minWeight mean "1 LP token" rather than "1 wei of one"; the
  // relative weights are unaffected either way.
  const rows = holders
    .filter((h) => typeof h.holderAddress === "string" && h.holderAddress.startsWith("inj1"))
    .map((h) => ({
      address: h.holderAddress as string,
      weight: Number(
        formatUnits(BigInt((holderType === "stake" ? h.stakedAmount : h.amount) ?? "0"), 18),
      ),
    }))
    .filter((r) => r.weight > 0);

  if (rows.length === 0) {
    throw new ToolError(
      "no_holders",
      `no wallet holds ${holderType === "stake" ? "STAKED " : ""}LP in vault ${vault}`,
      holderType === "stake" ? "try holderType 'non-stake' to include unstaked LP" : undefined,
    );
  }

  return filterHolders(
    rows,
    [],
    `${holderType === "stake" ? "stakers" : "LP holders"} of Mito vault ${vault}`,
    snapshotAt,
    18,
    "whole LP tokens",
  );
}

// ---------------------------------------------------------------------------
// Community BuyBack
// ---------------------------------------------------------------------------

/** The Injective Community BuyBack auction contract (mainnet only). */
const BUYBACK_CONTRACT = "inj10n78w79xhxmytnuhjcck633nj4e7hrqaglgnfz";
/** cw-storage-plus namespace of its participants map. */
const BUYBACK_NS = "user_round_info";

/**
 * Everyone who committed INJ in a buyback round, weighted by how much.
 *
 * The contract has no "list participants" query, so this walks its raw state:
 * participants live in a `Map<(u64 round_id, Addr), UserRoundInfo>` whose values
 * already carry the wallet, the round and the deposit — no key parsing needed,
 * only a start key crafted so paging begins at this round's first entry.
 *
 * The subtlety worth keeping: whitelisting a wallet writes a row with deposit
 * ZERO, so a round can hold thousands of reservations against a couple of
 * hundred actual committers. Only deposit > 0 rows count, and the round's own
 * `total_deposit` (read here rather than asked of the caller) is used to stop
 * early the moment every committed INJ is accounted for — which also means the
 * currently-open round, with a huge whitelist and nothing committed, costs one
 * query rather than five hundred.
 */
async function buybackParticipants(
  rt: Runtime,
  round: number,
  snapshotAt: string,
): Promise<SourceResult> {
  if (rt.net.name !== "mainnet") {
    throw new ToolError(
      "unsupported_network",
      "the Community BuyBack contract only exists on mainnet",
    );
  }
  const lcd = rt.net.lcdUrl;

  const info = await smartQuery<{ total_deposit?: string; id?: unknown }>(
    lcd,
    BUYBACK_CONTRACT,
    { get_round_info: { round_id: round } },
    { errorCode: "no_such_round", attempts: 3 },
  ).catch(() => null);
  if (info === null || info.id === undefined) {
    throw new ToolError("no_such_round", `buyback round ${round} does not exist`);
  }
  const expectedTotalInj = Number(info.total_deposit ?? 0) / 1e18;
  if (!(expectedTotalInj > 0)) {
    throw new ToolError(
      "round_empty",
      `buyback round ${round} has no committed INJ`,
      "an open round holds only whitelist reservations until people bid — snapshot a completed round",
    );
  }

  // start key = 0x00 <len> "user_round_info" 0x00 0x08 <round: u64 big-endian>
  const ns = mapPrefix(BUYBACK_NS);
  const startKey = new Uint8Array(ns.length + 2 + 8);
  startKey.set(ns, 0);
  startKey[ns.length] = 0;
  startKey[ns.length + 1] = 8;
  new DataView(startKey.buffer).setBigUint64(ns.length + 2, BigInt(round), false);

  const rows: { address: string; weight: number }[] = [];
  let committed = 0;
  let pageKey: Uint8Array | string | null = startKey;

  for (let page = 0; page < 500; page++) {
    const { models, nextKey } = await contractStatePage(lcd, BUYBACK_CONTRACT, pageKey, 100);
    if (models.length === 0) break;
    let done = false;
    for (const m of models) {
      if (!startsWith(m.key, ns)) {
        done = true; // walked out of the participants map entirely
        break;
      }
      let v: { round_id?: unknown; wallet?: unknown; deposit?: unknown };
      try {
        v = JSON.parse(Buffer.from(m.value).toString("utf8")) as typeof v;
      } catch {
        continue;
      }
      if (typeof v.round_id !== "number" || typeof v.wallet !== "string") continue;
      if (v.round_id > round) {
        done = true; // crossed into a later round
        break;
      }
      if (v.round_id !== round) continue;
      const deposit = Number(v.deposit ?? 0) / 1e18;
      if (deposit > 0) {
        rows.push({ address: v.wallet, weight: deposit });
        committed += deposit;
      }
    }
    // Every committed INJ accounted for — the rest of the round is whitelist.
    if (committed >= expectedTotalInj - 1e-6) done = true;
    if (done || !nextKey) break;
    pageKey = nextKey;
  }

  if (rows.length === 0) {
    throw new ToolError("no_participants", `no wallet committed INJ in buyback round ${round}`);
  }

  const warnings: string[] = [];
  if (committed < expectedTotalInj - 1e-6) {
    warnings.push(
      `found ${committed.toFixed(4)} of the ${expectedTotalInj.toFixed(4)} INJ this round reports committed — the participant scan may be short`,
    );
  }

  return filterHolders(
    rows,
    [],
    `participants in Community BuyBack round ${round} (${expectedTotalInj.toFixed(2)} INJ committed)`,
    snapshotAt,
    18,
    "INJ committed to the round",
    warnings,
  );
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
