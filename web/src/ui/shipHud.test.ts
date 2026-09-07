// The ship-readout model (shipHud.ts): the resource gauge list and the discrete
// capacitor segment maths.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resourceGauges, capacitorSegments, shipStateSentence, shipIsStopped, shipModeLabel, shipStateSentenceFor } from "./shipHud.ts";

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

// --- the header's state word -------------------------------------------------

test("the header word is the server's OWN mode, uppercased", () => {
  assert.equal(shipModeLabel("orbit"), "ORBIT");
  assert.equal(shipModeLabel("WARP"), "WARP");
  assert.equal(shipModeLabel("  goto "), "GOTO");
});

test("⚠ AN UNKNOWN MODE PASSES STRAIGHT THROUGH, rather than becoming a dash", () => {
  // The header is a glance, and a mode this client has never seen is still a
  // real thing the ship is doing. Printing it verbatim is worse-looking and
  // more truthful than printing "—" over a hull that is clearly moving.
  assert.equal(shipModeLabel("SOMETHING_NEW"), "SOMETHING_NEW");
  // Only "nothing at all" has nothing to say.
  assert.equal(shipModeLabel(null), null);
  assert.equal(shipModeLabel("   "), null);
});

test("stopped is recognised, so the word can go quiet instead of blue", () => {
  assert.equal(shipIsStopped("STOP"), true);
  assert.equal(shipIsStopped("stopped"), true);
  assert.equal(shipIsStopped("ORBIT"), false);
  assert.equal(shipIsStopped(null), false);
});

// --- the footer sentence, and what it may not invent -------------------------

const km = (metres: number) => `${Math.round(metres / 1000)} km`;

test("the sentence NAMES what the ship is acting on, when the server says", () => {
  const ship = { mode: "orbit", velocity: { x: 100, y: 0, z: 0 } };
  assert.equal(
    shipStateSentenceFor(ship, "Caldari Sentry Gun I", 5000, km),
    "Orbiting Caldari Sentry Gun I at 5 km",
  );
});

test("⚠ NO TARGET MEANS THE PLAIN SENTENCE — never an invented one", () => {
  // The design asks for "Orbiting X at N km". The ship's own row carries
  // `targetEntityID`, and on this server it is null — so there is nothing to
  // name, and the sentence says only what is known.
  const ship = { mode: "orbit", velocity: { x: 100, y: 0, z: 0 } };
  assert.equal(shipStateSentenceFor(ship, null, null, km), "Orbiting.");
  assert.equal(shipStateSentenceFor(ship, null, 5000, km), "Orbiting.");
});

test("a named target with no measurable range is still named", () => {
  // Half a fact is better than none, and the half that is missing is simply
  // absent rather than guessed at.
  const ship = { mode: "orbit", velocity: { x: 100, y: 0, z: 0 } };
  assert.equal(shipStateSentenceFor(ship, "Some Rock", null, km), "Orbiting Some Rock");
});

test("⚠ A STOPPED SHIP DOES NOT NAME A TARGET — FOUND ON SCREEN", () => {
  // The header read "Engines stopped Caldari Sentry Gun II at 1.3 km". A
  // stopped ship still carries a `targetEntityID` from whatever it was last
  // doing, and this function used to strip the full stop off ANY sentence and
  // staple the target on. It is not a sentence, and it reads as though the ship
  // had stopped the gun.
  const stopped = { mode: "stop", velocity: { x: 0, y: 0, z: 0 } };
  assert.equal(shipStateSentenceFor(stopped, "Some Rock", 1300, km), "Engines stopped.");
  // Same shape, same rule: a mode this build has never heard of describes
  // itself and claims nothing about the target.
  const unknown = { mode: "SOMETHING_NEW", velocity: { x: 0, y: 0, z: 0 } };
  assert.equal(
    shipStateSentenceFor(unknown, "Some Rock", 1300, km),
    shipStateSentence(unknown),
  );
});

test("each state names its object with the preposition that state actually takes", () => {
  // "Holding range X" and "Aligning X" are not English. The verb decides the
  // join, so the table carries the whole phrase rather than a bare participle.
  const at = (mode: string): string =>
    shipStateSentenceFor({ mode, velocity: { x: 1, y: 0, z: 0 } }, "Some Rock", 5000, km);
  assert.equal(at("orbit"), "Orbiting Some Rock at 5 km");
  assert.equal(at("approach"), "Approaching Some Rock at 5 km");
  assert.equal(at("align"), "Aligning to Some Rock at 5 km");
  assert.equal(at("keepatrange"), "Holding range on Some Rock at 5 km");
  assert.equal(at("warp"), "In warp to Some Rock at 5 km");
});

test("⚠ THE TARGET IS NOT TAKEN FROM WHAT THIS CLIENT LAST ORDERED", () => {
  // A course set by a bot, by another client or by a previous session is the
  // common case while this app is running, and a sentence assembled from a
  // stale local memory is indistinguishable, to a player, from one the ship
  // reported. The HUD reads the SNAPSHOT's own row and nothing else.
  const hud = readFileSync(new URL("./HudBar.svelte", import.meta.url), "utf8");
  assert.match(hud, /selfRow\?\.targetEntityID \?\? null/);
  assert.equal(
    /lastOrbit|lastOrdered|rememberedTarget/.test(hud),
    false,
    "the HUD grew a memory of what it ordered",
  );
});
