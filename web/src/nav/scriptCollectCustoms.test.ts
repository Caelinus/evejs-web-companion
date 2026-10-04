// collect-customs: the hauler's half of the customs-office export. The Haul
// button sends a colony's launchpads up into the planet's own customs office
// (over the game port, before the run starts); this block empties every office
// in THIS system that holds goods of the pilot's. Pure, over fixture
// observations - the same idiom as scriptCollectLaunches.test.ts.
//
// What these pin:
//   • an office is found by its GROUP (1025, Planetary Customs Offices), never
//     by its name or by where it sits;
//   • an unread list is "nobody looked", never "they are empty" - reading empty
//     out of a null would fly the hauler home past a full office;
//   • an office that reads empty is finished and the next one is worked;
//   • a full ship ends the block, because that is a finished trip;
//   • warp, then close in, then take - the shape every loot block has.

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus, SpaceEntity, SpaceShipStatus, SpaceSnapshot, SpaceVector } from "../store/types.ts";
import type { MacroStep } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { ScriptBoard } from "./scriptDecide.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import { stepSentence } from "../bots/scriptText.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };
const SYSTEM = 30000142;
const GROUP_CUSTOMS_OFFICES = 1025;
const OFFICE_A = 1_200_040_000_001;
const OFFICE_B = 1_200_040_000_002;

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "orbital", typeID: 2233, groupID: GROUP_CUSTOMS_OFFICES, categoryID: 46,
    name: "Customs Office", ownerID: null,
    radius: 1000, position: ORIGIN, velocity: ORIGIN, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: null, beltID: null, oreGrade: null,
    oreValuePerM3: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null,
    ...over,
  };
}

function ship(over: Partial<SpaceShipStatus> = {}): SpaceShipStatus {
  return {
    itemID: 9001, typeID: 650, name: "Epithal", mode: null, maxVelocity: 100, radius: 100,
    position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
    shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
    ...over,
  } as SpaceShipStatus;
}

function snapshot(entities: SpaceEntity[]): SpaceSnapshot {
  return { inSpace: true, solarSystemID: SYSTEM, shipID: 9001, sampledAtMs: 1, entities, ship: ship() };
}

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return {
    inSpace: true, docked: false, solarSystemID: SYSTEM, stationID: null, structureID: null,
    shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null,
    ...over,
  };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(), snapshot: snapshot([]), lockedTargetIDs: [], holds: null,
    droneBayItemIDs: [], miningModuleIDs: [], startingStationID: null, systemName: "Test System",
    ...over,
  };
}

const NB: ScriptBoard = {};
const collect = SCRIPT_MACROS["collect-customs"]!;
const step: MacroStep = { id: "cc", kind: "macro", macro: "collect-customs", args: {} };

/** An office on grid, `away` metres down the x axis. */
function office(itemID: number, away: number, over: Partial<SpaceEntity> = {}): SpaceEntity {
  return entity({ itemID, position: { x: away, y: 0, z: 0 }, ...over });
}

const holding = (officeID: number, units: number) => ({ officeID, stacks: 1, units });

test("the block is in the catalogue and says what it does", () => {
  assert.equal(stepSentence(step), "Empty every customs office in this system that holds your goods");
});

test("docked -> blocked: an office is emptied from space", () => {
  const t = collect(step, obs({
    inSpace: false, docked: true, snapshot: null,
    flightStatus: flight({ inSpace: false, docked: true, stationID: 60000004 }),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.equal(t.outcome.kind, "blocked");
});

test("⚠ an unread list waits; it is never read as 'every office is empty'", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000)]),
    customsOffices: null,
  }), {}, NB);
  assert.equal(t.outcome.kind, "acting");
  assert.equal(t.action.kind, "wait");
  assert.match(t.why, /Reading the customs offices/);
});

test("⚠ an empty grid read waits before it is believed; a gate jump lands on one", () => {
  // "There is no office here" finishes the block, which would walk the hauler
  // past a full office if the tick after a jump saw a sparse snapshot.
  const t = collect(step, obs({ snapshot: snapshot([]), customsOffices: [] }), {}, NB);
  assert.equal(t.outcome.kind, "acting");
  assert.match(t.why, /Looking for this system's customs offices/);
});

test("a system that really has no office finishes the block, once", () => {
  const t = collect(step, obs({ snapshot: snapshot([]), customsOffices: [] }), { looked: 15 }, NB);
  assert.equal(t.outcome.kind, "done");
  assert.match(t.why, /no customs office in this system/);
});

test("every office read empty finishes the block", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000), office(OFFICE_B, 2000)]),
    customsOffices: [holding(OFFICE_A, 0), holding(OFFICE_B, 0)],
  }), {}, NB);
  assert.equal(t.outcome.kind, "done");
  assert.match(t.why, /Every customs office in this system is emptied/);
});

test("an office holding goods, in reach, is emptied", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000)]),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "collectCustoms", officeID: OFFICE_A });
});

test("an office far off is warped to, not flown to", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 20_000_000)]),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "warp", targetID: OFFICE_A });
});

test("an office inside warp range but out of reach is approached", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 50_000)]),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "approach", targetID: OFFICE_A });
});

test("the nearest office holding something is worked first", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 20_000_000), office(OFFICE_B, 1000)]),
    customsOffices: [holding(OFFICE_A, 300), holding(OFFICE_B, 10)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "collectCustoms", officeID: OFFICE_B });
});

test("an empty office is skipped for one that is holding goods", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000), office(OFFICE_B, 2000)]),
    customsOffices: [holding(OFFICE_A, 0), holding(OFFICE_B, 42)],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "collectCustoms", officeID: OFFICE_B });
});

test("⚠ a structure that is not a customs office is never opened", () => {
  // Group 1025 is the test, not the name: a gantry carries the office's own
  // words and holds nothing.
  const gantry = office(OFFICE_B, 500, { groupID: 1026, typeID: 3962, name: "Customs Office Gantry" });
  const t = collect(step, obs({
    snapshot: snapshot([gantry]),
    customsOffices: [holding(OFFICE_B, 99)],
  }), { looked: 15 }, NB);
  assert.equal(t.outcome.kind, "done");
  assert.equal(t.action.kind, "wait");
});

test("a full ship is a finished trip, not a failure", () => {
  const t = collect(step, obs({
    snapshot: snapshot([office(OFFICE_A, 1000)]),
    customsOffices: [holding(OFFICE_A, 300)],
    holds: [{
      key: "planetary", label: "Planetary Hold", items: [], present: true, error: null,
      capacity: { capacity: 5000, used: 5000 },
    }] as never,
  }), {}, NB);
  assert.equal(t.outcome.kind, "done");
  assert.match(t.why, /full/);
});

test("in warp, nothing is decided", () => {
  const t = collect(step, obs({
    inWarp: true,
    snapshot: snapshot([office(OFFICE_A, 1000)]),
    customsOffices: [holding(OFFICE_A, 300)],
  }), {}, NB);
  assert.equal(t.action.kind, "wait");
  assert.equal(t.outcome.kind, "acting");
});
