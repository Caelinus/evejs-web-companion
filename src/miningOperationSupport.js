"use strict";

function normalizeSupport(value, members) {
  const commands = members.filter(row => row.role === "COMMAND");
  const fail = message => { throw Object.assign(new Error(message), { code: "MINING_OPERATION_INVALID" }); };
  if (value == null) { if (commands.length) fail("A COMMAND pilot requires support options."); return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      !Number.isSafeInteger(value.characterID) || commands.length !== 1 || commands[0].characterID !== value.characterID ||
      commands[0].routineMode !== "STANDARD") fail("Choose exactly one Standard COMMAND pilot for support.");
  const choice = (key, allowed, fallback) => {
    const result = value[key] ?? fallback;
    if (!allowed.includes(result)) fail(`Invalid support ${key}.`);
    return result;
  };
  const boolean = (key, fallback) => {
    const result = value[key] ?? fallback;
    if (typeof result !== "boolean") fail(`Invalid support ${key}.`);
    return result;
  };
  const support = { version: 1, characterID: value.characterID,
    fleetPolicy: choice("fleetPolicy", ["EXISTING_ONLY", "MANAGED"], "EXISTING_ONLY"),
    maintainBursts: boolean("maintainBursts", true), useIndustrialCore: boolean("useIndustrialCore", false),
    coreRequirement: choice("coreRequirement", ["continueWithoutCore", "requireCore"], "continueWithoutCore"),
    enableCompression: boolean("enableCompression", false), selfMining: boolean("selfMining", false),
    tractor: boolean("tractor", false), collection: choice("collection", ["TRACTOR_ONLY", "TRACTOR_AND_COLLECT"], "TRACTOR_ONLY"),
    compressCollectedOre: boolean("compressCollectedOre", false),
    supportLoss: choice("supportLoss", ["CONTINUE_UNSUPPORTED", "PAUSE", "STOP"], "PAUSE") };
  if (!support.maintainBursts) fail("Support-bound miners require mining burst maintenance.");
  if (support.coreRequirement === "requireCore" && !support.useIndustrialCore) fail("Required Core must be enabled.");
  if (support.collection === "TRACTOR_AND_COLLECT" && !support.tractor) fail("Collection requires tractor custody.");
  if (support.compressCollectedOre && (!support.enableCompression || support.collection !== "TRACTOR_AND_COLLECT")) fail("Collected ore compression requires collection and compression service.");
  return support;
}

/** Ephemeral controller receipt, never a persisted fleet identity. A short
 * recovery interval separates stale transport from an explicit loss action. */
function supportPolicy(config, status, lostSinceMs, nowMs) {
  if (!config) return { mode: "NORMAL", reason: null, lostSinceMs: null };
  const fresh = status && status.observedAtMs <= nowMs && nowMs - status.observedAtMs < 10000;
  const usable = fresh && ["READY", "DEGRADED"].includes(status.state) &&
    (config.coreRequirement !== "requireCore" || status.core === "active");
  if (usable) return { mode: "NORMAL", reason: status.state === "DEGRADED" ? status.reason : null, lostSinceMs: null };
  const since = lostSinceMs ?? nowMs;
  const reason = fresh ? status.reason || "support-not-ready" : "support-observation-unavailable";
  if (nowMs - since < 30000) return { mode: "PAUSE", reason: `RECOVERY: ${reason}`, lostSinceMs: since };
  return { mode: config.supportLoss === "CONTINUE_UNSUPPORTED" ? "FALLBACK" : config.supportLoss, reason, lostSinceMs: since };
}
module.exports = { normalizeSupport, supportPolicy };
