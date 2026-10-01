/**
 * Choice v2 venue — quote/buy/sell through the Infinity UniversalRouter on
 * Injective EVM, where an ATOMIC-core launch graduates (and where DojoFun and
 * other EVM-native tokens trade).
 *
 * Trust boundaries, in the order a swap crosses them:
 *  1. WHICH POOL. A graduated launch's pool is read off the chain:
 *     `settler.LOCKER().getPosition(launchId)` -> the locked position NFT ->
 *     `POSITION_MANAGER.getPoolAndPositionInfo(tokenId)`. Any other token's
 *     pools are DISCOVERED through the v2 API, then each candidate's key is
 *     re-hashed to its id and confirmed live on the pinned CLPoolManager. The
 *     API can only nominate pools; it cannot invent one, and among the ones it
 *     names the swap takes the best ON-CHAIN quote.
 *  2. WHICH HOOK. Hookless, or one of Choice's two launch hooks. Anything else
 *     runs unknown code inside the swap and is refused before it is quoted.
 *  3. HOW MUCH. CLQuoter simulates the swap through the hook, so the launch fee
 *     is inside the quote, and `minOut` comes from that quote and the caller's
 *     slippage — never from an API number.
 *  4. WHAT IS SIGNED. Built locally (`plan.ts`), re-decoded and checked
 *     against the request, then sent to the UniversalRouter only.
 *  5. WHAT IS APPROVED. ERC20 → Permit2 for EXACTLY the input, and Permit2 →
 *     router for exactly the input with a short expiry. Never max, never
 *     forever: a leftover allowance is a standing offer to whatever holds it.
 */

import { encodeFunctionData, formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem";

import type { ChoiceV2Api, V2Pool } from "../../api/choiceV2.js";
import type { EvmSigner, WriteTxResult } from "../../chain/evm.js";
import type { ChoiceV2Config, NetworkDef } from "../../chain/networks.js";
import { ToolError } from "../../errors.js";
import { ERC20_ABI } from "../shroom/abi.js";
import {
  CL_POOL_MANAGER_ABI,
  CL_POSITION_MANAGER_ABI,
  CL_QUOTER_ABI,
  INFINITY_SETTLER_ABI,
  LAUNCH_POOL_FEE_HOOK_ABI,
  PERMIT2_ABI,
  POSITION_LOCKER_ABI,
  UNIVERSAL_ROUTER_ABI,
} from "./abi.js";
import {
  assertSafePlan,
  buildSwapPlan,
  executeCalldata,
  poolIdOf,
  zeroForOneOf,
  type PoolKey,
} from "./plan.js";

/** How long a Permit2 grant to the router lives. The swap lands within the 120s deadline. */
export const PERMIT2_TTL_SECONDS = 15 * 60;
const SWAP_DEADLINE_SECONDS = 120;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** The non-token side of a trade: native INJ, or an ERC20 the pool pairs with. */
export interface Counter {
  /** The currency in the pool: wINJ when `native`. */
  address: Address;
  native: boolean;
  symbol: string;
  decimals: number;
}

/** One verified pool to trade `token` against `counter` in. */
export interface V2Route {
  key: PoolKey;
  poolId: Hex;
  token: Address;
  tokenDecimals: number;
  counter: Counter;
  /** Name of the pool's hook, or null when hookless. */
  hook: string | null;
  /**
   * What the pool charges a trade, in pips (10,000 = 1%): the LP fee, or the
   * launch hook's fee where the LP fee is 0. Informational — the quote already
   * includes it.
   */
  feePips: number | null;
  /** How the pool was found: read off the chain, or nominated by the API. */
  source: "launch-locker" | "api-verified";
}

export interface V2Quote {
  route: V2Route;
  side: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  inDecimals: number;
  outDecimals: number;
  inSymbol: string;
  outSymbol: string;
}

export interface V2TradeResult {
  venue: "choiceV2";
  hash: string | null;
  status: WriteTxResult["status"];
  side: "buy" | "sell";
  amountIn: string;
  expectedOut: string;
  minimumOut: string;
  pool: Hex;
  hook: string | null;
  warnings: string[];
  explorerUrl?: string;
}

export interface ChoiceV2Deps {
  /** Native INJ balance — from the bank module, never eth_getBalance (see README). */
  nativeBalance: () => Promise<bigint>;
  /** USD value of `amount` base units of `token` (`native` for INJ), or null. */
  usdValue: (token: Address | "native", amount: bigint, decimals: number) => Promise<number | null>;
}

export class ChoiceV2Venue {
  constructor(
    private readonly net: NetworkDef,
    readonly cfg: ChoiceV2Config,
    private readonly signer: EvmSigner,
    private readonly api: ChoiceV2Api,
    private readonly deps: ChoiceV2Deps,
  ) {}

  /** Native INJ, as a pool currency. */
  get nativeCounter(): Counter {
    return { address: this.cfg.winj, native: true, symbol: "INJ", decimals: 18 };
  }

  isAllowedHook(hooks: string): boolean {
    const h = hooks.toLowerCase();
    return h === ZERO || this.cfg.allowedHooks.some((a) => a.address.toLowerCase() === h);
  }

  private hookName(hooks: string): string | null {
    const h = hooks.toLowerCase();
    if (h === ZERO) return null;
    return this.cfg.allowedHooks.find((a) => a.address.toLowerCase() === h)?.name ?? hooks;
  }

  // ---- pool resolution ------------------------------------------------------

  /**
   * The pool a graduated launch was seeded into, read entirely off the chain.
   *
   * `settler` is the launch's OWN snapshotted settler (from `getLaunch`), and
   * it has to be one of the pinned InfinitySettlers — a launch that graduated
   * the CosmWasm way has no v2 position and must never be sent here.
   */
  async launchRoute(launch: { settler: Address; onchainId: bigint; token: Address }): Promise<V2Route> {
    const settler = launch.settler.toLowerCase();
    if (!this.cfg.infinitySettlers.some((s) => s.toLowerCase() === settler)) {
      throw new ToolError(
        "not_choice_v2",
        `this launch's settler ${launch.settler} is not a Choice v2 InfinitySettler — it did not graduate onto Choice v2`,
      );
    }
    const [locker, positionManager] = await Promise.all([
      this.read<Address>(launch.settler, INFINITY_SETTLER_ABI, "LOCKER", []),
      this.read<Address>(launch.settler, INFINITY_SETTLER_ABI, "POSITION_MANAGER", []),
    ]);
    const pos = await this.read<{ tokenId: bigint }>(locker, POSITION_LOCKER_ABI, "getPosition", [launch.onchainId]);
    if (!pos.tokenId) {
      throw new ToolError("no_pool", "the launch's graduation position is not registered with the locker yet");
    }
    const [rawKey] = await this.read<readonly [PoolKey, bigint]>(
      positionManager,
      CL_POSITION_MANAGER_ABI,
      "getPoolAndPositionInfo",
      [pos.tokenId],
    );
    const key = normKey(rawKey);
    return this.finishRoute(key, getAddress(launch.token), this.nativeCounter, "launch-locker");
  }

  /**
   * Every verified pool trading `token` against `counter`, best liquidity
   * first. Candidates come from the API; each is kept only if its key hashes
   * to its id, names the pinned pool manager and an allowed hook, and holds
   * liquidity on chain right now.
   */
  async discoverRoutes(token: Address, counter: Counter = this.nativeCounter): Promise<V2Route[]> {
    const want = new Set([token.toLowerCase(), counter.address.toLowerCase()]);
    const pools = await this.api.pools(token).catch(() => [] as V2Pool[]);
    const candidates = pools.filter(
      (p) =>
        p.poolType === "cl" &&
        want.has(p.currency0.toLowerCase()) &&
        want.has(p.currency1.toLowerCase()) &&
        p.currency0.toLowerCase() !== p.currency1.toLowerCase(),
    );
    const routes: { route: V2Route; liquidity: bigint }[] = [];
    for (const p of candidates) {
      if (!this.isAllowedHook(p.hooks)) continue;
      const key: PoolKey = {
        currency0: getAddress(p.currency0),
        currency1: getAddress(p.currency1),
        hooks: getAddress(p.hooks),
        poolManager: this.cfg.clPoolManager,
        fee: Number(p.keyFee),
        parameters: p.parameters as Hex,
      };
      // The API's id must BE this key on our pool manager, or the key is not
      // the pool it claims to be.
      if (poolIdOf(key).toLowerCase() !== p.id.toLowerCase()) continue;
      const liquidity = await this.read<bigint>(this.cfg.clPoolManager, CL_POOL_MANAGER_ABI, "getLiquidity", [
        poolIdOf(key),
      ]).catch(() => 0n);
      if (liquidity <= 0n) continue;
      routes.push({ route: await this.finishRoute(key, getAddress(token), counter, "api-verified"), liquidity });
    }
    return routes.sort((a, z) => (z.liquidity > a.liquidity ? 1 : z.liquidity < a.liquidity ? -1 : 0)).map((r) => r.route);
  }

  private async finishRoute(key: PoolKey, token: Address, counter: Counter, source: V2Route["source"]): Promise<V2Route> {
    if (key.poolManager.toLowerCase() !== this.cfg.clPoolManager.toLowerCase()) {
      throw new ToolError("bad_pool", `pool manager ${key.poolManager} is not Choice v2's CLPoolManager`);
    }
    if (!this.isAllowedHook(key.hooks)) {
      throw new ToolError(
        "unknown_hook",
        `this pool runs hook ${key.hooks}, which is not one of Choice's launch hooks — an unknown hook can take any cut of a swap, so it is refused`,
      );
    }
    const pair = [key.currency0.toLowerCase(), key.currency1.toLowerCase()];
    if (!pair.includes(token.toLowerCase()) || !pair.includes(counter.address.toLowerCase())) {
      throw new ToolError("bad_pool", `this pool does not pair ${token} with ${counter.symbol}`);
    }
    const poolId = poolIdOf(key);
    const tokenDecimals = Number(await this.read<number>(token, ERC20_ABI, "decimals", []));
    let feePips: number | null = key.fee;
    if (this.hookName(key.hooks) === "LaunchPoolFeeHook") {
      feePips = Number(
        await this.read<number>(key.hooks, LAUNCH_POOL_FEE_HOOK_ABI, "poolFeePips", [poolId]).catch(() => null),
      );
      if (!Number.isFinite(feePips)) feePips = null;
    }
    return { key, poolId, token, tokenDecimals, counter, hook: this.hookName(key.hooks), feePips, source };
  }

  // ---- quoting ---------------------------------------------------------------

  /**
   * On-chain exact-in quote. `amountIn` is base units of the INPUT side: the
   * counter on a buy, the token on a sell.
   */
  async quote(route: V2Route, side: "buy" | "sell", amountIn: bigint, slippageBps: number): Promise<V2Quote> {
    if (amountIn <= 0n) throw new ToolError("bad_amount", "amount must be positive");
    const inCurrency = side === "buy" ? route.counter.address : route.token;
    const zeroForOne = zeroForOneOf(route.key, inCurrency);
    const [amountOut] = await this.read<readonly [bigint, bigint]>(this.cfg.clQuoter, CL_QUOTER_ABI, "quoteExactInputSingle", [
      { poolKey: route.key, zeroForOne, exactAmount: amountIn, hookData: "0x" },
    ]);
    if (amountOut <= 0n) throw new ToolError("no_output", "the pool quotes zero for this amount — too small?");
    const minOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (minOut <= 0n) throw new ToolError("no_output", "the slippage floor rounds to zero — trade a larger amount");
    const tok = { decimals: route.tokenDecimals, symbol: "tokens" };
    const ctr = { decimals: route.counter.decimals, symbol: route.counter.symbol };
    const [i, o] = side === "buy" ? [ctr, tok] : [tok, ctr];
    return {
      route,
      side,
      amountIn,
      amountOut,
      minOut,
      inDecimals: i.decimals,
      outDecimals: o.decimals,
      inSymbol: i.symbol,
      outSymbol: o.symbol,
    };
  }

  /** Base units of the input side for a human amount (or the whole position). */
  async sizeInput(route: V2Route, side: "buy" | "sell", amount: string): Promise<bigint> {
    if (side === "sell" && amount === "all") {
      const held = await this.tokenBalance(route.token);
      if (held <= 0n) throw new ToolError("no_balance", "this wallet holds none of this token");
      return held;
    }
    const decimals = side === "buy" ? route.counter.decimals : route.tokenDecimals;
    try {
      return parseUnits(amount, decimals);
    } catch {
      throw new ToolError("bad_amount", `"${amount}" is not an amount`);
    }
  }

  async inputBalance(route: V2Route, side: "buy" | "sell"): Promise<bigint> {
    if (side === "sell") return this.tokenBalance(route.token);
    return route.counter.native ? this.deps.nativeBalance() : this.tokenBalance(route.counter.address);
  }

  tokenBalance(token: Address): Promise<bigint> {
    return this.read<bigint>(token, ERC20_ABI, "balanceOf", [this.signer.address]);
  }

  // ---- execution ---------------------------------------------------------------

  async swap(route: V2Route, side: "buy" | "sell", amountIn: bigint, slippageBps: number): Promise<V2TradeResult> {
    const warnings: string[] = [];
    const held = await this.inputBalance(route, side);
    const q = await this.quote(route, side, amountIn, slippageBps);
    if (held < amountIn) {
      throw new ToolError(
        "no_balance",
        `wallet holds ${formatUnits(held, q.inDecimals)} ${q.inSymbol} but this swap spends ${formatUnits(amountIn, q.inDecimals)}`,
      );
    }

    const nativeIn = side === "buy" && route.counter.native;
    const nativeOut = side === "sell" && route.counter.native;
    const tokenIn = side === "buy" ? route.counter.address : route.token;
    const tokenOut = side === "buy" ? route.token : route.counter.address;

    // What leaves the wallet, in USD, for the policy engine. A sell is priced
    // off what it fetches when the token itself has no mark — it is the same
    // value less the pool's fee and impact, and leaving it unpriced would
    // refuse every sell of a thin token outright.
    const usdIn = await this.deps.usdValue(nativeIn ? "native" : tokenIn, amountIn, q.inDecimals);
    const usdOut =
      usdIn === null ? await this.deps.usdValue(nativeOut ? "native" : tokenOut, q.amountOut, q.outDecimals) : null;
    const spendUsd = usdIn ?? usdOut;

    if (!nativeIn) await this.ensurePermit2(tokenIn, amountIn);

    const plan = buildSwapPlan({
      key: route.key,
      tokenIn,
      tokenOut,
      amountIn,
      minOut: q.minOut,
      nativeIn,
      nativeOut,
      winj: this.cfg.winj,
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
    // The plan is checked as CALLDATA — the exact bytes the signer will send —
    // against what was asked, not against the builder's own intermediate state.
    assertSafePlan(executeCalldata(plan, deadline), plan.value, {
      to: this.cfg.universalRouter,
      router: this.cfg.universalRouter,
      amountIn,
      minOutFloor: q.minOut,
      tokenIn,
      tokenOut,
      nativeIn,
      nativeOut,
      winj: this.cfg.winj,
      allowedHooks: this.cfg.allowedHooks.map((h) => h.address),
      poolManager: this.cfg.clPoolManager,
    });

    const outBefore = nativeOut ? await this.deps.nativeBalance() : await this.tokenBalance(tokenOut);
    const res = await this.signer.writeTx({
      address: this.cfg.universalRouter,
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: [plan.commands, plan.inputs, deadline],
      value: plan.value,
      intent: {
        kind: "swap",
        target: this.cfg.universalRouter,
        detail: `choice-v2 ${side} ${formatUnits(amountIn, q.inDecimals)} ${q.inSymbol} → ${tokenOut} (pool ${route.poolId.slice(0, 10)}…)`,
        spendUsd,
      },
      confirm: async () =>
        (nativeOut ? await this.deps.nativeBalance() : await this.tokenBalance(tokenOut)) > outBefore,
    });

    if (route.hook === "LaunchPoolFeeHook" && route.feePips !== null) {
      warnings.push(
        `this pool charges its launch's ${route.feePips / 10_000}% trade fee through LaunchPoolFeeHook — it is already inside the quote`,
      );
    }
    return {
      venue: "choiceV2",
      hash: res.hash,
      status: res.status,
      side,
      amountIn: `${formatUnits(amountIn, q.inDecimals)} ${q.inSymbol}`,
      expectedOut: `${formatUnits(q.amountOut, q.outDecimals)} ${q.outSymbol}`,
      minimumOut: `${formatUnits(q.minOut, q.outDecimals)} ${q.outSymbol}`,
      pool: route.poolId,
      hook: route.hook,
      warnings,
      ...(res.hash ? { explorerUrl: `${this.net.explorerTxBase}${res.hash}` } : {}),
    };
  }

  /**
   * Let the router pull exactly `amount` of `token`, through Permit2.
   *
   * Two grants, both EXACT: the token's ERC20 allowance to Permit2, and
   * Permit2's internal allowance to the router with a {@link PERMIT2_TTL_SECONDS}
   * expiry. A swap consumes both down to zero, so nothing standing is left
   * behind for a later caller — or a compromised router — to draw on.
   */
  async ensurePermit2(token: Address, amount: bigint): Promise<void> {
    const { permit2, universalRouter } = this.cfg;
    const erc20Allowance = await this.read<bigint>(token, ERC20_ABI, "allowance", [this.signer.address, permit2]);
    if (erc20Allowance < amount) {
      await this.signer.writeTx({
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [permit2, amount],
        intent: {
          kind: "approve",
          target: permit2,
          detail: `approve ${token} → Permit2 for exactly ${amount}`,
          approval: { amount },
        },
        confirm: async () =>
          (await this.read<bigint>(token, ERC20_ABI, "allowance", [this.signer.address, permit2])) >= amount,
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const [granted, expiration] = await this.read<readonly [bigint, number, number]>(permit2, PERMIT2_ABI, "allowance", [
      this.signer.address,
      token,
      universalRouter,
    ]);
    // Re-grant when short OR about to lapse: a grant that expires between the
    // approval and the swap fails the swap, not the approval.
    if (granted < amount || Number(expiration) < now + SWAP_DEADLINE_SECONDS) {
      const expiresAt = now + PERMIT2_TTL_SECONDS;
      await this.signer.writeTx({
        address: permit2,
        abi: PERMIT2_ABI,
        functionName: "approve",
        args: [token, universalRouter, amount, expiresAt],
        intent: {
          kind: "approve",
          target: universalRouter,
          detail: `Permit2: let the UniversalRouter pull exactly ${amount} of ${token} until ${new Date(expiresAt * 1000).toISOString()}`,
          approval: { amount, expiresAt },
        },
        confirm: async () => {
          const [a] = await this.read<readonly [bigint, number, number]>(permit2, PERMIT2_ABI, "allowance", [
            this.signer.address,
            token,
            universalRouter,
          ]);
          return a >= amount;
        },
      });
    }
  }

  /** `execute` calldata for a quote, exactly as `swap` would send it — for tests and previews. */
  previewCalldata(q: V2Quote): { to: Address; data: Hex; value: bigint } {
    const nativeIn = q.side === "buy" && q.route.counter.native;
    const nativeOut = q.side === "sell" && q.route.counter.native;
    const plan = buildSwapPlan({
      key: q.route.key,
      tokenIn: q.side === "buy" ? q.route.counter.address : q.route.token,
      tokenOut: q.side === "buy" ? q.route.token : q.route.counter.address,
      amountIn: q.amountIn,
      minOut: q.minOut,
      nativeIn,
      nativeOut,
      winj: this.cfg.winj,
    });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECONDS);
    return {
      to: this.cfg.universalRouter,
      data: encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: "execute", args: [plan.commands, plan.inputs, deadline] }),
      value: plan.value,
    };
  }

  private read<T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<T> {
    return this.signer.readContract<T>({ address, abi: abi as never, functionName, args });
  }
}

/** viem hands a struct back as an object; normalise case and number types. */
function normKey(k: PoolKey): PoolKey {
  return {
    currency0: getAddress(k.currency0),
    currency1: getAddress(k.currency1),
    hooks: getAddress(k.hooks),
    poolManager: getAddress(k.poolManager),
    fee: Number(k.fee),
    parameters: k.parameters,
  };
}
