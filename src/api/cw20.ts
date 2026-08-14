/**
 * CW20 reads.
 *
 * Choice hands out CW20 contract addresses as token ids — SHROOM itself is one
 * — and a CW20 position is not bank state. It lives in the token contract, so
 * `bankBalances` reports 0 for it and `denomDecimals` finds no metadata, which
 * is why `sell(amount:"all")` used to refuse the project's own flagship token
 * and `quote` explained that refusal as the chain not publishing decimals. Both
 * numbers exist; they just have to be asked of the contract that holds them.
 *
 * The swap itself always worked: Choice routes CW20 input via `is_cw20_input`.
 * Only the sizing and the pre-trade check were reading the wrong place.
 */

import { smartQuery } from "../airdrops/wasm.js";
import { ToolError } from "../errors.js";

/**
 * A Choice token id that is a CW20 contract rather than a bank denom.
 *
 * Bank denoms on Injective are `inj`, `peggy0x…`, `erc20:0x…`, `factory/…` or
 * `ibc/…` — none of which are bech32 account addresses. So a bare `inj1…` id is
 * a contract, and the only thing that can answer for its balance.
 */
export function isCw20Id(tokenId: string): boolean {
  return /^inj1[02-9ac-hj-np-z]{38}$/.test(tokenId);
}

export interface Cw20Info {
  decimals: number;
  symbol: string | null;
}

export async function cw20TokenInfo(lcdUrl: string, contract: string): Promise<Cw20Info> {
  const info = await smartQuery<{ decimals?: number; symbol?: string }>(
    lcdUrl,
    contract,
    { token_info: {} },
    { errorCode: "cw20_query_failed" },
  );
  if (typeof info.decimals !== "number") {
    throw new ToolError("cw20_query_failed", `${contract} did not report token_info.decimals`);
  }
  return { decimals: info.decimals, symbol: info.symbol ?? null };
}

export async function cw20Balance(
  lcdUrl: string,
  contract: string,
  injAddress: string,
): Promise<bigint> {
  const res = await smartQuery<{ balance?: string }>(
    lcdUrl,
    contract,
    { balance: { address: injAddress } },
    { errorCode: "cw20_query_failed" },
  );
  return BigInt(res.balance ?? "0");
}
