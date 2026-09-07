// HOW FULL A HOLD IS — and the three things "not full" can mean.
//
// ⚠ THIS IS WHY THE ARITHMETIC WAS LIFTED. It was two private functions on
// `Mining.svelte` until the HUD grew a cargo readout, and the moment a second
// caller existed the `null` handling had to be one thing rather than two. The
// distinction it protects is the expensive one in this whole client:
//
//   ABSENT  — the hull has no such hold. Draw nothing.
//   EMPTY   — measured, and there is nothing in it. 0 of N is a fact.
//   UNKNOWN — nobody measured. Never 0, and never an empty bar, because an
//             empty bar is how a pilot decides they have room for another
//             twenty minutes of mining.

import test from "node:test";
import assert from "node:assert/strict";

import {
  holdCapacityText,
  holdFillBand,
  holdFillPercent,
  holdFillShort,
  presentHolds,
} from "./holdFill.ts";
import type { MiningHold } from "../store/types.ts";

/**
 * The runtime's own grouping for a number.
 *
 * ⚠ NOT A HARDCODED "5,000". `holdCapacityText` groups with `toLocaleString`,
 * and this suite has to run on whatever locale the machine is set to — writing
 * the comma in by hand is exactly how the nineteen standing failures in this
 * repo got there. What is being claimed is the SHAPE of the sentence, not which
 * separator the host prefers.
 */
const grouped = (n: number): string => n.toLocaleString();

/** A hold, with only the fields these rules read. */
function hold(over: Partial<MiningHold> = {}): MiningHold {
  return {
    key: "ore",
    label: "Ore hold",
    items: [],
    capacity: { capacity: 5000, used: 1000 },
    present: true,
    error: null,
    ...over,
  } as MiningHold;
}

// --- unknown is not empty ----------------------------------------------------

test("⚠ A HOLD NOBODY MEASURED READS 'not known', NEVER 0", () => {
  assert.equal(holdCapacityText(hold({ capacity: null })), "not known");
  assert.equal(holdCapacityText(hold({ capacity: { capacity: null, used: null } })), "not known");
  assert.equal(holdFillShort(hold({ capacity: null })), "not known");
});

test("⚠ AND IT DRAWS NO BAR — null is not 0%", () => {
  // The number is what the component uses to decide whether to render a fill at
  // all. A 0 here would paint an empty bar over an unmeasured hold, which reads
  // as "plenty of room" in the one glance this readout exists for.
  assert.equal(holdFillPercent(hold({ capacity: null })), null);
  assert.equal(holdFillPercent(hold({ capacity: { capacity: null, used: 3 } })), null);
  assert.equal(holdFillPercent(hold({ capacity: { capacity: 5000, used: null } })), null);
  // A capacity of zero is not a divisor and not a reading either.
  assert.equal(holdFillPercent(hold({ capacity: { capacity: 0, used: 0 } })), null);
});

test("a MEASURED empty hold is 0 of N, which is a fact and looks like one", () => {
  const empty = hold({ capacity: { capacity: 5000, used: 0 } });
  assert.equal(holdFillPercent(empty), 0);
  assert.equal(holdFillShort(empty), "0%");
  assert.equal(holdCapacityText(empty), `${grouped(0)} of ${grouped(5000)} m³`);
});

test("a known size with unknown contents says the half that is real", () => {
  // "holds 5,000 m³" claims nothing about what is in it. Reporting it as empty
  // would be an invention; reporting nothing would throw away a fact.
  assert.equal(
    holdCapacityText(hold({ capacity: { capacity: 5000, used: null } })),
    `holds ${grouped(5000)} m³`,
  );
});

// --- the ordinary reading ----------------------------------------------------

test("a full reading is used out of capacity, grouped, in cubic metres", () => {
  assert.equal(holdCapacityText(hold()), `${grouped(1000)} of ${grouped(5000)} m³`);
  assert.equal(holdFillPercent(hold()), 20);
  assert.equal(holdFillShort(hold()), "20%");
});

test("an overfull hold is clamped to 100, because a bar cannot be 103% long", () => {
  // It happens: the server reports the contents and the capacity from two
  // different reads, and a stack can land between them.
  assert.equal(holdFillPercent(hold({ capacity: { capacity: 100, used: 103 } })), 100);
});

// --- the band, which is never the only telling -------------------------------

test("the band is a glance, and an UNKNOWN fill gets no band at all", () => {
  // Not "cool", not "fine" — nothing. A band on an unmeasured hold would be a
  // reassurance nobody earned.
  assert.equal(holdFillBand(hold({ capacity: null })), "");
  assert.equal(holdFillBand(hold({ capacity: { capacity: 100, used: 10 } })), "");
  assert.equal(holdFillBand(hold({ capacity: { capacity: 100, used: 70 } })), "warn");
  assert.equal(holdFillBand(hold({ capacity: { capacity: 100, used: 95 } })), "full");
});

test("every band is paired with a reading the band did not have to carry", () => {
  // The colour says "nearly full" and the text says how nearly. Neither is
  // load-bearing on its own — which is the rule the whole design system runs
  // on, and the reason this returns a string rather than a colour.
  const nearly = hold({ capacity: { capacity: 100, used: 95 } });
  assert.equal(holdFillBand(nearly), "full");
  assert.equal(holdFillShort(nearly), "95%");
});

// --- absent is not empty either ----------------------------------------------

test("⚠ A HULL WITH NO ORE HOLD SHOWS NO ORE HOLD", () => {
  // `present: false` is a fact about the HULL, not a reading about its
  // contents. An "Ore hold — not known" row would have a pilot hunting for a
  // bay their ship does not have.
  const holds = [hold(), hold({ key: "ice", label: "Ice hold", present: false })];
  assert.deepEqual(presentHolds(holds).map((h) => h.key), ["ore"]);
});

test("a hull with no holds at all yields an empty list, not a fabricated cargo bay", () => {
  assert.deepEqual(presentHolds([]), []);
  assert.deepEqual(presentHolds([hold({ present: false })]), []);
});
