/**
 * Local record of the agent's ERC-8004 identity, at `<home>/identity.json`.
 *
 * Why local state at all: the registry is an ERC-721 with NO enumeration —
 * there is no `tokenOfOwnerByIndex` and no `totalSupply` — so nothing on-chain
 * can answer "which agentId is mine?" from an address alone. The alternatives
 * are a bounded `Registered` log scan (works, but the public RPCs cap the
 * range) or the backend row (a network dependency that must fail soft). The
 * file is the cheap, offline answer; both others exist as fallbacks.
 *
 * Not a secret — an agentId is public — so no 0600 dance beyond what the home
 * directory already enforces.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface IdentityState {
  /** Decimal string — agentIds are uint256. */
  agentId: string;
  chainId: number;
  registry: string;
  cardUri: string;
  txHash?: string | null;
  registeredAt: string;
}

export function identityStatePath(home: string): string {
  return join(home, "identity.json");
}

export function loadIdentityState(home: string): IdentityState | null {
  const p = identityStatePath(home);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<IdentityState>;
    if (!raw.agentId || typeof raw.agentId !== "string") return null;
    return {
      agentId: raw.agentId,
      chainId: Number(raw.chainId ?? 0),
      registry: String(raw.registry ?? ""),
      cardUri: String(raw.cardUri ?? ""),
      txHash: raw.txHash ?? null,
      registeredAt: String(raw.registeredAt ?? ""),
    };
  } catch {
    // A corrupt file must not brick `agent_info` — treat it as absent.
    return null;
  }
}

export function saveIdentityState(home: string, state: IdentityState): void {
  writeFileSync(identityStatePath(home), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
