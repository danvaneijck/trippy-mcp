import { describe, expect, it } from "vitest";

import { NETWORKS, coreDeployments } from "../src/chain/networks.js";
import { createToken } from "../src/mcp/tools.js";
import type { Runtime } from "../src/runtime.js";
import { ShroomVenue } from "../src/venues/shroom/launchpad.js";

/**
 * What a launch is created on when the agent names no curve.
 *
 * It used to be a hard-coded curveId 0. The registry is append-only, so a menu
 * swap disables ids 0-6 and appends replacements under the SAME names at 7+ —
 * after which id 0 is a disabled preset and every launch without a stated
 * preference reverts `PresetDisabled`, after the fee is committed. These tests
 * drive the real `ShroomVenue.createLaunch` (and `create_token` on top of it)
 * against a stubbed chain and read the curveId off the calldata it sends.
 */

interface RawPreset {
  name: string;
  enabled: boolean;
  rBps?: number;
  targetMulBps?: number;
  quoteMask?: number;
}

const ALL = 0xffff_ffff;
const INJ_USDC = 0b110;

/** The mainnet menu before the swap: ids 0-6, all enabled. */
const BEFORE: RawPreset[] = [
  { name: "standard", enabled: true },
  { name: "gentle", enabled: true, rBps: 10_000 },
  { name: "steep", enabled: true, rBps: 1500 },
  { name: "deep-lp", enabled: true },
  { name: "high-float", enabled: true },
  { name: "whale", enabled: true, targetMulBps: 40_000, quoteMask: INJ_USDC },
  { name: "micro", enabled: true, targetMulBps: 2000 },
];

/** After it: 0-6 disabled, replacements appended at 7-12, no new high-float. */
const AFTER: RawPreset[] = [
  ...BEFORE.map((p) => ({ ...p, enabled: false })),
  { name: "standard", enabled: true },
  { name: "gentle", enabled: true, rBps: 10_000 },
  { name: "steep", enabled: true, rBps: 1500 },
  { name: "deep-lp", enabled: true, rBps: 20_000 },
  { name: "whale", enabled: true, targetMulBps: 40_000, quoteMask: INJ_USDC },
  { name: "micro", enabled: true, targetMulBps: 2000 },
];

interface Sent {
  functionName: string;
  cfg: Record<string, unknown>;
}

/**
 * A ShroomVenue over a chain that answers only what createLaunch reads, and
 * records every write instead of sending it. `bound` picks the core: null is
 * the network's current (v2, registry-backed) one.
 */
function stubVenue(menu: RawPreset[], bound: ReturnType<typeof coreDeployments>[number] | null = null) {
  const reads: string[] = [];
  const sent: Sent[] = [];
  const signer = {
    address: `0x${"12".repeat(20)}`,
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      reads.push(functionName);
      switch (functionName) {
        case "paused":
          return false;
        case "denomCreationFeeInj":
          return 100_000_000_000_000_000n;
        case "nextLaunchId":
          return 10_063n;
        case "launchTokenFactory":
          // Pre-atomic, so the dev-buy window is priced rather than refused.
          return `0x${"00".repeat(20)}`;
        case "getPresets":
          return menu.map((p) => ({
            virtualToken: 1_073_000_000_000_000_000_000_000_000n,
            rBps: p.rBps ?? 4000,
            targetMulBps: p.targetMulBps ?? 10_000,
            quoteMask: p.quoteMask ?? ALL,
            enabled: p.enabled,
            name: p.name,
          }));
        case "shapeOf": {
          void args;
          return [0n, 0n, 1_000_000_000_000_000_000_000_000_000n, 7780n, 2220n] as const;
        }
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    },
    writeTx: async (req: { functionName: string; args: unknown[] }) => {
      sent.push({ functionName: req.functionName, cfg: req.args[0] as Record<string, unknown> });
      return { status: "dry-run" as const, hash: null };
    },
  };
  const pump = { quotePrices: async () => ({ items: [] }) };
  const venue = new ShroomVenue(NETWORKS.mainnet, signer as never, pump as never, null, bound);
  return { venue, reads, sent };
}

const META = { name: "Test", symbol: "TEST" };

describe("createLaunch with no curve named", () => {
  it("sends the live standard's id in both registry states", async () => {
    for (const [menu, want] of [
      [BEFORE, 0],
      [AFTER, 7],
    ] as const) {
      for (const quoteSymbol of ["INJ", "USDC", "SAI"] as const) {
        const { venue, sent } = stubVenue(menu);
        await venue.createLaunch({ meta: META, quoteSymbol });
        expect(sent, `${quoteSymbol}`).toHaveLength(1);
        expect(sent[0]!.functionName).toBe("createLaunch");
        expect(sent[0]!.cfg.curveId, `${quoteSymbol} on a ${menu.length}-entry menu`).toBe(want);
      }
    }
  });

  it("never sends the disabled id 0 after the swap", async () => {
    const { venue, sent } = stubVenue(AFTER);
    await venue.createLaunch({ meta: META, quoteSymbol: "INJ" });
    expect(sent[0]!.cfg.curveId).not.toBe(0);
  });

  it("an explicit curveId is passed through untouched", async () => {
    const { venue, sent } = stubVenue(AFTER);
    await venue.createLaunch({ meta: META, quoteSymbol: "INJ", curveId: 9 });
    expect(sent[0]!.cfg.curveId).toBe(9);
  });

  it("prices the dev-buy window against the RESOLVED preset, not against id 0", async () => {
    // Make the two standards differ in the one way resolveLaunchTiming can see:
    // steepness. A steep curve caps the default dev buy at 1154 bps where a
    // flat one gets the full 2000, so the cap that lands in the calldata says
    // which preset the timing was priced against.
    const menu: RawPreset[] = [
      { name: "standard", enabled: false, rBps: 4000 },
      { name: "standard", enabled: true, rBps: 1500 },
    ];
    const { venue, sent } = stubVenue(menu);
    await venue.createLaunch({
      meta: META,
      quoteSymbol: "INJ",
      devBuy: { openDelaySeconds: 600 },
    });
    expect(sent[0]!.cfg.curveId).toBe(1);
    expect(sent[0]!.cfg.maxBuyBpsInGuardWindow).toBe(1154);
  });

  it("refuses before sending anything when no usable standard exists", async () => {
    const menu: RawPreset[] = [
      { name: "standard", enabled: false },
      { name: "gentle", enabled: true, rBps: 10_000 },
    ];
    const { venue, sent } = stubVenue(menu);
    await expect(venue.createLaunch({ meta: META, quoteSymbol: "INJ" })).rejects.toMatchObject({
      code: "bad_curve",
    });
    await expect(venue.createLaunch({ meta: META, quoteSymbol: "INJ" })).rejects.toThrow(
      /standard.*retired/,
    );
    expect(sent).toHaveLength(0);
  });

  it("keeps the v1 path as it was: no registry read, no curveId in the calldata", async () => {
    const v1 = coreDeployments(NETWORKS.mainnet).find((d) => !d.hasCurveId);
    expect(v1).toBeDefined();
    const { venue, reads, sent } = stubVenue(AFTER, v1!);
    await venue.createLaunch({ meta: META, quoteSymbol: "INJ" });
    expect(reads).not.toContain("getPresets");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.cfg).not.toHaveProperty("curveId");
  });
});

describe("create_token with no curve named", () => {
  function rtOver(menu: RawPreset[]) {
    const { venue, sent } = stubVenue(menu);
    const rt = {
      net: NETWORKS.mainnet,
      shroom: venue,
      pump: { listLaunches: async () => ({ items: [] }) },
    } as unknown as Runtime;
    return { rt, sent };
  }

  it("launches on the live standard and says so, in both registry states", async () => {
    for (const [menu, want] of [
      [BEFORE, 0],
      [AFTER, 7],
    ] as const) {
      const { rt, sent } = rtOver(menu);
      const res = (await createToken(rt, { name: "Test", symbol: "TEST" })) as {
        curve?: { curveId: number; name: string };
      };
      expect(sent[0]!.cfg.curveId).toBe(want);
      // The default is reported like a chosen curve: the agent learns which
      // registration it actually got.
      expect(res.curve).toMatchObject({ curveId: want, name: "standard" });
    }
  });

  it("resolves a named curve to its replacement after the swap", async () => {
    const { rt, sent } = rtOver(AFTER);
    await createToken(rt, { name: "Test", symbol: "TEST", curve: "whale", quoteAsset: "USDC" });
    expect(sent[0]!.cfg.curveId).toBe(11);
  });

  it("refuses a masked pairing with the live menu for that quote", async () => {
    const { rt, sent } = rtOver(AFTER);
    const err = await createToken(rt, {
      name: "Test",
      symbol: "TEST",
      curve: "whale",
      quoteAsset: "SAI",
    }).catch((e: unknown) => e as { code: string; message: string; hint?: string });
    expect(err).toMatchObject({ code: "bad_curve" });
    expect((err as { message: string }).message).toContain("not available on this quote asset");
    expect(sent).toHaveLength(0);
  });

  it("refuses a name that only exists retired, before anything is sent", async () => {
    const { rt, sent } = rtOver(AFTER);
    await expect(
      createToken(rt, { name: "Test", symbol: "TEST", curve: "high-float" }),
    ).rejects.toThrow(/high-float.*retired/);
    expect(sent).toHaveLength(0);
  });
});
