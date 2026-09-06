import test from "node:test";
import assert from "node:assert/strict";

import { fitWithin, holdFreeM3, unitsThatFit } from "./holdFit.ts";

test("holdFreeM3 is capacity minus used, floored at zero, null when unread", () => {
  assert.equal(holdFreeM3({ capacity: 5000, used: 2000 }), 3000);
  assert.equal(holdFreeM3({ capacity: 5000, used: 5200 }), 0, "an over-full hold reads as 0 free, never negative");
  assert.equal(holdFreeM3(null), null);
  assert.equal(holdFreeM3(undefined), null);
});

test("unitsThatFit moves the whole stack when it all fits", () => {
  // 100 Veldspar at 0.1 m³ = 10 m³ into a hold with 3000 free.
  assert.equal(unitsThatFit(100, 0.1, 3000), 100);
});

test("unitsThatFit moves only what fits when the stack is too big", () => {
  // 100000 Veldspar at 0.1 m³ into 3000 free → floor(3000 / 0.1) = 30000.
  assert.equal(unitsThatFit(100000, 0.1, 3000), 30000);
});

test("unitsThatFit floors partial units (no half-unit moves)", () => {
  // 25 free, 0.1 each → 250 fit, but only 40 in the stack.
  assert.equal(unitsThatFit(40, 0.1, 25), 40);
  // 7 free, 2 m³ each → 3 fit (3.5 floored).
  assert.equal(unitsThatFit(10, 2, 7), 3);
});

test("unitsThatFit returns 0 when nothing fits (full hold)", () => {
  assert.equal(unitsThatFit(100, 0.1, 0), 0);
  assert.equal(unitsThatFit(100, 5, 4), 0, "a unit bigger than the free space fits zero");
});

test("unitsThatFit hands the whole stack to the server when volume is unknown", () => {
  assert.equal(unitsThatFit(100, null, 3000), 100);
  assert.equal(unitsThatFit(100, undefined, 3000), 100);
  assert.equal(unitsThatFit(100, 0, 3000), 100, "a zero/garbage volume is 'unknown', not 'infinite'");
});

test("unitsThatFit hands the whole stack to the server when free space is unknown", () => {
  assert.equal(unitsThatFit(100, 0.1, null), 100);
});

test("unitsThatFit is 0 for an empty stack", () => {
  assert.equal(unitsThatFit(0, 0.1, 3000), 0);
});

// ── fitWithin: taking what fits, and leaving the rest where it is ───────────

function stack(itemID: number, quantity: number, volume: number | null) {
  return { itemID, quantity, volume };
}

test("a can bigger than the hold is DRAINED, not refused", () => {
  // The scenario the whole change exists for: 10,000 m³ in the can, 1,000 free.
  // Asking for the stack whole is refused outright and nothing moves, for ever.
  const sel = fitWithin([stack(1, 10_000, 1)], 1_000);
  assert.deepEqual(sel.whole, []);
  assert.equal(sel.split?.row.itemID, 1);
  assert.equal(sel.split?.quantity, 1_000, "take exactly what fits");
  assert.deepEqual(sel.deferred, [], "the rest of that stack rides in the split");
});

test("whole stacks are taken while they fit, in order", () => {
  const sel = fitWithin([stack(1, 100, 1), stack(2, 100, 1), stack(3, 100, 1)], 250);
  assert.deepEqual(sel.whole.map((r) => r.itemID), [1, 2]);
  assert.equal(sel.split?.row.itemID, 3);
  assert.equal(sel.split?.quantity, 50);
});

test("only ONE stack is split — past it the hold is full", () => {
  // The bridge refuses a quantity when more than one stack is named, and after
  // the first split there is nothing left worth measuring anyway.
  const sel = fitWithin([stack(1, 100, 1), stack(2, 100, 1)], 50);
  assert.equal(sel.split?.row.itemID, 1);
  assert.deepEqual(sel.deferred.map((r) => r.itemID), [2]);
});

test("a full hold takes nothing and defers everything", () => {
  const sel = fitWithin([stack(1, 100, 1)], 0);
  assert.deepEqual(sel.whole, []);
  assert.equal(sel.split, null);
  assert.deepEqual(sel.deferred.map((r) => r.itemID), [1]);
});

test("an unreadable capacity hands EVERYTHING to the server, as it always did", () => {
  const sel = fitWithin([stack(1, 100, 1), stack(2, 5, 2)], null);
  assert.deepEqual(sel.unknown.map((r) => r.itemID), [1, 2]);
  assert.deepEqual(sel.whole, []);
  assert.equal(sel.split, null);
});

test("a row of unknown volume is kept APART, so its refusal cannot sink the rest", () => {
  const sel = fitWithin([stack(1, 10, 1), stack(2, 1, null)], 100);
  assert.deepEqual(sel.whole.map((r) => r.itemID), [1]);
  assert.deepEqual(sel.unknown.map((r) => r.itemID), [2]);
});

test("nothing is lost: every row lands in exactly one bucket", () => {
  const rows = [stack(1, 10, 1), stack(2, 1, null), stack(3, 500, 1), stack(4, 500, 1)];
  const sel = fitWithin(rows, 100);
  const seen = [
    ...sel.whole.map((r) => r.itemID),
    ...(sel.split ? [sel.split.row.itemID] : []),
    ...sel.unknown.map((r) => r.itemID),
    ...sel.deferred.map((r) => r.itemID),
  ];
  assert.equal(seen.length, new Set(seen).size, "no row is in two buckets");
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4]);
});
