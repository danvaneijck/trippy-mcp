/**
 * SHROOM Pad backend client (pump-api.trippyinj.xyz) — launches/trades/
 * holders data, image uploads, quote→USD rates, and the agent-identity
 * registry endpoints.
 *
 * Wire shapes mirror backend/src/shared/{launches,trades}.ts serializers.
 */

import { ToolError } from "../errors.js";

export interface ApiLaunch {
  id: string;
  creator: string;
  token: string;
  quoteAsset: number;
  metadataURI: string;
  createdAt: string;
  state: number;
  realPair: string;
  tokensSold: string;
  bankDenom: string | null;
  tradeFeeBps: number | null;
  creatorFeeShareBps: number | null;
  graduationTarget: number;
  graduatedPoolAddress: string | null;
  graduatedPoolDenom: string | null;
  volume24h: string;
  lastTradedAt: string | null;
  holderCount: string;
  userHolderCount: string;
  hidden: boolean;
  featured: boolean;
  flagged: boolean;
  progressBps?: number;
}

export interface ApiTrade {
  txHash: string;
  logIndex: number;
  launchId: string;
  blockNumber: string;
  blockTime: string;
  trader: string;
  side: "buy" | "sell";
  pairAmount: string;
  tokenAmount: string;
  fee: string;
  spotPriceWad: string;
  quoteUsd: string | null;
}

export interface QuotePriceRow {
  quoteAsset: number;
  rateUsd: string;
  source: string;
  fetchedAt: string;
}

export interface ApiCandle {
  t: number; // unix seconds, bucket open
  o: string; // spot_price_wad (1e18-scaled pair-per-token, raw base-unit ratio)
  h: string;
  l: string;
  c: string;
  v: string; // pair volume in raw quote base units
  n: number; // trade count
  rateUsd: string | null; // quote→USD rate at the bucket's close trade
}

export interface AgentIdentity {
  agentAddress: string;
  name: string;
  ownerAddress: string | null;
  avatarUrl: string | null;
  client: string | null;
  createdAt: string;
  revoked: boolean;
  /** ERC-8004 identity NFT id, once minted. Absent on older backends. */
  erc8004AgentId?: string | null;
  erc8004ChainId?: number | null;
  /**
   * The pending wallet link the operator has to submit. Short-lived by
   * construction — the registry rejects a deadline more than 300s out — so a
   * consumer must check `deadline` against the clock, not just its presence.
   */
  walletLink?: {
    owner: string;
    deadline: number;
    signature: string;
  } | null;
}

export interface WalletLinkPayload {
  owner: string;
  deadline: number;
  signature: string;
}

export class PumpApi {
  constructor(private readonly base: string) {}

  private url(path: string): string {
    if (!this.base) {
      throw new ToolError(
        "no_api",
        "no SHROOM Pad API configured for this network",
        "set pumpApiBase in config.json",
      );
    }
    return `${this.base.replace(/\/$/, "")}${path}`;
  }

  private async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const qs = params
      ? `?${new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== "")
            .map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString()}`
      : "";
    const res = await fetch(this.url(path) + qs);
    if (!res.ok) {
      throw new ToolError("api_error", `pump API ${path} failed (HTTP ${res.status})`);
    }
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      throw new ToolError(
        "api_error",
        `pump API ${path} failed (HTTP ${res.status})${payload?.error ? `: ${payload.error}` : ""}`,
      );
    }
    return payload;
  }

  // ---- data ----------------------------------------------------------------

  listLaunches(opts: {
    q?: string;
    sort?: "newest" | "graduating" | "volume_24h" | "last_traded";
    state?: number;
    quote?: string;
    limit?: number;
  }): Promise<{ items: ApiLaunch[] }> {
    return this.get("/launches", {
      q: opts.q,
      sort: opts.sort,
      state: opts.state,
      quote: opts.quote,
      limit: opts.limit ?? 20,
    });
  }

  getLaunch(id: string | number | bigint): Promise<ApiLaunch> {
    return this.get(`/launches/${id}`);
  }

  getTrades(launchId: string | bigint, limit = 20): Promise<{ items: ApiTrade[] }> {
    return this.get(`/launches/${launchId}/trades`, { limit });
  }

  getHolders(launchId: string | bigint, limit = 20): Promise<{ items: unknown[] }> {
    return this.get(`/launches/${launchId}/holders`, { limit });
  }

  recentTrades(limit = 30): Promise<{ items: ApiTrade[] }> {
    return this.get("/trades/recent", { limit });
  }

  getCandles(
    launchId: string | bigint,
    opts: { interval?: string; from?: number; to?: number; limit?: number },
  ): Promise<{ interval: string; from: number; to: number; items: ApiCandle[] }> {
    return this.get(`/launches/${launchId}/candles`, {
      interval: opts.interval,
      from: opts.from,
      to: opts.to,
      limit: opts.limit,
    });
  }

  profileTrades(address: string, limit = 50): Promise<{ items: ApiTrade[] }> {
    return this.get(`/profiles/${address}/trades`, { limit });
  }

  quotePrices(): Promise<{ items: QuotePriceRow[] }> {
    return this.get("/quote-prices");
  }

  // ---- uploads -------------------------------------------------------------

  async uploadImage(bytes: Uint8Array, filename: string, mime: string): Promise<{ cid: string; url: string }> {
    const form = new FormData();
    form.append("file", new Blob([bytes as unknown as ArrayBuffer], { type: mime }), filename);
    const res = await fetch(this.url("/uploads/image"), { method: "POST", body: form });
    const payload = (await res.json().catch(() => ({}))) as { cid?: string; url?: string; error?: string };
    if (!res.ok || !payload.url) {
      throw new ToolError(
        "upload_failed",
        `image upload failed (HTTP ${res.status})${payload?.error ? `: ${payload.error}` : ""}`,
      );
    }
    return { cid: payload.cid ?? "", url: payload.url };
  }

  // ---- agent registry ------------------------------------------------------

  registerNonce(body: { agentAddress: string; name: string; client?: string }): Promise<{ nonce: string; message: string }> {
    return this.post("/agents/register/nonce", body);
  }

  register(body: {
    agentAddress: string;
    name: string;
    client?: string;
    avatarUrl?: string;
    nonce: string;
    signature: string;
  }): Promise<{ agent: AgentIdentity }> {
    return this.post("/agents/register", body);
  }

  getAgent(address: string): Promise<{ agent: AgentIdentity | null }> {
    return this.get(`/agents/${address}`);
  }

  claimCodeNonce(address: string): Promise<{ nonce: string; message: string }> {
    return this.post(`/agents/${address}/claim-code/nonce`, {});
  }

  claimCode(address: string, body: { nonce: string; signature: string }): Promise<{ code: string; expiresAt: string }> {
    return this.post(`/agents/${address}/claim-code`, body);
  }

  // ---- ERC-8004 ------------------------------------------------------------

  /**
   * The message embeds the payload being written (agentId/chainId and the
   * link's owner+deadline), so a captured signature cannot be replayed to
   * record different data — same discipline as `/agents/register`.
   */
  erc8004Nonce(
    address: string,
    body: {
      agentId?: string;
      chainId?: number;
      walletLink?: { owner: string; deadline: number };
    },
  ): Promise<{ nonce: string; message: string }> {
    return this.post(`/agents/${address}/erc8004/nonce`, body);
  }

  /**
   * Record the on-chain identity and/or refresh the pending wallet link.
   * Agent-key signed, same single-use-nonce discipline as `register`.
   */
  recordErc8004(
    address: string,
    body: {
      agentId?: string;
      chainId?: number;
      walletLink?: WalletLinkPayload;
      nonce: string;
      signature: string;
    },
  ): Promise<{ agent: AgentIdentity }> {
    return this.post(`/agents/${address}/erc8004`, body);
  }

  /** The URL `tokenURI` points at — fetched raw so the card can be validated. */
  async agentCard(address: string): Promise<unknown> {
    const res = await fetch(this.url(`/agents/${address.toLowerCase()}/agent-card.json`));
    if (!res.ok) {
      throw new ToolError(
        "api_error",
        `agent card is not being served (HTTP ${res.status})`,
        "run `trippy-mcp register` first — the card is built from the backend's agent row",
      );
    }
    return res.json();
  }
}
