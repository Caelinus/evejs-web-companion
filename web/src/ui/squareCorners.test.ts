// R53 (look more like the EVE client — square, no rounded corners). The design
// system centralises corner rounding in two radius tokens, and every panel /
// control / card gets its shape from them or from a handful of hardcoded radii.
// This pass set the tokens to 0 and swept the hardcoded radii to 0 so the whole
// UI reads as hard rectangles. This test is the regression guard: it reads the
// real stylesheet off disk and fails if any non-zero corner radius comes back.
//
// The matcher is proven live (it fires on a known non-zero value) so the test
// cannot pass while asserting nothing — see MEMORY: tests that pass while
// testing nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");
// Comments contain prose like "border-radius: 50%)" describing the one
// exception — strip them so we only ever inspect real declarations.
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

// A length/percentage value with a unit: 0.4rem, 999px, 50%, 0.12rem, ...
// A bare `0` has no unit and never matches; `var(--radius-…)` has no unit
// number and never matches. That is the whole point.
const UNIT_VALUE = /(?:\d*\.\d+|\d+)(?:rem|px|em|%|vh|vw|vmin|vmax|ch)/g;

function borderRadiusDecls(css: string): string[] {
  return [...css.matchAll(/border-radius\s*:\s*([^;]+);/g)].map((m) => m[1]!.trim());
}

test("the matcher actually fires on a non-zero radius (not vacuous)", () => {
  // If this ever stopped matching, every assertion below would pass trivially.
  assert.deepEqual("border-radius: 0.4rem;".match(UNIT_VALUE), ["0.4rem"]);
  assert.deepEqual("border-radius: 999px;".match(UNIT_VALUE), ["999px"]);
  assert.deepEqual("border-radius: 0.12rem;".match(UNIT_VALUE), ["0.12rem"]);
  // ...and does NOT fire on the square forms we swept to.
  assert.equal("border-radius: 0;".match(UNIT_VALUE), null);
  assert.equal("border-radius: var(--radius-frame);".match(UNIT_VALUE), null);
});

test("both radius tokens are flipped to 0 (square corners cascade)", () => {
  assert.match(CSS_NO_COMMENTS, /--radius-frame:\s*0\s*;/, "--radius-frame must be 0");
  assert.match(CSS_NO_COMMENTS, /--radius-control:\s*0\s*;/, "--radius-control must be 0");
});

test("no non-zero border-radius survives, except the documented ring circle", () => {
  const decls = borderRadiusDecls(CSS_NO_COMMENTS);
  // Non-vacuous: there are many declarations to check, or the regex is wrong.
  assert.ok(decls.length >= 15, `expected many border-radius decls, found ${decls.length}`);

  for (const decl of decls) {
    const units = decl.match(UNIT_VALUE) ?? [];
    // Allowed unit values: none at all (bare 0 or a var() token that resolves
    // to 0), or the one exception `50%` on the radial fitting guide circle.
    const offenders = units.filter((u) => Number.parseFloat(u) !== 0 && u !== "50%");
    assert.deepEqual(offenders, [], `non-square border-radius: "${decl}"`);
  }
});

/**
 * Every rule whose `border-radius` is `50%`, by its selector. A `50%` radius is
 * how CSS spells "a circle", so these are the DOTS and RINGS in the UI — not
 * rounded corners, which is what R53 squared off.
 */
function circleSelectors(css: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /border-radius\s*:\s*[^;]*50%/.test(body ?? ""))
    .map(([, selector]) => (selector ?? "").trim().replace(/\s+/g, " "));
}

test("only the documented circles keep a radius, and they are all circles", () => {
  // Pinned BY SELECTOR, not by count: a new circle has to be named here, which
  // is the review. Each one below is a shape that is round in the world — a
  // status dot or a geometric guide — never a corner someone softened.
  const allowed = [
    // The radial fitting window's dashed guide circle (R21). Decoration, and
    // aria-hidden; see the note beside the rule.
    ".fit-ring-guide",
    // The Pilot Hangar's three status dots: the pulsing "in client" indicator in
    // the header, a pilot's squad colour dots, and the launch queue's per-pilot
    // state dot. Each carries a text label or a title beside it, so none of them
    // is the only way to read what it means.
    ".hangar-online-dot",
    ".hangar-tag",
    ".hangar-queue-dot",
  ];
  assert.deepEqual(circleSelectors(CSS_NO_COMMENTS).sort(), [...allowed].sort());
});
