/**
 * `trippy-mcp init` — create the agent wallet + identity.
 *
 * Generates the key LOCALLY (it never leaves this machine), fixes the owner
 * sweep address (immutable — the only place funds can ever be swept to),
 * writes the keystore + config, registers the agent name with the Trippy
 * registry (agent-key signature; the badge shows immediately), and prints
 * funding instructions + client config snippets.
 */

import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { PumpApi } from "../api/pump.js";
import { getNetwork, type NetworkName } from "../chain/networks.js";
import { AGENT_NAME_RE, ConfigSchema, configPath, homeDir, saveConfig, type Config } from "../config.js";
import {
  buildEncryptedKeystore,
  buildPlaintextKeystore,
  evmToInj,
  injToEvm,
  saveKeystore,
} from "../keystore.js";
import { clientSnippets, fundingInstructions } from "./snippets.js";

interface InitFlags {
  name?: string;
  owner?: string;
  network: NetworkName;
  plaintext: boolean;
  force: boolean;
}

function parseFlags(argv: string[]): InitFlags {
  const flags: InitFlags = { network: "mainnet", plaintext: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--name") flags.name = argv[++i];
    else if (a === "--owner") flags.owner = argv[++i];
    else if (a === "--network") flags.network = argv[++i] === "testnet" ? "testnet" : "mainnet";
    else if (a === "--plaintext") flags.plaintext = true;
    else if (a === "--force") flags.force = true;
  }
  return flags;
}

export async function initCommand(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const home = homeDir();
  const out = (s: string) => process.stdout.write(`${s}\n`);

  if (existsSync(configPath(home)) && !flags.force) {
    out(`trippy-mcp is already initialized (${configPath(home)}).`);
    out("Re-running init would create a NEW wallet. If you really want that, sweep funds");
    out("first (`trippy-mcp sweep INJ all`) and re-run with --force.");
    process.exitCode = 1;
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // --- agent name ---------------------------------------------------------
    let name = flags.name ?? "";
    while (!AGENT_NAME_RE.test(name)) {
      if (name) out("  names are 3-32 chars: lowercase a-z, 0-9, _ and -");
      name = (await rl.question("Agent name (shown on Trippy Terminal): ")).trim().toLowerCase();
    }

    // --- owner sweep address ------------------------------------------------
    let owner = flags.owner ?? "";
    while (true) {
      if (/^0x[0-9a-fA-F]{40}$/.test(owner)) break;
      if (/^inj1[a-z0-9]{38}$/.test(owner)) {
        owner = injToEvm(owner);
        break;
      }
      if (owner) out("  enter your MAIN wallet address (0x… or inj1…)");
      owner = (
        await rl.question("Owner wallet (the ONLY address sweeps can ever go to): ")
      ).trim();
    }

    // --- key + storage mode ---------------------------------------------------
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const injAddress = evmToInj(account.address);

    let encrypted = !flags.plaintext;
    let passphrase = process.env.TRIPPY_MCP_PASSPHRASE ?? "";
    if (encrypted && !passphrase) {
      out("");
      out("Choose a keystore passphrase (you'll pass it to the MCP server as");
      out("TRIPPY_MCP_PASSPHRASE). Leave empty to store the key unencrypted (0600).");
      passphrase = (await rl.question("Passphrase (min 8 chars, empty = plaintext): ")).trim();
      if (passphrase === "") encrypted = false;
      else {
        while (passphrase.length < 8) {
          passphrase = (await rl.question("Too short — passphrase (min 8): ")).trim();
        }
        const confirmPass = (await rl.question("Confirm passphrase: ")).trim();
        if (confirmPass !== passphrase) {
          out("passphrases do not match — aborting, nothing was written");
          process.exitCode = 1;
          return;
        }
      }
    }

    const keystore = encrypted
      ? buildEncryptedKeystore(privateKey, passphrase)
      : buildPlaintextKeystore(privateKey);
    saveKeystore(home, keystore);

    const cfg: Config = ConfigSchema.parse({
      network: flags.network,
      agentName: name,
      ownerSweepAddress: owner,
    });
    saveConfig(cfg, home);

    out("");
    out(`✓ agent wallet created   ${account.address}`);
    out(`✓ config written         ${configPath(home)}`);
    out(`✓ sweep destination      ${owner} (immutable)`);

    // --- registry -------------------------------------------------------------
    const net = getNetwork(flags.network);
    const pump = new PumpApi(net.pumpApiBase);
    let registered = false;
    if (net.pumpApiBase) {
      try {
        const agentAddress = account.address.toLowerCase();
        const { nonce, message } = await pump.registerNonce({
          agentAddress,
          name,
          client: detectClient(),
        });
        const signature = await account.signMessage({ message });
        await pump.register({
          agentAddress,
          name,
          client: detectClient(),
          nonce,
          signature,
        });
        registered = true;
        out(`✓ registered on Trippy as "${name}" — trades from this wallet get the AGENT badge`);
      } catch (e) {
        out(`! registration failed (${e instanceof Error ? e.message : e})`);
        out("  trading works anyway — retry later with `trippy-mcp register`");
      }
    }

    out(fundingInstructions(account.address, injAddress));
    out(clientSnippets({ encrypted }));
    if (registered) {
      out("Optional: link this agent to your profile — run `trippy-mcp claim-code` and");
      out("enter the code in Trippy Terminal → Settings → Agents with your main wallet.");
    }
  } finally {
    rl.close();
  }
}

function detectClient(): string {
  if (process.env.CLAUDECODE) return "claude-code";
  if (process.env.CURSOR_TRACE_ID) return "cursor";
  return "cli";
}
