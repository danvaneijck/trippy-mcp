/**
 * Choice venue — swaps any Injective token pair through the Choice
 * aggregation contract. Quote comes from the SOR (`POST /api/quote`) as a
 * ready-to-broadcast MsgExecuteContract; we sign it Cosmos-side with the SAME
 * secp256k1 key the EVM leg uses (the inj address is the bech32 of the same
 * 20 bytes) via MsgBroadcasterWithPk — direct proto sign, simulate-first,
 * mirroring trippy_terminal/src/wallet/autosign/broadcaster.ts.
 *
 * @injectivelabs/sdk-ts is heavy, so it is imported lazily — pure curve
 * usage never loads it.
 *
 * Policy: the only contract a swap may execute is the network's Choice
 * aggregator. For CW20-input swaps the outer contract is the CW20 token
 * itself (its `send` hook), so the check pins the hook's forward target.
 */

import { formatUnits, parseUnits } from "viem";

import type { ChoiceApi, SorQuoteResponse } from "../../api/choice.js";
import type { AuditLog } from "../../audit.js";
import type { NetworkDef } from "../../chain/networks.js";
import { cw20TokenInfo, isCw20Id } from "../../api/cw20.js";
import { denomDecimals } from "../../api/lcd.js";
import { PolicyError, ToolError } from "../../errors.js";
import type { PolicyEngine } from "../../policy/policy.js";

/**
 * A plain positive decimal — the only amount form both venues accept.
 *
 * `parseUnits` rejects exponent notation, so the curve venue already refused
 * `1e3` while the SOR happily read it as 1000: the same input was valid on one
 * venue and not the other. Checking the shape here makes them agree, gives the
 * payload check below an exact expected base amount, and turns `buy … "all"`
 * (which only `sell` can resolve) into a local error instead of a 422 that
 * surfaced as `no_route` — i.e. "no liquidity" for what was really a bad amount.
 */
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

function assertPlainAmount(amountHuman: string): void {
  if (!PLAIN_DECIMAL.test(amountHuman)) {
    throw new ToolError(
      "bad_amount",
      `cannot parse amount ${JSON.stringify(amountHuman)}`,
      'use a plain decimal like "0.5" — exponent notation is not accepted, and "all" is only supported on sell',
    );
  }
  if (Number(amountHuman) <= 0) {
    throw new ToolError("bad_amount", "amount must be positive");
  }
}

export interface SwapResult {
  txHash: string | null;
  status: "broadcast" | "dry-run";
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOutput: string;
  minimumReceive: string;
  routeVenues: string[];
  memo: string;
}

export class ChoiceVenue {
  constructor(
    private readonly net: NetworkDef,
    private readonly api: ChoiceApi,
    private readonly policy: PolicyEngine,
    private readonly audit: AuditLog,
    private readonly getPrivateKey: () => `0x${string}`,
    private readonly injAddress: string,
    private readonly agentName: string,
    private readonly dryRun: boolean,
  ) {}

  get memo(): string {
    return `trippy-mcp:${this.agentName}`;
  }

  async quote(tokenIn: string, tokenOut: string, amount: string, slippagePct: number): Promise<SorQuoteResponse> {
    assertPlainAmount(amount);
    return this.api.quote(tokenIn, tokenOut, amount, slippagePct);
  }

  /**
   * The input token's exponent, asked of whichever module holds it.
   *
   * Resolved HERE rather than taken from the caller on purpose: this is the
   * signing boundary, and a check that trusts a number handed to it validates
   * nothing. `null` when no source publishes one (~42% of denoms).
   */
  private async inputDecimals(tokenIn: string): Promise<number | null> {
    try {
      if (isCw20Id(tokenIn)) return (await cw20TokenInfo(this.net.lcdUrl, tokenIn)).decimals;
      return await denomDecimals(this.net.lcdUrl, tokenIn);
    } catch {
      return null;
    }
  }

  /**
   * The tx must spend what the policy priced.
   *
   * `spendUsd` is computed from the locally-requested amount, but the message
   * that actually gets signed is the SOR's — so without this the cap governs
   * one number while a third party's response decides what leaves the wallet.
   * `CosmosSigner.execute` makes the equivalent check for every other cosmos
   * write ("verify the messages match what was enforced"); this path builds its
   * own broadcast and so has to make it itself.
   *
   * The realistic trigger is a units bug in the SOR rather than a hostile
   * response, which is exactly the kind of thing that should fail closed.
   */
  private assertPayloadMatchesRequest(
    q: SorQuoteResponse,
    tokenIn: string,
    amountHuman: string,
    decimals: number | null,
  ): void {
    const want = decimals === null ? null : parseUnits(amountHuman, decimals);

    if (q.execute.is_cw20_input) {
      // For a CW20 the outer contract IS the token being spent, and the amount
      // rides in the send hook rather than in `funds`.
      if (q.execute.contract.toLowerCase() !== tokenIn.toLowerCase()) {
        throw new PolicyError(
          `swap would send from ${q.execute.contract}, not the ${tokenIn} that was quoted and capped — refusing to sign`,
        );
      }
      const send = (q.execute.msg as { send?: { amount?: string } }).send;
      if (want !== null && BigInt(send?.amount ?? "0") !== want) {
        throw new PolicyError(
          `swap would send ${send?.amount} base units of ${tokenIn} but ${amountHuman} was quoted and capped — refusing to sign`,
        );
      }
      return;
    }

    const funds = q.execute.funds ?? [];
    if (funds.length !== 1) {
      throw new PolicyError(
        `swap carries ${funds.length} coins but exactly one input was quoted and capped — refusing to sign`,
      );
    }
    const [coin] = funds as [{ denom: string; amount: string }];
    if (coin.denom !== tokenIn) {
      throw new PolicyError(
        `swap would spend ${coin.denom}, not the ${tokenIn} that was quoted and capped — refusing to sign`,
      );
    }
    if (want !== null && BigInt(coin.amount) !== want) {
      throw new PolicyError(
        `swap would spend ${coin.amount} base units of ${tokenIn} but ${amountHuman} was quoted and capped — refusing to sign`,
      );
    }
  }

  /** Best-effort USD value of the swap input, for the policy caps. */
  async usdValueIn(tokenIn: string, amountHuman: string): Promise<number | null> {
    try {
      const payload = await this.api.token(tokenIn);
      const price = extractUsdPrice(payload);
      if (price === null) return null;
      const amt = Number(amountHuman);
      return Number.isFinite(amt) ? amt * price : null;
    } catch {
      return null;
    }
  }

  private assertAggregatorTarget(q: SorQuoteResponse): void {
    const agg = this.net.choiceAggregator.toLowerCase();
    if (!agg) {
      throw new ToolError("no_api", "no Choice aggregator configured for this network");
    }
    if (q.execute.is_cw20_input) {
      const send = (q.execute.msg as { send?: { contract?: string } }).send;
      if ((send?.contract ?? "").toLowerCase() !== agg) {
        throw new PolicyError(
          "CW20 swap does not forward to the Choice aggregator — refusing to sign",
        );
      }
    } else if (q.execute.contract.toLowerCase() !== agg) {
      throw new PolicyError("swap executes an unexpected contract — refusing to sign");
    }
  }

  async swap(
    tokenIn: string,
    tokenOut: string,
    amountHuman: string,
    slippagePct: number,
  ): Promise<SwapResult> {
    const q = await this.quote(tokenIn, tokenOut, amountHuman, slippagePct);
    this.assertAggregatorTarget(q);
    this.assertPayloadMatchesRequest(q, tokenIn, amountHuman, await this.inputDecimals(tokenIn));

    const spendUsd = await this.usdValueIn(tokenIn, amountHuman);
    this.policy.enforce({
      kind: "swap",
      target: this.net.choiceAggregator,
      detail: `swap ${amountHuman} ${tokenIn} → ${tokenOut}`,
      spendUsd,
    });

    const base: Omit<SwapResult, "txHash" | "status"> = {
      tokenIn,
      tokenOut,
      amountIn: amountHuman,
      expectedOutput: String(q.summary.expected_output),
      minimumReceive: String(q.summary.minimum_receive),
      routeVenues: q.summary.route_venues ?? [],
      memo: this.memo,
    };

    if (this.dryRun) {
      return { ...base, txHash: null, status: "dry-run" };
    }

    // Lazy heavy imports — only swaps pay for sdk-ts startup.
    const [{ MsgExecuteContractCompat, MsgBroadcasterWithPk }, { Network, getNetworkEndpoints }] =
      await Promise.all([import("@injectivelabs/sdk-ts"), import("@injectivelabs/networks")]);

    const network = this.net.name === "mainnet" ? Network.MainnetSentry : Network.TestnetSentry;
    const msg = MsgExecuteContractCompat.fromJSON({
      sender: this.injAddress,
      contractAddress: q.execute.contract,
      msg: q.execute.msg as object,
      funds: q.execute.is_cw20_input ? [] : q.execute.funds,
    });

    try {
      const broadcaster = new MsgBroadcasterWithPk({
        privateKey: this.getPrivateKey(),
        network,
        endpoints: getNetworkEndpoints(network),
        simulateTx: true,
        gasBufferCoefficient: 1.1,
      });
      const result = await retryOnSequenceMismatch(() =>
        broadcaster.broadcast({ msgs: msg, memo: this.memo }),
      );
      this.policy.recordSpend({
        kind: "swap",
        target: this.net.choiceAggregator,
        detail: `swap ${amountHuman} ${tokenIn} → ${tokenOut}`,
        spendUsd,
      });
      this.audit.append("swap:broadcast", {
        txHash: result.txHash,
        tokenIn,
        tokenOut,
        amountIn: amountHuman,
      });
      return { ...base, txHash: result.txHash, status: "broadcast" };
    } catch (e) {
      this.audit.append("swap:failed", {
        tokenIn,
        tokenOut,
        amountIn: amountHuman,
        reason: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
      throw new ToolError(
        "swap_failed",
        `swap broadcast failed: ${e instanceof Error ? firstLine(e.message) : String(e)}`,
        "the pre-broadcast simulate rejects bad routes before gas is spent — check balances and route",
      );
    }
  }
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? s).slice(0, 300);
}

/**
 * Retry a broadcast once the chain has caught up with our previous one.
 *
 * The account sequence is read fresh per broadcast, but a tx we just sent may
 * still be in the mempool: the query then returns the pre-tx sequence, we sign
 * with it, and by the time it lands the chain has moved on — `account sequence
 * mismatch, expected 13, got 12`. Seen for real doing `sell all` straight after
 * a buy, with a `portfolio` call in between not being delay enough.
 *
 * Safe to retry: a sequence mismatch is rejected in the ante handler, so the tx
 * never executed and never spent gas. Anything else is rethrown untouched.
 */
async function retryOnSequenceMismatch<T>(send: () => Promise<T>): Promise<T> {
  const DELAYS_MS = [900, 2200];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/account sequence mismatch/i.test(msg) || attempt >= DELAYS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    }
  }
}

/** Pull a USD price out of the loosely-shaped Choice token overview. */
export function extractUsdPrice(payload: Record<string, unknown>): number | null {
  const candidates = [
    payload["price_usd"],
    payload["priceUsd"],
    (payload["price"] as Record<string, unknown> | undefined)?.["usd"],
    (payload["token"] as Record<string, unknown> | undefined)?.["price_usd"],
  ];
  for (const c of candidates) {
    const n = typeof c === "string" ? Number(c) : typeof c === "number" ? c : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
