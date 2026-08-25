import { describe, expect, it } from "vitest";

import { asApiLaunchId, type ApiLaunch } from "../src/api/pump.js";
import { buy, candles, claimFees, createToken, recentTrades, sell } from "../src/mcp/tools.js";
import { ShroomVenue } from "../src/venues/shroom/launchpad.js";
import { allowedTargetsFor, type Runtime } from "../src/runtime.js";
import { NETWORKS, coreDeployments, quoteAssetBySlot } from "../src/chain/networks.js";

/**
 * The v2 launchpad gave every launch TWO ids and the package crossed them.
 *
 * `ApiLaunch.id` is the pad API's surrogate, unique across cores and the only
 * id any user-facing surface prints. The on-chain id restarts at 0 on each
 * deployed core, and the chain takes only that one. They were the same number
 * while one core existed; mainnet's second core made surrogate 234 into
 * on-chain 108, and made surrogate 108 a real, unrelated launch.
 *
 * Every test here pins a direction of that mapping. None of them would have
 * failed before the second core deployed, which is exactly why the crossings
 * shipped.
 */

const CORE_V2 = "0xd948740da926E8908A08414879490d0D8F96D463";
const CORE_V1 = "0xeBF62508F322137EE0986935Ee3b4A60a3F0D227";

const row = (o: Partial<ApiLaunch> & { id: string }) =>
  ({
    core: CORE_V2,
    onchainId: o.id,
    token: `0x${"a1".repeat(20)}`,
    quoteAsset: 1,
    state: 1,
    metadataURI: "",
    ...o,
    id: asApiLaunchId(o.id),
  }) as ApiLaunch;

// ---------------------------------------------------------------------------
// the pad API is keyed by the surrogate
// ---------------------------------------------------------------------------

describe("pad API reads take the surrogate id", () => {
  /** Records which id each endpoint was actually called with. */
  function apiRt(launch: ApiLaunch): { rt: Runtime; calls: Record<string, string[]> } {
    const calls: Record<string, string[]> = { trades: [], candles: [] };
    const rt = {
      net: NETWORKS.mainnet,
      shroom: { quoteInfo: (slot: number) => quoteAssetBySlot(NETWORKS.mainnet, slot) },
      pump: {
        getLaunch: async (id: string) => {
          if (id !== launch.id) throw new Error("not found");
          return launch;
        },
        getTrades: async (id: string) => {
          calls.trades!.push(id);
          return { items: [] };
        },
        getCandles: async (id: string) => {
          calls.candles!.push(id);
          return { interval: "1h", from: 0, to: 0, items: [] };
        },
      },
    } as unknown as Runtime;
    return { rt, calls };
  }

  it("recent_trades fetches the tape by surrogate, not by on-chain id", async () => {
    // The bug, in one line: asking for launch 242 returned launch 112's tape,
    // rows and all, because 112 is what 242 is called on its core.
    const { rt, calls } = apiRt(row({ id: "242", onchainId: "112" }));
    await recentTrades(rt, { query: "242", limit: 3 });
    expect(calls.trades).toEqual(["242"]);
  });

  it("candles fetches the series by surrogate, not by on-chain id", async () => {
    // Worse than the tape: the response is labelled with the id the caller
    // asked for, so another launch's OHLCV arrives under the right name with
    // nothing to give it away.
    const { rt, calls } = apiRt(row({ id: "242", onchainId: "112" }));
    await candles(rt, { query: "242", interval: "1h", limit: 5 });
    expect(calls.candles).toEqual(["242"]);
  });
});

// ---------------------------------------------------------------------------
// claims are per-core ledgers
// ---------------------------------------------------------------------------

describe("claim_fees", () => {
  function claimRt(rows: ApiLaunch[]): {
    rt: Runtime;
    seen: { core: string; ids: string[] }[];
  } {
    const seen: { core: string; ids: string[] }[] = [];
    const rt = {
      net: NETWORKS.mainnet,
      pump: {
        getLaunch: async (id: string) => {
          const hit = rows.find((r) => r.id === id);
          if (!hit) throw new Error("not found");
          return hit;
        },
      },
      shroom: {
        forLaunch: ({ core }: { core?: string | null }) => ({
          claimAll: async (ids: bigint[]) => {
            seen.push({ core: String(core), ids: ids.map(String) });
            return {
              creatorFees: ids.map((i) => ({ onchainId: i.toString(), amount: `1 INJ` })),
              referralFees: [],
              refundInj: null,
              txHashes: [],
              notes: ids.length === 0 ? ["nothing to claim — all ledgers are zero"] : [],
            };
          },
        }),
      },
    } as unknown as Runtime;
    return { rt, seen };
  }

  it("sends each launch's on-chain id to the core that issued it", async () => {
    const { rt, seen } = claimRt([
      row({ id: "234", onchainId: "108", core: CORE_V2 }),
      row({ id: "9", onchainId: "9", core: CORE_V1 }),
    ]);
    await claimFees(rt, { launchIds: ["234", "9"] });

    const v2 = seen.find((s) => s.core.toLowerCase() === CORE_V2.toLowerCase());
    const v1 = seen.find((s) => s.core.toLowerCase() === CORE_V1.toLowerCase());
    expect(v2?.ids).toEqual(["108"]);
    expect(v1?.ids).toEqual(["9"]);
  });

  it("visits the superseded core even when no launch id names it", async () => {
    // Referral fees and refunds are per-WALLET ledgers, but each core keeps its
    // own — binding only to the current core made everything owed on the old
    // one unreachable through this tool.
    const { rt, seen } = claimRt([row({ id: "234", onchainId: "108", core: CORE_V2 })]);
    await claimFees(rt, { launchIds: ["234"] });
    expect(seen.map((s) => s.core.toLowerCase()).sort()).toEqual(
      [CORE_V1.toLowerCase(), CORE_V2.toLowerCase()].sort(),
    );
  });

  it("reports what it claimed under the surrogate id the caller passed in", async () => {
    const { rt } = claimRt([row({ id: "234", onchainId: "108", core: CORE_V2 })]);
    const res = (await claimFees(rt, { launchIds: ["234"] })) as {
      creatorFees: { launchId: string }[];
    };
    expect(res.creatorFees.map((c) => c.launchId)).toContain("234");
    expect(res.creatorFees.map((c) => c.launchId)).not.toContain("108");
  });

  it("refuses an id the API does not know rather than reading it off a core", async () => {
    const { rt } = claimRt([]);
    await expect(claimFees(rt, { launchIds: ["234"] })).rejects.toThrow(/no SHROOM launch/);
  });

  it("refuses a launch on a core this build cannot name", async () => {
    // Otherwise it falls out of every per-core batch and the tool cheerfully
    // reports that there was nothing to claim.
    const { rt } = claimRt([row({ id: "500", onchainId: "3", core: `0x${"99".repeat(20)}` })]);
    await expect(claimFees(rt, { launchIds: ["500"] })).rejects.toThrow(/does not know/);
  });
});

// ---------------------------------------------------------------------------
// create_token reports the id the caller can actually use
// ---------------------------------------------------------------------------

describe("create_token", () => {
  const TOKEN = `0x${"c7".repeat(20)}`;

  function createRt(indexed: ApiLaunch | null): Runtime & Record<string, any> {
    return {
      net: NETWORKS.mainnet,
      pump: {
        listLaunches: async ({ q }: { q?: string }) => ({
          items: indexed && indexed.token.toLowerCase() === String(q).toLowerCase() ? [indexed] : [],
        }),
      },
      shroom: {
        createLaunch: async () => ({
          onchainId: "114",
          core: CORE_V2,
          token: TOKEN,
          state: "Trading",
          hash: "0xdead",
          status: "confirmed",
          creationFeeInj: "0.11",
          warnings: [],
        }),
      },
    } as unknown as Runtime;
  }

  it("reports the surrogate as launchId and keeps the on-chain id under its own name", async () => {
    // It used to return the on-chain id AS `launchId`. The next launch is
    // on-chain 114, and API launch 114 is an existing unrelated coin — so
    // `token_info` on the returned id looked up someone else's token.
    const res = (await createToken(createRt(row({ id: "247", onchainId: "114", token: TOKEN })), {
      name: "Test",
      symbol: "TEST",
    })) as { launchId: string | null; onchainId: string; terminalUrl?: string };

    expect(res.launchId).toBe("247");
    expect(res.onchainId).toBe("114");
    expect(res.terminalUrl).toBe("https://trade.trippyinj.xyz/t/shroom-curve%3A247");
  });

  it("tags the opening buy with the surrogate too", async () => {
    const rt = createRt(row({ id: "247", onchainId: "114", token: TOKEN }));
    rt.shroom.buy = async () => ({ onchainId: "114", side: "buy", status: "confirmed", hash: "0x1" });
    rt.policy = { clampSlippageBps: () => 100 };
    const res = (await createToken(rt, { name: "T", symbol: "T", initialBuy: "1" })) as {
      initialBuy: { launchId: string | null; onchainId: string };
    };
    expect(res.initialBuy.launchId).toBe("247");
    expect(res.initialBuy.onchainId).toBe("114");
  });

  it("says so rather than inventing a link when the API has not indexed the launch yet", async () => {
    const res = (await createToken(createRt(null), { name: "Test", symbol: "TEST" })) as {
      launchId: string | null;
      terminalUrl?: string;
      warnings: string[];
    };
    expect(res.launchId).toBeNull();
    expect(res.terminalUrl).toBeUndefined();
    expect(res.warnings.join(" ")).toMatch(/has not indexed/);
  });
});

// ---------------------------------------------------------------------------
// a trade result names the launch the caller asked for
// ---------------------------------------------------------------------------

describe("buy / sell results", () => {
  function tradeRt(launch: ApiLaunch) {
    return {
      net: NETWORKS.mainnet,
      policy: { clampSlippageBps: () => 100 },
      pump: {
        getLaunch: async (id: string) => {
          if (id !== launch.id) throw new Error("not found");
          return launch;
        },
      },
      shroom: {
        forLaunch: () => ({
          // What ShroomVenue really returns: the id it executed against.
          buy: async (id: bigint) => ({ onchainId: id.toString(), side: "buy", status: "confirmed" }),
          sell: async (id: bigint) => ({ onchainId: id.toString(), side: "sell", status: "confirmed" }),
        }),
      },
    } as unknown as Runtime;
  }

  it("reports the surrogate the caller traded, not the id it executed against", async () => {
    // Live fire caught this: buying launch 21 (MASK, on-chain 2 on the current
    // core) came back as `launchId: "2"`, which is BALLS on the other core.
    const rt = tradeRt(row({ id: "21", onchainId: "2" }));
    const b = (await buy(rt, { query: "21", amount: "0.1" })) as {
      launchId: string;
      onchainId: string;
    };
    expect(b.launchId).toBe("21");
    expect(b.onchainId).toBe("2");
  });

  it("does the same on the sell side", async () => {
    const rt = tradeRt(row({ id: "21", onchainId: "2" }));
    const s = (await sell(rt, { query: "21", amount: "all" })) as { launchId: string };
    expect(s.launchId).toBe("21");
  });
});

// ---------------------------------------------------------------------------
// the policy allowlist is per deployment, not per network
// ---------------------------------------------------------------------------

describe("contract allowlist", () => {
  it("admits every deployed core, not only the current one", () => {
    // A superseded core keeps trading and paying out what is already on it.
    // Naming only the current core refused every write against the old one
    // inside the signer, which reads as policy working rather than as a
    // missing address — and there is no way for a caller to tell them apart.
    const allowed = allowedTargetsFor(NETWORKS.mainnet);
    for (const dep of coreDeployments(NETWORKS.mainnet)) {
      expect(allowed).toContain(dep.core.toLowerCase());
    }
    expect(coreDeployments(NETWORKS.mainnet).length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// CurveRegistry.shapeOf returns a positional tuple
// ---------------------------------------------------------------------------

describe("curve presets", () => {
  /** `shapeOf` as the chain really answers it: five positional uint256s. */
  const SHAPE_STANDARD = [
    766_428_571_428_571_428_571_428_572n,
    233_571_428_571_428_571_428_571_428n,
    1_000_000_000_000_000_000_000_000_000n,
    7664n,
    2335n,
  ] as const;

  function venue(shapeOf: (i: number) => unknown): ShroomVenue {
    const signer = {
      readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
        if (functionName === "getPresets") {
          return [
            {
              virtualToken: 1_073_000_000_000_000_000_000_000_000n,
              rBps: 4000,
              targetMulBps: 10_000,
              quoteMask: 15,
              enabled: true,
              name: "standard",
            },
          ];
        }
        if (functionName === "shapeOf") return shapeOf(Number(args[0]));
        throw new Error(`unexpected read ${functionName}`);
      },
    };
    return new ShroomVenue(NETWORKS.mainnet, signer as never, {} as never, null);
  }

  it("reads float and LP off the tuple's positions, not off field names", async () => {
    // `shapeOf` has five outputs, so viem decodes it to an array — it only
    // keys a result by name for a single struct return. Reading `.floatBps`
    // gave `undefined`, `Number(undefined)` gave NaN, and JSON put `null` on
    // the wire for the two numbers a creator picks a curve on.
    const presets = await venue(() => SHAPE_STANDARD)!.curvePresets();
    expect(presets![0]!.floatBps).toBe(7664);
    expect(presets![0]!.lpBps).toBe(2335);
  });

  it("keeps float null when the registry read fails, rather than reporting 0%", async () => {
    // The old fallback was 0, and it was unreachable anyway: `shape ? … : 0`
    // never fires on an array. A zero float is a claim about the launch.
    const presets = await venue(() => {
      throw new Error("rpc down");
    })!.curvePresets();
    expect(presets![0]!.floatBps).toBeNull();
    expect(presets![0]!.lpBps).toBeNull();
  });

  it("still reports the rest of the menu when only the shape read fails", async () => {
    const presets = await venue(() => {
      throw new Error("rpc down");
    })!.curvePresets();
    expect(presets![0]!.name).toBe("standard");
    expect(presets![0]!.rBps).toBe(4000);
  });
});
