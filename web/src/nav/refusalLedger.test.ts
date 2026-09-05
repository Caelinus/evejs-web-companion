// The run-scoped refusal ledger. Pure — no runner, no BFF.
//
// The behaviour under test is the one whose absence let a bot answer 227
// consecutive refusals over twelve hours while reporting cheerful progress:
// that a repeated "no" is counted, worded, slowed down, and eventually acted on.

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRefusal,
  createRefusalLedger,
  MAX_CONSECUTIVE_REFUSALS,
  refusalKey,
  settleTicksForRefusals,
} from "./refusalLedger.ts";

const NO_ROOM = "CALL_REFUSED: NotEnoughCargoSpace";

test("a repeated refusal on one key counts up", () => {
  const ledger = createRefusalLedger();
  const key = refusalKey("s1", "lootContainer", 80001);
  assert.equal(ledger.consecutive(key), 0, "not failing until it fails");
  ledger.note(key, NO_ROOM, 1_000, true);
  ledger.note(key, NO_ROOM, 2_000, true);
  const third = ledger.note(key, NO_ROOM, 3_000, true);
  assert.equal(third.count, 3);
  assert.equal(third.firstAt, 1_000, "the streak remembers when it started");
  assert.equal(third.lastAt, 3_000);
});

test("a success ends the streak", () => {
  const ledger = createRefusalLedger();
  const key = refusalKey("s1", "lootContainer", 80001);
  ledger.note(key, NO_ROOM, 1_000, true);
  ledger.note(key, NO_ROOM, 2_000, true);
  ledger.clear(key);
  assert.equal(ledger.consecutive(key), 0);
});

test("one failing target never spends another's budget, or masks it", () => {
  const ledger = createRefusalLedger();
  const stubborn = refusalKey("s1", "lootContainer", 80001);
  const fine = refusalKey("s1", "lootContainer", 80002);
  ledger.note(stubborn, NO_ROOM, 1_000, true);
  ledger.note(stubborn, NO_ROOM, 2_000, true);
  ledger.note(fine, NO_ROOM, 3_000, true);
  assert.equal(ledger.consecutive(stubborn), 2);
  assert.equal(ledger.consecutive(fine), 1);
});

test("the same target under a DIFFERENT step is a different streak", () => {
  const ledger = createRefusalLedger();
  ledger.note(refusalKey("s1", "lootContainer", 80001), NO_ROOM, 1_000, true);
  assert.equal(ledger.consecutive(refusalKey("s2", "lootContainer", 80001)), 0);
});

test("a refusal is worded by describeRefusal, never left as a code", () => {
  const ledger = createRefusalLedger();
  const record = ledger.note(refusalKey("s1", "lootContainer", 1), NO_ROOM, 1_000, true);
  assert.match(record.words, /room/i, "the player reads about room, not NotEnoughCargoSpace");
  assert.equal(/NotEnoughCargoSpace/.test(record.words), false);
});

test("records come back worst-first, which is what a readout leads with", () => {
  const ledger = createRefusalLedger();
  const quiet = refusalKey("s1", "lootContainer", 1);
  const loud = refusalKey("s1", "lootContainer", 2);
  ledger.note(quiet, NO_ROOM, 1, true);
  for (let i = 0; i < 4; i += 1) {
    ledger.note(loud, NO_ROOM, i, true);
  }
  assert.deepEqual(ledger.records().map((record) => record.key), [loud, quiet]);
});

// ── The classification that a plan revision turned on ───────────────────────

test("an ordinary refusal is 'refused' whatever the grid says", () => {
  assert.equal(classifyRefusal(NO_ROOM, true), "refused");
  assert.equal(classifyRefusal(NO_ROOM, false), "refused");
  assert.equal(classifyRefusal(NO_ROOM, null), "refused");
});

test("a bind miss on a target STILL on the grid is unreachable, not gone", () => {
  // eve.js throws FakeItemNotFound both for an id that matches nothing and for
  // its own scene/range check. Retiring on the bare code would abandon every can
  // the ship merely drifted away from.
  assert.equal(classifyRefusal("CALL_REFUSED: FakeItemNotFound", true), "unreachable");
});

test("a bind miss on a target that has LEFT the grid is gone", () => {
  assert.equal(classifyRefusal("CALL_REFUSED: FakeItemNotFound", false), "gone");
});

test("a bind miss with an UNREADABLE grid is unreachable — never retired on a guess", () => {
  // "We could not look" is not evidence the object stopped existing, and the
  // recoverable reading is the only safe one.
  assert.equal(classifyRefusal("CALL_REFUSED: FakeItemNotFound", null), "unreachable");
});

// ── The backoff ─────────────────────────────────────────────────────────────

test("the wait grows with the streak and is capped", () => {
  assert.equal(settleTicksForRefusals(0), 2, "an unblemished key waits the ordinary settle");
  assert.ok(settleTicksForRefusals(1) > settleTicksForRefusals(0));
  assert.ok(settleTicksForRefusals(5) > settleTicksForRefusals(1));
  assert.equal(settleTicksForRefusals(1_000), settleTicksForRefusals(100), "capped, not unbounded");
  assert.ok(settleTicksForRefusals(1_000) <= 30);
});

test("the bound is looser than a block's own, because it stops the whole run", () => {
  // MAX_BLOCK_ATTEMPTS is 5 and bounds one visit to a block, where giving up and
  // trying the next can is cheap. This one ends the run.
  assert.ok(MAX_CONSECUTIVE_REFUSALS > 5);
});
