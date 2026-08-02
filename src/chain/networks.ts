/**
 * Network registry — Injective EVM (SHROOM Pad) + Cosmos (Choice) endpoints
 * and contract addresses, vendored from the shroom_launchpad deployments
 * records (`contracts/deployments/injective_{mainnet,testnet}.json`).
 *
 * Addresses here are data, not configuration: they change only on a contract
 * redeploy, which ships as a new package version. RPC/API endpoints CAN be
 * overridden per-install via config.json.
 */

import { defineChain, type Address, type Chain } from "viem";

export type NetworkName = "mainnet" | "testnet";

export interface QuoteAssetInfo {
  symbol: "INJ" | "USDC" | "SAI";
  /** LaunchpadCore quote-asset slot id. */
  slot: number;
  /** ERC20 pair asset (WINJ9 for INJ — buyNative/sellNative wrap in-contract). */
  pairAsset: Address;
  /** Cosmos bank denom of the pair asset. */
  bankDenom: string;
  /** Base-unit decimals — USDC is 6, everything else 18. */
  decimals: number;
  /** True for INJ: trade via buyNative/sellNative with msg.value. */
  isNative: boolean;
}

export interface ClaimDropsConfig {
  /** Instance address; empty disables the airdrop rail on this network. */
  contract: string;
  /**
   * Public base serving a drop's leaves JSON, content-addressed by merkle root
   * (`${leavesBase}/${root}.json`). This exact string is written ON-CHAIN as
   * the campaign's `leaves_uri`, and a one-shot drop freezes on its first
   * publish — a wrong host here mints an immutable drop pointing at a document
   * nobody can read, which is a permanently unclaimable campaign. It is not
   * overridable per-install for that reason.
   */
  leavesBase: string;
  /** Hasura GraphQL endpoint (anon role, insert+select on the drop tables). */
  hasuraUrl: string;
  /** Claim page an agent hands to recipients. */
  claimBase: string;
}

export interface NetworkDef {
  name: NetworkName;
  evmChainId: number;
  cosmosChainId: string;
  /** Ordered EVM JSON-RPC endpoints — first is preferred, rest are fallback. */
  rpcUrls: string[];
  lcdUrl: string;
  /**
   * Cosmos gRPC-web gateway.
   *
   * Not interchangeable with `lcdUrl`: the public LCD does not implement the
   * bank module's `DenomOwners` query (code 12, "Not Implemented", on every
   * public node and on both networks), while gRPC-web answers it fine. Holder
   * snapshots therefore go through here.
   */
  grpcUrl: string;
  explorerTxBase: string;
  pumpApiBase: string;
  choiceApiBase: string;
  terminalBase: string;
  addresses: {
    launchpadCore: Address;
    winj9: Address;
    feeTreasury: Address;
  };
  /** Choice aggregation router (CosmWasm) — the only contract swaps may execute. */
  choiceAggregator: string;
  /** `choice-claim-drops` rail: the only contract airdrops may execute. */
  claimDrops: ClaimDropsConfig;
  /**
   * Default `referrer` for curve buys: the platform fee treasury. Diverts the
   * referral share (10% of the creator's fee cut — not an extra cost to the
   * trader) and doubles as on-chain agent attribution. Overridable in config;
   * automatically replaced with address(0) when the agent is the launch
   * creator (the contract forbids referrer == creator or == buyer).
   */
  defaultReferrer: Address;
  quoteAssets: Record<string, QuoteAssetInfo>;
  /** Default gas price (wei) — Injective EVM uses a fixed floor, not an auction. */
  gasPriceWei: bigint;
}

const MAINNET: NetworkDef = {
  name: "mainnet",
  evmChainId: 1776,
  cosmosChainId: "injective-1",
  rpcUrls: [
    "https://sentry.evm-rpc.injective.network",
    "https://injectiveevm-rpc.polkachu.com",
  ],
  lcdUrl: "https://sentry.lcd.injective.network",
  grpcUrl: "https://sentry.chain.grpc-web.injective.network",
  explorerTxBase: "https://blockscout.injective.network/tx/",
  pumpApiBase: "https://pump-api.trippyinj.xyz",
  choiceApiBase: "https://api.choice.exchange",
  terminalBase: "https://trade.trippyinj.xyz",
  addresses: {
    launchpadCore: "0xeBF62508F322137EE0986935Ee3b4A60a3F0D227",
    winj9: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
    feeTreasury: "0xAB1C7326b8bcd3492FF56CdA88Ec40d0A417e40d",
  },
  choiceAggregator: "inj1520rsss9aykhkfmuf89nh5hp2jww770z4u3eu0",
  claimDrops: {
    // code id 2066 (InstantiatePermission: Everybody), fee_bps 0, wasm admin is
    // the Choice Admin Timelock (48h queued migrations). Deployed 2026-07-27.
    contract: "inj1nwqzch964chy8k0ptnajm3pa6907s5yhflw82n",
    leavesBase: "https://api.trippyinj.xyz/claim-drops/leaves",
    hasuraUrl: "https://api.trippyinj.xyz/v1/graphql",
    claimBase: "https://trippyinj.xyz/claim",
  },
  defaultReferrer: "0xAB1C7326b8bcd3492FF56CdA88Ec40d0A417e40d",
  quoteAssets: {
    INJ: {
      symbol: "INJ",
      slot: 1,
      pairAsset: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
      bankDenom: "inj",
      decimals: 18,
      isNative: true,
    },
    USDC: {
      symbol: "USDC",
      slot: 2,
      pairAsset: "0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
      bankDenom: "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
      decimals: 6,
      isNative: false,
    },
    SAI: {
      symbol: "SAI",
      slot: 3,
      pairAsset: "0x8Dc3ECb97E6E5f08cd490bA3089DA0BB9D59ccB4",
      bankDenom: "factory/inj10aa0h5s0xwzv95a8pjhwluxcm5feeqygdk3lkm/SAI",
      decimals: 18,
      isNative: false,
    },
  },
  gasPriceWei: 500_000_000n,
};

const TESTNET: NetworkDef = {
  name: "testnet",
  evmChainId: 1439,
  cosmosChainId: "injective-888",
  rpcUrls: ["https://injectiveevm-testnet-rpc.polkachu.com"],
  lcdUrl: "https://testnet.sentry.lcd.injective.network",
  grpcUrl: "https://testnet.sentry.chain.grpc-web.injective.network",
  explorerTxBase: "https://testnet.blockscout.injective.network/tx/",
  // Testnet pump API base is deployment-specific — override via config.
  pumpApiBase: "",
  choiceApiBase: "",
  terminalBase: "",
  addresses: {
    launchpadCore: "0x82ff4f7c7b4a4fe77a47d71c7700d17873a0d63f",
    winj9: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
    feeTreasury: "0xBf08c09Fe227ada4A86d279e98E695344848d33D",
  },
  choiceAggregator: "",
  claimDrops: {
    // code id 39733, fee_bps 0. Deployed 2026-07-26 for the end-to-end QA run.
    contract: "inj1f2htctksx6jfcrt5gr3yf4vnmgs70a9zxurp53",
    leavesBase: "https://api.trippyinj.xyz/claim-drops/leaves",
    hasuraUrl: "https://api.trippyinj.xyz/v1/graphql",
    claimBase: "https://trippyinj.xyz/claim",
  },
  defaultReferrer: "0xBf08c09Fe227ada4A86d279e98E695344848d33D",
  quoteAssets: {
    INJ: {
      symbol: "INJ",
      slot: 1,
      pairAsset: "0x0000000088827d2d103ee2d9A6b781773AE03FfB",
      bankDenom: "inj",
      decimals: 18,
      isNative: true,
    },
    USDC: {
      symbol: "USDC",
      slot: 2,
      pairAsset: "0xebc7c587e6551dEbE23D17ca253DE176365b3465",
      bankDenom: "factory/inj1tf79ks9y52f5wv9wywafc0era6uy6km8x40lny/USDC",
      decimals: 6,
      isNative: false,
    },
    SAI: {
      symbol: "SAI",
      slot: 3,
      pairAsset: "0x7E6f4a01f2943d7d68C89999cFFC187A09f5D8A1",
      bankDenom: "factory/inj1tf79ks9y52f5wv9wywafc0era6uy6km8x40lny/SAI",
      decimals: 18,
      isNative: false,
    },
  },
  gasPriceWei: 300_000_000n,
};

export const NETWORKS: Record<NetworkName, NetworkDef> = {
  mainnet: MAINNET,
  testnet: TESTNET,
};

export function getNetwork(name: NetworkName): NetworkDef {
  const n = NETWORKS[name];
  if (!n) throw new Error(`unknown network: ${name}`);
  return n;
}

export function makeChain(def: NetworkDef, rpcUrls?: string[]): Chain {
  const urls = rpcUrls && rpcUrls.length > 0 ? rpcUrls : def.rpcUrls;
  return defineChain({
    id: def.evmChainId,
    name: `Injective EVM ${def.name}`,
    nativeCurrency: { name: "Injective", symbol: "INJ", decimals: 18 },
    rpcUrls: { default: { http: urls } },
  });
}

export function quoteAssetBySlot(def: NetworkDef, slot: number): QuoteAssetInfo | undefined {
  return Object.values(def.quoteAssets).find((q) => q.slot === slot);
}
