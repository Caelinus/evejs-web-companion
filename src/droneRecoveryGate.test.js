"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { reconnectCandidate, hasPendingRecovery, recoveryReadyProof, handoffFlightReady } = require("./droneRecoveryGate");

test("only locally owned disconnected drones are reconnect candidates", () => {
  assert.equal(reconnectCandidate({ ownerID: 42, controllerID: null }, 42), true);
  assert.equal(reconnectCandidate({ ownerID: 42, controllerID: 0 }, 42), true);
  assert.equal(reconnectCandidate({ ownerID: 42, controllerID: 50 }, 42), false);
  assert.equal(reconnectCandidate({ ownerID: 43, controllerID: null }, 42), false);
  assert.equal(reconnectCandidate({ ownerID: null, controllerID: null }, 42), null);
  assert.equal(reconnectCandidate({ ownerID: 42 }, 42), null);
});

test("server handoff blocks its held pilot until browser recovery is ready", () => {
  const held = { characterID: 42, droneRecoveryReady: false };
  assert.equal(hasPendingRecovery(held, 42), true);
  assert.equal(hasPendingRecovery(held, 1), false);
  assert.equal(hasPendingRecovery(null, 42), false);
  held.droneRecoveryReady = true;
  assert.equal(hasPendingRecovery(held, 42), false);
});

test("a ready ACK needs fresh readable absence of lost and previously seen drones", () => {
  assert.equal(recoveryReadyProof(null, new Set()), false);
  assert.equal(recoveryReadyProof([{ itemID: 7, reconnectCandidate: null }], new Set()), false);
  assert.equal(recoveryReadyProof([{ itemID: 7, reconnectCandidate: true }], new Set()), false);
  assert.equal(recoveryReadyProof([{ itemID: 7, reconnectCandidate: false }], new Set([7])), false);
  assert.equal(recoveryReadyProof([], new Set([7])), true);
  assert.equal(recoveryReadyProof([{ itemID: 8, reconnectCandidate: false }], new Set([7])), true,
    "an unrelated connected flight is not a lost-drone recovery target");
});

test("browser-to-hosted handoff retains a controlled flight until authoritative return", () => {
  assert.equal(handoffFlightReady(null), false);
  assert.equal(handoffFlightReady([{ itemID: 7, controlled: true, activity: "returning" }]), false);
  assert.equal(handoffFlightReady([{ itemID: 7, controlled: null }]), false);
  assert.equal(handoffFlightReady([{ itemID: 7, controlled: false }]), true);
  assert.equal(handoffFlightReady([]), true);
});
