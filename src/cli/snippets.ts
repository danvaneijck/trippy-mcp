/** Copy-paste client config snippets printed at the end of `init`. */

export function clientSnippets(opts: { encrypted: boolean }): string {
  const env = opts.encrypted ? ` -e TRIPPY_MCP_PASSPHRASE=<your-passphrase>` : "";
  const codexEnv = opts.encrypted
    ? `\nenv = { TRIPPY_MCP_PASSPHRASE = "<your-passphrase>" }`
    : "";
  const cursorEnv = opts.encrypted
    ? `,\n      "env": { "TRIPPY_MCP_PASSPHRASE": "<your-passphrase>" }`
    : "";
  return `
Connect your coding agent — \`trippy-mcp connect\` writes these for you, or paste one:

  Claude Code:
    claude mcp add trippy${env} -- npx -y trippy-mcp serve

  Codex (~/.codex/config.toml):
    [mcp_servers.trippy]
    command = "npx"
    args = ["-y", "trippy-mcp", "serve"]${codexEnv}

  Cursor (.cursor/mcp.json):
    {
      "mcpServers": {
        "trippy": {
          "command": "npx",
          "args": ["-y", "trippy-mcp", "serve"]${cursorEnv}
        }
      }
    }
`;
}

export function fundingInstructions(evm: string, inj: string): string {
  return `
Fund the agent wallet (this is its trading budget — start small):

  EVM form:    ${evm}
  Cosmos form: ${inj}

Send INJ (gas + trading) and optionally USDC/SAI from any Injective wallet.
Note: block explorers and MetaMask may show a ZERO balance for this address —
that is an Injective EVM RPC quirk. \`trippy-mcp status\` shows the true bank
balance.
`;
}
