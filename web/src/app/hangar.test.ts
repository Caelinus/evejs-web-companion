// The Pilot Hangar's view model (app/hangar.ts).
//
// Everything the screen decides — which pilots are on it, what order they sit
// in, and every number it prints — is computed here, so it can be pinned without
// a DOM. The cases below are the ones that were wrong first or would be wrong
// silently: a stale training entry that would report a pilot as busy for hours
// after it went idle, ISK that must not go through the wallet's exact grouping,
// and the pinned-then-SP sort inside an account.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SLOTS,
  formatIskCompact,
  formatSpCompact,
  groupByAccount,
  matchesQuery,
  pilotCountLabel,
  scopeLabel,
  selectionDetail,
  selectionLabel,
  toHangarPilots,
  totalsLabel,
  trainingLabel,
  visiblePilots,
  type HangarPilot,
} from "./hangar.ts";
import { EMPTY_PREFS, addSquad, togglePinnedPilot, type HangarPrefs } from "./hangarPrefs.ts";
import type { KnownCharacter } from "./knownCharacters.ts";

const NOW = 1_700_000_000_000;

function known(overrides: Partial<KnownCharacter> = {}): KnownCharacter {
  return {
    accountName: "Account One",
    characterID: 90000001,
    characterName: "Test Pilot",
    shipName: "Velator",
    skillPoints: 5_000_000,
    balance: 1_000_000,
    lastSeen: NOW,
    locationName: "Jita",
    trainingSkillName: null,
    trainingToLevel: null,
    trainingEndsAtMs: null,
    ...overrides,
  };
}

function pilot(overrides: Partial<HangarPilot> = {}): HangarPilot {
  return {
    characterID: 90000001,
    name: "Test Pilot",
    accountName: "Account One",
    shipName: "Velator",
    locationName: "Jita",
    skillPoints: 5_000_000,
    balance: 1_000_000,
    training: null,
    online: false,
    pinned: false,
    squads: [],
    ...overrides,
  };
}

// --- the training string ----------------------------------------------------

test("trainingLabel names the skill with its level and the time left", () => {
  assert.equal(
    trainingLabel("Mining Barge", 5, NOW + 4 * 86_400_000 + 6 * 3_600_000, NOW),
    "Mining Barge V · 4d 6h",
  );
});

test("trainingLabel treats a queue that already ended as NOT training", () => {
  // The roster row is a snapshot: the skill kept ticking while the tab was shut,
  // so a past end time means the pilot has been idle, not busy.
  assert.equal(trainingLabel("Mining Barge", 5, NOW - 1000, NOW), null);
});

test("trainingLabel keeps the skill when there is no end time to count down", () => {
  assert.equal(trainingLabel("Drones", 4, null, NOW), "Drones IV");
});

test("trainingLabel is null for an empty queue", () => {
  assert.equal(trainingLabel(null, null, null, NOW), null);
  assert.equal(trainingLabel("", 3, null, NOW), null);
});

// --- roster -> rows ---------------------------------------------------------

test("toHangarPilots marks the pilots that are actually in the client", () => {
  const rows = toHangarPilots(
    [known(), known({ characterID: 90000002, characterName: "Second" })],
    EMPTY_PREFS,
    new Set([90000002]),
    NOW,
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.online]),
    [
      ["Test Pilot", false],
      ["Second", true],
    ],
  );
});

test("toHangarPilots carries squad membership and the pin onto the row", () => {
  const prefs: HangarPrefs = togglePinnedPilot(
    addSquad(EMPTY_PREFS, { id: "s1", name: "Mining Op", color: "#52d9a3" }, [90000001]),
    90000001,
  );
  const [row] = toHangarPilots([known()], prefs, new Set(), NOW);
  assert.equal(row?.pinned, true);
  assert.deepEqual(
    row?.squads.map((s) => s.name),
    ["Mining Op"],
  );
});

test("a row with no resolved place or skill still builds — the screen shows a dash", () => {
  const [row] = toHangarPilots(
    [known({ locationName: null, trainingSkillName: null })],
    EMPTY_PREFS,
    new Set(),
    NOW,
  );
  assert.equal(row?.locationName, null);
  assert.equal(row?.training, null);
});

// --- scope and search compose ----------------------------------------------

test("search matches on name, account, ship and system", () => {
  const row = pilot({ name: "Ore Farmer", accountName: "Test Account", shipName: "Venture", locationName: "Jita" });
  assert.equal(matchesQuery(row, "farm"), true);
  assert.equal(matchesQuery(row, "test acc"), true);
  assert.equal(matchesQuery(row, "vent"), true);
  assert.equal(matchesQuery(row, "jita"), true);
  assert.equal(matchesQuery(row, "amarr"), false);
  assert.equal(matchesQuery(row, "   "), true, "a blank search filters nothing");
});

test("the idle chip and the search box compose rather than replacing each other", () => {
  const rows = [
    pilot({ characterID: 1, name: "Alpha", training: "Drones IV · 2h" }),
    pilot({ characterID: 2, name: "Beta", training: null }),
    pilot({ characterID: 3, name: "Betelgeuse", training: null }),
  ];
  const idle = visiblePilots(rows, { kind: "idle" }, "");
  assert.deepEqual(idle.map((r) => r.name), ["Beta", "Betelgeuse"]);
  const both = visiblePilots(rows, { kind: "idle" }, "bet");
  assert.deepEqual(both.map((r) => r.name), ["Beta", "Betelgeuse"]);
  const narrowed = visiblePilots(rows, { kind: "idle" }, "betel");
  assert.deepEqual(narrowed.map((r) => r.name), ["Betelgeuse"]);
});

test("the squad chip shows only that squad's pilots, across accounts", () => {
  const squad = { id: "s1", name: "Mining Op", color: "#52d9a3" };
  const rows = [
    pilot({ characterID: 1, name: "Alpha", accountName: "A", squads: [squad] }),
    pilot({ characterID: 2, name: "Beta", accountName: "B" }),
    pilot({ characterID: 3, name: "Gamma", accountName: "B", squads: [squad] }),
  ];
  assert.deepEqual(
    visiblePilots(rows, { kind: "squad", value: "s1" }, "").map((r) => r.name),
    ["Alpha", "Gamma"],
  );
});

// --- grouping and ordering --------------------------------------------------

test("accounts keep roster order and pilots sort pinned first, then by SP", () => {
  const rows = [
    pilot({ characterID: 1, name: "Low", accountName: "First", skillPoints: 1_000 }),
    pilot({ characterID: 2, name: "High", accountName: "First", skillPoints: 9_000_000 }),
    pilot({ characterID: 3, name: "Pinned", accountName: "First", skillPoints: 5, pinned: true }),
    pilot({ characterID: 4, name: "Other", accountName: "Second" }),
  ];
  const grouped = groupByAccount(rows, { padSlots: false });
  assert.deepEqual(grouped.map((g) => g.name), ["First", "Second"]);
  assert.deepEqual(grouped[0]?.pilots.map((p) => p.name), ["Pinned", "High", "Low"]);
});

test("empty slots pad an account out to its three, but only on the unfiltered view", () => {
  const rows = [pilot({ characterID: 1, accountName: "First" })];
  assert.equal(groupByAccount(rows, { padSlots: true })[0]?.emptySlots, MAX_SLOTS - 1);
  // A filtered list showing one of three pilots has no free slot to offer, and a
  // dashed "+ Add character" under it would read as a missing result.
  assert.equal(groupByAccount(rows, { padSlots: false })[0]?.emptySlots, 0);
});

test("a full account offers no slot", () => {
  const rows = [1, 2, 3].map((id) => pilot({ characterID: id, accountName: "Full" }));
  assert.equal(groupByAccount(rows, { padSlots: true })[0]?.emptySlots, 0);
});

// --- the strings ------------------------------------------------------------

test("ISK reads as a magnitude, not a wallet total", () => {
  assert.equal(formatIskCompact(4.82e9), "4.82b");
  assert.equal(formatIskCompact(134.9e6), "134.9m");
  assert.equal(formatIskCompact(86_400), "86k");
  assert.equal(formatIskCompact(412), "412");
  assert.equal(formatIskCompact(null), "—", "an unread balance is a dash, never a zero");
});

test("skill points read compactly and an unread total is a dash", () => {
  assert.equal(formatSpCompact(134_900_000), "134.9m SP");
  assert.equal(formatSpCompact(412_000), "412k SP");
  assert.equal(formatSpCompact(null), "— SP");
});

test("the summary counts what is shown but totals idle across the whole roster", () => {
  const all = [
    pilot({ characterID: 1, balance: 4.8e9, training: null }),
    pilot({ characterID: 2, balance: 2e7, training: null }),
    pilot({ characterID: 3, balance: 1e6, training: "Drones IV · 2h" }),
  ];
  const shown = [all[0]!];
  assert.equal(totalsLabel(shown, all), "1 shown · 4.80b ISK · 2 not training");
});

test("counts and labels are singular when they should be", () => {
  assert.equal(selectionLabel(1), "1 pilot selected");
  assert.equal(selectionLabel(6), "6 pilots selected");
  assert.equal(pilotCountLabel(1), "1 pilot");
  assert.equal(pilotCountLabel(3), "3 pilots");
  assert.equal(
    selectionDetail([pilot({ characterID: 1, accountName: "A", balance: 1e9 })]),
    "1 account · 1.00b ISK",
  );
  assert.equal(
    selectionDetail([
      pilot({ characterID: 1, accountName: "A", balance: 1e9 }),
      pilot({ characterID: 2, accountName: "B", balance: 5e9 }),
    ]),
    "2 accounts · 6.00b ISK",
  );
});

test("the scope label says what is on screen, and names the squad by name", () => {
  const squads = [{ id: "s1", name: "Mining Op", color: "#52d9a3" }];
  assert.equal(scopeLabel({ kind: "all" }, squads), "All pilots, grouped by account");
  assert.equal(scopeLabel({ kind: "idle" }, squads), "Pilots with an empty skill queue");
  assert.equal(scopeLabel({ kind: "online" }, squads), "Pilots already in the client");
  assert.equal(
    scopeLabel({ kind: "squad", value: "s1" }, squads),
    "Mining Op — pilots across accounts",
  );
  // A deleted squad must not print its raw id at the player (R7d).
  assert.equal(scopeLabel({ kind: "squad", value: "gone" }, squads), "Squad");
});
