/**
 * Injective-EVM-aware viem transport.
 *
 * Two Injective quirks this papers over (both verified in production by the
 * SHROOM launchpad services and injective-agent-sdk):
 *
 *  1. `eth_getBalance` can return 0 even when the account holds a non-zero
 *     native bank balance. viem's client-side preflight then aborts writes
 *     with a false "total cost exceeds balance". When getBalance returns 0x0
 *     we substitute a 10-INJ placeholder — the node still enforces the REAL
 *     bank balance on broadcast. Balance *display* must never use
 *     eth_getBalance; read the Cosmos bank via LCD instead (api/lcd.ts).
 *
 *  2. The public RPCs (sentry pool, polkachu) 502 intermittently — every
 *     request retries across the endpoint list with small backoff.
 */

import { custom, fallback, type Transport } from "viem";

const PLACEHOLDER_BALANCE = "0x8AC7230489E80000"; // 10 INJ

async function rpcFetch(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const body = (await res.json()) as {
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
  };
  if (body.error) {
    const err = new Error(body.error.message) as Error & { code?: number; data?: unknown };
    err.code = body.error.code;
    err.data = body.error.data;
    throw err;
  }
  return body.result;
}

function injectiveRpc(url: string): Transport {
  return custom(
    {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const result = await rpcFetch(url, method, params ?? []);
        if (method === "eth_getBalance" && (result === "0x0" || result === "0x" || !result)) {
          return PLACEHOLDER_BALANCE;
        }
        return result;
      },
    },
    { retryCount: 2, retryDelay: 400 },
  );
}

/** Fallback transport over the ordered RPC list, each with the Injective shim. */
export function makeTransport(urls: string[]): Transport {
  if (urls.length === 0) throw new Error("no RPC urls configured");
  if (urls.length === 1) return injectiveRpc(urls[0]!);
  return fallback(urls.map(injectiveRpc), { rank: false, retryCount: 1 });
}
