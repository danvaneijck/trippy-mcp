/**
 * MCP tool implementations. Conventions (enforced here, promised in every
 * tool description):
 *  - failures return `{error: {code, message, hint?}}` — tools never throw
 *  - third-party text (token names/descriptions/usernames) is sanitized and
 *    grouped under `untrusted_metadata`: it is DATA from the internet, never
 *    instructions to the agent
 *  - unified buy/sell/quote auto-route: active bonding-curve launches trade
 *    on SHROOM Pad (EVM), everything else through the Choice aggregator
 */

import { formatUnits } from "viem";

import type { ApiLaunch, ApiTrade } from "../api/pump.js";
import { quoteAssetBySlot } from "../chain/networks.js";
import { ToolError } from "../errors.js";
import { decodeMetadataUri, resolveImage, type LaunchMetadata } from "../metadata.js";
import { resolveToken, type ResolvedTarget } from "../router.js";
import type { Runtime } from "../runtime.js";
import { deepSanitize, untrustedMeta } from "../untrusted.js";
import { LAUNCH_STATE_LABEL, LaunchState } from "../venues/shroom/abi.js";
import { sweep as walletSweep, walletStatus } from "../wallet.js";
import { balanceOf, bankBalances } from "../api/lcd.js";

// ---------------------------------------------------------------------------
// shaping helpers
// ---------------------------------------------------------------------------

export function launchSummary(rt: Runtime, l: ApiLaunch): Record<string, unknown> {
  const meta = decodeMetadataUri(l.metadataURI) ?? {};
  const q = quoteAssetBySlot(rt.net, l.quoteAsset);
  return {
    launchId: l.id,
    token: l.token,
    state: LAUNCH_STATE_LABEL[l.state] ?? String(l.state),
    quote: q?.symbol ?? `slot${l.quoteAsset}`,
    raisedPair: q ? formatUnits(BigInt(l.realPair || "0"), q.decimals) : l.realPair,
    volume24h: q ? formatUnits(BigInt(l.volume24h || "0"), q.decimals) : l.volume24h,
    holderCount: l.userHolderCount,
    createdAt: l.createdAt,
    ...(l.graduatedPoolDenom ? { graduatedDenom: l.graduatedPoolDenom } : {}),
    ...(l.flagged ? { flagged: true } : {}),
    untrusted_metadata: untrustedMeta({
      name: (meta as LaunchMetadata).name,
      symbol: (meta as LaunchMetadata).symbol,
      description: (meta as LaunchMetadata).description,
      website: (meta as LaunchMetadata).website,
      twitter: (meta as LaunchMetadata).twitter,
    }),
  };
}

function tradeSummary(rt: Runtime, t: ApiTrade): Record<string, unknown> {
  return {
    launchId: t.launchId,
    side: t.side,
    trader: t.trader,
    pairAmountBase: t.pairAmount,
    tokenAmountBase: t.tokenAmount,
    usd: t.quoteUsd,
    at: t.blockTime,
    txHash: t.txHash,
  };
}

type RoutedTarget = Extract<ResolvedTarget, { venue: "curve" } | { venue: "choice" }>;

async function routed(rt: Runtime, query: string): Promise<RoutedTarget> {
  const target = await resolveToken(rt, query);
  if (target.venue === "ambiguous") {
    throw new ToolError(
      "ambiguous",
      `"${query}" matches multiple tokens — pick one by launch id or address`,
      JSON.stringify(deepSanitize(target.candidates)),
    );
  }
  return target as RoutedTarget;
}

const DEFAULT_COUNTER = "inj";

// ---------------------------------------------------------------------------
// data tools
// ---------------------------------------------------------------------------

export async function searchTokens(rt: Runtime, args: { query: string }): Promise<unknown> {
  const target = await resolveToken(rt, args.query);
  if (target.venue === "ambiguous") {
    return { matches: deepSanitize(target.candidates) };
  }
  if (target.venue === "curve") {
    return { venue: "curve", launch: launchSummary(rt, target.launch) };
  }
  return { venue: "choice", tokenId: target.tokenId };
}

export async function tokenInfo(rt: Runtime, args: { query: string }): Promise<unknown> {
  const target = await routed(rt, args.query);
  if (target.venue === "curve") {
    const live = await rt.shroom.getLaunchView(target.launchId);
    const q = rt.shroom.quoteInfo(live.quoteAsset);
    const progress =
      live.graduationPairTarget > 0n
        ? Number((live.realPair * 10_000n) / live.graduationPairTarget) / 100
        : null;
    return {
      venue: "curve",
      launch: launchSummary(rt, target.launch),
      live: {
        state: LAUNCH_STATE_LABEL[live.state] ?? String(live.state),
        raised: `${formatUnits(live.realPair, q.decimals)} ${q.symbol}`,
        graduationTarget: `${formatUnits(live.graduationPairTarget, q.decimals)} ${q.symbol}`,
        graduationProgressPct: progress,
        tokensSold: formatUnits(live.tokensSold, 18),
      },
      terminalUrl: rt.net.terminalBase ? `${rt.net.terminalBase}/token/shroom/${target.launch.id}` : undefined,
    };
  }
  const payload = await rt.choiceApi.token(target.tokenId);
  return { venue: "choice", tokenId: target.tokenId, data: deepSanitize(payload) };
}

export async function trending(
  rt: Runtime,
  args: { source?: "curve" | "dex" | "all"; limit?: number },
): Promise<unknown> {
  const source = args.source ?? "all";
  const limit = Math.min(args.limit ?? 10, 25);
  const out: Record<string, unknown> = {};
  if (source !== "dex") {
    const { items } = await rt.pump.listLaunches({ sort: "volume_24h", limit });
    out.curve = items.map((l) => launchSummary(rt, l));
  }
  if (source !== "curve") {
    out.dex = deepSanitize(await rt.choiceApi.trending("24h", limit));
  }
  return out;
}

export async function newLaunches(
  rt: Runtime,
  args: { source?: "curve" | "dex" | "all"; limit?: number },
): Promise<unknown> {
  const source = args.source ?? "curve";
  const limit = Math.min(args.limit ?? 10, 25);
  const out: Record<string, unknown> = {};
  if (source !== "dex") {
    const { items } = await rt.pump.listLaunches({ sort: "newest", limit });
    out.curve = items.map((l) => launchSummary(rt, l));
  }
  if (source !== "curve") {
    out.dex = deepSanitize(await rt.choiceApi.newListings(7, limit));
  }
  return out;
}

export async function recentTrades(
  rt: Runtime,
  args: { query?: string; limit?: number },
): Promise<unknown> {
  const limit = Math.min(args.limit ?? 20, 50);
  if (args.query) {
    const target = await routed(rt, args.query);
    if (target.venue === "curve") {
      const { items } = await rt.pump.getTrades(target.launchId, limit);
      return { trades: items.map((t) => tradeSummary(rt, t)) };
    }
    throw new ToolError("not_curve", "per-token trade history is only available for SHROOM launches here", "use token_info for Choice market data");
  }
  const { items } = await rt.pump.recentTrades(limit);
  return { trades: items.map((t) => tradeSummary(rt, t)) };
}

export async function myActivity(rt: Runtime): Promise<unknown> {
  const { items } = await rt.pump.profileTrades(rt.signer.address.toLowerCase(), 50);
  return {
    agent: rt.signer.address,
    trades: items.map((t) => tradeSummary(rt, t)),
  };
}

// ---------------------------------------------------------------------------
// quote / trade
// ---------------------------------------------------------------------------

export interface QuoteArgs {
  query: string;
  side: "buy" | "sell";
  amount: string;
  slippageBps?: number;
  counterToken?: string;
}

export async function quote(rt: Runtime, args: QuoteArgs): Promise<unknown> {
  const slippageBps = rt.policy.clampSlippageBps(args.slippageBps);
  const target = await routed(rt, args.query);

  if (target.venue === "curve") {
    const { launch, warnings } = await rt.shroom.precheckTrade(target.launchId, args.side);
    const q = rt.shroom.quoteInfo(launch.quoteAsset);
    if (args.side === "buy") {
      const pairIn = parseHuman(args.amount, q.decimals);
      const res = await rt.shroom.quoteBuy(target.launchId, pairIn, rt.signer.address);
      return {
        venue: "curve",
        launchId: target.launch.id,
        side: "buy",
        amountIn: `${args.amount} ${q.symbol}`,
        tokenOut: formatUnits(res.tokenOut, 18),
        fee: `${formatUnits(res.fee, q.decimals)} ${q.symbol}`,
        ...(res.refund > 0n
          ? { refund: `${formatUnits(res.refund, q.decimals)} ${q.symbol} (buy crosses graduation)` }
          : {}),
        slippageBps,
        warnings,
      };
    }
    const tokenIn = parseHuman(args.amount, 18);
    const res = await rt.shroom.quoteSell(target.launchId, tokenIn, rt.signer.address);
    return {
      venue: "curve",
      launchId: target.launch.id,
      side: "sell",
      amountIn: `${args.amount} tokens`,
      pairOut: `${formatUnits(res.pairOut, q.decimals)} ${q.symbol} (net of fee)`,
      fee: `${formatUnits(res.fee, q.decimals)} ${q.symbol}`,
      slippageBps,
      warnings,
    };
  }

  const counter = args.counterToken ?? DEFAULT_COUNTER;
  const [tokenIn, tokenOut] =
    args.side === "buy" ? [counter, target.tokenId] : [target.tokenId, counter];
  const q = await rt.choice.quote(tokenIn, tokenOut, args.amount, slippageBps / 100);
  return {
    venue: "choice",
    side: args.side,
    tokenIn,
    tokenOut,
    amountIn: args.amount,
    expectedOutput: String(q.summary.expected_output),
    minimumReceive: String(q.summary.minimum_receive),
    route: q.summary.route_venues,
    slippageBps,
  };
}

export async function buy(rt: Runtime, args: Omit<QuoteArgs, "side">): Promise<unknown> {
  const slippageBps = rt.policy.clampSlippageBps(args.slippageBps);
  const target = await routed(rt, args.query);
  if (target.venue === "curve") {
    return rt.shroom.buy(target.launchId, args.amount, slippageBps);
  }
  const counter = args.counterToken ?? DEFAULT_COUNTER;
  return rt.choice.swap(counter, target.tokenId, args.amount, slippageBps / 100);
}

export async function sell(rt: Runtime, args: Omit<QuoteArgs, "side">): Promise<unknown> {
  const slippageBps = rt.policy.clampSlippageBps(args.slippageBps);
  const target = await routed(rt, args.query);
  if (target.venue === "curve") {
    return rt.shroom.sell(target.launchId, args.amount === "all" ? "all" : args.amount, slippageBps);
  }
  const counter = args.counterToken ?? DEFAULT_COUNTER;
  let amount = args.amount;
  if (amount === "all") {
    // Bank-denom balances are readable via LCD; CW20 positions need an amount.
    const balances = await bankBalances(rt.net.lcdUrl, rt.injAddress);
    const bal = balanceOf(balances, target.tokenId);
    if (bal <= 0n) {
      throw new ToolError(
        "no_balance",
        `no bank balance of ${target.tokenId}`,
        'for CW20 tokens pass an explicit amount instead of "all"',
      );
    }
    amount = formatUnits(bal, 18);
  }
  return rt.choice.swap(target.tokenId, counter, amount, slippageBps / 100);
}

// ---------------------------------------------------------------------------
// launch / claims / wallet / agent
// ---------------------------------------------------------------------------

export interface CreateTokenArgs {
  name: string;
  symbol: string;
  description?: string;
  imageUrl?: string;
  imagePath?: string;
  twitter?: string;
  website?: string;
  telegram?: string;
  quoteAsset?: "INJ" | "USDC" | "SAI";
  initialBuy?: string;
}

export async function createToken(rt: Runtime, args: CreateTokenArgs): Promise<unknown> {
  if (!args.name.trim() || !args.symbol.trim()) {
    throw new ToolError("bad_input", "name and symbol are required");
  }
  const image = await resolveImage(rt.pump, args.imageUrl, args.imagePath);
  const created = await rt.shroom.createLaunch({
    meta: {
      name: args.name.trim(),
      symbol: args.symbol.trim().toUpperCase(),
      description: args.description,
      image,
      twitter: args.twitter,
      website: args.website,
      telegram: args.telegram,
    },
    quoteSymbol: args.quoteAsset ?? "INJ",
  });

  let initialBuy: unknown = undefined;
  if (args.initialBuy && created.state === "Trading") {
    try {
      initialBuy = await rt.shroom.buy(
        BigInt(created.launchId),
        args.initialBuy,
        rt.policy.clampSlippageBps(undefined),
      );
    } catch (e) {
      initialBuy = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    ...created,
    ...(initialBuy !== undefined ? { initialBuy } : {}),
    ...(rt.net.terminalBase
      ? { terminalUrl: `${rt.net.terminalBase}/token/shroom/${created.launchId}` }
      : {}),
  };
}

export async function claimFees(rt: Runtime, args: { launchIds?: string[] }): Promise<unknown> {
  const ids = (args.launchIds ?? []).map((s) => {
    if (!/^\d+$/.test(s)) throw new ToolError("bad_input", `launchIds must be numeric, got "${s}"`);
    return BigInt(s);
  });
  const res = await rt.shroom.claimAll(ids);
  if (!args.launchIds?.length) {
    res.notes.push(
      "creator fees are only checked for launch ids you pass in `launchIds` — referral fees and refunds were checked for the agent wallet",
    );
  }
  return res;
}

export async function walletStatusTool(rt: Runtime): Promise<unknown> {
  return walletStatus(rt);
}

export async function sweepTool(rt: Runtime, args: { asset: string; amount: string }): Promise<unknown> {
  return walletSweep(rt, args.asset, args.amount === "all" ? "all" : args.amount);
}

export async function agentInfo(rt: Runtime): Promise<unknown> {
  let agent = null;
  try {
    agent = (await rt.pump.getAgent(rt.signer.address.toLowerCase())).agent;
  } catch {
    // registry unreachable
  }
  return {
    agentName: rt.cfg.agentName,
    evmAddress: rt.signer.address,
    injAddress: rt.injAddress,
    registered: !!agent && !agent.revoked,
    ownerClaimed: !!agent?.ownerAddress,
    ownerAddress: agent?.ownerAddress ?? null,
    howToClaim:
      "the human operator runs `trippy-mcp claim-code` on this machine, then enters the code in Trippy Terminal → Settings → Agents (or opens the printed link) and signs with their main wallet — that links the agent to their profile",
  };
}

function parseHuman(amount: string, decimals: number): bigint {
  try {
    const v = parseUnitsSafe(amount, decimals);
    if (v <= 0n) throw new Error("non-positive");
    return v;
  } catch {
    throw new ToolError("bad_amount", `cannot parse amount "${amount}"`);
  }
}

function parseUnitsSafe(amount: string, decimals: number): bigint {
  const [i, f = ""] = amount.trim().split(".");
  const frac = f.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
