/**
 * WINJ9 — wrapped INJ, and unwrapping it back to the native coin.
 *
 * INJ is the one quote asset whose bank denom and ERC20 pair asset are
 * DIFFERENT tokens. `quoteAssets.INJ` carries `bankDenom: "inj"` and
 * `pairAsset: WINJ9`, and the gap between them is invisible right up until a
 * contract pays the wallet on the ERC20 side:
 *
 *  - trading never exposes it — `buyNative`/`sellNative` take `msg.value` and
 *    wrap in-contract, so an INJ trade neither needs nor leaves a WINJ balance;
 *  - but LaunchpadCore settles the CURVE CREATOR FEE in the pair asset, so
 *    `claim_fees` on an INJ-quoted launch lands WINJ, not INJ.
 *
 * That payout is not spendable as INJ (it pays no gas, and `buyNative` cannot
 * send it), and because `erc20:0x…03FfB` is not `quoteAssets.INJ.bankDenom`,
 * `portfolio` priced it as `unpriced` — so the wallet total silently omitted
 * the whole claim. Both halves are fixed here: `unwrapWinj` converts the
 * payout at claim time, and `isWinjDenom` lets the pricer recognise any that
 * is already sitting there.
 *
 * WINJ9 is a WETH9 clone: `withdraw(wad)` burns the wrapper 1:1 and sends
 * native INJ back to the caller. It is self-custodial and takes no
 * destination, which is why it rides the uncapped `claim` intent — the same
 * treatment `approve` gets. WINJ9 is already on the target allowlist
 * (`allowedTargetsFor`, for the pair-asset approvals), so this adds no
 * address to the policy engine's surface.
 */

import { parseAbi, type Address } from "viem";

import type { EvmSigner } from "./evm.js";
import type { NetworkDef } from "./networks.js";

export const WINJ9_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function deposit() payable",
  "function withdraw(uint256 wad)",
]);

/**
 * The bank denom WINJ arrives under, or null on a network that names no
 * wrapper. The EVM and Cosmos halves name the same token two ways:
 * `erc20:<address>` in bank, a plain address over JSON-RPC.
 */
export function winjBankDenom(net: NetworkDef): string | null {
  const winj9 = net.addresses?.winj9;
  return winj9 ? `erc20:${winj9}` : null;
}

/**
 * Case-insensitive on purpose: the address is checksummed in the registry but
 * a bank denom is whatever the minting module wrote, and a case mismatch here
 * would resurrect the exact "unpriced" bug this exists to kill.
 *
 * No configured wrapper means nothing is WINJ — this sits on `portfolio`'s
 * read path, where a throw would take down the whole holdings list over an
 * address that only the payout path needs.
 */
export function isWinjDenom(net: NetworkDef, denom: string): boolean {
  const bank = winjBankDenom(net);
  return bank !== null && denom.toLowerCase() === bank.toLowerCase();
}

/** This wallet's WINJ balance, read from the wrapper itself. */
export async function winjBalance(signer: EvmSigner, net: NetworkDef): Promise<bigint> {
  return signer.readContract<bigint>({
    address: net.addresses.winj9,
    abi: WINJ9_ABI,
    functionName: "balanceOf",
    args: [signer.address],
  });
}

/**
 * Unwrap `amount` WINJ back to native INJ.
 *
 * `confirm` re-reads the balance rather than trusting a receipt: inj-EVM
 * public RPCs drop receipts often enough that `settle()` is built around it,
 * and a withdraw is idempotent-checkable — the balance simply went down.
 */
export async function unwrapWinj(
  signer: EvmSigner,
  net: NetworkDef,
  amount: bigint,
): Promise<{ hash: string | null; status: string }> {
  const before = await winjBalance(signer, net);
  const res = await signer.writeTx({
    address: net.addresses.winj9 as Address,
    abi: WINJ9_ABI,
    functionName: "withdraw",
    args: [amount],
    intent: {
      kind: "claim",
      target: net.addresses.winj9,
      detail: `unwrap ${amount} wei WINJ to INJ`,
    },
    confirm: async () => (await winjBalance(signer, net)) < before,
  });
  return { hash: res.hash, status: res.status };
}
