// THE SHIP HUD'S RING GEOMETRY (goal R71) — pure, framework-free, testable.
//
// WHY THE HUD WENT ROUND. The shield/armor/hull triad was three horizontal bars
// under a capacitor wheel. Everything was readable, but it read as a settings
// page: three progress bars stacked in a box. The retail HUD is the single most
// recognisable image in EVE — three concentric arcs wrapped around a segmented
// capacitor ring — and a pilot reads their own condition off its SHAPE long
// before they read a number off it.
//
// This module turns ratios into SVG path strings. It is separate from the
// component for the reason the rest of this codebase already applies: an arc
// drawn by interpolating numbers into a `d=` attribute inside a template can
// only be checked by rendering it and looking at it, and looking proves nothing
// about whether a half-full shield draws a half arc.
//
// ---------------------------------------------------------------------------
// THE COORDINATE CONVENTION, ONCE, HERE
//
// Angles are DEGREES, 0° at three o'clock, increasing CLOCKWISE. That falls out
// of SVG's y-axis pointing down: with `x = cx + r·cos θ, y = cy + r·sin θ`, a
// rising θ sweeps clockwise on screen. Every angle in this file and every angle
// passed into it uses that convention, so there is exactly one place to be
// confused about it rather than one per call site.
//
// The gauges run from 150° (bottom left) clockwise through 240° to 30°
// (bottom right), leaving a 120° gap centred on the bottom. The gap is not
// decoration: it is where the speed readout sits, and it is what stops the
// rings from reading as a solid target.
//
// ⚠ THE HANDOFF'S "START 210°" IS NOT THIS FILE'S 210°. The in-space design
// specifies a 240° sweep opening at the bottom, and gives a start angle in its
// own drawing tool's convention. Copying that number here would have put the
// gap on the LEFT, because 0° is three o'clock here and angles increase
// clockwise. What is honoured is the SHAPE the handoff draws — a 240° arc with
// its opening at the bottom — expressed in this file's own terms.
//
// ⚠ A SWEEP OF 360° IS NOT ALLOWED AND IS NOT AN OVERSIGHT. An SVG arc whose
// start and end points are identical is degenerate — the renderer draws nothing
// at all, so a "full" ring would vanish exactly when it was full. Anything
// wanting a closed ring must use a <circle>, not this.

/** Where the gauge arcs begin, in this file's convention. */
export const GAUGE_START_DEG = 150;
/** How far they sweep. 240° leaves a 120° gap centred on the bottom. */
export const GAUGE_SWEEP_DEG = 240;

/** A point on a circle, in the convention above. */
export function polarPoint(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number,
): { readonly x: number; readonly y: number } {
  const radians = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

/** Trim a float for an SVG attribute — three decimals is well under a pixel. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * An arc path from `startDeg` sweeping CLOCKWISE by `sweepDeg`.
 *
 * Returns an empty string for a sweep of zero or less — an empty `d` draws
 * nothing, which is what an empty gauge should do, and is safer than emitting a
 * malformed path.
 */
export function arcPath(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  sweepDeg: number,
): string {
  if (!Number.isFinite(sweepDeg) || sweepDeg <= 0 || !Number.isFinite(radius) || radius <= 0) {
    return "";
  }
  // Clamped below a full turn: at exactly 360° the start and end points coincide
  // and SVG draws nothing at all (see the note at the top of this file).
  const sweep = Math.min(sweepDeg, 359.999);
  const from = polarPoint(cx, cy, radius, startDeg);
  const to = polarPoint(cx, cy, radius, startDeg + sweep);
  const largeArc = sweep > 180 ? 1 : 0;
  // sweep-flag 1 = clockwise, matching this file's angle convention.
  return `M ${round(from.x)} ${round(from.y)} A ${round(radius)} ${round(radius)} 0 ${largeArc} 1 ${round(to.x)} ${round(to.y)}`;
}

/**
 * The FILLED portion of a gauge ring for a 0-1 ratio.
 *
 * ⚠ A NULL RATIO DRAWS NOTHING, AND THAT IS NOT THE SAME AS ZERO. "We have no
 * reading for your armor" and "your armor is gone" must never look alike — the
 * component pairs this with a dash in the text, so an unknown layer shows an
 * empty track and says so, while a genuinely empty one shows an empty track and
 * says 0%.
 */
export function gaugeArc(
  ratio: number | null | undefined,
  cx: number,
  cy: number,
  radius: number,
): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return "";
  }
  const clamped = Math.max(0, Math.min(1, ratio));
  return arcPath(cx, cy, radius, GAUGE_START_DEG, GAUGE_SWEEP_DEG * clamped);
}

/** The full, unfilled track a gauge is drawn on. */
export function gaugeTrack(cx: number, cy: number, radius: number): string {
  return arcPath(cx, cy, radius, GAUGE_START_DEG, GAUGE_SWEEP_DEG);
}

/** One capacitor segment: its own arc, so it can be lit independently. */
export interface CapacitorSegment {
  /** Position around the ring, 0 first. Used as a list key, never rendered. */
  readonly index: number;
  readonly path: string;
}

/**
 * The capacitor ring, as `count` discrete arcs with a gap between each.
 *
 * ⚠ DISCRETE IS THE POINT. EVE's capacitor has never been a smooth bar, and a
 * pilot counts remaining segments rather than reading a percentage — "three
 * left" is a decision, "24%" is a number you then have to convert. Each segment
 * is its own path so the component can light exactly the count that
 * `capacitorSegments()` already works out, rather than approximating with a
 * dash pattern that would not land on segment boundaries.
 */
export function capacitorSegments(
  count: number,
  cx: number,
  cy: number,
  radius: number,
  gapDeg = 4,
): readonly CapacitorSegment[] {
  if (!Number.isFinite(count) || count <= 0) {
    return [];
  }
  const each = GAUGE_SWEEP_DEG / count;
  // A gap wider than the segment it separates would invert the ring into a row
  // of gaps, so it is bounded by what is actually available.
  const gap = Math.max(0, Math.min(gapDeg, each * 0.6));
  const segments: CapacitorSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = GAUGE_START_DEG + index * each + gap / 2;
    segments.push({ index, path: arcPath(cx, cy, radius, start, each - gap) });
  }
  return segments;
}
