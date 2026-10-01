import test from "node:test";
import assert from "node:assert/strict";
import { deriveMiningSupportCapabilities } from "./miningSupportCapabilities.ts";
import { deriveMiningSupportServices } from "./miningSupportServices.ts";
import { decodeSpaceSnapshot } from "../bridge/space.ts";
import type { JsonValue } from "../bridge/wire.ts";
import { createClientStore } from "../store/clientStore.ts";
import { createAppFlow } from "../app/flow.ts";
import { nameKey } from "../store/names.ts";

const shipID = 9988400023309;
const coreID = 9988400037240;
const slots = [{ family: "high" as const, index: 0, module: { itemID: coreID, typeID: 62590, groupID: 515, online: true, charge: null } }];
const capabilities = deriveMiningSupportCapabilities({ scope: { shipID, fittingSignature: "core-fit" }, slots, dogma: null, bays: null,
  groupOf: () => "Siege Module", typeNameOf: () => "Medium Industrial Core I" });
const fuel = { typeID: { type: "long", value: "16272" }, effectivePerActivation: 80, availableQuantity: 120,
  eligibleFlagIDs: [133, 5], stacks: [{ itemID: 301, locationID: shipID, flagID: 133, quantity: 120 }], activationFailureCode: null };
const effect = { moduleID: coreID, effectID: 4575, effectName: "industrialCoreEffect2", startedAtMs: 100, cycleDurationMs: 200,
  nextCycleAtMs: 300, deactivationRequestedAtMs: 0, deactivateAtMs: 0, stopReason: null };
function observation(module: JsonValue = { moduleID: coreID, typeID: 62590, active: true, effect, fuel }, overrides: Record<string, JsonValue> = {}) {
  return { activeModuleIDs: [coreID], modules: [module], mobility: {
    movement: { verdict: "restricted", reasonCode: null, sources: [{ moduleID: coreID, effectID: 4575, effectName: "industrialCoreEffect2" }] },
    warp: { verdict: "restricted", reasonCode: "SHIP_IMMOBILE", sources: [] },
  }, ...overrides };
}
function snapshot(coreMobilityFuel: JsonValue | undefined) {
  return decodeSpaceSnapshot({ inSpace: true, shipID, sampledAtMs: 999, entities: [],
    ship: { itemID: shipID, ...(coreMobilityFuel === undefined ? {} : { coreMobilityFuel }) } });
}
function derive(raw: JsonValue | undefined) {
  return deriveMiningSupportServices(capabilities, snapshot(raw), typeID => typeID === 16272 ? "Heavy Water" : null);
}

test("Core item identity, active state, observed cycle timing and exact effective fuel survive transport", () => {
  const result = derive(observation());
  const core = result.cores[0]!;
  assert.equal(core.capability.itemID, coreID);
  assert.notEqual(core.capability.itemID, core.capability.typeID);
  assert.equal(core.state, "active");
  assert.equal(core.effect?.startedAtMs, 100);
  assert.equal(core.effect?.nextCycleAtMs, 300);
  assert.equal(core.effect?.cycleDurationMs, 200);
  assert.equal(core.fuel.typeID, 16272);
  assert.equal(core.fuel.typeName, "Heavy Water");
  assert.equal(core.fuel.effectivePerActivation, 80);
  assert.equal(core.fuel.availableQuantity, 120);
  assert.deepEqual(core.fuel.eligibleFlagIDs, [133, 5]);
  assert.equal(core.fuel.stacks?.[0]?.locationID, shipID);
  assert.equal(core.fuelFailure, "unknown");
});

test("deferred stop stays pending even beyond its timestamp until authority actually removes the effect", () => {
  const pending = derive(observation({ moduleID: coreID, typeID: 62590, active: true, fuel,
    effect: { ...effect, deactivationRequestedAtMs: 200, deactivateAtMs: 300, stopReason: "manual" } })).cores[0]!;
  assert.equal(pending.state, "deactivation-pending");
  assert.equal(pending.effect?.deactivateAtMs, 300, "999 observation time cannot override active authority");
  const finalized = derive(observation({ moduleID: coreID, typeID: 62590, active: false, effect: null,
    fuel: { ...fuel, effectivePerActivation: null } }, { activeModuleIDs: [] })).cores[0]!;
  assert.equal(finalized.state, "inactive");
  assert.equal(finalized.effect, null);
  assert.equal(finalized.fuel.effectivePerActivation, null);
  assert.equal(finalized.fuelFailure, "unknown", "finalized effects have no retained reason in current runtime");
});

test("mobility is independent authority, distinguishes movement from warp and is unknown when unreadable", () => {
  const independent = derive(observation(undefined, { mobility: {
    movement: { verdict: "unrestricted", reasonCode: null, sources: [] },
    warp: { verdict: "restricted", reasonCode: "SHIP_IMMOBILE", sources: [{ moduleID: coreID, effectID: 4575 }] },
  } }));
  assert.equal(independent.cores[0]?.state, "active");
  assert.equal(independent.mobility.movement.verdict, "unrestricted");
  assert.equal(independent.mobility.warp.verdict, "restricted");
  assert.equal(independent.mobility.warp.sources?.[0]?.moduleID, coreID);
  assert.equal(independent.mobility.scope, "runtime-action-restrictions");
  const missing = derive(observation(undefined, { mobility: {} }));
  assert.equal(missing.mobility.movement.verdict, "unknown");
  assert.equal(missing.mobility.warp.verdict, "unknown");
});

test("zero fuel, unreadable inventory and missing effective consumption remain distinct without inferred failures", () => {
  const empty = derive(observation({ moduleID: coreID, typeID: 62590, active: true, effect, fuel: { ...fuel, availableQuantity: 0 } })).cores[0]!;
  assert.equal(empty.fuel.availableQuantity, 0);
  assert.equal(empty.fuelFailure, "unknown");
  const unknown = derive(observation({ moduleID: coreID, typeID: 62590, active: true, effect,
    fuel: { typeID: 16272, availableQuantity: null, effectivePerActivation: null } })).cores[0]!;
  assert.equal(unknown.fuel.availableQuantity, null);
  assert.equal(unknown.fuel.effectivePerActivation, null);
  assert.equal(unknown.fuel.eligibleFlagIDs, null);
  assert.equal(unknown.fuelFailure, "unknown");
});

test("supplied NO_FUEL and fuel stop codes survive; absent reason never becomes not-fuel", () => {
  const failure = derive(observation({ moduleID: coreID, typeID: 62590, active: false, effect: null,
    fuel: { ...fuel, activationFailureCode: "NO_FUEL" } }, { activeModuleIDs: [] })).cores[0]!;
  assert.equal(failure.fuelFailure, "activation-no-fuel");
  assert.equal(failure.fuel.activationFailureCode, "NO_FUEL");
  const stopped = derive(observation({ moduleID: coreID, typeID: 62590, active: true,
    effect: { ...effect, stopReason: "fuel" }, fuel })).cores[0]!;
  assert.equal(stopped.fuelFailure, "cycle-fuel");
  assert.equal(stopped.effect?.stopReason, "fuel");
  assert.equal(derive(observation()).cores[0]?.fuelFailure, "unknown");
});

test("fitted alone, missing/malformed observations, contradictory state and foreign item type never prove active", () => {
  for (const raw of [undefined, null, {}, observation(undefined, { activeModuleIDs: null }),
    observation({ moduleID: coreID, typeID: 999, active: true, effect, fuel }),
    observation({ moduleID: coreID, typeID: 62590, active: true, effect, fuel }, { activeModuleIDs: [] })]) {
    const result = derive(raw);
    assert.equal(result.capabilities.industrialCores.presence, "present");
    assert.equal(result.cores[0]?.state, "unknown");
  }
  assert.equal(derive(undefined).mobility.movement.verdict, "unknown");
  const emptyFit = deriveMiningSupportCapabilities({ ...{ scope: capabilities.scope, slots: [], dogma: null, bays: null }, groupOf: () => null, typeNameOf: () => null });
  assert.deepEqual(deriveMiningSupportServices(emptyFit, snapshot(observation())).cores, []);
});

test("flow uses existing loaded inputs and cached fuel names; errors and ship changes drop service authority", () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: (async () => assert.fail("Core snapshot must perform no IO")) as typeof fetch });
  store.apply({ type: "fitting/loaded", activeShipID: shipID, slots, resources: store.fitting.get().resources,
    stats: store.fitting.get().stats, slotsError: null, resourcesError: null });
  store.apply({ type: "names/resolved", entries: { [nameKey("type", 62590)]: "Medium Industrial Core I", [nameKey("type", 16272)]: "Heavy Water" } });
  store.apply({ type: "space/snapshot", snapshot: snapshot(observation())!, gateLinks: [] });
  assert.equal(flow.readMiningSupportServices().cores[0]?.fuel.typeName, "Heavy Water");
  assert.equal(flow.readMiningSupportServices().cores[0]?.state, "active");
  store.apply({ type: "space/error", message: "unavailable" });
  assert.equal(flow.readMiningSupportServices().cores[0]?.state, "unknown");
  assert.equal(flow.readMiningSupportServices().mobility.warp.verdict, "unknown");
  store.apply({ type: "fitting/loaded", activeShipID: 42, slots, resources: store.fitting.get().resources,
    stats: store.fitting.get().stats, slotsError: null, resourcesError: null });
  store.apply({ type: "space/snapshot", snapshot: snapshot(observation())!, gateLinks: [] });
  assert.equal(flow.readMiningSupportServices().cores[0]?.state, "unknown");
});

test("inactive startup quote preserves item scope, server verdict, zero and cached name without WC fuel arithmetic", () => {
  function quoted(overrides: Record<string, JsonValue> = {}) {
    return derive(observation({ moduleID: coreID, typeID: 62590, active: false, effect: null,
      fuel: { ...fuel, effectivePerActivation: null, startupQuote: { moduleID: coreID, availability: "available", reason: null,
        fuelTypeID: 16272, requiredQuantity: 80, availableQuantity: 80, sufficient: true, ...overrides } } },
    { activeModuleIDs: [] })).cores[0]!;
  }
  const inactive = quoted();
  assert.equal(inactive.state, "inactive");
  assert.equal(inactive.fuel.effectivePerActivation, null);
  assert.deepEqual(inactive.fuel.startupQuote, { moduleID: coreID, availability: "available", reason: null,
    fuelTypeID: 16272, fuelName: "Heavy Water", requiredQuantity: 80, availableQuantity: 80, sufficient: true });
  const empty = quoted({ availableQuantity: 0, sufficient: false });
  assert.equal(empty.fuel.startupQuote.availableQuantity, 0);
  assert.equal(empty.fuel.startupQuote.sufficient, false);
  const noCost = quoted({ requiredQuantity: 0, availableQuantity: 0 });
  assert.equal(noCost.fuel.startupQuote.requiredQuantity, 0);
  assert.equal(noCost.fuel.startupQuote.sufficient, true);
  const unknown = quoted({ availability: "unknown", reason: "fuel-inventory-unavailable", availableQuantity: null, sufficient: null });
  assert.equal(unknown.fuel.startupQuote.availability, "unknown");
  assert.equal(unknown.fuel.startupQuote.sufficient, null);
  assert.equal(unknown.fuel.startupQuote.requiredQuantity, 80);
  const malformed: Record<string, JsonValue>[] = [{ moduleID: 42 }, { availableQuantity: null }, { requiredQuantity: null }, { sufficient: "true" }];
  for (const overrides of malformed) {
    assert.equal(quoted(overrides).fuel.startupQuote.sufficient, null, "malformed or foreign quote cannot prove sufficiency");
    assert.equal(quoted(overrides).fuel.startupQuote.availability, "unknown");
  }
  assert.equal(derive(undefined).cores[0]?.fuel.startupQuote.availability, "unknown");
  assert.equal(derive(observation()).cores[0]?.fuel.effectivePerActivation, 80, "active B2 consumption unchanged");
});
