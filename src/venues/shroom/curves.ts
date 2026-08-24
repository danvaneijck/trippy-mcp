/**
 * The curated curve menu — v2's `CurveRegistry`.
 *
 * On v1 the bonding curve was a property of the QUOTE ASSET: every launch
 * quoted in SAI shared one shape and a creator had nothing to choose. v2 moves
 * the shape onto the LAUNCH, picked at `createLaunch` from a curated,
 * append-only registry — so two launches on the same quote can differ
 * completely, and "the curve for this quote" stops being a thing that exists.
 *
 * Pure types and arithmetic live here; the chain reads are on `ShroomVenue`.
 */

/** One entry of the menu, as an agent sees it. */
export interface CurvePreset {
  /**
   * Index in the registry IS the curveId, and it is what `create_token` takes.
   * Append-only and never reordered: a preset is disabled, never mutated, or
   * every historical render starts lying about what a launch was created on.
   */
  id: number;
  name: string;
  /**
   * Steepness. `virtualPair = graduationPairTarget * rBps / 1e4`, so a SMALLER
   * r is a steeper curve — less virtual liquidity to push through.
   */
  rBps: number;
  /**
   * Scales the quote's base raise: 10000 = the quote's own target, 40000 is a
   * 4x raise, 2000 a fifth. The one field that changes HOW MUCH is raised;
   * everything else changes only the shape of getting there.
   */
  targetMulBps: number;
  /** Bit `q` set => legal on quote slot `q`. See `presetAllowedOnQuote`. */
  quoteMask: number;
  enabled: boolean;
  /** Share of total supply reaching the market through the curve, in bps. */
  floatBps: number;
  /** Share held back to seed the graduation pool, in bps. */
  lpBps: number;
  /** Virtual token reserve, whole tokens (launch tokens are 18-decimal). */
  virtualToken: number;
}

/**
 * How many times the spot price multiplies from launch to graduation.
 *
 * On an xy=k curve with virtual reserves, end/start spot is
 * `(1 + T/virtualPair)^2`, and the registry defines `virtualPair = T·rBps/1e4`
 * — so the target cancels and the run is a pure function of `rBps`:
 *
 *     priceRun = (1 + 1e4/rBps)^2
 *
 * Quote-invariant, exactly like float and LP. (r=0.4 -> 12.25x, r=1.0 -> 4x,
 * r=0.15 -> 58.8x.)
 */
export function priceRunX(rBps: number): number {
  if (rBps <= 0) return 0;
  const ratio = 1 + 10_000 / rBps;
  return ratio * ratio;
}

/**
 * Whether a preset may be used on a quote slot. Mirrors
 * `CurveRegistry.isAllowed` so a bad pick is refused here, with the menu in the
 * error, rather than as an opaque `createLaunch` revert after the gas is spent.
 * A 4x raise is unsourceable through a thin SAI pool, which is what the mask is
 * for. Slots >= 32 are unreachable by construction (the mask is a uint32).
 */
export function presetAllowedOnQuote(p: CurvePreset, quoteSlot: number): boolean {
  if (!p.enabled || quoteSlot < 0 || quoteSlot > 31) return false;
  // `1 << 31` is negative under JS's signed 32-bit bitwise ops — go unsigned.
  return ((p.quoteMask >>> quoteSlot) & 1) === 1;
}

/**
 * This preset's raise on a quote, in the quote's human units — the quote's own
 * base target scaled by `targetMulBps`. Exact: bps arithmetic, no rounding.
 */
export function raiseOfPreset(p: CurvePreset, quoteBaseTarget: number): number {
  return (quoteBaseTarget * p.targetMulBps) / 10_000;
}

/**
 * Graduation market cap of a launch on this preset, in units of
 * `quoteBaseTarget`.
 *
 * Closed form rather than a chain read. `FDV = S·(vp+g)²/(vt·vp)` with
 * `vp = g·r` collapses to `FDV = S·g·(1+r)²/(vt·r)` — every term is on the
 * preset, so one menu read prices every (quote x preset) combination. The
 * registry floors `vp` when it resolves, which moves the true figure by the
 * last ulp of a ~1e21 base-unit reserve; a launch's exact numbers come off its
 * own snapshot via `token_info`.
 */
export function graduationFdvOfPreset(
  p: CurvePreset,
  quoteBaseTarget: number,
  totalSupply: number,
): number {
  const r = p.rBps / 10_000;
  if (r <= 0 || p.virtualToken <= 0) return 0;
  return (totalSupply * raiseOfPreset(p, quoteBaseTarget) * (1 + r) ** 2) / (p.virtualToken * r);
}

/**
 * Resolve what an agent asked for — a curveId, or a preset NAME — to a curveId.
 *
 * Names are accepted because they are what a model reasons with ("launch it on
 * the whale curve"), while the contract takes an index. Matching is exact and
 * case-insensitive; there is deliberately no fuzzy match, because the presets
 * differ in ways ("steep" vs "gentle") where a near-miss would silently pick
 * the opposite of what was asked for.
 *
 * Returns a `{ error }` rather than throwing so the caller can attach the menu.
 */
export function resolveCurveChoice(
  presets: readonly CurvePreset[],
  choice: string | number,
  quoteSlot: number,
): { curveId: number; preset: CurvePreset } | { error: string } {
  const raw = typeof choice === "number" ? String(choice) : choice.trim();
  let found: CurvePreset | undefined;

  if (/^\d+$/.test(raw)) {
    found = presets.find((p) => p.id === Number(raw));
    if (!found) return { error: `no curve with id ${raw}` };
  } else {
    const want = raw.toLowerCase();
    found = presets.find((p) => p.name.toLowerCase() === want);
    if (!found) return { error: `no curve named "${raw}"` };
  }

  if (!found.enabled) {
    return { error: `curve "${found.name}" (id ${found.id}) is retired and cannot be used` };
  }
  if (!presetAllowedOnQuote(found, quoteSlot)) {
    return {
      error: `curve "${found.name}" (id ${found.id}) is not available on this quote asset — its raise is not sourceable there`,
    };
  }
  return { curveId: found.id, preset: found };
}
