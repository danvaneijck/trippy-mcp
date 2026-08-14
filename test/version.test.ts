import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compareVersions, PKG_VERSION } from "../src/version.js";

describe("compareVersions", () => {
  it("orders by major, minor then patch", () => {
    expect(compareVersions("0.5.0", "0.4.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.4.3", "0.4.2")).toBeGreaterThan(0);
    expect(compareVersions("0.4.2", "0.4.2")).toBe(0);
    expect(compareVersions("0.4.1", "0.4.2")).toBeLessThan(0);
  });

  it("does not compare version segments as strings", () => {
    // The bug a naive localeCompare would introduce: "0.10.0" < "0.9.0".
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.4.10", "0.4.9")).toBeGreaterThan(0);
  });

  it("sorts a prerelease below the release it qualifies", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
  });

  it("tolerates a leading v and missing segments", () => {
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.1.9")).toBeGreaterThan(0);
  });
});

describe("PKG_VERSION", () => {
  it("matches the manifest rather than a hardcoded literal", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    expect(PKG_VERSION).toBe(manifest.version);
  });
});

describe("checkForUpdate", () => {
  let home: string;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "trippy-version-"));
    process.env.TRIPPY_MCP_HOME = home;
    delete process.env.TRIPPY_MCP_NO_UPDATE_CHECK;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TRIPPY_MCP_HOME;
    delete process.env.TRIPPY_MCP_NO_UPDATE_CHECK;
  });

  it("reports an update when the registry is ahead, and caches the answer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ latest: "99.0.0" }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");

    const info = await checkForUpdate();
    expect(info?.updateAvailable).toBe(true);
    expect(info?.latest).toBe("99.0.0");
    expect(info?.howToUpdate).toBeTruthy();

    // Second call inside the TTL is served from disk — no second request.
    await checkForUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(home, "update-check.json"), "utf-8")).latest).toBe("99.0.0");
  });

  it("omits howToUpdate when already current", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ latest: PKG_VERSION }), { status: 200 })) as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");
    const info = await checkForUpdate();
    expect(info?.updateAvailable).toBe(false);
    expect(info?.howToUpdate).toBeUndefined();
  });

  it("returns null rather than throwing when the registry is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("falls back to a stale cached answer when the registry is down", async () => {
    writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: 0, latest: "99.0.0" }));
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");
    const info = await checkForUpdate();
    expect(info?.latest).toBe("99.0.0");
    expect(info?.updateAvailable).toBe(true);
  });

  it("makes no network call when the opt-out is set", async () => {
    process.env.TRIPPY_MCP_NO_UPDATE_CHECK = "1";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");
    await expect(checkForUpdate()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a malformed registry response", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ latest: 42 }), { status: 200 })) as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("flips as soon as a release lands, rather than riding out a day-old cache", async () => {
    // The shape that used to fail: a cache taken minutes before the release,
    // saying the running version IS latest. Under a 24h TTL this kept answering
    // "up to date" for the rest of the day.
    writeFileSync(
      join(home, "update-check.json"),
      JSON.stringify({ checkedAt: Date.now() - 20 * 60 * 1000, latest: PKG_VERSION }),
    );
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ latest: "99.0.0" }), { status: 200 })) as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");

    const info = await checkForUpdate();
    expect(info?.updateAvailable).toBe(true);
    expect(info?.latest).toBe("99.0.0");
  });

  it("serves a cache younger than the freshness window without asking again", async () => {
    writeFileSync(
      join(home, "update-check.json"),
      JSON.stringify({ checkedAt: Date.now() - 60_000, latest: PKG_VERSION }),
    );
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");

    const info = await checkForUpdate();
    expect(info?.updateAvailable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops polling once an update is already known", async () => {
    writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: 0, latest: "99.0.0" }));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");

    const info = await checkForUpdate();
    expect(info?.updateAvailable).toBe(true);
    // Nothing left to learn — the answer cannot change until this install moves.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers from cache when the registry hangs, and takes the late answer next call", async () => {
    writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: 0, latest: PKG_VERSION }));
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = (async () => {
      await held;
      return new Response(JSON.stringify({ latest: "99.0.0" }), { status: 200 });
    }) as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");

    // The caller must not wait on a hung registry: it falls back to the cache.
    const started = Date.now();
    const info = await checkForUpdate();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(info?.latest).toBe(PKG_VERSION);

    // The request was never cancelled, so its answer still lands in the cache.
    release?.();
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(join(home, "update-check.json"), "utf-8")).latest).toBe("99.0.0"),
    );
    expect((await checkForUpdate())?.updateAvailable).toBe(true);
  });

  it("dates the answer, so a cached one says how old it is", async () => {
    const checkedAt = Date.now() - 5 * 60 * 1000;
    writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt, latest: PKG_VERSION }));
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { checkForUpdate } = await import("../src/version.js");
    expect((await checkForUpdate())?.checkedAt).toBe(new Date(checkedAt).toISOString());
  });
});
