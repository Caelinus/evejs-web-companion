"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createLootMemory, CONTAINER_LEASE_MS } = require("../src/lootMemory");

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

test("active claims exclude another run, renew their owner, and expire after five minutes", () => {
  const clock = fakeClock();
  const memory = createLootMemory({ now: clock.now });
  assert.equal(memory.claimContainer("session-a", "run-1", SYSTEM, 9001), true);
  assert.equal(memory.claimContainer("session-b", "run-2", SYSTEM, 9001), false);
  assert.deepEqual(memory.claimedItemIDs(SYSTEM, "session-b", "run-2"), [9001]);
  assert.deepEqual(memory.claimedItemIDs(SYSTEM, "session-a", "run-1"), []);
  clock.advance(CONTAINER_LEASE_MS - 1);
  assert.equal(memory.claimContainer("session-a", "run-1", SYSTEM, 9001, true), true);
  clock.advance(CONTAINER_LEASE_MS - 1);
  assert.equal(memory.claimContainer("session-b", "run-2", SYSTEM, 9001), false);
  clock.advance(2);
  assert.equal(memory.claimContainer("session-b", "run-2", SYSTEM, 9001), true);
  assert.equal(memory.claimContainer("session-a", "run-1", SYSTEM, 9001, true), false);
});

test("claim identity includes system and release is scoped to authenticated session and generation", () => {
  const memory = createLootMemory();
  assert.equal(memory.claimContainer("a", "old", SYSTEM, 9001), true);
  assert.equal(memory.claimContainer("b", "run", OTHER_SYSTEM, 9001), true);
  memory.releaseClaims("a", "new");
  assert.equal(memory.claimContainer("c", "run", SYSTEM, 9001), false);
  memory.releaseClaims("a", "old");
  assert.equal(memory.claimContainer("c", "run", SYSTEM, 9001), true);
  assert.equal(memory.claimContainer("c", "run", OTHER_SYSTEM, 9001), false);
});

test("stop or session cleanup cannot release an issued transfer before it settles", () => {
  const clock = fakeClock();
  const memory = createLootMemory({ now: clock.now });
  memory.claimContainer("a", "run", SYSTEM, 9001);
  assert.equal(memory.beginTransfer("a", "run", SYSTEM, 9001), true);
  memory.releaseClaims("a");
  assert.equal(memory.claimContainer("b", "run", SYSTEM, 9001), false);
  memory.endTransfer("a", "run", SYSTEM, 9001, true);
  assert.equal(memory.claimContainer("b", "run", SYSTEM, 9001), true);
});

test("an unobservable issued transfer retains exclusivity only through bounded lease", () => {
  const clock = fakeClock();
  const memory = createLootMemory({ now: clock.now });
  memory.claimContainer("a", "run", SYSTEM, 9001);
  memory.beginTransfer("a", "run", SYSTEM, 9001);
  memory.releaseClaims("a");
  memory.endTransfer("a", "run", SYSTEM, 9001, false);
  assert.equal(memory.claimContainer("b", "run", SYSTEM, 9001), false);
  clock.advance(CONTAINER_LEASE_MS);
  assert.equal(memory.claimContainer("b", "run", SYSTEM, 9001), true);
});

test("renewing a pinned transfer preserves its stop hold and ambiguous outcome", () => {
  const clock = fakeClock();
  const memory = createLootMemory({ now: clock.now });
  assert.equal(memory.claimContainer("a", "run", SYSTEM, 9001), true);
  assert.equal(memory.beginTransfer("a", "run", SYSTEM, 9001), true);
  assert.equal(memory.claimContainer("a", "run", SYSTEM, 9001, true), true);
  memory.releaseClaims("a", "run");
  assert.equal(memory.claimContainer("b", "run", SYSTEM, 9001), false);
  memory.endTransfer("a", "run", SYSTEM, 9001, false);
  assert.equal(memory.claimContainer("a", "run", SYSTEM, 9001, true), false,
    "uncertain transfer cannot be renewed into a releasable claim");
  memory.releaseClaims("a", "run");
  assert.equal(memory.claimContainer("b", "run", SYSTEM, 9001), false);
  clock.advance(CONTAINER_LEASE_MS);
  assert.equal(memory.claimContainer("b", "run", SYSTEM, 9001), true);
});
