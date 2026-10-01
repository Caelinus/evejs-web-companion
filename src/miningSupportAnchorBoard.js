"use strict";

const { randomUUID } = require("crypto");

// Five ~2s runner ticks; a read never renews a publication. Stale diagnostics
// survive for another 20s, then disappear. No timers, persistence or game writes.
const FRESH_MS = 10_000;
const RETAIN_MS = 30_000;

function createMiningSupportAnchorBoard({ now = Date.now } = {}) {
  const entries = new Map();
  const epochs = new WeakMap();
  function sweep(stamp) {
    for (const [key, entry] of entries) {
      if (stamp >= entry.record.publishedAtMs + RETAIN_MS) entries.delete(key);
    }
  }
  function publish(owner, facts) {
    const stamp = now();
    sweep(stamp);
    let epoch = epochs.get(owner);
    if (!epoch || epoch.bridgeSessionID !== owner.bridgeSessionID || epoch.characterID !== owner.characterID || epoch.accountID !== owner.accountID) {
      epoch = { bridgeSessionID: owner.bridgeSessionID, characterID: owner.characterID, accountID: owner.accountID, value: randomUUID() };
      epochs.set(owner, epoch);
    }
    const previous = entries.get(`${facts.fleetID}:${owner.characterID}`);
    if (previous?.record.sessionEpoch === epoch.value && previous.record.shipID === facts.shipID
      && (facts.observedAtMs < previous.record.observedAtMs || facts.sampledAtMs < previous.record.sampledAtMs)) return null;
    // owner and facts are supplied ONLY by the route's fresh gateway reads.
    const record = { characterID: owner.characterID, shipID: facts.shipID,
      fleetID: facts.fleetID, solarSystemID: facts.solarSystemID,
      sessionEpoch: epoch.value, sampledAtMs: facts.sampledAtMs,
      observedAtMs: facts.observedAtMs, publishedAtMs: stamp, expiresAtMs: facts.observedAtMs + FRESH_MS,
      services: structuredClone(facts.services) };
    entries.set(`${record.fleetID}:${record.characterID}`, {
      owner, bridgeSessionID: owner.bridgeSessionID, accountID: owner.accountID, record,
    });
    return structuredClone({ ...record, freshness: "fresh", reason: null, ageMs: 0 });
  }
  function read(fleet, isCurrentOwner) {
    const stamp = now();
    sweep(stamp);
    const anchors = [];
    for (const { owner, bridgeSessionID, accountID, record } of entries.values()) {
      if (record.fleetID !== fleet.fleetID) continue;
      const member = fleet.members.find(row => row.characterID === record.characterID);
      const invalid = !isCurrentOwner(owner) || owner.bridgeSessionID !== bridgeSessionID || owner.characterID !== record.characterID || owner.accountID !== accountID ? "session-changed"
        : owner.activeShipID !== record.shipID ? "ship-changed"
        : !member || owner.fleetID !== record.fleetID ? "fleet-changed"
        : member.solarSystemID !== null && member.solarSystemID !== record.solarSystemID ? "system-changed" : null;
      const stale = stamp < record.publishedAtMs || stamp >= record.expiresAtMs;
      anchors.push(structuredClone({ ...record, ageMs: Math.max(0, stamp - record.publishedAtMs),
        freshness: invalid ? "invalid" : stale ? "stale" : "fresh", reason: invalid ?? (stale ? "expired" : null) }));
    }
    anchors.sort((a, b) => a.characterID - b.characterID);
    return { availability: "available", reason: null, readAtMs: stamp, fleet, anchors };
  }
  function release(owner) {
    for (const [key, entry] of entries) if (entry.owner === owner && entry.bridgeSessionID === owner.bridgeSessionID && entry.accountID === owner.accountID) entries.delete(key);
  }
  return { publish, read, release, now, freshMs: FRESH_MS };
}

module.exports = { createMiningSupportAnchorBoard, FRESH_MS, RETAIN_MS };
