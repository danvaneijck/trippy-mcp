#!/usr/bin/env node
/**
 * trippy-mcp entrypoint: `serve` starts the stdio MCP server; everything else
 * is the human CLI. Errors on the serve path go to stderr only — stdout is
 * the MCP protocol channel.
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "serve") {
    const { serve } = await import("./mcp/server.js");
    await serve();
    return; // serve() keeps the process alive on the transport
  }
  const { runCli } = await import("./cli/index.js");
  await runCli(argv);
}

main().catch((e: unknown) => {
  process.stderr.write(`trippy-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
