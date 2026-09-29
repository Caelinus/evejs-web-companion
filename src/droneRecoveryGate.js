"use strict";

// The gateway's current-scene drone projection carries ownerID and
// controllerID. Null controller means disconnected; any positive controller
// is a connected flight (possibly another hull) and must not be recovered.
function reconnectCandidate(row, characterID) {
  if (!Number.isSafeInteger(row.ownerID) ||
      !(row.controllerID === null || Number.isSafeInteger(row.controllerID))) return null;
  return characterID > 0 && row.ownerID === characterID &&
    (row.controllerID === null || row.controllerID === 0);
}

function hasPendingRecovery(held, characterID) {
  return !!held && Number(held.characterID) === characterID && !held.droneRecoveryReady;
}

// A client ACK is never evidence of return. The final fresh scene must be
// readable, contain no recoverable candidate, and contain none of the IDs
// previously seen disconnected on this held session.
function recoveryReadyProof(rows, seenIDs) {
  return Array.isArray(rows) && seenIDs instanceof Set && rows.every((row) =>
    row && row.reconnectCandidate === false && !seenIDs.has(row.itemID));
}

// Releasing a browser session disconnects its controlled flight. Even a pilot
// with no LOST drones must first return an ordinary active flight before the
// hosted bot may take over. Unknown authority is not an empty flight.
function handoffFlightReady(rows) {
  return Array.isArray(rows) && rows.every((row) => row && row.controlled === false);
}

module.exports = { reconnectCandidate, hasPendingRecovery, recoveryReadyProof, handoffFlightReady };
