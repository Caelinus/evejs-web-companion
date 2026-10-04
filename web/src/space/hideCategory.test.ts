// HIDE CATEGORIES (PLAN.txt goal 2) — the axis the player hides by, and the
// reason it exists: `bracketRole` ends in `return "ship"`, so static scenery
// was filed under Ships and hiding Ships took the scenery with it.
//
// ⚠ THE GROUP TABLE IS CHECKED AGAINST THE REAL SDE, NOT READ BACK FROM THE
// SOURCE. A typo'd group id cannot throw — it silently mis-files an object — so
// these tests read `groups.jsonl` out of the environment and assert that every
// id the table names is a real group in build 3396210. That is what turns "I
// typed these from memory" into something verifiable.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  HIDE_CATEGORIES,
  categoryCovers,
  hideCategoriesFor,
  hideCategoryByID,
  offeredCategoriesFor,
  type HideCategoryID,
} from "./hideCategory.ts";
import { bracketRole } from "./tactical.ts";
import type { SpaceEntity, SpaceVector } from "../store/types.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "celestial",
    typeID: 16,
    groupID: 500,
    categoryID: 2,
    name: null,
    ownerID: null,
    radius: 100,
    position: ORIGIN,
    velocity: ORIGIN,
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
    oreValuePerM3: null,
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...over,
  };
}

// --- the bug the module exists to fix ---------------------------------------

test("a Large Collidable Object is scenery, NOT a ship — and hiding Ships misses it", () => {
  // Group 226 is literally named "Large Collidable Object" in the SDE and sits
  // under category 2 (Celestial), i.e. static scenery.
  const lco = entity({ itemID: 1, groupID: 226, categoryID: 2, kind: "celestial" });

  assert.deepEqual(hideCategoriesFor(lco), ["scenery"]);
  assert.equal(categoryCovers("ship", lco), false);
  assert.equal(categoryCovers("scenery", lco), true);

  // ⚠ THE DOCUMENTED DEFECT, ASSERTED RATHER THAN DESCRIBED. `bracketRole`'s
  // final `return "ship"` is a catch-all: this scenery, tagged with a kind the
  // radar does not recognise, is filed as a SHIP there while the hide axis files
  // it correctly. So a player hiding "Ships" on the radar's word would take the
  // scenery with them.
  //
  // ⚠ If a future fix makes the two agree, THIS assertion is what should change
  // — and it should change deliberately, not by accident.
  const taggedShip = entity({ itemID: 1, groupID: 226, categoryID: 2, kind: "static" });
  assert.equal(bracketRole(taggedShip), "ship", "bracketRole files LCO scenery as a ship");
  assert.equal(categoryCovers("ship", taggedShip), false, "the hide axis does not");
});

test("every kind of scenery is scenery to the hide axis, whatever the runtime calls it", () => {
  // The runtime tags these inconsistently; a group the player can see should
  // not change category because the server named its kind differently.
  for (const groupID of [226, 336, 517, 885]) {
    for (const kind of ["ship", "celestial", "structure", "somethingnew"]) {
      const row = entity({ itemID: groupID, groupID, categoryID: 2, kind });
      assert.deepEqual(
        hideCategoriesFor(row),
        ["scenery"],
        `group ${groupID} tagged ${kind}`,
      );
    }
  }
});

test("a real ship is still a ship, and hiding Ships reaches it", () => {
  const frigate = entity({ itemID: 2, groupID: 25, categoryID: 6, kind: "ship" });
  assert.deepEqual(hideCategoriesFor(frigate), ["ship"]);
  assert.equal(categoryCovers("ship", frigate), true);
});

test("Scenery and Ships are disjoint, so hiding scenery cannot hide ships", () => {
  const scenery = entity({ itemID: 3, groupID: 226, categoryID: 2 });
  const ship = entity({ itemID: 4, groupID: 25, categoryID: 6 });
  assert.equal(categoryCovers("scenery", ship), false);
  assert.equal(categoryCovers("ship", scenery), false);
});

// --- the categories a pilot meets -------------------------------------------

test("the everyday kinds each land in their own category", () => {
  const cases: readonly [number, number, string, HideCategoryID][] = [
    [7, 2, "Planet", "planet"],
    [8, 2, "Moon", "moon"],
    [10, 2, "Stargate", "gate"],
    [186, 2, "Wreck", "wreck"],
    [15, 3, "Station", "station"],
    [12, 2, "Cargo Container", "container"],
    [100, 18, "Combat Drone", "drone"],
  ];
  for (const [groupID, categoryID, what, expected] of cases) {
    const row = entity({ itemID: 1000 + groupID, groupID, categoryID, kind: "celestial" });
    assert.deepEqual(hideCategoriesFor(row), [expected], what);
  }

  // ⚠ AN ORE GROUP ALONE IS NOT A ROCK. Group 450 is "Arkonor" — the ore, not
  // an asteroid of it. The runtime tells them apart by stamping the ROW with a
  // yield, which is why the ore stamp is checked below rather than here.
  const oreType = entity({ itemID: 1450, groupID: 450, categoryID: 25, kind: "celestial" });
  assert.deepEqual(hideCategoriesFor(oreType), ["celestial"]);

  const oreRock = entity({
    itemID: 1451,
    groupID: 450,
    categoryID: 25,
    kind: "celestial",
    miningYieldTypeID: 450,
  });
  assert.deepEqual(hideCategoriesFor(oreRock), ["asteroid"]);
});

test("police answer before everything else, so a Concord hull is not traffic", () => {
  const concord = entity({
    itemID: 5,
    groupID: 25,
    categoryID: 6,
    kind: "ship",
    isNpc: true,
    npcEntityType: "concord",
  });
  assert.deepEqual(hideCategoriesFor(concord), ["police"]);
});

test("a rock is a rock by the runtime's stamp, not by its group", () => {
  const belt = entity({ itemID: 6, groupID: 9, categoryID: 2, kind: "celestial" });
  assert.equal(hideCategoriesFor(belt).includes("asteroid"), true);

  const rock = entity({
    itemID: 7,
    groupID: null,
    categoryID: 2,
    kind: "celestial",
    miningYieldTypeID: 755,
  });
  assert.deepEqual(hideCategoriesFor(rock), ["asteroid"]);
});

// --- fallbacks ---------------------------------------------------------------

test("a row whose kind we can read still gets a category when its group is absent", () => {
  const ship = entity({ itemID: 8, groupID: null, categoryID: null, kind: "ship" });
  assert.deepEqual(hideCategoriesFor(ship), ["ship"]);
});

test("a hull-category object the group table has never heard of is still a ship", () => {
  // Category 6 is the hull category. Not naming a group is not evidence of
  // scenery — it is evidence of an unfamiliar hull.
  const unfamiliar = entity({ itemID: 9, groupID: 99999, categoryID: 6, kind: "ship" });
  assert.deepEqual(hideCategoriesFor(unfamiliar), ["ship"]);
});

test("a row we cannot classify at all is `other`, never an empty list", () => {
  const blank = entity({ itemID: 10, groupID: null, categoryID: null, kind: null });
  assert.deepEqual(hideCategoriesFor(blank), ["other"]);
  // An empty list would refuse the press and read as a broken button.
  assert.equal(hideCategoriesFor(blank).length, 1);
});

test("`other` is never OFFERED as a button, because it would hide nothing", () => {
  const blank = entity({ itemID: 11, groupID: null, categoryID: null, kind: null });
  assert.deepEqual(offeredCategoriesFor(blank), []);
});

test("a group of 0 or a non-finite group never matches anything", () => {
  // The old entry builder refused these because group 0 would match every
  // ungrouped row on the grid, emptying the overview in one press.
  for (const groupID of [0, -1, Number.NaN]) {
    const row = entity({ itemID: 12, groupID, categoryID: null, kind: null });
    assert.deepEqual(hideCategoriesFor(row), ["other"], `groupID ${groupID}`);
  }
});

// --- the category table itself -----------------------------------------------

test("every category has a label, a hint, and no duplicate id", () => {
  const seen = new Set<HideCategoryID>();
  for (const category of HIDE_CATEGORIES) {
    assert.equal(seen.has(category.id), false, `duplicate category ${category.id}`);
    seen.add(category.id);
    assert.notEqual(category.label.trim(), "", `${category.id} label`);
    assert.notEqual(category.hint.trim(), "", `${category.id} hint`);
  }
  assert.equal(hideCategoryByID("ship").id, "ship");
  assert.equal(hideCategoryByID("nonsense" as HideCategoryID).id, "other");
});

// --- the group table, checked against the real SDE ---------------------------

const SDE_ROOT = process.env.EVEJS_ROOT ?? "/workspaces/EveJS_dev/eve.js";
const GROUPS_FILE = `${SDE_ROOT}/_local/sde/eve-online-static-data-3396210-jsonl/groups.jsonl`;

interface SdeGroup {
  readonly _key: number;
  readonly categoryID: number;
  readonly name: { readonly en: string };
}

function readSdeGroups(): SdeGroup[] | null {
  if (!existsSync(GROUPS_FILE)) return null;
  return readFileSync(GROUPS_FILE, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SdeGroup);
}

test("every group id the table names is a REAL group in the SDE", (t) => {
  const groups = readSdeGroups();
  if (groups === null) {
    t.skip(`SDE groups.jsonl not present at ${GROUPS_FILE}`);
    return;
  }
  const known = new Set(groups.map((row) => row._key));
  const ids = [
    9, 11, 226, 10, 186, 273, 97, 100, 101, 299, 470, 544, 545, 549, 639, 640, 641, 1159,
    1452, 182, 301, 12, 340, 448, 649, 15, 16, 307, 874, 7, 8, 6, 1165, 995, 305, 227, 312,
    711, 1975, 1978, 1980, 1983, 1882, 517, 502, 885, 411, 368, 336, 1071, 4719, 1971, 288,
    287, 298, 4430, 4935, 4937, 4938, 4918, 366, 4081,
  ];
  const missing = ids.filter((id) => !known.has(id));
  assert.deepEqual(missing, [], `group ids absent from the SDE: ${missing.join(", ")}`);
});

test("group 226 really is the Large Collidable Object the whole module is about", (t) => {
  const groups = readSdeGroups();
  if (groups === null) {
    t.skip(`SDE groups.jsonl not present at ${GROUPS_FILE}`);
    return;
  }
  const row = groups.find((candidate) => candidate._key === 226);

  assert.ok(row, "group 226 must exist in the SDE");
  assert.equal(row.name.en, "Large Collidable Object");
  assert.equal(row.categoryID, 2, "and it is a Celestial, i.e. scenery, not a hull");
});

test("every ore group is reachable as `asteroid` through a category-25 row", (t) => {
  const groups = readSdeGroups();
  if (groups === null) {
    t.skip(`SDE groups.jsonl not present at ${GROUPS_FILE}`);
    return;
  }
  const ores = groups.filter((row) => row.categoryID === 25);
  assert.ok(ores.length > 0, "the SDE has ore groups");

  // None of the 49 ore groups is named in the table — they all reach `asteroid`
  // through the runtime's ore stamp, which is how the merge stays honest as the
  // SDE adds ore.
  for (const ore of ores) {
    const row = entity({
      itemID: 2000 + ore._key,
      groupID: ore._key,
      categoryID: 25,
      kind: "celestial",
      miningYieldTypeID: 755,
    });
    assert.deepEqual(hideCategoriesFor(row), ["asteroid"], `ore group ${ore._key}`);
  }
});
