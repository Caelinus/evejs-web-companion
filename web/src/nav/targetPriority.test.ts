// The target-priority ladder: the game's ship-group name in, the job the hull
// was built for out, and the one ordering both combat call sites pick with.
// Pins the exact matching (a "Prototype Exploration Ship" is not a recon), the
// cannot-tell rule (an unresolved group is never promoted), and the ranking —
// NOT filtering — rule that keeps an unlisted class shootable.

import test from "node:test";
import assert from "node:assert/strict";

import { TARGET_CLASS_ARGS } from "../bots/botScript.ts";
import { DEFAULT_TARGET_PRIORITY, fleetTagRank, pickPrimary, targetClassForGroup } from "./targetPriority.ts";

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
  readonly tag?: string | null;
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

// Same rows, but the fleet's tag is read too — the call path scriptMacros.ts
// will use once broadcasts feed pickPrimary a tag.
function pickTagged(rows: readonly Row[], priority = DEFAULT_TARGET_PRIORITY): Row | null {
  return pickPrimary(
    rows,
    (row) => row.typeID,
    (row) => row.distance,
    (typeID) => GROUPS[typeID] ?? null,
    priority,
    (row) => row.tag,
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

// ── fleet tags ───────────────────────────────────────────────────────────────

test("the stock menu's tags rank in the documented order: digits 1-9-0, then A-J, X, Y, Z", () => {
  const STOCK_ORDER = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "X", "Y", "Z",
  ];
  for (let i = 1; i < STOCK_ORDER.length; i++) {
    assert.ok(
      fleetTagRank(STOCK_ORDER[i - 1]) < fleetTagRank(STOCK_ORDER[i]),
      `${STOCK_ORDER[i - 1]} should outrank ${STOCK_ORDER[i]}`,
    );
  }
  assert.ok(fleetTagRank("9") < fleetTagRank("0"), "0 sits after 9, keyboard-row order not numeric order");
  assert.ok(fleetTagRank("J") < fleetTagRank("X"), "the K-W gap does not break the letters' order");
});

test("tags are read case-insensitively — a hand-typed lowercase tag is the same instruction", () => {
  assert.equal(fleetTagRank("a"), fleetTagRank("A"));
  assert.equal(fleetTagRank("z"), fleetTagRank("Z"));
});

test("an unrecognised tag ranks last among tagged ships — never dropped", () => {
  // ⚠ There is no server-side allowlist: a non-stock client can broadcast any
  // string. This is the check that such a tag still gets a finite rank.
  const weird = fleetTagRank("!!custom-tag!!");
  assert.ok(Number.isFinite(weird), "an unrecognised tag must still rank, not vanish");
  assert.ok(weird > fleetTagRank("Z"), "it ranks worse than every stock tag");
  assert.ok(weird < fleetTagRank(null), "but it still beats having no tag at all");
});

test("an absent tag ranks below every tagged ship, recognised or not", () => {
  for (const empty of [null, undefined, "", "   "]) {
    assert.equal(fleetTagRank(empty), Number.POSITIVE_INFINITY, JSON.stringify(empty));
  }
});

test("a tagged ship beats an untagged one, regardless of class or distance", () => {
  const closeUntaggedTackle = { id: 1, typeID: 11176, distance: 1_000 };
  const farTaggedBattleship = { id: 2, typeID: 645, distance: 80_000, tag: "1" };
  assert.equal(pickTagged([closeUntaggedTackle, farTaggedBattleship])?.id, 2);
});

test("tag outranks class, deliberately — the FC's call beats this client's own guess", () => {
  const untaggedInterceptor = { id: 1, typeID: 11176, distance: 5_000 }; // best class, untagged
  const taggedBattleship = { id: 2, typeID: 645, distance: 90_000, tag: "5" }; // worst class, tagged
  assert.equal(pickTagged([untaggedInterceptor, taggedBattleship])?.id, 2);
});

test("among tagged ships, the documented tag order decides — not class or distance", () => {
  const tag2Interceptor = { id: 1, typeID: 11176, distance: 1_000, tag: "2" };
  const tag1Battleship = { id: 2, typeID: 645, distance: 90_000, tag: "1" };
  assert.equal(pickTagged([tag2Interceptor, tag1Battleship])?.id, 2, "1 outranks 2 regardless of class/distance");
});

test("distance still breaks ties within equal tag and equal class", () => {
  const near = { id: 1, typeID: 645, distance: 5_000, tag: "1" };
  const far = { id: 2, typeID: 645, distance: 30_000, tag: "1" };
  assert.equal(pickTagged([far, near])?.id, 1);
});

test("the no-tag-accessor call path is unchanged", () => {
  // pick() never passes a tagOf — every existing caller of pickPrimary looks
  // like this. Same rows through pick() and pickTagged() (where nothing on
  // the rows carries a `tag`) must land on the same primary.
  const battleship = { id: 1, typeID: 645, distance: 2_000 };
  const interceptor = { id: 2, typeID: 11176, distance: 40_000 };
  assert.equal(pick([battleship, interceptor])?.id, pickTagged([battleship, interceptor])?.id);
});
