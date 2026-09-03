// R107 — the local roster that powers the "Add character" quick-pick. These
// pin the storage semantics: recording a sign-in's character list, replacing an
// account's rows wholesale on re-record (a removed character drops), forgetting
// one pilot, most-recently-seen-first ordering, and graceful behaviour with no
// storage or corrupt storage.

import test from "node:test";
import assert from "node:assert/strict";

import {
  loadKnownCharacters,
  rememberCharacters,
  forgetKnownCharacter,
  forgetKnownAccount,
  setKnownCharacterStorage,
  type KnownCharacterStorage,
} from "./knownCharacters.ts";
import type { CharacterSummary } from "../store/types.ts";

function makeStorage(): KnownCharacterStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
  };
}

/** A CharacterSummary with only the fields the roster reads; rest cast away. */
function char(characterID: number, characterName: string, shipName: string | null, sp: number): CharacterSummary {
  return { characterID, characterName, shipName, skillPoints: sp, balance: 1000 } as unknown as CharacterSummary;
}

test.beforeEach(() => {
  setKnownCharacterStorage(makeStorage());
});

test.after(() => {
  setKnownCharacterStorage(null);
});

test("records a sign-in's character list and reads it back", () => {
  rememberCharacters("farmer", [char(7001, "Ore Farmer", "Procurer", 500), char(7002, "Hauler", "Bestower", 300)]);

  const known = loadKnownCharacters();
  assert.equal(known.length, 2);
  const farmer = known.find((k) => k.characterID === 7001);
  assert.equal(farmer?.accountName, "farmer");
  assert.equal(farmer?.characterName, "Ore Farmer");
  assert.equal(farmer?.shipName, "Procurer");
  assert.equal(farmer?.skillPoints, 500);
});

test("re-recording an account REPLACES its rows — a removed character drops", () => {
  rememberCharacters("farmer", [char(7001, "Ore Farmer", "Procurer", 500), char(7002, "Hauler", "Bestower", 300)]);
  // Sign in again; the account now only has 7001.
  rememberCharacters("farmer", [char(7001, "Ore Farmer", "Retriever", 600)]);

  const known = loadKnownCharacters();
  assert.equal(known.length, 1);
  assert.equal(known[0]?.characterID, 7001);
  assert.equal(known[0]?.shipName, "Retriever", "the row refreshed to the latest read");
  assert.equal(known.some((k) => k.characterID === 7002), false, "the removed character is gone");
});

test("keeps separate accounts and orders most-recently-seen first", () => {
  rememberCharacters("farmer", [char(7001, "Ore Farmer", "Procurer", 500)]);
  rememberCharacters("second", [char(7002, "Second Pilot", "Merlin", 100)]);

  const known = loadKnownCharacters();
  assert.equal(known.length, 2);
  // `second` signed in last, so its pilot sorts to the front.
  assert.equal(known[0]?.characterID, 7002);
  assert.equal(known[1]?.characterID, 7001);
});

test("forget drops exactly one pilot", () => {
  rememberCharacters("farmer", [char(7001, "Ore Farmer", "Procurer", 500), char(7002, "Hauler", "Bestower", 300)]);
  forgetKnownCharacter(7001);

  const known = loadKnownCharacters();
  assert.equal(known.length, 1);
  assert.equal(known[0]?.characterID, 7002);
});

test("empty list and blank account name are ignored", () => {
  rememberCharacters("farmer", []);
  rememberCharacters("   ", [char(7001, "Ore Farmer", "Procurer", 500)]);
  assert.deepEqual(loadKnownCharacters(), []);
});

test("no storage: reads empty and writes are no-ops, never throwing", () => {
  setKnownCharacterStorage(null);
  assert.deepEqual(loadKnownCharacters(), []);
  rememberCharacters("farmer", [char(7001, "Ore Farmer", "Procurer", 500)]);
  forgetKnownCharacter(7001);
  assert.deepEqual(loadKnownCharacters(), []);
});

test("corrupt stored JSON reads back as empty, not a throw", () => {
  const storage = makeStorage();
  storage.map.set("evejs-web-known-characters:v1", "{not json");
  setKnownCharacterStorage(storage);
  assert.deepEqual(loadKnownCharacters(), []);

  // A non-array payload is also ignored.
  storage.map.set("evejs-web-known-characters:v1", JSON.stringify({ nope: true }));
  assert.deepEqual(loadKnownCharacters(), []);
});

// --- the Pilot Hangar's columns --------------------------------------------
//
// The hangar shows where a pilot is and what it is training. The location and
// skill NAMES can only be resolved by a caller holding a token, so an ordinary
// character-select sign-in cannot supply them — and must not wipe them either.
// These pin the carry-over rule that makes that safe.

/** A selection row carrying the fields the hangar reads off it. */
function hangarChar(
  characterID: number,
  extras: Partial<Record<string, unknown>>,
): CharacterSummary {
  return {
    characterID,
    characterName: `Pilot ${characterID}`,
    shipName: "Velator",
    skillPoints: 500,
    balance: 1000,
    stationID: null,
    solarSystemID: null,
    skillTypeID: null,
    toLevel: null,
    trainingEndTime: null,
    ...extras,
  } as unknown as CharacterSummary;
}

test("a sign-in with a token records the resolved place and skill", () => {
  rememberCharacters(
    "farmer",
    [hangarChar(7001, { stationID: 60000004, skillTypeID: 3300, toLevel: 4 })],
    new Map([[7001, { locationName: "Jita IV - Moon 4", trainingSkillName: "Mining Barge" }]]),
  );
  const row = loadKnownCharacters()[0];
  assert.equal(row?.locationName, "Jita IV - Moon 4");
  assert.equal(row?.trainingSkillName, "Mining Barge");
  assert.equal(row?.trainingToLevel, 4);
});

test("a plain sign-in KEEPS the names it cannot resolve, as long as nothing moved", () => {
  rememberCharacters(
    "farmer",
    [hangarChar(7001, { stationID: 60000004, skillTypeID: 3300, toLevel: 4 })],
    new Map([[7001, { locationName: "Jita IV - Moon 4", trainingSkillName: "Mining Barge" }]]),
  );
  // The character-select screen re-records the same account with no lookup.
  rememberCharacters("farmer", [
    hangarChar(7001, { stationID: 60000004, skillTypeID: 3300, toLevel: 4 }),
  ]);
  const row = loadKnownCharacters()[0];
  assert.equal(row?.locationName, "Jita IV - Moon 4");
  assert.equal(row?.trainingSkillName, "Mining Barge");
});

test("a name whose id changed is DROPPED rather than carried over as a lie", () => {
  rememberCharacters(
    "farmer",
    [hangarChar(7001, { stationID: 60000004, skillTypeID: 3300 })],
    new Map([[7001, { locationName: "Jita IV - Moon 4", trainingSkillName: "Mining Barge" }]]),
  );
  // The pilot has moved and started a different skill; without a lookup we do
  // not know the new names, and the old ones no longer describe anything.
  rememberCharacters("farmer", [
    hangarChar(7001, { stationID: 60000010, skillTypeID: 3400 }),
  ]);
  const row = loadKnownCharacters()[0];
  assert.equal(row?.locationName, null);
  assert.equal(row?.trainingSkillName, null);
});

test("an undocked pilot is placed by its solar system", () => {
  rememberCharacters("farmer", [hangarChar(7001, { solarSystemID: 30000142 })]);
  assert.equal(loadKnownCharacters()[0]?.locationRefID, 30000142);
});

test("the training end time is stored as a Unix instant, not a retail FILETIME", () => {
  // 2011-11-11T00:00:00Z as a FILETIME.
  rememberCharacters("farmer", [
    hangarChar(7001, { trainingEndTime: 129654432000000000n }),
  ]);
  assert.equal(loadKnownCharacters()[0]?.trainingEndsAtMs, 1320969600000);
});

test("forgetting an account drops all of its pilots and names which went", () => {
  rememberCharacters("farmer", [hangarChar(7001, {}), hangarChar(7002, {})]);
  rememberCharacters("trader", [hangarChar(8001, {})]);
  const gone = forgetKnownAccount("farmer");
  assert.deepEqual(gone.sort(), [7001, 7002]);
  assert.deepEqual(
    loadKnownCharacters().map((k) => k.characterID),
    [8001],
  );
});
