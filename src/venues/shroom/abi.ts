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

/**
 * v2 read surface (CurveRegistry release). Two things changed shape, so this
 * cannot be folded into LAUNCHPAD_ABI — mainnet still runs v1, and the same
 * package serves both:
 *
 *  - `Launch` gained `uint16 curveId` (after creatorFeeShareBps). Curves are
 *    chosen PER LAUNCH from the registry rather than being a property of the
 *    quote asset.
 *  - `QuoteAssetConfig` LOST virtualPair / virtualToken / curveSupply /
 *    graduationTokenReserve for the same reason. `graduationPairTarget`
 *    survives as the quote's BASE raise size, which presets scale.
 *
 * Both are served by LaunchpadViews, not core: they were moved off to reclaim
 * EIP-170 headroom (core sat at 24,282 B with 294 B spare) and are rebuilt from
 * raw storage through core's `extsload`. Same values, different address.
 *
 * Decoding a v2 launch with the v1 tuple does NOT throw — `curveId` shifts
 * every field after it — so the shape is selected by network, never guessed.
 */
export const LAUNCHPAD_VIEWS_ABI = parseAbi([
  "struct LaunchGate { address gateToken; uint256 minBalance; uint64 windowEndsAt; uint16 discountBps; }",
  "struct LaunchV2 { uint8 state; address creator; address token; address sink; uint8 quoteAsset; LaunchGate gate; uint64 tradingOpensAt; uint64 guardWindowEndsAt; uint16 maxBuyBpsInGuardWindow; uint64 bindDeadline; address settler; address pairAsset; uint256 virtualPair; uint256 virtualToken; uint256 curveSupply; uint256 graduationPairTarget; uint256 graduationTokenReserve; uint256 realPair; uint256 tokensSold; uint256 refundPairTotal; uint256 refundTokensTotal; uint256 refundPairPaid; uint256 refundTokensReceived; uint256 feeEscrowed; uint16 tradeFeeBps; uint16 creatorFeeShareBps; uint16 curveId; string bankDenom; bool requiresChoiceFactoryDust; string metadataURI; uint8 poolKind; }",
  "struct QuoteAssetConfigV2 { address pairAsset; uint256 graduationPairTarget; bool enabled; string bankDenom; bool requiresChoiceFactoryDust; uint16 tradeFeeBps; uint16 creatorFeeShareBps; }",
  "function getLaunch(uint256 launchId) view returns (LaunchV2)",
  "function getQuoteAssetConfig(uint8 q) view returns (QuoteAssetConfigV2)",
  // Progress derived from the launch's OWN snapshotted target. A per-quote
  // target is not a valid denominator on v2: presets scale it per launch.
  "function graduationProgressBps(uint256 launchId) view returns (uint256)",
]);

/**
 * v2 `createLaunch`. `LaunchConfig` gained `uint16 curveId` (after quoteAsset),
 * so the v1 write ABI encodes a different calldata layout and the call reverts.
 * curveId 0 is the standard preset and reproduces the v1 curve exactly, so it
 * is the safe default for a caller that does not care.
 */
export const LAUNCHPAD_WRITE_V2_ABI = parseAbi([
  "struct LaunchGate { address gateToken; uint256 minBalance; uint64 windowEndsAt; uint16 discountBps; }",
  "struct LaunchConfigV2 { string name; string symbol; string metadataURI; uint8 quoteAsset; uint16 curveId; LaunchGate gate; uint64 tradingOpensAt; uint64 guardWindowEndsAt; uint16 maxBuyBpsInGuardWindow; uint64 bindDeadlineSeconds; uint8 poolKind; }",
  "function createLaunch(LaunchConfigV2 cfg) payable returns (uint256)",
]);

/** Curated curve presets (v2 only). */
export const CURVE_REGISTRY_ABI = parseAbi([
  "struct Preset { uint256 virtualToken; uint256 curveSupply; uint256 graduationTokenReserve; uint16 rBps; uint16 targetMulBps; uint32 quoteMask; bool enabled; string name; }",
  "function presetCount() view returns (uint256)",
  "function getPreset(uint16 curveId) view returns (Preset)",
  "function getPresets() view returns (Preset[])",
  // Quote-invariant shape stats — float and LP are the two numbers a creator
  // actually chooses between, and the registry is the only authority on them.
  // Recomputing them here would drift silently the moment `MIN_LP_BPS` or the
  // ceiling form changed, and it would drift toward over-promising float.
  "function shapeOf(uint16 curveId) view returns (uint256 tokensAtGrad, uint256 lpTokens, uint256 totalSupply, uint256 floatBps, uint256 lpBps)",
  "function isAllowed(uint16 curveId, uint8 quote) view returns (bool)",
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
