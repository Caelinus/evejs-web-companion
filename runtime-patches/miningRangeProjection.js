"use strict";
const id = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const range = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
function projectModuleReach(entity, nowMs, authority) {
  const shipID = id(entity?.itemID);
  const unknown = reason => ({ shipID, sampledAtSimTimeMs: Number.isFinite(nowMs) ? nowMs : null,
    availability: "unknown", reason, modules: null });
  if (shipID === null || !Number.isFinite(nowMs)) return unknown("scope-or-time-unavailable");
  try {
    const characterID = id(authority.characterID(entity));
    const ship = authority.shipItem(entity);
    const items = authority.fittedItems(entity);
    if (characterID === null || ship?.itemID !== shipID || !Array.isArray(items)) return unknown("ship-context-unavailable");
    const modules = [];
    for (const item of items) {
      if (id(item?.itemID) === null || id(item?.typeID) === null || item.locationID !== shipID || item.ownerID !== characterID) return unknown("module-scope-mismatch");
      const mining = authority.mining(entity, item, nowMs);
      if (!mining || typeof mining.matched !== "boolean") return unknown("module-classification-unavailable");
      let family, snapshot;
      if (mining.matched) { family = "mining"; snapshot = mining; }
      else if (authority.isTractor(item) === true) { family = "tractor"; snapshot = authority.tractor(entity, item); }
      else continue;
      const maxRangeMeters = range(snapshot?.maxRangeMeters);
      const settlement = family === "tractor" ? range(authority.tractorSettlementMeters) : null;
      const available = maxRangeMeters !== null && (family === "mining" ? snapshot?.availability === "available" : settlement !== null);
      modules.push({ moduleID: item.itemID, typeID: item.typeID, family,
        resourceFamily: family === "mining" && ["ore", "ice", "gas"].includes(snapshot?.resourceFamily) ? snapshot.resourceFamily : null,
        maxRangeMeters: available ? maxRangeMeters : null, settlementSurfaceDistanceMeters: settlement,
        availability: available ? "available" : "unknown", reason: available ? null : "range-calculation-unavailable" });
    }
    return { shipID, sampledAtSimTimeMs: nowMs, availability: "available", reason: null, modules: modules.sort((a,b) => a.moduleID - b.moduleID) };
  } catch { return unknown("range-authority-unavailable"); }
}
function readModuleReach(entity, nowMs) {
  try {
    const dogma = require("../../space/runtime/entityDogmaView");
    const mining = require("../../services/mining/miningRuntime");
    const tractor = require("../../space/modules/tractorBeamRuntime");
    const effects = require("../../space/runtime/moduleActivationEffectRecord");
    return projectModuleReach(entity, nowMs, {
      characterID: ship => dogma.getShipEntityInventoryCharacterID(ship, 0),
      shipItem: dogma.getEntityRuntimeShipItem,
      fittedItems: dogma.getEntityRuntimeFittedItems,
      mining: mining.readEntityMiningReach,
      isTractor: item => String(effects.resolveDefaultActivationEffect(item.typeID)?.name ?? "").toLowerCase() === "tractorbeamcan",
      tractorSettlementMeters: tractor.TRACTOR_FOLLOW_RANGE_METERS,
      tractor(ship, item) {
        return tractor.readTractorBeamModuleSnapshot({ shipItem: dogma.getEntityRuntimeShipItem(ship), moduleItem: item,
          chargeItem: dogma.getEntityRuntimeLoadedCharge(ship, item), skillMap: dogma.getEntityRuntimeSkillMap(ship),
          fittedItems: dogma.getEntityRuntimeFittedItems(ship), activeModuleContexts: dogma.getEntityRuntimeActiveModuleContexts(ship,
            { excludeModuleID: item.itemID, includeOverloadModuleID: item.itemID }) });
      },
    });
  } catch { return { shipID: id(entity?.itemID), sampledAtSimTimeMs: Number.isFinite(nowMs) ? nowMs : null,
    availability: "unknown", reason: "range-authority-unavailable", modules: null }; }
}
module.exports = { projectModuleReach, readModuleReach };
