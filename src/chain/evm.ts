/**
 * The EVM signer — every EVM write in the package funnels through
 * `EvmSigner.writeTx`, which is where policy enforcement, gas handling and
 * the audit trail live.
 *
 * inj-EVM realities baked in (see shroom_launchpad CLAUDE.md + activity-bot):
 *  - gas is billed at LIMIT, not usage → estimate then a small buffer
 *    (default +20%), never flat multi-million limits
 *  - gasPrice is a fixed floor, not an auction — set it explicitly
 *  - receipts lag or go missing on the public RPCs; a missing receipt is NOT
 *    failure — callers pass a `confirm()` closure that re-reads on-chain
 *    state (balance/launch state) as the source of truth
 */

import {
  createPublicClient,
  createWalletClient,
  type Abi,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import type { AuditLog } from "../audit.js";
import { ToolError } from "../errors.js";
import type { PolicyEngine, WriteIntent } from "../policy/policy.js";

const RECEIPT_TIMEOUT_MS = 90_000;
const CONFIRM_POLL_MS = 3_000;
const CONFIRM_POLL_TRIES = 10;

export interface WriteTxOpts {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
  intent: WriteIntent;
  /**
   * Optional state re-read used when the receipt never arrives: return true
   * once on-chain state proves the tx landed. Missing receipt + confirm()
   * true → status "confirmed"; never resubmit on a mere receipt timeout.
   */
  confirm?: () => Promise<boolean>;
}

export interface WriteTxResult {
  hash: `0x${string}` | null;
  status: "confirmed" | "unconfirmed" | "reverted" | "dry-run";
  gasUsed?: string;
}

export class EvmSigner {
  readonly publicClient: PublicClient;
  readonly account: PrivateKeyAccount;
  readonly address: Address;
  private readonly walletClient;

  constructor(
    chain: Chain,
    transport: Transport,
    privateKey: `0x${string}`,
    private readonly policy: PolicyEngine,
    private readonly audit: AuditLog,
    private readonly gasBufferPct: number,
    private readonly gasPriceWei: bigint,
    private readonly dryRun: boolean,
  ) {
    this.publicClient = createPublicClient({ chain, transport });
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address;
    this.walletClient = createWalletClient({ chain, transport, account: this.account });
  }

  async writeTx(opts: WriteTxOpts): Promise<WriteTxResult> {
    const { address, abi, functionName, args, value, intent, confirm } = opts;

    try {
      this.policy.enforce(intent);
    } catch (e) {
      this.audit.append("tx:policy_denied", {
        fn: functionName,
        to: address,
        detail: intent.detail,
        reason: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    // Estimation doubles as a revert preflight with a decoded reason — and as
    // the entire execution in dry-run mode.
    const estimated = await this.publicClient.estimateContractGas({
      account: this.account,
      address,
      abi,
      functionName,
      args,
      ...(value !== undefined ? { value } : {}),
    } as Parameters<PublicClient["estimateContractGas"]>[0]);

    if (this.dryRun) {
      this.audit.append("tx:simulated", { fn: functionName, to: address, detail: intent.detail });
      return { hash: null, status: "dry-run", gasUsed: estimated.toString() };
    }

    const gas = (estimated * BigInt(100 + this.gasBufferPct)) / 100n;
    const hash = await this.walletClient.writeContract({
      address,
      abi,
      functionName,
      args,
      gas,
      gasPrice: this.gasPriceWei,
      ...(value !== undefined ? { value } : {}),
    } as Parameters<(typeof this.walletClient)["writeContract"]>[0]);

    // Spend counts from broadcast — conservative under receipt lag.
    this.policy.recordSpend(intent);
    this.audit.append("tx:broadcast", { fn: functionName, to: address, hash, detail: intent.detail });

    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      if (receipt.status === "success") {
        this.audit.append("tx:confirmed", { hash, gasUsed: receipt.gasUsed.toString() });
        return { hash, status: "confirmed", gasUsed: receipt.gasUsed.toString() };
      }
      this.audit.append("tx:failed", { hash, reason: "reverted" });
      return { hash, status: "reverted" };
    } catch {
      // Receipt never arrived — normal on inj-EVM public RPCs. Re-read state.
      if (confirm) {
        for (let i = 0; i < CONFIRM_POLL_TRIES; i++) {
          try {
            if (await confirm()) {
              this.audit.append("tx:confirmed", { hash, via: "state-reread" });
              return { hash, status: "confirmed" };
            }
          } catch {
            // state read flaked too — keep polling
          }
          await sleep(CONFIRM_POLL_MS);
        }
      }
      this.audit.append("tx:unconfirmed", { hash });
      return { hash, status: "unconfirmed" };
    }
  }

  /** Native INJ transfer — used ONLY by sweep (policy pins the destination). */
  async sendNative(to: Address, value: bigint, intent: WriteIntent): Promise<WriteTxResult> {
    this.policy.enforce(intent);
    if (this.dryRun) return { hash: null, status: "dry-run" };
    const hash = await this.walletClient.sendTransaction({
      to,
      value,
      gas: 100_000n,
      gasPrice: this.gasPriceWei,
      chain: this.walletClient.chain,
      account: this.account,
    });
    this.audit.append("sweep:sent", { to, valueWei: value.toString(), hash });
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      return { hash, status: receipt.status === "success" ? "confirmed" : "reverted" };
    } catch {
      return { hash, status: "unconfirmed" };
    }
  }

  async readContract<T>(opts: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<T> {
    return (await this.publicClient.readContract(
      opts as Parameters<PublicClient["readContract"]>[0],
    )) as T;
  }
}

export function requirePositive(amount: bigint, what: string): void {
  if (amount <= 0n) throw new ToolError("bad_amount", `${what} must be positive`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
