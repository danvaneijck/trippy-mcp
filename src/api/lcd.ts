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
