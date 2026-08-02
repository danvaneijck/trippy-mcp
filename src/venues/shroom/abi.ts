/**
 * LaunchpadCore surface used by this package — human-readable viem parseAbi,
 * lifted from shroom_launchpad/activity-bot/src/chain.ts and extended with
 * the claims/refund/lookup views.
 *
 * ⚠ ABI-drift hazard: this is a hand-maintained mirror of the deployed
 * contract. `npm run sync-abi` checks every entry below against the vendored
 * Foundry artifact in `abi/LaunchpadCore.abi.json` (CI-enforced) — the
 * upstream monorepo had a silent-drift incident in 2026-06 and now treats
 * every mirror as guilty until proven in sync.
 *
 * Only the 3-arg `quoteBuy/quoteSell` overloads exist on-chain (the 2-arg
 * forms were removed for EIP-170 budget) — always pass `account`.
 */

import { parseAbi } from "viem";

export const LAUNCHPAD_ABI = parseAbi([
  "struct LaunchGate { address gateToken; uint256 minBalance; uint64 windowEndsAt; uint16 discountBps; }",
  "struct LaunchConfig { string name; string symbol; string metadataURI; uint8 quoteAsset; LaunchGate gate; uint64 tradingOpensAt; uint64 guardWindowEndsAt; uint16 maxBuyBpsInGuardWindow; uint64 bindDeadlineSeconds; uint8 poolKind; }",
  "struct Launch { uint8 state; address creator; address token; address sink; uint8 quoteAsset; LaunchGate gate; uint64 tradingOpensAt; uint64 guardWindowEndsAt; uint16 maxBuyBpsInGuardWindow; uint64 bindDeadline; address settler; address pairAsset; uint256 virtualPair; uint256 virtualToken; uint256 curveSupply; uint256 graduationPairTarget; uint256 graduationTokenReserve; uint256 realPair; uint256 tokensSold; uint256 refundPairTotal; uint256 refundTokensTotal; uint256 refundPairPaid; uint256 refundTokensReceived; uint256 feeEscrowed; uint16 tradeFeeBps; uint16 creatorFeeShareBps; string bankDenom; bool requiresChoiceFactoryDust; string metadataURI; uint8 poolKind; }",

  // Reads
  "function denomCreationFeeInj() view returns (uint256)",
  "function nextLaunchId() view returns (uint256)",
  "function launchCount() view returns (uint256)",
  "function paused() view returns (bool)",
  "function getLaunchState(uint256 launchId) view returns (uint8)",
  "function getLaunch(uint256 launchId) view returns (Launch)",
  "function getLaunchByToken(address token) view returns (uint256)",
  "function quoteBuy(uint256 launchId, uint256 pairIn, address account) view returns (uint256 tokenOut, uint256 fee, uint256 refund)",
  "function quoteSell(uint256 launchId, uint256 tokenIn, address account) view returns (uint256 pairOut, uint256 fee)",
  "function creatorFeesOwed(uint256 launchId) view returns (uint256)",
  "function referralFeesOwed(address referrer, address pairAsset) view returns (uint256)",
  "function refundsOwed(address account) view returns (uint256)",

  // Protocol parameters. Everything the `explain` docs quote as a number is
  // read through these at call time — the prose ships no baked figures, because
  // they move without a redeploy (the creation fee was cut 1 → 0.2 INJ via
  // setDenomCreationFeeInj after mainnet launch, which would have made any
  // hard-coded value in an npm package a lie until the next release).
  "struct QuoteAssetConfig { address pairAsset; uint256 virtualPair; uint256 virtualToken; uint256 curveSupply; uint256 graduationPairTarget; uint256 graduationTokenReserve; bool enabled; string bankDenom; bool requiresChoiceFactoryDust; uint16 tradeFeeBps; uint16 creatorFeeShareBps; }",
  "function getQuoteAssetConfig(uint8 q) view returns (QuoteAssetConfig)",
  "function referralShareBps() view returns (uint16)",
  "function treasury() view returns (address)",
  "function getLaunchSink(uint256 launchId) view returns (address)",

  // Writes
  "function createLaunch(LaunchConfig cfg) payable returns (uint256)",
  "function buy(uint256 launchId, uint256 pairIn, uint256 minTokenOut, address referrer, uint256 deadline) returns (uint256)",
  "function buyNative(uint256 launchId, uint256 minTokenOut, address referrer, uint256 deadline) payable returns (uint256)",
  "function sell(uint256 launchId, uint256 tokenIn, uint256 minPairOut, uint256 deadline) returns (uint256)",
  "function sellNative(uint256 launchId, uint256 tokenIn, uint256 minPairOut, uint256 deadline) returns (uint256)",
  "function claimCreatorFees(uint256 launchId) returns (uint256)",
  "function claimCreatorFeesMany(uint256[] launchIds) returns (uint256)",
  "function claimReferralFees(address pairAsset) returns (uint256)",
  "function withdrawRefund() returns (uint256)",
]);

export const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/** Mirror of LaunchpadCore's enum LaunchState (append-only). */
export enum LaunchState {
  Created = 0,
  Trading = 1,
  CurveFilled = 2,
  PendingSettlement = 3,
  Graduated = 4,
  SettlementFailed = 5,
  Refunded = 6,
  Reserved = 7,
  Cancelled = 8,
}

export const LAUNCH_STATE_LABEL: Record<number, string> = {
  0: "Created",
  1: "Trading",
  2: "CurveFilled",
  3: "PendingSettlement",
  4: "Graduated",
  5: "SettlementFailed",
  6: "Refunded",
  7: "Reserved",
  8: "Cancelled",
};

export enum PoolKind {
  Xyk = 0,
  Clmm = 1,
}
