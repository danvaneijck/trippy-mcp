/**
 * Runtime assembly: config + keystore → clients, signer, policy, venues.
 * Built once per process (MCP serve or CLI command).
 */

import { AuditLog } from "./audit.js";
import { ChoiceApi } from "./api/choice.js";
import { PumpApi } from "./api/pump.js";
import { BANK_MULTISEND_TARGET, CosmosSigner } from "./chain/cosmos.js";
import { EvmSigner } from "./chain/evm.js";
import { getNetwork, makeChain, type NetworkDef } from "./chain/networks.js";
import { makeTransport } from "./chain/transport.js";
import { homeDir as defaultHomeDir, loadConfig, type Config } from "./config.js";
import { evmToInj, loadKeystore, unlockKeystore } from "./keystore.js";
import { PolicyEngine } from "./policy/policy.js";
import { SpendLedger } from "./policy/spend.js";
import { ChoiceVenue } from "./venues/choice/swap.js";
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
    gasPriceWei: cfg.gasPriceWei ? BigInt(cfg.gasPriceWei) : base.gasPriceWei,
  };
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

  const allowedTargets = new Set(
    [
      net.addresses.launchpadCore,
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
    ]
      .filter((a) => a && a.length > 0)
      .map((a) => a.toLowerCase()),
  );
  const policy = new PolicyEngine(
    cfg.policy,
    allowedTargets,
    cfg.ownerSweepAddress.toLowerCase(),
    ledger,
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
  };
}
