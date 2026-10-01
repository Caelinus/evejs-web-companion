import test from "node:test";
import assert from "node:assert/strict";
import { confirmControlledDronesHome, controlledFlightSettled, type ControlledDroneStopRow } from "./controlledDroneStop.ts";

function row(itemID: number, activity: string | null): ControlledDroneStopRow {
  return { itemID, controlled: true, activity };
}
test("support settlement ignores confirmed disconnected drones but retains unknown or controlled flight", () => {
  assert.equal(controlledFlightSettled([]), true);
  assert.equal(controlledFlightSettled([{ itemID: 8, controlled: false, activity: "idle" }]), true);
  for (const raw of [null, {}, [row(8, "returning")], [{ itemID: 8 }],
    [{ itemID: 8, controlled: 0 }], [{ itemID: 0, controlled: false }],
    [{ itemID: 8, controlled: false }, { itemID: 8, controlled: false }]]) {
    assert.equal(controlledFlightSettled(raw), false);
  }
});

test("an authoritative empty flight stops without recall or waiting", async () => {
  let recalls = 0;
  let waits = 0;
  await confirmControlledDronesHome({
    read: async () => [], recall: async () => { recalls += 1; },
    sleep: async () => { waits += 1; }, now: () => 0, deadlineMs: 100,
  });
  assert.equal(recalls, 0);
  assert.equal(waits, 0);
});

for (const role of ["mining", "combat"] as const) {
  test(`${role} flight recall waits for authoritative empty state`, async () => {
    const reads: (readonly ControlledDroneStopRow[] | null)[] = [
      [row(8, role === "mining" ? "mining" : "engaging")], [row(8, "returning")], [],
    ];
    const orders: number[][] = [];
    await confirmControlledDronesHome({
      read: async () => reads.shift() ?? [],
      recall: async (ids) => { orders.push([...ids]); },
      sleep: async () => {}, now: () => 0, deadlineMs: 100,
    });
    assert.deepEqual(orders, [[8]]);
    assert.equal(reads.length, 0, "a sent order alone did not complete Stop");
  });
}

test("already returning drones are observed without another recall", async () => {
  const reads = [[row(9, "returning")], []];
  let recalls = 0;
  await confirmControlledDronesHome({
    read: async () => reads.shift() ?? [], recall: async () => { recalls += 1; },
    sleep: async () => {}, now: () => 0, deadlineMs: 100,
  });
  assert.equal(recalls, 0);
});

test("unreadable or unconfirmed flight fails closed within the observation bound", async () => {
  for (const read of [async () => null, async () => [row(10, "returning")]]) {
    let waits = 0;
    let clock = 0;
    await assert.rejects(confirmControlledDronesHome({
      read, recall: async () => {}, sleep: async (ms) => { waits += 1; clock += ms; },
      now: () => clock, deadlineMs: 4_500,
    }), /confirmed|paused/);
    assert.equal(waits, 3);
  }
});
