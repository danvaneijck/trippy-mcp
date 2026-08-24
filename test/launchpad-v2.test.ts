import { describe, expect, it } from "vitest";
import { toFunctionSelector, type AbiFunction, type AbiParameter } from "viem";

import { getNetwork, isCurveV2, launchViewsAddress, type NetworkDef } from "../src/chain/networks.js";
import {
  LAUNCHPAD_ABI,
  LAUNCHPAD_VIEWS_ABI,
  LAUNCHPAD_WRITE_V2_ABI,
} from "../src/venues/shroom/abi.js";

/**
 * The v1/v2 launchpad split.
 *
 * This package serves mainnet (v1) and testnet (v2) from one build, and the two
 * are not ABI-compatible. The dangerous half is that the incompatibility is
 * mostly SILENT: `getLaunch(uint256)` has the same selector on both, so calling
 * it with the wrong ABI does not revert — the returned tuple just decodes with
 * every field after `creatorFeeShareBps` shifted by one. These tests pin the
 * facts that make choosing a shape mandatory.
 */

function fn(abi: readonly unknown[], name: string): AbiFunction {
  const e = (abi as AbiFunction[]).find((x) => x.type === "function" && x.name === name);
  if (!e) throw new Error(`no ${name} in abi`);
  return e;
}

/** Field names of a function's first (tuple) output. */
function outputTupleFields(f: AbiFunction): string[] {
  const out = f.outputs[0] as AbiParameter & { components?: AbiParameter[] };
  return (out.components ?? []).map((c) => c.name ?? "");
}

function inputTupleFields(f: AbiFunction): string[] {
  const inp = f.inputs[0] as AbiParameter & { components?: AbiParameter[] };
  return (inp.components ?? []).map((c) => c.name ?? "");
}

describe("v1 vs v2 launchpad surface", () => {
  it("getLaunch has the SAME selector on both, so the shape cannot be inferred from a revert", () => {
    // This is the whole reason `isCurveV2` exists rather than a try/catch.
    expect(toFunctionSelector(fn(LAUNCHPAD_VIEWS_ABI, "getLaunch"))).toBe(
      toFunctionSelector(fn(LAUNCHPAD_ABI, "getLaunch")),
    );
  });

  it("the v2 Launch tuple adds curveId, shifting every field after it", () => {
    const v1 = outputTupleFields(fn(LAUNCHPAD_ABI, "getLaunch"));
    const v2 = outputTupleFields(fn(LAUNCHPAD_VIEWS_ABI, "getLaunch"));
    expect(v1).not.toContain("curveId");
    expect(v2).toContain("curveId");
    expect(v2.length).toBe(v1.length + 1);
    // Inserted after creatorFeeShareBps: everything past it moves, which is
    // exactly what a v1 decode of a v2 launch would get wrong.
    expect(v2[v2.indexOf("curveId") - 1]).toBe("creatorFeeShareBps");
    expect(v1[v2.indexOf("curveId")]).toBe("bankDenom");
  });

  it("the v2 QuoteAssetConfig drops the four curve-shape fields", () => {
    const v1 = outputTupleFields(fn(LAUNCHPAD_ABI, "getQuoteAssetConfig"));
    const v2 = outputTupleFields(fn(LAUNCHPAD_VIEWS_ABI, "getQuoteAssetConfig"));
    for (const f of ["virtualPair", "virtualToken", "curveSupply", "graduationTokenReserve"]) {
      expect(v1).toContain(f);
      expect(v2).not.toContain(f);
    }
    // The base raise target survives — presets scale it, they do not replace it.
    expect(v2).toContain("graduationPairTarget");
  });

  it("createLaunch DOES change selector, so the write ABI must be picked too", () => {
    const v1 = fn(LAUNCHPAD_ABI, "createLaunch");
    const v2 = fn(LAUNCHPAD_WRITE_V2_ABI, "createLaunch");
    expect(inputTupleFields(v1)).not.toContain("curveId");
    expect(inputTupleFields(v2)).toContain("curveId");
    // Unlike getLaunch, this one fails loudly on the wrong network.
    expect(toFunctionSelector(v2)).not.toBe(toFunctionSelector(v1));
  });
});

describe("network version detection", () => {
  const withViews = (def: NetworkDef, views?: `0x${string}`): NetworkDef => ({
    ...def,
    addresses: { ...def.addresses, launchpadViews: views },
  });

  it("mainnet is v1 today: no views satellite, getters read off the core", () => {
    const net = getNetwork("mainnet");
    expect(isCurveV2(net)).toBe(false);
    expect(launchViewsAddress(net)).toBe(net.addresses.launchpadCore);
  });

  it("a network with a views satellite is v2 and reads are routed to it", () => {
    const views = "0x1111111111111111111111111111111111111111" as const;
    const net = withViews(getNetwork("mainnet"), views);
    expect(isCurveV2(net)).toBe(true);
    expect(launchViewsAddress(net)).toBe(views);
    expect(launchViewsAddress(net)).not.toBe(net.addresses.launchpadCore);
  });

  it("clearing the views address falls back to v1 rather than half-configuring", () => {
    const net = withViews(getNetwork("mainnet"), undefined);
    expect(isCurveV2(net)).toBe(false);
    expect(launchViewsAddress(net)).toBe(net.addresses.launchpadCore);
  });
});
