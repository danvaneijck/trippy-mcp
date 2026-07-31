/**
 * CLI subcommands (everything except `serve`, which lives in mcp/server.ts).
 * Human-facing — pretty text on stdout is fine here.
 */

import { createInterface } from "node:readline/promises";

import { loadConfig, homeDir } from "../config.js";
import { loadKeystore, unlockKeystore } from "../keystore.js";
import { buildRuntime } from "../runtime.js";
import { walletStatus, sweep } from "../wallet.js";
import { initCommand } from "./init.js";

const HELP = `trippy-mcp — Injective trading MCP (SHROOM Pad + Choice)

Usage:
  trippy-mcp init [--name <n>] [--owner <0x|inj1>] [--network mainnet|testnet] [--plaintext] [--force]
  trippy-mcp serve                 start the stdio MCP server (what your agent runs)
  trippy-mcp status                wallet balances, policy budget, registration
  trippy-mcp register              (re)register the agent name with the Trippy registry
  trippy-mcp claim-code            mint a code to link this agent to your Terminal profile
  trippy-mcp sweep <asset> <amt>   send funds to the owner wallet (asset: INJ|USDC|SAI|0x…, amt or "all")
  trippy-mcp export-key --yes-i-understand   print the raw private key (DANGER)

Docs & source: https://github.com/danvaneijck/trippy-mcp
`;

async function withPassphrase<T>(fn: (passphrase?: string) => T): Promise<T> {
  // CLI convenience: prompt when the keystore is encrypted and no env is set.
  try {
    const ks = loadKeystore(homeDir());
    if (ks.kind === "encrypted" && !process.env.TRIPPY_MCP_PASSPHRASE) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const pass = await rl.question("Keystore passphrase: ");
        return fn(pass.trim());
      } finally {
        rl.close();
      }
    }
  } catch {
    // fall through — fn() will surface the proper error
  }
  return fn();
}

export async function runCli(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "help";
  const rest = argv.slice(1);
  const out = (s: string) => process.stdout.write(`${s}\n`);

  switch (cmd) {
    case "init":
      await initCommand(rest);
      return;

    case "status": {
      const rt = await withPassphrase((p) => buildRuntime(p));
      const s = await walletStatus(rt);
      out(JSON.stringify(s, null, 2));
      return;
    }

    case "register": {
      const rt = await withPassphrase((p) => buildRuntime(p));
      const agentAddress = rt.signer.address.toLowerCase();
      const { nonce, message } = await rt.pump.registerNonce({
        agentAddress,
        name: rt.cfg.agentName,
      });
      const signature = await rt.signer.account.signMessage({ message });
      await rt.pump.register({ agentAddress, name: rt.cfg.agentName, nonce, signature });
      rt.audit.append("agent:registered", { agentAddress, name: rt.cfg.agentName });
      out(`registered as "${rt.cfg.agentName}" (${agentAddress})`);
      return;
    }

    case "claim-code": {
      const rt = await withPassphrase((p) => buildRuntime(p));
      const agentAddress = rt.signer.address.toLowerCase();
      const { nonce, message } = await rt.pump.claimCodeNonce(agentAddress);
      const signature = await rt.signer.account.signMessage({ message });
      const { code, expiresAt } = await rt.pump.claimCode(agentAddress, { nonce, signature });
      out(`Claim code: ${code}   (expires ${expiresAt})`);
      if (rt.net.terminalBase) {
        out(`Open ${rt.net.terminalBase}/settings?claimAgent=${code} and sign with your MAIN wallet.`);
      } else {
        out("Enter it in Trippy Terminal → Settings → Agents with your main wallet.");
      }
      return;
    }

    case "sweep": {
      const asset = rest[0];
      const amount = rest[1];
      if (!asset || !amount) {
        out('usage: trippy-mcp sweep <INJ|USDC|SAI|0x…> <amount|"all">');
        process.exitCode = 1;
        return;
      }
      const rt = await withPassphrase((p) => buildRuntime(p));
      const res = await sweep(rt, asset, amount === "all" ? "all" : amount);
      out(JSON.stringify(res, null, 2));
      return;
    }

    case "export-key": {
      if (!rest.includes("--yes-i-understand")) {
        out("This prints the agent's RAW PRIVATE KEY. Anyone with it controls the funds.");
        out("Re-run with --yes-i-understand if you are sure.");
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      void cfg;
      const key = await withPassphrase((p) => unlockKeystore(loadKeystore(homeDir()), p));
      out(key);
      return;
    }

    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return;

    default:
      out(`unknown command: ${cmd}\n`);
      out(HELP);
      process.exitCode = 1;
  }
}
