import { describe, expect, it } from "vitest";

import { asApiLaunchId, type ApiLaunch } from "../src/api/pump.js";
import { NETWORKS } from "../src/chain/networks.js";
import { createToken } from "../src/mcp/tools.js";
import type { Runtime } from "../src/runtime.js";
import {
  devBuyFloatBps,
  MAX_DEV_BUY_BPS,
  MAX_DEV_FLOAT_BPS,
  MAX_OPEN_DELAY_SECONDS,
  maxDevBuyBpsFor,
  MIN_SAFE_OPEN_DELAY_SECONDS,
  type CurvePreset,
} from "../src/venues/shroom/curves.js";
import { ShroomVenue } from "../src/venues/shroom/launchpad.js";

/**
 * The V-4 dev-buy window and the holder gate, as the contract validates them.
 *
 * Both are set once, at createLaunch, and both are frozen onto the launch. The
 * contract reverts rather than clamping, so every rule mirrored here is the
 * difference between a refusal that names the right number and a revert that
 * costs the gas and says `DevBuyUncapped(0, 2000)`.
 */

describe("dev-buy float ceiling", () => {
  /**
   * The ratio the contract computes is
   * `devTokens/tokensAtGrad` with `cap = target·m` and `vp = target·r`, which
   * collapses to `m(1+r)/(r+m)` — the target and the virtual token reserve both
   * cancel. So the answer depends on the CURVE, not on the raise or the quote.
   */
  it("is a function of steepness and the cap, not of the raise", () => {
    // Same cap, same answer, whatever the quote asset raises.
    expect(devBuyFloatBps(4000, 2000)).toBe(4667);
    expect(devBuyFloatBps(4000, 1000)).toBe(2800);
  });

  it("bites harder on a steeper curve — which is the counter-intuitive part", () => {
    // A steeper curve sells less of the supply for the same quote in, so the
    // same cap buys a BIGGER share of the float.
    expect(devBuyFloatBps(1500, 2000)).toBe(6571); // steep — over the ceiling
    expect(devBuyFloatBps(4000, 2000)).toBe(4667); // standard — under it
    expect(devBuyFloatBps(10_000, 2000)).toBe(3333); // gentle — well under
  });

  it("caps `steep` below the contract's absolute maximum", () => {
    // The one preset out of seven where using MAX_DEV_BUY_BPS reverts.
    expect(maxDevBuyBpsFor(1500)).toBe(1154);
    expect(devBuyFloatBps(1500, maxDevBuyBpsFor(1500))).toBeLessThanOrEqual(MAX_DEV_FLOAT_BPS);
    expect(devBuyFloatBps(1500, maxDevBuyBpsFor(1500) + 1)).toBeGreaterThan(MAX_DEV_FLOAT_BPS);
  });

  it("lets every other preset use the full 2000 bps", () => {
    for (const rBps of [4000, 10_000]) {
      expect(maxDevBuyBpsFor(rBps)).toBe(MAX_DEV_BUY_BPS);
      expect(devBuyFloatBps(rBps, MAX_DEV_BUY_BPS)).toBeLessThanOrEqual(MAX_DEV_FLOAT_BPS);
    }
  });

  it("the inverse lands exactly on the ceiling, not near it", () => {
    // If this drifts, the client refuses launches the contract would take (or
    // worse, waves through ones it would revert).
    for (const rBps of [1500, 2500, 4000, 7000, 10_000]) {
      const max = maxDevBuyBpsFor(rBps);
      if (max < MAX_DEV_BUY_BPS) {
        expect(devBuyFloatBps(rBps, max)).toBeLessThanOrEqual(MAX_DEV_FLOAT_BPS);
        expect(devBuyFloatBps(rBps, max + 1)).toBeGreaterThan(MAX_DEV_FLOAT_BPS);
      }
    }
  });

  it("the default cap is the curve's own maximum, so it never reverts", () => {
    // `create_token` leaves maxBuyBps unset by default and the venue resolves
    // it per curve. Defaulting to the absolute 2000 instead would refuse a
    // `steep` launch over a number the caller never chose.
    for (const rBps of [1500, 2500, 4000, 7000, 10_000]) {
      const chosen = Math.min(MAX_DEV_BUY_BPS, maxDevBuyBpsFor(rBps));
      expect(chosen).toBeGreaterThan(0);
      expect(devBuyFloatBps(rBps, chosen)).toBeLessThanOrEqual(MAX_DEV_FLOAT_BPS);
    }
  });

  it("returns 0 for a degenerate curve rather than dividing by zero", () => {
    expect(devBuyFloatBps(0, 2000)).toBe(0);
    expect(maxDevBuyBpsFor(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the dev-buy window has to outlast the keeper bind
// ---------------------------------------------------------------------------

/**
 * The contract validates the CAP on the pre-open window and says nothing about
 * its LENGTH — a 1-second window is legal and produces a valid launch. It just
 * produces one where the keeper bind outlasts the exclusivity, so the opening
 * buy is public after all, on a launch opening at a moment every watcher can
 * predict. That is the feature failing while every gate reports success.
 *
 * So the floor is ours, it is empirical (28-65s of measured bind latency,
 * median 53s), and it is enforced BEFORE the creation fee is spent. It is soft:
 * the timing is frozen onto the launch, so a caller who wants a short window
 * must be able to have one — deliberately, by name.
 */
describe("dev-buy delay floor", () => {
  function venue(): { resolveLaunchTiming: (d: unknown, c: number, q: number) => Promise<unknown> } {
    const v = new ShroomVenue(
      NETWORKS.mainnet,
      {} as never,
      {} as never,
      null,
    ) as unknown as { curvePresets: () => Promise<CurvePreset[]> } & Record<string, never>;
    // The floor is checked before any chain read; this only matters for the
    // paths that get PAST it.
    v.curvePresets = async () => [{ id: 0, name: "standard", rBps: 4000 } as CurvePreset];
    return v as never;
  }

  const timing = (d: unknown) => venue().resolveLaunchTiming(d, 0, 1);

  it("refuses a window the bind would eat, before anything is spent", async () => {
    // BOOTS launched on 60 and cleared by ~8s. It was one slow bind from
    // having paid the creation fee for an anti-snipe window it did not get.
    await expect(timing({ openDelaySeconds: 60 })).rejects.toMatchObject({
      code: "dev_buy_window_too_short",
    });
  });

  it("names the number to use instead, since the caller has to re-issue", async () => {
    await expect(timing({ openDelaySeconds: 60 })).rejects.toMatchObject({
      hint: expect.stringContaining(String(MIN_SAFE_OPEN_DELAY_SECONDS)),
    });
  });

  it("takes the floor itself", async () => {
    const t = (await timing({ openDelaySeconds: MIN_SAFE_OPEN_DELAY_SECONDS })) as {
      tradingOpensAt: bigint;
      maxBuyBpsInGuardWindow: number;
    };
    expect(t.tradingOpensAt).toBeGreaterThan(0n);
    expect(t.maxBuyBpsInGuardWindow).toBe(MAX_DEV_BUY_BPS);
  });

  it("lets a caller opt out by name, because the value is frozen at creation", async () => {
    // Clamping 60 up to 180 would launch on timing nobody chose. Refusing with
    // no way through would make the package the arbiter of keeper latency.
    const t = (await timing({ openDelaySeconds: 60, allowShortWindow: true })) as {
      tradingOpensAt: bigint;
    };
    expect(t.tradingOpensAt).toBeGreaterThan(0n);
  });

  it("does not apply to an immediate open, which has no window to lose", async () => {
    // Zero is not a short window, it is no window: the first buy is a fair
    // public race and the contract leaves it unconstrained on purpose.
    const t = (await timing({ openDelaySeconds: 0 })) as { tradingOpensAt: bigint };
    expect(t.tradingOpensAt).toBe(0n);
  });

  it("still refuses over the contract's own 24h ceiling", async () => {
    await expect(
      timing({ openDelaySeconds: MAX_OPEN_DELAY_SECONDS + 1, allowShortWindow: true }),
    ).rejects.toMatchObject({ code: "bad_dev_buy" });
  });
});

// ---------------------------------------------------------------------------
// and what it actually did, once the bind and the buy have happened
// ---------------------------------------------------------------------------

describe("create_token reports the window it got", () => {
  const TOKEN = `0x${"c7".repeat(20)}`;

  /** `opensInSeconds` relative to now, as `createLaunch` would have set it. */
  function rt(opensInSeconds: number): Runtime {
    return {
      net: NETWORKS.mainnet,
      policy: { clampSlippageBps: () => 100 },
      // Indexed on the first look, so these tests do not sit through the
      // not-yet-indexed retry that create_token does on a real launch.
      pump: {
        listLaunches: async () => ({
          items: [
            {
              id: asApiLaunchId("247"),
              onchainId: "114",
              token: TOKEN,
              core: "0xd948740da926E8908A08414879490d0D8F96D463",
              quoteAsset: 1,
              state: 1,
              metadataURI: "",
            } as ApiLaunch,
          ],
        }),
      },
      shroom: {
        createLaunch: async () => ({
          onchainId: "114",
          core: "0xd948740da926E8908A08414879490d0D8F96D463",
          token: TOKEN,
          state: "Trading",
          hash: "0xdead",
          status: "confirmed",
          creationFeeInj: "0.11",
          tradingOpensAt: Math.floor(Date.now() / 1000) + opensInSeconds,
          warnings: [],
        }),
        buy: async () => ({ onchainId: "114", side: "buy", status: "confirmed", hash: "0x1" }),
      },
    } as unknown as Runtime;
  }

  const warnings = async (opensInSeconds: number) =>
    (
      (await createToken(rt(opensInSeconds), {
        name: "T",
        symbol: "T",
        initialBuy: "1",
      })) as { warnings: string[] }
    ).warnings.join(" ");

  it("says the window lapsed before the buy landed", async () => {
    expect(await warnings(-1)).toMatch(/competed with everyone else/);
  });

  it("says a near miss was a near miss, and says by how much", async () => {
    // The gap this closes: BOOTS held its window by ~8 seconds and the result
    // was indistinguishable from one that held by ten minutes. The margin is
    // the number that decides the NEXT launch's delay, so it has to be real —
    // matched loosely because it is a wall-clock reading, not a constant.
    const m = /(\d+)s left of the exclusive window/.exec(await warnings(8));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![1])).toBeLessThanOrEqual(8);
  });

  it("stays quiet when the window held comfortably", async () => {
    expect(await warnings(300)).not.toMatch(/exclusive window/);
  });
});
