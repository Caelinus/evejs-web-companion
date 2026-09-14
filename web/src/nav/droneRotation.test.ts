// Drone rotation — guarding the machine of §4 of docs/drone-boat-block-spec.md.
//
// The tidy cycle (notice, recall, bay, relaunch, idle) gets one test and is the
// least interesting thing in the file. The cases this module actually exists for
// are the ones where the machine could get STUCK or could fire on nothing:
//
//   * the trigger is `shieldRatio < 1`, and an UNREADABLE shield is not a low
//     one — a snapshot that never carries the ratio must not yank a drone off
//     the field every tick;
//   * ARMOUR damage under a full shield is history, not news, and rotating on it
//     would spend the whole cap in the first few ticks after the first scratch
//     (drone armour never comes back in space);
//   * a drone that DIES mid-rotation stops appearing in space and never appears
//     in the bay, and a machine that waits for it waits for the rest of the
//     site, silently;
//   * …but an UNREADABLE tick looks exactly like that absence and must not be
//     mistaken for it.
//
// The last test is the plain-JSON round trip, which is not decoration: the
// record lives in a step-memory slot, and a count keyed by a number instead of a
// string would come back under a different key and start again from zero — a cap
// that quietly stops capping.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEAD_DRONE_TICKS,
  MAX_DRONE_ROTATIONS,
  MAX_RECALL_TICKS,
  MAX_RELAUNCH_TICKS,
  decideDroneRotation,
  emptyDroneRotationMemory,
  readRotationMemory,
  rotationsSpent,
  type DroneRotationMemory,
  type DroneRotationStep,
  type RotationDrone,
} from "./droneRotation.ts";

/** A drone in space, healthy unless the test says otherwise. */
function drone(
  itemID: number,
  shieldRatio: number | null = 1,
  armorRatio: number | null = 1,
  hullRatio: number | null = 1,
): RotationDrone {
  return { itemID, shieldRatio, armorRatio, hullRatio };
}

/** One tick, with both lists readable unless a test hands in null. */
function tick(
  dronesInSpace: readonly RotationDrone[] | null,
  droneIDsInBay: readonly number[] | null,
  memory: unknown = undefined,
): DroneRotationStep {
  return decideDroneRotation({ dronesInSpace, droneIDsInBay, memory });
}

test("a shield that has started dropping triggers a recall of that one drone", () => {
  // 0.99, not 0.5. The whole point of the rule is that it is not a threshold:
  // the drone has begun taking damage and that is the entire signal.
  const step = tick([drone(1), drone(2, 0.99), drone(3)], []);
  assert.equal(step.action, "recall");
  assert.equal(step.itemID, 2);
  assert.equal(step.reason, "recalling");
  assert.equal(step.memory.active?.phase, "recalling");
  // Booked at the START of the rotation, not at the end — a rotation that fails
  // has still cost the block its actions.
  assert.equal(rotationsSpent(step.memory, 2), 1);
});

test("a flight at full shield is left alone", () => {
  const step = tick([drone(1), drone(2), drone(3)], []);
  assert.equal(step.action, "none");
  assert.equal(step.reason, "idle");
  assert.equal(step.memory.active, null);
});

test("an unreadable shield is not a low shield", () => {
  // ⚠ The three-state rule. A null layer is "that did not read", never "that is
  // at zero" — and the cost of getting it wrong here is a drone pulled off the
  // field on every single tick of a snapshot that simply never carries shields.
  const step = tick([drone(1, null), drone(2, null, 0.2, 0.5)], []);
  assert.equal(step.action, "none");
  assert.equal(step.reason, "idle");
});

test("armour and hull damage under a full shield is history, not a trigger", () => {
  // The decision, written down: drone armour does not repair in space, so
  // `armorRatio < 1` is true for the REST OF THE SITE from the first scratch.
  // Treating it as a trigger turns the trigger into a permanent condition — the
  // drone would be recalled again the tick after it came back, burning all three
  // of its rotations within six ticks and then being disqualified for good. A
  // shield below full is the live fact; a chewed armour bar on a full shield
  // means the drone survived something and is currently being left alone.
  const step = tick([drone(1, 1, 0.3, 0.8)], []);
  assert.equal(step.action, "none");
  assert.equal(step.reason, "idle");
  assert.equal(rotationsSpent(step.memory, 1), 0);
});

test("only one rotation is in flight at a time", () => {
  // Two drones losing shield at once. Rotating both would take half the flight's
  // damage off the grid for as long as both were travelling.
  const first = tick([drone(1, 0.9), drone(2, 0.5)], []);
  // Worst shield first, so drone 2.
  assert.equal(first.action, "recall");
  assert.equal(first.itemID, 2);

  const second = tick([drone(1, 0.9), drone(2, 0.5)], [], first.memory);
  assert.equal(second.action, "none");
  assert.equal(second.reason, "recalling");
  // And drone 1 has not quietly had a rotation booked against it while it waits.
  assert.equal(rotationsSpent(second.memory, 1), 0);
});

test("two drones on the same shield pick the same one every tick", () => {
  // A coin flip here would start a rotation on a different drone whenever the
  // list order changed underneath the rung.
  const a = tick([drone(7, 0.8), drone(3, 0.8)], []);
  const b = tick([drone(3, 0.8), drone(7, 0.8)], []);
  assert.equal(a.itemID, 3);
  assert.equal(b.itemID, 3);
});

test("the full cycle: notice, recall, fly home, relaunch, back in space, idle", () => {
  // Tick 1 — it starts losing shield.
  const t1 = tick([drone(1), drone(2, 0.97)], [], undefined);
  assert.deepEqual(
    [t1.action, t1.itemID, t1.reason],
    ["recall", 2, "recalling"],
  );

  // Tick 2 — still in space, flying home. NO second recall: the order is
  // standing on the server and re-issuing it would spend the tick's one action
  // on a call that changes nothing for the whole flight.
  const t2 = tick([drone(1), drone(2, 0.97)], [], t1.memory);
  assert.deepEqual([t2.action, t2.reason], ["none", "recalling"]);

  // Tick 3 — it is in the bay. Send it back out.
  const t3 = tick([drone(1)], [2], t2.memory);
  assert.deepEqual(
    [t3.action, t3.itemID, t3.reason],
    ["relaunch", 2, "relaunching"],
  );

  // Tick 4 — it is in space again. The rotation is over and the block's own
  // engage rung takes it from here.
  const t4 = tick([drone(1), drone(2, 0.97)], [], t3.memory);
  assert.deepEqual([t4.action, t4.reason], ["none", "complete"]);
  assert.equal(t4.memory.active, null);

  // Tick 5 — it is STILL losing shield, so it rotates again. Second of three.
  const t5 = tick([drone(1), drone(2, 0.97)], [], t4.memory);
  assert.deepEqual([t5.action, t5.itemID], ["recall", 2]);
  assert.equal(rotationsSpent(t5.memory, 2), 2);
});

test("a finished rotation does not also start the next one in the same tick", () => {
  // One world call per tick. A tick that completes a rotation reports it and
  // stops, even with another drone visibly hurt.
  const memory: DroneRotationMemory = {
    active: { itemID: 2, phase: "relaunching", waitTicks: 1, missingTicks: 0 },
    rotations: { "2": 1 },
  };
  const step = tick([drone(1, 0.4), drone(2)], [], memory);
  assert.equal(step.action, "none");
  assert.equal(step.reason, "complete");
});

test("the count survives the drone sitting in the bay", () => {
  // It is the same drone when it comes back, so forgetting its tally while it is
  // out of sight would hand it a fresh three on every trip home.
  const memory: DroneRotationMemory = {
    active: null,
    rotations: { "2": 2 },
  };
  const away = tick([drone(1)], [2], memory);
  assert.equal(rotationsSpent(away.memory, 2), 2);
  const back = tick([drone(1), drone(2, 0.5)], [], away.memory);
  assert.equal(back.action, "recall");
  assert.equal(rotationsSpent(back.memory, 2), 3);
});

test("three rotations per drone, and the fourth is ignored while others still rotate", () => {
  // Drone 2 has had its three: it is being focused, and a fourth rotation costs
  // more damage than the drone is worth. Drone 5 has had none.
  const spent: DroneRotationMemory = {
    active: null,
    rotations: { "2": MAX_DRONE_ROTATIONS },
  };

  // Alone, it is left out to die — and the readout says so rather than "idle",
  // which would be a lie about a drone that is about to be lost.
  const alone = tick([drone(2, 0.4)], [], spent);
  assert.equal(alone.action, "none");
  assert.equal(alone.reason, "capped");
  assert.equal(rotationsSpent(alone.memory, 2), MAX_DRONE_ROTATIONS);

  // ⚠ And the cap is PER DRONE: the capped one must not disable the rung. Drone
  // 5 is worse off (0.2 vs 0.4) and is the pick; even if it were not, drone 2 is
  // out of the running entirely.
  const others = tick([drone(2, 0.4), drone(5, 0.2)], [], spent);
  assert.equal(others.action, "recall");
  assert.equal(others.itemID, 5);

  // The capped drone does not win even when it is the more hurt of the two.
  const worse = tick([drone(2, 0.1), drone(5, 0.9)], [], spent);
  assert.equal(worse.action, "recall");
  assert.equal(worse.itemID, 5);
});

test("a drone that dies mid-rotation is dropped, not waited on for ever", () => {
  // ⚠ The wedge. A dead drone has no event of its own: it stops appearing in
  // space and never appears in the bay. A machine that waits for the bay waits
  // for the rest of the site, and no other drone can rotate meanwhile.
  const recalling: DroneRotationMemory = {
    active: { itemID: 2, phase: "recalling", waitTicks: 1, missingTicks: 0 },
    rotations: { "2": 1 },
  };

  // First absent tick: not yet a verdict — a drone that has just finished flying
  // home can be out of the space list one tick before it is in the bay list,
  // because the two are folded from different parts of the snapshot.
  const t1 = tick([drone(1)], [], recalling);
  assert.equal(t1.action, "none");
  assert.equal(t1.memory.active?.missingTicks, 1);
  assert.equal(t1.reason, "recalling");

  // Second absent tick: it is gone.
  const t2 = tick([drone(1)], [], t1.memory);
  assert.equal(t2.reason, "lost");
  assert.equal(t2.memory.active, null);
  assert.equal(DEAD_DRONE_TICKS, 2);

  // …and the machine is free again: another drone can rotate on the next tick.
  const t3 = tick([drone(1, 0.6)], [], t2.memory);
  assert.deepEqual([t3.action, t3.itemID], ["recall", 1]);
});

test("an unreadable tick is not a vanishing", () => {
  // ⚠ Absence is only evidence when both places were actually LOOKED AT. With
  // either list missing, "not in it" is a fact about the snapshot and not about
  // the drone — and writing drones off on that would lose a healthy one to a
  // single bad tick.
  const recalling: DroneRotationMemory = {
    active: { itemID: 2, phase: "recalling", waitTicks: 0, missingTicks: 1 },
    rotations: { "2": 1 },
  };

  // Space did not read.
  const noSpace = tick(null, [], recalling);
  assert.equal(noSpace.reason, "recalling");
  assert.equal(noSpace.memory.active?.itemID, 2);
  assert.equal(noSpace.memory.active?.missingTicks, 1);

  // The bay did not read.
  const noBay = tick([drone(1)], null, recalling);
  assert.equal(noBay.reason, "recalling");
  assert.equal(noBay.memory.active?.missingTicks, 1);

  // Neither read. Ten such ticks in a row still do not add up to a death.
  let memory: unknown = recalling;
  for (let i = 0; i < 10; i += 1) memory = tick(null, null, memory).memory;
  const still = tick(null, null, memory);
  assert.equal(still.memory.active?.itemID, 2);
  assert.notEqual(still.reason, "lost");

  // And the drone then turns up in the bay, exactly as it should have.
  const home = tick(null, [2], still.memory);
  assert.deepEqual([home.action, home.itemID], ["relaunch", 2]);
});

test("an unreadable space list never starts a rotation, and says so", () => {
  // "Nobody looked" and "everything is fine" are different sentences to the
  // player, and only one of them means the drones are all right.
  const step = tick(null, [], undefined);
  assert.equal(step.action, "none");
  assert.equal(step.reason, "unreadable");
  assert.equal(step.memory.active, null);
});

test("an empty space list is not the same as an unreadable one", () => {
  const step = tick([], [1, 2], undefined);
  assert.equal(step.reason, "idle");
});

test("a recall that never lands gives the machine back instead of wedging it", () => {
  // The drone is still in space and still shooting, which is a survivable
  // outcome; a rung frozen for the rest of the site is not.
  let memory: unknown = undefined;
  let step = tick([drone(2, 0.8)], [], memory);
  assert.equal(step.action, "recall");
  for (let i = 0; i < MAX_RECALL_TICKS - 1; i += 1) {
    step = tick([drone(2, 0.8)], [], step.memory);
    assert.equal(step.reason, "recalling");
  }
  step = tick([drone(2, 0.8)], [], step.memory);
  assert.equal(step.reason, "stalled");
  assert.equal(step.memory.active, null);
  // The rotation it spent is still booked against it — it cost the block its
  // actions whether or not the order landed.
  assert.equal(rotationsSpent(step.memory, 2), 1);
});

test("a launch that never lands gives the machine back too", () => {
  // The likely cause is bandwidth — something else went out while this drone was
  // away — and waiting longer does not fix bandwidth. Leaving it in the bay
  // hands it to the block's own launch rung.
  let step = tick([drone(1)], [2], {
    active: { itemID: 2, phase: "recalling", waitTicks: 0, missingTicks: 0 },
    rotations: { "2": 1 },
  });
  assert.equal(step.action, "relaunch");
  for (let i = 0; i < MAX_RELAUNCH_TICKS - 1; i += 1) {
    step = tick([drone(1)], [2], step.memory);
    assert.equal(step.reason, "relaunching");
  }
  step = tick([drone(1)], [2], step.memory);
  assert.equal(step.reason, "stalled");
  assert.equal(step.memory.active, null);
});

test("the record round-trips through plain JSON unchanged", () => {
  // ⚠ Not decoration. The record lives in a step-memory slot typed
  // `Readonly<Record<string, unknown>>` and may be serialised on the way; a
  // count keyed by a NUMBER would come back under a string key and the cap would
  // quietly start again from zero.
  const started = tick([drone(4, 0.5), drone(9, 0.7)], []);
  const waiting = tick([drone(4, 0.5), drone(9, 0.7)], [], started.memory);

  const wire = JSON.parse(JSON.stringify(waiting.memory)) as unknown;
  assert.deepEqual(wire, waiting.memory);
  // And it is still the same record after being read back in.
  assert.deepEqual(readRotationMemory(wire), waiting.memory);

  // The machine carries on across the round trip as if nothing had happened.
  const afterWire = tick([drone(9, 0.7)], [4], wire);
  assert.deepEqual([afterWire.action, afterWire.itemID], ["relaunch", 4]);

  // It is assignable to the step-memory slot's own type, which is why
  // DroneRotationMemory is a type alias and not an interface.
  const slot: Readonly<Record<string, unknown>> = waiting.memory;
  assert.equal(typeof slot, "object");
});

test("a mangled record degrades to an empty one instead of throwing", () => {
  // A throw in a bot rung is a run that stops, and the value in that slot has
  // been through `unknown` and possibly through JSON.
  assert.deepEqual(readRotationMemory(undefined), emptyDroneRotationMemory());
  assert.deepEqual(readRotationMemory("nonsense"), emptyDroneRotationMemory());
  assert.deepEqual(readRotationMemory({ active: 7, rotations: 3 }), {
    active: null,
    rotations: {},
  });
  // An active row naming no drone is not a rotation — keeping it would block
  // every future rotation while naming nothing to recall.
  assert.deepEqual(
    readRotationMemory({ active: { phase: "recalling" }, rotations: {} }),
    emptyDroneRotationMemory(),
  );
  // A row with an unknown phase is the same kind of corruption.
  assert.equal(
    readRotationMemory({ active: { itemID: 1, phase: "sulking" } }).active,
    null,
  );
  // Rubbish in the counts does not survive, and a real count does.
  assert.deepEqual(
    readRotationMemory({ rotations: { "2": "lots", "3": 2, "4": -1 } }).rotations,
    { "3": 2 },
  );
});

test("nothing ever comes out naming a drone we cannot call", () => {
  // Coarse sweep: whatever the snapshot hands in, an action always names a
  // finite itemID and a no-op always names none. A world call with a
  // meaningless argument is a much worse failure than a missed rotation.
  const shields: (number | null | unknown)[] = [
    1, 0.99, 0, -0.5, 1.0001, null, undefined, NaN, "0.5",
  ];
  const memories: unknown[] = [
    undefined,
    null,
    {},
    { active: null, rotations: {} },
    { active: { itemID: 2, phase: "recalling", waitTicks: 0, missingTicks: 0 } },
    { active: { itemID: 2, phase: "relaunching", waitTicks: 0, missingTicks: 0 } },
    { rotations: { "2": MAX_DRONE_ROTATIONS } },
  ];
  const bays: (readonly number[] | null)[] = [[], [2], [1, 2], null];

  for (const shield of shields) {
    for (const memory of memories) {
      for (const bay of bays) {
        const rows = [
          { itemID: 2, shieldRatio: shield, armorRatio: null, hullRatio: null },
          { itemID: undefined, shieldRatio: 0.5, armorRatio: 1, hullRatio: 1 },
        ] as unknown as readonly RotationDrone[];
        const step = tick(rows, bay, memory);
        if (step.action === "none") {
          assert.equal(step.itemID, null);
        } else {
          assert.equal(typeof step.itemID, "number");
          assert.ok(Number.isFinite(step.itemID as number));
        }
        // The record is always plain data the caller can hand straight back.
        assert.deepEqual(
          readRotationMemory(JSON.parse(JSON.stringify(step.memory))),
          step.memory,
        );
      }
    }
  }
});
