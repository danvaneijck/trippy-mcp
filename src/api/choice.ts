/**
 * Choice DEX client (api.choice.exchange):
 *  - POST /api/quote — the SOR: best route across AMM/CLMM/orderbook,
 *    re-quoted on-chain, returning a ready-to-broadcast MsgExecuteContract
 *    payload (the CALLER signs — the aggregator enforces minimum_receive
 *    on-chain). Wire types mirror trippy_terminal venues/choiceSor/quote.ts.
 *  - GET /api/agent/* — curated read endpoints (resolve/token/trending/...).
 */

import { ToolError } from "../errors.js";

export interface SorExecute {
  type: string;
  sender: string | null;
  contract: string;
  msg: Record<string, unknown>;
  funds: { denom: string; amount: string }[];
  is_cw20_input: boolean;
  minimum_receive_base: number | string;
}

export interface SorQuoteSummary {
  token_in: string;
  token_out: string;
  amount_in: number | string;
  expected_output: string | number;
  effective_price: string | number;
  minimum_receive: string | number;
  slippage_pct: number;
  route_venues: string[];
}

export interface SorQuoteResponse {
  summary: SorQuoteSummary;
  execute: SorExecute;
  as_of: string;
}

export class ChoiceApi {
  constructor(private readonly base: string) {}

  private url(path: string): string {
    if (!this.base) {
      throw new ToolError(
        "no_api",
        "no Choice API configured for this network",
        "set choiceApiBase in config.json (mainnet default: https://api.choice.exchange)",
      );
    }
    return `${this.base.replace(/\/$/, "")}${path}`;
  }

  /**
   * SOR quote. `tokenIn`/`tokenOut` are Choice token ids (bank denom like
   * `inj` / `factory/…` / `peggy0x…`, or a CW20 address); `amount` is HUMAN
   * units of the input; `slippagePct` e.g. 0.5 = 0.5%.
   */
  async quote(
    tokenIn: string,
    tokenOut: string,
    amount: string | number,
    slippagePct: number,
  ): Promise<SorQuoteResponse> {
    const res = await fetch(this.url("/api/quote"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in: tokenIn,
        token_out: tokenOut,
        amount: String(amount),
        slippage_pct: slippagePct,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ToolError(
        "no_route",
        `Choice SOR returned no route (HTTP ${res.status})`,
        body.slice(0, 200) || "check the token ids and amount",
      );
    }
    const data = (await res.json()) as Partial<SorQuoteResponse>;
    if (!data.summary || !data.execute) {
      throw new ToolError("no_route", "Choice SOR response missing summary/execute");
    }
    return data as SorQuoteResponse;
  }

  private async agentGet<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const qs = params
      ? `?${new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString()}`
      : "";
    const res = await fetch(this.url(`/api/agent${path}`) + qs);
    if (!res.ok) {
      throw new ToolError("api_error", `Choice agent API ${path} failed (HTTP ${res.status})`);
    }
    return (await res.json()) as T;
  }

  /** Resolve a symbol/name/address to curated token/market matches. */
  resolve(q: string, type: "auto" | "token" | "market" = "auto"): Promise<Record<string, unknown>> {
    return this.agentGet("/resolve", { q, type });
  }

  /** Bundled token overview (price, liquidity, markets, safety flags). */
  token(query: string): Promise<Record<string, unknown>> {
    // Path-style query — keep `/` literal for denoms like factory/inj1…/TOKEN.
    const enc = query.split("/").map(encodeURIComponent).join("/");
    return this.agentGet(`/token/${enc}`);
  }

  trending(horizon: "1h" | "6h" | "24h" = "24h", limit = 10): Promise<Record<string, unknown>> {
    return this.agentGet("/trending", { horizon, limit });
  }

  newListings(days = 7, limit = 20): Promise<Record<string, unknown>> {
    return this.agentGet("/discovery/new", { days, limit });
  }
}
