/**
 * Runtime assembly: config + keystore → clients, signer, policy, venues.
 * Built once per process (MCP serve or CLI command).
 */

import { formatUnits } from "viem";

import { AuditLog } from "./audit.js";
import { ChoiceApi } from "./api/choice.js";
import { ChoiceV2Api } from "./api/choiceV2.js";
import { balanceOf, bankBalances } from "./api/lcd.js";
import { PumpApi } from "./api/pump.js";
import { BANK_MULTISEND_TARGET, CosmosSigner } from "./chain/cosmos.js";
import { EvmSigner } from "./chain/evm.js";
import { coreDeployments, getNetwork, makeChain, type NetworkDef } from "./chain/networks.js";
import { makeTransport } from "./chain/transport.js";
import { homeDir as defaultHomeDir, loadConfig, type Config } from "./config.js";
import { evmToInj, loadKeystore, unlockKeystore } from "./keystore.js";
import { PolicyEngine, type ExactApprovalSpender } from "./policy/policy.js";
import { SpendLedger } from "./policy/spend.js";
import { ChoiceVenue } from "./venues/choice/swap.js";
import { ChoiceV2Venue } from "./venues/choiceV2/venue.js";
import { ShroomVenue } from "./venues/shroom/launchpad.js";

export interface Runtime {
  cfg: Config;
  net: NetworkDef;
  home: string;
  audit: AuditLog;
  policy: PolicyEngine;
  pump: PumpApi;
  choiceApi: ChoiceApi;
  signer: EvmSigner;
  cosmos: CosmosSigner;
  injAddress: string;
  shroom: ShroomVenue;
  choice: ChoiceVenue;
  /** Choice v2 read API; null where the network has no v2 deployment. */
  choiceV2Api: ChoiceV2Api | null;
  /** Choice v2 (Infinity CL, EVM) venue; null where the network has none. */
  choiceV2: ChoiceV2Venue | null;
  /** USD value of a v2 swap leg (`native` = INJ); null when nothing can mark it. */
  choiceV2UsdValue: (token: string, amount: bigint, decimals: number) => Promise<number | null>;
}

/** Apply per-install endpoint overrides onto the vendored network def. */
export function effectiveNetwork(cfg: Config): NetworkDef {
  const base = getNetwork(cfg.network);
  return {
    ...base,
    rpcUrls: cfg.rpcUrls && cfg.rpcUrls.length > 0 ? cfg.rpcUrls : base.rpcUrls,
    lcdUrl: cfg.lcdUrl ?? base.lcdUrl,
    pumpApiBase: cfg.pumpApiBase ?? base.pumpApiBase,
    choiceApiBase: cfg.choiceApiBase ?? base.choiceApiBase,
    // Unioned, not replaced: a per-install addition must never silently drop a
    // built-in, or a wallet holding SHROOM would go back to reporting nothing.
    cw20Tokens: [...new Set([...base.cw20Tokens, ...(cfg.cw20Tokens ?? [])])],
    gasPriceWei: cfg.gasPriceWei ? BigInt(cfg.gasPriceWei) : base.gasPriceWei,
  };
}

/**
 * Every contract a write may target, lowercased.
 *
 * Exported because it IS the policy surface: a contract missing from here is
 * refused inside the signer with "target … is not on the contract allowlist",
 * no matter how correct the calling code is. That failure mode is invisible
 * until someone tries the write on a live network, so it gets its own test.
 */
export function allowedTargetsFor(net: NetworkDef): Set<string> {
  return new Set(
    [
      // EVERY deployed core, not just the current one. A superseded core keeps
      // trading, graduating and paying out the launches already on it — eight
      // of mainnet's sixteen v1 launches were still in Trading when the v2 core
      // went live, and four were Cancelled with a refund owed. Listing only the
      // current core refused all of that inside the signer, which reads as the
      // policy engine working rather than as a missing address.
      ...coreDeployments(net).map((d) => d.core),
      net.addresses.winj9,
      ...Object.values(net.quoteAssets).map((q) => q.pairAsset),
      net.choiceAggregator,
      // The claim-drops instance. Listed unconditionally: reaching it still
      // requires an `airdrop` intent, which airdropCapUsd governs separately.
      net.claimDrops.contract,
      // The push rail's bank-multisend leg. Not an address — a MsgMultiSend
      // executes no contract — but the allowlist check is not skipped for it,
      // so it declares a named target instead. See chain/cosmos.ts.
      BANK_MULTISEND_TARGET,
      // Choice v2: the router is the only contract a v2 swap executes on, and
      // Permit2 is the only spender a v2 input is approved to (exactly, and
      // only for the swap at hand — see `exactApprovalSpendersFor`).
      ...(net.choiceV2 ? [net.choiceV2.universalRouter, net.choiceV2.permit2] : []),
      // The ecosystem's ERC-8004 identity registry. Empty on a network with no
      // deployment, and filtered out below — an empty allowlist entry would
      // match nothing anyway, but it would also let a mis-set address through
      // as "". Identity writes spend gas only (kind: "identity" is not
      // spend-bearing), and the transfer's recipient is pinned separately.
      net.erc8004.identityRegistry,
    ]
      .filter((a) => a && a.length > 0)
      .map((a) => a.toLowerCase()),
  );
}

/** Spenders whose approvals the policy holds to exact, bounded amounts. */
export function exactApprovalSpendersFor(net: NetworkDef): ExactApprovalSpender[] {
  if (!net.choiceV2) return [];
  return [
    // The token's ERC20 allowance to Permit2: exact, no expiry on the ERC20 side.
    { spender: net.choiceV2.permit2.toLowerCase(), expires: false },
    // Permit2's grant to the router: exact AND time-boxed.
    { spender: net.choiceV2.universalRouter.toLowerCase(), expires: true },
  ];
}

export function buildRuntime(passphrase?: string): Runtime {
  const home = defaultHomeDir();
  const cfg = loadConfig(home);
  const net = effectiveNetwork(cfg);

  const keystore = loadKeystore(home);
  const privateKey = unlockKeystore(keystore, passphrase);
  const injAddress = evmToInj(keystore.address);

  const audit = new AuditLog(home);
  const ledger = new SpendLedger(home);

  const allowedTargets = allowedTargetsFor(net);
  const policy = new PolicyEngine(
    cfg.policy,
    allowedTargets,
    cfg.ownerSweepAddress.toLowerCase(),
    ledger,
    exactApprovalSpendersFor(net),
  );

  const chain = makeChain(net, net.rpcUrls);
  const transport = makeTransport(net.rpcUrls);
  const signer = new EvmSigner(
    chain,
    transport,
    privateKey,
    policy,
    audit,
    cfg.gasBufferPct,
    net.gasPriceWei,
    cfg.dryRun,
  );

  const pump = new PumpApi(net.pumpApiBase);
  const choiceApi = new ChoiceApi(net.choiceApiBase);

  // referrer: undefined in config → platform default; null → disabled.
  const referrer = (cfg.referrer === undefined ? net.defaultReferrer : cfg.referrer) as
    | `0x${string}`
    | null;
  const shroom = new ShroomVenue(net, signer, pump, referrer);
  const choice = new ChoiceVenue(
    net,
    choiceApi,
    policy,
    audit,
    () => privateKey,
    injAddress,
    cfg.agentName,
    cfg.dryRun,
  );

  const cosmos = new CosmosSigner(net, policy, audit, () => privateKey, injAddress, cfg.dryRun);

  const choiceV2Api = net.choiceV2 ? new ChoiceV2Api(net.choiceV2.apiBase) : null;
  const choiceV2 =
    net.choiceV2 && choiceV2Api
      ? new ChoiceV2Venue(net, net.choiceV2, signer, choiceV2Api, {
          nativeBalance: async () => balanceOf(await bankBalances(net.lcdUrl, injAddress), "inj"),
          usdValue: (token, amount, decimals) =>
            choiceV2UsdValue(net, shroom, choiceV2Api, token, amount, decimals),
        })
      : null;

  return {
    cfg,
    net,
    home,
    audit,
    policy,
    pump,
    choiceApi,
    signer,
    cosmos,
    injAddress,
    shroom,
    choice,
    choiceV2Api,
    choiceV2,
    choiceV2UsdValue: async (token, amount, decimals) =>
      choiceV2Api ? choiceV2UsdValue(net, shroom, choiceV2Api, token, amount, decimals) : null,
  };
}

/**
 * USD value of a v2 swap leg. INJ and wINJ go through the pad's own quote-rate
 * feed — the same mark every other USD figure here uses, and the leg a
 * launch-token trade almost always has. Anything else takes the v2 indexer's
 * stable-anchored price, which is null for a token it cannot anchor.
 */
export async function choiceV2UsdValue(
  net: NetworkDef,
  shroom: ShroomVenue,
  api: ChoiceV2Api,
  token: string,
  amount: bigint,
  decimals: number,
): Promise<number | null> {
  const inj = net.quoteAssets.INJ;
  if (inj && (token === "native" || token.toLowerCase() === net.choiceV2?.winj.toLowerCase())) {
    return shroom.usdValue(inj.slot, amount);
  }
  const t = await api.token(token).catch(() => null);
  const price = t?.priceUsd === null || t?.priceUsd === undefined ? NaN : Number(t.priceUsd);
  if (!Number.isFinite(price) || price <= 0) return null;
  return Number(formatUnits(amount, decimals)) * price;
}
