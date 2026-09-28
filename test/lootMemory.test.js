"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLootMemory } = require("../src/lootMemory");

const SYSTEM = 30000144;
const OTHER_SYSTEM = 30000142;

function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
  };
}

test("an emptied can is reported back for its system", () => {
  const memory = createLootMemory({ now: fakeClock().now });
  memory.markEmptied(SYSTEM, 9001);

  assert.deepEqual(memory.emptiedItemIDs(SYSTEM), [9001]);
});

test("repeat marks are one id, not two", () => {
  const memory = createLootMemory({ now: fakeClock().now });
  memory.markEmptied(SYSTEM, 9001);
  memory.markEmptied(SYSTEM, 9001);

  assert.deepEqual(memory.emptiedItemIDs(SYSTEM), [9001]);
});

test("systems are kept apart", () => {
  const memory = createLootMemory({ now: fakeClock().now });
  memory.markEmptied(SYSTEM, 9001);
  memory.markEmptied(OTHER_SYSTEM, 9002);

  assert.deepEqual(memory.emptiedItemIDs(SYSTEM), [9001]);
  assert.deepEqual(memory.emptiedItemIDs(OTHER_SYSTEM), [9002]);
});

test("an unknown system reads as an empty list, never null", () => {
  const memory = createLootMemory({ now: fakeClock().now });
  assert.deepEqual(memory.emptiedItemIDs(404), []);
});

test("marks expire on read once past their ttl", () => {
  const clock = fakeClock();
  const memory = createLootMemory({ now: clock.now, ttlMs: 1_000 });
  memory.markEmptied(SYSTEM, 9001);

  clock.advance(500);
  assert.deepEqual(memory.emptiedItemIDs(SYSTEM), [9001], "still fresh at half the ttl");

  clock.advance(600);
  assert.deepEqual(memory.emptiedItemIDs(SYSTEM), [], "stale past the ttl");
});

test("a fresh mark on a stale id refreshes its expiry", () => {
  const clock = fakeClock();
  const memory = createLootMemory({ now: clock.now, ttlMs: 1_000 });
  memory.markEmptied(SYSTEM, 9001);

  clock.advance(1_500); // now stale
  memory.markEmptied(SYSTEM, 9001);

  clock.advance(500);
  assert.deepEqual(memory.emptiedItemIDs(SYSTEM), [9001]);
});

test("ids that are not positive integers are ignored, and so are blank systems", () => {
  const memory = createLootMemory({ now: fakeClock().now });
  memory.markEmptied(SYSTEM, 0);
  memory.markEmptied(SYSTEM, -3);
  memory.markEmptied(SYSTEM, 1.5);
  memory.markEmptied(SYSTEM, "nonsense");
  memory.markEmptied(0, 9001);
  memory.markEmptied(null, 9001);

  assert.deepEqual(memory.emptiedItemIDs(SYSTEM), []);
  assert.deepEqual(memory.emptiedItemIDs(0), []);
});

test("a numeric string id is accepted — the routes hand over query strings", () => {
  const memory = createLootMemory({ now: fakeClock().now });
  memory.markEmptied("30000144", "9001");

  assert.deepEqual(memory.emptiedItemIDs("30000144"), [9001]);
});

test("one system's list is capped, oldest first", () => {
  const memory = createLootMemory({ now: fakeClock().now, maxPerSystem: 3 });
  memory.markEmptied(SYSTEM, 1);
  memory.markEmptied(SYSTEM, 2);
  memory.markEmptied(SYSTEM, 3);
  memory.markEmptied(SYSTEM, 4);

  assert.deepEqual(memory.emptiedItemIDs(SYSTEM), [2, 3, 4], "the oldest mark is the one dropped");
});

test("a re-marked id is young again, so the cap drops something else", () => {
  const memory = createLootMemory({ now: fakeClock().now, maxPerSystem: 3 });
  memory.markEmptied(SYSTEM, 1);
  memory.markEmptied(SYSTEM, 2);
  memory.markEmptied(SYSTEM, 3);
  memory.markEmptied(SYSTEM, 1); // confirmed again: must not be the next eviction
  memory.markEmptied(SYSTEM, 4);

  assert.deepEqual(memory.emptiedItemIDs(SYSTEM), [3, 1, 4]);
});
