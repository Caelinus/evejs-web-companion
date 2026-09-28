// The mining surveyor's SCHEDULING rules — the ones the real client enforces
// around its own button (see the header of surveyScan.ts for where each of
// these comes from). What is pinned here is not "does the scan work" but "when
// is a bot allowed to press it", which is the whole of the difference between
// running the scanner and hammering it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_SURVEY_MEMORY,
  MAX_BLANK_SCANS,
  SCAN_BUDGET_PER_MINUTE,
  SCAN_EFFECT_MS,
  SCAN_RANGE_M,
  decideSurveyScan,
  forgetSurvey,
  rememberSurveyFailure,
  rememberSurveyScan,
  surveyForShip,
  surveyedSnapshot,
  type SurveyMemory,
} from "./surveyScan.ts";
import type { SpaceEntity, SpaceShipStatus, SpaceSnapshot } from "../store/types.ts";

const SYSTEM = 30000142;
const SHIP = 9001;
const BELT = 40000123;
const ROCK_A = 5001;
const ROCK_B = 5002;

function entity(overrides: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: null,
    typeID: null,
    groupID: null,
    categoryID: null,
    name: null,
    ownerID: null,
    radius: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
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
    oreValuePerM3: null,
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...overrides,
  };
}

function rock(itemID: number, metres: number, remaining: number | null = null): SpaceEntity {
  return entity({
    itemID,
    kind: "asteroid",
    name: "Veldspar",
    position: { x: metres, y: 0, z: 0 },
    miningYieldTypeID: 1230,
    beltID: BELT,
    remainingQuantity: remaining,
  });
}

function ship(mode = "STOP"): SpaceShipStatus {
  return {
    itemID: SHIP,
    typeID: 620,
    name: "Miner",
    mode,
    maxVelocity: 200,
    radius: 60,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    shieldRatio: 1,
    armorRatio: 1,
    hullRatio: 1,
    capacitorRatio: 1,
    shieldCapacity: 1000,
    armorCapacity: 1000,
    hullCapacity: 1000,
    activeModuleIDs: [],
    overloadedModuleIDs: [],
    moduleDamage: {},
    weaponBanks: {},
  };
}

function snapshot(entities: readonly SpaceEntity[], mode = "STOP", inSpace = true): SpaceSnapshot {
  return {
    inSpace,
    solarSystemID: SYSTEM,
    shipID: SHIP,
    sampledAtMs: 0,
    ship: ship(mode),
    entities: [...entities],
  };
}

// --- when a scan is due ------------------------------------------------------

test("an unsurveyed rock in range is what makes a scan due", () => {
  const verdict = decideSurveyScan(snapshot([rock(ROCK_A, 8_000)]), EMPTY_SURVEY_MEMORY, 1_000);
  assert.equal(verdict.scan, true);
});

test("no rocks, docked, or a rock the SERVER already measured: nothing to survey", () => {
  assert.equal(decideSurveyScan(snapshot([]), EMPTY_SURVEY_MEMORY, 1_000).scan, false);
  assert.equal(decideSurveyScan(null, EMPTY_SURVEY_MEMORY, 1_000).scan, false);
  assert.equal(
    decideSurveyScan(snapshot([rock(ROCK_A, 8_000)], "STOP", false), EMPTY_SURVEY_MEMORY, 1_000).scan,
    false,
    "a snapshot that says the ship is not in space is not a grid to scan",
  );
  assert.equal(
    decideSurveyScan(snapshot([rock(ROCK_A, 8_000, 4_200)]), EMPTY_SURVEY_MEMORY, 1_000).scan,
    false,
    "the snapshot already carries this rock's quantity — a scan would learn nothing",
  );
});

test("in warp the scanner is refused, exactly as the client refuses it", () => {
  const verdict = decideSurveyScan(snapshot([rock(ROCK_A, 8_000)], "WARP"), EMPTY_SURVEY_MEMORY, 1_000);
  assert.equal(verdict.scan, false);
  assert.match(verdict.why, /warp/i);
});

test("a rock past the wave's 250 km reach is not a reason to scan", () => {
  const verdict = decideSurveyScan(
    snapshot([rock(ROCK_A, SCAN_RANGE_M + 50_000)]),
    EMPTY_SURVEY_MEMORY,
    1_000,
  );
  assert.equal(verdict.scan, false);
});

// --- the "still active" rule -------------------------------------------------

test("while the previous scan's wave is still travelling, no second scan is fired", () => {
  const grid = snapshot([rock(ROCK_A, 8_000), rock(ROCK_B, 9_000)]);
  // The first scan answered for ONE of the two rocks; the other stays unknown,
  // so the only thing holding the next scan back is the busy window.
  const after = rememberSurveyScan(
    EMPTY_SURVEY_MEMORY,
    grid,
    [{ itemID: ROCK_A, yieldTypeID: 1230, remainingQuantity: 4_200 }],
    10_000,
  );
  const busy = decideSurveyScan(grid, after, 10_000 + SCAN_EFFECT_MS - 1);
  assert.equal(busy.scan, false, "the wave has not finished");
  assert.match(busy.why, /still running/);

  // Once it has finished, the rock nobody answered for is STILL not a reason to
  // scan again: it was covered, and the client stores exactly that.
  const later = decideSurveyScan(grid, after, 10_000 + SCAN_EFFECT_MS + 1);
  assert.equal(later.scan, false, "a covered-but-unanswered rock is not re-asked about");
  assert.match(later.why, /already surveyed/);
});

test("a rock that was not on the grid when the scan ran does make the next one due", () => {
  const before = snapshot([rock(ROCK_A, 8_000)]);
  const memory = rememberSurveyScan(
    EMPTY_SURVEY_MEMORY,
    before,
    [{ itemID: ROCK_A, yieldTypeID: 1230, remainingQuantity: 4_200 }],
    10_000,
  );
  // Rotating to the next belt: a rock nothing has ever measured.
  const after = snapshot([rock(ROCK_A, 8_000), rock(ROCK_B, 12_000)]);
  assert.equal(decideSurveyScan(after, memory, 10_000 + SCAN_EFFECT_MS + 1).scan, true);
});

test("the ten-per-minute budget is the ceiling, and it rolls", () => {
  const grid = snapshot([rock(ROCK_A, 8_000)]);
  let memory: SurveyMemory = EMPTY_SURVEY_MEMORY;
  for (let index = 0; index < SCAN_BUDGET_PER_MINUTE; index += 1) {
    // Each scan answers, so the blank-streak retirement never trips, and all ten
    // land inside the same minute — which is the only thing under test here.
    memory = rememberSurveyScan(
      memory,
      grid,
      [{ itemID: ROCK_A + index, yieldTypeID: 1230, remainingQuantity: 10 }],
      index * 1_000,
    );
  }
  // Past the busy window of the last one, and still inside its minute.
  const spent = decideSurveyScan(grid, memory, 9_000 + SCAN_EFFECT_MS + 1);
  assert.equal(spent.scan, false);
  assert.match(spent.why, /budget/);
});

// --- giving up on a hull that cannot survey ---------------------------------

test("two scans that answer nothing retire the scanner for this ship", () => {
  const grid = snapshot([rock(ROCK_A, 8_000)]);
  let memory: SurveyMemory = EMPTY_SURVEY_MEMORY;
  for (let index = 0; index < MAX_BLANK_SCANS; index += 1) {
    memory = rememberSurveyFailure(memory, index * SCAN_EFFECT_MS);
  }
  const verdict = decideSurveyScan(grid, memory, MAX_BLANK_SCANS * SCAN_EFFECT_MS + 1);
  assert.equal(verdict.scan, false);
  assert.match(verdict.why, /cannot survey/);
  // And a warp to the next belt does not re-arm it: the hull is the reason.
  assert.equal(decideSurveyScan(grid, forgetSurvey(memory), 100_000).scan, false);
});

test("boarding another hull re-arms the scanner, because it is another scanner", () => {
  const grid = snapshot([rock(ROCK_A, 8_000)]);
  let memory: SurveyMemory = surveyForShip(EMPTY_SURVEY_MEMORY, SHIP);
  for (let index = 0; index < MAX_BLANK_SCANS; index += 1) {
    memory = rememberSurveyFailure(memory, index * SCAN_EFFECT_MS);
  }
  assert.equal(decideSurveyScan(grid, memory, 100_000).scan, false, "this hull cannot survey");

  // Docked, refitted, undocked in a different ship: the old hull's verdict does
  // not travel with the pilot.
  const boarded = surveyForShip(forgetSurvey(memory), SHIP + 1);
  assert.equal(boarded.blankStreak, 0);
  assert.equal(decideSurveyScan(grid, boarded, 100_000).scan, true);
  assert.deepEqual(
    boarded.scanTimesMs,
    memory.scanTimesMs,
    "the per-minute budget protects the server from this client, not from this hull",
  );
});

test("a failed call costs a slot but blinds nothing — the rocks were never asked", () => {
  const grid = snapshot([rock(ROCK_A, 8_000)]);
  const failed = rememberSurveyFailure(EMPTY_SURVEY_MEMORY, 1_000);
  assert.equal(failed.quantities.size, 0, "no rock was recorded as covered");
  const verdict = decideSurveyScan(grid, failed, 1_000 + SCAN_EFFECT_MS + 1);
  assert.equal(verdict.scan, true, "one bad round trip is not a verdict about the grid");
});

// --- forgetting, the way the client forgets ---------------------------------

test("a rock that leaves the grid is forgotten, and docking clears the lot", () => {
  const grid = snapshot([rock(ROCK_A, 8_000), rock(ROCK_B, 9_000)]);
  const memory = rememberSurveyScan(
    EMPTY_SURVEY_MEMORY,
    grid,
    [
      { itemID: ROCK_A, yieldTypeID: 1230, remainingQuantity: 4_200 },
      { itemID: ROCK_B, yieldTypeID: 1230, remainingQuantity: 900 },
    ],
    1_000,
  );
  assert.equal(memory.quantities.size, 2);

  // ROCK_A is mined out and gone from the snapshot; the next scan drops it.
  const thinner = rememberSurveyScan(memory, snapshot([rock(ROCK_B, 9_000)]), [], 20_000);
  assert.equal(thinner.quantities.has(ROCK_A), false, "a rock nobody can see is not a rock with no ore");
  assert.equal(thinner.quantities.get(ROCK_B), 900);

  const cleared = forgetSurvey(thinner);
  assert.equal(cleared.quantities.size, 0);
  assert.equal(cleared.blankStreak, thinner.blankStreak, "the throttle and the streak survive a session change");
});

// --- what the deciders actually see ------------------------------------------

test("the survey fills the snapshot's BLANKS and never overwrites the server", () => {
  const grid = snapshot([rock(ROCK_A, 8_000), rock(ROCK_B, 9_000, 777)]);
  const memory = rememberSurveyScan(
    EMPTY_SURVEY_MEMORY,
    grid,
    [
      { itemID: ROCK_A, yieldTypeID: 1230, remainingQuantity: 4_200 },
      { itemID: ROCK_B, yieldTypeID: 1230, remainingQuantity: 1 },
    ],
    1_000,
  );
  const merged = surveyedSnapshot(grid, memory);
  const byID = new Map(merged.entities.map((row) => [row.itemID, row.remainingQuantity]));
  assert.equal(byID.get(ROCK_A), 4_200, "the blank was filled");
  assert.equal(byID.get(ROCK_B), 777, "the server's own number is live and stays");
});

test("a rock the scanner reported as EMPTY keeps its real zero", () => {
  const grid = snapshot([rock(ROCK_A, 8_000)]);
  const memory = rememberSurveyScan(
    EMPTY_SURVEY_MEMORY,
    grid,
    [{ itemID: ROCK_A, yieldTypeID: 1230, remainingQuantity: 0 }],
    1_000,
  );
  assert.equal(surveyedSnapshot(grid, memory).entities[0]?.remainingQuantity, 0);
});

test("with nothing surveyed the snapshot comes back untouched, object and all", () => {
  const grid = snapshot([rock(ROCK_A, 8_000)]);
  assert.equal(surveyedSnapshot(grid, EMPTY_SURVEY_MEMORY), grid);
});
