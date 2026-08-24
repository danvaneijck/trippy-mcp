import { describe, expect, it } from "vitest";

import {
  graduationFdvOfPreset,
  presetAllowedOnQuote,
  priceRunX,
  raiseOfPreset,
  resolveCurveChoice,
  type CurvePreset,
} from "../src/venues/shroom/curves.js";

/**
 * The curve menu's arithmetic and its refusal rules.
 *
 * The refusals matter as much as the maths: a curve is FROZEN onto a launch at
 * creation, so a pick that should have been rejected is not recoverable, and
 * letting `createLaunch` revert instead costs gas and says nothing actionable.
 */

const preset = (over: Partial<CurvePreset> = {}): CurvePreset => ({
  id: 0,
  name: "standard",
  rBps: 4000,
  targetMulBps: 10_000,
  quoteMask: 0xff,
  enabled: true,
  floatBps: 7660,
  lpBps: 2340,
  virtualToken: 1_073_000_000,
  ...over,
});

const MENU: CurvePreset[] = [
  preset(),
  preset({ id: 1, name: "gentle", rBps: 10_000, floatBps: 7000, lpBps: 3000 }),
  preset({ id: 2, name: "steep", rBps: 1500, floatBps: 8500, lpBps: 1500 }),
  // `whale` raises 4x, which is unsourceable through a thin pool — masked to
  // slot 1 (INJ) only.
  preset({ id: 3, name: "whale", targetMulBps: 40_000, quoteMask: 0b10 }),
  preset({ id: 4, name: "retired", enabled: false }),
];

describe("price run", () => {
  // The registry's own documented figures. r is the ONLY input: the raise
  // cancels out of (1 + T/vp)^2 because vp = T*r.
  it("is a pure function of steepness, not of the raise", () => {
    expect(priceRunX(4000)).toBeCloseTo(12.25, 2); // standard
    expect(priceRunX(10_000)).toBeCloseTo(4, 2); // gentle
    expect(priceRunX(1500)).toBeCloseTo(58.78, 2); // steep
  });

  it("is unchanged by the raise multiplier", () => {
    const small = preset({ targetMulBps: 2000 });
    const big = preset({ targetMulBps: 40_000 });
    expect(priceRunX(small.rBps)).toBe(priceRunX(big.rBps));
  });

  it("returns 0 rather than Infinity on a degenerate r", () => {
    expect(priceRunX(0)).toBe(0);
    expect(priceRunX(-1)).toBe(0);
  });
});

describe("raise and graduation cap", () => {
  it("scales the quote's base target by targetMulBps", () => {
    expect(raiseOfPreset(preset(), 2500)).toBe(2500);
    expect(raiseOfPreset(preset({ targetMulBps: 40_000 }), 2500)).toBe(10_000);
    expect(raiseOfPreset(preset({ targetMulBps: 2000 }), 2500)).toBe(500);
  });

  it("matches the direct xy=k formula it is derived from", () => {
    // FDV = S*(vp+g)^2/(vt*vp) with vp = g*r, which the closed form collapses.
    // Asserting against the long form is what pins the algebra.
    const p = preset();
    const base = 2500;
    const g = raiseOfPreset(p, base);
    const vp = g * (p.rBps / 10_000);
    const direct = (1e9 * (vp + g) ** 2) / (p.virtualToken * vp);
    expect(graduationFdvOfPreset(p, base, 1e9)).toBeCloseTo(direct, 6);
  });

  it("a 4x raise graduates 4x higher, all else equal", () => {
    const one = graduationFdvOfPreset(preset(), 2500, 1e9);
    const four = graduationFdvOfPreset(preset({ targetMulBps: 40_000 }), 2500, 1e9);
    expect(four / one).toBeCloseTo(4, 6);
  });
});

describe("quote masking", () => {
  it("reads the mask bit for the slot, not the slot number", () => {
    const whale = MENU[3]!;
    expect(presetAllowedOnQuote(whale, 1)).toBe(true); // INJ
    expect(presetAllowedOnQuote(whale, 3)).toBe(false); // SAI
    expect(presetAllowedOnQuote(whale, 0)).toBe(false);
  });

  it("a retired preset is allowed nowhere", () => {
    expect(presetAllowedOnQuote(MENU[4]!, 1)).toBe(false);
  });

  it("slot 31 is the last reachable bit and is read unsigned", () => {
    // `1 << 31` is NEGATIVE under JS's signed bitwise ops, so a signed shift
    // would answer false for the one slot the uint32 mask can still address.
    const top = preset({ quoteMask: 0x8000_0000 });
    expect(presetAllowedOnQuote(top, 31)).toBe(true);
    expect(presetAllowedOnQuote(top, 30)).toBe(false);
    expect(presetAllowedOnQuote(preset({ quoteMask: 0xff }), 32)).toBe(false);
  });
});

describe("resolving what an agent asked for", () => {
  it("takes a name, case-insensitively", () => {
    expect(resolveCurveChoice(MENU, "steep", 1)).toMatchObject({ curveId: 2 });
    expect(resolveCurveChoice(MENU, "STEEP", 1)).toMatchObject({ curveId: 2 });
    expect(resolveCurveChoice(MENU, "  gentle  ", 1)).toMatchObject({ curveId: 1 });
  });

  it("takes a numeric id, as a string or a number", () => {
    expect(resolveCurveChoice(MENU, "2", 1)).toMatchObject({ curveId: 2 });
    expect(resolveCurveChoice(MENU, 2, 1)).toMatchObject({ curveId: 2 });
  });

  it("never fuzzy-matches — 'steep' and 'gentle' are opposites", () => {
    // A near-miss here silently picks the OPPOSITE curve and freezes it onto
    // the launch, so an unknown name must be an error, not a best guess.
    expect(resolveCurveChoice(MENU, "steepish", 1)).toEqual({
      error: 'no curve named "steepish"',
    });
    expect(resolveCurveChoice(MENU, "99", 1)).toEqual({ error: "no curve with id 99" });
  });

  it("refuses a preset the quote asset does not allow, and says why", () => {
    const r = resolveCurveChoice(MENU, "whale", 3);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toContain("not available on this quote asset");
  });

  it("refuses a retired preset rather than launching on it", () => {
    const r = resolveCurveChoice(MENU, "retired", 1);
    expect((r as { error: string }).error).toContain("retired");
  });

  it("id 0 is a real answer, not a falsy one", () => {
    // `standard` is curveId 0. Any truthiness check on the resolved id would
    // drop it, and the caller would silently fall through to a default.
    const r = resolveCurveChoice(MENU, "standard", 1);
    expect(r).toMatchObject({ curveId: 0 });
    expect((r as { curveId: number }).curveId).toBe(0);
  });
});
