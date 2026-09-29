"use strict";
const { normalizeResourcePolicy } = require("./miningResourcePolicy");

const STOP_MODES = Object.freeze(["STAY_IN_PLACE", "RETURN_HOME_DOCK", "RETURN_HOME_UNLOAD_DOCK"]);
function invalid(message) {
  return Object.assign(new Error(message), { code: "MINING_OPERATION_INVALID" });
}

function normalizePolicies(input, resolveStation, resolveSystem) {
  const value = input ?? {};
  if (typeof value !== "object" || Array.isArray(value) || (value.version != null && value.version !== 1)) {
    throw invalid("Unsupported operation policy version.");
  }
  const defaults = { travelAssist: "DISABLED", resourceTarget: "ANY_ELIGIBLE", scouting: "DISABLED", defense: "EXISTING_SELF_DEFENSE" };
  if (value.travelAssist?.mode === "AUTO") defaults.travelAssist = "AUTO";
  for (const [key, mode] of Object.entries(defaults)) {
    if (value[key] != null && (value[key].mode !== mode || Object.keys(value[key]).some(k => k !== "mode"))) {
      throw invalid(`${key} policy is not executable yet; use ${mode}.`);
    }
  }
  if (Object.keys(value).some(key => !["version", "parking", "resourcePolicy", ...Object.keys(defaults)].includes(key))) throw invalid("Unknown operation policy.");
  const parking = value.parking ?? { mode: "STAY_IN_PLACE" };
  if (!STOP_MODES.includes(parking.mode)) throw invalid("Choose a supported Stop / Parking policy.");
  let destination = null;
  if (parking.mode !== "STAY_IN_PLACE") {
    if (parking.destination?.kind === "structure") {
      const { id, name, solarSystemID, solarSystemName } = parking.destination;
      const system = Number.isSafeInteger(solarSystemID) ? resolveSystem(solarSystemID) : null;
      if (!Number.isSafeInteger(id) || id < 1_000_000_000_000 || typeof name !== "string" || !name.trim() ||
          !system?.solarSystemName || solarSystemName !== system.solarSystemName) {
        throw invalid("Return-home parking requires a resolved player structure and known solar system.");
      }
      destination = { kind: "structure", id, name: name.trim(), solarSystemID, solarSystemName: system.solarSystemName };
    } else {
      const id = Number(parking.destination?.stationID);
      const station = Number.isSafeInteger(id) && id > 0 ? resolveStation(id) : null;
      const system = station ? resolveSystem(Number(station.solarSystemID)) : null;
      if (!station?.stationName || !system?.solarSystemName) throw invalid("Return-home parking requires an explicit known parking station. Starting station is never substituted.");
      if ((parking.destination.stationName && parking.destination.stationName !== station.stationName) ||
          (parking.destination.systemName && parking.destination.systemName !== system.solarSystemName)) {
        throw invalid("Parking station identity does not match the authoritative catalog.");
      }
      destination = { stationID: id, stationName: station.stationName, systemName: system.solarSystemName };
    }
  }
  const division = parking.corporationDivision ?? null;
  if (division !== null && (!Number.isSafeInteger(division) || division < 1 || division > 7)) throw invalid("Parking unload division must be 1–7, or personal hangar.");
  const corporationID = parking.corporationID == null ? null : Number(parking.corporationID);
  if (division !== null && (!Number.isSafeInteger(corporationID) || corporationID <= 0)) throw invalid("Strict corporation Parking requires the intended corporation ID.");
  return { version: 1,
    resourcePolicy: normalizeResourcePolicy(value.resourcePolicy),
    parking: { mode: parking.mode, destination, corporationDivision: division, corporationID: division === null ? null : corporationID },
    ...Object.fromEntries(Object.entries(defaults).map(([key, mode]) => [key, { mode }])),
  };
}

module.exports = { STOP_MODES, normalizePolicies };
