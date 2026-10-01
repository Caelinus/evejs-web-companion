"use strict";

// Read-only projection of values ALREADY computed by commandBurstRuntime and
// industrialCore. No activation, dogma calculation, recipient or fleet policy.
function positiveID(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function activeEffects(entity) {
  if (!(entity && entity.activeModuleEffects instanceof Map)) return null;
  return [...entity.activeModuleEffects.entries()].filter(([, state]) =>
    state && !(Number(state.deactivatedAtMs) > 0));
}

function projectMiningBurstServices(entity) {
  const effects = activeEffects(entity);
  if (effects === null) return null;
  return {
    activeModuleIDs: effects.map(([moduleID]) => positiveID(moduleID)).filter(id => id !== null),
    bursts: effects.filter(([, state]) => state.commandBurstEffect === true && state.commandBurstFamily === "mining")
      .map(([moduleID, state]) => ({
        moduleID: positiveID(moduleID),
        typeID: positiveID(state.typeID),
        effectID: positiveID(state.effectID),
        effectName: typeof state.effectName === "string" ? state.effectName : null,
        chargeTypeID: positiveID(state.chargeTypeID),
        // Current effect state does not retain the consumed charge item's ID.
        chargeItemID: null,
        rangeMeters: finite(state.commandBurstRangeMeters),
        cycleDurationMs: finite(state.durationMs),
        buffDurationMs: finite(state.commandBurstBuffDurationMs),
        buffs: state.commandBurstDbuffValues instanceof Map
          ? [...state.commandBurstDbuffValues].map(([collectionID, value]) => ({ collectionID: positiveID(collectionID), value: finite(value) }))
          : null,
      })),
  };
}

function projectCompressionService(entity) {
  const effects = activeEffects(entity);
  const compressors = effects === null ? null : effects
    .filter(([, state]) => String(state.effectName || "").toLowerCase() === "industrialitemcompression")
    .map(([moduleID, state]) => ({ moduleID: positiveID(moduleID), typeID: positiveID(state.typeID) }));
  const pairs = entity && entity.compressionFacilityTypelists;
  // industrialCore.refreshShipCompressionFacilityState leaves an uninitialised
  // cache undefined when both its previous and current typelists are empty.
  // A readable effect map with no compressor proves the facility inactive;
  // an absent effect map still cannot supply that proof.
  if (pairs === undefined && compressors !== null && compressors.length === 0) {
    return { state: "inactive", typeListRanges: [], compressors };
  }
  if (pairs === null || (Array.isArray(pairs) && pairs.length === 0)) {
    return { state: "inactive", typeListRanges: [], compressors };
  }
  if (!Array.isArray(pairs)) return { state: "unknown", typeListRanges: null, compressors };
  const typeListRanges = pairs.map(pair => ({
    typeListID: positiveID(Array.isArray(pair) ? pair[0] : null),
    rangeMeters: finite(Array.isArray(pair) ? pair[1] : null),
  }));
  if (typeListRanges.some(pair => pair.typeListID === null || pair.rangeMeters === null || pair.rangeMeters <= 0)) {
    return { state: "unknown", typeListRanges: null, compressors };
  }
  return { state: "active", typeListRanges, compressors };
}

function safely(read) {
  try { return read(); } catch { return null; }
}

function effectIdentity(moduleID, state) {
  return { moduleID: positiveID(moduleID), effectID: positiveID(state.effectID),
    effectName: typeof state.effectName === "string" ? state.effectName : null };
}

function unknownStartupQuote(moduleID, reason) {
  return { moduleID, availability: "unknown", reason, fuelTypeID: null,
    requiredQuantity: null, availableQuantity: null, sufficient: null };
}

// Consumption arithmetic stays in getGenericModuleRuntimeAttributes. This
// observation compares its final quantity with the SAME eligible-stack total
// used by sharedFuelRuntime's NO_FUEL gate; it never probes by consuming fuel.
function projectStartupFuelQuote(entity, item, active, nowMs, authority, readInventory) {
  const moduleID = positiveID(item.itemID);
  if (active === null) return unknownStartupQuote(moduleID, "module-state-unknown");
  if (active) return { ...unknownStartupQuote(moduleID, "module-active"), availability: "not-applicable" };
  const isCore = safely(() => authority.isIndustrialCore(item));
  if (isCore === false) return { ...unknownStartupQuote(moduleID, "not-industrial-core"), availability: "not-applicable" };
  if (isCore !== true) return unknownStartupQuote(moduleID, "core-identity-unknown");
  if (finite(nowMs) === null) return unknownStartupQuote(moduleID, "simulation-time-unavailable");
  if (moduleID === null || positiveID(item.locationID) !== positiveID(entity.itemID) || !positiveID(entity.itemID)) {
    return unknownStartupQuote(moduleID, "module-scope-mismatch");
  }
  const attributes = safely(() => authority.readStartupRuntimeAttributes(entity, item, nowMs));
  const fuelTypeID = positiveID(attributes?.fuelTypeID);
  const requiredQuantity = finite(attributes?.fuelPerActivation);
  if (fuelTypeID === null || requiredQuantity === null || !Number.isSafeInteger(requiredQuantity) || requiredQuantity < 0) {
    return unknownStartupQuote(moduleID, "fuel-calculation-unavailable");
  }
  const availableQuantity = finite(readInventory(fuelTypeID)?.availableQuantity);
  const readable = availableQuantity !== null && availableQuantity >= 0;
  return { moduleID, fuelTypeID, requiredQuantity, availableQuantity: readable ? availableQuantity : null,
    sufficient: readable ? availableQuantity >= requiredQuantity : null,
    availability: readable ? "available" : "unknown", reason: readable ? null : "fuel-inventory-unavailable" };
}

// Authority callbacks are the existing runtime predicates/readers, not a new
// rules engine. Keeping projection pure makes unavailable reads testable.
function projectCoreMobilityFuel(entity, nowMs, authority = {}) {
  const effects = activeEffects(entity);
  const fitted = safely(() => authority.readFittedModules(entity));
  const items = new Map((Array.isArray(fitted) ? fitted : []).map(item => [positiveID(item.itemID), item]));
  for (const [moduleID, state] of effects || []) {
    if (!items.has(moduleID)) items.set(moduleID, { itemID: moduleID, typeID: state.typeID });
  }
  const inventoryByType = new Map(); // Deduplicate reads within ONE snapshot only.
  const readInventory = typeID => {
    if (!inventoryByType.has(typeID)) inventoryByType.set(typeID, safely(() => authority.readFuelInventory(entity, typeID)));
    return inventoryByType.get(typeID) || null;
  };
  const modules = [...items].filter(([moduleID]) => moduleID !== null).map(([moduleID, item]) => {
    const candidate = effects?.find(([id]) => id === moduleID)?.[1];
    const effect = candidate && candidate.typeID === item.typeID ? candidate : null;
    const active = effects === null || (candidate && !effect) ? null : effect !== null;
    const fuelTypeID = effect && effect.fuelTypeID !== undefined ? positiveID(effect.fuelTypeID)
      : positiveID(safely(() => authority.readFuelTypeID(item)));
    const inventory = fuelTypeID === null ? null : readInventory(fuelTypeID);
    return {
      moduleID, typeID: positiveID(item.typeID), active,
      effect: effect ? {
        ...effectIdentity(moduleID, effect),
        startedAtMs: finite(effect.startedAtMs), cycleDurationMs: finite(effect.durationMs),
        nextCycleAtMs: finite(effect.nextCycleAtMs),
        deactivationRequestedAtMs: finite(effect.deactivationRequestedAtMs), deactivateAtMs: finite(effect.deactivateAtMs),
        stopReason: typeof effect.stopReason === "string" ? effect.stopReason : null,
      } : null,
      fuel: {
        typeID: fuelTypeID,
        // The continuing-cycle consumer uses this already-rounded effect value.
        // Base dogma is deliberately NOT substituted for an inactive module.
        effectivePerActivation: effect ? finite(effect.fuelPerActivation) : null,
        availableQuantity: inventory ? finite(inventory.availableQuantity) : null,
        eligibleFlagIDs: inventory?.eligibleFlagIDs ?? null,
        stacks: inventory?.stacks ?? null,
        // NO_FUEL activation failures are not retained by current runtime state.
        activationFailureCode: null,
        startupQuote: projectStartupFuelQuote(entity, item, active, nowMs, authority, readInventory),
      },
    };
  });
  function restriction(action) {
    const locked = effects === null || finite(nowMs) === null ? null : safely(() => action === "movement"
      ? authority.isShipMovementLockedByRuntime(entity, nowMs) : authority.isShipWarpDisabledByRuntime(entity, nowMs));
    const verdict = typeof locked !== "boolean" ? "unknown" : locked ? "restricted" : "unrestricted";
    const sources = effects === null ? null : effects.filter(([, state]) => state.immobilizesShip === true ||
      (action === "warp" && safely(() => authority.moduleTypeDisallowsWarp(state.typeID)) === true))
      .map(([moduleID, state]) => effectIdentity(moduleID, state));
    return { verdict, reasonCode: action === "warp" && locked === true ? "SHIP_IMMOBILE" : null, sources };
  }
  return { activeModuleIDs: effects === null ? null : effects.map(([id]) => positiveID(id)).filter(id => id !== null),
    modules, mobility: { movement: restriction("movement"), warp: restriction("warp") } };
}

// This adapter only calls existing read authority. It never calls the fuel
// consumer, activates a module or mutates lifecycle/history state.
function readCoreMobilityFuel(entity, nowMs) {
  return safely(() => {
    const restrictions = require("../../space/runtime/shipActionRestrictions");
    const dogma = require("../../space/runtime/entityDogmaView");
    const attributes = require("../../space/runtime/moduleAttributes");
    const fuel = require("../../space/modules/sharedFuelRuntime");
    const bays = require("../../services/inventory/fuelBayInventory");
    const effects = require("../../space/runtime/moduleActivationEffectRecord");
    const core = require("../../space/runtime/industrialCore");
    const modifiers = require("../../space/runtime/activeShipModifiers");
    const diff = require("../../space/modules/moduleAttributeDiff");
    const bursts = require("../../space/modules/commandBurstRuntime");
    const npc = require("../../space/npc/npcCapabilityResolver");
    return projectCoreMobilityFuel(entity, nowMs, {
      ...restrictions,
      readFittedModules: dogma.getEntityRuntimeFittedItems,
      readFuelTypeID: item => attributes.getBaseGenericModuleRuntimeAttributes(item)?.fuelTypeID ?? null,
      isIndustrialCore(item) {
        const effect = effects.resolveDefaultActivationEffect(item.typeID);
        return effect ? core.isIndustrialCoreEffectName(effect.name || effect.guid) : null;
      },
      readStartupRuntimeAttributes(ship, item, now) {
        const characterID = dogma.getShipEntityInventoryCharacterID(ship, 0);
        const shipItem = dogma.getEntityRuntimeShipItem(ship);
        if (!(characterID > 0) || ship.kind !== "ship" || shipItem?.itemID !== ship.itemID) return null;
        const effectiveItem = npc.buildNpcEffectiveModuleItem(item);
        // Same generic activation context as scene/modules.activateGenericModule:
        // exclude this module's current effect, retain its overload context,
        // include skills, fitting, implants, system and current burst modifiers.
        return attributes.getGenericModuleRuntimeAttributes(characterID, shipItem, effectiveItem,
          dogma.getEntityRuntimeLoadedCharge(ship, item), null, {
            skillMap: dogma.getEntityRuntimeSkillMap(ship),
            fittedItems: dogma.getEntityRuntimeFittedItems(ship),
            activeModuleContexts: dogma.getEntityRuntimeActiveModuleContexts(ship, {
              excludeModuleID: item.itemID, includeOverloadModuleID: item.itemID,
            }),
            additionalLocationModifierSources: modifiers.collectEntityWormholeLocationModifierSources(ship),
            additionalDirectModifierEntries: diff.resolveModuleSnapshotDirectModifierEntries(ship, effectiveItem, {
              nowMs: now, collectModifierEntriesForItem: bursts.collectModifierEntriesForItem,
            }),
          });
      },
      readFuelInventory(ship, typeID) {
        const characterID = dogma.getShipEntityInventoryCharacterID(ship, 0);
        if (!(characterID > 0) || !positiveID(ship.itemID)) return null;
        const stacks = fuel.getFuelStacksForShipStorage(ship, typeID, { resolveCharacterID: () => characterID });
        return {
          availableQuantity: fuel.getFuelQuantityFromStacks(stacks),
          eligibleFlagIDs: bays.getFuelStorageFlagsForType(typeID),
          stacks: stacks.map(stack => ({ itemID: positiveID(stack.itemID), locationID: positiveID(stack.locationID),
            flagID: positiveID(stack.flagID), quantity: finite(stack.quantity ?? stack.stacksize) })),
        };
      },
    });
  });
}

module.exports = { projectMiningBurstServices, projectCompressionService, projectCoreMobilityFuel, readCoreMobilityFuel };
