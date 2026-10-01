"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { projectModuleReach } = require("./miningRangeProjection");
const reference = process.env.EVEJS_CLEAN_REFERENCE || path.resolve(__dirname, "../../../EveJS-0.12.9");

// Reconstruct the actual tracked patch in memory. No clean-reference writes or
// runtime entrypoint/database imports. Context assertions also guard patch drift.
function patchedSource(relative) {
  const original = fs.readFileSync(path.join(reference, relative), "utf8").replace(/\r\n/g, "\n").split("\n");
  const patch = fs.readFileSync(path.join(__dirname, "mining-support-services.patch"), "utf8").replace(/\r\n/g, "\n");
  const section = patch.split("diff --git ").find(s => s.startsWith(`a/${relative} b/${relative}\n`));
  assert.ok(section, relative);
  const out = []; let cursor = 0;
  const lines = section.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(lines[i]);
    if (!hunk) continue;
    const start = Number(hunk[1]) - 1;
    out.push(...original.slice(cursor, start)); cursor = start;
    while (++i < lines.length && !lines[i].startsWith("@@ ")) {
      const line = lines[i]; if (line === "" && i === lines.length - 1) break;
      if (line[0] === " " || line[0] === "-") assert.equal(original[cursor++], line.slice(1), `${relative} context`);
      if (line[0] === " " || line[0] === "+") out.push(line.slice(1));
    }
    i--;
  }
  out.push(...original.slice(cursor)); return out.join("\n");
}
function load(relative, dependencies) {
  const module = { exports: {} }, filename = path.join(reference, relative);
  vm.runInNewContext(patchedSource(relative), { module, exports: module.exports, __dirname: path.dirname(filename), Map, Set, Buffer,
    require(id) { if (id === "path") return path;
      const name = path.basename(id).replace(/\.js$/, "");
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency ${id}`);
    } }, { filename });
  return module.exports;
}
const numbers = { toFiniteNumber: (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback,
  toInt: (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback, round6: v => Number(v.toFixed(6)) };

test("gateway projects own reach with the scene's captured sample even while the clock advances", () => {
  const source = patchedSource("server/src/_secondary/express/evejsWebGatewayRuntime.js");
  const start = source.indexOf("refreshSpacePresentationFields(spaceRuntime, egoEntity, visible);");
  const end = source.indexOf("if (egoItemID > 0)", start);
  assert.ok(start >= 0 && end > start);
  let calls = 0;
  const snapshot = { sampledAtMs: 1 };
  vm.runInNewContext(source.slice(start, end), { snapshot, scene: { getCurrentSimTimeMs: () => 1000 + ++calls },
    spaceRuntime: {}, egoEntity: { itemID: 101 }, visible: [], refreshSpacePresentationFields() {},
    buildMineableStateLookup() {}, projectSpaceEntity() {}, projectActiveShipStatus: (_, sampledAtMs) => ({ moduleReach: { sampledAtSimTimeMs: sampledAtMs } }) });
  assert.equal(calls, 1);
  assert.equal(snapshot.ship.moduleReach.sampledAtSimTimeMs, snapshot.sampledAtMs);
  for (const clock of [undefined, 0, null, false, ""]) {
    const scene = clock === undefined ? {} : { getCurrentSimTimeMs: () => clock };
    const unavailable = { sampledAtMs: 1 };
    vm.runInNewContext(source.slice(start, end), { snapshot: unavailable, scene,
      spaceRuntime: {}, egoEntity: { itemID: 101 }, visible: [], refreshSpacePresentationFields() {}, buildMineableStateLookup() {},
      projectSpaceEntity() {}, projectActiveShipStatus: (_, sampledAtMs) => ({ moduleReach: { sampledAtSimTimeMs: sampledAtMs } }) });
    assert.equal(unavailable.ship.moduleReach.sampledAtSimTimeMs, clock === 0 ? 0 : null);
    assert.equal(unavailable.sampledAtMs, clock === 0 ? 0 : 1);
  }
});

test("projection binds exact own fitted identities and fails closed without mutating state", () => {
  const entity = { itemID: 101, activeModuleEffects: new Map([[301, { targetID: 901 }]]) };
  const items = [{ itemID: 301, typeID: 401, locationID: 101, ownerID: 501 }, { itemID: 302, typeID: 402, locationID: 101, ownerID: 501 }];
  const authority = { characterID: () => 501, shipItem: () => ({ itemID: 101 }), fittedItems: () => items,
    mining: (ship, item, now) => { assert.equal(ship, entity); assert.equal(now, 200); return item.itemID === 301
      ? { matched: true, availability: "available", maxRangeMeters: 23000, resourceFamily: "ore" } : { matched: false }; },
    isTractor: () => true, tractor: () => ({ maxRangeMeters: 72000.125 }), tractorSettlementMeters: 500 };
  const before = structuredClone({ entity, items });
  const result = projectModuleReach(entity, 200, authority);
  assert.equal(result.modules[0].maxRangeMeters, 23000); assert.equal(result.modules[1].maxRangeMeters, 72000.125);
  assert.equal(result.modules[1].settlementSurfaceDistanceMeters, 500);
  assert.deepEqual({ entity, items }, before);
  assert.equal(projectModuleReach(entity, null, authority).availability, "unknown");
  assert.equal(projectModuleReach(entity, 200, { ...authority, fittedItems: () => [{ ...items[0], ownerID: 502 }] }).availability, "unknown");
  assert.equal(projectModuleReach(entity, 200, { ...authority, mining: () => { throw Error("unreadable"); } }).availability, "unknown");
  assert.equal(projectModuleReach(entity, 200, { ...authority, mining: () => ({ matched: true, availability: "unknown", maxRangeMeters: 23000 }) }).modules[0].availability, "unknown");
});

test("actual mining read and activation share charge, fitting, skill, effect, burst and system snapshot inputs", () => {
  const shipItem = { itemID: 101 }, item = { itemID: 301, typeID: 401, ownerID: 501, locationID: 101, flagID: 27 };
  const charge = { itemID: 601, typeID: 701 }, effect = { effectID: 81, name: "mining" };
  const effectState = { moduleID: 302, effectID: 82 }, otherItem = { ...item, itemID: 302 };
  const skills = new Map([[100, 5]]), seen = [];
  const entity = { kind: "ship", itemID: 101, characterID: 501, systemID: 801, activeModuleEffects: new Map([[302, effectState]]) };
  const dependencies = { numbers, config: {}, logger: {}, interactionScope: { canEntitiesInteractLocally: () => true },
    characterState: { getActiveShipRecord: () => shipItem }, skillState: { getCachedCharacterSkillMap: () => skills }, itemStore: { ITEM_FLAGS: {} },
    simulationInventoryProjection: {}, liveFittingState: { getFittedModuleItems: () => [item, otherItem], getLoadedChargeByFlag: () => charge,
      getEffectTypeRecord: () => effect, getTypeEffectRecords: () => [effect], isChargeCompatibleWithModule: () => true }, itemTypeRegistry: { resolveItemByTypeID: () => ({ effects: [{ effectID: 81 }] }) },
    typeListAuthority: { matchesTypeList: () => true }, miningInventory: {}, miningMath: {},
    miningDogma: { isMiningEffectRecord: () => true, buildMiningModuleSnapshot: inputs => {
      seen.push(inputs); return { family: "ore", chargeTypeID: 701, crystalTargetTypeListID: 1, maxRangeMeters: 23000.25 }; } },
    commandBurstRuntime: { collectModifierEntriesForItem: (ship, target, now) => { assert.equal(ship, entity); assert.equal(now, 200); return [{ target: target.itemID }]; } },
    wormholeEnvironmentRuntime: { getLocationModifierSourcesForSystem: system => { assert.equal(system, 801); return [{ modifier: "system" }]; } },
    miningRuntimeState: { ensureSceneMiningState: () => {}, getMineableState: () => ({ remainingQuantity: 10, yieldKind: "ore", yieldTypeID: 702 }) },
    npcEquipment: { isNativeNpcEntity: () => false }, serviceHelpers: {} };
  const runtime = load("server/src/services/mining/miningRuntime.js", dependencies);
  const scene = { getEntityByID: () => ({}), getCurrentSimTimeMs: () => 200, getCommandTimeEntitySurfaceDistance: () => 23000.25,
    getTargetsForEntity: () => [901] };
  const reach = runtime.readEntityMiningReach(entity, item, 200);
  const activation = runtime.resolveMiningActivation(scene, entity, item, effect, { targetID: 901 });
  assert.equal(activation.success, true); assert.equal(reach.maxRangeMeters, activation.data.runtimeAttrs.miningSnapshot.maxRangeMeters);
  assert.deepEqual(seen[0], seen[1]); assert.equal(seen[0].chargeItem, charge); assert.equal(seen[0].skillMap, skills);
  assert.equal(seen[0].activeModuleContexts.length, 1); assert.equal(seen[0].additionalChargeModifierEntries[0].target, 601);
  for (const foreign of [{ ...item, ownerID: 502 }, { ...item, locationID: 102 }, { ...item, typeID: 402 }, { ...item, itemID: 999 }]) {
    assert.equal(runtime.readEntityMiningReach(entity, foreign, 200), null);
  }
  assert.equal(runtime.readEntityMiningReach({ ...entity, itemID: 102 }, item, 200), null);
  assert.equal(seen.length, 2, "failed scope must not calculate");
});

test("actual tractor reader retains activation rounding, grace boundary and source settlement constant", () => {
  const args = { shipItem: { itemID: 101 }, moduleItem: { itemID: 301 }, chargeItem: { itemID: 601 }, skillMap: new Map(), fittedItems: [], activeModuleContexts: [] };
  const runtime = load("server/src/space/modules/tractorBeamRuntime.js", { vector: { cloneVector: v => ({ ...v }) }, numbers,
    liveFittingState: { getAttributeIDByNames: () => 0 }, liveModuleAttributes: { buildLiveModuleAttributeMap: (...actual) => {
      assert.deepEqual(actual, [args.shipItem, args.moduleItem, args.chargeItem, args.skillMap, args.fittedItems, args.activeModuleContexts]);
      return { 54: 72000.12349, 73: 5000, 1045: 1000 }; } }, tractorBeam: {}, deliveryPolicy: {}, interactionScope: { canEntitiesInteractLocally: () => true } });
  const reach = runtime.readTractorBeamModuleSnapshot(args);
  assert.equal(reach.maxRangeMeters, 72000.123); assert.equal(runtime.TRACTOR_FOLLOW_RANGE_METERS, 500);
  for (const [distance, success] of [[72000.123, true], [72001.123, true], [72001.124, false]]) {
    const result = runtime.resolveTractorBeamActivation({ ...args, entity: {}, scene: { getEntityByID: () => ({ kind: "container" }) },
      effectRecord: { name: "tractorBeamCan" }, options: { targetID: 901 }, callbacks: { hasLootRightForTarget: () => true, getEntitySurfaceDistance: () => distance } });
    assert.equal(result.success, success);
    if (success) assert.equal(result.data.effectStatePatch.tractorBeamRangeMeters, reach.maxRangeMeters);
  }
});
