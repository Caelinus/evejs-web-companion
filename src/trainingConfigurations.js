"use strict";

// Browser configuration is a requested contract, never gameplay authority.
// Every read resolves its owner/hull/content against the pilot's current corp.
const ROLE_ID = /^[A-Z][A-Z0-9_-]{0,39}$/;
const CONFIG_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MINER_POLICIES = ["VENTURE", "PIONEER", "PROCURER"];
function invalid(message) {
  throw Object.assign(new Error(message), { code: "INVALID_TRAINING_CONFIGURATION", statusCode: 400 });
}
function validateConfigurations(role, configurations) {
  if (typeof role !== "string" || !ROLE_ID.test(role)) invalid("An explicit role ID is required.");
  if (!Array.isArray(configurations) || configurations.length > 3) invalid("Each role supports at most three training configurations.");
  const ids = new Set(), contracts = new Set();
  return configurations.map((c, order) => {
    if (!c || !CONFIG_ID.test(c.configurationID || "") || c.roleID !== role || c.order !== order ||
        [c.corporationOwnerID, c.fittingID, c.hullTypeID].some((id) => !Number.isSafeInteger(id) || id <= 0)) invalid("Invalid qualification identity or order.");
    const contract = `${c.corporationOwnerID}:${c.fittingID}`;
    if (ids.has(c.configurationID) || contracts.has(contract)) invalid("Duplicate qualification contract.");
    ids.add(c.configurationID); contracts.add(contract);
    if (c.acceptedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(c.acceptedFingerprint)) invalid("Invalid accepted fitting fingerprint.");
    if (c.acceptedSavedDate !== undefined && !/^[1-9][0-9]{0,19}$/.test(c.acceptedSavedDate)) invalid("Invalid accepted fitting date.");
    if (c.supportPolicyKey != null && (role !== "MINER" || !MINER_POLICIES.includes(c.supportPolicyKey) || c.supportPolicyVersion !== 1)) invalid("Unsupported role support policy.");
    return { configurationID: c.configurationID, roleID: role, order, corporationOwnerID: c.corporationOwnerID,
      fittingID: c.fittingID, hullTypeID: c.hullTypeID, acceptedSavedDate: c.acceptedSavedDate,
      acceptedFingerprint: c.acceptedFingerprint, supportPolicyKey: c.supportPolicyKey || null, supportPolicyVersion: c.supportPolicyVersion || null };
  });
}
function configurationStages(role, configurations) {
  return validateConfigurations(role, configurations).map((c) => ({ ...c, id: c.configurationID, expectedHullTypeID: c.hullTypeID }));
}
function configurationSelections(configurations) {
  return Object.fromEntries(configurations.map((c) => [c.configurationID, { scope: "CORPORATION", ownerID: c.corporationOwnerID,
    fittingID: c.fittingID, acceptedSavedDate: c.acceptedSavedDate, acceptedFingerprint: c.acceptedFingerprint }]));
}
module.exports = { validateConfigurations, configurationStages, configurationSelections, ROLE_ID };
