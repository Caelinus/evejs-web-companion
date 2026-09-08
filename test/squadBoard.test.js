"use strict";

// The squad board: one standing call per fleet, keyed by an exact fleet id,
// gone the moment it goes stale. Pins the three things a follower's behaviour
// hangs on — last call wins, a lapsed call reads as NO call (so the follower
// falls back to its own ladder), and one fleet never sees another's.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSquadBoard, DEFAULT_TTL_MS } = require("../src/squadBoard");

const FLEET = 654500010000; // a fleet id is large — this is the shape, not a real one
const OTHER_FLEET = 654500019999;
const FC = 90000001;
const WING = 90000002;

function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
  };
}

test("a called primary reads back, with who called it", () => {
  const board = createSquadBoard({ now: fakeClock().now });
  assert.deepEqual(board.call(FLEET, 1001, FC), { targetID: 1001, calledByCharacterID: FC });
  assert.deepEqual(board.primary(FLEET), { targetID: 1001, calledByCharacterID: FC });
});

test("nobody has called anything yet, and that is not an error", () => {
  const board = createSquadBoard({ now: fakeClock().now });
  assert.equal(board.primary(FLEET), null);
});

test("the last call wins — the FC is whoever spoke most recently", () => {
  const board = createSquadBoard({ now: fakeClock().now });
  board.call(FLEET, 1001, FC);
  board.call(FLEET, 1002, WING);
  assert.deepEqual(board.primary(FLEET), { targetID: 1002, calledByCharacterID: WING });
});

test("a call lapses, and a lapsed call reads as NO call", () => {
  const clock = fakeClock();
  const board = createSquadBoard({ ttlMs: 30_000, now: clock.now });
  board.call(FLEET, 1001, FC);

  clock.advance(29_000);
  assert.deepEqual(board.primary(FLEET), { targetID: 1001, calledByCharacterID: FC });

  clock.advance(2_000);
  assert.equal(board.primary(FLEET), null, "a stale call must not keep guns on a dead ship");
});

test("re-calling the same target refreshes the call", () => {
  const clock = fakeClock();
  const board = createSquadBoard({ ttlMs: 30_000, now: clock.now });
  board.call(FLEET, 1001, FC);
  clock.advance(25_000);
  board.call(FLEET, 1001, FC);
  clock.advance(25_000);
  assert.deepEqual(board.primary(FLEET), { targetID: 1001, calledByCharacterID: FC });
});

test("clearing drops the call, and clearing nothing is not an error", () => {
  const board = createSquadBoard({ now: fakeClock().now });
  board.call(FLEET, 1001, FC);
  assert.equal(board.clear(FLEET), true);
  assert.equal(board.primary(FLEET), null);
  assert.equal(board.clear(FLEET), false);
});

test("one fleet never sees another's call", () => {
  const board = createSquadBoard({ now: fakeClock().now });
  board.call(FLEET, 1001, FC);
  assert.equal(board.primary(OTHER_FLEET), null);
});

test("a fleet id keyed as a string and as a number are the same fleet", () => {
  const board = createSquadBoard({ now: fakeClock().now });
  board.call(String(FLEET), 1001, FC);
  assert.deepEqual(board.primary(FLEET), { targetID: 1001, calledByCharacterID: FC });
  // And an id too large for a Number keeps working, because it is never coerced.
  const huge = "9007199254740993000";
  board.call(huge, 1002, FC);
  assert.deepEqual(board.primary(huge), { targetID: 1002, calledByCharacterID: FC });
});

test("a call with no fleet, or no target, is dropped rather than stored", () => {
  const board = createSquadBoard({ now: fakeClock().now });
  board.call(FLEET, 1001, FC);
  assert.equal(board.call(0, 1002, FC), null, "fleetless: there is nobody to tell");
  assert.equal(board.call(FLEET, 0, FC), null);
  assert.equal(board.call(FLEET, -5, FC), null);
  assert.equal(board.call(FLEET, 1.5, FC), null);
  assert.deepEqual(
    board.primary(FLEET),
    { targetID: 1001, calledByCharacterID: FC },
    "a bad call must not displace the good one standing",
  );
});

test("an unknown caller is recorded as unknown, not invented", () => {
  const board = createSquadBoard({ now: fakeClock().now });
  board.call(FLEET, 1001, null);
  assert.deepEqual(board.primary(FLEET), { targetID: 1001, calledByCharacterID: null });
});

test("the shipped ttl is a fight, not an hour", () => {
  assert.ok(DEFAULT_TTL_MS >= 10_000 && DEFAULT_TTL_MS <= 60_000, `ttl is ${DEFAULT_TTL_MS}ms`);
});
