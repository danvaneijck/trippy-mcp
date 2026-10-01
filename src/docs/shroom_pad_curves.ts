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
 * redeploy, so a hard-coded list would go stale silently and an agent choosing
 * off it would pass a curveId that no longer means what it read.
 *
 * Retired presets are listed apart from the live menu, by name and id only. A
 * preset is corrected by retiring it and re-registering its NAME at a new id,
 * so after a menu swap the raw registry holds every name twice; rendering both
 * as full blocks reads like two "standard" curves to choose between.
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

/**
 * A bps share as a percentage, or an honest gap.
 *
 * "unavailable" and not "0.00%": float is the number a creator picks a preset
 * ON, and a fabricated zero reads as a fact about the curve rather than as a
 * failed read of the registry.
 */
function pct(bps: number | null): string {
  return bps === null ? "unavailable (registry read failed)" : `${(bps / 100).toFixed(2)}%`;
}

/** Total supply of every launch token — fixed by the launchpad, not the curve. */
const TOTAL_SUPPLY = 1_000_000_000;

function presetBlock(c: CurvePreset, p: LiveParams): string {
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

  return `### ${c.name}  —  curveId ${c.id}

  float                 ${pct(c.floatBps)} of supply reaches the market through the curve
  pool liquidity        ${pct(c.lpBps)} of supply is locked to seed the graduated pool
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

  const live = p.curves.filter((c) => c.enabled);
  const retired = p.curves.filter((c) => !c.enabled);
  const menu =
    p.curves.length === 0
      ? UNKNOWN
      : live.length > 0
        ? live.map((c) => presetBlock(c, p)).join("\n\n")
        : "Every preset on the registry is retired right now, so `create_token` has no curve to launch on.";
  const retiredSection =
    retired.length === 0
      ? ""
      : `

## Retired presets

Launches already created on these keep them forever (\`token_info\` reports a
launch's own curve); new launches cannot use them. A name listed here AND in
the menu above was replaced: the menu entry is the live one, and that is what
the name resolves to.

${retired.map((c) => `- ${c.name}  —  curveId ${c.id}`).join("\n")}`;

  return `# Choosing a bonding curve

A launch's curve is picked at createLaunch from a curated on-chain menu and is
frozen onto the launch forever. It is the SHAPE of the raise: how much of the
supply is sold through the curve versus locked as graduation liquidity, and how
far the price travels on the way. It does not change what the launch raises in
(that is the quote asset) or what it charges (that is the fee config).

Pass \`curve\` to \`create_token\` — either the name or the curveId below.
A name resolves to its live entry on the menu. Omitting \`curve\` uses the
\`standard\` preset, looked up the same way, by name: do not assume it has a
fixed curveId.

## The menu

${menu}${retiredSection}

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
2. **Names are stable, curveIds are not.** Because nothing is edited in place,
   correcting a preset means retiring it and registering the fix under the
   SAME name at a new curveId. A name always resolves to the live entry, and
   so does the default (\`standard\`); a curveId is taken literally, and a
   retired one is refused. Prefer names unless you read the id off this menu.
3. **Presets are masked per quote asset.** A multiplied raise is not
   sourceable through a thin pool, so it is simply not on the menu for those
   quotes. The
   "available on" line above is the authority; \`create_token\` refuses an
   illegal pairing rather than letting it revert on chain.

${SNAPSHOT_NOTE}`;
}
