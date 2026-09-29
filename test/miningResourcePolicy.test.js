"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeResourcePolicy, validateResourcePolicy } = require("../src/miningResourcePolicy");
const { normalizePolicies } = require("../src/miningOperationPolicies");

test("old policy defaults to Any; preferences are ordered authoritative IDs and manual only", () => {
  assert.deepEqual(normalizePolicies().resourcePolicy, { mode: "ANY_ELIGIBLE", source: "MANUAL", typeIDs: [] });
  assert.deepEqual(normalizeResourcePolicy({ mode: "PREFER_LIST", typeIDs: [22, 11] }).typeIDs, [22, 11]);
  for (const value of [{ mode: "PREFER_LIST", typeIDs: [] }, { mode: "PREFER_LIST", typeIDs: [11, 11] },
    { mode: "PREFER_LIST", typeIDs: ["Arkonor"] }, { mode: "PREFER_LIST", source: "INDUSTRY_DEMAND", typeIDs: [11] },
    { mode: "STRICT_LIST", typeIDs: [11] }]) assert.throws(() => normalizeResourcePolicy(value), /resource|eligible/i);
});
test("catalog validation rejects unknown resources, GAS and cross-family preference", () => {
  const catalog = [{ typeID: 11, family: "ore" }, { typeID: 22, family: "ice" }];
  for (const family of ["BELT", "ORE_ANOMALY", "ICE"]) {
    const definition = { area: { targetClasses: [family] }, policies: { resourcePolicy: { mode: "PREFER_LIST", typeIDs: [family === "ICE" ? 22 : 11] } } };
    assert.doesNotThrow(() => validateResourcePolicy(definition, catalog));
    for (const id of [999, family === "ICE" ? 11 : 22]) {
      definition.policies.resourcePolicy.typeIDs = [id]; assert.throws(() => validateResourcePolicy(definition, catalog), /incompatible/);
    }
  }
  assert.throws(() => validateResourcePolicy({ area: { targetClasses: ["GAS"] }, policies: { resourcePolicy: { mode: "PREFER_LIST", typeIDs: [11] } } }, catalog), /executable/);
});
