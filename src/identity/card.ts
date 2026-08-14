/**
 * The ERC-8004 agent card — the JSON `tokenURI` points at.
 *
 * Schema is Injective's, field-for-field: `injective-agent-sdk`
 * `src/types/index.ts` (`AgentCard`). Anything the ecosystem's own tooling
 * cannot parse is worthless on-chain, so this file's job is to agree with that
 * type rather than to invent a shape.
 *
 * The card is SERVED BY THE BACKEND (`pump-api/agents/:address/agent-card.json`),
 * not by this package: `tokenURI` is written once at register and changing it
 * later costs gas AND — after custody moves to the operator — a signature the
 * agent no longer has. Hosting it behind a stable URL makes a rename or an
 * avatar swap free.
 *
 * So the builder here is the VALIDATOR of what the backend serves, plus the
 * local preview. `assertValidCard` is what stops `identity register` minting an
 * immutable pointer at a 404 or at a payload the ecosystem cannot read.
 */

import { ToolError } from "../errors.js";

/** `AGENT_CARD_TYPE` in the SDK. */
export const AGENT_CARD_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";
export const AGENT_CARD_TYPE_ALT = "https://erc8004.org/agent-card";

/** Self-declared, free-form on-chain — the SHROOM Pad builder attribution. */
export const BUILDER_CODE = "shroom";
/** One of the SDK's `AgentType` union; trippy agents trade. */
export const AGENT_TYPE = "trading";

export interface ServiceEntry {
  name: string;
  endpoint: string;
  description?: string;
  version?: string;
}

export interface AgentCard {
  type: string;
  name: string;
  description?: string;
  services: ServiceEntry[];
  image: string;
  x402Support: boolean;
  active?: boolean;
  registrations?: { agentId: string | null; agentRegistry: string }[];
  updatedAt?: number;
  metadata: {
    chain: "injective";
    chainId: string;
    agentType: string;
    builderCode: string;
    operatorAddress: string;
  };
}

export interface BuildCardInput {
  name: string;
  agentAddress: string;
  /** The human operator once claimed; the agent itself until then. */
  operatorAddress: string;
  avatarUrl?: string | null;
  /** Terminal profile URL — the only endpoint a local stdio server can honestly advertise. */
  profileUrl?: string | null;
  chainId: number;
  registryAddress: string;
  agentId?: string | null;
  description?: string;
}

/**
 * Services advertise `web` ONLY.
 *
 * trippy-mcp is a local stdio MCP server: it has no reachable endpoint, so an
 * `MCP` or `A2A` entry would advertise a service that never answers. A card
 * claiming an unreachable endpoint is worse than one claiming none — the
 * ecosystem's discovery tools treat it as a live agent and time out.
 */
export function buildAgentCard(input: BuildCardInput): AgentCard {
  const services: ServiceEntry[] = [];
  if (input.profileUrl) {
    services.push({
      name: "web",
      endpoint: input.profileUrl,
      description: "Trippy Terminal profile — this agent's trades, holdings and launches.",
    });
  }
  return {
    type: AGENT_CARD_TYPE,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    services,
    image: input.avatarUrl ?? "",
    x402Support: false,
    active: true,
    registrations: [
      {
        // CAIP-10 + token id, per the SDK's `identityTuple`.
        agentId: input.agentId ?? null,
        agentRegistry: `eip155:${input.chainId}:${input.registryAddress}`,
      },
    ],
    metadata: {
      chain: "injective",
      chainId: String(input.chainId),
      agentType: AGENT_TYPE,
      builderCode: BUILDER_CODE,
      operatorAddress: input.operatorAddress,
    },
  };
}

/**
 * Throws unless `raw` parses as an `AgentCard` the SDK would accept.
 *
 * Deliberately checks the fields Injective's own `validateFetchedCard` reads
 * (it hard-fails only on a missing `name`, but a card with no `metadata` or a
 * junk `type` is a card nothing downstream can use).
 */
export function assertValidCard(raw: unknown, where: string): AgentCard {
  const bad = (why: string): never => {
    throw new ToolError(
      "bad_agent_card",
      `${where} is not a valid ERC-8004 agent card: ${why}`,
      "the card is served by the SHROOM Pad backend — run `trippy-mcp register` first, and check pumpApiBase in config.json",
    );
  };
  if (typeof raw !== "object" || raw === null) return bad("not a JSON object");
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return bad("missing `name`");
  if (o.type !== AGENT_CARD_TYPE && o.type !== AGENT_CARD_TYPE_ALT) {
    return bad(`unexpected \`type\` ${JSON.stringify(o.type)}`);
  }
  if (typeof o.metadata !== "object" || o.metadata === null) return bad("missing `metadata`");
  const m = o.metadata as Record<string, unknown>;
  if (m.chain !== "injective") return bad("metadata.chain is not \"injective\"");
  if (typeof m.chainId !== "string") return bad("metadata.chainId must be a string");
  if (typeof m.builderCode !== "string") return bad("metadata.builderCode must be a string");
  if (typeof m.agentType !== "string") return bad("metadata.agentType must be a string");
  if (!Array.isArray(o.services)) return bad("`services` must be an array");
  if (typeof o.image !== "string") return bad("`image` must be a string");
  if (typeof o.x402Support !== "boolean") return bad("`x402Support` must be a boolean");
  return raw as AgentCard;
}

/** The URL `tokenURI` is set to — stable for the life of the identity. */
export function cardUrl(pumpApiBase: string, agentAddress: string): string {
  return `${pumpApiBase.replace(/\/$/, "")}/agents/${agentAddress.toLowerCase()}/agent-card.json`;
}
