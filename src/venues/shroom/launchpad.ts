/**
 * SHROOM Pad venue — bonding-curve reads and writes against LaunchpadCore.
 *
 * Execution logic is a translation of the battle-tested
 * shroom_launchpad/activity-bot/src/trade.ts (quote → slippage → native vs
 * ERC20 branch → approval), with the launch flow from tools/drive-*-e2e.mjs
 * (predict launchId → createLaunch → poll Reserved→Trading).
 *
 * Contract gotchas honoured here (see repo recon / MAINNET_DEPLOYMENT.md):
 *  - quoteBuy/quoteSell are 3-arg only (account reflects gate discounts)
 *  - quotes ignore paused/gate/guard-window/tradingOpensAt → precheck first
 *  - near-graduation buys partial-fill: size minTokenOut off quoted tokenOut,
 *    surface the refund
 *  - sell minPairOut compares NET of fee (directly against quoteSell.pairOut)
 *  - sells need an ERC20 approve of the LAUNCH token (both variants)
 *  - USDC quote is 6-decimal — all conversions go through QuoteAssetInfo
 *  - createLaunch does not make a tradable token: keeper binds Reserved(7) →
 *    Trading(1); Cancelled(8) means bind deadline passed → withdrawRefund()
 */

import { formatUnits, maxUint256, parseUnits, zeroAddress, type Address } from "viem";

import type { PumpApi } from "../../api/pump.js";
import type { EvmSigner, WriteTxResult } from "../../chain/evm.js";
import type { NetworkDef, QuoteAssetInfo } from "../../chain/networks.js";
import { quoteAssetBySlot } from "../../chain/networks.js";
import { ToolError } from "../../errors.js";
import { encodeMetadataUri, type LaunchMetadata } from "../../metadata.js";
import { ERC20_ABI, LAUNCHPAD_ABI, LAUNCH_STATE_LABEL, LaunchState, PoolKind } from "./abi.js";

export interface LaunchView {
  state: number;
  creator: Address;
  token: Address;
  /** Per-launch sink contract — holds unsold curve supply, never a recipient. */
  sink: Address;
  quoteAsset: number;
  pairAsset: Address;
  gate: { gateToken: Address; minBalance: bigint; windowEndsAt: bigint; discountBps: number };
  tradingOpensAt: bigint;
  guardWindowEndsAt: bigint;
  maxBuyBpsInGuardWindow: number;
  virtualPair: bigint;
  realPair: bigint;
  tokensSold: bigint;
  graduationPairTarget: bigint;
  /** Snapshotted at createLaunch — NOT the current global quote-asset config. */
  tradeFeeBps: number;
  creatorFeeShareBps: number;
  metadataURI: string;
  bankDenom: string;
}

/**
 * The live per-quote terms a NEW launch would get. LaunchpadCore copies this
 * whole struct onto a launch at createLaunch, so an existing launch keeps the
 * config it launched with — these are the terms on offer today, not the terms
 * of any particular launch (which live on `LaunchView`).
 */
export interface QuoteAssetConfigView {
  pairAsset: Address;
  virtualPair: bigint;
  virtualToken: bigint;
  curveSupply: bigint;
  graduationPairTarget: bigint;
  graduationTokenReserve: bigint;
  enabled: boolean;
  bankDenom: string;
  requiresChoiceFactoryDust: boolean;
  tradeFeeBps: number;
  creatorFeeShareBps: number;
}

export interface TradeResult {
  hash: string | null;
  status: WriteTxResult["status"];
  launchId: string;
  side: "buy" | "sell";
  /** Human units of the pair asset that entered/left the curve. */
  pairAmount: string;
  /** Human units of launch tokens quoted out/in. */
  tokenAmount: string;
  quoteSymbol: string;
  /** Buy only: pair refunded because the buy crossed the graduation target. */
  refund?: string;
  warnings: string[];
  explorerUrl?: string;
}

const PRICE_CACHE_MS = 60_000;

export class ShroomVenue {
  private priceCache: { at: number; bySlot: Map<number, number> } | null = null;

  constructor(
    private readonly net: NetworkDef,
    private readonly signer: EvmSigner,
    private readonly pump: PumpApi,
    private readonly referrer: Address | null,
  ) {}

  private get core(): Address {
    return this.net.addresses.launchpadCore;
  }

  // ---- reads ---------------------------------------------------------------

  async getLaunchView(launchId: bigint): Promise<LaunchView> {
    const l = await this.signer.readContract<LaunchView & Record<string, unknown>>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "getLaunch",
      args: [launchId],
    });
    return {
      state: Number(l.state),
      creator: l.creator,
      token: l.token,
      sink: l.sink,
      quoteAsset: Number(l.quoteAsset),
      pairAsset: l.pairAsset,
      gate: {
        gateToken: l.gate.gateToken,
        minBalance: BigInt(l.gate.minBalance),
        windowEndsAt: BigInt(l.gate.windowEndsAt),
        discountBps: Number(l.gate.discountBps),
      },
      tradingOpensAt: BigInt(l.tradingOpensAt),
      guardWindowEndsAt: BigInt(l.guardWindowEndsAt),
      maxBuyBpsInGuardWindow: Number(l.maxBuyBpsInGuardWindow),
      virtualPair: BigInt(l.virtualPair),
      realPair: BigInt(l.realPair),
      tokensSold: BigInt(l.tokensSold),
      graduationPairTarget: BigInt(l.graduationPairTarget),
      tradeFeeBps: Number(l.tradeFeeBps),
      creatorFeeShareBps: Number(l.creatorFeeShareBps),
      metadataURI: String(l.metadataURI),
      bankDenom: String(l.bankDenom),
    };
  }

  // ---- protocol parameters (live — the docs quote no baked numbers) --------

  /** Creation fee in wei of INJ. Changeable by the owner without a redeploy. */
  async denomCreationFeeInj(): Promise<bigint> {
    return this.signer.readContract<bigint>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "denomCreationFeeInj",
      args: [],
    });
  }

  /**
   * Referrer's share of the CREATOR's fee cut, in bps. Global and NOT
   * snapshotted onto a launch, unlike everything in QuoteAssetConfig — a change
   * here applies to every existing launch immediately.
   */
  async referralShareBps(): Promise<number> {
    const v = await this.signer.readContract<number>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "referralShareBps",
      args: [],
    });
    return Number(v);
  }

  /** Platform fee treasury — also the default curve-buy referrer. */
  async treasury(): Promise<Address> {
    return this.signer.readContract<Address>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "treasury",
      args: [],
    });
  }

  async getQuoteAssetConfig(slot: number): Promise<QuoteAssetConfigView> {
    const c = await this.signer.readContract<QuoteAssetConfigView & Record<string, unknown>>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "getQuoteAssetConfig",
      args: [slot],
    });
    return {
      pairAsset: c.pairAsset,
      virtualPair: BigInt(c.virtualPair),
      virtualToken: BigInt(c.virtualToken),
      curveSupply: BigInt(c.curveSupply),
      graduationPairTarget: BigInt(c.graduationPairTarget),
      graduationTokenReserve: BigInt(c.graduationTokenReserve),
      enabled: Boolean(c.enabled),
      bankDenom: String(c.bankDenom),
      requiresChoiceFactoryDust: Boolean(c.requiresChoiceFactoryDust),
      tradeFeeBps: Number(c.tradeFeeBps),
      creatorFeeShareBps: Number(c.creatorFeeShareBps),
    };
  }

  /**
   * Decimals of a quote asset's pair token. Known slots come from the vendored
   * registry; unknown ones (slots 4..255 can be added without a redeploy) are
   * read off the ERC20 itself so a new quote asset explains correctly on the
   * day it appears.
   */
  async quoteDecimals(slot: number, pairAsset: Address): Promise<number> {
    const known = quoteAssetBySlot(this.net, slot);
    if (known) return known.decimals;
    try {
      const d = await this.signer.readContract<number>({
        address: pairAsset,
        abi: ERC20_ABI,
        functionName: "decimals",
        args: [],
      });
      return Number(d);
    } catch {
      return 18;
    }
  }

  /** ERC20 `symbol()`, for quote-asset slots not in the vendored registry. */
  async erc20Symbol(token: Address): Promise<string | null> {
    try {
      return await this.signer.readContract<string>({
        address: token,
        abi: ERC20_ABI,
        functionName: "symbol",
        args: [],
      });
    } catch {
      return null;
    }
  }

  async getState(launchId: bigint): Promise<number> {
    const s = await this.signer.readContract<number>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "getLaunchState",
      args: [launchId],
    });
    return Number(s);
  }

  async isPaused(): Promise<boolean> {
    return this.signer.readContract<boolean>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "paused",
      args: [],
    });
  }

  async quoteBuy(
    launchId: bigint,
    pairIn: bigint,
    account: Address,
  ): Promise<{ tokenOut: bigint; fee: bigint; refund: bigint }> {
    const [tokenOut, fee, refund] = await this.signer.readContract<[bigint, bigint, bigint]>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "quoteBuy",
      args: [launchId, pairIn, account],
    });
    return { tokenOut, fee, refund };
  }

  async quoteSell(
    launchId: bigint,
    tokenIn: bigint,
    account: Address,
  ): Promise<{ pairOut: bigint; fee: bigint }> {
    const [pairOut, fee] = await this.signer.readContract<[bigint, bigint]>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "quoteSell",
      args: [launchId, tokenIn, account],
    });
    return { pairOut, fee };
  }

  async erc20Balance(token: Address, owner: Address): Promise<bigint> {
    return this.signer.readContract<bigint>({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner],
    });
  }

  quoteInfo(slot: number): QuoteAssetInfo {
    const q = quoteAssetBySlot(this.net, slot);
    if (!q) throw new ToolError("bad_quote", `unknown quote asset slot ${slot}`);
    return q;
  }

  /** USD value of `amountWei` of the given quote asset (pump quote-prices). */
  async usdValue(slot: number, amountWei: bigint): Promise<number | null> {
    const q = this.quoteInfo(slot);
    try {
      if (!this.priceCache || Date.now() - this.priceCache.at > PRICE_CACHE_MS) {
        const { items } = await this.pump.quotePrices();
        this.priceCache = {
          at: Date.now(),
          bySlot: new Map(items.map((r) => [r.quoteAsset, Number(r.rateUsd)])),
        };
      }
      const rate = this.priceCache.bySlot.get(slot);
      if (rate === undefined || !Number.isFinite(rate)) return null;
      return Number(formatUnits(amountWei, q.decimals)) * rate;
    } catch {
      return null;
    }
  }

  // ---- tradability precheck ------------------------------------------------

  /**
   * Everything the on-chain quote does NOT check. Throws for hard blockers,
   * returns warnings for soft ones (guard window caps).
   */
  async precheckTrade(launchId: bigint, side: "buy" | "sell"): Promise<{ launch: LaunchView; warnings: string[] }> {
    if (await this.isPaused()) {
      throw new ToolError("paused", "the launchpad is paused — trading is temporarily disabled");
    }
    const launch = await this.getLaunchView(launchId);
    const state = launch.state;
    if (state !== LaunchState.Trading) {
      const label = LAUNCH_STATE_LABEL[state] ?? String(state);
      if (state === LaunchState.Graduated) {
        throw new ToolError(
          "graduated",
          `launch #${launchId} has graduated — it trades on Choice now`,
          "use the `quote`/`buy`/`sell` tools without venue override (they auto-route to Choice), or choice_swap directly",
        );
      }
      if (state === LaunchState.Reserved) {
        throw new ToolError("binding", `launch #${launchId} is still binding (keeper) — retry shortly`);
      }
      if (state === LaunchState.Cancelled) {
        throw new ToolError(
          "cancelled",
          `launch #${launchId} was cancelled (bind deadline passed)`,
          "the creator can reclaim the fee with claim_fees",
        );
      }
      throw new ToolError("not_tradable", `launch #${launchId} is ${label} — not curve-tradable`);
    }

    const warnings: string[] = [];
    const now = BigInt(Math.floor(Date.now() / 1000));

    if (side === "buy") {
      if (launch.tradingOpensAt > now) {
        throw new ToolError(
          "not_open",
          `trading opens at ${new Date(Number(launch.tradingOpensAt) * 1000).toISOString()}`,
        );
      }
      const gateActive =
        launch.gate.gateToken !== zeroAddress &&
        launch.gate.minBalance > 0n &&
        launch.gate.windowEndsAt > now;
      if (gateActive) {
        const bal = await this.erc20Balance(launch.gate.gateToken, this.signer.address);
        if (bal < launch.gate.minBalance) {
          throw new ToolError(
            "gated",
            `launch #${launchId} is gate-restricted until ${new Date(Number(launch.gate.windowEndsAt) * 1000).toISOString()} — the agent wallet does not hold enough of the gate token ${launch.gate.gateToken}`,
          );
        }
      }
      if (launch.guardWindowEndsAt > now && launch.maxBuyBpsInGuardWindow > 0) {
        const cap = (launch.graduationPairTarget * BigInt(launch.maxBuyBpsInGuardWindow)) / 10_000n;
        const q = this.quoteInfo(launch.quoteAsset);
        warnings.push(
          `guard window until ${new Date(Number(launch.guardWindowEndsAt) * 1000).toISOString()}: cumulative buys capped at ${formatUnits(cap, q.decimals)} ${q.symbol} per wallet`,
        );
      }
    }
    return { launch, warnings };
  }

  // ---- approvals -----------------------------------------------------------

  private async ensureApproval(token: Address, need: bigint): Promise<void> {
    const have = await this.signer.readContract<bigint>({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [this.signer.address, this.core],
    });
    if (have >= need) return;
    await this.signer.writeTx({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [this.core, maxUint256],
      // Security-relevant counterparty is the SPENDER — always the core.
      intent: { kind: "approve", target: this.core, detail: `approve ${token} → LaunchpadCore` },
    });
  }

  private resolveReferrer(launch: LaunchView): Address {
    const r = this.referrer;
    if (!r) return zeroAddress;
    const rl = r.toLowerCase();
    if (rl === this.signer.address.toLowerCase() || rl === launch.creator.toLowerCase()) {
      return zeroAddress; // contract forbids referrer == buyer or == creator
    }
    return r;
  }

  private deadline(): bigint {
    return BigInt(Math.floor(Date.now() / 1000) + 120);
  }

  // ---- execution -----------------------------------------------------------

  async buy(launchId: bigint, amountHuman: string, slippageBps: number): Promise<TradeResult> {
    const { launch, warnings } = await this.precheckTrade(launchId, "buy");
    const q = this.quoteInfo(launch.quoteAsset);
    const pairIn = parseUnits(amountHuman, q.decimals);
    if (pairIn <= 0n) throw new ToolError("bad_amount", "amount must be positive");

    const quote = await this.quoteBuy(launchId, pairIn, this.signer.address);
    if (quote.tokenOut <= 0n) {
      throw new ToolError("no_output", "quoteBuy returned zero tokens — amount too small?");
    }
    const minTokenOut = (quote.tokenOut * BigInt(10_000 - slippageBps)) / 10_000n;
    const effectiveIn = pairIn - quote.refund;
    if (quote.refund > 0n) {
      warnings.push(
        `buy crosses the graduation target: only ${formatUnits(effectiveIn, q.decimals)} ${q.symbol} fills, ${formatUnits(quote.refund, q.decimals)} refunds in the same tx, and the launch will graduate`,
      );
    }

    const spendUsd = await this.usdValue(launch.quoteAsset, effectiveIn);
    const referrer = this.resolveReferrer(launch);
    const balBefore = await this.erc20Balance(launch.token, this.signer.address).catch(() => 0n);
    const confirm = async () =>
      (await this.erc20Balance(launch.token, this.signer.address)) > balBefore;
    const intent = {
      kind: "trade" as const,
      target: this.core,
      detail: `buy #${launchId} ${amountHuman} ${q.symbol}`,
      spendUsd,
    };

    let res: WriteTxResult;
    if (q.isNative) {
      res = await this.signer.writeTx({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "buyNative",
        args: [launchId, minTokenOut, referrer, this.deadline()],
        value: pairIn,
        intent,
        confirm,
      });
    } else {
      await this.ensureApproval(q.pairAsset, pairIn);
      res = await this.signer.writeTx({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "buy",
        args: [launchId, pairIn, minTokenOut, referrer, this.deadline()],
        intent,
        confirm,
      });
    }

    return this.tradeResult(res, launchId, "buy", effectiveIn, quote.tokenOut, q, warnings, quote.refund);
  }

  async sell(
    launchId: bigint,
    tokenAmountHuman: string | "all",
    slippageBps: number,
  ): Promise<TradeResult> {
    const { launch, warnings } = await this.precheckTrade(launchId, "sell");
    const q = this.quoteInfo(launch.quoteAsset);

    const balance = await this.erc20Balance(launch.token, this.signer.address);
    if (balance <= 0n) {
      throw new ToolError("no_balance", `the agent wallet holds no tokens of launch #${launchId}`);
    }
    const tokenIn = tokenAmountHuman === "all" ? balance : parseUnits(tokenAmountHuman, 18);
    if (tokenIn <= 0n) throw new ToolError("bad_amount", "amount must be positive");
    if (tokenIn > balance) {
      throw new ToolError(
        "no_balance",
        `amount exceeds balance (${formatUnits(balance, 18)} tokens held)`,
        'pass "all" to sell the whole position',
      );
    }

    const quote = await this.quoteSell(launchId, tokenIn, this.signer.address);
    if (quote.pairOut <= 0n) {
      throw new ToolError("no_output", "quoteSell returned zero — amount too small?");
    }
    // minPairOut is compared NET of fee on-chain — same basis as the quote.
    const minPairOut = (quote.pairOut * BigInt(10_000 - slippageBps)) / 10_000n;

    await this.ensureApproval(launch.token, tokenIn);
    const balBefore = await this.erc20Balance(launch.token, this.signer.address);
    const confirm = async () =>
      (await this.erc20Balance(launch.token, this.signer.address)) < balBefore;

    const res = await this.signer.writeTx({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: q.isNative ? "sellNative" : "sell",
      args: [launchId, tokenIn, minPairOut, this.deadline()],
      // Sells convert the token back to the quote asset — funds stay in the
      // wallet, so they don't consume the USD spend budget (spendUsd: 0).
      intent: {
        kind: "trade",
        target: this.core,
        detail: `sell #${launchId} ${formatUnits(tokenIn, 18)} tokens`,
        spendUsd: 0,
      },
      confirm,
    });

    return this.tradeResult(res, launchId, "sell", quote.pairOut, tokenIn, q, warnings);
  }

  private tradeResult(
    res: WriteTxResult,
    launchId: bigint,
    side: "buy" | "sell",
    pairWei: bigint,
    tokenWei: bigint,
    q: QuoteAssetInfo,
    warnings: string[],
    refundWei?: bigint,
  ): TradeResult {
    return {
      hash: res.hash,
      status: res.status,
      launchId: launchId.toString(),
      side,
      pairAmount: formatUnits(pairWei, q.decimals),
      tokenAmount: formatUnits(tokenWei, 18),
      quoteSymbol: q.symbol,
      ...(refundWei && refundWei > 0n ? { refund: formatUnits(refundWei, q.decimals) } : {}),
      warnings,
      ...(res.hash ? { explorerUrl: `${this.net.explorerTxBase}${res.hash}` } : {}),
    };
  }

  // ---- launch creation -----------------------------------------------------

  async createLaunch(opts: {
    meta: LaunchMetadata;
    quoteSymbol: "INJ" | "USDC" | "SAI";
  }): Promise<{
    launchId: string;
    token: string | null;
    state: string;
    hash: string | null;
    status: string;
    creationFeeInj: string;
    warnings: string[];
  }> {
    if (await this.isPaused()) {
      throw new ToolError("paused", "the launchpad is paused — launches are temporarily disabled");
    }
    const q = this.net.quoteAssets[opts.quoteSymbol];
    if (!q) throw new ToolError("bad_quote", `unknown quote asset ${opts.quoteSymbol}`);

    const fee = await this.signer.readContract<bigint>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "denomCreationFeeInj",
      args: [],
    });
    // Predict the launch id BEFORE sending — receipts lag on inj-EVM, and the
    // id is assigned sequentially (nextLaunchId++). Verified against creator
    // in confirm() in case another launch lands in between.
    const predictedId = await this.signer.readContract<bigint>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "nextLaunchId",
      args: [],
    });

    const cfg = {
      name: opts.meta.name,
      symbol: opts.meta.symbol,
      metadataURI: encodeMetadataUri(opts.meta),
      quoteAsset: q.slot,
      gate: { gateToken: zeroAddress, minBalance: 0n, windowEndsAt: 0n, discountBps: 0 },
      tradingOpensAt: 0n,
      guardWindowEndsAt: 0n,
      maxBuyBpsInGuardWindow: 0,
      bindDeadlineSeconds: 0n, // contract default (1h)
      poolKind: PoolKind.Clmm, // mainnet only allows CLMM graduation
    };

    const feeUsd = await this.usdValue(this.net.quoteAssets.INJ!.slot, fee);
    const resolveOurId = async (): Promise<bigint | null> => {
      for (let id = predictedId; id < predictedId + 4n; id++) {
        try {
          const l = await this.getLaunchView(id);
          if (l.creator.toLowerCase() === this.signer.address.toLowerCase()) return id;
        } catch {
          break; // id not created yet
        }
      }
      return null;
    };

    const res = await this.signer.writeTx({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "createLaunch",
      args: [cfg],
      value: fee,
      intent: {
        kind: "launch",
        target: this.core,
        detail: `createLaunch ${opts.meta.symbol} (${opts.quoteSymbol})`,
        spendUsd: feeUsd,
      },
      confirm: async () => (await resolveOurId()) !== null,
    });

    if (res.status === "dry-run") {
      return {
        launchId: predictedId.toString(),
        token: null,
        state: "dry-run",
        hash: null,
        status: "dry-run",
        creationFeeInj: formatUnits(fee, 18),
        warnings: [],
      };
    }
    if (res.status === "reverted") {
      throw new ToolError("launch_failed", "createLaunch reverted");
    }

    const launchId = (await resolveOurId()) ?? predictedId;
    const warnings: string[] = [];

    // Poll Reserved(7) → Trading(1): the keeper mints + binds the bank token.
    // Usually seconds; give it 90s before handing back a "still binding".
    let state = LaunchState.Reserved as number;
    let token: string | null = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        state = await this.getState(launchId);
        if (state === LaunchState.Trading) {
          token = (await this.getLaunchView(launchId)).token;
          break;
        }
        if (state === LaunchState.Cancelled) {
          throw new ToolError(
            "launch_cancelled",
            `launch #${launchId} was cancelled before binding`,
            "reclaim the creation fee with claim_fees",
          );
        }
      } catch (e) {
        if (e instanceof ToolError) throw e;
        // reads flake — keep polling
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (state !== LaunchState.Trading) {
      warnings.push(
        "the keeper has not bound the token yet — check token_info for this launch id in a minute; trading opens automatically once it flips to Trading",
      );
    }

    return {
      launchId: launchId.toString(),
      token,
      state: LAUNCH_STATE_LABEL[state] ?? String(state),
      hash: res.hash,
      status: res.status,
      creationFeeInj: formatUnits(fee, 18),
      warnings,
    };
  }

  // ---- claims --------------------------------------------------------------

  async claimAll(launchIds: bigint[]): Promise<{
    creatorFees: { launchId: string; amount: string }[];
    referralFees: { pairAsset: string; symbol: string; amount: string }[];
    refundInj: string | null;
    txHashes: string[];
    notes: string[];
  }> {
    const me = this.signer.address;
    const txHashes: string[] = [];
    const notes: string[] = [];

    // Reads first — every claim fn reverts NothingToClaim() on zero.
    const creatorOwed: { launchId: bigint; amount: bigint; q: QuoteAssetInfo }[] = [];
    for (const id of launchIds) {
      const owed = await this.signer.readContract<bigint>({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "creatorFeesOwed",
        args: [id],
      });
      if (owed > 0n) {
        const launch = await this.getLaunchView(id);
        creatorOwed.push({ launchId: id, amount: owed, q: this.quoteInfo(launch.quoteAsset) });
      }
    }
    if (creatorOwed.length === 1) {
      const r = await this.signer.writeTx({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "claimCreatorFees",
        args: [creatorOwed[0]!.launchId],
        intent: { kind: "claim", target: this.core, detail: `claimCreatorFees #${creatorOwed[0]!.launchId}` },
      });
      if (r.hash) txHashes.push(r.hash);
    } else if (creatorOwed.length > 1) {
      const r = await this.signer.writeTx({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "claimCreatorFeesMany",
        args: [creatorOwed.map((c) => c.launchId)],
        intent: { kind: "claim", target: this.core, detail: `claimCreatorFeesMany ×${creatorOwed.length}` },
      });
      if (r.hash) txHashes.push(r.hash);
    }

    const referral: { pairAsset: string; symbol: string; amount: string }[] = [];
    for (const q of Object.values(this.net.quoteAssets)) {
      const owed = await this.signer.readContract<bigint>({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "referralFeesOwed",
        args: [me, q.pairAsset],
      });
      if (owed > 0n) {
        const r = await this.signer.writeTx({
          address: this.core,
          abi: LAUNCHPAD_ABI,
          functionName: "claimReferralFees",
          args: [q.pairAsset],
          intent: { kind: "claim", target: this.core, detail: `claimReferralFees ${q.symbol}` },
        });
        if (r.hash) txHashes.push(r.hash);
        referral.push({ pairAsset: q.pairAsset, symbol: q.symbol, amount: formatUnits(owed, q.decimals) });
      }
    }

    let refundInj: string | null = null;
    const refundOwed = await this.signer.readContract<bigint>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "refundsOwed",
      args: [me],
    });
    if (refundOwed > 0n) {
      const r = await this.signer.writeTx({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "withdrawRefund",
        args: [],
        intent: { kind: "claim", target: this.core, detail: "withdrawRefund" },
      });
      if (r.hash) txHashes.push(r.hash);
      refundInj = formatUnits(refundOwed, 18);
    }

    if (creatorOwed.length === 0 && referral.length === 0 && refundOwed === 0n) {
      notes.push("nothing to claim — all ledgers are zero");
    }

    return {
      creatorFees: creatorOwed.map((c) => ({
        launchId: c.launchId.toString(),
        amount: `${formatUnits(c.amount, c.q.decimals)} ${c.q.symbol}`,
      })),
      referralFees: referral,
      refundInj,
      txHashes,
      notes,
    };
  }
}
