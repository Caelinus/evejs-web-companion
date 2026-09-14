import test from "node:test";
import assert from "node:assert/strict";

import {
  ADVANCED_DRONE_AVIONICS_TYPE_ID,
  BASE_DRONE_CONTROL_RANGE_M,
  DRONE_AVIONICS_TYPE_ID,
  DRONE_RANGE_BONUS_ATTRIBUTE_ID,
  DRONE_RANGE_SKILL_TYPE_IDS,
  droneControlRangeFromSkills,
  resolveDroneControlRangeM,
  type DroneRangeSkillReading,
} from "./droneControlRange.ts";

/**
 * The per-level bonuses as the LOCAL SDE build carries them on each skill's own
 * typeDogma row (attribute 459). They are written here as the values a dogma
 * READ handed back, never as the module's own constants — the whole point of
 * the module is that it holds neither number, so a test that asserted against a
 * constant imported from it would be asserting nothing.
 */
const AVIONICS_BONUS_M = 5000;
const ADVANCED_BONUS_M = 3000;

function reading(
  typeID: number,
  level: number,
  bonusPerLevelM: number | null,
): DroneRangeSkillReading {
  return { typeID, level, bonusPerLevelM };
}

/** Both drone-range skills at the given levels, both bonuses read successfully. */
function sheet(avionics: number, advanced: number): DroneRangeSkillReading[] {
  return [
    reading(DRONE_AVIONICS_TYPE_ID, avionics, AVIONICS_BONUS_M),
    reading(ADVANCED_DRONE_AVIONICS_TYPE_ID, advanced, ADVANCED_BONUS_M),
  ];
}

test("the skill ids and the bonus attribute id are the ones the SDE carries", () => {
  assert.equal(DRONE_AVIONICS_TYPE_ID, 3437);
  assert.equal(ADVANCED_DRONE_AVIONICS_TYPE_ID, 23566);
  assert.equal(DRONE_RANGE_BONUS_ATTRIBUTE_ID, 459);
  assert.deepEqual(DRONE_RANGE_SKILL_TYPE_IDS, [3437, 23566]);
  assert.equal(BASE_DRONE_CONTROL_RANGE_M, 20_000);
});

test("an untrained pilot gets the base 20 km, and it is a reading not a guess", () => {
  // The value the dead run's fallback GUESSED at. Reached here from a sheet that
  // was actually read, which is what makes it reportable.
  assert.equal(droneControlRangeFromSkills(sheet(0, 0)), 20_000);
  // A sheet with no drone skills on it at all is the same statement.
  assert.equal(droneControlRangeFromSkills([]), 20_000);
});

test("each level of each skill adds that skill's own per-level bonus", () => {
  assert.equal(droneControlRangeFromSkills(sheet(1, 0)), 25_000);
  assert.equal(droneControlRangeFromSkills(sheet(4, 0)), 40_000);
  assert.equal(droneControlRangeFromSkills(sheet(0, 3)), 29_000);
  assert.equal(droneControlRangeFromSkills(sheet(5, 3)), 54_000);
});

test("a maxed pilot reaches 60 km, three times the guess that killed the ship", () => {
  assert.equal(droneControlRangeFromSkills(sheet(5, 5)), 60_000);
});

test("the bonus comes from the DATA, so a retuned skill moves the answer", () => {
  // ⚠ THE LOAD-BEARING TEST OF THE WHOLE MODULE. If 5000/3000 were baked in,
  // this would still answer 60 km and a content pack could park the ship at a
  // confidently wrong distance with nothing reporting a fault.
  const retuned = [
    reading(DRONE_AVIONICS_TYPE_ID, 5, 7000),
    reading(ADVANCED_DRONE_AVIONICS_TYPE_ID, 5, 1000),
  ];
  assert.equal(droneControlRangeFromSkills(retuned), 20_000 + 35_000 + 5_000);
});

test("an unreadable skill sheet is null, never a computed-looking number", () => {
  assert.equal(droneControlRangeFromSkills(null), null);
});

test("a trained skill whose bonus never arrived collapses the whole answer", () => {
  // Dropping the silent skill's contribution would SHORTEN the leash and walk
  // the ship back toward the scram, which is the failure being fixed.
  const partial = [
    reading(DRONE_AVIONICS_TYPE_ID, 5, AVIONICS_BONUS_M),
    reading(ADVANCED_DRONE_AVIONICS_TYPE_ID, 4, null),
  ];
  assert.equal(droneControlRangeFromSkills(partial), null);
});

test("a missing bonus on an UNTRAINED skill is harmless and still answers", () => {
  const partial = [
    reading(DRONE_AVIONICS_TYPE_ID, 5, AVIONICS_BONUS_M),
    reading(ADVANCED_DRONE_AVIONICS_TYPE_ID, 0, null),
  ];
  assert.equal(droneControlRangeFromSkills(partial), 45_000);
});

test("levels are clamped and junk levels read as untrained", () => {
  assert.equal(droneControlRangeFromSkills(sheet(9, 0)), 45_000);
  assert.equal(droneControlRangeFromSkills(sheet(-2, 0)), 20_000);
  assert.equal(
    droneControlRangeFromSkills([
      reading(DRONE_AVIONICS_TYPE_ID, Number.NaN, AVIONICS_BONUS_M),
    ]),
    20_000,
  );
});

test("the leash can never come out negative", () => {
  const absurd = [reading(DRONE_AVIONICS_TYPE_ID, 5, -100_000)];
  assert.equal(droneControlRangeFromSkills(absurd), 0);
});

test("precedence: the fit stat is the authority whenever it answers", () => {
  assert.deepEqual(resolveDroneControlRangeM(48_000, 60_000), {
    rangeM: 48_000,
    source: "fit",
  });
});

test("precedence: the computed skill value stands in when the fit says nothing", () => {
  // Today's real case on every hull: 458 is absent from every hull's typeDogma
  // row, so the fit half is null for everyone.
  assert.deepEqual(resolveDroneControlRangeM(null, 60_000), {
    rangeM: 60_000,
    source: "skills",
  });
});

test("precedence: neither source answering is null and says so", () => {
  assert.deepEqual(resolveDroneControlRangeM(null, null), {
    rangeM: null,
    source: "unreadable",
  });
});

test("a non-positive fit stat is not an answer and falls through to skills", () => {
  assert.deepEqual(resolveDroneControlRangeM(0, 45_000), {
    rangeM: 45_000,
    source: "skills",
  });
  assert.deepEqual(resolveDroneControlRangeM(-1, null), {
    rangeM: null,
    source: "unreadable",
  });
  assert.deepEqual(resolveDroneControlRangeM(Number.NaN, 20_000), {
    rangeM: 20_000,
    source: "skills",
  });
});

test("the end-to-end shape the flow uses: no fit stat, a read sheet, a real leash", () => {
  const fromSkills = droneControlRangeFromSkills(sheet(4, 2));
  assert.deepEqual(resolveDroneControlRangeM(null, fromSkills), {
    rangeM: 46_000,
    source: "skills",
  });
  // And the same pilot with an unreadable sheet gets the honest null, which is
  // what leaves nav/kiteBand.ts's own 20 km fallback (and its log line) standing.
  assert.deepEqual(resolveDroneControlRangeM(null, droneControlRangeFromSkills(null)), {
    rangeM: null,
    source: "unreadable",
  });
});
