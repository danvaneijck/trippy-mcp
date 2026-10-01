import { describe, expect, it } from "vitest";

import {
  DEFAULT_CURVE_NAME,
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

/**
 * A menu swap: the registry is append-only, so correcting presets means
 * appending replacements that REUSE the old names and disabling the originals,
 * atomically. Afterwards `getPresets()` holds every name twice, and the old,
 * disabled entry comes FIRST. These are the mainnet shapes (CurveRegistry
 * 0xA92c…): ids 0-6 before, 7-12 appended, `high-float` not re-registered.
 */
describe("resolving names across a menu swap", () => {
  const ALL = 0xffff_ffff;
  const INJ_USDC = 0b110; // slots 1 (INJ) and 2 (USDC)
  const INJ = 1;
  const USDC = 2;
  const SAI = 3;

  const BEFORE: CurvePreset[] = [
    preset({ id: 0, name: "standard", quoteMask: ALL }),
    preset({ id: 1, name: "gentle", rBps: 10_000, quoteMask: ALL }),
    preset({ id: 2, name: "steep", rBps: 1500, quoteMask: ALL }),
    preset({ id: 3, name: "deep-lp", quoteMask: ALL }),
    preset({ id: 4, name: "high-float", quoteMask: ALL }),
    preset({ id: 5, name: "whale", targetMulBps: 40_000, quoteMask: INJ_USDC }),
    preset({ id: 6, name: "micro", targetMulBps: 2000, quoteMask: ALL }),
  ];
  const AFTER: CurvePreset[] = [
    ...BEFORE.map((p) => ({ ...p, enabled: false })),
    preset({ id: 7, name: "standard", quoteMask: ALL, floatBps: 7780, lpBps: 2220 }),
    preset({ id: 8, name: "gentle", rBps: 10_000, quoteMask: ALL, floatBps: 6670, lpBps: 3330 }),
    preset({ id: 9, name: "steep", rBps: 1500, quoteMask: ALL, floatBps: 8850, lpBps: 1150 }),
    preset({ id: 10, name: "deep-lp", rBps: 20_000, quoteMask: ALL, floatBps: 6000, lpBps: 4000 }),
    preset({ id: 11, name: "whale", targetMulBps: 40_000, quoteMask: INJ_USDC, floatBps: 7780, lpBps: 2220 }),
    preset({ id: 12, name: "micro", targetMulBps: 2000, quoteMask: ALL, floatBps: 7780, lpBps: 2220 }),
  ];

  it("a name used twice resolves to the enabled replacement, not the first match", () => {
    // The bug: `find` hit the disabled id-0 `standard` first and refused the
    // request as "retired" while a live `standard` sat at id 7.
    expect(resolveCurveChoice(AFTER, "standard", INJ)).toMatchObject({ curveId: 7 });
    expect(resolveCurveChoice(AFTER, "Standard", USDC)).toMatchObject({ curveId: 7 });
    expect(resolveCurveChoice(AFTER, "steep", SAI)).toMatchObject({ curveId: 9 });
    expect(resolveCurveChoice(AFTER, "whale", INJ)).toMatchObject({ curveId: 11 });
    expect(resolveCurveChoice(AFTER, "micro", SAI)).toMatchObject({ curveId: 12 });
  });

  it("returns the replacement's own preset, so its shape is what gets reported", () => {
    const r = resolveCurveChoice(AFTER, "standard", INJ) as { preset: CurvePreset };
    expect(r.preset.enabled).toBe(true);
    expect(r.preset.floatBps).toBe(7780);
  });

  it("among several usable same-named presets the newest id wins", () => {
    // Not reachable through an atomic swap, but it is what "the newest
    // registration is the live one" means when two are enabled at once.
    const both = [...BEFORE, preset({ id: 7, name: "standard", quoteMask: ALL })];
    expect(resolveCurveChoice(both, "standard", INJ)).toMatchObject({ curveId: 7 });
  });

  it("prefers an older usable preset over a newer one masked off this quote", () => {
    const menu = [
      preset({ id: 5, name: "whale", quoteMask: ALL }),
      preset({ id: 11, name: "whale", quoteMask: INJ_USDC }),
    ];
    expect(resolveCurveChoice(menu, "whale", SAI)).toMatchObject({ curveId: 5 });
    expect(resolveCurveChoice(menu, "whale", INJ)).toMatchObject({ curveId: 11 });
  });

  it("a name whose only entries are disabled is still refused as retired", () => {
    // `high-float` was not re-registered: id 4 is all there is.
    const r = resolveCurveChoice(AFTER, "high-float", INJ);
    expect((r as { error: string }).error).toBe(
      'curve "high-float" (id 4) is retired and cannot be used',
    );
  });

  it("an enabled replacement masked off the quote gets the quote-mask error, not 'retired'", () => {
    // whale is INJ|USDC only. On SAI the retired id 5 and the live id 11 both
    // fail, and the useful reason is the mask on the live one.
    const r = resolveCurveChoice(AFTER, "whale", SAI) as { error: string };
    expect(r.error).toContain("not available on this quote asset");
    expect(r.error).toContain("(id 11)");
    expect(r.error).not.toContain("retired");
  });

  it("a numeric id is still taken literally, retired or not", () => {
    // An agent that passed an id meant that id. Silently moving it to the
    // replacement would launch on parameters it never read.
    expect((resolveCurveChoice(AFTER, "0", INJ) as { error: string }).error).toContain("retired");
    expect((resolveCurveChoice(AFTER, 0, INJ) as { error: string }).error).toContain("(id 0)");
    expect(resolveCurveChoice(AFTER, 7, INJ)).toMatchObject({ curveId: 7 });
    expect(resolveCurveChoice(BEFORE, "0", INJ)).toMatchObject({ curveId: 0 });
  });

  it("the default resolves to the live standard in both registry states", () => {
    expect(DEFAULT_CURVE_NAME).toBe("standard");
    for (const slot of [INJ, USDC, SAI]) {
      expect(resolveCurveChoice(BEFORE, DEFAULT_CURVE_NAME, slot)).toMatchObject({ curveId: 0 });
      expect(resolveCurveChoice(AFTER, DEFAULT_CURVE_NAME, slot)).toMatchObject({ curveId: 7 });
    }
  });
});
