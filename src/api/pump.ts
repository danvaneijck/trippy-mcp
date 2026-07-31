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

export interface AgentIdentity {
  agentAddress: string;
  name: string;
  ownerAddress: string | null;
  avatarUrl: string | null;
  client: string | null;
  createdAt: string;
  revoked: boolean;
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
}
