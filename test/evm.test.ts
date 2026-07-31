import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineChain, http } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditLog } from "../src/audit.js";
import { EvmSigner } from "../src/chain/evm.js";
import { PolicySchema } from "../src/config.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { SpendLedger } from "../src/policy/spend.js";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const KEY = `0x${"11".repeat(32)}` as const;
const HASH = `0x${"ab".repeat(32)}` as const;

const chain = defineChain({
  id: 1776,
  name: "test",
  nativeCurrency: { name: "INJ", symbol: "INJ", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
});

function makeSigner() {
  const dir = mkdtempSync(join(tmpdir(), "trippy-mcp-test-"));
  const policy = new PolicyEngine(PolicySchema.parse({}), new Set(), OWNER, new SpendLedger(dir));
  const signer = new EvmSigner(
    chain,
    http(),
    KEY,
    policy,
    new AuditLog(dir),
    20,
    160_000_000n,
    false,
  );
  // Never hit the (dead) RPC: broadcast succeeds, receipt times out.
  (signer as unknown as { walletClient: { sendTransaction: () => Promise<string> } }).walletClient
    .sendTransaction = async () => HASH;
  (signer.publicClient as { waitForTransactionReceipt: () => Promise<never> })
    .waitForTransactionReceipt = async () => {
      throw new Error("receipt timeout");
    };
  return signer;
}

const intent = { kind: "sweep" as const, target: OWNER, detail: "test sweep" };

describe("EvmSigner.sendNative receipt-lag fallback", () => {
  afterEach(() => vi.useRealTimers());

  it("confirms via state reread when the receipt never arrives", async () => {
    const signer = makeSigner();
    const res = await signer.sendNative(OWNER, 1n, intent, async () => true);
    expect(res).toEqual({ hash: HASH, status: "confirmed" });
  });

  it("reports unconfirmed without a confirm closure", async () => {
    const signer = makeSigner();
    const res = await signer.sendNative(OWNER, 1n, intent);
    expect(res).toEqual({ hash: HASH, status: "unconfirmed" });
  });

  it("reports unconfirmed when the state reread never proves the send", async () => {
    vi.useFakeTimers();
    const signer = makeSigner();
    const pending = signer.sendNative(OWNER, 1n, intent, async () => false);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ hash: HASH, status: "unconfirmed" });
  });
});
