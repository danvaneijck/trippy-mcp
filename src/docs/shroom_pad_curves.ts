/**
 * Topic: choosing a bonding curve for a launch.
 *
 * Only meaningful on a deployment with a `CurveRegistry` — on v1 the curve was
 * a property of the quote asset and a creator had nothing to choose, which is
 * why `index.ts` keeps this topic out of the index there rather than rendering
 * an explanation of a menu that does not exist.
 *
 * Every number here is read from the registry at call time, presets included:
 * the menu is append-only and the owner can register a new preset without a
 * redeploy, so a hard-coded list of seven would go stale silently and an agent
 * choosing off it would pass a curveId that no longer means what it read.
 */

import {
  graduationFdvOfPreset,
  presetAllowedOnQuote,
  priceRunX,
  raiseOfPreset,
  type CurvePreset,
} from "../venues/shroom/curves.js";
import { SNAPSHOT_NOTE, UNKNOWN, type LiveParams } from "./params.js";

export const id = "shroom_pad_curves";
export const title = "SHROOM Pad: choosing a bonding curve";
export const summary =
  "The curve menu a launch can be created on — what float, pool liquidity and price run actually mean, and which presets each quote asset allows.";

export const sources = [
  "CurveRegistry.getPresets() (live read)",
  "CurveRegistry.shapeOf(curveId) (live read)",
  "LaunchpadCore.getQuoteAssetConfig(slot) for the base raise each preset scales (live read)",
];

/** Total supply of every launch token — fixed by the launchpad, not the curve. */
const TOTAL_SUPPLY = 1_000_000_000;

function presetBlock(c: CurvePreset, p: LiveParams): string {
  const flag = c.enabled ? "" : "  [RETIRED — existing launches keep it, new ones cannot use it]";
  const mul = c.targetMulBps / 10_000;
  const quotes = p.quotes
    .filter((q) => q.enabled && presetAllowedOnQuote(c, q.slot))
    .map((q) => {
      const base = Number(q.graduationPairTarget);
      if (!Number.isFinite(base) || base <= 0) return q.symbol;
      const raise = raiseOfPreset(c, base);
      const fdv = graduationFdvOfPreset(c, base, TOTAL_SUPPLY);
      return `${q.symbol} (raises ${round(raise)} ${q.symbol}, graduates at ~${round(fdv)} ${q.symbol} market cap)`;
    });

  return `### ${c.name}  —  curveId ${c.id}${flag}

  float                 ${(c.floatBps / 100).toFixed(2)}% of supply reaches the market through the curve
  pool liquidity        ${(c.lpBps / 100).toFixed(2)}% of supply is locked to seed the graduated pool
  price run             ${priceRunX(c.rBps).toFixed(1)}x from the first buy to graduation
  raise multiplier      ${mul}x the quote's base target${mul === 1 ? " (the standard raise)" : ""}
  available on          ${quotes.length > 0 ? quotes.join(", ") : "no enabled quote asset"}`;
}

/** Enough precision to compare, not so much that it reads as a promise. */
function round(v: number): string {
  if (!Number.isFinite(v)) return "?";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(2);
}

export function render(p: LiveParams): string {
  if (!p.curves) {
    return `# Choosing a bonding curve

This deployment does not offer a curve menu. Every launch on a given quote
asset uses that quote's one fixed curve, so there is nothing to choose and
\`create_token\` takes no curve argument here. See topic
\`shroom_pad_quotes\` for what each quote asset does change.`;
  }

  const menu = p.curves.length > 0 ? p.curves.map((c) => presetBlock(c, p)).join("\n\n") : UNKNOWN;

  return `# Choosing a bonding curve

A launch's curve is picked at createLaunch from a curated on-chain menu and is
frozen onto the launch forever. It is the SHAPE of the raise: how much of the
supply is sold through the curve versus locked as graduation liquidity, and how
far the price travels on the way. It does not change what the launch raises in
(that is the quote asset) or what it charges (that is the fee config).

Pass \`curve\` to \`create_token\` — either the name or the curveId below.
Omitting it uses curveId 0, which reproduces the pre-registry curve exactly.

## The menu

${menu}

## What the three numbers mean

**float** is the share of the 1,000,000,000 supply that reaches the market
through the curve. Everything not floated is locked into the graduation pool.
A high float means more of the supply is in holders' hands at graduation; a low
float means a deeper pool behind a thinner circulating supply.

**pool liquidity** is the rest — the tokens the launch keeps back to seed its
Choice CLMM pool, paired with the raise. It is locked; it is what the token
trades against after graduation. There is a hard floor on it, enforced by the
registry, so no preset can graduate into a pool too thin to trade.

**price run** is how many times the spot price multiplies between the first buy
and graduation. It follows from the steepness alone, and is the same on every
quote asset.

## The thing that is counter-intuitive

**A steeper curve is not an easier pump.** After graduation, what it costs to
move the price by a given multiple depends on the size of the pool — and the
pool's quote side IS the raise. Two launches that raise the same amount cost
the same to move afterwards, whatever shape they took to get there. Only the
raise multiplier changes that, and it changes it in the obvious direction: a
bigger raise is a deeper pool and a harder price to move.

## Rules the registry enforces

1. **Presets are append-only and never edited.** A preset is retired by being
   disabled, not changed — otherwise every launch created under the old
   parameters would start being described by the new ones.
2. **curveId 0 is the standard curve** and reproduces exactly what launches got
   before the registry existed. Omitting a choice is therefore never a surprise.
3. **Presets are masked per quote asset.** A 4x raise is not sourceable through
   a thin pool, so it is simply not on the menu for those quotes. The
   "available on" line above is the authority; \`create_token\` refuses an
   illegal pairing rather than letting it revert on chain.

${SNAPSHOT_NOTE}`;
}
