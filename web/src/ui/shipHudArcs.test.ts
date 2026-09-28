// The circular ship HUD's geometry (goal R71): arcs that grow clockwise from the
// bottom left, a null reading that draws nothing rather than an empty gauge, a
// full ring that does not vanish, and a discrete capacitor whose segments never
// overlap.

import test from "node:test";
import assert from "node:assert/strict";

import {
  GAUGE_START_DEG,
  GAUGE_SWEEP_DEG,
  arcPath,
  capacitorSegments,
  gaugeArc,
  gaugeTrack,
  polarPoint,
} from "./shipHudArcs.ts";

const CX = 50;
const CY = 50;

/**
 * How close two bearings recovered from a PATH STRING may be called equal.
 *
 * ⚠ NOT 1e-9. `arcPath` rounds its coordinates to three decimals so the emitted
 * SVG is not a wall of float noise, which means a bearing read back out of a
 * path carries up to ~5e-5 rad of rounding. At the radii this HUD uses that is
 * about two thousandths of a viewBox unit — far under a pixel, and invisible.
 * A tolerance tighter than the source data's own precision does not test the
 * geometry harder, it just fails.
 */
const BEARING_EPSILON = 2e-3;

/** Pull the two endpoints out of an "M x y A r r 0 f f x y" path. */
function endpoints(path: string): { from: [number, number]; to: [number, number] } {
  const numbers = path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  // M x y  A rx ry rot largeArc sweep x y
  return {
    from: [numbers[0] as number, numbers[1] as number],
    to: [numbers[7] as number, numbers[8] as number],
  };
}

// --- the convention ----------------------------------------------------------

test("0 degrees is three o'clock", () => {
  const point = polarPoint(CX, CY, 10, 0);
  assert.ok(Math.abs(point.x - 60) < 1e-9);
  assert.ok(Math.abs(point.y - 50) < 1e-9);
});

test("angles increase CLOCKWISE on screen", () => {
  // SVG's y-axis points down, so a rising angle sweeps clockwise. 90° must be
  // BELOW the centre, not above it — get this backwards and every gauge fills
  // the wrong way round.
  const point = polarPoint(CX, CY, 10, 90);
  assert.ok(Math.abs(point.x - 50) < 1e-9);
  assert.ok(point.y > CY, "90 degrees must be below the centre");
});

test("the gauges start at the bottom left", () => {
  const start = polarPoint(CX, CY, 10, GAUGE_START_DEG);
  assert.ok(start.x < CX, "left of centre");
  assert.ok(start.y > CY, "below centre");
});

test("the gauges leave a gap centred on the bottom", () => {
  // 150° -> 390°, so the untouched span is 30°..150°, centred on 90° (the
  // bottom). That gap is where the speed readout sits.
  //
  // ⚠ The numbers moved for the in-space redesign (a 240° sweep instead of
  // 270°) and the SHAPE did not: both assertions below held before and after,
  // which is the point of testing the shape rather than the constant.
  assert.equal(GAUGE_START_DEG + GAUGE_SWEEP_DEG, 390);
  const end = polarPoint(CX, CY, 10, GAUGE_START_DEG + GAUGE_SWEEP_DEG);
  assert.ok(end.x > CX, "ends right of centre");
  assert.ok(end.y > CY, "and below it");
});

// --- arcs --------------------------------------------------------------------

test("an arc is drawn clockwise", () => {
  // sweep-flag 1 is clockwise. A 0 here mirrors every gauge through the centre.
  const path = arcPath(CX, CY, 40, 0, 90);
  assert.match(path, /A 40 40 0 \d 1 /);
});

test("the large-arc flag flips past a half turn", () => {
  assert.match(arcPath(CX, CY, 40, 0, 90), /A 40 40 0 0 1 /);
  assert.match(arcPath(CX, CY, 40, 0, 200), /A 40 40 0 1 1 /);
});

test("a full-sweep ring still draws — it does not collapse to nothing", () => {
  // An SVG arc whose endpoints coincide renders NOTHING, so an unclamped 360°
  // would make a full gauge disappear exactly when it was full.
  const path = arcPath(CX, CY, 40, 0, 360);
  assert.notEqual(path, "");
  const { from, to } = endpoints(path);
  assert.ok(
    Math.hypot(from[0] - to[0], from[1] - to[1]) > 1e-6,
    "the endpoints must not coincide",
  );
});

test("a zero or negative sweep draws nothing at all", () => {
  assert.equal(arcPath(CX, CY, 40, 0, 0), "");
  assert.equal(arcPath(CX, CY, 40, 0, -30), "");
});

test("a zero radius draws nothing rather than a malformed path", () => {
  assert.equal(arcPath(CX, CY, 0, 0, 90), "");
});

// --- gauges ------------------------------------------------------------------

test("a full gauge sweeps the whole track", () => {
  assert.equal(gaugeArc(1, CX, CY, 40), gaugeTrack(CX, CY, 40));
});

test("a half gauge ends half way round the track", () => {
  const half = gaugeArc(0.5, CX, CY, 40);
  const expected = arcPath(CX, CY, 40, GAUGE_START_DEG, GAUGE_SWEEP_DEG / 2);
  assert.equal(half, expected);
});

test("a gauge grows from the start, not from the middle", () => {
  // Every partial arc must begin at the same point; only its end moves.
  const quarter = endpoints(gaugeArc(0.25, CX, CY, 40));
  const threeQuarters = endpoints(gaugeArc(0.75, CX, CY, 40));
  assert.deepEqual(quarter.from, threeQuarters.from);
  assert.notDeepEqual(quarter.to, threeQuarters.to);
});

test("an empty gauge draws nothing", () => {
  assert.equal(gaugeArc(0, CX, CY, 40), "");
});

test("an UNKNOWN reading draws nothing — and is not the same as empty", () => {
  // "We have no reading for your armor" and "your armor is gone" must never look
  // alike. Both draw an empty track here; the component tells them apart in TEXT
  // (a dash versus 0%), which is why neither may fabricate an arc.
  assert.equal(gaugeArc(null, CX, CY, 40), "");
  assert.equal(gaugeArc(undefined, CX, CY, 40), "");
  assert.equal(gaugeArc(Number.NaN, CX, CY, 40), "");
});

test("a ratio outside 0-1 is clamped rather than overrunning the ring", () => {
  assert.equal(gaugeArc(1.4, CX, CY, 40), gaugeArc(1, CX, CY, 40));
  assert.equal(gaugeArc(-0.3, CX, CY, 40), "");
});

test("gauges at different radii are concentric", () => {
  const outer = endpoints(gaugeArc(0.5, CX, CY, 44));
  const inner = endpoints(gaugeArc(0.5, CX, CY, 30));
  // Same bearing from the centre, different distance — that is what concentric
  // means, and it is what makes the three rings read as one instrument.
  const bearing = (p: [number, number]): number => Math.atan2(p[1] - CY, p[0] - CX);
  assert.ok(Math.abs(bearing(outer.from) - bearing(inner.from)) < BEARING_EPSILON);
  assert.ok(Math.abs(bearing(outer.to) - bearing(inner.to)) < BEARING_EPSILON);
});

// --- capacitor ---------------------------------------------------------------

test("the capacitor is discrete: one path per segment", () => {
  const segments = capacitorSegments(12, CX, CY, 22);
  assert.equal(segments.length, 12);
  for (const segment of segments) {
    assert.notEqual(segment.path, "", "every segment must draw");
  }
});

test("capacitor segments are evenly spaced and do not overlap", () => {
  const segments = capacitorSegments(12, CX, CY, 22);
  const bearings = segments.map((segment) => {
    const { from } = endpoints(segment.path);
    return Math.atan2(from[1] - CY, from[0] - CX);
  });
  // Consecutive starts must differ by the same step. Unwrapped, because the ring
  // crosses the -pi/+pi seam.
  const steps: number[] = [];
  for (let index = 1; index < bearings.length; index += 1) {
    let step = (bearings[index] as number) - (bearings[index - 1] as number);
    if (step < 0) step += Math.PI * 2;
    steps.push(step);
  }
  // ⚠ UNIFORMITY ALONE IS NOT ENOUGH, and this is not a hypothetical. Twelve
  // segments all stacked at the SAME angle are perfectly uniform — every step is
  // equally zero — so a test that only compared the steps to each other passed
  // against a build whose ring had collapsed into a single arc. The expected
  // step has to be named.
  const expected = ((GAUGE_SWEEP_DEG / 12) * Math.PI) / 180;
  for (const step of steps) {
    assert.ok(
      Math.abs(step - expected) < BEARING_EPSILON,
      `expected a ${expected} rad step between segments, got ${step}`,
    );
  }
});

test("the capacitor ring occupies the same span as the gauges", () => {
  // It sits inside them, so a different span would read as a mistake.
  const segments = capacitorSegments(12, CX, CY, 22);
  const firstStart = endpoints(segments[0]?.path ?? "").from;
  const trackStart = endpoints(gaugeTrack(CX, CY, 22)).from;
  // The first segment starts half a gap in, so it is close to but not exactly
  // the track's start.
  assert.ok(Math.hypot(firstStart[0] - trackStart[0], firstStart[1] - trackStart[1]) < 2);
});

test("a gap wider than the segment cannot invert the ring into gaps", () => {
  // With 24 segments each span is 11.25°; a 30° gap would produce negative-width
  // segments, i.e. an empty ring, which would read as a dead capacitor.
  const segments = capacitorSegments(24, CX, CY, 22, 30);
  assert.equal(segments.length, 24);
  for (const segment of segments) {
    assert.notEqual(segment.path, "", "a segment must survive an over-wide gap");
  }
});

test("a nonsensical segment count yields no ring rather than throwing", () => {
  assert.deepEqual(capacitorSegments(0, CX, CY, 22), []);
  assert.deepEqual(capacitorSegments(-4, CX, CY, 22), []);
});
