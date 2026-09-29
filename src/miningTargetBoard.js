"use strict";

// One process-wide coordination authority for every Mining Operation. Targets
// are keyed by stable facts that another pilot can observe too: system id plus
// belt name or authoritative site/instance identity. Claims are synchronous check-and-set operations
// in the BFF event loop and are bounded by a renewable lease.

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const TARGET_TYPES = new Set(["BELT", "ORE_ANOMALY", "ICE", "GAS"]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function targetKey(targetType, systemID, targetName) {
  const type = text(targetType).toUpperCase();
  const system = Number(systemID);
  const name = text(targetName);
  if (!TARGET_TYPES.has(type) || !Number.isSafeInteger(system) || system <= 0 || !name) return "";
  return `${type}:${system}:${name}`;
}

function createMiningTargetBoard(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const leaseMs = Number.isFinite(options.leaseMs) && options.leaseMs > 0
    ? Number(options.leaseMs)
    : DEFAULT_CLAIM_LEASE_MS;
  const entries = new Map();

  function publicEntry(entry) {
    return {
      targetKey: entry.targetKey,
      targetType: entry.targetType,
      systemID: entry.systemID,
      systemName: entry.systemName,
      targetName: entry.targetName,
      ...(entry.siteIdentity ? { siteIdentity: entry.siteIdentity, siteID: entry.siteID, instanceID: entry.instanceID, position: { ...entry.position } } : {}),
      state: entry.state,
      claimedByOperationID: entry.claimedByOperationID,
      claimedAt: entry.claimedAt,
      lastHeartbeat: entry.lastHeartbeat,
      leaseExpiresAt: entry.leaseExpiresAt,
      depletionEvidence: entry.depletionEvidence,
      depletedAt: entry.depletedAt,
    };
  }

  function expire(entry) {
    if (
      entry.claimedByOperationID !== null &&
      entry.leaseExpiresAt !== null &&
      entry.leaseExpiresAt <= now()
    ) {
      entry.claimedByOperationID = null;
      entry.claimedAt = null;
      entry.lastHeartbeat = null;
      entry.leaseExpiresAt = null;
      entry.state = entry.depletionEvidence === null ? "AVAILABLE" : "DEPLETED";
    }
    return entry;
  }

  function get(key) {
    const entry = entries.get(String(key));
    return entry ? publicEntry(expire(entry)) : null;
  }

  // Atomic in one synchronous turn: no read/await/write gap exists here.
  function reserve(operationID, target) {
    const owner = text(operationID);
    const key = targetKey(target?.targetType, target?.systemID, target?.siteIdentity || target?.targetName);
    if (!owner || !key) return { acquired: false, reason: "INVALID_TARGET", target: null };
    let entry = entries.get(key);
    if (entry) expire(entry);
    if (entry?.depletionEvidence !== null && entry?.depletionEvidence !== undefined) {
      return { acquired: false, reason: "DEPLETED", target: publicEntry(entry) };
    }
    if (entry?.claimedByOperationID && entry.claimedByOperationID !== owner) {
      return { acquired: false, reason: "CLAIMED", target: publicEntry(entry) };
    }
    const stamp = now();
    if (!entry) {
      entry = {
        targetKey: key,
        targetType: text(target.targetType).toUpperCase(),
        systemID: Number(target.systemID),
        systemName: text(target.systemName) || null,
        targetName: text(target.targetName),
        ...(target.siteIdentity ? { siteIdentity: target.siteIdentity, siteID: target.siteID, instanceID: target.instanceID, position: { ...target.position } } : {}),
        state: "AVAILABLE",
        claimedByOperationID: null,
        claimedAt: null,
        lastHeartbeat: null,
        leaseExpiresAt: null,
        depletionEvidence: null,
        depletedAt: null,
      };
      entries.set(key, entry);
    }
    if (target.siteIdentity && entry.claimedByOperationID === null) {
      // A confirmed reappearance can reuse identity; use THIS observation's
      // position/warp handle, never the previous incarnation's coordinates.
      entry.position = { ...target.position };
      entry.targetName = text(target.targetName);
    }
    entry.state = "RESERVED";
    entry.claimedByOperationID = owner;
    entry.claimedAt ??= stamp;
    entry.lastHeartbeat = stamp;
    entry.leaseExpiresAt = stamp + leaseMs;
    return { acquired: true, reason: null, target: publicEntry(entry) };
  }

  function heartbeat(operationID, key) {
    const entry = entries.get(String(key));
    if (!entry) return false;
    expire(entry);
    if (entry.claimedByOperationID !== text(operationID)) return false;
    const stamp = now();
    entry.lastHeartbeat = stamp;
    entry.leaseExpiresAt = stamp + leaseMs;
    return true;
  }

  function activate(operationID, key) {
    const entry = entries.get(String(key));
    if (!entry) return false;
    expire(entry);
    if (entry.claimedByOperationID !== text(operationID)) return false;
    entry.state = "ACTIVE";
    heartbeat(operationID, key);
    return true;
  }

  function markDepleted(operationID, key, evidence, draining = false) {
    const entry = entries.get(String(key));
    if (!entry) return false;
    expire(entry);
    if (entry.claimedByOperationID !== text(operationID)) return false;
    entry.depletionEvidence = evidence && typeof evidence === "object" ? { ...evidence } : { source: "observed" };
    entry.depletedAt = now();
    entry.state = draining ? "DRAINING" : "DEPLETED";
    if (!draining) {
      entry.claimedByOperationID = null;
      entry.claimedAt = null;
      entry.lastHeartbeat = null;
      entry.leaseExpiresAt = null;
    } else {
      heartbeat(operationID, key);
    }
    return true;
  }

  function finishDraining(operationID, key) {
    const entry = entries.get(String(key));
    if (!entry) return false;
    expire(entry);
    if (entry.claimedByOperationID !== text(operationID)) return false;
    entry.state = entry.depletionEvidence === null ? "AVAILABLE" : "DEPLETED";
    entry.claimedByOperationID = null;
    entry.claimedAt = null;
    entry.lastHeartbeat = null;
    entry.leaseExpiresAt = null;
    return true;
  }

  function releaseOperation(operationID) {
    const owner = text(operationID);
    let released = 0;
    for (const entry of entries.values()) {
      expire(entry);
      if (entry.claimedByOperationID !== owner) continue;
      entry.claimedByOperationID = null;
      entry.claimedAt = null;
      entry.lastHeartbeat = null;
      entry.leaseExpiresAt = null;
      entry.state = entry.depletionEvidence === null ? "AVAILABLE" : "DEPLETED";
      released += 1;
    }
    return released;
  }

  function clearDepleted(key) {
    const entry = entries.get(String(key));
    if (!entry || entry.depletionEvidence === null) return false;
    entry.depletionEvidence = null;
    entry.depletedAt = null;
    if (entry.claimedByOperationID === null) entry.state = "AVAILABLE";
    return true;
  }

  function list() {
    return [...entries.values()]
      .map((entry) => publicEntry(expire(entry)))
      .sort((a, b) => a.targetKey.localeCompare(b.targetKey));
  }

  return {
    reserve,
    activate,
    heartbeat,
    markDepleted,
    finishDraining,
    releaseOperation,
    clearDepleted,
    get,
    list,
    leaseMs,
  };
}

module.exports = { createMiningTargetBoard, targetKey, DEFAULT_CLAIM_LEASE_MS };
