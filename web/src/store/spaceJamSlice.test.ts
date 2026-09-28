import test from "node:test";
import assert from "node:assert/strict";

import { createClientStore } from "./clientStore.ts";
import { decodeJamNotification } from "../bridge/jamNotifications.ts";
import type { SpaceSnapshot } from "./types.ts";

const AGGRESSOR = 9001;
const AGGRESSOR_MODULE = 9002;
const MY_SHIP = 90000001;

const SNAPSHOT: SpaceSnapshot = {
  inSpace: true,
  solarSystemID: 30000142,
  shipID: MY_SHIP,
  sampledAtMs: 1_000,
  entities: [],
  ship: null,
};

function jam(method: "OnJamStart" | "OnJamEnd", receivedAtMs: number) {
  const event = decodeJamNotification(
    method,
    [AGGRESSOR, AGGRESSOR_MODULE, MY_SHIP, "warpScrambler", 0, 5_000],
    receivedAtMs,
  );
  assert.notEqual(event, null);
  return event!;
}

test("the space slice starts with no jams", () => {
  const store = createClientStore();
  assert.deepEqual([...store.space.get().jams], []);
});

test("a jam start lands on the slice and a jam end takes it off again", () => {
  const store = createClientStore();
  store.apply({ type: "space/jam", event: jam("OnJamStart", 1_000) });
  assert.equal(store.space.get().jams.length, 1);
  assert.equal(store.space.get().jams[0]?.sourceBallID, AGGRESSOR);

  store.apply({ type: "space/jam", event: jam("OnJamEnd", 2_000) });
  assert.deepEqual([...store.space.get().jams], []);
});

// ⚠ THE REGRESSION THIS SLICE EXISTS TO AVOID. The jams are folded from pushes
// that arrive on their own schedule; the snapshot poll runs about once a
// second. A `space/snapshot` that rebuilt the slice wholesale would wipe a live
// scram every poll, and the tackle rung would see an empty set on most ticks.
test("a snapshot read does NOT wipe a standing jam", () => {
  const store = createClientStore();
  store.apply({ type: "space/jam", event: jam("OnJamStart", 1_000) });
  store.apply({ type: "space/snapshot", snapshot: SNAPSHOT });

  assert.equal(store.space.get().loaded, true);
  assert.equal(store.space.get().jams.length, 1, "the snapshot poll must not clear the jams");
});

// Docking is the one place a wipe is right: a docked ship is not being
// scrambled by anything, and `space/cleared` is what fires on a dock.
test("clearing the space slice clears the jams with it", () => {
  const store = createClientStore();
  store.apply({ type: "space/jam", event: jam("OnJamStart", 1_000) });
  store.apply({ type: "space/cleared" });
  assert.deepEqual([...store.space.get().jams], []);
});

// The slice keeps what the wire said and never expires anything itself — the
// same split `lastBroadcast` and `isFleetBroadcastFresh` make on the fleet
// slice. A reader asks `isJamLive` when it wants to know.
test("the slice does not expire a lapsed jam on its own", () => {
  const store = createClientStore();
  store.apply({ type: "space/jam", event: jam("OnJamStart", 1_000) });
  store.apply({ type: "space/snapshot", snapshot: SNAPSHOT });
  assert.equal(store.space.get().jams.length, 1);
  assert.equal(store.space.get().jams[0]?.receivedAtMs, 1_000);
});
