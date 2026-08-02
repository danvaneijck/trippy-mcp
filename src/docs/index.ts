/**
 * The `explain` topic registry.
 *
 * Shape choice: ONE tool with a topic enum, not one tool per topic and not
 * resources alone. Tools are the only surface every MCP client lets a model
 * call on its own initiative — resources generally need a human to attach them
 * — so documentation that lives only in resources is documentation no agent
 * reads. The same topics ARE registered as resources too (`trippy://docs/…`),
 * for clients that surface them, at zero extra content cost.
 *
 * Topics are deliberately fine-grained and each stays around 1.5k tokens: an
 * agent pays context for whatever it fetches, so "everything about SHROOM Pad"
 * in one blob would make asking a cheap question expensive.
 */

import { ToolError } from "../errors.js";
import type { Runtime } from "../runtime.js";
import * as agentWallet from "./agent_wallet.js";
import * as airdrops from "./airdrops.js";
import * as choice from "./choice.js";
import { loadLiveParams, type LiveParams } from "./params.js";
import * as shroomPad from "./shroom_pad.js";
import * as shroomPadFees from "./shroom_pad_fees.js";
import * as shroomPadQuotes from "./shroom_pad_quotes.js";

export interface DocTopic {
  id: string;
  title: string;
  summary: string;
  sources: string[];
  render(params: LiveParams): string;
}

export const TOPICS: readonly DocTopic[] = [
  shroomPad,
  shroomPadQuotes,
  shroomPadFees,
  choice,
  agentWallet,
  airdrops,
];

export const TOPIC_IDS = TOPICS.map((t) => t.id) as [string, ...string[]];

export function findTopic(id: string): DocTopic | undefined {
  return TOPICS.find((t) => t.id === id);
}

/** The index an agent gets when it calls `explain` with no topic. */
export function topicIndex(): Record<string, unknown> {
  return {
    topics: TOPICS.map((t) => ({ topic: t.id, title: t.title, summary: t.summary })),
    usage: "call explain again with one of these `topic` values for the full explanation",
    note: "every number in these topics is read from the chain at call time, so they cannot go stale between package releases",
  };
}

export interface Explanation {
  topic: string;
  title: string;
  content: string;
  live_params: Record<string, unknown>;
  sources: string[];
  fetched_at: string;
  warnings?: string[];
}

export async function explain(rt: Runtime, topicId?: string): Promise<Record<string, unknown>> {
  if (!topicId) return topicIndex();

  const topic = findTopic(topicId);
  if (!topic) {
    throw new ToolError(
      "unknown_topic",
      `no such topic "${topicId}"`,
      `known topics: ${TOPIC_IDS.join(", ")} — call explain with no arguments for the index`,
    );
  }

  const params = await loadLiveParams(rt);
  const out: Explanation = {
    topic: topic.id,
    title: topic.title,
    content: topic.render(params),
    live_params: liveParamsFor(topic.id, params),
    sources: topic.sources,
    fetched_at: params.fetchedAt,
  };
  if (params.errors.length > 0) {
    out.warnings = params.errors.map(
      (e) => `a live parameter read failed (${e}) — figures depending on it read as unavailable rather than guessed`,
    );
  }
  return out as unknown as Record<string, unknown>;
}

/**
 * The machine-readable half of the answer. Prose is for the agent to reason
 * with; this is for it to compute with, so a topic ships only the fields it
 * actually talks about rather than the whole parameter dump every time.
 */
function liveParamsFor(topicId: string, p: LiveParams): Record<string, unknown> {
  const quotes = p.quotes.map((q) => ({
    symbol: q.symbol,
    slot: q.slot,
    enabled: q.enabled,
    decimals: q.decimals,
    bankDenom: q.bankDenom,
    pairAsset: q.pairAsset,
    graduationPairTarget: q.graduationPairTarget,
    virtualPair: q.virtualPair,
    virtualToken: q.virtualToken,
    curveSupply: q.curveSupply,
    graduationTokenReserve: q.graduationTokenReserve,
    tradeFeeBps: q.tradeFeeBps,
    creatorFeeShareBps: q.creatorFeeShareBps,
  }));

  switch (topicId) {
    case "shroom_pad":
      return { creationFeeInj: p.creationFeeInj, quotes };
    case "shroom_pad_quotes":
      return { quotes, referralShareBps: p.referralShareBps };
    case "shroom_pad_fees":
      return {
        creationFeeInj: p.creationFeeInj,
        referralShareBps: p.referralShareBps,
        treasury: p.treasury,
        quotes,
      };
    case "agent_wallet":
      return { creationFeeInj: p.creationFeeInj };
    default:
      return {};
  }
}
