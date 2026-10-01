import test from "node:test";
import assert from "node:assert/strict";
import { latchSupportEmergency, supportHandoff } from "./supportHandoff.ts";
test("run emergency survives first reducer binding, recovered/unknown health and fleet loss", () => {
  const pending = latchSupportEmergency(false, null, 0.1);
  assert.equal(pending, true);
  for (const health of [1, null]) assert.equal(latchSupportEmergency(pending, null, health), true);
  assert.equal(latchSupportEmergency(false, null, null), false);
  assert.equal(latchSupportEmergency(false, "emergency-health-floor", null), true);
});
test("emergency handoff requests Stop only after self, drones, services and custody settle", () => {
  for (const [selfSettled, localSettled] of [[false, false], [true, false], [false, true]]) {
    assert.deepEqual(supportHandoff("emergency-health-floor", selfSettled!, localSettled!), {
      phase: "BLOCKED", reason: "Support self-mining handoff: emergency-health-floor", requestEmergencyStop: false });
  }
  assert.equal(supportHandoff("emergency-health-floor", true, true)?.requestEmergencyStop, true);
});
test("full or resource handoff stays visible without inventing a logistics/Stop policy", () => {
  for (const reason of ["mining-hold-full", "no-reachable-resource"]) {
    assert.equal(supportHandoff(reason, true, true)?.phase, "DEGRADED");
    assert.equal(supportHandoff(reason, true, true)?.requestEmergencyStop, false);
  }
  assert.equal(supportHandoff(null, true, true), null);
});
