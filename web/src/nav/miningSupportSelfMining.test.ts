import test from "node:test";
import assert from "node:assert/strict";
import { decideSupportSelfMining, freshSupportSelfMiningMemory, fittedSupportMiningPlan, supportSelfMiningDiagnostic, type SupportSelfMiningInput } from "./miningSupportSelfMining.ts";
import { deriveMiningSupportCapabilities } from "./miningSupportCapabilities.ts";
import { describeFitting } from "./scriptCapabilities.ts";
import { decodeSpaceSnapshot } from "../bridge/space.ts";
import { decodeFlightStatus } from "../bridge/flight.ts";
import type { MiningDroneState } from "./miningDroneFlight.ts";
import { decideMiningAction } from "./miningBotLoop.ts";
const drones: MiningDroneState = { bay: [], out: [], maxActive: 5, roles: { 10250: "mining", 100: "combat" } };
test("self-mining evidence preserves observed flight confirmation and bounded copies, without feedback capability", () => {
  const result = decideSupportSelfMining(input({ modules: false, locked: true, drones: { ...drones,
    bay: [{ itemID: 602, typeID: 10250, quantity: 5 }] } }), freshSupportSelfMiningMemory());
  const observed = { ...drones, out: [{ itemID: 602, typeID: 10250, name: "private drone name", activity: "mining", targetID: 901,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, controlled: true }] };
  const evidence = supportSelfMiningDiagnostic(result, result.memory,
    { scope: { characterID: 501, shipID: 101, solarSystemID: 801, fleetID: "701", fittingSignature: "private scope", sessionEpoch: "private session" },
      actionID: 1, outcome: "failed", reason: "private error" }, observed);
  assert.equal(evidence.action, "launchDrones");
  assert.equal(evidence.feedback, "failed");
  assert.deepEqual(evidence.drones, [{ itemID: 602, typeID: 10250, role: "mining", activity: "mining", targetID: 901, controlled: true }]);
  assert.equal(JSON.stringify(evidence).includes("private"), false);
  observed.out[0]!.targetID = 999;
  assert.equal(evidence.drones?.[0]?.targetID, 901);
  const many = supportSelfMiningDiagnostic(result, result.memory, null, { ...observed, out: Array(40).fill(observed.out[0]) });
  assert.equal(many.drones?.length, 32); assert.equal(many.dronesTruncated, true);
  assert.equal(supportSelfMiningDiagnostic(null, result.memory, null, null).drones, null);
  assert.equal(supportSelfMiningDiagnostic(result, result.memory, null, drones).drones?.length, 0);
});
function input(options: { sample?: number; modules?: boolean; active?: boolean; distance?: number; reach?: boolean; locked?: boolean; mayWork?: boolean; enabled?: boolean; drones?: MiningDroneState; full?: boolean; hostile?: boolean; hostileDistance?: number; health?: number } = {}): SupportSelfMiningInput {
  const slots = options.modules === false ? [] : [{ family: "high" as const, index: 0, module: { itemID: 301, typeID: 401, groupID: 54, online: true, charge: null } }];
  const fittingSignature = describeFitting(101, slots), sample = options.sample ?? 200;
  const capabilities = deriveMiningSupportCapabilities({ scope: { shipID: 101, fittingSignature }, slots, dogma: null, bays: null, groupOf: () => "Mining Laser", typeNameOf: () => "Miner II" });
  const scene = decodeSpaceSnapshot({ inSpace: true, shipID: 101, solarSystemID: 801, sampledAtMs: sample,
    ship: { itemID: 101, characterID: 501, mode: "STOP", position: { x: 0, y: 0, z: 0 }, radius: 10, velocity: { x: 0, y: 0, z: 0 },
      shieldRatio: options.health ?? 1, armorRatio: 1, hullRatio: 1, activeModuleIDs: options.active ? [301] : [],
      moduleReach: options.reach === false ? null : { shipID: 101, sampledAtSimTimeMs: sample, availability: "available", modules: [{ moduleID: 301, typeID: 401, family: "mining", resourceFamily: "ore", availability: "available", maxRangeMeters: 19500 }] } },
    entities: [{ itemID: 901, kind: "asteroid", position: { x: options.distance ?? 1000, y: 0, z: 0 }, radius: 100, miningYieldTypeID: 1230, miningResourceFamily: "ore", beltID: 902 },
      ...(options.hostile ? [{ itemID: 903, kind: "ship", isNpc: true, isHostile: true, position: { x: options.hostileDistance ?? 1000, y: 0, z: 0 }, radius: 10 }] : [])] });
  return { scope: { characterID: 501, sessionEpoch: "run", shipID: 101, fleetID: "701", solarSystemID: 801, fittingSignature },
    observation: { status: decodeFlightStatus({ inSpace: true, docked: false, shipID: 101, solarSystemID: 801, shipMode: "STOP" }), snapshot: scene, measurement: null,
      lockedTargetIDs: options.locked ? [901] : [], droneBayItemIDs: [], drones: options.drones ?? drones,
      holds: [{ key: "ore", label: "Ore hold", present: true, error: null, capacity: { capacity: 1000, used: options.full ? 950 : 0 }, items: [] }] },
    capabilities, receivedAtMs: 1000, nowMs: 1000, maxTargetRangeM: 30000, droneControlRangeM: 60000, settledSpeedMetersPerSecond: 0.5,
    enabled: options.enabled ?? true, mayWork: options.mayWork ?? true, settleReason: null,
    plan: { beltID: 902, beltName: "Belt", stationID: 904, stationName: "Home", miningModuleIDs: slots.length ? [301] : [], healthFloor: 0.3, useDrones: true, myCharacterID: 501 } };
}
const out = (activity: string) => ({ itemID: 601, typeID: 10250, name: null, controlled: true, activity, targetID: 901, shieldRatio: 1, armorRatio: 1, hullRatio: 1 });

test("support shares Farmer reach while omitted engine input keeps classic hostile policy", () => {
  const value = input({ modules: false, locked: true, hostile: true, hostileDistance: 100000,
    drones: { ...drones, bay: [{ itemID: 602, typeID: 10250, quantity: 5 }, { itemID: 603, typeID: 100, quantity: 5 }] } });
  const fresh = freshSupportSelfMiningMemory();
  assert.deepEqual(decideSupportSelfMining(value, fresh).action, { kind: "launchDrones", droneItemIDs: [602] });
  assert.deepEqual(decideMiningAction(value.observation, value.plan, fresh.engine).action,
    { kind: "launch", droneItemIDs: [603] }, "classic callers retain their all-grid policy");
  assert.notEqual(decideSupportSelfMining({ ...value, observation: { ...value.observation, drones: null } }, fresh).action?.kind,
    "launchDrones", "an unreadable flight never authorizes launch");
  const unsafe = input({ modules: false, locked: true, hostile: true, hostileDistance: 100000, health: 0.1 });
  assert.equal(decideSupportSelfMining(unsafe, fresh).state, "HANDOFF", "far reach never masks health escape");
});

test("support reachable combat preserves three clear reads and actual return before mining relaunch", () => {
  const bay = [{ itemID: 602, typeID: 10250, quantity: 5 }, { itemID: 603, typeID: 100, quantity: 5 }];
  const reading = (sample: number, far: boolean, flight: MiningDroneState["out"]) => input({ sample,
    modules: false, locked: true, hostile: true, hostileDistance: far ? 100000 : 1000,
    drones: { ...drones, bay, out: flight } });
  const combat = { ...out("fighting"), itemID: 604, typeID: 100, targetID: 903 };
  let result = decideSupportSelfMining(reading(200, false, [out("mining")]), freshSupportSelfMiningMemory());
  assert.equal(result.action?.kind, "recallDrones");
  result = decideSupportSelfMining(reading(201, false, []), result.memory);
  assert.deepEqual(result.action, { kind: "launchDrones", droneItemIDs: [603] });
  result = decideSupportSelfMining(reading(202, false, [combat]), result.memory);
  for (const sample of [203, 204]) {
    result = decideSupportSelfMining(reading(sample, true, [combat]), result.memory);
    assert.equal(result.memory.engine.droneFlight?.combat, true);
    assert.notEqual(result.action?.kind, "recallDrones");
  }
  result = decideSupportSelfMining(reading(205, true, [combat]), result.memory);
  assert.deepEqual(result.action, { kind: "recallDrones", droneIDs: [604] });
  result = decideSupportSelfMining(reading(206, true, [{ ...combat, activity: "returning" }]), result.memory);
  assert.equal(result.action, null, "returning does not prove bay arrival");
  result = decideSupportSelfMining(reading(207, true, []), result.memory);
  assert.deepEqual(result.action, { kind: "launchDrones", droneItemIDs: [602] });
});

test("managed support selects current online capability item IDs while retaining ordinary explicit plans", () => {
  const value = input({ locked: true });
  const empty = { ...value.plan, miningModuleIDs: [] };
  const plan = fittedSupportMiningPlan(empty, value.capabilities);
  assert.deepEqual(plan.miningModuleIDs, [301]);
  assert.deepEqual(empty.miningModuleIDs, []);
  assert.deepEqual(decideSupportSelfMining({ ...value, plan }, freshSupportSelfMiningMemory()).action,
    { kind: "activate", moduleID: 301, targetID: 901 });
  const offline = { ...value.capabilities, mining: { ...value.capabilities.mining,
    modules: value.capabilities.mining.modules.map(row => ({ ...row, online: false })) } };
  assert.deepEqual(fittedSupportMiningPlan(empty, offline).miningModuleIDs, []);
  assert.deepEqual(fittedSupportMiningPlan(empty, { ...value.capabilities, mining: { ...value.capabilities.mining, presence: "unknown" } }).miningModuleIDs, []);
  const active = input({ active: true, mayWork: false });
  assert.equal(decideSupportSelfMining({ ...active, capabilities: offline, plan: fittedSupportMiningPlan(empty, offline) },
    freshSupportSelfMiningMemory()).action?.kind, "deactivate");
  const changed = { ...value, scope: { ...value.scope, shipID: 999 }, plan };
  assert.equal(decideSupportSelfMining(changed, freshSupportSelfMiningMemory()).action, null);
  const missing = input({ modules: false });
  assert.deepEqual(fittedSupportMiningPlan(empty, missing.capabilities).miningModuleIDs, []);
});
test("disabled/stable/support gates never start work or move; item reach selects exact usable miner", () => {
  assert.equal(decideSupportSelfMining(input({ enabled: false }), freshSupportSelfMiningMemory()).state, "SETTLED");
  assert.equal(decideSupportSelfMining(input({ mayWork: false }), freshSupportSelfMiningMemory()).action, null);
  assert.deepEqual(decideSupportSelfMining(input({ locked: true }), freshSupportSelfMiningMemory()).action, { kind: "activate", moduleID: 301, targetID: 901 });
  for (const options of [{ reach: false }, { distance: 50000 }]) assert.equal(decideSupportSelfMining(input(options), freshSupportSelfMiningMemory()).action, null);
  const unknownLock = { ...input(), maxTargetRangeM: null };
  assert.equal(decideSupportSelfMining(unknownLock, freshSupportSelfMiningMemory()).action, null);
});
test("relocation settles exact mining modules then recalls and positively confirms controlled flight", () => {
  let result = decideSupportSelfMining(input({ active: true, mayWork: false, drones: { ...drones, out: [out("mining")] } }), freshSupportSelfMiningMemory());
  assert.deepEqual(result.action, { kind: "deactivate", moduleID: 301, typeID: 401 });
  result = decideSupportSelfMining(input({ sample: 201, mayWork: false, drones: { ...drones, out: [out("mining")] } }), result.memory);
  assert.equal(result.action?.kind, "recallDrones"); assert.equal(result.state, "SETTLING");
  result = decideSupportSelfMining(input({ sample: 202, mayWork: false, drones: { ...drones, out: [out("returning")] } }), result.memory);
  assert.equal(result.action, null); assert.equal(result.state, "SETTLING");
  result = decideSupportSelfMining(input({ sample: 203, mayWork: false }), result.memory);
  assert.equal(result.state, "SETTLED");
});
test("drone-only support reuses mining flight and hostile flight switching", () => {
  const droneInput = input({ modules: false, locked: true, drones: { ...drones, bay: [{ itemID: 602, typeID: 10250, quantity: 5 }] } });
  assert.deepEqual(decideSupportSelfMining(droneInput, freshSupportSelfMiningMemory()).action, { kind: "launchDrones", droneItemIDs: [602] });
  const hostile = input({ modules: false, locked: true, hostile: true, drones: { ...drones, out: [out("mining")] } });
  assert.equal(decideSupportSelfMining(hostile, freshSupportSelfMiningMemory()).action?.kind, "recallDrones");
});
test("full hold and safety handoffs settle work instead of emitting classic travel", () => {
  for (const options of [{ full: true }, { health: 0.1 }]) {
    const result = decideSupportSelfMining(input({ ...options, active: true }), freshSupportSelfMiningMemory());
    assert.equal(result.action?.kind, "deactivate"); assert.equal(result.state, "SETTLING"); assert.ok(result.memory.stopReason);
  }
});
test("ACK cannot confirm action; only newer samples consume bound and scope changes discard feedback", () => {
  let result = decideSupportSelfMining(input(), freshSupportSelfMiningMemory());
  assert.equal(result.action?.kind, "lock");
  const same = decideSupportSelfMining(input(), result.memory);
  assert.equal(same.action, null); assert.equal(same.memory.order?.observations, 0);
  for (let sample = 201; sample < 209; sample++) result = decideSupportSelfMining(input({ sample }), result.memory,
    { scope: input().scope, actionID: 1, outcome: "acknowledged" });
  assert.equal(result.state, "BLOCKED");
  const next = input({ sample: 210 });
  const changed = decideSupportSelfMining({ ...next, scope: { ...next.scope, sessionEpoch: "other" } }, result.memory,
    { scope: input().scope, actionID: 1, outcome: "failed" });
  assert.equal(changed.action?.kind, "lock"); assert.equal(changed.memory.fault, null);
});

test("a disappeared pending lock settles the old target instead of timing out productive support", () => {
  const first = decideSupportSelfMining(input(), freshSupportSelfMiningMemory());
  const next = input({ sample: 201 });
  const replacement = { ...next.observation.snapshot!.entities[0]!, itemID: 999 };
  const gone = { ...next, observation: { ...next.observation,
    snapshot: { ...next.observation.snapshot!, entities: [replacement] } } };
  const settled = decideSupportSelfMining(gone, first.memory,
    { scope: next.scope, actionID: first.actionID!, outcome: "acknowledged" });
  assert.equal(settled.state, "SETTLED");
  assert.equal(settled.memory.order, null); assert.equal(settled.memory.fault, null);
  assert.equal(settled.memory.engine.currentRockID, null);
  const fresh = input({ sample: 202 });
  const newer = { ...fresh, observation: { ...fresh.observation,
    snapshot: { ...fresh.observation.snapshot!, entities: [{ ...fresh.observation.snapshot!.entities[0]!, itemID: 999 }] } } };
  assert.deepEqual(decideSupportSelfMining(newer, settled.memory).action, { kind: "lock", targetID: 999 });
  const unknown = decideSupportSelfMining({ ...gone, observation: { ...gone.observation, lockedTargetIDs: null } }, first.memory);
  assert.equal(unknown.memory.order?.action.kind, "lock");
  const stale = decideSupportSelfMining({ ...gone, observation: { ...gone.observation,
    snapshot: { ...gone.observation.snapshot!, sampledAtMs: 200 } } }, first.memory);
  assert.equal(stale.memory.order?.action.kind, "lock");
  const activating = decideSupportSelfMining(input({ locked: true }), freshSupportSelfMiningMemory());
  assert.equal(decideSupportSelfMining(gone, activating.memory).memory.order?.action.kind, "activate");
});

test("pending lock and failed activation cannot prohibit safety drone recall", () => {
  for (const locked of [false, true]) {
    const first = decideSupportSelfMining(input({ locked }), freshSupportSelfMiningMemory());
    const next = input({ sample: 201, locked, health: 0.1, drones: { ...drones, out: [out("mining")] } });
    const stopped = decideSupportSelfMining(next, first.memory, locked ? { scope: next.scope, actionID: first.actionID!, outcome: "failed" } : undefined);
    assert.equal(stopped.action?.kind, "recallDrones"); assert.equal(stopped.state, "SETTLING");
  }
});
test("plan changes preserve order IDs; observed activation wins over late refusal", () => {
  const first = decideSupportSelfMining(input({ locked: true }), freshSupportSelfMiningMemory());
  const next = input({ sample: 201, locked: true, active: true });
  const confirmed = decideSupportSelfMining(next, first.memory, { scope: next.scope, actionID: first.actionID!, outcome: "failed" });
  assert.equal(confirmed.memory.fault, null);
  const changed = { ...input({ sample: 202 }), plan: { ...input().plan, stationName: "New home" } };
  let result = decideSupportSelfMining(changed, confirmed.memory);
  assert.ok(result.memory.nextActionID > first.actionID!);
  result = decideSupportSelfMining({ ...changed, observation: input({ sample: 203 }).observation }, result.memory);
  assert.ok((result.actionID ?? 0) > first.actionID!);
});
test("target becomes unreachable: settle before selecting another target", () => {
  const first = decideSupportSelfMining(input({ locked: true }), freshSupportSelfMiningMemory());
  let result = decideSupportSelfMining(input({ sample: 201, locked: true, active: true, distance: 50000 }), first.memory);
  assert.equal(result.action?.kind, "deactivate"); assert.equal(result.memory.targetSettlement, true);
  result = decideSupportSelfMining(input({ sample: 202, distance: 50000 }), result.memory);
  assert.equal(result.state, "SETTLED"); assert.equal(result.memory.targetSettlement, false);
});
test("stationary COMMAND needs no travel IDs to mine or complete safety handoff", () => {
  const noTravel = (options: Parameters<typeof input>[0] = {}) => {
    const observed = input(options);
    return { ...observed, plan: { ...observed.plan, beltID: 0, stationID: 0 } };
  };
  const mining = decideSupportSelfMining(noTravel({ locked: true }), freshSupportSelfMiningMemory());
  assert.equal(mining.action?.kind, "activate");
  const emergency = decideSupportSelfMining(noTravel({ sample: 201, health: 0.1, active: true }), mining.memory);
  assert.equal(emergency.action?.kind, "deactivate");
  const settled = decideSupportSelfMining(noTravel({ sample: 202, health: 0.1 }), emergency.memory);
  assert.equal(settled.state, "HANDOFF"); assert.equal(settled.reason, "emergency-health-floor");
  assert.equal(settled.action, null);
});
