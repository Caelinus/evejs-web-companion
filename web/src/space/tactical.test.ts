// The tactical projection (goal R70, rescaled in R86): a compressed radius with
// a truthful bearing, a squashed disc with drop lines for height, rings that
// DEFINE the compression rather than decorate it, and a hit test that hands back
// the bracket a player can actually see.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_RANGE_METERS,
  RANGE_ANCHORS,
  bracketRole,
  hitTestBrackets,
  labelledBracketIDs,
  plotGeometry,
  projectBrackets,
  projectPoint,
  radialFraction,
  tacticalRings,
  type TacticalBracket,
  type TacticalViewport,
} from "./tactical.ts";
import { METRES_PER_AU } from "./overview.ts";
import type { SpaceEntity, SpaceVector } from "../store/types.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };

const VIEW: TacticalViewport = {
  width: 800,
  height: 600,
};

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "celestial",
    typeID: 16,
    groupID: 500,
    categoryID: 2,
    name: null,
    ownerID: null,
    radius: 100,
    position: ORIGIN,
    velocity: ORIGIN,
    isSelf: false,
    shieldRatio: null,
    armorRatio: null,
    hullRatio: null,
    characterID: null,
    corporationID: null,
    allianceID: null,
    securityStatus: null,
    maxVelocity: null,
    mode: null,
    capacitorRatio: null,
    remainingQuantity: null,
    miningYieldTypeID: null,
    beltID: null,
    oreGrade: null,
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...over,
  };
}

// --- the scale ---------------------------------------------------------------
//
// ⚠ REWRITTEN IN R86. These used to assert a plain logarithm between a caller's
// min and max ("10 km is one decade of three, so a third of the way out"). The
// scale is defined by ANCHORS now, and the reason is measurable: at a 20 AU rim
// the old curve put 10 km at 11% of the radius, 50 km at 18% and 100 km at 21%,
// so every range at which a pilot decides anything lived in the inner fifth of
// the picture.

test("the ship is the centre and the outermost anchor is the rim", () => {
  assert.equal(radialFraction(0), 0);
  assert.equal(radialFraction(MAX_RANGE_METERS), 1);
});

test("every anchor lands EXACTLY where it was pinned", () => {
  // The rings are drawn at these fractions, so if the curve did not pass through
  // them the labels would be in the wrong place — the one failure that would
  // make the whole picture lie.
  for (const anchor of RANGE_ANCHORS) {
    const actual = radialFraction(anchor.meters);
    assert.ok(
      Math.abs(actual - anchor.radial) < 1e-9,
      `${anchor.meters} m should sit at ${anchor.radial}, got ${actual}`,
    );
  }
});

test("the near field gets the MAJORITY of the radius", () => {
  // The whole point of the rework. 0-100 km is where a pilot makes decisions.
  const at100km = radialFraction(100_000);
  assert.ok(at100km > 0.6, `100 km should be past 60% of the radius, got ${at100km}`);
  // ...and it must still leave room for everything beyond.
  assert.ok(at100km < 0.8, `100 km at ${at100km} leaves too little for the rest`);
});

test("close range keeps its TRUE proportions", () => {
  // Inside the first ring the interpolation is linear on purpose: at scram range
  // 2 km and 8 km should look four times apart, because they are. A logarithm
  // there would flatten exactly the distances being judged most finely.
  const at2km = radialFraction(2_000);
  const at8km = radialFraction(8_000);
  assert.ok(Math.abs(at8km / at2km - 4) < 1e-9, `expected 4x, got ${at8km / at2km}`);
});

test("the scale never goes backwards", () => {
  // Monotonic across every band boundary — a further object must never be drawn
  // nearer, which piecewise interpolation makes easy to get wrong at the seams.
  let previous = -1;
  for (const distance of [
    100, 1_000, 5_000, 9_999, 10_000, 10_001, 25_000, 49_999, 50_000, 50_001,
    75_000, 99_999, 100_000, 100_001, 500_000, 1e6, 1e9, METRES_PER_AU,
    5 * METRES_PER_AU, 19.9 * METRES_PER_AU, MAX_RANGE_METERS,
  ]) {
    const value = radialFraction(distance);
    assert.ok(value >= previous, `${distance} m went backwards: ${value} < ${previous}`);
    previous = value;
  }
});

test("beyond the outermost anchor everything pins to the rim", () => {
  assert.equal(radialFraction(50 * METRES_PER_AU), 1);
  assert.equal(radialFraction(Number.MAX_VALUE), 1);
});

test("a nonsensical distance collapses to the centre rather than to NaN", () => {
  // A canvas silently declines to draw NaN, so a bracket would simply not appear.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY * 0, -1, -Infinity]) {
    const value = radialFraction(bad);
    assert.ok(Number.isFinite(value), `${bad} produced ${value}`);
    assert.equal(value, 0);
  }
});

test("the anchors themselves are ordered and bounded", () => {
  // They define the scale, so a table that is out of order or runs past the rim
  // makes every interpolation meaningless.
  let lastMeters = -1;
  let lastRadial = -1;
  for (const anchor of RANGE_ANCHORS) {
    assert.ok(anchor.meters > lastMeters, `anchor ${anchor.meters} m is out of order`);
    assert.ok(anchor.radial > lastRadial, `anchor at ${anchor.radial} is out of order`);
    assert.ok(anchor.radial >= 0 && anchor.radial <= 1, "an anchor sits outside the plot");
    lastMeters = anchor.meters;
    lastRadial = anchor.radial;
  }
  assert.equal(RANGE_ANCHORS[0]?.meters, 0, "the scale must start at the ship");
  assert.equal(RANGE_ANCHORS[RANGE_ANCHORS.length - 1]?.radial, 1, "the last anchor is the rim");
});

// --- the plot ----------------------------------------------------------------

test("plotGeometry centres the plot and keeps the margin clear", () => {
  const { cx, cy, radius } = plotGeometry({ ...VIEW, marginPx: 20, tilt: 1 });
  assert.equal(cx, 400);
  assert.equal(cy, 300);
  // Tilt 1 is a true circle, so the short axis (height) bounds it: 300 - 20.
  assert.equal(radius, 280);
});

test("plotGeometry lets a squashed disc use the width it has", () => {
  // At tilt 0.42 the disc is only 42% as tall as it is wide, so the height stops
  // constraining it and the plot may use nearly the full half-width.
  const { radius } = plotGeometry({ ...VIEW, marginPx: 20, tilt: 0.42 });
  assert.equal(radius, 380);
});

// --- the projection ----------------------------------------------------------

test("something at the ship's own position lands dead centre", () => {
  const point = projectPoint(ORIGIN, ORIGIN, VIEW);
  const { cx, cy } = plotGeometry(VIEW);
  assert.equal(point.x, cx);
  assert.equal(point.y, cy);
  assert.equal(point.distance, 0);
  assert.equal(point.radial, 0);
});

test("bearing is truthful: +x is right, +z is down-screen", () => {
  const { cx, cy } = plotGeometry(VIEW);
  const east = projectPoint({ x: 100_000, y: 0, z: 0 }, ORIGIN, VIEW);
  assert.ok(east.x > cx, "an object at +x must plot to the right of the ship");
  assert.ok(Math.abs(east.y - cy) < 1e-9, "and stay on the ship's own row");

  const south = projectPoint({ x: 0, y: 0, z: 100_000 }, ORIGIN, VIEW);
  assert.ok(Math.abs(south.x - cx) < 1e-9);
  assert.ok(south.y > cy, "an object at +z must plot below the ship");
});

test("two objects 90 degrees apart are drawn 90 degrees apart", () => {
  const { cx, cy } = plotGeometry({ ...VIEW, tilt: 1 });
  const view = { ...VIEW, tilt: 1 };
  const a = projectPoint({ x: 100_000, y: 0, z: 0 }, ORIGIN, view);
  const b = projectPoint({ x: 0, y: 0, z: 100_000 }, ORIGIN, view);
  const angleA = Math.atan2(a.y - cy, a.x - cx);
  const angleB = Math.atan2(b.y - cy, b.x - cx);
  assert.ok(Math.abs(Math.abs(angleB - angleA) - Math.PI / 2) < 1e-9);
});

test("the disc is squashed by the tilt", () => {
  const { cx, cy } = plotGeometry(VIEW);
  const east = projectPoint({ x: 1_000_000, y: 0, z: 0 }, ORIGIN, VIEW);
  const south = projectPoint({ x: 0, y: 0, z: 1_000_000 }, ORIGIN, VIEW);
  const acrossX = Math.abs(east.x - cx);
  const acrossY = Math.abs(south.planeY - cy);
  assert.ok(acrossY < acrossX, "the vertical half-axis must be the short one");
  assert.ok(Math.abs(acrossY / acrossX - 0.42) < 1e-9, "and squashed by exactly the tilt");
});

test("height lifts the object off its own place on the disc", () => {
  const above = projectPoint({ x: 100_000, y: 100_000, z: 0 }, ORIGIN, VIEW);
  assert.ok(above.y < above.planeY, "positive world height must draw UPWARD");
  assert.equal(above.heightMeters, 100_000);

  const below = projectPoint({ x: 100_000, y: -100_000, z: 0 }, ORIGIN, VIEW);
  assert.ok(below.y > below.planeY, "negative world height must draw downward");
  assert.equal(below.heightMeters, -100_000);
});

test("something on the plane has its object and its shadow in the same place", () => {
  const flat = projectPoint({ x: 100_000, y: 0, z: 50_000 }, ORIGIN, VIEW);
  assert.equal(flat.y, flat.planeY);
});

test("something directly overhead plots over the ship, not out at the rim", () => {
  // atan2(0, 0) is 0, which would park a straight-overhead object at the
  // three-o'clock rim if the FLAT distance did not drive the radius.
  const { cx } = plotGeometry(VIEW);
  const overhead = projectPoint({ x: 0, y: 500_000, z: 0 }, ORIGIN, VIEW);
  assert.ok(Math.abs(overhead.x - cx) < 1e-9, "must stay on the ship's own column");
  assert.ok(overhead.y < plotGeometry(VIEW).cy, "and be drawn above it");
});

test("beyond the rim clamps and says so", () => {
  const far = projectPoint({ x: 40 * METRES_PER_AU, y: 0, z: 0 }, ORIGIN, VIEW);
  assert.equal(far.clamped, true);
  assert.equal(far.radial, 1);
  // Still finite and on-screen — a clamped bracket is drawn at the rim, not off it.
  const { cx, radius } = plotGeometry(VIEW);
  assert.ok(Math.abs(far.x - cx - radius) < 1e-6);
});

test("inside the rim does not claim to be clamped", () => {
  const near = projectPoint({ x: 10_000, y: 0, z: 0 }, ORIGIN, VIEW);
  assert.equal(near.clamped, false);
});

test("the projection is measured from the SHIP, not from the origin of space", () => {
  const shipAt = { x: 1_000_000, y: 0, z: 0 };
  const { cx, cy } = plotGeometry(VIEW);
  const alongside = projectPoint(shipAt, shipAt, VIEW);
  assert.equal(alongside.x, cx);
  assert.equal(alongside.y, cy);
  assert.equal(alongside.distance, 0);
});

// --- roles -------------------------------------------------------------------

test("a belt rat is hostile even though it is kind:ship", () => {
  // R25's finding, restated for the viewport: `kind` cannot separate a pirate
  // from a person, so the role must go through the same predicate the threat
  // panel uses or the picture will disagree with the warning.
  const rat = entity({ itemID: 1, kind: "ship", isNpc: true, npcEntityType: "npc" });
  assert.equal(bracketRole(rat), "hostile");
});

test("law enforcement is not painted as a threat", () => {
  const police = entity({ itemID: 2, kind: "ship", isNpc: true, npcEntityType: "concord" });
  assert.equal(bracketRole(police), "police");
});

test("another player's ship is a plain ship", () => {
  const player = entity({ itemID: 3, kind: "ship", characterID: 140000005 });
  assert.equal(bracketRole(player), "ship");
});

test("an unknown NPC kind is treated as hostile, loudly", () => {
  const unknown = entity({ itemID: 4, kind: "ship", isNpc: true, npcEntityType: null });
  assert.equal(bracketRole(unknown), "hostile");
});

test("a rock is told from a planet by its ore, not by its kind", () => {
  const rock = entity({ itemID: 5, kind: "celestial", miningYieldTypeID: 1230 });
  assert.equal(bracketRole(rock), "asteroid");
  const planet = entity({ itemID: 6, kind: "celestial", groupID: 7 });
  assert.equal(bracketRole(planet), "celestial");
});

test("a stargate is its own role", () => {
  const gate = entity({ itemID: 7, kind: "celestial", groupID: 10 });
  assert.equal(bracketRole(gate), "gate");
});

test("a drone and a structure get their own roles", () => {
  assert.equal(bracketRole(entity({ itemID: 8, kind: "drone" })), "drone");
  assert.equal(bracketRole(entity({ itemID: 9, kind: "structure" })), "station");
});

// --- brackets ----------------------------------------------------------------

test("projectBrackets drops your own ship", () => {
  const brackets = projectBrackets(
    [entity({ itemID: 1, isSelf: true }), entity({ itemID: 2, position: { x: 10_000, y: 0, z: 0 } })],
    ORIGIN,
    VIEW,
  );
  assert.deepEqual(brackets.map((b) => b.itemID), [2]);
});

test("projectBrackets orders farthest first so the nearest draws on top", () => {
  const brackets = projectBrackets(
    [
      entity({ itemID: 1, position: { x: 10_000, y: 0, z: 0 } }),
      entity({ itemID: 2, position: { x: 500_000, y: 0, z: 0 } }),
      entity({ itemID: 3, position: { x: 100_000, y: 0, z: 0 } }),
    ],
    ORIGIN,
    VIEW,
  );
  assert.deepEqual(brackets.map((b) => b.itemID), [2, 3, 1]);
});

test("a stationary object gets no velocity vector", () => {
  const [bracket] = projectBrackets(
    [entity({ itemID: 1, position: { x: 10_000, y: 0, z: 0 } })],
    ORIGIN,
    VIEW,
  );
  assert.equal(bracket?.moving, false);
  assert.equal(bracket?.vectorX, 0);
  assert.equal(bracket?.vectorY, 0);
});

test("a moving object gets a vector pointing the way it is going", () => {
  const [bracket] = projectBrackets(
    [
      entity({
        itemID: 1,
        position: { x: 10_000, y: 0, z: 0 },
        velocity: { x: 200, y: 0, z: 0 },
      }),
    ],
    ORIGIN,
    VIEW,
  );
  assert.equal(bracket?.moving, true);
  assert.ok((bracket?.vectorX ?? 0) > 0, "moving +x must point right");
  assert.equal(bracket?.vectorY, 0);
});

test("a drifting object below the threshold is not called moving", () => {
  const [bracket] = projectBrackets(
    [
      entity({
        itemID: 1,
        position: { x: 10_000, y: 0, z: 0 },
        velocity: { x: 0.2, y: 0, z: 0 },
      }),
    ],
    ORIGIN,
    VIEW,
  );
  assert.equal(bracket?.moving, false);
});

test("brackets carry the health ratios the snapshot already sends", () => {
  const [bracket] = projectBrackets(
    [
      entity({
        itemID: 1,
        position: { x: 10_000, y: 0, z: 0 },
        shieldRatio: 0.5,
        armorRatio: 1,
        hullRatio: 1,
      }),
    ],
    ORIGIN,
    VIEW,
  );
  assert.equal(bracket?.shieldRatio, 0.5);
  assert.equal(bracket?.armorRatio, 1);
});

// --- rings -------------------------------------------------------------------
//
// ⚠ REWRITTEN IN R86. The rings used to be a fixed LADDER of candidate distances
// thinned to fit whatever range the plot happened to have, so most of these
// tests were about the thinning. The rings ARE the scale's anchors now, which
// makes the thinning — and every test of it — meaningless.

test("the rings are exactly the ranges a pilot asked for", () => {
  const rings = tacticalRings();
  assert.deepEqual(
    rings.map((ring) => ring.label),
    ["10 km", "50 km", "100 km", "20 AU"],
  );
});

test("every ring sits where the scale actually puts its distance", () => {
  // ⚠ THE ONE THAT MATTERS. A ring drawn anywhere other than where
  // `radialFraction` maps its own distance is a label pointing at the wrong
  // circle — the picture would be lying, and lying plausibly.
  for (const ring of tacticalRings()) {
    assert.equal(
      ring.radial,
      radialFraction(ring.meters),
      `the ${ring.label} ring is not drawn at ${ring.label}`,
    );
  }
});

test("rings come out in order, innermost first", () => {
  const rings = tacticalRings();
  for (let index = 1; index < rings.length; index += 1) {
    assert.ok(
      (rings[index]?.meters ?? 0) > (rings[index - 1]?.meters ?? 0),
      "rings must ascend",
    );
    assert.ok(
      (rings[index]?.radial ?? 0) > (rings[index - 1]?.radial ?? 0),
      "and so must their radii",
    );
  }
});

test("no ring sits on the ship or outside the rim", () => {
  for (const ring of tacticalRings()) {
    assert.ok(ring.radial > 0, `${ring.label} is on top of the ship`);
    assert.ok(ring.radial <= 1, `${ring.label} is outside the rim`);
  }
});

test("the ship's own anchor is not drawn as a ring", () => {
  // Anchor zero exists to make the innermost band interpolate; there is nothing
  // to label at the centre.
  assert.equal(
    tacticalRings().some((ring) => ring.meters === 0),
    false,
  );
});

test("AU rings are labelled in AU and short ones in km", () => {
  const labels = tacticalRings().map((ring) => ring.label);
  assert.ok(labels.some((label) => label.endsWith("km")));
  assert.ok(labels.some((label) => label.endsWith("AU")));
  for (const label of labels) {
    assert.match(label, /^\d+(\.\d)? (km|AU)$/);
  }
});

// --- labels ------------------------------------------------------------------

test("the selected object always gets a label", () => {
  const brackets = projectBrackets(
    [
      entity({ itemID: 1, position: { x: 900_000, y: 0, z: 0 } }),
      ...Array.from({ length: 20 }, (_, index) =>
        entity({ itemID: 100 + index, position: { x: 5_000 + index, y: 0, z: 0 } }),
      ),
    ],
    ORIGIN,
    VIEW,
  );
  // Object 1 is the FARTHEST of 21, so it would never make the nearest-few cut.
  const labelled = labelledBracketIDs(brackets, 1, 8);
  assert.ok(labelled.has(1), "the thing the player is looking at must be named");
});

test("every hostile gets a label however far out it is", () => {
  const brackets = projectBrackets(
    [
      entity({ itemID: 1, kind: "ship", isNpc: true, npcEntityType: "npc", position: { x: 900_000, y: 0, z: 0 } }),
      ...Array.from({ length: 20 }, (_, index) =>
        entity({ itemID: 100 + index, position: { x: 5_000 + index, y: 0, z: 0 } }),
      ),
    ],
    ORIGIN,
    VIEW,
  );
  const labelled = labelledBracketIDs(brackets, null, 8);
  assert.ok(labelled.has(1), "a threat you cannot name is a threat you cannot report");
});

test("the rest of the labels go to the NEAREST objects, not the first in the array", () => {
  const brackets = projectBrackets(
    [
      entity({ itemID: 1, position: { x: 5_000, y: 0, z: 0 } }),
      entity({ itemID: 2, position: { x: 50_000, y: 0, z: 0 } }),
      entity({ itemID: 3, position: { x: 500_000, y: 0, z: 0 } }),
    ],
    ORIGIN,
    VIEW,
  );
  const labelled = labelledBracketIDs(brackets, null, 2);
  assert.ok(labelled.has(1), "nearest must be labelled");
  assert.ok(labelled.has(2));
  assert.ok(!labelled.has(3), "the farthest must be the one dropped");
});

test("labels are capped so a belt does not become text soup", () => {
  const brackets = projectBrackets(
    Array.from({ length: 40 }, (_, index) =>
      entity({ itemID: index + 1, position: { x: 5_000 + index * 10, y: 0, z: 0 } }),
    ),
    ORIGIN,
    VIEW,
  );
  const labelled = labelledBracketIDs(brackets, null, 8);
  assert.equal(labelled.size, 8);
});

test("the cap counts only the nearest-few, so hostiles never crowd them out", () => {
  // Three hostiles plus a cap of 8 means 11 labels, not 8 — the cap bounds the
  // ordinary objects, and a threat is never dropped to make room for a rock.
  const brackets = projectBrackets(
    [
      ...Array.from({ length: 3 }, (_, index) =>
        entity({
          itemID: index + 1,
          kind: "ship",
          isNpc: true,
          npcEntityType: "npc",
          position: { x: 400_000 + index, y: 0, z: 0 },
        }),
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        entity({ itemID: 100 + index, position: { x: 5_000 + index, y: 0, z: 0 } }),
      ),
    ],
    ORIGIN,
    VIEW,
  );
  const labelled = labelledBracketIDs(brackets, null, 8);
  assert.equal(labelled.size, 11);
  assert.ok(labelled.has(1) && labelled.has(2) && labelled.has(3));
});

// --- hit testing -------------------------------------------------------------

function bracketAt(itemID: number, x: number, y: number, distance: number): TacticalBracket {
  return {
    itemID,
    x,
    y,
    planeY: y,
    distance,
    radial: 0.5,
    clamped: false,
    heightMeters: 0,
    role: "ship",
    name: null,
    typeID: null,
    shieldRatio: null,
    armorRatio: null,
    hullRatio: null,
    moving: false,
    vectorX: 0,
    vectorY: 0,
  };
}

test("a click picks the NEAREST bracket, not the first one in the array", () => {
  // The array is farthest-first, so a first-match hit test reliably hands back
  // the bracket the player can see least of.
  const brackets = [bracketAt(1, 100, 100, 900_000), bracketAt(2, 104, 100, 5_000)];
  const hit = hitTestBrackets(brackets, 105, 100);
  assert.equal(hit?.itemID, 2);
});

test("a click on empty space picks nothing", () => {
  const brackets = [bracketAt(1, 100, 100, 5_000)];
  assert.equal(hitTestBrackets(brackets, 400, 400), null);
});

test("the hit tolerance is honoured", () => {
  const brackets = [bracketAt(1, 100, 100, 5_000)];
  assert.equal(hitTestBrackets(brackets, 115, 100, 18)?.itemID, 1);
  assert.equal(hitTestBrackets(brackets, 125, 100, 18), null);
});

test("an exact tie goes to the nearer object in space", () => {
  const brackets = [bracketAt(1, 100, 100, 900_000), bracketAt(2, 100, 100, 5_000)];
  assert.equal(hitTestBrackets(brackets, 100, 100)?.itemID, 2);
});
