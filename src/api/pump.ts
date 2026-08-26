/**
 * SHROOM Pad backend client (pump-api.trippyinj.xyz) — launches/trades/
 * holders data, image uploads, quote→USD rates, and the agent-identity
 * registry endpoints.
 *
 * Wire shapes mirror backend/src/shared/{launches,trades}.ts serializers.
 */

import { ToolError } from "../errors.js";

/**
 * The pad API's SURROGATE launch id — the only id any endpoint on this client
 * accepts. Branded so the compiler refuses the on-chain id, which is a
 * different number in a different namespace and, fed to `/launches/:id`,
 * returns a real but DIFFERENT launch instead of a 404.
 *
 * The two coincided while one core existed and diverged the moment a second
 * deployed: mainnet's surrogate 234 is on-chain 108, and surrogate 108 is
 * on-chain 46. Every crossing this brand has caught was silent.
 */
export type ApiLaunchId = string & { readonly __brand: "ApiLaunchId" };

/**
 * Assert that a string is a surrogate id. Use ONLY where the value provably
 * came from the API's own `id` field or from a caller naming a launch the way
 * the tools report it — never on an id read off the chain or out of a denom.
 */
export function asApiLaunchId(id: string | number): ApiLaunchId {
  return String(id) as ApiLaunchId;
}

export interface ApiLaunch {
  /** 🔴 The API's surrogate id, NOT the on-chain id — see `onchainId`. */
  id: ApiLaunchId;
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
  /**
   * The launch's post-graduation fee locker, bech32 — the CosmWasm contract
   * that HOLDS the graduated pool's LP position NFT and splits its swap fees
   * between the creator and the treasury.
   *
   * 🔴 The creator's fees do NOT all live on the core. This address is the
   * only route to the second rail, and it is null until the launch graduates
   * (and on XYK graduations, which mint no position NFT). See
   * `venues/shroom/locker.ts`.
   */
  lockerAddr?: string | null;
  volume24h: string;
  lastTradedAt: string | null;
  holderCount: string;
  userHolderCount: string;
  hidden: boolean;
  featured: boolean;
  flagged: boolean;
  progressBps?: number;
  /**
   * The LaunchpadCore this launch lives on. Optional because an API older than
   * the multi-core migration does not serve it; absent resolves to the current
   * core only where a single core is deployed (see `coreDeploymentFor`).
   */
  core?: string;
  /**
   * This launch's sink contract, bech32. The sink is the only thing that knows
   * which bank denom the launch actually minted — the subdenom's salt is not
   * derivable from any launch field — so it is what separates two launches that
   * share an on-chain id across cores.
   */
  sinkAddr?: string;
  /**
   * This launch's id ON ITS OWN CORE — what every chain call takes.
   *
   * 🔴 NOT `id`. `id` is the API's surrogate, unique across cores; the on-chain
   * id restarts at 0 for each core. They coincided while one core existed, and
   * stopped the moment a second one deployed: mainnet's first v2 launch is
   * surrogate 16 and on-chain 0. Passing a surrogate to the chain reads a real
   * but different launch, so use this everywhere a `launchId: bigint` is
   * wanted.
   */
  onchainId?: string;
}

/**
 * A created-launch row from `/profiles/:address`.
 *
 * 🔴 The activity columns are OMITTED, not zero. The backend's created-launches
 * query selects a fixed column list that leaves out `volume_24h`,
 * `holder_count` and `user_holder_count`, and the shared serialiser then
 * defaults all three to the string "0" — so a launch doing 58 INJ a day
 * reports "0" here and looks dead. `Omit` keeps them off the type so a reader
 * has to go to `getLaunch` for the real figures instead of printing a zero
 * that is a serialiser artefact.
 */
export type ApiProfileLaunch = Omit<ApiLaunch, "volume24h" | "holderCount" | "userHolderCount">;

/**
 * One launch this wallet holds or has traded, with ITS OWN flow through that
 * launch — the sums are this address's trades only, not the launch's totals.
 *
 * `realizableValuePair` is what the position would fetch if sold right now:
 * the backend quotes it live per row (curve `quoteSell` for an active launch,
 * the Choice pool once graduated) with this wallet's holder discount applied,
 * so it is an exit price and not `balance x spot`. Null when the quote failed.
 */
export interface ApiProfileHolding {
  launchId: ApiLaunchId;
  core?: string;
  onchainId?: string;
  creator: string;
  token: string;
  quoteAsset: number;
  state: number;
  metadataURI: string;
  realPair: string;
  tokensSold: string;
  /** This wallet's own buys/sells on this launch, in base units. */
  sumBuyPair: string;
  sumBuyToken: string;
  sumSellPair: string;
  sumSellToken: string;
  sumSellFee: string;
  feesPaid: string;
  volumePair: string;
  tradeCount: string;
  lastTradeAt: string | null;
  currentBalance: string;
  spotPriceWad: string | null;
  realizableValuePair: string | null;
}

export interface ApiProfile {
  address: string;
  holdings: ApiProfileHolding[];
  createdLaunches: ApiProfileLaunch[];
}

export interface ApiTrade {
  txHash: string;
  logIndex: number;
  /** Surrogate id, same namespace as `ApiLaunch.id`. */
  launchId: ApiLaunchId;
  blockNumber: string;
  blockTime: string;
  trader: string;
  side: "buy" | "sell";
  pairAmount: string;
  tokenAmount: string;
  fee: string;
  /// NORMALISED: display-quote per display-token, x1e18. The decimal gap is
  /// already applied by the indexer — do NOT rescale by 10^(18-quoteDecimals).
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
  o: string; // spot_price_wad — NORMALISED display-quote per display-token, x1e18
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
    /** Offset cursor; the response carries the next one under `cursor`. */
    cursor?: number;
  }): Promise<{ items: ApiLaunch[]; cursor?: number }> {
    return this.get("/launches", {
      q: opts.q,
      sort: opts.sort,
      state: opts.state,
      quote: opts.quote,
      limit: opts.limit ?? 20,
      cursor: opts.cursor,
    });
  }

  getLaunch(id: ApiLaunchId): Promise<ApiLaunch> {
    return this.get(`/launches/${id}`);
  }

  getTrades(launchId: ApiLaunchId, limit = 20): Promise<{ items: ApiTrade[] }> {
    return this.get(`/launches/${launchId}/trades`, { limit });
  }

  getHolders(launchId: ApiLaunchId, limit = 20): Promise<{ items: unknown[] }> {
    return this.get(`/launches/${launchId}/holders`, { limit });
  }

  recentTrades(limit = 30): Promise<{ items: ApiTrade[] }> {
    return this.get("/trades/recent", { limit });
  }

  getCandles(
    launchId: ApiLaunchId,
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

  /**
   * A wallet's pad profile: the launches it CREATED, and every launch it holds
   * or has traded, with that wallet's own cash flow per launch.
   *
   * This is the only endpoint that answers "which launches are mine". The
   * `/launches` list has no creator filter — an unknown `creator=` param is
   * dropped by the route's zod schema, so filtering that way silently returns
   * every creator's launches — and the `q=` search matches a creator prefix
   * only as one of five surfaces it ranks.
   */
  profile(address: string): Promise<ApiProfile> {
    return this.get(`/profiles/${address.toLowerCase()}`);
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
