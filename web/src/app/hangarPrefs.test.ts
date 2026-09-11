// The hangar's saved arrangement (app/hangarPrefs.ts).
//
// This is the only state in the app that has no server behind it at all, so the
// things worth pinning are the ones a bad edit would corrupt quietly: deleting a
// squad must not leave its membership and its chip pin behind, removing a pilot
// must not leave squads counting it, and a storage that throws or holds junk must
// degrade to an empty arrangement rather than taking the screen down.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_PREFS,
  SQUAD_PALETTE,
  addSquad,
  addSquadMembers,
  deleteSquad,
  forgetPilots,
  loadHangarPrefs,
  nextSquadColor,
  saveHangarPrefs,
  setHangarPrefsStorage,
  squadMemberCount,
  squadsForPilot,
  toggleCollapsedAccount,
  togglePinnedPilot,
  togglePinnedSquad,
  toggleSquadMember,
  updateSquad,
  companionConfigFor,
  companionSquadRoster,
  competingTaggers,
  setCompanionConfig,
  type HangarPrefsStorage,
} from "./hangarPrefs.ts";
import {
  DEFAULT_FLEET_COMPANION_REQUEST,
  type FleetCompanionRequest,
} from "../nav/fleetCompanionLoop.ts";

function memoryStorage(seed: Record<string, string> = {}): HangarPrefsStorage & {
  readonly data: Record<string, string>;
} {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const MINING = { id: "s1", name: "Mining Op", color: "#52d9a3" };
const SCOUTS = { id: "s2", name: "Scout Net", color: "#e0b155" };

test("a squad round-trips through storage with its members, pins and collapses", () => {
  const storage = memoryStorage();
  setHangarPrefsStorage(storage);
  try {
    let prefs = addSquad(EMPTY_PREFS, MINING, [1, 2]);
    prefs = togglePinnedSquad(prefs, MINING.id);
    prefs = togglePinnedPilot(prefs, 2);
    prefs = toggleCollapsedAccount(prefs, "Account One");
    saveHangarPrefs(prefs);

    const back = loadHangarPrefs();
    assert.deepEqual(back.squads, [MINING]);
    assert.deepEqual(back.members[MINING.id], [1, 2]);
    assert.deepEqual(back.pinnedSquads, [MINING.id]);
    assert.deepEqual(back.pinnedPilots, [2]);
    assert.deepEqual(back.collapsedAccounts, ["Account One"]);
  } finally {
    setHangarPrefsStorage(null);
  }
});

test("junk in storage reads back as an empty arrangement, never a throw", () => {
  setHangarPrefsStorage(memoryStorage({ "evejs-web-hangar-prefs:v1": "{not json" }));
  try {
    assert.deepEqual(loadHangarPrefs(), EMPTY_PREFS);
  } finally {
    setHangarPrefsStorage(null);
  }
});

test("a half-written arrangement keeps the parts that are valid", () => {
  setHangarPrefsStorage(
    memoryStorage({
      "evejs-web-hangar-prefs:v1": JSON.stringify({
        squads: [MINING, { id: 7 }, null],
        members: { s1: [1, "two", 3] },
        pinnedSquads: ["s1", 9],
        pinnedPilots: [1, "x"],
      }),
    }),
  );
  try {
    const prefs = loadHangarPrefs();
    assert.deepEqual(prefs.squads, [MINING]);
    assert.deepEqual(prefs.members.s1, [1, 3]);
    assert.deepEqual(prefs.pinnedSquads, ["s1"]);
    assert.deepEqual(prefs.pinnedPilots, [1]);
  } finally {
    setHangarPrefsStorage(null);
  }
});

test("with no storage at all the arrangement is empty and saving is a no-op", () => {
  setHangarPrefsStorage(null);
  assert.deepEqual(loadHangarPrefs(), EMPTY_PREFS);
  saveHangarPrefs(addSquad(EMPTY_PREFS, MINING));
  assert.deepEqual(loadHangarPrefs(), EMPTY_PREFS);
});

test("deleting a squad takes its membership and its chip pin with it", () => {
  let prefs = addSquad(EMPTY_PREFS, MINING, [1, 2]);
  prefs = addSquad(prefs, SCOUTS, [2]);
  prefs = togglePinnedSquad(prefs, MINING.id);
  prefs = deleteSquad(prefs, MINING.id);
  assert.deepEqual(prefs.squads, [SCOUTS]);
  assert.equal(prefs.members[MINING.id], undefined);
  assert.deepEqual(prefs.pinnedSquads, []);
  assert.deepEqual(prefs.members[SCOUTS.id], [2], "the other squad is untouched");
});

test("forgetting pilots clears them out of every squad and off the pin list", () => {
  let prefs = addSquad(EMPTY_PREFS, MINING, [1, 2, 3]);
  prefs = addSquad(prefs, SCOUTS, [2, 3]);
  prefs = togglePinnedPilot(prefs, 2);
  prefs = forgetPilots(prefs, [2, 3]);
  assert.deepEqual(prefs.members[MINING.id], [1]);
  assert.deepEqual(prefs.members[SCOUTS.id], []);
  assert.deepEqual(prefs.pinnedPilots, []);
});

test("membership toggles both ways and a pilot can be in several squads", () => {
  let prefs = addSquad(addSquad(EMPTY_PREFS, MINING), SCOUTS);
  prefs = toggleSquadMember(prefs, MINING.id, 1);
  prefs = toggleSquadMember(prefs, SCOUTS.id, 1);
  assert.deepEqual(
    squadsForPilot(prefs, 1).map((s) => s.name),
    ["Mining Op", "Scout Net"],
  );
  prefs = toggleSquadMember(prefs, MINING.id, 1);
  assert.deepEqual(
    squadsForPilot(prefs, 1).map((s) => s.name),
    ["Scout Net"],
  );
});

test("a squad counts only members that are still in the roster", () => {
  const prefs = addSquad(EMPTY_PREFS, MINING, [1, 2, 3]);
  assert.equal(squadMemberCount(prefs, MINING.id, new Set([1, 3])), 2);
  assert.equal(squadMemberCount(prefs, "nope", new Set([1])), 0);
});

test("renaming and recolouring leaves everything else alone", () => {
  let prefs = addSquad(EMPTY_PREFS, MINING, [1]);
  prefs = updateSquad(prefs, MINING.id, { name: "Ore Run", color: "#b48ae0" });
  assert.deepEqual(prefs.squads, [{ id: "s1", name: "Ore Run", color: "#b48ae0" }]);
  assert.deepEqual(prefs.members[MINING.id], [1]);
  assert.deepEqual(updateSquad(prefs, "gone", { name: "x" }).squads, prefs.squads);
});

test("new squads cycle the palette so two made in a row do not look alike", () => {
  let prefs = EMPTY_PREFS;
  const picked: string[] = [];
  for (let i = 0; i < SQUAD_PALETTE.length + 1; i += 1) {
    const color = nextSquadColor(prefs);
    picked.push(color);
    prefs = addSquad(prefs, { id: `s${i}`, name: `Squad ${i}`, color });
  }
  assert.deepEqual(picked.slice(0, SQUAD_PALETTE.length), [...SQUAD_PALETTE]);
  assert.equal(picked[SQUAD_PALETTE.length], SQUAD_PALETTE[0]);
});

test("adding a selection to a squad is a union, never a replacement", () => {
  // "Save as squad → Mining Op" with two pilots selected must not throw away
  // the four already in it, and must not list a pilot twice when one of the two
  // was already a member.
  let prefs = addSquad(EMPTY_PREFS, MINING, [1, 2, 3, 4]);
  prefs = addSquadMembers(prefs, MINING.id, [3, 5]);
  assert.deepEqual(prefs.members[MINING.id], [1, 2, 3, 4, 5]);
});

test("adding pilots to a squad that is not there changes nothing", () => {
  // A squad deleted in another tab must not come back as a members entry with
  // no squad on the chip row to match it.
  const prefs = addSquad(EMPTY_PREFS, MINING, [1]);
  const after = addSquadMembers(prefs, SCOUTS.id, [2]);
  assert.equal(after, prefs, "the same value back, so nothing is written");
  assert.equal(after.members[SCOUTS.id], undefined);
});


// --- per-pilot companion setups on a squad ----------------------------------

const PILOT_A = 90000001;
const PILOT_B = 90000002;

function squadConfig(over: Partial<FleetCompanionRequest> = {}): FleetCompanionRequest {
  // What a squad member actually stores: no module lists, and the fit read at
  // start instead. An itemID saved here would be stale the moment that pilot
  // refits or changes ship.
  return { ...DEFAULT_FLEET_COMPANION_REQUEST, deriveModulesFromFit: true, ...over };
}

function squadWith(...pilots: readonly number[]) {
  let prefs = addSquad(EMPTY_PREFS, MINING);
  for (const pilot of pilots) {
    prefs = toggleSquadMember(prefs, MINING.id, pilot);
  }
  return prefs;
}

test("a pilot's companion setup is stored against the squad, and read back", () => {
  let prefs = squadWith(PILOT_A);
  assert.equal(companionConfigFor(prefs, MINING.id, PILOT_A), null, "nothing until it is set");
  prefs = setCompanionConfig(prefs, MINING.id, PILOT_A, squadConfig({ role: "logi" }));
  assert.equal(companionConfigFor(prefs, MINING.id, PILOT_A)?.role, "logi");
  prefs = setCompanionConfig(prefs, MINING.id, PILOT_A, null);
  assert.equal(companionConfigFor(prefs, MINING.id, PILOT_A), null, "and cleared with null");
});

test("a setup cannot be written against a pilot that is not in the squad", () => {
  // ⚠ IT WOULD SURVIVE EVERY PRUNE. Membership is what deleteSquad and
  // forgetPilots walk, so a config against a non-member is read by nothing and
  // cleaned up by nothing.
  const prefs = squadWith(PILOT_A);
  const after = setCompanionConfig(prefs, MINING.id, PILOT_B, squadConfig());
  assert.equal(after, prefs, "untouched");
  assert.equal(companionConfigFor(after, MINING.id, PILOT_B), null);
});

test("taking a pilot out of a squad takes its setup with it", () => {
  // ⚠ AND THE PUT-BACK IS THE REASON. A kept config would be unreachable while
  // the pilot is out, and would then silently reappear as its setup if it were
  // ever added again -- a configuration nobody chose this time.
  let prefs = squadWith(PILOT_A);
  prefs = setCompanionConfig(prefs, MINING.id, PILOT_A, squadConfig({ role: "tackle" }));
  prefs = toggleSquadMember(prefs, MINING.id, PILOT_A);
  assert.equal(companionConfigFor(prefs, MINING.id, PILOT_A), null);
  prefs = toggleSquadMember(prefs, MINING.id, PILOT_A);
  assert.equal(companionConfigFor(prefs, MINING.id, PILOT_A), null, "put back with no setup");
});

test("deleting a squad and forgetting a pilot both take the setups with them", () => {
  let prefs = squadWith(PILOT_A, PILOT_B);
  prefs = setCompanionConfig(prefs, MINING.id, PILOT_A, squadConfig());
  prefs = setCompanionConfig(prefs, MINING.id, PILOT_B, squadConfig());

  const forgotten = forgetPilots(prefs, [PILOT_A]);
  assert.equal(companionConfigFor(forgotten, MINING.id, PILOT_A), null);
  assert.ok(companionConfigFor(forgotten, MINING.id, PILOT_B), "the other one stays");

  const deleted = deleteSquad(prefs, MINING.id);
  assert.deepEqual(deleted.companionConfigs, {}, "no squad, no setups");
});

test("the squad roster is the members that are actually set up to fly", () => {
  let prefs = squadWith(PILOT_A, PILOT_B);
  prefs = setCompanionConfig(prefs, MINING.id, PILOT_B, squadConfig({ role: "logi" }));
  const roster = companionSquadRoster(prefs, MINING.id);
  assert.deepEqual(
    roster.map((row) => row.characterID),
    [PILOT_B],
    "a member with no setup has nothing to start it with",
  );
  assert.equal(roster[0]!.request.role, "logi");
});

test("two taggers in one squad are reported, one is not", () => {
  // ⚠ THIS IS WHERE THE ONE-TAGGER RULE FINALLY LANDS, and it is exactly why
  // the role presets refuse to set `attemptsTagging`: a tag is unique
  // fleet-wide and the server deletes any other item holding the same letter,
  // so two taggers fight over letters. A ROLE cannot know how many of itself
  // are in a squad. A squad can just count.
  let prefs = squadWith(PILOT_A, PILOT_B);
  prefs = setCompanionConfig(prefs, MINING.id, PILOT_A, squadConfig({ attemptsTagging: true }));
  assert.deepEqual(competingTaggers(prefs, MINING.id), [], "one tagger is the correct setup");

  prefs = setCompanionConfig(prefs, MINING.id, PILOT_B, squadConfig({ attemptsTagging: true }));
  assert.deepEqual(competingTaggers(prefs, MINING.id), [PILOT_A, PILOT_B]);

  const none = setCompanionConfig(prefs, MINING.id, PILOT_B, squadConfig());
  assert.deepEqual(competingTaggers(none, MINING.id), []);
});

test("a stored setup that cannot be decoded is dropped, not defaulted", () => {
  // ⚠ localStorage IS UNTRUSTED BYTES -- another tab, an older build, a hand
  // edit -- so the same codec botHost.start() trusts is the door here too. A
  // fabricated default would be a setup nobody chose, flying a real ship.
  const store = memoryStorage();
  setHangarPrefsStorage(store);
  let prefs = squadWith(PILOT_A, PILOT_B);
  prefs = setCompanionConfig(prefs, MINING.id, PILOT_A, squadConfig());
  saveHangarPrefs(prefs);

  const raw = JSON.parse(store.getItem("evejs-web-hangar-prefs:v1")!);
  raw.companionConfigs[MINING.id][String(PILOT_B)] = { role: "not-a-role" };
  store.setItem("evejs-web-hangar-prefs:v1", JSON.stringify(raw));

  const back = loadHangarPrefs();
  assert.ok(companionConfigFor(back, MINING.id, PILOT_A), "the good one survives");
  assert.equal(companionConfigFor(back, MINING.id, PILOT_B), null, "the junk one is gone");
  setHangarPrefsStorage(null);
});

test("an arrangement with no companionConfigs at all still loads", () => {
  // ⚠ EVERY EXISTING INSTALL IS THIS CASE. The whole reason this is a parallel
  // key rather than a richer `members` is that an older blob simply lacks it,
  // and must come back with its squads and pins intact.
  const store = memoryStorage();
  setHangarPrefsStorage(store);
  store.setItem(
    "evejs-web-hangar-prefs:v1",
    JSON.stringify({ squads: [MINING], members: { [MINING.id]: [PILOT_A] }, pinnedSquads: [MINING.id] }),
  );
  const back = loadHangarPrefs();
  assert.deepEqual(back.squads, [MINING]);
  assert.deepEqual(back.members[MINING.id], [PILOT_A]);
  assert.deepEqual(back.pinnedSquads, [MINING.id]);
  assert.deepEqual(back.companionConfigs, {});
  setHangarPrefsStorage(null);
});
