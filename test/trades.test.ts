import { describe, expect, it } from "vitest";

import type { ApiTrade } from "../src/api/pump.js";
import type { QuoteAssetInfo } from "../src/chain/networks.js";
import { isNotFoundBody } from "../src/airdrops/wasm.js";
import { tradeSummary } from "../src/mcp/tools.js";

const INJ: QuoteAssetInfo = {
  symbol: "INJ",
  slot: 1,
  pairAsset: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
  bankDenom: "inj",
  decimals: 18,
  isNative: true,
};

const USDC: QuoteAssetInfo = {
  symbol: "USDC",
  slot: 2,
  pairAsset: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
  bankDenom: "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
  decimals: 6,
  isNative: false,
};

function trade(over: Partial<ApiTrade> = {}): ApiTrade {
  return {
    txHash: "0xabc",
    logIndex: 0,
    launchId: "2",
    blockNumber: "1",
    blockTime: "2026-08-01T09:11:39.000Z",
    trader: "0xdead",
    side: "buy",
    pairAmount: "20000000000000000", // 0.02 INJ
    tokenAmount: "20789957194227654515159",
    fee: "0",
    spotPriceWad: "0",
    quoteUsd: "4.878830230000000157", // the INJ PRICE, not the trade's value
    ...over,
  };
}

describe("tradeSummary", () => {
  it("reports the trade's notional, not the quote asset's price", () => {
    const row = tradeSummary(trade(), INJ);
    // 0.02 INJ × $4.8788 — the old shaping published 4.8788 here, 50x too big.
    expect(row.usd).toBeCloseTo(0.097577, 6);
    expect(row.quoteRateUsd).toBeCloseTo(4.87883, 5);
    expect(row.pairAmount).toBe("0.02");
    expect(row.quoteSymbol).toBe("INJ");
  });

  it("scales by the quote asset's own decimals", () => {
    // A 6-decimal quote read as 18 would be off by a trillion.
    const row = tradeSummary(
      trade({ launchId: "9", pairAmount: "5000000", quoteUsd: "1.0" }),
      USDC,
    );
    expect(row.pairAmount).toBe("5");
    expect(row.usd).toBeCloseTo(5, 6);
  });

  it("prices a SAI-quoted trade off its own historical rate", () => {
    const sai: QuoteAssetInfo = { ...INJ, symbol: "SAI", slot: 3 };
    const row = tradeSummary(
      trade({ pairAmount: "196980893662594621759", quoteUsd: "0.044913469430634921" }),
      sai,
    );
    // ~197 SAI at $0.0449 — the old shaping published 0.0449, 197x too small.
    expect(row.usd).toBeCloseTo(8.847, 3);
  });

  it("leaves usd null rather than guessing when the quote asset is unknown", () => {
    const row = tradeSummary(trade(), null);
    expect(row.usd).toBeNull();
    expect(row.quoteSymbol).toBeNull();
    // The raw base amounts still go out, so nothing is lost.
    expect(row.pairAmountBase).toBe("20000000000000000");
  });

  it("leaves usd null when the trade carries no rate", () => {
    expect(tradeSummary(trade({ quoteUsd: null }), INJ).usd).toBeNull();
    expect(tradeSummary(trade({ quoteUsd: "0" }), INJ).quoteRateUsd).toBeNull();
  });
});

describe("isNotFoundBody", () => {
  it("recognises the contract-level not-found CosmWasm wraps in a 500", () => {
    expect(
      isNotFoundBody(
        '{"code":2,"message":"type: choice_claim_drops::state::Campaign; key: [00, 09] not found: query wasm contract failed"}',
      ),
    ).toBe(true);
    expect(isNotFoundBody('{"code":2,"message":"height 112181445 is not available"}')).toBe(false);
    expect(isNotFoundBody("upstream connect error")).toBe(false);
  });
});
