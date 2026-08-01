import { describe, expect, it } from "vitest";

import type { ApiCandle } from "../src/api/pump.js";
import { portfolioTotals, shapeChoiceCandles, shapeCurveCandles, type PortfolioRow } from "../src/mcp/tools.js";

function candle(over: Partial<ApiCandle>): ApiCandle {
  return {
    t: 1_700_000_000,
    o: "1000000000000000000",
    h: "2000000000000000000",
    l: "500000000000000000",
    c: "1500000000000000000",
    v: "0",
    n: 1,
    rateUsd: null,
    ...over,
  };
}

describe("shapeCurveCandles", () => {
  it("converts wad prices for an 18-decimal quote (INJ)", () => {
    const [row] = shapeCurveCandles([candle({ v: "2500000000000000000" })], 18);
    expect(row!.o).toBe(1);
    expect(row!.h).toBe(2);
    expect(row!.l).toBe(0.5);
    expect(row!.c).toBe(1.5);
    expect(row!.v).toBe(2.5);
    expect(row!.rateUsd).toBeNull();
    expect(row!.cUsd).toBeUndefined();
  });

  it("rescales by the decimal gap for a 6-decimal quote (USDC)", () => {
    // spot_price_wad is the RAW base-unit ratio × 1e18: for a 6-decimal quote
    // the human price needs the 10^(18-6) correction (mirrors the FE's
    // spotPriceHuman) — wad 3e6 → 3 USDC per token.
    const [row] = shapeCurveCandles([candle({ o: "3000000", h: "3000000", l: "3000000", c: "3000000", v: "1500000" })], 6);
    expect(row!.c).toBeCloseTo(3);
    expect(row!.v).toBeCloseTo(1.5);
  });

  it("adds USD fields only when the bucket carries a usable rate", () => {
    const rows = shapeCurveCandles(
      [candle({ rateUsd: "2.5", v: "1000000000000000000" }), candle({ rateUsd: "0" })],
      18,
    );
    expect(rows[0]!.cUsd).toBeCloseTo(1.5 * 2.5);
    expect(rows[0]!.vUsd).toBeCloseTo(2.5);
    expect(rows[1]!.rateUsd).toBeNull();
    expect(rows[1]!.cUsd).toBeUndefined();
  });
});

describe("shapeChoiceCandles", () => {
  it("normalizes compact arrays and drops malformed rows", () => {
    const rows = shapeChoiceCandles([
      [1_700_000_000, "1.1", 2, "0.9", "1.5", "100"],
      ["not-a-ts", 1, 2, 3, 4, 5],
      [1, 2], // too short
      "junk",
      null,
    ]);
    expect(rows).toEqual([{ t: 1_700_000_000, o: 1.1, h: 2, l: 0.9, c: 1.5, v: 100 }]);
  });

  it("returns [] for a non-array payload", () => {
    expect(shapeChoiceCandles(undefined)).toEqual([]);
    expect(shapeChoiceCandles({ candles: [] })).toEqual([]);
  });
});

describe("portfolioTotals", () => {
  it("sums priced holdings and counts unpriced ones", () => {
    const row = (valueUsd: number | null): PortfolioRow => ({
      denom: "x",
      symbol: null,
      amount: 1,
      priceUsd: null,
      valueUsd,
      pricedVia: valueUsd === null ? "unpriced" : "choice",
    });
    expect(portfolioTotals([row(10), row(null), row(5.5)])).toEqual({ totalUsd: 15.5, unpriced: 1 });
    expect(portfolioTotals([])).toEqual({ totalUsd: 0, unpriced: 0 });
  });
});
