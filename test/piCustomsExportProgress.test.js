"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { exportPlannedColonies } = require("../src/piCustomsExport");

const PLANET_A = 40000001;
const PLANET_B = 40000002;
const OFFICE_A = 1200040000001;
const OFFICE_B = 1200040000002;

function entry(planetID, pads) {
  return { planetID, planetName: "Alpha", solarSystemID: 30000001, solarSystemName: "Test System", pads, reason: null };
}

function client(refusedPinID, taxRate = 0.1) {
  const completed = [];
  return {
    completed,
    async call(service) {
      if (service === "planetOrbitalRegistryBroker") return taxRate;
      return { type: "dict", entries: [
        ["columns", ["groupID", "itemID", "orbitID"]],
        ["lines", [[1025, OFFICE_A, PLANET_A], [1025, OFFICE_B, PLANET_B]]],
      ] };
    },
    async bind(_service, [officeID]) { return officeID; },
    async callBound(officeID, _method, [pinID]) {
      if (pinID === refusedPinID) throw new Error("CannotLaunchCommoditiesNotFound");
      completed.push([officeID, pinID]);
    },
  };
}

test("a later pad refusal preserves goods already exported and still processes another colony", async () => {
  const runtime = client(12);
  const results = await exportPlannedColonies(runtime, [
    entry(PLANET_A, [{ pinID: 11, commodities: { 3645: 70 } }, { pinID: 12, commodities: { 3645: 300 } }]),
    entry(PLANET_B, [{ pinID: 13, commodities: { 3645: 42 } }]),
  ]);
  assert.deepEqual(runtime.completed, [[OFFICE_A, 11], [OFFICE_B, 13]]);
  assert.equal(results[0].officeID, OFFICE_A);
  assert.equal(results[0].exported, true);
  assert.equal(results[0].units, 70);
  assert.equal(results[0].reason, "refused");
  assert.equal(results[0].message, "CannotLaunchCommoditiesNotFound");
  assert.equal(results[1].exported, true);
  assert.equal(results[1].units, 42);
});

test("a first pad refusal reports no successful units", async () => {
  const results = await exportPlannedColonies(client(11), [entry(PLANET_A, [{ pinID: 11, commodities: { 3645: 70 } }])]);
  assert.equal(results[0].exported, false);
  assert.equal(results[0].units, 0);
  assert.equal(results[0].reason, "refused");
});

test("an unavailable or invalid tax rate is refused before exporting, while zero remains valid", async () => {
  const plan = [entry(PLANET_A, [{ pinID: 11, commodities: { 3645: 70 } }])];
  for (const taxRate of [null, "unreadable", Infinity]) {
    const runtime = client(null, taxRate);
    const [result] = await exportPlannedColonies(runtime, plan);
    assert.equal(result.exported, false);
    assert.equal(result.reason, "no-tax-rate");
    assert.equal(result.message, "The customs office did not provide an export tax rate.");
    assert.deepEqual(runtime.completed, []);
  }
  const [zeroTax] = await exportPlannedColonies(client(null, 0), plan);
  assert.equal(zeroTax.exported, true);
  assert.equal(zeroTax.units, 70);
});
