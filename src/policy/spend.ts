/**
 * Rolling-24h USD spend ledger at `<home>/spend.json`. Written by the signers
 * (never the tool layer) at broadcast time — a tx we broadcast counts against
 * the budget even if its receipt lags.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PolicyError } from "../errors.js";

interface SpendEntry {
  t: number; // epoch ms
  usd: number;
  detail: string;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

export class SpendLedger {
  private readonly path: string;

  constructor(homeDir: string) {
    this.path = join(homeDir, "spend.json");
  }

  private load(): SpendEntry[] {
    if (!existsSync(this.path)) return [];
    let raw: { entries?: SpendEntry[] };
    try {
      raw = JSON.parse(readFileSync(this.path, "utf-8")) as { entries?: SpendEntry[] };
    } catch {
      // A file that exists but will not parse is the one case that must NOT
      // read as "nothing spent yet": that silently returns the full 24h budget
      // to an agent that has already spent it. Refuse instead — the operator
      // can delete the file, which is an explicit choice rather than an
      // accident of corruption.
      throw new PolicyError(
        `the spend ledger at ${this.path} is unreadable, so the 24h budget cannot be enforced`,
        "inspect it and delete it to start a fresh 24h window",
      );
    }
    const cutoff = Date.now() - WINDOW_MS;
    return (raw.entries ?? []).filter(
      (e) => typeof e?.t === "number" && typeof e?.usd === "number" && e.t > cutoff,
    );
  }

  private save(entries: SpendEntry[]): void {
    writeFileSync(this.path, JSON.stringify({ entries }, null, 2), { mode: 0o600 });
  }

  /** USD spent in the trailing 24h window. */
  spent(): number {
    return this.load().reduce((a, e) => a + e.usd, 0);
  }

  record(usd: number, detail: string): void {
    const entries = this.load();
    entries.push({ t: Date.now(), usd, detail });
    this.save(entries);
  }
}
