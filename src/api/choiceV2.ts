/**
 * Choice v2 indexer API (evm-api.choice.exchange) — READ-ONLY, GET only.
 *
 * Nothing this client returns is ever signed. It is where pools are DISCOVERED
 * (every candidate is then re-derived and checked on chain), and where the
 * read tools get prices, the tape and candles. `/quote` is disabled on mainnet
 * (`/health` reports `quote: false`) and `/route` is deliberately not used:
 * quotes come from CLQuoter on chain, and calldata is built locally.
 */

import { ToolError } from "../errors.js";

export interface V2TokenRef {
  address: string;
  symbol: string | null;
  name?: string | null;
  decimals: number | null;
}

export interface V2Pool {
  id: string;
  poolType: "cl" | "bin" | string;
  currency0: string;
  currency1: string;
  hooks: string;
  token0: V2TokenRef;
  token1: V2TokenRef;
  /** The key's own fee field — what `PoolKey.fee` must be to hash to `id`. */
  keyFee: number;
  lpFeePips: number;
  parameters: string;
  liquidity: string;
  price?: string;
  quote?: string;
  tvlUsd?: string | null;
  lastSwapAt?: string | null;
}

export interface V2Token {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  priceUsd: string | null;
  priceUsdAt?: string | null;
  priceSource?: { poolId?: string; symbol?: string; hops?: number } | null;
  totalSupply?: string | null;
  [k: string]: unknown;
}

export interface V2Trade {
  txHash: string;
  trader: string;
  tokenIn: V2TokenRef;
  tokenOut: V2TokenRef;
  amountIn: string | null;
  amountOut: string | null;
  price?: string | null;
  usdValue: string | null;
  blockTimestamp: string;
  pools?: string[];
}

export interface V2Candle {
  time: number;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume0: string;
  volume1: string;
  volumeUsd: string | null;
  trades?: string;
}

export class ChoiceV2Api {
  constructor(private readonly base: string) {}

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    if (!this.base) throw new ToolError("no_api", "no Choice v2 API configured for this network");
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const res = await fetch(`${this.base.replace(/\/$/, "")}${path}${qs ? `?${qs}` : ""}`);
    if (!res.ok) {
      throw new ToolError("choice_v2_api", `Choice v2 API ${path} answered ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** Pools whose either token matches `q` (address or symbol substring). */
  async pools(q: string, limit = 50): Promise<V2Pool[]> {
    const r = await this.get<{ pools?: V2Pool[] }>("/pools", { q, limit });
    return r.pools ?? [];
  }

  async tokens(q: string, limit = 20): Promise<V2Token[]> {
    const r = await this.get<{ tokens?: V2Token[] }>("/tokens", { q, limit });
    return r.tokens ?? [];
  }

  /** The token whose address is exactly `address`, or null. */
  async token(address: string): Promise<V2Token | null> {
    const want = address.toLowerCase();
    return (await this.tokens(address, 5)).find((t) => t.address.toLowerCase() === want) ?? null;
  }

  async trades(pool: string, limit: number): Promise<V2Trade[]> {
    const r = await this.get<{ trades?: V2Trade[] }>("/trades", { pool, limit });
    return r.trades ?? [];
  }

  /**
   * `invert: true` prices currency0 in currency1 terms flipped — i.e. the
   * price of currency1. `denom: "usd"` converts each bucket at its own time.
   */
  async candles(
    pool: string,
    opts: { interval: string; limit: number; invert: boolean; denom: "usd" | "quote" },
  ): Promise<{ quote?: string; candles: V2Candle[] }> {
    const r = await this.get<{ quote?: string; candles?: V2Candle[] }>("/candles", {
      pool,
      interval: opts.interval,
      limit: opts.limit,
      invert: opts.invert,
      denom: opts.denom,
    });
    return { quote: r.quote, candles: r.candles ?? [] };
  }
}
