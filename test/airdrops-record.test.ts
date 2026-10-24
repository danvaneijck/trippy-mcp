import { afterEach, describe, expect, it } from "vitest";

import { recordCampaign } from "../src/airdrops/hasura.js";
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
