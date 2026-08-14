/**
 * The swap signing boundary.
 *
 * `spendUsd` is computed from the amount the caller asked for, but the message
 * that gets signed is the SOR's. Nothing used to check the two agreed, so a
 * response naming a different denom or a larger amount would have been signed
 * having been capped against a smaller number. `CosmosSigner.execute` makes the
 * equivalent message-vs-intent check for every other cosmos write; this path
 * builds its own broadcast, so it has to make it itself.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChoiceApi, SorQuoteResponse } from "../src/api/choice.js";
import type { AuditLog } from "../src/audit.js";
import { getNetwork } from "../src/chain/networks.js";
import { PolicyError, ToolError } from "../src/errors.js";
import { PolicySchema } from "../src/config.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { SpendLedger } from "../src/policy/spend.js";
import { ChoiceVenue } from "../src/venues/choice/swap.js";

const NET = getNetwork("mainnet");
const AGG = NET.choiceAggregator;
const INJ = "inj";
const SHROOM_CW20 = "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8";
const realFetch = globalThis.fetch;

/** 0.01 INJ, the amount every test asks for. */
const ASK = "0.01";
const ASK_BASE = "10000000000000000";

function sorResponse(over: Partial<SorQuoteResponse["execute"]> = {}): SorQuoteResponse {
  return {
    summary: {
      token_in: INJ, token_out: "x", amount_in: ASK, expected_output: "1",
      effective_price: "1", minimum_receive: "1", slippage_pct: 1, route_venues: ["100%: amm"],
    },
    execute: {
      type: "MsgExecuteContract", sender: null, contract: AGG,
      msg: { execute_route: {} }, funds: [{ denom: INJ, amount: ASK_BASE }],
      is_cw20_input: false, minimum_receive_base: 1,
      ...over,
    },
    as_of: "2026-08-14T00:00:00Z",
  };
}

/** A venue whose SOR returns `q`, and whose LCD reports 18-dec for `inj`. */
function venue(q: SorQuoteResponse, opts: { decimals?: number | null } = {}) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("denoms_metadata")) {
      const dec = opts.decimals === undefined ? 18 : opts.decimals;
      if (dec === null) return new Response(JSON.stringify({ metadatas: [] }), { status: 200 });
      return new Response(
        JSON.stringify({ metadatas: [{ base: INJ, denom_units: [{ denom: INJ, exponent: dec }] }], pagination: {} }),
        { status: 200 },
      );
    }
    if (url.includes("/smart/")) {
      return new Response(JSON.stringify({ data: { decimals: 18, symbol: "SHROOM" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const dir = mkdtempSync(join(tmpdir(), "trippy-mcp-swap-"));
  const policy = new PolicyEngine(
    PolicySchema.parse({ perTxCapUsd: 1000, allowUnpricedSpend: true }),
    new Set([AGG.toLowerCase()]),
    "0x0",
    new SpendLedger(dir),
  );
  const api = {
    quote: async () => q,
    token: async () => ({ price_usd: 1 }),
  } as unknown as ChoiceApi;
  const audit = { append: () => {} } as unknown as AuditLog;
  // dryRun: signing is never reached — every case here must fail before it.
  return new ChoiceVenue(NET, api, policy, audit, () => "0x00", "inj1x", "agent", true);
}

describe("swap payload must match what the policy priced", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("accepts a payload that spends exactly what was quoted", async () => {
    const res = await venue(sorResponse()).swap(INJ, "x", ASK, 1);
    expect(res.status).toBe("dry-run");
  });

  it("refuses a payload that spends a different denom", async () => {
    // The wallet's USDC being spent under a cap priced in INJ.
    const q = sorResponse({ funds: [{ denom: "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", amount: ASK_BASE }] });
    await expect(venue(q).swap(INJ, "x", ASK, 1)).rejects.toThrow(PolicyError);
  });

  it("refuses a payload that spends more than was quoted", async () => {
    // 1000x the ask — capped against 0.01 INJ, would have spent 10.
    const q = sorResponse({ funds: [{ denom: INJ, amount: "10000000000000000000" }] });
    await expect(venue(q).swap(INJ, "x", ASK, 1)).rejects.toThrow(/would spend .* but 0\.01 was quoted/);
  });

  it("refuses a payload carrying more than one coin", async () => {
    const q = sorResponse({
      funds: [{ denom: INJ, amount: ASK_BASE }, { denom: "erc20:0xa00", amount: "5" }],
    });
    await expect(venue(q).swap(INJ, "x", ASK, 1)).rejects.toThrow(PolicyError);
  });

  it("refuses a CW20 send from a token other than the one quoted", async () => {
    const q = sorResponse({
      is_cw20_input: true,
      contract: "inj1dypt8q7gc97vfqe37snleawaz2gp7hquxkvh34",
      msg: { send: { contract: AGG, amount: ASK_BASE } },
      funds: [],
    });
    await expect(venue(q).swap(SHROOM_CW20, "x", ASK, 1)).rejects.toThrow(/not the .* that was quoted/);
  });

  it("refuses a CW20 send of more than was quoted", async () => {
    const q = sorResponse({
      is_cw20_input: true,
      contract: SHROOM_CW20,
      msg: { send: { contract: AGG, amount: "10000000000000000000" } },
      funds: [],
    });
    await expect(venue(q).swap(SHROOM_CW20, "x", ASK, 1)).rejects.toThrow(PolicyError);
  });

  it("still checks the denom when no source publishes an exponent", async () => {
    // ~42% of denoms publish none. The amount cannot be verified there, but the
    // asset can — so the check degrades rather than disappearing.
    const q = sorResponse({ funds: [{ denom: "factory/inj1other/x", amount: ASK_BASE }] });
    await expect(venue(q, { decimals: null }).swap(INJ, "x", ASK, 1)).rejects.toThrow(PolicyError);
  });

  it("allows an unverifiable amount through when the exponent is unknown", async () => {
    const res = await venue(sorResponse(), { decimals: null }).swap(INJ, "x", ASK, 1);
    expect(res.status).toBe("dry-run");
  });
});

describe("swap amount parsing", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('rejects "all", which only sell can resolve', async () => {
    // Forwarding the literal made the SOR 422, surfacing as `no_route` — i.e.
    // "no liquidity" for what was really a bad amount. The curve venue already
    // answered `bad_amount` locally.
    await expect(venue(sorResponse()).swap(INJ, "x", "all", 1)).rejects.toThrow(ToolError);
  });

  it("rejects exponent notation the two venues disagreed on", async () => {
    // `parseUnits` throws on `1e3` (so the curve venue refused it) while the
    // SOR read it as 1000 — the same input valid on one venue and not the other.
    await expect(venue(sorResponse()).swap(INJ, "x", "1e3", 1)).rejects.toThrow(/cannot parse amount/);
  });

  it("rejects zero and negative amounts locally", async () => {
    await expect(venue(sorResponse()).swap(INJ, "x", "0", 1)).rejects.toThrow(/positive/);
    await expect(venue(sorResponse()).swap(INJ, "x", "-1", 1)).rejects.toThrow(ToolError);
  });
});
