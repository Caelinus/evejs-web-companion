// The scanner's ICE sites as a destination for the Fly-to and Mine-at blocks,
// with no Mining Operation behind them.
//
// An ice field reaches the scanner as a gravimetric (211) row, so it groups
// with the ore sites; only its dungeon archetype (28) says it is ice. These
// tests pin that the two tours never mix: the ore tour skips ice fields, the
// ice tour skips ore sites, and on an ice grid only the harvesters touch only
// the ice.

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus, SpaceEntity, SpaceShipStatus, SpaceSnapshot } from "../store/types.ts";
import type { MacroMemory, MacroTick, ScriptBoard } from "./scriptDecide.ts";
import type { ScannedAnomaly, ScriptObservation } from "./scriptConditions.ts";
import type { BotScript, MacroStep } from "../bots/botScript.ts";
import { activeStepMinesIce, initialMemory } from "./scriptDecide.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import { stepSentence } from "../bots/scriptText.ts";
import { scriptMinesScannerSites } from "./miningSite.ts";

const ORIGIN = { x: 0, y: 0, z: 0 };
const AU = 149_597_870_700;

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "celestial", typeID: 1, groupID: 1, categoryID: 2, name: null, ownerID: null,
    radius: 10, position: ORIGIN, velocity: ORIGIN, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: null, beltID: null, oreGrade: null,
    oreValuePerM3: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null,
    ...over,
  };
}

function snapshot(entities: SpaceEntity[]): SpaceSnapshot {
  const ship = {
    itemID: 9001, typeID: 17480, name: "Procurer", mode: null, maxVelocity: 100, radius: 100,
    position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
    shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
  } as unknown as SpaceShipStatus;
  return { inSpace: true, solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1, entities, ship };
}

function flight(): FlightStatus {
  return { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null, shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(), snapshot: null, lockedTargetIDs: [], holds: null, droneBayItemIDs: [],
    miningModuleIDs: [], startingStationID: null,
    systemName: "Test System",
    ...over,
  };
}

/** Scanner rows as the server sends them: both scanned gravimetric, told apart only by archetype. */
const ICE_FIELD: ScannedAnomaly = { label: "ICE-001", kind: "ore", archetypeID: 28, siteID: 101, instanceID: 101, position: { x: 2 * AU, y: 0, z: 0 } };
const ORE_SITE: ScannedAnomaly = { label: "ORE-001", kind: "ore", archetypeID: 27, siteID: 102, instanceID: 102, position: { x: 3 * AU, y: 0, z: 0 } };
const ICE_FIELD_2: ScannedAnomaly = { label: "ICE-002", kind: "ore", archetypeID: 28, siteID: 103, instanceID: 103, position: { x: 4 * AU, y: 0, z: 0 } };

function beltStep(macro: "travel-to-belt" | "mine-at-belt", mode: "site" | "ice-site"): MacroStep {
  return {
    id: "s", kind: "macro", macro, args: { belt: { kind: "belt", belt: { mode } } },
    ...(macro === "mine-at-belt" ? { until: { kind: "ore-hold-at-least" as const, fraction: 0.9 } } : {}),
  };
}

/** Tick a block until it presses a warp (a tour may commit its pick on a wait tick first). */
function untilWarp(step: MacroStep, observation: ScriptObservation, board: ScriptBoard = {}): MacroTick {
  const decide = SCRIPT_MACROS[step.macro]!;
  let mem: MacroMemory = {};
  let last = decide(step, observation, mem, board);
  for (let i = 0; i < 4 && last.action.kind !== "warpScan" && last.outcome.kind === "acting"; i += 1) {
    mem = last.nextMem;
    last = decide(step, observation, mem, board);
  }
  return last;
}

test("the ore tour no longer flies into an ice field", () => {
  const step: MacroStep = { id: "w", kind: "macro", macro: "warp-to-ore-anomaly", args: {} };
  const out = untilWarp(step, obs({ anomalies: [ICE_FIELD, ORE_SITE] }));
  assert.deepEqual(out.action, { kind: "warpScan", target: "ORE-001" });
});

test("Fly to the scanner's ice sites, with no operation, warps to the ice field and not the ore site", () => {
  const out = untilWarp(beltStep("travel-to-belt", "ice-site"), obs({ anomalies: [ORE_SITE, ICE_FIELD] }));
  assert.deepEqual(out.action, { kind: "warpScan", target: "ICE-001" });
});

test("Fly to the scanner's ore sites, with no operation, is the ore tour and skips ice", () => {
  const out = untilWarp(beltStep("travel-to-belt", "site"), obs({ anomalies: [ICE_FIELD, ORE_SITE] }));
  assert.deepEqual(out.action, { kind: "warpScan", target: "ORE-001" });
});

test("a system with only ore sites is no place for the ice tour", () => {
  const out = untilWarp(beltStep("travel-to-belt", "ice-site"), obs({ anomalies: [ORE_SITE] }));
  assert.equal(out.outcome.kind, "blocked");
  assert.match((out.outcome as { reason: string }).reason, /not one of them is an ice site/);
});

test("on an ice grid the mine block works the ice chunk with the harvester, never the rock", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, miningResourceFamily: "ore", position: { x: 3000, y: 0, z: 0 } });
  const chunk = entity({ itemID: 50002, name: "White Glaze", miningYieldTypeID: 16265, miningResourceFamily: "ice", position: { x: 9000, y: 0, z: 0 } });
  const out = SCRIPT_MACROS["mine-at-belt"]!(beltStep("mine-at-belt", "ice-site"),
    obs({ snapshot: snapshot([rock, chunk]), miningModuleIDs: [7001, 7002], iceMiningModuleIDs: [7002], anomalies: [ICE_FIELD] }),
    {}, { iceAnomsVisited: "ICE-001" });
  assert.deepEqual(out.action, { kind: "orbit", targetID: 50002, range: 5000 });
  assert.equal(out.phase, "Approaching an ice chunk");
});

test("an ice step with no online Ice Harvester stops and says so", () => {
  const chunk = entity({ itemID: 50002, miningYieldTypeID: 16265, miningResourceFamily: "ice" });
  const out = SCRIPT_MACROS["mine-at-belt"]!(beltStep("mine-at-belt", "ice-site"),
    obs({ snapshot: snapshot([chunk]), miningModuleIDs: [7001], iceMiningModuleIDs: [] }), {}, {});
  assert.equal(out.outcome.kind, "blocked");
  assert.match((out.outcome as { reason: string }).reason, /ICE_MINING_CAPABILITY_REQUIRED/);
});

test("a mined-out ice field moves on to the next ice field, keeping its own lists", () => {
  const step = beltStep("mine-at-belt", "ice-site");
  const observation = obs({ snapshot: snapshot([]), iceMiningModuleIDs: [7002], anomalies: [ICE_FIELD, ORE_SITE, ICE_FIELD_2] });
  const board: ScriptBoard = { iceAnomsVisited: "ICE-001", oreAnomsVisited: "ORE-001" };
  let mem: MacroMemory = {};
  let out = SCRIPT_MACROS["mine-at-belt"]!(step, observation, mem, board);
  for (let read = 1; read < 3; read += 1) {
    mem = out.nextMem;
    out = SCRIPT_MACROS["mine-at-belt"]!(step, observation, mem, board);
  }
  assert.deepEqual(out.action, { kind: "warpScan", target: "ICE-002" });
  assert.equal(out.boardPatch?.["iceSitesBarren"], "ICE-001");
  assert.equal(out.boardPatch?.["iceAnomsVisited"], "ICE-001,ICE-002");
  assert.equal(out.boardPatch?.["oreSitesBarren"], undefined, "the ore tour's lists are not touched");
});

test("unclassified mineable chunks wait and reset the ice tour's consecutive barren proof", () => {
  const step = beltStep("mine-at-belt", "ice-site");
  const chunk = entity({ itemID: 50002, miningYieldTypeID: 16265, miningResourceFamily: null });
  const board: ScriptBoard = { iceAnomsVisited: "ICE-001" };
  const observation = obs({ snapshot: snapshot([chunk]), iceMiningModuleIDs: [7002], anomalies: [ICE_FIELD, ICE_FIELD_2] });
  let mem: MacroMemory = { oreGridEmptyReads: 2 };
  for (let read = 0; read < 3; read += 1) {
    const out = SCRIPT_MACROS["mine-at-belt"]!(step, observation, mem, board);
    assert.equal(out.action.kind, "wait");
    assert.equal(out.phase, "Resource authority unavailable");
    assert.equal(out.outcome.kind, "acting");
    assert.equal(out.boardPatch, undefined);
    mem = out.nextMem;
  }
  const identified = SCRIPT_MACROS["mine-at-belt"]!(step,
    { ...observation, snapshot: snapshot([{ ...chunk, miningResourceFamily: "ice" }]) }, mem, board);
  assert.deepEqual(identified.action, { kind: "orbit", targetID: 50002, range: 5000 });

  // Once authority returns an empty grid, all three fresh reads are required.
  const empty = { ...observation, snapshot: snapshot([]) };
  for (let read = 0; read < 2; read += 1) {
    const out = SCRIPT_MACROS["mine-at-belt"]!(step, empty, mem, board);
    assert.equal(out.action.kind, "wait");
    assert.equal(out.boardPatch, undefined);
    mem = out.nextMem;
  }
  const barren = SCRIPT_MACROS["mine-at-belt"]!(step, empty, mem, board);
  assert.deepEqual(barren.action, { kind: "warpScan", target: "ICE-002" });
  assert.equal(barren.boardPatch?.["iceSitesBarren"], "ICE-001");
});

test("unclassified nonmineable celestials do not block a confirmed ice chunk", () => {
  const chunk = entity({ itemID: 50002, miningYieldTypeID: 16265, miningResourceFamily: "ice" });
  const station = entity({ itemID: 60000004, miningResourceFamily: null });
  const out = SCRIPT_MACROS["mine-at-belt"]!(beltStep("mine-at-belt", "ice-site"),
    obs({ snapshot: snapshot([station, chunk]), iceMiningModuleIDs: [7002] }), {}, {});
  assert.deepEqual(out.action, { kind: "orbit", targetID: 50002, range: 5000 });
});

test("the hold an ice step watches is the ice hold", () => {
  const script: BotScript = { version: 1, name: "Ice", home: { entity: "station", id: 60000004, name: "Home", systemName: null },
    program: [beltStep("mine-at-belt", "ice-site")] } as unknown as BotScript;
  assert.equal(activeStepMinesIce(script, initialMemory(script)), true);
  const ore = { ...script, program: [beltStep("mine-at-belt", "site")] } as BotScript;
  assert.equal(activeStepMinesIce(ore, initialMemory(ore)), false);
});

test("the block reads as a trip to the scanner's ice site", () => {
  assert.match(stepSentence(beltStep("travel-to-belt", "ice-site")), /Fly to the ice site the scanner shows/);
});

test("a script that tours the scanner's sites asks for its miners to be told apart", () => {
  const wrap = (step: MacroStep): BotScript =>
    ({ version: 1, name: "S", home: null, program: [{ id: "l", kind: "loop", repeat: { kind: "forever" }, body: [step] }] }) as unknown as BotScript;
  assert.equal(scriptMinesScannerSites(wrap(beltStep("mine-at-belt", "ice-site"))), true);
  assert.equal(scriptMinesScannerSites(wrap(beltStep("travel-to-belt", "site"))), true);
  const nearest: MacroStep = { id: "n", kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "nearest" } } } };
  assert.equal(scriptMinesScannerSites(wrap(nearest)), false);
});
