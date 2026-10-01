/**
 * The creator-fee rail of a launch that graduated onto Choice v2.
 *
 * A v2 graduate keeps paying its creator after the curve closes, through one of
 * two contracts — neither of them the core, and neither of them the CosmWasm
 * locker a Choice v1 graduate uses:
 *
 *  - **LaunchPoolFeeHook** (most graduates; LP fee 0). Every swap credits the
 *    launch's creator share to `creatorOwed[launchId]`, in the launch's quote.
 *    `claimCreator(launchId)` pays it to the launch's CURRENT creator — read off
 *    the core, so a creator handoff moves the credit — and only they may call.
 *  - **PositionLocker** (the earliest graduates, whose pool carries an ordinary
 *    LP fee). Fees sit uncollected inside the locked position until anyone calls
 *    `collect(launchId)`, which credits them to `owed[currency][recipient]` at
 *    the split fixed at graduation. `claim(currency, recipient)` then pays a
 *    recipient — permissionless, and never anyone but the recipient. The
 *    creator leg is the address REGISTERED at graduation, not the core's current
 *    creator. Pending fees have no view: they are read by eth_call-simulating
 *    `collect`, which changes nothing.
 *
 * Both pay ERC20s — wINJ for the quote side, and on the locker also the launch
 * token — so `claim_fees` unwraps wINJ afterwards exactly as it does for the
 * curve rail.
 */

import { type Address } from "viem";

import type { EvmSigner } from "../../chain/evm.js";
import type { ChoiceV2Config } from "../../chain/networks.js";
import { ERC20_ABI } from "../shroom/abi.js";
import {
  CL_POSITION_MANAGER_ABI,
  INFINITY_SETTLER_ABI,
  LAUNCH_POOL_FEE_HOOK_ABI,
  POSITION_LOCKER_ABI,
} from "./abi.js";

const ZERO_ID = `0x${"00".repeat(32)}`;

export interface CurrencyAmount {
  currency: Address;
  decimals: number;
  amount: bigint;
}

export interface V2HookFees {
  hook: Address;
  /** `creatorOwed[launchId]`, in `quote`. */
  owed: CurrencyAmount;
  /** The launch's current creator — the only address `claimCreator` pays. */
  creator: Address;
  /** True when that is this wallet. */
  claimable: boolean;
}

export interface V2LockerFees {
  locker: Address;
  tokenId: bigint;
  /** The creator leg fixed at graduation. */
  positionCreator: Address;
  creatorBps: number;
  /** True when this wallet is that creator leg. */
  mine: boolean;
  /** Uncollected in the position, GROSS of the split (one row per pool currency). */
  pending: CurrencyAmount[];
  /** This wallet's cut of `pending`, once collected. */
  pendingYours: CurrencyAmount[];
  /** Already collected and credited to this wallet, waiting for `claim`. Wallet-wide, not per launch. */
  credited: CurrencyAmount[];
}

export interface V2LaunchFees {
  onchainId: bigint;
  hook: V2HookFees | null;
  locker: V2LockerFees | null;
  /** Reads that failed — a rail that will not answer is UNKNOWN, never zero. */
  errors: string[];
}

export class V2CreatorFees {
  constructor(
    private readonly cfg: ChoiceV2Config,
    private readonly signer: EvmSigner,
  ) {}

  private call<T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<T> {
    return this.signer.readContract<T>({ address, abi: abi as never, functionName, args });
  }

  private async decimals(token: Address): Promise<number> {
    return Number(await this.call<number>(token, ERC20_ABI, "decimals", []).catch(() => 18));
  }

  /**
   * Everything a v2 graduate owes `wallet`, read-only. `settler` is the launch's
   * own snapshotted settler and must be a pinned InfinitySettler — the caller
   * checks; a non-v2 launch has neither rail.
   */
  async read(settler: Address, onchainId: bigint, wallet: Address): Promise<V2LaunchFees> {
    const errors: string[] = [];
    const me = wallet.toLowerCase();
    const [hook, locker] = await Promise.all([
      this.readHook(onchainId, me).catch((e: unknown) => {
        errors.push(`fee hook: ${msg(e)}`);
        return null;
      }),
      this.readLocker(settler, onchainId, wallet).catch((e: unknown) => {
        errors.push(`position locker: ${msg(e)}`);
        return null;
      }),
    ]);
    return { onchainId, hook, locker, errors };
  }

  private async readHook(onchainId: bigint, me: string): Promise<V2HookFees | null> {
    for (const h of this.cfg.allowedHooks.filter((a) => a.name === "LaunchPoolFeeHook")) {
      const pool = await this.call<string>(h.address, LAUNCH_POOL_FEE_HOOK_ABI, "launchPool", [onchainId]);
      if (pool.toLowerCase() === ZERO_ID) continue;
      const [owed, quote, creator] = await Promise.all([
        this.call<bigint>(h.address, LAUNCH_POOL_FEE_HOOK_ABI, "creatorOwed", [onchainId]),
        this.call<Address>(h.address, LAUNCH_POOL_FEE_HOOK_ABI, "launchQuote", [onchainId]),
        this.call<Address>(h.address, LAUNCH_POOL_FEE_HOOK_ABI, "creatorOf", [onchainId]),
      ]);
      return {
        hook: h.address,
        owed: { currency: quote, decimals: await this.decimals(quote), amount: owed },
        creator,
        claimable: creator.toLowerCase() === me,
      };
    }
    return null;
  }

  private async readLocker(settler: Address, onchainId: bigint, wallet: Address): Promise<V2LockerFees | null> {
    const locker = await this.call<Address>(settler, INFINITY_SETTLER_ABI, "LOCKER", []);
    if (locker.toLowerCase() !== this.cfg.positionLocker.toLowerCase()) {
      // A settler pointing somewhere this build does not know: reading is
      // harmless, but nothing will be claimed from it, so say so loudly.
      throw new Error(`settler's locker ${locker} is not the pinned PositionLocker ${this.cfg.positionLocker}`);
    }
    const pos = await this.call<{ tokenId: bigint; creator: Address; creatorBps: number }>(
      locker,
      POSITION_LOCKER_ABI,
      "getPosition",
      [onchainId],
    );
    if (!pos.tokenId) return null;
    const pm = await this.call<Address>(settler, INFINITY_SETTLER_ABI, "POSITION_MANAGER", []);
    const [key] = await this.call<readonly [{ currency0: Address; currency1: Address }, bigint]>(
      pm,
      CL_POSITION_MANAGER_ABI,
      "getPoolAndPositionInfo",
      [pos.tokenId],
    );
    const currencies = [key.currency0, key.currency1] as const;
    const decimals = await Promise.all(currencies.map((c) => this.decimals(c)));

    // `collect` simulated, never sent. NothingToCollect (or any revert) = nothing pending.
    const pending = await this.signer.publicClient
      .simulateContract({
        account: wallet,
        address: locker,
        abi: POSITION_LOCKER_ABI,
        functionName: "collect",
        args: [onchainId],
      })
      .then((r) => r.result as readonly [bigint, bigint])
      .catch(() => [0n, 0n] as const);

    const mine = pos.creator.toLowerCase() === wallet.toLowerCase();
    const bps = BigInt(Number(pos.creatorBps));
    const credited = await Promise.all(
      currencies.map((c) => this.call<bigint>(locker, POSITION_LOCKER_ABI, "owed", [c, wallet])),
    );
    const row = (i: 0 | 1, amount: bigint): CurrencyAmount => ({ currency: currencies[i], decimals: decimals[i]!, amount });
    return {
      locker,
      tokenId: pos.tokenId,
      positionCreator: pos.creator,
      creatorBps: Number(pos.creatorBps),
      mine,
      pending: [row(0, pending[0]), row(1, pending[1])],
      pendingYours: mine ? [row(0, (pending[0] * bps) / 10_000n), row(1, (pending[1] * bps) / 10_000n)] : [],
      credited: [row(0, credited[0]!), row(1, credited[1]!)].filter((r) => r.amount > 0n),
    };
  }

  /**
   * Collect what `fees` shows this wallet is owed, and nothing else: a hook
   * credit only when this wallet is the launch's creator, a locker collect only
   * when it is the position's creator leg and something is pending, and a
   * locker claim only for a currency with a non-zero credit — every one of those
   * calls reverts on zero, and each costs gas.
   */
  async claim(fees: V2LaunchFees[], wallet: Address): Promise<{
    hookClaims: { onchainId: bigint; amount: CurrencyAmount }[];
    lockerCollects: bigint[];
    lockerClaims: CurrencyAmount[];
    txHashes: string[];
  }> {
    const txHashes: string[] = [];
    const hookClaims: { onchainId: bigint; amount: CurrencyAmount }[] = [];
    const lockerCollects: bigint[] = [];
    const lockerClaims: CurrencyAmount[] = [];
    const lockerCurrencies = new Map<string, { currency: Address; decimals: number }>();

    for (const f of fees) {
      if (f.hook && f.hook.claimable && f.hook.owed.amount > 0n) {
        const r = await this.signer.writeTx({
          address: f.hook.hook,
          abi: LAUNCH_POOL_FEE_HOOK_ABI,
          functionName: "claimCreator",
          args: [f.onchainId],
          intent: { kind: "claim", target: f.hook.hook, detail: `LaunchPoolFeeHook.claimCreator #${f.onchainId}` },
        });
        if (r.hash) txHashes.push(r.hash);
        hookClaims.push({ onchainId: f.onchainId, amount: f.hook.owed });
      }
      if (f.locker && f.locker.mine) {
        for (const c of [...f.locker.pending, ...f.locker.credited]) {
          lockerCurrencies.set(c.currency.toLowerCase(), { currency: c.currency, decimals: c.decimals });
        }
        if (f.locker.pending.some((p) => p.amount > 0n)) {
          const locker = f.locker;
          const owedNow = () =>
            Promise.all(
              locker.pending.map((p) => this.call<bigint>(locker.locker, POSITION_LOCKER_ABI, "owed", [p.currency, wallet])),
            );
          const before = await owedNow();
          const r = await this.signer.writeTx({
            address: locker.locker,
            abi: POSITION_LOCKER_ABI,
            functionName: "collect",
            args: [f.onchainId],
            intent: { kind: "claim", target: locker.locker, detail: `PositionLocker.collect #${f.onchainId}` },
            // A missing receipt is normal here; the credit landing is the proof.
            confirm: async () => (await owedNow()).some((v, i) => v > before[i]!),
          });
          if (r.hash) txHashes.push(r.hash);
          lockerCollects.push(f.onchainId);
        }
      }
    }

    // Credits are per (currency, recipient), wallet-wide — read AFTER the collects.
    for (const { currency, decimals } of lockerCurrencies.values()) {
      const owed = await this.call<bigint>(this.cfg.positionLocker, POSITION_LOCKER_ABI, "owed", [currency, wallet]);
      if (owed <= 0n) continue;
      const r = await this.signer.writeTx({
        address: this.cfg.positionLocker,
        abi: POSITION_LOCKER_ABI,
        functionName: "claim",
        args: [currency, wallet],
        intent: { kind: "claim", target: this.cfg.positionLocker, detail: `PositionLocker.claim ${currency}` },
      });
      if (r.hash) txHashes.push(r.hash);
      lockerClaims.push({ currency, decimals, amount: owed });
    }
    return { hookClaims, lockerCollects, lockerClaims, txHashes };
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
}
