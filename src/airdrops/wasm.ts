/**
 * CosmWasm reads over LCD: smart queries and raw contract-state paging.
 *
 * Everything here is plain `fetch` against the REST endpoint rather than
 * gRPC-web. The site's versions of these snapshots run on `ChainGrpcWasmApi`
 * and a `CosmWasmClient`; this package deliberately adds no transport it did
 * not already have, and LCD covers both shapes of read:
 *
 *  - `/smart/<b64 query>` for anything the contract exposes as a query, and
 *  - `/state?pagination.key=…` for the raw key/value pairs, which is the ONLY
 *    way to enumerate a cw-storage-plus `Map` that has no "list" query — the
 *    CW404 balance map and the buyback participants map are both like that.
 *
 * Retry is not optional here. Enumerating a collection is hundreds of
 * sequential paginated calls against a public endpoint that rate-limits under
 * that kind of burst, and giving up halfway does not produce a short list — it
 * produces a WRONG list, which then gets allocated and frozen into a merkle
 * root. Every call in this module retries with backoff for that reason.
 */

import { ToolError } from "../errors.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RetryOpts {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Base backoff in ms; doubles per attempt, capped at 8s. */
  backoffMs?: number;
  /** Error code for the ToolError raised once attempts run out. */
  errorCode?: string;
  /** Extra request headers — `x-cosmos-block-height` for at-height reads. */
  headers?: Record<string, string>;
}

/**
 * GET some JSON, retrying transient failures.
 *
 * A 4xx that is not 429 is NOT retried: a bad contract address or a query the
 * contract does not implement fails the same way ten times in a row, and the
 * agent should hear about it in a second rather than in a minute.
 */
export async function lcdGetJson<T>(url: string, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const backoff = opts.backoffMs ?? 500;
  let last = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    let status = 0;
    try {
      const res = await fetch(url, opts.headers ? { headers: opts.headers } : undefined);
      status = res.status;
      if (res.ok) return (await res.json()) as T;
      last = `HTTP ${res.status}`;
      if (status >= 400 && status < 500 && status !== 429) break;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt < attempts - 1) await sleep(Math.min(8_000, backoff * 2 ** attempt));
  }
  throw new ToolError(opts.errorCode ?? "lcd_error", `${url.split("?")[0]} failed: ${last}`);
}

const base = (lcdUrl: string): string => lcdUrl.replace(/\/$/, "");

/** Smart-query a contract. `query` is the JSON message, base64'd by us. */
export async function smartQuery<T>(
  lcdUrl: string,
  contract: string,
  query: object,
  opts: RetryOpts = {},
): Promise<T> {
  const encoded = Buffer.from(JSON.stringify(query)).toString("base64");
  const url = `${base(lcdUrl)}/cosmwasm/wasm/v1/contract/${contract}/smart/${encodeURIComponent(encoded)}`;
  const body = await lcdGetJson<{ data?: T }>(url, {
    errorCode: "contract_query_failed",
    ...opts,
  });
  if (body.data === undefined) {
    throw new ToolError(opts.errorCode ?? "contract_query_failed", `${contract} returned no data`);
  }
  return body.data;
}

// ---- raw state ------------------------------------------------------------

export interface StateModel {
  /** Raw key bytes (the endpoint hands them back hex-encoded). */
  key: Uint8Array;
  /** Raw value bytes — usually UTF-8 JSON. */
  value: Uint8Array;
}

export interface StatePage {
  models: StateModel[];
  /** Base64 pagination key for the next page, or null at the end. */
  nextKey: string | null;
}

export const bytesToB64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
export const b64ToBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

export function startsWith(value: Uint8Array, prefix: Uint8Array): boolean {
  if (value.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (value[i] !== prefix[i]) return false;
  return true;
}

/**
 * The cw-storage-plus prefix every entry of a `Map<_, _>` shares:
 * `0x00 <namespace length> <namespace bytes>`.
 *
 * Building this ourselves is what lets a scan START at the map instead of at
 * the contract's first key — the difference between three pages and three
 * hundred on a contract whose interesting map sits late in the keyspace.
 */
export function mapPrefix(namespace: string): Uint8Array {
  const ns = new TextEncoder().encode(namespace);
  const out = new Uint8Array(2 + ns.length);
  out[0] = 0;
  out[1] = ns.length;
  out.set(ns, 2);
  return out;
}

/**
 * The state endpoint marshals model keys as HexBytes (an uppercase hex string),
 * while values and the pagination key are base64. Nothing in the response says
 * which, so the encoding is sniffed: a hex string is even-length and drawn from
 * [0-9a-fA-F] only, and these keys always begin with a 0x00 length-prefixed
 * namespace whose base64 form ("AAdiYWxhbmNl…") contains characters outside
 * that set. A node that switched to base64 keys therefore still decodes.
 */
function decodeKey(raw: string): Uint8Array {
  if (raw.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(raw)) {
    return new Uint8Array(Buffer.from(raw, "hex"));
  }
  return b64ToBytes(raw);
}

/** One page of a contract's raw state, starting at `startKey` (raw bytes). */
export async function contractStatePage(
  lcdUrl: string,
  contract: string,
  startKey: Uint8Array | string | null,
  limit = 100,
): Promise<StatePage> {
  const params = new URLSearchParams({ "pagination.limit": String(limit) });
  if (startKey) {
    params.set("pagination.key", typeof startKey === "string" ? startKey : bytesToB64(startKey));
  }
  const url = `${base(lcdUrl)}/cosmwasm/wasm/v1/contract/${contract}/state?${params}`;
  const body = await lcdGetJson<{
    models?: { key?: string; value?: string }[];
    pagination?: { next_key?: string | null };
  }>(url, { errorCode: "contract_state_failed" });
  return {
    models: (body.models ?? []).map((m) => ({
      key: decodeKey(m.key ?? ""),
      value: b64ToBytes(m.value ?? ""),
    })),
    nextKey: body.pagination?.next_key || null,
  };
}
