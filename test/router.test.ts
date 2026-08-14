import { describe, expect, it } from "vitest";

import type { ApiLaunch } from "../src/api/pump.js";
import { encodeMetadataUri } from "../src/metadata.js";
import { resolveToken } from "../src/router.js";
import type { Runtime } from "../src/runtime.js";
import { LaunchState } from "../src/venues/shroom/abi.js";

function launch(id: string, symbol: string, name: string, over: Partial<ApiLaunch> = {}): ApiLaunch {
  return {
    id,
    creator: "0xcreator",
    token: `0xtoken${id}`,
    quoteAsset: 0,
    metadataURI: encodeMetadataUri({ name, symbol, description: `the ${name} memecoin` }),
    createdAt: "2026-07-01T00:00:00.000Z",
    state: LaunchState.Trading,
    realPair: "0",
    tokensSold: "0",
    bankDenom: null,
    tradeFeeBps: 100,
    creatorFeeShareBps: 9000,
    graduationTarget: 10000,
    graduatedPoolAddress: null,
    graduatedPoolDenom: null,
    volume24h: "0",
    lastTradedAt: null,
    holderCount: "2",
    userHolderCount: "2",
    hidden: false,
    featured: false,
    flagged: false,
    ...over,
  };
}

type ChoiceMatch = { address?: string; symbol?: string; name?: string };

/** Runtime stub exposing only what resolveToken touches. */
function rt(opts: { launches?: ApiLaunch[]; choice?: ChoiceMatch[] }): Runtime {
  return {
    pump: {
      listLaunches: async () => ({ items: opts.launches ?? [] }),
      getLaunch: async (id: string) => {
        const hit = (opts.launches ?? []).find((l) => l.id === String(id));
        if (!hit) throw new Error("not found");
        return hit;
      },
    },
    choiceApi: {
      resolve: async () => ({ matches: opts.choice ?? [], ambiguous: (opts.choice ?? []).length > 1 }),
    },
  } as unknown as Runtime;
}

describe("resolveToken symbol matching", () => {
  it("prefers a Choice token whose symbol IS the query over a fuzzy launch name match", async () => {
    // The real defect: the launchpad substring-matches "ANSHROOM" for a "SHROOM" query
    // and, being the only hit, used to win outright — so quote/buy/sell silently
    // targeted a 2-holder curve launch instead of the graduated SHROOM token.
    const target = await resolveToken(
      rt({
        launches: [launch("9", "ANSHROOM", "The Blue Bull on Injective")],
        choice: [{ address: "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8", symbol: "SHROOM", name: "Shroom" }],
      }),
      "SHROOM",
    );
    expect(target.venue).toBe("choice");
    expect(target).toMatchObject({ tokenId: "inj1300xcg9naqy00fujsr9r8alwk7dh65uqu87xm8" });
  });

  it("still routes to the launch when the query IS its symbol", async () => {
    const target = await resolveToken(
      rt({ launches: [launch("9", "ANSHROOM", "The Blue Bull on Injective")] }),
      "anshroom",
    );
    expect(target.venue).toBe("curve");
    expect(target).toMatchObject({ launchId: 9n });
  });

  it("routes an exact-symbol launch even when the launchpad also returns fuzzy siblings", async () => {
    const target = await resolveToken(
      rt({
        launches: [
          launch("9", "ANSHROOM", "The Blue Bull on Injective"),
          launch("13", "SHROOM", "Shroom Pad"),
        ],
      }),
      "SHROOM",
    );
    expect(target).toMatchObject({ venue: "curve", launchId: 13n });
  });

  it("takes a lone fuzzy launch when Choice knows nothing better", async () => {
    const target = await resolveToken(
      rt({ launches: [launch("11", "BERB", "canary in a coal mine")] }),
      "canary",
    );
    expect(target).toMatchObject({ venue: "curve", launchId: 11n });
  });

  it("surfaces both venues' near-misses instead of guessing", async () => {
    const target = await resolveToken(
      rt({
        launches: [launch("9", "ANSHROOM", "The Blue Bull on Injective")],
        choice: [{ address: "inj1other", symbol: "SHROOMX", name: "Shroom Copy" }],
      }),
      "shroo",
    );
    expect(target.venue).toBe("ambiguous");
    const candidates = (target as { candidates: Record<string, unknown>[] }).candidates;
    expect(candidates.map((c) => c.symbol)).toEqual(["ANSHROOM", "SHROOMX"]);
    // Candidates carry the symbol, not a truncated data: URI.
    expect(candidates.every((c) => !("metadataURI" in c))).toBe(true);
  });

  it("routes a graduated exact-symbol launch to its bank denom on Choice", async () => {
    const graduated = launch("13", "SKIBI", "SKIBIDI", {
      state: LaunchState.Graduated,
      graduatedPoolDenom: "factory/inj13j2/shroom_13_f9ac",
    });
    const target = await resolveToken(rt({ launches: [graduated] }), "SKIBI");
    expect(target).toMatchObject({ venue: "choice", tokenId: "factory/inj13j2/shroom_13_f9ac" });
  });

  it("treats bank denoms and launch ids as unambiguous without any lookup", async () => {
    const denom = "factory/inj13j2/shroom_13_f9ac";
    expect(await resolveToken(rt({}), denom)).toMatchObject({ venue: "choice", tokenId: denom });
    expect(await resolveToken(rt({ launches: [launch("14", "SYN", "Galactic")] }), "14")).toMatchObject({
      venue: "curve",
      launchId: 14n,
    });
  });

  it("refuses to pick when a launch and a Choice token BOTH answer to the symbol", async () => {
    // Launch metadata is author-supplied, so a launch can declare "SAI" and the
    // pad hit would otherwise win outright — spending funds on an impostor
    // rather than the established token the caller named.
    const target = await resolveToken(
      rt({
        launches: [launch("99", "SAI", "definitely the real sai")],
        choice: [
          {
            address: "factory/inj10aa0h5s0xwzv95a8pjhwluxcm5feeqygdk3lkm/SAI",
            symbol: "SAI",
            name: "SAI",
          },
        ],
      }),
      "SAI",
    );
    expect(target.venue).toBe("ambiguous");
    const candidates = (target as { candidates: Record<string, unknown>[] }).candidates;
    expect(candidates.map((c) => c.venue)).toEqual(["curve", "choice"]);
  });

  it("does not fall back to bankDenom for a graduated launch — that is its QUOTE asset", async () => {
    // bankDenom is SAI on every mainnet launch. Routing a graduated token to it
    // would resolve `buy SKIBI` to SAI and buy the wrong asset outright, so an
    // unindexed graduation stays on the curve branch where tools explain it.
    const graduated = launch("13", "SKIBI", "SKIBIDI", {
      state: LaunchState.Graduated,
      graduatedPoolDenom: null,
      bankDenom: "factory/inj10aa0h5s0xwzv95a8pjhwluxcm5feeqygdk3lkm/SAI",
    });
    const target = await resolveToken(rt({ launches: [graduated] }), "SKIBI");
    expect(target).toMatchObject({ venue: "curve", launchId: 13n });
    expect(target).not.toMatchObject({ venue: "choice" });
  });
});
