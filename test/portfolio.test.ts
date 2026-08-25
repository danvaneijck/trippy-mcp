import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiLaunch } from "../src/api/pump.js";
import {
  launchFromDenom,
  policyWarnings,
  portfolio,
  type PortfolioRow,
  shortfallWarning,
} from "../src/mcp/tools.js";
import { effectiveNetwork, type Runtime } from "../src/runtime.js";
import { NETWORKS } from "../src/chain/networks.js";
import { isCw20Id } from "../src/api/cw20.js";
import { evmToInj } from "../src/keystore.js";

const ISSUER = "inj13j2rpnlwl30c02d4pzukykwfeyyhelvry9cqte";
const CORE_V2 = "0xd948740da926E8908A08414879490d0D8F96D463";
const CORE_V1 = "0xeBF62508F322137EE0986935Ee3b4A60a3F0D227";

/** sink address -> the denom that sink's launch actually minted. */
const sinkDenoms = new Map<string, string>();
// Intercept ONLY the sink lookup — `smartQuery` is also how CW20 balances are
// read, and stubbing the whole module blanks every CW20 holding in this file.
vi.mock("../src/airdrops/wasm.js", async (orig) => {
  const real = await orig<typeof import("../src/airdrops/wasm.js")>();
  return {
    ...real,
    smartQuery: async (lcd: string, contract: string, query: object, opts?: unknown) => {
      if (query && typeof query === "object" && "sink_config" in query) {
        return { token_denom: sinkDenoms.get(contract.toLowerCase()) ?? null };
      }
      return real.smartQuery(lcd, contract, query, opts as never);
    },
  };
});

interface ChainLaunch {
  core: string;
  onchainId: string;
  token: string;
  sink?: string;
}

/**
 * A runtime with TWO deployed cores, because one core cannot reproduce any of
 * this: the id in a subdenom is per core, and both cores mint under the same
 * tokenfactory issuer.
 */
function rt(
  opts: {
    issuer?: string;
    chain?: ChainLaunch[];
    rows?: ApiLaunch[];
    /** What the `/launches` listing serves — the index is built from this. */
    index?: ApiLaunch[];
    onChainRead?: () => void;
  } = {},
): Runtime {
  const chain = opts.chain ?? [];
  const rows = opts.rows ?? [];
  const index = opts.index ?? [];
  const key = (core: string, id: string) => `${core.toLowerCase()}:${id}`;
  const byKey = new Map(chain.map((c) => [key(c.core, c.onchainId), c]));

  return {
    net: {
      launchDenomIssuer: opts.issuer ?? ISSUER,
      lcdUrl: "https://lcd.test",
      addresses: { launchpadCore: CORE_V2, launchpadViews: CORE_V2, curveRegistry: CORE_V2 },
      legacyCores: [{ core: CORE_V1, views: CORE_V1, hasCurveId: false, legacy: true }],
    },
    shroom: {
      forLaunch: (l: { core?: string | null }) => {
        const core = l.core ?? CORE_V2;
        return {
          getLaunchView: async (id: bigint) => {
            opts.onChainRead?.();
            const hit = byKey.get(key(core, id.toString()));
            if (!hit) throw new Error("no such launch on this core");
            return { token: hit.token, sink: hit.sink ?? `0x${"ee".repeat(20)}` };
          },
        };
      },
    },
    pump: {
      listLaunches: async ({ q }: { q?: string }) =>
        q === undefined
          ? { items: index } // the index build asks for everything
          : { items: rows.filter((r) => r.token.toLowerCase() === q.toLowerCase()) },
      getLaunch: async (id: string) => {
        const hit = rows.find((r) => r.id === id);
        if (!hit) throw new Error("not found");
        return hit;
      },
    },
  } as unknown as Runtime;
}

const TOK_EGG = `0x${"a1".repeat(20)}`;
const TOK_PEDRO = `0x${"b2".repeat(20)}`;

const row = (o: Partial<ApiLaunch> & { id: string; token?: string }) =>
  ({ onchainId: o.id, core: CORE_V2, token: TOK_EGG, ...o }) as ApiLaunch;


describe("launchFromDenom", () => {
  afterEach(() => sinkDenoms.clear());

  it("reads the subdenom's id as an ON-CHAIN id, not as an API launch id", async () => {
    // The regression. `shroom_108_…` is INJEGG, whose API id is 234; API launch
    // 108 is an unrelated coin that also exists. Feeding the subdenom's id
    // straight to the API resolved the wrong launch every time, and then priced
    // the holding off its trades and labelled it with its name.
    const found = await launchFromDenom(
      rt({
        chain: [{ core: CORE_V2, onchainId: "108", token: TOK_EGG }],
        rows: [
          row({ id: "234", onchainId: "108", token: TOK_EGG }),
          row({ id: "108", onchainId: "46", token: TOK_PEDRO }),
        ],
      }),
      `factory/${ISSUER}/shroom_108_179b58245e1c88ae`,
    );
    expect(found?.id).toBe("234");
  });

  it("finds a launch that lives on the superseded core", async () => {
    const found = await launchFromDenom(
      rt({
        chain: [{ core: CORE_V1, onchainId: "3", token: TOK_EGG }],
        rows: [row({ id: "3", onchainId: "3", token: TOK_EGG, core: CORE_V1 })],
      }),
      `factory/${ISSUER}/shroom_3_0181da33a45490e9`,
    );
    expect(found?.id).toBe("3");
  });

  it("asks the sink which core minted it when both cores share the id", async () => {
    // Mainnet's two cores collide on ids 0..15 outright: `shroom_9_31dcaf…` and
    // `shroom_9_f28bdc…` are different tokens under one issuer. Nothing but the
    // salt separates them, and only the sink knows it.
    const denom = `factory/${ISSUER}/shroom_9_f28bdc6d70eab504`;
    const SINK_V1 = `0x${"c3".repeat(20)}`;
    const SINK_V2 = `0x${"d4".repeat(20)}`;
    sinkDenoms.set(evmToInj(SINK_V2 as `0x${string}`).toLowerCase(), denom);
    sinkDenoms.set(
      evmToInj(SINK_V1 as `0x${string}`).toLowerCase(),
      `factory/${ISSUER}/shroom_9_31dcaf8cb918ef5c`,
    );

    const found = await launchFromDenom(
      rt({
        chain: [
          { core: CORE_V1, onchainId: "9", token: TOK_PEDRO, sink: SINK_V1 },
          { core: CORE_V2, onchainId: "9", token: TOK_EGG, sink: SINK_V2 },
        ],
        rows: [
          row({ id: "9", onchainId: "9", token: TOK_PEDRO, core: CORE_V1 }),
          row({ id: "225", onchainId: "9", token: TOK_EGG, core: CORE_V2 }),
        ],
      }),
      denom,
    );
    expect(found?.id).toBe("225");
  });

  it("handles the testnet subdenom prefix", async () => {
    const found = await launchFromDenom(
      rt({
        chain: [{ core: CORE_V2, onchainId: "3", token: TOK_EGG }],
        rows: [row({ id: "19", onchainId: "3", token: TOK_EGG })],
      }),
      `factory/${ISSUER}/shroom_t_3_0181da33a45490e9`,
    );
    expect(found?.id).toBe("19");
  });

  it("ignores a denom minted by anyone other than the launchpad issuer", async () => {
    // Tokenfactory namespaces a denom under its creator, so this is the whole
    // spoof check: an impostor cannot mint into the issuer's prefix.
    const found = await launchFromDenom(
      rt({
        chain: [{ core: CORE_V2, onchainId: "8", token: TOK_EGG }],
        rows: [row({ id: "8", token: TOK_EGG })],
      }),
      "factory/inj1impostorimpostorimpostorimpostorimposto/shroom_8_be9bddf36b94db69",
    );
    expect(found).toBeNull();
  });

  it("ignores the issuer's non-launch denoms and other denom families", async () => {
    const r = rt({
      chain: [{ core: CORE_V2, onchainId: "8", token: TOK_EGG }],
      rows: [row({ id: "8", token: TOK_EGG })],
    });
    expect(await launchFromDenom(r, `factory/${ISSUER}/SAI`)).toBeNull();
    expect(await launchFromDenom(r, "inj")).toBeNull();
    expect(await launchFromDenom(r, "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7")).toBeNull();
  });

  it("returns null rather than throwing when no core has that launch", async () => {
    expect(await launchFromDenom(rt({}), `factory/${ISSUER}/shroom_42_deadbeefdeadbeef`)).toBeNull();
  });

  it("answers from the listing index without touching the chain at all", async () => {
    // `portfolio` resolves one of these per launch-token holding. Doing it with
    // a chain read each tripled a real wallet's portfolio call to 76s; the
    // listing already carries core, onchainId and sinkAddr on every row.
    let chainReads = 0;
    const r = rt({
      chain: [{ core: CORE_V2, onchainId: "108", token: TOK_EGG }],
      rows: [row({ id: "234", onchainId: "108", token: TOK_EGG })],
      index: [row({ id: "234", onchainId: "108", token: TOK_EGG })],
      onChainRead: () => chainReads++,
    });
    const found = await launchFromDenom(r, `factory/${ISSUER}/shroom_108_179b58245e1c88ae`);
    expect(found?.id).toBe("234");
    expect(chainReads).toBe(0);
  });

  it("separates a collision from the index using each candidate's sinkAddr", async () => {
    const denom = `factory/${ISSUER}/shroom_9_f28bdc6d70eab504`;
    sinkDenoms.set("inj1sinkv2", denom);
    sinkDenoms.set("inj1sinkv1", `factory/${ISSUER}/shroom_9_31dcaf8cb918ef5c`);
    let chainReads = 0;
    const r = rt({
      index: [
        row({ id: "9", onchainId: "9", token: TOK_PEDRO, core: CORE_V1, sinkAddr: "inj1sinkv1" }),
        row({ id: "34", onchainId: "9", token: TOK_EGG, core: CORE_V2, sinkAddr: "inj1sinkv2" }),
      ],
      onChainRead: () => chainReads++,
    });
    expect((await launchFromDenom(r, denom))?.id).toBe("34");
    expect(chainReads).toBe(0);
  });

  it("refuses a row that disagrees with the chain about its core or on-chain id", async () => {
    // The token address is the handle that crosses the two namespaces, so a row
    // that does not agree about both is not the launch this denom names.
    const found = await launchFromDenom(
      rt({
        chain: [{ core: CORE_V2, onchainId: "108", token: TOK_EGG }],
        rows: [row({ id: "234", onchainId: "77", token: TOK_EGG })],
      }),
      `factory/${ISSUER}/shroom_108_179b58245e1c88ae`,
    );
    expect(found).toBeNull();
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

// ---------------------------------------------------------------------------
// CW20 holdings
// ---------------------------------------------------------------------------

const SHROOM_CW20 = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
const AGENT_INJ = "inj1lr5qnxn8qem0psflh8we7cdeyecutenzgcxjjg";
const realFetch = globalThis.fetch;

/**
 * An LCD + Choice pair holding `bank` in the bank module and `cw20` inside the
 * token contracts. The split is the whole point: a CW20 balance is invisible to
 * `bankBalances`, so a portfolio that only reads bank cannot see it.
 */
function stubChain(opts: {
  bank?: { denom: string; amount: string }[];
  cw20?: Record<string, { balance: string; decimals?: number; symbol?: string } | "erroring">;
  priceUsd?: number | null;
}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/cosmos/bank/v1beta1/balances/")) {
      return new Response(JSON.stringify({ balances: opts.bank ?? [] }), { status: 200 });
    }
    const smart = /\/contract\/([^/]+)\/smart\/(.+)$/.exec(url);
    if (smart) {
      const token = opts.cw20?.[smart[1]!];
      // 400, not 500: `smartQuery` retries 5xx for ~15s by design, and what is
      // under test here is the catch, not the retry ladder.
      if (!token || token === "erroring") return new Response("boom", { status: 400 });
      const q = JSON.parse(Buffer.from(decodeURIComponent(smart[2]!), "base64").toString());
      if ("balance" in q) {
        return new Response(JSON.stringify({ data: { balance: token.balance } }), { status: 200 });
      }
      if (token.decimals === undefined) return new Response("boom", { status: 400 });
      return new Response(
        JSON.stringify({ data: { decimals: token.decimals, symbol: token.symbol } }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { calls };
}

function cw20Rt(cw20Tokens: string[], priceUsd: number | null = 0.0000329315): Runtime {
  return {
    net: {
      lcdUrl: "https://lcd.test",
      cw20Tokens,
      quoteAssets: {},
      launchDenomIssuer: ISSUER,
    },
    injAddress: AGENT_INJ,
    signer: { address: "0xf8E8099A670676F0C13FB9Dd9f61b92671c5e662" },
    // Shaped like a live overview: a real token carries `liquidity_usd`, and
    // one that does not is treated as a mark nobody traded against.
    choiceApi: {
      token: async () => ({
        price_usd: priceUsd,
        name: "shroomin",
        liquidity_usd: 7773.21,
        top_markets: [{ pair: "SHROOM/INJ", vol24h_usd: 206.79 }],
      }),
    },
    pump: { getLaunch: async () => { throw new Error("not found"); } },
  } as unknown as Runtime;
}

describe("portfolio CW20 holdings", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reports a CW20 position that bank state cannot see", async () => {
    // The gap: a Choice buy of SHROOM settles into the CW20 contract, not into
    // the token's bank-adapter denom, so `bankBalances` reports nothing at all.
    // `sell all` sized this position correctly the whole time — portfolio just
    // could not show it, so an agent surveying holdings concluded it held none.
    stubChain({
      bank: [],
      cw20: { [SHROOM_CW20]: { balance: "1380569701581075860244", decimals: 18, symbol: "SHROOM" } },
    });
    const res = (await portfolio(cw20Rt([SHROOM_CW20]))) as {
      holdings: PortfolioRow[];
      totalUsd: number;
    };
    expect(res.holdings).toHaveLength(1);
    const row = res.holdings[0]!;
    expect(row.denom).toBe(SHROOM_CW20);
    expect(row.amount).toBeCloseTo(1380.5697015810759, 6);
    expect(row.pricedVia).toBe("choice");
    expect(res.totalUsd).toBeCloseTo(1380.5697015810759 * 0.0000329315, 8);
    // The contract's own ticker is third-party text, so it never occupies the
    // trusted `symbol` field.
    expect(row.symbol).toBeNull();
    expect(row.untrusted_metadata?.symbol).toBe("SHROOM");
  });

  it("keeps bank and CW20 holdings as separate rows", async () => {
    // SHROOM exists in both forms; holding each is two real balances, not one
    // double-counted. They must both appear and both count.
    stubChain({
      bank: [{ denom: "inj", amount: "48212267518105470" }],
      cw20: { [SHROOM_CW20]: { balance: "1000000000000000000", decimals: 18, symbol: "SHROOM" } },
    });
    const res = (await portfolio(cw20Rt([SHROOM_CW20]))) as { holdings: PortfolioRow[] };
    expect(res.holdings.map((h) => h.denom).sort()).toEqual(["inj", SHROOM_CW20].sort());
  });

  it("omits a zero CW20 balance instead of showing an empty row", async () => {
    stubChain({ bank: [], cw20: { [SHROOM_CW20]: { balance: "0", decimals: 18 } } });
    const res = (await portfolio(cw20Rt([SHROOM_CW20]))) as { holdings: PortfolioRow[] };
    expect(res.holdings).toEqual([]);
  });

  it("survives a CW20 contract that errors rather than failing the portfolio", async () => {
    // One bad contract must never take down the whole holdings view.
    stubChain({
      bank: [{ denom: "inj", amount: "1000000000000000000" }],
      cw20: { [SHROOM_CW20]: "erroring" },
    });
    const res = (await portfolio(cw20Rt([SHROOM_CW20]))) as { holdings: PortfolioRow[] };
    expect(res.holdings.map((h) => h.denom)).toEqual(["inj"]);
  });

  it("reports the exact base amount, unpriced, when token_info has no decimals", async () => {
    // Same rule as a bank denom with no metadata: never multiply a real price
    // by a guessed quantity.
    stubChain({
      bank: [],
      cw20: { [SHROOM_CW20]: { balance: "1380569701581075860244" } },
    });
    const res = (await portfolio(cw20Rt([SHROOM_CW20]))) as {
      holdings: PortfolioRow[];
      totalUsd: number;
    };
    const row = res.holdings[0]!;
    expect(row.decimalsUnknown).toBe(true);
    expect(row.amountBase).toBe("1380569701581075860244");
    expect(row.valueUsd).toBeNull();
    expect(res.totalUsd).toBe(0);
  });

  it("prices CW20s even when a dust tail would exhaust the lookup budget", async () => {
    // Regression: bank was walked first, so a wallet with 26 junk denoms spent
    // MAX_PRICE_LOOKUPS before the CW20 probe ran and the position came back
    // unpriced — i.e. missing from totalUsd. Seen live on a wallet whose CW20
    // was 88% of its value. The curated list is short; the dust tail is not, so
    // the dust is what must degrade.
    stubChain({
      bank: Array.from({ length: 30 }, (_, i) => ({
        denom: `factory/inj1dust${String(i).padStart(34, "0")}/d${i}`,
        amount: "1000",
      })),
      cw20: { [SHROOM_CW20]: { balance: "1000000000000000000", decimals: 18, symbol: "SHROOM" } },
    });
    const res = (await portfolio(cw20Rt([SHROOM_CW20]))) as {
      holdings: PortfolioRow[];
      totalUsd: number;
    };
    const shroom = res.holdings.find((h) => h.denom === SHROOM_CW20)!;
    expect(shroom.pricedVia).toBe("choice");
    expect(res.totalUsd).toBeGreaterThan(0);
  });

  it("probes nothing when the network lists no CW20s", async () => {
    const { calls } = stubChain({ bank: [] });
    await portfolio(cw20Rt([]));
    expect(calls.some((c) => c.includes("/smart/"))).toBe(false);
  });
});

describe("cw20Tokens registry", () => {
  it("lists only ids the CW20 branch will actually recognise", () => {
    // `isCw20Id` is what routes a token id to the contract rather than to bank.
    // An entry that fails it would be probed as a CW20 and found by nothing.
    for (const net of Object.values(NETWORKS)) {
      for (const id of net.cw20Tokens) {
        expect(isCw20Id(id), `${net.name}: ${id}`).toBe(true);
      }
    }
  });

  it("has no duplicates — each entry costs a balance query per portfolio call", () => {
    for (const net of Object.values(NETWORKS)) {
      expect(new Set(net.cw20Tokens).size).toBe(net.cw20Tokens.length);
    }
  });

  it("keeps SHROOM on mainnet", () => {
    // The token the gap was found with, and the one an agent is likeliest to
    // hold — a refactor that drops it reintroduces the original bug.
    expect(NETWORKS.mainnet.cw20Tokens).toContain("inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8");
  });

  it("unions a per-install list with the built-ins instead of replacing them", () => {
    const extra = "inj1dypt8q7gc97vfqe37snleawaz2gp7hquxkvh34";
    const net = effectiveNetwork({
      network: "mainnet",
      cw20Tokens: [extra, "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8"],
    } as unknown as Parameters<typeof effectiveNetwork>[0]);
    expect(net.cw20Tokens).toContain(extra);
    // Built-ins survive, and re-stating one does not duplicate its probe.
    for (const id of NETWORKS.mainnet.cw20Tokens) expect(net.cw20Tokens).toContain(id);
    expect(new Set(net.cw20Tokens).size).toBe(net.cw20Tokens.length);
  });
});

describe("prices nobody traded against stay out of totalUsd", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A runtime whose Choice overview is exactly `overview`. */
  function rtWithOverview(overview: Record<string, unknown>): Runtime {
    return {
      net: { lcdUrl: "https://lcd.test", cw20Tokens: [SHROOM_CW20], quoteAssets: {}, launchDenomIssuer: ISSUER },
      injAddress: AGENT_INJ,
      signer: { address: "0x0" },
      choiceApi: { token: async () => overview },
      pump: { getLaunch: async () => { throw new Error("nf"); } },
    } as unknown as Runtime;
  }

  const held = { [SHROOM_CW20]: { balance: "10000000000000000000000", decimals: 18, symbol: "X" } };

  it("drops a mark on a dead token, in the exact shape Choice really returns", async () => {
    // 10,000 of a dead factory denom marked at $541 contributed $5.4M of a
    // $5.4M total on a wallet that really held dust. Decimals and amount were
    // both right — only the mark was junk, so no exponent guard caught it.
    //
    // This overview is copied from the live response for RealTrumPepe: Choice
    // OMITS `liquidity_usd` for a token with no pools rather than sending 0.
    // The first cut of this test asserted `liquidity_usd: 0` — an assumption,
    // not the payload — so it passed while the gate was inert in production.
    stubChain({ bank: [], cw20: held });
    const res = (await portfolio(
      rtWithOverview({
        price_usd: 541.323,
        top_markets: [{ kind: "orderbook", pair: "RealTrumPepe/INJ", vol24h_usd: 0.0 }],
      }),
    )) as { holdings: PortfolioRow[]; totalUsd: number };
    const row = res.holdings[0]!;
    expect(row.staleMark).toBe(true);
    expect(row.valueUsd).toBeNull();
    expect(res.totalUsd).toBe(0);
    // The quantity is still reported — only the money claim is withheld.
    expect(row.amount).toBe(10000);
  });

  it("keeps a mark when the token has real volume", async () => {
    stubChain({ bank: [], cw20: held });
    const res = (await portfolio(
      rtWithOverview({ price_usd: 2, liquidity_usd: 0, top_markets: [{ vol24h_usd: 1234 }] }),
    )) as { holdings: PortfolioRow[]; totalUsd: number };
    expect(res.holdings[0]!.staleMark).toBeUndefined();
    expect(res.totalUsd).toBe(20000);
  });

  it("keeps a mark when the token has real liquidity", async () => {
    stubChain({ bank: [], cw20: held });
    const res = (await portfolio(
      rtWithOverview({ price_usd: 2, liquidity_usd: 7776, top_markets: [{ vol24h_usd: 0 }] }),
    )) as { holdings: PortfolioRow[]; totalUsd: number };
    expect(res.holdings[0]!.staleMark).toBeUndefined();
    expect(res.totalUsd).toBe(20000);
  });

  it("treats an absent liquidity field with no volume as dead", async () => {
    // The inverse of what shipped in 0.8.0. Every live asset sampled — INJ,
    // USDT, QUNT, SHROOM, the launch denoms — carries `liquidity_usd`; only
    // the dead one omitted it.
    stubChain({ bank: [], cw20: held });
    const res = (await portfolio(rtWithOverview({ price_usd: 2 }))) as {
      holdings: PortfolioRow[];
      totalUsd: number;
    };
    expect(res.holdings[0]!.staleMark).toBe(true);
    expect(res.totalUsd).toBe(0);
  });

  it("keeps a mark on a token with liquidity but no markets array", async () => {
    stubChain({ bank: [], cw20: held });
    const res = (await portfolio(rtWithOverview({ price_usd: 2, liquidity_usd: 500 }))) as {
      holdings: PortfolioRow[];
      totalUsd: number;
    };
    expect(res.holdings[0]!.staleMark).toBeUndefined();
    expect(res.totalUsd).toBe(20000);
  });
});
