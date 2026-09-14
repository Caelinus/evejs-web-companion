// The stand-off band — guarding the arithmetic, not the flying.
//
// This file asserts the three numbers of §2 of docs/drone-boat-block-spec.md and
// nothing about how a block uses them. The cases that matter are not the tidy
// ones: the EMPTY BAND out of the spec's own worked table (a low-skill Tristan
// that cannot outrange the frigate holding it) and the UNREADABLE LEASH (drone
// control range is skill-derived and not on the hull row, so null is a likely
// real answer) are the two shapes this module exists for, and both have their
// own test below. So does the third awkward one: a grid full of rats where NONE
// of them can point anything, which is the case that must not produce an order
// to sit at 0 m.
//
// The last test is a coarse fuzz over every nasty input shape crossed with every
// other. It asserts one thing only — that no combination produces a NaN or a
// negative — because every number out of here is handed to a `keepAtRange` call,
// and a world call with a meaningless argument is a much worse failure than a
// wrong-but-sane distance.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FALLBACK_CONTROL_RANGE_M,
  LEASH_BUFFER_M,
  RANGE_HYSTERESIS_M,
  THREAT_BUFFER_M,
  kiteBand,
  shouldReissueHold,
  type BandInputs,
  type BandThreat,
} from "./kiteBand.ts";

/** A grid row, with the fields a test does not care about filled in. */
function threat(
  itemID: number,
  distanceM: number,
  scramRangeM: number | null = null,
  webs = false,
): BandThreat {
  return { itemID, distanceM, scramRangeM, webs };
}

/** A well-skilled pilot unless a test says otherwise, so each case can state the
 *  one input it is about. */
function inputs(over: Partial<BandInputs> = {}): BandInputs {
  return {
    threats: [],
    droneControlRangeM: 45000,
    maxTargetRangeM: 40000,
    overrideHoldM: null,
    ...over,
  };
}

test("the floor comes from the worst scrammer on grid, not the nearest one", () => {
  // The close rat scrams at 7.5 km, the far one at 24 km. Holding off the reach
  // of the near one would park the ship comfortably inside the far one's point.
  const band = kiteBand(
    inputs({
      threats: [threat(1, 4000, 7500), threat(2, 30000, 24000)],
      droneControlRangeM: 90000,
      maxTargetRangeM: 90000,
    }),
  );
  assert.equal(band.floorM, 24000 + THREAT_BUFFER_M);
  assert.equal(band.holdM, 29000);
  // …and the anchor is still the NEAR scrammer, because that is the object the
  // ship can actually hold range from. Floor by reach, anchor by distance.
  assert.equal(band.anchorID, 1);
});

test("a hostile that cannot scram never raises the floor", () => {
  const band = kiteBand(
    inputs({ threats: [threat(1, 3000, null), threat(2, 8000, null)] }),
  );
  assert.equal(band.floorM, 0);
  assert.equal(band.empty, false);
});

test("rats on grid but none that scram: hold at the ceiling, not at 0 m", () => {
  // The "hold at the floor" argument is about drone travel time, and it only
  // outranks safety while something can actually grab the ship. Nothing here
  // can, so the far end of the leash is the right place to be — and an order to
  // keepAtRange 0 would be an order to sit on top of the rats.
  const band = kiteBand(
    inputs({ threats: [threat(1, 3000, null), threat(2, 8000, null)] }),
  );
  assert.equal(band.floorM, 0);
  assert.equal(band.ceilingM, 37000);
  assert.equal(band.holdM, 37000);
  // Not "no-threat": there are rats here, and telling the player the grid is
  // empty while they are being shot at is a lie the readout must not be able to
  // tell.
  assert.equal(band.reason, "no-tackle");
  // Still a real object to keep station against.
  assert.equal(band.anchorID, 1);
});

test("the ceiling is the smaller of the two leashes, minus the buffer", () => {
  const droneLeashed = kiteBand(
    inputs({ droneControlRangeM: 30000, maxTargetRangeM: 80000 }),
  );
  assert.equal(droneLeashed.ceilingM, 30000 - LEASH_BUFFER_M);

  const lockLeashed = kiteBand(
    inputs({ droneControlRangeM: 80000, maxTargetRangeM: 30000 }),
  );
  assert.equal(lockLeashed.ceilingM, 30000 - LEASH_BUFFER_M);
});

test("a null lock range drops out of the arithmetic entirely", () => {
  // `maxTargetRangeM` is commonly null on the hull rows in this codebase — "the
  // hull did not say" is not "the hull cannot lock anything".
  const noLock = kiteBand(
    inputs({ droneControlRangeM: 45000, maxTargetRangeM: null }),
  );
  assert.equal(noLock.ceilingM, 45000 - LEASH_BUFFER_M);
});

test("a readable lock range NEVER stands in for an unreadable drone control range", () => {
  // ⚠ THE REGRESSION THIS FILE EXISTS TO CATCH. Lock range is how far the ship
  // can target; drone control range is how far the drones still answer. Reading
  // one as the other routes the commonest fit in the game — a hull that reports
  // its lock range and not the pilot's skill-derived control range — straight
  // around the empty-band protection, and leaves the protection sitting in the
  // code looking like it works.
  const band = kiteBand(
    inputs({
      threats: [threat(1, 12000, 20000)],
      droneControlRangeM: null,
      maxTargetRangeM: 40000,
    }),
  );
  // NOT 37 000. The drones are assumed to reach 20 km until somebody says
  // otherwise, so the ceiling is 17 km and the 25 km floor has nowhere to go.
  assert.equal(band.ceilingM, FALLBACK_CONTROL_RANGE_M - LEASH_BUFFER_M);
  assert.equal(band.floorM, 25000);
  assert.equal(band.empty, true);
  assert.equal(band.holdM, 17000);
  // And it says which number it had to invent, so the readout can ask for it.
  assert.equal(band.reason, "fallback");
});

test("the hold sits at the floor, not the ceiling, when the band is open", () => {
  const band = kiteBand(
    inputs({
      threats: [threat(7, 12000, 20000)],
      droneControlRangeM: 60000,
      maxTargetRangeM: 60000,
    }),
  );
  assert.equal(band.floorM, 25000);
  assert.equal(band.ceilingM, 57000);
  // The drones fly every metre of stand-off on every target switch, so the extra
  // 32 km of "safety" would be paid for in drone transit and bought nothing.
  assert.equal(band.holdM, 25000);
  assert.equal(band.reason, "floor");
  assert.equal(band.empty, false);
});

test("the spec's low-skill row: the band is empty and the block brawls at the ceiling", () => {
  // Tristan, 27.5 km of drone control range, 40 km lock, one Dire Pithi
  // Arrogator scramming at 20 km. Floor 25 km, ceiling 24.5 km — no room.
  const band = kiteBand(
    inputs({
      threats: [threat(42, 18000, 20000)],
      droneControlRangeM: 27500,
      maxTargetRangeM: 40000,
    }),
  );
  assert.equal(band.floorM, 25000);
  assert.equal(band.ceilingM, 24500);
  assert.equal(band.empty, true);
  assert.equal(band.holdM, 24500);
  assert.equal(band.reason, "ceiling");
  assert.equal(band.anchorID, 42);
});

test("the spec's high-skill row: the same grid, 45 km of control, a 25 km hold", () => {
  const band = kiteBand(
    inputs({
      threats: [threat(42, 18000, 20000)],
      droneControlRangeM: 45000,
      maxTargetRangeM: 40000,
    }),
  );
  assert.equal(band.floorM, 25000);
  assert.equal(band.ceilingM, 37000);
  assert.equal(band.empty, false);
  assert.equal(band.holdM, 25000);
  assert.equal(band.reason, "floor");
});

test("a fresh wave with a longer-ranged scrammer moves the hold out from under the ship", () => {
  const firstWave = inputs({
    threats: [threat(1, 9000, 9000)],
    droneControlRangeM: 60000,
    maxTargetRangeM: 60000,
  });
  const before = kiteBand(firstWave);
  assert.equal(before.holdM, 14000);

  // Same grid plus one new arrival that points from 24 km. The band is computed
  // off the grid every tick precisely so this moves.
  const after = kiteBand({
    ...firstWave,
    threats: [...firstWave.threats, threat(2, 40000, 24000)],
  });
  assert.equal(after.holdM, 29000);
  assert.equal(
    shouldReissueHold(before.holdM, after.holdM, before.anchorID !== after.anchorID),
    true,
  );
});

test("nothing measurable and nothing asked for: the no-skills base, and it says so", () => {
  const band = kiteBand(
    inputs({
      threats: [threat(1, 9000, 20000)],
      droneControlRangeM: null,
      maxTargetRangeM: null,
    }),
  );
  // 20 km assumed, 3 km off it: a 25 km floor has nowhere to go.
  assert.equal(band.ceilingM, FALLBACK_CONTROL_RANGE_M - LEASH_BUFFER_M);
  assert.equal(band.empty, true);
  assert.equal(band.holdM, 17000);
  // Not "ceiling": the actionable half of the sentence is that the leash was a
  // guess, so the player can go and tell us the real one.
  assert.equal(band.reason, "fallback");
});

test("a guessed leash that decides nothing is not reported as the reason", () => {
  // Nothing measurable, but the floor is well inside even the guessed ceiling —
  // saying "fallback" here would send the player off to fix a number that is not
  // in their way.
  const band = kiteBand(
    inputs({
      threats: [threat(1, 3000, 5000)],
      droneControlRangeM: null,
      maxTargetRangeM: null,
    }),
  );
  assert.equal(band.holdM, 10000);
  assert.ok(band.holdM < band.ceilingM);
  assert.equal(band.reason, "floor");
});

test("an override is honoured outright, including inside the floor", () => {
  const band = kiteBand(
    inputs({
      threats: [threat(1, 9000, 20000)],
      droneControlRangeM: 60000,
      maxTargetRangeM: 60000,
      overrideHoldM: 8000,
    }),
  );
  assert.equal(band.floorM, 25000);
  // A player who deliberately asks to brawl inside scram range is allowed to.
  assert.equal(band.holdM, 8000);
  assert.equal(band.reason, "override");
});

test("an override past a MEASURED ceiling is clamped — drones that do not answer are not a tactic", () => {
  const band = kiteBand(
    inputs({
      threats: [threat(1, 9000, 20000)],
      droneControlRangeM: 45000,
      maxTargetRangeM: 40000,
      overrideHoldM: 80000,
    }),
  );
  assert.equal(band.ceilingM, 37000);
  assert.equal(band.holdM, 37000);
  assert.equal(band.reason, "ceiling");
});

test("an override standing in for an unreadable drone leash is honoured at face value", () => {
  const nothingElseKnown = kiteBand(
    inputs({
      threats: [threat(1, 9000, 20000)],
      droneControlRangeM: null,
      maxTargetRangeM: null,
      overrideHoldM: 30000,
    }),
  );
  // No buffer comes off it. The leash buffer protects against drift around the
  // edge of a MEASURED leash; there is no measured edge here, so taking 3 km off
  // would be silently correcting the player against a number we do not have —
  // and they know their own skills better than our 20 km guess does.
  assert.equal(nothingElseKnown.ceilingM, 30000);
  assert.equal(nothingElseKnown.holdM, 30000);
  assert.equal(nothingElseKnown.reason, "override");

  // A readable LOCK range does not change that — it is a separate leash, and
  // here it is the slacker of the two.
  const lockKnown = kiteBand(
    inputs({
      threats: [threat(1, 9000, 20000)],
      droneControlRangeM: null,
      maxTargetRangeM: 40000,
      overrideHoldM: 30000,
    }),
  );
  assert.equal(lockKnown.ceilingM, 30000);
  assert.equal(lockKnown.reason, "override");

  // …but when the lock range is the tighter leash it still clamps, and a
  // MEASURED leash clamping an override reports "ceiling", not "fallback":
  // nothing was guessed, the ship simply cannot lock that far.
  const lockClamps = kiteBand(
    inputs({
      threats: [threat(1, 9000, 20000)],
      droneControlRangeM: null,
      maxTargetRangeM: 40000,
      overrideHoldM: 50000,
    }),
  );
  assert.equal(lockClamps.ceilingM, 37000);
  assert.equal(lockClamps.holdM, 37000);
  assert.equal(lockClamps.reason, "ceiling");
});

test("an empty grid holds at the ceiling with no anchor", () => {
  const band = kiteBand(inputs({ threats: [] }));
  assert.equal(band.floorM, 0);
  assert.equal(band.ceilingM, 37000);
  assert.equal(band.holdM, 37000);
  assert.equal(band.empty, false);
  assert.equal(band.reason, "no-threat");
  assert.equal(band.anchorID, null);
});

test("the anchor is the nearest scrammer, then the nearest webber, then the nearest threat", () => {
  const scrammerBehindAHarmlessRat = kiteBand(
    inputs({ threats: [threat(1, 2000, null), threat(2, 12000, 20000)] }),
  );
  assert.equal(scrammerBehindAHarmlessRat.anchorID, 2);

  // A scram outranks a web even when the webber is closer: the thing that can
  // HOLD the ship is the thing the stand-off is measured against.
  const webberInFront = kiteBand(
    inputs({
      threats: [threat(1, 2000, null, true), threat(2, 12000, 20000, false)],
    }),
  );
  assert.equal(webberInFront.anchorID, 2);

  // Nothing points, so the webber is the rat worth keeping station against —
  // even though it did not move the floor.
  const webberOnly = kiteBand(
    inputs({
      threats: [threat(1, 2000, null, false), threat(2, 12000, null, true)],
    }),
  );
  assert.equal(webberOnly.anchorID, 2);
  assert.equal(webberOnly.floorM, 0);
  assert.equal(webberOnly.reason, "no-tackle");

  const noneThreaten = kiteBand(
    inputs({ threats: [threat(9, 30000, null), threat(8, 6000, null)] }),
  );
  assert.equal(noneThreaten.anchorID, 8);

  assert.equal(kiteBand(inputs({ threats: [] })).anchorID, null);

  // A tie breaks on itemID rather than array order, so the anchor — and with it
  // the standing keepAtRange order — does not flicker between two rats sitting
  // at the same distance.
  const tied = kiteBand(
    inputs({ threats: [threat(77, 5000, 1000), threat(12, 5000, 1000)] }),
  );
  assert.equal(tied.anchorID, 12);
});

test("a hostile with an unreadable distance never wins the anchor", () => {
  const band = kiteBand(
    inputs({
      threats: [
        threat(1, Number.NaN, 20000),
        threat(2, 15000, 20000),
      ],
    }),
  );
  assert.equal(band.anchorID, 2);
});

test("hysteresis both ways: a small drift falls through, a real move re-issues", () => {
  // Inside the band: the rung falls through and the tick goes to shooting.
  assert.equal(shouldReissueHold(25000, 25000 + RANGE_HYSTERESIS_M, false), false);
  assert.equal(shouldReissueHold(25000, 25000 - RANGE_HYSTERESIS_M, false), false);
  assert.equal(shouldReissueHold(25000, 24900, false), false);

  // Past it, in either direction.
  assert.equal(shouldReissueHold(25000, 25000 + RANGE_HYSTERESIS_M + 1, false), true);
  assert.equal(shouldReissueHold(25000, 25000 - RANGE_HYSTERESIS_M - 1, false), true);

  // No standing order at all: first tick of the site, or one issued before a
  // reconnect and no longer ours to assume.
  assert.equal(shouldReissueHold(null, 25000, false), true);

  // A new anchor always costs the action: the old order maintains a distance
  // from a different object, which is nobody's intention.
  assert.equal(shouldReissueHold(25000, 25000, true), true);

  // An unreadable wanted hold is not a reason to fire off a call carrying it.
  assert.equal(shouldReissueHold(25000, Number.NaN, false), false);
});

test("no combination of nulls, zeros, junk or negatives yields a NaN, a negative, or a nonsense reason", () => {
  const REASONS = new Set([
    "override",
    "floor",
    "ceiling",
    "no-tackle",
    "no-threat",
    "fallback",
  ]);
  const NASTY: unknown[] = [
    null,
    undefined,
    0,
    -1,
    -40000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1,
    500,
    20000,
    1e12,
    "40000",
  ];
  const GRIDS: BandThreat[][] = [
    [],
    [threat(1, 0, 0)],
    [threat(1, -5000, -5000, true)],
    [threat(1, Number.NaN, Number.NaN)],
    [threat(1, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)],
    [threat(1, 10000, null, true), threat(2, 20000, 1e12)],
    [threat(1, 10000, null), threat(2, 20000, null)],
  ];

  let cases = 0;
  for (const grid of GRIDS) {
    for (const control of NASTY) {
      for (const lock of NASTY) {
        for (const override of NASTY) {
          const band = kiteBand({
            threats: grid,
            droneControlRangeM: control as number | null,
            maxTargetRangeM: lock as number | null,
            overrideHoldM: override as number | null,
          });
          const where = JSON.stringify({ grid, control, lock, override });
          for (const [name, value] of [
            ["holdM", band.holdM],
            ["floorM", band.floorM],
            ["ceilingM", band.ceilingM],
          ] as const) {
            assert.ok(
              Number.isFinite(value) && value >= 0,
              `${name} was ${String(value)} for ${where}`,
            );
          }
          assert.ok(band.holdM <= band.ceilingM, `hold above the ceiling for ${where}`);
          assert.equal(typeof band.empty, "boolean");
          assert.ok(REASONS.has(band.reason), `bad reason for ${where}`);
          assert.ok(
            band.anchorID === null || Number.isFinite(band.anchorID),
            `bad anchor for ${where}`,
          );
          // A grid with rats on it always has something to hold range from.
          assert.equal(
            band.anchorID === null,
            grid.length === 0,
            `anchor disagreed with the grid for ${where}`,
          );
          cases += 1;
        }
      }
    }
  }
  assert.equal(cases, GRIDS.length * NASTY.length ** 3);
});
