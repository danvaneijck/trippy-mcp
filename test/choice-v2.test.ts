import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import type { V2Pool } from "../src/api/choiceV2.js";
import type { ApiLaunch } from "../src/api/pump.js";
import { NETWORKS } from "../src/chain/networks.js";
import { PolicySchema } from "../src/config.js";
import { PolicyError } from "../src/errors.js";
import { MAX_APPROVAL_TTL_SECONDS, PolicyEngine } from "../src/policy/policy.js";
import { SpendLedger } from "../src/policy/spend.js";
import { pickBetterQuote, resolveToken } from "../src/router.js";
import { allowedTargetsFor, exactApprovalSpendersFor, type Runtime } from "../src/runtime.js";
import { UNIVERSAL_ROUTER_ABI } from "../src/venues/choiceV2/abi.js";
import {
  Action,
  MSG_SENDER,
  assertSafePlan,
  buildSwapPlan,
  executeCalldata,
  poolIdOf,
  type PlanExpectation,
  type PoolKey,
  type SwapRequest,
} from "../src/venues/choiceV2/plan.js";
import { ChoiceV2Venue, PERMIT2_TTL_SECONDS } from "../src/venues/choiceV2/venue.js";
import { encodeMetadataUri } from "../src/metadata.js";
import { LaunchState } from "../src/venues/shroom/abi.js";

/**
 * Choice v2 — the EVM venue an atomic-core launch graduates onto.
 *
 * The fixtures are mainnet's own: launch 10006's pool key exactly as
 * `POSITION_MANAGER.getPoolAndPositionInfo` returned it on 2026-10-01, which
 * hashes to the id the pad API records for it.
 */

const NET = NETWORKS.mainnet;
const V2 = NET.choiceV2!;
const WINJ = V2.winj;
const INJIVA: Address = "0xc3dD627938376fFe1a0a11b1E8F9ab8B61D8ACcF";
const FEE_HOOK = V2.allowedHooks.find((h) => h.name === "LaunchPoolFeeHook")!.address;
const KEY_10006: PoolKey = {
  currency0: WINJ,
  currency1: INJIVA,
  hooks: FEE_HOOK,
  poolManager: V2.clPoolManager,
  fee: 0,
  parameters: "0x0000000000000000000000000000000000000000000000000000000000c80cc1",
};
const POOL_10006 = "0x65dc89a5eaf5df31141f005244c0c88a76eaeb8db8f4077e93f91f2a08e7bde5";
const DEADLINE = 1_900_000_000n;

describe("pool identity", () => {
  it("poolIdOf hashes launch 10006's on-chain key to the id the indexer records", () => {
    expect(poolIdOf(KEY_10006)).toBe(POOL_10006);
  });
});

// ---------------------------------------------------------------------------
// plan construction
// ---------------------------------------------------------------------------

const buyReq: SwapRequest = {
  key: KEY_10006,
  tokenIn: WINJ,
  tokenOut: INJIVA,
  amountIn: 5n * 10n ** 17n,
  minOut: 216_924n * 10n ** 18n,
  nativeIn: true,
  nativeOut: false,
  winj: WINJ,
};
const sellReq: SwapRequest = {
  key: KEY_10006,
  tokenIn: INJIVA,
  tokenOut: WINJ,
  amountIn: 10n ** 24n,
  minOut: 2n * 10n ** 18n,
  nativeIn: false,
  nativeOut: true,
  winj: WINJ,
};

function expectFor(r: SwapRequest): PlanExpectation {
  return {
    to: V2.universalRouter,
    router: V2.universalRouter,
    amountIn: r.amountIn,
    minOutFloor: r.minOut,
    tokenIn: r.tokenIn,
    tokenOut: r.tokenOut,
    nativeIn: r.nativeIn,
    nativeOut: r.nativeOut,
    winj: WINJ,
    allowedHooks: V2.allowedHooks.map((h) => h.address),
    poolManager: V2.clPoolManager,
  };
}

describe("buildSwapPlan", () => {
  it("native buy: WRAP_ETH into the router, then INFI_SWAP settling from the router", () => {
    const plan = buildSwapPlan(buyReq);
    expect(plan.commands).toBe("0x0b10");
    expect(plan.value).toBe(buyReq.amountIn);
    // zeroForOne: wINJ is currency0, and it is what is sold.
    const [actions] = decodeInfi(plan.inputs[1]!);
    // CL_SWAP_EXACT_IN_SINGLE, SETTLE (payer = router), TAKE_ALL
    expect(actions).toBe("0x060b0f");
    expect([Action.CL_SWAP_EXACT_IN_SINGLE, Action.SETTLE, Action.TAKE_ALL]).toEqual([0x06, 0x0b, 0x0f]);
  });

  it("native sell: INFI_SWAP taking wINJ into the router, then UNWRAP_WETH to the caller", () => {
    const plan = buildSwapPlan(sellReq);
    expect(plan.commands).toBe("0x100c");
    expect(plan.value).toBe(0n);
    const [actions] = decodeInfi(plan.inputs[0]!);
    expect(actions).toBe("0x060c0e");
  });

  it("erc20 → erc20: SETTLE_ALL + TAKE_ALL, no wrap, no value", () => {
    const plan = buildSwapPlan({ ...sellReq, nativeOut: false });
    expect(plan.commands).toBe("0x10");
    expect(plan.value).toBe(0n);
    const [actions] = decodeInfi(plan.inputs[0]!);
    expect(actions).toBe("0x060c0f");
  });

  it("refuses a pair the pool does not hold", () => {
    expect(() => buildSwapPlan({ ...buyReq, tokenOut: "0x00000000000000000000000000000000000000aa" })).toThrow(
      /not the other side/,
    );
  });

  it("refuses zero or out-of-range amounts", () => {
    expect(() => buildSwapPlan({ ...buyReq, amountIn: 0n })).toThrow();
    expect(() => buildSwapPlan({ ...buyReq, minOut: 0n })).toThrow();
    expect(() => buildSwapPlan({ ...buyReq, amountIn: 1n << 128n })).toThrow();
  });

  for (const [label, r] of [
    ["native buy", buyReq],
    ["native sell", sellReq],
    ["erc20 swap", { ...sellReq, nativeOut: false }],
  ] as const) {
    it(`what it builds passes its own validator (${label})`, () => {
      const plan = buildSwapPlan(r);
      expect(() => assertSafePlan(executeCalldata(plan, DEADLINE), plan.value, expectFor(r))).not.toThrow();
    });
  }
});

function decodeInfi(input: Hex): readonly [Hex, readonly Hex[]] {
  return decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], input);
}

// ---------------------------------------------------------------------------
// plan validation: every way a plan could move money the request did not
// ---------------------------------------------------------------------------

/** Rebuild execute() calldata with one input swapped out. */
function tamper(plan: { commands: Hex; inputs: Hex[] }, i: number, input: Hex, commands = plan.commands): Hex {
  const inputs = [...plan.inputs];
  inputs[i] = input;
  return encodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, functionName: "execute", args: [commands, inputs, DEADLINE] });
}

const ADDR_UINT = [{ type: "address" }, { type: "uint256" }] as const;
const ACTIONS = [{ type: "bytes" }, { type: "bytes[]" }] as const;
const SWAP = [
  {
    type: "tuple",
    components: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "hooks", type: "address" },
          { name: "poolManager", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "parameters", type: "bytes32" },
        ],
      },
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint128" },
      { name: "amountOutMinimum", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ],
  },
] as const;

describe("assertSafePlan refuses", () => {
  const plan = buildSwapPlan(sellReq);
  const e = expectFor(sellReq);
  const [actions, params] = decodeInfi(plan.inputs[0]!);

  const withSwap = (over: Record<string, unknown>) => {
    const swap = encodeAbiParameters(SWAP, [
      { poolKey: KEY_10006, zeroForOne: false, amountIn: sellReq.amountIn, amountOutMinimum: sellReq.minOut, hookData: "0x", ...over } as never,
    ]);
    return encodeAbiParameters(ACTIONS, [actions, [swap, params[1]!, params[2]!]]);
  };

  it("a target that is not the UniversalRouter", () => {
    expect(() => assertSafePlan(executeCalldata(plan, DEADLINE), 0n, { ...e, to: "0x00000000000000000000000000000000000000bb" })).toThrow(
      /not the UniversalRouter/,
    );
  });

  it("an extra command (e.g. a SWEEP to someone else)", () => {
    const data = encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: "execute",
      args: ["0x100c04", [...plan.inputs, encodeAbiParameters(ADDR_UINT, [WINJ, 0n])], DEADLINE],
    });
    expect(() => assertSafePlan(data, 0n, e)).toThrow(/commands/);
  });

  it("an allow-revert flag on a command", () => {
    expect(() => assertSafePlan(tamper(plan, 0, plan.inputs[0]!, "0x900c"), 0n, e)).toThrow(/commands/);
  });

  it("an unwrap paid to anyone but the caller", () => {
    const evil = encodeAbiParameters(ADDR_UINT, ["0x00000000000000000000000000000000000000cc", sellReq.minOut]);
    expect(() => assertSafePlan(tamper(plan, 1, evil), 0n, e)).toThrow(/pay the caller/);
  });

  it("a floor below the on-chain quote's", () => {
    const low = encodeAbiParameters(ADDR_UINT, [MSG_SENDER, sellReq.minOut - 1n]);
    expect(() => assertSafePlan(tamper(plan, 1, low), 0n, e)).toThrow(/floor/);
    expect(() => assertSafePlan(tamper(plan, 0, withSwap({ amountOutMinimum: 1n })), 0n, e)).toThrow(/floor/);
  });

  it("a larger input than was asked", () => {
    expect(() => assertSafePlan(tamper(plan, 0, withSwap({ amountIn: sellReq.amountIn + 1n })), 0n, e)).toThrow(/amountIn/);
  });

  it("a pool behind an unknown hook, or on a foreign pool manager", () => {
    const evilHook = { ...KEY_10006, hooks: "0x00000000000000000000000000000000000000dd" as Address };
    expect(() => assertSafePlan(tamper(plan, 0, withSwap({ poolKey: evilHook })), 0n, e)).toThrow(/hook/);
    const foreign = { ...KEY_10006, poolManager: "0x00000000000000000000000000000000000000ee" as Address };
    expect(() => assertSafePlan(tamper(plan, 0, withSwap({ poolKey: foreign })), 0n, e)).toThrow(/pool manager/);
  });

  it("hook data smuggled into the swap", () => {
    expect(() => assertSafePlan(tamper(plan, 0, withSwap({ hookData: "0xdeadbeef" })), 0n, e)).toThrow(/hookData/);
  });

  it("a TAKE into anyone but the router", () => {
    const take = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [WINJ, "0x00000000000000000000000000000000000000cc", 0n]);
    const infi = encodeAbiParameters(ACTIONS, [actions, [params[0]!, params[1]!, take]]);
    expect(() => assertSafePlan(tamper(plan, 0, infi), 0n, e)).toThrow(/TAKE/);
  });

  it("any msg.value on a sell, or the wrong one on a buy", () => {
    expect(() => assertSafePlan(executeCalldata(plan, DEADLINE), 1n, e)).toThrow(/value/);
    const buy = buildSwapPlan(buyReq);
    expect(() => assertSafePlan(executeCalldata(buy, DEADLINE), buy.value + 1n, expectFor(buyReq))).toThrow(/value/);
  });

  it("a wrap into anyone but the router", () => {
    const buy = buildSwapPlan(buyReq);
    const evil = encodeAbiParameters(ADDR_UINT, [MSG_SENDER, buyReq.amountIn]);
    expect(() => assertSafePlan(tamper(buy, 0, evil), buy.value, expectFor(buyReq))).toThrow(/WRAP_ETH/);
  });

});

// ---------------------------------------------------------------------------
// Permit2: exact, short-lived — at the venue and again inside the signer
// ---------------------------------------------------------------------------

interface Write {
  address: string;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  intent: { kind: string; target: string; approval?: { amount: bigint; expiresAt?: number }; spendUsd?: number | null };
}

function stubVenue(opts: {
  erc20Allowance?: bigint;
  permit2?: [bigint, number];
  balances?: Record<string, bigint>;
  native?: bigint;
  quoteOut?: bigint;
  pools?: V2Pool[];
  liquidity?: bigint;
}) {
  const writes: Write[] = [];
  const me = `0x${"12".repeat(20)}` as Address;
  const signer = {
    address: me,
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args: unknown[] }) => {
      switch (functionName) {
        case "allowance":
          if (address.toLowerCase() === V2.permit2.toLowerCase()) return opts.permit2 ?? [0n, 0, 0];
          return opts.erc20Allowance ?? 0n;
        case "balanceOf":
          return opts.balances?.[address.toLowerCase()] ?? 0n;
        case "decimals":
          return 18;
        case "quoteExactInputSingle":
          return [opts.quoteOut ?? 10n ** 21n, 100_000n];
        case "getLiquidity":
          return opts.liquidity ?? 10n ** 24n;
        case "poolFeePips":
          return 10_000;
        default:
          throw new Error(`unexpected read ${functionName}(${String(args)})`);
      }
    },
    writeTx: async (w: Write) => {
      writes.push(w);
      return { status: "dry-run" as const, hash: null };
    },
  };
  const api = { pools: async () => opts.pools ?? [] };
  const venue = new ChoiceV2Venue(NET, V2, signer as never, api as never, {
    nativeBalance: async () => opts.native ?? 0n,
    usdValue: async () => 1,
  });
  return { venue, writes };
}

function route(venue: ChoiceV2Venue) {
  return {
    key: KEY_10006,
    poolId: POOL_10006 as Hex,
    token: INJIVA,
    tokenDecimals: 18,
    counter: venue.nativeCounter,
    hook: "LaunchPoolFeeHook",
    feePips: 10_000,
    source: "launch-locker" as const,
  };
}

describe("Permit2 approvals are exact and short-lived", () => {
  it("approves the token to Permit2 for EXACTLY the input, and Permit2 → router briefly", async () => {
    const { venue, writes } = stubVenue({});
    const before = Math.floor(Date.now() / 1000);
    await venue.ensurePermit2(INJIVA, 1234n);
    expect(writes).toHaveLength(2);
    const [erc20, permit] = writes;
    expect(erc20!.address).toBe(INJIVA);
    expect(erc20!.functionName).toBe("approve");
    expect(erc20!.args).toEqual([V2.permit2, 1234n]);
    expect(erc20!.intent).toMatchObject({ kind: "approve", target: V2.permit2, approval: { amount: 1234n } });

    expect(permit!.address).toBe(V2.permit2);
    const [token, spender, amount, expiration] = permit!.args as [string, string, bigint, number];
    expect([token, spender, amount]).toEqual([INJIVA, V2.universalRouter, 1234n]);
    expect(expiration).toBeGreaterThanOrEqual(before + PERMIT2_TTL_SECONDS);
    expect(expiration).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + PERMIT2_TTL_SECONDS);
    expect(permit!.intent).toMatchObject({ kind: "approve", target: V2.universalRouter });
  });

  it("never grants more than asked: no maxUint anywhere", async () => {
    const { venue, writes } = stubVenue({});
    await venue.ensurePermit2(INJIVA, 7n);
    for (const w of writes) {
      for (const a of w.args) if (typeof a === "bigint") expect(a).toBe(7n);
    }
  });

  it("skips both grants when the standing ones already cover this swap", async () => {
    const far = Math.floor(Date.now() / 1000) + 600;
    const { venue, writes } = stubVenue({ erc20Allowance: 50n, permit2: [50n, far] });
    await venue.ensurePermit2(INJIVA, 50n);
    expect(writes).toHaveLength(0);
  });

  it("re-grants a Permit2 allowance that would lapse before the swap lands", async () => {
    const soon = Math.floor(Date.now() / 1000) + 30;
    const { venue, writes } = stubVenue({ erc20Allowance: 50n, permit2: [50n, soon] });
    await venue.ensurePermit2(INJIVA, 50n);
    expect(writes.map((w) => w.address)).toEqual([V2.permit2]);
  });
});

function policyEngine() {
  const ledger = new SpendLedger(mkdtempSync(join(tmpdir(), "trippy-mcp-v2-")));
  return new PolicyEngine(
    PolicySchema.parse({}),
    allowedTargetsFor(NET),
    `0x${"11".repeat(20)}`,
    ledger,
    exactApprovalSpendersFor(NET),
  );
}

describe("policy: Choice v2 allowlist and exact approvals", () => {
  it("allowlists the UniversalRouter and Permit2", () => {
    const allowed = allowedTargetsFor(NET);
    expect(allowed.has(V2.universalRouter.toLowerCase())).toBe(true);
    expect(allowed.has(V2.permit2.toLowerCase())).toBe(true);
  });

  it("does NOT allowlist the quoter, the pool manager or the API's world", () => {
    const allowed = allowedTargetsFor(NET);
    expect(allowed.has(V2.clQuoter.toLowerCase())).toBe(false);
    expect(allowed.has(V2.clPoolManager.toLowerCase())).toBe(false);
  });

  it("refuses an unlimited or unstated approval to Permit2", () => {
    const p = policyEngine();
    expect(() => p.enforce({ kind: "approve", target: V2.permit2, detail: "x" })).toThrow(PolicyError);
    expect(() =>
      p.enforce({ kind: "approve", target: V2.permit2, detail: "x", approval: { amount: (1n << 256n) - 1n } }),
    ).toThrow(/unlimited/);
    expect(() => p.enforce({ kind: "approve", target: V2.permit2, detail: "x", approval: { amount: 10n } })).not.toThrow();
  });

  it("refuses a Permit2 grant to the router with no expiry, or one past the cap", () => {
    const p = policyEngine();
    const now = Math.floor(Date.now() / 1000);
    expect(() => p.enforce({ kind: "approve", target: V2.universalRouter, detail: "x", approval: { amount: 10n } })).toThrow(
      /expire/,
    );
    expect(() =>
      p.enforce({
        kind: "approve",
        target: V2.universalRouter,
        detail: "x",
        approval: { amount: 10n, expiresAt: now + MAX_APPROVAL_TTL_SECONDS + 60 },
      }),
    ).toThrow(/expire/);
    expect(() =>
      p.enforce({ kind: "approve", target: V2.universalRouter, detail: "x", approval: { amount: 10n, expiresAt: now + PERMIT2_TTL_SECONDS } }),
    ).not.toThrow();
  });

  it("leaves the curve's approval to a LaunchpadCore exactly as it was", () => {
    const p = policyEngine();
    expect(() => p.enforce({ kind: "approve", target: NET.addresses.launchpadCore, detail: "x" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// the venue: pool verification and the swap it signs
// ---------------------------------------------------------------------------

function apiPool(over: Partial<V2Pool> = {}): V2Pool {
  return {
    id: POOL_10006,
    poolType: "cl",
    currency0: WINJ.toLowerCase(),
    currency1: INJIVA.toLowerCase(),
    hooks: FEE_HOOK.toLowerCase(),
    token0: { address: WINJ, symbol: "WINJ", decimals: 18 },
    token1: { address: INJIVA, symbol: "INJIVA", decimals: 18 },
    keyFee: 0,
    lpFeePips: 0,
    parameters: KEY_10006.parameters,
    liquidity: "1",
    ...over,
  };
}

describe("pool discovery trusts the chain, not the API", () => {
  it("keeps a pool whose key hashes to its id and holds liquidity", async () => {
    const { venue } = stubVenue({ pools: [apiPool()] });
    const routes = await venue.discoverRoutes(INJIVA);
    expect(routes.map((r) => r.poolId)).toEqual([POOL_10006]);
    expect(routes[0]!.source).toBe("api-verified");
  });

  it("drops a pool whose id is not the hash of the key it was served with", async () => {
    const { venue } = stubVenue({ pools: [apiPool({ id: `0x${"ab".repeat(32)}` })] });
    expect(await venue.discoverRoutes(INJIVA)).toEqual([]);
  });

  it("drops a pool behind an unknown hook before it is ever quoted", async () => {
    const { venue } = stubVenue({ pools: [apiPool({ hooks: "0x00000000000000000000000000000000000000dd" })] });
    expect(await venue.discoverRoutes(INJIVA)).toEqual([]);
  });

  it("drops a pool with no liquidity on chain, whatever the API says", async () => {
    const { venue } = stubVenue({ pools: [apiPool()], liquidity: 0n });
    expect(await venue.discoverRoutes(INJIVA)).toEqual([]);
  });

  it("drops bin pools: single-hop CL only", async () => {
    const { venue } = stubVenue({ pools: [apiPool({ poolType: "bin" })] });
    expect(await venue.discoverRoutes(INJIVA)).toEqual([]);
  });

  it("refuses a launch whose settler is not a Choice v2 InfinitySettler", async () => {
    const { venue } = stubVenue({});
    await expect(
      venue.launchRoute({ settler: "0x5Db6B8d92dB7B98d47198729E33B93E34e5e606b", onchainId: 91n, token: INJIVA }),
    ).rejects.toMatchObject({ code: "not_choice_v2" });
  });
});

describe("the swap the venue signs", () => {
  it("native buy goes to the UniversalRouter with value = amountIn and a priced intent", async () => {
    const { venue, writes } = stubVenue({ native: 10n ** 18n, quoteOut: 1000n * 10n ** 18n });
    await venue.swap(route(venue), "buy", 5n * 10n ** 17n, 100);
    expect(writes).toHaveLength(1);
    const w = writes[0]!;
    expect(w.address).toBe(V2.universalRouter);
    expect(w.functionName).toBe("execute");
    expect(w.value).toBe(5n * 10n ** 17n);
    expect(w.intent).toMatchObject({ kind: "swap", target: V2.universalRouter, spendUsd: 1 });
    // minOut = quote less 1%, in both the swap and the TAKE_ALL.
    const plan = { commands: w.args[0] as Hex, inputs: w.args[1] as Hex[] };
    expect(() =>
      assertSafePlan(executeCalldata(plan, w.args[2] as bigint), w.value!, {
        ...expectFor(buyReq),
        minOutFloor: 990n * 10n ** 18n,
      }),
    ).not.toThrow();
  });

  it("sell approves exactly, then swaps with no value", async () => {
    const { venue, writes } = stubVenue({ balances: { [INJIVA.toLowerCase()]: 10n ** 24n } });
    await venue.swap(route(venue), "sell", 10n ** 24n, 100);
    expect(writes.map((w) => `${w.functionName}@${w.address}`)).toEqual([
      `approve@${INJIVA}`,
      `approve@${V2.permit2}`,
      `execute@${V2.universalRouter}`,
    ]);
    expect(writes[2]!.value).toBe(0n);
  });

  it("refuses before approving anything when the wallet is short", async () => {
    const { venue, writes } = stubVenue({ balances: { [INJIVA.toLowerCase()]: 5n } });
    await expect(venue.swap(route(venue), "sell", 10n, 100)).rejects.toMatchObject({ code: "no_balance" });
    expect(writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// the router: which venue a token goes to
// ---------------------------------------------------------------------------

const ATOMIC_SETTLER = V2.infinitySettlers[0]!;
const PHASE3 = "0x5Db6B8d92dB7B98d47198729E33B93E34e5e606b";

function launch(over: Partial<ApiLaunch>): ApiLaunch {
  return {
    id: "1",
    creator: "0xc",
    token: INJIVA.toLowerCase(),
    quoteAsset: 1,
    metadataURI: encodeMetadataUri({ name: "X", symbol: "XX" }),
    createdAt: "",
    state: LaunchState.Graduated,
    realPair: "0",
    tokensSold: "0",
    bankDenom: "inj",
    tradeFeeBps: 100,
    creatorFeeShareBps: 7000,
    graduationTarget: 1,
    graduatedPoolAddress: null,
    graduatedPoolDenom: null,
    volume24h: "0",
    lastTradedAt: null,
    holderCount: "0",
    userHolderCount: "0",
    hidden: false,
    featured: false,
    flagged: false,
    ...over,
  } as ApiLaunch;
}

function routerRt(opts: { launches?: ApiLaunch[]; v2Pools?: V2Pool[]; v1Liquidity?: number }): Runtime {
  return {
    net: NET,
    pump: {
      getLaunch: async (id: string) => {
        const hit = (opts.launches ?? []).find((l) => l.id === id);
        if (!hit) throw new Error("nf");
        return hit;
      },
      listLaunches: async ({ q }: { q?: string }) => ({
        items: (opts.launches ?? []).filter((l) => !q || l.token.toLowerCase() === q.toLowerCase()),
      }),
    },
    choiceApi: {
      token: async (id: string) => {
        if (opts.v1Liquidity === undefined) throw new Error("not found");
        return { address: id, liquidity_usd: opts.v1Liquidity };
      },
      resolve: async () => ({ matches: [] }),
    },
    choiceV2Api: { pools: async () => opts.v2Pools ?? [], tokens: async () => [] },
  } as unknown as Runtime;
}

describe("router venue choice", () => {
  it("a graduated ATOMIC-core launch goes to Choice v2 — it has no v1 pool", async () => {
    const t = await resolveToken(routerRt({ launches: [launch({ id: "624", settler: ATOMIC_SETTLER.toLowerCase() })] }), "624");
    expect(t).toMatchObject({ venue: "choiceV2", token: INJIVA });
  });

  it("the indexer's graduationVenue alone is enough when the settler is unknown to the row", async () => {
    const t = await resolveToken(routerRt({ launches: [launch({ id: "640", graduationVenue: "choice_v2" })] }), "640");
    expect(t.venue).toBe("choiceV2");
  });

  it("a graduated OLDER-core launch stays on Choice v1, by its graduated denom", async () => {
    const t = await resolveToken(
      routerRt({ launches: [launch({ id: "200", settler: PHASE3, graduatedPoolDenom: "factory/inj1x/shroom_9_ab" })] }),
      "200",
    );
    expect(t).toMatchObject({ venue: "choice", tokenId: "factory/inj1x/shroom_9_ab" });
    expect(t).not.toHaveProperty("v2Token");
  });

  it("…and carries its v2 pool as an alternative when one exists (MOTION's shape)", async () => {
    const t = await resolveToken(
      routerRt({
        launches: [launch({ id: "16", settler: PHASE3, graduatedPoolDenom: "factory/inj1x/shroom_0_ab" })],
        v2Pools: [apiPool({ hooks: "0x0000000000000000000000000000000000000000", liquidity: "5" })],
      }),
      "16",
    );
    expect(t).toMatchObject({ venue: "choice", v2Token: INJIVA });
  });

  it("a curve-state launch is untouched", async () => {
    const t = await resolveToken(routerRt({ launches: [launch({ id: "793", state: LaunchState.Trading, onchainId: "10064" })] }), "793");
    expect(t).toMatchObject({ venue: "curve", launchId: 10064n });
  });

  it("a plain 0x ERC20 with only a v2 pool goes to Choice v2", async () => {
    const t = await resolveToken(routerRt({ v2Pools: [apiPool({ liquidity: "5" })] }), INJIVA.toLowerCase());
    expect(t).toEqual({ venue: "choiceV2", token: INJIVA });
  });

  it("a plain 0x ERC20 listed only on v1 goes there as erc20:<checksummed>, the id v1 knows", async () => {
    const t = await resolveToken(routerRt({ v1Liquidity: 1000 }), INJIVA.toLowerCase());
    expect(t).toEqual({ venue: "choice", tokenId: `erc20:${INJIVA}` });
  });

  it("listed on both: v2 with v1 as the alternative", async () => {
    const t = await resolveToken(routerRt({ v2Pools: [apiPool({ liquidity: "5" })], v1Liquidity: 1000 }), INJIVA);
    expect(t).toEqual({ venue: "choiceV2", token: INJIVA, v1TokenId: `erc20:${INJIVA}` });
  });

  it("a v2 pool behind an unknown hook does not count as a listing", async () => {
    const t = await resolveToken(
      routerRt({ v2Pools: [apiPool({ hooks: "0x00000000000000000000000000000000000000dd", liquidity: "5" })] }),
      INJIVA,
    );
    expect(t).toEqual({ venue: "choice", tokenId: INJIVA });
  });

  it("bank denoms and CW20s stay on Choice v1", async () => {
    for (const q of ["factory/inj1abc/foo", "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8"]) {
      expect((await resolveToken(routerRt({}), q)).venue).toBe("choice");
    }
  });
});

describe("pickBetterQuote", () => {
  it.each([
    [100, 101, "choiceV2"],
    [101, 100, "choice"],
    [100, 100, "choice"],
    [null, 5, "choiceV2"],
    [5, null, "choice"],
    [0, 5, "choiceV2"],
    [Number.NaN, 5, "choiceV2"],
    [null, null, null],
  ] as const)("v1 %s vs v2 %s → %s", (v1, v2, want) => {
    expect(pickBetterQuote(v1, v2)).toBe(want);
  });
});

// ---------------------------------------------------------------------------
// an asset on BOTH Choice venues: quote both, trade the better
// ---------------------------------------------------------------------------

describe("two-venue assets", () => {
  /** v1 quotes `v1Out` tokens, v2's pool quotes `v2Out`; records where a buy lands. */
  function dualRt(v1Out: string, v2Out: bigint) {
    const executed: string[] = [];
    const { venue } = stubVenue({ pools: [apiPool({ hooks: "0x0000000000000000000000000000000000000000", liquidity: "5" })], quoteOut: v2Out, native: 10n ** 20n });
    // Re-key the stub pool hookless so it hashes.
    const hookless = { ...KEY_10006, hooks: "0x0000000000000000000000000000000000000000" as Address };
    const pools = [apiPool({ id: poolIdOf(hookless), hooks: hookless.hooks, liquidity: "5" })];
    (venue as unknown as { api: { pools: () => Promise<V2Pool[]> } }).api = { pools: async () => pools };
    (venue as unknown as { signer: { writeTx: (w: Write) => Promise<unknown> } }).signer.writeTx = async (w: Write) => {
      executed.push(`v2:${w.functionName}`);
      return { status: "dry-run", hash: null };
    };
    const rt = {
      // An unreachable LCD: every bank read fails soft, as it does offline.
      net: { ...NET, lcdUrl: "http://127.0.0.1:9" },
      pump: { listLaunches: async () => ({ items: [] }), getLaunch: async () => { throw new Error("nf"); } },
      choiceApi: { token: async (id: string) => ({ address: id, liquidity_usd: 1000 }), resolve: async () => ({ matches: [] }) },
      choiceV2Api: { pools: async () => pools, tokens: async () => [] },
      choiceV2: venue,
      choiceV2UsdValue: async () => 1,
      choice: {
        quote: async () => ({ summary: { expected_output: v1Out, minimum_receive: v1Out, route_venues: ["clmm"] } }),
        usdValueIn: async () => 1,
        swap: async () => {
          executed.push("v1:swap");
          return { status: "dry-run" };
        },
      },
      signer: { address: `0x${"12".repeat(20)}`, readContract: async () => 18 },
      policy: {
        clampSlippageBps: (b?: number) => b ?? 100,
        snapshot: () => ({ tradingEnabled: true, perTxCapUsd: 200, remainingDailyUsd: 1000, allowUnpricedSpend: false }),
      },
    } as unknown as Runtime;
    return { rt, executed };
  }

  it("quote reports the larger output and names the other venue as the alternative", async () => {
    const { quote } = await import("../src/mcp/tools.js");
    const { rt } = dualRt("900", 1000n * 10n ** 18n);
    const q = (await quote(rt, { query: INJIVA, side: "buy", amount: "1" })) as Record<string, unknown>;
    expect(q.venue).toBe("choiceV2");
    expect(q.alternative).toMatchObject({ venue: "choice", expectedOutput: "900" });
    expect(String(q.venueChoice)).toContain("v2 quotes the larger output");
  });

  it("buy executes on whichever venue quotes more — v1 when v1 does", async () => {
    const { buy } = await import("../src/mcp/tools.js");
    const v1Wins = dualRt("1100", 1000n * 10n ** 18n);
    await buy(v1Wins.rt, { query: INJIVA, amount: "1" });
    expect(v1Wins.executed).toEqual(["v1:swap"]);

    const v2Wins = dualRt("900", 1000n * 10n ** 18n);
    await buy(v2Wins.rt, { query: INJIVA, amount: "1" });
    expect(v2Wins.executed).toEqual(["v2:execute"]);
  });
});
