/**
 * ERC-8004 identity — the on-chain agent registry.
 *
 * These tests exist because the design was WRONG the first time, in a way a
 * green suite would not have caught: the original sequence was register → link
 * → transfer, on the assumption that the wallet link survives a transfer. It
 * does not. Measured on testnet 2026-08-14 (agents 63 and 64):
 *
 *   register()                    → getAgentWallet == msg.sender  (auto-linked)
 *   setAgentWallet(wallet = B)    → getAgentWallet == B
 *   safeTransferFrom(A → C)       → getAgentWallet == 0x0         BOTH cases
 *   sig naming the OLD owner      → "invalid wallet sig"
 *   sig naming the NEW owner      → accepted, submitted by the new owner
 *   deadline > ~300s ahead        → "deadline too far"
 *
 * So what is pinned here is the shape those facts forced, not the shape the
 * plan assumed: the deadline ceiling, the owner the signature binds, the
 * refusal to hand the identity anywhere but the owner address, and the
 * fail-soft `agent_info` block. A fixture cannot prove chain behaviour — the
 * chain proved it, and these keep the code agreeing with what it proved.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toEventSelector,
  zeroAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { AuditLog } from "../src/audit.js";
import { getNetwork } from "../src/chain/networks.js";
import { PolicySchema } from "../src/config.js";
import { PolicyError } from "../src/errors.js";
import {
  IDENTITY_REGISTRY_ABI,
  MAX_WALLET_LINK_DEADLINE_SECS,
  WALLET_LINK_DOMAIN_NAME,
  WALLET_LINK_TYPES,
} from "../src/identity/abi.js";
import { assertValidCard, buildAgentCard, cardUrl } from "../src/identity/card.js";
import {
  IdentityRegistry,
  REGISTERED_TOPIC,
  registeredIdFromLogs,
} from "../src/identity/registry.js";
import { loadIdentityState, saveIdentityState } from "../src/identity/state.js";
import { agentInfo } from "../src/mcp/tools.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { SpendLedger } from "../src/policy/spend.js";
import { allowedTargetsFor, type Runtime } from "../src/runtime.js";

const MAINNET = getNetwork("mainnet");
const REGISTRY = MAINNET.erc8004.identityRegistry as Address;
const OWNER = "0x204Ac1DC67837C9b17F5AF6E5e4be4Bfd0A4104c";
const STRANGER = "0x2222222222222222222222222222222222222222";
/** Throwaway test key — never used anywhere but here. */
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ACCOUNT = privateKeyToAccount(KEY);

function ledgerDir(): string {
  return mkdtempSync(join(tmpdir(), "trippy-identity-test-"));
}

/**
 * A signer stub with the two real pieces the registry needs: a viem account
 * (so signatures are genuine and recoverable) and a policy engine (so a
 * refusal is the real refusal, not a mock's).
 */
function stubSigner(opts: {
  reads?: Record<string, unknown>;
  allowRegistry?: boolean;
  /** Receipt `register` gets back; omitted means the RPC never produced one. */
  receipt?: { logs: { address: string; topics: string[] }[] };
  onWrite?: (intent: { kind: string; target: string; destination?: string }) => void;
}) {
  const dir = ledgerDir();
  const allowed = new Set<string>([MAINNET.addresses.launchpadCore.toLowerCase()]);
  if (opts.allowRegistry !== false) allowed.add(REGISTRY.toLowerCase());
  const policy = new PolicyEngine(
    PolicySchema.parse({}),
    allowed,
    OWNER.toLowerCase(),
    new SpendLedger(dir),
  );
  const writes: { functionName: string; args: readonly unknown[] }[] = [];
  const signer = {
    address: ACCOUNT.address,
    account: ACCOUNT,
    publicClient: {
      getBlock: async () => ({ timestamp: 1_786_700_000n }),
      getBlockNumber: async () => 1n,
      getTransactionReceipt: async () => {
        if (!opts.receipt) throw new Error("no receipt");
        return opts.receipt;
      },
      request: async () => [],
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      const v = opts.reads?.[functionName];
      if (v === undefined) throw new Error(`unstubbed read ${functionName}`);
      return v;
    },
    writeTx: async (o: {
      functionName: string;
      args: readonly unknown[];
      intent: { kind: string; target: string; destination?: string };
    }) => {
      policy.enforce(o.intent as never);
      opts.onWrite?.(o.intent);
      writes.push({ functionName: o.functionName, args: o.args });
      return { hash: "0xfeed" as `0x${string}`, status: "confirmed" as const };
    },
  };
  return { signer: signer as never, writes, policy };
}

// ---------------------------------------------------------------------------

describe("agent card", () => {
  it("builds a card the SDK's own validator accepts", () => {
    const card = buildAgentCard({
      name: "fable-agent",
      agentAddress: ACCOUNT.address,
      operatorAddress: OWNER,
      avatarUrl: "https://example.test/a.png",
      profileUrl: "https://trade.trippyinj.xyz/profile/0xabc",
      chainId: 1776,
      registryAddress: REGISTRY,
    });
    expect(card.type).toBe("https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    expect(card.metadata).toEqual({
      chain: "injective",
      chainId: "1776",
      agentType: "trading",
      builderCode: "shroom",
      operatorAddress: OWNER,
    });
    expect(card.registrations?.[0]?.agentRegistry).toBe(`eip155:1776:${REGISTRY}`);
    expect(card.x402Support).toBe(false);
    // A local stdio MCP server has no reachable endpoint, so `web` is the only
    // service it may honestly advertise.
    expect(card.services.map((s) => s.name)).toEqual(["web"]);
    expect(() => assertValidCard(card, "built")).not.toThrow();
  });

  it("refuses a card that would make tokenURI point at junk", () => {
    expect(() => assertValidCard({ name: "x" }, "u")).toThrow(/agent card/);
    expect(() => assertValidCard({ name: "x", type: "nope", metadata: {} }, "u")).toThrow(/type/);
    expect(() =>
      assertValidCard(
        { name: "x", type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" },
        "u",
      ),
    ).toThrow(/metadata/);
  });

  it("points tokenURI at a stable backend URL, lowercased", () => {
    expect(cardUrl("https://pump-api.trippyinj.xyz/", "0xAbCdEf0000000000000000000000000000000001")).toBe(
      "https://pump-api.trippyinj.xyz/agents/0xabcdef0000000000000000000000000000000001/agent-card.json",
    );
  });
});

/**
 * The log set of a REAL testnet registration — tx
 * 0x34d650e96cc0898fb10d6283024eb07dbc31793e055cb2666e523d357eb073b0, which
 * minted agent 64. Order and topic0s copied off the receipt: ERC-721 Transfer
 * first, then Registered, then three MetadataSet logs. Anything that scans for
 * `Registered` has to pick it out of that, not assume `logs[0]`.
 */
const REAL_RECEIPT_LOGS = [
  {
    address: REGISTRY.toLowerCase(),
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer
      `0x${"0".repeat(64)}`,
      `0x${"0".repeat(24)}${ACCOUNT.address.slice(2).toLowerCase()}`,
      `0x${(64).toString(16).padStart(64, "0")}`,
    ],
  },
  {
    address: REGISTRY.toLowerCase(),
    topics: [
      REGISTERED_TOPIC,
      `0x${(64).toString(16).padStart(64, "0")}`,
      `0x${"0".repeat(24)}${ACCOUNT.address.slice(2).toLowerCase()}`,
    ],
  },
  {
    address: REGISTRY.toLowerCase(),
    topics: [
      "0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b", // MetadataSet
      `0x${(64).toString(16).padStart(64, "0")}`,
    ],
  },
];

describe("agentId extraction", () => {
  it("pins the Registered topic to the event in the ABI", () => {
    const event = IDENTITY_REGISTRY_ABI.find(
      (e) => e.type === "event" && e.name === "Registered",
    );
    expect(toEventSelector(event as never)).toBe(REGISTERED_TOPIC);
  });

  /**
   * Shape copied from the receipt of a REAL testnet registration (tx
   * 0x34d650e9…, agent 64): the id is topics[1] of the registry's own log, and
   * the receipt also carries ERC-721 Transfer + three MetadataSet logs that
   * must not be mistaken for it.
   */
  it("reads the agentId off the real receipt log shape", () => {
    expect(registeredIdFromLogs(REAL_RECEIPT_LOGS, REGISTRY)).toBe("64");
  });

  it("ignores an identical event emitted by a different contract", () => {
    const logs = [
      {
        address: "0x000000000000000000000000000000000000dead",
        topics: [REGISTERED_TOPIC, `0x${(9).toString(16).padStart(64, "0")}`],
      },
    ];
    expect(registeredIdFromLogs(logs, REGISTRY)).toBeNull();
  });
});

describe("wallet link", () => {
  const registry = () => {
    const { signer } = stubSigner({});
    return new IdentityRegistry(MAINNET, signer);
  };

  /**
   * The number is written out LITERALLY, not as MAX_WALLET_LINK_DEADLINE_SECS.
   * Asserting against the constant is what a test looks like when it proves
   * nothing: raising the constant to the plan's "generous deadline" moves the
   * expectation with it and the suite stays green while every link reverts
   * on-chain with "deadline too far". 300 is a property of the deployed
   * contract, measured on both networks — so 300 is what is written here.
   */
  it("never signs a deadline the contract would reject as 'deadline too far'", async () => {
    expect(MAX_WALLET_LINK_DEADLINE_SECS).toBe(300);

    const CHAIN_NOW = 1_786_700_000; // the stubbed block timestamp
    const link = await registry().signWalletLink({
      agentId: 64n,
      owner: OWNER as Address,
      ttlSecs: 86_400, // an operator asking for a day gets five minutes
    });
    expect(link.deadline - CHAIN_NOW).toBeLessThanOrEqual(300);
    expect(link.ttlSecs).toBeLessThanOrEqual(300);

    // The default is under the ceiling on purpose: at exactly 300 a link minted
    // against a `latest` block a few seconds stale reverts by the time it lands.
    const dflt = await registry().signWalletLink({ agentId: 64n, owner: OWNER as Address });
    expect(dflt.deadline - CHAIN_NOW).toBeLessThan(300);
    // …and still long enough to be usable by a human clicking a button.
    expect(dflt.deadline - CHAIN_NOW).toBeGreaterThanOrEqual(120);
  });

  it("binds the signature to the address that will SUBMIT it", async () => {
    const link = await registry().signWalletLink({ agentId: 64n, owner: OWNER as Address });
    const recovered = await recoverWalletLink(link.signature, {
      agentId: 64n,
      newWallet: ACCOUNT.address,
      owner: OWNER as Address,
      deadline: BigInt(link.deadline),
    });
    expect(recovered.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());

    // …and the same signature does NOT verify against a different owner — which
    // is exactly the "invalid wallet sig" revert the chain returned when a sig
    // naming the old owner was submitted by the new one.
    const wrong = await recoverWalletLink(link.signature, {
      agentId: 64n,
      newWallet: ACCOUNT.address,
      owner: STRANGER as Address,
      deadline: BigInt(link.deadline),
    });
    expect(wrong.toLowerCase()).not.toBe(ACCOUNT.address.toLowerCase());
  });
});

describe("policy", () => {
  /**
   * The wiring, not the logic: the registry has to be on the runtime's
   * allowlist or every identity write is refused inside the signer — a failure
   * nothing else in the suite would surface, because each other test builds its
   * own allowlist.
   */
  it("puts the identity registry on the real runtime allowlist", () => {
    for (const name of ["mainnet", "testnet"] as const) {
      const net = getNetwork(name);
      expect(allowedTargetsFor(net)).toContain(net.erc8004.identityRegistry.toLowerCase());
    }
  });

  it("refuses the register write when the registry is not allowlisted", async () => {
    const { signer } = stubSigner({ allowRegistry: false });
    const registry = new IdentityRegistry(MAINNET, signer);
    await expect(registry.register("https://x.test/card.json")).rejects.toThrow(PolicyError);
  });

  it("allows it once the registry is on the allowlist, and reads back the id", async () => {
    const { signer, writes } = stubSigner({ receipt: { logs: REAL_RECEIPT_LOGS } });
    const registry = new IdentityRegistry(MAINNET, signer);
    const { agentId } = await registry.register("https://x.test/card.json");
    expect(agentId).toBe("64");
    expect(writes[0]?.functionName).toBe("register");
    // builderCode/agentType ride along in the SAME transaction — abi-encoded
    // strings, not raw bytes.
    const metadata = writes[0]?.args[1] as { metadataKey: string; metadataValue: string }[];
    expect(metadata.map((m) => m.metadataKey)).toEqual(["builderCode", "agentType"]);
    expect(metadata[0]?.metadataValue).toBe(
      encodeAbiParameters(parseAbiParameters("string"), ["shroom"]),
    );
  });

  it("refuses to transfer the identity anywhere but the owner address", async () => {
    const { signer } = stubSigner({});
    const registry = new IdentityRegistry(MAINNET, signer);
    await expect(registry.transfer(64n, STRANGER as Address)).rejects.toThrow(
      /not the owner address/,
    );
    await expect(registry.transfer(64n, OWNER as Address)).resolves.toBeTruthy();
  });

  it("does not charge identity gas against the trading budget", () => {
    const dir = ledgerDir();
    const ledger = new SpendLedger(dir);
    const policy = new PolicyEngine(
      PolicySchema.parse({ dailyBudgetUsd: 10, tradingEnabled: false }),
      new Set([REGISTRY.toLowerCase()]),
      OWNER.toLowerCase(),
      ledger,
    );
    // tradingEnabled=false kills trades but must not brick identity upkeep.
    expect(() =>
      policy.enforce({ kind: "identity", target: REGISTRY, detail: "register" }),
    ).not.toThrow();
    expect(ledger.spent()).toBe(0);
  });
});

describe("custody", () => {
  const view = async (owner: string, wallet: string) => {
    const { signer } = stubSigner({
      reads: {
        ownerOf: owner,
        getAgentWallet: wallet,
        tokenURI: "https://x.test/card.json",
        getMetadata: encodeAbiParameters(parseAbiParameters("string"), ["shroom"]),
      },
    });
    return new IdentityRegistry(MAINNET, signer).view(64n);
  };

  it("reads 'agent' while the agent still owns its identity", async () => {
    expect((await view(ACCOUNT.address, ACCOUNT.address)).custody).toBe("agent");
  });

  it("reads 'owner' in the target topology", async () => {
    expect((await view(OWNER, ACCOUNT.address)).custody).toBe("owner");
  });

  /**
   * The state the whole design turns on: a transferred identity comes back with
   * agentWallet == 0x0, and trades stop being attributable until it is relinked.
   */
  it("reads 'unlinked' right after a transfer", async () => {
    expect((await view(OWNER, zeroAddress)).custody).toBe("unlinked");
  });

  it("reads 'foreign' when it is somebody else's agent", async () => {
    expect((await view(STRANGER, STRANGER)).custody).toBe("foreign");
  });
});

describe("agent_info", () => {
  const runtime = (over: Partial<Runtime> & { home: string }): Runtime =>
    ({
      cfg: { agentName: "fable-agent", ownerSweepAddress: OWNER } as never,
      net: MAINNET,
      audit: { append() {} } as unknown as AuditLog,
      injAddress: "inj1lr5qnxn8qem0psflh8we7cdeyecutenzgcxjjg",
      pump: { getAgent: async () => ({ agent: null }) } as never,
      ...over,
    }) as Runtime;

  it("nudges toward registration when there is no identity", async () => {
    const { signer } = stubSigner({});
    const home = ledgerDir();
    const info = (await agentInfo(runtime({ home, signer }))) as {
      erc8004: { registered: boolean; howToRegister: string };
    };
    expect(info.erc8004.registered).toBe(false);
    expect(info.erc8004.howToRegister).toMatch(/identity register/);
  });

  it("reports the on-chain state once registered", async () => {
    const home = ledgerDir();
    saveIdentityState(home, {
      agentId: "64",
      chainId: 1776,
      registry: REGISTRY,
      cardUri: "https://x.test/card.json",
      registeredAt: new Date().toISOString(),
    });
    expect(loadIdentityState(home)?.agentId).toBe("64");
    const { signer } = stubSigner({
      reads: {
        ownerOf: OWNER,
        getAgentWallet: ACCOUNT.address,
        tokenURI: "https://x.test/card.json",
        getMetadata: encodeAbiParameters(parseAbiParameters("string"), ["shroom"]),
      },
    });
    const info = (await agentInfo(runtime({ home, signer }))) as {
      erc8004: { registered: boolean; agentId: string; custody: string; scanUrl: string };
    };
    expect(info.erc8004.registered).toBe(true);
    expect(info.erc8004.agentId).toBe("64");
    expect(info.erc8004.custody).toBe("owner");
    expect(info.erc8004.scanUrl).toBe(`https://8004scan.io/agent/eip155:1776:${REGISTRY}:64`);
  });

  /**
   * The registry is an upgradeable proxy read over a public RPC, and
   * `agent_info` is the first call of a session. A flaky read must not take
   * identity down with it.
   */
  it("fails soft when the registry read throws", async () => {
    const home = ledgerDir();
    saveIdentityState(home, {
      agentId: "64",
      chainId: 1776,
      registry: REGISTRY,
      cardUri: "",
      registeredAt: "",
    });
    const { signer } = stubSigner({}); // every read is unstubbed → throws
    const info = (await agentInfo(runtime({ home, signer }))) as Record<string, unknown>;
    expect(info.erc8004).toBeNull();
    expect(info.agentName).toBe("fable-agent");
  });

  it("survives a corrupt identity.json", () => {
    const home = ledgerDir();
    writeFileSync(join(home, "identity.json"), "{not json");
    expect(loadIdentityState(home)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

async function recoverWalletLink(
  signature: `0x${string}`,
  message: { agentId: bigint; newWallet: Address; owner: Address; deadline: bigint },
): Promise<Address> {
  const { recoverTypedDataAddress } = await import("viem");
  return recoverTypedDataAddress({
    domain: {
      name: WALLET_LINK_DOMAIN_NAME,
      version: "1",
      chainId: 1776,
      verifyingContract: REGISTRY,
    },
    types: WALLET_LINK_TYPES,
    primaryType: "AgentWalletSet",
    message,
    signature,
  });
}

// keep viem's keccak256/vi imports honest for the linter
void keccak256;
void vi;
