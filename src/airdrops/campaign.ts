/**
 * The airdrop rail: preview -> execute -> status.
 *
 * ORDERING DISCIPLINE (kept verbatim from the trippytools flow, because every
 * step of it is load-bearing):
 *
 *   1. publish the leaves, and verify what is stored under this root is really
 *      our tree — BEFORE anything is broadcast. The create tx writes leaves_uri
 *      on-chain and, being one-shot, freezes the root in the same block, so a
 *      drop whose leaves never landed is immutable and unclaimable: nobody can
 *      build a proof. This is the only step that can hard-stop, and it moves no
 *      value, so it goes first.
 *   2. one transaction: create + fund + auto-freeze.
 *   3. resolve the campaign id, then index it so /claim/<id> can serve it.
 *
 * A failed leaves publish stops before any value moves. A failed step 3 leaves
 * a live, claimable drop that just is not indexed yet — recoverable, and
 * `airdrop_status` re-resolves it.
 */

import { ToolError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import { untrustedMeta } from "../untrusted.js";
import { exclusionSet } from "./address.js";
import {
  allocateExact,
  applyMinAmount,
  applyMinWeight,
  applyTopN,
  applyVoteOptions,
  type DistMode,
  type SourceRow,
} from "./allocate.js";
import {
  createOneShotDropMsg,
  findCampaignIdByRoot,
  nanosToIso,
  parseCampaignId,
  queryCampaign,
  queryContractConfig,
  leavesUriForRoot,
  secondsToNanos,
} from "./contract.js";
import { publishLeaves, recordAirdropLog, recordCampaign } from "./hasura.js";
import { buildTree } from "./merkle.js";
import { loadPlan, planId as makePlanId, savePlan, updatePlan, type StoredPlan } from "./plan.js";
import { denomBalance, denomSymbol, dropDecimals, usdValue } from "./pricing.js";
import { executePush, pushStatus, MAX_PUSH_RECIPIENTS, type PushRun } from "./push.js";
import { loadCheckpoint } from "./checkpoint.js";
import { loadSource, normalizeVoteOption, type Source } from "./sources.js";
import { buildLeavesFromRows, fromBaseUnits, isValidAmount, toBaseUnits } from "./units.js";

export interface PreviewArgs {
  source: Source;
  filters?: {
    topN?: number;
    minWeight?: number;
    minAmount?: string;
    exclude?: string[];
    voteOptions?: string[];
  };
  allocation: { mode?: DistMode; total?: string; asset: string };
  delivery?: {
    rail?: Rail;
    title?: string;
    description?: string;
    expiryDays?: number;
    perpetual?: boolean;
  };
}

export type Rail = "claim_drop" | "push";

const DEFAULT_EXPIRY_DAYS = 30;
/** More leaves than one preview will build. Beyond this, split the campaign. */
const MAX_RECIPIENTS = 50_000;

export async function preview(rt: Runtime, args: PreviewArgs): Promise<Record<string, unknown>> {
  const rail: Rail = args.delivery?.rail ?? "claim_drop";
  // The claim rail needs its contract; the push rail is a bank message and
  // works on any network, so it must not be gated on a contract deployment.
  const contract = rail === "claim_drop" ? requireContract(rt) : null;
  const asset = args.allocation.asset;
  if (!asset) throw new ToolError("bad_input", "allocation.asset is required (the denom to drop)");

  const decimals = await dropDecimals(rt, asset);
  const loaded = await loadSource(rt, args.source);
  // Source-level caveats (an in-progress vote, tokens with no resolvable owner,
  // a gov snapshot's weights being vote weight rather than stake) surface in
  // the same list as everything else the preview wants read before executing.
  const warnings: string[] = [...(loaded.warnings ?? [])];

  // ---- rows -> per-address whole-token amounts ----------------------------
  let amountRows: { address: string; amount: string }[];
  // Proportionate is the right default for a holdings snapshot. A gov snapshot
  // has no stake weight to be proportionate TO — every voter's weight is the
  // weight of their vote, which is ~1 — so it defaults the other way rather
  // than producing an equal split under a name that implies otherwise.
  let mode: DistMode =
    args.allocation.mode ?? (args.source.kind === "gov_voters" ? "fair" : "proportionate");
  let allocatorDroppedZero = 0;
  let allocatorMergedRows = 0;

  if (args.source.kind === "csv") {
    // A CSV carries its own amounts, so the allocator is bypassed entirely and
    // `total` is whatever the rows add up to.
    if (args.allocation.total) {
      warnings.push(
        "allocation.total is ignored for a csv source — the rows carry their own amounts, and the drop's total is their sum",
      );
    }
    for (const r of args.source.rows) {
      if (!isValidAmount(r.amount)) {
        throw new ToolError("bad_amount", `csv row for ${r.address} has an unusable amount "${r.amount}"`);
      }
    }
    amountRows = args.source.rows;
    mode = "proportionate";
  } else {
    if (!args.allocation.total) {
      throw new ToolError("bad_input", "allocation.total is required for a snapshot source");
    }
    if (!isValidAmount(args.allocation.total)) {
      throw new ToolError("bad_amount", `allocation.total "${args.allocation.total}" is not a plain decimal amount`);
    }
    const totalBase = BigInt(toBaseUnits(args.allocation.total, decimals).base);
    if (totalBase <= 0n) throw new ToolError("bad_amount", "allocation.total must be positive");

    let rows: SourceRow[] = loaded.rows;
    const excludeSet = new Set((args.filters?.exclude ?? []).map((a) => a.trim()));
    if (excludeSet.size > 0) rows = rows.filter((r) => !excludeSet.has(r.address));
    if (args.filters?.voteOptions && args.filters.voteOptions.length > 0) {
      const wanted = args.filters.voteOptions.map(normalizeVoteOption);
      const before = rows.length;
      rows = applyVoteOptions(rows, wanted);
      if (rows.length === before && !loaded.rows.some((r) => r.voteOption !== undefined)) {
        warnings.push(
          `filters.voteOptions was ignored — ${args.source.kind} rows carry no vote, so there was nothing to filter on`,
        );
      }
    }
    if (args.filters?.minWeight) rows = applyMinWeight(rows, args.filters.minWeight);
    if (args.filters?.topN) rows = applyTopN(rows, args.filters.topN);
    if (args.filters?.minAmount) {
      const minBase = BigInt(toBaseUnits(args.filters.minAmount, decimals).base);
      rows = applyMinAmount(rows, totalBase, mode, minBase);
    }
    if (rows.length === 0) {
      throw new ToolError(
        "no_recipients",
        "no wallets survived the filters",
        "loosen filters.topN / minWeight / minAmount, or check the source has holders",
      );
    }

    const allocated = allocateExact(rows, totalBase, mode);
    allocatorDroppedZero = allocated.droppedZero;
    allocatorMergedRows = allocated.mergedRows;
    if (allocated.droppedZero > 0) {
      warnings.push(
        `${allocated.droppedZero} wallets allocated to 0 base units and were dropped — their share was below one unit of ${asset}`,
      );
    }
    amountRows = allocated.allocations.map((a) => ({
      address: a.address,
      amount: fromBaseUnits(a.amountBase, decimals),
    }));
  }

  // ---- leaves ------------------------------------------------------------
  // Exclusions are applied HERE as well as inside the snapshot sources, because
  // a csv never passes through a snapshot at all — without this, a pasted list
  // could allocate to a bank-blocked module account, and those funds would be
  // frozen in the contract with no key in existence that could claim them.
  const built = buildLeavesFromRows(amountRows, decimals, {
    isBlocked: exclusionSet(args.filters?.exclude ?? []),
  });
  if (built.leaves.length === 0) {
    throw new ToolError("no_recipients", "no valid recipients left after validation");
  }
  const railCap = rail === "push" ? MAX_PUSH_RECIPIENTS : MAX_RECIPIENTS;
  if (built.leaves.length > railCap) {
    throw new ToolError(
      "too_many_recipients",
      `${built.leaves.length} recipients exceeds the ${railCap} cap for one ${rail} drop`,
      rail === "push"
        ? `the push rail sends every recipient in ONE transaction so the per-campaign policy cap means what it says — narrow with filters.topN, or use the claim_drop rail, which handles ${MAX_RECIPIENTS} in a single tx`
        : "narrow with filters.topN or filters.minWeight",
    );
  }
  if (built.invalidRows > 0) {
    warnings.push(
      `${built.invalidRows} rows were dropped for failing bech32 checksum validation (e.g. ${built.invalidSamples.join(", ")}) — a mistyped address in a frozen campaign is permanently unclaimable, so they are never included`,
    );
  }
  if (built.blockedRows > 0) {
    warnings.push(`${built.blockedRows} rows were dropped as blocked or excluded addresses`);
  }
  if (built.truncatedRows > 0) {
    warnings.push(
      `${built.truncatedRows} amounts carried more precision than ${asset} has decimals and were floored`,
    );
  }
  if (loaded.excludedCount > 0) {
    warnings.push(
      `${loaded.excludedCount} non-wallet holders were excluded from the snapshot (module accounts, burn addresses, and for a launch its own sink which holds the unsold supply)`,
    );
  }

  const tree = buildTree(built.leaves);

  // ---- valuation + policy dry-run ----------------------------------------
  // Indicative only. `execute` re-prices what it is actually about to attach,
  // because this figure can be an hour old by then.
  const totalWhole = fromBaseUnits(tree.total, decimals);
  const totalUsd = await usdValue(rt, asset, totalWhole);
  const cap = rt.policy.airdropCapUsd();
  const policyCheck: Record<string, unknown> = {
    airdropCapUsd: cap,
    totalUsd,
    remainingDailyUsd: rt.policy.remainingDailyUsd(),
  };
  if (totalUsd === null) {
    policyCheck.verdict = "will be REFUSED — an airdrop that cannot be priced cannot be capped";
    // Say WHY it could not be priced. The quote assets are valued off the pump
    // API's USD feed, and the testnet NetworkDef ships no pumpApiBase — so on
    // testnet EVERY airdrop is unpriceable, and the bare verdict above reads
    // like a policy decision rather than a missing endpoint.
    const isQuoteAsset = Object.values(rt.net.quoteAssets).some((q) => q.bankDenom === asset);
    policyCheck.whyUnpriced = !rt.net.pumpApiBase
      ? `no pumpApiBase is configured for ${rt.net.name}, so the quote-asset USD feed is unreachable and nothing on this network can be priced — set pumpApiBase in config.json`
      : isQuoteAsset
        ? "the quote-asset USD feed did not return a rate for this asset"
        : `no USD price could be resolved for ${asset} from the Choice token API`;
  } else if (totalUsd > cap) {
    policyCheck.verdict = `will be REFUSED — $${totalUsd.toFixed(2)} exceeds the per-campaign cap $${cap}`;
  } else if (totalUsd > rt.policy.remainingDailyUsd()) {
    policyCheck.verdict = `will be REFUSED — $${totalUsd.toFixed(2)} exceeds what is left of the 24h budget`;
  } else {
    policyCheck.verdict = "passes the local policy caps";
  }
  policyCheck.note =
    "indicative: execute re-prices the drop at broadcast time and enforces against that, so a price move inside the plan's 1h life can still change the verdict";

  // ---- funding check ------------------------------------------------------
  // A push drop attaches no platform fee and executes no contract, so it needs
  // exactly the total and neither of the contract reads below.
  const cfg =
    contract === null ? null : await queryContractConfig(rt.net.lcdUrl, contract).catch(() => null);
  if (contract !== null && cfg === null) {
    warnings.push(
      "the claim-drops contract config could not be read, so the platform fee is assumed to be 0 — if the instance charges one, this preview understates what the drop needs",
    );
  }
  const feeBps = cfg?.fee_bps ?? 0;
  const balance = await denomBalance(rt, asset);
  const required = BigInt(tree.total) + BigInt(ceil(tree.total, feeBps));
  const funded = balance === null ? null : balance >= required;
  if (funded === false) {
    warnings.push(
      `the agent wallet holds ${fromBaseUnits(balance!.toString(), decimals)} ${asset} but this drop needs ${fromBaseUnits(required.toString(), decimals)} — fund the wallet before executing`,
    );
  }
  if (cfg?.paused) warnings.push("the claim-drops contract is paused — execute will fail until it is unpaused");

  // ---- expiry -------------------------------------------------------------
  // A push drop has no expiry to have: the tokens land in wallets, so there is
  // nothing left unclaimed and nothing to claw back.
  const perpetual = args.delivery?.perpetual === true;
  const expiryDays = args.delivery?.expiryDays ?? DEFAULT_EXPIRY_DAYS;
  const expiryNanos =
    rail === "push" || perpetual
      ? null
      : secondsToNanos(Math.floor(Date.now() / 1000) + expiryDays * 86_400);
  if (rail === "push" && (perpetual || args.delivery?.expiryDays !== undefined)) {
    warnings.push(
      "delivery.expiryDays / perpetual do not apply to the push rail — the tokens are sent directly, so there is nothing to expire",
    );
  }
  if (rail !== "push" && perpetual) {
    warnings.push(
      "perpetual: this campaign never expires, which means unclaimed funds can NEVER be clawed back — they stay in the contract forever",
    );
  }
  if (rail === "push") {
    warnings.push(
      "the push rail sends to every recipient IRREVERSIBLY and with no claim step — a wrong address here is not an unclaimed leaf, it is somebody else's money. Read topRecipients before executing.",
    );
  }

  const symbol = await denomSymbol(rt, asset);
  const criteria = `${loaded.description}, ${mode} split of ${totalWhole} ${symbol ?? asset}`;
  const id = makePlanId(rt.injAddress, asset, tree.leaves);
  const plan: StoredPlan = {
    planId: id,
    createdAt: new Date().toISOString(),
    network: rt.net.name,
    rail,
    sender: rt.injAddress,
    denom: asset,
    symbol,
    decimals,
    rootHex: tree.rootHex,
    totalBase: tree.total,
    leaves: tree.leaves,
    meta: {
      title: args.delivery?.title ?? `Drop to ${loaded.description}`,
      symbol: symbol ?? asset,
      decimals,
      ...(args.delivery?.description ? { description: args.delivery.description } : {}),
      // Flags the drop as agent-made everywhere it surfaces: this blob is
      // written on-chain as the campaign's `meta` AND stored in the campaign
      // row, so the claim page can say who created it.
      createdBy: `trippy-mcp:${rt.cfg.agentName}`,
    },
    expiryNanos,
    totalUsd,
    criteria,
    snapshotAt: loaded.snapshotAt,
    ...(loaded.snapshotHeight !== undefined ? { snapshotHeight: loaded.snapshotHeight } : {}),
  };
  savePlan(rt.home, plan);

  return {
    planId: id,
    rail,
    recipientCount: tree.leaves.length,
    total: `${totalWhole} ${symbol ?? asset}`,
    totalBase: tree.total,
    totalUsd,
    // For a push drop the root is published nowhere — it is just a stable
    // fingerprint of the exact list, which is also what planId is derived from.
    root: tree.rootHex,
    mode,
    criteria,
    snapshotAt: loaded.snapshotAt,
    ...(loaded.snapshotHeight !== undefined
      ? { snapshotHeight: loaded.snapshotHeight, snapshotIsAtHeight: true }
      : {}),
    weightUnit: loaded.weightUnit,
    topRecipients: [...tree.leaves]
      .sort((a, z) => {
        const d = BigInt(z.amount) - BigInt(a.amount);
        return d > 0n ? 1 : d < 0n ? -1 : 0;
      })
      .slice(0, 10)
      .map((l) => ({ address: l.address, amount: fromBaseUnits(l.amount, decimals) })),
    // Both stages can drop a zero: the allocator when a share rounds to nothing,
    // and the leaf builder when a supplied amount floors to nothing. Reporting
    // only the second reads as 0 on every snapshot source, because the allocator
    // has already removed its own before the leaf builder ever sees them.
    droppedZero: built.zeroRows + allocatorDroppedZero,
    mergedRows: built.mergedRows + allocatorMergedRows,
    truncatedRows: built.truncatedRows,
    blockedRows: built.blockedRows + loaded.excludedCount,
    invalidRows: built.invalidRows,
    funded,
    walletBalance: balance === null ? null : fromBaseUnits(balance.toString(), decimals),
    contractFeeBps: feeBps,
    expiry:
      rail === "push"
        ? "n/a — a push drop lands in wallets and has nothing to expire"
        : expiryNanos
          ? nanosToIso(expiryNanos)
          : "never (perpetual — not clawback-able)",
    transactions: rail === "push" ? Math.ceil(tree.leaves.length / MAX_PUSH_RECIPIENTS) : 1,
    policyCheck,
    warnings,
    next: `nothing has been published or broadcast yet. Review the recipients, then call airdrop_execute with planId "${id}" and confirm:true. The plan expires in 1 hour.`,
  };
}

export async function execute(
  rt: Runtime,
  args: { planId: string; confirm?: boolean },
): Promise<Record<string, unknown>> {
  if (args.confirm !== true) {
    throw new ToolError(
      "not_confirmed",
      "airdrop_execute requires confirm:true — this moves funds out of the wallet",
    );
  }

  // A push plan is RESUMABLE, and its resume is reached through this same call,
  // so it must survive both guards a claim plan is held to: the single-use mark
  // (whose whole purpose is to stop a second claim campaign being funded — a
  // push resume is the opposite, it is how the run finishes) and the snapshot
  // TTL, but only once there is progress to resume. A push plan with nothing
  // paid yet is just an un-executed plan, and an hour-old snapshot is as stale
  // for it as for any other.
  const peek = loadPlan(rt.home, args.planId, { allowStale: true });
  if (peek.rail === "push") {
    const cp = loadCheckpoint(rt.home, args.planId);
    const started = (cp?.paid.length ?? 0) > 0 || (cp?.failed.length ?? 0) > 0;
    const plan = started ? peek : loadPlan(rt.home, args.planId);
    requireOwnPlan(rt, plan);
    const decimals = await dropDecimals(rt, plan.denom);
    const symbol = plan.symbol ?? plan.denom;
    if (!plan.attemptedAt) {
      updatePlan(rt.home, plan.planId, { attemptedAt: new Date().toISOString() });
    }
    const run = await executePush(rt, plan, { decimals, symbol });
    await logPushDrop(rt, plan, run);
    return run.result;
  }

  const contract = requireContract(rt);
  const plan = loadPlan(rt.home, args.planId);
  requireOwnPlan(rt, plan);
  if (plan.attemptedAt) {
    throw new ToolError(
      "already_attempted",
      `this plan was already broadcast at ${plan.attemptedAt}${plan.campaignId ? ` as campaign #${plan.campaignId}` : ""}`,
      `call airdrop_status with planId "${plan.planId}" to find the campaign. Executing again would fund a SECOND campaign for the same list.`,
    );
  }

  // Rebuild from the stored leaves rather than trusting the stored root: the
  // plan file is on disk and the root is what gets frozen on-chain.
  const tree = buildTree(plan.leaves);
  if (tree.rootHex !== plan.rootHex) {
    throw new ToolError(
      "plan_corrupt",
      "the stored plan's leaves no longer rebuild to its root — refusing to publish",
      "run airdrop_preview again",
    );
  }

  const cfg = await queryContractConfig(rt.net.lcdUrl, contract);
  if (cfg.paused) throw new ToolError("contract_paused", "the claim-drops contract is paused");

  // A campaign of ours already carrying this root means a previous execute
  // landed, whatever it reported back. Refuse before doing anything else.
  const existing = await findCampaignIdByRoot(
    rt.net.lcdUrl,
    contract,
    rt.injAddress,
    tree.rootHex,
  ).catch(() => null);
  if (existing !== null) {
    updatePlan(rt.home, plan.planId, { campaignId: existing });
    throw new ToolError(
      "already_funded",
      `campaign #${existing} already exists for this exact recipient list — it was funded by an earlier execute`,
      `check it with airdrop_status campaignId ${existing}. Funding again would create a duplicate drop.`,
    );
  }

  const leavesUri = leavesUriForRoot(rt.net.claimDrops.leavesBase, tree.rootHex);

  // STEP 1 — leaves first, verified. Nothing has moved yet, and this is the
  // only step that can hard-stop.
  await publishLeaves(
    rt.net.claimDrops.hasuraUrl,
    tree.rootHex,
    tree.total,
    tree.leaves,
    rt.injAddress,
  );

  // STEP 2 — one tx: create + fund + auto-freeze.
  const { msg, funds } = createOneShotDropMsg({
    denom: plan.denom,
    meta: JSON.stringify(plan.meta),
    rootHex: tree.rootHex,
    total: tree.total,
    leavesUri,
    expiryNanos: plan.expiryNanos,
    feeBps: cfg.fee_bps,
  });

  // Price at EXECUTE time, not at preview time. The policy cap has to be
  // applied to what is actually about to leave the wallet: a token that moved
  // inside the plan's 1h TTL would otherwise be capped against an hour-old
  // valuation, and a 3x means the operator's ceiling was never the real bound.
  // Value the ATTACHED funds (total + the instance's fee), not just the total.
  const fundsWhole = fromBaseUnits(funds.amount, plan.decimals);
  const spendUsd = await usdValue(rt, plan.denom, fundsWhole);

  // Written BEFORE the broadcast: a tx that lands and still throws (the sdk
  // gives up on the inclusion wait while it sits in the mempool) must not leave
  // a plan that looks un-executed and invites a retry.
  const dryRun = rt.cfg.dryRun;
  if (!dryRun) updatePlan(rt.home, plan.planId, { attemptedAt: new Date().toISOString() });

  let res;
  try {
    res = await rt.cosmos.execute([{ contract, msg, funds: [funds] }], {
      intent: {
        kind: "airdrop",
        target: contract,
        detail: `claim drop: ${plan.leaves.length} recipients, ${fromBaseUnits(tree.total, plan.decimals)} ${plan.symbol ?? plan.denom}`,
        spendUsd,
      },
      memo: `trippy-mcp:${rt.cfg.agentName}`,
    });
  } catch (e) {
    // The throw may mean "rejected" or it may mean "we stopped waiting". Ask
    // the chain which, because the two need opposite responses from the caller.
    const landed = await findCampaignIdByRoot(
      rt.net.lcdUrl,
      contract,
      rt.injAddress,
      tree.rootHex,
    ).catch(() => null);
    if (landed !== null) {
      updatePlan(rt.home, plan.planId, { campaignId: landed });
      throw new ToolError(
        "broadcast_uncertain_but_landed",
        `the broadcast call failed, but campaign #${landed} IS on chain and funded — the transaction landed after the client stopped waiting`,
        `the drop is live: check it with airdrop_status campaignId ${landed}. Do NOT execute again.`,
      );
    }
    if (e instanceof ToolError) {
      throw new ToolError(
        e.code,
        e.message,
        `no campaign with this root exists on chain, so the funds did not move. This plan is now locked against retry — run airdrop_preview again to get a fresh one. (${e.hint ?? ""})`.trim(),
      );
    }
    throw e;
  }

  if (res.status === "dry-run") {
    return {
      status: "dry-run",
      planId: plan.planId,
      root: tree.rootHex,
      leavesPublished: true,
      wouldSpendUsd: spendUsd,
      note: "dryRun is set in config.json — the leaves were published (harmless and reusable) but no campaign was created",
    };
  }

  // STEP 3 — resolve the id and index it. The plan file is KEPT (marked
  // executed): it is the only thing that can turn this planId back into a root
  // if the id cannot be read here, which is exactly what airdrop_status needs.
  let campaignId = parseCampaignId(res.raw);
  if (campaignId === null) {
    campaignId = await findCampaignIdByRoot(
      rt.net.lcdUrl,
      contract,
      rt.injAddress,
      tree.rootHex,
    ).catch(() => null);
  }
  updatePlan(rt.home, plan.planId, { txHash: res.txHash, campaignId });

  const notes: string[] = [];
  if (campaignId !== null) {
    try {
      await recordCampaign(rt.net.claimDrops.hasuraUrl, {
        network: rt.net.name,
        contract,
        campaignId,
        root: tree.rootHex,
        denom: plan.denom,
        symbol: plan.symbol,
        decimals: plan.decimals,
        meta: plan.meta,
        creator: rt.injAddress,
        txHash: res.txHash,
      });
    } catch (e) {
      notes.push(
        `the drop is LIVE and claimable, but indexing it for the claim page failed (${e instanceof Error ? e.message : String(e)}) — it will still resolve from the chain`,
      );
    }
  } else {
    notes.push(
      "the drop was created but its campaign id could not be resolved from the tx — call airdrop_status with this planId shortly to find it by root. Do NOT re-run execute: that would fund a second, duplicate campaign.",
    );
  }

  return {
    status: "broadcast",
    campaignId,
    claimUrl: campaignId === null ? null : `${rt.net.claimDrops.claimBase}/${campaignId}`,
    txHash: res.txHash,
    explorerUrl: res.txHash ? `${rt.net.explorerTxBase}${res.txHash}` : null,
    root: tree.rootHex,
    leavesUri,
    recipientCount: tree.leaves.length,
    total: `${fromBaseUnits(tree.total, plan.decimals)} ${plan.symbol ?? plan.denom}`,
    expiry: plan.expiryNanos ? nanosToIso(plan.expiryNanos) : "never (perpetual)",
    frozen: true,
    notes,
  };
}

export async function status(
  rt: Runtime,
  args: { campaignId?: number; planId?: string },
): Promise<Record<string, unknown>> {
  // A push plan has no campaign at all — its state is the checkpoint — so it is
  // answered before the claim-drop contract is even required.
  if (args.campaignId === undefined && args.planId) {
    const peek = loadPlan(rt.home, args.planId, { allowStale: true });
    if (peek.rail === "push") return pushStatus(rt, peek, loadCheckpoint(rt.home, args.planId));
  }

  const contract = requireContract(rt);

  let campaignId = args.campaignId ?? null;
  if (campaignId === null && args.planId) {
    // A plan whose execute lost its id: find the campaign by its root.
    const plan = loadPlan(rt.home, args.planId, { allowStale: true });
    // Recorded id first; otherwise ask the chain which campaign carries the
    // plan's root. This is the recovery path for an execute whose tx landed but
    // whose id could not be read back, so the plan file is deliberately kept
    // after execution rather than deleted.
    campaignId =
      plan.campaignId ??
      (await findCampaignIdByRoot(rt.net.lcdUrl, contract, rt.injAddress, plan.rootHex));
    if (campaignId === null) {
      return {
        planId: args.planId,
        campaignId: null,
        state: plan.attemptedAt ? "broadcast attempted, not on chain" : "never executed",
        attemptedAt: plan.attemptedAt ?? null,
        root: plan.rootHex,
        note: plan.attemptedAt
          ? "a broadcast was attempted but no campaign of this wallet carries that root — the transaction did not land, and the funds did not move. Preview again for a fresh plan."
          : "no campaign of this wallet carries that plan's root — it was never executed",
      };
    }
  }
  if (campaignId === null) {
    throw new ToolError("bad_input", "pass campaignId or planId");
  }

  const res = await queryCampaign(rt.net.lcdUrl, contract, campaignId);
  const c = res.campaign;
  // Same registry-first resolution `preview` uses. Going straight to
  // denomDecimals here would report a USDC drop a trillion-fold wrong whenever
  // the metadata read misses, and this is the number a human checks a frozen
  // campaign against.
  const decimals = await dropDecimals(rt, c.denom);
  const meta = safeMeta(c.meta);

  return {
    campaignId: res.id,
    claimUrl: `${rt.net.claimDrops.claimBase}/${res.id}`,
    creator: c.creator,
    isThisAgent: c.creator === rt.injAddress,
    denom: c.denom,
    total: fromBaseUnits(c.total, decimals),
    claimed: fromBaseUnits(c.claimed_total, decimals),
    remaining: fromBaseUnits(res.remaining, decimals),
    claimants: c.claimants,
    claimedPct: BigInt(c.total) > 0n ? Number((BigInt(c.claimed_total) * 10_000n) / BigInt(c.total)) / 100 : 0,
    frozen: c.frozen,
    paused: c.paused,
    swept: c.swept,
    expiry: c.expiry ? nanosToIso(c.expiry) : "never (perpetual)",
    expired: c.expiry ? Date.now() > Number(BigInt(c.expiry) / 1_000_000n) : false,
    root: c.root,
    leavesUri: c.leaves_uri,
    untrusted_metadata: untrustedMeta({
      title: meta.title,
      description: meta.description,
      createdBy: meta.createdBy,
    }),
  };
}

// ---------------------------------------------------------------------------

function requireOwnPlan(rt: Runtime, plan: StoredPlan): void {
  if (plan.sender !== rt.injAddress) {
    throw new ToolError("wrong_wallet", "this plan was previewed by a different wallet");
  }
  if (plan.network !== rt.net.name) {
    throw new ToolError("wrong_network", `this plan was previewed on ${plan.network}`);
  }
}

/**
 * Mirror a finished push drop into the site's airdrop history.
 *
 * Best-effort and deliberately last: the transactions have already landed, so a
 * Hasura failure is a missing history row, never a failed drop. Only recipients
 * a landed transaction actually paid are logged, so a partial run reads as what
 * it was.
 *
 * MAINNET ONLY, and not for a policy reason — for a schema one. The claim-drop
 * tables carry a `network` column, so a testnet campaign is distinguishable
 * there; these three do not. `airdrop_tracker_airdroplog` has no network
 * column, and the two tables its foreign keys point at (`token_tracker_token`,
 * `wallet_tracker_wallet`) are the site's shared token and wallet registries.
 * Writing a testnet drop would therefore put a testnet denom in the site's
 * token table and a row with unresolvable tx hashes in the airdrop history real
 * users read, with nothing to filter it back out by. The Hasura endpoint is the
 * same production host on both networks, so this is the only place the
 * distinction can be made.
 */
async function logPushDrop(rt: Runtime, plan: StoredPlan, run: PushRun): Promise<void> {
  const result = run.result;
  const txHashes = (result.txHashes as string[] | undefined) ?? [];
  if (result.status !== "broadcast" || txHashes.length === 0) return;
  if (rt.net.name !== "mainnet") {
    const notes = (result.notes as string[] | undefined) ?? [];
    notes.push(
      `this drop was NOT written to the site's airdrop history because it ran on ${rt.net.name} — that history has no network column, and the site would show a ${rt.net.name} drop as if it were live`,
    );
    result.notes = notes;
    return;
  }
  // Only what THIS run paid: a drop finished across two calls should produce
  // two history rows that partition the recipients, not two that overlap.
  const paid = new Set(run.paidThisRun);
  const recipients = plan.leaves.filter((l) => paid.has(l.address));
  if (recipients.length === 0) return;

  const totalBase = recipients.reduce((s, l) => s + BigInt(l.amount), 0n);
  const unsendable = (result.unsendable as { address: string }[] | undefined)?.length ?? 0;
  try {
    await recordAirdropLog(rt.net.claimDrops.hasuraUrl, {
      denom: plan.denom,
      sender: plan.sender,
      amountDropped: Number(fromBaseUnits(totalBase.toString(), plan.decimals)),
      recipients: recipients.map((l) => l.address),
      criteria: plan.criteria,
      description:
        `${(plan.meta.description as string | undefined) ?? ""} [created by ${plan.meta.createdBy ?? "trippy-mcp"}]` +
        (unsendable > 0
          ? ` [partial: ${unsendable} unsendable address(es) skipped]`
          : ""),
      txHashes,
    });
  } catch (e) {
    const notes = (result.notes as string[] | undefined) ?? [];
    notes.push(
      `the drop landed but writing it to the site's airdrop history failed (${e instanceof Error ? e.message : String(e)}) — the transactions are on chain regardless`,
    );
    result.notes = notes;
  }
}

function requireContract(rt: Runtime): string {
  const contract = rt.net.claimDrops.contract;
  if (!contract) {
    throw new ToolError(
      "no_contract",
      `the claim-drops contract is not deployed on ${rt.net.name}`,
    );
  }
  return contract;
}

function ceil(total: string, feeBps: number): string {
  if (feeBps <= 0) return "0";
  return ((BigInt(total) * BigInt(feeBps) + 9_999n) / 10_000n).toString();
}

function safeMeta(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
