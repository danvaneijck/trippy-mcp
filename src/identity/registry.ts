/**
 * Typed client over the ERC-8004 identity registry.
 *
 * Every write goes through `EvmSigner.writeTx`, so the policy engine sees it
 * like any other EVM write — the registry has to be on `allowedTargets` or the
 * call is refused before it is signed (see runtime.ts).
 *
 * Three contract behaviours were MEASURED on testnet (2026-08-14) rather than
 * assumed, and each one changed the design:
 *
 *  1. `register` ALREADY LINKS the wallet: `getAgentWallet(id)` returns
 *     `msg.sender` immediately after minting, with no `setAgentWallet` call.
 *     Registration is therefore ONE transaction (378,790 gas), not two.
 *  2. `safeTransferFrom` CLEARS the link back to `address(0)` — confirmed for
 *     both an auto-linked wallet and one explicitly pointed elsewhere. So
 *     handing custody to the operator always costs the attribution until it is
 *     re-established, and it can only be re-established BY the new owner.
 *  3. the wallet-link signature expires within 300s (see abi.ts).
 */

import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

import type { EvmSigner, WriteTxResult } from "../chain/evm.js";
import type { NetworkDef } from "../chain/networks.js";
import { ToolError } from "../errors.js";
import {
  DEFAULT_WALLET_LINK_DEADLINE_SECS,
  IDENTITY_REGISTRY_ABI,
  MAX_WALLET_LINK_DEADLINE_SECS,
  WALLET_LINK_DOMAIN_NAME,
  WALLET_LINK_DOMAIN_VERSION,
  WALLET_LINK_TYPES,
} from "./abi.js";
import { AGENT_TYPE, BUILDER_CODE } from "./card.js";

/** Where the identity sits relative to this agent's own key. */
export type Custody =
  /** owner == this agent: registered but custody not handed over yet. */
  | "agent"
  /** owner is someone else, wallet == this agent: the target topology. */
  | "owner"
  /** wallet == 0x0: transferred and not yet re-linked — trades are unattributable. */
  | "unlinked"
  /** neither owner nor wallet is this agent — not ours in any useful sense. */
  | "foreign";

export interface IdentityView {
  agentId: string;
  owner: Address;
  agentWallet: Address;
  cardUri: string;
  builderCode: string;
  agentType: string;
  custody: Custody;
  chainId: number;
  registry: Address;
  identityTuple: string;
  scanUrl: string;
}

export interface WalletLink {
  agentId: string;
  /** The wallet being linked — this agent. */
  newWallet: Address;
  /** The address that must SUBMIT the tx; the signature is bound to it. */
  owner: Address;
  /** Unix seconds. */
  deadline: number;
  signature: Hex;
  /** Seconds left at mint time, for the operator's countdown. */
  ttlSecs: number;
}

const STRING_PARAM = parseAbiParameters("string");

export class IdentityRegistry {
  constructor(
    private readonly net: NetworkDef,
    private readonly signer: EvmSigner,
  ) {}

  get address(): Address {
    const a = this.net.erc8004.identityRegistry;
    if (!a) {
      throw new ToolError(
        "no_registry",
        `no ERC-8004 identity registry is deployed for ${this.net.name}`,
        "the on-chain agent registry exists on Injective mainnet and testnet only",
      );
    }
    return a as Address;
  }

  /** Whether this network has a registry at all — reads must not throw on `agent_info`. */
  get available(): boolean {
    return !!this.net.erc8004.identityRegistry;
  }

  identityTuple(agentId: bigint | string): string {
    return `eip155:${this.net.evmChainId}:${this.address}:${agentId}`;
  }

  scanUrl(agentId: bigint | string): string {
    return `https://8004scan.io/agent/${this.identityTuple(agentId)}`;
  }

  // ---- reads ---------------------------------------------------------------

  ownerOf(agentId: bigint): Promise<Address> {
    return this.signer.readContract<Address>({
      address: this.address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "ownerOf",
      args: [agentId],
    });
  }

  getAgentWallet(agentId: bigint): Promise<Address> {
    return this.signer.readContract<Address>({
      address: this.address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "getAgentWallet",
      args: [agentId],
    });
  }

  tokenURI(agentId: bigint): Promise<string> {
    return this.signer.readContract<string>({
      address: this.address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "tokenURI",
      args: [agentId],
    });
  }

  /** Metadata values are abi-encoded strings — `""` when the key was never set. */
  async getMetadata(agentId: bigint, key: string): Promise<string> {
    const raw = await this.signer.readContract<Hex>({
      address: this.address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "getMetadata",
      args: [agentId, key],
    });
    if (!raw || raw === "0x") return "";
    try {
      return decodeAbiParameters(STRING_PARAM, raw)[0];
    } catch {
      return "";
    }
  }

  async view(agentId: bigint): Promise<IdentityView> {
    const [owner, agentWallet, cardUri, builderCode, agentType] = await Promise.all([
      this.ownerOf(agentId),
      this.getAgentWallet(agentId),
      this.tokenURI(agentId),
      this.getMetadata(agentId, "builderCode"),
      this.getMetadata(agentId, "agentType"),
    ]);
    const me = this.signer.address.toLowerCase();
    const custody: Custody =
      agentWallet === zeroAddress
        ? "unlinked"
        : owner.toLowerCase() === me
          ? "agent"
          : agentWallet.toLowerCase() === me
            ? "owner"
            : "foreign";
    return {
      agentId: agentId.toString(),
      owner,
      agentWallet,
      cardUri,
      builderCode,
      agentType,
      custody,
      chainId: this.net.evmChainId,
      registry: this.address,
      identityTuple: this.identityTuple(agentId),
      scanUrl: this.scanUrl(agentId),
    };
  }

  // ---- writes --------------------------------------------------------------

  /**
   * Mint the identity. One transaction: the metadata batch rides along with
   * `register`, and the contract links `agentWallet = msg.sender` itself.
   *
   * Returns the agentId off the `Registered` log. `writeTx` can legitimately
   * come back "unconfirmed" on inj-EVM (receipts lag or vanish), so the id is
   * recovered from a bounded `Registered` log scan when the receipt is missing
   * — the tx did land, and re-registering would mint a SECOND identity.
   */
  async register(cardUri: string): Promise<{ agentId: string | null; tx: WriteTxResult }> {
    const metadata = [
      { metadataKey: "builderCode", metadataValue: encodeStringParam(BUILDER_CODE) },
      { metadataKey: "agentType", metadataValue: encodeStringParam(AGENT_TYPE) },
    ];
    const fromBlock = await this.signer.publicClient.getBlockNumber().catch(() => null);

    const tx = await this.signer.writeTx({
      address: this.address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "register",
      args: [cardUri, metadata],
      intent: {
        kind: "identity",
        target: this.address,
        detail: `erc8004 register ${cardUri}`,
      },
    });

    if (tx.status === "dry-run" || !tx.hash) return { agentId: null, tx };

    const agentId =
      (await this.agentIdFromReceipt(tx.hash)) ??
      (fromBlock === null ? null : await this.findRegisteredId(fromBlock, cardUri));
    return { agentId, tx };
  }

  /**
   * Re-establish `agentWallet` — only callable by the CURRENT owner, so this is
   * the repair path for an identity the agent still owns. Once custody is with
   * the operator the agent can only SIGN (see `signWalletLink`); the operator
   * submits from the Terminal.
   */
  async setAgentWallet(link: WalletLink): Promise<WriteTxResult> {
    return this.signer.writeTx({
      address: this.address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "setAgentWallet",
      args: [BigInt(link.agentId), link.newWallet, BigInt(link.deadline), link.signature],
      intent: {
        kind: "identity",
        target: this.address,
        detail: `erc8004 setAgentWallet ${link.agentId} → ${link.newWallet}`,
      },
    });
  }

  /**
   * Hand the identity to the operator. ⚠ This CLEARS `agentWallet` to zero —
   * measured, not assumed — so the agent's trades stop being attributable to
   * the identity until the operator submits a fresh wallet link.
   */
  async transfer(agentId: bigint, to: Address): Promise<WriteTxResult> {
    return this.signer.writeTx({
      address: this.address,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: "safeTransferFrom",
      args: [this.signer.address, to, agentId],
      intent: {
        kind: "identity",
        target: this.address,
        detail: `erc8004 transfer ${agentId} → ${to}`,
        // The registry is the target; the NFT lands with `to`. Policy pins it
        // to ownerSweepAddress, so this cannot hand the identity to a stranger.
        destination: to,
      },
      confirm: async () => (await this.ownerOf(agentId)).toLowerCase() === to.toLowerCase(),
    });
  }

  // ---- the wallet link -----------------------------------------------------

  /**
   * Mint the EIP-712 `AgentWalletSet` signature the OWNER needs to re-point
   * `agentWallet` at this agent.
   *
   * `owner` is part of the signed message and binds the submitter, so it must
   * be the address that will send the transaction — the operator's wallet.
   *
   * The deadline is derived from the CHAIN's clock, not the local one: the
   * contract compares against `block.timestamp`, and a machine a few seconds
   * fast silently mints a link that reverts with "deadline too far".
   */
  async signWalletLink(opts: {
    agentId: bigint;
    owner: Address;
    ttlSecs?: number;
  }): Promise<WalletLink> {
    const ttl = Math.min(opts.ttlSecs ?? DEFAULT_WALLET_LINK_DEADLINE_SECS, MAX_WALLET_LINK_DEADLINE_SECS);
    if (ttl <= 0) {
      throw new ToolError("bad_deadline", "wallet-link ttl must be positive");
    }
    const block = await this.signer.publicClient.getBlock({ blockTag: "latest" });
    const deadline = Number(block.timestamp) + ttl;
    const newWallet = this.signer.address;

    const signature = await this.signer.account.signTypedData({
      domain: {
        name: WALLET_LINK_DOMAIN_NAME,
        version: WALLET_LINK_DOMAIN_VERSION,
        chainId: this.net.evmChainId,
        verifyingContract: this.address,
      },
      types: WALLET_LINK_TYPES,
      primaryType: "AgentWalletSet",
      message: {
        agentId: BigInt(opts.agentId),
        newWallet,
        owner: opts.owner,
        deadline: BigInt(deadline),
      },
    });

    return {
      agentId: opts.agentId.toString(),
      newWallet,
      owner: opts.owner,
      deadline,
      signature,
      ttlSecs: ttl,
    };
  }

  // ---- agentId recovery ----------------------------------------------------

  private async agentIdFromReceipt(hash: `0x${string}`): Promise<string | null> {
    for (let i = 0; i < 3; i++) {
      try {
        const receipt = await this.signer.publicClient.getTransactionReceipt({ hash });
        const id = registeredIdFromLogs(receipt.logs, this.address);
        if (id !== null) return id;
      } catch {
        // receipt not indexed yet — inj-EVM public RPCs lag
      }
      await sleep(2_000);
    }
    return null;
  }

  /**
   * Fallback: find OUR `Registered` log by scanning back from the block the
   * write started at. Bounded to 10k blocks — the public RPCs answer that span
   * and a registration we just broadcast cannot be older.
   */
  private async findRegisteredId(fromBlock: bigint, cardUri: string): Promise<string | null> {
    void cardUri;
    try {
      const head = await this.signer.publicClient.getBlockNumber();
      const start = head - fromBlock > 10_000n ? head - 10_000n : fromBlock;
      // Raw eth_getLogs rather than viem's typed `event` form: `owner` is the
      // SECOND indexed arg, so filtering on it is a padded topic[2] and nothing
      // has to be decoded to answer "which id did we just mint".
      const logs = (await this.signer.publicClient.request({
        method: "eth_getLogs",
        params: [
          {
            address: this.address,
            fromBlock: `0x${start.toString(16)}`,
            toBlock: `0x${head.toString(16)}`,
            topics: [REGISTERED_TOPIC, null, padTopicAddress(this.signer.address)],
          },
        ],
      } as never)) as { topics: Hex[] }[];
      const last = logs.at(-1);
      const raw = last?.topics?.[1];
      return raw ? BigInt(raw).toString() : null;
    } catch {
      return null;
    }
  }
}

/** ERC-8004 metadata values are abi-encoded, not raw utf-8 bytes. */
export function encodeStringParam(value: string): Hex {
  return encodeAbiParameters(STRING_PARAM, [value]);
}

/** `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`. */
export function registeredIdFromLogs(
  logs: readonly { address: string; topics: readonly string[] }[],
  registry: string,
): string | null {
  const topic0 = REGISTERED_TOPIC;
  for (const log of logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
    if (log.topics[0]?.toLowerCase() !== topic0) continue;
    const raw = log.topics[1];
    if (raw) return BigInt(raw).toString();
  }
  return null;
}

/**
 * keccak256("Registered(uint256,string,address)") — pinned rather than derived
 * so a receipt can be read without loading the ABI. `identity.test.ts` asserts
 * it still equals the hash of the event in IDENTITY_REGISTRY_ABI.
 */
export const REGISTERED_TOPIC =
  "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a";

/** An indexed address topic is the 20 bytes right-aligned in 32. */
function padTopicAddress(address: Address): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
