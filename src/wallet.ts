/**
 * Wallet status + sweep. Balances come from the Cosmos bank via LCD — never
 * eth_getBalance (returns 0 on Injective's EVM RPC even when funded).
 *
 * Sweep can only send to `ownerSweepAddress` (fixed at init) — the sweep code
 * path takes no destination argument and the policy engine re-checks the
 * target, so a hijacked model cannot exfiltrate funds.
 */

import { formatUnits, parseUnits, type Address } from "viem";

import { balanceOf, bankBalances } from "./api/lcd.js";
import { ERC20_ABI } from "./venues/shroom/abi.js";
import { ToolError } from "./errors.js";
import type { Runtime } from "./runtime.js";

/** Native INJ kept behind on sweeps so the wallet can always pay gas. */
const GAS_RESERVE_WEI = 50_000_000_000_000_000n; // 0.05 INJ

export interface WalletStatus {
  agentName: string;
  evmAddress: string;
  injAddress: string;
  network: string;
  balances: { symbol: string; amount: string; denom: string }[];
  policy: Record<string, unknown>;
  ownerSweepAddress: string;
  registered: boolean;
  ownerClaimed: boolean;
  dryRun: boolean;
}

export async function walletStatus(rt: Runtime): Promise<WalletStatus> {
  const all = await bankBalances(rt.net.lcdUrl, rt.injAddress);
  const balances: WalletStatus["balances"] = [];
  for (const q of Object.values(rt.net.quoteAssets)) {
    const amt = balanceOf(all, q.bankDenom);
    balances.push({ symbol: q.symbol, amount: formatUnits(amt, q.decimals), denom: q.bankDenom });
  }
  // Anything else the wallet holds (launch tokens ride bank denoms too).
  for (const b of all) {
    if (!balances.some((x) => x.denom === b.denom)) {
      balances.push({ symbol: b.denom.slice(0, 24), amount: b.amount, denom: b.denom });
    }
  }

  let registered = false;
  let ownerClaimed = false;
  try {
    const { agent } = await rt.pump.getAgent(rt.signer.address.toLowerCase());
    registered = !!agent && !agent.revoked;
    ownerClaimed = !!agent?.ownerAddress;
  } catch {
    // registry unreachable — report unregistered rather than failing status
  }

  return {
    agentName: rt.cfg.agentName,
    evmAddress: rt.signer.address,
    injAddress: rt.injAddress,
    network: rt.net.name,
    balances,
    policy: rt.policy.snapshot(),
    ownerSweepAddress: rt.cfg.ownerSweepAddress,
    registered,
    ownerClaimed,
    dryRun: rt.cfg.dryRun,
  };
}

export interface SweepResult {
  asset: string;
  amount: string;
  to: string;
  hash: string | null;
  status: string;
}

/**
 * Send funds home. `asset` is INJ | USDC | SAI | an ERC20 address; `amount`
 * human units or "all" (INJ keeps a 0.05 gas reserve).
 */
export async function sweep(rt: Runtime, asset: string, amount: string | "all"): Promise<SweepResult> {
  const owner = rt.cfg.ownerSweepAddress as Address;
  const intent = { kind: "sweep" as const, target: owner, detail: `sweep ${asset} → owner` };

  if (asset.toUpperCase() === "INJ") {
    const all = await bankBalances(rt.net.lcdUrl, rt.injAddress);
    const bal = balanceOf(all, "inj");
    const spendable = bal > GAS_RESERVE_WEI ? bal - GAS_RESERVE_WEI : 0n;
    const value = amount === "all" ? spendable : parseUnits(amount, 18);
    if (value <= 0n || value > spendable) {
      throw new ToolError(
        "no_balance",
        `nothing sweepable — balance ${formatUnits(bal, 18)} INJ minus 0.05 gas reserve`,
      );
    }
    const res = await rt.signer.sendNative(owner, value, intent);
    return { asset: "INJ", amount: formatUnits(value, 18), to: owner, hash: res.hash, status: res.status };
  }

  const known = rt.net.quoteAssets[asset.toUpperCase()];
  const token = (known ? known.pairAsset : asset) as Address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    throw new ToolError("bad_asset", "asset must be INJ, USDC, SAI or an ERC20 0x address");
  }
  const decimals = known
    ? known.decimals
    : Number(
        await rt.signer.readContract<number>({
          address: token,
          abi: ERC20_ABI,
          functionName: "decimals",
          args: [],
        }),
      );
  const bal = await rt.signer.readContract<bigint>({
    address: token,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [rt.signer.address],
  });
  const value = amount === "all" ? bal : parseUnits(amount, decimals);
  if (value <= 0n || value > bal) {
    throw new ToolError("no_balance", `balance is ${formatUnits(bal, decimals)}`);
  }
  const res = await rt.signer.writeTx({
    address: token,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [owner, value],
    intent,
  });
  return {
    asset: known ? known.symbol : token,
    amount: formatUnits(value, decimals),
    to: owner,
    hash: res.hash,
    status: res.status,
  };
}
