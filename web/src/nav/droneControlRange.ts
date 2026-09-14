// Where the drones stop answering, worked out from the PILOT rather than from
// the hull — and the precedence that decides which of the two gets believed.
//
// ─── WHY THIS MODULE EXISTS AT ALL ────────────────────────────────────────────
//
// A live run lost a ship to this. The log said:
//
//     "I could not read your drone control range, so I assumed the no-skills
//      20 km"
//
// and the band did exactly what it says there: `FALLBACK_CONTROL_RANGE_M` in
// nav/kiteBand.ts is 20 km, the ceiling came out at 17 km after the leash
// buffer, and the ship held INSIDE the 20 km scram reach of the rats it was
// fighting. It got pointed and it died.
//
// ⚠ THE READ THAT "COULD NOT ANSWER" WAS NEVER GOING TO ANSWER. The number the
// band asked for came off `fit.stats.bays.droneControlRange`, which reads dogma
// attribute 458 (`droneControlDistance`) off the FITTING. A hull does not carry
// 458: checked against the local SDE, the Tristan's own typeDogma row lists no
// such attribute, and neither does any other hull row — 458 has a defaultValue
// of 20000 in `dogmaAttributes.jsonl` precisely because it is a CHARACTER
// attribute that starts at the no-skills value and is raised by skills. So the
// fit read was not stumbling; it was being asked a question its data source
// cannot hold an answer to, every single tick, for every pilot. The fallback was
// not a rare degraded path — it was the ONLY path.
//
// Drone control range is skill-derived:
//
//     20 km base
//   + Drone Avionics (typeID 3437)           level x its own droneRangeBonus
//   + Advanced Drone Avionics (typeID 23566) level x its own droneRangeBonus
//
// which for a maxed pilot is 20 + 25 + 15 = 60 km, and for the untrained pilot
// the fallback was guessing at, exactly the 20 km it guessed.
//
// ⚠ THE PER-LEVEL BONUS IS NOT WRITTEN DOWN IN THIS FILE, AND MUST NOT BE. The
// two skills carry attribute 459 (`droneRangeBonus`) in their own typeDogma
// rows — 5000 and 3000 metres per level in the SDE build this checkout reads —
// and the caller fetches those values through /api/types/dogma and passes them
// in. Baking 5000/3000 in here would survive a server content pack retuning a
// skill and would then park the ship at a confidently wrong distance with
// nothing anywhere reporting a fault, which is the same shape of failure as the
// 20 km guess that started this. What IS written down here is which SKILLS to
// ask about, because that is a question about the game's design and not a
// number that drifts.
//
// ⚠ AND NEITHER HALF MAY BE REPORTED AS MEASURED WHEN IT WAS NOT READ. Every
// function below answers `null` rather than a plausible number when the inputs
// do not support one. `null` still reaches the band as "unreadable", the band's
// own 20 km fallback still stands, and the pilot still gets told — which is a
// worse ride than a real number but an HONEST one. A confident wrong leash is
// what killed the ship.

/** Drone Avionics — +droneRangeBonus metres of control range per level. */
export const DRONE_AVIONICS_TYPE_ID = 3437;

/** Advanced Drone Avionics — the second, smaller per-level bonus. */
export const ADVANCED_DRONE_AVIONICS_TYPE_ID = 23566;

/**
 * The two skills that lengthen the leash, in the order they are applied (which
 * does not matter arithmetically — they are additive — but keeps the readout
 * and the tests in one order).
 */
export const DRONE_RANGE_SKILL_TYPE_IDS: readonly number[] = [
  DRONE_AVIONICS_TYPE_ID,
  ADVANCED_DRONE_AVIONICS_TYPE_ID,
];

/**
 * Dogma attribute 459 `droneRangeBonus` — "Drone Control Range Bonus", metres
 * per level, carried by each skill type's OWN typeDogma row. Verified in the
 * local SDE build's `dogmaAttributes.jsonl` (459, name `droneRangeBonus`) and
 * found on both skill rows in `typeDogma.jsonl`; the neighbouring 458
 * `droneControlDistance` is the CHARACTER attribute this arithmetic reproduces,
 * and 1472 `droneRangeMultiplier` is a different mechanic that no drone skill
 * carries.
 */
export const DRONE_RANGE_BONUS_ATTRIBUTE_ID = 459;

/**
 * The no-skills control range, in metres: attribute 458's own `defaultValue` in
 * the SDE.
 *
 * ⚠ THIS ONE IS A CONSTANT AND THE BONUSES ARE NOT, WHICH IS NOT AN
 * INCONSISTENCY. A per-level bonus lives in a row /api/types/dogma can hand
 * back, so there is a way to read it and no excuse for hardcoding it. An
 * attribute's `defaultValue` lives in `dogmaAttributes.jsonl`, which no route
 * serves and which nothing else in the client has ever needed — and the number
 * it holds is the same 20 km `FALLBACK_CONTROL_RANGE_M` in nav/kiteBand.ts
 * already states independently. Adding a route to read a constant that two
 * other places already agree on would buy a round trip and no truth.
 */
export const BASE_DRONE_CONTROL_RANGE_M = 20_000;

/** The highest level any skill trains to. A sheet claiming more is clamped. */
const MAX_SKILL_LEVEL = 5;

/** One drone-range skill as the caller managed to read it. */
export interface DroneRangeSkillReading {
  readonly typeID: number;
  /**
   * The TRAINED level, 0 through 5. Zero is a reading — "this pilot has not
   * trained it" — and is the right value for a skill the sheet simply does not
   * list, because an untrained skill is absent from a skill sheet rather than
   * present at zero. ⚠ Pass 0 only when the SHEET was read; when the read
   * failed, pass the whole list as `null` instead (see below), or a pilot with
   * 60 km of reach gets told they have 20.
   */
  readonly level: number;
  /**
   * Metres per level, from this skill type's own attribute 459. `null` when the
   * dogma read did not answer for this type — which is fatal to the sum ONLY if
   * the level is above zero (see `droneControlRangeFromSkills`).
   */
  readonly bonusPerLevelM: number | null;
}

/**
 * The control range these skills buy, in metres — or `null` when the inputs
 * cannot support an honest number.
 *
 * `null` in, `null` out: a caller whose skill-sheet read FAILED passes `null`
 * for the whole list and gets `null` back. That is the distinction the whole
 * module turns on — an empty LIST means "the sheet was read and this pilot has
 * no drone skills", which is a real 20 km; a `null` list means "nobody knows",
 * which is not a number at all.
 *
 * ⚠ A MISSING BONUS ON AN UNTRAINED SKILL IS NOT A FAILURE. Level 0 multiplied
 * by anything is 0, so a dogma read that answered for one skill and not the
 * other still yields a true total when the silent one is untrained. Only a
 * TRAINED skill whose bonus never arrived collapses the answer to `null`, and it
 * has to: the alternative is quietly dropping that skill's contribution, which
 * shortens the leash and walks the ship back toward the scram.
 */
export function droneControlRangeFromSkills(
  skills: readonly DroneRangeSkillReading[] | null,
): number | null {
  if (skills === null) {
    return null;
  }
  let total = BASE_DRONE_CONTROL_RANGE_M;
  for (const skill of skills) {
    const level = Math.max(0, Math.min(MAX_SKILL_LEVEL, Math.trunc(Number(skill?.level) || 0)));
    if (level === 0) {
      continue;
    }
    const bonus = skill?.bonusPerLevelM;
    if (typeof bonus !== "number" || !Number.isFinite(bonus)) {
      return null;
    }
    total += level * bonus;
  }
  // A content pack could in principle publish a negative bonus; the leash still
  // cannot be less than nothing, and a negative metre count downstream would be
  // read as a distance to fly.
  return Math.max(0, total);
}

/** Which of the two sources the reported range actually came from. */
export type DroneControlRangeSource = "fit" | "skills" | "unreadable";

export interface ResolvedDroneControlRange {
  /** Metres, or `null` when neither source answered. */
  readonly rangeM: number | null;
  readonly source: DroneControlRangeSource;
}

/**
 * THE PRECEDENCE, and it is the whole point of this function existing rather
 * than the two values being `??`-ed together at the call site:
 *
 *   1. THE FIT STAT, whenever it is `known`. It is the authority when present —
 *      it is the SERVER's own post-dogma number for this hull, and if a future
 *      content pack ever does put 458 on a hull row (or the bound-dogma path
 *      starts carrying the character attribute through), that number already
 *      accounts for everything this file reconstructs by hand, including
 *      whatever the arithmetic below does not model.
 *   2. OTHERWISE THE COMPUTED SKILL VALUE, which today is the one that actually
 *      answers, because a hull does not carry 458 at all.
 *   3. OTHERWISE `null` — meaning "unreadable", NOT 20 km. The band already
 *      knows what to do with that (`resolveDroneLeash` falls back to
 *      `FALLBACK_CONTROL_RANGE_M` and says so in the run log), and it is not
 *      this module's place to make that fallback silent by dressing a guess up
 *      as a reading.
 *
 * ⚠ ONLY A POSITIVE FIT STAT COUNTS AS PRESENT. `shipStats.readPositive`
 * already yields `known` only above zero, so a zero or negative arriving here
 * is a value that was never measured, and must fall through to the skills
 * rather than pin the leash at the hull's nose.
 */
export function resolveDroneControlRangeM(
  fitStatM: number | null,
  fromSkillsM: number | null,
): ResolvedDroneControlRange {
  if (typeof fitStatM === "number" && Number.isFinite(fitStatM) && fitStatM > 0) {
    return { rangeM: fitStatM, source: "fit" };
  }
  if (typeof fromSkillsM === "number" && Number.isFinite(fromSkillsM)) {
    return { rangeM: fromSkillsM, source: "skills" };
  }
  return { rangeM: null, source: "unreadable" };
}
