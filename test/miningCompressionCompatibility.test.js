"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { compressionCompatibility } = require("../src/miningCompressionCompatibility");
const type = { typeID: 1230, groupID: 462, categoryID: 25 };
const list = { listID: 334, includedTypeIDs: [], includedGroupIDs: [], includedCategoryIDs: [25], excludedTypeIDs: [], excludedGroupIDs: [], excludedCategoryIDs: [] };
test("same runtime typelist include/exclude rules and compression recipe, without assuming all category25 fits", () => {
  const read = compressionCompatibility([type], [334], [list], { 1230: 62516 });
  assert.deepEqual(read, [{ typeID: 1230, compressedTypeID: 62516, matchingTypeListIDs: [334], availability: "available" }]);
  for (const exclusion of [{ excludedTypeIDs: [1230] }, { excludedGroupIDs: [462] }, { excludedCategoryIDs: [25] }])
    assert.deepEqual(compressionCompatibility([type], [334], [{ ...list, ...exclusion }], { 1230: 62516 })[0].matchingTypeListIDs, []);
  assert.equal(compressionCompatibility([type], [334], [list], {})[0].compressedTypeID, null);
});
test("missing type, list, rules or recipe table are unknown, never compatible", () => {
  for (const [types, lists, recipes] of [[[type], null, {}], [[type], [], {}], [[{ typeID: 1230 }], [list], {}],
    [[type], [list], null], [[type], [{ ...list, excludedTypeIDs: undefined }], {}]]) {
    const result = compressionCompatibility(types, [334], lists, recipes)[0]; assert.equal(result.availability, "unknown"); assert.equal(result.matchingTypeListIDs, null);
  }
});
