import { afterEach, describe, expect, it } from "vitest";

import { asApiLaunchId, type ApiLaunch, type ApiProfileLaunch } from "../src/api/pump.js";
import { NETWORKS } from "../src/chain/networks.js";
import { claimFees, myLaunches } from "../src/mcp/tools.js";
import { PolicyEngine } from "../src/policy/policy.js";
import type { Runtime } from "../src/runtime.js";
import { legBpsFor, prepareCollect, shareOf } from "../src/venues/shroom/locker.js";

/**
 * A graduated launch earns on TWO rails and this package could only see one.
 *
 * The curve's creator fee accrues on LaunchpadCore, EVM-side, and `claim_fees`
 * has always moved it. The graduated pool's swap fee accrues inside a CLMM
 * position NFT held by a per-launch CosmWasm locker — a different chain half,
 * a different contract, no link to the core — and nothing here could read it,
 * so `my_launches` reported a graduated launch's earnings as the curve ledger
 * alone. On the launch this shipped for that was 7.5 INJ beside ~$197 of
 * uncollected pool fees.
 *
 * These tests pin: the second rail is read at all, the split is applied to it,
 * a locker that is not ours is never signed for, and an unreadable locker
 * reports UNKNOWN rather than the zero that started this.
 */

const CORE_V2 = "0xd948740da926E8908A08414879490d0D8F96D463";
const AGENT = `0x${"f8".repeat(20)}`;
const ME = "inj1agent";
const LOCKER = "inj14epy8tp28jxfazca4hz02k6rjr4qudu0fylqu3";
const MANAGER = "inj1eag2kjzs5ma5sflxvlhaacdxxpvdjg4ny7yg3g";
const TOKEN_DENOM = "factory/inj13j2rpnlwl30c02d4pzukykwfeyyhelvry9cqte/shroom_114_955c7968a51e189a";
const LCD = NETWORKS.mainnet.lcdUrl;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The three LCD reads a locker costs, with the real BOOTS numbers. */
function lockerLcd(
  opts: {
    creator?: string;
    treasury?: string;
    shareBps?: number;
    owed0?: string;
    owed1?: string;
    fails?: boolean;
  } = {},
) {
  const decode = (url: string): Record<string, unknown> => {
    const b64 = decodeURIComponent(/\/smart\/(.+)$/.exec(url)![1]!);
    return JSON.parse(Buffer.from(b64, "base64").toString());
  };
  const seen: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (!url.includes("/smart/")) return new Response("{}", { status: 404 });
    if (opts.fails) return new Response("upstream is down", { status: 503 });
    const q = decode(url);
    seen.push(q);
    if ("locker_config" in q) {
      return Response.json({
        data: {
          manager: MANAGER,
          treasury: "inj1treasury",
          creator: opts.creator ?? ME,
          creator_fee_share_bps: opts.shareBps ?? 7000,
          admin: null,
        },
      });
    }
    if ("tokens" in q) return Response.json({ data: { tokens: ["134"] } });
    if ("position_with_fees" in q) {
      return Response.json({
        data: {
          position: {
            token0: { native_token: { denom: TOKEN_DENOM } },
            token1: { native_token: { denom: "inj" } },
          },
          liquidity: "341739248968733887972766",
          tokens_owed_0: opts.owed0 ?? "5749785246737572083856477",
          tokens_owed_1: opts.owed1 ?? "14453779178193452939",
        },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return seen;
}

const graduated = (o: Partial<ApiProfileLaunch> = {}): ApiProfileLaunch =>
  ({
    id: asApiLaunchId("247"),
    core: CORE_V2,
    onchainId: "114",
    creator: AGENT,
    token: `0x${"a1".repeat(20)}`,
    quoteAsset: 1,
    // Graduated.
    state: 4,
    metadataURI: "",
    createdAt: "2026-08-25T07:17:54.000Z",
    realPair: "500000000000000000000",
    tokensSold: "0",
    bankDenom: TOKEN_DENOM,
    tradeFeeBps: 100,
    creatorFeeShareBps: 7000,
    graduationTarget: 1,
    graduatedPoolAddress: "inj1h0mehrg8t3v92k9jw7taq7035w88cvf453alun",
    graduatedPoolDenom: TOKEN_DENOM,
    lockerAddr: LOCKER,
    lastTradedAt: null,
    hidden: false,
    featured: false,
    flagged: false,
    ...o,
  }) as ApiProfileLaunch;

interface Broadcast {
  contract: string;
  msg: unknown;
  intentKind: string;
}

function rtFor(opts: { launches: ApiProfileLaunch[]; tokenPriceUsd?: number | null }): {
  rt: Runtime;
  sent: Broadcast[];
} {
  const sent: Broadcast[] = [];
  const policy = new PolicyEngine(
    {
      tradingEnabled: true,
      perTxCapUsd: 100,
      dailyBudgetUsd: 100,
      maxSlippageBps: 500,
      allowUnpricedSpend: false,
      airdropCapUsd: 0,
    } as never,
    new Set([CORE_V2.toLowerCase()]),
    "0xowner",
    { spent: () => 0, record: () => undefined } as never,
  );
  const rt = {
    net: NETWORKS.mainnet,
    policy,
    signer: { address: AGENT },
    injAddress: ME,
    pump: {
      profile: async () => ({ address: AGENT.toLowerCase(), holdings: [], createdLaunches: opts.launches }),
      getLaunch: async (id: string) => {
        const hit = opts.launches.find((l) => l.id === id);
        if (!hit) throw new Error("not found");
        return { ...hit, volume24h: "0", holderCount: "0", userHolderCount: "0" } as ApiLaunch;
      },
    },
    choiceApi: {
      token: async () => ({
        price_usd: opts.tokenPriceUsd === undefined ? 0.0000203409 : opts.tokenPriceUsd,
        liquidity_usd: 7538.65,
      }),
    },
    shroom: {
      // $5.5534/INJ — the rate implied by the launch this shipped for.
      usdValue: async (_slot: number, wei: bigint) => (Number(wei) / 1e18) * 5.5534,
      forLaunch: () => ({
        getLaunchView: async () => null,
        creatorFeesOwed: async () => 0n,
        claimable: async () => ({ creator: [], referral: [], refund: 0n }),
        claimAll: async () => ({
          creatorFees: [],
          referralFees: [],
          refundInj: null,
          txHashes: [],
          notes: ["nothing to claim — all ledgers are zero"],
        }),
      }),
    },
    cosmos: {
      execute: async (msgs: { contract: string; msg: unknown }[], o: { intent: { kind: string; target: string } }) => {
        // The signer's own check: policy runs INSIDE it, so a target the
        // engine refuses must never reach a broadcast.
        policy.enforce(o.intent as never);
        sent.push({ contract: msgs[0]!.contract, msg: msgs[0]!.msg, intentKind: o.intent.kind });
        return { txHash: "0xc0ffee", status: "broadcast", raw: null };
      },
    },
  } as unknown as Runtime;
  return { rt, sent };
}

describe("the locker split", () => {
  const config = { manager: MANAGER, treasury: "inj1treasury", creator: ME, creator_fee_share_bps: 7000, admin: null };

  it("takes the creator leg when the wallet is the creator", () => {
    expect(legBpsFor(config, ME)).toBe(7000);
    expect(shareOf(1000n, config, ME)).toBe(700n);
  });

  it("takes the TREASURY leg — the complement — when the wallet is the treasury", () => {
    // Not 7000: the treasury gets what the creator does not.
    expect(legBpsFor(config, "inj1treasury")).toBe(3000);
    expect(shareOf(1000n, config, "inj1treasury")).toBe(300n);
  });

  it("is zero for a stranger's locker", () => {
    expect(legBpsFor(config, "inj1nobody")).toBe(0);
  });
});

describe("prepareCollect", () => {
  it("refuses a locker that pays neither leg to this wallet, and allowlists nothing", async () => {
    lockerLcd({ creator: "inj1someoneelse", treasury: "inj1treasury" });
    const policy = new PolicyEngine({} as never, new Set(), "0xowner", {} as never);
    await expect(
      prepareCollect({ lcdUrl: LCD, injAddress: ME, policy }, LOCKER),
    ).rejects.toThrow(/neither of which is this wallet/);
    // The refusal has to be the allowlist's too — a locker admitted and then
    // rejected downstream is a locker any later call could reach.
    expect(() => policy.enforce({ kind: "claim", target: LOCKER, detail: "x" })).toThrow(/allowlist/);
  });

  it("admits a verified locker for `claim` ONLY", async () => {
    lockerLcd();
    const policy = new PolicyEngine({} as never, new Set(), "0xowner", {} as never);
    const msg = await prepareCollect({ lcdUrl: LCD, injAddress: ME, policy }, LOCKER);
    expect(msg).toEqual({ contract: LOCKER, msg: { collect_fees: { token_id: null } }, funds: [] });
    expect(() => policy.enforce({ kind: "claim", target: LOCKER, detail: "collect" })).not.toThrow();
    // A locker is not a trading venue. Widening it to `swap` would make every
    // graduated launch a signable target for something that moves value.
    expect(() => policy.enforce({ kind: "swap", target: LOCKER, detail: "x", spendUsd: 1 })).toThrow(/allowlist/);
  });
});

describe("my_launches", () => {
  it("names the launch-token leg off graduatedPoolDenom, NOT bankDenom", async () => {
    // `bankDenom` on a launch row is the QUOTE denom — "inj" here, not the coin
    // the launch minted. Reading the token leg off it files the bigger half of
    // the pool's fees under "other".
    lockerLcd();
    const { rt } = rtFor({ launches: [graduated({ bankDenom: "inj" })] });
    const res = (await myLaunches(rt, {})) as { launches: Record<string, any>[] };
    const legs = res.launches[0]!.poolFees.pending.map((r: any) => r.leg);
    expect(new Set(legs)).toEqual(new Set(["launch token", "INJ"]));
  });

  it("reports the pool rail beside the curve rail, split and priced", async () => {
    lockerLcd();
    const { rt } = rtFor({ launches: [graduated()] });
    const res = (await myLaunches(rt, {})) as { launches: Record<string, any>[] };
    const pool = res.launches[0]!.poolFees;

    expect(pool.locker).toBe(LOCKER);
    expect(pool.yourShareBps).toBe(7000);
    const inj = pool.pending.find((r: any) => r.leg === "INJ");
    expect(inj.gross).toBe("14.453779178193452939");
    // 70% of gross, in base units — not a float of a float.
    expect(inj.yours).toBe("10.117645424735417057");
    const token = pool.pending.find((r: any) => r.leg === "launch token");
    expect(token.gross).toBe("5749785.246737572083856477");
    // ~$197 gross, ~$138 ours — the figure the curve ledger alone was missing.
    expect(pool.pendingGrossUsd).toBeCloseTo(197.2, 0);
    expect(pool.pendingYoursUsd).toBeCloseTo(138.1, 0);
  });

  it("says UNKNOWN, not zero, when the locker will not answer", async () => {
    lockerLcd({ fails: true });
    const { rt } = rtFor({ launches: [graduated()] });
    const res = (await myLaunches(rt, {})) as { launches: Record<string, any>[] };
    expect(res.launches[0]!.poolFees.pending).toBeNull();
    expect(res.launches[0]!.poolFees.note).toMatch(/UNKNOWN, not zero/);
  });

  it("reads no locker at all for a launch that has not graduated", async () => {
    const seen = lockerLcd();
    const { rt } = rtFor({ launches: [graduated({ state: 1, lockerAddr: null })] });
    const res = (await myLaunches(rt, {})) as { launches: Record<string, any>[] };
    expect(res.launches[0]!.poolFees).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe("claim_fees", () => {
  it("collects the pool fees, not just the core ledgers", async () => {
    lockerLcd();
    const { rt, sent } = rtFor({ launches: [graduated()] });
    const res = (await claimFees(rt, {})) as { poolFees: Record<string, any>[]; txHashes: string[] };

    expect(sent).toEqual([
      { contract: LOCKER, msg: { collect_fees: { token_id: null } }, intentKind: "claim" },
    ]);
    expect(res.poolFees[0]!.launchId).toBe("247");
    expect(res.poolFees[0]!.collected).toBe(true);
    expect(res.txHashes).toContain("0xc0ffee");
  });

  it("previews the pool rail without signing anything", async () => {
    lockerLcd();
    const { rt, sent } = rtFor({ launches: [graduated()] });
    const res = (await claimFees(rt, { preview: true })) as { poolFees: Record<string, any>[] };
    expect(sent).toEqual([]);
    expect(res.poolFees[0]!.pendingYoursUsd).toBeCloseTo(138.1, 0);
    expect(res.poolFees[0]!.collected).toBeUndefined();
  });

  it("does not spend gas collecting an empty position", async () => {
    lockerLcd({ owed0: "0", owed1: "0" });
    const { rt, sent } = rtFor({ launches: [graduated()] });
    const res = (await claimFees(rt, {})) as { poolFees: unknown[]; notes: string[] };
    expect(sent).toEqual([]);
    expect(res.poolFees).toEqual([]);
    expect(res.notes.join(" ")).toMatch(/nothing to claim/);
  });

  it("never signs for a locker that pays someone else", async () => {
    lockerLcd({ creator: "inj1someoneelse" });
    const { rt, sent } = rtFor({ launches: [graduated()] });
    await claimFees(rt, {});
    expect(sent).toEqual([]);
  });
});
