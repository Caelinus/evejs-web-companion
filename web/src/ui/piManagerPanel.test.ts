// R108 slice 3: the Planetary Industry window, rendered.
//
// The board's logic is pinned in bridge/piBoard.test.ts; this proves the
// window actually PRINTS it — from a roster and readings stored the way the
// window stores them, through the same decoder — and that what it prints obeys
// the house rules: every colony row with its own age, the four per-pilot
// outcomes in words, no id as data (R7d), no machinery words (R9a), and no
// character select anywhere in the source.
//
// (`onMount` does not run under the server generator, so rendering here never
// reads; that is also why these tests can hold stored readings still.)

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const PiManager = (await import("./PiManager.svelte")).default;
const { setKnownCharacterStorage } = await import("../app/knownCharacters.ts");
const { setHangarPrefsStorage, saveHangarPrefs, addSquad, EMPTY_PREFS } = await import(
  "../app/hangarPrefs.ts"
);
const { setPiRosterStorage, savePiRoster, recordPiAnswer, addPiMembers, EMPTY_PI_ROSTER } =
  await import("../app/piRosterPrefs.ts");

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "PiManager.svelte"), "utf8");

const FARMER = 90000001;
const NEWBIE = 90000002;
const STRANGER = 90000003;
const SPARE = 90000004;
const MINUTE = 60_000;

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function knownPilot(characterID: number, characterName: string) {
  return {
    accountName: "alpha",
    characterID,
    characterName,
    shipName: null,
    skillPoints: null,
    balance: null,
    lastSeen: 1,
  };
}

function colonyWire(planetID: number, planetName: string, expiresAtMs: number) {
  return {
    planetID,
    planetName,
    solarSystemID: 30000001,
    solarSystemName: "Alpha",
    planetTypeID: 2016,
    planetTypeName: "Planet (Barren)",
    commandCenterLevel: 5,
    lastSimulatedAtMs: expiresAtMs - 10 * MINUTE,
    linkCount: 0,
    links: [],
    routes: [],
    pins: [
      {
        pinID: 900000000000,
        typeID: 2848,
        typeName: "Barren Extractor Control Unit",
        kind: "extractor-control",
        contents: [],
        usedM3: null,
        capacityM3: null,
        schematicID: null,
        schematicName: null,
        hasReceivedInputs: null,
        receivedInputsLastCycle: null,
        lastRunAtMs: null,
        lastLaunchAtMs: null,
        program: {
          resourceTypeID: 2268,
          resourceTypeName: "Aqueous Liquids",
          cycleTimeSeconds: 7200,
          quantityPerCycle: 4591,
          installedAtMs: expiresAtMs - 48 * 60 * MINUTE,
          expiresAtMs,
          headCount: 7,
        },
      },
    ],
  };
}

/** Seed all three stores the window reads, then render it. */
function renderSeeded(): string {
  const shared = memoryStorage();
  setKnownCharacterStorage(shared);
  setHangarPrefsStorage(shared);
  setPiRosterStorage(shared);
  shared.setItem(
    "evejs-web-known-characters:v1",
    JSON.stringify([
      knownPilot(FARMER, "Ada Farmer"),
      knownPilot(NEWBIE, "Cy Newbie"),
      knownPilot(SPARE, "Eve Spare"),
    ]),
  );
  saveHangarPrefs(addSquad(EMPTY_PREFS, { id: "sq1", name: "Miners", color: "#fff" }, [SPARE]));

  const now = Date.now();
  // Read two hours ago: one colony's program already ran out, one is running.
  const readAt = now - 2 * 60 * MINUTE;
  const answer = {
    ok: true,
    serverNowMs: readAt,
    pilots: [
      {
        characterID: FARMER,
        readAtMs: readAt,
        coloniesReadable: true,
        colonies: [
          colonyWire(40000002, "Alpha I", now + 30 * 60 * MINUTE),
          colonyWire(40000004, "Alpha II", now - 30 * MINUTE),
        ],
      },
      { characterID: NEWBIE, readAtMs: readAt, coloniesReadable: true, colonies: [] },
    ],
  };
  savePiRoster(recordPiAnswer(addPiMembers(EMPTY_PI_ROSTER, [FARMER, NEWBIE, STRANGER]), answer, readAt));
  try {
    return render(PiManager as never, { props: {} } as never).body;
  } finally {
    setKnownCharacterStorage(null);
    setHangarPrefsStorage(null);
    setPiRosterStorage(null);
  }
}

function visibleText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ");
}

test("an empty roster says what to do, and offers the hangar's pilots", () => {
  setKnownCharacterStorage(null);
  setPiRosterStorage(null);
  const text = visibleText(render(PiManager as never, { props: {} } as never).body);
  assert.match(text, /No pilots are on planetary industry yet\. Add one below\./);
  assert.match(text, /Pilots come from the Pilot hangar/);
});

test("stored readings are printed: worst first, each with its own age", () => {
  const text = visibleText(renderSeeded());
  assert.match(text, /Needs you/);
  assert.match(text, /Alpha II - Ada Farmer 1 extractor has finished its program Read 2 hours ago/);
  // Both colonies in the table, the stopped one first.
  const stopped = text.indexOf("Alpha II Ada Farmer");
  const running = text.indexOf("Alpha I Ada Farmer");
  assert.ok(stopped >= 0 && running > stopped, text);
  // Every table row carries its own age, not only the list above it.
  assert.match(text, /Alpha II Ada Farmer 1 extractor has finished its program Read 2 hours ago/);
  assert.match(text, /Alpha I Ada Farmer Extracting — next program ends in [^R]+ Read 2 hours ago/);
});

test("⚠ each pilot's outcome is said about that pilot", () => {
  const text = visibleText(renderSeeded());
  assert.match(text, /Cy Newbie Cy Newbie has not built on a planet yet\./);
  assert.match(
    text,
    /A pilot no longer in the hangar This pilot is no longer in the hangar, so there is no account to read with\./,
  );
});

test("taking a pilot off the list is called Remove, never 'Take off'", () => {
  // In a game about ships "Take off" reads as launching the ship. This button
  // only edits the list: nothing is signed in, selected or undocked.
  const text = visibleText(renderSeeded());
  assert.match(text, /\bRemove\b/);
  assert.doesNotMatch(text, /take off/i);
});

test("the add list offers pilots not yet on it, and a squad with someone new", () => {
  const body = renderSeeded();
  assert.match(body, /<option value="pilot:90000004">Eve Spare<\/option>/);
  assert.doesNotMatch(body, /<option value="pilot:90000001">/, "already on the roster");
  assert.match(body, /<option value="squad:sq1">Miners<\/option>/);
});

test("no id as data and no machinery words in anything a player reads", () => {
  const text = visibleText(renderSeeded());
  assert.doesNotMatch(text, /\d{5,}/, "no id-length number is printed");
  assert.doesNotMatch(text, /schematic|\bpins?\b|\bECU\b|character ?ID/i);
  // And the sweep does catch an id when one is there.
  assert.match(`Pilot ${FARMER}`, /\d{5,}/);
});

test("the board is given the recipe table the read fetched", () => {
  // onMount does not run under the server generator, so this is pinned at the
  // source: without it the board judges starved factories by routes alone.
  assert.match(SOURCE, /buildPiBoard\(\{[^}]*\brecipes\b[^}]*\}\)/);
  assert.match(SOURCE, /onRecipes:/);
});

test("⚠ the window never selects a character, and never reads on a timer", () => {
  assert.doesNotMatch(SOURCE, /selectCharacter|\/api\/bridge\/select|flow\.select/);
  // The one interval moves the ages on; it must not be the thing that reads.
  const interval = SOURCE.match(/setInterval\(([^;]*)\);/);
  assert.ok(interval, "the age tick exists");
  assert.doesNotMatch(interval![1]!, /refresh|readPiRoster/);
});
