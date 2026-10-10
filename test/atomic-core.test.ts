import { describe, expect, it } from "vitest";

import { launchTokenDenom } from "../src/airdrops/sources.js";
import { asApiLaunchId, type ApiLaunch } from "../src/api/pump.js";
import {
  NETWORKS,
  baseQuoteSlot,
  coreDeploymentFor,
  quoteAssetBySlot,
  quoteSlotsOf,
} from "../src/chain/networks.js";
import { buy, createToken } from "../src/mcp/tools.js";
import type { Runtime } from "../src/runtime.js";
import { ShroomVenue } from "../src/venues/shroom/launchpad.js";

/**
 * Mainnet's ATOMIC core (0x1333…, since 2026-09-13).
 *
 * Until 0.15.0 this package sent every mainnet `create_token` to the v2 core,
 * which has `launchesPaused() == true` since the cutover — so every agent launch
 * reverted `LaunchesPaused()` — and refused every launch the atomic core holds
 * as "unknown core". These pin both directions, plus the two things the atomic
 * core changed underneath an otherwise unchanged ABI: a second INJ quote slot
 * (the 3% tier, slot 6) and launch tokens with no sink.
 */

const NET = NETWORKS.mainnet;
const ATOMIC = "0x1333692eB905823df110762525c26f7489BB9300";
const V2 = "0xd948740da926E8908A08414879490d0D8F96D463";
const V1 = "0xeBF62508F322137EE0986935Ee3b4A60a3F0D227";
const WINJ = "0x0000000088827d2d103ee2d9A6b781773AE03FfB";

describe("fee-tier quote slots", () => {
  it("slot 6 is native INJ carrying its own slot", () => {
    const q = quoteAssetBySlot(NET, 6)!;
    expect(q.symbol).toBe("INJ");
    expect(q.isNative).toBe(true);
    expect(q.pairAsset).toBe(WINJ);
    // The slot a chain call names must stay the launch's real one.
    expect(q.slot).toBe(6);
  });

  it("an unregistered slot is still unknown — no tier invented", () => {
    expect(quoteAssetBySlot(NET, 10)).toBeUndefined();
    // Never reused: SHROOM (0) and testnet's EIGHT/TWLV (4/5).
    for (const slot of [0, 4, 5]) expect(quoteAssetBySlot(NET, slot)).toBeUndefined();
  });

  it("USDC's 3% tier (7) and SPROUT (8) with its tier (9) resolve to their base assets", () => {
    const usdc3 = quoteAssetBySlot(NET, 7)!;
    expect(usdc3).toMatchObject({ symbol: "USDC", slot: 7, decimals: 6, isNative: false });
    expect(usdc3.pairAsset).toBe("0xa00C59fF5a080D2b954d0c75e46E22a0c371235a");
    const sprout = quoteAssetBySlot(NET, 8)!;
    expect(sprout).toMatchObject({ symbol: "SPROUT", slot: 8, decimals: 18, isNative: false });
    expect(sprout.pairAsset).toBe("0x503f2A7bAc1E2ff2800Aa92EdB82abeF0bFA631E");
    expect(quoteAssetBySlot(NET, 9)).toMatchObject({ symbol: "SPROUT", slot: 9, pairAsset: sprout.pairAsset });
    for (const [tier, base] of [[6, 1], [7, 2], [9, 8], [2, 2], [8, 8], [3, 3]] as const) {
      expect(baseQuoteSlot(NET, tier)).toBe(base);
    }
  });

  it("testnet carries the same slots, on its own SPROUT", () => {
    const T = NETWORKS.testnet;
    expect(quoteAssetBySlot(T, 9)).toMatchObject({
      symbol: "SPROUT",
      slot: 9,
      pairAsset: "0xEDF52618Cf3C61Be2a721d964C5064c87970331E",
    });
    expect(quoteSlotsOf(T, "USDC")).toEqual([2, 7]);
  });

  it("each asset's slots are its base and its tier", () => {
    expect(quoteSlotsOf(NET, "INJ")).toEqual([1, 6]);
    expect(quoteSlotsOf(NET, "USDC")).toEqual([2, 7]);
    expect(quoteSlotsOf(NET, "SPROUT")).toEqual([8, 9]);
    expect(quoteSlotsOf(NET, "SAI")).toEqual([3]);
    expect(quoteSlotsOf(NET, "NOPE")).toEqual([]);
  });
});

describe("three-core binding", () => {
  it("every launch-scoped venue binds to the core on the launch row", async () => {
    const seen: string[] = [];
    const signer = {
      address: `0x${"12".repeat(20)}`,
      readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
        seen.push(`${functionName}@${address.toLowerCase()}`);
        if (functionName === "creatorFeesOwed") return 0n;
        throw new Error("unused");
      },
    };
    const root = new ShroomVenue(NET, signer as never, {} as never, null);
    for (const core of [ATOMIC, V2, V1]) {
      await root.forLaunch({ core: core.toLowerCase() }).creatorFeesOwed(10_000n);
    }
    expect(seen).toEqual([
      `creatorFeesOwed@${ATOMIC.toLowerCase()}`,
      `creatorFeesOwed@${V2.toLowerCase()}`,
      `creatorFeesOwed@${V1.toLowerCase()}`,
    ]);
  });

  it("a launch on the atomic core no longer resolves to 'unknown core'", () => {
    expect(() => new ShroomVenue(NET, {} as never, {} as never, null).forLaunch({ core: ATOMIC })).not.toThrow();
    expect(coreDeploymentFor(NET, ATOMIC.toLowerCase())?.legacy).toBe(false);
  });

  it("getLaunch is read through each core's own views with its own tuple", async () => {
    const reads: { address: string; hasCurveId: boolean }[] = [];
    const signer = {
      readContract: async ({ address, abi }: { address: string; abi: { name?: string; outputs?: { components?: { name: string }[] }[] }[] }) => {
        const getLaunch = abi.find((f) => f.name === "getLaunch");
        const fields = getLaunch?.outputs?.[0]?.components?.map((c) => c.name) ?? [];
        reads.push({ address: address.toLowerCase(), hasCurveId: fields.includes("curveId") });
        throw new Error("stop");
      },
    };
    const root = new ShroomVenue(NET, signer as never, {} as never, null);
    for (const core of [ATOMIC, V2, V1]) {
      await root.forLaunch({ core }).getLaunchView(1n).catch(() => null);
    }
    expect(reads).toEqual([
      { address: "0xf3adbfedd7c5e2f843f82e264fee351134240445", hasCurveId: true },
      { address: "0x4a4e90f87f5376e25e235b1d0609857c06f520b6", hasCurveId: true },
      // v1 serves its own getters, with the SHORTER tuple.
      { address: V1.toLowerCase(), hasCurveId: false },
    ]);
  });
});

/** A launch view as `getLaunchView` decodes it, on the 3% INJ tier. */
function tierLaunch(): Record<string, unknown> {
  return {
    state: 1,
    creator: `0x${"cc".repeat(20)}`,
    token: `0x${"77".repeat(20)}`,
    sink: `0x${"00".repeat(20)}`,
    quoteAsset: 6,
    pairAsset: WINJ,
    gate: { gateToken: `0x${"00".repeat(20)}`, minBalance: 0n, windowEndsAt: 0n, discountBps: 0 },
    tradingOpensAt: 0n,
    guardWindowEndsAt: 0n,
    maxBuyBpsInGuardWindow: 0,
    virtualPair: 1n,
    realPair: 0n,
    tokensSold: 1n,
    graduationPairTarget: 2_500n * 10n ** 18n,
    tradeFeeBps: 300,
    creatorFeeShareBps: 7000,
    curveId: 7,
    metadataURI: "",
    bankDenom: "inj",
  };
}

describe("a launch on INJ's 3% tier (slot 6) trades", () => {
  it("buy goes to the atomic core as buyNative with msg.value — not 'unknown quote asset slot 6'", async () => {
    const writes: { address: string; functionName: string; value?: bigint }[] = [];
    const signer = {
      address: `0x${"12".repeat(20)}`,
      readContract: async ({ functionName }: { functionName: string }) => {
        switch (functionName) {
          case "paused":
            return false;
          case "getLaunch":
            return tierLaunch();
          case "quoteBuy":
            return [10n ** 24n, 3n * 10n ** 16n, 0n];
          case "balanceOf":
            return 0n;
          default:
            throw new Error(`unexpected read ${functionName}`);
        }
      },
      writeTx: async (req: { address: string; functionName: string; value?: bigint }) => {
        writes.push({ address: req.address, functionName: req.functionName, value: req.value });
        return { status: "dry-run" as const, hash: null };
      },
    };
    const pump = {
      quotePrices: async () => ({ items: [{ quoteAsset: 6, rateUsd: "5" }] }),
      getLaunch: async () =>
        ({
          id: asApiLaunchId("789"),
          core: ATOMIC.toLowerCase(),
          onchainId: "10063",
          state: 1,
          quoteAsset: 6,
          token: `0x${"77".repeat(20)}`,
          metadataURI: "",
        }) as ApiLaunch,
    };
    const shroom = new ShroomVenue(NET, signer as never, pump as never, null);
    const rt = {
      net: NET,
      shroom,
      pump,
      policy: { clampSlippageBps: (b?: number) => b ?? 100 },
    } as unknown as Runtime;
    const res = (await buy(rt, { query: "789", amount: "1" })) as Record<string, unknown>;
    expect(writes).toEqual([{ address: ATOMIC, functionName: "buyNative", value: 10n ** 18n }]);
    expect(res.launchId).toBe("789");
    expect(res.onchainId).toBe("10063");
    expect(res.quoteSymbol).toBe("INJ");
  });
});

/**
 * A ShroomVenue on the current (atomic) core whose quote menu is the live
 * mainnet one at the time of writing: INJ on slot 1 at 1%, its tier on slot 6
 * at 3%, USDC and SAI not registered.
 */
function atomicCreateVenue(
  extra: Record<number, { fee: number; pairAsset: string }> = {},
  balances: Record<string, bigint> = {},
) {
  const sent: { address: string; cfg: Record<string, unknown>; value?: bigint }[] = [];
  const zero = `0x${"00".repeat(20)}`;
  const signer = {
    address: `0x${"12".repeat(20)}`,
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args: unknown[] }) => {
      switch (functionName) {
        case "balanceOf":
          return balances[address.toLowerCase()] ?? 0n;
        case "paused":
          return false;
        case "denomCreationFeeInj":
          return 10n ** 18n;
        case "nextLaunchId":
          return 10_064n;
        case "launchTokenFactory":
          return "0x615EDD898be2F44d18CE875Bbc75A1065E8D9BA2";
        case "getQuoteAssetConfig": {
          const slot = Number(args[0]);
          const live: Record<number, { fee: number; pairAsset: string }> = {
            1: { fee: 100, pairAsset: WINJ },
            6: { fee: 300, pairAsset: WINJ },
            ...extra,
          };
          const hit = live[slot];
          return {
            pairAsset: hit ? hit.pairAsset : zero,
            graduationPairTarget: hit ? 2_500n * 10n ** 18n : 0n,
            enabled: !!hit,
            bankDenom: hit ? "inj" : "",
            requiresChoiceFactoryDust: false,
            tradeFeeBps: hit?.fee ?? 0,
            creatorFeeShareBps: hit ? 7000 : 0,
          };
        }
        case "getPresets":
          return [
            ...Array.from({ length: 7 }, () => ({ name: "standard", enabled: false })),
            { name: "standard", enabled: true },
          ].map((p) => ({
            virtualToken: 1_073_000_000_000_000_000_000_000_000n,
            rBps: 4000,
            targetMulBps: 10_000,
            quoteMask: 0xffff_ffff,
            enabled: p.enabled,
            name: p.name,
          }));
        case "shapeOf":
          return [0n, 0n, 10n ** 27n, 7780n, 2220n] as const;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    writeTx: async (req: { address: string; args: unknown[]; value?: bigint }) => {
      sent.push({ address: req.address, cfg: req.args[0] as Record<string, unknown>, value: req.value });
      return { status: "dry-run" as const, hash: null };
    },
  };
  const pump = { quotePrices: async () => ({ items: [] }), listLaunches: async () => ({ items: [] }) };
  const venue = new ShroomVenue(NET, signer as never, pump as never, null);
  const rt = { net: NET, shroom: venue, pump, signer } as unknown as Runtime;
  return { venue, rt, sent };
}

const SPROUT = "0x503f2A7bAc1E2ff2800Aa92EdB82abeF0bFA631E";
const USDC = "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";

describe("create on a USDC or SPROUT quote", () => {
  it("SPROUT at 3% launches on slot 9 once the chain enables it", async () => {
    const { rt, sent } = atomicCreateVenue({ 8: { fee: 100, pairAsset: SPROUT }, 9: { fee: 300, pairAsset: SPROUT } });
    await createToken(rt, { name: "Sprouted", symbol: "SPRT1", quoteAsset: "SPROUT", tradeFeeBps: 300 });
    expect(sent[0]!.cfg.quoteAsset).toBe(9);
    // The fee is paid in INJ whatever the quote; nothing else rides the create.
    expect(sent[0]!.value).toBe(10n ** 18n);
  });

  it("USDC at the default tier launches on slot 2", async () => {
    const { rt, sent } = atomicCreateVenue({ 2: { fee: 100, pairAsset: USDC }, 7: { fee: 300, pairAsset: USDC } });
    await createToken(rt, { name: "Dollar", symbol: "DLR1", quoteAsset: "USDC" });
    expect(sent[0]!.cfg.quoteAsset).toBe(2);
  });

  it("refuses SPROUT while the chain has not enabled it, before spending", async () => {
    const { rt, sent } = atomicCreateVenue();
    await expect(createToken(rt, { name: "Early", symbol: "EARLY", quoteAsset: "SPROUT" })).rejects.toMatchObject({
      code: "quote_disabled",
      hint: expect.stringContaining("INJ (slot 1, 1% trade fee)"),
    });
    expect(sent).toHaveLength(0);
  });

  it("an enabled tier with a disabled base names the tier to pick", async () => {
    const { rt, sent } = atomicCreateVenue({ 9: { fee: 300, pairAsset: SPROUT } });
    await expect(createToken(rt, { name: "Base", symbol: "BASE", quoteAsset: "SPROUT" })).rejects.toMatchObject({
      code: "quote_disabled",
      hint: expect.stringContaining("SPROUT (slot 9, 3% trade fee)"),
    });
    expect(sent).toHaveLength(0);
  });

  it("a slot 8 carrying any other token than SPROUT's address reads as disabled", async () => {
    const fake = `0x${"5e".repeat(20)}`;
    const { rt, sent } = atomicCreateVenue({ 8: { fee: 100, pairAsset: fake } });
    await expect(createToken(rt, { name: "Fake", symbol: "FAKE", quoteAsset: "SPROUT" })).rejects.toMatchObject({
      code: "quote_disabled",
    });
    expect(sent).toHaveLength(0);
  });

  it("refuses an opening buy the wallet holds no SPROUT for, before the launch exists", async () => {
    const { rt, sent } = atomicCreateVenue(
      { 8: { fee: 100, pairAsset: SPROUT } },
      { [SPROUT.toLowerCase()]: 10n ** 18n },
    );
    await expect(
      createToken(rt, { name: "Poor", symbol: "POOR", quoteAsset: "SPROUT", initialBuy: "1000" }),
    ).rejects.toMatchObject({ code: "no_balance", message: expect.stringContaining("priced in SPROUT") });
    expect(sent).toHaveLength(0);
  });
});

describe("create on the atomic core", () => {
  it("sends createLaunch to 0x1333… with EXACTLY the creation fee as value", async () => {
    const { rt, sent } = atomicCreateVenue();
    await createToken(rt, { name: "Atomic", symbol: "ATOM1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.address).toBe(ATOMIC);
    // An overshoot reverts InsufficientLaunchFee on this core.
    expect(sent[0]!.value).toBe(10n ** 18n);
    expect(sent[0]!.cfg.quoteAsset).toBe(1);
    // The live "standard", by name — not the retired id 0.
    expect(sent[0]!.cfg.curveId).toBe(7);
  });

  it("refuses a quote the core has not enabled, naming the ones it has, before spending", async () => {
    const { rt, sent } = atomicCreateVenue();
    await expect(createToken(rt, { name: "Usd", symbol: "USD1", quoteAsset: "USDC" })).rejects.toMatchObject({
      code: "quote_disabled",
      hint: expect.stringContaining("INJ (slot 6, 3% trade fee)"),
    });
    expect(sent).toHaveLength(0);
  });

  it("tradeFeeBps 300 launches on INJ's tier slot, read off the live menu", async () => {
    const { rt, sent } = atomicCreateVenue();
    await createToken(rt, { name: "Tier", symbol: "TIER", tradeFeeBps: 300 });
    expect(sent[0]!.cfg.quoteAsset).toBe(6);
  });

  it("a fee tier the core does not offer is refused with the tiers it does", async () => {
    const { rt, sent } = atomicCreateVenue();
    await expect(createToken(rt, { name: "Tier", symbol: "TIER", tradeFeeBps: 200 })).rejects.toMatchObject({
      code: "bad_fee_tier",
      hint: "INJ tiers enabled here: 100 bps, 300 bps",
    });
    expect(sent).toHaveLength(0);
  });

  it("still refuses the dev-buy window here: buy() has no creator exemption", async () => {
    const { rt, sent } = atomicCreateVenue();
    await expect(
      createToken(rt, { name: "Win", symbol: "WIN", initialBuy: "1", devBuyDelaySeconds: 300 }),
    ).rejects.toMatchObject({ code: "dev_buy_not_supported_on_this_core" });
    expect(sent).toHaveLength(0);
  });
});

describe("holder snapshots of an atomic launch", () => {
  it("use erc20:<CHECKSUMMED token> — there is no sink to ask", async () => {
    const denom = await launchTokenDenom(
      { net: NET } as unknown as Runtime,
      { sink: `0x${"00".repeat(20)}`, token: "0x86e8e94f3181b15d11bb0303b88d272abd4fb00d" },
      "606",
    );
    // The lowercase spelling is a different, EMPTY bank denom.
    expect(denom).toBe("erc20:0x86e8e94F3181b15d11bB0303b88d272AbD4fb00D");
  });
});
