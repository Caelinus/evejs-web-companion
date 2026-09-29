import test from "node:test";
import assert from "node:assert/strict";
import { recoverLostDroneFlight, readRecoveryDrones, type RecoveryDrone, type DroneRecoveryState } from "./lostDroneRecovery.ts";

const lost = (id: number): RecoveryDrone => ({ itemID: id, controlled: false, reconnectCandidate: true, activity: "idle" });
const flown = (id: number, activity = "idle"): RecoveryDrone => ({ itemID: id, controlled: true, reconnectCandidate: false, activity });

function harness(options: { inSpace?: boolean | null; drones?: readonly RecoveryDrone[] | null;
  reconnectFails?: boolean; unreadableAfterReconnect?: boolean; neverReturns?: boolean;
  disconnectOnRecall?: boolean; skipReconnectID?: number } = {}) {
  let drones = options.drones === undefined ? [] : options.drones;
  const calls: string[] = [];
  const states: DroneRecoveryState[] = [];
  const pendingIDs = new Set<number>();
  const confirmedIDs = new Set<number>();
  let reconnectDone = false;
  return {
    calls, states, pendingIDs,
    run: () => recoverLostDroneFlight({
      inSpace: async () => { calls.push("flight"); return options.inSpace === undefined ? true : options.inSpace; },
      read: async () => { calls.push("read"); return reconnectDone && options.unreadableAfterReconnect ? null : drones; },
      reconnect: async ids => {
        calls.push(`reconnect:${ids.join(",")}`);
        if (options.reconnectFails) throw new Error("Reconnect refused");
        reconnectDone = true;
        drones = drones?.map(drone => ids.includes(drone.itemID) ? flown(drone.itemID) : drone) ?? null;
        if (options.skipReconnectID !== undefined) drones = drones?.map(drone =>
          drone.itemID === options.skipReconnectID ? lost(drone.itemID) : drone) ?? null;
      },
      recall: async ids => {
        calls.push(`recall:${ids.join(",")}`);
        if (options.disconnectOnRecall) drones = drones?.map(drone =>
          ids.includes(drone.itemID) ? lost(drone.itemID) : drone) ?? null;
        else if (!options.neverReturns) drones = drones?.filter(drone => !ids.includes(drone.itemID)) ?? null;
      },
      sleep: async () => {},
      pendingIDs,
      confirmedIDs,
      report: state => { states.push(state); },
    }),
  };
}

test("docked pilot does not scan drones; empty in-space flight is ready", async () => {
  const docked = harness({ inSpace: false });
  await docked.run();
  assert.deepEqual(docked.calls, ["flight"]);
  assert.equal(docked.states.at(-1)?.phase, "ready");
  const empty = harness();
  await empty.run();
  assert.deepEqual(empty.calls, ["flight", "read"]);
  assert.equal(empty.states.at(-1)?.phase, "ready");
});

for (const role of ["mining", "combat"] as const) {
  test(`${role} lost flight reconnects, confirms control, recalls, confirms empty`, async () => {
    const h = harness({ drones: [lost(1), lost(2)] });
    await h.run();
    assert.deepEqual(h.calls.filter(call => call.startsWith("reconnect") || call.startsWith("recall")),
      ["reconnect:1,2", "recall:1,2"]);
    assert.equal(h.states.at(-1)?.phase, "ready");
    assert.equal(h.pendingIDs.size, 0);
  });
}

test("already-connected normal flight is untouched", async () => {
  const h = harness({ drones: [flown(1)] });
  await h.run();
  assert.deepEqual(h.calls, ["flight", "read"]);
  assert.equal(h.states.at(-1)?.phase, "ready");
});

test("unreadable candidate flag, unreadable snapshot and reconnect refusal fail closed", async () => {
  assert.equal(readRecoveryDrones([{ itemID: 1, controlled: false }]), null);
  await assert.rejects(harness({ drones: null }).run(), /could not be read/);
  await assert.rejects(harness({ drones: [lost(1)], reconnectFails: true }).run(), /Reconnect refused/);
  await assert.rejects(harness({ drones: [lost(1)], unreadableAfterReconnect: true }).run(), /could not be confirmed/);
});

test("partial server reconnect never becomes a successful recovery", async () => {
  const h = harness({ drones: [lost(1), lost(2)], skipReconnectID: 2 });
  await assert.rejects(h.run(), /did not reconnect/);
  assert.equal(h.calls.some(call => call.startsWith("recall")), false);
});

test("unconfirmed return stays blocked; retry retains the recovered flight", async () => {
  const h = harness({ drones: [lost(1)], neverReturns: true });
  await assert.rejects(h.run(), /not been confirmed/);
  assert.deepEqual([...h.pendingIDs], [1]);
  await assert.rejects(h.run(), /not been confirmed/);
  assert.equal(h.calls.filter(call => call.startsWith("reconnect")).length, 1);
});

test("a recovered drone that disconnects during return is not a confirmed empty flight", async () => {
  const h = harness({ drones: [lost(1)], disconnectOnRecall: true });
  await assert.rejects(h.run(), /not been confirmed/);
  assert.deepEqual([...h.pendingIDs], [1]);
});

test("more than ten owned lost drones is an anomaly, not a batch reconnect", async () => {
  const h = harness({ drones: Array.from({ length: 11 }, (_, index) => lost(index + 1)) });
  await assert.rejects(h.run(), /More than 10/);
  assert.equal(h.calls.some(call => call.startsWith("reconnect")), false);
});
