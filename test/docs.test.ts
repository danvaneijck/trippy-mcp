import { describe, expect, it } from "vitest";

import { explain, TOPICS, TOPIC_IDS, findTopic, topicIndex } from "../src/docs/index.js";
import { bps, fee, UNKNOWN, type LiveParams, type QuoteParams } from "../src/docs/params.js";
import type { Runtime } from "../src/runtime.js";

const quote = (over: Partial<QuoteParams> = {}): QuoteParams => ({
  symbol: "INJ",
  slot: 1,
  enabled: true,
  pairAsset: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
  bankDenom: "inj",
  decimals: 18,
  virtualPair: "30",
  graduationPairTarget: "300",
  virtualToken: "1073000000",
  curveSupply: "800000000",
  graduationTokenReserve: "200000000",
  tradeFeeBps: 100,
  creatorFeeShareBps: 1000,
  creatorTakePct: 0.1,
  ...over,
});

const params = (over: Partial<LiveParams> = {}): LiveParams => ({
  creationFeeInj: "0.2",
  referralShareBps: 1000,
  treasury: "0xAB1C7326b8bcd3492FF56CdA88Ec40d0A417e40d",
  quotes: [quote()],
  errors: [],
  fetchedAt: "2026-08-02T00:00:00.000Z",
  ...over,
});

describe("docs registry", () => {
  it("every topic has a unique id, a summary and sources", () => {
    const ids = TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOPICS) {
      expect(t.summary.length).toBeGreaterThan(20);
      expect(t.sources.length).toBeGreaterThan(0);
      expect(t.title.length).toBeGreaterThan(5);
    }
  });

  it("TOPIC_IDS matches the registry (the zod enum must not drift)", () => {
    expect([...TOPIC_IDS].sort()).toEqual(TOPICS.map((t) => t.id).sort());
  });

  it("indexes topics when called with no topic", async () => {
    const idx = topicIndex();
    expect((idx.topics as unknown[]).length).toBe(TOPICS.length);
    const viaExplain = await explain({} as Runtime, undefined);
    expect(viaExplain).toEqual(idx);
  });

  it("rejects an unknown topic with the list of known ones", async () => {
    await expect(explain({} as Runtime, "nope")).rejects.toMatchObject({
      code: "unknown_topic",
    });
  });
});

describe("prose carries no numbers", () => {
  // The whole point of hydrating live: a figure that survives into the prose
  // when the chain read failed is a figure this package invented.
  const NUMERIC_CLAIM =
    /\b\d[\d,._]*\s*(INJ|USDC|SAI|bps|%)|\b(0\.\d+|[1-9]\d*)\s*(INJ|bps)\b/i;

  it("renders no protocol figures when every live read failed", () => {
    const blank = params({
      creationFeeInj: null,
      referralShareBps: null,
      treasury: null,
      quotes: [],
      errors: ["denomCreationFeeInj: boom"],
    });
    for (const topic of TOPICS) {
      const text = topic.render(blank);
      // Strip the parts that are legitimately fixed protocol constants
      // (supply, the CLMM fee tier, decimals warnings) before the scan.
      const scrubbed = text
        .replace(/1,000,000,000 tokens/g, "")
        .replace(/0\.30% tier/g, "")
        .replace(/0\.5% max_spread/g, "")
        .replace(/\b1e\d+\b/g, "")
        .replace(/slots? 0-7/g, "")
        // Contract invariants, not parameters: the discount is capped at 100%
        // of the creator cut by the code, it is not a configurable figure.
        .replace(/100% of it|up to 100%/g, "")
        .replace(/18-decimal|6-decimal|6, not 18|uint8/g, "");
      const hit = NUMERIC_CLAIM.exec(scrubbed);
      expect(hit, `${topic.id} invented "${hit?.[0]}" with no live data`).toBeNull();
    }
  });

  it("surfaces unreadable figures as UNKNOWN, never as a plausible number", () => {
    expect(fee(params({ creationFeeInj: null }))).toBe(UNKNOWN);
    expect(fee(params())).toBe("0.2 INJ");
    expect(bps(null)).toBe(UNKNOWN);
    expect(bps(1000)).toBe("1000 bps (10%)");
  });
});

describe("topic rendering", () => {
  it("shroom_pad_quotes tabulates every live slot, including disabled ones", () => {
    const text = findTopic("shroom_pad_quotes")!.render(
      params({
        quotes: [
          quote(),
          quote({ symbol: "SAI", slot: 3, creatorFeeShareBps: 9000, creatorTakePct: 0.9 }),
          quote({ symbol: "OLD", slot: 4, enabled: false }),
        ],
      }),
    );
    expect(text).toContain("### INJ (slot 1)");
    expect(text).toContain("### SAI (slot 3)");
    expect(text).toContain("[DISABLED");
    // Ranking is derived, not asserted in prose: SAI's higher creator share
    // must sort it ahead of INJ, and the disabled slot must not rank at all.
    expect(text).toMatch(/SAI ~0\.9000% > INJ ~0\.1000%/);
    expect(text).not.toMatch(/OLD ~/);
  });

  it("shroom_pad_fees computes the referral rate as a share of the creator cut", () => {
    const text = findTopic("shroom_pad_fees")!.render(params());
    // 100 bps fee x 10% creator cut x 10% referral share = 1 bp of the buy.
    // Reading referralShareBps as a share of the TRADE instead would print
    // 1000 bps — three orders of magnitude out.
    expect(text).toContain("~1.0000 bps of the buy");
    expect(text).not.toContain("~1000.0000 bps of the buy");
  });

  it("scales the referral rate with the creator cut", () => {
    // SAI's 90% creator share is what makes referring a SAI launch worth ~9x
    // referring an INJ one. Same referralShareBps, different creator cut.
    const text = findTopic("shroom_pad_fees")!.render(
      params({
        quotes: [quote({ symbol: "SAI", slot: 3, creatorFeeShareBps: 9000, creatorTakePct: 0.9 })],
      }),
    );
    expect(text).toContain("~9.0000 bps of the buy");
  });

  it("every topic renders non-trivially with full live params", () => {
    for (const topic of TOPICS) {
      const text = topic.render(params());
      expect(text.length, topic.id).toBeGreaterThan(500);
      expect(text, topic.id).not.toContain("{{");
      expect(text, topic.id).not.toContain("undefined");
      expect(text, topic.id).not.toContain("NaN");
    }
  });
});
