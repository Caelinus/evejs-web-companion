"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute only source functions in an isolated VM. Inventory, static metadata,
// character/session and modifier inputs are fixtures; no runtime entrypoint,
// database, listener or real inventory writer is loaded.
const legacyReference = path.resolve(__dirname, "../../../EveJS-0.12.9");
const reference = process.env.EVEJS_CLEAN_REFERENCE || (fs.existsSync(legacyReference) ? legacyReference :
  require("../scripts/prepare-runtime-test-reference").prepareRuntimeTestReference().reference);
function loadSource(relative, dependencies = {}) {
  const filename = path.join(reference, relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), { module, exports: module.exports,
    __dirname: path.dirname(filename), Map, Set, Buffer,
    require(id) {
      if (id === "path") return path;
      const name = path.basename(id).replace(/\.js$/, "");
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency: ${id}`);
    },
  }, { filename });
  return module.exports;
}

function fixture({ available = 100, rawCost = 500, percent = -80, unreadable = false } = {}) {
  const numbers = loadSource("server/src/common/numbers.js");
  const rawFitting = loadSource("server/src/services/fitting/liveFittingState.js", {
    numbers, referenceData: { TABLE: {}, readStaticTable: () => ({}) },
    floatPrecision: loadSource("server/src/services/_shared/floatPrecision.js"),
    itemStore: { ITEM_FLAGS: {} }, simulationInventoryProjection: {}, skillState: {}, itemTypeRegistry: {},
    miningConstants: { MINING_HOLD_DEFINITIONS: [] }, fuelBayInventory: {}, fleetHangarInventory: {}, activeImplantModifiers: {},
    chargeCompatibilityPolicy: {}, hullBonusSkillAuthority: {},
  });
  const item = { itemID: 201, typeID: 62590, groupID: 515, locationID: 401, ownerID: 501,
    flagID: 27, dogma: { 713: 16272, 714: rawCost, 73: 60000 } };
  const shipItem = { itemID: 401, typeID: 42244 };
  const ship = { itemID: 401, kind: "ship", characterID: 501, activeModuleEffects: new Map() };
  const rows = [
    { itemID: 301, ownerID: 501, locationID: 401, typeID: 16272, flagID: 133, quantity: Math.min(60, available) },
    { itemID: 302, ownerID: 501, locationID: 401, typeID: 16272, flagID: 5, quantity: Math.max(0, available - 60) },
    { itemID: 303, ownerID: 501, locationID: 401, typeID: 16272, flagID: 155, quantity: 10000 },
    { itemID: 304, ownerID: 501, locationID: 401, typeID: 42, flagID: 133, quantity: 10000 },
  ];
  let writes = 0;
  const bays = loadSource("server/src/services/inventory/fuelBayInventory.js", { numbers,
    itemTypeRegistry: { resolveItemByTypeID: typeID => ({ typeID, groupID: typeID === 16272 ? 423 : 0 }) } });
  const storage = loadSource("server/src/space/modules/sharedFuelRuntime.js", {
    npcEquipment: { isNativeNpcEntity: () => false }, nativeNpcStore: {}, fuelBayInventory: bays,
    simulationInventoryProjection: { listContainerItems: (ownerID, locationID, flagID) => {
      if (unreadable) throw new Error("inventory unavailable");
      return rows.filter(row => row.ownerID === ownerID && row.locationID === locationID && row.flagID === flagID);
    } },
    itemStore: { consumeInventoryItemStacksAtomic: requests => {
      writes++; assert.equal(requests.reduce((sum, row) => sum + row.quantity, 0), 100);
      return { success: true, changes: [], consumedQuantity: 100 };
    } },
  });
  const genericFuel = loadSource("server/src/space/modules/genericModuleFuelRuntime.js", { sharedFuelRuntime: storage });
  const dogma = {
    getShipEntityInventoryCharacterID: () => 501, getEntityRuntimeShipItem: () => shipItem,
    getEntityRuntimeFittedItems: () => [item], getEntityRuntimeSkillMap: () => new Map(),
    getEntityRuntimeLoadedCharge: () => null,
    getEntityRuntimeActiveModuleContexts: (entity, options) => {
      assert.equal(entity, ship); assert.equal(options.excludeModuleID, 201); assert.equal(options.includeOverloadModuleID, 201);
      return [];
    },
  };
  const fuel = loadSource("server/src/space/runtime/shipModuleFuel.js", {
    numbers, genericModuleFuelRuntime: genericFuel, entityDogmaView: dogma,
    characterStateBridge: { syncInventoryChangesToSession: () => assert.fail("quote cannot sync inventory") },
  });
  const effects = { resolveDefaultActivationEffect: () => ({ name: "industrialCoreEffect2", durationAttributeID: 73 }) };
  const fitting = { ...rawFitting, getAttributeIDByNames: () => 0,
    buildEffectiveItemAttributeMap: target => ({ ...target.dogma }), isStructureDogmaHost: () => false,
    resolveDogmaSkillMapForHost: (characterID, host, options) => options.skillMap,
    getTypeEffectRecords: () => [], isPassiveModifierSource: () => false,
    indexOverloadEffectRecordsByModuleID: () => new Map(),
  };
  const npc = { buildNpcEffectiveModuleItem: target => target };
  const weapon = { resolveWeaponFamily: () => null, collectShipModifierAttributes: () => ({}),
    buildSkillEffectiveAttributes: () => ({}) };
  const live = loadSource("server/src/space/modules/liveModuleAttributes.js", {
    liveFittingState: fitting, weaponDogma: weapon, npcCapabilityResolver: npc,
  });
  const runtime = loadSource("server/src/space/runtime/moduleAttributes.js", {
    numbers, liveFittingState: fitting, liveModuleAttributes: live, entityDogmaView: dogma,
    moduleActivationEffectRecord: effects, shipModuleFuel: fuel, weaponDogma: weapon,
    activeShipModifiers: {}, weaponSnapshot: { isSnapshotWeaponFamily: () => false },
    activeImplantModifiers: { getActiveImplantLocationModifierSources: () => [], getActiveImplantShipModifierEntries: () => [] },
  });
  let computed;
  const attributes = { ...runtime, getGenericModuleRuntimeAttributes: (...args) => {
    assert.equal(args[0], 501); assert.equal(args[1], shipItem); assert.equal(args[2], item);
    assert.equal(args[3], null); assert.equal(args[4], null);
    computed = runtime.getGenericModuleRuntimeAttributes(...args); return computed;
  } };
  const projection = loadSource(path.relative(reference, path.join(__dirname, "miningSupportProjection.js")), {
    moduleAttributes: attributes, entityDogmaView: dogma, sharedFuelRuntime: storage, fuelBayInventory: bays,
    shipActionRestrictions: { isShipMovementLockedByRuntime: () => false, isShipWarpDisabledByRuntime: () => false },
    moduleActivationEffectRecord: effects, industrialCore: { isIndustrialCoreEffectName: () => true },
    activeShipModifiers: { collectEntityWormholeLocationModifierSources: () => [] },
    moduleAttributeDiff: loadSource("server/src/space/modules/moduleAttributeDiff.js"), npcCapabilityResolver: npc,
    commandBurstRuntime: { collectModifierEntriesForItem: (entity, target, nowMs) => {
      assert.equal(entity, ship); assert.equal(target, item); assert.equal(nowMs, 0);
      return [{ modifiedAttributeID: 714, operation: 6, value: percent, stackingPenalized: false }];
    } },
  });
  return { ship, item, rows, fuel, computed: () => computed, writes: () => writes,
    quote: () => projection.readCoreMobilityFuel(ship, 0).modules[0].fuel.startupQuote };
}

test("real runtime modifiers, final rounding and eligible stores produce an inactive item quote without writes", () => {
  const f = fixture();
  const before = structuredClone({ ship: f.ship, item: f.item, rows: f.rows });
  const quote = f.quote();
  assert.equal(quote.moduleID, 201); assert.equal(quote.fuelTypeID, 16272);
  assert.equal(quote.requiredQuantity, 100, "500 with -80% uses runtime rounding of its floating result");
  assert.equal(f.computed().fuelPerActivation, quote.requiredQuantity);
  assert.equal(quote.availableQuantity, 100, "fuel bay + cargo, excluding other flags/types");
  assert.equal(quote.sufficient, true); assert.equal(quote.availability, "available");
  assert.equal(f.writes(), 0); assert.deepEqual({ ship: f.ship, item: f.item, rows: f.rows }, before);
  const fractional = fixture({ rawCost: 100.5, percent: 0, available: 101 });
  assert.equal(fractional.quote().requiredQuantity, 101, "uses runtime whole-unit rule, not truncation");
});

test("actual consumer and quote agree on final cost and NO_FUEL at the exact boundary using runtime source", () => {
  for (const available of [100, 99, 0]) {
    const f = fixture({ available }); const quote = f.quote();
    assert.equal(f.writes(), 0, "quote consumes nothing");
    const result = f.fuel.consumeShipModuleFuelForSession(null, f.ship,
      f.computed().fuelTypeID, f.computed().fuelPerActivation, { deferSync: true });
    assert.equal(quote.sufficient, available === 100); assert.equal(result.success, quote.sufficient);
    if (available < 100) { assert.equal(result.errorMsg, "NO_FUEL"); assert.equal(f.writes(), 0); }
  }
  // Actual activation uses this public resolver, and forwards its final amount
  // into the consumer tested above. No activation method is executed here.
  const scene = fs.readFileSync(path.join(reference, "server/src/space/runtime/scene/modules.js"), "utf8");
  assert.match(scene, /: getGenericModuleRuntimeAttributes\(/);
  assert.match(scene, /consumeShipModuleFuelForSession\([\s\S]*?: finalRuntimeAttrs\.fuelPerActivation/);
});

test("unavailable inventory retains resolved cost and unknown sufficiency", () => {
  const f = fixture({ unreadable: true }); const quote = f.quote();
  assert.equal(quote.requiredQuantity, 100); assert.equal(quote.availableQuantity, null);
  assert.equal(quote.sufficient, null); assert.equal(quote.availability, "unknown");
  assert.equal(quote.reason, "fuel-inventory-unavailable"); assert.equal(f.writes(), 0);
});
