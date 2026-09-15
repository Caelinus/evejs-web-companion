// load-cargo: the hauler's loading block, and the three things it has to get
// right for a ten-trip haul to be a loop rather than ten hand-written programs.
//
//   1. EACH STACK INTO THE BAY THAT WANTS IT — command centres into the command
//      centre hold, not trickling into a cargo bay a tenth its size.
//   2. WHAT FITS, THEN DONE. A hold with room for six out of twenty loads six
//      and finishes. The fourteen left behind are the next lap's work, not a
//      failure, and the block must never read as one.
//   3. NOTHING IT COULD NOT IDENTIFY. A row the rules cannot be tested against
//      stays in the hangar, where it already safely was.
//
// Pure, over fixture observations — same shape as the other macro tests.

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus, InventoryItemRow, ShipBay } from "../store/types.ts";
import type { MacroStep, ItemMatchArg } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { ScriptBoard } from "./scriptDecide.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";

const STATION = 60000004;
// The command-centre group, and two of the twenty types in it. Every planet has
// its own command centre type; they all share this group, which is exactly why a
// group rule is the one entry a player should need.
const GROUP_COMMAND_CENTER = 1027;
// ⚠ 41 IS PLANETARY INTERACTION (the structures), NOT 43. A command centre is
// group 1027 in category 41, which is precisely why the planetary commodities
// hold — categories 42 and 43 — refuses it. This fixture said 43 while the
// table still named that hold as the overflow, and so agreed with the bug.
const CATEGORY_PLANETARY_INTERACTION = 41;
const TEMPERATE_CC = 2254;
const BARREN_CC = 2256;
const CC_M3 = 1000;

const loadCargo = SCRIPT_MACROS["load-cargo"]!;
const NB: ScriptBoard = {};

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return {
    inSpace: false, docked: true, solarSystemID: 30000142, stationID: STATION,
    structureID: null, shipID: 9001, shipTypeID: null, shipIsCapsule: null,
    shipMode: null, shipSpeedFraction: null, ...over,
  };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: false, docked: true, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(),
    ...over,
  };
}

function row(over: Partial<InventoryItemRow> & { itemID: number }): InventoryItemRow {
  return {
    typeID: TEMPERATE_CC, groupID: GROUP_COMMAND_CENTER, categoryID: CATEGORY_PLANETARY_INTERACTION,
    flagID: null, quantity: 1, singleton: false, volume: CC_M3, ...over,
  };
}

function bay(key: string, over: Partial<ShipBay> = {}): ShipBay {
  return { key, label: key, present: true, capacity: null, items: [], error: null, ...over };
}

/** An Epithal-shaped hull: a command centre hold, a planetary hold, plain cargo. */
function hauler(over: { readonly ccFree?: number; readonly piFree?: number; readonly cargoFree?: number } = {}): ShipBay[] {
  const ccFree = over.ccFree ?? 6 * CC_M3;
  const piFree = over.piFree ?? 0;
  const cargoFree = over.cargoFree ?? 500;
  return [
    bay("cargo", { capacity: { capacity: cargoFree, used: 0 } }),
    bay("commandCenter", { capacity: { capacity: ccFree, used: 0 }, present: ccFree > 0 }),
    bay("planetary", { capacity: { capacity: piFree, used: 0 }, present: piFree > 0 }),
  ];
}

function step(items: readonly ItemMatchArg[], args: MacroStep["args"] = {}): MacroStep {
  return {
    id: "s",
    kind: "macro",
    macro: "load-cargo",
    args: { items: { kind: "itemList", items: [...items] }, ...args },
  };
}

const BY_GROUP: ItemMatchArg = { match: "group", groupID: GROUP_COMMAND_CENTER, name: "items like Temperate Command Center" };

test("one GROUP rule loads every planet's command centre, into the command centre hold", () => {
  const tick = loadCargo(
    step([BY_GROUP]),
    obs({
      stationHangar: [
        row({ itemID: 101, typeID: TEMPERATE_CC, quantity: 2 }),
        row({ itemID: 102, typeID: BARREN_CC, quantity: 2 }),
        // Not a command centre, and not asked for.
        row({ itemID: 103, typeID: 34, groupID: 18, categoryID: 4, quantity: 100, volume: 0.01 }),
      ],
      shipBays: hauler(),
      cargo: { rows: [], capacity: { capacity: 500, used: 0 } },
    }),
    {},
    NB,
  );
  assert.equal(tick.action.kind, "loadHolds");
  assert.deepEqual(
    tick.action.kind === "loadHolds" ? tick.action.groups : [],
    [{ bay: "commandCenter", itemIDs: [101, 102], qty: null }],
    "both stacks, one call, into the bay that wants them — and the mineral stack left alone",
  );
});

test("a hold with room for six out of twenty asks for SIX, and the rest waits for the next lap", () => {
  // ⚠ THE SPLIT IS THE WHOLE POINT. A transfer is all-or-nothing per stack, so
  // asking for the twenty would be refused outright — the block would load
  // nothing, every tick, for ever.
  const tick = loadCargo(
    step([BY_GROUP]),
    obs({
      stationHangar: [row({ itemID: 101, quantity: 20 })],
      shipBays: hauler({ ccFree: 6 * CC_M3 }),
      cargo: { rows: [], capacity: { capacity: 500, used: 0 } },
    }),
    {},
    NB,
  );
  assert.deepEqual(
    tick.action.kind === "loadHolds" ? tick.action.groups : [],
    [{ bay: "commandCenter", itemIDs: [101], qty: 6 }],
  );
});

test("a FULL hold is done, not blocked — the fourteen left behind are the next trip's cargo", () => {
  const tick = loadCargo(
    step([BY_GROUP]),
    obs({
      stationHangar: [row({ itemID: 101, quantity: 14 })],
      shipBays: [
        bay("cargo", { capacity: { capacity: 500, used: 500 } }),
        bay("commandCenter", { capacity: { capacity: 6000, used: 6000 } }),
      ],
      cargo: { rows: [], capacity: { capacity: 500, used: 500 } },
    }),
    {},
    NB,
  );
  assert.equal(tick.action.kind, "wait");
  assert.equal(tick.outcome.kind, "done");
  assert.match(tick.why, /full/i);
});

test("a full SPECIALISED bay does not spill into the cargo hold", () => {
  // The operator's standing rule, inherited from the loot side: if the right bay
  // exists, its cargo never goes into ship cargo. Freight pushed into a hauler's
  // cargo bay is freight the unload block's bay sweep would have to find later.
  const tick = loadCargo(
    step([BY_GROUP]),
    obs({
      stationHangar: [row({ itemID: 101, quantity: 3 })],
      shipBays: [
        bay("cargo", { capacity: { capacity: 10_000, used: 0 } }),
        bay("commandCenter", { capacity: { capacity: 6000, used: 6000 } }),
      ],
      cargo: { rows: [], capacity: { capacity: 10_000, used: 0 } },
    }),
    {},
    NB,
  );
  assert.equal(tick.outcome.kind, "done", "nothing loaded, and nothing forced into cargo");
  assert.equal(tick.action.kind, "wait");
});

test("the PLANETARY hold is never offered a command centre, full hold or not", () => {
  // ⚠ THE LIVE FAILURE, 2026-09-15. An Epithal loaded six into its command
  // centre hold and the router sent the seventh next door, where the server
  // answered "Only planetary resources and commodities can be placed in the
  // Planetary Commodities Hold" — a command centre is category 41, and that
  // hold takes 42 and 43. With a PI hold present and empty, and a command centre
  // hold that is full, the right answer is to load NOTHING and come back.
  const tick = loadCargo(
    step([BY_GROUP]),
    obs({
      stationHangar: [row({ itemID: 101, quantity: 14 })],
      shipBays: [
        bay("cargo", { capacity: { capacity: 500, used: 0 } }),
        bay("commandCenter", { capacity: { capacity: 6000, used: 6000 } }),
        bay("planetary", { capacity: { capacity: 45_000, used: 0 } }),
      ],
      cargo: { rows: [], capacity: { capacity: 500, used: 0 } },
    }),
    {},
    NB,
  );
  assert.equal(tick.action.kind, "wait", "no transfer at all, least of all into the planetary hold");
  assert.equal(tick.outcome.kind, "done");
});

test("a hull with NO bay for it falls back to the cargo hold, as it always did", () => {
  const tick = loadCargo(
    step([BY_GROUP]),
    obs({
      stationHangar: [row({ itemID: 101, quantity: 2 })],
      shipBays: [bay("cargo", { capacity: { capacity: 10_000, used: 0 } })],
      cargo: { rows: [], capacity: { capacity: 10_000, used: 0 } },
    }),
    {},
    NB,
  );
  assert.deepEqual(
    tick.action.kind === "loadHolds" ? tick.action.groups : [],
    [{ bay: null, itemIDs: [101], qty: null }],
  );
});

test("a NAME pattern matches what the client resolved, and needs the names to do it", () => {
  const byName: ItemMatchArg = { match: "name", pattern: "command center", name: 'everything matching "command center"' };
  const hangar = [
    row({ itemID: 101, typeID: TEMPERATE_CC, quantity: 1 }),
    row({ itemID: 102, typeID: BARREN_CC, quantity: 1 }),
    row({ itemID: 103, typeID: 34, groupID: 18, categoryID: 4, quantity: 10, volume: 0.01 }),
  ];
  const matched = loadCargo(
    step([byName]),
    obs({
      stationHangar: hangar,
      typeNames: { [TEMPERATE_CC]: "Temperate Command Center", [BARREN_CC]: "Barren Command Center", 34: "Tritanium" },
      shipBays: hauler(),
      cargo: { rows: [], capacity: { capacity: 500, used: 0 } },
    }),
    {},
    NB,
  );
  assert.deepEqual(
    matched.action.kind === "loadHolds" ? matched.action.groups : [],
    [{ bay: "commandCenter", itemIDs: [101, 102], qty: null }],
  );

  // ⚠ NO NAMES READ IS "COULD NOT TELL", NEVER "NOTHING MATCHED". Reading it as
  // an empty selection would send the ship off empty and call the load finished.
  const blind = loadCargo(
    step([byName]),
    obs({ stationHangar: hangar, shipBays: hauler(), cargo: { rows: [], capacity: { capacity: 500, used: 0 } } }),
    {},
    NB,
  );
  assert.notEqual(blind.outcome.kind, "done");
  assert.equal(blind.action.kind, "wait");
});

test("a bay named in `exceptBays` is not filled, and its cargo stays in the hangar", () => {
  // Excluding a bay must not push what belongs in it into the cargo hold — that
  // is the fall-through the rule above forbids, arrived at from the other side.
  // One bay is the whole chain for a command centre, so naming it is enough.
  const tick = loadCargo(
    step([BY_GROUP], { exceptBays: { kind: "bayList", bays: ["commandCenter"] } }),
    obs({
      stationHangar: [row({ itemID: 101, quantity: 2 })],
      shipBays: hauler({ piFree: 45_000, cargoFree: 10_000 }),
      cargo: { rows: [], capacity: { capacity: 10_000, used: 0 } },
    }),
    {},
    NB,
  );
  assert.equal(tick.outcome.kind, "done");
  assert.equal(tick.action.kind, "wait");
  assert.match(tick.why, /leave alone/i);
});

test("undocked, unset and empty-handed each say which they are", () => {
  const undocked = loadCargo(
    step([BY_GROUP]),
    obs({ flightStatus: flight({ docked: false, inSpace: true, stationID: null }) }),
    {},
    NB,
  );
  assert.equal(undocked.outcome.kind, "blocked");

  const unset = loadCargo(step([]), obs({ stationHangar: [], shipBays: hauler() }), {}, NB);
  assert.equal(unset.outcome.kind, "blocked", "a step with nothing named cannot load the whole hangar");

  const nothingHere = loadCargo(
    step([BY_GROUP]),
    obs({
      stationHangar: [row({ itemID: 103, typeID: 34, groupID: 18, categoryID: 4, quantity: 10, volume: 0.01 })],
      shipBays: hauler(),
      cargo: { rows: [], capacity: { capacity: 500, used: 0 } },
    }),
    {},
    NB,
  );
  assert.equal(nothingHere.outcome.kind, "done");
  assert.match(nothingHere.why, /None of that/i);
});

test("an unreadable hangar waits, then says so — it never passes for an empty one", () => {
  let mem = {};
  let last = loadCargo(step([BY_GROUP]), obs({ shipBays: hauler() }), mem, NB);
  for (let i = 0; i < 6 && last.outcome.kind !== "blocked"; i += 1) {
    mem = last.nextMem;
    last = loadCargo(step([BY_GROUP]), obs({ shipBays: hauler() }), mem, NB);
  }
  assert.equal(last.outcome.kind, "blocked");
});
