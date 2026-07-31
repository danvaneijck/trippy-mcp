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

import { formatUnits } from "viem";

import type { ChoiceApi, SorQuoteResponse } from "../../api/choice.js";
import type { AuditLog } from "../../audit.js";
import type { NetworkDef } from "../../chain/networks.js";
import { PolicyError, ToolError } from "../../errors.js";
import type { PolicyEngine } from "../../policy/policy.js";

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
    return this.api.quote(tokenIn, tokenOut, amount, slippagePct);
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
      const result = await broadcaster.broadcast({ msgs: msg, memo: this.memo });
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
