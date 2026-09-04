"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createBeltMemory } = require("../src/beltMemory");

function fakeClock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms;
    },
  };
}

test("marking a belt dry of everything reports all: true", () => {
  const memory = createBeltMemory({ now: fakeClock().now });
  memory.markDry("Jita", "Belt - 1", null);

  const rows = memory.dryBelts("Jita");
  assert.deepEqual(rows, [{ beltName: "Belt - 1", all: true, families: [] }]);
});

test("marking a belt dry of one ore family records that family only", () => {
  const memory = createBeltMemory({ now: fakeClock().now });
  memory.markDry("Jita", "Belt - 1", 465);

  const rows = memory.dryBelts("Jita");
  assert.deepEqual(rows, [{ beltName: "Belt - 1", all: false, families: [465] }]);
});

test("repeated family marks are deduped, and multiple families accumulate", () => {
  const memory = createBeltMemory({ now: fakeClock().now });
  memory.markDry("Jita", "Belt - 1", 465);
  memory.markDry("Jita", "Belt - 1", 465);
  memory.markDry("Jita", "Belt - 1", 18);

  const rows = memory.dryBelts("Jita");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].all, false);
  assert.deepEqual(rows[0].families.slice().sort((a, b) => a - b), [18, 465]);
});

test("a later 'all dry' mark upgrades a family-only entry", () => {
  const memory = createBeltMemory({ now: fakeClock().now });
  memory.markDry("Jita", "Belt - 1", 465);
  memory.markDry("Jita", "Belt - 1", null);

  const rows = memory.dryBelts("Jita");
  assert.equal(rows[0].all, true);
  assert.deepEqual(rows[0].families, [465]);
});

test("entries expire on read once past their ttl", () => {
  const clock = fakeClock();
  const memory = createBeltMemory({ now: clock.now, ttlMs: 1_000 });
  memory.markDry("Jita", "Belt - 1", null);

  clock.advance(500);
  assert.equal(memory.dryBelts("Jita").length, 1, "still fresh at half the ttl");

  clock.advance(600);
  assert.deepEqual(memory.dryBelts("Jita"), [], "stale past the ttl");
});

test("a fresh mark on an expired belt refreshes its expiry", () => {
  const clock = fakeClock();
  const memory = createBeltMemory({ now: clock.now, ttlMs: 1_000 });
  memory.markDry("Jita", "Belt - 1", null);

  clock.advance(1_500); // now stale
  memory.markDry("Jita", "Belt - 1", 465);

  clock.advance(500); // 500ms past the refresh, well under the ttl
  const rows = memory.dryBelts("Jita");
  assert.equal(rows.length, 1);
  // The stale mark's `all: true` is gone — a fresh entry was started on re-mark.
  assert.equal(rows[0].all, false);
  assert.deepEqual(rows[0].families, [465]);
});

test("two systems are kept apart even when belt names collide", () => {
  const memory = createBeltMemory({ now: fakeClock().now });
  memory.markDry("Jita", "Belt - 1", null);
  memory.markDry("Amarr", "Belt - 1", 465);

  assert.deepEqual(memory.dryBelts("Jita"), [{ beltName: "Belt - 1", all: true, families: [] }]);
  assert.deepEqual(memory.dryBelts("Amarr"), [{ beltName: "Belt - 1", all: false, families: [465] }]);
});

test("an unknown system reads as an empty list, never null", () => {
  const memory = createBeltMemory({ now: fakeClock().now });
  assert.deepEqual(memory.dryBelts("Nowhere"), []);
});

test("names are trimmed and blank names are ignored", () => {
  const memory = createBeltMemory({ now: fakeClock().now });
  memory.markDry("  Jita  ", "  Belt - 1  ", null);
  memory.markDry("", "Belt - 2", null);
  memory.markDry("Jita", "   ", 465);

  assert.deepEqual(memory.dryBelts("Jita"), [{ beltName: "Belt - 1", all: true, families: [] }]);
  assert.deepEqual(memory.dryBelts(""), []);
});
