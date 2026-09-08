// The inventory panel's MODEL (web/src/ui/inventoryModel.ts).
//
// WHY THIS SUITE EXISTS, and why it is not covered by inventoryCards.test.ts.
//
// `InventoryShip.svelte` renders under `svelte/server`, where `$effect` and
// event handlers never run and the component's own `selectionPlace` can never
// be set — so a server render can reach the grid and the bays, and CANNOT reach
// the move bar, the destination list, the merge ordering or the fit clamp. Those
// are exactly the rules that decide where a player's stack ends up, and they are
// now shared with the docked station panel. They are tested here, directly.
//
// The fixtures go through the REAL reducer (`createClientStore().apply`) rather
// than hand-built objects, so a slice shape that drifts breaks this suite
// instead of quietly passing it.

import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "../store/clientStore.ts";
import { decodeShipBays } from "../bridge/shipBays.ts";
import type { InventoryItemRow, InventoryState } from "../store/types.ts";
import {
  amount,
  amountText,
  bayIsActionable,
  bayPlace,
  capacityText,
  divisionLooksAccessible,
  fillPercent,
  hangarThings,
  mergeOrder,
  moveDestinations,
  moveQuantityFor,
  orderedPresentBays,
  parseMoveQuantity,
  placeKey,
  placeName,
  roomUsedText,
  rowsIn,
  samePlace,
  shipRows,
  shortLabel,
  uncheckedShipBays,
} from "./inventoryModel.ts";

// Real ids from the live reads these fixtures were captured from.
const STATION_ID = 60000004;
const PROCURER_ID = 9988400023309;
const RUPTURE_ID = 9988400091901;
const PROCURER_TYPE = 17480;
const RUPTURE_TYPE = 629;
const VELDSPAR_ID = 9988400092033;
const VELDSPAR_TYPE = 1230;
const DRONE_STACK_ID = 9988400023316;
const DRONE_TYPE = 2488;
const TRIT_STACK_ID = 9988400092040;
const TRIT_TYPE = 34;
const CRATE_ID = 9988400092050;
const CRATE_TYPE = 3465;

function row(over: Record<string, unknown>): unknown {
  return {
    itemID: 0,
    typeID: 0,
    groupID: null,
    categoryID: null,
    flagID: null,
    quantity: 1,
    singleton: false,
    ...over,
  };
}

/**
 * Farmer's Procurer as the BFF answered it: three bays it HAS, two it has not,
 * one nobody could check, and one it has whose capacity never arrived. All four
 * states in one hull, because they must never collapse into each other.
 */
const PROCURER_BAYS = [
  { key: "drone", label: "Drone bay", present: true, capacity: { capacity: 100, used: 50 }, items: [
    { itemID: DRONE_STACK_ID, typeID: DRONE_TYPE, groupID: 100, categoryID: 18, quantity: 5, singleton: false },
  ], error: null },
  { key: "cargo", label: "Cargo hold", present: true, capacity: { capacity: 350, used: 0 }, items: [], error: null },
  { key: "ore", label: "Ore hold", present: true, capacity: { capacity: 16000, used: 15990 }, items: [
    { itemID: VELDSPAR_ID, typeID: VELDSPAR_TYPE, groupID: 462, categoryID: 25, quantity: 123752, singleton: false },
  ], error: null },
  { key: "shipMaintenance", label: "Ship maintenance bay", present: false, capacity: null, items: null, error: null },
  { key: "fleet", label: "Fleet hangar", present: false, capacity: null, items: null, error: null },
  { key: "fuel", label: "Fuel bay", present: null, capacity: null, items: null, error: "the read failed" },
  { key: "gas", label: "Gas hold", present: true, capacity: null, items: null, error: null },
];

interface SceneOptions {
  readonly activeShipID?: number | null;
  readonly openShipID?: number;
  readonly bays?: boolean;
  readonly corp?: boolean;
  readonly corpAvailable?: boolean;
  readonly container?: boolean;
}

function inventory(options: SceneOptions = {}): InventoryState {
  const store = createClientStore();
  store.apply({
    type: "inventory/loaded",
    stationID: STATION_ID,
    activeShipID: options.activeShipID === undefined ? PROCURER_ID : options.activeShipID,
    hangar: {
      rows: [
        row({ itemID: PROCURER_ID, typeID: PROCURER_TYPE, categoryID: 6, singleton: true }),
        row({ itemID: RUPTURE_ID, typeID: RUPTURE_TYPE, categoryID: 6, singleton: true }),
        row({ itemID: VELDSPAR_ID, typeID: VELDSPAR_TYPE, categoryID: 25, groupID: 462, quantity: 123752, volume: 0.1 }),
        row({ itemID: TRIT_STACK_ID, typeID: TRIT_TYPE, categoryID: 4, quantity: 88000, volume: 0.01 }),
        row({ itemID: CRATE_ID, typeID: CRATE_TYPE, categoryID: 2, groupID: 12, singleton: true }),
      ],
      capacity: { capacity: 1000000, used: 250000 },
      error: null,
    },
    cargo: { rows: [], capacity: { capacity: 350, used: 0 }, error: null },
  } as never);
  if (options.bays !== false) {
    const shipID = options.openShipID ?? PROCURER_ID;
    store.apply({ type: "inventory/ship-open", itemID: shipID, typeID: PROCURER_TYPE } as never);
    store.apply({
      type: "inventory/ship-bays",
      itemID: shipID,
      bays: decodeShipBays(PROCURER_BAYS as never),
      error: null,
    } as never);
  }
  if (options.container) {
    store.apply({
      type: "inventory/container",
      container: {
        itemID: CRATE_ID,
        typeID: CRATE_TYPE,
        rows: [row({ itemID: TRIT_STACK_ID, typeID: TRIT_TYPE, quantity: 10 })],
        capacity: { capacity: 27500, used: 100 },
        error: null,
      },
    } as never);
  }
  if (options.corp) {
    store.apply({
      type: "inventory/corp-loaded",
      available: options.corpAvailable !== false,
      reason: null,
      divisions: [
        { division: 1, name: "Ore stash", rows: [row({ itemID: VELDSPAR_ID, typeID: VELDSPAR_TYPE, quantity: 10 })], error: null },
        { division: 2, name: null, rows: [], error: null },
      ],
    } as never);
  }
  return store.inventory.get();
}

const stack = (over: Record<string, unknown> = {}): InventoryItemRow =>
  row({ itemID: 1, typeID: TRIT_TYPE, quantity: 10, volume: 1, ...over }) as InventoryItemRow;

// --- places -----------------------------------------------------------------

test("a place is only the same place as itself", () => {
  assert.equal(samePlace({ kind: "hangar" }, { kind: "hangar" }), true);
  assert.equal(samePlace({ kind: "hangar" }, { kind: "cargo" }), false);
  assert.equal(samePlace(null, { kind: "hangar" }), false);
});

test("⚠ a tick in one ship bay is not a tick in another", () => {
  // The ore hold and the drone bay are different places. Collapsing them would
  // apply a selection made in one to the contents of the other.
  assert.equal(samePlace({ kind: "shipBay", bay: "ore" }, { kind: "shipBay", bay: "ore" }), true);
  assert.equal(samePlace({ kind: "shipBay", bay: "ore" }, { kind: "shipBay", bay: "drone" }), false);
});

test("⚠ a tick in one corporation division is not a tick in another", () => {
  assert.equal(samePlace({ kind: "corp", division: 1 }, { kind: "corp", division: 1 }), true);
  assert.equal(samePlace({ kind: "corp", division: 1 }, { kind: "corp", division: 2 }), false);
});

test("⚠ a tick in one container is not a tick in another", () => {
  assert.equal(samePlace({ kind: "container", itemID: 7 }, { kind: "container", itemID: 7 }), true);
  assert.equal(samePlace({ kind: "container", itemID: 7 }, { kind: "container", itemID: 8 }), false);
});

test("every place has its own key, and no two places share one", () => {
  const keys = [
    placeKey({ kind: "hangar" }),
    placeKey({ kind: "cargo" }),
    placeKey({ kind: "shipBay", bay: "ore" }),
    placeKey({ kind: "shipBay", bay: "drone" }),
    placeKey({ kind: "container", itemID: 7 }),
    placeKey({ kind: "corp", division: 1 }),
  ];
  assert.equal(new Set(keys).size, keys.length, `keys collided: ${keys.join(", ")}`);
  // R7d — a key is internal, but it must not be built from anything a player
  // could mistake for a rendered id. Only the two id-bearing kinds carry one.
  assert.equal(placeKey({ kind: "hangar" }), "hangar");
});

test("the rows in a place come from that place, and an unopened one has none", () => {
  const inv = inventory({ container: true, corp: true });
  assert.equal(rowsIn(inv, { kind: "hangar" }).length, 5);
  assert.equal(rowsIn(inv, { kind: "cargo" }).length, 0);
  assert.equal(rowsIn(inv, { kind: "shipBay", bay: "ore" }).length, 1);
  assert.equal(rowsIn(inv, { kind: "container", itemID: CRATE_ID }).length, 1);
  assert.equal(rowsIn(inv, { kind: "corp", division: 1 }).length, 1);
  // A container that is not the open one, and a division that does not exist.
  assert.deepEqual(rowsIn(inv, { kind: "container", itemID: 999 }), []);
  assert.deepEqual(rowsIn(inv, { kind: "corp", division: 7 }), []);
});

test("⚠ a bay that could not be read has no rows — it does not borrow another bay's", () => {
  const inv = inventory();
  assert.deepEqual(rowsIn(inv, { kind: "shipBay", bay: "gas" }), []);
  assert.deepEqual(rowsIn(inv, { kind: "shipBay", bay: "nosuchbay" }), []);
});

test("a place is named in the player's words, never by a flag or an id", () => {
  const inv = inventory({ corp: true, container: true });
  assert.equal(placeName(inv, { kind: "hangar" }, "Crate"), "Station hangar");
  assert.equal(placeName(inv, { kind: "cargo" }, "Crate"), "Ship cargo");
  assert.equal(placeName(inv, { kind: "shipBay", bay: "ore" }, "Crate"), "Ore hold");
  assert.equal(placeName(inv, { kind: "container", itemID: CRATE_ID }, "Crate"), "Crate");
  assert.match(placeName(inv, { kind: "corp", division: 1 }, "Crate"), /Ore stash/);
  assert.equal(placeName(inv, null, "Crate"), "");
});

test("a corporation division nobody renamed is named by its ordinal, not its flag", () => {
  const inv = inventory({ corp: true });
  const name = placeName(inv, { kind: "corp", division: 2 }, "Crate");
  assert.match(name, /Division 2/);
  // 115-121 are the retail flags behind the divisions. None may surface.
  assert.doesNotMatch(name, /11[5-9]|12[01]/);
});

test("a bay whose label never arrived still gets words, not a blank", () => {
  const inv = inventory({ bays: false });
  assert.equal(placeName(inv, { kind: "shipBay", bay: "ore" }, "Crate"), "Ship bay");
});

// --- destinations -----------------------------------------------------------

test("the place you are in is never offered as somewhere to send things", () => {
  const inv = inventory();
  for (const label of moveDestinations(inv, { kind: "hangar" }, "Crate")) {
    assert.notEqual(label.place.kind, "hangar");
  }
  const fromOre = moveDestinations(inv, { kind: "shipBay", bay: "ore" }, "Crate");
  assert.equal(
    fromOre.some((d) => d.place.kind === "shipBay" && d.place.bay === "ore"),
    false,
    "the ore hold offered itself",
  );
});

test("the ACTIVE hull's specialty holds are destinations; cargo is offered once", () => {
  const destinations = moveDestinations(inventory(), { kind: "hangar" }, "Crate");
  const labels = destinations.map((d) => d.label);
  assert.deepEqual(
    labels,
    ["Ship cargo", "Drone bay", "Ore hold", "Gas hold"],
    "the cargo hold must not appear twice (once as Ship cargo, once as a bay)",
  );
});

test("⚠ a bay the hull does NOT have is never a destination", () => {
  const labels = moveDestinations(inventory(), { kind: "hangar" }, "Crate").map((d) => d.label);
  assert.equal(labels.includes("Ship maintenance bay"), false);
  assert.equal(labels.includes("Fleet hangar"), false);
});

test("⚠ a bay nobody could CHECK is not a destination either", () => {
  // `present: null` is "we do not know", and a button that might not work must
  // not be drawn. It is named elsewhere as unchecked — it is not offered here.
  const labels = moveDestinations(inventory(), { kind: "hangar" }, "Crate").map((d) => d.label);
  assert.equal(labels.includes("Fuel bay"), false);
});

test("the bays of a hull you are NOT flying are not destinations", () => {
  // There is no addressing for "the ore hold of the ship I am not flying", so
  // offering it would promise a move the bridge cannot make.
  const inv = inventory({ openShipID: RUPTURE_ID });
  const labels = moveDestinations(inv, { kind: "hangar" }, "Crate").map((d) => d.label);
  assert.deepEqual(labels, ["Ship cargo"]);
});

test("with no ship at all, only the places that exist are offered", () => {
  const inv = inventory({ activeShipID: null, bays: false });
  assert.deepEqual(moveDestinations(inv, { kind: "hangar" }, "Crate"), []);
});

test("an open container is a destination, under its own name", () => {
  const inv = inventory({ container: true });
  const match = moveDestinations(inv, { kind: "hangar" }, "Small Standard Container").find(
    (d) => d.place.kind === "container",
  );
  assert.ok(match, "the open container was not offered");
  assert.equal(match.label, "Small Standard Container");
});

test("corporation divisions appear only when the corporation has an office here", () => {
  const withOffice = moveDestinations(inventory({ corp: true }), { kind: "hangar" }, "Crate");
  assert.ok(withOffice.some((d) => d.place.kind === "corp"), "a division should be offered");

  const noOffice = moveDestinations(
    inventory({ corp: true, corpAvailable: false }),
    { kind: "hangar" },
    "Crate",
  );
  assert.equal(noOffice.some((d) => d.place.kind === "corp"), false);
});

// --- bays -------------------------------------------------------------------

test("⚠ only the bays a hull HAS are drawn, in reading order", () => {
  const bays = orderedPresentBays(inventory().openShip);
  assert.deepEqual(
    bays.map((b) => b.key),
    ["cargo", "ore", "gas", "drone"],
    "cargo first, then the specialised holds in BAY_ORDER, never the read's order",
  );
  // Non-vacuous: the read handed them over drone-first, so this really is the
  // panel's order and not just whatever the BFF happened to answer with.
  assert.equal(PROCURER_BAYS[0]?.key, "drone");
});

test("⚠ a bay nobody could check is named, and never counted as absent", () => {
  const unchecked = uncheckedShipBays(inventory().openShip);
  assert.deepEqual(unchecked.map((b) => b.label), ["Fuel bay"]);
  // And it is NOT among the drawn bays, which is the other half of the rule.
  assert.equal(orderedPresentBays(inventory().openShip).some((b) => b.key === "fuel"), false);
});

test("with no hull open there are neither drawn bays nor unchecked ones", () => {
  assert.deepEqual(orderedPresentBays(null), []);
  assert.deepEqual(uncheckedShipBays(null), []);
});

test("the cargo hold keeps its own place; every other bay is addressed by key", () => {
  assert.deepEqual(bayPlace({ key: "cargo" } as never), { kind: "cargo" });
  assert.deepEqual(bayPlace({ key: "ore" } as never), { kind: "shipBay", bay: "ore" });
});

test("a bay is actionable only on the hull you are flying, and only if it is there", () => {
  const present = { key: "ore", present: true } as never;
  const absent = { key: "fleet", present: false } as never;
  const unknown = { key: "fuel", present: null } as never;
  assert.equal(bayIsActionable(PROCURER_ID, present, PROCURER_ID), true);
  assert.equal(bayIsActionable(RUPTURE_ID, present, PROCURER_ID), false, "not the hull you are in");
  assert.equal(bayIsActionable(PROCURER_ID, absent, PROCURER_ID), false);
  assert.equal(bayIsActionable(PROCURER_ID, unknown, PROCURER_ID), false, "unknown is not yes");
});

// --- ships and things -------------------------------------------------------

test("the ships are the hulls, and the things are everything else", () => {
  const inv = inventory();
  assert.deepEqual(shipRows(inv).map((r) => r.itemID), [PROCURER_ID, RUPTURE_ID]);
  assert.deepEqual(
    hangarThings(inv).map((r) => r.itemID),
    [VELDSPAR_ID, TRIT_STACK_ID, CRATE_ID],
    "no hull may appear among the things",
  );
});

test("⚠ in space the hull you are flying is still listed, though no hangar was read", () => {
  // A player in space has no station hangar. Without this the one ship they are
  // definitely in would be the one ship they could not open.
  const store = createClientStore();
  store.apply({
    type: "inventory/loaded",
    stationID: null,
    activeShipID: PROCURER_ID,
    hangar: { rows: [], capacity: null, error: null },
    cargo: {
      rows: [row({ itemID: PROCURER_ID, typeID: PROCURER_TYPE, categoryID: 6, singleton: true })],
      capacity: { capacity: 350, used: 0 },
      error: null,
    },
  } as never);
  const ships = shipRows(store.inventory.get());
  assert.deepEqual(ships.map((r) => r.itemID), [PROCURER_ID]);
  assert.equal(ships[0]?.typeID, PROCURER_TYPE, "the hull must be named, not left as type 0");
});

// --- numbers, in words ------------------------------------------------------

test("⚠ a capacity the ship did not report reads 'not known', NEVER 0", () => {
  // A confident "0 of 0 m³" tells the player a bay is unusable when in truth
  // nobody asked. This is the invariant, and it is why this is a string and not
  // a number.
  assert.equal(capacityText(null), "not known");
  assert.equal(roomUsedText(null), "not known");
  assert.doesNotMatch(capacityText(null), /0/);
  assert.doesNotMatch(roomUsedText(null), /0/);
});

test("a capacity the ship DID report is shown as used of capacity", () => {
  const text = capacityText({ capacity: 350, used: 0 });
  assert.match(text, / of /);
  assert.match(text, /m³$/);
  // A real zero the server sent is legitimate and is shown.
  assert.notEqual(text, "not known");
});

test("⚠ the station hangar shows room USED with no 'of' and no ceiling", () => {
  // eve.js answers a phantom 1,000,000 m³ for the unmapped hangar flag. Showing
  // it as a limit would invent a ceiling that does not exist.
  const text = roomUsedText({ capacity: 1000000, used: 250000 });
  assert.doesNotMatch(text, / of /);
  assert.doesNotMatch(text, /1[.,\s]?000[.,\s]?000/);
  assert.match(text, /m³$/);
});

test("a gauge fills from the two numbers the server gave, and is clamped", () => {
  assert.equal(fillPercent({ capacity: 100, used: 50 }), 50);
  assert.equal(fillPercent({ capacity: 100, used: 250 }), 100, "clamped, never past full");
  assert.equal(fillPercent({ capacity: 100, used: -5 }), 0, "clamped, never negative");
  // No capacity means no meaningful bar — and specifically not a full one.
  assert.equal(fillPercent(null), 0);
  assert.equal(fillPercent({ capacity: 0, used: 0 }), 0);
});

test("an assembled thing is captioned as such, not with a bare 1", () => {
  assert.equal(amountText(stack({ singleton: true })), "assembled");
  assert.notEqual(amountText(stack({ quantity: 10 })), "assembled");
});

test("an amount is grouped and never carries more than two fraction digits", () => {
  // Asserted locale-independently: the separators differ by machine, the DIGITS
  // do not.
  assert.equal(amount(123456.789).replace(/\D/g, ""), "12345679");
  assert.equal(amount(0).replace(/\D/g, ""), "0");
});

// --- moving -----------------------------------------------------------------

test("a blank or nonsense quantity means the whole stack, never a zero-unit move", () => {
  assert.equal(parseMoveQuantity(""), null);
  assert.equal(parseMoveQuantity("   "), null);
  assert.equal(parseMoveQuantity("0"), null);
  assert.equal(parseMoveQuantity("-4"), null);
  assert.equal(parseMoveQuantity("2.5"), null);
  assert.equal(parseMoveQuantity("abc"), null);
  assert.equal(parseMoveQuantity("7"), 7);
});

test("⚠ THE QTY BOX HANDS BACK A NUMBER, AND THAT MUST NOT THROW", () => {
  // `<input type="number">` binds back a number, or null while it is empty —
  // never the raw text. Reading it as a string threw
  // "text.trim is not a function" on Confirm move and lost the whole action, so
  // the shapes the DOM actually produces are asserted here.
  assert.equal(parseMoveQuantity(null), null);
  assert.equal(parseMoveQuantity(undefined), null);
  assert.equal(parseMoveQuantity(0), null);
  assert.equal(parseMoveQuantity(-4), null);
  assert.equal(parseMoveQuantity(2.5), null);
  assert.equal(parseMoveQuantity(Number.NaN), null);
  assert.equal(parseMoveQuantity(7), 7);
});

function move(over: Record<string, unknown>) {
  return moveQuantityFor({
    inventory: inventory(),
    destination: { kind: "hangar" },
    selection: [1],
    selectedRows: [stack()],
    typedQuantity: "",
    ...over,
  } as never);
}

test("a move into anywhere but a ship hold sends the whole stack", () => {
  assert.deepEqual(move({}), { kind: "move", quantity: null });
});

test("a typed quantity wins, even into a ship hold — the player asked for it", () => {
  assert.deepEqual(
    move({ destination: { kind: "shipBay", bay: "ore" }, typedQuantity: "3" }),
    { kind: "move", quantity: 3 },
  );
});

test("a typed quantity is ignored when more than one stack is ticked", () => {
  // The bridge refuses a quantity when several stacks are named (INVALID_SPLIT).
  assert.deepEqual(
    move({ selection: [1, 2], selectedRows: [stack(), stack({ itemID: 2 })], typedQuantity: "3" }),
    { kind: "move", quantity: null },
  );
});

test("⚠ a single stack into a ship hold is clamped to what actually fits", () => {
  // The ore hold has 10 m³ free (16000 - 15990) and Veldspar is 0.1 m³/unit, so
  // 100 units fit out of a much larger stack. Asking for the whole stack would
  // be refused OUTRIGHT — a transfer is all-or-nothing per stack.
  const verdict = move({
    destination: { kind: "shipBay", bay: "ore" },
    selectedRows: [stack({ typeID: VELDSPAR_TYPE, quantity: 123752, volume: 0.1 })],
  });
  assert.deepEqual(verdict, { kind: "move", quantity: 100 });
});

test("a stack that fits ENTIRE keeps its quantity null — only a partial move names one", () => {
  const verdict = move({
    destination: { kind: "shipBay", bay: "drone" },
    selectedRows: [stack({ quantity: 5, volume: 1 })],
  });
  assert.deepEqual(verdict, { kind: "move", quantity: null });
});

test("a hold with no room refuses, in that hold's own name", () => {
  const verdict = move({
    destination: { kind: "shipBay", bay: "ore" },
    selectedRows: [stack({ quantity: 100, volume: 500 })],
  });
  assert.equal(verdict.kind, "refused");
  assert.match(verdict.message, /Ore hold/, "the refusal must name the hold");
  assert.doesNotMatch(verdict.message, /\d{3,}/, "and must not quote a flag or an id");
});

test("⚠ an unknown volume hands the whole stack over and lets the SERVER judge", () => {
  // Ship-bay rows carry no volume at all (see InventoryItemRow). Inventing a
  // smaller number from missing data is the one thing this must never do.
  const verdict = move({
    destination: { kind: "shipBay", bay: "ore" },
    selectedRows: [stack({ quantity: 123752, volume: null })],
  });
  assert.deepEqual(verdict, { kind: "move", quantity: null });
});

test("an unread hold capacity also hands the whole stack over", () => {
  // The gas hold is present but its capacity never arrived.
  const verdict = move({
    destination: { kind: "shipBay", bay: "gas" },
    selectedRows: [stack({ quantity: 50, volume: 1 })],
  });
  assert.deepEqual(verdict, { kind: "move", quantity: null });
});

test("a hold on a hull you are not flying is not measured here — the server decides", () => {
  const verdict = moveQuantityFor({
    inventory: inventory({ openShipID: RUPTURE_ID }),
    destination: { kind: "shipBay", bay: "ore" },
    selection: [1],
    selectedRows: [stack({ quantity: 50, volume: 1 })],
    typedQuantity: "",
  });
  assert.deepEqual(verdict, { kind: "move", quantity: null });
});

test("a selection whose row has gone away still moves the ids, whole", () => {
  const verdict = move({ destination: { kind: "shipBay", bay: "ore" }, selectedRows: [] });
  assert.deepEqual(verdict, { kind: "move", quantity: null });
});

// --- merging ----------------------------------------------------------------

test("merging pours the SMALLER stack into the larger one, either way round", () => {
  const small = stack({ itemID: 1, quantity: 3 });
  const large = stack({ itemID: 2, quantity: 30 });
  assert.deepEqual(mergeOrder([small, large]), { source: small, destination: large });
  assert.deepEqual(mergeOrder([large, small]), { source: small, destination: large });
});

test("merging needs exactly two stacks", () => {
  assert.equal(mergeOrder([]), null);
  assert.equal(mergeOrder([stack()]), null);
  assert.equal(mergeOrder([stack({ itemID: 1 }), stack({ itemID: 2 }), stack({ itemID: 3 })]), null);
});

// --- corporation hangar -----------------------------------------------------

test("a division that reads back empty only LOOKS inaccessible — it never gates", () => {
  // The server filters a division the character lacks the role for down to
  // nothing, so an empty read and an empty division are indistinguishable.
  assert.equal(divisionLooksAccessible({ rows: [stack()] }), true);
  assert.equal(divisionLooksAccessible({ rows: [] }), false);
});

// --- the narrow panel's one-word destination ---------------------------------

test("a destination abbreviates to its DISTINGUISHING word, not just its first", () => {
  assert.equal(shortLabel("Ship cargo"), "Cargo");
  assert.equal(shortLabel("Station hangar"), "Hangar");
  // "hold" and "bay" are what every hull has, so they are never the half that
  // tells two places apart.
  assert.equal(shortLabel("Ore hold"), "Ore");
  assert.equal(shortLabel("Drone bay"), "Drone");
  assert.equal(shortLabel("Ship maintenance bay"), "Ship");
  // A one-word name is already as short as it goes.
  assert.equal(shortLabel("Industry"), "Industry");
  assert.equal(shortLabel(""), "");
});
