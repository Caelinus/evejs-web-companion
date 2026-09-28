// Item-level "leave this alone". Pure.
//
// The case it exists for: spare mining crystals sitting in the cargo hold beside
// the ore and salvage the trip was for. No bay-level rule can separate them,
// because they are all in the same bay.

import test from "node:test";
import assert from "node:assert/strict";

import { movableRows, staysAboard, type KeepRule } from "./keepAboard.ts";

const CRYSTAL = { typeID: 3389, groupID: 483 };
const VELDSPAR = { typeID: 1230, groupID: 462 };
const UNCLASSIFIED = { typeID: 9999, groupID: null };

test("an empty rule list keeps nothing at all", () => {
  assert.equal(staysAboard(CRYSTAL, [], "keep"), false);
  assert.deepEqual(movableRows([CRYSTAL, VELDSPAR], [], "move"), [CRYSTAL, VELDSPAR]);
});

test("a type rule keeps exactly that type", () => {
  const keep: KeepRule[] = [{ match: "type", typeID: 3389 }];
  assert.equal(staysAboard(CRYSTAL, keep, "move"), true);
  assert.equal(staysAboard(VELDSPAR, keep, "move"), false);
});

test("a group rule keeps every variant of a kind — the reason to prefer it", () => {
  // Every grade of a crystal shares a group; a typeID list would need a dozen
  // entries and would silently miss the thirteenth.
  const keep: KeepRule[] = [{ match: "group", groupID: 483 }];
  assert.equal(staysAboard({ typeID: 3389, groupID: 483 }, keep, "move"), true);
  assert.equal(staysAboard({ typeID: 18068, groupID: 483 }, keep, "move"), true, "a different crystal");
  assert.equal(staysAboard(VELDSPAR, keep, "move"), false);
});

test("UNLOADING moves a row it cannot classify", () => {
  // It lands in the station hangar, which is one drag from undone — and holding
  // back rows we cannot classify would stall the block's "am I empty yet" check.
  const keep: KeepRule[] = [{ match: "group", groupID: 483 }];
  assert.equal(staysAboard(UNCLASSIFIED, keep, "move"), false);
});

test("JETTISONING keeps a row it cannot classify", () => {
  // The stack goes into a can that despawns. There is no undo, so "I could not
  // tell" must never be enough to throw something into space.
  const keep: KeepRule[] = [{ match: "group", groupID: 483 }];
  assert.equal(staysAboard(UNCLASSIFIED, keep, "keep"), true);
});

test("an unreadable group cannot defeat a TYPE rule", () => {
  // A type rule always has a typeID to test, so the row is decidable either way
  // and `whenUnsure` never comes into it.
  const keep: KeepRule[] = [{ match: "type", typeID: 9999 }];
  assert.equal(staysAboard(UNCLASSIFIED, keep, "move"), true);
  assert.equal(staysAboard({ typeID: 1, groupID: null }, keep, "keep"), false, "no group rule to be unsure about");
});

test("movableRows holds back exactly what the rules protect", () => {
  const keep: KeepRule[] = [{ match: "group", groupID: 483 }];
  const rows = [CRYSTAL, VELDSPAR, UNCLASSIFIED];
  assert.deepEqual(movableRows(rows, keep, "move"), [VELDSPAR, UNCLASSIFIED]);
  assert.deepEqual(movableRows(rows, keep, "keep"), [VELDSPAR]);
});
