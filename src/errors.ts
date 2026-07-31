/**
 * Typed, user-safe errors. MCP tools never throw to the client — every failure
 * becomes an `{error: {code, message, hint?}}` envelope so the calling model
 * can read what went wrong and adapt instead of dying on an opaque exception.
 */

export class ToolError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.hint = hint;
  }
}

export class PolicyError extends ToolError {
  constructor(message: string, hint?: string) {
    super("policy_violation", message, hint);
    this.name = "PolicyError";
  }
}

export interface ErrorPayload {
  error: { code: string; message: string; hint?: string };
}

/** Collapse any thrown value into the tool error envelope. */
export function toErrorPayload(e: unknown): ErrorPayload {
  if (e instanceof ToolError) {
    return { error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) } };
  }
  const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
  // Contract reverts surface from viem as ContractFunctionExecutionError with
  // the decoded error name in the message — pass the first line through.
  return { error: { code: "error", message: firstLine(msg) } };
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? s;
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}
