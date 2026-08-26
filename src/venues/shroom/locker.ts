/**
 * The SECOND fee rail a launch earns on — the graduated Choice CLMM pool.
 *
 * A launch pays its creator twice, from two places that share nothing:
 *
 *  1. ON THE CURVE, `tradeFeeBps` accrues to a per-launch ledger on
 *     LaunchpadCore, EVM-side, claimed with `claimCreatorFees`. That is what
 *     `creatorFeesOwed` reads and `claim_fees` moves.
 *  2. AFTER GRADUATION, the pool's own swap fee accrues inside a CLMM position
 *     NFT — and the position is NOT held by the creator. It is minted into a
 *     per-launch LOCKER (a `choice_pool_seeder` instance in Locker role, the
 *     launch's `lockerAddr`), which can collect fees and can never withdraw
 *     principal. `collect_fees` is permissionless and splits every collected
 *     denom between a `treasury` leg and a `creator` leg at the same
 *     `creator_fee_share_bps` the curve used.
 *
 * Rail 2 was invisible to this package until 0.13.0, and it is not a rounding
 * difference: on the launch this shipped for, 19h after graduation the curve
 * ledger held 7.5 INJ while the locker held ~$197 of uncollected fees. A tool
 * that answers "what has this launch earned" from rail 1 alone under-reports a
 * graduated launch by whatever its pool has been doing since.
 *
 * Two shapes to keep straight:
 *  - `tokens_owed_0/1` off the manager is GROSS, pre-split. The creator's cut
 *    is `creator_fee_share_bps` of it, and it arrives partly in the LAUNCH
 *    TOKEN — a pool earns fees on both sides, so a collect pays in token0 and
 *    token1, not in the quote asset alone.
 *  - the locker names its OWN manager. We read it from `locker_config` rather
 *    than pinning a CLMM manager per network, so a manager redeploy cannot
 *    silently point this at the wrong contract.
 */

import { smartQuery, type RetryOpts } from "../../airdrops/wasm.js";
import type { CosmosExecuteMsg } from "../../chain/cosmos.js";
import { ToolError } from "../../errors.js";
import type { PolicyEngine } from "../../policy/policy.js";

/**
 * A DELIBERATELY short retry ladder.
 *
 * `smartQuery`'s default is built for merkle snapshots, where a truncated list
 * is worse than a slow one, so it spends ~15s before giving up. These reads are
 * a fee display on the hot path of `my_launches`, which loops over up to 25
 * launches — one unreachable locker on the default ladder stalls the whole
 * creator view for a quarter of a minute and returns the same answer it would
 * have returned in 250ms. Failing fast is what makes "UNKNOWN, not zero"
 * cheap enough to actually report.
 */
const READ_RETRY: RetryOpts = { attempts: 2, backoffMs: 250, maxBackoffMs: 500 };

/** `locker_config {}` — errors `WrongRole` on a factory or a sink. */
export interface LockerConfig {
  manager: string;
  treasury: string;
  /** Immutable for the life of the locker; the launch creator's bech32. */
  creator: string;
  creator_fee_share_bps: number;
  admin: string | null;
}

interface AssetInfo {
  native_token?: { denom: string };
  token?: { contract_addr: string };
}

interface PositionWithFees {
  position: { token0: AssetInfo; token1: AssetInfo };
  liquidity: string;
  tokens_owed_0: string;
  tokens_owed_1: string;
}

/** One denom's uncollected fee, GROSS — before the creator/treasury split. */
export interface LockerOwed {
  denom: string;
  gross: bigint;
}

export interface LockerPending {
  config: LockerConfig;
  /** Position NFTs the locker holds. A launchpad locker holds exactly one. */
  tokenIds: string[];
  owed: LockerOwed[];
}

const denomOf = (a: AssetInfo): string => a.native_token?.denom ?? a.token?.contract_addr ?? "";

/** Most position NFTs one locker read will enumerate. A launch locker has 1. */
const MAX_POSITIONS = 30;

export function lockerConfig(lcdUrl: string, locker: string, retry: RetryOpts = READ_RETRY): Promise<LockerConfig> {
  return smartQuery<LockerConfig>(lcdUrl, locker, { locker_config: {} }, retry);
}

/**
 * What the locker's position(s) have accrued and not yet paid out.
 *
 * Costs three reads and no gas. The equivalent before this existed was to
 * broadcast a collect and diff the wallet, which is why nobody asked.
 */
export async function lockerPending(lcdUrl: string, locker: string): Promise<LockerPending> {
  const config = await lockerConfig(lcdUrl, locker);
  const { tokens } = await smartQuery<{ tokens?: string[] }>(
    lcdUrl,
    config.manager,
    { tokens: { owner: locker, limit: MAX_POSITIONS } },
    READ_RETRY,
  );
  const ids = tokens ?? [];

  const byDenom = new Map<string, bigint>();
  for (const tokenId of ids) {
    const pos = await smartQuery<PositionWithFees>(
      lcdUrl,
      config.manager,
      { position_with_fees: { token_id: tokenId } },
      READ_RETRY,
    );
    for (const [asset, amount] of [
      [pos.position.token0, pos.tokens_owed_0],
      [pos.position.token1, pos.tokens_owed_1],
    ] as const) {
      const denom = denomOf(asset);
      const raw = BigInt(amount ?? "0");
      if (!denom || raw <= 0n) continue;
      byDenom.set(denom, (byDenom.get(denom) ?? 0n) + raw);
    }
  }

  return {
    config,
    tokenIds: ids,
    owed: [...byDenom].map(([denom, gross]) => ({ denom, gross })),
  };
}

/** This wallet's cut of a gross amount, per the locker's own split. */
export function shareOf(gross: bigint, config: LockerConfig, injAddress: string): bigint {
  const bps = BigInt(legBpsFor(config, injAddress));
  return (gross * bps) / 10_000n;
}

/**
 * Which leg of the split this wallet is, in bps. Zero when it is neither —
 * collecting a stranger's locker spends our gas to pay someone else.
 */
export function legBpsFor(config: LockerConfig, injAddress: string): number {
  const me = injAddress.toLowerCase();
  const creator = config.creator.toLowerCase() === me ? config.creator_fee_share_bps : 0;
  const treasury = config.treasury.toLowerCase() === me ? 10_000 - config.creator_fee_share_bps : 0;
  return creator + treasury;
}

/**
 * Verify a locker pays this wallet, register it as a `claim` target, and build
 * the collect message.
 *
 * 🔴 THIS FUNCTION IS THE POLICY CHECK for the whole locker path, and it is
 * the only caller of `allowPayoutLocker` in the package. A locker's bech32 is
 * per-launch and cannot be listed in `allowedTargetsFor` ahead of time, so the
 * static allowlist cannot cover it — the substitute is that the address is
 * admitted only after the CHAIN says it pays us, and only for `claim`, which
 * moves no value out of the wallet. Do not reorder these lines: registering
 * before the check would turn a per-launch address into an open target, and
 * `collect_fees` on an arbitrary contract is a signature we would be handing
 * to whatever set the launch row.
 *
 * `token_id: null` collects every position the locker owns.
 */
export async function prepareCollect(
  ctx: { lcdUrl: string; injAddress: string; policy: PolicyEngine },
  locker: string,
  config?: LockerConfig,
): Promise<CosmosExecuteMsg> {
  // Default ladder here, not READ_RETRY: this read is the security check
  // before a signature, so a busy node must not read as "unverifiable".
  const cfg = config ?? (await lockerConfig(ctx.lcdUrl, locker, {}));
  if (legBpsFor(cfg, ctx.injAddress) === 0) {
    throw new ToolError(
      "not_a_payout_leg",
      `locker ${locker} pays ${cfg.creator} and ${cfg.treasury}, neither of which is this wallet`,
      "collecting it would spend this wallet's gas to pay someone else — refused",
    );
  }
  ctx.policy.allowPayoutLocker(locker);
  return { contract: locker, msg: { collect_fees: { token_id: null } }, funds: [] };
}
