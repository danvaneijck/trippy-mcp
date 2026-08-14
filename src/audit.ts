/**
 * Append-only JSONL audit log at `<home>/audit.log` (0600).
 *
 * Every signing-path event lands here: policy checks, broadcasts, confirms,
 * failures. Invariant: NEVER log key material, passphrases or signatures —
 * only addresses, hashes, amounts and outcomes.
 */

import { appendFileSync, chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AuditEvent =
  | "tx:policy_denied"
  | "tx:simulated"
  | "tx:broadcast"
  | "tx:confirmed"
  | "tx:unconfirmed"
  | "tx:failed"
  | "swap:broadcast"
  | "swap:failed"
  | "agent:registered"
  | "agent:erc8004-registered"
  | "agent:erc8004-linked"
  | "agent:erc8004-transferred"
  | "sweep:sent";

export class AuditLog {
  private readonly path: string;

  constructor(homeDir: string) {
    this.path = join(homeDir, "audit.log");
  }

  append(event: AuditEvent, fields: Record<string, unknown>): void {
    try {
      const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`;
      if (!existsSync(this.path)) {
        writeFileSync(this.path, line, { mode: 0o600 });
      } else {
        appendFileSync(this.path, line);
        chmodSync(this.path, 0o600);
      }
    } catch {
      // Audit failures must never block a trade — but they should be loud.
      process.stderr.write(`trippy-mcp: WARNING failed to write audit log at ${this.path}\n`);
    }
  }
}
