// R108 slice 3: the PI Manager's board, as a pure function of what was read.
//
// What is checked, and why each matters:
//
//   1. FOUR OUTCOMES, PER PILOT. Being read, could not be read, has not built,
//      and the server reported no colony table are four different facts. On a
//      board spanning pilots each is said about THAT pilot, never collapsed into
//      one message for the whole board.
//
//   2. EVERY ROW CARRIES ITS OWN AGE. Pilots are read at different moments; a
//      merged list says how old each row is and says when they differ.
//
//   3. A FAILED READ DOES NOT ERASE A GOOD ONE. The last reading stays on the
//      board, aged, beside the sentence saying the new one failed.
//
//   4. WORST FIRST ACROSS PILOTS, by the same rule one colony list uses.
//
//   5. NO NUMBER AS DATA (R7d), NO MACHINERY WORDS (R9a).

import test from "node:test";
import assert from "node:assert/strict";

import { buildPiBoard, type PiBoardInput, type PilotAttempt } from "./piBoard.ts";
import type { PilotColonyReading } from "./piRoster.ts";
import type { Colony, ColonyPin } from "../store/types.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

const FARMER = 90000001;
const HAULER = 90000002;
const NEWBIE = 90000003;
const LOST = 90000004;

function pin(overrides: Partial<ColonyPin> & Pick<ColonyPin, "pinID" | "kind">): ColonyPin {
  return {
    typeID: 2848,
    typeName: "Barren Extractor Control Unit",
    contents: [],
    usedM3: 0,
    capacityM3: null,
    schematicID: null,
    schematicName: null,
    hasReceivedInputs: null,
    receivedInputsLastCycle: null,
    lastRunAtMs: NOW - MINUTE,
    lastLaunchAtMs: null,
    program: null,
    ...overrides,
  };
}

function extractor(pinID: number, expiresAtMs: number): ColonyPin {
  return pin({
    pinID,
    kind: "extractor-control",
    program: {
      resourceTypeID: 2268,
      resourceTypeName: "Aqueous Liquids",
      cycleTimeSeconds: 7200,
      quantityPerCycle: 4591,
      installedAtMs: expiresAtMs - 48 * HOUR,
      expiresAtMs,
      headCount: 7,
    },
  });
}

function colony(planetID: number, planetName: string | null, pins: readonly ColonyPin[]): Colony {
  return {
    planetID,
    planetName,
    solarSystemID: 30000001,
    solarSystemName: "Alpha",
    planetTypeID: 2016,
    planetTypeName: "Planet (Barren)",
    commandCenterLevel: 5,
    lastSimulatedAtMs: NOW - MINUTE,
    pins,
    linkCount: 0,
    links: [],
    routes: [],
  };
}

function reading(
  characterID: number,
  colonies: readonly Colony[],
  readAtMs: number | null,
  coloniesReadable = true,
): PilotColonyReading {
  return { characterID, readAtMs, report: { colonies, coloniesReadable, clockOffsetMs: 0 } };
}

function input(overrides: Partial<PiBoardInput> = {}): PiBoardInput {
  return {
    members: [FARMER, HAULER, NEWBIE],
    names: new Map([[FARMER, "Ada Farmer"], [HAULER, "Bo Hauler"], [NEWBIE, "Cy Newbie"]]),
    readings: new Map(),
    attempts: new Map(),
    browserNowMs: NOW,
    ...overrides,
  };
}

const QUIET = colony(40000002, "Alpha I", [extractor(2, NOW + 30 * HOUR)]);
const STOPPED = colony(40000004, "Alpha II", [extractor(2, NOW - HOUR)]);
const STARVED = colony(40000006, "Alpha III", [
  extractor(2, NOW + 30 * HOUR),
  pin({ pinID: 4, kind: "factory", schematicName: "Water", receivedInputsLastCycle: false }),
]);
const COMING_UP = colony(40000008, "Alpha IV", [extractor(2, NOW + 2 * HOUR)]);

test("a roster nobody has read yet says so per pilot, and offers no colonies", () => {
  const board = buildPiBoard(input());
  assert.deepEqual(board.pilots.map((pilot) => pilot.noteWords), [
    "Not looked at yet.",
    "Not looked at yet.",
    "Not looked at yet.",
  ]);
  assert.deepEqual(board.colonies, []);
  assert.deepEqual(board.needsYou, []);
});

test("⚠ the four outcomes are told apart, and told about the right pilot", () => {
  const attempts = new Map<number, PilotAttempt>([
    [FARMER, "reading"],
    [HAULER, "failed"],
  ]);
  const board = buildPiBoard(input({
    members: [FARMER, HAULER, NEWBIE, LOST],
    attempts,
    readings: new Map([
      [NEWBIE, reading(NEWBIE, [], NOW - MINUTE)],
      [LOST, reading(LOST, [], NOW - MINUTE, false)],
    ]),
    names: new Map([[FARMER, "Ada Farmer"], [HAULER, "Bo Hauler"], [NEWBIE, "Cy Newbie"], [LOST, "Di Lost"]]),
  }));
  assert.deepEqual(board.pilots.map((pilot) => pilot.noteWords), [
    "Looking at Ada Farmer's colonies...",
    "Bo Hauler's colonies could not be read just now.",
    "Cy Newbie has not built on a planet yet.",
    "The server did not report colony information for Di Lost. That is not the same as having none.",
  ]);
  assert.equal(board.pilots[0]!.busy, true);
  assert.equal(board.pilots[1]!.busy, false);
});

test("a pilot no longer in the hangar is named as such, never by number", () => {
  const board = buildPiBoard(input({
    members: [FARMER],
    names: new Map(),
    attempts: new Map([[FARMER, "no-account"]]),
  }));
  const [pilot] = board.pilots;
  assert.equal(pilot!.pilotName, "A pilot no longer in the hangar");
  assert.equal(
    pilot!.noteWords,
    "This pilot is no longer in the hangar, so there is no account to read with.",
  );
  assert.doesNotMatch(`${pilot!.pilotName} ${pilot!.noteWords}`, new RegExp(String(FARMER)));
});

test("an unanswered pilot reads as a failed read, not as 'has not built'", () => {
  const board = buildPiBoard(input({ members: [HAULER], attempts: new Map([[HAULER, "unanswered"]]) }));
  assert.equal(board.pilots[0]!.noteWords, "Bo Hauler's colonies could not be read just now.");
});

test("⚠ a failed read keeps the last good reading on the board, aged", () => {
  const board = buildPiBoard(input({
    members: [FARMER],
    attempts: new Map([[FARMER, "failed"]]),
    readings: new Map([[FARMER, reading(FARMER, [QUIET], NOW - 3 * HOUR)]]),
  }));
  assert.equal(board.pilots[0]!.noteWords, "Ada Farmer's colonies could not be read just now.");
  assert.equal(board.colonies.length, 1);
  assert.equal(board.colonies[0]!.readAgeWords, "Read 3 hours ago");
});

test("every colony row carries its pilot, its place, its line and its own age", () => {
  const board = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET], NOW - 2 * MINUTE)],
      [HAULER, reading(HAULER, [colony(40000010, null, [])], NOW - 90 * MINUTE)],
    ]),
  }));
  assert.deepEqual(
    board.colonies.map((row) => [row.pilotName, row.placeWords, row.stateWords, row.readAgeWords]),
    [
      ["Ada Farmer", "Alpha I", "Extracting — next program ends in 1d 6h", "Read 2 minutes ago"],
      ["Bo Hauler", "a planet in Alpha", "No extractors here yet", "Read 1h 30m ago"],
    ],
  );
  // Keys are unique across pilots, for a keyed each; they are never printed.
  assert.equal(new Set(board.colonies.map((row) => row.key)).size, 2);
});

test("a reading with no instant says its age is unknown rather than inventing one", () => {
  const board = buildPiBoard(input({
    members: [FARMER],
    readings: new Map([[FARMER, reading(FARMER, [QUIET], null)]]),
  }));
  assert.equal(board.colonies[0]!.readAgeWords, "Read at an unknown time");
});

test("the age is judged on the server's clock, not the browser's", () => {
  const skewed: PilotColonyReading = {
    characterID: FARMER,
    readAtMs: NOW - 10 * MINUTE,
    // The browser is five minutes slow, so the server's now is NOW + 5m, and a
    // read stamped NOW - 10m on the server's clock is fifteen minutes old.
    report: { colonies: [QUIET], coloniesReadable: true, clockOffsetMs: 5 * MINUTE },
  };
  const board = buildPiBoard(input({ members: [FARMER], readings: new Map([[FARMER, skewed]]) }));
  assert.equal(board.colonies[0]!.readAgeWords, "Read 15 minutes ago");
});

test("⚠ worst first ACROSS pilots, and quiet colonies after every noisy one", () => {
  const board = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET, COMING_UP], NOW - MINUTE)],
      [HAULER, reading(HAULER, [STARVED], NOW - MINUTE)],
      [NEWBIE, reading(NEWBIE, [STOPPED], NOW - MINUTE)],
    ]),
  }));
  assert.deepEqual(board.colonies.map((row) => row.placeWords), ["Alpha II", "Alpha III", "Alpha IV", "Alpha I"]);
  assert.deepEqual(board.colonies.map((row) => row.needsYouNow), [true, true, false, false]);

  // The "needs you" list holds only what has something to say, worst first,
  // each line naming the pilot whose colony it is.
  assert.deepEqual(
    board.needsYou.map((item) => [item.pilotName, item.placeWords, item.urgency]),
    [
      ["Cy Newbie", "Alpha II", "now"],
      ["Bo Hauler", "Alpha III", "now"],
      ["Ada Farmer", "Alpha IV", "soon"],
    ],
  );
  assert.equal(board.needsYou[0]!.words, "1 extractor has finished its program");
  assert.equal(board.needsYou[1]!.words, "1 factory was fed nothing last cycle");
  // Coming up has no "now" sentence, so it is told in the finding's own words.
  assert.match(board.needsYou[2]!.words, /Aqueous Liquids/);
});

test("readings from different moments say so, with the oldest age", () => {
  const apart = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET], NOW - 2 * MINUTE)],
      [HAULER, reading(HAULER, [STOPPED], NOW - 4 * HOUR)],
    ]),
  }));
  assert.equal(apart.staleWords, "Read at different times; the oldest is 4 hours old.");

  // Read together (inside a minute of each other): nothing to warn about.
  const together = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET], NOW - 2 * MINUTE)],
      [HAULER, reading(HAULER, [STOPPED], NOW - 2 * MINUTE - 20_000)],
    ]),
  }));
  assert.equal(together.staleWords, null);
});

test("the whole-board sentences: nobody assigned, and nobody has built", () => {
  assert.equal(
    buildPiBoard(input({ members: [] })).emptyWords,
    "No pilots are on planetary industry yet. Add one below.",
  );
  const nobodyBuilt = buildPiBoard(input({
    members: [FARMER, HAULER],
    readings: new Map([
      [FARMER, reading(FARMER, [], NOW - MINUTE)],
      [HAULER, reading(HAULER, [], NOW - MINUTE)],
    ]),
  }));
  assert.equal(nobodyBuilt.emptyWords, "None of your pilots has built on a planet yet.");
  // One unread pilot means we do not know that yet.
  const unsure = buildPiBoard(input({
    members: [FARMER, HAULER],
    readings: new Map([[FARMER, reading(FARMER, [], NOW - MINUTE)]]),
  }));
  assert.equal(unsure.emptyWords, null);
});

test("no machinery words and no bare ids anywhere a player reads", () => {
  const board = buildPiBoard(input({
    readings: new Map([
      [FARMER, reading(FARMER, [QUIET, STOPPED], NOW - MINUTE)],
      [HAULER, reading(HAULER, [STARVED], NOW - 2 * HOUR)],
    ]),
    attempts: new Map([[NEWBIE, "failed"]]),
  }));
  const printed = JSON.stringify({
    pilots: board.pilots.map(({ pilotName, noteWords, readAgeWords }) => ({ pilotName, noteWords, readAgeWords })),
    colonies: board.colonies.map(({ pilotName, placeWords, stateWords, readAgeWords }) =>
      ({ pilotName, placeWords, stateWords, readAgeWords })),
    needsYou: board.needsYou.map(({ pilotName, placeWords, words }) => ({ pilotName, placeWords, words })),
    staleWords: board.staleWords,
  });
  assert.doesNotMatch(printed, /\d{5,}/, "no id-length number");
  assert.doesNotMatch(printed, /schematic|\bpin\b|\bECU\b|characterID|planetID/i);
  // And the sweep does catch an id when one is there.
  assert.match(JSON.stringify({ x: `${FARMER}` }), /\d{5,}/);
});
