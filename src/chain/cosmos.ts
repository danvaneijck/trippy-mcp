/**
 * Cosmos-side signer for CosmWasm executes.
 *
 * Signs with the SAME secp256k1 key the EVM leg uses — the inj address is the
 * bech32 of the same 20 bytes — via MsgBroadcasterWithPk (direct proto sign,
 * simulate first).
 *
 * The reason this is a class and not a helper: `enforce()` runs HERE, between
 * building the message and handing it to the broadcaster, exactly like
 * chain/evm.ts does for the EVM path. Policy that lives in the tool layer is
 * policy a tool-wiring mistake can skip; policy in the signer is policy that
 * every caller pays, including ones written later by someone who did not read
 * this comment.
 *
 * @injectivelabs/sdk-ts is heavy, so it is imported lazily — an install that
 * only ever reads never pays for it.
 */

import type { AuditLog } from "../audit.js";
import { ToolError } from "../errors.js";
import type { PolicyEngine, WriteIntent } from "../policy/policy.js";
import type { NetworkDef } from "./networks.js";

export interface CosmosExecuteMsg {
  contract: string;
  msg: object;
  funds?: { denom: string; amount: string }[];
}

export interface CosmosTxResult {
  txHash: string | null;
  status: "broadcast" | "dry-run";
  /** Raw broadcast response — event parsing needs it. */
  raw: unknown;
}

/**
 * The policy target a push airdrop declares.
 *
 * A MsgMultiSend executes no contract, so there is no address for the target
 * allowlist to check — but the allowlist is not optional, and quietly exempting
 * a whole message type from it would be exactly the hole worth having it for.
 * So the bank path gets a NAMED target instead: it is on the allowlist (added
 * in runtime.ts), it is obviously not an address, and reaching it still
 * requires an `airdrop` intent, which `airdropCapUsd` governs.
 */
export const BANK_MULTISEND_TARGET = "bank:multisend";

export interface MultiSendOutput {
  address: string;
  /** Base units. */
  amount: string;
}

/**
 * Gas headroom for a multisend chunk. A bank output costs a dead-linear
 * ~44k gas, so the simulate is accurate — but it occasionally lands just over
 * the default 1.1x, and gas is charged on use rather than on the limit, so a
 * wider buffer costs nothing and removes the failure mode.
 */
const MULTISEND_GAS_BUFFER = 1.3;

export class CosmosSigner {
  constructor(
    private readonly net: NetworkDef,
    private readonly policy: PolicyEngine,
    private readonly audit: AuditLog,
    private readonly getPrivateKey: () => `0x${string}`,
    readonly address: string,
    private readonly dryRun: boolean,
  ) {}

  /**
   * Enforce, then sign and broadcast. `intent.target` must be the contract the
   * messages execute — the allowlist check is what stops this from being a
   * general-purpose "execute any contract" primitive.
   */
  async execute(
    msgs: CosmosExecuteMsg[],
    opts: { intent: WriteIntent; memo?: string },
  ): Promise<CosmosTxResult> {
    if (msgs.length === 0) throw new ToolError("bad_input", "no messages to broadcast");

    // Defence in depth: enforce() checks the intent's declared target, so a
    // caller that declared one contract and built messages for another would
    // slip past it. Verify the messages match what was enforced.
    const target = opts.intent.target.toLowerCase();
    for (const m of msgs) {
      if (m.contract.toLowerCase() !== target) {
        throw new ToolError(
          "intent_mismatch",
          `refusing to sign: message executes ${m.contract} but the policy check was made against ${opts.intent.target}`,
        );
      }
    }

    this.policy.enforce(opts.intent);

    if (this.dryRun) {
      this.audit.append("tx:simulated", {
        chain: "cosmos",
        target: opts.intent.target,
        detail: opts.intent.detail,
      });
      return { txHash: null, status: "dry-run", raw: null };
    }

    const [{ MsgExecuteContractCompat, MsgBroadcasterWithPk }, { Network, getNetworkEndpoints }] =
      await Promise.all([import("@injectivelabs/sdk-ts"), import("@injectivelabs/networks")]);

    const network = this.net.name === "mainnet" ? Network.MainnetSentry : Network.TestnetSentry;
    const built = msgs.map((m) =>
      MsgExecuteContractCompat.fromJSON({
        sender: this.address,
        contractAddress: m.contract,
        msg: m.msg,
        funds: m.funds ?? [],
      }),
    );

    try {
      const broadcaster = new MsgBroadcasterWithPk({
        privateKey: this.getPrivateKey(),
        network,
        endpoints: getNetworkEndpoints(network),
        simulateTx: true,
        gasBufferCoefficient: 1.1,
      });
      const result = await broadcaster.broadcast({
        msgs: built,
        ...(opts.memo ? { memo: opts.memo } : {}),
      });
      this.policy.recordSpend(opts.intent);
      this.audit.append("tx:broadcast", {
        chain: "cosmos",
        txHash: result.txHash,
        target: opts.intent.target,
        detail: opts.intent.detail,
        spendUsd: opts.intent.spendUsd ?? null,
      });
      return { txHash: result.txHash, status: "broadcast", raw: result };
    } catch (e) {
      this.audit.append("tx:failed", {
        chain: "cosmos",
        target: opts.intent.target,
        detail: opts.intent.detail,
        reason: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
      throw new ToolError(
        "broadcast_failed",
        `broadcast failed: ${firstLine(e instanceof Error ? e.message : String(e))}`,
        "the pre-broadcast simulate rejects bad messages before gas is spent — check balances and inputs",
      );
    }
  }

  /**
   * One balanced MsgMultiSend: the push-airdrop leg.
   *
   * Separate from `execute` rather than folded into it because the two need
   * different invariants checked before signing. `execute` verifies that the
   * messages target the contract the policy check named; there is no contract
   * here, so what gets verified instead is that the intent really is an airdrop
   * against the named bank target, and that the declared input equals the sum
   * of the outputs — the bank module rejects an unbalanced multisend, and
   * discovering that in a simulate after the policy has already recorded a
   * spend is a worse place to find out.
   */
  async bankMultiSend(
    p: { denom: string; outputs: MultiSendOutput[] },
    opts: { intent: WriteIntent; memo?: string },
  ): Promise<CosmosTxResult> {
    if (p.outputs.length === 0) throw new ToolError("bad_input", "no recipients to send to");
    if (opts.intent.kind !== "airdrop" || opts.intent.target !== BANK_MULTISEND_TARGET) {
      throw new ToolError(
        "intent_mismatch",
        `refusing to sign a bank multisend under a ${opts.intent.kind} intent targeting ${opts.intent.target}`,
      );
    }

    let total = 0n;
    for (const o of p.outputs) {
      const amount = BigInt(o.amount);
      if (amount <= 0n) {
        throw new ToolError("bad_input", `refusing to send ${o.amount} to ${o.address}`);
      }
      total += amount;
    }

    this.policy.enforce(opts.intent);

    if (this.dryRun) {
      this.audit.append("tx:simulated", {
        chain: "cosmos",
        target: opts.intent.target,
        detail: opts.intent.detail,
      });
      return { txHash: null, status: "dry-run", raw: null };
    }

    const [{ MsgMultiSend, MsgBroadcasterWithPk }, { Network, getNetworkEndpoints }] =
      await Promise.all([import("@injectivelabs/sdk-ts"), import("@injectivelabs/networks")]);

    const network = this.net.name === "mainnet" ? Network.MainnetSentry : Network.TestnetSentry;
    const msg = MsgMultiSend.fromJSON({
      inputs: [{ address: this.address, coins: [{ denom: p.denom, amount: total.toString() }] }],
      outputs: p.outputs.map((o) => ({
        address: o.address,
        coins: [{ denom: p.denom, amount: o.amount }],
      })),
    });

    const broadcaster = new MsgBroadcasterWithPk({
      privateKey: this.getPrivateKey(),
      network,
      endpoints: getNetworkEndpoints(network),
      simulateTx: true,
      gasBufferCoefficient: MULTISEND_GAS_BUFFER,
    });
    const tx = { msgs: [msg], ...(opts.memo ? { memo: opts.memo } : {}) };

    // Simulate EXPLICITLY first, and report a simulate failure with its own
    // code. `broadcast` would simulate anyway, but it collapses both failures
    // into one error — and the push rail has to tell them apart, because they
    // demand opposite responses. A rejected simulation never signed anything:
    // no sequence was consumed and nothing can land, so the caller is free to
    // split the batch and retry immediately. A failed broadcast may be sitting
    // in the mempool, and the caller must resolve it before resending anything.
    //
    // This is the common case, not an edge case: a bank-blocked recipient is
    // refused during simulation, which is precisely why one bad address takes
    // its whole batch down.
    try {
      await broadcaster.simulate(tx);
    } catch (e) {
      this.audit.append("tx:failed", {
        chain: "cosmos",
        target: opts.intent.target,
        detail: opts.intent.detail,
        reason: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
      throw new ToolError(
        "simulate_rejected",
        `multisend rejected before signing: ${firstLine(e instanceof Error ? e.message : String(e))}`,
        "nothing was signed or broadcast, so no funds moved and no account sequence was used",
      );
    }

    try {
      const result = await broadcaster.broadcast(tx);
      this.policy.recordSpend(opts.intent);
      this.audit.append("tx:broadcast", {
        chain: "cosmos",
        txHash: result.txHash,
        target: opts.intent.target,
        detail: opts.intent.detail,
        spendUsd: opts.intent.spendUsd ?? null,
      });
      return { txHash: result.txHash, status: "broadcast", raw: result };
    } catch (e) {
      this.audit.append("tx:failed", {
        chain: "cosmos",
        target: opts.intent.target,
        detail: opts.intent.detail,
        reason: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
      // Deliberately NOT wrapped in a "the funds did not move" hint the way
      // `execute` is: the caller has to resolve whether this landed before it
      // decides anything, and a reassuring message here would encourage the
      // one response that double-pays.
      throw new ToolError(
        "broadcast_failed",
        `multisend broadcast failed: ${firstLine(e instanceof Error ? e.message : String(e))}`,
      );
    }
  }
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? s).slice(0, 300);
}
