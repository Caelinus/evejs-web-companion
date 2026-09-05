// The R26 mining bot, driven against SYNTHETIC state exactly as
// `autopilotLoop.test.ts` drives the flight ladder: each case hands the
// decision one reading of the world and asserts which single atomic action
// comes back, at the right rung and in the right order.
//
// Three things are asserted over and over here, because they are the three
// things that make a bot safe to walk away from:
//
//   1. A 200 IS NOT PROOF. Every mutation in these tests can be made to answer
//      success while the AUTHORITY (GetTargets, activeModuleIDs, the hold, the
//      drone rows, flight status) says nothing changed — and the bot must
//      notice, not carry on.
//   2. NO BRANCH REPEATS UNBOUNDEDLY. Every rung gets a world in which it can
//      never make progress, and every one of them must stop with a reason a
//      player can read.
//   3. DANGER OUTRANKS YIELD. A pirate gets the drones out; the health floor
//      abandons the belt; an unreadable shield bar next to a pirate stops the
//      bot rather than letting it guess.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BELT_ARRIVAL_RADIUS_M,
  MAX_ACTIVATE_ATTEMPTS,
  MAX_CONSECUTIVE_LOCK_FAILURES,
  MAX_LAUNCH_ATTEMPTS,
  MAX_LOCK_ATTEMPTS,
  MAX_NO_YIELD_CYCLES,
  MAX_UNDOCK_ATTEMPTS,
  MAX_UNLOAD_ATTEMPTS,
  createMiningBot,
  decideMiningAction,
  destinationHold,
  freightHoldItemIDs,
  HAUL_AT_FRACTION,
  holdItemIDs,
  holdShouldHaul,
  holdUnits,
  isMineableRock,
  lowestHealth,
  type MiningBotAction,
  type MiningBotController,
  type MiningBotDeps,
  type MiningBotProgress,
  type MiningDecisionMemory,
  type MiningObservation,
  type MiningPlan,
} from "./miningBotLoop.ts";
import { MAX_SILENT_DOCK_ATTEMPTS, MAX_WARP_ATTEMPTS, measureSpace } from "./autopilotLoop.ts";
import type {
  FlightStatus,
  MiningHold,
  SpaceEntity,
  SpaceShipStatus,
  SpaceSnapshot,
} from "../store/types.ts";

const SYSTEM = 30000142;
const STATION = 60003760;
const BELT = 40000123;
const SHIP = 9001;
const LASER_A = 7001;
const LASER_B = 7002;
const ROCK_A = 5001;
const ROCK_B = 5002;
const ROCK_C = 5003;
const DRONE_STACK = 8001;
const DRONE_IN_SPACE = 8101;
const PIRATE = 6001;

const PLAN: MiningPlan = {
  beltID: BELT,
  beltName: "Asteroid Belt 1",
  stationID: STATION,
  stationName: "Jita IV - Moon 4",
  miningModuleIDs: [LASER_A, LASER_B],
  healthFloor: 0.5,
  useDrones: true,
  myCharacterID: 1234,
};

// --- synthetic world builders ------------------------------------------------

function status(overrides: Partial<FlightStatus> = {}): FlightStatus {
  return {
    inSpace: true,
    docked: false,
    solarSystemID: SYSTEM,
    stationID: null,
    structureID: null,
    shipID: SHIP,
    shipMode: "STOP",
    shipSpeedFraction: 0,
    ...overrides,
  };
}

function entity(overrides: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: null,
    typeID: null,
    groupID: null,
    categoryID: null,
    name: null,
    ownerID: null,
    radius: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isSelf: false,
    shieldRatio: null,
    armorRatio: null,
    hullRatio: null,
    characterID: null,
    corporationID: null,
    allianceID: null,
    securityStatus: null,
    maxVelocity: null,
    mode: null,
    capacitorRatio: null,
    remainingQuantity: null,
    miningYieldTypeID: null,
    beltID: null,
    oreGrade: null,
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...overrides,
  };
}

/** A rock: the mining fields the gateway projects onto asteroid rows only. */
function rock(itemID: number, metres: number, remaining: number | null, name: string): SpaceEntity {
  return entity({
    itemID,
    kind: "asteroid",
    name,
    position: { x: metres, y: 0, z: 0 },
    miningYieldTypeID: 1230,
    beltID: BELT,
    remainingQuantity: remaining,
  });
}

function pirate(metres = 12_000): SpaceEntity {
  return entity({
    itemID: PIRATE,
    kind: "ship",
    name: "Serpentis Scout",
    position: { x: metres, y: 0, z: 0 },
    isNpc: true,
    npcEntityType: "npc",
  });
}

function myDrone(): SpaceEntity {
  return entity({
    itemID: DRONE_IN_SPACE,
    kind: "drone",
    name: "Hobgoblin I",
    ownerID: PLAN.myCharacterID,
    controllerID: SHIP,
    droneActivity: "idle",
  });
}

/**
 * A drone I OWN but the ship no longer CONTROLS (controllerID null) — the R48
 * live case: an abandoned `Ice Harvesting Drone II` left drifting in Perimeter
 * II - Asteroid Belt 1. It is listed as mine, but it defends nothing and cannot
 * be ordered, so it must NOT count as "drones already out".
 */
function abandonedDrone(): SpaceEntity {
  return entity({
    itemID: 8102,
    kind: "drone",
    name: "Ice Harvesting Drone II",
    ownerID: PLAN.myCharacterID,
    controllerID: null,
    droneActivity: "idle",
  });
}

function ship(overrides: Partial<SpaceShipStatus> = {}): SpaceShipStatus {
  return {
    itemID: SHIP,
    typeID: 620,
    name: "Miner",
    mode: "STOP",
    maxVelocity: 200,
    radius: 60,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    shieldRatio: 1,
    armorRatio: 1,
    hullRatio: 1,
    capacitorRatio: 1,
    shieldCapacity: 1000,
    armorCapacity: 1000,
    hullCapacity: 1000,
    activeModuleIDs: [],
    overloadedModuleIDs: [],
    moduleDamage: {},
    weaponBanks: {},
    ...overrides,
  };
}

function snapshot(
  entities: readonly SpaceEntity[],
  shipOverrides: Partial<SpaceShipStatus> = {},
): SpaceSnapshot {
  return {
    inSpace: true,
    solarSystemID: SYSTEM,
    shipID: SHIP,
    sampledAtMs: 0,
    ship: ship(shipOverrides),
    entities: [...entities],
  };
}

/** An ore hold with a capacity and a stack in it. */
function oreHold(used: number, capacity = 5_000, items: readonly number[] = []): MiningHold {
  return {
    key: "ore",
    label: "Ore hold",
    items: items.map((quantity, index) => ({
      itemID: 90_000 + index,
      typeID: 1230,
      quantity,
    })),
    capacity: { capacity, used },
    present: true,
    error: null,
  };
}

const EMPTY_MEMORY: MiningDecisionMemory = {
  currentRockID: null,
  lockRefusedRockIDs: new Set<number>(),
  approachingTargetID: null,
  headingHome: null,
  launchGaveUp: false,
  noYieldCycles: 0,
};

function memory(overrides: Partial<MiningDecisionMemory> = {}): MiningDecisionMemory {
  return { ...EMPTY_MEMORY, ...overrides };
}

function observe(overrides: Partial<MiningObservation> = {}): MiningObservation {
  const space = overrides.snapshot === undefined ? snapshot([]) : overrides.snapshot;
  return {
    status: status(),
    snapshot: space,
    measurement: measureSpace(space),
    lockedTargetIDs: [],
    holds: [oreHold(0)],
    droneBayItemIDs: null,
    ...overrides,
    // measurement always tracks whatever snapshot ended up in play unless the
    // caller supplied one explicitly.
    ...(overrides.measurement === undefined ? { measurement: measureSpace(space) } : {}),
  };
}

function decide(overrides: Partial<MiningObservation>, mem = EMPTY_MEMORY) {
  return decideMiningAction(observe(overrides), PLAN, mem);
}

// --- the readers -------------------------------------------------------------

function cargoHoldWith(items: readonly number[], present = true): MiningHold {
  return {
    key: "cargo",
    label: "Cargo hold",
    items: items.map((itemID) => ({ itemID, typeID: 3389, quantity: 1 })),
    capacity: { capacity: 400, used: 0 },
    present,
    error: null,
  };
}

test("a delivery empties the SPECIALISED holds and leaves the cargo hold alone", () => {
  // The bug this exists to stop: a barge's spare mining crystals live in cargo,
  // and every lap put them in the station hangar because the mining-holds route
  // reports cargo as a fallback entry on every hull.
  const holds = [oreHold(1_000, 5_000, [500]), cargoHoldWith([70_001, 70_002])];
  assert.deepEqual([...freightHoldItemIDs(holds)], [90_000], "only the ore hold's stack");
  // The old reading, kept here so the difference is explicit rather than implied.
  assert.deepEqual([...holdItemIDs(holds)], [90_000, 70_001, 70_002]);
});

test("a hull with NO specialised hold still delivers out of cargo", () => {
  // The case the fallback was written for: a frigate mines straight into cargo,
  // and refusing to unload it there would strand the ore.
  const holds = [cargoHoldWith([70_001])];
  assert.deepEqual([...freightHoldItemIDs(holds)], [70_001]);
});

test("a specialised hold whose CAPACITY read failed is still the hull's own hold", () => {
  // The mining-holds route folds "absent" and "capacity unreadable" into the
  // same present:false. Contents are the second witness — without them one
  // failed read would demote a barge to "no ore hold" and ship its cargo out.
  const blindOre: MiningHold = {
    key: "ore",
    label: "Ore hold",
    items: [{ itemID: 90_500, typeID: 1230, quantity: 10 }],
    capacity: null,
    present: false,
    error: "READ_FAILED",
  };
  assert.deepEqual([...freightHoldItemIDs([blindOre, cargoHoldWith([70_001])])], [90_500]);
});

test("an empty ore hold on a hull that has one does NOT fall back to cargo", () => {
  // "Nothing left to deliver" — not "so take the cargo hold instead".
  const holds = [oreHold(0, 5_000, []), cargoHoldWith([70_001])];
  assert.deepEqual([...freightHoldItemIDs(holds)], []);
});

test("unreadable holds deliver nothing rather than guessing", () => {
  assert.deepEqual([...freightHoldItemIDs(null)], []);
  assert.deepEqual([...freightHoldItemIDs([])], []);
});

test("the destination hold is the hull's specialised one, falling back to cargo", () => {
  const cargo: MiningHold = {
    key: "cargo",
    label: "Cargo hold",
    items: [],
    capacity: { capacity: 400, used: 400 },
    present: true,
    error: null,
  };
  // A frigate with no ore bay mines into cargo — the runtime's own fallback.
  assert.equal(destinationHold([cargo])?.key, "cargo");
  // A barge has both, and mining fills the ORE hold. A full cargo bay of
  // something else must never read as "the ship is full of ore".
  assert.equal(destinationHold([oreHold(0), cargo])?.key, "ore");
  assert.equal(destinationHold(null), null);
  assert.equal(destinationHold([]), null);
});

test("hauling is a FRACTION of the server's capacity, and unknown is never a haul", () => {
  assert.equal(holdShouldHaul(oreHold(0)), false);
  // 5,000 m³ hold: the bot goes at 4,500.
  assert.equal(holdShouldHaul(oreHold(4_499)), false);
  assert.equal(holdShouldHaul(oreHold(4_500)), true);
  assert.equal(holdShouldHaul(oreHold(5_000)), true);
  // Room to spare with items in it is still not a haul.
  assert.equal(holdShouldHaul(oreHold(1_000, 5_000, [10_000])), false);
  // A hull that did not report a capacity is UNKNOWN — never a haul, never room.
  assert.equal(
    holdShouldHaul({ key: "ore", label: "Ore hold", items: [], capacity: null, present: true, error: null }),
    null,
  );
  assert.equal(holdShouldHaul(null), null);
  // The threshold is the named constant, not a number sprinkled in the code.
  assert.equal(holdShouldHaul(oreHold(16_000 * HAUL_AT_FRACTION, 16_000)), true);
});

test("THE R26 REGRESSION STAYS COVERED: the boundary that never hauled is far past the mark", () => {
  // Observed live on a Retriever: the ore hold stopped at 15999.95 of 16000 m³
  // with the server refusing to start another cycle, and `used >= capacity` is
  // FALSE there — so the bot re-lit the lasers forever and never hauled.
  //
  // Under the 90% rule that boundary is not a special case at all: a 16,000 m³
  // hold is hauled at 14,400, and 15,999.95 passed that 1,599 m³ ago. The whole
  // class of "does exactly one more unit fit" questions is gone.
  assert.equal(holdShouldHaul(oreHold(15_999.95, 16_000, [159_999.5])), true);

  // ⚠ AND IT NO LONGER DEPENDS ON READING THE ITEMS. The old derivation needed
  // the stack list to work out one unit's volume, so an unreadable hold fell
  // back to `used >= capacity` and returned FALSE on exactly this number — the
  // original bug, still live whenever the item read failed. Capacity alone now
  // answers it.
  const blind: MiningHold = {
    key: "ore",
    label: "Ore hold",
    items: null,
    capacity: { capacity: 16_000, used: 15_999.95 },
    present: true,
    error: "READ_FAILED",
  };
  assert.equal(holdShouldHaul(blind), true, "capacity alone decides; the stacks are not needed");
});

test("THE MIXED-ORE HOLD THE R39 SOAK MEASURED: the average that decided it is gone", () => {
  // Real numbers off the live Procurer (16,000 m³ ore hold), both hauls:
  //
  //   haul 1  type 17464 x 96,728 @ 0.15 + Veldspar x 14,908 @ 0.1 = 16,000.00
  //   haul 2  type 17464 x 71,866 @ 0.15 + Veldspar x 52,200 @ 0.1 = 15,999.90
  //
  // reconciled against the station hangar to the cubic metre. The old predicate
  // derived ONE unit volume as `used / units`, which across a mixed hold is an
  // average describing NEITHER ore — 0.1433 on haul 1 while the bot was mining
  // 0.15. When that average sits below the volume of the ore actually arriving,
  // the test fires too LATE: the bot reads "not full", relights on a rock whose
  // unit cannot fit, and stalls. Haul 1 was in exactly that state and escaped
  // only because the fill happened to land on 0.00 free.
  //
  // At 90% none of that arithmetic is reachable: both hauls are decided by
  // capacity alone, thousands of cubic metres earlier.
  const haul1 = oreHold(16_000.0, 16_000, [96_728, 14_908]);
  const haul2 = oreHold(15_999.9, 16_000, [71_866, 52_200]);
  assert.equal(holdShouldHaul(haul1), true);
  assert.equal(holdShouldHaul(haul2), true);

  // The mixed hold mid-fill, well under the mark, is still not a haul — the
  // headroom must not make the bot leave with a half-empty ship.
  assert.equal(holdShouldHaul(oreHold(9_000, 16_000, [50_000, 20_000])), false);

  // And the crossing itself: 14,400 is the mark for a 16,000 m³ hold, whatever
  // is in it and whatever it is mining.
  assert.equal(holdShouldHaul(oreHold(14_399.99, 16_000, [95_000, 5_000])), false);
  assert.equal(holdShouldHaul(oreHold(14_400, 16_000, [95_000, 5_000])), true);
});

test("hold units distinguish an empty hold from a hold nobody could read", () => {
  assert.equal(holdUnits([oreHold(100, 5_000, [500, 250])]), 750);
  assert.equal(holdUnits([oreHold(0)]), 0, "a readable empty hold is 0");
  assert.equal(
    holdUnits([{ key: "ore", label: "Ore hold", items: null, capacity: null, present: true, error: "READ_FAILED" }]),
    null,
    "a hold nobody could read is unknown, never 0",
  );
  assert.equal(holdUnits(null), null);
});

test("a rock is identified by the mining fields the gateway projects, not by guesswork", () => {
  assert.equal(isMineableRock(rock(ROCK_A, 5_000, 1_000, "Veldspar")), true);
  // A wreck, a can, a planet: none of them carry the mining fields.
  assert.equal(isMineableRock(entity({ itemID: 1, kind: "wreck", name: "Wreck" })), false);
  assert.equal(isMineableRock(pirate()), false);
});

test("the health floor reads the LOWEST layer, and reports unknown as unknown", () => {
  assert.equal(lowestHealth(snapshot([], { shieldRatio: 0.4, armorRatio: 1, hullRatio: 1 })), 0.4);
  assert.equal(lowestHealth(snapshot([], { shieldRatio: 1, armorRatio: 0.2, hullRatio: 1 })), 0.2);
  assert.equal(
    lowestHealth(snapshot([], { shieldRatio: null, armorRatio: null, hullRatio: null })),
    null,
    "no readable layer is unknown, never 1.0",
  );
});

// --- the ladder, rung by rung ------------------------------------------------

test("rung 2: docked with ore in the hold UNLOADS before anything else", () => {
  const decision = decide({
    status: status({ docked: true, inSpace: false, stationID: STATION }),
    snapshot: null,
    holds: [oreHold(2_000, 5_000, [1_500])],
  });
  assert.equal(decision.action.kind, "unload");
  assert.match(decision.why, /hangar/i);
});

test("rung 3: docked with a confirmed-empty hold UNDOCKS", () => {
  const decision = decide({
    status: status({ docked: true, inSpace: false, stationID: STATION }),
    snapshot: null,
    holds: [oreHold(0)],
  });
  assert.equal(decision.action.kind, "undock");
});

test("docked with a hold NOBODY COULD READ does not undock — it waits", () => {
  // Heading back out with an unread hold risks flying to the belt full. "We
  // could not look" is not "it is empty".
  const decision = decide({
    status: status({ docked: true, inSpace: false, stationID: STATION }),
    snapshot: null,
    holds: null,
  });
  assert.equal(decision.action.kind, "wait");
  assert.match(decision.why, /looking in the hold/i);
});

test("rung 4: a FULL hold in space heads for the station and docks when in range", () => {
  // Far out: warp.
  const far = decide({
    snapshot: snapshot([entity({ itemID: STATION, kind: "station", position: { x: 5e9, y: 0, z: 0 } })]),
    holds: [oreHold(5_000, 5_000, [5_000])],
  });
  assert.equal(far.action.kind, "warp");
  if (far.action.kind === "warp") {
    assert.equal(far.action.destinationID, STATION);
  }
  assert.match(far.why, /full/i);

  // Inside the server's own 2,500 m SURFACE docking radius (R24 slice B): dock.
  const close = decide({
    snapshot: snapshot([entity({ itemID: STATION, kind: "station", position: { x: 1_000, y: 0, z: 0 } })]),
    holds: [oreHold(5_000, 5_000, [5_000])],
  });
  assert.equal(close.action.kind, "dock");
});

test("rung 5: with nothing locked, the NEAREST mineable rock on the grid is locked — the ore count is not consulted", () => {
  const decision = decide({
    snapshot: snapshot([
      rock(ROCK_B, 40_000, 5_000, "Scordite"),
      rock(ROCK_A, 8_000, 1_200, "Veldspar"),
      // Nearest, and its stale ore reading is 0. The bot still picks it: depletion
      // is the server's call — it removes a mined-out rock from the grid — so a
      // rock the server still shows is a rock to mine. R49 stopped predicting it.
      rock(ROCK_C, 2_000, 0, "Plagioclase"),
    ]),
  });
  assert.equal(decision.action.kind, "lock");
  if (decision.action.kind === "lock") {
    assert.equal(decision.action.targetID, ROCK_C, "the nearest rock on the grid, whatever its ore reading");
  }
  assert.equal(decision.takeRock, ROCK_C);
  // R9a / R7d: the reason names the ore and the distance, never an id.
  assert.match(decision.why, /Plagioclase/);
  assert.doesNotMatch(decision.why, new RegExp(String(ROCK_C)));
});

test("rung 6: a locked rock with idle lasers switches the equipment on, one module per tick", () => {
  const world = {
    snapshot: snapshot([rock(ROCK_A, 8_000, 1_200, "Veldspar")], { activeModuleIDs: [] }),
    lockedTargetIDs: [ROCK_A],
  };
  const first = decide(world, memory({ currentRockID: ROCK_A }));
  assert.equal(first.action.kind, "activate");
  if (first.action.kind === "activate") {
    assert.equal(first.action.moduleID, LASER_A, "one atomic call per tick");
    assert.equal(first.action.targetID, ROCK_A);
  }

  // With A running, the next tick starts B — from activeModuleIDs, the SERVER's
  // own answer, never from what the loop remembers clicking.
  const second = decide(
    {
      snapshot: snapshot([rock(ROCK_A, 8_000, 1_200, "Veldspar")], { activeModuleIDs: [LASER_A] }),
      lockedTargetIDs: [ROCK_A],
    },
    memory({ currentRockID: ROCK_A }),
  );
  assert.equal(second.action.kind, "activate");
  if (second.action.kind === "activate") {
    assert.equal(second.action.moduleID, LASER_B);
  }

  // Both running: it is mining, and it says which rock — but NOT a units count.
  // R49 removed the depletion readout, so the "why" names the rock and no more.
  const mining = decide(
    {
      snapshot: snapshot([rock(ROCK_A, 8_000, 1_200, "Veldspar")], {
        activeModuleIDs: [LASER_A, LASER_B],
      }),
      lockedTargetIDs: [ROCK_A],
    },
    memory({ currentRockID: ROCK_A }),
  );
  assert.equal(mining.action.kind, "wait");
  assert.match(mining.why, /Mining Veldspar/);
  assert.doesNotMatch(mining.why, /1,200|units left/i);
});

test("a rock the ship ALREADY holds is adopted, not re-locked — and the lasers go on the same tick", () => {
  // The player locked a rock themselves and then pressed Start. Asking the
  // server to lock a ball it already holds would spend a whole tick changing
  // nothing, so the decision adopts it and goes straight to rung 6.
  const decision = decide({
    snapshot: snapshot([rock(ROCK_A, 8_000, 1_200, "Veldspar")], { activeModuleIDs: [] }),
    lockedTargetIDs: [ROCK_A],
  });
  assert.equal(decision.action.kind, "activate");
  assert.equal(decision.takeRock, ROCK_A, "and it takes ownership of that rock");
  assert.match(decision.why, /Veldspar is locked/);
});

test("A 200 IS NOT PROOF: a rock the lock call accepted but GetTargets does not list is re-locked, not mined", () => {
  const decision = decide(
    {
      snapshot: snapshot([rock(ROCK_A, 8_000, 1_200, "Veldspar")]),
      lockedTargetIDs: [], // the AUTHORITY says nothing is locked
    },
    memory({ currentRockID: ROCK_A }),
  );
  assert.equal(decision.action.kind, "lock", "it does not switch a laser on a lock it cannot see");
});

test("A 200 IS NOT PROOF: activeModuleIDs UNKNOWN never reads as off — nothing is switched on", () => {
  const decision = decide(
    {
      snapshot: snapshot([rock(ROCK_A, 8_000, 1_200, "Veldspar")], { activeModuleIDs: null }),
      lockedTargetIDs: [ROCK_A],
    },
    memory({ currentRockID: ROCK_A }),
  );
  assert.equal(decision.action.kind, "wait");
  assert.match(decision.why, /did not say which equipment is running/i);
});

test("the lock authority failing stops the bot deciding anything that depends on a lock", () => {
  const decision = decide(
    { snapshot: snapshot([rock(ROCK_A, 8_000, 1_200, "Veldspar")]), lockedTargetIDs: null },
    memory({ currentRockID: ROCK_A }),
  );
  assert.equal(decision.action.kind, "wait");
  assert.match(decision.why, /what your ship has locked/i);
});

test("rung 7: the ONLY way a rock is dropped is the server removing it from the grid — a stale 0-ore rock is still mined", () => {
  // A rock still on the grid, locked, whose stale ore reading is 0: the bot runs
  // the lasers on it and never lets it go for the count. Depletion is the
  // server's — it removes a mined-out rock — so the client mines what is on field.
  const stale = decide(
    { snapshot: snapshot([rock(ROCK_A, 8_000, 0, "Veldspar")]), lockedTargetIDs: [ROCK_A] },
    memory({ currentRockID: ROCK_A }),
  );
  assert.equal(stale.dropRock, undefined, "a 0-ore rock the server still shows is not dropped");
  assert.equal(stale.rung, "rock-is-locked");

  // The locked rock is simply gone from the snapshot (the server took it): the
  // one reactive release verb fires, and it does not blacklist.
  const gone = decide(
    { snapshot: snapshot([rock(ROCK_B, 9_000, 900, "Scordite")]), lockedTargetIDs: [] },
    memory({ currentRockID: ROCK_A }),
  );
  assert.equal(gone.dropRock, "it went out of view");
  assert.equal(gone.rung, "rock-out-of-view");
  assert.match(gone.why, /no longer in view/i);
});

test("rung 8: at the belt with NO mineable rocks on the grid PAUSES with a plain reason — it does not wander", () => {
  const decision = decide({
    // The belt is right here (inside the arrival radius) and the grid holds no
    // rocks at all — the server has removed them as they were mined out. A rock
    // with a stale 0-ore reading would still be MINED (see rung 5), so an empty
    // belt is only ever an empty grid, never a client guess about ore.
    snapshot: snapshot([
      entity({ itemID: BELT, kind: "celestial", name: "Asteroid Belt 1", position: { x: 500, y: 0, z: 0 } }),
    ]),
  });
  assert.equal(decision.action.kind, "pause");
  if (decision.action.kind === "pause") {
    assert.match(decision.action.reason, /no rocks left to mine/i);
    assert.match(decision.action.reason, /Asteroid Belt 1/);
  }
});

test("no rocks and the belt is far away: it flies there (warp, then approach) rather than pausing", () => {
  const far = decide({
    snapshot: snapshot([entity({ itemID: BELT, kind: "celestial", position: { x: 4e9, y: 0, z: 0 } })]),
  });
  assert.equal(far.action.kind, "warp");
  if (far.action.kind === "warp") {
    assert.equal(far.action.destinationID, BELT);
  }

  // Landed short of the arrival radius but inside the R24 warp dead band: the
  // ladder closes the gap under sublight instead of asking for a warp the
  // server would silently refuse.
  const nearly = decide({
    snapshot: snapshot([
      entity({ itemID: BELT, kind: "celestial", position: { x: BELT_ARRIVAL_RADIUS_M + 5_000, y: 0, z: 0 } }),
    ]),
  });
  assert.equal(nearly.action.kind, "approach");
});

test("mid-warp the bot does NOTHING, whatever the measurement says is in reach", () => {
  const decision = decide({
    status: status({ shipMode: "WARP" }),
    snapshot: snapshot([rock(ROCK_A, 1_000, 5_000, "Veldspar")], { mode: "WARP" }),
  });
  assert.equal(decision.action.kind, "wait");
  assert.match(decision.why, /in warp/i);
});

// --- rung 1: danger first ----------------------------------------------------

test("rung 1: a pirate with no drones of ours out LAUNCHES — launching IS the defence", () => {
  const decision = decide({
    snapshot: snapshot([pirate(), rock(ROCK_A, 8_000, 5_000, "Veldspar")]),
    droneBayItemIDs: [DRONE_STACK],
  });
  assert.equal(decision.action.kind, "launch");
  if (decision.action.kind === "launch") {
    assert.deepEqual(decision.action.droneItemIDs, [DRONE_STACK]);
  }
  assert.match(decision.why, /defend the ship on their own/i);
});

test("rung 1: drones already out are not launched again — the SNAPSHOT is the authority", () => {
  const decision = decide({
    snapshot: snapshot([pirate(), myDrone(), rock(ROCK_A, 8_000, 5_000, "Veldspar")]),
    droneBayItemIDs: [DRONE_STACK],
  });
  assert.notEqual(decision.action.kind, "launch");
  assert.equal(decision.action.kind, "lock", "with the drones out it gets on with mining");
});

test("rung 1: an ABANDONED owned drone does NOT count as defence — the bay still LAUNCHES (R48 live)", () => {
  // Perimeter II, live: a pirate on grid, a full bay, and one owned drone the
  // ship can no longer command (controllerID null). A drone we cannot order is
  // not defending us, so the guard must count only CONTROLLED drones — else the
  // ship sits next to a pirate with ten combat drones still in the bay.
  const decision = decide({
    snapshot: snapshot([pirate(), abandonedDrone(), rock(ROCK_A, 8_000, 5_000, "Veldspar")]),
    droneBayItemIDs: [DRONE_STACK],
  });
  assert.equal(decision.action.kind, "launch", "a drone we cannot command is not defence");
  if (decision.action.kind === "launch") {
    assert.deepEqual(decision.action.droneItemIDs, [DRONE_STACK]);
  }
});

test("rung 1: the CONTROLLER reads the bay past an abandoned drone and launches (R48 live)", async () => {
  // Exercises observe() as well as the decision: the bay is only read when a
  // launch is on the table, and the same too-broad "mine" test gated that read.
  const { deps, rec } = makeDeps({
    status: () => status(),
    snapshot: () => snapshot([pirate(), abandonedDrone(), rock(ROCK_A, 8_000, 5_000, "Veldspar")]),
    bay: () => [DRONE_STACK],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 3);
  assert.ok(rec.calls.includes("launch"), "the controller sends the bay out despite the abandoned drone");
});

test("rung 1: an empty drone bay is not a reason to stop — the health floor is still armed", () => {
  const decision = decide({
    snapshot: snapshot([pirate(), rock(ROCK_A, 8_000, 5_000, "Veldspar")]),
    droneBayItemIDs: [],
  });
  assert.equal(decision.action.kind, "lock", "no drones to send, so it keeps mining");
});

test("rung 1: below the health floor it ABANDONS the belt and docks — survival outranks yield", () => {
  const decision = decide({
    snapshot: snapshot(
      [
        pirate(),
        rock(ROCK_A, 8_000, 5_000, "Veldspar"),
        entity({ itemID: STATION, kind: "station", position: { x: 5e9, y: 0, z: 0 } }),
      ],
      { shieldRatio: 0.3, armorRatio: 1, hullRatio: 1 },
    ),
    droneBayItemIDs: [DRONE_STACK],
  });
  // Not "launch": once under the floor no launch saves the ship.
  assert.equal(decision.action.kind, "warp");
  if (decision.action.kind === "warp") {
    assert.equal(decision.action.destinationID, STATION);
  }
  assert.ok(decision.headHome, "and it is sticky from here on");
  assert.match(String(decision.headHome), /30%/);
});

test("heading home is STICKY: shields regenerating does not send the bot back to the belt", () => {
  const decision = decide(
    {
      snapshot: snapshot(
        [
          rock(ROCK_A, 8_000, 5_000, "Veldspar"),
          entity({ itemID: STATION, kind: "station", position: { x: 800, y: 0, z: 0 } }),
        ],
        { shieldRatio: 1, armorRatio: 1, hullRatio: 1 }, // fully healed
      ),
    },
    memory({ headingHome: "Your ship is down to 30%, so the bot broke off." }),
  );
  assert.equal(decision.action.kind, "dock");
});

test("rung 1: a pirate AND an unreadable shield bar stops the bot rather than guessing", () => {
  const decision = decide({
    snapshot: snapshot([pirate(), rock(ROCK_A, 8_000, 5_000, "Veldspar")], {
      shieldRatio: null,
      armorRatio: null,
      hullRatio: null,
    }),
    droneBayItemIDs: [DRONE_STACK],
  });
  assert.equal(decision.action.kind, "pause");
  if (decision.action.kind === "pause") {
    assert.match(decision.action.reason, /could not be read/i);
  }
});

test("police are not pirates: CONCORD on the grid triggers nothing", () => {
  const concord = entity({
    itemID: 6002,
    kind: "ship",
    name: "CONCORD Police",
    isNpc: true,
    npcEntityType: "concord",
  });
  const decision = decide({
    snapshot: snapshot([concord, rock(ROCK_A, 8_000, 5_000, "Veldspar")]),
    droneBayItemIDs: [DRONE_STACK],
  });
  assert.equal(decision.action.kind, "lock");
});

// --- the controller: bounds --------------------------------------------------

interface Recorder {
  readonly calls: string[];
  readonly progress: MiningBotProgress[];
}

/** A deps object over a mutable world the test drives. */
function makeDeps(
  world: {
    status: () => FlightStatus;
    snapshot: () => SpaceSnapshot | null;
    locked?: () => readonly number[] | null;
    holds?: () => readonly MiningHold[] | null;
    bay?: () => readonly number[] | null;
    onCall?: (name: string, args: readonly number[]) => void;
    fail?: (name: string) => Error | null;
  },
): { deps: MiningBotDeps; rec: Recorder } {
  const calls: string[] = [];
  const progress: MiningBotProgress[] = [];
  const record = (name: string, args: readonly number[] = []): void => {
    calls.push(name);
    world.onCall?.(name, args);
    const failure = world.fail?.(name);
    if (failure) {
      throw failure;
    }
  };
  return {
    rec: { calls, progress },
    deps: {
      getStatus: async () => world.status(),
      getSpaceSnapshot: async () => world.snapshot(),
      getLockedTargetIDs: async () => (world.locked ? world.locked() : []),
      getHolds: async () => (world.holds ? world.holds() : [oreHold(0)]),
      getDroneBayItemIDs: async () => (world.bay ? world.bay() : []),
      undock: async () => record("undock"),
      warp: async (id) => record("warp", [id]),
      approach: async (id) => record("approach", [id]),
      dock: async (id) => record("dock", [id]),
      lockTarget: async (id) => record("lock", [id]),
      activateModule: async (m, t) => record("activate", [m, t]),
      launchDrones: async (ids) => record("launch", [...ids]),
      unloadHolds: async (ids) => record("unload", [...ids]),
      sleep: async () => {},
      onProgress: (p) => progress.push(p),
      isSessionLost: (e) => (e as { code?: string })?.code === "SESSION_NOT_FOUND",
      refusalReason: (e) => (e instanceof Error ? e.message : String(e)),
    },
  };
}

function refusal(message: string, code = "CALL_REFUSED"): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

async function drive(bot: MiningBotController, ticks: number): Promise<MiningBotAction[]> {
  const actions: MiningBotAction[] = [];
  for (let i = 0; i < ticks; i += 1) {
    actions.push(await bot.tick());
  }
  return actions;
}

test("ready-returning undock and dock advance on the next tick without duplicate calls", async () => {
  let outboundDocked = true;
  const outbound = makeDeps({
    status: () => outboundDocked
      ? status({ docked: true, inSpace: false, stationID: STATION })
      : status(),
    snapshot: () => outboundDocked
      ? null
      : snapshot([
        entity({ itemID: BELT, kind: "celestial", position: { x: 4e9, y: 0, z: 0 } }),
      ]),
    holds: () => [oreHold(0)],
    onCall: (name) => {
      if (name === "undock") {
        outboundDocked = false;
      }
    },
  });
  const outboundBot = createMiningBot(outbound.deps);
  outboundBot.start(PLAN);

  assert.equal((await outboundBot.tick()).kind, "undock");
  assert.equal(
    (await outboundBot.tick()).kind,
    "warp",
    "authoritative undock readiness removes the old settle window",
  );
  assert.deepEqual(outbound.rec.calls, ["undock", "warp"]);

  let inboundDocked = false;
  const inbound = makeDeps({
    status: () => inboundDocked
      ? status({ docked: true, inSpace: false, stationID: STATION })
      : status(),
    snapshot: () => inboundDocked
      ? null
      : snapshot([
        entity({ itemID: STATION, kind: "station", position: { x: 800, y: 0, z: 0 } }),
      ]),
    holds: () => [oreHold(5_000, 5_000, [5_000])],
    onCall: (name) => {
      if (name === "dock") {
        inboundDocked = true;
      }
    },
  });
  const inboundBot = createMiningBot(inbound.deps);
  inboundBot.start(PLAN);

  assert.equal((await inboundBot.tick()).kind, "dock");
  assert.equal(
    (await inboundBot.tick()).kind,
    "unload",
    "authoritative dock readiness allows the immediate docked decision",
  );
  assert.deepEqual(inbound.rec.calls, ["dock", "unload"]);
});

test("BOUND: a lock that never lands gives up on that ROCK, then on the belt — it never spins", async () => {
  // Every lock call answers 200 and GetTargets never lists anything: the exact
  // silent-decline shape this server has six confirmed cases of.
  const rocks = [
    rock(ROCK_A, 8_000, 5_000, "Veldspar"),
    rock(ROCK_B, 9_000, 5_000, "Scordite"),
    rock(ROCK_C, 10_000, 5_000, "Plagioclase"),
    rock(5004, 11_000, 5_000, "Pyroxeres"),
  ];
  const { deps, rec } = makeDeps({
    status: () => status(),
    snapshot: () => snapshot(rocks),
    locked: () => [],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 200);

  const locks = rec.calls.filter((c) => c === "lock").length;
  assert.ok(locks > 0, "it does try");
  assert.ok(
    locks <= MAX_LOCK_ATTEMPTS * MAX_CONSECUTIVE_LOCK_FAILURES + MAX_CONSECUTIVE_LOCK_FAILURES,
    `bounded (issued ${locks})`,
  );
  const final = bot.snapshot();
  assert.equal(final.status, "paused", "it stops rather than trying every rock forever");
  assert.match(String(final.failureReason), /would not lock/i);
});

test("BOUND: a laser that answers 200 and never appears in activeModuleIDs PAUSES and says so", async () => {
  const { deps, rec } = makeDeps({
    status: () => status(),
    // Locked, in view, plenty of ore — and activeModuleIDs stays empty forever.
    snapshot: () => snapshot([rock(ROCK_A, 8_000, 5_000, "Veldspar")], { activeModuleIDs: [] }),
    locked: () => [ROCK_A],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 200);

  const activations = rec.calls.filter((c) => c === "activate").length;
  assert.ok(activations > 0);
  assert.ok(activations <= MAX_ACTIVATE_ATTEMPTS + 1, `bounded (issued ${activations})`);
  assert.equal(bot.snapshot().status, "paused");
  assert.match(String(bot.snapshot().failureReason), /still reports it as off/i);
});

test("BOUND: a warp that changes nothing stops (R24 slice A's bound, unchanged)", async () => {
  const { deps, rec } = makeDeps({
    status: () => status(),
    // The belt is far away and the ship never moves, however many warps land.
    snapshot: () => snapshot([entity({ itemID: BELT, kind: "celestial", position: { x: 4e9, y: 0, z: 0 } })]),
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 100);

  const warps = rec.calls.filter((c) => c === "warp").length;
  assert.ok(warps > 0 && warps <= MAX_WARP_ATTEMPTS, `bounded (issued ${warps})`);
  assert.equal(bot.snapshot().status, "paused");
  assert.match(String(bot.snapshot().failureReason), /warp did not start/i);
});

test("BOUND: a Dock that answers 200 and seats nobody stops (R24 slice B's bound, unchanged)", async () => {
  const { deps, rec } = makeDeps({
    status: () => status(), // never docked
    snapshot: () => snapshot([entity({ itemID: STATION, kind: "station", position: { x: 800, y: 0, z: 0 } })]),
    holds: () => [oreHold(5_000, 5_000, [5_000])], // full: it wants to dock
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 200);

  const docks = rec.calls.filter((c) => c === "dock").length;
  assert.ok(docks > 0 && docks <= MAX_SILENT_DOCK_ATTEMPTS + 1, `bounded (issued ${docks})`);
  assert.equal(bot.snapshot().status, "paused");
  assert.match(String(bot.snapshot().failureReason), /has not taken the ship/i);
});

test("BOUND: an unload the hold never honours stops with the ore still aboard", async () => {
  const { deps, rec } = makeDeps({
    status: () => status({ docked: true, inSpace: false, stationID: STATION }),
    snapshot: () => null,
    holds: () => [oreHold(2_000, 5_000, [1_500])], // the stack never leaves
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 100);

  const unloads = rec.calls.filter((c) => c === "unload").length;
  assert.ok(unloads > 0 && unloads <= MAX_UNLOAD_ATTEMPTS + 1, `bounded (issued ${unloads})`);
  assert.equal(bot.snapshot().status, "paused");
  assert.match(String(bot.snapshot().failureReason), /would not move into the hangar/i);
});

test("BOUND: an undock that flight status never honours stops", async () => {
  const { deps, rec } = makeDeps({
    status: () => status({ docked: true, inSpace: false, stationID: STATION }),
    snapshot: () => null,
    holds: () => [oreHold(0)],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 100);

  const undocks = rec.calls.filter((c) => c === "undock").length;
  assert.ok(undocks > 0 && undocks <= MAX_UNDOCK_ATTEMPTS + 1, `bounded (issued ${undocks})`);
  assert.equal(bot.snapshot().status, "paused");
  assert.match(String(bot.snapshot().failureReason), /would not undock/i);
});

test("BOUND: a launch that answers 200 and puts no drone in space HEADS HOME, it does not sit there", async () => {
  // R25's live finding: a launch returns 200 while refusing drones inline. Next
  // to a pirate, pausing a defenceless ship is the worst available outcome — so
  // this bound leaves instead.
  const { deps, rec } = makeDeps({
    status: () => status(),
    snapshot: () =>
      snapshot([
        pirate(),
        rock(ROCK_A, 8_000, 5_000, "Veldspar"),
        entity({ itemID: STATION, kind: "station", position: { x: 5e9, y: 0, z: 0 } }),
      ]),
    bay: () => [DRONE_STACK],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 30);

  const launches = rec.calls.filter((c) => c === "launch").length;
  assert.ok(launches > 0 && launches <= MAX_LAUNCH_ATTEMPTS + 1, `bounded (issued ${launches})`);
  assert.ok(rec.calls.includes("warp"), "it heads for the station instead of sitting there");
  // The reason is on the readout the moment the bound is spent — the player can
  // see WHY it left the belt, not just that it did.
  assert.ok(
    rec.progress.some((p) => /heading back to the station/i.test(p.why ?? "")),
    "and it says why it broke off",
  );
  // (This synthetic ship cannot actually move, so the warp bound stops it a few
  // ticks later. That is the next bound doing its job, not this one failing.)
});

test("BOUND: lasers running for minutes with the hold not growing stops claiming it is mining", async () => {
  const { deps } = makeDeps({
    status: () => status(),
    snapshot: () =>
      snapshot([rock(ROCK_A, 8_000, 5_000, "Veldspar")], { activeModuleIDs: [LASER_A, LASER_B] }),
    locked: () => [ROCK_A],
    holds: () => [oreHold(0)], // never grows
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, MAX_NO_YIELD_CYCLES + 20);

  assert.equal(bot.snapshot().status, "paused");
  assert.match(String(bot.snapshot().failureReason), /nothing is arriving in the hold/i);
});

test("BOUND: a persistent flight-status failure stops, but a transient one does not", async () => {
  let failures = 3;
  let transientDocked = true;
  const { deps } = makeDeps({ status: () => status(), snapshot: () => snapshot([]) });
  const transient = createMiningBot({
    ...deps,
    getStatus: async () => {
      if (failures > 0) {
        failures -= 1;
        throw refusal("EveJS gateway timed out.", "EVE_GATEWAY_TIMEOUT");
      }
      return transientDocked
        ? status({ docked: true, inSpace: false, stationID: STATION })
        : status();
    },
    undock: async () => {
      await deps.undock();
      transientDocked = false; // ready-returning BFF exposes authoritative state
    },
  });
  transient.start(PLAN);
  await drive(transient, 8);
  assert.notEqual(transient.snapshot().status, "paused", "a slow read is not a fatal read");

  const forever = createMiningBot({
    ...deps,
    getStatus: async () => {
      throw refusal("EveJS gateway timed out.", "EVE_GATEWAY_TIMEOUT");
    },
  });
  forever.start(PLAN);
  await drive(forever, 20);
  assert.equal(forever.snapshot().status, "paused");
  assert.match(String(forever.snapshot().failureReason), /could not be read/i);
});

// --- the controller: refusals ------------------------------------------------

test("the SERVER owns range: a lock refused for range makes the ship close in, then retry", async () => {
  let refuseLock = true;
  const { deps, rec } = makeDeps({
    status: () => status(),
    snapshot: () => snapshot([rock(ROCK_A, 60_000, 5_000, "Veldspar")]),
    locked: () => (refuseLock ? [] : [ROCK_A]),
    fail: (name) => (name === "lock" && refuseLock ? refusal("Target is out of targeting range.") : null),
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 4);
  assert.ok(rec.calls.includes("approach"), "it closes in rather than reimplementing a range check");

  refuseLock = false;
  await drive(bot, 8);
  assert.ok(rec.calls.includes("activate"), "and then gets on with mining");
  assert.notEqual(bot.snapshot().status, "paused");
});

test("an unexpected refusal PAUSES with the server's own words — it does not guess", async () => {
  const { deps } = makeDeps({
    status: () => status(),
    snapshot: () => snapshot([rock(ROCK_A, 8_000, 5_000, "Veldspar")]),
    fail: (name) => (name === "lock" ? refusal("You cannot lock while cloaked.") : null),
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 10);

  assert.equal(bot.snapshot().status, "paused");
  assert.match(String(bot.snapshot().failureReason), /cloaked/i);
});

test("a lost session stops the bot as an error and it never calls the bridge again", async () => {
  const { deps, rec } = makeDeps({
    status: () => status(),
    snapshot: () => snapshot([rock(ROCK_A, 8_000, 5_000, "Veldspar")]),
    fail: (name) => (name === "lock" ? refusal("Bridge session gone.", "SESSION_NOT_FOUND") : null),
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await bot.tick();
  const after = rec.calls.length;
  await drive(bot, 5);

  assert.equal(bot.snapshot().status, "error");
  assert.match(String(bot.snapshot().failureReason), /session ended/i);
  assert.equal(rec.calls.length, after, "no further bridge calls after session loss");
});

// --- the controller: lifecycle -----------------------------------------------

test("stop halts the bot and it never calls the bridge afterwards", async () => {
  const { deps, rec } = makeDeps({
    status: () => status({ docked: true, inSpace: false, stationID: STATION }),
    snapshot: () => null,
    holds: () => [oreHold(0)],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await bot.tick();
  assert.deepEqual(rec.calls, ["undock"]);

  bot.stop();
  const atStop = rec.calls.length;
  const a = await bot.tick();
  const b = await bot.tick();
  assert.equal(a.kind, "stopped");
  assert.equal(b.kind, "stopped");
  assert.equal(rec.calls.length, atStop, "no bridge call after stop");
  assert.equal(bot.snapshot().status, "stopped");
});

test("pause holds the bot where it is; resume carries on from there", async () => {
  let docked = true;
  const { deps, rec } = makeDeps({
    status: () =>
      docked
        ? status({ docked: true, inSpace: false, stationID: STATION })
        : status(),
    snapshot: () => (docked ? null : snapshot([rock(ROCK_A, 8_000, 5_000, "Veldspar")])),
    holds: () => [oreHold(0)],
    onCall: (name) => {
      if (name === "undock") {
        docked = false;
      }
    },
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await bot.tick(); // undock
  bot.pause();
  const paused = rec.calls.length;

  await bot.tick();
  assert.equal(rec.calls.length, paused, "a paused bot issues nothing");
  assert.equal(bot.snapshot().status, "paused");

  bot.resume();
  await drive(bot, 10);
  assert.ok(rec.calls.includes("lock"), "and picks the run back up");
});

// --- the full cycle ----------------------------------------------------------

test("A FULL CYCLE: undock -> belt -> lock -> mine -> hold fills -> dock -> unload -> back out", async () => {
  // A fake world that advances the way the sim does: a warp lands the ship near
  // the belt, a lock lands after the settle, a running laser fills the hold a
  // little each tick, a full hold ends mining, and only FLIGHT STATUS docking
  // (never the Dock call's 200) counts as arrival.
  const world = {
    docked: true,
    atBelt: false,
    atStation: false,
    locked: [] as number[],
    active: [] as number[],
    used: 0,
    units: 0,
    hangar: 0,
  };

  const { deps, rec } = makeDeps({
    status: () =>
      world.docked
        ? status({ docked: true, inSpace: false, stationID: STATION })
        : status(),
    snapshot: () => {
      if (world.docked) {
        return null;
      }
      const entities: SpaceEntity[] = [
        entity({
          itemID: BELT,
          kind: "celestial",
          name: "Asteroid Belt 1",
          position: { x: world.atBelt ? 1_000 : 4e9, y: 0, z: 0 },
        }),
        entity({
          itemID: STATION,
          kind: "station",
          name: "Jita IV - Moon 4",
          position: { x: world.atStation ? 900 : 5e9, y: 0, z: 0 },
        }),
      ];
      if (world.atBelt) {
        entities.push(rock(ROCK_A, 5_000, 50_000, "Veldspar"));
      }
      return snapshot(entities, { activeModuleIDs: [...world.active] });
    },
    locked: () => [...world.locked],
    holds: () => [oreHold(world.used, 5_000, world.units > 0 ? [world.units] : [])],
    onCall: (name, args) => {
      switch (name) {
        case "undock":
          world.docked = false;
          world.atBelt = false;
          world.atStation = false;
          break;
        case "warp":
          // A warp lands the ship at whatever it was aimed at.
          world.atBelt = args[0] === BELT;
          world.atStation = args[0] === STATION;
          break;
        case "lock":
          world.locked = [args[0] as number];
          break;
        case "activate":
          world.active = [...new Set([...world.active, args[0] as number])];
          break;
        case "dock":
          if (world.atStation) {
            world.docked = true;
            world.locked = [];
            world.active = [];
          }
          break;
        case "unload":
          world.hangar += world.units;
          world.units = 0;
          world.used = 0;
          break;
        default:
          break;
      }
    },
  });

  // Each running laser puts ore in the hold — the ONLY evidence of mining this
  // loop accepts. Hooked onto the hold read so it advances with the ticks.
  const baseHolds = deps.getHolds;
  const bot = createMiningBot({
    ...deps,
    getHolds: async () => {
      if (!world.docked && world.active.length > 0 && world.used < 5_000) {
        world.used = Math.min(5_000, world.used + 800 * world.active.length);
        world.units = world.used * 10;
      }
      return baseHolds();
    },
  });

  bot.start(PLAN);
  await drive(bot, 120);

  const sequence = rec.calls;
  const order = (name: string): number => sequence.indexOf(name);
  assert.ok(order("undock") >= 0, "it left the station");
  assert.ok(order("warp") > order("undock"), "then flew to the belt");
  assert.ok(order("lock") > order("warp"), "then locked a rock");
  assert.ok(order("activate") > order("lock"), "then switched the equipment on");
  assert.ok(order("dock") > order("activate"), "then hauled the full hold home");
  assert.ok(order("unload") > order("dock"), "and unloaded it");

  // THE PHASE MUST NOT CONTRADICT THE REASON. Live, a full hold sets no
  // "heading home" flag — it does not need one — so a label keyed off that flag
  // announced "Flying to the belt" while the ship warped to the station with a
  // full load. The label is decided from where the move is AIMED, so both
  // phases must appear across a run that does both.
  const phases = new Set(rec.progress.map((p) => p.phase));
  assert.ok(phases.has("Hauling"), `the haul reads as hauling (saw: ${[...phases].join(", ")})`);
  assert.ok(phases.has("Flying to the belt"), "and the outbound leg reads as the outbound leg");
  assert.ok(phases.has("Mining"), "and mining reads as mining");
  for (const frame of rec.progress) {
    if (frame.phase === "Hauling") {
      assert.doesNotMatch(String(frame.why), /Heading for/, "a haul never says it is heading out");
    }
  }

  const final = bot.snapshot();
  assert.equal(final.cyclesCompleted >= 1, true, `a haul was completed (${final.cyclesCompleted})`);
  assert.ok(final.oreUnitsMined > 0, `ore was counted from the hold (${final.oreUnitsMined})`);
  assert.equal(world.hangar > 0, true, "and it is in the hangar");
  // And it went back out for another load rather than stopping at one.
  assert.ok(sequence.filter((c) => c === "undock").length >= 2, "it started the next run");
  assert.notEqual(final.status, "paused");
});

test("ore is counted from the HOLD growing, never from cycles or a yield sum", async () => {
  let units = 0;
  const { deps } = makeDeps({
    status: () => status(),
    snapshot: () =>
      snapshot([rock(ROCK_A, 5_000, 50_000, "Veldspar")], { activeModuleIDs: [LASER_A, LASER_B] }),
    locked: () => [ROCK_A],
    holds: () => [oreHold(units / 10, 5_000, units > 0 ? [units] : [])],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);

  await drive(bot, 4);
  assert.equal(bot.snapshot().oreUnitsMined, 0, "nothing in the hold, nothing claimed");
  units = 300;
  await drive(bot, 4);
  units = 750;
  await drive(bot, 4);
  assert.equal(bot.snapshot().oreUnitsMined, 750, "exactly what the hold gained, no more");
});

test("a PARTIAL hold read cannot mint phantom ore, and real growth still counts after it", async () => {
  // Two holds answer the read. Mid-run the ore hold's items DROP for a tick
  // while the cargo hold still reads — the total dips by the whole ore hold,
  // and the old baseline adopted the dip, so the ore's return on the next full
  // read counted as freshly mined. Nothing was mined here at all.
  const cargoHold: MiningHold = {
    key: "cargo",
    label: "Cargo hold",
    items: [{ itemID: 99_999, typeID: 34, quantity: 20 }],
    capacity: { capacity: 500, used: 20 },
    present: true,
    error: null,
  };
  let units = 500;
  let dropOreItems = false;
  const { deps } = makeDeps({
    status: () => status(),
    snapshot: () =>
      snapshot([rock(ROCK_A, 5_000, 50_000, "Veldspar")], { activeModuleIDs: [LASER_A, LASER_B] }),
    locked: () => [ROCK_A],
    holds: () => [
      dropOreItems
        ? { ...oreHold(units / 10, 5_000, [units]), items: null, error: "read failed" }
        : oreHold(units / 10, 5_000, units > 0 ? [units] : []),
      cargoHold,
    ],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);

  await drive(bot, 2); // the baseline: 500 ore + 20 cargo, all pre-existing
  dropOreItems = true;
  await drive(bot, 2); // the dip: only the cargo hold reads
  dropOreItems = false;
  await drive(bot, 2); // the full total comes back
  assert.equal(bot.snapshot().oreUnitsMined, 0, "re-appearing ore is not mined ore");

  units = 800; // now the lasers actually produce
  await drive(bot, 2);
  assert.equal(bot.snapshot().oreUnitsMined, 300, "growth past the kept baseline still counts");
});

test("a haul whose unload read-back RACED the settle still counts — once", async () => {
  // The unload lands, but the read the unload itself fires still shows the old
  // contents (the transfer is settling — the same lag SETTLE_UNLOAD exists
  // for). Counting ONLY on that immediate read silently lost exactly these
  // hauls: the next docked tick read empty, decided undock, and nothing ever
  // counted the load.
  let unloaded = false;
  let readsAfterUnload = 0;
  const { deps } = makeDeps({
    status: () => status({ docked: true, inSpace: false, stationID: STATION }),
    snapshot: () => null,
    holds: () => {
      if (!unloaded) {
        return [oreHold(4_000, 5_000, [40_000])];
      }
      readsAfterUnload += 1;
      return readsAfterUnload === 1 ? [oreHold(4_000, 5_000, [40_000])] : [oreHold(0)];
    },
    onCall: (name) => {
      if (name === "unload") {
        unloaded = true;
      }
    },
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 6);

  assert.equal(
    bot.snapshot().cyclesCompleted,
    1,
    "the docked tick that CONFIRMS the empty hold counts the haul — exactly once, never twice",
  );
});

test("a haul whose unload read-back DROPPED still counts — once", async () => {
  // Same shape, different miss: the confirming read after the unload throws.
  // The haul is pending until a read actually says the ore left; the next
  // docked observation is that read.
  let unloaded = false;
  let failNextHoldRead = false;
  const { deps } = makeDeps({
    status: () => status({ docked: true, inSpace: false, stationID: STATION }),
    snapshot: () => null,
    holds: () => {
      if (failNextHoldRead) {
        failNextHoldRead = false;
        throw new Error("the hold read dropped");
      }
      return unloaded ? [oreHold(0)] : [oreHold(4_000, 5_000, [40_000])];
    },
    onCall: (name) => {
      if (name === "unload") {
        unloaded = true;
        failNextHoldRead = true;
      }
    },
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 6);

  assert.equal(bot.snapshot().cyclesCompleted, 1, "the lost read-back no longer loses the haul");
});

test("the readout always says WHY, and never shows a numeric id (R7d / R9a)", async () => {
  const { deps, rec } = makeDeps({
    status: () => status(),
    snapshot: () => snapshot([rock(ROCK_A, 8_000, 5_000, "Veldspar")]),
    locked: () => [],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 6);

  const withWhy = rec.progress.filter((p) => p.why !== null);
  assert.ok(withWhy.length > 0, "every cycle explains itself");
  const ids = [ROCK_A, ROCK_B, STATION, BELT, LASER_A, LASER_B, SHIP].map(String);
  for (const frame of rec.progress) {
    const text = [frame.why, frame.action, frame.phase, frame.failureReason, frame.rockName]
      .filter((part): part is string => typeof part === "string")
      .join(" | ");
    for (const id of ids) {
      assert.doesNotMatch(text, new RegExp(id), `readout must not show ${id}: ${text}`);
    }
  }
  assert.ok(
    rec.progress.some((p) => (p.rockName ?? "") === "Veldspar"),
    "the rock is named, not numbered",
  );
});

test("NOTHING repeats unboundedly: a world where every branch fails still stops", async () => {
  // Locks never land, the hold never fills, the station never takes the ship,
  // the warp never moves anything. Whatever rung it lands on, it must stop.
  const { deps, rec } = makeDeps({
    status: () => status(),
    snapshot: () =>
      snapshot([
        rock(ROCK_A, 8_000, 5_000, "Veldspar"),
        entity({ itemID: STATION, kind: "station", position: { x: 5e9, y: 0, z: 0 } }),
        entity({ itemID: BELT, kind: "celestial", position: { x: 4e9, y: 0, z: 0 } }),
      ]),
    locked: () => [],
    holds: () => [oreHold(0)],
  });
  const bot = createMiningBot(deps);
  bot.start(PLAN);
  await drive(bot, 500);

  assert.equal(bot.snapshot().status, "paused", "it stopped");
  assert.ok(
    String(bot.snapshot().failureReason).length > 0,
    "and said why, in the loop's own words",
  );
  assert.ok(rec.calls.length < 60, `and did not spam the bridge (${rec.calls.length} calls)`);
});
