"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizePolicies } = require("../src/miningOperationPolicies");
const { createMiningOperationStore, STORE_FILENAME } = require("../src/miningOperationStore");
const { familyCapabilities, buildStandardProfile } = require("../src/miningOperationProfiles");
const system = id => id === 30000142 ? { solarSystemID: id, solarSystemName: "Jita" } : null;
const station = id => id === 60003760 ? { stationID: id, stationName: "Home", solarSystemID: 30000142 } : null;
const normalize = input => normalizePolicies(input, station, system);
const returning = (destination = { stationID: 60003760 }) => ({ parking: { mode: "RETURN_HOME_DOCK", destination } });

test("old version-1 JSON loads deterministic Stay defaults without rewriting or copying scripts", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcc-policies-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = { operationID: "old", name: "Old fleet", area: { anchorSystemID: 30000142, targetClasses: ["BELT"], reach: "CURRENT_SYSTEM" },
    unloadPolicy: "SELF_UNLOAD", targetPolicy: "ANY_ELIGIBLE", members: [{ characterID: 1, characterName: "Miner", accountName: "account", role: "MINER", automationID: "saved-ref" }] };
  const raw = JSON.stringify({ version: 1, operations: [old] });
  const file = path.join(dir, STORE_FILENAME);
  fs.writeFileSync(file, raw);
  const store = createMiningOperationStore({ dataDir: dir, resolveSystem: system, resolveStation: station });
  assert.equal(store.get("old").policies.parking.mode, "STAY_IN_PLACE");
  assert.equal(store.get("old").policies.parking.destination, null);
  assert.equal(fs.readFileSync(file, "utf8"), raw, "read is not a migration write");
  const saved = store.save({ ...old, policies: returning() });
  assert.deepEqual(createMiningOperationStore({ dataDir: dir, resolveSystem: system, resolveStation: station }).get("old"), saved);
  assert.equal(saved.members[0].automationID, "saved-ref");
  assert.equal(saved.members[0].doc, undefined);
});

test("parking station is canonical, explicit and separate from delivery or starting station", () => {
  assert.deepEqual(normalize(returning()).parking.destination, { stationID: 60003760, stationName: "Home", systemName: "Jita" });
  for (const destination of [null, { stationID: 1 }, { stationID: 60003760, stationName: "Wrong" }, { stationID: 60003760, systemName: "Wrong" }]) {
    assert.throws(() => normalize(returning(destination)), /station/i);
  }
  assert.throws(() => normalize({ parking: { mode: "RETURN_HOME_DOCK", startingStationID: 60003760 } }), /explicit known parking station/);
  assert.throws(() => normalize({ parking: { ...returning().parking, corporationDivision: 9 } }), /division/);
  assert.deepEqual(normalize().parking, { mode: "STAY_IN_PLACE", destination: null, corporationDivision: null, corporationID: null });
});

test("parking accepts a resolved structure and preserves an explicit corporation division", () => {
  const structure = { kind: "structure", id: 1030000000001, name: "My Astrahus", solarSystemID: 30000142, solarSystemName: "Jita" };
  assert.deepEqual(normalize({ parking: { mode: "RETURN_HOME_DOCK", destination: structure } }).parking.destination, structure);
  assert.deepEqual(normalize({ parking: { mode: "RETURN_HOME_UNLOAD_DOCK", destination: structure } }).parking.destination, structure);
  assert.equal(normalize({ parking: { mode: "RETURN_HOME_UNLOAD_DOCK", destination: structure, corporationDivision: 1, corporationID: 98000001 } }).parking.corporationDivision, 1);
  assert.throws(() => normalize({ parking: { mode: "RETURN_HOME_UNLOAD_DOCK", destination: structure, corporationDivision: 1 } }), /corporation ID/);
  assert.throws(() => normalize({ parking: { mode: "RETURN_HOME_DOCK", destination: { ...structure, solarSystemName: "Wrong" } } }), /known solar system/);
  assert.throws(() => normalize({ parking: { mode: "RETURN_HOME_DOCK", destination: { ...structure, id: 5 } } }), /player structure/);
});

test("future policies have explicit defaults and cannot be silently enabled", () => {
  const defaults = normalize();
  assert.equal(defaults.travelAssist.mode, "DISABLED");
  assert.equal(normalize({ travelAssist: { mode: "AUTO" } }).travelAssist.mode, "AUTO");
  assert.throws(() => normalize({ travelAssist: { mode: "AUTO", takeOver: true } }), /not executable/);
  assert.equal(defaults.resourceTarget.mode, "ANY_ELIGIBLE");
  assert.equal(defaults.scouting.mode, "DISABLED");
  assert.equal(defaults.defense.mode, "EXISTING_SELF_DEFENSE");
  for (const key of ["travelAssist", "resourceTarget", "scouting", "defense"]) {
    assert.throws(() => normalize({ [key]: { mode: "ENABLED" } }), /not executable/);
  }
  assert.throws(() => normalize({ version: 2 }), /version/);
});

test("distinct families expose ore and ice but not gas; Belt revisions and behavior remain pinned", () => {
  const families = familyCapabilities();
  assert.deepEqual(families.map(row => [row.family, row.executable]), [["BELT", true], ["ORE_ANOMALY", true], ["ICE", true], ["GAS", false]]);
  const def = { area: { targetClasses: ["BELT"] }, unloadPolicy: "HAULER_SERVICE",
    unloadDestination: { stationID: 60003760, stationName: "Home", systemName: "Jita", corporationDivision: 1 } };
  const miner = buildStandardProfile(def, { role: "MINER", routineMode: "STANDARD" });
  const hauler = buildStandardProfile(def, { role: "HAULER", routineMode: "STANDARD" });
  assert.equal(miner.scriptID, "mcc.belt.hauler-service.miner");
  assert.equal(miner.rev, 2);
  assert.equal(hauler.scriptID, "mcc.belt.hauler-service.hauler");
  assert.equal(hauler.rev, 1);
  assert.deepEqual(miner.doc.program[0].body.map(row => row.macro), ["undock", "mine-at-belt", "jettison-ore"]);
  assert.equal(miner.doc.program[0].body[1].args.drones, undefined, "shared Batch 6 capability controller owns drones");
  assert.equal(hauler.doc.program[0].body[1].args.seconds.value, 3);
  for (const family of families.filter(row => !row.executable)) {
    assert.deepEqual(family.profiles, {});
    assert.equal(buildStandardProfile({ ...def, area: { targetClasses: [family.family] } }, { role: "MINER" }), null);
  }
});
