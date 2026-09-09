// B1 — the macro adapters' key transitions. Pins each block's task loop so a
// wrong turn surfaces here, not on a live ship: undock, the mine state machine
// (warp to belt / orbit / lock / activate), deliver (dock + unload), defend.

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus, HoldItem, MiningHold, SpaceEntity, SpaceShipStatus, SpaceSnapshot, SpaceVector } from "../store/types.ts";
import type { MacroMemory } from "./scriptDecide.ts";
import type { DryBelt, ScriptObservation } from "./scriptConditions.ts";
import type { MacroStep } from "../bots/botScript.ts";
import { SCRIPT_MACROS, scriptTravelHome } from "./scriptMacros.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };

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

function ship(over: Partial<SpaceShipStatus> = {}): SpaceShipStatus {
  return {
    itemID: 9001, typeID: 17476, name: "Procurer", mode: null, maxVelocity: 100, radius: 100,
    position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
    shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
    ...over,
  } as SpaceShipStatus;
}

function snapshot(entities: SpaceEntity[], shipOver: Partial<SpaceShipStatus> = {}): SpaceSnapshot {
  return { inSpace: true, solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1, entities, ship: ship(shipOver) };
}

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null, shipID: 9001, shipMode: null, shipSpeedFraction: null, ...over };
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

const mineStep: MacroStep = { id: "m", kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "nearest" } } }, until: { kind: "ore-hold-at-least", fraction: 0.9 } };
const haulStep: MacroStep = { id: "h", kind: "macro", macro: "deliver-ore", args: { station: { kind: "station", ref: { entity: "station", id: 60000004, name: "Home", systemName: null } } } };
const mine = SCRIPT_MACROS["mine-at-belt"]!;
const deliver = SCRIPT_MACROS["deliver-ore"]!;
const undock = SCRIPT_MACROS["undock"]!;
const defend = SCRIPT_MACROS["defend-with-drones"]!;
const NM: MacroMemory = {};

const scannerOperations: NonNullable<ScriptObservation["scannerOperations"]> = {
  inSpace: true,
  solarSystemID: 30000142,
  shipID: 9001,
  maxActiveProbes: 8,
  launcher: {
    moduleID: 8001,
    typeID: 17938,
    online: true,
    chargeTypeID: 30013,
    loadedCount: 8,
    launchCount: 8,
  },
  probes: [],
};

test("undock: docked -> undock, in space -> done", () => {
  assert.equal(undock({ id: "u", kind: "macro", macro: "undock", args: {} }, obs({ flightStatus: flight({ docked: true, inSpace: false }) }), NM, {}).action.kind, "undock");
  assert.equal(undock({ id: "u", kind: "macro", macro: "undock", args: {} }, obs({ flightStatus: flight({ docked: false }) }), NM, {}).outcome.kind, "done");
});

test("mine: no rocks but a distant belt -> warp to the belt", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(t.action.kind, "warp");
  assert.ok(t.action.kind === "warp" && t.action.targetID === 40001);
});

test("mine: a pinned belt beats a nearer unpinned one", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const chosen = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 900000, y: 0, z: 0 } });
  const step: MacroStep = {
    id: "m",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: {
        kind: "belt",
        belt: { mode: "chosen", ref: { entity: "belt", id: 40002, name: "Asteroid Belt 2", systemName: null } },
      },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const t = mine(step, obs({ snapshot: snapshot([near, chosen]) }), NM, {});
  assert.equal(t.action.kind, "warp");
  assert.ok(t.action.kind === "warp" && t.action.targetID === 40002);
});

test("mine: a pinned belt not on this grid -> blocked, never a silent fallback to nearest", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const step: MacroStep = {
    id: "m",
    kind: "macro",
    macro: "mine-at-belt",
    args: {
      belt: {
        kind: "belt",
        belt: { mode: "chosen", ref: { entity: "belt", id: 99999, name: "Asteroid Belt 9", systemName: null } },
      },
    },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const t = mine(step, obs({ snapshot: snapshot([near]) }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /pinned/i);
});

const travelToBeltStep: MacroStep = {
  id: "tb", kind: "macro", macro: "travel-to-belt",
  args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
};
const travelToBelt = SCRIPT_MACROS["travel-to-belt"]!;

test("travel-to-belt: no belt in view -> blocked", () => {
  const t = travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([]) }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
});

test("travel-to-belt: a distant belt -> warp to it", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const t = travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(t.action.kind, "warp");
  assert.ok(t.action.kind === "warp" && t.action.targetID === 40001);
});

test("travel-to-belt: already on the belt -> done, no mining involved", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const t = travelToBelt(travelToBeltStep, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(t.outcome.kind, "done");
});

test("travel-to-belt: a pinned belt not on this grid -> blocked, never a silent fallback to nearest", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 500000, y: 0, z: 0 } });
  const step: MacroStep = {
    id: "tb2",
    kind: "macro",
    macro: "travel-to-belt",
    args: {
      belt: {
        kind: "belt",
        belt: { mode: "chosen", ref: { entity: "belt", id: 99999, name: "Asteroid Belt 9", systemName: null } },
      },
    },
  };
  const t = travelToBelt(step, obs({ snapshot: snapshot([near]) }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /pinned/i);
});

test("mine: a rock in range -> orbit it at 5km and remember it", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, beltID: 40001, position: { x: 8000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([rock]) }), NM, {});
  assert.equal(t.action.kind, "orbit");
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50001 && t.action.range === 5000);
  assert.equal(t.nextMem["rockID"], 50001);
});

test("mine: rock locked but still out of range, not yet approached -> close in", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 15000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [700, 701] }),
    { rockID: 50001, lockIssued: true, waited: 0 },
    {},
  );
  assert.equal(t.action.kind, "orbit");
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50001 && t.action.range === 5000);
  assert.equal(t.nextMem["approachedRockID"], 50001);
});

test("mine: rock locked, out of range, already closing in -> wait rather than activate", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 15000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [700, 701] }),
    { rockID: 50001, lockIssued: true, waited: 0, approachedRockID: 50001 },
    {},
  );
  assert.equal(t.action.kind, "wait");
  assert.match(t.phase, /Approaching/);
});

test("mine: rock locked at 7km — an orbit of 5km overshooting a little — still activates", () => {
  // An orbit command holds APPROXIMATELY its radius, not exactly it, so a ship
  // told to orbit at 5km can genuinely settle a bit outside that. The range
  // check has to tolerate that wobble rather than treat it as still too far.
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 7000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [700, 701] }),
    { rockID: 50001, lockIssued: true, waited: 0, approachedRockID: 50001 },
    {},
  );
  assert.ok(t.action.kind === "activate" && t.action.targetID === 50001 && t.action.moduleID === 700);
});

test("mine: rock locked, a miner idle -> activate it on the rock", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 4000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [700, 701] }),
    { rockID: 50001, lockIssued: true, waited: 0 },
    {},
  );
  assert.ok(t.action.kind === "activate" && t.action.targetID === 50001 && t.action.moduleID === 700);
});

test("mine: rock locked, all miners running -> wait (mining)", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 4000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [700] }), lockedTargetIDs: [50001], miningModuleIDs: [700] }),
    { rockID: 50001, lockIssued: true, waited: 0 },
    {},
  );
  assert.equal(t.action.kind, "wait");
  assert.match(t.phase, /Mining/);
});

test("mine: rock locked, but no mining equipment was detected -> blocked, not a silent 'mining'", () => {
  const rock = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, position: { x: 4000, y: 0, z: 0 } });
  const t = mine(
    mineStep,
    obs({ snapshot: snapshot([rock], { activeModuleIDs: [] }), lockedTargetIDs: [50001], miningModuleIDs: [] }),
    { rockID: 50001, lockIssued: true, waited: 0 },
    {},
  );
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /no mining equipment/i);
});

// ── mine: belt rotation (nearest mode, decision 2, shared BFF memory) ───────

test("mine: a dry belt in nearest mode reports it via the shared memory instead of blocking", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 500000, y: 0, z: 0 } });
  const t1 = mine(mineStep, obs({ snapshot: snapshot([near, far]) }), NM, {});
  assert.equal(t1.action.kind, "rememberBeltDry");
  assert.ok(
    t1.action.kind === "rememberBeltDry" &&
      t1.action.systemName === "Test System" &&
      t1.action.beltName === "Asteroid Belt 1" &&
      t1.action.groupID === null,
  );
  assert.match(t1.why, /moving to the next belt/i);

  // Next tick, with the shared memory now reporting belt 1 all-dry: rotate to the far belt.
  const dryBelts: DryBelt[] = [{ beltName: "Asteroid Belt 1", all: true, families: [] }];
  const t2 = mine(mineStep, obs({ snapshot: snapshot([near, far]), dryBelts }), NM, {});
  assert.equal(t2.action.kind, "warp");
  assert.ok(t2.action.kind === "warp" && t2.action.targetID === 40002);
});

test("mine: every belt in the system reported dry -> blocked with a plain reason", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 8000, y: 0, z: 0 } });
  const dryBelts: DryBelt[] = [
    { beltName: "Asteroid Belt 1", all: true, families: [] },
    { beltName: "Asteroid Belt 2", all: true, families: [] },
  ];
  const t = mine(mineStep, obs({ snapshot: snapshot([near, far]), dryBelts }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.kind === "blocked" ? t.outcome.reason : "", "Every asteroid belt in this system is mined out.");
});

test("mine: a CHOSEN (pinned) belt still just pauses when dry — no rotation", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const step: MacroStep = {
    id: "mp",
    kind: "macro",
    macro: "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: "chosen", ref: { entity: "belt", id: 40001, name: "Asteroid Belt 1", systemName: null } } } },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
  const t = mine(step, obs({ snapshot: snapshot([belt]) }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.kind === "blocked" ? t.outcome.reason : "", "This belt has no rocks left to mine.");
  assert.equal(t.boardPatch, undefined);
});

test("mine: the shared belt memory is read from the observation, independent of per-step memory", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 500000, y: 0, z: 0 } });
  const dryBelts: DryBelt[] = [{ beltName: "Asteroid Belt 1", all: true, families: [] }];
  // A stale mem (as if this were mid-lock on a rock from before the haul) makes no difference.
  const t1 = mine(mineStep, obs({ snapshot: snapshot([near, far]), dryBelts }), { rockID: 999, lockIssued: true }, {});
  assert.ok(t1.action.kind === "warp" && t1.action.targetID === 40002);
  // Re-entering the step resets mem to {} and the board carries nothing either —
  // the shared memory lives on the observation and does not care.
  const t2 = mine(mineStep, obs({ snapshot: snapshot([near, far]), dryBelts }), {}, {});
  assert.ok(t2.action.kind === "warp" && t2.action.targetID === 40002);
});

test("mine: dryBelts null (unreadable) is treated as nothing known, never as all dry", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([near]), dryBelts: null }), NM, {});
  assert.equal(t.action.kind, "rememberBeltDry");
});

test("mine: on a dry belt but the system name is unreadable -> blocked, not a bare report", () => {
  const near = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([near]), systemName: null }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.kind === "blocked" ? t.outcome.reason : "", "The bot cannot tell which solar system this is.");
});

test("mine: rotation skips a belt dry for this tier's family but not a belt dry only for a different family", () => {
  const belt1 = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const belt2 = entity({ itemID: 40002, name: "Asteroid Belt 2", position: { x: 500000, y: 0, z: 0 } });
  const step = oreListStep([VELDSPAR, KERNITE]);
  const dryBelts: DryBelt[] = [
    { beltName: "Asteroid Belt 1", all: false, families: [VELDSPAR.groupID] },
    { beltName: "Asteroid Belt 2", all: false, families: [KERNITE.groupID] },
  ];
  const t = mine(step, obs({ snapshot: snapshot([belt1, belt2]), dryBelts }), NM, {});
  assert.equal(t.action.kind, "warp");
  assert.ok(
    t.action.kind === "warp" && t.action.targetID === 40002,
    "belt 2 is only dry for Kernite, not the active Veldspar tier, so it is still a target",
  );
});

// ── mine: ore priority (tiered oreList) ──────────────────────────────────────

const VELDSPAR = { groupID: 462, name: "Veldspar" };
const KERNITE = { groupID: 465, name: "Kernite" };

function oreListStep(ores: { groupID: number; name: string }[]): MacroStep {
  return {
    id: "mo",
    kind: "macro",
    macro: "mine-at-belt",
    args: { belt: { kind: "belt", belt: { mode: "nearest" } }, ores: { kind: "oreList", ores } },
    until: { kind: "ore-hold-at-least", fraction: 0.9 },
  };
}

test("mine: an ore-priority list only mines the listed family, ignoring closer non-listed rocks", () => {
  const veld = entity({ itemID: 50001, name: "Veldspar", groupID: 462, miningYieldTypeID: 1230, position: { x: 9000, y: 0, z: 0 } });
  const kern = entity({ itemID: 50002, name: "Kernite", groupID: 465, miningYieldTypeID: 1229, position: { x: 3000, y: 0, z: 0 } });
  const t = mine(oreListStep([VELDSPAR]), obs({ snapshot: snapshot([veld, kern]) }), NM, {});
  assert.equal(t.action.kind, "orbit");
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50001, "the closer Kernite rock is not on the list and is ignored");
});

test("mine: within a family, the highest ore grade wins over distance; an unknown grade sorts last", () => {
  const plain = entity({ itemID: 50001, name: "Veldspar", groupID: 462, miningYieldTypeID: 1230, oreGrade: 0, position: { x: 2000, y: 0, z: 0 } });
  const graded = entity({ itemID: 50002, name: "Concentrated Veldspar", groupID: 462, miningYieldTypeID: 1231, oreGrade: 2, position: { x: 9000, y: 0, z: 0 } });
  const unknown = entity({ itemID: 50003, name: "Veldspar", groupID: 462, miningYieldTypeID: 1230, oreGrade: null,
    oreValuePerM3: null, position: { x: 500, y: 0, z: 0 } });
  const t = mine(oreListStep([VELDSPAR]), obs({ snapshot: snapshot([plain, graded, unknown]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50002, "grade II beats both a closer plain rock and an unknown-grade one");
});

test("mine: a belt on grid dry for the tier's family reports that family's groupID, not a plain dry", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const kern = entity({ itemID: 50001, name: "Kernite", groupID: 465, miningYieldTypeID: 1229, position: { x: 9000, y: 0, z: 0 } });
  const step = oreListStep([VELDSPAR, KERNITE]);
  const t1 = mine(step, obs({ snapshot: snapshot([belt, kern]) }), NM, {});
  assert.equal(t1.action.kind, "rememberBeltDry");
  assert.ok(
    t1.action.kind === "rememberBeltDry" &&
      t1.action.systemName === "Test System" &&
      t1.action.beltName === "Asteroid Belt 1" &&
      t1.action.groupID === VELDSPAR.groupID,
  );
  assert.match(t1.why, /No Veldspar left here/i);
});

test("mine: once a tier's ore is reported gone from every belt, priority advances to the next tier (a fresh tour)", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const kern = entity({ itemID: 50001, name: "Kernite", groupID: 465, miningYieldTypeID: 1229, position: { x: 9000, y: 0, z: 0 } });
  const step = oreListStep([VELDSPAR, KERNITE]);
  // The shared memory already reports the only belt dry for Veldspar.
  const dryBelts: DryBelt[] = [{ beltName: "Asteroid Belt 1", all: false, families: [VELDSPAR.groupID] }];
  const world = () => obs({ snapshot: snapshot([belt, kern]), dryBelts });

  // Tick 1: every belt is dry for Veldspar -> advance to Kernite, fresh tour (per-pilot tier).
  const t1 = mine(step, world(), NM, {});
  assert.match(t1.why, /No Veldspar left in this system, moving to the next ore/i);
  assert.equal(t1.boardPatch?.["mineOreTier"], 1);

  // Tick 2: now on the Kernite tier, the rock right there is mineable — the
  // shared memory's Veldspar-only entry does not block a different family.
  const t2 = mine(step, world(), NM, { ...t1.boardPatch });
  assert.ok(t2.action.kind === "orbit" && t2.action.targetID === 50001);
});

test("mine: the ore-priority list running out entirely -> blocked, never a silent fallback to any rock", () => {
  const belt = entity({ itemID: 40001, name: "Asteroid Belt 1", position: { x: 5000, y: 0, z: 0 } });
  const board = { mineOreTier: 1 }; // already past the end of a one-family list
  const t = mine(oreListStep([VELDSPAR]), obs({ snapshot: snapshot([belt]) }), NM, board);
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(t.outcome.kind === "blocked" ? t.outcome.reason : "", "None of the ores on your list are left in this system.");
});

test("deliver: docked with ore -> unload; docked empty -> done", () => {
  const withOre: MiningHold[] = [{ key: "ore", label: "Ore Hold", items: [{ itemID: 8, typeID: 1230, groupID: 462, categoryID: 25, quantity: 100 }], capacity: null, present: true, error: null }];
  const unload = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds: withOre }), NM, {});
  assert.ok(unload.action.kind === "unloadOre" && unload.action.itemIDs.includes(8));

  const done = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds: [] }), NM, {});
  assert.equal(done.outcome.kind, "done");
});

test("deliver: the ore hold goes ashore, the CARGO hold stays aboard", () => {
  // A barge carrying spare mining crystals in cargo. Before this, the delivery
  // took them too — the mining-holds route reports cargo as a fallback entry on
  // every hull and the block emptied every hold it was handed.
  const holds: MiningHold[] = [
    { key: "ore", label: "Ore Hold", items: [{ itemID: 8, typeID: 1230, groupID: 462, categoryID: 25, quantity: 100 }], capacity: null, present: true, error: null },
    { key: "cargo", label: "Cargo Hold", items: [{ itemID: 99, typeID: 3389, groupID: 483, categoryID: 8, quantity: 4 }], capacity: null, present: true, error: null },
  ];
  const t = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds }), NM, {});
  assert.ok(t.action.kind === "unloadOre");
  assert.deepEqual(t.action.kind === "unloadOre" ? [...t.action.itemIDs] : [], [8], "the crystals stayed in cargo");
});

test("deliver: a hull with no ore hold still delivers what it mined into cargo", () => {
  const holds: MiningHold[] = [
    { key: "cargo", label: "Cargo Hold", items: [{ itemID: 42, typeID: 1230, groupID: 462, categoryID: 25, quantity: 50 }], capacity: null, present: true, error: null },
  ];
  const t = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds }), NM, {});
  assert.ok(t.action.kind === "unloadOre" && t.action.itemIDs.includes(42));
});

test("deliver: an empty ore hold is DONE even with cargo aboard", () => {
  const holds: MiningHold[] = [
    { key: "ore", label: "Ore Hold", items: [], capacity: null, present: true, error: null },
    { key: "cargo", label: "Cargo Hold", items: [{ itemID: 99, typeID: 3389, groupID: 483, categoryID: 8, quantity: 4 }], capacity: null, present: true, error: null },
  ];
  const t = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), holds }), NM, {});
  assert.equal(t.outcome.kind, "done", "the trip delivered its ore; the cargo hold is not its business");
});

test("deliver: in space, away from the station -> ride the autopilot there (multi-system)", () => {
  const t = deliver(haulStep, obs({ snapshot: snapshot([]) }), NM, {});
  assert.ok(t.action.kind === "startRoute" && t.action.stationID === 60000004);
});

test("deliver: docked at the WRONG station -> not done, heads for the right one", () => {
  const t = deliver(haulStep, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000099 }), snapshot: null }), NM, {});
  assert.ok(t.action.kind === "startRoute" && t.action.stationID === 60000004);
});

test("deliver: drones out -> recall them first (never abandon them)", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), NM, {});
  assert.ok(t.action.kind === "recallDrones" && t.action.droneIDs.includes(111));
  assert.equal(t.nextMem["recalled"], true);
});

test("deliver: recalled but still out -> align out toward the station while they come home", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  // The station is ON THIS GRID, so the wait is spent already aligned toward it.
  const station = entity({ itemID: 60000004, kind: "station", position: { x: 900000, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone, station]), dronesOut: true }), { recalled: true }, {});
  assert.ok(t.action.kind === "align" && t.action.targetID === 60000004);
});

test("deliver: recalled, station OFF-grid -> no align (nothing to align to), just hold", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), { recalled: true }, {});
  assert.equal(t.action.kind, "wait");
});

test("deliver: recalled + aligned, still out -> hold until they're all in", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), { recalled: true, aligned: true, recallWaited: 1 }, {});
  assert.equal(t.action.kind, "wait");
});

test("deliver: 0 drones in space -> head out", () => {
  const t = deliver(haulStep, obs({ snapshot: snapshot([]), dronesOut: false }), { recalled: true, aligned: true, recallWaited: 3 }, {});
  assert.ok(t.action.kind === "startRoute" && t.action.stationID === 60000004);
});

test("deliver: drones never make it home -> leave anyway once the wait is spent", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = deliver(haulStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), { recalled: true, aligned: true, recallWaited: 999 }, {});
  assert.ok(t.action.kind === "startRoute" && t.action.stationID === 60000004);
});

const defendStep = { id: "d", kind: "macro", macro: "defend-with-drones", args: {} } as const;
const pirate = () => entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });

test("defend: a pirate and combat drones in the bay, none out -> launch ONLY the combat drones", () => {
  // A mixed bay: two Hobgoblins and a Salvage Drone. The salvage drone stays in.
  const t = defend(defendStep, obs({ snapshot: snapshot([pirate()]), dronesOut: false, droneBayItemIDs: [111, 112, 113], combatDroneBayItemIDs: [111, 112], salvageDroneBayItemIDs: [113] }), NM, {});
  assert.ok(t.action.kind === "launchDrones");
  assert.deepEqual(t.action.droneItemIDs, [111, 112]);
});

test("defend: a bay of salvage drones is NOT a defence -> blocked with a plain reason", () => {
  const t = defend(defendStep, obs({ snapshot: snapshot([pirate()]), dronesOut: false, droneBayItemIDs: [113], combatDroneBayItemIDs: [], salvageDroneBayItemIDs: [113] }), NM, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /no combat drones/i);
});

test("defend: salvage drones out, combat drones in the bay -> call the salvage drones in first, launch once they are home", () => {
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const world = (out: SpaceEntity[]) =>
    obs({ snapshot: snapshot([pirate(), ...out]), dronesOut: out.length > 0, droneBayItemIDs: [111], combatDroneBayItemIDs: [111], salvageDroneBayItemIDs: [], combatDroneIDs: [], salvageDroneIDs: out.map((e) => e.itemID) });
  // Tick 1: the salvage drone holds the slot — recall it, not the bay.
  const recall = defend(defendStep, world([salvager]), {}, {});
  assert.ok(recall.action.kind === "recallDrones" && recall.action.droneIDs.includes(113));
  // Tick 2: still coming home — wait, do not spam the launch.
  const wait = defend(defendStep, world([salvager]), recall.nextMem, {});
  assert.equal(wait.action.kind, "wait");
  assert.equal(wait.outcome.kind, "acting");
  // Tick 3: home — the combat drones go out.
  const launch = defend(defendStep, world([]), wait.nextMem, {});
  assert.ok(launch.action.kind === "launchDrones");
  assert.deepEqual(launch.action.droneItemIDs, [111]);
});

test("defend: a mixed flight out -> only the combat drones are sent onto the pirate", () => {
  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = defend(defendStep, obs({ snapshot: snapshot([pirate(), hob, salvager]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [113] }), NM, {});
  assert.ok(t.action.kind === "engageDrones" && t.action.targetID === 6661);
  assert.deepEqual(t.action.droneIDs, [111]);
});

test("defend: the launch is bounded — a bay that will not launch blocks rather than spinning", () => {
  const t = defend(defendStep, obs({ snapshot: snapshot([pirate()]), dronesOut: false, combatDroneBayItemIDs: [111] }), { launchTries: 3 }, {});
  assert.equal(t.outcome.kind, "blocked");
});

test("defend: pirate dead but drones still out -> recall them, not done yet", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = defend({ id: "d", kind: "macro", macro: "defend-with-drones", args: {} }, obs({ snapshot: snapshot([drone]), dronesOut: true }), NM, {});
  assert.ok(t.action.kind === "recallDrones" && t.action.droneIDs.includes(111));
  assert.notEqual(t.outcome.kind, "done");
});

test("travel-to-station: rides the shared autopilot (multi-system) and is done only at the TARGET", () => {
  const travelTo = SCRIPT_MACROS["travel-to-station"]!;
  const s: MacroStep = { id: "t", kind: "macro", macro: "travel-to-station", args: { station: { kind: "station", ref: { entity: "station", id: 60000007, name: "Far", systemName: null } } } };

  // In space, target off-grid -> hand the trip to the autopilot.
  const go = travelTo(s, obs({ snapshot: snapshot([]) }), {}, {});
  assert.ok(go.action.kind === "startRoute" && go.action.stationID === 60000007);

  // The autopilot flying it -> wait, don't re-issue.
  const riding = travelTo(
    s,
    obs({ snapshot: snapshot([]), travel: { status: "running", destinationStationID: 60000007, remainingJumps: 3, failureReason: null } }),
    {},
    {},
  );
  assert.equal(riding.action.kind, "wait");

  // Docked SOMEWHERE ELSE is not arrived — it heads out again.
  const wrongStation = travelTo(s, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000004 }), snapshot: null }), {}, {});
  assert.ok(wrongStation.action.kind === "startRoute");

  // Docked at the target -> done.
  const arrived = travelTo(s, obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60000007 }), snapshot: null }), {}, {});
  assert.equal(arrived.outcome.kind, "done");

  // A STALE failure from an old route does not block a fresh trip.
  const staleFailure = travelTo(
    s,
    obs({ snapshot: snapshot([]), travel: { status: "idle", destinationStationID: 60000099, remainingJumps: 0, failureReason: "old news" } }),
    {},
    {},
  );
  assert.ok(staleFailure.action.kind === "startRoute", "a failure on ANOTHER destination is ignored");
});

// ── travel-to-system ─────────────────────────────────────────────────────────
//
// The block exists because set-destination does NOT wait, and a bot whose next
// step reads the grid stops the run when it starts two gates early. These tests
// pin the one property that difference lives in: arrival, and only arrival,
// finishes it.

const HOME_SYSTEM = 30000142;
const FAR_SYSTEM = 30000144;
const flyToSystem = SCRIPT_MACROS["travel-to-system"]!;
const systemStep: MacroStep = {
  id: "ts",
  kind: "macro",
  macro: "travel-to-system",
  args: { system: { kind: "system", ref: { entity: "system", id: FAR_SYSTEM, name: "Far", systemName: "Far" } } },
};

test("travel-to-system: rides the shared autopilot and is done ONLY once the ship is in the system", () => {
  // Elsewhere -> hand the trip to the autopilot's system plan (no final dock).
  const go = flyToSystem(systemStep, obs({ snapshot: snapshot([]) }), {}, {});
  assert.ok(go.action.kind === "startSystemRoute" && go.action.systemID === FAR_SYSTEM);
  assert.notEqual(go.outcome.kind, "done");

  // Under way -> wait, never re-issue the route every tick.
  const riding = flyToSystem(
    systemStep,
    obs({ snapshot: snapshot([]), travel: { status: "running", destinationSystemID: FAR_SYSTEM, destinationStationID: null, remainingJumps: 2, failureReason: null } }),
    {},
    {},
  );
  assert.equal(riding.action.kind, "wait");
  assert.notEqual(riding.outcome.kind, "done");

  // ⚠ THE WHOLE POINT. Mid-route, one gate short, is NOT arrived — this is the
  // tick where set-destination would already have handed the next block a grid
  // in the wrong system.
  const oneGateShort = flyToSystem(systemStep, obs({ flightStatus: flight({ solarSystemID: 30000148 }), snapshot: snapshot([]) }), {}, {});
  assert.notEqual(oneGateShort.outcome.kind, "done");

  // There -> done.
  const arrived = flyToSystem(systemStep, obs({ flightStatus: flight({ solarSystemID: FAR_SYSTEM }), snapshot: snapshot([]) }), {}, {});
  assert.equal(arrived.outcome.kind, "done");
});

test("travel-to-system: DOCKED in the destination system counts as arrived", () => {
  // The autopilot's own system plan treats a dock in the destination system as
  // arrival and will not undock for it, so a stricter rule here would hang
  // forever. A program that needs to be in space says so with an undock block.
  const dockedThere = flyToSystem(
    systemStep,
    obs({ flightStatus: flight({ docked: true, inSpace: false, solarSystemID: FAR_SYSTEM, stationID: 60000007 }), snapshot: null }),
    {},
    {},
  );
  assert.equal(dockedThere.outcome.kind, "done");
});

test("travel-to-system: a failure on THIS trip blocks; a stale one from another does not", () => {
  const failed = flyToSystem(
    systemStep,
    obs({ snapshot: snapshot([]), travel: { status: "idle", destinationSystemID: FAR_SYSTEM, destinationStationID: null, remainingJumps: 0, failureReason: "Off route" } }),
    {},
    {},
  );
  assert.equal(failed.outcome.kind, "blocked");

  const stale = flyToSystem(
    systemStep,
    obs({ snapshot: snapshot([]), travel: { status: "idle", destinationSystemID: HOME_SYSTEM, destinationStationID: null, remainingJumps: 0, failureReason: "old news" } }),
    {},
    {},
  );
  assert.ok(stale.action.kind === "startSystemRoute", "a failure on ANOTHER destination is ignored");
});

test("travel-to-system: drones out come home before the ship warps off", () => {
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = flyToSystem(systemStep, obs({ snapshot: snapshot([drone]), dronesOut: true }), {}, {});
  assert.ok(t.action.kind === "recallDrones" && t.action.droneIDs.includes(111));
});

test("travel-to-system: an unpicked system blocks instead of flying somewhere arbitrary", () => {
  const unbound: MacroStep = {
    id: "ts",
    kind: "macro",
    macro: "travel-to-system",
    args: { system: { kind: "system", ref: { entity: "system", id: null, name: null, systemName: null } } },
  };
  assert.equal(flyToSystem(unbound, obs({ snapshot: snapshot([]) }), {}, {}).outcome.kind, "blocked");
});

test("salvage: wrecks + drones out -> set them salvaging (auto-pick); grid clean -> recall, then done", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", name: "Wreck", position: { x: 3000, y: 0, z: 0 } });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });

  const sweep = salvage(s, obs({ snapshot: snapshot([wreck, drone]), dronesOut: true, salvageDroneIDs: [111] }), {}, {});
  assert.ok(sweep.action.kind === "salvageDrones" && sweep.action.targetID === 0 && sweep.action.droneIDs.includes(111));

  const recall = salvage(s, obs({ snapshot: snapshot([drone]), dronesOut: true, salvageDroneIDs: [111] }), {}, {});
  assert.ok(recall.action.kind === "recallDrones");

  const done = salvage(s, obs({ snapshot: snapshot([]) }), {}, {});
  assert.equal(done.outcome.kind, "done");
});

test("salvage: a mixed flight out -> only the SALVAGE drones get the order; the combat drones are left alone", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = salvage(s, obs({ snapshot: snapshot([wreck, hob, salvager]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [113] }), {}, {});
  assert.ok(t.action.kind === "salvageDrones");
  assert.deepEqual(t.action.droneIDs, [113]);
  // Grid swept: EVERY drone comes home, whatever it is.
  const recall = salvage(s, obs({ snapshot: snapshot([hob, salvager]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [113] }), {}, {});
  assert.ok(recall.action.kind === "recallDrones");
  assert.deepEqual([...recall.action.droneIDs].sort(), [111, 113]);
});

test("salvage: combat drones out from the fight, salvage drones in the bay -> call the combat drones in, then launch ONLY the salvage drones", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const world = (out: SpaceEntity[]) =>
    obs({
      snapshot: snapshot([wreck, ...out]),
      dronesOut: out.length > 0,
      droneBayItemIDs: [112, 113],
      combatDroneBayItemIDs: [112],
      salvageDroneBayItemIDs: [113],
      combatDroneIDs: out.map((e) => e.itemID),
      salvageDroneIDs: [],
    });
  const recall = salvage(s, world([hob]), {}, {});
  assert.ok(recall.action.kind === "recallDrones" && recall.action.droneIDs.includes(111), "the Hobgoblin goes home first");
  const wait = salvage(s, world([hob]), recall.nextMem, {});
  assert.equal(wait.action.kind, "wait");
  assert.equal(wait.outcome.kind, "acting", "still working — not blocked, not done");
  const launch = salvage(s, world([]), wait.nextMem, {});
  assert.ok(launch.action.kind === "launchDrones");
  assert.deepEqual(launch.action.droneItemIDs, [113], "the Hobgoblin stays in the bay");
});

test("salvage: a bay of combat drones and no salvager is NO way to salvage -> skipped", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const t = salvage(s, obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [], droneBayItemIDs: [111, 112], combatDroneBayItemIDs: [111, 112], salvageDroneBayItemIDs: [] }), {}, {});
  assert.equal(t.outcome.kind, "skipped");
  assert.match(t.outcome.kind === "skipped" ? t.outcome.reason : "", /no salvage drones/i);
});

test("salvage: combat drones out, nothing that can salvage -> skipped, and it says why", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = salvage(s, obs({ snapshot: snapshot([wreck, hob]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [], salvageDroneBayItemIDs: [] }), {}, {});
  assert.equal(t.outcome.kind, "skipped");
  assert.match(t.outcome.kind === "skipped" ? t.outcome.reason : "", /cannot salvage/i);
});

test("salvage: no drones, salvager fitted -> approach, lock, run it on the wreck", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });

  const go = salvage(s, obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [800] }), {}, {});
  assert.ok(go.action.kind === "approach" && go.action.targetID === 70001);

  const run = salvage(
    s,
    obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [800], lockedTargetIDs: [70001] }),
    { wreckID: 70001, lockIssued: true, waited: 0 },
    {},
  );
  assert.ok(run.action.kind === "activate" && run.action.moduleID === 800 && run.action.targetID === 70001);
});

test("salvage: nothing to salvage with -> SKIPPED with a plain reason, not a stop", () => {
  const salvage = SCRIPT_MACROS["salvage-wrecks"]!;
  const s = { id: "sv", kind: "macro", macro: "salvage-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", position: { x: 3000, y: 0, z: 0 } });
  const t = salvage(s, obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [], droneBayItemIDs: [] }), {}, {});
  assert.equal(t.outcome.kind, "skipped");
  assert.match(t.outcome.kind === "skipped" ? t.outcome.reason : "", /no salvage drones in the bay and no salvager fitted/);
  // A bay stack whose group could not be read is NAMED, not passed off as an empty bay.
  const unread = salvage(s, obs({ snapshot: snapshot([wreck]), salvageModuleIDs: [], droneBayItemIDs: [111], salvageDroneBayItemIDs: [], unclassifiedDroneBayItemIDs: [111] }), {}, {});
  assert.equal(unread.outcome.kind, "skipped");
  assert.match(unread.outcome.kind === "skipped" ? unread.outcome.reason : "", /could not be identified/);
});

test("loot: only YOUR wrecks are ever opened — others' and unknown-owner wrecks never", () => {
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const mine = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 1000, y: 0, z: 0 } });
  const theirs = entity({ itemID: 70002, kind: "wreck", ownerID: 555, position: { x: 500, y: 0, z: 0 } });
  const unknown = entity({ itemID: 70003, kind: "wreck", ownerID: null, position: { x: 200, y: 0, z: 0 } });

  // Mine is FARTHEST, yet it is the only one this block will ever touch.
  const t = loot(s, obs({ snapshot: snapshot([mine, theirs, unknown]), myCharacterID: 90000001 }), {}, {});
  assert.ok(t.action.kind === "lootWreck" && t.action.wreckID === 70001);

  // Nothing of ours left -> done, with the other wrecks still on grid untouched.
  const done = loot(s, obs({ snapshot: snapshot([theirs, unknown]), myCharacterID: 90000001 }), {}, {});
  assert.equal(done.outcome.kind, "done");
});

test("loot: far from your wreck -> approach first; looted wrecks are not reopened", () => {
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const far = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 90000, y: 0, z: 0 } });

  const go = loot(s, obs({ snapshot: snapshot([far]), myCharacterID: 90000001 }), {}, {});
  assert.ok(go.action.kind === "approach" && go.action.targetID === 70001);

  const skip = loot(s, obs({ snapshot: snapshot([far]), myCharacterID: 90000001 }), { looted: [70001] }, {});
  assert.equal(skip.outcome.kind, "done", "an already-looted wreck is never reopened");
});

test("loot-containers: any container is fair game, no ownership check", () => {
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const mine = entity({ itemID: 80001, kind: "container", ownerID: 90000001, position: { x: 1000, y: 0, z: 0 } });
  const theirs = entity({ itemID: 80002, kind: "container", ownerID: 555, position: { x: 500, y: 0, z: 0 } });
  const unknown = entity({ itemID: 80003, kind: "container", ownerID: null, position: { x: 200, y: 0, z: 0 } });

  // Nearest wins regardless of owner — unlike loot-wrecks, nothing here is off limits.
  const t = loot(s, obs({ snapshot: snapshot([mine, theirs, unknown]), myCharacterID: 90000001 }), {}, {});
  assert.ok(t.action.kind === "lootContainer" && t.action.containerID === 80003);

  // Nothing left, and the settle window (see the dedicated test below) has
  // already run out -> done.
  const done = loot(
    s,
    obs({ snapshot: snapshot([]), myCharacterID: 90000001 }),
    { emptyChecks: 30 },
    {},
  );
  assert.equal(done.outcome.kind, "done");
});

test("loot-containers: an empty read right after arrival waits out a settle window instead of leaving immediately", () => {
  // No natural pause the way a player starting the bot by hand gets — landing
  // on a belt and checking for containers on the very next tick can read one
  // tick ahead of a not-yet-caught-up snapshot. A single empty read must not
  // send the bot straight back to the station.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;

  const firstCheck = loot(s, obs({ snapshot: snapshot([]) }), {}, {});
  assert.equal(firstCheck.action.kind, "wait");
  assert.notEqual(firstCheck.outcome.kind, "done", "one empty read is not proof the grid never had a can");
  assert.equal(firstCheck.nextMem["emptyChecks"], 1);

  // A can showing up mid-window resets the count and gets worked normally.
  const can = entity({ itemID: 80001, kind: "container", position: { x: 90000, y: 0, z: 0 } });
  const found = loot(s, obs({ snapshot: snapshot([can]) }), firstCheck.nextMem, {});
  assert.ok(found.action.kind === "approach" && found.action.targetID === 80001);
  assert.equal(found.nextMem["emptyChecks"], 0);

  // Genuinely nothing there for the whole window -> done, not stuck forever.
  const stillEmpty = loot(s, obs({ snapshot: snapshot([]) }), { emptyChecks: 30 }, {});
  assert.equal(stillEmpty.outcome.kind, "done");
});

test("loot-containers: far from a container -> approach first", () => {
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const far = entity({ itemID: 80001, kind: "container", position: { x: 90000, y: 0, z: 0 } });

  const go = loot(s, obs({ snapshot: snapshot([far]) }), {}, {});
  assert.ok(go.action.kind === "approach" && go.action.targetID === 80001);
});

/** One entry as the run's refusal ledger would report it. */
function refusal(
  stepID: string,
  actionKind: string,
  targetID: number,
  count: number,
  kind: "refused" | "unreachable" | "gone" = "refused",
) {
  return {
    key: `${stepID}:${actionKind}:${targetID}`,
    count,
    firstAt: 0,
    lastAt: 0,
    words: "There isn't enough room in that hold.",
    kind,
  };
}

test("loot-containers: still on grid after a loot attempt -> tried again, never silently believed emptied", () => {
  // A jetcan the server has not despawned is a jetcan that is NOT actually
  // empty yet (jettisonRuntime.js's maybeExpireEmptySpaceContainer despawns it
  // the instant it truly is) — so seeing it again next tick means the transfer
  // likely declined, and the block has to retry rather than trust its own
  // "I already issued the action" memory and move on leaving the ore behind.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 1000, y: 0, z: 0 } });

  const retry = loot(s, obs({ snapshot: snapshot([can]), refusals: [refusal("lc", "lootContainer", 80001, 1)] }), {}, {});
  assert.ok(retry.action.kind === "lootContainer" && retry.action.containerID === 80001);
});

test("loot-containers: a can that keeps refusing is set aside — and the bound SURVIVES the lap", () => {
  // The bound now lives on the RUN's ledger, not in step memory. That is the
  // whole change: `scriptDecide` drops step memory every time the block is left,
  // so the old `tries` counter handed each stubborn can a fresh five attempts on
  // every lap of a `forever` loop — which is exactly why the original log shows
  // repeating bursts of five instead of one burst and then silence.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const stuck = entity({ itemID: 80001, kind: "container", position: { x: 1000, y: 0, z: 0 } });
  const other = entity({ itemID: 80002, kind: "container", position: { x: 2000, y: 0, z: 0 } });
  const ledger = [refusal("lc", "lootContainer", 80001, 5)];

  // Set aside, so a different can on the grid is picked instead.
  const next = loot(s, obs({ snapshot: snapshot([stuck, other]), refusals: ledger }), {}, {});
  assert.ok(next.action.kind === "lootContainer" && next.action.containerID === 80002);

  // ⚠ WITH FRESH MEMORY — a new lap. The old counter lived here and was wiped;
  // the ledger is not, so the can stays set aside.
  const nextLap = loot(s, obs({ snapshot: snapshot([stuck, other]), refusals: ledger }), {}, {});
  assert.ok(nextLap.action.kind === "lootContainer" && nextLap.action.containerID === 80002);

  // And with only the stuck can on grid, the block finishes rather than looping.
  const alone = loot(s, obs({ snapshot: snapshot([stuck]), refusals: ledger }), { emptyChecks: 99 }, {});
  assert.equal(alone.outcome.kind, "done");
});

/** Holds with a given amount of free room, as the mining-holds read reports it. */
function holdsWithFree(freeM3: number) {
  return [
    { key: "ore", label: "Ore hold", items: [], capacity: { capacity: 16000, used: 16000 - freeM3 }, present: true, error: null },
    { key: "cargo", label: "Cargo hold", items: [], capacity: { capacity: 0, used: 0 }, present: false, error: null },
  ];
}

test("loot-containers: a FULL ship finishes the block instead of reaching into the can", () => {
  // With nowhere to put anything there is nothing to attempt. Asking anyway is
  // the refusal loop; stopping the whole bot over it is not much better.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const t = loot(s, obs({ snapshot: snapshot([can]), holds: holdsWithFree(0) as never }), {}, {});
  assert.equal(t.outcome.kind, "done");
  assert.match(t.why, /full/i);
});

test("loot-containers: room left -> it still loots", () => {
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const t = loot(s, obs({ snapshot: snapshot([can]), holds: holdsWithFree(500) as never }), {}, {});
  assert.ok(t.action.kind === "lootContainer");
});

test("loot-containers: holds that could not be READ are never taken for full", () => {
  // "We could not look" is not "there is no room" — the block carries on and
  // lets the transfer decide, exactly as it did before.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const t = loot(s, obs({ snapshot: snapshot([can]), holds: null }), {}, {});
  assert.ok(t.action.kind === "lootContainer");
});

test("loot-wrecks: a FULL ship finishes the block too", () => {
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 10, y: 0, z: 0 } });
  const t = loot(
    s,
    obs({ snapshot: snapshot([wreck]), myCharacterID: 90000001, holds: holdsWithFree(0) as never }),
    {},
    {},
  );
  assert.equal(t.outcome.kind, "done");
});

test("loot-containers: the FIRST no-room ends the block — it is not proved once per can", () => {
  // The failure this closes: the ore hold is full after mining, the cans hold
  // ore, and ore does not fall through to cargo. Every can then answers "no
  // room", and the block spent five attempts with a growing backoff on EACH
  // before setting it aside. With a belt full of cans that is minutes of a bot
  // doing nothing, which is indistinguishable from a hang.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const a = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const b = entity({ itemID: 80002, kind: "container", position: { x: 20, y: 0, z: 0 } });
  const noRoom = {
    key: "lc:lootContainer:80001",
    count: 1,
    firstAt: 0,
    lastAt: 0,
    words: "There is no room aboard for what is in that container.",
    kind: "no-room" as const,
  };
  // The ship is NOT full by the block's own measure — the cargo hold has room,
  // it is the ore hold that does not — so only the no-room record can end this.
  const t = loot(s, obs({ snapshot: snapshot([a, b]), refusals: [noRoom] }), {}, {});
  assert.equal(t.outcome.kind, "done", "one refusal answers for the whole belt");
  assert.match(t.why, /unload/i);
});

test("loot-wrecks: the same, so a full ship stops looting wrecks too", () => {
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 10, y: 0, z: 0 } });
  const noRoom = {
    key: "lw:lootWreck:70001",
    count: 1,
    firstAt: 0,
    lastAt: 0,
    words: "There is no room aboard for what is in that container.",
    kind: "no-room" as const,
  };
  const t = loot(s, obs({ snapshot: snapshot([wreck]), myCharacterID: 90000001, refusals: [noRoom] }), {}, {});
  assert.equal(t.outcome.kind, "done");
});

test("loot-containers: a can that CANNOT BE REACHED is closed in on, never set aside", () => {
  // eve.js answers the same FakeItemNotFound for a despawned can and for one
  // merely out of range. Retiring on that would abandon every can the ship
  // drifted away from — most of them, on a hauling loop.
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const can = entity({ itemID: 80001, kind: "container", position: { x: 10, y: 0, z: 0 } });
  const t = loot(
    s,
    obs({ snapshot: snapshot([can]), refusals: [refusal("lc", "lootContainer", 80001, 9, "unreachable")] }),
    {},
    {},
  );
  // In range by our own arithmetic, and it still closes in: the gateway's range
  // check beats the snapshot's.
  assert.ok(t.action.kind === "approach" && t.action.targetID === 80001);
});

test("loot-containers: a can that is GONE is set aside at once, without spending the budget", () => {
  const loot = SCRIPT_MACROS["loot-containers"]!;
  const s = { id: "lc", kind: "macro", macro: "loot-containers", args: {} } as const;
  const ghost = entity({ itemID: 80001, kind: "container", position: { x: 1000, y: 0, z: 0 } });
  const real = entity({ itemID: 80002, kind: "container", position: { x: 2000, y: 0, z: 0 } });
  const t = loot(
    s,
    obs({ snapshot: snapshot([ghost, real]), refusals: [refusal("lc", "lootContainer", 80001, 1, "gone")] }),
    {},
    {},
  );
  assert.ok(t.action.kind === "lootContainer" && t.action.containerID === 80002);
});

test("loot-wrecks: a wreck is marked emptied only once the attempt was NOT refused", () => {
  // It used to be marked the instant the action went out, which believed a
  // refused transfer exactly as readily as a real one — the behaviour
  // loot-containers' own comment calls out and this block never fixed.
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const s = { id: "lw", kind: "macro", macro: "loot-wrecks", args: {} } as const;
  const wreck = entity({ itemID: 70001, kind: "wreck", ownerID: 90000001, position: { x: 10, y: 0, z: 0 } });
  const world = { snapshot: snapshot([wreck]), myCharacterID: 90000001 };

  const issued = loot(s, obs(world), {}, {});
  assert.ok(issued.action.kind === "lootWreck" && issued.action.wreckID === 70001);
  assert.equal(issued.nextMem["attempted"], 70001, "remembered as ATTEMPTED, not as emptied");
  assert.deepEqual(issued.nextMem["looted"], [], "nothing is claimed emptied yet");

  // Next tick with NO refusal recorded: the attempt stood, so the wreck is
  // ticked off — and with nothing else of ours on the grid, the block finishes.
  const confirmed = loot(s, obs(world), issued.nextMem, {});
  assert.equal(confirmed.outcome.kind, "done");

  // The other branch: the attempt WAS refused, so the wreck is NOT ticked off
  // and the block tries it again instead of declaring the grid clear.
  const refused = loot(
    s,
    obs({ ...world, refusals: [refusal("lw", "lootWreck", 70001, 1)] }),
    issued.nextMem,
    {},
  );
  assert.notEqual(refused.outcome.kind, "done", "a refused wreck is not ticked off");
  assert.ok(refused.action.kind === "lootWreck", "it tries again");
});

test("hardeners-on: switches idle hardeners on one per tick; all running -> done; none fitted -> blocked", () => {
  const hardeners = SCRIPT_MACROS["hardeners-on"]!;
  const s = { id: "hd", kind: "macro", macro: "hardeners-on", args: {} } as const;

  const on = hardeners(s, obs({ snapshot: snapshot([], { activeModuleIDs: [] }), hardenerModuleIDs: [900, 901] }), {}, {});
  assert.ok(on.action.kind === "activate" && on.action.moduleID === 900 && on.action.targetID === 0);

  const done = hardeners(s, obs({ snapshot: snapshot([], { activeModuleIDs: [900, 901] }), hardenerModuleIDs: [900, 901] }), {}, {});
  assert.equal(done.outcome.kind, "done");

  const none = hardeners(s, obs({ snapshot: snapshot([]), hardenerModuleIDs: [] }), {}, {});
  assert.equal(none.outcome.kind, "blocked");
});

// ─── Fighting the way out of a tackle ────────────────────────────────────────
//
// The one that cost four ships: shields dropped, the watch latched and told the
// ship to run, the rat had it scrambled so the warp was refused, the autopilot
// paused with that refusal — and the bot sat still in the belt with its guns off
// until it died. A ship that cannot leave has to fight.

const HOME = 60000004;
/** The travel reading the autopilot leaves behind when a warp is refused. */
const scrambled = {
  status: "paused" as const,
  destinationStationID: HOME,
  remainingJumps: 2,
  failureReason: "Warp refused: you are being warp scrambled.",
};

test("tackled: a refused trip home is fought, not sat through", () => {
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });

  // The tank goes up first — one hardener per tick, same as everywhere else.
  const harden = scriptTravelHome(
    obs({ snapshot: snapshot([rat]), travel: scrambled, homeStationID: HOME, hardenerModuleIDs: [40], weaponModuleIDs: [500] }),
    {},
  );
  assert.equal(harden.outcome.kind, "acting", "it must NOT report blocked and stop");
  assert.ok(harden.action.kind === "activate" && harden.action.moduleID === 40, "hardener on");
  assert.equal(harden.phase, "Fighting free");

  // Hardened: now shoot whatever is holding the ship.
  const fight = scriptTravelHome(
    obs({
      snapshot: snapshot([rat], { activeModuleIDs: [40] }),
      travel: scrambled,
      homeStationID: HOME,
      hardenerModuleIDs: [40],
      weaponModuleIDs: [500],
    }),
    harden.nextMem,
  );
  assert.ok(fight.action.kind === "lock" && fight.action.targetID === 6661, "locks the tackler");
  assert.equal(fight.outcome.kind, "acting");
});

test("tackled: once the grid is clear the trip home is asked for again", () => {
  // The autopilot's failure is sticky, so a cleared grid alone would leave the
  // trip blocked forever. The escape re-issues the route, which resets it.
  const clear = scriptTravelHome(
    obs({ snapshot: snapshot([]), travel: scrambled, homeStationID: HOME, hardenerModuleIDs: [40] }),
    { escaping: true, recalled: true },
  );
  assert.ok(clear.action.kind === "startRoute" && clear.action.stationID === HOME);
  assert.equal(clear.nextMem["escaping"], false);
  assert.equal(clear.nextMem["escapeTries"], 1);
  assert.equal(clear.nextMem["recalled"], false, "the drones are called in again before the next warp");
});

test("tackled: the escape is bounded — a trip that keeps failing eventually stops", () => {
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const spent = scriptTravelHome(
    obs({ snapshot: snapshot([rat]), travel: scrambled, homeStationID: HOME, weaponModuleIDs: [500] }),
    { escapeTries: 3 },
  );
  assert.equal(spent.outcome.kind, "blocked", "three cleared grids is enough");
  assert.match(spent.outcome.kind === "blocked" ? spent.outcome.reason : "", /could not be finished/i);
});

test("tackled: a blocked trip with nothing to shoot still stops honestly", () => {
  const nothing = scriptTravelHome(
    obs({ snapshot: snapshot([]), travel: scrambled, homeStationID: HOME }),
    {},
  );
  assert.equal(nothing.outcome.kind, "blocked", "no fight was started, so there is nothing to retry");
});

test("tackled: a hull with no way to fight stops rather than pretending", () => {
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const unarmed = scriptTravelHome(
    obs({ snapshot: snapshot([rat]), travel: scrambled, homeStationID: HOME, weaponModuleIDs: [], combatDroneBayItemIDs: [] }),
    {},
  );
  assert.equal(unarmed.outcome.kind, "blocked");
});

test("a trip home that is NOT blocked is untouched by the escape", () => {
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  // Rats on grid, but the autopilot is flying fine: keep flying, do not brawl.
  const flying = scriptTravelHome(
    obs({
      snapshot: snapshot([rat]),
      travel: { status: "running", destinationStationID: HOME, remainingJumps: 2, failureReason: null },
      homeStationID: HOME,
      hardenerModuleIDs: [40],
      weaponModuleIDs: [500],
    }),
    {},
  );
  assert.equal(flying.action.kind, "wait");
  assert.match(flying.why, /autopilot has the ship/i);
});

test("fight: locks the NEAREST rat, drones on it, then every idle gun on it", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const near = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 90000, y: 0, z: 0 } });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });

  // First tick: lock the NEAR one (concentrated fire), remember it.
  const lock = fight(s, obs({ snapshot: snapshot([far, near, drone]), dronesOut: true, combatDroneIDs: [111], weaponModuleIDs: [500] }), {}, {});
  assert.ok(lock.action.kind === "lock" && lock.action.targetID === 6661);

  // Locked: drones onto it first…
  const engage = fight(
    s,
    obs({ snapshot: snapshot([near, drone]), dronesOut: true, combatDroneIDs: [111], lockedTargetIDs: [6661], weaponModuleIDs: [500] }),
    { targetID: 6661, lockIssued: true, waited: 0, dronesOn: null },
    {},
  );
  assert.ok(engage.action.kind === "engageDrones" && engage.action.targetID === 6661);

  // …then the idle gun.
  const guns = fight(
    s,
    obs({ snapshot: snapshot([near, drone]), dronesOut: true, lockedTargetIDs: [6661], weaponModuleIDs: [500] }),
    { targetID: 6661, lockIssued: true, waited: 0, dronesOn: 6661 },
    {},
  );
  assert.ok(guns.action.kind === "activate" && guns.action.moduleID === 500 && guns.action.targetID === 6661);
});

test("fight: target died -> next rat; grid clear -> recall drones, then done", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const remaining = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 90000, y: 0, z: 0 } });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });

  // 6661 died: pick + lock 6662.
  const next = fight(s, obs({ snapshot: snapshot([remaining, drone]), dronesOut: true, weaponModuleIDs: [500] }), { targetID: 6661, lockIssued: true, waited: 0, dronesOn: 6661 }, {});
  assert.ok(next.action.kind === "lock" && next.action.targetID === 6662);

  // All dead, drones out -> recall; drones home -> done.
  const recall = fight(s, obs({ snapshot: snapshot([drone]), dronesOut: true }), {}, {});
  assert.ok(recall.action.kind === "recallDrones");
  const done = fight(s, obs({ snapshot: snapshot([]) }), {}, {});
  assert.equal(done.outcome.kind, "done");
});

test("fight: a rat beyond the hull's targeting range is not a target at all", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const near = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 90000, y: 0, z: 0 } });

  // 30 km of lock range: the near rat is fair game, the far one is invisible to
  // the ladder — so it does not burn ticks locking something it cannot reach.
  const inRange = fight(
    s,
    obs({ snapshot: snapshot([far, near]), dronesOut: true, weaponModuleIDs: [500], maxTargetRangeM: 30_000 }),
    {},
    {},
  );
  assert.ok(inRange.action.kind === "lock" && inRange.action.targetID === 6661);

  // Only the far one left: nothing is reachable, so the block FINISHES rather
  // than locking-and-giving-up forever. As a watch response, that hands the ship
  // back to the step under it.
  const unreachable = fight(
    s,
    obs({ snapshot: snapshot([far]), weaponModuleIDs: [500], maxTargetRangeM: 30_000 }),
    {},
    {},
  );
  assert.equal(unreachable.outcome.kind, "done");
});

test("fight: an unreadable targeting range does NOT gate — the bounded lock stays the backstop", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const far = entity({ itemID: 6662, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 900000, y: 0, z: 0 } });
  const t = fight(s, obs({ snapshot: snapshot([far]), dronesOut: true, weaponModuleIDs: [500] }), {}, {});
  assert.ok(t.action.kind === "lock" && t.action.targetID === 6662);
});

test("fight: no guns and no drones -> blocked with a plain reason", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const t = fight(s, obs({ snapshot: snapshot([rat]), weaponModuleIDs: [], droneBayItemIDs: [] }), {}, {});
  assert.equal(t.outcome.kind, "blocked");
  // A bay of salvage drones is no way to fight either.
  const salvageOnly = fight(s, obs({ snapshot: snapshot([rat]), weaponModuleIDs: [], droneBayItemIDs: [113], combatDroneBayItemIDs: [], salvageDroneBayItemIDs: [113] }), {}, {});
  assert.equal(salvageOnly.outcome.kind, "blocked");
});

test("fight: a mixed bay -> only the COMBAT drones are launched; a mixed flight -> only they are set on the rat", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const launch = fight(s, obs({ snapshot: snapshot([rat]), dronesOut: false, droneBayItemIDs: [111, 113], combatDroneBayItemIDs: [111], salvageDroneBayItemIDs: [113] }), {}, {});
  assert.ok(launch.action.kind === "launchDrones");
  assert.deepEqual(launch.action.droneItemIDs, [111]);

  const hob = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const engage = fight(
    s,
    obs({ snapshot: snapshot([rat, hob, salvager]), dronesOut: true, combatDroneIDs: [111], salvageDroneIDs: [113], lockedTargetIDs: [6661], weaponModuleIDs: [500] }),
    { targetID: 6661, lockIssued: true, waited: 0, dronesOn: null },
    {},
  );
  assert.ok(engage.action.kind === "engageDrones");
  assert.deepEqual(engage.action.droneIDs, [111]);
});

test("fight: salvage drones out, combat drones in the bay -> recall the salvage drones, and keep shooting meanwhile", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const s = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const rat = entity({ itemID: 6661, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 5000, y: 0, z: 0 } });
  const salvager = entity({ itemID: 113, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([rat, salvager]), dronesOut: true, combatDroneBayItemIDs: [111], salvageDroneBayItemIDs: [], combatDroneIDs: [], salvageDroneIDs: [113], lockedTargetIDs: [6661], weaponModuleIDs: [500] });
  const recall = fight(s, world, {}, {});
  assert.ok(recall.action.kind === "recallDrones" && recall.action.droneIDs.includes(113));
  // Next tick the salvage drone is still coming home: the ladder does NOT wait on it — the guns go on.
  const guns = fight(s, world, { ...recall.nextMem, targetID: 6661, lockIssued: true, waited: 0, dronesOn: null }, {});
  assert.ok(guns.action.kind === "activate" && guns.action.moduleID === 500, `expected the gun, got ${guns.action.kind}`);
});

test("defend: pirate dead and drones home -> done", () => {
  const t = defend({ id: "d", kind: "macro", macro: "defend-with-drones", args: {} }, obs({ snapshot: snapshot([]), dronesOut: true }), NM, {});
  assert.equal(t.outcome.kind, "done");
});

// ── Named board slots ────────────────────────────────────────────────────────

test("a station arg can point at a BOARD SLOT an earlier block filled in", () => {
  const travel = SCRIPT_MACROS["travel-to-station"]!;
  const slotStep: MacroStep = {
    id: "t",
    kind: "macro",
    macro: "travel-to-station",
    args: { station: { kind: "station", ref: { entity: "station", id: null, name: null, systemName: null, slot: "agent-station" } } },
  };
  // The board says the agent's station is 60009999 — and we are docked there, so
  // the block resolves the slot and reports arrival rather than "no station".
  const docked = obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60009999 }) });
  const done = travel(slotStep, docked, {}, { agentStationID: 60009999 });
  assert.equal(done.outcome.kind, "done", "resolved the slot to the board's station");

  // With the slot UNFILLED the block blocks with a plain reason — never a guess.
  const empty = travel(slotStep, docked, {}, {});
  assert.equal(empty.outcome.kind, "blocked");
});

// ── The market set ───────────────────────────────────────────────────────────

function invRow(over: Partial<import("../store/types.ts").InventoryItemRow> & { itemID: number }): import("../store/types.ts").InventoryItemRow {
  return { typeID: 34, groupID: null, categoryID: null, flagID: null, quantity: 100, singleton: false, ...over };
}

const buy = SCRIPT_MACROS["buy-item"]!;
const sell = SCRIPT_MACROS["sell-item"]!;
const buyStep: MacroStep = {
  id: "b", kind: "macro", macro: "buy-item",
  args: { item: { kind: "itemType", typeID: 34, name: "Tritanium" }, quantity: { kind: "qty", value: 5000 }, price: { kind: "isk", value: 6 } },
};
const sellStep: MacroStep = {
  id: "s", kind: "macro", macro: "sell-item",
  args: { item: { kind: "itemType", typeID: 34, name: "Tritanium" }, price: { kind: "isk", value: 5 } },
};

test("buy-item: docked -> places one buy order, then done; not docked -> blocked", () => {
  const first = buy(buyStep, obs({ flightStatus: flight({ docked: true, inSpace: false }) }), {}, {});
  assert.ok(first.action.kind === "placeBuyOrder" && first.action.typeID === 34 && first.action.quantity === 5000 && first.action.price === 6);
  // The mem it returns marks it placed -> the next tick is done (no double buy).
  const second = buy(buyStep, obs({ flightStatus: flight({ docked: true, inSpace: false }) }), first.nextMem, {});
  assert.equal(second.outcome.kind, "done");
  assert.equal(buy(buyStep, obs({ flightStatus: flight({ docked: false }) }), {}, {}).outcome.kind, "blocked");
});

test("buy-item: an unfilled item/price/quantity -> blocked, never a bad order", () => {
  const bad: MacroStep = { id: "b", kind: "macro", macro: "buy-item", args: { item: { kind: "itemType", typeID: null, name: null }, quantity: { kind: "qty", value: 1 }, price: { kind: "isk", value: 1 } } };
  assert.equal(buy(bad, obs({ flightStatus: flight({ docked: true, inSpace: false }) }), {}, {}).outcome.kind, "blocked");
});

test("sell-item: lists each hangar stack, done when none left; not docked -> blocked", () => {
  const docked = obs({ flightStatus: flight({ docked: true, inSpace: false }), stationHangar: [invRow({ itemID: 111, quantity: 200 }), invRow({ itemID: 222, typeID: 99, quantity: 5 })] });
  const t = sell(sellStep, docked, {}, {});
  assert.ok(t.action.kind === "placeSellOrder" && t.action.itemID === 111 && t.action.quantity === 200 && t.action.price === 5);
  // Hangar now empty of type 34 -> done (the listed stack left the hangar).
  const empty = obs({ flightStatus: flight({ docked: true, inSpace: false }), stationHangar: [invRow({ itemID: 222, typeID: 99 })] });
  assert.equal(sell(sellStep, empty, {}, {}).outcome.kind, "done");
  // A singleton (an assembled item) of the type is never listed.
  const onlySingleton = obs({ flightStatus: flight({ docked: true, inSpace: false }), stationHangar: [invRow({ itemID: 333, singleton: true })] });
  assert.equal(sell(sellStep, onlySingleton, {}, {}).outcome.kind, "done");
  assert.equal(sell(sellStep, obs({ flightStatus: flight({ docked: false }) }), {}, {}).outcome.kind, "blocked");
});

// ── The fleet-support set ────────────────────────────────────────────────────

const remoteRep = SCRIPT_MACROS["remote-rep"]!;
const orbitBoost = SCRIPT_MACROS["orbit-and-boost"]!;
const repStep: MacroStep = { id: "rr", kind: "macro", macro: "remote-rep", args: {} };
const boostStep: MacroStep = { id: "ob", kind: "macro", macro: "orbit-and-boost", args: {} };

test("remote-rep: no remote reps fitted -> blocked", () => {
  const hurt = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4 });
  assert.equal(remoteRep(repStep, obs({ snapshot: snapshot([hurt]), remoteShieldRepairerIDs: [] }), {}, {}).outcome.kind, "blocked");
});

test("remote-rep: hurt friendly -> lock then rep it; everyone full -> done", () => {
  const hurt = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1 });
  const lock = remoteRep(repStep, obs({ snapshot: snapshot([hurt]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [5001] }), {}, {});
  assert.ok(lock.action.kind === "lock" && lock.action.targetID === 7001);
  const rep = remoteRep(repStep, obs({ snapshot: snapshot([hurt]), remoteShieldRepairerIDs: [600], lockedTargetIDs: [7001], fleetMemberCharacterIDs: [5001] }), lock.nextMem, {});
  assert.ok(rep.action.kind === "activate" && rep.action.moduleID === 600 && rep.action.targetID === 7001);
  const full = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 1, armorRatio: 1, hullRatio: 1 });
  assert.equal(remoteRep(repStep, obs({ snapshot: snapshot([full]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [5001] }), {}, {}).outcome.kind, "done");
});

test("probe sweep blocks launch, analyze once, and recover against observed state", () => {
  const launchStep: MacroStep = { id: "pl", kind: "macro", macro: "launch-scan-probes", args: {} };
  const analyzeStep: MacroStep = { id: "pa", kind: "macro", macro: "analyze-signatures", args: {} };
  const recoverStep: MacroStep = { id: "pr", kind: "macro", macro: "recover-scan-probes", args: {} };
  const launch = SCRIPT_MACROS["launch-scan-probes"];
  const analyze = SCRIPT_MACROS["analyze-signatures"];
  const recover = SCRIPT_MACROS["recover-scan-probes"];
  const probe = {
    probeID: 7001,
    typeID: 30013,
    pos: [1, 2, 3] as const,
    destination: [4, 5, 6] as const,
    scanRange: 1,
    rangeStep: 1,
    state: 1,
    expiry: "1",
  };

  assert.equal(launch(launchStep, obs({ scannerOperations }), NM, {}).action.kind, "scannerLaunch");
  assert.equal(
    launch(launchStep, obs({ scannerOperations: { ...scannerOperations, probes: [probe] } }), NM, {}).outcome.kind,
    "done",
  );
  const firstAnalysis = analyze(
    analyzeStep,
    obs({ scannerOperations: { ...scannerOperations, probes: [probe] } }),
    NM,
    {},
  );
  assert.equal(firstAnalysis.action.kind, "scannerAnalyze");
  assert.equal(
    analyze(
      analyzeStep,
      obs({ scannerOperations: { ...scannerOperations, probes: [probe] } }),
      firstAnalysis.nextMem,
      {},
    ).outcome.kind,
    "done",
  );
  assert.equal(
    recover(recoverStep, obs({ scannerOperations: { ...scannerOperations, probes: [probe] } }), NM, {}).action.kind,
    "scannerRecover",
  );
  assert.equal(recover(recoverStep, obs({ scannerOperations }), NM, {}).outcome.kind, "done");
});

test("fleet support waits for an authoritative roster and never targets a non-member", () => {
  const stranger = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.2, armorRatio: 1, hullRatio: 1, position: { x: 500, y: 0, z: 0 } });
  const member = entity({ itemID: 7002, kind: "ship", characterID: 5002, shieldRatio: 1, armorRatio: 1, hullRatio: 1, position: { x: 5000, y: 0, z: 0 } });

  const unavailable = remoteRep(repStep, obs({
    snapshot: snapshot([stranger]),
    remoteShieldRepairerIDs: [600],
    fleetMemberCharacterIDs: null,
  }), {}, {});
  assert.equal(unavailable.action.kind, "wait");
  assert.match(unavailable.why, /fleet roster/i);

  const filtered = remoteRep(repStep, obs({
    snapshot: snapshot([stranger, member]),
    remoteShieldRepairerIDs: [600],
    fleetMemberCharacterIDs: [5002],
  }), {}, {});
  assert.equal(filtered.outcome.kind, "done", "a hurt non-member must not be locked or repped");

  const anchor = orbitBoost(boostStep, obs({
    snapshot: snapshot([stranger, member]),
    remoteShieldRepairerIDs: [600],
    fleetMemberCharacterIDs: [5002],
  }), {}, {});
  assert.ok(anchor.action.kind === "orbit" && anchor.action.targetID === 7002);
});

test("a ship that leaves the authoritative roster stops receiving assistance immediately", () => {
  const formerMate = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.3, armorRatio: 1, hullRatio: 1 });
  const first = remoteRep(repStep, obs({
    snapshot: snapshot([formerMate]),
    remoteShieldRepairerIDs: [600],
    fleetMemberCharacterIDs: [5001],
  }), {}, {});
  assert.equal(first.action.kind, "lock");

  const afterLeave = remoteRep(repStep, obs({
    snapshot: snapshot([formerMate]),
    remoteShieldRepairerIDs: [600],
    lockedTargetIDs: [7001],
    fleetMemberCharacterIDs: [],
  }), first.nextMem, {});
  assert.equal(afterLeave.outcome.kind, "done");
  assert.notEqual(afterLeave.action.kind, "activate");
});

// ── Remote assistance has a range, and a bound ───────────────────────────────
//
// ⚠ BOTH REMOTE BLOCKS USED TO RETURN `mem` UNCHANGED after issuing an activate.
// A module that would not come on was found idle again next tick and re-fired,
// forever: no counter, no progress, no reason surfaced. And because remote-rep
// only reports `done` when everyone on grid is full (remote-cap likewise), a mate
// parked out of reach was an infinite loop — the bot would sit there locking and
// firing into nothing for as long as it was left running.

test("remote-rep: a mate out of rep range is CLOSED ON, not repped hopefully", () => {
  const far = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1, position: { x: 40000, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([far]), remoteShieldRepairerIDs: [600], lockedTargetIDs: [7001], fleetMemberCharacterIDs: [5001] });
  const t = remoteRep(repStep, world, { repLockOn: 7001, repWaited: 0 }, {});
  assert.ok(t.action.kind === "approach" && t.action.targetID === 7001, "it must close before it fires");
  assert.match(t.why, /Closing in/);
  // Issued once, then it stops asking and lets the rest of the tick happen.
  const next = remoteRep(repStep, world, t.nextMem, {});
  assert.notEqual(next.action.kind, "approach");
  assert.equal(next.nextMem["repTries"] ?? 0, 0, "and an out-of-reach tick spends no budget");
});

test("remote-rep: reps that never come on are BOUNDED (this was an infinite loop)", () => {
  const hurt = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1 });
  const world = obs({
    // The rep never appears in activeModuleIDs — the shape of a silent refusal.
    snapshot: snapshot([hurt], { activeModuleIDs: [] }),
    remoteShieldRepairerIDs: [600], lockedTargetIDs: [7001],
    fleetMemberCharacterIDs: [5001],
  });
  let mem: MacroMemory = { repLockOn: 7001, repWaited: 0 };
  let fired = 0;
  for (let i = 0; i < 8; i++) {
    const t = remoteRep(repStep, world, mem, {});
    if (t.action.kind === "activate") fired += 1;
    mem = t.nextMem;
  }
  assert.equal(fired, 3, `the rep is offered exactly MAX_REMOTE_ASSIST_ATTEMPTS times; got ${fired}`);
});

test("remote-rep: a rep that IS cycling refills the budget — no mid-fight stall", () => {
  // The bound must only ever catch a module that is not landing. A ship with two
  // reps where one is already running has to be able to switch the other on, and
  // keep doing so, however long the fight lasts.
  const hurt = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1 });
  const world = obs({
    snapshot: snapshot([hurt], { activeModuleIDs: [600] }), // 600 landed, 601 idle
    remoteShieldRepairerIDs: [600, 601], lockedTargetIDs: [7001],
    fleetMemberCharacterIDs: [5001],
  });
  // Arrive with the budget already spent from an earlier dry spell.
  let mem: MacroMemory = { repLockOn: 7001, repWaited: 0, repTries: 3 };
  let fired = 0;
  for (let i = 0; i < 6; i++) {
    const t = remoteRep(repStep, world, mem, {});
    if (t.action.kind === "activate") fired += 1;
    mem = t.nextMem;
  }
  assert.equal(fired, 6, "a landed rep means the budget is not spent — keep working the second one");
});

test("remote-rep: a NEW mate gets a fresh budget", () => {
  const first = entity({ itemID: 7001, kind: "ship", characterID: 5001, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1 });
  const second = entity({ itemID: 7009, kind: "ship", characterID: 5009, shieldRatio: 0.3, armorRatio: 1, hullRatio: 1 });
  // Memory from a spent attempt on 7001, which has since left the grid.
  const t = remoteRep(
    repStep,
    obs({ snapshot: snapshot([second]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [5009] }),
    { repLockOn: 7001, repWaited: 0, repTries: 3, repApproached: 7001 },
    {},
  );
  assert.ok(t.action.kind === "lock" && t.action.targetID === 7009);
  assert.equal(t.nextMem["repTries"], 0, "the last mate's spent budget must not disarm the reps for this one");
  assert.equal(t.nextMem["repApproached"], null);
  assert.ok(first.itemID === 7001);
});

test("orbit-and-boost: closes by ORBITING — it must not also issue an approach", () => {
  // Its orbit at ORBIT_BOOST_RANGE_M is how this block gets in range. An approach
  // from the shared helper would fight that orbit command every tick.
  const far = entity({ itemID: 7003, kind: "ship", characterID: 5002, shieldRatio: 0.4, armorRatio: 1, hullRatio: 1, position: { x: 40000, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([far]), remoteShieldRepairerIDs: [600], lockedTargetIDs: [7003], fleetMemberCharacterIDs: [5002] });
  // `orbiting` already set, so the orbit is not re-issued and we reach the reps.
  const t = orbitBoost(boostStep, world, { orbiting: 7003, repLockOn: 7003, repWaited: 0 }, {});
  assert.notEqual(t.action.kind, "approach");
});

test("remote-rep: an NPC or your own hull is never a rep target", () => {
  const npc = entity({ itemID: 7002, kind: "ship", isNpc: true, shieldRatio: 0.2 });
  // No FRIENDLY is hurt (the NPC is skipped), so the block is done — never reps a rat.
  assert.equal(remoteRep(repStep, obs({ snapshot: snapshot([npc]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [] }), {}, {}).outcome.kind, "done");
});

test("orbit-and-boost: no mate -> waits (never done); a mate present -> orbit it", () => {
  const none = orbitBoost(boostStep, obs({ snapshot: snapshot([]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [] }), {}, {});
  assert.equal(none.outcome.kind, "acting");
  assert.equal(none.action.kind, "wait");
  const mate = entity({ itemID: 7003, kind: "ship", characterID: 5002, shieldRatio: 1, armorRatio: 1, hullRatio: 1, position: { x: 5000, y: 0, z: 0 } });
  const orb = orbitBoost(boostStep, obs({ snapshot: snapshot([mate]), remoteShieldRepairerIDs: [600], fleetMemberCharacterIDs: [5002] }), {}, {});
  assert.ok(orb.action.kind === "orbit" && orb.action.targetID === 7003);
});

// ── The fleet-management set ─────────────────────────────────────────────────

const createF = SCRIPT_MACROS["create-fleet"]!;
const inviteF = SCRIPT_MACROS["invite-to-fleet"]!;
const joinF = SCRIPT_MACROS["join-fleet"]!;
const createStep: MacroStep = { id: "cf", kind: "macro", macro: "create-fleet", args: {} };
const inviteStep: MacroStep = { id: "if", kind: "macro", macro: "invite-to-fleet", args: { who: { kind: "character", charID: 90001, name: "Alt" } } };
const joinStep: MacroStep = { id: "jf", kind: "macro", macro: "join-fleet", args: {} };

test("create-fleet: not in a fleet -> form one; already in one -> done; unread -> wait", () => {
  assert.equal(createF(createStep, obs({ inFleet: false }), {}, {}).action.kind, "createFleet");
  assert.equal(createF(createStep, obs({ inFleet: true }), {}, {}).outcome.kind, "done");
  assert.equal(createF(createStep, obs({ inFleet: null }), {}, {}).action.kind, "wait"); // reading, not deciding blind
});

test("invite-to-fleet: in a fleet -> invite once then done; not in a fleet -> blocked; no pilot -> blocked", () => {
  const inv = inviteF(inviteStep, obs({ inFleet: true }), {}, {});
  assert.ok(inv.action.kind === "inviteToFleet" && inv.action.charID === 90001);
  assert.equal(inviteF(inviteStep, obs({ inFleet: true }), inv.nextMem, {}).outcome.kind, "done");
  assert.equal(inviteF(inviteStep, obs({ inFleet: false }), {}, {}).outcome.kind, "blocked");
  const noWho: MacroStep = { id: "if", kind: "macro", macro: "invite-to-fleet", args: { who: { kind: "character", charID: null, name: null } } };
  assert.equal(inviteF(noWho, obs({ inFleet: true }), {}, {}).outcome.kind, "blocked");
});

test("join-fleet: not in a fleet -> keep accepting; in a fleet -> done", () => {
  assert.equal(joinF(joinStep, obs({ inFleet: false }), {}, {}).action.kind, "acceptFleetInvite");
  assert.equal(joinF(joinStep, obs({ inFleet: true }), {}, {}).outcome.kind, "done");
});


// ── join-advertised-fleet ────────────────────────────────────────────────────
// The opportunistic twin of join-fleet. The tests that matter most are the ones
// proving it does NOT stop the run when the fleet simply is not there, and that
// it will not join a fleet whose name merely resembles the one asked for.

const joinAdv = SCRIPT_MACROS["join-advertised-fleet"]!;
const joinAdvStep: MacroStep = {
  id: "jaf", kind: "macro", macro: "join-advertised-fleet",
  args: { fleetName: { kind: "text", text: "Mining Op" } },
};
/** One fleet-finder row. */
const ad = (fleetID: number, fleetName: string, numMembers = 1) => ({ fleetID, fleetName, numMembers });

test("join-advertised-fleet: already in a fleet -> done without reading the finder", () => {
  const done = joinAdv(joinAdvStep, obs({ inFleet: true }), {}, {});
  assert.equal(done.outcome.kind, "done");
  assert.equal(done.action.kind, "wait");
});

test("join-advertised-fleet: the named fleet is advertised -> apply to it", () => {
  const t = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(42, "Other Op"), ad(77, "Mining Op")] }), {}, {});
  assert.ok(t.action.kind === "applyToJoinFleet" && t.action.fleetID === 77);
  assert.equal(t.outcome.kind, "acting");
});

test("join-advertised-fleet: the name matches past case and padding, but never as a substring", () => {
  const loose = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(88, "  mining op ")] }), {}, {});
  assert.ok(loose.action.kind === "applyToJoinFleet" && loose.action.fleetID === 88);
  // "Sunday Mining Op" CONTAINS the typed name; an unattended ship must not join it.
  const substring = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(99, "Sunday Mining Op")] }), {}, {});
  assert.equal(substring.outcome.kind, "done");
  assert.equal(substring.action.kind, "wait");
});

test("join-advertised-fleet: nobody advertising that name -> DONE, so the loop carries on", () => {
  // The whole point of the block: an empty or non-matching finder is a real
  // answer, not a failure, and must never stop a bot that mines on alone.
  for (const ads of [[], [ad(42, "Other Op")]]) {
    const t = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: ads }), {}, {});
    assert.equal(t.outcome.kind, "done");
    assert.equal(t.action.kind, "wait");
  }
});

test("join-advertised-fleet: two fleets share the name -> the bigger one, stably", () => {
  const t = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(5, "Mining Op", 2), ad(6, "Mining Op", 9)] }), {}, {});
  assert.ok(t.action.kind === "applyToJoinFleet" && t.action.fleetID === 6);
  // Equal sizes must not flap between ticks: the lower id wins, both orderings.
  const tie = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: [ad(6, "Mining Op", 4), ad(5, "Mining Op", 4)] }), {}, {});
  assert.ok(tie.action.kind === "applyToJoinFleet" && tie.action.fleetID === 5);
});

test("join-advertised-fleet: an unreadable finder or fleet status waits, never guesses", () => {
  const noAds = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: null }), {}, {});
  assert.equal(noAds.outcome.kind, "acting");
  assert.equal(noAds.action.kind, "wait");
  const noFleet = joinAdv(joinAdvStep, obs({ inFleet: null }), {}, {});
  assert.equal(noFleet.outcome.kind, "acting");
  assert.equal(noFleet.action.kind, "wait");
});

// ⚠ THE REGRESSION THIS SECTION EXISTS FOR. The first version of this block
// applied and then waited for membership to appear, which it never does: an
// apply mints an INVITE and the client has to accept it. Every test below the
// apply is about the half that was missing, because the original tests all
// stopped at "emits an applyToJoinFleet action" and passed while the block hung
// on a live fleet.

/** The state after this block has applied to fleet 77 this activation. */
const APPLIED = { waited: 1, appliedTo: 77 };
const ads77 = [ad(77, "Mining Op")];

test("join-advertised-fleet: an apply is followed by ACCEPTING the invite it minted", () => {
  const applied = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: ads77 }), {}, {});
  assert.ok(applied.action.kind === "applyToJoinFleet" && applied.action.fleetID === 77);

  // The server minted an invite. Accept it, naming the fleet applied to rather
  // than depending on the notification having reached the store.
  const accepting = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 77, outcome: "invited" } }),
    applied.nextMem,
    {},
  );
  assert.ok(accepting.action.kind === "acceptFleetInvite" && accepting.action.fleetID === 77);
  // And it does not apply a second time.
  assert.notEqual(accepting.action.kind, "applyToJoinFleet");

  // Membership ends the block.
  assert.equal(joinAdv(joinAdvStep, obs({ inFleet: true }), accepting.nextMem, {}).outcome.kind, "done");
});

test("join-advertised-fleet: an approval-gated fleet stops at once, it does not sit out the bound", () => {
  // No invite exists and none is coming -- only the boss can act. Saying so
  // beats timing out and blaming the fleet several minutes later.
  const t = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 77, outcome: "needs-approval" } }),
    APPLIED,
    {},
  );
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /approve/i);
});

test("join-advertised-fleet: an answer it does not recognise still tries the accept", () => {
  // "unknown" is the honest third state. The invite half is the common one, and
  // a wasted accept costs one swallowed call where refusing to accept would
  // strand a bot that had an invite waiting.
  const t = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 77, outcome: "unknown" } }),
    APPLIED,
    {},
  );
  assert.ok(t.action.kind === "acceptFleetInvite" && t.action.fleetID === 77);
});

test("join-advertised-fleet: an answer about a DIFFERENT fleet is not this application", () => {
  // The observation outlives a lap; step memory does not. A previous lap's
  // answer must not decide this one -- the fleet id is what keeps them apart.
  const t = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 42, outcome: "needs-approval" } }),
    APPLIED,
    {},
  );
  assert.equal(t.outcome.kind, "acting");
  assert.equal(t.action.kind, "wait");
});

test("join-advertised-fleet: no answer yet waits; accepted but never landed gives up", () => {
  // The apply is in flight, or it threw and the runner swallowed it.
  const inFlight = joinAdv(joinAdvStep, obs({ inFleet: false, fleetAds: ads77 }), APPLIED, {});
  assert.equal(inFlight.outcome.kind, "acting");
  assert.equal(inFlight.action.kind, "wait");

  // A join applied for AND accepted that still never lands is a real failure.
  const overdue = joinAdv(
    joinAdvStep,
    obs({ inFleet: false, fleetAds: ads77, fleetApplication: { fleetID: 77, outcome: "invited" } }),
    { waited: 10_000, appliedTo: 77 },
    {},
  );
  assert.equal(overdue.outcome.kind, "blocked");
});

test("join-advertised-fleet: no name typed -> blocked before anything is read", () => {
  const blank: MacroStep = {
    id: "jaf0", kind: "macro", macro: "join-advertised-fleet",
    args: { fleetName: { kind: "text", text: "   " } },
  };
  assert.equal(joinAdv(blank, obs({ inFleet: false, fleetAds: [ad(77, "Mining Op")] }), {}, {}).outcome.kind, "blocked");
});

// ── Movement extras, cargo extras, cap chain ─────────────────────────────────

const setDest = SCRIPT_MACROS["set-destination"]!;
const dockNearest = SCRIPT_MACROS["dock-at-nearest"]!;
const remoteCapBlock = SCRIPT_MACROS["remote-cap"]!;
const jettison = SCRIPT_MACROS["jettison-cargo"]!;
const tidy = SCRIPT_MACROS["tidy-hangar"]!;

const toStationStep: MacroStep = {
  id: "sd", kind: "macro", macro: "set-destination",
  args: { destination: { kind: "destination", ref: { entity: "station", id: 60008143, name: "Home", systemName: null } } },
};
const toSystemStep: MacroStep = {
  id: "sd2", kind: "macro", macro: "set-destination",
  args: { destination: { kind: "destination", ref: { entity: "system", id: 30005239, name: "Aring", systemName: null } } },
};

test("set-destination: a STATION destination starts a station route; a SYSTEM one a system route", () => {
  const st = setDest(toStationStep, obs({}), {}, {});
  assert.ok(st.action.kind === "startRoute" && st.action.stationID === 60008143);
  const sys = setDest(toSystemStep, obs({}), {}, {});
  assert.ok(sys.action.kind === "startSystemRoute" && sys.action.systemID === 30005239);
});

test("set-destination: done once the trip is under way, NOT on arrival", () => {
  const t = setDest(
    toStationStep,
    obs({ travel: { status: "running", destinationStationID: 60008143, destinationSystemID: null, remainingJumps: 4, failureReason: null } }),
    { issued: true },
    {},
  );
  assert.equal(t.outcome.kind, "done", "the block finishes with the ship still flying");
});

test("set-destination: a failure on THIS destination blocks; an unset destination blocks", () => {
  const failed = setDest(
    toStationStep,
    obs({ travel: { status: "paused", destinationStationID: 60008143, destinationSystemID: null, remainingJumps: 0, failureReason: "No gate route." } }),
    {},
    {},
  );
  assert.equal(failed.outcome.kind, "blocked");
  const unset: MacroStep = {
    id: "sd3", kind: "macro", macro: "set-destination",
    args: { destination: { kind: "destination", ref: { entity: "station", id: null, name: null, systemName: null } } },
  };
  assert.equal(setDest(unset, obs({}), {}, {}).outcome.kind, "blocked");
});

const dockNearStep: MacroStep = { id: "dn", kind: "macro", macro: "dock-at-nearest", args: {} };

test("dock-at-nearest: picks the CLOSEST dockable and docks when in range", () => {
  const near = entity({ itemID: 60001, kind: "station", name: "Near", radius: 1000, position: { x: 1500, y: 0, z: 0 } });
  const far = entity({ itemID: 60002, kind: "station", name: "Far", radius: 1000, position: { x: 9_000_000, y: 0, z: 0 } });
  const t = dockNearest(dockNearStep, obs({ snapshot: snapshot([near, far]) }), {}, {});
  assert.ok(t.action.kind === "dock" && t.action.stationID === 60001);
});

test("dock-at-nearest: far away warps; docked is done; nothing in view is blocked", () => {
  const far = entity({ itemID: 60002, kind: "station", name: "Far", radius: 1000, position: { x: 900_000_000, y: 0, z: 0 } });
  const warp = dockNearest(dockNearStep, obs({ snapshot: snapshot([far]) }), {}, {});
  assert.ok(warp.action.kind === "warp" && warp.action.targetID === 60002);

  const done = dockNearest(
    dockNearStep,
    obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60002 }) }),
    {},
    {},
  );
  assert.equal(done.outcome.kind, "done");

  const empty = dockNearest(dockNearStep, obs({ snapshot: snapshot([]) }), {}, {});
  assert.equal(empty.outcome.kind, "blocked");
});

test("dock-at-nearest: drones out means call them home before warping off", () => {
  const station = entity({ itemID: 60002, kind: "station", radius: 1000, position: { x: 900_000_000, y: 0, z: 0 } });
  const drone = entity({ itemID: 111, kind: "drone", controllerID: 9001, position: { x: 200, y: 0, z: 0 } });
  const t = dockNearest(dockNearStep, obs({ snapshot: snapshot([station, drone]), dronesOut: true }), {}, {});
  assert.ok(t.action.kind === "recallDrones" && t.action.droneIDs.includes(111));
});

test("remote-cap: feeds the EMPTIEST mate; all healthy is done; none fitted is blocked", () => {
  const capStep: MacroStep = { id: "rc", kind: "macro", macro: "remote-cap", args: {} };
  const thirsty = entity({ itemID: 801, kind: "ship", characterID: 90001, isNpc: false, capacitorRatio: 0.2, position: { x: 1000, y: 0, z: 0 } });
  const fine = entity({ itemID: 802, kind: "ship", characterID: 90002, isNpc: false, capacitorRatio: 0.99, position: { x: 900, y: 0, z: 0 } });

  const lock = remoteCapBlock(capStep, obs({ snapshot: snapshot([thirsty, fine]), remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90001, 90002] }), {}, {});
  assert.ok(lock.action.kind === "lock" && lock.action.targetID === 801, "the emptiest one, not the nearest");

  const run = remoteCapBlock(
    capStep,
    obs({ snapshot: snapshot([thirsty], { activeModuleIDs: [] }), lockedTargetIDs: [801], remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90001] }),
    { capLockOn: 801 },
    {},
  );
  assert.ok(run.action.kind === "activate" && run.action.moduleID === 640 && run.action.targetID === 801);

  const allFine = remoteCapBlock(capStep, obs({ snapshot: snapshot([fine]), remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90002] }), {}, {});
  assert.equal(allFine.outcome.kind, "done");

  const noModule = remoteCapBlock(capStep, obs({ snapshot: snapshot([thirsty]), remoteCapModuleIDs: [] }), {}, {});
  assert.equal(noModule.outcome.kind, "blocked");

  const unavailable = remoteCapBlock(capStep, obs({
    snapshot: snapshot([thirsty]),
    remoteCapModuleIDs: [640],
    fleetMemberCharacterIDs: null,
  }), {}, {});
  assert.equal(unavailable.action.kind, "wait");
  assert.match(unavailable.why, /fleet roster/i);

  const stranger = remoteCapBlock(capStep, obs({
    snapshot: snapshot([thirsty, fine]),
    remoteCapModuleIDs: [640],
    fleetMemberCharacterIDs: [90002],
  }), {}, {});
  assert.equal(stranger.outcome.kind, "done", "a cap-starved non-member must not receive a transmitter");
});

test("remote-cap: a mate out of reach is closed on, and the transfer is bounded", () => {
  // The same two faults remote-rep had. Measured live: a Small Remote Capacitor
  // Transmitter I refused TargetNotWithinRangeGeneric at 17.9 km.
  const capStep: MacroStep = { id: "rc", kind: "macro", macro: "remote-cap", args: {} };
  const far = entity({ itemID: 801, kind: "ship", characterID: 90001, isNpc: false, capacitorRatio: 0.2, position: { x: 30000, y: 0, z: 0 } });
  const world = obs({ snapshot: snapshot([far]), lockedTargetIDs: [801], remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90001] });
  const close = remoteCapBlock(capStep, world, { capLockOn: 801, capWaited: 0 }, {});
  assert.ok(close.action.kind === "approach" && close.action.targetID === 801);
  assert.match(close.why, /Closing in/);
  assert.equal(close.nextMem["capTries"] ?? 0, 0, "out of reach spends no budget");

  const near = entity({ itemID: 801, kind: "ship", characterID: 90001, isNpc: false, capacitorRatio: 0.2, position: { x: 1000, y: 0, z: 0 } });
  const inRange = obs({ snapshot: snapshot([near], { activeModuleIDs: [] }), lockedTargetIDs: [801], remoteCapModuleIDs: [640], fleetMemberCharacterIDs: [90001] });
  let mem: MacroMemory = { capLockOn: 801, capWaited: 0 };
  let fired = 0;
  for (let i = 0; i < 8; i++) {
    const t = remoteCapBlock(capStep, inRange, mem, {});
    if (t.action.kind === "activate") fired += 1;
    mem = t.nextMem;
  }
  assert.equal(fired, 3, `the transmitter is offered exactly MAX_REMOTE_ASSIST_ATTEMPTS times; got ${fired}`);
});

const jettisonStep: MacroStep = { id: "jc", kind: "macro", macro: "jettison-cargo", args: {} };

test("jettison-cargo: keepItems is honoured, and an UNREADABLE row is never thrown out", () => {
  // ⚠ The one block where getting this wrong cannot be undone: a jettisoned
  // stack goes into a can that despawns. So unlike the unload block, a row this
  // client cannot classify stays aboard.
  const keepCrystals: MacroStep = {
    id: "jc3", kind: "macro", macro: "jettison-cargo",
    args: { keepItems: { kind: "itemList", items: [{ match: "group", groupID: 483, name: "crystal" }] } },
  } as never;
  const rows = [
    { itemID: 11, typeID: 1230, groupID: 462, categoryID: 25, quantity: 50, singleton: false },
    { itemID: 12, typeID: 3389, groupID: 483, categoryID: 8, quantity: 2, singleton: false },
    { itemID: 13, typeID: 999, groupID: null, categoryID: null, quantity: 1, singleton: false },
  ];
  const cargo = { rows, capacity: null } as unknown as ScriptObservation["cargo"];
  const t = jettison(keepCrystals, obs({ cargo }), {}, {});
  assert.ok(t.action.kind === "jettison");
  assert.deepEqual(
    t.action.kind === "jettison" ? [...t.action.itemIDs] : [],
    [11],
    "the ore went out; the crystals and the unidentifiable stack stayed",
  );
});

test("jettison-cargo: dumps the whole hold, or only the picked item; empty is done", () => {
  const rows = [
    { itemID: 11, typeID: 34, quantity: 100, singleton: false },
    { itemID: 12, typeID: 1230, quantity: 50, singleton: false },
  ];
  const cargo = { rows, capacity: null } as unknown as ScriptObservation["cargo"];
  const all = jettison(jettisonStep, obs({ cargo }), {}, {});
  assert.ok(all.action.kind === "jettison" && all.action.itemIDs.length === 2);

  const onlyOre: MacroStep = {
    id: "jc2", kind: "macro", macro: "jettison-cargo",
    args: { item: { kind: "itemType", typeID: 1230, name: "Veldspar" } },
  };
  const one = jettison(onlyOre, obs({ cargo }), {}, {});
  assert.ok(one.action.kind === "jettison" && one.action.itemIDs.length === 1 && one.action.itemIDs[0] === 12);

  const emptied = jettison(
    jettisonStep,
    obs({ cargo: { rows: [], capacity: null } as unknown as ScriptObservation["cargo"] }),
    {},
    {},
  );
  assert.equal(emptied.outcome.kind, "done", "the hold emptying IS the confirmation");
});

test("jettison-cargo: docked is blocked, since a can needs space to float in", () => {
  const t = jettison(
    jettisonStep,
    obs({ inSpace: false, flightStatus: flight({ docked: true, inSpace: false }) }),
    {},
    {},
  );
  assert.equal(t.outcome.kind, "blocked");
});

const jettisonOreStep: MacroStep = { id: "jo", kind: "macro", macro: "jettison-ore", args: {} };
const jettisonOre = SCRIPT_MACROS["jettison-ore"]!;

test("jettison-ore: dumps the ore hold, never the (empty) cargo hold", () => {
  const holds: NonNullable<ScriptObservation["holds"]> = [
    { key: "cargo", label: "Cargo Hold", items: [], capacity: null, present: true, error: null },
    {
      key: "ore",
      label: "Ore Hold",
      items: [
        { itemID: 21, typeID: 1230, quantity: 500, singleton: false },
        { itemID: 22, typeID: 1228, quantity: 300, singleton: false },
      ] as unknown as NonNullable<ScriptObservation["holds"]>[number]["items"],
      capacity: null,
      present: true,
      error: null,
    },
  ];
  const all = jettisonOre(jettisonOreStep, obs({ holds }), {}, {});
  assert.ok(all.action.kind === "jettison" && all.action.itemIDs.length === 2);

  const onlyVeldspar: MacroStep = {
    id: "jo2", kind: "macro", macro: "jettison-ore",
    args: { item: { kind: "itemType", typeID: 1230, name: "Veldspar" } },
  };
  const one = jettisonOre(onlyVeldspar, obs({ holds }), {}, {});
  assert.ok(one.action.kind === "jettison" && one.action.itemIDs.length === 1 && one.action.itemIDs[0] === 21);
});

test("jettison-ore: an empty ore hold is done; a ship with no ore hold is blocked", () => {
  const emptyOre: NonNullable<ScriptObservation["holds"]> = [
    { key: "ore", label: "Ore Hold", items: [], capacity: null, present: true, error: null },
  ];
  const emptied = jettisonOre(jettisonOreStep, obs({ holds: emptyOre }), {}, {});
  assert.equal(emptied.outcome.kind, "done");

  const cargoOnly: NonNullable<ScriptObservation["holds"]> = [
    { key: "cargo", label: "Cargo Hold", items: [], capacity: null, present: true, error: null },
  ];
  const noHold = jettisonOre(jettisonOreStep, obs({ holds: cargoOnly }), {}, {});
  assert.equal(noHold.outcome.kind, "blocked");
  assert.match(noHold.outcome.kind === "blocked" ? noHold.outcome.reason : "", /no ore hold/i);
});

test("jettison-ore: docked is blocked, since a can needs space to float in", () => {
  const t = jettisonOre(
    jettisonOreStep,
    obs({ inSpace: false, flightStatus: flight({ docked: true, inSpace: false }) }),
    {},
    {},
  );
  assert.equal(t.outcome.kind, "blocked");
});

test("tidy-hangar: stacks once then done; undocked is blocked", () => {
  const step: MacroStep = { id: "th", kind: "macro", macro: "tidy-hangar", args: {} };
  const docked = obs({ flightStatus: flight({ docked: true, inSpace: false, stationID: 60008143 }) });
  const first = tidy(step, docked, {}, {});
  assert.equal(first.action.kind, "stackHangar");
  assert.equal(tidy(step, docked, first.nextMem, {}).outcome.kind, "done");
  assert.equal(tidy(step, obs({}), {}, {}).outcome.kind, "blocked");
});

test("mine: the biggest-rock order prefers the most ore left; the default stays nearest", () => {
  const small = entity({ itemID: 50001, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: 100, position: { x: 3000, y: 0, z: 0 } });
  const big = entity({ itemID: 50002, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: 9000, position: { x: 9000, y: 0, z: 0 } });
  const unknown = entity({ itemID: 50003, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: null, position: { x: 1000, y: 0, z: 0 } });
  const biggestStep: MacroStep = {
    ...mineStep, id: "mb",
    args: { ...mineStep.args, pick: { kind: "rockPick", pick: "biggest" } },
  };
  const t = mine(biggestStep, obs({ snapshot: snapshot([small, big, unknown]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50002, "the big one, though it is furthest");

  const near = mine(mineStep, obs({ snapshot: snapshot([small, big, unknown]) }), NM, {});
  assert.ok(near.action.kind === "orbit" && near.action.targetID === 50003, "default still picks the nearest");
});

test("mine: the most-valuable order prefers ISK per m³, and breaks ties by distance", () => {
  // Two ores in the belt. The cheap one is nearer and holds more; the valuable
  // one is what a hold-sized trip is actually worth, which is the whole point.
  const cheapNear = entity({ itemID: 50101, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: 9000, oreValuePerM3: 52.8, position: { x: 1000, y: 0, z: 0 } });
  const cheapFar = entity({ itemID: 50102, name: "Veldspar", miningYieldTypeID: 1230, remainingQuantity: 9000, oreValuePerM3: 52.8, position: { x: 4000, y: 0, z: 0 } });
  const richFar = entity({ itemID: 50103, name: "Kernite", miningYieldTypeID: 1228, remainingQuantity: 500, oreValuePerM3: 120.5, position: { x: 9000, y: 0, z: 0 } });
  const valuableStep: MacroStep = {
    ...mineStep, id: "mv",
    args: { ...mineStep.args, pick: { kind: "rockPick", pick: "valuable" } },
  };
  const rich = mine(valuableStep, obs({ snapshot: snapshot([cheapNear, cheapFar, richFar]) }), NM, {});
  assert.ok(rich.action.kind === "orbit" && rich.action.targetID === 50103, "the richer ore, though it is furthest and smaller");

  // ⚠ THE TIE IS THE COMMON CASE: a belt of one ore prices every rock the same.
  // Without a distance tie-break this pick would be "whichever rock came first".
  const tied = mine(valuableStep, obs({ snapshot: snapshot([cheapFar, cheapNear]) }), NM, {});
  assert.ok(tied.action.kind === "orbit" && tied.action.targetID === 50101, "same ore, so the nearest of them");
});

test("mine: an unpriced rock sorts last, and a belt nobody could price falls back to nearest", () => {
  const priced = entity({ itemID: 50201, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: 52.8, position: { x: 9000, y: 0, z: 0 } });
  const unpriced = entity({ itemID: 50202, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: null, position: { x: 1000, y: 0, z: 0 } });
  const valuableStep: MacroStep = {
    ...mineStep, id: "mv2",
    args: { ...mineStep.args, pick: { kind: "rockPick", pick: "valuable" } },
  };
  const known = mine(valuableStep, obs({ snapshot: snapshot([priced, unpriced]) }), NM, {});
  assert.ok(known.action.kind === "orbit" && known.action.targetID === 50201, "a null price is not a cheap rock");

  // Nothing priced at all: the pick has no opinion, so it stops inventing one.
  const blind = mine(valuableStep, obs({ snapshot: snapshot([unpriced, priced2()]) }), NM, {});
  assert.ok(blind.action.kind === "orbit" && blind.action.targetID === 50202, "back to the nearest rock");
});

/** A second unpriced rock, further out — for the "nothing is priced" case. */
function priced2() {
  return entity({ itemID: 50203, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: null, position: { x: 7000, y: 0, z: 0 } });
}

// ── the ore priority nobody typed ────────────────────────────────────────────

test("mine: with NO ore list the block works the richest ore on the belt, not the nearest rock", () => {
  // The default pick is "nearest" — and it still is, WITHIN the ore worth most.
  // This is the whole of the automatic ordering: which ore comes first is a
  // different question from which of that ore's rocks to fly to.
  const cheapNear = entity({ itemID: 50301, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: 52.8, position: { x: 1000, y: 0, z: 0 } });
  const richFar = entity({ itemID: 50302, name: "Kernite", miningYieldTypeID: 1228, oreValuePerM3: 95.04, position: { x: 8000, y: 0, z: 0 } });
  const richFarther = entity({ itemID: 50303, name: "Kernite", miningYieldTypeID: 1228, oreValuePerM3: 95.04, position: { x: 12000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([cheapNear, richFar, richFarther]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50302, "the Kernite, and the nearer of the two");
});

test("mine: a rock already being WORKED is not dropped when a richer one drifts into view", () => {
  // Half a cycle into a Veldspar rock is not the moment to fly off: the ore
  // priority restricts what to pick NEXT, it does not re-open a rock in hand.
  const working = entity({ itemID: 50311, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: 52.8, position: { x: 1000, y: 0, z: 0 } });
  const richer = entity({ itemID: 50312, name: "Kernite", miningYieldTypeID: 1228, oreValuePerM3: 95.04, position: { x: 2000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([working, richer]) }), { rockID: 50311 }, {});
  assert.ok(t.action.kind === "lock" && t.action.targetID === 50311, "it carries on with the rock it was working");
});

test("mine: with nothing priced the block picks exactly as it always did", () => {
  // An older BFF (or ore nobody could price) leaves every value null. That must
  // read as "no opinion", not as "every rock is worthless".
  const near = entity({ itemID: 50321, name: "Veldspar", miningYieldTypeID: 1230, oreValuePerM3: null, position: { x: 1000, y: 0, z: 0 } });
  const far = entity({ itemID: 50322, name: "Kernite", miningYieldTypeID: 1228, oreValuePerM3: null, position: { x: 9000, y: 0, z: 0 } });
  const t = mine(mineStep, obs({ snapshot: snapshot([far, near]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50321, "the nearest rock, as before");
});

test("mine: a HAND-WRITTEN ore list outranks the value ordering, because it answers a different question", () => {
  // A player who typed "Veldspar" is not asking what the belt is worth — they
  // want Veldspar, and a richer rock sitting next to it changes nothing.
  const veld = entity({ itemID: 50331, name: "Veldspar", groupID: VELDSPAR.groupID, miningYieldTypeID: 1230, oreValuePerM3: 52.8, position: { x: 9000, y: 0, z: 0 } });
  const kern = entity({ itemID: 50332, name: "Kernite", groupID: KERNITE.groupID, miningYieldTypeID: 1228, oreValuePerM3: 95.04, position: { x: 1000, y: 0, z: 0 } });
  const t = mine(oreListStep([VELDSPAR]), obs({ snapshot: snapshot([veld, kern]) }), NM, {});
  assert.ok(t.action.kind === "orbit" && t.action.targetID === 50331, "the ore on the list, though the other is nearer AND richer");
});

// ── compress-ore (the fleet mechanic) ────────────────────────────────────────

const compress = SCRIPT_MACROS["compress-ore"]!;
const compressStep: MacroStep = { id: "co", kind: "macro", macro: "compress-ore", args: {} };

/** A hold with these stacks in it. */
function oreHold(items: readonly { itemID: number; typeID: number; quantity: number }[]): MiningHold[] {
  // Everything in an ore hold is ore, so the helper classifies it as such —
  // callers say what is there, not what kind of thing it is.
  const rows: HoldItem[] = items.map((item) => ({ ...item, groupID: 462, categoryID: 25 }));
  return [{ key: "ore", label: "Ore Hold", items: rows, capacity: null, present: true, error: null }];
}

/** A support ship that IS running its compression gear. */
function facilityShip(itemID: number, characterID: number, x: number, rangeMeters = 60_000): SpaceEntity {
  return entity({
    itemID, kind: "ship", characterID, isNpc: false, radius: 3000,
    position: { x, y: 0, z: 0 },
    compressionFacility: { rangeMeters, typeListIDs: [1] },
  });
}

test("compress-ore: an in-range support ship on grid -> compress the first stack", () => {
  const orca = facilityShip(7001, 90002, 20_000);
  const t = compress(compressStep, obs({ snapshot: snapshot([orca]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]) }), {}, {});
  assert.ok(t.action.kind === "compressOre" && t.action.itemID === 11 && t.action.facilityID === 7001);
});

test("compress-ore: no support ship running its gear -> blocked, and says so", () => {
  // An ordinary ship on grid is NOT a facility, and neither is one whose modules
  // are off (compressionFacility null).
  const plain = entity({ itemID: 7002, kind: "ship", characterID: 90003, isNpc: false, position: { x: 1000, y: 0, z: 0 } });
  const off = entity({ itemID: 7003, kind: "ship", characterID: 90004, isNpc: false, compressionFacility: null, position: { x: 1200, y: 0, z: 0 } });
  const t = compress(compressStep, obs({ snapshot: snapshot([plain, off]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]) }), {}, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.match(t.outcome.kind === "blocked" ? t.outcome.reason : "", /compression gear/i);
});

test("compress-ore: an ABSENT facility reading is not a facility (no hopeful firing)", () => {
  // An older server, or a row the gateway did not project: the field is missing
  // entirely. That must read as "not a facility", not as an unknown worth trying.
  const unknown = entity({ itemID: 7004, kind: "ship", characterID: 90005, isNpc: false, position: { x: 900, y: 0, z: 0 } });
  delete (unknown as { compressionFacility?: unknown }).compressionFacility;
  const t = compress(compressStep, obs({ snapshot: snapshot([unknown]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]) }), {}, {});
  assert.equal(t.outcome.kind, "blocked");
});

test("compress-ore: an NPC hull is never a facility", () => {
  const rat = entity({
    itemID: 7005, kind: "ship", isNpc: true, npcEntityType: "npc",
    position: { x: 500, y: 0, z: 0 },
    compressionFacility: { rangeMeters: 60_000, typeListIDs: [1] },
  });
  const t = compress(compressStep, obs({ snapshot: snapshot([rat]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 1 }]) }), {}, {});
  assert.equal(t.outcome.kind, "blocked");
});

test("compress-ore: out of the facility's range -> close in first, then compress", () => {
  // 200 km away with a 60 km reach: too far for the server to accept.
  const far = facilityShip(7001, 90002, 200_000, 60_000);
  const holds = oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]);
  const closing = compress(compressStep, obs({ snapshot: snapshot([far]), holds }), {}, {});
  assert.ok(
    closing.action.kind === "approach" || closing.action.kind === "warp",
    `expected to close the gap, got ${closing.action.kind}`,
  );

  // Inside its reach, it compresses.
  const near = facilityShip(7001, 90002, 30_000, 60_000);
  const inRange = compress(compressStep, obs({ snapshot: snapshot([near]), holds }), {}, {});
  assert.equal(inRange.action.kind, "compressOre");
});

test("compress-ore: OWN ship as the facility needs no closing in", () => {
  // The ego ship itself is running the gear (a Rorqual compressing its own ore).
  const self = entity({
    itemID: 9001, kind: "ship", isSelf: true, isNpc: false, characterID: 90001,
    position: { x: 0, y: 0, z: 0 },
    compressionFacility: { rangeMeters: 1, typeListIDs: [1] },
  });
  const t = compress(compressStep, obs({ snapshot: snapshot([self]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 5000 }]) }), {}, {});
  assert.ok(t.action.kind === "compressOre" && t.action.facilityID === 9001);
});

test("compress-ore: own ship is preferred over a fleet-mate's facility", () => {
  const self = entity({
    itemID: 9001, kind: "ship", isSelf: true, isNpc: false, characterID: 90001,
    position: { x: 0, y: 0, z: 0 },
    compressionFacility: { rangeMeters: 1, typeListIDs: [1] },
  });
  const mate = facilityShip(7001, 90002, 5000);
  const t = compress(compressStep, obs({ snapshot: snapshot([self, mate]), holds: oreHold([{ itemID: 11, typeID: 1230, quantity: 1 }]) }), {}, {});
  assert.ok(t.action.kind === "compressOre" && t.action.facilityID === 9001);
});

test("compress-ore: each stack gets ONE attempt, then the block finishes", () => {
  const orca = facilityShip(7001, 90002, 20_000);
  const holds = oreHold([
    { itemID: 11, typeID: 1230, quantity: 5000 },
    { itemID: 12, typeID: 1228, quantity: 3000 },
  ]);
  let mem: MacroMemory = {};
  const attempted: number[] = [];
  let finishedOnTick = -1;
  for (let i = 0; i < 5; i++) {
    const t = compress(compressStep, obs({ snapshot: snapshot([orca]), holds }), mem, {});
    if (t.action.kind === "compressOre") attempted.push(t.action.itemID);
    mem = t.nextMem;
    if (t.outcome.kind === "done") {
      finishedOnTick = i;
      break;
    }
  }
  assert.deepEqual(attempted, [11, 12], "each stack once, in order — an ore with no compressed form is not retried forever");
  assert.equal(finishedOnTick, 2, "it finishes the tick after the last stack, never looping on a stubborn one");
  // ⚠ The memory it finishes with is CLEARED, on purpose: the runner resets
  // per-step memory at a step boundary anyway, and inside a Repeat loop the next
  // lap must reconsider ore mined since rather than remember an empty hold.
  assert.equal(mem["triedItemIDs"], undefined);
});

test("compress-ore: an EMPTY hold is done; an UNREADABLE hold waits", () => {
  const orca = facilityShip(7001, 90002, 20_000);
  const empty = compress(compressStep, obs({ snapshot: snapshot([orca]), holds: oreHold([]) }), {}, {});
  assert.equal(empty.outcome.kind, "done");

  // items:null is "we could not look", NOT "it is empty" — it must not finish.
  const blind: MiningHold[] = [{ key: "ore", label: "Ore Hold", items: null, capacity: null, present: true, error: "read failed" }];
  const waiting = compress(compressStep, obs({ snapshot: snapshot([orca]), holds: blind }), {}, {});
  assert.equal(waiting.action.kind, "wait");
  assert.notEqual(waiting.outcome.kind, "done", "a failed read must never look like an empty hold");
});

test("compress-ore: docked -> blocked; mid-warp -> waits", () => {
  const docked = compress(compressStep, obs({ inSpace: false, flightStatus: flight({ docked: true, inSpace: false }) }), {}, {});
  assert.equal(docked.outcome.kind, "blocked");
  const warping = compress(compressStep, obs({ inWarp: true, snapshot: snapshot([]) }), {}, {});
  assert.equal(warping.action.kind, "wait");
  assert.equal(warping.outcome.kind, "acting");
});

test("compress-ore / jettison: an UNREADABLE location waits, it does not say 'undock first'", () => {
  // The whole flight status is missing (a first tick, or a failed read). Docked is
  // a verdict; unreadable is not — telling a player to undock a ship whose place
  // has not been read yet is exactly the mistake the tri-state rule prevents.
  const blind = obs({ inSpace: null, flightStatus: null, snapshot: null, holds: null, cargo: null });
  const c = compress(compressStep, blind, {}, {});
  assert.equal(c.action.kind, "wait");
  assert.equal(c.outcome.kind, "acting", "an unread location must not be a blocked verdict");

  const j = jettison(jettisonStep, blind, {}, {});
  assert.equal(j.action.kind, "wait");
  assert.equal(j.outcome.kind, "acting");

  // And a genuinely docked ship still blocks, with the plain hint.
  const parked = obs({ inSpace: false, flightStatus: flight({ docked: true, inSpace: false }) });
  assert.equal(compress(compressStep, parked, {}, {}).outcome.kind, "blocked");
  assert.equal(jettison(jettisonStep, parked, {}, {}).outcome.kind, "blocked");
});

// ── target priority (nav/targetPriority.ts) ──────────────────────────────────
//
// The ladder decides WHICH hostile is primary; the rest of the engage is
// unchanged, so these only assert the pick. Group names arrive on the
// observation the same way drone roles do — resolved, or not resolved at all.

const TACKLE_TYPE = 11176; // an Interceptor hull
const BRICK_TYPE = 645; // a battleship hull
const GRID_GROUPS = { [TACKLE_TYPE]: "Interceptor", [BRICK_TYPE]: "Battleship" };

test("fight: the far tackle is primary over the near battleship", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const near = entity({ itemID: 6661, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 2000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, typeID: TACKLE_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 40000, y: 0, z: 0 } });
  const tick = fight(step, obs({ snapshot: snapshot([near, far]), weaponModuleIDs: [500], targetGroupNames: GRID_GROUPS }), {}, {});
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6662);
});

test("fight: with no groups resolved the pick is the old nearest-first", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = { id: "f", kind: "macro", macro: "fight-the-rats", args: {} } as const;
  const near = entity({ itemID: 6661, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 2000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, typeID: TACKLE_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 40000, y: 0, z: 0 } });
  const blind = fight(step, obs({ snapshot: snapshot([near, far]), weaponModuleIDs: [500] }), {}, {});
  assert.ok(blind.action.kind === "lock" && blind.action.targetID === 6661);
  // A map that answers null for these types is the same "cannot tell".
  const unresolved = fight(
    step,
    obs({ snapshot: snapshot([near, far]), weaponModuleIDs: [500], targetGroupNames: { [TACKLE_TYPE]: null, [BRICK_TYPE]: null } }),
    {},
    {},
  );
  assert.ok(unresolved.action.kind === "lock" && unresolved.action.targetID === 6661);
});

test("fight: the player's own ladder is followed", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const step = {
    id: "f",
    kind: "macro",
    macro: "fight-the-rats",
    args: { targets: { kind: "targetList", classes: ["other", "tackle"] } },
  } as const;
  const near = entity({ itemID: 6661, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 40000, y: 0, z: 0 } });
  const far = entity({ itemID: 6662, typeID: TACKLE_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 2000, y: 0, z: 0 } });
  const tick = fight(step, obs({ snapshot: snapshot([near, far]), weaponModuleIDs: [500], targetGroupNames: GRID_GROUPS }), {}, {});
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6661, "battleships first, because that is what was asked");
});

// ── flying with the fleet (the shared squad board) ───────────────────────────
//
// `squad: follow` shoots what the fleet called WHEN that ship is here; `squad:
// call` says what this pilot is on, once per primary. Everything else is the
// same engage, so these assert the pick and the one extra action.

function fightStep(squad: "off" | "call" | "follow"): MacroStep {
  return {
    id: "f",
    kind: "macro",
    macro: "fight-the-rats",
    args: squad === "off" ? {} : { squad: { kind: "squadRole", role: squad } },
  };
}

const RAT_NEAR = entity({ itemID: 6661, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 2000, y: 0, z: 0 } });
const RAT_FAR = entity({ itemID: 6662, typeID: BRICK_TYPE, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 40000, y: 0, z: 0 } });

test("follow: the fleet's call outranks this pilot's own pick", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const tick = fight(
    fightStep("follow"),
    obs({ snapshot: snapshot([RAT_NEAR, RAT_FAR]), weaponModuleIDs: [500], squadPrimaryTargetID: 6662 }),
    {},
    {},
  );
  assert.ok(tick.action.kind === "lock" && tick.action.targetID === 6662);
  assert.match(tick.why, /fleet called/i);
});

test("follow: a call for a ship that is NOT here changes nothing", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const elsewhere = fight(
    fightStep("follow"),
    obs({ snapshot: snapshot([RAT_NEAR, RAT_FAR]), weaponModuleIDs: [500], squadPrimaryTargetID: 999999 }),
    {},
    {},
  );
  assert.ok(elsewhere.action.kind === "lock" && elsewhere.action.targetID === 6661, "its own ladder, unchanged");

  // No call at all reads the same way — a quiet fleet never stalls a follower.
  const quiet = fight(fightStep("follow"), obs({ snapshot: snapshot([RAT_NEAR, RAT_FAR]), weaponModuleIDs: [500] }), {}, {});
  assert.ok(quiet.action.kind === "lock" && quiet.action.targetID === 6661);
});

test("follow: a NEW call mid-fight switches the primary", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const switched = fight(
    fightStep("follow"),
    obs({ snapshot: snapshot([RAT_NEAR, RAT_FAR]), weaponModuleIDs: [500], lockedTargetIDs: [6661], squadPrimaryTargetID: 6662 }),
    { targetID: 6661, lockIssued: true, waited: 0, dronesOn: 6661 },
    {},
  );
  assert.ok(switched.action.kind === "lock" && switched.action.targetID === 6662);
});

test("call: the fleet is told once per primary, then the fight goes on", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const state = obs({ snapshot: snapshot([RAT_NEAR]), weaponModuleIDs: [500], lockedTargetIDs: [6661] });

  const called = fight(fightStep("call"), state, { targetID: 6661, lockIssued: true, waited: 0, dronesOn: null }, {});
  assert.ok(called.action.kind === "callPrimary" && called.action.targetID === 6661);
  assert.equal(called.nextMem["calledTargetID"], 6661);

  // Next tick, with the call remembered, the guns come up as usual.
  const shooting = fight(fightStep("call"), state, { ...called.nextMem }, {});
  assert.ok(shooting.action.kind === "activate" && shooting.action.targetID === 6661);
});

test("call: the call is stood down when the grid clears", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const cleared = fight(fightStep("call"), obs({ snapshot: snapshot([]) }), { calledTargetID: 6661 }, {});
  assert.ok(cleared.action.kind === "callPrimary" && cleared.action.targetID === null);

  // …and once it is down, the block finishes as it always did.
  const done = fight(fightStep("call"), obs({ snapshot: snapshot([]) }), { calledTargetID: null }, {});
  assert.equal(done.outcome.kind, "done");
});

test("off: a block that never mentions the fleet never calls anything", () => {
  const fight = SCRIPT_MACROS["fight-the-rats"]!;
  const state = obs({ snapshot: snapshot([RAT_NEAR]), weaponModuleIDs: [500], lockedTargetIDs: [6661], squadPrimaryTargetID: 6662 });
  const tick = fight(fightStep("off"), state, { targetID: 6661, lockIssued: true, waited: 0, dronesOn: null }, {});
  assert.notEqual(tick.action.kind, "callPrimary");
  assert.ok(tick.action.kind === "activate" && tick.action.targetID === 6661, "and a call it is not following is ignored");
});

