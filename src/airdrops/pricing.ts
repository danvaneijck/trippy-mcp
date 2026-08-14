/**
 * Valuing and denominating a drop.
 *
 * Shared by both rails, and it is the module the policy cap depends on, so the
 * two rules it exists to hold are worth stating: decimals are resolved
 * registry-first, and an asset that cannot be priced returns null rather than
 * something optimistic.
 */

import { balanceOf, bankBalances, denomDecimals } from "../api/lcd.js";
import { ToolError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import { fromBaseUnits } from "./units.js";

/** An exponent supplied by the operator, or recorded on a campaign at creation. */
export function statedDecimals(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30
    ? value
    : null;
}

/**
 * Decimals of an asset, or null when no source knows.
 *
 * In order: what the caller stated, the vendored registry, then chain metadata.
 * The stated value wins because 1,483 of mainnet's 3,497 denoms publish
 * `decimals: 0` with no populated `denom_units` — Injective's "never filled
 * in", indistinguishable from a real 0 — so for a large slice of the chain an
 * operator who knows the exponent is the only source there is.
 */
export async function knownDecimals(
  rt: Runtime,
  denom: string,
  stated?: unknown,
): Promise<number | null> {
  const said = statedDecimals(stated);
  if (said !== null) return said;
  const known = Object.values(rt.net.quoteAssets).find((q) => q.bankDenom === denom);
  if (known) return known.decimals;
  return denomDecimals(rt.net.lcdUrl, denom);
}

/**
 * Decimals for SIZING a drop — same resolution, but null is a hard stop.
 *
 * A wrong exponent here does not fail, it silently builds a drop off by a
 * factor of a trillion and funds it. Refusing costs an operator one explicit
 * answer; guessing costs them the campaign.
 */
export async function dropDecimals(rt: Runtime, denom: string, stated?: unknown): Promise<number> {
  const decimals = await knownDecimals(rt, denom, stated);
  if (decimals === null) {
    throw new ToolError(
      "unknown_decimals",
      `no decimals published for ${denom}, so a drop of it cannot be sized`,
      "pass assetDecimals with the token's exponent (most Injective tokens are 18, USDC/USDT are 6) — many factory denoms carry no usable bank metadata, so stating it is the only way",
    );
  }
  return decimals;
}

/** Whole tokens when the exponent is known, else an explicit base-unit figure. */
export function amountText(base: string, decimals: number | null, denom: string): string {
  return decimals === null
    ? `${base} base units of ${denom} (no decimals published for it)`
    : `${fromBaseUnits(base, decimals)} ${denom}`;
}

/**
 * The bare quantity, for fields that carry the denom separately.
 *
 * Unknown returns base units, which is why every caller must also say that the
 * exponent is unknown — otherwise the two cases are the same string and a
 * reader cannot tell 1000 tokens from 1000 base units of one.
 */
export function quantityText(base: string, decimals: number | null): string {
  return decimals === null ? base : fromBaseUnits(base, decimals);
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

/**
 * Find the hash of a send this wallet made at a known account sequence.
 *
 * The push rail can confirm that a lost broadcast LANDED — the probe recipient
 * was paid — while never having been told the hash, because the client died or
 * gave up before the broadcaster returned one. That leaves recipients who are
 * genuinely paid and a history row with nothing to point at.
 *
 * The sequence is what makes the lookup exact rather than a guess: a
 * transaction is valid at exactly one sequence, so at most one SUCCESSFUL
 * transaction from this signer can carry it. The probe check on top is
 * belt-and-braces for the case the caller is wrong about the verdict — if that
 * sequence was actually consumed by some other transaction, this returns null
 * rather than attributing a stranger's hash to the drop.
 *
 * Best-effort by contract: a missing hash costs a link in the audit row, and is
 * never a reason to resend anything.
 */
export async function findTxHashAtSequence(
  rt: Runtime,
  sequence: number | null,
  paidTo: string,
): Promise<string | null> {
  if (sequence === null) return null;
  try {
    const base = rt.net.lcdUrl.replace(/\/$/, "");
    const query = encodeURIComponent(`message.sender='${rt.injAddress}'`);
    const res = await fetch(
      `${base}/cosmos/tx/v1beta1/txs?query=${query}&order_by=ORDER_BY_DESC&pagination.limit=20`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      tx_responses?: {
        txhash?: string;
        code?: number;
        tx?: {
          auth_info?: { signer_infos?: { sequence?: string }[] };
          body?: { messages?: { "@type"?: string; outputs?: { address?: string }[] }[] };
        };
      }[];
    };
    for (const r of body.tx_responses ?? []) {
      if (r.code !== 0) continue;
      const signed = (r.tx?.auth_info?.signer_infos ?? []).some(
        (s) => Number(s.sequence) === sequence,
      );
      if (!signed) continue;
      const paysProbe = (r.tx?.body?.messages ?? []).some(
        (m) =>
          typeof m["@type"] === "string" &&
          m["@type"].endsWith("MsgMultiSend") &&
          (m.outputs ?? []).some((o) => o.address === paidTo),
      );
      if (paysProbe && typeof r.txhash === "string") return r.txhash;
    }
    return null;
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
