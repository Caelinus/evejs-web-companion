// Item-level "leave this alone". Pure.
//
// The case it exists for: spare mining crystals sitting in the cargo hold beside
// the ore and salvage the trip was for. No bay-level rule can separate them,
// because they are all in the same bay.

import test from "node:test";
import assert from "node:assert/strict";

import { movableRows, pickedRows, staysAboard, type KeepRule } from "./keepAboard.ts";

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

// ─── name patterns, and the load side ───────────────────────────────────────

const COMMAND_CENTER = { typeID: 2524, groupID: 1027, name: "Temperate Command Center" };
const BARREN_CENTER = { typeID: 2525, groupID: 1027, name: "Barren Command Center" };
const PASTE = { typeID: 28668, groupID: 536, name: "Nanite Repair Paste" };
const UNNAMED = { typeID: 4242, groupID: 1027, name: null };

test("a name pattern matches on the resolved name, case-insensitively", () => {
  const rules: KeepRule[] = [{ match: "name", pattern: "command center" }];
  assert.equal(staysAboard(COMMAND_CENTER, rules, "move"), true);
  assert.equal(staysAboard(BARREN_CENTER, rules, "move"), true);
  assert.equal(staysAboard(PASTE, rules, "move"), false);
});

test("a name pattern nobody resolved a name for is UNDECIDABLE, not false", () => {
  // Same rule a group match follows for an unreadable groupID: "we could not
  // tell" is its own answer, and which way it falls is the caller's to choose.
  const rules: KeepRule[] = [{ match: "name", pattern: "command center" }];
  assert.equal(staysAboard(UNNAMED, rules, "keep"), true);
  assert.equal(staysAboard(UNNAMED, rules, "move"), false);
  assert.deepEqual(pickedRows([UNNAMED], rules, "skip"), []);
  assert.deepEqual(pickedRows([UNNAMED], rules, "pick"), [UNNAMED]);
});

test("a blank pattern matches NOTHING, never everything", () => {
  // A half-typed rule must not turn a load block into "take the whole hangar".
  const rules: KeepRule[] = [{ match: "name", pattern: "   " }];
  assert.deepEqual(pickedRows([COMMAND_CENTER, PASTE], rules, "skip"), []);
  assert.equal(staysAboard(COMMAND_CENTER, rules, "keep"), false);
});

test("pickedRows takes nothing when nothing is asked for — the OPPOSITE of an empty keep list", () => {
  // An unload with no keep rules empties the ship (recoverable); a load with no
  // rules must not carry a station hangar's entire contents away.
  assert.deepEqual(pickedRows([COMMAND_CENTER, PASTE], [], "skip"), []);
  assert.deepEqual(movableRows([COMMAND_CENTER, PASTE], [], "move"), [COMMAND_CENTER, PASTE]);
});

test("one GROUP rule covers every planet's command centre", () => {
  // The reason a group is still the rule to reach for: it survives a rename.
  const rules: KeepRule[] = [{ match: "group", groupID: 1027 }];
  assert.deepEqual(pickedRows([COMMAND_CENTER, BARREN_CENTER, PASTE], rules, "skip"), [
    COMMAND_CENTER,
    BARREN_CENTER,
  ]);
});
