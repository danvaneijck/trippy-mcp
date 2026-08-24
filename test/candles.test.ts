import { describe, expect, it } from "vitest";

import type { ApiCandle } from "../src/api/pump.js";
import {
  CHOICE_CANDLE_COLUMNS,
  CURVE_CANDLE_COLUMNS,
  portfolioTotals,
  shapeChoiceCandles,
  shapeCurveCandles,
  type PortfolioRow,
} from "../src/mcp/tools.js";

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

/** Rows go out as CSV under a `columns` header — read one back as an object. */
function cells(row: string, columns: string[]): Record<string, string> {
  const parts = row.split(",");
  return Object.fromEntries(columns.map((c, i) => [c, parts[i] ?? ""]));
}

describe("shapeCurveCandles", () => {
  it("converts wad prices for an 18-decimal quote (INJ)", () => {
    const [row] = shapeCurveCandles([candle({ v: "2500000000000000000" })], 18);
    const c = cells(row!, CURVE_CANDLE_COLUMNS);
    expect(c.t).toBe("1700000000");
    expect(c.o).toBe("1");
    expect(c.h).toBe("2");
    expect(c.l).toBe("0.5");
    expect(c.c).toBe("1.5");
    expect(c.v).toBe("2.5");
    expect(c.rateUsd).toBe("");
    expect(c.cUsd).toBe("");
  });

  it("does NOT rescale price for a 6-decimal quote (USDC), but does rescale volume", () => {
    // spot_price_wad is stored NORMALISED — display-quote per display-token
    // x1e18 — so the price is wad/1e18 on every quote, with no decimal gap
    // applied here. This test used to assert the opposite, which is what let
    // every USDC launch read 1e12 too high.
    //
    // Real values from mainnet launch 234 (INJEGG/USDC): the API serves
    // 4136178109927, and the reserves say the price is 4.136178109927e-6 USDC
    // per token. Volume IS raw base units, so it still takes the 1e6 divide.
    const wad = "4136178109927";
    const [row] = shapeCurveCandles([candle({ o: wad, h: wad, l: wad, c: wad, v: "1500000" })], 6);
    const c = cells(row!, CURVE_CANDLE_COLUMNS);
    // Relative, not absolute: the CSV formatter rounds to significant figures,
    // and an absolute tolerance at this magnitude would pass for 0 too.
    const expected = 4.136178109927e-6;
    expect(Math.abs(Number(c.c) - expected) / expected).toBeLessThan(1e-6);
    expect(Number(c.v)).toBeCloseTo(1.5);
  });

  it("treats an 18-decimal quote identically — the gap correction is gone for good", () => {
    const wad = "3000000000000000000"; // 3e18 -> 3.0
    const [row] = shapeCurveCandles([candle({ o: wad, h: wad, l: wad, c: wad, v: "1000000000000000000" })], 18);
    const c = cells(row!, CURVE_CANDLE_COLUMNS);
    expect(Number(c.c)).toBeCloseTo(3);
    expect(Number(c.v)).toBeCloseTo(1);
  });

  it("adds USD fields only when the bucket carries a usable rate", () => {
    const rows = shapeCurveCandles(
      [candle({ rateUsd: "2.5", v: "1000000000000000000" }), candle({ rateUsd: "0" })],
      18,
    );
    const priced = cells(rows[0]!, CURVE_CANDLE_COLUMNS);
    const unpriced = cells(rows[1]!, CURVE_CANDLE_COLUMNS);
    expect(Number(priced.cUsd)).toBeCloseTo(1.5 * 2.5);
    expect(Number(priced.vUsd)).toBeCloseTo(2.5);
    expect(unpriced.rateUsd).toBe("");
    expect(unpriced.cUsd).toBe("");
  });

  it("emits one line per bucket, which is what keeps a 500-candle pull readable", () => {
    const rows = shapeCurveCandles(Array.from({ length: 500 }, () => candle({ rateUsd: "2.5" })), 18);
    expect(rows).toHaveLength(500);
    expect(rows.every((r) => !r.includes("\n"))).toBe(true);
    // The object-per-bucket shaping this replaced pretty-printed to ~66KB at
    // this size, which clients refuse outright.
    expect(JSON.stringify(rows, null, 1).length).toBeLessThan(40_000);
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
    expect(rows).toEqual(["1700000000,1.1,2,0.9,1.5,100"]);
    expect(cells(rows[0]!, CHOICE_CANDLE_COLUMNS)).toEqual({
      t: "1700000000",
      o: "1.1",
      h: "2",
      l: "0.9",
      c: "1.5",
      v: "100",
    });
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
