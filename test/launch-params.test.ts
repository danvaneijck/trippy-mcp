import { describe, expect, it } from "vitest";

import {
  devBuyFloatBps,
  MAX_DEV_BUY_BPS,
  MAX_DEV_FLOAT_BPS,
  maxDevBuyBpsFor,
} from "../src/venues/shroom/curves.js";

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
