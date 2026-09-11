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
import type { CoreDeployment, NetworkDef, QuoteAssetInfo } from "../../chain/networks.js";
import {
  coreDeploymentFor,
  currentCoreDeployment,
  quoteAssetBySlot,
} from "../../chain/networks.js";
import { ToolError } from "../../errors.js";
import { assertBrandable, encodeMetadataUri, type LaunchMetadata } from "../../metadata.js";
import {
  devBuyFloatBps,
  MAX_DEV_BUY_BPS,
  MAX_DEV_FLOAT_BPS,
  MAX_DISCOUNT_BPS,
  MAX_OPEN_DELAY_SECONDS,
  maxDevBuyBpsFor,
  MIN_SAFE_OPEN_DELAY_SECONDS,
  SHAPE_FLOAT_BPS,
  SHAPE_LP_BPS,
  type CurvePreset,
} from "./curves.js";
import {
  CURVE_REGISTRY_ABI,
  ERC20_ABI,
  LAUNCHPAD_ABI,
  LAUNCHPAD_VIEWS_ABI,
  LAUNCHPAD_WRITE_V2_ABI,
  LAUNCH_STATE_LABEL,
  LaunchState,
  PoolKind,
} from "./abi.js";

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
  /**
   * CurveRegistry preset this launch was created with. `null` on a v1 network,
   * where the curve was a property of the quote asset and there was nothing to
   * choose. 0 is the standard preset, which reproduces the v1 curve exactly.
   */
  curveId: number | null;
  metadataURI: string;
  bankDenom: string;
}

/**
 * Everything one core owes a wallet, read-only.
 *
 * Creator fees are per (launch, core): the same on-chain id names a different
 * launch on every other core, so the ids here are only meaningful next to the
 * venue they were read from. Referral fees and refunds are per WALLET, but
 * each core keeps its own copy of those ledgers too — a wallet with history on
 * a superseded core is owed on both.
 */
export interface ClaimableLedgers {
  creator: { launchId: bigint; amount: bigint; quote: QuoteAssetInfo }[];
  referral: { quote: QuoteAssetInfo; amount: bigint }[];
  /** Cancelled-launch creation-fee refunds, in INJ base units. */
  refund: bigint;
}

/**
 * The live per-quote terms a NEW launch would get. LaunchpadCore copies this
 * whole struct onto a launch at createLaunch, so an existing launch keeps the
 * config it launched with — these are the terms on offer today, not the terms
 * of any particular launch (which live on `LaunchView`).
 */
export interface QuoteAssetConfigView {
  pairAsset: Address;
  /**
   * Curve SHAPE, and only on v1. On v2 the curve is chosen per launch from the
   * CurveRegistry and these four fields no longer exist on the quote config —
   * they are `null`, and a launch's real shape comes from `LaunchView`.
   * Rendering a per-quote curve as "the" curve is wrong on v2: two launches on
   * the same quote can have completely different ones.
   */
  virtualPair: bigint | null;
  virtualToken: bigint | null;
  curveSupply: bigint | null;
  /** The quote's BASE raise size. Survives on v2; presets scale it. */
  graduationPairTarget: bigint;
  graduationTokenReserve: bigint | null;
  enabled: boolean;
  bankDenom: string;
  requiresChoiceFactoryDust: boolean;
  tradeFeeBps: number;
  creatorFeeShareBps: number;
}

export interface TradeResult {
  hash: string | null;
  status: WriteTxResult["status"];
  /**
   * The traded launch's id ON ITS OWN CORE. Deliberately not `launchId`: the
   * tool layer adds that, and it is the API's surrogate — the id every other
   * surface prints and the only one a caller can look the launch up by. A buy
   * of surrogate 21 executes against on-chain 2, and reporting "2" back named
   * a different, real launch on the other core.
   */
  onchainId: string;
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
    /**
     * The core this instance acts against. Null = the current one, which is
     * correct for `createLaunch` and for any network serving a single core.
     * Set by `forLaunch` for everything scoped to an EXISTING launch.
     */
    private readonly bound: CoreDeployment | null = null,
  ) {}

  /**
   * A clone bound to the core that owns `launch`.
   *
   * Every read and write below addresses a launch by a bare on-chain id, and
   * ids are per core: the same id exists on both deployed cores and naming the
   * wrong one returns a real, valid, DIFFERENT launch rather than an error. So
   * a launch-scoped call must go through here, and an unresolvable core is a
   * refusal — never a fallback to the current core, which is exactly the
   * substitution this guards against.
   */
  forLaunch(launch: { core?: string | null }): ShroomVenue {
    const dep = coreDeploymentFor(this.net, launch.core);
    if (!dep) {
      throw new ToolError(
        "unknown_core",
        `this launch lives on LaunchpadCore ${launch.core ?? "(unnamed)"}, which this build does not know. Upgrade trippy-mcp.`,
      );
    }
    return new ShroomVenue(this.net, this.signer, this.pump, this.referrer, dep);
  }

  private get deployment(): CoreDeployment {
    return this.bound ?? currentCoreDeployment(this.net);
  }

  private get core(): Address {
    return this.deployment.core;
  }

  /** Where `getLaunch` / `getQuoteAssetConfig` live: views on v2, core on v1. */
  private get views(): Address {
    return this.deployment.views;
  }

  /** True where the launchpad runs CurveRegistry + LaunchpadViews. */
  private get v2(): boolean {
    return this.deployment.hasCurveId;
  }

  /** True where a creator can choose a curve at all. */
  get curvesSelectable(): boolean {
    return this.v2 && Boolean(this.deployment.curveRegistry);
  }

  // ---- reads ---------------------------------------------------------------

  async getLaunchView(launchId: bigint): Promise<LaunchView> {
    // The v2 `Launch` tuple carries `curveId`, which shifts every field after
    // it — so the ABI is chosen by network rather than assumed. Both are read
    // from `this.views`, which is the core itself on v1.
    const l = await this.signer.readContract<LaunchView & Record<string, unknown>>({
      address: this.views,
      abi: (this.v2 ? LAUNCHPAD_VIEWS_ABI : LAUNCHPAD_ABI) as never,
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
      curveId: this.v2 ? Number(l.curveId ?? 0) : null,
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

  /**
   * Is this core ATOMIC — does it issue, bind and open a launch inside
   * `createLaunch`?
   *
   * 🔑 PROBED, never configured. `launchTokenFactory()` returns a non-zero
   * address on an atomic core and REVERTS on every earlier one (the selector
   * does not exist), and it is a property of the deployed bytecode, so a core
   * cannot change kind over its life. Only a revert reads as "pre-atomic": an
   * RPC failure must not be mistaken for an answer, so it propagates.
   *
   * Cached per instance — a venue is bound to one core.
   */
  private atomicProbe: Promise<boolean> | null = null;
  async isAtomicCore(): Promise<boolean> {
    if (!this.atomicProbe) {
      this.atomicProbe = (async () => {
        try {
          const a = await this.signer.readContract<Address>({
            address: this.core,
            abi: LAUNCHPAD_ABI,
            functionName: "launchTokenFactory",
            args: [],
          });
          return !!a && !/^0x0{40}$/i.test(a);
        } catch {
          // An unanswerable probe reads as PRE-ATOMIC, which is exactly the
          // behaviour every caller had before this existed. Refusing instead
          // would turn a transient RPC blip into a blocked launch on the live
          // pre-atomic core — trading a real regression for a hypothetical one.
          // Anything this gates is a pre-flight check on a path that is about to
          // spend the chain anyway, so a chain it cannot read fails a moment later.
          return false;
        }
      })();
    }
    return this.atomicProbe;
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

  /**
   * The curated curve menu, or null where there is none (a v1 network, where
   * the curve belongs to the quote asset and there is nothing to choose).
   *
   * `floatBps`/`lpBps` come from the registry's own `shapeOf`, not from local
   * arithmetic: they are the two numbers a creator actually picks between, and
   * a reimplementation of the contract's rounding would drift the moment
   * `MIN_LP_BPS` or the ceiling form changed — silently, and in the direction
   * of over-promising float.
   */
  async curvePresets(): Promise<CurvePreset[] | null> {
    const registry = this.deployment.curveRegistry;
    if (!this.v2 || !registry) return null;

    const raw = await this.signer.readContract<
      readonly {
        virtualToken: bigint;
        rBps: number | bigint;
        targetMulBps: number | bigint;
        quoteMask: number | bigint;
        enabled: boolean;
        name: string;
      }[]
    >({
      address: registry,
      abi: CURVE_REGISTRY_ABI,
      functionName: "getPresets",
      args: [],
    });

    // 🔴 `shapeOf` has FIVE outputs, so it decodes to a positional tuple, not
    // an object — viem only keys a result by name for a single struct return.
    // Reading `.floatBps` off it yielded `undefined` -> `NaN` -> `null` on the
    // wire, and the `shape ? … : 0` guard never fired because an array is
    // truthy. Indices, and a test that asserts the arity.
    const shapes = await Promise.all(
      raw.map((_, i) =>
        this.signer
          .readContract<readonly [bigint, bigint, bigint, bigint, bigint]>({
            address: registry,
            abi: CURVE_REGISTRY_ABI,
            functionName: "shapeOf",
            args: [i],
          })
          // One dead entry must not take down the whole menu.
          .catch(() => null),
      ),
    );

    return raw.map((p, i) => {
      const shape = shapes[i];
      return {
        id: i,
        name: String(p.name),
        rBps: Number(p.rBps),
        targetMulBps: Number(p.targetMulBps),
        quoteMask: Number(p.quoteMask),
        enabled: Boolean(p.enabled),
        floatBps: shape ? Number(shape[SHAPE_FLOAT_BPS]) : null,
        lpBps: shape ? Number(shape[SHAPE_LP_BPS]) : null,
        virtualToken: Number(formatUnits(BigInt(p.virtualToken), 18)),
      };
    });
  }

  async getQuoteAssetConfig(slot: number): Promise<QuoteAssetConfigView> {
    const c = await this.signer.readContract<Record<string, unknown>>({
      address: this.views,
      abi: (this.v2 ? LAUNCHPAD_VIEWS_ABI : LAUNCHPAD_ABI) as never,
      functionName: "getQuoteAssetConfig",
      args: [slot],
    });
    // On v2 the four curve-shape fields are simply not on this struct any more
    // — the curve is per launch. Reporting a per-quote curve there would be a
    // confident lie, so they are null and callers must read `LaunchView`.
    return {
      pairAsset: c.pairAsset as Address,
      virtualPair: this.v2 ? null : BigInt(c.virtualPair as bigint),
      virtualToken: this.v2 ? null : BigInt(c.virtualToken as bigint),
      curveSupply: this.v2 ? null : BigInt(c.curveSupply as bigint),
      graduationPairTarget: BigInt(c.graduationPairTarget as bigint),
      graduationTokenReserve: this.v2 ? null : BigInt(c.graduationTokenReserve as bigint),
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

  async erc20Decimals(token: Address): Promise<number> {
    const d = await this.signer.readContract<number | bigint>({
      address: token,
      abi: ERC20_ABI,
      functionName: "decimals",
      args: [],
    });
    return Number(d);
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
      // Mirrors `_buy`'s pre-open gate. The creator is let through early for
      // the genuine FIRST trade only (`tokensSold == 0`) — that exclusive
      // pre-open buy is the whole point of setting an open delay, so refusing
      // it here would make the feature unusable through this package while the
      // contract was happily allowing it.
      const creatorsFirstBuy =
        launch.creator.toLowerCase() === this.signer.address.toLowerCase() &&
        launch.tokensSold === 0n;
      if (launch.tradingOpensAt > now && !creatorsFirstBuy) {
        throw new ToolError(
          "not_open",
          `trading opens at ${new Date(Number(launch.tradingOpensAt) * 1000).toISOString()}`,
          launch.creator.toLowerCase() === this.signer.address.toLowerCase()
            ? "the creator's exclusive pre-open buy is the first trade only, and this launch has already sold tokens"
            : undefined,
        );
      }
      if (creatorsFirstBuy && launch.tradingOpensAt > now) {
        warnings.push(
          `pre-open creator buy: public trading opens at ${new Date(Number(launch.tradingOpensAt) * 1000).toISOString()}, and this exclusivity applies to this first trade only`,
        );
      }
      // Mirrors `_checkGate`. Two rules that the previous version had wrong and
      // that now matter, because `create_token` can set these: a gate with a
      // DISCOUNT (discountBps != 0) restricts nobody, and `windowEndsAt == 0`
      // means the access gate never expires rather than that it has expired.
      const gateActive =
        launch.gate.gateToken !== zeroAddress &&
        launch.gate.discountBps === 0 &&
        (launch.gate.windowEndsAt === 0n || now < launch.gate.windowEndsAt);
      if (gateActive) {
        const bal = await this.erc20Balance(launch.gate.gateToken, this.signer.address);
        if (bal < launch.gate.minBalance) {
          throw new ToolError(
            "gated",
            `launch #${launchId} is gate-restricted ${launch.gate.windowEndsAt === 0n ? "with no expiry" : `until ${new Date(Number(launch.gate.windowEndsAt) * 1000).toISOString()}`} — the agent wallet does not hold enough of the gate token ${launch.gate.gateToken}`,
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

    // The guard-window cap is charged on the GROSS in, and `_accrueGuardWindow`
    // reverts the whole buy when the running total crosses it. Catching it here
    // turns an opaque `GuardWindowExceeded` into the number to use instead —
    // and this is exactly the path a creator's own dev buy takes.
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (launch.guardWindowEndsAt > now && launch.maxBuyBpsInGuardWindow > 0) {
      const cap = (launch.graduationPairTarget * BigInt(launch.maxBuyBpsInGuardWindow)) / 10_000n;
      if (pairIn > cap) {
        throw new ToolError(
          "guard_window",
          `guard window caps each wallet at ${formatUnits(cap, q.decimals)} ${q.symbol} until ${new Date(Number(launch.guardWindowEndsAt) * 1000).toISOString()}, and this buy is ${amountHuman}`,
          "buy up to the cap now and the rest once the window closes",
        );
      }
    }

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
      onchainId: launchId.toString(),
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

  /**
   * Turn a dev-buy request into the three timing fields, refusing anything
   * `_validateDevBuy` would revert on.
   *
   * The contract's rule is that exclusivity has to come WITH a cap: a pre-open
   * window where the creator is the only permitted buyer and nothing bounds the
   * buy lets them take the entire curve in one uncontested transaction. So an
   * uncapped or unbounded request is refused rather than sent — a revert here
   * costs the gas and says `DevBuyUncapped(0, 2000)`, which is not something an
   * agent can act on.
   *
   * The float ceiling is the interesting one, because it is per CURVE. A 2000
   * bps cap is 46.67% of the float on the standard curve and 65.71% on `steep`,
   * and only the second one reverts. `maxDevBuyBpsFor` inverts that so the
   * refusal can name the actual maximum for the curve being launched on.
   */
  private async resolveLaunchTiming(
    devBuy: { openDelaySeconds: number; maxBuyBps?: number; allowShortWindow?: boolean } | undefined,
    curveId: number,
    quoteSlot: number,
  ): Promise<{ tradingOpensAt: bigint; guardWindowEndsAt: bigint; maxBuyBpsInGuardWindow: number }> {
    const off = { tradingOpensAt: 0n, guardWindowEndsAt: 0n, maxBuyBpsInGuardWindow: 0 };
    if (!devBuy) return off;
    // An immediate open is deliberately unconstrained by the contract: there is
    // no exclusive period to abuse and the first buy is a fair race.
    if (devBuy.openDelaySeconds <= 0) return off;

    if (devBuy.openDelaySeconds > MAX_OPEN_DELAY_SECONDS) {
      throw new ToolError(
        "bad_dev_buy",
        `openDelaySeconds ${devBuy.openDelaySeconds} is over the contract's ceiling of ${MAX_OPEN_DELAY_SECONDS} (24h)`,
      );
    }
    // The contract has no floor: it will take a 1-second window happily, and
    // the launch that comes out is valid. It just is not the launch that was
    // asked for, because the window has to outlast the keeper bind and the
    // bind alone has measured up to 65s. Refuse here, BEFORE the creation fee
    // and the buy are spent — the same fact after the fact is only a warning
    // on timing that is already frozen onto the launch.
    if (!devBuy.allowShortWindow && devBuy.openDelaySeconds < MIN_SAFE_OPEN_DELAY_SECONDS) {
      throw new ToolError(
        "dev_buy_window_too_short",
        `a ${devBuy.openDelaySeconds}s exclusive window will probably lapse before the opening buy lands: it has to contain the keeper bind AND the buy, and the bind alone has measured 28-65s (median 53s) on mainnet. The buy would still succeed, as a PUBLIC one, on a launch opening at a moment every watcher can predict.`,
        `use devBuyDelaySeconds ${MIN_SAFE_OPEN_DELAY_SECONDS} or more, or pass allowShortDevBuyWindow: true to accept the risk — the timing cannot be changed once the launch exists`,
      );
    }
    if (devBuy.maxBuyBps !== undefined && (devBuy.maxBuyBps <= 0 || devBuy.maxBuyBps > MAX_DEV_BUY_BPS)) {
      throw new ToolError(
        "bad_dev_buy",
        `maxBuyBps must be between 1 and ${MAX_DEV_BUY_BPS} — the contract refuses a pre-open window without a cap that binds it`,
      );
    }

    // 🔴 THE WHOLE FEATURE INVERTS ON AN ATOMIC CORE, and it does not fail
    // loudly — it fails as a launch that opens at a moment every watcher can
    // predict, with the creator locked out of its own window.
    //
    // The pre-atomic shape this was written for: `createLaunch` reserves, the
    // KEEPER binds the token some seconds later, and the creator then buys in a
    // SEPARATE transaction before `tradingOpensAt`. `_buy` let the creator
    // through early, which is what made the window exclusive to them.
    //
    // The atomic core issues and binds inside `createLaunch`, and its `_buy`
    // carries "the trading-open gate, with NO creator exemption: the creator's
    // one exclusive buy is the opening buy inside `createLaunch`". So a separate
    // buy during the window REVERTS `TradingNotOpen` for the entire delay, and
    // the first buy that can land is a public one on a launch whose open time is
    // public knowledge. Setting the delay is strictly worse than not setting it.
    //
    // The exclusive buy still exists there — as `createLaunchWithOptions`'s
    // `devBuyPairIn`, paid in the SAME transaction with `msg.value` = fee + buy.
    // This client does not build that call yet, so it refuses the parameter
    // rather than selling the caller a window it cannot use. Refused BEFORE the
    // creation fee is spent: after the fact the timing is frozen onto the launch.
    if (await this.isAtomicCore()) {
      throw new ToolError(
        "dev_buy_not_supported_on_this_core",
        "this core issues and binds the token inside createLaunch, and its buy() has no creator exemption — a separate opening buy would revert TradingNotOpen for the whole window, then land as a PUBLIC buy at an open time everyone can predict. An exclusive opening buy on this core has to be atomic (createLaunchWithOptions), which this client does not build yet.",
        "drop devBuyDelaySeconds: on this core a launch is Trading the moment the create lands, so an immediate initialBuy is already the first buy in the ordinary race",
      );
    }

    // Price the cap against THIS launch's curve, exactly as the contract does.
    const preset = this.curvesSelectable
      ? (await this.curvePresets())?.find((p) => p.id === curveId)
      : null;

    // No cap named: take the most this CURVE allows rather than the absolute
    // maximum. They are the same on six of seven presets, and on `steep` the
    // absolute maximum reverts — refusing a launch over a default the caller
    // never chose is a bad trade for one line of arithmetic. An explicit
    // over-cap value is still refused: silently changing what was asked for is
    // the one thing that must not happen to a parameter frozen at creation.
    const maxBuyBps =
      devBuy.maxBuyBps ??
      (preset ? Math.min(MAX_DEV_BUY_BPS, maxDevBuyBpsFor(preset.rBps)) : MAX_DEV_BUY_BPS);

    if (preset) {
      const floatBps = devBuyFloatBps(preset.rBps, maxBuyBps);
      if (floatBps > MAX_DEV_FLOAT_BPS) {
        const max = maxDevBuyBpsFor(preset.rBps);
        throw new ToolError(
          "bad_dev_buy",
          `a ${maxBuyBps} bps dev buy takes ${(floatBps / 100).toFixed(2)}% of the float on the "${preset.name}" curve, over the contract's ${MAX_DEV_FLOAT_BPS / 100}% ceiling`,
          `the most this curve allows is ${max} bps (${(devBuyFloatBps(preset.rBps, max) / 100).toFixed(2)}% of float) — steeper curves hit the ceiling sooner`,
        );
      }
    }
    void quoteSlot; // the float ratio is quote-invariant; the slot is not needed

    const opensAt = BigInt(Math.floor(Date.now() / 1000) + devBuy.openDelaySeconds);
    return {
      tradingOpensAt: opensAt,
      // Ends exactly when public trading opens, so the cap covers the whole
      // creator-only window. A window that lapsed first would leave a stretch
      // where the creator is the only permitted buyer and uncapped, which the
      // contract rejects as the same hole by another route.
      guardWindowEndsAt: opensAt,
      maxBuyBpsInGuardWindow: maxBuyBps,
    };
  }

  /**
   * Normalise a gate, refusing what `_validateGate` would revert on.
   *
   * The two modes are distinguished by `discountBps`, and they are not variants
   * of one feature: non-zero is a fee DISCOUNT for qualifying holders and
   * restricts nobody, zero is a hard ACCESS gate that stops everyone else from
   * buying at all. Getting that backwards closes a launch to the public by
   * accident, so the caller states it and this refuses the malformed shapes.
   */
  private resolveGate(
    gate:
      | { gateToken: Address; minBalance: bigint; discountBps: number; windowEndsAt: bigint }
      | undefined,
  ): { gateToken: Address; minBalance: bigint; windowEndsAt: bigint; discountBps: number } {
    const off = {
      gateToken: zeroAddress as Address,
      minBalance: 0n,
      windowEndsAt: 0n,
      discountBps: 0,
    };
    if (!gate || gate.gateToken === zeroAddress) {
      if (gate && (gate.discountBps !== 0 || gate.minBalance !== 0n)) {
        throw new ToolError(
          "bad_gate",
          "a discount or a holder threshold needs a gate token — the contract rejects one without the other",
        );
      }
      return off;
    }
    if (gate.discountBps < 0 || gate.discountBps > MAX_DISCOUNT_BPS) {
      throw new ToolError(
        "bad_gate",
        `discountBps must be between 0 and ${MAX_DISCOUNT_BPS} (100% of the creator's cut — the platform's leg is never reduced)`,
      );
    }
    if (gate.discountBps > 0 && gate.minBalance <= 0n) {
      throw new ToolError("bad_gate", "a holder discount needs a non-zero minBalance to qualify on");
    }
    if (gate.discountBps === 0 && gate.minBalance <= 0n) {
      throw new ToolError(
        "bad_gate",
        "an access gate with a zero threshold admits everyone and blocks nobody",
        "set minBalance, or drop the gate entirely",
      );
    }
    return {
      gateToken: gate.gateToken,
      minBalance: gate.minBalance,
      windowEndsAt: gate.windowEndsAt,
      discountBps: gate.discountBps,
    };
  }

  /** `allowedGateTokens` — only enforced by the contract for DISCOUNT gates. */
  async isAllowedGateToken(token: Address): Promise<boolean> {
    return this.signer
      .readContract<boolean>({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "allowedGateTokens",
        args: [token],
      })
      .catch(() => false);
  }

  async createLaunch(opts: {
    meta: LaunchMetadata;
    quoteSymbol: "INJ" | "USDC" | "SAI";
    /** CurveRegistry preset (v2 only). Omitted / 0 = the standard curve. */
    curveId?: number;
    /**
     * V-4 exclusive pre-open window. `tradingOpensAt` sits `openDelaySeconds`
     * ahead, and the contract lets the CREATOR through early for the first
     * trade only — so the opening buy is theirs rather than a public race.
     * The contract refuses exclusivity without a cap that binds it, and this
     * refuses a delay too short to outlast the keeper bind unless
     * `allowShortWindow` says to launch with it anyway.
     */
    devBuy?: { openDelaySeconds: number; maxBuyBps?: number; allowShortWindow?: boolean };
    /** Holder discount, or a hard access gate when `discountBps` is 0. */
    gate?: {
      gateToken: Address;
      minBalance: bigint;
      discountBps: number;
      windowEndsAt: bigint;
    };
  }): Promise<{
    /**
     * The new launch's id ON THE CORE THAT ISSUED IT. Deliberately not called
     * `launchId`: every user-facing surface prints the API's surrogate under
     * that name, and the two are different numbers. Chain calls take this one.
     */
    onchainId: string;
    /** The core it was created on, so the id above can be resolved later. */
    core: string;
    /** Unix seconds public trading opens; 0 = immediately. */
    tradingOpensAt: number;
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
    // Before anything is spent. The chain takes name/symbol once, at
    // MsgCreateDenom, and DROPS whatever it will not accept rather than
    // truncating it — so this is the last point at which a bad name is still
    // fixable instead of permanent.
    assertBrandable("name", opts.meta.name);
    assertBrandable("symbol", opts.meta.symbol);
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

    // v2's LaunchConfig carries `curveId` (after quoteAsset), so the two
    // versions encode different calldata and the wrong one reverts rather than
    // misbehaving quietly. curveId 0 is the standard preset, which reproduces
    // the v1 curve exactly — so an agent that expresses no curve preference
    // gets the same launch on both networks.
    const curveId = opts.curveId ?? 0;
    const timing = await this.resolveLaunchTiming(opts.devBuy, curveId, q.slot);
    const gate = this.resolveGate(opts.gate);
    const base = {
      name: opts.meta.name,
      symbol: opts.meta.symbol,
      metadataURI: encodeMetadataUri(opts.meta),
      quoteAsset: q.slot,
      gate,
      tradingOpensAt: timing.tradingOpensAt,
      guardWindowEndsAt: timing.guardWindowEndsAt,
      maxBuyBpsInGuardWindow: timing.maxBuyBpsInGuardWindow,
      // Both of these are deliberately not exposed as `create_token` params.
      //
      // `bindDeadlineSeconds: 0` takes the contract's own default (1h), which
      // is the window the keeper has to bind the launch before it can be
      // cancelled. Shortening it only makes a slow bind fatal, and lengthening
      // it only leaves a stuck launch stuck for longer — there is no value an
      // agent could pick from a tool call that beats the deployment's own, and
      // it is frozen onto the launch like everything else here.
      //
      // `PoolKind.Clmm` is the only graduation target mainnet accepts, and
      // every launch this package has made has graduated to a Choice CLMM
      // pool. Exposing the enum's other member (Xyk) would offer a choice
      // between one legal value and one that fails at GRADUATION — a whole
      // raise after the call that picked it, with no way back. If a deployment
      // ever accepts XYK, this is the line to make configurable.
      bindDeadlineSeconds: 0n,
      poolKind: PoolKind.Clmm,
    };
    const cfg = this.v2
      ? {
          name: base.name,
          symbol: base.symbol,
          metadataURI: base.metadataURI,
          quoteAsset: base.quoteAsset,
          curveId,
          gate: base.gate,
          tradingOpensAt: base.tradingOpensAt,
          guardWindowEndsAt: base.guardWindowEndsAt,
          maxBuyBpsInGuardWindow: base.maxBuyBpsInGuardWindow,
          bindDeadlineSeconds: base.bindDeadlineSeconds,
          poolKind: base.poolKind,
        }
      : base;
    if (!this.v2 && curveId !== 0) {
      throw new ToolError(
        "bad_curve",
        "this network runs the v1 launchpad, where the curve is fixed per quote asset — curveId is not selectable",
      );
    }

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
      abi: (this.v2 ? LAUNCHPAD_WRITE_V2_ABI : LAUNCHPAD_ABI) as never,
      functionName: "createLaunch",
      args: [cfg as never],
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
        onchainId: predictedId.toString(),
        core: this.core,
        tradingOpensAt: Number(timing.tradingOpensAt),
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
      onchainId: launchId.toString(),
      core: this.core,
      tradingOpensAt: Number(timing.tradingOpensAt),
      token,
      state: LAUNCH_STATE_LABEL[state] ?? String(state),
      hash: res.hash,
      status: res.status,
      creationFeeInj: formatUnits(fee, 18),
      warnings,
    };
  }

  // ---- claims --------------------------------------------------------------

  /**
   * Claim everything this wallet is owed ON THIS VENUE'S CORE.
   *
   * `launchIds` are on-chain ids and must belong to the bound core — creator
   * fees are a per-launch ledger, and the same id names a different launch on
   * every other core. Referral fees and refunds are per-WALLET ledgers, but
   * each core keeps its own, so a caller with several cores has to run this
   * against each of them; `claim_fees` does.
   */
  /**
   * What THIS launch owes its creator, unclaimed, in the launch's quote asset.
   *
   * A plain view — reading it costs nothing and broadcasts nothing, which is
   * the whole point: the ledger used to be legible only by claiming it.
   * `launchId` is the ON-CHAIN id on this venue's core.
   */
  async creatorFeesOwed(launchId: bigint): Promise<bigint> {
    return this.signer.readContract<bigint>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "creatorFeesOwed",
      args: [launchId],
    });
  }

  /**
   * Every ledger this wallet can draw on THIS core, read and nothing else.
   *
   * Split out of `claimAll` so the same reads answer "what am I owed?" without
   * a transaction. `claimAll` still calls it first, because every claim
   * function reverts `NothingToClaim()` on a zero balance and the reads are
   * what keep it from spending gas to find that out.
   */
  async claimable(launchIds: bigint[]): Promise<ClaimableLedgers> {
    const creator: ClaimableLedgers["creator"] = [];
    for (const id of launchIds) {
      const amount = await this.creatorFeesOwed(id);
      if (amount > 0n) {
        const launch = await this.getLaunchView(id);
        creator.push({ launchId: id, amount, quote: this.quoteInfo(launch.quoteAsset) });
      }
    }

    const referral: ClaimableLedgers["referral"] = [];
    for (const q of Object.values(this.net.quoteAssets)) {
      const amount = await this.signer.readContract<bigint>({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "referralFeesOwed",
        args: [this.signer.address, q.pairAsset],
      });
      if (amount > 0n) referral.push({ quote: q, amount });
    }

    const refund = await this.signer.readContract<bigint>({
      address: this.core,
      abi: LAUNCHPAD_ABI,
      functionName: "refundsOwed",
      args: [this.signer.address],
    });

    return { creator, referral, refund };
  }

  async claimAll(launchIds: bigint[]): Promise<{
    creatorFees: { onchainId: string; amount: string }[];
    referralFees: { pairAsset: string; symbol: string; amount: string }[];
    refundInj: string | null;
    txHashes: string[];
    notes: string[];
  }> {
    const txHashes: string[] = [];
    const notes: string[] = [];

    const owed = await this.claimable(launchIds);
    const creatorOwed = owed.creator.map((c) => ({ launchId: c.launchId, amount: c.amount, q: c.quote }));
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
    for (const { quote: q, amount } of owed.referral) {
      const r = await this.signer.writeTx({
        address: this.core,
        abi: LAUNCHPAD_ABI,
        functionName: "claimReferralFees",
        args: [q.pairAsset],
        intent: { kind: "claim", target: this.core, detail: `claimReferralFees ${q.symbol}` },
      });
      if (r.hash) txHashes.push(r.hash);
      referral.push({ pairAsset: q.pairAsset, symbol: q.symbol, amount: formatUnits(amount, q.decimals) });
    }

    let refundInj: string | null = null;
    const refundOwed = owed.refund;
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
        onchainId: c.launchId.toString(),
        amount: `${formatUnits(c.amount, c.q.decimals)} ${c.q.symbol}`,
      })),
      referralFees: referral,
      refundInj,
      txHashes,
      notes,
    };
  }
}
