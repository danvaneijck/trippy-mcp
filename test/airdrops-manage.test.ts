import { describe, expect, it } from "vitest";

import { applyVoteOptions, type SourceRow } from "../src/airdrops/allocate.js";
import { BLOCK_MS, seedHeight } from "../src/airdrops/blocks.js";
import type { Campaign } from "../src/airdrops/contract.js";
import {
  clawbackMsg,
  expiryMs,
  freezeMsg,
  isExpired,
  manageActions,
  MIN_WIND_DOWN_MS,
  setCampaignPausedMsg,
  setExpiryMsg,
} from "../src/airdrops/manage.js";
import { normalizeVoteOption } from "../src/airdrops/sources.js";
import { mapPrefix, startsWith } from "../src/airdrops/wasm.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const nanosAt = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  creator: "inj1creator",
  keeper: null,
  streaming: false,
  denom: "inj",
  meta: "{}",
  leaves_uri: "https://example.test/leaves/abc.json",
  root: "abc",
  total: "1000",
  claimed_total: "250",
  claimants: 3,
  frozen: true,
  expiry: nanosAt(NOW + 10 * 86_400_000),
  paused: false,
  swept: false,
  ...over,
});

describe("manage rules — the contract's own preconditions, checked locally", () => {
  it("refuses every action to a wallet that is not the creator", () => {
    const a = manageActions(campaign(), "750", NOW, false);
    for (const key of ["freeze", "pause", "set_expiry", "clawback"] as const) {
      expect(a[key].enabled, key).toBe(false);
      expect(a[key].reason, key).toMatch(/creator/);
    }
  });

  it("allows clawback only once the expiry has actually passed", () => {
    const dated = campaign({ expiry: nanosAt(NOW + 86_400_000) });
    expect(manageActions(dated, "750", NOW, true).clawback.enabled).toBe(false);
    expect(manageActions(dated, "750", NOW, true).clawback.reason).toMatch(/after the expiry/);

    // One millisecond past it is past it.
    const at = expiryMs(dated) as number;
    expect(manageActions(dated, "750", at, true).clawback.enabled).toBe(true);
    expect(manageActions(dated, "750", at, true).clawback.amountBase).toBe("750");
    expect(isExpired(dated, at - 1)).toBe(false);
    expect(isExpired(dated, at)).toBe(true);
  });

  it("a perpetual drop cannot be clawed back — it must be given an expiry first", () => {
    const perpetual = campaign({ expiry: null, frozen: false });
    const a = manageActions(perpetual, "750", NOW, true);
    expect(a.clawback.enabled).toBe(false);
    expect(a.clawback.reason).toMatch(/set an expiry first/);
    // ...and that wind-down carries the contract's 7-day minimum notice.
    expect(a.set_expiry.enabled).toBe(true);
    expect(a.set_expiry.earliestMs).toBe(NOW + MIN_WIND_DOWN_MS);
  });

  it("a FROZEN perpetual drop is permanent — no expiry, so no clawback, ever", () => {
    // This is the trap `perpetual: true` sets, and the one the preview warns
    // about: freeze + no expiry is an irrevocable promise, not a default.
    const a = manageActions(campaign({ expiry: null, frozen: true }), "750", NOW, true);
    expect(a.set_expiry.enabled).toBe(false);
    expect(a.set_expiry.reason).toMatch(/permanent/);
    expect(a.set_expiry.earliestMs).toBeNull();
    expect(a.clawback.enabled).toBe(false);
  });

  it("an expiry only extends — the earliest acceptable is one ms past the current one", () => {
    const c = campaign();
    const a = manageActions(c, "750", NOW, true);
    expect(a.set_expiry.enabled).toBe(true);
    expect(a.set_expiry.earliestMs).toBe((expiryMs(c) as number) + 1);
  });

  it("a swept campaign is closed for good", () => {
    const a = manageActions(campaign({ swept: true }), "0", NOW + 1e10, true);
    expect(a.clawback.enabled).toBe(false);
    expect(a.clawback.reason).toMatch(/already clawed back/);
    expect(a.pause.enabled).toBe(false);
    expect(a.set_expiry.enabled).toBe(false);
  });

  it("freeze is unavailable on a drop this rail created, because it is born frozen", () => {
    expect(manageActions(campaign(), "750", NOW, true).freeze.enabled).toBe(false);
    // An unfrozen campaign with a published root can still be frozen...
    expect(manageActions(campaign({ frozen: false }), "750", NOW, true).freeze.enabled).toBe(true);
    // ...but there is nothing to freeze before a root exists.
    const unpublished = manageActions(campaign({ frozen: false, root: null }), "0", NOW, true);
    expect(unpublished.freeze.enabled).toBe(false);
    expect(unpublished.freeze.reason).toMatch(/no root/);
  });

  it("pause stays available while the campaign is live, in both directions", () => {
    expect(manageActions(campaign(), "750", NOW, true).pause.enabled).toBe(true);
    expect(manageActions(campaign({ paused: true }), "750", NOW, true).pause.enabled).toBe(true);
  });
});

describe("manage messages — shapes the contract accepts", () => {
  it("match ExecuteMsg exactly", () => {
    expect(freezeMsg(7)).toEqual({ freeze: { id: 7 } });
    expect(clawbackMsg(7)).toEqual({ clawback: { id: 7 } });
    expect(setCampaignPausedMsg(7, false)).toEqual({
      set_campaign_paused: { id: 7, paused: false },
    });
    expect(setExpiryMsg(7, "1")).toEqual({ set_expiry: { id: 7, expiry: "1" } });
  });
});

describe("gov vote options", () => {
  it("accepts the short forms an agent will actually type", () => {
    expect(normalizeVoteOption("yes")).toBe("VOTE_OPTION_YES");
    expect(normalizeVoteOption("No")).toBe("VOTE_OPTION_NO");
    expect(normalizeVoteOption("no with veto")).toBe("VOTE_OPTION_NO_WITH_VETO");
    expect(normalizeVoteOption("no-with-veto")).toBe("VOTE_OPTION_NO_WITH_VETO");
    expect(normalizeVoteOption("veto")).toBe("VOTE_OPTION_NO_WITH_VETO");
    expect(normalizeVoteOption("VOTE_OPTION_ABSTAIN")).toBe("VOTE_OPTION_ABSTAIN");
  });

  it("filters by vote, and is a no-op on rows that carry no vote", () => {
    const rows: SourceRow[] = [
      { address: "inj1a", weight: 1, voteOption: "VOTE_OPTION_YES" },
      { address: "inj1b", weight: 1, voteOption: "VOTE_OPTION_NO" },
    ];
    expect(applyVoteOptions(rows, ["VOTE_OPTION_YES"]).map((r) => r.address)).toEqual(["inj1a"]);
    expect(applyVoteOptions(rows, [])).toHaveLength(2);
    // A token snapshot has no votes — the filter must not empty the drop.
    const holders: SourceRow[] = [{ address: "inj1a", weight: 5 }];
    expect(applyVoteOptions(holders, ["VOTE_OPTION_YES"])).toHaveLength(1);
  });
});

describe("block finder seeding", () => {
  const latest = { height: 180_000_000, timeMs: Date.parse("2026-08-02T12:00:00Z"), timeIso: "" };

  it("walks back one block per block-interval", () => {
    const hourAgo = latest.timeMs - 3_600_000;
    expect(seedHeight(latest, hourAgo)).toBe(latest.height - Math.round(3_600_000 / BLOCK_MS));
  });

  it("never seeds outside the chain", () => {
    expect(seedHeight(latest, latest.timeMs + 1e12)).toBe(latest.height);
    expect(seedHeight(latest, latest.timeMs - 1e15)).toBe(1);
  });
});

describe("cw-storage-plus map prefixes", () => {
  it("builds the 0x00 <len> <namespace> prefix the contract writes under", () => {
    // 000762616c616e6365 — the literal the site's CW404 scanner matches on.
    expect(Buffer.from(mapPrefix("balance")).toString("hex")).toBe("000762616c616e6365");
    expect(Buffer.from(mapPrefix("user_round_info")).toString("hex")).toBe(
      "000f757365725f726f756e645f696e666f",
    );
  });

  it("the length byte keeps one namespace from matching another's prefix", () => {
    // Without it, "balance" would prefix-match every "balance2" key and the
    // scan would fold a different map's rows into the holder list.
    expect(startsWith(mapPrefix("balance2"), mapPrefix("balance"))).toBe(false);
    const entry = new Uint8Array([...mapPrefix("balance"), 0x69, 0x6e, 0x6a]);
    expect(startsWith(entry, mapPrefix("balance"))).toBe(true);
  });
});
