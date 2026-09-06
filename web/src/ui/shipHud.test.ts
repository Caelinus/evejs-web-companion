// The ship-readout model (shipHud.ts): the resource gauge list and the discrete
// capacitor segment maths.

import test from "node:test";
import assert from "node:assert/strict";

import { resourceGauges, capacitorSegments, shipStateSentence } from "./shipHud.ts";

test("resourceGauges is shield/armor/hull, outer to inner, carrying the ratios", () => {
  const gauges = resourceGauges({ shieldRatio: 1, armorRatio: 0.5, hullRatio: 0.2 });
  assert.deepEqual(gauges.map((g) => g.key), ["shield", "armor", "hull"]);
  assert.deepEqual(gauges.map((g) => g.ratio), [1, 0.5, 0.2]);
});

test("a null ship yields three null gauges (no reading, not zero)", () => {
  const gauges = resourceGauges(null);
  assert.deepEqual(gauges.map((g) => g.ratio), [null, null, null]);
});

test("capacitorSegments rounds a clamped ratio to the nearest segment", () => {
  assert.equal(capacitorSegments(1, 12), 12);
  assert.equal(capacitorSegments(0, 12), 0);
  assert.equal(capacitorSegments(0.5, 12), 6);
  // 0.75 * 12 = 9.
  assert.equal(capacitorSegments(0.75, 12), 9);
});

test("capacitorSegments treats null as empty and clamps out-of-range ratios", () => {
  assert.equal(capacitorSegments(null, 12), 0);
  assert.equal(capacitorSegments(1.4, 12), 12);
  assert.equal(capacitorSegments(-0.2, 12), 0);
  assert.equal(capacitorSegments(0.5, 0), 0);
});

// --- what the ship is DOING (the HUD footer's one sentence) ------------------

const STILL = { x: 0, y: 0, z: 0 };

test("each mode the server names gets its own plain sentence", () => {
  for (const [mode, words] of [
    ["STOP", "Engines stopped."],
    ["warp", "In warp."],
    ["orbit", "Orbiting."],
    ["approaching", "Approaching."],
    ["align", "Aligning."],
    ["keepAtRange", "Holding range."],
    ["docking", "Docking."],
    ["jump", "Jumping."],
  ] as const) {
    assert.equal(shipStateSentence({ mode, velocity: STILL }), words, `mode ${mode}`);
  }
});

test("⚠ NO SHIP IS 'NOT KNOWN YET' — never the calmest possible guess", () => {
  // Before the first space poll lands there is no ship object. A footer that
  // said "Engines stopped." there would be inventing the most reassuring
  // sentence available about a hull that might be in warp.
  assert.match(shipStateSentence(null), /not known/);
  assert.equal(/stopped/i.test(shipStateSentence(null)), false);
});

test("an unrecognised mode falls back to what the VELOCITY says, not to silence", () => {
  // The server's vocabulary is its own and can grow. Speed is a fact we hold
  // independently of the mode word, so it answers when the word does not.
  assert.equal(shipStateSentence({ mode: "SOMETHING_NEW", velocity: STILL }), "Holding position.");
  assert.equal(
    shipStateSentence({ mode: "SOMETHING_NEW", velocity: { x: 120, y: 0, z: 0 } }),
    "Under way.",
  );
});

test("no mode and no velocity is not known, rather than 'holding position'", () => {
  assert.match(shipStateSentence({ mode: null, velocity: null }), /not known/);
});

test("a null mode with a real velocity still reports movement", () => {
  assert.equal(shipStateSentence({ mode: null, velocity: STILL }), "Holding position.");
  assert.equal(shipStateSentence({ mode: null, velocity: { x: 0, y: 3, z: 4 } }), "Under way.");
});
