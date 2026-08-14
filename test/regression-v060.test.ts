/**
 * Regressions found auditing 0.6.0, each pinned to the behaviour that replaced
 * it. Every case here was reproduced against mainnet before it was fixed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  amountText,
  dropDecimals,
  knownDecimals,
  quantityText,
  statedDecimals,
} from "../src/airdrops/pricing.js";
import { isCw20Id } from "../src/api/cw20.js";
import type { ApiLaunch } from "../src/api/pump.js";
import { PolicySchema } from "../src/config.js";
import { PolicyError, ToolError } from "../src/errors.js";
import { encodeMetadataUri } from "../src/metadata.js";
import { choiceCandleMarket, policyWarnings } from "../src/mcp/tools.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { SpendLedger } from "../src/policy/spend.js";
import { resolveToken } from "../src/router.js";
import type { Runtime } from "../src/runtime.js";
import { LaunchState } from "../src/venues/shroom/abi.js";

const CORE = "0xebf62508f322137ee0986935ee3b4a60a3f0d227";
const OWNER = "0x1111111111111111111111111111111111111111";
const ISSUER = "inj13j2rpnlwl30c02d4pzukykwfeyyhelvry9cqte";
const SKIBI_DENOM = `factory/${ISSUER}/shroom_13_f9ac767ba1df1fec`;

function realEngine(overrides: Partial<ReturnType<typeof PolicySchema.parse>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trippy-mcp-test-"));
  const cfg = PolicySchema.parse({ perTxCapUsd: 200, dailyBudgetUsd: 1000, ...overrides });
  return new PolicyEngine(cfg, new Set([CORE]), OWNER, new SpendLedger(dir));
}

function graduated(over: Partial<ApiLaunch> = {}): ApiLaunch {
  return {
    id: "13",
    creator: "0xcreator",
    token: "0xfd02f6313a15327c5cc2285c8182ebb615250974",
    quoteAsset: 0,
    metadataURI: encodeMetadataUri({ name: "SKIBIDI", symbol: "SKIBI", description: "d" }),
    createdAt: "2026-07-01T00:00:00.000Z",
    state: LaunchState.Graduated,
    graduatedPoolDenom: SKIBI_DENOM,
    bankDenom: "factory/inj10aa0h5s0xwzv95a8pjhwluxcm5feeqygdk3lkm/SAI",
    ...over,
  } as unknown as ApiLaunch;
}

function routerRt(launch: ApiLaunch, matches: { address?: string; symbol?: string }[]): Runtime {
  return {
    pump: { listLaunches: async () => ({ items: [launch] }), getLaunch: async () => launch },
    choiceApi: { resolve: async () => ({ matches, ambiguous: matches.length > 1 }) },
  } as unknown as Runtime;
}

describe("a graduated launch and its Choice listing are one asset", () => {
  it("resolves by symbol instead of calling itself ambiguous", async () => {
    // Graduating IS listing: the pad answers the launch and Choice answers the
    // very denom it graduated into. The exact-on-both guard read that as two
    // rival tokens, which made SKIBI #13, BERB #11 and MOON #1 — every
    // graduated launch, i.e. the ones with real liquidity — untradeable by
    // symbol through quote/buy/sell alike.
    const target = await resolveToken(
      routerRt(graduated(), [{ address: SKIBI_DENOM, symbol: "SKIBI" }]),
      "SKIBI",
    );
    expect(target.venue).toBe("choice");
    expect(target.venue === "choice" && target.tokenId).toBe(SKIBI_DENOM);
  });

  it("still refuses when a DIFFERENT token claims the same symbol", async () => {
    // The guard's real purpose: launch metadata is author-supplied, so a launch
    // can declare a symbol an established token already answers to.
    const target = await resolveToken(
      routerRt(graduated(), [{ address: "erc20:0xdifferent", symbol: "SKIBI" }]),
      "SKIBI",
    );
    expect(target.venue).toBe("ambiguous");
  });

  it("refuses when a rival exists alongside the launch's own denom", async () => {
    const target = await resolveToken(
      routerRt(graduated(), [
        { address: SKIBI_DENOM, symbol: "SKIBI" },
        { address: "erc20:0xdifferent", symbol: "SKIBI" },
      ]),
      "SKIBI",
    );
    expect(target.venue).toBe("ambiguous");
    // Only the genuine rival is offered — not the launch's own denom twice.
    expect(target.venue === "ambiguous" && target.candidates).toHaveLength(2);
  });

  it("an ungraduated launch colliding on symbol is still ambiguous", async () => {
    const active = graduated({ state: LaunchState.Trading, graduatedPoolDenom: null });
    const target = await resolveToken(
      routerRt(active, [{ address: "erc20:0xreal", symbol: "SKIBI" }]),
      "SKIBI",
    );
    expect(target.venue).toBe("ambiguous");
  });
});

describe("quote reports the refusals the signer will actually make", () => {
  it("warns that an unpriceable trade is refused — and the engine does refuse it", () => {
    const engine = realEngine();
    expect(PolicySchema.parse({}).allowUnpricedSpend).toBe(false);
    expect(() =>
      engine.enforce({ kind: "swap", target: CORE, detail: "s", spendUsd: null }),
    ).toThrow(PolicyError);

    const w = policyWarnings({ policy: engine } as unknown as Runtime, null);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("would refuse");
  });

  it("stays silent once the operator allows unpriced spend, matching enforce", () => {
    const engine = realEngine({ allowUnpricedSpend: true });
    expect(() =>
      engine.enforce({ kind: "swap", target: CORE, detail: "s", spendUsd: null }),
    ).not.toThrow();
    expect(policyWarnings({ policy: engine } as unknown as Runtime, null)).toEqual([]);
  });

  it("0 means spends-nothing and never warns — curve sells rely on it", () => {
    const engine = realEngine();
    expect(() =>
      engine.enforce({ kind: "trade", target: CORE, detail: "sell", spendUsd: 0 }),
    ).not.toThrow();
    expect(policyWarnings({ policy: engine } as unknown as Runtime, 0)).toEqual([]);
  });
});

describe("an exponent the chain does not publish", () => {
  const USDC = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
  const ROAR = "factory/inj10pz3xq7zf8xudqxaqealgyrnfk66u3c99ud5m2/ROAR";
  // lcdUrl is unreachable on purpose: nothing below may need the network.
  const priceRt = {
    net: { lcdUrl: "http://127.0.0.1:1", quoteAssets: { usdc: { bankDenom: USDC, decimals: 6 } } },
  } as unknown as Runtime;

  it("takes what the operator stated ahead of everything else", async () => {
    // 1,483 of mainnet's 3,497 denoms publish decimals: 0 with no populated
    // denom_units — Injective's "never filled in". For those the operator is
    // the only source, so the whole airdrop rail was unusable without this.
    expect(await knownDecimals(priceRt, ROAR, 18)).toBe(18);
    expect(await dropDecimals(priceRt, ROAR, 18)).toBe(18);
  });

  it("still prefers the vendored registry over a bad guess", async () => {
    expect(await knownDecimals(priceRt, USDC)).toBe(6);
  });

  it("rejects a stated exponent that is not a plausible one", () => {
    for (const bad of [null, undefined, "18", 1.5, -1, 31, NaN]) {
      expect(statedDecimals(bad)).toBeNull();
    }
    expect(statedDecimals(0)).toBe(0);
    expect(statedDecimals(18)).toBe(18);
  });

  it("sizing refuses when nobody knows, and says how to answer", async () => {
    // The old hint said "drop a denom with bank metadata" — unactionable, since
    // these denoms DO have bank metadata; it just carries decimals: 0.
    const err = await dropDecimals(priceRt, ROAR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).message).toContain("cannot be sized");
    expect((err as ToolError).hint).toContain("assetDecimals");
  });

  it("display falls back to base units rather than refusing", () => {
    // airdrop_status is read-only: a funded, live campaign has to stay
    // inspectable even when nothing publishes an exponent for its denom.
    expect(quantityText("1000", null)).toBe("1000");
    expect(quantityText("1000000", 6)).toBe("1");
    expect(amountText("1000", null, ROAR)).toContain("base units");
  });
});

describe("candles chart the token that was asked for", () => {
  const marketRt = (symbol: string | null, top: { pair: string; vol24h_usd: number }[]): Runtime =>
    ({
      choiceApi: { token: async () => ({ symbol, top_markets: top, price_usd: 1.64e-6 }) },
    }) as unknown as Runtime;

  it("picks the market the token is the BASE of, not the busiest one", async () => {
    // Live: SAI/SKIBI carried more volume, and charting its base returned SAI's
    // ~$0.047 series for a token trading at $0.0000016.
    const picked = await choiceCandleMarket(marketRt("SKIBI", [
      { pair: "SAI/SKIBI", vol24h_usd: 2.77 },
      { pair: "SKIBI/INJ", vol24h_usd: 2.43 },
      { pair: "SKIBI/AUSD", vol24h_usd: 0 },
    ]), "denom");
    expect(picked.chartsSomethingElse).toBe(false);
    expect(picked.market).toBe("SKIBI/INJ");
    expect(picked.thin).toBe(false);
  });

  it("flags the base-side market as thin when it has no volume", async () => {
    const picked = await choiceCandleMarket(marketRt("BERB", [
      { pair: "SAI/BERB", vol24h_usd: 3.53 },
      { pair: "BERB/USDT", vol24h_usd: 0 },
    ]), "denom");
    expect(picked.market).toBe("BERB/USDT");
    expect(picked.thin).toBe(true);
  });

  it("refuses when the token is only ever the quote side", async () => {
    // MOON and ERIC today: SAI/MOON is the only market, so no series exists.
    const picked = await choiceCandleMarket(
      marketRt("MOON", [{ pair: "SAI/MOON", vol24h_usd: 0 }]),
      "denom",
    );
    expect(picked.chartsSomethingElse).toBe(true);
    expect(picked.markets).toEqual(["SAI/MOON"]);
  });

  it("leaves the token-id request alone when nothing is known", async () => {
    const picked = await choiceCandleMarket(marketRt(null, []), "denom");
    expect(picked.chartsSomethingElse).toBe(false);
    expect(picked.market).toBeUndefined();
  });
});

describe("CW20 token ids", () => {
  it("recognises a bech32 contract id, and no bank denom shape", () => {
    // SHROOM's Choice id. Its balance lives in the contract, not the bank
    // module, so bankBalances read 0 and quote blamed missing chain metadata.
    expect(isCw20Id("inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8")).toBe(true);
    for (const denom of [
      "inj",
      "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
      SKIBI_DENOM,
      "ibc/C4CFF46FD6DE35CA4CF4CE031E643C8FDC9BA4B99AE598E9B0ED98FE3A2319F9",
    ]) {
      expect(isCw20Id(denom)).toBe(false);
    }
  });
});
