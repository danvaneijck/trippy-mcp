import { afterEach, describe, expect, it } from "vitest";

import type { ApiLaunch, ApiProfileLaunch } from "../src/api/pump.js";
import { NETWORKS } from "../src/chain/networks.js";
import { isWinjDenom, winjBankDenom } from "../src/chain/winj.js";
import { claimFees, portfolio, type PortfolioRow } from "../src/mcp/tools.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { allowedTargetsFor, type Runtime } from "../src/runtime.js";

/**
 * INJ is the one quote asset whose bank denom and ERC20 pair asset are
 * different tokens, and the gap only ever shows on the payout side.
 *
 * `buyNative`/`sellNative` wrap in-contract, so trading never leaves a WINJ
 * balance and nothing here noticed for a long time. But LaunchpadCore settles
 * the CURVE CREATOR FEE in the pair asset — so claiming on an INJ-quoted
 * launch landed WINJ, which cannot pay gas and cannot fund a buy. Worse,
 * `erc20:0x…03FfB` is not `quoteAssets.INJ.bankDenom` ("inj"), so `portfolio`
 * fell through to the Choice pricer, came back `unpriced`, and dropped the
 * entire claim out of `totalUsd`. On the launch this shipped for that was
 * 7.5073 INJ — $42 — reported as an unpriced mystery row.
 *
 * These tests pin both halves: the claim converts it, and a balance that is
 * already wrapped is priced rather than ignored.
 */

const NET = NETWORKS.mainnet;
const WINJ = NET.addresses.winj9;
const WINJ_DENOM = `erc20:${WINJ}`;
const AGENT = `0x${"f8".repeat(20)}`;
const ME = "inj1agent";
/** 7.507330521036336848 WINJ — the real BOOTS creator fee, to the wei. */
const FEE_WEI = 7_507_330_521_036_336_848n;
const INJ_USD = 5.60199953;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface EvmWrite {
  address: string;
  functionName: string;
  args: readonly unknown[];
  intentKind: string;
  intentTarget: string;
}

function rtFor(
  opts: {
    winjBalance?: bigint;
    balanceThrows?: boolean;
    withdrawThrows?: boolean;
    launches?: ApiProfileLaunch[];
  } = {},
): { rt: Runtime; writes: EvmWrite[] } {
  const writes: EvmWrite[] = [];
  let balance = opts.winjBalance ?? 0n;
  const policy = new PolicyEngine(
    {
      tradingEnabled: true,
      perTxCapUsd: 100,
      dailyBudgetUsd: 100,
      maxSlippageBps: 500,
      allowUnpricedSpend: false,
      airdropCapUsd: 0,
    } as never,
    allowedTargetsFor(NET),
    "0xowner",
    { spent: () => 0, record: () => undefined } as never,
  );

  const rt = {
    net: NET,
    policy,
    injAddress: ME,
    signer: {
      address: AGENT,
      readContract: async ({ functionName }: { functionName: string }) => {
        if (opts.balanceThrows) throw new Error("rpc flaked");
        if (functionName === "balanceOf") return balance;
        throw new Error(`unexpected read ${functionName}`);
      },
      writeTx: async (o: {
        address: string;
        functionName: string;
        args: readonly unknown[];
        intent: { kind: string; target: string };
      }) => {
        // The real signer enforces policy INSIDE itself, so a target the engine
        // refuses must never reach a broadcast here either.
        policy.enforce(o.intent as never);
        if (opts.withdrawThrows) throw new Error("execution reverted");
        writes.push({
          address: o.address,
          functionName: o.functionName,
          args: o.args,
          intentKind: o.intent.kind,
          intentTarget: o.intent.target,
        });
        if (o.functionName === "withdraw") balance -= o.args[0] as bigint;
        return { hash: "0xdeadbeef", status: "confirmed" };
      },
    },
    pump: {
      profile: async () => ({
        address: AGENT.toLowerCase(),
        holdings: [],
        createdLaunches: opts.launches ?? [],
      }),
      getLaunch: async (id: string) => {
        const hit = (opts.launches ?? []).find((l) => l.id === id);
        if (!hit) throw new Error("not found");
        return hit as ApiLaunch;
      },
    },
    shroom: {
      usdValue: async (_slot: number, wei: bigint) => (Number(wei) / 1e18) * INJ_USD,
      forLaunch: () => ({
        claimable: async () => ({ creator: [], referral: [], refund: 0n }),
        claimAll: async () => ({
          creatorFees: [],
          referralFees: [],
          refundInj: null,
          txHashes: [],
          notes: ["nothing to claim — all ledgers are zero"],
        }),
      }),
    },
  } as unknown as Runtime;
  return { rt, writes };
}

type ClaimResult = {
  unwrappedInj?: string;
  txHashes: string[];
  notes: string[];
};

describe("isWinjDenom", () => {
  it("matches the bank form of the pair asset", () => {
    expect(winjBankDenom(NET)).toBe(WINJ_DENOM);
    expect(isWinjDenom(NET, WINJ_DENOM)).toBe(true);
  });

  it("matches case-insensitively", () => {
    // The registry checksums the address; a bank denom is whatever the module
    // wrote. A case-sensitive compare here would resurrect the unpriced bug.
    expect(isWinjDenom(NET, WINJ_DENOM.toLowerCase())).toBe(true);
    expect(isWinjDenom(NET, WINJ_DENOM.toUpperCase())).toBe(true);
  });

  it("does NOT match native INJ or another quote's erc20 denom", () => {
    expect(isWinjDenom(NET, "inj")).toBe(false);
    // USDC's bank denom IS its erc20 form — it must not be swept into unwrap.
    expect(isWinjDenom(NET, NET.quoteAssets.USDC!.bankDenom)).toBe(false);
  });
});

describe("claim_fees unwraps the curve fee", () => {
  it("withdraws the whole WINJ balance to native INJ", async () => {
    const { rt, writes } = rtFor({ winjBalance: FEE_WEI });
    const res = (await claimFees(rt, {})) as ClaimResult;

    const withdraw = writes.find((w) => w.functionName === "withdraw");
    expect(withdraw).toBeDefined();
    expect(withdraw!.address.toLowerCase()).toBe(WINJ.toLowerCase());
    expect(withdraw!.args[0]).toBe(FEE_WEI);
    expect(res.unwrappedInj).toBe("7.507330521036336848");
    expect(res.txHashes).toContain("0xdeadbeef");
  });

  it("rides the uncapped `claim` intent, and WINJ9 is already allowlisted", () => {
    // The point of filing it as `claim`: a withdraw takes no destination and is
    // 1:1 into the same wallet, so it is not spend-bearing. It also means this
    // adds NO address to the policy engine — WINJ9 was already there for the
    // pair-asset approvals.
    expect(allowedTargetsFor(NET).has(WINJ.toLowerCase())).toBe(true);
    const { rt } = rtFor({ winjBalance: FEE_WEI });
    expect(() =>
      rt.policy.enforce({ kind: "claim", target: WINJ, detail: "unwrap" } as never),
    ).not.toThrow();
  });

  it("broadcasts nothing when the balance is zero", async () => {
    const { rt, writes } = rtFor({ winjBalance: 0n });
    const res = (await claimFees(rt, {})) as ClaimResult;
    expect(writes).toHaveLength(0);
    expect(res.unwrappedInj).toBeUndefined();
    expect(res.notes.join(" ")).toContain("nothing to claim");
  });

  it("leaves it wrapped when the caller says unwrap:false", async () => {
    const { rt, writes } = rtFor({ winjBalance: FEE_WEI });
    const res = (await claimFees(rt, { unwrap: false })) as ClaimResult;
    expect(writes).toHaveLength(0);
    expect(res.unwrappedInj).toBeUndefined();
  });

  it("preview reports what WOULD be unwrapped and signs nothing", async () => {
    const { rt, writes } = rtFor({ winjBalance: FEE_WEI });
    const res = (await claimFees(rt, { preview: true })) as ClaimResult;
    expect(writes).toHaveLength(0);
    expect(res.unwrappedInj).toBe("7.507330521036336848");
    expect(res.notes.join(" ")).toContain("would be unwrapped");
    expect(res.txHashes).toHaveLength(0);
  });
});

describe("a failed unwrap never fails the claim", () => {
  it("reports the fees as claimed, still wrapped, when withdraw reverts", async () => {
    // The fees ARE in the wallet at this point — the core ledger already paid.
    // Throwing here would report a successful claim as a failure and invite a
    // retry against an empty ledger.
    const { rt } = rtFor({ winjBalance: FEE_WEI, withdrawThrows: true });
    const res = (await claimFees(rt, {})) as ClaimResult;
    expect(res.unwrappedInj).toBeUndefined();
    expect(res.notes.join(" ")).toContain("as wrapped INJ");
  });

  it("says so when the balance read itself flakes", async () => {
    const { rt } = rtFor({ balanceThrows: true });
    const res = (await claimFees(rt, {})) as ClaimResult;
    expect(res.notes.join(" ")).toContain("could not read the WINJ balance");
  });
});

describe("portfolio prices a wrapped balance", () => {
  function lcdWith(balances: { denom: string; amount: string }[]) {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/cosmos/bank/v1beta1/balances/")) return Response.json({ balances });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("counts WINJ in totalUsd instead of dropping it as unpriced", async () => {
    // The regression: this row used to arrive `pricedVia: "unpriced"`,
    // `valueUsd: null`, and vanish from the wallet total entirely.
    lcdWith([{ denom: WINJ_DENOM, amount: FEE_WEI.toString() }]);
    const { rt } = rtFor();
    const res = (await portfolio(rt)) as { holdings: PortfolioRow[]; totalUsd: number };

    const winj = res.holdings.find((h) => h.denom === WINJ_DENOM);
    expect(winj).toBeDefined();
    expect(winj!.symbol).toBe("WINJ");
    expect(winj!.pricedVia).toBe("quote-rate");
    expect(winj!.amount).toBeCloseTo(7.50733052, 6);
    expect(winj!.valueUsd).toBeCloseTo(7.50733052 * INJ_USD, 4);
    expect(res.totalUsd).toBeCloseTo(7.50733052 * INJ_USD, 4);
  });

  it("flags it as wrapped, because it cannot pay gas or fund a buy", async () => {
    lcdWith([{ denom: WINJ_DENOM, amount: FEE_WEI.toString() }]);
    const { rt } = rtFor();
    const res = (await portfolio(rt)) as { holdings: PortfolioRow[] };
    expect(res.holdings.find((h) => h.denom === WINJ_DENOM)!.wrappedInj).toBe(true);
  });

  it("still reports native INJ separately — they are two balances, not one", async () => {
    lcdWith([
      { denom: WINJ_DENOM, amount: FEE_WEI.toString() },
      { denom: "inj", amount: "4426927524809110704" },
    ]);
    const { rt } = rtFor();
    const res = (await portfolio(rt)) as { holdings: PortfolioRow[]; totalUsd: number };
    expect(res.holdings.map((h) => h.symbol).sort()).toEqual(["INJ", "WINJ"]);
    expect(res.totalUsd).toBeCloseTo((7.50733052 + 4.42692752) * INJ_USD, 3);
  });
});
