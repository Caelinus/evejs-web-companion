"use strict";
function unavailable(code, message) {
  throw Object.assign(new Error(message), { code, statusCode: 409 });
}
const offlineProvisioning = () => unavailable("PROVISIONING_OFFLINE_AUTHORITY_UNAVAILABLE",
  "Stock EveJS cannot verify and acquire an offline provisioning pilot. Select the pilot and use Ready Fit or Replenish in its held session.");
const skillAcquisition = () => unavailable("SKILL_ACQUISITION_UNAVAILABLE",
  "Direct skill purchase is unavailable through the stock EveJS web gateway. Inject skillbooks in the game client, then refresh Training and review the queue.");
const structureServices = () => unavailable("STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE",
  "Stock EveJS web gateway does not expose authoritative structure services. This action requires service authority; NPC station actions remain available.");
module.exports = { unavailable, offlineProvisioning, skillAcquisition, structureServices };
