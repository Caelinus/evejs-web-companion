import type { FindAgentsResult, FoundAgent } from "../app/api.ts";
import { AGENT_BUTTON } from "../bridge/agents.ts";
import type { AgentConversation } from "../store/types.ts";

export const MAX_DISTRIBUTION_LEVEL = 4;
export type AgentProbe = "usable" | "ineligible" | "unavailable";

/** DoAction(None) is the game's access verdict; static standings are never guessed here. */
export function classifyDistributionAgentConversation(conversation: AgentConversation): AgentProbe {
  if (/standings are not high enough|too low standings/i.test(conversation.agentSays)) return "ineligible";
  const meaningful = new Set<number>(Object.values(AGENT_BUTTON));
  return conversation.actions.some((action) => Number.isSafeInteger(action.actionID) && action.actionID > 0 &&
    meaningful.has(action.buttonType)) ? "usable" : "unavailable";
}

export interface DistributionAgentPolicy {
  readonly preferredLevel: number;
  readonly fallback: boolean;
  readonly corporationID: number | null;
  readonly maxJumps: number | null;
  readonly originSystemID: number | null;
  readonly distances: ReadonlyMap<number, number> | null;
}

export interface DistributionAgentSelection {
  readonly agent: FoundAgent | null;
  readonly level: number | null;
  readonly reason: string;
}

/** Exhaust one level's nearest candidates before trying the next lower level. */
export async function selectDistributionAgent(
  policy: DistributionAgentPolicy,
  find: (level: number) => Promise<Pick<FindAgentsResult, "agents" | "capped" | "total">>,
  probe: (agentID: number) => Promise<AgentProbe>,
): Promise<DistributionAgentSelection> {
  const preferred = policy.preferredLevel;
  if (!Number.isSafeInteger(preferred) || preferred < 1 || preferred > MAX_DISTRIBUTION_LEVEL ||
      typeof policy.fallback !== "boolean") {
    return { agent: null, level: null, reason: "Choose a Distribution level from 1 to 4 and a valid fallback policy." };
  }
  if (!Number.isSafeInteger(policy.originSystemID) || policy.originSystemID === null || policy.originSystemID <= 0 ||
      policy.distances === null) {
    return { agent: null, level: null, reason: "The current system or route distances could not be read." };
  }
  for (let level = preferred; level >= (policy.fallback ? 1 : preferred); level--) {
    const found = await find(level);
    if (!Array.isArray(found.agents) || !Number.isSafeInteger(found.total) || found.total < found.agents.length ||
        typeof found.capped !== "boolean" || found.capped || found.total > found.agents.length) {
      return { agent: null, level: null, reason: `The level ${level} agent list was incomplete; no lower level was selected.` };
    }
    const candidates = found.agents
      .filter((agent) => agent.level === level && agent.divisionID === 22 && agent.agentTypeID === 2 &&
        agent.stationID !== null && agent.solarSystemID !== null &&
        (policy.corporationID === null || agent.corporationID === policy.corporationID))
      .map((agent) => ({
        agent,
        jumps: agent.solarSystemID === policy.originSystemID ? 0 :
          (policy.distances?.get(agent.solarSystemID!) ?? Number.POSITIVE_INFINITY),
      }))
      .filter(({ jumps }) => Number.isFinite(jumps) && (policy.maxJumps === null || jumps <= policy.maxJumps))
      .sort((a, b) => a.jumps - b.jumps || a.agent.agentID - b.agent.agentID);
    let authorityUnreadable = false;
    for (const { agent } of candidates) {
      let access: AgentProbe = "unavailable";
      try { access = await probe(agent.agentID); } catch { /* unreadable is never eligible */ }
      if (access === "usable") {
        return { agent, level, reason: level === preferred
          ? `Found an eligible level ${level} Distribution agent.`
          : `Level ${preferred} unavailable; using an eligible level ${level} Distribution agent.` };
      }
      if (access !== "ineligible") authorityUnreadable = true;
    }
    if (authorityUnreadable) {
      return { agent: null, level: null, reason: `Level ${level} agent access could not be confirmed; no lower level was selected.` };
    }
  }
  return { agent: null, level: null, reason: policy.fallback && preferred > 1
    ? `No eligible Distribution agent is available at level ${preferred} or below.`
    : `No eligible level ${preferred} Distribution agent is available.` };
}
