import test from "node:test";
import assert from "node:assert/strict";
import type { FoundAgent } from "../app/api.ts";
import type { AgentConversation } from "../store/types.ts";
import { classifyDistributionAgentConversation, selectDistributionAgent } from "./distributionAgentSelection.ts";

const ORIGIN = 30000001;
function agent(id: number, level: number, over: Partial<FoundAgent> = {}): FoundAgent {
  return { agentID: id, name: `Agent ${id}`, level, divisionID: 22, agentTypeID: 2,
    missionKind: "courier", missionTypeLabel: "Distribution", corporationID: 100,
    factionID: 500, stationID: 60000000 + id, stationName: "Station",
    solarSystemID: 30001000 + id, solarSystemName: "System", ...over };
}
function policy(level: number, fallback = false, over: Partial<Parameters<typeof selectDistributionAgent>[0]> = {}) {
  return { preferredLevel: level, fallback, corporationID: null, maxJumps: null,
    originSystemID: ORIGIN, distances: new Map<number, number>(), ...over };
}
function finder(rows: readonly FoundAgent[], asked: number[] = []) {
  return async (level: number) => {
    asked.push(level);
    const agents = rows.filter((row) => row.level === level);
    return { agents, total: agents.length, capped: false };
  };
}
const reachable = (rows: readonly FoundAgent[]) => new Map(rows.map((row, i) => [row.solarSystemID!, i + 1]));
const usable = async () => "usable" as const;

test("exact preferred levels 1, 2, 3 and 4 never search another level", async () => {
  for (const level of [1, 2, 3, 4]) {
    const row = agent(level, level), asked: number[] = [];
    const picked = await selectDistributionAgent(policy(level, false, { distances: reachable([row]) }), finder([row], asked), usable);
    assert.equal(picked.agent?.agentID, level);
    assert.deepEqual(asked, [level]);
  }
});

test("fallback descends 4→3→2→1 and 3→2→1; disabled never searches lower or higher", async () => {
  for (const preferred of [4, 3]) {
    const rows = Array.from({ length: preferred }, (_, i) => agent(i + 1, i + 1));
    const asked: number[] = [];
    const picked = await selectDistributionAgent(policy(preferred, true, { distances: reachable(rows) }),
      finder(rows, asked), async (id) => id === 1 ? "usable" : "ineligible");
    assert.deepEqual(asked, Array.from({ length: preferred }, (_, i) => preferred - i));
    assert.equal(picked.level, 1);
    const exactAsked: number[] = [];
    const exact = await selectDistributionAgent(policy(preferred, false, { distances: reachable(rows) }),
      finder(rows, exactAsked), async () => "ineligible");
    assert.equal(exact.agent, null);
    assert.deepEqual(exactAsked, [preferred]);
  }
});

test("a reachable preferred-level agent beats a nearer lower-level agent", async () => {
  const high = agent(4, 4), low = agent(3, 3), asked: number[] = [];
  const result = await selectDistributionAgent(policy(4, true, { distances: new Map([
    [high.solarSystemID!, 12], [low.solarSystemID!, 1],
  ]) }), finder([low, high], asked), usable);
  assert.equal(result.agent?.agentID, 4);
  assert.deepEqual(asked, [4]);
});

test("inaccessible nearest candidate is skipped before a farther same-level candidate", async () => {
  const first = agent(1, 4), second = agent(2, 4), probed: number[] = [];
  const picked = await selectDistributionAgent(policy(4, false, { distances: new Map([
    [first.solarSystemID!, 1], [second.solarSystemID!, 3],
  ]) }), finder([second, first]), async (id) => { probed.push(id); return id === 1 ? "ineligible" : "usable"; });
  assert.deepEqual(probed, [1, 2]);
  assert.equal(picked.agent?.agentID, 2);
});

test("division, standard type, corporation, jump limit and unknown route exclude candidates", async () => {
  const rows = [agent(1, 4, { divisionID: 24 }), agent(2, 4, { agentTypeID: 3 }),
    agent(3, 4, { corporationID: 200 }), agent(4, 4), agent(5, 4), agent(6, 4)];
  const probed: number[] = [];
  const picked = await selectDistributionAgent(policy(4, false, { corporationID: 100, maxJumps: 3,
    distances: new Map([[rows[3]!.solarSystemID!, 8], [rows[4]!.solarSystemID!, 2]]) }),
    finder(rows), async (id) => { probed.push(id); return "usable"; });
  assert.equal(picked.agent?.agentID, 5);
  assert.deepEqual(probed, [5]);
});

test("authoritatively inaccessible candidates exhaust once", async () => {
  const rows = [agent(4, 4), agent(3, 3)], asked: number[] = [], probed: number[] = [];
  const picked = await selectDistributionAgent(policy(4, true, { distances: reachable(rows) }),
    finder(rows, asked), async (id) => { probed.push(id); return "ineligible"; });
  assert.equal(picked.agent, null);
  assert.deepEqual(asked, [4, 3, 2, 1]);
  assert.deepEqual(probed, [4, 3]);
});

test("unknown or throwing preferred-level authority blocks fallback but checks another same-level candidate", async () => {
  const rows = [agent(4, 4), agent(5, 4), agent(3, 3)], asked: number[] = [], probed: number[] = [];
  const picked = await selectDistributionAgent(policy(4, true, { distances: reachable(rows) }),
    finder(rows, asked), async (id) => { probed.push(id); if (id === 4) throw new Error("unreadable"); return "ineligible"; });
  assert.equal(picked.agent, null);
  assert.match(picked.reason, /could not be confirmed/i);
  assert.deepEqual(asked, [4]);
  assert.deepEqual(probed, [4, 5]);
});

test("a capped preferred-level list blocks rather than choosing a lower level", async () => {
  const asked: number[] = [];
  const picked = await selectDistributionAgent(policy(4, true), async (level) => {
    asked.push(level);
    return { agents: [], total: 1, capped: true };
  }, usable);
  assert.equal(picked.agent, null);
  assert.match(picked.reason, /incomplete/i);
  assert.deepEqual(asked, [4]);
});

test("invalid level or unreadable route authority fails closed before candidate search", async () => {
  for (const p of [policy(0), policy(5), policy(3, false, { distances: null })]) {
    const asked: number[] = [];
    const result = await selectDistributionAgent(p, finder([], asked), usable);
    assert.equal(result.agent, null);
    assert.deepEqual(asked, []);
  }
});

function conversation(says: string, actions: AgentConversation["actions"]): AgentConversation {
  return { agentSays: says, contentID: null, actions,
    lastActionInfo: { missionCompleted: null, missionDeclined: null, missionQuit: null, loyaltyPoints: null } };
}
test("conversation authority accepts usable action, rejects standings denial and malformed buttons", () => {
  assert.equal(classifyDistributionAgentConversation(conversation("Hello", [{ actionID: 8, buttonType: 2, label: "Request" }])), "usable");
  assert.equal(classifyDistributionAgentConversation(conversation("Your current standings are not high enough", [{ actionID: 8, buttonType: 2, label: "Request" }])), "ineligible");
  assert.equal(classifyDistributionAgentConversation(conversation("Hello", [{ actionID: 0, buttonType: 2, label: "Bad" }])), "unavailable");
  assert.equal(classifyDistributionAgentConversation(conversation("Hello", [{ actionID: 8, buttonType: 99, label: "Unknown" }])), "unavailable");
});
