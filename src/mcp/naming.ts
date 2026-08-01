/**
 * Tool naming.
 *
 * Claude Code namespaces MCP tools for you (`mcp__trippy__buy`), so bare verbs
 * read fine there. Codex and Cursor present flatter names, where a bare `buy`
 * sitting next to another server's `trade_open` is genuinely ambiguous to a
 * model. `TRIPPY_MCP_TOOL_PREFIX=trippy` registers `trippy_buy` instead.
 *
 * Opt-in on purpose: renaming by default would break every existing install's
 * allowlists and saved prompts.
 */

/** MCP tool names are capped well below this; our longest bare name is 13. */
const MAX_PREFIX_LEN = 24;

/**
 * Normalize the configured prefix into a ready-to-concatenate string.
 * Returns "" (no prefixing) when unset or when nothing usable survives.
 */
export function toolPrefix(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.TRIPPY_MCP_TOOL_PREFIX ?? "").trim();
  if (!raw) return "";
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_PREFIX_LEN);
  return cleaned ? `${cleaned}_` : "";
}

/** Apply the configured prefix to a bare tool name. */
export function toolName(bare: string, env?: NodeJS.ProcessEnv): string {
  return `${toolPrefix(env)}${bare}`;
}
