/**
 * `sell … "all"` has to be previewable.
 *
 * `sell` accepted the sentinel and sized it against the live position; `quote`
 * rejected it at the SOR amount parser, so liquidating a position was the ONE
 * trade that could not be previewed. The workaround was to read the quantity
 * out of `portfolio` and retype it as a decimal — which is exactly the manual
 * decimals step that produced the trillionth-of-a-position bug, on the exact
 * tokens (6-dec factory denoms) where it bites.
 *
 * The parser's own hint gave the game away: "all" is only supported on sell —
 * emitted on a sell. It is a shared helper with no view of its caller.
 *
 * These tests pin the parity: both tools size the sentinel the same way, both
 * report the concrete quantity, and a buy still refuses it.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ChoiceApi, SorQuoteResponse } from "../src/api/choice.js";
import type { AuditLog } from "../src/audit.js";
import { getNetwork } from "../src/chain/networks.js";
import { PolicySchema } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import { quote, sell } from "../src/mcp/tools.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { SpendLedger } from "../src/policy/spend.js";
import type { Runtime } from "../src/runtime.js";
import { ChoiceVenue } from "../src/venues/choice/swap.js";

const ADDR = "inj1lr5qnxn8qem0psflh8we7cdeyecutenzgcxjjg";
/** HDRO — a 6-dec factory denom, the shape the decimals bug rode in on. */
const HDRO = "factory/inj1etz0laas6h7vemg3qtd67jpr6lh8v7xz7gfzqw/hdro";
/** 47.676421 HDRO at 6 decimals — the balance from the proven live round trip. */
const HELD_6DEC = "47676421";
const realFetch = globalThis.fetch;

/** Records what the SOR was asked for, so the test can assert the sized amount. */
interface Seen {
  amounts: string[];
}

/**
 * `denomDecimals` memoises per `lcdUrl|denom` for the life of the process, so
 * every runtime gets its OWN url — otherwise the first test to publish an
 * exponent answers for the test that deliberately publishes none.
 */
let lcdSeq = 0;

function rt(opts: { held?: string; decimals?: number | null } = {}): {
  runtime: Runtime;
  seen: Seen;
} {
  const seen: Seen = { amounts: [] };
  const decimals = opts.decimals === undefined ? 6 : opts.decimals;
  const held = opts.held ?? HELD_6DEC;
  const LCD = `https://lcd-${++lcdSeq}.example`;

  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    // `inputPosition` reads the position from the bank module...
    if (url.includes("/bank/v1beta1/balances")) {
      return new Response(
        JSON.stringify({ balances: [{ denom: HDRO, amount: held }], pagination: {} }),
        { status: 200 },
      );
    }
    // ...and the exponent from denom metadata. A slash denom 501s on the
    // per-denom endpoint, so this is the LIST form the package actually uses.
    if (url.includes("denoms_metadata")) {
      if (decimals === null) {
        return new Response(JSON.stringify({ metadatas: [], pagination: {} }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          metadatas: [{ base: HDRO, denom_units: [{ denom: HDRO, exponent: decimals }] }],
          pagination: {},
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const runtime = {
    net: { lcdUrl: LCD },
    injAddress: ADDR,
    policy: {
      clampSlippageBps: (bps?: number) => bps ?? 100,
      snapshot: () => ({
        tradingEnabled: true,
        perTxCapUsd: 200,
        remainingDailyUsd: 1000,
        allowUnpricedSpend: false,
      }),
    },
    choice: {
      quote: async (
        tokenIn: string,
        tokenOut: string,
        amount: string,
      ): Promise<SorQuoteResponse> => {
        seen.amounts.push(amount);
        return {
          summary: {
            token_in: tokenIn,
            token_out: tokenOut,
            amount_in: amount,
            expected_output: "0.00994392",
            effective_price: "1",
            minimum_receive: "0.00984448",
            slippage_pct: 1,
            route_venues: ["100%: amm"],
          },
        } as unknown as SorQuoteResponse;
      },
      // The swap leg records the amount too: `sell` must send what `quote` showed.
      swap: async (tokenIn: string, tokenOut: string, amount: string) => {
        seen.amounts.push(amount);
        return { txHash: "0xdead", status: "broadcast", amountIn: amount };
      },
      usdValueIn: async () => 0.0453,
    },
  } as unknown as Runtime;

  return { runtime, seen };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('quote sell "all"', () => {
  it("resolves the sentinel instead of rejecting it at the parser", async () => {
    // The bug: `bad_amount: cannot parse amount "all"`, hinting that "all" is
    // only supported on sell — on a sell.
    const { runtime, seen } = rt();
    const res = (await quote(runtime, {
      query: HDRO,
      side: "sell",
      amount: "all",
    })) as Record<string, unknown>;

    expect(seen.amounts).toEqual(["47.676421"]);
    expect(res.amountIn).toBe("47.676421");
  });

  it("sizes with the token's OWN exponent, not a guessed 18", async () => {
    // The whole reason a preview matters here. At 18 decimals this balance
    // reads as 4.7676421e-11 — a trillionth of the position, which either
    // fails as "rounds to zero" or sells the trillionth and reports success.
    const { runtime, seen } = rt({ decimals: 6 });
    await quote(runtime, { query: HDRO, side: "sell", amount: "all" });
    expect(seen.amounts[0]).toBe("47.676421");
    expect(seen.amounts[0]).not.toBe("0.000000000047676421");
  });

  it("previews exactly what sell would broadcast", async () => {
    // The parity that was missing: one sizing helper, so the preview and the
    // broadcast cannot describe different trades.
    const previewed = rt();
    const executed = rt();
    const res = (await quote(previewed.runtime, {
      query: HDRO,
      side: "sell",
      amount: "all",
    })) as Record<string, unknown>;
    await sell(executed.runtime, { query: HDRO, amount: "all" });

    expect(executed.seen.amounts).toEqual(previewed.seen.amounts);
    expect(res.amountIn).toBe(executed.seen.amounts[0]);
  });

  it("refuses a position it cannot size rather than guessing", async () => {
    // No published exponent ⇒ no safe human amount. Failing closed here is the
    // point: the alternative is a silent trillionth.
    const { runtime } = rt({ decimals: null });
    await expect(
      quote(runtime, { query: HDRO, side: "sell", amount: "all" }),
    ).rejects.toThrow(ToolError);
  });

  it("refuses an empty position with no_balance, not a zero-amount quote", async () => {
    const { runtime } = rt({ held: "0" });
    await expect(
      quote(runtime, { query: HDRO, side: "sell", amount: "all" }),
    ).rejects.toMatchObject({ code: "no_balance" });
  });
});

describe('buy "all"', () => {
  it("is left unsized by quote — there is no position to size it against", async () => {
    // The sentinel is only meaningful on a sell, so `quote` passes it straight
    // through on a buy and lets the venue parser refuse it (next test).
    const { runtime, seen } = rt();
    await quote(runtime, { query: HDRO, side: "buy", amount: "all" }).catch(() => null);
    expect(seen.amounts).toEqual(["all"]);
  });

  it("is refused by the venue parser, with a hint that names the real problem", async () => {
    // The old hint read `"all" is only supported on sell` — which is exactly
    // what it said while refusing a sell, because this parser cannot see which
    // side called it. Now the sentinel only ever reaches here off a BUY, and
    // the text says so.
    const dir = mkdtempSync(join(tmpdir(), "trippy-mcp-sellall-"));
    const NET = getNetwork("mainnet");
    const venue = new ChoiceVenue(
      NET,
      { quote: async () => ({}) as SorQuoteResponse } as unknown as ChoiceApi,
      new PolicyEngine(
        PolicySchema.parse({ perTxCapUsd: 1000 }),
        new Set([NET.choiceAggregator.toLowerCase()]),
        "0x0",
        new SpendLedger(dir),
      ),
      { append: () => {} } as unknown as AuditLog,
      () => "0x00",
      ADDR,
      "agent",
      true,
    );

    await expect(venue.quote("inj", HDRO, "all", 1)).rejects.toMatchObject({
      code: "bad_amount",
      hint: expect.stringContaining("sell-only"),
    });
    // And the contradiction is gone.
    await expect(venue.quote("inj", HDRO, "all", 1)).rejects.not.toMatchObject({
      hint: expect.stringContaining("only supported on sell"),
    });
  });

  it("still rejects exponent notation, with the decimal hint", async () => {
    // The 0.8.0 guard: the SOR reads `1e3` as 1000 while the curve venue
    // refuses it, so the venues disagreed on the same input.
    const dir = mkdtempSync(join(tmpdir(), "trippy-mcp-sellall-"));
    const NET = getNetwork("mainnet");
    const venue = new ChoiceVenue(
      NET,
      { quote: async () => ({}) as SorQuoteResponse } as unknown as ChoiceApi,
      new PolicyEngine(
        PolicySchema.parse({ perTxCapUsd: 1000 }),
        new Set([NET.choiceAggregator.toLowerCase()]),
        "0x0",
        new SpendLedger(dir),
      ),
      { append: () => {} } as unknown as AuditLog,
      () => "0x00",
      ADDR,
      "agent",
      true,
    );

    await expect(venue.quote("inj", HDRO, "1e3", 1)).rejects.toMatchObject({
      code: "bad_amount",
      hint: expect.stringContaining("exponent notation"),
    });
  });
});
