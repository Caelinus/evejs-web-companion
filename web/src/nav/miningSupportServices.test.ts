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
const moduleID = 9988400037240;
const slots = [{ family: "high" as const, index: 0, module: { itemID: moduleID, typeID: 42528, groupID: 1770, online: true, charge: null } }];
const capabilities = deriveMiningSupportCapabilities({ scope: { shipID, fittingSignature: "fit-a" }, slots, dogma: null, bays: null,
  groupOf: () => "Command Burst", typeNameOf: () => "Mining Foreman Burst I" });
const burst = { moduleID: { type: "long", value: String(moduleID) }, typeID: 42528, effectID: 6736,
  effectName: "moduleBonusWarfareLinkMining", chargeTypeID: 42831, chargeItemID: null,
  rangeMeters: 63742.125, cycleDurationMs: 61000, buffDurationMs: 118500, buffs: [{ collectionID: 23, value: -17.5 }] };
const single = { state: "active", typeListRanges: [{ typeListID: 23, rangeMeters: 60000 }],
  compressors: [{ moduleID: 9988400037250, typeID: 62586 }] };
function space(overrides: Record<string, JsonValue> = {}, shipOverrides: Record<string, JsonValue> = {}) {
  return decodeSpaceSnapshot({ inSpace: true, shipID, sampledAtMs: 1234, entities: [],
    ship: { itemID: shipID, characterID: 5000, ownerID: 5000, miningBurstServices: { activeModuleIDs: [moduleID], bursts: [burst] }, compressionService: single, ...shipOverrides }, ...overrides });
}

test("active burst preserves fitted identity, computed range, duration, charge type and buff collection", () => {
  const result = deriveMiningSupportServices(capabilities, space());
  const service = result.bursts[0]!;
  assert.equal(service.state, "active");
  assert.equal(service.capability.itemID, moduleID);
  assert.equal(service.facts?.moduleID, moduleID);
  assert.equal(service.facts?.rangeMeters, 63742.125);
  assert.equal(service.facts?.cycleDurationMs, 61000);
  assert.equal(service.facts?.buffDurationMs, 118500);
  assert.equal(service.facts?.chargeTypeID, 42831);
  assert.equal(service.facts?.chargeItemID, null);
  assert.equal(service.facts?.effectID, 6736);
  assert.deepEqual(service.facts?.buffs, [{ collectionID: 23, value: -17.5 }]);
  assert.equal(result.sampledAtMs, 1234);
});

test("burst deferred stop requires matching own item/type/effect identity", () => {
  const lifecycle = { moduleID, typeID: 42528, active: true, effect: { moduleID, effectID: 6736,
    effectName: "moduleBonusWarfareLinkMining", deactivationRequestedAtMs: 1230, deactivateAtMs: 60000 } };
  const read = (module = lifecycle) => deriveMiningSupportServices(capabilities, space({}, { coreMobilityFuel: { activeModuleIDs: [moduleID], modules: [module] } }));
  assert.equal(read().bursts[0]?.state, "deactivation-pending");
  for (const row of [{ ...lifecycle, typeID: 999 }, { ...lifecycle, moduleID: moduleID + 1 },
    { ...lifecycle, effect: { ...lifecycle.effect, effectID: 999 } }, { ...lifecycle, effect: { ...lifecycle.effect, effectName: "different" } }])
    assert.equal(read(row).bursts[0]?.state, "active");
});

test("fitted burst alone never proves active; inactive and unreadable runtime are distinct", () => {
  assert.equal(capabilities.bursts.presence, "present");
  assert.equal(deriveMiningSupportServices(capabilities, null).bursts[0]?.state, "unknown");
  assert.equal(deriveMiningSupportServices(capabilities, space({}, { miningBurstServices: { activeModuleIDs: [], bursts: [] } })).bursts[0]?.state, "inactive");
  const malformedServices: JsonValue[] = [null, {}, { activeModuleIDs: [moduleID] }, { activeModuleIDs: [null], bursts: [] }];
  for (const malformed of malformedServices) {
    assert.equal(deriveMiningSupportServices(capabilities, space({}, { miningBurstServices: malformed })).bursts[0]?.state, "unknown");
  }
  assert.equal(deriveMiningSupportServices(capabilities, space({}, { miningBurstServices: { activeModuleIDs: [moduleID], bursts: [] } })).bursts[0]?.state, "unknown");
  assert.equal(deriveMiningSupportServices(capabilities, space({}, { miningBurstServices: { activeModuleIDs: [moduleID], bursts: [{ ...burst, typeID: 999 }] } })).bursts[0]?.state, "unknown");
  const missingFields = deriveMiningSupportServices(capabilities, space({}, { miningBurstServices: { activeModuleIDs: [moduleID], bursts: [{ moduleID, typeID: 42528 }] } }));
  assert.equal(missingFields.bursts[0]?.facts?.rangeMeters, null);
  assert.equal(missingFields.bursts[0]?.facts?.buffs, null);
});

test("self compression preserves one exact typelist/range pair without implying usability", () => {
  const facility = deriveMiningSupportServices(capabilities, space()).compression.facilities[0]!;
  assert.equal(facility.origin, "self");
  assert.equal(facility.shipID, shipID);
  assert.equal(facility.pilotID, 5000, "own pilot identity survives even when the overview excludes self");
  assert.equal(facility.ownerID, 5000);
  assert.equal(facility.state, "active");
  assert.deepEqual(facility.typeListRanges, single.typeListRanges);
  assert.deepEqual(facility.compressors, single.compressors);
});

test("external facility identity and multiple different typelist ranges survive the bridge", () => {
  const compressionService = { ...single, typeListRanges: [{ typeListID: 23, rangeMeters: 60000 }, { typeListID: 24, rangeMeters: 80000 }] };
  const snapshot = space({ entities: [{ kind: "ship", itemID: 4001, characterID: 5001, ownerID: 5001, compressionService }] });
  const facility = deriveMiningSupportServices(capabilities, snapshot).compression.facilities.find(facility => facility.shipID === 4001)!;
  assert.equal(facility.pilotID, 5001);
  assert.equal(facility.ownerID, 5001);
  assert.equal(facility.origin, "external");
  assert.deepEqual(facility.typeListRanges, compressionService.typeListRanges);
  assert.notEqual(facility.typeListRanges?.[0]?.rangeMeters, facility.typeListRanges?.[1]?.rangeMeters);
  assert.equal("rangeMeters" in facility, false, "service model has no facility-wide maximum");
  assert.notEqual(facility.typeListRanges, snapshot?.entities[0]?.compressionService?.typeListRanges);
});

test("old maximum-range payloads, missing pairs and malformed pairs remain unknown", () => {
  const old = space({ entities: [{ kind: "ship", itemID: 4001, compressionFacility: { rangeMeters: 80000, typeListIDs: [23, 24] } }] }, { compressionService: null });
  const result = deriveMiningSupportServices(capabilities, old);
  assert.equal(result.compression.observation, "unknown");
  assert.equal(result.compression.facilities[0]?.state, "unknown");
  assert.equal(result.compression.facilities[1]?.state, "unknown");
  assert.equal(result.compression.facilities[1]?.typeListRanges, null);
  for (const malformed of [{ state: "active", typeListRanges: [] }, { state: "active", typeListRanges: [{ typeListID: 23 }] },
    { state: "active", typeListRanges: [{ typeListID: 23, rangeMeters: -1 }] }, { state: "inactive", typeListRanges: single.typeListRanges }]) {
    assert.equal(deriveMiningSupportServices(capabilities, space({}, { compressionService: malformed })).compression.facilities[0]?.state, "unknown");
  }
  const inactive = deriveMiningSupportServices(capabilities, space({}, { compressionService: { state: "inactive", typeListRanges: [], compressors: [] } }));
  assert.equal(inactive.compression.facilities[0]?.state, "inactive");
});

test("ship switch and missing space observation cannot reuse old service facts", () => {
  for (const stale of [space({ shipID: 42 }), space({}, { itemID: 42 }), space({ inSpace: false }), null]) {
    const result = deriveMiningSupportServices(capabilities, stale);
    assert.equal(result.bursts[0]?.state, "unknown");
    assert.equal(result.compression.observation, "unknown");
    assert.deepEqual(result.compression.facilities, []);
  }
});

test("flow reads current loaded observations without IO; an error suppresses retained service state", () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: (async () => assert.fail("service getter must not perform IO")) as typeof fetch });
  store.apply({ type: "fitting/loaded", activeShipID: shipID, slots, resources: store.fitting.get().resources,
    stats: store.fitting.get().stats, slotsError: null, resourcesError: null });
  store.apply({ type: "names/resolved", entries: { [nameKey("type", 42528)]: "Mining Foreman Burst I" } });
  store.apply({ type: "space/snapshot", snapshot: space()!, gateLinks: [] });
  assert.equal(flow.readMiningSupportServices().bursts[0]?.state, "active");
  store.apply({ type: "space/snapshot", snapshot: space({}, { miningBurstServices: { activeModuleIDs: [], bursts: [] } })!, gateLinks: [] });
  assert.equal(flow.readMiningSupportServices().bursts[0]?.state, "inactive");
  store.apply({ type: "space/error", message: "read failed" });
  assert.equal(flow.readMiningSupportServices().bursts[0]?.state, "unknown");
  assert.equal(flow.readMiningSupportServices().compression.observation, "unknown");
});
