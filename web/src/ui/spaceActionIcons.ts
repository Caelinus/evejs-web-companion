// FLIGHT-VERB GLYPHS — the things you do to something on the grid, as SVG path
// data. The sibling of `actionIcons.ts`, drawn to the same rule so the two sets
// look like one app.
//
// WHY ICONS HERE. The overview's action bar carries up to eleven verbs for the
// selected object, and eleven words wrap to three lines in a 340px dock column
// — which is where this panel lives most of the time. Warp, orbit, lock and
// dock are also the four things a pilot reaches for under pressure, and a shape
// is found faster than a word once it is known.
//
// ⚠ AN ICON IS NEVER THE ONLY LABEL, exactly as in `actionIcons.ts`. Every
// button carries the verb as its ACCESSIBLE NAME, as its tooltip, and as a
// caption under the glyph — the caption is not a nicety, because a tooltip does
// not exist on a touch screen and this panel has a touch tier. An icon is an
// accelerator for someone who already knows the app; it must never be the only
// way to find out what a button does.
//
// ⚠ AND IT IS NEVER THE ONLY WAY TO TELL TWO VERBS APART. Lock and Unlock are
// the two states of ONE control and are never on screen together, so they may
// share a family — but they do not share a glyph, because the difference
// between "start shooting this" and "stop" is not one to leave to a caption.
//
// Every path is authored in a 24x24 box and STROKED by the caller (round caps
// and joins, no fills), like the Neocom's and the row actions'.

import type { RowActionID } from "../space/rowActions.ts";

/** One glyph: the primitives to stroke, in a 24x24 box. */
export type SpaceActionGlyph = readonly string[];

/**
 * The glyph for every flight verb.
 *
 * ⚠ `Record<RowActionID, …>`, so a verb added to `space/rowActions.ts` is a TYPE
 * ERROR here rather than a button that renders an empty box — the same
 * guarantee `ACTION_GLYPHS` and `NEOCOM_GLYPHS` give, and for the same reason:
 * a missing glyph is invisible in review.
 */
export const SPACE_ACTION_GLYPHS: Readonly<Record<RowActionID, SpaceActionGlyph>> = {
  // Warp: the two chevrons of "fast forward, a long way".
  warp: ["M5 6l6 6-6 6", "M13 6l6 6-6 6"],
  // Approach: go towards it. An arrow up to the thing, which is the line above.
  approach: ["M12 21V8", "M7 13l5-5 5 5", "M5 4h14"],
  // Orbit: a ring around a centre. The one shape that is unmistakably "circle
  // it" rather than "go to it".
  orbit: [
    "M12 4a8 8 0 1 0 0.01 0",
    "M12 11.5a0.5 0.5 0 1 0 0.01 0",
  ],
  // Keep at range: hold this distance — a span with a stop at each end.
  keepAtRange: ["M4 12h16", "M7 8.5L3.5 12 7 15.5", "M17 8.5L20.5 12 17 15.5"],
  // Align to: point the ship that way without going yet — a diagonal arrow.
  align: ["M5 19L18 6", "M12 6h6v6"],
  // Dock: down into a shape that holds you.
  dock: ["M12 3v9", "M8 8l4 4 4-4", "M4 16h16v4H4z"],
  // Jump: through the ring and out the other side.
  jump: ["M9 4a6 8 0 1 0 0 16", "M12 12h8", "M17 9l3 3-3 3"],
  // Lock: the four target brackets closing on it.
  lock: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"],
  // Unlock: the same brackets, struck through. Not a shared glyph — see above.
  unlock: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5", "M5 19L19 5"],
  // Mine: a laser reaching out to a rock.
  mine: ["M3 21l6-6", "M8 16l4-4", "M13 4l7 7-3.5 3.5-7-7z"],
  // Take everything: a crate with its contents coming OUT. The same crate the
  // haul glyph draws with its arrow reversed, because the two verbs are the two
  // directions of one idea; the captions ("Loot" / "Haul to …") say which.
  loot: ["M4 11h16v9H4z", "M4 11l2-4h12l2 4", "M12 7V1", "M9 4l3-3 3 3"],
  // Haul: a crate, and where it is going.
  haul: ["M4 9h16v11H4z", "M4 9l2-5h12l2 5", "M12 12v5", "M9.5 14.5L12 17l2.5-2.5"],
};

/**
 * The verbs the panel draws with a distance ON the button, because pressing
 * them flies at a remembered number and "Orbit" alone does not say which.
 */
export const RANGED_ACTIONS: ReadonlySet<RowActionID> = new Set<RowActionID>([
  "orbit",
  "keepAtRange",
]);

/**
 * A shorter CAPTION for a verb whose full name will not fit its button.
 *
 * ⚠ THE CAPTION ONLY. The button's accessible name and its tooltip stay the
 * model's own label, so nothing a screen reader or a hovering player is told
 * gets shortened — this is a typographic fix for a 58px box, not a rename.
 * "Keep at range 10 km" broke over three lines and turned one control into the
 * tallest thing in the bar.
 */
export const SHORT_ACTION_CAPTION: Partial<Readonly<Record<RowActionID, string>>> = {
  keepAtRange: "Keep",
  loot: "Loot",
};
