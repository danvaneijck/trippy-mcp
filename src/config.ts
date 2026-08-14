/**
 * Install config at `<home>/config.json` (home = $TRIPPY_MCP_HOME or
 * ~/.trippy-mcp). Written by `trippy-mcp init`, validated on every load.
 *
 * `ownerSweepAddress` is deliberately immutable after init: the sweep code
 * path hardcodes it and takes no destination argument, so even a fully
 * hijacked model can only send funds home. Changing it requires editing
 * config.json by hand — a human action outside the MCP surface.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { ToolError } from "./errors.js";

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/;

const EvmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x EVM address");

export const PolicySchema = z.object({
  /** Max USD value signed away in a single trade/swap/launch. */
  perTxCapUsd: z.number().positive().default(200),
  /** Rolling-24h USD spend ceiling across all trades/swaps/launches. */
  dailyBudgetUsd: z.number().positive().default(1000),
  /** Hard ceiling any tool-supplied slippage is clamped to. */
  maxSlippageBps: z.number().int().min(1).max(5000).default(300),
  /** Kill switch: false blocks every trade/swap/launch, reads keep working. */
  tradingEnabled: z.boolean().default(true),
  /**
   * Whether spends with no resolvable USD price may proceed (they bypass the
   * USD caps). Default false: unpriceable spend is refused.
   */
  allowUnpricedSpend: z.boolean().default(false),
  /**
   * Max USD value of a single airdrop campaign.
   *
   * An airdrop is the one action here that sends value to arbitrary addresses,
   * which is exactly what the fixed sweep destination exists to prevent
   * everywhere else — so it gets its own ceiling on top of the shared budget
   * rather than riding on perTxCapUsd. Set to 0 to switch the airdrop tools off
   * entirely (they are not registered at all, so an injected prompt cannot even
   * see them) — including `airdrop_manage`, so wind down any live campaign
   * before turning them off or the clawback has to be done from the site.
   *
   * It does NOT get its own budget: a campaign also consumes `dailyBudgetUsd`
   * through the same ledger as every trade, so the 24h ceiling is the real
   * bound on how much an agent can push out in a day.
   */
  airdropCapUsd: z.number().min(0).default(1000),
});

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  network: z.enum(["mainnet", "testnet"]).default("mainnet"),
  agentName: z.string().regex(AGENT_NAME_RE, "3-32 chars: a-z 0-9 _ - (lowercase)"),
  /** Immutable post-init — the only destination `sweep` can send to. */
  ownerSweepAddress: EvmAddress,
  /** Curve-buy referrer override; null disables (address(0)). Default: platform treasury. */
  referrer: EvmAddress.nullable().optional(),
  rpcUrls: z.array(z.string().url()).optional(),
  lcdUrl: z.string().url().optional(),
  pumpApiBase: z.string().url().optional(),
  choiceApiBase: z.string().url().optional(),
  /**
   * Extra CW20 contracts `portfolio` should probe, on top of the network's
   * built-ins. CW20 balances cannot be enumerated from the chain, so a holding
   * is only ever visible if its contract is on this list — add one here when
   * the agent acquires a CW20 the package does not ship knowledge of.
   */
  cw20Tokens: z.array(z.string().regex(/^inj1[02-9ac-hj-np-z]{38}$/)).optional(),
  gasBufferPct: z.number().int().min(0).max(100).default(20),
  gasPriceWei: z.string().regex(/^\d+$/).optional(),
  policy: PolicySchema.default({}),
  /** Simulate everything, broadcast nothing. */
  dryRun: z.boolean().default(false),
});

export type PolicyConfig = z.infer<typeof PolicySchema>;
export type Config = z.infer<typeof ConfigSchema>;

export function homeDir(): string {
  return process.env.TRIPPY_MCP_HOME ?? join(homedir(), ".trippy-mcp");
}

export function configPath(dir = homeDir()): string {
  return join(dir, "config.json");
}

export function loadConfig(dir = homeDir()): Config {
  const p = configPath(dir);
  if (!existsSync(p)) {
    throw new ToolError(
      "not_initialized",
      `no config at ${p}`,
      "run `trippy-mcp init` to set up the agent wallet and identity",
    );
  }
  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(p, "utf-8")));
  if (!parsed.success) {
    throw new ToolError(
      "config_invalid",
      `invalid config at ${p}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return parsed.data;
}

export function saveConfig(cfg: Config, dir = homeDir()): void {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o700);
  writeFileSync(configPath(dir), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
