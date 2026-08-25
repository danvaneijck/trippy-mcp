import { describe, expect, it } from "vitest";

import { asApiLaunchId, type ApiLaunch, type ApiProfileHolding, type ApiProfileLaunch } from "../src/api/pump.js";
import { NETWORKS } from "../src/chain/networks.js";
import { claimFees, myActivity, myLaunches } from "../src/mcp/tools.js";
import type { Runtime } from "../src/runtime.js";

/**
 * A creator could not see their own launches.
 *
 * `my_activity` carried trades, `portfolio` carried balances, and neither could
 * tell a launch of your own from a stranger's coin — the dev buy looked
 * identical to any other buy. Meanwhile the creator-fee ledger accrued on the
 * core with no read-only path to it: the only way to learn what a launch owed
 * you was to broadcast a claim for it.
 *
 * These tests pin the three things that were wrong, plus the id crossing that
 * any new launch-scoped surface can reintroduce.
 */

const CORE_V2 = "0xd948740da926E8908A08414879490d0D8F96D463";
const CORE_V1 = "0xeBF62508F322137EE0986935Ee3b4A60a3F0D227";
const AGENT = `0x${"f8".repeat(20)}`;

const created = (o: Partial<ApiProfileLaunch> & { id: string }): ApiProfileLaunch =>
  ({
    core: CORE_V2,
    onchainId: o.id,
    creator: AGENT,
    token: `0x${"a1".repeat(20)}`,
    quoteAsset: 1,
    state: 1,
    metadataURI: "",
    createdAt: "2026-08-25T07:17:54.000Z",
    realPair: "38000000000000000000",
    tokensSold: "0",
    bankDenom: "inj",
    tradeFeeBps: 100,
    creatorFeeShareBps: 7000,
    graduationTarget: 1,
    graduatedPoolAddress: null,
    graduatedPoolDenom: null,
    lastTradedAt: null,
    hidden: false,
    featured: false,
    flagged: false,
    ...o,
    id: asApiLaunchId(o.id),
  }) as ApiProfileLaunch;

const holding = (o: Partial<ApiProfileHolding> & { launchId: string }): ApiProfileHolding =>
  ({
    core: CORE_V2,
    onchainId: o.launchId,
    creator: AGENT,
    token: `0x${"a1".repeat(20)}`,
    quoteAsset: 1,
    state: 1,
    metadataURI: "",
    realPair: "0",
    tokensSold: "0",
    sumBuyPair: "0",
    sumBuyToken: "0",
    sumSellPair: "0",
    sumSellToken: "0",
    sumSellFee: "0",
    feesPaid: "0",
    volumePair: "0",
    tradeCount: "0",
    lastTradeAt: null,
    currentBalance: "0",
    spotPriceWad: null,
    realizableValuePair: null,
    ...o,
    launchId: asApiLaunchId(o.launchId),
  }) as ApiProfileHolding;

const view = (over: Record<string, unknown> = {}) => ({
  state: 1,
  creator: AGENT,
  token: `0x${"a1".repeat(20)}`,
  sink: `0x${"00".repeat(20)}`,
  quoteAsset: 1,
  pairAsset: `0x${"00".repeat(20)}`,
  gate: { gateToken: `0x${"00".repeat(20)}`, minBalance: 0n, windowEndsAt: 0n, discountBps: 0 },
  tradingOpensAt: 0n,
  guardWindowEndsAt: 0n,
  maxBuyBpsInGuardWindow: 0,
  virtualPair: 0n,
  realPair: 38_000000000000000000n,
  tokensSold: 0n,
  graduationPairTarget: 500_000000000000000000n,
  tradeFeeBps: 100,
  creatorFeeShareBps: 7000,
  curveId: 6,
  metadataURI: "",
  bankDenom: "inj",
  ...over,
});

interface Calls {
  chainIds: string[];
  apiIds: string[];
  claimed: string[][];
}

function rtFor(opts: {
  createdLaunches: ApiProfileLaunch[];
  holdings?: ApiProfileHolding[];
  owed?: Record<string, bigint>;
  full?: Partial<ApiLaunch>;
  viewOver?: Record<string, unknown>;
}): { rt: Runtime; calls: Calls } {
  const calls: Calls = { chainIds: [], apiIds: [], claimed: [] };
  const rt = {
    net: NETWORKS.mainnet,
    signer: { address: AGENT },
    injAddress: "inj1agent",
    pump: {
      profile: async () => ({
        address: AGENT.toLowerCase(),
        holdings: opts.holdings ?? [],
        createdLaunches: opts.createdLaunches,
      }),
      getLaunch: async (id: string) => {
        calls.apiIds.push(id);
        const hit = opts.createdLaunches.find((l) => l.id === id);
        if (!hit) throw new Error("not found");
        return { ...hit, volume24h: "0", holderCount: "0", userHolderCount: "0", ...opts.full } as ApiLaunch;
      },
      profileTrades: async () => ({ items: [] }),
    },
    choiceApi: { wallet: async () => ({}) },
    shroom: {
      usdValue: async () => 2.39,
      forLaunch: ({ core }: { core?: string | null }) => ({
        getLaunchView: async (id: bigint) => {
          calls.chainIds.push(id.toString());
          return view(opts.viewOver);
        },
        creatorFeesOwed: async (id: bigint) => {
          calls.chainIds.push(id.toString());
          return opts.owed?.[id.toString()] ?? 0n;
        },
        claimable: async (ids: bigint[]) => ({
          creator: ids
            .map((i) => ({ launchId: i, amount: opts.owed?.[i.toString()] ?? 0n }))
            .filter((c) => c.amount > 0n)
            .map((c) => ({ ...c, quote: NETWORKS.mainnet.quoteAssets.INJ! })),
          referral: [],
          refund: 0n,
        }),
        claimAll: async (ids: bigint[]) => {
          calls.claimed.push([String(core), ...ids.map(String)]);
          return { creatorFees: [], referralFees: [], refundInj: null, txHashes: ["0xdead"], notes: [] };
        },
      }),
    },
  } as unknown as Runtime;
  return { rt, calls };
}

describe("my_launches", () => {
  it("reads the fee ledger with the ON-CHAIN id and the tape with the SURROGATE", async () => {
    // The launch this shipped for is surrogate 247 / on-chain 114, and 114 is
    // itself a real, unrelated launch as a surrogate. Crossing them here would
    // report another coin's volume beside this coin's fees.
    const { rt, calls } = rtFor({
      createdLaunches: [created({ id: "247", onchainId: "114" })],
      owed: { "114": 405400898995987566n },
    });
    const res = (await myLaunches(rt, {})) as { launches: Record<string, any>[] };

    expect(calls.apiIds).toEqual(["247"]);
    expect(new Set(calls.chainIds)).toEqual(new Set(["114"]));
    expect(res.launches[0]!.launchId).toBe("247");
    expect(res.launches[0]!.onchainId).toBe("114");
    expect(res.launches[0]!.fees.owed).toBe("0.405400898995987566 INJ");
  });

  it("refetches activity instead of trusting the profile row's zeros", async () => {
    // The profile endpoint's created-launches query does not select volume or
    // holders, and the serialiser fills in "0" — a launch doing 58 INJ a day
    // reads as dead. `ApiProfileLaunch` omits the fields; this is the behaviour
    // that omission buys.
    const { rt } = rtFor({
      createdLaunches: [created({ id: "247", onchainId: "114" })],
      full: { volume24h: "58549320619787006831", userHolderCount: "9" },
    });
    const res = (await myLaunches(rt, {})) as { launches: Record<string, any>[] };
    expect(res.launches[0]!.activity).toEqual({
      volume24h: "58.549320619787006831",
      holders: "9",
      lastTradedAt: null,
    });
  });

  it("nets the bag and the unclaimed fees against what the wallet paid in", async () => {
    const { rt } = rtFor({
      createdLaunches: [created({ id: "247", onchainId: "114" })],
      owed: { "114": 400000000000000000n }, // 0.4 INJ
      holdings: [
        holding({
          launchId: "247",
          sumBuyPair: "5000000000000000000", // 5 INJ dev buy
          currentBalance: "25915345206147840936813857",
          realizableValuePair: "7272351888269845614", // 7.27 INJ exit quote
        }),
      ],
    });
    const res = (await myLaunches(rt, {})) as { launches: Record<string, any>[] };
    // 7.272351888269845614 + 0 sold + 0.4 owed − 5 bought
    expect(res.launches[0]!.myPosition.netIfSoldNow).toBe("+2.672351888269845614 INJ");
    expect(res.launches[0]!.myPosition.sellAllValue).toBe("7.272351888269845614 INJ");
  });

  it("reports the dev-buy window the launch actually got", async () => {
    // 07:17:54 create → 07:18:48 open. The API serves no field for this, so the
    // chain view is the only record of how much exclusivity a launch really had.
    const { rt } = rtFor({
      createdLaunches: [created({ id: "247", onchainId: "114" })],
      viewOver: { tradingOpensAt: 1787642328n, maxBuyBpsInGuardWindow: 2000 },
    });
    const res = (await myLaunches(rt, {})) as { launches: Record<string, any>[] };
    expect(res.launches[0]!.devBuyWindow.exclusiveSecondsAfterCreate).toBe(54);
    expect(res.launches[0]!.devBuyWindow.maxBuyBpsInGuardWindow).toBe(2000);
  });

  it("keeps a launch on an unknown core in the list, minus the reads it cannot do", async () => {
    const { rt } = rtFor({ createdLaunches: [created({ id: "500", onchainId: "3", core: `0x${"99".repeat(20)}` })] });
    const res = (await myLaunches(rt, {})) as { launches: Record<string, any>[] };
    expect(res.launches).toHaveLength(1);
    expect(res.launches[0]!.note).toMatch(/does not know/);
    expect(res.launches[0]!.fees).toBeUndefined();
  });

  it("caps the rows it values and says how many it left out", async () => {
    const { rt } = rtFor({
      createdLaunches: [created({ id: "3" }), created({ id: "2" }), created({ id: "1" })],
    });
    const res = (await myLaunches(rt, { limit: 2 })) as { launches: unknown[]; created: number; notes: string[] };
    expect(res.launches).toHaveLength(2);
    expect(res.created).toBe(3);
    expect(res.notes.join(" ")).toMatch(/showing 2 of 3/);
  });
});

describe("claim_fees", () => {
  it("preview reads the ledgers and broadcasts nothing", async () => {
    const { rt, calls } = rtFor({
      createdLaunches: [created({ id: "247", onchainId: "114" })],
      owed: { "114": 405400898995987566n },
    });
    const res = (await claimFees(rt, { launchIds: ["247"], preview: true })) as {
      preview: boolean;
      creatorFees: { launchId: string; amount: string }[];
      txHashes: string[];
      notes: string[];
    };
    expect(res.preview).toBe(true);
    expect(calls.claimed).toEqual([]);
    expect(res.txHashes).toEqual([]);
    // Reported under the surrogate the caller passed, not the on-chain id.
    expect(res.creatorFees).toEqual([{ launchId: "247", amount: "0.405400898995987566 INJ" }]);
    expect(res.notes.join(" ")).toMatch(/nothing was broadcast/);
  });

  it("with no launchIds, claims every launch this wallet created", async () => {
    // The old no-arg behaviour did referral and refunds only and left creator
    // fees on the table — the ids were undiscoverable, so nobody passed them.
    const { rt, calls } = rtFor({
      createdLaunches: [
        created({ id: "247", onchainId: "114", core: CORE_V2 }),
        created({ id: "9", onchainId: "9", core: CORE_V1 }),
      ],
    });
    await claimFees(rt, {});
    const v2 = calls.claimed.find((c) => c[0]!.toLowerCase() === CORE_V2.toLowerCase());
    const v1 = calls.claimed.find((c) => c[0]!.toLowerCase() === CORE_V1.toLowerCase());
    expect(v2).toEqual([CORE_V2, "114"]);
    expect(v1).toEqual([CORE_V1, "9"]);
  });

  it("skips a discovered launch on an unknown core instead of failing the whole claim", async () => {
    const { rt, calls } = rtFor({
      createdLaunches: [
        created({ id: "247", onchainId: "114", core: CORE_V2 }),
        created({ id: "500", onchainId: "3", core: `0x${"99".repeat(20)}` }),
      ],
    });
    const res = (await claimFees(rt, {})) as { notes: string[] };
    expect(res.notes.join(" ")).toMatch(/#500 is on LaunchpadCore/);
    expect(calls.claimed.find((c) => c[0]!.toLowerCase() === CORE_V2.toLowerCase())).toEqual([CORE_V2, "114"]);
  });
});

describe("my_activity", () => {
  it("lists the launches this wallet created, not just the trades", async () => {
    const { rt } = rtFor({ createdLaunches: [created({ id: "247", onchainId: "114" })] });
    const res = (await myActivity(rt, {})) as { created: Record<string, any>[]; createdNote: string };
    expect(res.created).toHaveLength(1);
    expect(res.created[0]!.launchId).toBe("247");
    expect(res.created[0]!.raised).toBe("38 INJ");
    expect(res.createdNote).toMatch(/my_launches/);
  });
});
