import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import type { MacroStep } from "../bots/botScript.ts";
import type { FlightStatus, MiningHold, SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import type { MiningOperationAssignment, MiningOperationTarget, ScriptObservation } from "./scriptConditions.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import { decodeScriptValue } from "../bots/scriptCodec.ts";
import { decodeDroneBay } from "../bridge/drones.ts";
import type { DroneInSpace } from "../store/types.ts";
import type { BotLogDraft } from "./botLog.ts";
import type { ScriptAction } from "./scriptDecide.ts";
import { decideScriptAction, initialMemory } from "./scriptDecide.ts";
import { createScriptRunner } from "./scriptRunner.ts";
const require = createRequire(import.meta.url);
const { buildStandardProfile } = require("../../../src/miningOperationProfiles.js");

const beltStep: MacroStep = {
  id: "mine",
  kind: "macro",
  macro: "mine-at-belt",
  args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
};
const siteWarpStep: MacroStep = { id: "warp", kind: "macro", macro: "warp-to-ore-anomaly", args: {} };
const travelStep: MacroStep = { id: "travel", kind: "macro", macro: "travel-to-belt", args: {} };
const lootStep: MacroStep = { id: "loot", kind: "macro", macro: "loot-containers", args: {} };
const deliverStep: MacroStep = {
  id: "deliver",
  kind: "macro",
  macro: "deliver-ore",
  args: { station: { kind: "station", ref: { entity: "station", id: 60000004, name: "Home", systemName: null } } },
};

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null, shipID: 9, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null, ...over };
}

function entity(itemID: number, name: string, x = 0): SpaceEntity {
  return {
    itemID, kind: "celestial", typeID: 1, groupID: 1, categoryID: 2, name, ownerID: null,
    radius: 10, position: { x, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: null, beltID: null, oreGrade: null,
    oreValuePerM3: null, isNpc: false, npcEntityType: null, controllerID: null,
    droneActivity: null, targetEntityID: null,
  };
}

function snapshot(entities: readonly SpaceEntity[]): SpaceSnapshot {
  return {
    inSpace: true, solarSystemID: 30000142, shipID: 9, sampledAtMs: 1, entities,
    ship: {
      itemID: 9, typeID: 1, name: "Miner", mode: null, maxVelocity: 100, radius: 100,
      position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
      shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
    } as unknown as NonNullable<SpaceSnapshot["ship"]>,
  };
}

function target(over: Partial<MiningOperationTarget> = {}): MiningOperationTarget {
  return {
    targetKey: "BELT:30000142:Asteroid Belt 1", targetType: "BELT", systemID: 30000142,
    systemName: "Jita", targetName: "Asteroid Belt 1", state: "ACTIVE", claimedByOperationID: "op",
    ...over,
  };
}

function assignment(over: Partial<MiningOperationAssignment> = {}): MiningOperationAssignment {
  return {
    operationID: "op", operationName: "Op", role: "MINER", unloadPolicy: "HAULER_SERVICE",
    area: { anchorSystemID: 30000142, anchorSystemName: "Jita", reach: "CURRENT_SYSTEM", targetClasses: ["BELT"] },
    state: "MINING", currentTarget: target(), logisticsTarget: null, rendezvous: null,
    ownedContainerIDs: [50, 501], miningOwnerIDs: [900005], containerProvenanceUnconfirmed: false, ...over,
  };
}

function observation(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false, flightStatus: flight(), snapshot: snapshot([]),
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1, oreHoldFraction: 0,
    holdEmpty: true, hostileOnGrid: false, dronesOut: false, lockedTargetIDs: [], holds: [],
    droneBayItemIDs: [], miningModuleIDs: [], startingStationID: null, systemName: "Jita",
    miningOperation: assignment(), ...over,
  };
}

function oreHold(itemIDs: readonly number[]): MiningHold[] {
  return [{
    key: "ore", label: "Ore Hold", present: true, error: null, capacity: null,
    items: itemIDs.map((itemID) => ({ itemID, typeID: 1230, groupID: 462, categoryID: 25, quantity: 100 })),
  }];
}

// The actual versioned profile -> codec -> runner -> real macros -> drone
// ladder, with only world IO replaced. A successful command is NOT a return:
// recall stays visible for two further observations before the singleton bay
// rows reappear in the same format as returned drones in the live logs.
function standardMinerHarness(dronesEnabled = true, family: "BELT" | "ORE_ANOMALY" | "ICE" = "BELT", selfUnload = false) {
  const profile = buildStandardProfile({ area: { targetClasses: [family] }, unloadPolicy: selfUnload ? "SELF_UNLOAD" : "HAULER_SERVICE",
    unloadDestination: { stationID: 60000004, stationName: "Home", systemName: "Jita", corporationDivision: 1 },
  }, { role: "MINER", routineMode: "STANDARD" });
  if (!dronesEnabled) delete profile.doc.program[0].body[1].args.drones;
  const decoded = decodeScriptValue(profile.doc);
  assert.ok(decoded.ok);
  const ids = [81, 82, 83, 84, 85];
  let out: DroneInSpace[] = [];
  let recallReads = 0;
  let droneReadUnavailable = false;
  const bay = () => decodeDroneBay(ids.filter(id => !out.some(d => d.itemID === id))
    .map(itemID => ({ itemID, typeID: 101, quantity: -1, singleton: true })))!;
  const droneState = () => ({ out, bay: bay(), maxActive: 5, roles: { 101: "mining" as const } });
  const rock = { ...entity(501, "Veldspar", 1000), kind: "asteroid" as const, miningYieldTypeID: 1230, beltID: 1, remainingQuantity: 10000 };
  let world = observation({ snapshot: snapshot([entity(1, "Asteroid Belt 1"), rock]),
    miningOperationRequired: true, miningModuleIDs: [71], holds: oreHold([]) });
  if (family !== "BELT") {
    world = { ...world, ...siteWorld(family), miningModuleIDs: [71], iceMiningModuleIDs: family === "ICE" ? [71] : [],
      snapshot: snapshot([{ ...rock, miningResourceFamily: family === "ICE" ? "ice" : "ore" }]) };
  }
  if (selfUnload) world = { ...world, miningOperation: { ...world.miningOperation!, unloadPolicy: "SELF_UNLOAD" } };
  const actions: ScriptAction[] = [];
  const logs: BotLogDraft[] = [];
  const runner = createScriptRunner({
    observe: async () => {
      if (recallReads > 0 && --recallReads === 0) out = [];
      return { ...world, dronesOut: out.length > 0, miningDrones: droneReadUnavailable ? { ...droneState(), out: null } : droneState(),
        snapshot: { ...world.snapshot!, entities: [...world.snapshot!.entities, ...out.map(d => ({
          ...entity(d.itemID, "Mining Drone"), kind: "drone" as const, categoryID: 18,
          controllerID: 9, typeID: d.typeID, droneActivity: d.activity, targetEntityID: d.targetID,
        }))] } };
    },
    issue: async a => {
      actions.push(a);
      switch (a.kind) {
        case "launchDrones":
          assert.ok(world.miningOperation?.currentTarget, "launch requires current operation target");
          for (const itemID of a.droneItemIDs) {
                        out.push({ itemID, typeID: 101, controlled: true, targetID: null, activity: "idle",
              name: null, shieldRatio: 1, armorRatio: 1, hullRatio: 1 });
          }
          break;
        case "mineDrones": out = out.map(d => ({ ...d, activity: "mining", targetID: a.targetID })); break;
        case "recallDrones": out = out.map(d => ({ ...d, activity: "returning" })); recallReads = 3; break;
        case "activate":
        case "deactivate": world = { ...world, snapshot: { ...world.snapshot!, ship: { ...world.snapshot!.ship!,
          activeModuleIDs: a.kind === "activate" ? [a.moduleID] : [] } } }; break;
        case "lock": world = { ...world, lockedTargetIDs: [a.targetID] }; break;
        case "unlock": world = { ...world, lockedTargetIDs: [] }; break;
        case "startRoute":
          assert.equal(out.length, 0, "Self-Unload travels only after drone settlement");
          assert.equal(world.snapshot!.ship!.activeModuleIDs?.length, 0, "mining modules settled before travel");
          world = { ...world, inSpace: false, docked: true, flightStatus: flight({ inSpace: false, docked: true, stationID: a.stationID }) }; break;
        case "unloadOre": world = { ...world, holds: oreHold([]), oreHoldFraction: 0, holdEmpty: true }; break;
        case "undock": world = { ...world, inSpace: true, docked: false, flightStatus: flight() }; break;
        case "miningMemberReady": world = { ...world, miningOperation: { ...world.miningOperation!, rendezvous: { ...world.miningOperation!.rendezvous!, thisMemberReady: true } } }; break;
        case "jettison":
          assert.equal(out.length, 0, "ore cannot be refilled by a flight while confirming the empty hold");
          world = { ...world, holds: oreHold([]), oreHoldFraction: 0, holdEmpty: true }; break;
        case "depleteMiningTarget":
          // The BFF updates the operation board synchronously; reproduce its
          // authoritative next-observation result in this runner harness.
          world = { ...world, miningOperation: { ...world.miningOperation!, state: "DRAINING",
            currentTarget: { ...world.miningOperation!.currentTarget!, state: "DEPLETED" },
            rendezvous: { kind: "MINER_CLEARANCE", required: [1], ready: [1], thisMemberReady: true } } }; break;
      }
    },
    registry: SCRIPT_MACROS,
    travelHome: () => { throw new Error("Unexpected home travel in healthy belt cycle"); },
    sleep: async () => {}, onProgress: () => {}, isSessionLost: () => false, refusalReason: String,
    log: { write: draft => logs.push(draft) },
  });
  runner.start(decoded.doc);
  const count = (kind: ScriptAction["kind"]) => actions.filter(a => a.kind === kind).length;
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 150 && !predicate(); i++) {
      await runner.tick();
      assert.equal(runner.getStatus(), "running", JSON.stringify(logs.slice(-4)));
    }
    assert.ok(predicate(), JSON.stringify(logs.slice(-8)));
  }
  return { runner, actions, logs, count, until, droneState,
    get world() { return world; },
    setWorld(over: Partial<ScriptObservation>) { world = { ...world, ...over }; },
    setDroneReadUnavailable(value: boolean) { droneReadUnavailable = value; },
    working: () => (world.snapshot!.ship!.activeModuleIDs ?? []).includes(71) && out.length === (family === "ICE" ? 0 : 5) && out.every(d => d.activity === "mining"),
    returnFlight: () => { out = []; },
  };
}

test("standard BELT profile keeps relaunching the authoritative singleton flight through 40 full jettison cycles", async () => {
  const h = standardMinerHarness();
  await h.until(h.working);
  for (let cycle = 1; cycle <= 40; cycle++) {
    h.setWorld({ oreHoldFraction: 0.91, holdEmpty: false, holds: oreHold([800 + cycle]) });
    await h.until(() => h.count("jettison") === cycle);
    await h.until(h.working);
    assert.equal(h.count("launchDrones"), cycle + 1);
    assert.equal(h.count("recallDrones"), cycle);
    assert.equal(h.world.miningOperation?.currentTarget?.targetKey, target().targetKey);
  }
  // Farmer's shared Batch 6 controller owns flight diagnostics. The actual
  // action sequence, including authoritative return, is the contract here.
  // Settle the last issued activation, then steady observations must not add
  // repeated flight diagnostics (nor a second launch/recall).
  for (let i = 0; i < 10; i++) await h.runner.tick();
  const before = h.actions.length;
  for (let i = 0; i < 30; i++) await h.runner.tick();
  assert.equal(h.actions.length, before);
  assert.equal(h.count("launchDrones"), 41);
});

test("legacy drone toggle cannot disable the shared capability-based controller", async () => {
  const h = standardMinerHarness(false);
  await h.until(h.working);
  assert.equal(h.count("launchDrones"), 1);
});

test("a successful recall command plus an unreadable return never authorizes jettison or a second flight", async () => {
  const h = standardMinerHarness();
  await h.until(h.working);
  h.setWorld({ oreHoldFraction: 0.91, holds: oreHold([801]), holdEmpty: false });
  await h.until(() => h.count("recallDrones") === 1);
  h.setDroneReadUnavailable(true);
  for (let i = 0; i < 20; i++) await h.runner.tick();
  assert.equal(h.count("jettison"), 0);
  assert.equal(h.count("launchDrones"), 1);
  assert.ok(!h.logs.some(l => l.why?.startsWith("Recall confirmed:")));
  h.setDroneReadUnavailable(false);
  await h.until(() => h.count("jettison") === 1);
  await h.until(h.working);
  assert.equal(h.count("launchDrones"), 2);
});

test("target loss immediately after jettison cannot relaunch onto the old operation target or choose a standalone belt", async () => {
  for (const missing of [true, false]) {
    const h = standardMinerHarness();
    await h.until(h.working);
    h.setWorld({ oreHoldFraction: 0.91, holds: oreHold([801]), holdEmpty: false });
    await h.until(() => h.count("jettison") === 1);
    h.setWorld({ miningOperation: missing ? null : assignment({ currentTarget: null }) });
    const offset = h.actions.length;
    for (let i = 0; i < 30; i++) await h.runner.tick();
    assert.ok(h.actions.slice(offset).every(a => a.kind === "reserveMiningTarget"), JSON.stringify(h.actions.slice(offset)));
    assert.equal(h.count("launchDrones"), 1);
    assert.ok(h.logs.some(l => l.phase === "Target authority unavailable" || l.phase === "Waiting for operation target"));
  }
});

test("depletion still recalls and confirms the flight before the partial dump and relocation handoff", async () => {
  const h = standardMinerHarness();
  await h.until(h.working);
  h.setWorld({ snapshot: snapshot([entity(1, "Asteroid Belt 1")]), holds: oreHold([801]), oreHoldFraction: 0.27, holdEmpty: false });
  await h.until(() => h.count("depleteMiningTarget") === 1);
  assert.equal(h.count("recallDrones"), 1);
  assert.equal(h.count("jettison"), 1);
  assert.equal(h.count("launchDrones"), 1);
  assert.ok(h.actions.findIndex(a => a.kind === "recallDrones") < h.actions.findIndex(a => a.kind === "jettison"));
  h.setWorld({ miningOperation: assignment({ currentTarget: target({ targetName: "Asteroid Belt 2", state: "RESERVED" }) }),
    snapshot: snapshot([entity(1, "Asteroid Belt 1"), entity(2, "Asteroid Belt 2", 300_000)]) });
  await h.until(() => h.count("warp") === 1);
  assert.equal(h.count("launchDrones"), 1);
});

test("shared depletion and ready-to-relocate do not relaunch against a locally cached rock", async () => {
  const h = standardMinerHarness();
  await h.until(h.working);
  // Another member reported depletion; this pilot still sees an old rock row.
  h.setWorld({ miningOperation: assignment({ currentTarget: target({ state: "DEPLETED" }) }),
    holds: oreHold([801]), oreHoldFraction: 0.27, holdEmpty: false });
  await h.until(() => h.count("depleteMiningTarget") === 1);
  h.setWorld({ miningOperation: assignment({ currentTarget: target({ state: "DEPLETED" }),
    rendezvous: { kind: "MINER_CLEARANCE", required: [1, 2], ready: [1], thisMemberReady: true } }) });
  for (let i = 0; i < 20; i++) await h.runner.tick();
  assert.equal(h.count("recallDrones"), 1);
  assert.equal(h.count("launchDrones"), 1);
});

test("operation relocation recalls an active flight before warping even though the mining step has not changed", async () => {
  const h = standardMinerHarness();
  await h.until(h.working);
  h.setWorld({ miningOperation: assignment({ currentTarget: target({ targetName: "Asteroid Belt 2", state: "RESERVED" }) }),
    snapshot: snapshot([entity(1, "Asteroid Belt 1"), entity(2, "Asteroid Belt 2", 300_000)]) });
  await h.until(() => h.count("warp") === 1);
  assert.equal(h.count("recallDrones"), 1);
  assert.equal(h.droneState().out.length, 0);
  assert.equal(h.count("launchDrones"), 1);
});

test("operation miner reserves one deterministic eligible belt when no target exists", () => {
  const mine = SCRIPT_MACROS["mine-at-belt"];
  const world = observation({
    miningOperation: assignment({ currentTarget: null }),
    snapshot: snapshot([entity(2, "Asteroid Belt 2"), entity(1, "Asteroid Belt 1")]),
  });
  const tick = mine(beltStep, world, {}, {});
  assert.equal(tick.action.kind, "reserveMiningTarget");
  assert.ok(tick.action.kind === "reserveMiningTarget" && tick.action.targetName === "Asteroid Belt 1");
});

test("MCC standard miner and hauler resource steps obey currentTarget, not nearest standalone belt", () => {
  const def = { area: { targetClasses: ["BELT"] }, unloadPolicy: "HAULER_SERVICE",
    unloadDestination: { stationID: 60000004, stationName: "Home", systemName: "Jita", corporationDivision: 1 } };
  const minerBody = buildStandardProfile(def, { role: "MINER", routineMode: "STANDARD" }).doc.program[0].body;
  const haulerBody = buildStandardProfile(def, { role: "HAULER", routineMode: "STANDARD" }).doc.program[0].body;
  const assigned = target({ targetKey: "BELT:30000142:Asteroid Belt 2", targetName: "Asteroid Belt 2" });
  const world = observation({ miningOperation: assignment({ currentTarget: assigned }),
    snapshot: snapshot([entity(1, "Asteroid Belt 1", 100_000), entity(2, "Asteroid Belt 2", 200_000)]) });
  const mine = SCRIPT_MACROS["mine-at-belt"](minerBody[1] as MacroStep, world, {}, {});
  assert.equal(mine.action.kind, "warp");
  assert.equal(mine.action.kind === "warp" ? mine.action.targetID : null, 2);
  const inSpaceUndock = SCRIPT_MACROS["undock"](haulerBody[0].else[0] as MacroStep,
    { ...world, miningOperation: assignment({ role: "HAULER", currentTarget: assigned }) }, {}, {});
  assert.equal(inSpaceUndock.outcome.kind, "done", "a hauler already in space can enter the standard profile");
  const travel = SCRIPT_MACROS["travel-to-belt"](haulerBody[0].else[1] as MacroStep,
    { ...world, miningOperation: assignment({ role: "HAULER", currentTarget: assigned }) }, {}, {});
  assert.equal(travel.action.kind === "warp" ? travel.action.targetID : null, 2);
});

test("HAULER_SERVICE depletion forces a below-threshold partial dump before relocation", () => {
  const mine = SCRIPT_MACROS["mine-at-belt"];
  const world = observation({ snapshot: snapshot([entity(1, "Asteroid Belt 1")]), holds: oreHold([81, 82]) });
  let memory = {};
  let tick = mine(beltStep, world, memory, {});
  memory = tick.nextMem;
  tick = mine(beltStep, world, memory, {});
  memory = tick.nextMem;
  tick = mine(beltStep, world, memory, {});
  assert.equal(tick.action.kind, "jettison");
  assert.deepEqual(tick.action.kind === "jettison" ? tick.action.itemIDs : [], [81, 82]);
});

test("SELF_UNLOAD depletion never jettisons and hands off to the saved delivery path", () => {
  const mine = SCRIPT_MACROS["mine-at-belt"];
  const self = assignment({ unloadPolicy: "SELF_UNLOAD" });
  const world = observation({ miningOperation: self, snapshot: snapshot([entity(1, "Asteroid Belt 1")]), holds: oreHold([81]) });
  let memory = {};
  let tick = mine(beltStep, world, memory, {});
  memory = tick.nextMem;
  tick = mine(beltStep, world, memory, {});
  memory = tick.nextMem;
  tick = mine(beltStep, world, memory, {});
  assert.equal(tick.action.kind, "depleteMiningTarget");
  assert.notEqual(tick.action.kind, "jettison");
});

test("SELF_UNLOAD delivery reports rendezvous readiness only after the hold is empty", () => {
  const deliver = SCRIPT_MACROS["deliver-ore"];
  const self = assignment({
    unloadPolicy: "SELF_UNLOAD",
    currentTarget: target({ state: "DEPLETED", claimedByOperationID: null }),
    rendezvous: { kind: "SELF_UNLOAD", required: [1, 2], ready: [], thisMemberReady: false },
  });
  const docked = observation({
    inSpace: false, docked: true, flightStatus: flight({ inSpace: false, docked: true, stationID: 60000004 }),
    miningOperation: self, holds: [],
  });
  assert.equal(deliver(deliverStep, docked, {}, {}).action.kind, "miningMemberReady");
  assert.equal(deliver(deliverStep, { ...docked, holds: oreHold([9]) }, {}, {}).action.kind, "unloadOre");
});

test("operation hauler services the logistics tail before the new current target", () => {
  const travel = SCRIPT_MACROS["travel-to-belt"];
  const old = target({ targetKey: "BELT:30000142:Old Belt", targetName: "Old Belt", state: "DRAINING" });
  const current = target({ targetKey: "BELT:30000142:New Belt", targetName: "New Belt", state: "ACTIVE" });
  const hauler = assignment({ role: "HAULER", currentTarget: current, logisticsTarget: old });
  const tick = travel(travelStep, observation({
    miningOperation: hauler,
    snapshot: snapshot([entity(1, "Old Belt", 500_000), entity(2, "New Belt", 300_000)]),
  }), {}, {});
  assert.ok(tick.action.kind === "warp" && tick.action.targetID === 1);
});

test("hauler completes its drain only after the old grid and freight are both empty", () => {
  const loot = SCRIPT_MACROS["loot-containers"];
  const deliver = SCRIPT_MACROS["deliver-ore"];
  const hauler = assignment({ role: "HAULER", logisticsTarget: target({ state: "DRAINING" }) });
  const clearGrid = loot(lootStep, observation({ miningOperation: hauler,
    holds: oreHold([9]), snapshot: snapshot([entity(1, "Asteroid Belt 1")]) }), { emptyChecks: 30 }, {});
  assert.equal(clearGrid.outcome.kind, "done");
  assert.equal(clearGrid.boardPatch?.miningDrainGridClear, hauler.logisticsTarget?.targetKey);
  const docked = observation({
    inSpace: false, docked: true, flightStatus: flight({ inSpace: false, docked: true, stationID: 60000004 }),
    miningOperation: hauler, holds: [],
  });
  assert.equal(deliver(deliverStep, docked, {}, clearGrid.boardPatch ?? {}).action.kind, "miningDrainComplete");
});

test("a full hauler unload does not close its logistics tail before grid-clear proof", () => {
  const deliver = SCRIPT_MACROS["deliver-ore"];
  const hauler = assignment({ role: "HAULER", logisticsTarget: target({ state: "DRAINING" }) });
  const docked = observation({
    inSpace: false, docked: true, flightStatus: flight({ inSpace: false, docked: true, stationID: 60000004 }),
    miningOperation: hauler, holds: [],
  });
  assert.notEqual(deliver(deliverStep, docked, {}, {}).action.kind, "miningDrainComplete");
});

for (const family of ["BELT", "ORE_ANOMALY", "ICE"] as const) for (const fraction of [0.72, 0.01, 0]) {
  test(`${family} real Standard hauler: clear tail at ${fraction * 100}% delivers once or completes empty, then follows latest target`, () => {
    const profile = buildStandardProfile({ area: { targetClasses: [family] }, unloadPolicy: "HAULER_SERVICE",
      unloadDestination: { stationID: 60000004, stationName: "Home", systemName: "Jita", corporationDivision: 1 },
    }, { role: "HAULER", routineMode: "STANDARD" });
    const decoded = decodeScriptValue(profile.doc);
    assert.ok(decoded.ok);
    const site = family === "BELT" ? {} : siteWorld(family);
    const old = { ...(site.miningOperation?.currentTarget ?? target()), state: "DRAINING" as const };
    const next = { ...old, targetKey: "next", targetName: "Asteroid Belt 2", state: "ACTIVE" as const };
    let world = observation({ ...site, miningSiteBookmarks: { [old.targetKey]: 55 }, oreHoldFraction: fraction, holdEmpty: fraction === 0,
      holds: oreHold(fraction ? [9] : []),
      snapshot: snapshot(family === "BELT" ? [entity(1, old.targetName)] : []),
      miningOperation: assignment({ role: "HAULER", currentTarget: next, logisticsTarget: old,
        area: { anchorSystemID: 30000142, anchorSystemName: "Jita", reach: "CURRENT_SYSTEM", targetClasses: [family] } }),
    });
    let memory = initialMemory(decoded.doc);
    let routes = 0, unloads = 0, completions = 0, reads = 0;
    for (let i = 0; i < 150 && !completions; i++) {
      const result = decideScriptAction(decoded.doc, world, memory, SCRIPT_MACROS, () => { throw new Error("Unexpected safety return"); });
      memory = result.memory;
      assert.equal(result.status, "running");
      reads++;
      if (result.action.kind === "startRoute") {
        routes++;
        assert.ok(reads > 30, "bounded grid-clear confirmation precedes partial delivery");
        assert.equal(result.action.stationID, 60000004);
        // Fleet moved again while this hauler was delivering. No cached next target.
        world = { ...world, inSpace: false, docked: true,
          flightStatus: flight({ inSpace: false, docked: true, stationID: 60000004 }),
          miningOperation: { ...world.miningOperation!, currentTarget: { ...next, targetKey: "latest", targetName: "Asteroid Belt 3" } } };
      } else if (result.action.kind === "unloadOre") {
        unloads++;
        assert.deepEqual(result.action.itemIDs, [9]);
        assert.equal(result.action.division, 1);
        // A successful dispatch alone cannot complete: keep freight for another observation.
        if (unloads === 2) world = { ...world, holds: oreHold([]), holdEmpty: true, oreHoldFraction: 0 };
      } else if (result.action.kind === "miningDrainComplete") {
        completions++;
        assert.equal(result.action.targetKey, old.targetKey);
        assert.deepEqual(world.holds, oreHold([]));
        world = { ...world, miningOperation: { ...world.miningOperation!, logisticsTarget: null } };
      } else {
        assert.equal(result.action.kind, "wait", "must not warp to the new target before finishing the tail");
      }
    }
    assert.equal(completions, 1);
    assert.equal(routes, fraction ? 1 : 0);
    assert.equal(unloads, fraction ? 2 : 0);
    assert.equal(world.miningOperation?.currentTarget?.targetKey, fraction ? "latest" : "next");
    if (family === "BELT") {
      // Remain physically on the old belt after completion. The real program
      // must leave its old loot invocation and re-read the current assignment.
      world = { ...world,
        snapshot: snapshot([entity(1, old.targetName), entity(3, world.miningOperation!.currentTarget!.targetName, 500_000)]) };
      let caughtUp = false;
      for (let i = 0; i < 30 && !caughtUp; i++) {
        const r = decideScriptAction(decoded.doc, world, memory, SCRIPT_MACROS, () => { throw new Error("Unexpected safety return"); });
        memory = r.memory;
        if (r.action.kind === "warp") { assert.equal(r.action.targetID, 3); caughtUp = true; }
        else if (r.action.kind === "undock") world = { ...world, inSpace: true, docked: false, flightStatus: flight() };
        else assert.equal(r.action.kind, "wait");
      }
      assert.ok(caughtUp, "empty or delivered hauler catches up without stale loot-step deadlock");
    }
  });
}

test("tail clear requires readable freight, no pending miner dumps, and 31 empty reads", () => {
  const tail = target({ state: "DRAINING" });
  const world = observation({ holds: oreHold([]), snapshot: snapshot([entity(1, tail.targetName)]),
    miningOperation: assignment({ role: "HAULER", logisticsTarget: tail }) });
  const loot = SCRIPT_MACROS["loot-containers"];
  assert.equal(loot(lootStep, world, { emptyChecks: 29 }, {}).action.kind, "wait");
  assert.equal(loot(lootStep, world, { emptyChecks: 30 }, {}).action.kind, "miningDrainComplete");
  for (const holds of [null, [{ ...oreHold([])[0]!, items: null, error: "READ_FAILED" }]]) {
    assert.equal(loot(lootStep, { ...world, holds }, { emptyChecks: 30 }, {}).action.kind, "wait");
    const docked = { ...world, holds, flightStatus: flight({ docked: true, stationID: 60000004 }) };
    assert.equal(SCRIPT_MACROS["deliver-ore"](deliverStep, docked, {}, { miningDrainGridClear: tail.targetKey }).action.kind, "wait");
  }
  assert.equal(loot(lootStep, { ...world, miningOperation: { ...world.miningOperation!,
    rendezvous: { kind: "MINER_CLEARANCE", required: [1], ready: [], thisMemberReady: false } } }, { emptyChecks: 31 }, {}).action.kind, "wait");
});

for (const family of ["BELT", "ORE_ANOMALY", "ICE"] as const) test(`${family} Standard Self-Unload settles, delivers and resumes; depletion waits docked for rendezvous`, async () => {
  const h = standardMinerHarness(true, family, true);
  const key = h.world.miningOperation!.currentTarget!.targetKey;
  await h.until(h.working);
  h.setWorld({ holds: oreHold([901]), holdEmpty: false, oreHoldFraction: 0.91 });
  await h.until(() => h.count("unloadOre") === 1);
  await h.until(h.working);
  assert.equal(h.world.miningOperation!.currentTarget!.targetKey, key);
  assert.equal(h.count("jettison"), 0);
  const target = h.world.miningOperation!.currentTarget!;
  h.setWorld({ holds: oreHold([902]), holdEmpty: false, oreHoldFraction: 0.17,
    miningOperation: { ...h.world.miningOperation!, currentTarget: { ...target, state: "DEPLETED" },
      rendezvous: { kind: "SELF_UNLOAD", required: [1, 2], ready: [], thisMemberReady: false } } });
  await h.until(() => h.count("miningMemberReady") === 1);
  const trips = h.count("startRoute"), undocks = h.count("undock");
  for (let i = 0; i < 10; i++) await h.runner.tick();
  assert.equal(h.count("undock"), undocks, "ready miner waits for peers at delivery station");
  assert.equal(h.count("startRoute"), trips);
  assert.equal(h.count("jettison"), 0);
  assert.equal(h.count("unloadOre"), 2);
  if (family === "ICE") assert.equal(h.count("launchDrones"), 0);
  h.setWorld({ miningOperation: { ...h.world.miningOperation!, currentTarget: { ...target, targetKey: `${key}:next` }, rendezvous: null } });
  await h.until(h.working);
  assert.equal(h.world.miningOperation!.currentTarget!.targetType, family);
});

test("nonclear tail keeps looting below threshold; full trip returns to OLD target; ACTIVE 90% unchanged", () => {
  const tail = target({ state: "DRAINING" });
  const op = assignment({ role: "HAULER", logisticsTarget: tail,
    currentTarget: target({ targetKey: "new", targetName: "Asteroid Belt 2" }) });
  const can = { ...entity(50, "Jetcan", 100), kind: "container" as const, ownerID: 900005 };
  const world = observation({ miningOperation: op, oreHoldFraction: 0.72, holds: oreHold([9]),
    snapshot: snapshot([entity(1, tail.targetName), can]) });
  const loot = SCRIPT_MACROS["loot-containers"](lootStep, world, { emptyChecks: 31 }, {});
  assert.equal(loot.action.kind, "lootContainer");
  assert.equal(loot.boardPatch?.miningDrainGridClear, "");
  const contested = SCRIPT_MACROS["loot-containers"](lootStep, { ...world, claimedContainerIDs: [50] }, { emptyChecks: 31 }, {});
  assert.equal(contested.action.kind, "wait");
  assert.equal(contested.nextMem.emptyChecks, 0);
  assert.equal(contested.boardPatch?.miningDrainGridClear, "", "another hauler's leased can is not clear-grid evidence");
  const profile = buildStandardProfile({ area: { targetClasses: ["BELT"] }, unloadPolicy: "HAULER_SERVICE",
    unloadDestination: { stationID: 60000004, stationName: "Home", systemName: "Jita", corporationDivision: 1 },
  }, { role: "HAULER", routineMode: "STANDARD" });
  const decoded = decodeScriptValue(profile.doc); assert.ok(decoded.ok);
  for (const draining of [false, true]) for (const fraction of [0.72, 0.9]) {
    const current = { ...world, oreHoldFraction: fraction, miningOperation: draining ? op : { ...op, currentTarget: target(), logisticsTarget: null } };
    const memory = { ...initialMemory(decoded.doc), board: { miningDrainGridClear: draining ? "obsolete-tail" : tail.targetKey } };
    const r = decideScriptAction(decoded.doc, current, memory, SCRIPT_MACROS, () => { throw new Error("Unexpected safety return"); });
    assert.equal(r.action.kind, fraction >= 0.9 ? "startRoute" : "lootContainer");
  }
  const delivered = SCRIPT_MACROS["deliver-ore"](deliverStep, { ...world, holds: oreHold([]),
    flightStatus: flight({ docked: true, stationID: 60000004 }) }, {}, {});
  assert.equal(delivered.outcome.kind, "done");
  const back = SCRIPT_MACROS["travel-to-belt"](travelStep, { ...world,
    snapshot: snapshot([entity(1, tail.targetName, 500_000), entity(2, "Asteroid Belt 2", 300_000)]) }, {}, {});
  assert.deepEqual(back.action, { kind: "warp", targetID: 1 });
});

test("operation hauler collects only a proven miner-owned can", () => {
  const hauler = assignment({ role: "HAULER", ownedContainerIDs: [50], miningOwnerIDs: [900005] });
  const own = { ...entity(50, "Our can", 100), kind: "container" as const, ownerID: 900005 };
  const other = { ...entity(51, "Other pilot's can", 50), kind: "container" as const, ownerID: 140000099 };
  const world = observation({ miningOperation: hauler, snapshot: snapshot([entity(1, "Asteroid Belt 1"), own, other]) });
  const loot = SCRIPT_MACROS["loot-containers"];
  assert.equal(loot(lootStep, world, {}, {}).action.kind, "lootContainer", JSON.stringify(loot(lootStep, world, {}, {})));
  assert.equal((loot(lootStep, world, {}, {}).action as { containerID?: number }).containerID, 50);
  const unknown = loot(lootStep, { ...world, miningOperation: { ...hauler, containerProvenanceUnconfirmed: true } }, {}, {});
  assert.equal(unknown.outcome.kind, "blocked");
  const changedOwner = loot(lootStep, { ...world, snapshot: snapshot([entity(1, "Asteroid Belt 1"), { ...own, ownerID: 140000099 }]) }, {}, {});
  assert.equal(changedOwner.outcome.kind, "blocked");
  const unregistered = loot(lootStep, { ...world, miningOperation: { ...hauler, ownedContainerIDs: [] } }, {}, {});
  assert.notEqual(unregistered.action.kind, "lootContainer");
});

test("final delivery preserves unrelated cargo and cannot complete while transfer is refused", () => {
  const tail = target({ state: "DRAINING" });
  const cargo = { ...oreHold([])[0]!, key: "cargo", items: [{ itemID: 33, typeID: 1, categoryID: 8, groupID: 1, quantity: 100 }] };
  const world = observation({ holds: [...oreHold([9]), cargo], miningOperation: assignment({ role: "HAULER", logisticsTarget: tail }),
    flightStatus: flight({ docked: true, stationID: 60000004 }) });
  const board = { miningDrainGridClear: tail.targetKey };
  for (let i = 0; i < 5; i++) {
    const r = SCRIPT_MACROS["deliver-ore"](deliverStep, world, {}, board);
    assert.equal(r.action.kind, "unloadOre");
    if (r.action.kind === "unloadOre") assert.deepEqual(r.action.itemIDs, [9]);
  }
  assert.equal(SCRIPT_MACROS["deliver-ore"](deliverStep, { ...world, holds: [...oreHold([]), cargo] }, {}, board).action.kind, "miningDrainComplete");
  assert.notEqual(SCRIPT_MACROS["deliver-ore"](deliverStep, { ...world, holds: oreHold([]), miningOperation: { ...world.miningOperation!, logisticsTarget: null } }, {}, board).action.kind, "miningDrainComplete");
});

test("operation ore-site selection excludes ice archetype and never invents remote scanner rows", () => {
  const warp = SCRIPT_MACROS["warp-to-ore-anomaly"];
  const op = assignment({
    unloadPolicy: "SELF_UNLOAD", currentTarget: null,
    area: { anchorSystemID: 30000142, anchorSystemName: "Jita", reach: "CURRENT_AND_ADJACENT", targetClasses: ["ORE_ANOMALY", "ICE"] },
  });
  const tick = warp(siteWarpStep, observation({
    miningOperation: op,
    anomalies: [
      { label: "ICE-100", kind: "ore", archetypeID: 28, siteID: 100, position: { x: 0, y: 0, z: 0 } },
      { label: "ORE-200", kind: "ore", archetypeID: 27, siteID: 200, position: { x: 0, y: 0, z: 0 } },
    ],
  }), {}, {});
  assert.ok(tick.action.kind === "reserveMiningTarget" && tick.action.targetName === "ORE-200");
  assert.equal(tick.action.kind === "reserveMiningTarget" ? tick.action.systemID : 0, 30000142);
});

function siteWorld(family: "ORE_ANOMALY" | "ICE"): Partial<ScriptObservation> {
  const site = { label: "SITE-100", kind: "ore" as const, archetypeID: family === "ICE" ? 28 : 27,
    siteID: 100, instanceID: 101, position: { x: 0, y: 0, z: 0 } };
  const current = target({ targetType: family, targetKey: `${family}:30000142:site:100:instance:101`, targetName: site.label,
    siteID: 100, instanceID: 101, siteIdentity: "site:100:instance:101", position: site.position });
  return { anomalies: [site], iceMiningModuleIDs: family === "ICE" ? [71] : [], oreMiningModuleIDs: family === "ORE_ANOMALY" ? [71] : [], miningModuleIDs: [71],
    miningOperation: assignment({ currentTarget: current, area: { anchorSystemID: 30000142, anchorSystemName: "Jita", reach: "CURRENT_SYSTEM", targetClasses: [family] } }) };
}
function siteStep(family: "ORE_ANOMALY" | "ICE", travel = false): MacroStep {
  return { id: travel ? "travel" : "mine", kind: "macro", macro: travel ? "travel-to-belt" : "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: family === "ICE" ? "ice-site" : "site" } } } };
}

for (const family of ["BELT", "ORE_ANOMALY", "ICE"] as const) for (const role of ["MINER", "HAULER"] as const) for (const ending of ["interaction", "claim-loss", "stop", "pause"]) {
  test(`${family} ${role}: shared runner assists movement, then settles on ${ending}`, async () => {
    const step = role === "HAULER" ? lootStep : family === "BELT" ? beltStep : siteStep(family);
    const profile = buildStandardProfile({ area: { targetClasses: [family] }, unloadPolicy: "HAULER_SERVICE",
      unloadDestination: { stationID: 60000004, stationName: "Home", systemName: "Jita", corporationDivision: 1 } }, { role });
    const decoded = decodeScriptValue({ ...profile.doc, program: [role === "MINER" ? { ...step, until: { kind: "ore-hold-at-least", fraction: 0.9 } } : step] }); assert.ok(decoded.ok);
    let x = 60_000, propOn = false, claimLost = false;
    const changes: boolean[] = [], actions: ScriptAction[] = [];
    const base = observation(family === "BELT" ? {} : siteWorld(family));
    const op = { ...base.miningOperation!, role, travelAssist: "AUTO" as const };
    const runner = createScriptRunner({
      observe: async () => {
        const resource = { ...entity(501, "Resource", x), kind: role === "HAULER" ? "container" : "asteroid", ownerID: role === "HAULER" ? 900005 : null, miningYieldTypeID: role === "MINER" ? 1230 : null,
          miningResourceFamily: family === "ICE" ? "ice" as const : "ore" as const, remainingQuantity: 100 };
        const scene = snapshot([entity(1, "Asteroid Belt 1"), resource]);
        return { ...base, miningOperationRequired: true, miningOperation: claimLost ? null : op, miningModuleIDs: [71], lockedTargetIDs: [501],
          snapshot: { ...scene, ship: { ...scene.ship!, mode: "follow", activeModuleIDs: propOn ? [91] : [] } },
          travelPropulsionModules: [{ itemID: 91, typeID: 439, kind: "afterburner" }] };
      },
      travelAssist: { change: async (_module, on) => { propOn = on; changes.push(on); return true; } },
      claims: { read: async () => [], acquire: async () => true, release: async () => {} },
      issue: async action => { actions.push(action); }, sleep: async () => {}, onProgress: () => {},
      isSessionLost: () => false, refusalReason: String, registry: SCRIPT_MACROS, travelHome: () => {
        assert.ok(claimLost, "healthy approach must not ask for a safety return");
        assert.equal(propOn, false, "claim-loss shutdown precedes even macro safety-return evaluation");
        return { action: { kind: "wait" }, why: "Safety return waiting", phase: "Waiting", armed: false, outcome: { kind: "acting" }, nextMem: {} };
      },
    });
    runner.start(decoded.doc);
    for (let i = 0; i < 4; i++) await runner.tick();
    assert.equal(changes[0], true);
    assert.ok(actions.some(a => a.kind === (role === "MINER" ? "orbit" : "approach")));
    const beforeEnd = actions.length;
    if (ending === "stop") await runner.beginGracefulStop();
    else if (ending === "pause") { runner.pause(); await Promise.resolve(); await Promise.resolve(); }
    else {
      if (ending === "interaction") x = 1_000;
      else claimLost = true;
      for (let i = 0; i < 5; i++) await runner.tick();
    }
    assert.deepEqual(changes, [true, false], JSON.stringify({ snapshot: runner.snapshot(), actions }));
    if (ending === "interaction") assert.ok(actions.some(a => a.kind === (role === "MINER" ? "activate" : "lootContainer")));
    else assert.ok(actions.slice(beforeEnd).every(a => ["wait", "deactivate", "recallDrones"].includes(a.kind)), "no stale work after claim loss/Stop");
    await runner.beginGracefulStop(); assert.equal(propOn, false); await runner.stop();
  });
}

for (const family of ["ORE_ANOMALY", "ICE"] as const) {
  test(`${family}: depletion is not clearance until modules settle and freight is readable/empty`, () => {
    const mine = SCRIPT_MACROS["mine-at-belt"];
    const step = siteStep(family);
    const world = observation({ ...siteWorld(family), snapshot: snapshot([]), holds: null });
    let memory = {};
    let result = mine(step, world, memory, {});
    for (let i = 1; i < 3; i++) { memory = result.nextMem; result = mine(step, world, memory, {}); }
    assert.equal(result.action.kind, "depleteMiningTarget");
    assert.ok(result.action.kind === "depleteMiningTarget" && result.action.evidence.partialDumpConfirmed !== true);
    const draining = { ...world, miningOperation: { ...world.miningOperation!, currentTarget: { ...world.miningOperation!.currentTarget!, state: "DRAINING" as const } } };
    result = mine(step, { ...draining, snapshot: { ...world.snapshot!, ship: { ...world.snapshot!.ship!, activeModuleIDs: [71] } } }, {}, {});
    assert.deepEqual(result.action, { kind: "deactivate", moduleID: 71 });
    assert.ok(result.settleDrones);
    result = mine(step, { ...draining, holds: oreHold([]), snapshot: { ...world.snapshot!, ship: { ...world.snapshot!.ship!, activeModuleIDs: null } } }, {}, {});
    assert.equal(result.action.kind, "wait", "unknown module state is not confirmed settlement");
    result = mine(step, draining, {}, {});
    assert.equal(result.action.kind, "wait", "unknown holds are not confirmed empty");
    result = mine(step, { ...draining, holds: oreHold([901]) }, {}, {});
    assert.deepEqual(result.action, { kind: "jettison", itemIDs: [901] });
    result = mine(step, { ...draining, holds: oreHold([]) }, {}, {});
    assert.ok(result.action.kind === "depleteMiningTarget" && result.action.evidence.partialDumpConfirmed === true);
  });

  test(`${family} standard profile repeats mine/jettison/resume without independent selection`, async () => {
    const h = standardMinerHarness(true, family);
    await h.until(h.working);
    for (let cycle = 1; cycle <= 4; cycle++) {
      h.setWorld({ oreHoldFraction: 0.91, holds: oreHold([800 + cycle]), holdEmpty: false });
      await h.until(() => h.count("jettison") === cycle);
      await h.until(h.working);
    }
    assert.equal(h.count("warp"), 0);
    assert.equal(h.count("reserveMiningTarget"), 0);
    assert.equal(h.count("launchDrones"), family === "ICE" ? 0 : 5);
    h.setWorld({ miningOperation: null });
    const offset = h.actions.length;
    for (let i = 0; i < 8; i++) await h.runner.tick();
    assert.ok(h.actions.slice(offset).every(a => ["wait", "deactivate", "recallDrones"].includes(a.kind)), "claim loss must gate stale work");
  });

  test(`${family}: exact site travel, repeated disappearance, same-family no-target wait and logistics bookmark`, () => {
    const world = observation(siteWorld(family));
    const step = siteStep(family);
    const mine = SCRIPT_MACROS["mine-at-belt"];
    const distant = { ...world.miningOperation!.currentTarget!, position: { x: 1e9, y: 0, z: 0 } };
    let action = mine(step, { ...world, miningOperation: { ...world.miningOperation!, currentTarget: distant } }, {}, {});
    assert.equal(action.action.kind, "warpScan");
    assert.ok(action.settleDrones);
    let mem = {};
    for (let i = 0; i < 3; i++) {
      action = mine(step, { ...world, anomalies: [] }, mem, {}); mem = action.nextMem;
      assert.equal(action.action.kind, i === 2 ? "depleteMiningTarget" : "wait");
    }
    action = mine(step, { ...world, anomalies: null }, mem, {});
    assert.equal(action.action.kind, "wait", "failed scan is not confirmed disappearance");
    action = mine(step, { ...world, anomalies: [], miningOperation: { ...world.miningOperation!, currentTarget: null } }, {}, {});
    assert.equal(action.action.kind, "wait"); assert.equal(action.phase, "Waiting for target");
    const hauler = { ...world, miningOperation: { ...world.miningOperation!, role: "HAULER" as const } };
    const travel = SCRIPT_MACROS["travel-to-belt"];
    action = travel(siteStep(family, true), hauler, {}, {});
    assert.equal(action.action.kind, "bookmarkMiningSite", "in-space starts prepare a return point before looting");
    action = travel(siteStep(family, true), { ...hauler, anomalies: [], miningSiteBookmarks: { [distant.targetKey]: 990 },
      miningOperation: { ...hauler.miningOperation!, currentTarget: target(), logisticsTarget: { ...distant, state: "DRAINING" } } }, {}, {});
    assert.deepEqual(action.action, { kind: "warpBookmark", bookmarkID: 990 });
    const atTail = { ...hauler, miningSiteBookmarks: { [distant.targetKey]: 990 },
      miningOperation: { ...hauler.miningOperation!, logisticsTarget: { ...world.miningOperation!.currentTarget!, state: "DRAINING" as const } } };
    action = SCRIPT_MACROS["loot-containers"](lootStep, atTail, {}, {});
    assert.equal(action.phase, "Looting");
  });
}

test("Ice rejects an ore-only fit and activates only the Ice Harvester against classified Ice", () => {
  const step = siteStep("ICE");
  const world = observation(siteWorld("ICE"));
  const mine = SCRIPT_MACROS["mine-at-belt"];
  const refused = mine(step, { ...world, miningModuleIDs: [72], iceMiningModuleIDs: [] }, {}, {});
  assert.equal(refused.outcome.kind, "blocked"); assert.match(refused.why, /Ice Harvester/);
  const rock = { ...entity(501, "Not a classification", 1000), kind: "asteroid", miningYieldTypeID: 16265, miningResourceFamily: "ice" as const, remainingQuantity: 10 };
  const decided = mine(step, { ...world, snapshot: snapshot([rock]), miningModuleIDs: [72, 71], iceMiningModuleIDs: [71], lockedTargetIDs: [501] }, { rockID: 501, siteTargetKey: world.miningOperation!.currentTarget!.targetKey }, {});
  assert.deepEqual(decided.action, { kind: "activate", moduleID: 71, targetID: 501 });
  const unknown = mine(step, { ...world, snapshot: snapshot([{ ...rock, miningResourceFamily: null }]) }, {}, {});
  assert.equal(unknown.phase, "Resource authority unavailable");
});

for (const family of ["BELT", "ORE_ANOMALY", "ICE"] as const) {
  test(`${family}: resource preference outranks distance, falls through A/B/other without target depletion`, () => {
    const base = observation(family === "BELT" ? { miningModuleIDs: [71] } : siteWorld(family));
    const policy = { mode: "PREFER_LIST" as const, source: "MANUAL" as const, typeIDs: [100, 200] };
    const rock = (itemID: number, yieldID: number, x: number) => ({ ...entity(itemID, "Not authoritative", x), kind: "asteroid", miningYieldTypeID: yieldID,
      miningResourceFamily: family === "ICE" ? "ice" as const : "ore" as const, remainingQuantity: 100 });
    const aFar = rock(501, 100, 80_000), aNear = rock(502, 100, 40_000), b = rock(503, 200, 20_000), other = rock(504, 300, 1000);
    const decide = (resources: ReturnType<typeof rock>[], mode: "ANY_ELIGIBLE" | "PREFER_LIST" = "PREFER_LIST", mem = {}) => SCRIPT_MACROS["mine-at-belt"](
      family === "BELT" ? beltStep : siteStep(family), { ...base, miningOperation: { ...base.miningOperation!, resourcePolicy: { ...policy, mode } },
        snapshot: snapshot([entity(1, "Asteroid Belt 1"), ...resources]) }, mem, {});
    for (const [resources, expected] of [[[aFar, aNear, b, other], 502], [[b, other], 503], [[other], 504]] as const) {
      const next = decide([...resources]); assert.equal(next.action.kind, "orbit");
      assert.equal(next.action.kind === "orbit" ? next.action.targetID : null, expected);
      assert.notEqual(next.phase, "Confirming depletion");
    }
    const any = decide([aFar, b, other], "ANY_ELIGIBLE"); assert.equal(any.action.kind === "orbit" ? any.action.targetID : null, 504);
    const exhausted = decide([b, other], "PREFER_LIST", { rockID: aNear.itemID });
    assert.equal(exhausted.action.kind === "orbit" ? exhausted.action.targetID : null, b.itemID);
  });
}
