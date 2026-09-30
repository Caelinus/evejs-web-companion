"use strict";

const LOCATION_MAX_AGE_MS = 15_000;
const positionValid = p => p != null && [p.x, p.y, p.z].every(Number.isFinite);
const keyOf = c => `${c.targetType}:${c.systemID}:${c.siteIdentity || c.targetName}`;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Eligible candidates only; the caller still reserves atomically. No affinity,
// persisted coordinates, world reads or hauler contribution.
function rankMiningCandidates(candidates, members, now) {
  const anchors = members.filter(m => m.role === "MINER" &&
    ["STARTING", "starting", "RUNNING", "running", "READY_FOR_RENDEZVOUS"].includes(m.runtimeState) &&
    m.location && now >= m.location.observedAt && now - m.location.observedAt <= LOCATION_MAX_AGE_MS &&
    positionValid(m.location.position));
  const usable = candidates.length > 0 && candidates.every(c => positionValid(c.position) && anchors.some(m => m.location.systemID === c.systemID));
  return candidates.map(candidate => {
    const distances = usable ? anchors.filter(m => m.location.systemID === candidate.systemID)
      .map(m => Math.hypot(m.location.position.x - candidate.position.x, m.location.position.y - candidate.position.y, m.location.position.z - candidate.position.z)) : [];
    const score = distances.length ? median(distances) : null;
    return { candidate, key: keyOf(candidate), medianDistanceM: score,
      anchorCount: distances.length, reason: score === null ? "DETERMINISTIC_NO_FRESH_LOCALITY" : score < 150_000 ? "MAIN_BODY_AT_TARGET" : "MEDIAN_MAIN_BODY_DISTANCE" };
  }).sort((a, b) => (usable ? (a.medianDistanceM ?? 0) - (b.medianDistanceM ?? 0)
    : a.candidate.targetName.localeCompare(b.candidate.targetName)) || a.key.localeCompare(b.key));
}

module.exports = { LOCATION_MAX_AGE_MS, positionValid, keyOf, rankMiningCandidates };
