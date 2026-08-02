/**
 * Valuing and denominating a drop.
 *
 * Shared by both rails, and it is the module the policy cap depends on, so the
 * two rules it exists to hold are worth stating: decimals are resolved
 * registry-first, and an asset that cannot be priced returns null rather than
 * something optimistic.
 */

import { balanceOf, bankBalances, denomDecimals } from "../api/lcd.js";
import type { Runtime } from "../runtime.js";

/**
 * Decimals of the asset being dropped.
 *
 * The vendored registry wins over LCD metadata for the quote assets, because
 * `denomDecimals` falls back to 18 when metadata is missing and USDC is 6 — a
 * wrong exponent here does not fail, it silently builds a drop off by a factor
 * of a trillion and funds it.
 */
export async function dropDecimals(rt: Runtime, denom: string): Promise<number> {
  const known = Object.values(rt.net.quoteAssets).find((q) => q.bankDenom === denom);
  return known ? known.decimals : denomDecimals(rt.net.lcdUrl, denom);
}

export async function denomSymbol(rt: Runtime, denom: string): Promise<string | null> {
  const known = Object.values(rt.net.quoteAssets).find((q) => q.bankDenom === denom);
  if (known) return known.symbol;
  try {
    const payload = await rt.choiceApi.token(denom);
    const s = (payload as { symbol?: unknown }).symbol;
    return typeof s === "string" && s.length > 0 && s.length < 32 ? s : null;
  } catch {
    return null;
  }
}

export async function denomBalance(rt: Runtime, denom: string): Promise<bigint | null> {
  try {
    return balanceOf(await bankBalances(rt.net.lcdUrl, rt.injAddress), denom);
  } catch {
    return null;
  }
}

/**
 * USD value of an amount of `denom`. This is the number the policy cap is
 * applied to, so it is never allowed to be optimistic: an asset we cannot price
 * returns null, and null is refused rather than waved through.
 */
export async function usdValue(
  rt: Runtime,
  denom: string,
  amountWhole: string,
): Promise<number | null> {
  const amount = Number(amountWhole);
  if (!Number.isFinite(amount)) return null;

  const known = Object.values(rt.net.quoteAssets).find((q) => q.bankDenom === denom);
  if (known) {
    const unit = await rt.shroom.usdValue(known.slot, 10n ** BigInt(known.decimals));
    return unit === null ? null : unit * amount;
  }
  try {
    const { extractUsdPrice } = await import("../venues/choice/swap.js");
    const price = extractUsdPrice(await rt.choiceApi.token(denom));
    return price === null ? null : price * amount;
  } catch {
    return null;
  }
}

/**
 * The agent wallet's account sequence.
 *
 * Read by the push rail, and only for one purpose: a signed transaction is
 * valid at exactly ONE sequence number, so a sequence that has moved past the
 * one a transaction was signed at proves that transaction can never land. That
 * is the only rigorous way to tell "the broadcast failed" from "the client gave
 * up waiting while it sat in the mempool", and the two need opposite responses.
 */
export async function accountSequence(rt: Runtime): Promise<number | null> {
  try {
    const url = `${rt.net.lcdUrl.replace(/\/$/, "")}/cosmos/auth/v1beta1/accounts/${rt.injAddress}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      account?: { sequence?: string; base_account?: { sequence?: string } };
    };
    // Injective accounts are EthAccount, which nests the base account; plain
    // BaseAccounts carry it at the top level.
    const raw = body.account?.base_account?.sequence ?? body.account?.sequence;
    const seq = Number(raw);
    return Number.isInteger(seq) && seq >= 0 ? seq : null;
  } catch {
    return null;
  }
}

/** Bank balance of `denom` held by an arbitrary address. */
export async function balanceOfAddress(
  rt: Runtime,
  address: string,
  denom: string,
): Promise<bigint | null> {
  try {
    const url = `${rt.net.lcdUrl.replace(/\/$/, "")}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { balance?: { amount?: string } };
    return BigInt(body.balance?.amount ?? "0");
  } catch {
    return null;
  }
}
