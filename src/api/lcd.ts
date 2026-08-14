/**
 * Cosmos LCD reads. Balance display always comes from the bank module — never
 * `eth_getBalance`, which can return 0 on Injective's EVM RPC even when the
 * account is funded (the transport shim in chain/transport.ts covers the
 * write-path preflight; this covers the read path).
 */

import { ToolError } from "../errors.js";

export interface BankBalance {
  denom: string;
  amount: string;
}

export async function bankBalances(lcdUrl: string, injAddress: string): Promise<BankBalance[]> {
  const url = `${lcdUrl.replace(/\/$/, "")}/cosmos/bank/v1beta1/balances/${injAddress}?pagination.limit=200`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new ToolError("lcd_error", `LCD balance query failed (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { balances?: BankBalance[] };
  return body.balances ?? [];
}

export function balanceOf(balances: BankBalance[], denom: string): bigint {
  const hit = balances.find((b) => b.denom === denom);
  return hit ? BigInt(hit.amount) : 0n;
}

interface DenomMeta {
  base?: string;
  decimals?: number;
  denom_units?: { exponent?: number }[];
}

/**
 * Keyed `lcdUrl|denom`, and POSITIVE answers only.
 *
 * A denom's exponent is immutable, so a number is safe to keep forever. A miss
 * is not: every launch mints a new factory denom, so "the chain says nothing
 * about this" is a statement about when we last looked, not about the denom.
 * Caching that would strand each new token as unpriceable for the life of the
 * process.
 */
const decimalsCache = new Map<string, number>();

/** How long a fetched metadata list is trusted before a miss re-reads it. */
const CATALOGUE_TTL_MS = 10 * 60 * 1000;

const catalogues = new Map<string, { at: number; map: Promise<Map<string, number>> }>();

/**
 * The exponent a metadata entry actually pins down, or null when it pins none.
 *
 * `decimals: 0` alongside a lone exponent-0 unit is Injective's "never filled
 * in", not a genuine 0-decimal token, so it reads as unknown. That direction is
 * deliberate: guessing 18 for a 6-decimal denom under-reports by 1e12, but
 * guessing 0 over-reports by 1e18, and only one of those can overdraw a wallet.
 */
function exponentOf(meta: DenomMeta): number | null {
  if (typeof meta.decimals === "number" && meta.decimals > 0) return meta.decimals;
  const fromUnits = Math.max(0, ...(meta.denom_units ?? []).map((u) => u.exponent ?? 0));
  return fromUnits > 0 ? fromUnits : null;
}

/**
 * Every denom the chain publishes metadata for, in one shot.
 *
 * This exists because the per-denom route does not work for the denoms that
 * matter — see `denomDecimals`. Mainnet answers in a single ~1.4 MB page today;
 * the loop is here because the page cap is the node's call, not ours.
 */
async function fetchCatalogue(lcdUrl: string): Promise<Map<string, number>> {
  const base = `${lcdUrl.replace(/\/$/, "")}/cosmos/bank/v1beta1/denoms_metadata`;
  const out = new Map<string, number>();
  let key: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const url = `${base}?pagination.limit=2000${key ? `&pagination.key=${encodeURIComponent(key)}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new ToolError("lcd_error", `LCD denom metadata query failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as {
      metadatas?: DenomMeta[];
      pagination?: { next_key?: string | null };
    };
    for (const meta of body.metadatas ?? []) {
      const exp = exponentOf(meta);
      if (meta.base && exp !== null) out.set(meta.base, exp);
    }
    key = body.pagination?.next_key ?? null;
    if (!key) break;
  }
  return out;
}

async function lookupDecimals(lcdUrl: string, denom: string): Promise<number | null> {
  // `denoms_metadata/{denom}` is ONE path segment. The gateway percent-decodes
  // before it routes, so the `/` inside `factory/…` and `ibc/…` splits the
  // segment, the route stops matching and the node answers 501 — for 3,048 of
  // mainnet's 3,497 denoms. Spending a request to confirm that is pointless.
  if (!denom.includes("/")) {
    try {
      const url = `${lcdUrl.replace(/\/$/, "")}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`;
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { metadata?: DenomMeta };
        const exp = body.metadata ? exponentOf(body.metadata) : null;
        if (exp !== null) return exp;
      }
    } catch {
      // fall through to the catalogue
    }
  }
  return (await catalogueFor(lcdUrl)).get(denom) ?? null;
}

function catalogueFor(lcdUrl: string): Promise<Map<string, number>> {
  const hit = catalogues.get(lcdUrl);
  if (hit && Date.now() - hit.at < CATALOGUE_TTL_MS) return hit.map;
  const entry = { at: Date.now(), map: fetchCatalogue(lcdUrl) };
  // A rejected fetch must not become the cached answer.
  void entry.map.catch(() => {
    if (catalogues.get(lcdUrl) === entry) catalogues.delete(lcdUrl);
  });
  catalogues.set(lcdUrl, entry);
  return entry.map;
}

/**
 * Base-unit decimals for a bank denom, or `null` when the chain does not say.
 *
 * Null rather than a fallback, because the fallback was the bug: this used to
 * answer 18 whenever the metadata read missed, and the read missed for every
 * `factory/…` and `ibc/…` denom on the network — 1,223 of which are not
 * 18-decimal. A silent 18 is not a display nit. `sell(amount:"all")` converts a
 * bank balance to human units with this number, so on a 6-decimal denom it
 * offered a trillionth of the position: small holdings failed with a confusing
 * "rounds to zero", and holdings over ~1e6 tokens quietly SOLD that trillionth
 * and reported success. Callers now have to say what they want to do about not
 * knowing, and the money paths refuse.
 */
export async function denomDecimals(lcdUrl: string, denom: string): Promise<number | null> {
  if (denom === "inj") return 18;
  const key = `${lcdUrl}|${denom}`;
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  let answer: number | null;
  try {
    answer = await lookupDecimals(lcdUrl, denom);
  } catch {
    // Transient — leave it uncached so the next call gets another go, rather
    // than pinning the denom to "unknown" for the life of the process.
    return null;
  }
  if (answer !== null) decimalsCache.set(key, answer);
  return answer;
}
