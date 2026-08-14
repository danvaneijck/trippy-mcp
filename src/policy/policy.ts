/**
 * The policy engine — the non-negotiable backstop between the model and the
 * key. `enforce()` runs INSIDE the two signers (chain/evm.ts writeTx and
 * venues/choice broadcast), never in the tool layer, so no tool wiring
 * mistake or prompt-injected instruction can route around it.
 *
 * What it guards:
 *  - kill switch (`tradingEnabled`)
 *  - target allowlist: writes only to known contracts; ERC20 approvals only
 *    to the LaunchpadCore; sweeps/transfers only to the owner address
 *  - per-tx and rolling-24h USD caps on trades/swaps/launches
 *  - slippage clamp
 */

import type { PolicyConfig } from "../config.js";
import { PolicyError } from "../errors.js";
import type { SpendLedger } from "./spend.js";

export type IntentKind =
  | "trade"
  | "swap"
  | "launch"
  | "claim"
  | "sweep"
  | "approve"
  | "airdrop"
  /**
   * ERC-8004 registry writes (register / setAgentWallet / transfer the identity
   * NFT). Allowlist-gated like everything else, but NOT spend-bearing: they move
   * no value, only gas — the same treatment `approve` and `claim` get.
   *
   * The one that *looks* like it moves value is the identity transfer, and it
   * does move an asset. It is safe to leave uncapped for the same reason `sweep`
   * is: the destination is not free. `identity transfer` sends only to
   * `ownerSweepAddress`, the address fixed at init, so a hijacked model can hand
   * the identity to the operator and nowhere else.
   */
  | "identity";

/** Intents that move value out and are therefore capped and budgeted. */
const SPEND_BEARING: ReadonlySet<IntentKind> = new Set<IntentKind>([
  "trade",
  "swap",
  "launch",
  "airdrop",
]);

export interface WriteIntent {
  kind: IntentKind;
  /**
   * The security-relevant counterparty:
   *  - trade/launch/claim: the contract being called
   *  - swap: the Choice aggregation contract the route executes on
   *  - approve: the SPENDER being authorized (not the token contract)
   *  - sweep: the destination address
   */
  target: string;
  /** Human-readable, for the audit log. */
  detail: string;
  /**
   * Where an asset ends up, when the call sends one somewhere the `target`
   * does not describe. Set by the ERC-8004 identity transfer, whose target is
   * the registry contract while the NFT itself lands with a third party — the
   * one write in the package where those differ. Pinned to the owner address,
   * exactly like `sweep`.
   */
  destination?: string;
  /**
   * USD value leaving the wallet. `undefined` = no spend (claims, approvals);
   * `null` = spend of unknown USD value (refused unless allowUnpricedSpend).
   */
  spendUsd?: number | null;
}

export class PolicyEngine {
  constructor(
    private readonly cfg: PolicyConfig,
    /** Lowercased addresses writes may target (contracts + approve spenders). */
    private readonly allowedTargets: ReadonlySet<string>,
    /** Lowercased owner sweep destination — the ONLY allowed transfer dest. */
    private readonly sweepDestination: string,
    private readonly ledger: SpendLedger,
  ) {}

  /** Throws PolicyError when the intent is not permitted. */
  enforce(intent: WriteIntent): void {
    const target = intent.target.toLowerCase();

    if (intent.kind === "sweep") {
      if (target !== this.sweepDestination) {
        throw new PolicyError(
          `sweep destination ${intent.target} is not the owner address`,
          "sweeps can only go to ownerSweepAddress fixed at init",
        );
      }
      return; // sweeps are never capped — getting funds home is always allowed
    }

    if (!this.allowedTargets.has(target)) {
      throw new PolicyError(
        `target ${intent.target} is not on the contract allowlist`,
        "writes are restricted to the LaunchpadCore, its quote assets and the Choice aggregator",
      );
    }

    if (intent.kind === "identity") {
      // The registry is allowlisted, but `safeTransferFrom` carries its own
      // recipient — so the identity NFT gets the sweep treatment rather than
      // riding on the target check that never looks at an argument.
      if (intent.destination && intent.destination.toLowerCase() !== this.sweepDestination) {
        throw new PolicyError(
          `identity destination ${intent.destination} is not the owner address`,
          "the agent identity can only be transferred to ownerSweepAddress fixed at init",
        );
      }
      return;
    }

    if (intent.kind === "claim" || intent.kind === "approve") return;

    // trade / swap / launch / airdrop — spend-bearing actions
    if (!this.cfg.tradingEnabled) {
      throw new PolicyError(
        "trading is disabled by policy",
        "set policy.tradingEnabled=true in config.json to re-enable",
      );
    }

    const airdrop = intent.kind === "airdrop";

    // Airdrops are the only action that sends value to addresses the operator
    // never named, which is exactly what the fixed sweep destination prevents
    // everywhere else. So they get their OWN per-action ceiling in place of
    // perTxCapUsd — an airdrop is not a trade and sizing it like one would mean
    // whichever of the two knobs is smaller silently governs both.
    const perActionCap = airdrop ? this.cfg.airdropCapUsd : this.cfg.perTxCapUsd;
    if (airdrop && perActionCap <= 0) {
      throw new PolicyError(
        "airdrops are disabled by policy",
        "set policy.airdropCapUsd to a positive USD amount in config.json to enable them",
      );
    }

    const spend = intent.spendUsd;
    if (spend === null || spend === undefined) {
      // `allowUnpricedSpend` is a trading convenience — it exists so an
      // illiquid token with no price feed is still tradable. It is NOT an
      // escape hatch for outbound value transfer, so it does not apply here.
      if (this.cfg.allowUnpricedSpend && !airdrop) {
        // Permitted, but not free. Letting it through untracked made the 24h
        // budget count only the trades it happened to be able to price, so an
        // agent could push out unlimited value in tokens with no feed — while
        // this file claims the budget is "the real bound". Charged at the
        // per-tx cap: the most this action could have been allowed to spend.
        this.assertWithinDailyBudget(perActionCap);
        return;
      }
      throw new PolicyError(
        `cannot price this ${intent.kind} in USD — refusing under policy`,
        airdrop
          ? "an airdrop of unpriceable assets cannot be capped, so it is always refused"
          : "set policy.allowUnpricedSpend=true to permit spends without a USD valuation",
      );
    }
    if (spend > perActionCap) {
      throw new PolicyError(
        `${airdrop ? "airdrop" : "spend"} ~$${spend.toFixed(2)} exceeds the ` +
          `${airdrop ? `per-campaign cap $${perActionCap}` : `per-tx cap $${perActionCap}`}`,
        airdrop
          ? "raise policy.airdropCapUsd in config.json (a human action) or drop less"
          : "raise policy.perTxCapUsd in config.json (a human action) or trade smaller",
      );
    }
    this.assertWithinDailyBudget(spend);
  }

  /**
   * The 24h budget is shared with every trade and swap — it, not the
   * per-campaign cap, is the real bound on what an agent can push out in a day.
   */
  private assertWithinDailyBudget(spend: number): void {
    const spent = this.ledger.spent();
    if (spent + spend > this.cfg.dailyBudgetUsd) {
      throw new PolicyError(
        `spend ~$${spend.toFixed(2)} would exceed the 24h budget ` +
          `($${spent.toFixed(2)} of $${this.cfg.dailyBudgetUsd} used)`,
        "wait for the window to roll or raise policy.dailyBudgetUsd in config.json",
      );
    }
  }

  /** Whether the airdrop tools should be registered at all. */
  airdropsEnabled(): boolean {
    return this.cfg.airdropCapUsd > 0;
  }

  airdropCapUsd(): number {
    return this.cfg.airdropCapUsd;
  }

  /** Record a broadcast spend against the 24h budget. */
  recordSpend(intent: WriteIntent): void {
    if (typeof intent.spendUsd === "number" && intent.spendUsd > 0) {
      this.ledger.record(intent.spendUsd, intent.detail);
      return;
    }
    // `null` is a spend of UNKNOWN value (`undefined` is no spend at all — a
    // claim or an approval, which must not consume budget). One that broadcast
    // did move money, so it is charged what `enforce` assumed rather than
    // nothing, which is what let it repeat without limit.
    if (intent.spendUsd === null && SPEND_BEARING.has(intent.kind)) {
      this.ledger.record(this.cfg.perTxCapUsd, `${intent.detail} (unpriced)`);
    }
  }

  /** Clamp a tool-supplied slippage to the policy ceiling. */
  clampSlippageBps(requested?: number): number {
    const req = requested ?? Math.min(100, this.cfg.maxSlippageBps);
    return Math.max(1, Math.min(req, this.cfg.maxSlippageBps));
  }

  remainingDailyUsd(): number {
    return Math.max(0, this.cfg.dailyBudgetUsd - this.ledger.spent());
  }

  snapshot(): Record<string, unknown> {
    return {
      tradingEnabled: this.cfg.tradingEnabled,
      perTxCapUsd: this.cfg.perTxCapUsd,
      dailyBudgetUsd: this.cfg.dailyBudgetUsd,
      remainingDailyUsd: this.remainingDailyUsd(),
      // Surfaced because `quote` has to be able to say that an unpriceable
      // trade is about to be refused — that refusal is decided here.
      allowUnpricedSpend: this.cfg.allowUnpricedSpend,
      maxSlippageBps: this.cfg.maxSlippageBps,
      airdropCapUsd: this.cfg.airdropCapUsd,
      airdropsEnabled: this.airdropsEnabled(),
    };
  }
}
