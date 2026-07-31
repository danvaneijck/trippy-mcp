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

const decimalsCache = new Map<string, number>();

/**
 * Base-unit decimals for a bank denom via LCD denom metadata (present for
 * peggy/factory/erc20 denoms on Injective). Falls back to 18 — callers that
 * can't tolerate a wrong guess should ask for an explicit amount instead.
 */
export async function denomDecimals(lcdUrl: string, denom: string): Promise<number> {
  if (denom === "inj") return 18;
  const cached = decimalsCache.get(denom);
  if (cached !== undefined) return cached;
  try {
    const url = `${lcdUrl.replace(/\/$/, "")}/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`;
    const res = await fetch(url);
    if (!res.ok) return 18;
    const body = (await res.json()) as {
      metadata?: { decimals?: number; denom_units?: { exponent?: number }[] };
    };
    const meta = body.metadata;
    const fromField = meta?.decimals;
    const fromUnits = Math.max(0, ...(meta?.denom_units ?? []).map((u) => u.exponent ?? 0));
    const dec =
      typeof fromField === "number" && fromField > 0 ? fromField : fromUnits > 0 ? fromUnits : 18;
    decimalsCache.set(denom, dec);
    return dec;
  } catch {
    return 18;
  }
}
