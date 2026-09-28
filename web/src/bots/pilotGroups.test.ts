// PILOT GROUPS — the Bot Manager's view over the hangar's squads, and the one
// group that is not a squad.
//
// The three things worth pinning here are the three a reader would otherwise
// have to trust: that the Companions group is assembled from the companion
// ticks and never lists a pilot twice, that a member already flying is SKIPPED
// rather than queued to refuse, and that "Run here" and "Run on server" reach
// different sets of pilots.
import test from "node:test";
import assert from "node:assert/strict";

import type { ServerBot } from "../app/api.ts";
import {
  addSquad,
  EMPTY_PREFS,
  setCompanionConfig,
  type HangarPrefs,
} from "../app/hangarPrefs.ts";
import { DEFAULT_COMPANION_SETUP } from "../nav/fleetCompanionLoop.ts";
import {
  COMPANIONS_GROUP_ID,
  companionGroupRoster,
  groupMemberStates,
  groupStartEmptyWords,
  groupStatusWords,
  pilotGroups,
  planGroupLaunch,
  runHereReachWords,
  type GroupMemberState,
} from "./pilotGroups.ts";

// Synthetic throughout: 90000001-and-up mirrors ESI's documented example id.
const PILOT_A = 90000001;
const PILOT_B = 90000002;
const PILOT_C = 90000003;

function serverBot(over: Partial<ServerBot> = {}): ServerBot {
  return {
    botID: "bot-1",
    characterID: PILOT_A,
    characterName: "Sample Pilot One",
    scriptID: "script-1",
    scriptName: "Belt loop",
    scriptRev: 1,
    scriptHash: "hash-1",
    restartSafe: true,
    riskClasses: [],
    maxRuntimeMinutes: 60,
    expiresAt: null,
    status: "running",
    phase: null,
    why: null,
    stepPath: null,
    pauseReason: null,
    note: null,
    startedAt: "2026-09-02T11:00:00.000Z",
    endedAt: null,
    resumedAt: null,
    lastAlert: null,
    kind: "script",
    companion: null,
    ...over,
  };
}

function withSquad(
  prefs: HangarPrefs,
  id: string,
  name: string,
  members: readonly number[],
): HangarPrefs {
  return addSquad(prefs, { id, name, color: "#52d9a3" }, members);
}

const NO_ONE_HERE = {
  serverBots: [] as readonly ServerBot[],
  heldCharacterIDs: [] as readonly number[],
  busyHereCharacterIDs: [] as readonly number[],
  nameOf: () => null,
};

// --- the group list ---------------------------------------------------------

test("Companions leads the list and is present even with nobody in it", () => {
  // ⚠ THE ROW A PLAYER CANNOT MAKE FOR THEMSELVES MUST NOT VANISH WHEN EMPTY.
  // It is the only place that can say where the companion tick lives.
  const groups = pilotGroups(EMPTY_PREFS);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.id, COMPANIONS_GROUP_ID);
  assert.equal(groups[0]?.kind, "companions");
  assert.deepEqual(groups[0]?.members, []);
});

test("every squad becomes a group, in the order the player made them", () => {
  let prefs = withSquad(EMPTY_PREFS, "squad-1", "Mining Op", [PILOT_A, PILOT_B]);
  prefs = withSquad(prefs, "squad-2", "Scout Net", [PILOT_C]);
  const groups = pilotGroups(prefs);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["Companions", "Mining Op", "Scout Net"],
  );
  assert.deepEqual(groups[1]?.members, [PILOT_A, PILOT_B]);
  assert.equal(groups[1]?.kind, "squad");
});

test("a squad group carries the chip colour; Companions carries none", () => {
  const prefs = withSquad(EMPTY_PREFS, "squad-1", "Mining Op", [PILOT_A]);
  const groups = pilotGroups(prefs);
  assert.equal(groups[0]?.color, null, "Companions borrowed a squad colour");
  assert.equal(groups[1]?.color, "#52d9a3");
});

test("the built-in group's id cannot collide with a minted squad id", () => {
  // `nextSquadId()` mints `squad-<uuid>`; this must not be able to be one.
  assert.doesNotMatch(COMPANIONS_GROUP_ID, /^squad-/);
});

// --- the Companions group's membership --------------------------------------

test("a pilot is in Companions exactly when a squad ticked it as one", () => {
  let prefs = withSquad(EMPTY_PREFS, "squad-1", "Mining Op", [PILOT_A, PILOT_B]);
  prefs = setCompanionConfig(prefs, "squad-1", PILOT_B, DEFAULT_COMPANION_SETUP);
  assert.deepEqual(
    companionGroupRoster(prefs).map((member) => member.characterID),
    [PILOT_B],
  );
  assert.deepEqual(pilotGroups(prefs)[0]?.members, [PILOT_B]);
});

test("A PILOT IN TWO SQUADS APPEARS ONCE — it has one hull", () => {
  // Listed twice, the same character would be queued twice and the second
  // start would refuse against the first with CHARACTER_IN_USE.
  let prefs = withSquad(EMPTY_PREFS, "squad-1", "Mining Op", [PILOT_A]);
  prefs = withSquad(prefs, "squad-2", "Scout Net", [PILOT_A]);
  prefs = setCompanionConfig(prefs, "squad-1", PILOT_A, DEFAULT_COMPANION_SETUP);
  prefs = setCompanionConfig(prefs, "squad-2", PILOT_A, {
    ...DEFAULT_COMPANION_SETUP,
    fleeHealthFloor: 0.5,
  });
  const roster = companionGroupRoster(prefs);
  assert.equal(roster.length, 1);
  // First found is squad order, which is the order the player made them in.
  assert.equal(roster[0]?.setup.fleeHealthFloor, DEFAULT_COMPANION_SETUP.fleeHealthFloor);
});

// --- what each member is doing ----------------------------------------------

test("the server's claim wins over a tab that merely holds the login", () => {
  const states = groupMemberStates([PILOT_A], {
    ...NO_ONE_HERE,
    serverBots: [serverBot({ characterID: PILOT_A })],
    heldCharacterIDs: [PILOT_A],
  });
  assert.equal(states[0]?.where, "running-server");
  assert.equal(states[0]?.botName, "Belt loop");
});

test("a headless companion is named by what it IS, not by the host's run name", () => {
  const states = groupMemberStates([PILOT_A], {
    ...NO_ONE_HERE,
    serverBots: [serverBot({ characterID: PILOT_A, kind: "companion", scriptName: "whatever" })],
  });
  assert.equal(states[0]?.botName, "Fleet companion");
});

test("an ENDED server run is not a claim on the pilot", () => {
  // A finished run keeps appearing in the roster so its last readout stays
  // visible; reading it as a claim would shadow the pilot for ever.
  const states = groupMemberStates([PILOT_A], {
    ...NO_ONE_HERE,
    serverBots: [serverBot({ characterID: PILOT_A, endedAt: "2026-09-02T12:00:00.000Z" })],
  });
  assert.equal(states[0]?.where, "free");
});

test("held, busy-here and free are told apart", () => {
  const states = groupMemberStates([PILOT_A, PILOT_B, PILOT_C], {
    ...NO_ONE_HERE,
    heldCharacterIDs: [PILOT_A, PILOT_B],
    busyHereCharacterIDs: [PILOT_B],
  });
  assert.deepEqual(
    states.map((state) => state.where),
    ["held", "running-here", "free"],
  );
});

test("a pilot this browser has never seen is named, never printed as an id", () => {
  const states = groupMemberStates([PILOT_A], NO_ONE_HERE);
  assert.equal(states[0]?.name, "Unknown pilot");
  assert.doesNotMatch(states[0]!.name, /\d/);
});

// --- what a start would do --------------------------------------------------

function states(
  rows: readonly [number, GroupMemberState["where"]][],
): readonly GroupMemberState[] {
  return rows.map(([characterID, where]) => ({
    characterID,
    name: `Pilot ${characterID % 10}`,
    where,
    botName: null,
  }));
}

test("A PILOT ALREADY FLYING IS SKIPPED, NOT QUEUED TO REFUSE", () => {
  const plan = planGroupLaunch(
    states([
      [PILOT_A, "running-server"],
      [PILOT_B, "free"],
      [PILOT_C, "running-here"],
    ]),
  );
  assert.deepEqual(plan.onServer, [PILOT_B]);
  assert.deepEqual(plan.busy, [PILOT_A, PILOT_C]);
});

test("`here` is a SUBSET of `onServer`, not a disjoint half", () => {
  // A pilot this tab holds can go either way; the difference between the two
  // buttons is what happens when the tab closes, not which pilots they reach.
  const plan = planGroupLaunch(
    states([
      [PILOT_A, "held"],
      [PILOT_B, "free"],
    ]),
  );
  assert.deepEqual(plan.onServer, [PILOT_A, PILOT_B]);
  assert.deepEqual(plan.here, [PILOT_A]);
});

test("the status line counts the group, the busy and the free", () => {
  assert.equal(groupStatusWords([]), "No pilots");
  assert.equal(
    groupStatusWords(
      states([
        [PILOT_A, "running-server"],
        [PILOT_B, "free"],
      ]),
    ),
    "2 pilots - 1 already flying - 1 free",
  );
  assert.equal(groupStatusWords(states([[PILOT_A, "free"]])), "1 pilot - 1 free");
  assert.equal(
    groupStatusWords(states([[PILOT_A, "running-here"]])),
    "1 pilot - 1 already flying - none free",
  );
});

test("'Run here' says when it reaches fewer pilots than the server would", () => {
  // ⚠ A DISABLED BUTTON WITH NO SENTENCE BESIDE IT READS AS BROKEN.
  const noTabs = planGroupLaunch(states([[PILOT_A, "free"]]));
  assert.equal(runHereReachWords(noTabs), "No pilot in this group has a tab open here.");

  const some = planGroupLaunch(
    states([
      [PILOT_A, "held"],
      [PILOT_B, "free"],
    ]),
  );
  assert.equal(
    runHereReachWords(some),
    "Only 1 pilot of the 2 free have a tab open here.",
  );

  // Nothing to warn about: both buttons reach the same pilots.
  assert.equal(runHereReachWords(planGroupLaunch(states([[PILOT_A, "held"]]))), null);
  // Nothing to start at all; the status line has already said so.
  assert.equal(runHereReachWords(planGroupLaunch(states([[PILOT_A, "running-here"]]))), null);
});

test("the empty sentence names what the player has to go and do", () => {
  // ⚠ THE TWO EMPTY GROUPS MEAN DIFFERENT THINGS and neither is fixable here.
  assert.match(groupStartEmptyWords("companions", 0), /companion/i);
  assert.match(groupStartEmptyWords("companions", 0), /Pilot Hangar/);
  assert.match(groupStartEmptyWords("squad", 0), /no pilots/i);
  assert.match(groupStartEmptyWords("squad", 0), /Pilot Hangar/);
  // A group that HAS members but nobody startable is a third thing again.
  assert.match(groupStartEmptyWords("squad", 3), /already flying/i);
});

test("every sentence this module prints is plain ASCII", () => {
  const words = [
    groupStatusWords([]),
    groupStatusWords(states([[PILOT_A, "running-server"], [PILOT_B, "free"]])),
    groupStartEmptyWords("companions", 0),
    groupStartEmptyWords("squad", 0),
    groupStartEmptyWords("squad", 2),
    runHereReachWords(planGroupLaunch(states([[PILOT_A, "free"]]))) ?? "",
    runHereReachWords(planGroupLaunch(states([[PILOT_A, "held"], [PILOT_B, "free"]]))) ?? "",
  ];
  for (const line of words) {
    assert.match(line, /^[\x20-\x7e]*$/, `not plain ASCII: ${line}`);
  }
});
