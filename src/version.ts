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
const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2500;

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

export interface UpdateInfo {
  running: string;
  latest: string;
  updateAvailable: boolean;
  /** Present only when an update exists — short enough to survive a tool response. */
  howToUpdate?: string;
}

/**
 * Version status for this install. Returns `{updateAvailable:false}` on the happy path
 * and `null` when the registry could not be reached (never throws, never blocks).
 *
 * Set `TRIPPY_MCP_NO_UPDATE_CHECK=1` to disable the network call entirely.
 */
export async function checkForUpdate(opts: { force?: boolean } = {}): Promise<UpdateInfo | null> {
  if (process.env.TRIPPY_MCP_NO_UPDATE_CHECK === "1") return null;

  let latest: string | null = null;
  const cached = readCache();
  if (!opts.force && cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) {
    latest = cached.latest;
  } else {
    latest = await fetchLatest();
    if (latest) writeCache({ checkedAt: Date.now(), latest });
    else if (cached) latest = cached.latest; // stale answer beats no answer
  }
  if (!latest) return null;

  const updateAvailable = compareVersions(latest, PKG_VERSION) > 0;
  return {
    running: PKG_VERSION,
    latest,
    updateAvailable,
    ...(updateAvailable
      ? {
          howToUpdate:
            "restart your MCP client if it runs `npx -y trippy-mcp` (that pulls the new version), " +
            "otherwise `npm i -g trippy-mcp@latest` or bump the pin in your client config",
        }
      : {}),
  };
}
