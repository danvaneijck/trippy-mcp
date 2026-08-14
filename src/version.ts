/**
 * Running version + "is there a newer one" check.
 *
 * Agents run this package unattended for weeks — Dan's own entry is an unpinned
 * `npx -y trippy-mcp serve`, which only picks up a release when the client restarts,
 * and a pinned install never does. Nothing on the chain or in the API tells a stale
 * install it is stale, so the check has to come from here.
 *
 * Design rules, in priority order:
 *  1. NEVER break a tool call. Offline, rate-limited, garbage response — all resolve to
 *     `null` and the caller simply omits the field.
 *  2. NEVER write to stdout: that is the MCP protocol channel. This module returns data;
 *     the CLI is what prints.
 *  3. Cheap. The answer is cached on disk for `CHECK_TTL_MS`, so a busy agent hits the
 *     registry roughly once a day, not once a tool call.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { homeDir } from "./config.js";

const REGISTRY_DIST_TAGS = "https://registry.npmjs.org/-/package/trippy-mcp/dist-tags";
const FETCH_TIMEOUT_MS = 2500;

/**
 * How long a cached answer is served without asking again.
 *
 * This used to be a day, which meant an install that checked an hour before a
 * release kept reporting "up to date" for the next 23 — the one window where
 * the answer actually matters. The check runs from `agent_info`, not from every
 * tool call, so asking this often costs a dist-tags GET a few times a day.
 */
const FRESH_MS = 15 * 60 * 1000;

/**
 * How long a caller waits for a refresh before falling back to the cache.
 *
 * Well under the fetch's own timeout on purpose: the request keeps running and
 * still writes the cache when it lands, so a slow registry costs this much once
 * per `FRESH_MS` instead of blocking a tool call for `FETCH_TIMEOUT_MS`.
 */
const SOFT_WAIT_MS = 700;

/** This install's version, read from the package manifest one level above dist/ (and src/). */
export const PKG_VERSION: string = (() => {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf-8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/**
 * Compare two semver-ish strings. Returns >0 when `a` is newer than `b`.
 * Prerelease tags sort below the release they qualify (1.0.0-rc.1 < 1.0.0).
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const [core = "", ...rest] = v.trim().replace(/^v/, "").split("-");
    return {
      nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.join("-"),
    };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1; // a is the release, b is a prerelease of it
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

interface CacheFile {
  checkedAt: number;
  latest: string;
}

function cachePath(): URL {
  return new URL(`file://${homeDir().replace(/\/$/, "")}/update-check.json`);
}

function readCache(): CacheFile | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf-8")) as Partial<CacheFile>;
    if (typeof parsed.checkedAt !== "number" || typeof parsed.latest !== "string") return null;
    return { checkedAt: parsed.checkedAt, latest: parsed.latest };
  } catch {
    return null;
  }
}

function writeCache(entry: CacheFile): void {
  try {
    writeFileSync(cachePath(), JSON.stringify(entry), "utf-8");
  } catch {
    // A read-only or not-yet-created home just means we re-check next time.
  }
}

/** The registry's `latest` dist-tag, or null if it could not be established. */
async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(REGISTRY_DIST_TAGS, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const tags = (await res.json()) as { latest?: unknown };
    return typeof tags.latest === "string" ? tags.latest : null;
  } catch {
    return null;
  }
}

/** In-flight refresh, so concurrent callers share one request. */
let inFlight: Promise<string | null> | null = null;

/** Fetch `latest` and cache it. Never rejects; concurrent calls coalesce. */
function refreshLatest(): Promise<string | null> {
  inFlight ??= fetchLatest()
    .then((latest) => {
      if (latest) writeCache({ checkedAt: Date.now(), latest });
      return latest;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Wait `ms` for `p`, else resolve null. `p` is NOT cancelled — it goes on to
 * write the cache, so a refresh this call gave up on still lands for the next.
 */
function raceTimeout(p: Promise<string | null>, ms: number): Promise<string | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      // Never hold the process open for a check nobody is waiting on.
      (timer as { unref?: () => void }).unref?.();
    }),
  ]);
}

export interface UpdateInfo {
  running: string;
  latest: string;
  updateAvailable: boolean;
  /** When `latest` was established — a cached answer says how old it is. */
  checkedAt: string;
  /** Present only when an update exists — short enough to survive a tool response. */
  howToUpdate?: string;
}

/**
 * Version status for this install. Returns `{updateAvailable:false}` on the happy path
 * and `null` when the registry could not be reached (never throws, never blocks).
 *
 * A cached answer inside `FRESH_MS` is used as-is. Past that the registry is
 * asked again, but only for `SOFT_WAIT_MS` — the cache covers a slow answer, and
 * the request that missed the window still updates the cache behind it. So the
 * flip to `updateAvailable` costs at most one quarter-hour, and a tool call
 * never waits on npm for longer than the soft budget.
 *
 * Set `TRIPPY_MCP_NO_UPDATE_CHECK=1` to disable the network call entirely.
 */
export async function checkForUpdate(opts: { force?: boolean } = {}): Promise<UpdateInfo | null> {
  if (process.env.TRIPPY_MCP_NO_UPDATE_CHECK === "1") return null;

  const cached = readCache();
  let latest = cached?.latest ?? null;
  let checkedAt = cached?.checkedAt ?? null;

  // Once an update is known there is nothing further to learn: the answer stays
  // true until this install catches up, at which point PKG_VERSION rises and
  // the comparison below turns the polling back on by itself.
  const alreadyKnown = latest !== null && compareVersions(latest, PKG_VERSION) > 0;
  const fresh = cached !== null && Date.now() - cached.checkedAt < FRESH_MS;

  if (opts.force || cached === null) {
    // Nothing to fall back on (or an explicit `--check`), so this one waits.
    const got = await refreshLatest();
    if (got) {
      latest = got;
      checkedAt = Date.now();
    }
  } else if (!fresh && !alreadyKnown) {
    const got = await raceTimeout(refreshLatest(), SOFT_WAIT_MS);
    if (got) {
      latest = got;
      checkedAt = Date.now();
    }
  }
  if (!latest) return null; // registry unreachable and no cached answer

  const updateAvailable = compareVersions(latest, PKG_VERSION) > 0;
  return {
    running: PKG_VERSION,
    latest,
    updateAvailable,
    checkedAt: new Date(checkedAt ?? Date.now()).toISOString(),
    ...(updateAvailable
      ? {
          howToUpdate:
            "restart your MCP client if it runs `npx -y trippy-mcp` (that pulls the new version), " +
            "otherwise `npm i -g trippy-mcp@latest` or bump the pin in your client config",
        }
      : {}),
  };
}
