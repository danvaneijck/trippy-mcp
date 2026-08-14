/**
 * Managing a campaign after it exists: clawback, expiry, freeze, pause.
 *
 * Two halves.
 *
 * `manageActions` restates the contract's own rules about which action is legal
 * when. Duplicating them is deliberate and is the whole point of the module:
 * without it the agent's only way to discover that a clawback is three weeks
 * early is to sign a transaction and read the revert. Several of these actions
 * are irreversible, so "spend gas to find out" is the wrong discovery
 * mechanism — the rules are checked locally first, and the reason an action is
 * unavailable is returned in words.
 *
 * It is a restatement plus TWO deliberate extras, verified against the deployed
 * contract by simulation (2026-08-02): re-freezing an already-frozen campaign
 * and pausing a swept one are both accepted on chain, and both are no-ops.
 * They are reported unavailable here anyway, because offering an agent an
 * action whose only effect is a gas bill is worse than explaining why it is
 * pointless. Those two reasons say "this would do nothing"; every other reason
 * in the table mirrors an error the contract really does return.
 *
 * The other half builds and signs the messages. Policy runs inside the signer as
 * always; what is decided HERE is which intent kind each action carries:
 *
 *   - `clawback` moves the campaign's unclaimed remainder to its creator, which
 *     is this agent. Value flows IN, the destination is fixed by the contract
 *     and takes no argument, and there is nothing an injected prompt could point
 *     it at. That is a `claim`, not an `airdrop` — capping it under
 *     `airdropCapUsd` would mean a wallet that dropped its whole daily budget
 *     could not recover its own expired funds, which is exactly backwards.
 *   - `set_expiry`, `freeze` and `pause` move no value at all. Also `claim`.
 *
 * Nothing here can create an outbound transfer, so nothing here is capped. The
 * contract allowlist and the kill switch still apply, since every one of these
 * still goes through `PolicyEngine.enforce`.
 */

import { ToolError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import { untrustedMeta } from "../untrusted.js";
import {
  nanosToIso,
  queryCampaign,
  queryContractConfig,
  secondsToNanos,
  type Campaign,
  type CampaignResponse,
} from "./contract.js";
import { fromBaseUnits } from "./units.js";

/** The contract's MIN_WIND_DOWN_SECONDS, in ms. */
export const MIN_WIND_DOWN_MS = 7 * 24 * 60 * 60 * 1000;

const NANOS_PER_MS = 1_000_000n;

export const expiryMs = (c: Campaign): number | null =>
  c.expiry === null ? null : Number(BigInt(c.expiry) / NANOS_PER_MS);

export const isExpired = (c: Campaign, nowMs: number): boolean => {
  const at = expiryMs(c);
  return at !== null && nowMs >= at;
};

export interface Availability {
  enabled: boolean;
  /** Why not — mirrors the contract's own error. */
  reason?: string;
}

export interface ManageActions {
  freeze: Availability;
  /** Toggle: the campaign's `paused` flag says which way it would go. */
  pause: Availability;
  set_expiry: Availability & {
    /**
     * Earliest expiry the contract will accept, in ms. Extend-only for a dated
     * campaign; now + 7 days when winding down a perpetual one. Null when the
     * action is unavailable at all.
     */
    earliestMs: number | null;
  };
  clawback: Availability & { amountBase: string };
}

export type ManageAction = keyof ManageActions;

export const MANAGE_ACTIONS: ManageAction[] = ["clawback", "set_expiry", "freeze", "pause"];

/**
 * Which actions this campaign will accept right now, and why not.
 *
 * Pure and IO-free: the caller passes the campaign, its remaining balance, the
 * clock and whether the calling wallet is the creator.
 */
export function manageActions(
  campaign: Campaign,
  remaining: string,
  nowMs: number,
  isCreator: boolean,
): ManageActions {
  // Every one of these is `info.sender != campaign.creator -> Unauthorized`.
  // Owning the contract instance grants nothing over someone else's campaign.
  const notCreator = isCreator
    ? undefined
    : "only the campaign's creator can manage it, and this agent's wallet is not it";
  // The contract rejects clawback and set_expiry on a swept campaign
  // (ContractError::Swept). It does NOT reject pause — that one is ours.
  const swept = campaign.swept
    ? "this campaign was already clawed back — it is closed for good"
    : undefined;

  const expired = isExpired(campaign, nowMs);
  const dated = campaign.expiry !== null;

  const freezeReason =
    notCreator ??
    // Not a contract rule: `freeze` is idempotent on chain and a second one
    // succeeds. Withheld because it would spend gas to change nothing.
    (campaign.frozen
      ? "already frozen — the recipient list can never change, so this would spend gas and change nothing"
      : undefined) ??
    (campaign.root === null ? "nothing published yet, so there is no root to freeze" : undefined);

  let expiryReason = notCreator ?? swept;
  let earliestMs: number | null = null;
  if (!expiryReason) {
    if (dated) {
      // `expiry <= current` is rejected: an announced window only ever extends.
      earliestMs = (expiryMs(campaign) as number) + 1;
    } else if (campaign.frozen) {
      expiryReason =
        "this drop is frozen and perpetual — it promised recipients no deadline and that promise is permanent. It can never be given an expiry, and therefore never clawed back.";
    } else {
      earliestMs = nowMs + MIN_WIND_DOWN_MS;
    }
  }

  const clawbackReason =
    notCreator ??
    swept ??
    (!dated
      ? "a perpetual drop has nothing to claw back — set an expiry first, which the contract makes take at least 7 days"
      : undefined) ??
    (!expired
      ? `only after the expiry passes (${campaign.expiry ? nanosToIso(campaign.expiry) : "unknown"})`
      : undefined);

  // Also not a contract rule — `set_campaign_paused` checks only the creator,
  // so pausing a swept campaign is accepted. Withheld for the same reason as a
  // redundant freeze: a closed campaign has no claims left to pause.
  const pauseReason =
    notCreator ??
    (campaign.swept
      ? "this campaign was already clawed back — it is closed for good, so there are no claims left to pause"
      : undefined);

  return {
    freeze: { enabled: !freezeReason, ...(freezeReason ? { reason: freezeReason } : {}) },
    pause: { enabled: !pauseReason, ...(pauseReason ? { reason: pauseReason } : {}) },
    set_expiry: {
      enabled: !expiryReason,
      ...(expiryReason ? { reason: expiryReason } : {}),
      earliestMs,
    },
    clawback: {
      enabled: !clawbackReason,
      ...(clawbackReason ? { reason: clawbackReason } : {}),
      amountBase: remaining,
    },
  };
}

// ---- messages -------------------------------------------------------------
// Shapes mirror `contracts/choice_claim_drops/src/msg.rs::ExecuteMsg`.

export const freezeMsg = (id: number): object => ({ freeze: { id } });

export const setExpiryMsg = (id: number, expiryNanos: string): object => ({
  set_expiry: { id, expiry: expiryNanos },
});

export const setCampaignPausedMsg = (id: number, paused: boolean): object => ({
  set_campaign_paused: { id, paused },
});

export const clawbackMsg = (id: number): object => ({ clawback: { id } });

export const updateMetaMsg = (id: number, meta?: string, leavesUri?: string): object => ({
  update_meta: { id, meta: meta ?? null, leaves_uri: leavesUri ?? null },
});

// ---- the tool -------------------------------------------------------------

export interface ManageArgs {
  campaignId: number;
  /** Omitted → report what is possible without touching the chain. */
  action?: ManageAction;
  /** `set_expiry` only: days from NOW the campaign should expire. */
  expiryDays?: number;
  /** `pause` only: false resumes claims. Defaults to true. */
  paused?: boolean;
  /** Required for the irreversible actions (clawback, freeze). */
  confirm?: boolean;
}

/** Actions that cannot be undone once they land. */
const IRREVERSIBLE: ReadonlySet<ManageAction> = new Set<ManageAction>(["clawback", "freeze"]);

export async function manage(rt: Runtime, args: ManageArgs): Promise<Record<string, unknown>> {
  const contract = rt.net.claimDrops.contract;
  if (!contract) {
    throw new ToolError("no_contract", `the claim-drops contract is not deployed on ${rt.net.name}`);
  }
  if (!Number.isInteger(args.campaignId) || args.campaignId < 1) {
    throw new ToolError("bad_input", "campaignId must be a positive integer");
  }

  const res = await queryCampaign(rt.net.lcdUrl, contract, args.campaignId);
  const now = Date.now();
  const isCreator = res.campaign.creator === rt.injAddress;
  const actions = manageActions(res.campaign, res.remaining, now, isCreator);

  if (!args.action) return describe(rt, res, actions, isCreator);

  const action = args.action;
  const availability = actions[action];
  if (!availability.enabled) {
    throw new ToolError(
      "action_unavailable",
      `${action} is not possible on campaign #${args.campaignId}: ${availability.reason}`,
      "call airdrop_manage with no action to see the full state and what is available",
    );
  }
  if (IRREVERSIBLE.has(action) && args.confirm !== true) {
    throw new ToolError(
      "not_confirmed",
      `${action} cannot be undone — pass confirm:true`,
      action === "clawback"
        ? "clawback sweeps the unclaimed remainder back to this wallet and closes the campaign permanently; nobody can claim afterwards"
        : "freezing locks the recipient list forever",
    );
  }

  // The contract refuses everything while the whole instance is paused, so
  // check once rather than let the simulate discover it.
  const cfg = await queryContractConfig(rt.net.lcdUrl, contract).catch(() => null);
  if (cfg?.paused) {
    throw new ToolError(
      "contract_paused",
      "the claim-drops contract is paused instance-wide — no campaign action will go through until its owner unpauses it",
    );
  }

  const decimals = await campaignDecimals(rt, res.campaign);
  let msg: object;
  let detail: string;
  let expiryIso: string | null = null;

  switch (action) {
    case "clawback":
      msg = clawbackMsg(args.campaignId);
      detail = `clawback campaign #${args.campaignId}: ${amountText(res.remaining, decimals, res.campaign.denom)} back to the creator`;
      break;

    case "freeze":
      msg = freezeMsg(args.campaignId);
      detail = `freeze campaign #${args.campaignId}`;
      break;

    case "pause": {
      const paused = args.paused !== false;
      if (paused === res.campaign.paused) {
        throw new ToolError(
          "no_change",
          `campaign #${args.campaignId} is already ${paused ? "paused" : "unpaused"}`,
        );
      }
      msg = setCampaignPausedMsg(args.campaignId, paused);
      detail = `${paused ? "pause" : "resume"} claims on campaign #${args.campaignId}`;
      break;
    }

    case "set_expiry": {
      const days = args.expiryDays;
      if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
        throw new ToolError(
          "bad_input",
          "expiryDays is required for set_expiry (days from now until the drop closes)",
        );
      }
      const targetMs = now + days * 86_400_000;
      const earliest = actions.set_expiry.earliestMs as number;
      if (targetMs < earliest) {
        const current = res.campaign.expiry;
        throw new ToolError(
          "expiry_too_soon",
          `expiry must be at or after ${new Date(earliest).toISOString()}, and ${days} days from now is ${new Date(targetMs).toISOString()}`,
          current
            ? "an expiry can only be extended — the contract rejects any date at or before the one recipients were already told"
            : "winding down a perpetual drop takes at least 7 days' notice, which the contract enforces",
        );
      }
      expiryIso = new Date(targetMs).toISOString();
      msg = setExpiryMsg(args.campaignId, secondsToNanos(Math.floor(targetMs / 1000)));
      detail = `set campaign #${args.campaignId} expiry to ${expiryIso}`;
      break;
    }
  }

  const result = await rt.cosmos.execute([{ contract, msg }], {
    intent: {
      kind: "claim",
      target: contract,
      detail,
      // No spend: every action here either moves nothing or moves the
      // campaign's remainder TOWARD this wallet. See the module header.
    },
    memo: `trippy-mcp:${rt.cfg.agentName}`,
  });

  if (result.status === "dry-run") {
    return {
      status: "dry-run",
      campaignId: args.campaignId,
      action,
      wouldDo: detail,
      note: "dryRun is set in config.json — nothing was broadcast",
    };
  }

  return {
    status: "broadcast",
    campaignId: args.campaignId,
    action,
    did: detail,
    txHash: result.txHash,
    explorerUrl: result.txHash ? `${rt.net.explorerTxBase}${result.txHash}` : null,
    ...(expiryIso ? { newExpiry: expiryIso } : {}),
    ...(action === "clawback"
      ? {
          recovered: amountText(res.remaining, decimals, res.campaign.denom),
          note: "the campaign is closed permanently — anyone who had not claimed by the expiry cannot claim now",
        }
      : {}),
    next: `airdrop_status campaignId ${args.campaignId} to confirm the new state on chain`,
  };
}

/** The no-action answer: full state plus the availability table. */
function describe(
  rt: Runtime,
  res: CampaignResponse,
  actions: ManageActions,
  isCreator: boolean,
): Record<string, unknown> {
  const c = res.campaign;
  const meta = safeMeta(c.meta);
  return {
    campaignId: res.id,
    claimUrl: `${rt.net.claimDrops.claimBase}/${res.id}`,
    creator: c.creator,
    isThisAgent: isCreator,
    denom: c.denom,
    frozen: c.frozen,
    paused: c.paused,
    swept: c.swept,
    expiry: c.expiry ? nanosToIso(c.expiry) : "never (perpetual)",
    expired: isExpired(c, Date.now()),
    claimants: c.claimants,
    remainingBase: res.remaining,
    available: actions,
    hint: isCreator
      ? "call again with `action` to execute one of the enabled entries above. clawback and freeze also need confirm:true."
      : "this agent did not create this campaign, so it can only read it",
    untrusted_metadata: untrustedMeta({ title: meta.title, description: meta.description }),
  };
}

/**
 * Decimals for the amounts this file prints, or null when nothing knows.
 *
 * Registry, then the campaign's own meta, then the chain. Null is a real answer
 * here rather than a refusal, because these amounts are audit-log and response
 * TEXT — the clawback message carries a campaign id and no amount. Refusing
 * would block an operator from recovering their own funds over a display
 * string, so `amountText` prints base units instead and says so.
 */
async function campaignDecimals(rt: Runtime, c: Campaign): Promise<number | null> {
  const known = Object.values(rt.net.quoteAssets).find((q) => q.bankDenom === c.denom);
  if (known) return known.decimals;
  const meta = safeMeta(c.meta);
  if (typeof meta.decimals === "number" && meta.decimals >= 0 && meta.decimals <= 30) {
    return meta.decimals;
  }
  const { denomDecimals } = await import("../api/lcd.js");
  return denomDecimals(rt.net.lcdUrl, c.denom);
}

/** Whole tokens when the exponent is known, else an explicit base-unit figure. */
function amountText(base: string, decimals: number | null, denom: string): string {
  return decimals === null
    ? `${base} base units of ${denom} (the chain publishes no decimals for it)`
    : `${fromBaseUnits(base, decimals)} ${denom}`;
}

function safeMeta(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
