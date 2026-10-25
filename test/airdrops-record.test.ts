import { afterEach, describe, expect, it } from "vitest";

import { recordAirdropLog, recordBatches, recordCampaign } from "../src/airdrops/hasura.js";
import { NETWORKS } from "../src/chain/networks.js";

// The campaign index is written by trippinj from the contract's state, so the
// only thing sent is which campaign: no root, meta or creator from the client.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("recordCampaign", () => {
  it("posts only the campaign's coordinates to the trippinj endpoint", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: "recorded" }), { status: 200 });
    }) as typeof fetch;

    const net = NETWORKS.mainnet;
    await recordCampaign(net.claimDrops.campaignsUrl, {
      network: net.name,
      contract: net.claimDrops.contract,
      campaignId: 12,
      txHash: "AB".repeat(32),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.trippyinj.xyz/claim-drops/campaigns");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      network: "mainnet",
      contract: net.claimDrops.contract,
      campaign_id: 12,
      tx_hash: "AB".repeat(32),
    });
  });

  it("surfaces the endpoint's error", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "no such campaign on chain" }), { status: 404 })) as typeof fetch;
    await expect(
      recordCampaign(NETWORKS.testnet.claimDrops.campaignsUrl, {
        network: "testnet",
        contract: NETWORKS.testnet.claimDrops.contract,
        campaignId: 1,
        txHash: null,
      }),
    ).rejects.toThrow(/HTTP 404: no such campaign on chain/);
  });
});

// The airdrop history is written by trippinj from the drop's transactions, so
// only the hashes and the free text are sent: no sender, token or recipients.
describe("recordAirdropLog", () => {
  const HASH = "AB".repeat(32);

  it("posts only the hashes and the text to the trippinj endpoint", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: "recorded" }), { status: 200 });
    }) as typeof fetch;

    await recordAirdropLog(NETWORKS.mainnet.claimDrops.airdropLogUrl, {
      criteria: "holders of X",
      description: "d",
      txHashes: [HASH],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.trippyinj.xyz/airdrops/log");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      tx_hashes: [HASH],
      criteria: "holders of X",
      description: "d",
    });
  });

  it("retries a tx the LCD has not indexed yet, but not a refusal", async () => {
    const statuses = [404, 200];
    let calls = 0;
    globalThis.fetch = (async () => new Response("{}", { status: statuses[calls++] })) as typeof fetch;
    await recordAirdropLog("https://x/airdrops/log", { criteria: "", description: "", txHashes: [HASH] }, { retryDelayMs: 0 });
    expect(calls).toBe(2);

    calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "tx is not an airdrop" }), { status: 422 });
    }) as typeof fetch;
    await expect(
      recordAirdropLog("https://x/airdrops/log", { criteria: "", description: "", txHashes: [HASH] }, { retryDelayMs: 0 }),
    ).rejects.toThrow(/HTTP 422: tx is not an airdrop/);
    expect(calls).toBe(1);
  });

  it("splits a long run into batches that each repeat a hash of the one before", () => {
    const all = Array.from({ length: 450 }, (_, i) => i.toString(16).padStart(64, "0"));
    const batches = recordBatches(all);
    expect(batches.every((b) => b.length <= 200)).toBe(true);
    for (let i = 1; i < batches.length; i++) expect(batches[i - 1]).toContain(batches[i][0]);
    expect([...new Set(batches.flat())]).toEqual(all);
  });
});
