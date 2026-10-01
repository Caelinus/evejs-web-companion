"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { projectMiningBurstServices, projectCompressionService } = require("./miningSupportProjection");
const { projectCoreMobilityFuel } = require("./miningSupportProjection");

test("gateway projection copies computed mining burst facts without changing runtime state", () => {
  const state = { typeID: 42528, effectID: 6736, effectName: "moduleBonusWarfareLinkMining", chargeTypeID: 42831,
    commandBurstEffect: true, commandBurstFamily: "mining", commandBurstRangeMeters: 63742.125,
    durationMs: 61000, commandBurstBuffDurationMs: 118500, commandBurstDbuffValues: new Map([[23, -17.5]]) };
  const entity = { activeModuleEffects: new Map([[9988400037240, state], [12, { ...state, commandBurstFamily: "shield" }],
    [13, { ...state, deactivatedAtMs: 20 }]]) };
  const before = structuredClone(entity);
  const result = projectMiningBurstServices(entity);
  assert.deepEqual(result.activeModuleIDs, [9988400037240, 12]);
  assert.deepEqual(result.bursts, [{ moduleID: 9988400037240, typeID: 42528, effectID: 6736,
    effectName: "moduleBonusWarfareLinkMining", chargeTypeID: 42831, chargeItemID: null,
    rangeMeters: 63742.125, cycleDurationMs: 61000, buffDurationMs: 118500, buffs: [{ collectionID: 23, value: -17.5 }] }]);
  assert.deepEqual(entity, before);
  assert.equal(projectMiningBurstServices({}), null);
  assert.deepEqual(projectMiningBurstServices({ activeModuleEffects: new Map() }), { activeModuleIDs: [], bursts: [] });
});

test("gateway compression projection preserves distinct typelist ranges and module identities", () => {
  const entity = { compressionFacilityTypelists: [[23, 60000], [24, 80000]], activeModuleEffects: new Map([
    [9988400037250, { typeID: 62586, effectName: "industrialItemCompression" }],
    [9988400037251, { typeID: 62587, effectName: "industrialItemCompression", deactivatedAtMs: 40 }],
  ]) };
  const before = structuredClone(entity);
  assert.deepEqual(projectCompressionService(entity), { state: "active",
    typeListRanges: [{ typeListID: 23, rangeMeters: 60000 }, { typeListID: 24, rangeMeters: 80000 }],
    compressors: [{ moduleID: 9988400037250, typeID: 62586 }] });
  assert.deepEqual(entity, before);
  assert.equal(projectCompressionService({ compressionFacilityTypelists: null }).state, "inactive");
  assert.equal(projectCompressionService({}).state, "unknown");
  const fresh = { activeModuleEffects: new Map() };
  assert.deepEqual(projectCompressionService(fresh), { state: "inactive", typeListRanges: [], compressors: [] });
  assert.equal(Object.hasOwn(fresh, "compressionFacilityTypelists"), false, "read never initialises runtime cache");
  assert.equal(projectCompressionService({ activeModuleEffects: new Map([[99,
    { effectName: "industrialItemCompression" }]]) }).state, "unknown", "active compressor requires actual typelist facts");
  assert.equal(projectCompressionService({ compressionFacilityTypelists: [[23, NaN]] }).state, "unknown");
});

test("packaged projection artifacts match the manifest hashes", () => {
  const manifest = JSON.parse(readFileSync(`${__dirname}/mining-support-0.12.9-manifest.json`, "utf8"));
  for (const artifact of [...manifest.installFiles, ...manifest.applyInOrder]) {
    const actual = createHash("sha256").update(readFileSync(`${__dirname}/${artifact.file}`)).digest("hex").toUpperCase();
    assert.equal(actual, artifact.sha256, artifact.file);
  }
});

function coreAuthority(overrides = {}) {
  return {
    readFittedModules: () => [{ itemID: 201, typeID: 62590 }],
    readFuelTypeID: () => 16272,
    readFuelInventory: () => ({ availableQuantity: 120, eligibleFlagIDs: [133, 5],
      stacks: [{ itemID: 301, locationID: 401, flagID: 133, quantity: 100 }, { itemID: 302, locationID: 401, flagID: 5, quantity: 20 }] }),
    isShipMovementLockedByRuntime: () => false,
    isShipWarpDisabledByRuntime: () => true,
    moduleTypeDisallowsWarp: () => true,
    ...overrides,
  };
}
const coreEffect = { typeID: 62590, effectID: 4575, effectName: "industrialCoreEffect2", startedAtMs: 100,
  durationMs: 200, nextCycleAtMs: 300, deactivationRequestedAtMs: 200, deactivateAtMs: 300,
  fuelTypeID: 16272, fuelPerActivation: 80, stopReason: "manual" };

test("Core projection preserves pending stop and continuing-cycle fuel value without ending overdue effects", () => {
  const entity = { activeModuleEffects: new Map([[201, coreEffect]]) };
  const before = structuredClone(entity);
  const projection = projectCoreMobilityFuel(entity, 999, coreAuthority());
  const module = projection.modules[0];
  assert.equal(module.moduleID, 201);
  assert.equal(module.active, true);
  assert.equal(module.effect.deactivationRequestedAtMs, 200);
  assert.equal(module.effect.deactivateAtMs, 300);
  assert.equal(module.effect.nextCycleAtMs, 300);
  assert.equal(module.fuel.typeID, 16272);
  assert.equal(module.fuel.effectivePerActivation, 80);
  assert.equal(module.fuel.availableQuantity, 120);
  assert.deepEqual(module.fuel.eligibleFlagIDs, [133, 5]);
  assert.equal(module.fuel.stacks[0].locationID, 401);
  assert.equal(projection.mobility.movement.verdict, "unrestricted", "predicate answer, not Core-active inference");
  assert.equal(projection.mobility.warp.verdict, "restricted");
  assert.equal(projection.mobility.warp.reasonCode, "SHIP_IMMOBILE");
  assert.equal(projection.mobility.warp.sources[0].moduleID, 201);
  assert.deepEqual(entity, before, "projection never finalizes or consumes anything");
});

test("effect removal proves inactive; base fuel quantity is never presented as effective", () => {
  const projection = projectCoreMobilityFuel({ activeModuleEffects: new Map() }, 999, coreAuthority());
  assert.equal(projection.modules[0].active, false);
  assert.equal(projection.modules[0].effect, null);
  assert.equal(projection.modules[0].fuel.typeID, 16272);
  assert.equal(projection.modules[0].fuel.effectivePerActivation, null);
  assert.equal(projection.modules[0].fuel.activationFailureCode, null);
});

test("failed inventory/restriction reads remain unknown and zero fuel stays zero without inventing NO_FUEL", () => {
  const entity = { activeModuleEffects: new Map([[201, { ...coreEffect, stopReason: "fuel" }]]) };
  const projection = projectCoreMobilityFuel(entity, 200, coreAuthority({
    readFuelInventory: () => ({ availableQuantity: 0, eligibleFlagIDs: [133, 5], stacks: [] }),
    isShipMovementLockedByRuntime: () => { throw new Error("unavailable"); },
  }));
  assert.equal(projection.modules[0].fuel.availableQuantity, 0);
  assert.equal(projection.modules[0].fuel.activationFailureCode, null);
  assert.equal(projection.modules[0].effect.stopReason, "fuel");
  assert.equal(projection.mobility.movement.verdict, "unknown");
  const unavailable = projectCoreMobilityFuel(entity, 200, coreAuthority({ readFuelInventory: () => { throw new Error("unavailable"); } }));
  assert.equal(unavailable.modules[0].fuel.availableQuantity, null);
  const noEffects = projectCoreMobilityFuel({}, 200, coreAuthority());
  assert.equal(noEffects.activeModuleIDs, null);
  assert.equal(noEffects.modules[0].active, null);
  assert.equal(noEffects.mobility.warp.verdict, "unknown");
});

test("restriction authority receives zero simulation time and missing time cannot permit relocation", () => {
  const entity = { activeModuleEffects: new Map() };
  const authority = coreAuthority({
    isShipMovementLockedByRuntime: (ship, nowMs) => { assert.equal(ship, entity); assert.equal(nowMs, 0); return true; },
    isShipWarpDisabledByRuntime: (ship, nowMs) => { assert.equal(ship, entity); assert.equal(nowMs, 0); return false; },
  });
  const known = projectCoreMobilityFuel(entity, 0, authority);
  assert.equal(known.mobility.movement.verdict, "restricted");
  assert.equal(known.mobility.warp.verdict, "unrestricted");
  const unknown = projectCoreMobilityFuel(entity, null, authority);
  assert.equal(unknown.mobility.movement.verdict, "unknown");
  assert.equal(unknown.mobility.warp.verdict, "unknown");
});

test("inactive Core startup quote is item-scoped, uses resolved cost and distinguishes sufficient, zero and unknown", () => {
  const entity = { itemID: 401, activeModuleEffects: new Map() };
  const authority = coreAuthority({ readFittedModules: () => [{ itemID: 201, typeID: 62590, locationID: 401 }],
    isIndustrialCore: () => true,
    readStartupRuntimeAttributes: (ship, item, now) => {
      assert.equal(ship, entity); assert.equal(item.itemID, 201); assert.equal(now, 0);
      return { fuelTypeID: 16272, fuelPerActivation: 80 };
    },
  });
  for (const [availableQuantity, sufficient] of [[80, true], [79, false], [0, false], [null, null]]) {
    const result = projectCoreMobilityFuel(entity, 0, { ...authority,
      readFuelInventory: () => ({ availableQuantity, stacks: [] }) }).modules[0];
    assert.equal(result.active, false);
    assert.equal(result.fuel.effectivePerActivation, null, "B2 inactive consumption stays unchanged");
    assert.equal(result.fuel.startupQuote.moduleID, 201);
    assert.equal(result.fuel.startupQuote.requiredQuantity, 80);
    assert.equal(result.fuel.startupQuote.availableQuantity, availableQuantity);
    assert.equal(result.fuel.startupQuote.sufficient, sufficient);
    assert.equal(result.fuel.startupQuote.availability, sufficient === null ? "unknown" : "available");
  }
  const zeroCost = projectCoreMobilityFuel(entity, 0, { ...authority,
    readStartupRuntimeAttributes: () => ({ fuelTypeID: 16272, fuelPerActivation: 0 }),
    readFuelInventory: () => ({ availableQuantity: 0 }),
  }).modules[0].fuel.startupQuote;
  assert.equal(zeroCost.requiredQuantity, 0); assert.equal(zeroCost.sufficient, true);
  const unreadable = projectCoreMobilityFuel(entity, 0, { ...authority,
    readStartupRuntimeAttributes: () => { throw new Error("unreadable"); },
  }).modules[0].fuel.startupQuote;
  assert.equal(unreadable.requiredQuantity, null); assert.equal(unreadable.sufficient, null);
  assert.equal(unreadable.reason, "fuel-calculation-unavailable");
  const foreign = projectCoreMobilityFuel(entity, 0, { ...authority,
    readFittedModules: () => [{ itemID: 201, typeID: 62590, locationID: 999 }],
  }).modules[0].fuel.startupQuote;
  assert.equal(foreign.reason, "module-scope-mismatch"); assert.equal(foreign.sufficient, null);
  const active = projectCoreMobilityFuel({ ...entity, activeModuleEffects: new Map([[201, coreEffect]]) }, 0,
    { ...authority, readStartupRuntimeAttributes: () => assert.fail("never quote an active Core") }).modules[0].fuel;
  assert.equal(active.effectivePerActivation, 80);
  assert.equal(active.startupQuote.availability, "not-applicable");
  const missingState = projectCoreMobilityFuel({ itemID: 401 }, 0, authority).modules[0].fuel.startupQuote;
  assert.equal(missingState.reason, "module-state-unknown");
  assert.equal(projectCoreMobilityFuel(entity, null, authority).modules[0].fuel.startupQuote.reason, "simulation-time-unavailable");
});
