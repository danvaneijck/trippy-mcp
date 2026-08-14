import { describe, expect, it } from "vitest";

import type { ApiLaunch } from "../src/api/pump.js";
import { launchFromDenom, policyWarnings, shortfallWarning } from "../src/mcp/tools.js";
import type { Runtime } from "../src/runtime.js";

const ISSUER = "inj13j2rpnlwl30c02d4pzukykwfeyyhelvry9cqte";

function rt(opts: { launches?: Record<string, ApiLaunch>; issuer?: string } = {}): Runtime {
  return {
    net: { launchDenomIssuer: opts.issuer ?? ISSUER },
    pump: {
      getLaunch: async (id: string) => {
        const hit = (opts.launches ?? {})[String(id)];
        if (!hit) throw new Error("not found");
        return hit;
      },
    },
  } as unknown as Runtime;
}

const launch = (id: string) => ({ id }) as ApiLaunch;

describe("launchFromDenom", () => {
  it("maps a launch token's bank denom back to its launch", async () => {
    // Launch tokens ride `factory/<issuer>/…`, never `erc20:0x…` — whose bank
    // supply for a launch token is 0. Matching only the erc20 form meant no
    // holding ever resolved to a launch, so curve positions fell through to the
    // Choice pricer (which cannot price a pre-graduation token) and the
    // dedicated curve pricer never ran.
    const found = await launchFromDenom(
      rt({ launches: { "8": launch("8") } }),
      `factory/${ISSUER}/shroom_8_be9bddf36b94db69`,
    );
    expect(found?.id).toBe("8");
  });

  it("handles the testnet subdenom prefix", async () => {
    const found = await launchFromDenom(
      rt({ launches: { "3": launch("3") } }),
      `factory/${ISSUER}/shroom_t_3_0181da33a45490e9`,
    );
    expect(found?.id).toBe("3");
  });

  it("ignores a denom minted by anyone other than the launchpad issuer", async () => {
    // Tokenfactory namespaces a denom under its creator, so this is the whole
    // spoof check: an impostor cannot mint into the issuer's prefix.
    const found = await launchFromDenom(
      rt({ launches: { "8": launch("8") } }),
      "factory/inj1impostorimpostorimpostorimpostorimposto/shroom_8_be9bddf36b94db69",
    );
    expect(found).toBeNull();
  });

  it("ignores the issuer's non-launch denoms and other denom families", async () => {
    const r = rt({ launches: { "8": launch("8") } });
    expect(await launchFromDenom(r, `factory/${ISSUER}/SAI`)).toBeNull();
    expect(await launchFromDenom(r, "inj")).toBeNull();
    expect(await launchFromDenom(r, "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7")).toBeNull();
  });

  it("returns null rather than throwing when the launch is unknown", async () => {
    expect(await launchFromDenom(rt({}), `factory/${ISSUER}/shroom_42_deadbeefdeadbeef`)).toBeNull();
  });
});

function policyRt(over: Partial<Record<string, unknown>> = {}): Runtime {
  return {
    policy: {
      snapshot: () => ({
        tradingEnabled: true,
        perTxCapUsd: 200,
        remainingDailyUsd: 999.82,
        allowUnpricedSpend: false,
        ...over,
      }),
    },
  } as unknown as Runtime;
}

describe("quote warnings", () => {
  it("says a quote is over the per-tx cap instead of letting execution discover it", () => {
    // A 500 INJ buy quoted clean at amountInUsd 2302.34 against a $200 cap: the
    // number was right there in the response and the caller learned nothing.
    const w = policyWarnings(policyRt(), 2302.34);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("per-tx cap");
    expect(w[0]).toContain("2302.34");
  });

  it("falls to the 24h budget once a spend is under the per-tx cap", () => {
    const w = policyWarnings(policyRt({ remainingDailyUsd: 10 }), 50);
    expect(w[0]).toContain("24h budget");
  });

  it("stays quiet for a spend inside both limits", () => {
    expect(policyWarnings(policyRt(), 5)).toEqual([]);
  });

  it("says an unpriceable trade will be refused, because the signer refuses it", () => {
    // `enforce` throws on spendUsd null unless allowUnpricedSpend, which is
    // false by default — the likeliest refusal of all on a thin token, and the
    // one quote used to stay silent about.
    const w = policyWarnings(policyRt(), null);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("no USD price");
    expect(w[0]).toContain("would refuse");
  });

  it("stays quiet about an unpriceable trade when the operator opted in", () => {
    expect(policyWarnings(policyRt({ allowUnpricedSpend: true }), null)).toEqual([]);
  });

  it("treats 0 as spends-nothing, not as unpriceable — curve sells pass 0", () => {
    // A curve sell converts back to the quote asset; the launchpad enforces
    // spendUsd: 0. Passing null here would warn about a refusal that cannot
    // happen on every single curve sell quote.
    expect(policyWarnings(policyRt(), 0)).toEqual([]);
  });

  it("reports the kill switch", () => {
    expect(policyWarnings(policyRt({ tradingEnabled: false }), 1)[0]).toContain("disabled");
  });

  it("reports a sell of a token the wallet does not hold", () => {
    // `quote sell` of 20,789 BALLS against a zero balance returned warnings: [].
    const w = shortfallWarning(0n, 20_789_957_194_227_654_515_159n, 18, "tokens");
    expect(w).toContain("wallet holds 0 tokens");
    expect(w).toContain("would refuse");
  });

  it("stays quiet when the balance covers the quote", () => {
    expect(shortfallWarning(10n ** 18n, 10n ** 17n, 18, "INJ")).toBeNull();
    expect(shortfallWarning(10n ** 18n, 10n ** 18n, 18, "INJ")).toBeNull();
  });
});
