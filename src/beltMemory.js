"use strict";

// Shared, in-process belt memory for mining bots (goal: mine-ore-priority).
//
// WHY THIS EXISTS. A mining bot burns real time warping to a belt only to find
// it already stripped by another pilot (or by itself, an orbit ago). Belts
// have no stable cross-session id worth keying on — the entity id EVE hands
// out is grid-local and changes on every visit — so the only handle that
// survives is the NAME, and even that is only unambiguous within one solar
// system (two systems can each have a "Belt - 1"). Hence the two-level key:
// system name first, belt name second.
//
// SHARED, NOT PERSISTED. Every pilot running a mining bot on this BFF reports
// into the same memory, so pilot B skips a belt pilot A just cleared — but it
// lives only in this process's RAM. A restart forgets everything, which is
// intended: a belt repopulates over time, and nothing here claims to track
// that, so entries also expire on their own via `ttlMs`.
//
// PURE. No I/O, no timers of its own — `now` is injected so tests control the
// clock exactly, the same shape as src/accountCache.js.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // one hour

function normalizeName(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs]     How long a mark stays valid before it is
 *                                      treated as stale and dropped.
 * @param {() => number} [options.now] Clock injection, for tests.
 */
function createBeltMemory(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const now = typeof options.now === "function" ? options.now : Date.now;

  // systemName -> Map<beltName, { all: boolean, families: Set<number>, expiresAtMs: number }>
  const systems = new Map();

  function pruneSystem(beltMap) {
    const cutoff = now();
    for (const [beltName, entry] of beltMap) {
      if (entry.expiresAtMs <= cutoff) {
        beltMap.delete(beltName);
      }
    }
  }

  /**
   * Record that `beltName` in `systemName` was found dry — of everything
   * (`groupID` null) or of one ore family (`groupID` a positive type group).
   * Refreshes the belt's expiry regardless of which kind of mark this is.
   */
  function markDry(systemName, beltName, groupID) {
    const system = normalizeName(systemName);
    const belt = normalizeName(beltName);
    if (!system || !belt) {
      return;
    }
    let beltMap = systems.get(system);
    if (!beltMap) {
      beltMap = new Map();
      systems.set(system, beltMap);
    } else {
      pruneSystem(beltMap);
    }
    let entry = beltMap.get(belt);
    if (!entry) {
      entry = { all: false, families: new Set(), expiresAtMs: 0 };
      beltMap.set(belt, entry);
    }
    if (groupID === null || groupID === undefined) {
      entry.all = true;
    } else {
      const numeric = Number(groupID);
      if (Number.isSafeInteger(numeric) && numeric > 0) {
        entry.families.add(numeric);
      }
    }
    entry.expiresAtMs = now() + ttlMs;
  }

  /**
   * The belts known dry in `systemName` right now — stale entries (past their
   * ttl) are dropped as part of this read and never returned. Unknown systems
   * answer `[]`, never null: "nothing known" is a real, cheap answer here.
   */
  function dryBelts(systemName) {
    const system = normalizeName(systemName);
    if (!system) {
      return [];
    }
    const beltMap = systems.get(system);
    if (!beltMap) {
      return [];
    }
    pruneSystem(beltMap);
    if (beltMap.size === 0) {
      systems.delete(system);
      return [];
    }
    const rows = [];
    for (const [beltName, entry] of beltMap) {
      rows.push({ beltName, all: entry.all, families: Array.from(entry.families) });
    }
    return rows;
  }

  return { markDry, dryBelts };
}

module.exports = { createBeltMemory, DEFAULT_TTL_MS };
