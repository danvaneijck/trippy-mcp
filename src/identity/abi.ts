/**
 * ERC-8004 identity registry (`AgentIdentity` / `AGENT`, v2.0.0) — the subset
 * of the surface this package touches, as a hand-maintained viem parseAbi
 * mirror of the vendored `abi/IdentityRegistry.abi.json`.
 *
 * ⚠ Two drift hazards, not one:
 *  1. the usual mirror-vs-artifact drift — `npm run sync-abi -- --check`
 *     asserts every function below is a selector-level subset of the vendored
 *     ABI, exactly as it does for LaunchpadCore;
 *  2. the registry is an UPGRADEABLE PROXY, so the bytecode behind these
 *     selectors can change without any redeploy of ours. Every read here is
 *     therefore treated as fallible (`agent_info` fails soft), and behaviours
 *     the ABI cannot express are pinned by the constants below, measured
 *     against the live contract rather than read from a doc.
 */

import { parseAbi } from "viem";

export const IDENTITY_REGISTRY_ABI = parseAbi([
  "struct MetadataEntry { string metadataKey; bytes metadataValue; }",

  // Reads
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function getVersion() view returns (string)",

  // Writes
  "function register(string agentURI, MetadataEntry[] metadata) returns (uint256)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",

  // `register` returns the id, but a tx return value is not observable off-chain
  // — the id comes off topics[1] of this log.
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

/**
 * MEASURED against both deployments on 2026-08-14, not read from the spec:
 * `setAgentWallet` reverts with "deadline too far" for any deadline more than
 * 300s past the executing block's timestamp (mainnet agent 1 and testnet agent
 * 63 both flip between +300s and +360s relative to `latest`, which trails the
 * execution block).
 *
 * This is the single fact that shapes Phase 2. A wallet-link signature CANNOT
 * be minted now and used tomorrow — it dies within five minutes — so the
 * operator's hand-off is a live, re-runnable step rather than a stored blob
 * that waits for them.
 */
export const MAX_WALLET_LINK_DEADLINE_SECS = 300;

/**
 * What we actually request. The headroom absorbs the gap between the block we
 * read the timestamp from and the block the operator's tx lands in — at 300s
 * exactly, a link minted against a stale `latest` reverts.
 */
export const DEFAULT_WALLET_LINK_DEADLINE_SECS = 240;

/** EIP-712 domain, confirmed via `eip712Domain()` on both networks. */
export const WALLET_LINK_DOMAIN_NAME = "ERC8004IdentityRegistry";
export const WALLET_LINK_DOMAIN_VERSION = "1";

/**
 * `AgentWalletSet(uint256 agentId, address newWallet, address owner, uint256 deadline)`.
 *
 * Signed by the NEW WALLET (the agent, proving control), submitted by the
 * OWNER. `owner` binds the submitter: a signature naming the previous owner is
 * rejected with "invalid wallet sig" when the new owner sends it — verified
 * live on testnet agent 64.
 */
export const WALLET_LINK_TYPES = {
  AgentWalletSet: [
    { name: "agentId", type: "uint256" },
    { name: "newWallet", type: "address" },
    { name: "owner", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
