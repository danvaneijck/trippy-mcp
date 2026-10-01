import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import { NETWORKS } from "../src/chain/networks.js";
import { PolicySchema } from "../src/config.js";
import { myActivity } from "../src/mcp/tools.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { SpendLedger } from "../src/policy/spend.js";
import { allowedTargetsFor, claimOnlyTargetsFor, exactApprovalSpendersFor, type Runtime } from "../src/runtime.js";
import { V2CreatorFees, type V2LaunchFees } from "../src/venues/choiceV2/creatorFees.js";

/**
 * The creator-fee rail of a Choice v2 graduate: LaunchPoolFeeHook's per-launch
 * credit (current creator only) and the v2 PositionLocker (collect credits the
 * split, claim pays a recipient). Shapes are mainnet's own on 2026-10-01:
 * 10006/10010 owe their creators through the hook, 10000 through the locker.
 */

const NET = NETWORKS.mainnet;
const V2 = NET.choiceV2!;
const HOOK = V2.allowedHooks.find((h) => h.name === "LaunchPoolFeeHook")!.address;
const LOCKER = V2.positionLocker;
const WINJ = V2.winj;
const PROOF: Address = "0x86e8e94F3181b15d11bB0303b88d272AbD4fb00D";
const ME: Address = "0x204Ac1DC67837C9b17F5AF6E5e4be4Bfd0A4104c";

function engine() {
  return new PolicyEngine(
    PolicySchema.parse({}),
    allowedTargetsFor(NET),
    `0x${"11".repeat(20)}`,
    new SpendLedger(mkdtempSync(join(tmpdir(), "trippy-mcp-v2fees-"))),
    exactApprovalSpendersFor(NET),
    claimOnlyTargetsFor(NET),
  );
}

describe("policy: the v2 fee contracts are claim-only", () => {
  it("a claim may call the fee hook and the position locker", () => {
    const p = engine();
    for (const target of [HOOK, LOCKER]) {
      expect(() => p.enforce({ kind: "claim", target, detail: "c" })).not.toThrow();
    }
  });

  it("no trade, swap or approval can be pointed at them", () => {
    const p = engine();
    for (const target of [HOOK, LOCKER]) {
      expect(() => p.enforce({ kind: "swap", target, detail: "s", spendUsd: 1 })).toThrow(/allowlist/);
      expect(() => p.enforce({ kind: "approve", target, detail: "a" })).toThrow(/allowlist/);
    }
    expect(allowedTargetsFor(NET).has(HOOK.toLowerCase())).toBe(false);
  });
});

function fees(over: Partial<V2LaunchFees>): V2LaunchFees {
  return { onchainId: 10_000n, hook: null, locker: null, errors: [], ...over };
}

function claimer(owedAfterCollect: Record<string, bigint> = {}) {
  const writes: { to: string; fn: string; args: readonly unknown[] }[] = [];
  const signer = {
    address: ME,
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === "owed") return owedAfterCollect[String(args[0]).toLowerCase()] ?? 0n;
      throw new Error(`unexpected read ${functionName}`);
    },
    writeTx: async (w: { address: string; functionName: string; args: readonly unknown[] }) => {
      writes.push({ to: w.address, fn: w.functionName, args: w.args });
      return { status: "dry-run" as const, hash: null };
    },
  };
  return { v: new V2CreatorFees(V2, signer as never), writes };
}

const hookOwed = (amount: bigint, claimable: boolean) => ({
  hook: HOOK,
  owed: { currency: WINJ, decimals: 18, amount },
  creator: claimable ? ME : ("0x00000000000000000000000000000000000000c0" as Address),
  claimable,
});

const lockerFees = (mine: boolean, pending: bigint) => ({
  locker: LOCKER,
  tokenId: 18n,
  positionCreator: mine ? ME : ("0x00000000000000000000000000000000000000c0" as Address),
  creatorBps: 7000,
  mine,
  pending: [
    { currency: WINJ, decimals: 18, amount: pending },
    { currency: PROOF, decimals: 18, amount: pending * 1000n },
  ],
  pendingYours: [],
  credited: [],
});

describe("V2CreatorFees.claim", () => {
  it("claims the hook credit when this wallet is the launch's current creator", async () => {
    const { v, writes } = claimer();
    await v.claim([fees({ onchainId: 10_010n, hook: hookOwed(29n, true) })], ME);
    expect(writes).toEqual([{ to: HOOK, fn: "claimCreator", args: [10_010n] }]);
  });

  it("never calls claimCreator for someone else's launch, or on a zero credit", async () => {
    const { v, writes } = claimer();
    await v.claim([fees({ hook: hookOwed(29n, false) }), fees({ hook: hookOwed(0n, true) })], ME);
    expect(writes).toEqual([]);
  });

  it("locker: collect, THEN claim each currency the wallet is credited in", async () => {
    const { v, writes } = claimer({ [WINJ.toLowerCase()]: 7n, [PROOF.toLowerCase()]: 5n });
    await v.claim([fees({ locker: lockerFees(true, 10n) })], ME);
    expect(writes).toEqual([
      { to: LOCKER, fn: "collect", args: [10_000n] },
      { to: LOCKER, fn: "claim", args: [WINJ, ME] },
      { to: LOCKER, fn: "claim", args: [PROOF, ME] },
    ]);
  });

  it("locker: claims ONLY to this wallet — the recipient arg is never anyone else", async () => {
    const { v, writes } = claimer({ [WINJ.toLowerCase()]: 7n });
    await v.claim([fees({ locker: lockerFees(true, 10n) })], ME);
    for (const w of writes.filter((x) => x.fn === "claim")) expect(w.args[1]).toBe(ME);
  });

  it("locker: no collect when nothing is pending, and no claim on a zero credit", async () => {
    const { v, writes } = claimer();
    await v.claim([fees({ locker: lockerFees(true, 0n) })], ME);
    expect(writes).toEqual([]);
  });

  it("locker: never collects a position whose creator leg is someone else", async () => {
    const { v, writes } = claimer({ [WINJ.toLowerCase()]: 7n });
    await v.claim([fees({ locker: lockerFees(false, 10n) })], ME);
    expect(writes).toEqual([]);
  });
});

describe("my_activity lists v2 swaps", () => {
  it("adds this wallet's Choice v2 trades under choiceV2, within the window", async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const seen: string[] = [];
    const trade = (at: string) => ({
      txHash: `0x${at.length}`,
      trader: ME.toLowerCase(),
      tokenIn: { address: WINJ, symbol: "WINJ", decimals: 18 },
      tokenOut: { address: PROOF, symbol: "PROOF", decimals: 18 },
      amountIn: "1",
      amountOut: "1000",
      usdValue: "7.4",
      blockTimestamp: at,
    });
    const rt = {
      signer: { address: ME },
      injAddress: "inj1x",
      pump: {
        profileTrades: async () => ({ items: [] }),
        profile: async () => ({ createdLaunches: [] }),
      },
      choiceApi: { wallet: async () => ({}) },
      choiceV2Api: {
        walletTrades: async (who: string) => {
          seen.push(who);
          return [trade(now), trade(old)];
        },
      },
    } as unknown as Runtime;
    const out = (await myActivity(rt, { days: 30 })) as { choiceV2: Record<string, unknown>[] };
    expect(seen).toEqual([ME]);
    expect(out.choiceV2).toHaveLength(1);
    expect(out.choiceV2[0]).toMatchObject({ venue: "choiceV2", usd: 7.4, untrusted_metadata: { symbolOut: "PROOF" } });
  });
});
