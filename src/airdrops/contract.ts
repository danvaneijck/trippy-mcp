/**
 * The `choice-claim-drops` contract: message shapes, reads, and the funding
 * arithmetic that has to match the contract's own to the base unit.
 *
 * Message shapes mirror `contracts/choice_claim_drops/src/msg.rs::ExecuteMsg`.
 * Reads go over LCD smart queries rather than gRPC so the airdrop path adds no
 * transport this package did not already have.
 */

import { ToolError } from "../errors.js";

export interface ContractConfig {
  owner: string;
  pending_owner: string | null;
  fee_bps: number;
  fee_collector: string;
  paused: boolean;
}

export interface Campaign {
  creator: string;
  keeper: string | null;
  streaming: boolean;
  denom: string;
  /** JSON string written by the creator: { title, symbol, decimals, … }. */
  meta: string;
  leaves_uri: string;
  root: string | null;
  total: string;
  claimed_total: string;
  claimants: number;
  frozen: boolean;
  /** Nanosecond decimal string, or null for a perpetual campaign. */
  expiry: string | null;
  paused: boolean;
  swept: boolean;
}

export interface CampaignResponse {
  id: number;
  campaign: Campaign;
  remaining: string;
}

/** ceil(total * fee_bps / 10_000) — mirrors the contract's `ceil_fee`. */
export function ceilFee(total: string, feeBps: number): string {
  if (feeBps <= 0) return "0";
  const t = BigInt(total);
  if (t === 0n) return "0";
  return ((t * BigInt(feeBps) + 9_999n) / 10_000n).toString();
}

/** Exact funds to attach when publishing `total`: total + ceil platform fee. */
export function fundingRequired(total: string, feeBps: number): string {
  return (BigInt(total) + BigInt(ceilFee(total, feeBps))).toString();
}

const NANOS_PER_SEC = 1_000_000_000n;

export const secondsToNanos = (seconds: number): string =>
  (BigInt(Math.floor(seconds)) * NANOS_PER_SEC).toString();

export const nanosToIso = (nanos: string): string =>
  new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();

export const leavesUriForRoot = (leavesBase: string, rootHex: string): string =>
  `${leavesBase.replace(/\/$/, "")}/${rootHex}.json`;

/**
 * The one-shot create message: published, funded and auto-frozen in a single
 * transaction (`streaming: false`).
 *
 * `leaves_uri` is content-addressed by root, so it is known before broadcast —
 * there is no id chicken-and-egg to resolve first.
 */
export function createOneShotDropMsg(p: {
  denom: string;
  /** JSON string: { title, symbol, decimals, description?, createdBy? }. */
  meta: string;
  rootHex: string;
  total: string;
  leavesUri: string;
  /** Nanosecond decimal string; null for a perpetual (un-clawbackable) drop. */
  expiryNanos: string | null;
  /**
   * The INSTANCE's fee_bps, read live from its Config. Both deployed instances
   * are 0, but the attached funds must equal total + ceil(fee) exactly or the
   * contract's solvency check rejects the campaign — so this is read, never
   * assumed.
   */
  feeBps: number;
}): { msg: object; funds: { denom: string; amount: string } } {
  return {
    msg: {
      create_campaign: {
        denom: p.denom,
        meta: p.meta,
        keeper: null,
        expiry: p.expiryNanos,
        streaming: false,
        initial: { root: p.rootHex, total: p.total, leaves_uri: p.leavesUri },
      },
    },
    funds: { denom: p.denom, amount: fundingRequired(p.total, p.feeBps) },
  };
}

// ---- reads ----------------------------------------------------------------

async function smartQuery<T>(lcdUrl: string, contract: string, query: object): Promise<T> {
  const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
  const url = `${lcdUrl.replace(/\/$/, "")}/cosmwasm/wasm/v1/contract/${contract}/smart/${encodeURIComponent(encoded)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new ToolError(
      "claim_drops_query_failed",
      `claim-drops query failed (HTTP ${res.status})`,
    );
  }
  const body = (await res.json()) as { data?: T };
  if (body.data === undefined) {
    throw new ToolError("claim_drops_query_failed", "claim-drops query returned no data");
  }
  return body.data;
}

export const queryContractConfig = (lcdUrl: string, contract: string): Promise<ContractConfig> =>
  smartQuery<ContractConfig>(lcdUrl, contract, { config: {} });

export const queryCampaign = (
  lcdUrl: string,
  contract: string,
  id: number,
): Promise<CampaignResponse> => smartQuery<CampaignResponse>(lcdUrl, contract, { campaign: { id } });

export const queryCampaignsByCreator = (
  lcdUrl: string,
  contract: string,
  creator: string,
  startAfter?: number,
  limit = 100,
): Promise<CampaignResponse[]> =>
  smartQuery<CampaignResponse[]>(lcdUrl, contract, {
    campaigns_by_creator: { creator, start_after: startAfter ?? null, limit },
  });

/**
 * Which of this creator's campaigns carries `rootHex`.
 *
 * The fallback for when the create tx response carries no usable events. Pages
 * ascending and keeps the HIGHEST match, so re-publishing an identical tree
 * resolves to the newest campaign rather than an older one with the same root.
 */
export async function findCampaignIdByRoot(
  lcdUrl: string,
  contract: string,
  creator: string,
  rootHex: string,
): Promise<number | null> {
  let startAfter: number | undefined;
  let found: number | null = null;
  for (let page = 0; page < 25; page++) {
    const batch = await queryCampaignsByCreator(lcdUrl, contract, creator, startAfter, 100);
    if (batch.length === 0) break;
    for (const entry of batch) {
      if (entry.campaign.root?.toLowerCase() === rootHex.toLowerCase()) found = entry.id;
    }
    if (batch.length < 100) break;
    startAfter = batch[batch.length - 1]!.id;
  }
  return found;
}

// ---- tx response parsing --------------------------------------------------

interface TxEvent {
  type?: string;
  attributes?: { key?: string; value?: string }[];
}

/**
 * Pull the new campaign's id out of the create tx.
 *
 * The id IS the /claim/<id> link, so it is worth getting right. The contract
 * also returns it as the message's `set_data`, but decoding a `TxMsgData`
 * protobuf is a lot of machinery for a number that is emitted twice as an
 * event attribute.
 */
export function parseCampaignId(result: unknown): number | null {
  const res = result as { events?: unknown; rawLog?: string } | null | undefined;
  let events = res?.events;
  if (!Array.isArray(events) && res?.rawLog) {
    try {
      events = (JSON.parse(res.rawLog) as { events?: unknown }[])[0]?.events;
    } catch {
      events = undefined;
    }
  }
  if (!Array.isArray(events)) return null;
  const typed = events as TxEvent[];

  // `Event::new("update_root")` surfaces as `wasm-update_root` and only fires
  // on a publish, so its id is unambiguous.
  for (const event of typed) {
    if (event.type !== "wasm-update_root") continue;
    const id = Number(event.attributes?.find((a) => a.key === "id")?.value);
    if (Number.isInteger(id) && id > 0) return id;
  }

  // Otherwise walk the `wasm` attributes in order: the `id` following
  // `action=create_campaign` belongs to that call.
  for (const event of typed) {
    if (event.type !== "wasm") continue;
    let sawCreate = false;
    for (const a of event.attributes ?? []) {
      if (a.key === "action") sawCreate = a.value === "create_campaign";
      else if (sawCreate && a.key === "id") {
        const id = Number(a.value);
        if (Number.isInteger(id) && id > 0) return id;
      }
    }
  }
  return null;
}
