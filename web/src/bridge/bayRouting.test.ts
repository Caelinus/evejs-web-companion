// The bay ROUTER: which destination each picked-up stack is asked for, given
// what the hull actually has. Pure — no BFF, no flow.
//
// Every case here is about the rule the module exists to enforce: a preference
// is never a verdict. A bay the hull lacks, a type the table does not know and
// a row that cannot be classified all end up in the same place — the cargo hold
// — because that is the only destination every hull is guaranteed to have.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BAY_PREFERENCES,
  FREIGHT_BAYS,
  planBayTransfers,
  planLootTransfers,
  preferredBays,
  type BayPreference,
} from "./bayRouting.ts";
import type { InventoryItemRow, ShipBay } from "../store/types.ts";

const PREFS: readonly BayPreference[] = [
  { bays: ["ice", "ore"], groupIDs: [465] },
  { bays: ["mineral"], groupIDs: [18] },
  { bays: ["ore", "asteroid"], categoryIDs: [25] },
];

function row(itemID: number, categoryID: number | null, groupID: number | null): InventoryItemRow {
  return { itemID, typeID: 1, groupID, categoryID, flagID: null, quantity: 1, singleton: false };
}

function bay(key: string, present: boolean | null): ShipBay {
  return { key, label: key, present, capacity: null, items: null, error: null };
}

test("a group rule beats the category rule it refines", () => {
  // Ice is category 25 (Asteroid) AND group 423. The mining hold would claim it
  // on category alone, so group rules have to be asked first or a hull with a
  // dedicated ice hold would never use it.
  assert.deepEqual(preferredBays(row(1, 25, 465), PREFS), ["ice", "ore"]);
  assert.deepEqual(preferredBays(row(2, 25, 462), PREFS), ["ore", "asteroid"]);
});

test("a second choice is taken when the hull lacks the first", () => {
  // The 19.11 mining-hold rule in practice: a Retriever has no ice hold, and
  // ice belongs in its ore hold rather than trickling into a tiny cargo bay.
  const groups = planBayTransfers([row(1, 25, 465)], [bay("ore", true), bay("ice", false)], PREFS);
  assert.deepEqual(groups, [{ bay: "ore", itemIDs: [1] }]);
});

test("the first choice wins when the hull has both", () => {
  const groups = planBayTransfers([row(1, 25, 465)], [bay("ore", true), bay("ice", true)], PREFS);
  assert.deepEqual(groups, [{ bay: "ice", itemIDs: [1] }]);
});

test("an unclassifiable row prefers nothing and lands in cargo", () => {
  assert.deepEqual(preferredBays(row(1, null, null), PREFS), []);
  assert.deepEqual(planBayTransfers([row(1, null, null)], [bay("ore", true)], PREFS), [
    { bay: null, itemIDs: [1] },
  ]);
});

test("a type the table does not know prefers cargo", () => {
  assert.deepEqual(preferredBays(row(1, 7, 60), PREFS), []);
});

test("a bay that could not be READ is skipped exactly like an absent one", () => {
  // present === null is "we could not look". Addressing it anyway is how the
  // original bug shipped: a bay nobody confirmed, asked for regardless.
  const groups = planBayTransfers([row(1, 25, 462)], [bay("ore", null)], PREFS);
  assert.deepEqual(groups, [{ bay: null, itemIDs: [1] }]);
});

test("rows route to the bays the hull HAS, everything else to cargo", () => {
  const groups = planBayTransfers(
    [
      row(10, 25, 462), // ore -> ore hold (present)
      row(11, 4, 18), //  mineral -> no mineral hold -> cargo
      row(12, 7, 60), //  unknown -> cargo
    ],
    [bay("ore", true), bay("mineral", false)],
    PREFS,
  );
  assert.deepEqual(groups, [
    { bay: "ore", itemIDs: [10] },
    { bay: null, itemIDs: [11, 12] },
  ]);
});

test("the cargo group comes last so specialised bays take their share first", () => {
  const groups = planBayTransfers([row(1, 7, 60), row(2, 25, 462)], [bay("ore", true)], PREFS);
  assert.deepEqual(groups.map((group) => group.bay), ["ore", null]);
});

test("no rows means no transfers at all — an empty wreck asks for nothing", () => {
  assert.deepEqual(planBayTransfers([], [bay("ore", true)], PREFS), []);
});

test("a row appears in exactly one group", () => {
  const groups = planBayTransfers(
    [row(1, 25, 462), row(2, 25, 462), row(3, 4, 18), row(4, null, null)],
    [bay("ore", true), bay("mineral", true)],
    PREFS,
  );
  const seen = groups.flatMap((group) => group.itemIDs);
  assert.equal(seen.length, new Set(seen).size, "no itemID is routed twice");
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test("with no bays read at all, every row falls back to cargo", () => {
  // The shape the loot path takes when `/bays` failed: routing degrades to the
  // old everything-into-cargo behaviour rather than addressing a bay blind.
  assert.deepEqual(planBayTransfers([row(1, 25, 462), row(2, 4, 18)], [], PREFS), [
    { bay: null, itemIDs: [1, 2] },
  ]);
});

// ── The invariant that keeps the two halves honest ──────────────────────────

test("every bay the router can FILL is a bay the unload block can EMPTY", () => {
  // This is the whole reason FREIGHT_BAYS and BAY_PREFERENCES live in one file.
  // A destination that is routable but not unloadable fills once and then
  // refuses every later pickup for the rest of the run — the exact twelve-hour
  // failure this module was written to end, displaced by one bay.
  for (const preference of BAY_PREFERENCES) {
    for (const key of preference.bays) {
      assert.equal(FREIGHT_BAYS.has(key), true, `${key} is routed to but not unloaded`);
    }
  }
});

test("FREIGHT_BAYS never includes a bay that holds the ship's own kit", () => {
  // fuel and ammo are deliberately NOT here: the operator asked for them to be
  // supported, and a bay a bot may fill has to be one it can also empty. A ship
  // that must keep its own charges says so with `exceptBays`.
  for (const kit of [
    "drone",
    "fighter",
    "subsystem",
    "shipMaintenance",
    "ship",
    "smallShip",
    "mediumShip",
    "largeShip",
    "industrialShip",
    "booster",
    "quafe",
    "corpse",
    "fleet",
    "mobileDepot",
  ]) {
    assert.equal(FREIGHT_BAYS.has(kit), false, `${kit} is the ship's kit, not freight`);
  }
});

test("FREIGHT_BAYS does not list the cargo hold, which is swept as a place not a bay", () => {
  assert.equal(FREIGHT_BAYS.has("cargo"), false);
});

test("the shipped table routes the cargo the bug was about", () => {
  const bays = [bay("ore", true), bay("mineral", true), bay("ice", true)];
  const veldspar = row(1, 25, 462);
  const ice = row(2, 25, 465);
  const tritanium = row(3, 4, 18);
  const module = row(4, 7, 60);
  const groups = planBayTransfers([veldspar, ice, tritanium, module], bays);
  // Order is "first mention across BAY_PREFERENCES, cargo last" — "ore" is
  // emitted here while the ICE rule's fallback list is being walked, which is
  // why it precedes "mineral". Only cargo-last is load-bearing; the rest is
  // pinned so the sequence of transfer calls stays deterministic.
  assert.deepEqual(groups, [
    { bay: "ice", itemIDs: [2] },
    { bay: "ore", itemIDs: [1] },
    { bay: "mineral", itemIDs: [3] },
    { bay: null, itemIDs: [4] },
  ]);
});

test("ammunition goes to the ammo hold, and jump fuel to the fuel bay", () => {
  // Category 8 is every charge: ammunition, missiles, cap boosters, scripts.
  assert.deepEqual(preferredBays(row(1, 8, 85)), ["ammo"]);
  assert.deepEqual(preferredBays(row(2, 8, 654)), ["ammo"]);
  // Group 423 is "Ice Product" — the isotopes and their fuel-class siblings.
  assert.deepEqual(preferredBays(row(3, 4, 423)), ["fuel"]);
  assert.deepEqual(preferredBays(row(4, 4, 1136)), ["fuel"], "fuel blocks too");
});

test("raw ice and its refined product are told apart", () => {
  // Checked against live static data: Clear Icicle is group 465 in category 25;
  // group 423 in category 4 is the refined output. This file had them swapped.
  assert.deepEqual(preferredBays(row(1, 25, 465)), ["ice", "ore"], "raw ice");
  assert.deepEqual(preferredBays(row(2, 4, 423)), ["fuel"], "ice PRODUCT");
});

// ── The chain: specialised bays only, cargo is not a backstop ──────────────

function vrow(itemID: number, categoryID: number | null, groupID: number | null, quantity: number, volume: number | null) {
  return { itemID, typeID: 1, groupID, categoryID, flagID: null, quantity, singleton: false, volume };
}

const FREE = (map: Record<string, number | null>) => (bay: string | null) => map[bay ?? "cargo"] ?? null;

test("ore that OVERFLOWS the ore hold stays in the can — it never lands in cargo", () => {
  // The operator's rule, and not a preference: "if the ore bay exists, no ore in
  // ship cargo." Also the safe reading — deliver-ore empties the specialised
  // holds, so ore pushed into a barge's cargo is ore nothing will ever unload.
  const out = planLootTransfers(
    [vrow(1, 25, 462, 1000, 1)],
    [bay("ore", true)],
    FREE({ ore: 400, cargo: 5000 }),
  );
  assert.deepEqual(out, [{ bay: "ore", itemIDs: [1], qty: 400 }]);
  assert.equal(out.some((t) => t.bay === null), false, "cargo was not offered the overflow");
});

test("a hull with NO ore hold takes the ore into cargo, which is what cargo is for", () => {
  const out = planLootTransfers(
    [vrow(1, 25, 462, 300, 1)],
    [bay("ore", false)],
    FREE({ cargo: 5000 }),
  );
  assert.deepEqual(out, [{ bay: null, itemIDs: [1], qty: null }]);
});

test("a stack that fits its bay entirely moves whole", () => {
  const out = planLootTransfers(
    [vrow(1, 25, 462, 100, 1)],
    [bay("ore", true)],
    FREE({ ore: 5000, cargo: 500 }),
  );
  assert.deepEqual(out, [{ bay: "ore", itemIDs: [1], qty: null }]);
});

test("ice cascades to the MINING hold when the ice hold is full — both are specialised", () => {
  // Chaining between specialised bays is still right: flag 134 takes ice since
  // patch 19.11. What is forbidden is falling through to the cargo hold.
  const out = planLootTransfers(
    [vrow(1, 25, 465, 1000, 1)],
    [bay("ice", true), bay("ore", true)],
    FREE({ ice: 400, ore: 600, cargo: 5000 }),
  );
  assert.deepEqual(out, [
    { bay: "ice", itemIDs: [1], qty: 400 },
    { bay: "ore", itemIDs: [1], qty: 600 },
  ]);
});

test("two stacks bound for one bay cannot both be promised the same room", () => {
  const out = planLootTransfers(
    [vrow(1, 25, 462, 300, 1), vrow(2, 25, 462, 300, 1)],
    [bay("ore", true)],
    FREE({ ore: 400, cargo: 5000 }),
  );
  const oreUnits = out
    .filter((t) => t.bay === "ore")
    .reduce((sum, t) => sum + (t.qty ?? 300), 0);
  assert.equal(oreUnits, 400, "the ore hold is allocated exactly once");
  assert.equal(out.some((t) => t.bay === null), false, "and the rest waits, rather than going to cargo");
});

test("a destination whose room cannot be READ is handed the row whole", () => {
  // No arithmetic is possible, so the server rules on it — holdFit's standing
  // rule — and the chain stops rather than guessing further down it.
  const out = planLootTransfers(
    [vrow(1, 25, 462, 100, 1)],
    [bay("ore", true)],
    FREE({ ore: null, cargo: 1000 }),
  );
  assert.deepEqual(out, [{ bay: "ore", itemIDs: [1], qty: null }]);
});

test("a row of unknown VOLUME is handed over whole at its first choice", () => {
  const out = planLootTransfers(
    [vrow(1, 25, 462, 100, null)],
    [bay("ore", true)],
    FREE({ ore: 5000, cargo: 500 }),
  );
  assert.deepEqual(out, [{ bay: "ore", itemIDs: [1], qty: null }]);
});

test("a full ship asks for nothing at all", () => {
  const out = planLootTransfers(
    [vrow(1, 25, 462, 100, 1)],
    [bay("ore", true)],
    FREE({ ore: 0, cargo: 0 }),
  );
  assert.deepEqual(out, []);
});

test("minerals go to a mineral hold when the hull has one, and stay out of cargo", () => {
  // The bays the operator listed are routed AND measured, not merely routed.
  const out = planLootTransfers(
    [vrow(1, 4, 18, 1000, 1)],
    [bay("mineral", true), bay("ore", true)],
    FREE({ mineral: 600, ore: 5000, cargo: 5000 }),
  );
  assert.deepEqual(out, [{ bay: "mineral", itemIDs: [1], qty: 600 }]);
});

test("loot with no bay of its own still goes to cargo, alongside bay-bound rows", () => {
  const out = planLootTransfers(
    [vrow(1, 25, 462, 100, 1), vrow(2, 7, 60, 5, 1)],
    [bay("ore", true)],
    FREE({ ore: 5000, cargo: 500 }),
  );
  assert.deepEqual(out, [
    { bay: "ore", itemIDs: [1], qty: null },
    { bay: null, itemIDs: [2], qty: null },
  ]);
});
