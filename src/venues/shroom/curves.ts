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

/**
 * Positions of `floatBps` / `lpBps` in `CurveRegistry.shapeOf`'s return tuple
 * `(tokensAtGrad, lpTokens, totalSupply, floatBps, lpBps)`.
 */
export const SHAPE_FLOAT_BPS = 3;
export const SHAPE_LP_BPS = 4;

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
  /**
   * Share of total supply reaching the market through the curve, in bps.
   *
   * Null when the registry's `shapeOf` would not read. Nullable rather than 0
   * on purpose: a zero float is a claim about the launch, and the wrong one —
   * an absent number has to render as absent everywhere it is shown.
   */
  floatBps: number | null;
  /** Share held back to seed the graduation pool, in bps. Null: see `floatBps`. */
  lpBps: number | null;
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

/** Contract-side ceilings on the V-4 dev-buy window. Mirrors LaunchpadCore. */
export const MAX_DEV_BUY_BPS = 2_000;
export const MAX_DEV_FLOAT_BPS = 5_000;
export const MAX_OPEN_DELAY_SECONDS = 24 * 60 * 60;
/** Contract-side ceiling on the holder discount (100% of the creator's cut). */
export const MAX_DISCOUNT_BPS = 10_000;

/**
 * NOT a contract limit — a client-side floor on the dev-buy delay, measured.
 *
 * The exclusive window has to contain the keeper bind AND the opening buy, and
 * the contract has no opinion on whether it does: a window that lapses first
 * still produces a valid launch, it just produces a PUBLIC opening buy on a
 * launch that opens at a moment every watcher can predict. That is the whole
 * thing the delay was asked for, lost silently.
 *
 * Measured create -> first-trade over the 8 mainnet launches before BOOTS:
 * 28s to 65s, median 53s. BOOTS itself ran 52.2s against a 60s window and
 * cleared it by ~8s. 180s is roughly 3x the observed worst case, which leaves
 * room for a slow bind without making the launch feel held back.
 *
 * Keeper latency is an operational fact, not a protocol one, so this is a soft
 * floor: `allowShortDevBuyWindow` opts out of it deliberately. Do not clamp to
 * it — the value is frozen onto the launch, and silently launching with timing
 * the caller did not choose is worse than refusing.
 */
export const MIN_SAFE_OPEN_DELAY_SECONDS = 180;

/**
 * Below this much daylight between the opening buy landing and public trading,
 * say so. The window was not lost, but it was closer than the caller can see
 * from a successful result, and the next launch should get a longer delay.
 */
export const THIN_DEV_BUY_MARGIN_SECONDS = 30;

/**
 * What share of the launch's float a dev buy of `maxBuyBps` would take, in bps.
 *
 * Mirrors `_validateDevBuy`. The contract prices the cap against the curve:
 * `cap = target·m`, `devTokens = cap·vt/(vp+cap)`, `tokensAtGrad =
 * vt·target/(vp+target)`, and with `vp = target·r` both the target and the
 * virtual token reserve cancel out of the ratio:
 *
 *     floatBps = 1e4 · m(1+r) / (r+m)
 *
 * So it depends only on the curve's steepness and the cap — not on the quote
 * asset, and not on the size of the raise. Which is why the answer differs per
 * preset: 2000 bps takes 46.67% of the float on the standard curve and 65.71%
 * on `steep`, and the second one reverts.
 */
export function devBuyFloatBps(rBps: number, maxBuyBps: number): number {
  if (rBps <= 0 || maxBuyBps <= 0) return 0;
  const r = rBps / 10_000;
  const m = maxBuyBps / 10_000;
  return Math.round((10_000 * m * (1 + r)) / (r + m));
}

/**
 * The largest `maxBuyBpsInGuardWindow` this curve will accept.
 *
 * Invert the above at the ceiling: `1e4·m(1+r)/(r+m) <= MAX_DEV_FLOAT_BPS`
 * solves to `m <= r/(1+2r)` at a 50% ceiling, then the absolute
 * `MAX_DEV_BUY_BPS` applies on top. Steeper curves reach the float ceiling
 * first — `steep` tops out at 1154 bps where every other preset gets the full
 * 2000 — so a caller that just used the maximum would eat a revert on one
 * preset out of seven, after paying for it.
 */
export function maxDevBuyBpsFor(rBps: number): number {
  if (rBps <= 0) return 0;
  const r = rBps / 10_000;
  const ceiling = MAX_DEV_FLOAT_BPS / 10_000;
  // m(1+r)/(r+m) <= ceiling  =>  m <= ceiling·r / (1 + r − ceiling)
  let m = Math.min(MAX_DEV_BUY_BPS, Math.floor(((ceiling * r) / (1 + r - ceiling)) * 10_000));
  // The closed form is exact in reals; `devBuyFloatBps` rounds. Walk the last
  // bps or two so this agrees EXACTLY with the check that will refuse the
  // launch — a hint that suggests 1153 where 1154 is also legal is a hint that
  // quietly costs the creator part of their window.
  while (m < MAX_DEV_BUY_BPS && devBuyFloatBps(rBps, m + 1) <= MAX_DEV_FLOAT_BPS) m += 1;
  while (m > 0 && devBuyFloatBps(rBps, m) > MAX_DEV_FLOAT_BPS) m -= 1;
  return m;
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
