"use strict";

function normalizeResourcePolicy(input) {
  const value = input ?? { mode: "ANY_ELIGIBLE" };
  const invalid = message => { throw Object.assign(new Error(message), { code: "MINING_OPERATION_INVALID" }); };
  if (!value || !["ANY_ELIGIBLE", "PREFER_LIST"].includes(value.mode) ||
      (value.source != null && value.source !== "MANUAL") ||
      Object.keys(value).some(key => !["mode", "source", "typeIDs"].includes(key))) invalid("Choose Any eligible or a manual ordered resource list.");
  const ids = value.typeIDs ?? [];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length ||
      (value.mode === "PREFER_LIST" ? ids.length === 0 : ids.length !== 0)) invalid("Select 1–20 different resource types for Prefer, or an empty list for Any eligible.");
  return { mode: value.mode, source: "MANUAL", typeIDs: [...ids] };
}

function validateResourcePolicy(definition, catalog) {
  const policy = normalizeResourcePolicy(definition.policies?.resourcePolicy);
  if (policy.mode === "ANY_ELIGIBLE") return;
  const families = definition.area?.targetClasses;
  if (!Array.isArray(families) || families.length !== 1 || !["BELT", "ORE_ANOMALY", "ICE"].includes(families[0])) throw Object.assign(new Error("Resource preference requires one executable target family."), { code: "MINING_OPERATION_INVALID" });
  const family = families[0] === "ICE" ? "ice" : "ore";
  if (policy.typeIDs.some(id => !catalog.some(row => row.typeID === id && row.family === family))) {
    throw Object.assign(new Error("A preferred resource is unknown or incompatible with the selected target family. Choose it from the resource catalog."), { code: "MINING_OPERATION_INVALID" });
  }
}
module.exports = { normalizeResourcePolicy, validateResourcePolicy };
