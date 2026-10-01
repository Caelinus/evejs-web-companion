"use strict";

// Invention with a decryptor: the exact materials map the server compares
// against (src/industryInstall.js).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  facilityMaterialModifiers,
  findFacilityRow,
  inventionProductTypeID,
  inventionRequestMaterials,
  modifierMatchesProduct,
  roundMaterialQuantity,
} = require("../src/industryInstall");

const DATACORE_A = 20418;
const DATACORE_B = 20419;
const PARITY = 34204;
const INVENTION = { materials: [{ typeID: DATACORE_A, quantity: 1 }, { typeID: DATACORE_B, quantity: 2 }], products: [{ typeID: 2457, quantity: 10 }] };
const PRODUCT = { typeID: 2457, groupID: 176, categoryID: 9 };

function keyVal(entries) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

// The shape GetFacilities answers (captured live): activities is a dict of
// activityID to a tuple of modifier lists, [time, material, cost, ...].
function facility(facilityID, inventionMaterial) {
  return keyVal([
    ["facilityID", facilityID],
    ["activities", { type: "dict", entries: [
      [1, { type: "tuple", items: [[[0.95, null, null, null, 5]], [], [], [], [], []] }],
      [8, { type: "tuple", items: [[[0.98, null, null, null, 5]], inventionMaterial, [], [], [], []] }],
    ] }],
  ]);
}

test("datacores per run times runs, and the decryptor at one per run", () => {
  assert.deepEqual(
    inventionRequestMaterials({ invention: INVENTION, runs: 3, modifiers: [], productType: PRODUCT, decryptorTypeID: PARITY }),
    { [DATACORE_A]: 3, [DATACORE_B]: 6, [PARITY]: 3 },
  );
});

test("a facility's invention material modifier applies, rounded the server's way, never below one a run", () => {
  // 2 x 3 x 0.9 = 5.4 -> 6; 1 x 3 x 0.9 = 2.7 -> 3.
  assert.deepEqual(
    inventionRequestMaterials({ invention: INVENTION, runs: 3, modifiers: [[0.9, null, null, null, 6]], productType: PRODUCT, decryptorTypeID: PARITY }),
    { [DATACORE_A]: 3, [DATACORE_B]: 6, [PARITY]: 3 },
  );
  // 1 x 3 x 0.5 = 1.5 -> 2, but at least one a run: 3.
  assert.equal(roundMaterialQuantity(1.5, 3), 3);
  // Two decimals first: 4.001 is 4, not 5.
  assert.equal(roundMaterialQuantity(4.001, 1), 4);
  assert.equal(roundMaterialQuantity(4.01, 1), 5);
});

test("a modifier for another category, group or type does not apply", () => {
  assert.equal(modifierMatchesProduct([0.9, null, null, null], PRODUCT), true);
  assert.equal(modifierMatchesProduct([0.9, 9, null, null], PRODUCT), true);
  assert.equal(modifierMatchesProduct([0.9, 6, null, null], PRODUCT), false);
  assert.equal(modifierMatchesProduct([0.9, null, 176, null], PRODUCT), true);
  assert.equal(modifierMatchesProduct([0.9, null, 25, null], PRODUCT), false);
  assert.equal(modifierMatchesProduct([0.9, null, null, 2457], PRODUCT), true);
  assert.equal(modifierMatchesProduct([0.9, null, null, 2456], PRODUCT), false);
  assert.equal(modifierMatchesProduct([0.9, 9, null, null], null), false);
  const heavy = { materials: [{ typeID: DATACORE_B, quantity: 10 }] };
  const halved = inventionRequestMaterials({ invention: heavy, runs: 2, modifiers: [[0.5, 6, null, null], [0.5, null, 176, null]], productType: PRODUCT, decryptorTypeID: PARITY });
  // Only the group modifier matches: 10 x 2 x 0.5 = 10, not 10 x 2 x 0.25 = 5.
  assert.equal(halved[DATACORE_B], 10);
});

test("the facility's invention material modifiers are read off its GetFacilities row", () => {
  const rows = { type: "list", items: [facility(60000001, []), facility(60000002, [[0.9, null, null, null, 6]])] };
  const row = findFacilityRow(rows, 60000002);
  assert.ok(row);
  assert.deepEqual(facilityMaterialModifiers(row, 8), [[0.9, null, null, null, 6]]);
  assert.deepEqual(facilityMaterialModifiers(findFacilityRow(rows, 60000001), 8), []);
  // Manufacturing's material list is its own, and empty here.
  assert.deepEqual(facilityMaterialModifiers(row, 1), []);
  assert.equal(findFacilityRow(rows, 60000003), null);
});

test("the product is the one asked for if the recipe makes it, else the only one", () => {
  assert.equal(inventionProductTypeID(INVENTION, 0), 2457);
  assert.equal(inventionProductTypeID(INVENTION, 2457), 2457);
  assert.equal(inventionProductTypeID(INVENTION, 999), 0);
  assert.equal(inventionProductTypeID({ products: [{ typeID: 1 }, { typeID: 2 }] }, 0), 0);
});
