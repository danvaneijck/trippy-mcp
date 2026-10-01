/**
 * Choice v2 (PancakeSwap Infinity) surface used by this package — only what a
 * single-hop CL swap and its pool lookup need. Hand-written from the deployed
 * sources (choice_v2/forks/infinity-universal-router, infinity-periphery and
 * choice_v2_contracts src/launchpad), every entry exercised against mainnet.
 */

import { parseAbi } from "viem";

/** `PoolKey` as Infinity lays it out: `parameters` packs tickSpacing + hook bitmap. */
export const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "hooks", type: "address" },
  { name: "poolManager", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "parameters", type: "bytes32" },
] as const;

export const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);

export const CL_QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; address hooks; address poolManager; uint24 fee; bytes32 parameters; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  // Not a view: it runs the swap and reverts with the result. Called with
  // eth_call only, so nothing it does can land.
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const CL_POOL_MANAGER_ABI = parseAbi([
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 id) view returns (uint128)",
]);

export const PERMIT2_ABI = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

/** InfinitySettler → its PositionLocker and the CL position manager. */
export const INFINITY_SETTLER_ABI = parseAbi([
  "function LOCKER() view returns (address)",
  "function POSITION_MANAGER() view returns (address)",
]);

export const POSITION_LOCKER_ABI = parseAbi([
  "struct LockedPosition { uint256 tokenId; address creator; uint16 creatorBps; }",
  "function getPosition(uint256 launchId) view returns (LockedPosition)",
]);

export const CL_POSITION_MANAGER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; address hooks; address poolManager; uint24 fee; bytes32 parameters; }",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)",
]);

export const LAUNCH_POOL_FEE_HOOK_ABI = parseAbi([
  "function poolFeePips(bytes32 poolId) view returns (uint24)",
]);
