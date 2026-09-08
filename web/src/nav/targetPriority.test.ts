// The target-priority ladder: the game's ship-group name in, the job the hull
// was built for out, and the one ordering both combat call sites pick with.
// Pins the exact matching (a "Prototype Exploration Ship" is not a recon), the
// cannot-tell rule (an unresolved group is never promoted), and the ranking —
// NOT filtering — rule that keeps an unlisted class shootable.

import test from "node:test";
import assert from "node:assert/strict";

import { TARGET_CLASS_ARGS } from "../bots/botScript.ts";
import { DEFAULT_TARGET_PRIORITY, pickPrimary, targetClassForGroup } from "./targetPriority.ts";

test("the game's own ship groups map to the jobs a fight is decided by", () => {
  for (const group of ["Interceptor", "Interdictor", "Heavy Interdiction Cruiser"]) {
    assert.equal(targetClassForGroup(group), "tackle", group);
  }
  for (const group of ["Electronic Attack Ship", "Force Recon Ship", "Combat Recon Ship"]) {
    assert.equal(targetClassForGroup(group), "ewar", group);
  }
  for (const group of ["Logistics", "Logistics Frigate", "Force Auxiliary"]) {
    assert.equal(targetClassForGroup(group), "logi", group);
  }
  assert.equal(targetClassForGroup("  interceptor  "), "tackle", "case and padding are not load-bearing");
});

test("every other hull is 'other' — still shot, just not first", () => {
  for (const group of ["Battleship", "Frigate", "Assault Frigate", "Command Ship", "Covert Ops", "Mining Barge"]) {
    assert.equal(targetClassForGroup(group), "other", group);
  }
});

test("the match is exact — hulls that merely read like a class do not qualify", () => {
  assert.equal(targetClassForGroup("Prototype Exploration Ship"), "other");
  assert.equal(targetClassForGroup("Industrial Command Ship"), "other");
  assert.equal(targetClassForGroup("Logistics Blueprint"), "other");
  assert.equal(targetClassForGroup("Heavy Assault Cruiser"), "other");
});

test("an unresolved group is NO class, not a guess", () => {
  assert.equal(targetClassForGroup(null), null);
  assert.equal(targetClassForGroup(undefined), null);
});

// ── the pick ─────────────────────────────────────────────────────────────────

interface Row {
  readonly id: number;
  readonly typeID: number | null;
  readonly distance: number | null;
}

const GROUPS: Record<number, string> = {
  11176: "Interceptor", // a tackle hull
  11995: "Combat Recon Ship", // an ewar hull
  11985: "Logistics", // a logi hull
  645: "Battleship", // everything else
};

function pick(rows: readonly Row[], priority = DEFAULT_TARGET_PRIORITY): Row | null {
  return pickPrimary(
    rows,
    (row) => row.typeID,
    (row) => row.distance,
    (typeID) => GROUPS[typeID] ?? null,
    priority,
  );
}

test("class beats distance — the far tackle dies before the near battleship", () => {
  const battleship = { id: 1, typeID: 645, distance: 2_000 };
  const interceptor = { id: 2, typeID: 11176, distance: 40_000 };
  assert.equal(pick([battleship, interceptor])?.id, 2);
});

test("inside one class the nearest still wins, and ties keep the caller's order", () => {
  const near = { id: 1, typeID: 645, distance: 5_000 };
  const far = { id: 2, typeID: 645, distance: 30_000 };
  assert.equal(pick([far, near])?.id, 1);
  const tiedFirst = { id: 3, typeID: 645, distance: 5_000 };
  assert.equal(pick([near, tiedFirst])?.id, 1, "a tie is not a reshuffle");
});

test("the whole ladder is honoured, not just its first rung", () => {
  const battleship = { id: 1, typeID: 645, distance: 1_000 };
  const logi = { id: 2, typeID: 11985, distance: 50_000 };
  const recon = { id: 3, typeID: 11995, distance: 60_000 };
  assert.equal(pick([battleship, logi, recon])?.id, 3, "ewar outranks logi outranks the rest");
  assert.equal(pick([battleship, logi])?.id, 2);
});

test("a player's own order is followed", () => {
  const interceptor = { id: 1, typeID: 11176, distance: 30_000 };
  const logi = { id: 2, typeID: 11985, distance: 30_000 };
  assert.equal(pick([interceptor, logi], ["logi", "tackle", "ewar", "other"])?.id, 2);
});

test("a class left off the list is LAST, never unshootable", () => {
  // "Kill the tackle" alone: a lone battleship is still the primary, because a
  // block that refuses everything off its list just sits there and dies.
  const battleship = { id: 1, typeID: 645, distance: 10_000 };
  assert.equal(pick([battleship], ["tackle"])?.id, 1);
  // And it still loses to the class that WAS named.
  const interceptor = { id: 2, typeID: 11176, distance: 90_000 };
  assert.equal(pick([battleship, interceptor], ["tackle"])?.id, 2);
});

test("unlisted classes keep the shipped order among themselves", () => {
  const logi = { id: 1, typeID: 11985, distance: 40_000 };
  const battleship = { id: 2, typeID: 645, distance: 1_000 };
  assert.equal(pick([battleship, logi], ["tackle"])?.id, 1, "logi still outranks 'other'");
});

test("an unresolved hull is ranked with 'other' — never promoted, never dropped", () => {
  const unknown = { id: 1, typeID: 99999, distance: 1_000 };
  const interceptor = { id: 2, typeID: 11176, distance: 80_000 };
  assert.equal(pick([unknown, interceptor])?.id, 2, "a hull nobody could name never outranks known tackle");
  assert.equal(pick([unknown])?.id, 1, "and it is still a target when it is all there is");
  const noType = { id: 3, typeID: null, distance: 500 };
  assert.equal(pick([noType])?.id, 3);
});

test("an unmeasurable distance sorts last inside its class, not out of the fight", () => {
  const measured = { id: 1, typeID: 645, distance: 20_000 };
  const unmeasured = { id: 2, typeID: 645, distance: null };
  assert.equal(pick([unmeasured, measured])?.id, 1);
  assert.equal(pick([unmeasured])?.id, 2);
});

test("no rows, no primary", () => {
  assert.equal(pick([]), null);
});

test("the shipped order covers the format's whole vocabulary", () => {
  // Two lists on purpose — the codec's is the FORMAT vocabulary, this one is the
  // shipped ordering — so a class added to one and forgotten in the other would
  // rank as "unlisted" forever. This is the check that catches that.
  assert.deepEqual([...DEFAULT_TARGET_PRIORITY].sort(), [...TARGET_CLASS_ARGS].sort());
});
