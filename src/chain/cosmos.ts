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
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? s).slice(0, 300);
}
