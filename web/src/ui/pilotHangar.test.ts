// The Pilot Hangar renders (goal R18 — a component that dies during creation
// takes its whole screen down silently, and this one IS the whole screen).
//
// Rendered with Svelte's server generator, like panelFirstMount.test.ts — no DOM
// needed. `$effect` and `onMount` do not run there, so this pins RENDER-time
// correctness: nothing here signs in, refreshes the roster or launches a pilot.
//
// Both states matter and fail for different reasons. First run has no roster at
// all and must reach the "No pilots yet" copy rather than an empty page; a
// populated hangar must group by account and print every column, and it is the
// one that would break on a roster row written by an older build with none of
// the hangar's fields on it.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { setKnownCharacterStorage } = await import("../app/knownCharacters.ts");
const { setHangarPrefsStorage } = await import("../app/hangarPrefs.ts");
const PilotHangar = (await import("./PilotHangar.svelte")).default;
const HangarPilotRow = (await import("./HangarPilotRow.svelte")).default;

const ROSTER_KEY = "evejs-web-known-characters:v1";
const PREFS_KEY = "evejs-web-hangar-prefs:v1";

function storage(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

function renderHangar(): string {
  return render(PilotHangar as never, {
    props: {
      onlineIDs: new Set<number>([90000002]),
      onLaunch: async () => {},
      onGoToFirst: () => {},
      onClose: null,
    },
  } as never).body;
}

const ROSTER = JSON.stringify([
  {
    accountName: "Test Account",
    characterID: 90000001,
    characterName: "Ore Farmer",
    shipName: "Venture",
    skillPoints: 134_900_000,
    balance: 4.82e9,
    lastSeen: 2,
    locationName: "Jita IV - Moon 4",
    trainingSkillName: "Mining Barge",
    trainingToLevel: 5,
    trainingEndsAtMs: null,
  },
  {
    accountName: "Test Account",
    characterID: 90000002,
    characterName: "Hauler",
    shipName: "Bestower",
    skillPoints: 10_000_000,
    balance: 1.14e9,
    lastSeen: 2,
  },
  {
    accountName: "Other Account",
    characterID: 90000003,
    characterName: "Scout",
    shipName: "Velator",
    skillPoints: 400_000,
    balance: 1.2e6,
    lastSeen: 1,
  },
]);

test.afterEach(() => {
  setKnownCharacterStorage(null);
  setHangarPrefsStorage(null);
});

test("first run renders the empty state rather than a blank page", () => {
  setKnownCharacterStorage(storage());
  setHangarPrefsStorage(storage());
  const body = renderHangar();
  assert.match(body, /No pilots yet/);
  assert.match(body, /Add your first account/);
});

test("a populated hangar groups by account and prints every pilot column", () => {
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(storage());
  const body = renderHangar();

  // Accounts are the grouping, in roster order.
  assert.match(body, /Test Account/);
  assert.match(body, /Other Account/);
  assert.ok(body.indexOf("Test Account") < body.indexOf("Other Account"));

  // Every column the screen exists to show.
  assert.match(body, /Ore Farmer/);
  assert.match(body, /Venture/);
  assert.match(body, /Jita IV - Moon 4/);
  assert.match(body, /4\.82b ISK/);
  assert.match(body, /134\.9m SP/);
  assert.match(body, /Mining Barge V/);

  // A pilot already in the client carries the badge, with its word.
  assert.match(body, />ON</);
  // A pilot with an empty queue says so twice — the badge and the stat line.
  assert.match(body, />IDLE</);
  assert.match(body, /not training/);

  // The summary counts the whole roster, and nothing is filtered yet.
  assert.match(body, /All pilots, grouped by account/);
  assert.match(body, /3 shown/);
  assert.match(body, /1 in client/);
});

test("a roster row written before the hangar existed renders dashes, not ids", () => {
  // R7d: an unresolved place or skill is an em dash. The row below has neither
  // a locationName nor a trainingSkillName — exactly what an upgrade from an
  // older build looks like.
  setKnownCharacterStorage(
    storage({
      [ROSTER_KEY]: JSON.stringify([
        {
          accountName: "Legacy",
          characterID: 90000009,
          characterName: "Old Row",
          shipName: null,
          skillPoints: null,
          balance: null,
          lastSeen: 1,
        },
      ]),
    }),
  );
  setHangarPrefsStorage(storage());
  const body = renderHangar();
  assert.match(body, /Old Row/);
  assert.match(body, /—/);
  assert.doesNotMatch(body, /90000009/, "a raw character id must never reach the player");
});

test("accounts with room offer their empty slots", () => {
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(storage());
  const body = renderHangar();
  // Other Account has one pilot of three; Test Account has two of three. Three slots.
  assert.equal(body.split("+ Add character").length - 1, 3);
  assert.match(body, /slot 3\/3/);
});

test("a squad puts its colour on the chip row and a dot on its pilots", () => {
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(
    storage({
      [PREFS_KEY]: JSON.stringify({
        squads: [{ id: "s1", name: "Mining Op", color: "#52d9a3" }],
        members: { s1: [90000001, 90000003] },
        pinnedSquads: ["s1"],
        pinnedPilots: [],
        collapsedAccounts: [],
      }),
    }),
  );
  const body = renderHangar();
  assert.match(body, /Mining Op/);
  // Both members carry a titled dot, so the colour is never the only signal.
  assert.equal(body.split('title="Mining Op"').length - 1, 2);
});

test("a collapsed account shows its header and hides its pilots", () => {
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(
    storage({
      [PREFS_KEY]: JSON.stringify({
        squads: [],
        members: {},
        pinnedSquads: [],
        pinnedPilots: [],
        collapsedAccounts: ["Other Account"],
      }),
    }),
  );
  const body = renderHangar();
  assert.match(body, /Other Account/);
  assert.doesNotMatch(body, /Scout/);
  assert.match(body, /Ore Farmer/, "the other account is unaffected");
});

// --- the row on its own -----------------------------------------------------

function renderRow(overrides: Record<string, unknown> = {}): string {
  const pilot = {
    characterID: 90000001,
    name: "Ore Farmer",
    accountName: "Test Account",
    shipName: "Venture",
    locationName: "Jita",
    skillPoints: 134_900_000,
    balance: 4.82e9,
    training: "Mining Barge V · 4d 6h",
    online: false,
    pinned: false,
    squads: [],
  };
  return render(HangarPilotRow as never, {
    props: {
      pilot,
      selected: false,
      manage: false,
      tapSelects: false,
      squads: [],
      squadMenuOpen: false,
      onActivate: () => {},
      onToggleSelect: () => {},
      onTogglePin: () => {},
      onRemove: () => {},
      onToggleSquadMenu: () => {},
      onToggleSquad: () => {},
      ...overrides,
    },
  } as never).body;
}

test("manage mode hides every way to launch or select a pilot by accident", () => {
  const normal = renderRow();
  assert.match(normal, /type="checkbox"/);
  assert.match(normal, /role="button"/);

  const managing = renderRow({ manage: true });
  assert.doesNotMatch(managing, /type="checkbox"/, "no selection while managing");
  assert.doesNotMatch(managing, /role="button"/, "the row itself is inert while managing");
  assert.match(managing, /Squads \(0\)/, "and the squad checklist appears instead");
});
