import test from "node:test";
import assert from "node:assert/strict";
import { deriveMiningSupportCapabilities, type MiningSupportCapabilityInputs } from "./miningSupportCapabilities.ts";
import { describeFitting } from "./scriptCapabilities.ts";
import type { BoundDogmaAllInfo, DogmaItemInfo } from "../bridge/boundDogma.ts";
import type { FittingSlot, ShipBay, InventoryItemRow } from "../store/types.ts";
import { PROCURER_MODULES, SHIP_ID, STRIP_MINER_ITEM_IDS } from "../app/botFixtures.ts";
import { createAppFlow } from "../app/flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { nameKey } from "../store/names.ts";

// Small equipment fixtures; item IDs deliberately differ from type IDs.
const burst = slot(101, 1770);
const tractor = slot(102, 650);
const core = slot(103, 515);
const compressor = slot(104, 4174);
const families = ["bursts", "mining", "tractors", "industrialCores", "compressors"] as const;

function slot(itemID: number, groupID: number | null): FittingSlot {
  return { family: "high", index: itemID - 100, module: { itemID, typeID: itemID + 1000, groupID, online: true, charge: null } };
}

function input(slots: readonly FittingSlot[] | null, overrides: Partial<MiningSupportCapabilityInputs> = {}): MiningSupportCapabilityInputs {
  return { scope: { shipID: SHIP_ID, fittingSignature: describeFitting(SHIP_ID, slots ?? []) }, slots, dogma: null, bays: null,
    typeNameOf: typeID => typeID === 1101 ? "Mining Foreman Burst I" : typeID === 1103 ? "Medium Industrial Core I" : PROCURER_MODULES.find(module => module.typeID === typeID)?.name ?? null,
    groupOf: typeID => PROCURER_MODULES.find(module => module.typeID === typeID)?.groupName ?? "Other Module", ...overrides };
}

function dogma(slots: readonly FittingSlot[]): BoundDogmaAllInfo {
  const ships: DogmaItemInfo[] = slots.flatMap(slot => slot.module ? [{
    itemID: slot.module.itemID, typeID: slot.module.typeID, ownerID: null, locationID: SHIP_ID,
    flagID: 27, groupID: slot.module.groupID, categoryID: 7, quantity: -1, stacksize: -1,
    customInfo: null, time: null, wallclockTime: null,
    attributes: [{ attributeID: 73, value: 1000 }], activeEffects: { observed: true },
  }] : []);
  return { activeShipID: SHIP_ID, ships, character: null, characterID: null, shipModifiedCharAttributes: null,
    shipState: null, charBrain: null, systemWideEffectsOnShip: null, structureInfo: null, locationInfo: null };
}

function bay(key: string, present: boolean | null = true, items: readonly InventoryItemRow[] | null = []): ShipBay {
  return { key, label: key, present, capacity: present ? { capacity: 100, used: 5 } : null, items, error: null };
}
function drone(itemID: number, typeID: number, quantity: number): InventoryItemRow {
  return { itemID, typeID, quantity, groupID: null, categoryID: 18, flagID: 87, singleton: quantity === -1 };
}

test("burst-only and minimal support fits carry fitted IDs and loaded charges without inventing usability", () => {
  const charged: FittingSlot = { ...burst, module: { ...burst.module!, charge: { itemID: 501, typeID: 502, quantity: 12 } } };
  const snapshot = deriveMiningSupportCapabilities(input([charged]));
  assert.equal(snapshot.bursts.presence, "present");
  assert.equal(snapshot.bursts.modules[0]?.itemID, 101);
  assert.deepEqual(snapshot.bursts.modules[0]?.charge, charged.module?.charge);
  assert.equal(snapshot.bursts.modules[0]?.hasActivationCycle, null);
  assert.equal(snapshot.bursts.modules[0]?.activeEffects, null);
  assert.equal(snapshot.bursts.modules[0]?.maxRangeMeters, null);
  for (const family of families.filter(family => family !== "bursts")) assert.equal(snapshot[family].presence, "absent");
  const miner = PROCURER_MODULES[0]!;
  const minimal = deriveMiningSupportCapabilities(input([charged, { ...slot(miner.itemID, miner.groupID), module: { ...slot(miner.itemID, miner.groupID).module!, typeID: miner.typeID } }]));
  assert.equal(minimal.mining.presence, "present");
  assert.equal(minimal.industrialCores.presence, "absent");
});

test("captured mining fit excludes mining upgrades and rigs and needs no hull name", () => {
  const slots: FittingSlot[] = PROCURER_MODULES.map((module, index) => ({
    family: module.flagID >= 92 ? "rig" : module.flagID >= 27 ? "high" : module.flagID >= 19 ? "mid" : "low", index,
    module: { itemID: module.itemID, typeID: module.typeID, groupID: module.groupID, online: true, charge: null },
  }));
  const snapshot = deriveMiningSupportCapabilities(input(slots));
  assert.deepEqual(snapshot.mining.modules.map(module => module.itemID), STRIP_MINER_ITEM_IDS);
  for (const family of families.filter(family => family !== "mining")) assert.equal(snapshot[family].presence, "absent");
  const otherShip = deriveMiningSupportCapabilities(input(slots, { scope: { shipID: 42, fittingSignature: describeFitting(42, slots) } }));
  assert.deepEqual(otherShip.mining, snapshot.mining, "equipment classifies identically on any hull identity");
});

for (const [name, fitted] of [["tractors", tractor], ["industrialCores", core], ["compressors", compressor]] as const) {
  test(`${name} is detected independently`, () => {
    const snapshot = deriveMiningSupportCapabilities(input([fitted]));
    assert.equal(snapshot[name].presence, "present");
    assert.equal(snapshot[name].modules[0]?.itemID, fitted.module?.itemID);
    for (const family of families.filter(family => family !== name)) assert.equal(snapshot[family].presence, "absent");
  });
}

test("mixed support fit preserves only observed effective dogma, Core dependency and storage", () => {
  const slots = [burst, tractor, core, compressor];
  const info = dogma(slots);
  const attributes = [{ attributeID: 73, value: 2000 }, { attributeID: 54, value: 18000 }, { attributeID: 6, value: 30 },
    { attributeID: 1045, value: 500 }, { attributeID: 713, value: 4246 }, { attributeID: 714, value: 5 },
    { attributeID: 3255, value: 23 }, { attributeID: 3265, value: 1 }];
  const rows = [bay("cargo"), bay("ore"), bay("gas", false), bay("fleet"), bay("drone", true, [drone(601, 701, -1), drone(602, 702, 4)])];
  const snapshot = deriveMiningSupportCapabilities(input(slots, {
    dogma: { ...info, ships: info.ships.map(entry => ({ ...entry, attributes })) }, bays: { shipID: SHIP_ID, rows },
    groupOf: typeID => typeID === 701 ? "Mining Drone" : typeID === 702 ? "Combat Drone" : "Other Module",
  }));
  for (const family of families.filter(family => family !== "mining")) assert.equal(snapshot[family].presence, "present");
  const observed = snapshot.compressors.modules[0]!;
  assert.equal(observed.hasActivationCycle, true);
  assert.deepEqual(observed.effectiveAttributes, attributes);
  assert.deepEqual(observed.activeEffects, { observed: true });
  assert.equal(observed.maxRangeMeters, 18000);
  assert.equal(observed.capacitorNeed, 30);
  assert.equal(snapshot.tractors.modules[0]?.maxTractorVelocity, 500);
  assert.equal(snapshot.industrialCores.modules[0]?.fuelTypeID, 4246);
  assert.equal(snapshot.industrialCores.modules[0]?.fuelPerCycle, 5);
  assert.equal(observed.compressionTypeListID, 23);
  assert.equal(observed.requiresActiveCore, true);
  assert.deepEqual(snapshot.miningDrones.stacks, [{ itemID: 601, typeID: 701, quantity: -1 }]);
  assert.equal(snapshot.miningDrones.presence, "present");
  for (const storage of Object.values(snapshot.storage)) assert.equal(storage.presence, "present");
  attributes[1]!.value = 0;
  assert.equal(observed.maxRangeMeters, 18000);
  assert.equal(observed.effectiveAttributes?.[1]?.value, 18000, "snapshot does not alias input dogma");
  assert.notEqual(snapshot.storage.cargo.bays[0], rows[0], "bay snapshot does not alias input rows");
});

test("empty, unreadable, unresolved and failed observations remain distinct", () => {
  const empty = deriveMiningSupportCapabilities(input([], { bays: { shipID: SHIP_ID,
    rows: [bay("cargo"), bay("ore", false), bay("gas", false), bay("ice", false), bay("asteroid", false), bay("fleet", false), bay("drone", false)] } }));
  for (const family of families) assert.equal(empty[family].presence, "absent");
  assert.equal(empty.storage.mining.presence, "absent");
  assert.equal(empty.storage.fleetHangar.presence, "absent");
  assert.equal(empty.miningDrones.presence, "absent");
  const missing = deriveMiningSupportCapabilities(input(null));
  for (const family of families) assert.equal(missing[family].presence, "unknown");
  assert.equal(missing.storage.cargo.presence, "unknown");
  const unknown = deriveMiningSupportCapabilities(input([slot(105, null)], { groupOf: () => null,
    bays: { shipID: SHIP_ID, rows: [bay("drone", true, [drone(603, 703, 1)]), { ...bay("ore", null, null), error: "unreadable" }] } }));
  for (const family of families) assert.equal(unknown[family].presence, "unknown");
  assert.deepEqual(unknown.unclassifiedModuleItemIDs, [105]);
  assert.equal(unknown.miningDrones.presence, "unknown");
  assert.deepEqual(unknown.miningDrones.unclassifiedItemIDs, [603]);
  assert.equal(unknown.storage.mining.presence, "unknown");
  assert.equal(deriveMiningSupportCapabilities(input([], { bays: { shipID: SHIP_ID, rows: [{ ...bay("drone"), error: "failed" }] } })).miningDrones.presence, "unknown");
});

test("foreign or unmatched dogma and bays are rejected; offline and passive facts stay explicit", () => {
  const info = dogma([tractor]);
  for (const replacement of [{ ...info, activeShipID: 42 },
    { ...info, ships: info.ships.map(entry => ({ ...entry, typeID: 999 })) },
    { ...info, ships: info.ships.map(entry => ({ ...entry, locationID: 42 })) },
    { ...info, ships: info.ships.map(entry => ({ ...entry, itemID: 999 })) },
    { ...info, ships: info.ships.map(entry => ({ ...entry, categoryID: 8 })) }]) {
    assert.equal(deriveMiningSupportCapabilities(input([tractor], { dogma: replacement })).tractors.modules[0]?.hasActivationCycle, null);
  }
  const offline = { ...tractor, module: { ...tractor.module!, online: false } };
  const snapshot = deriveMiningSupportCapabilities(input([offline], { dogma: { ...info, ships: info.ships.map(entry => ({ ...entry, attributes: [] })) },
    bays: { shipID: 42, rows: [bay("cargo"), bay("drone")] } }));
  assert.equal(snapshot.tractors.modules[0]?.online, false);
  assert.equal(snapshot.tractors.modules[0]?.hasActivationCycle, false);
  assert.equal(snapshot.storage.cargo.presence, "unknown");
  assert.equal(snapshot.miningDrones.presence, "unknown");
  const noShip = deriveMiningSupportCapabilities(input([tractor], { scope: { shipID: null, fittingSignature: "none" }, dogma: info }));
  assert.equal(noShip.tractors.presence, "unknown");
});

test("shared command-burst and siege groups do not invent mining bursts or Industrial Cores", () => {
  const combat = deriveMiningSupportCapabilities(input([burst, core], {
    typeNameOf: typeID => typeID === 1101 ? "Shield Command Burst II" : "Bastion Module I",
  }));
  assert.equal(combat.bursts.presence, "absent");
  assert.equal(combat.industrialCores.presence, "absent");
  const unresolved = deriveMiningSupportCapabilities(input([burst, core], { typeNameOf: () => null }));
  assert.equal(unresolved.bursts.presence, "unknown");
  assert.equal(unresolved.industrialCores.presence, "unknown");
  const faction = deriveMiningSupportCapabilities(input([burst, core], {
    typeNameOf: typeID => typeID === 1101 ? "Presidential Mining Foreman Burst" : "Capital Industrial Core II",
  }));
  assert.equal(faction.bursts.presence, "present");
  assert.equal(faction.industrialCores.presence, "present");
});

test("flow reader recomputes refits, charges and bays without IO or cached stale item IDs", () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: (async () => { assert.fail("capability snapshots must perform no IO"); }) as typeof fetch });
  const setFit = (slots: readonly FittingSlot[], shipID = SHIP_ID, slotsError: string | null = null) => store.apply({
    type: "fitting/loaded", activeShipID: shipID, slots, resources: store.fitting.get().resources,
    stats: store.fitting.get().stats, slotsError, resourcesError: null,
  });
  assert.equal(flow.readMiningSupportCapabilities().bursts.presence, "unknown");
  store.apply({ type: "names/resolved", entries: { [nameKey("type", 1101)]: "Mining Foreman Burst I" } });
  setFit([burst]);
  const before = flow.readMiningSupportCapabilities();
  const charged = { ...burst, module: { ...burst.module!, charge: { itemID: 501, typeID: 502, quantity: 4 } } };
  setFit([charged]);
  const chargedSnapshot = flow.readMiningSupportCapabilities();
  assert.equal(chargedSnapshot.scope.fittingSignature, before.scope.fittingSignature);
  assert.equal(chargedSnapshot.bursts.modules[0]?.charge?.quantity, 4);
  store.apply({ type: "inventory/ship-open", itemID: SHIP_ID, typeID: 1 });
  store.apply({ type: "inventory/ship-bays", itemID: SHIP_ID, bays: [bay("cargo", true, [drone(601, 701, 1)])], error: null });
  const fullCargo = flow.readMiningSupportCapabilities();
  store.apply({ type: "inventory/ship-bays", itemID: SHIP_ID, bays: [bay("cargo")], error: null });
  assert.deepEqual(flow.readMiningSupportCapabilities().storage.cargo.bays[0]?.items, []);
  assert.equal(fullCargo.storage.cargo.bays[0]?.items?.length, 1);
  store.apply({ type: "dogma/loaded", allInfo: dogma([burst]), error: null });
  setFit([tractor]);
  const refit = flow.readMiningSupportCapabilities();
  assert.notEqual(refit.scope.fittingSignature, before.scope.fittingSignature);
  assert.equal(refit.bursts.presence, "absent");
  assert.deepEqual(refit.tractors.modules.map(module => module.itemID), [102]);
  assert.equal(refit.tractors.modules[0]?.hasActivationCycle, null);
  setFit([tractor], 42);
  const switched = flow.readMiningSupportCapabilities();
  assert.equal(switched.scope.shipID, 42);
  assert.equal(switched.storage.cargo.presence, "unknown");
  assert.equal(switched.tractors.modules[0]?.hasActivationCycle, null);
  setFit([tractor], 42, "failed slot read");
  assert.equal(flow.readMiningSupportCapabilities().tractors.presence, "unknown");
  store.apply({ type: "inventory/loaded", stationID: null, activeShipID: null,
    hangar: store.inventory.get().hangar, cargo: store.inventory.get().cargo });
  setFit([tractor], 42);
  assert.equal(flow.readMiningSupportCapabilities().scope.shipID, null, "observed no active ship wins over retained fitting");
  assert.equal(flow.readMiningSupportCapabilities().tractors.presence, "unknown");
});
