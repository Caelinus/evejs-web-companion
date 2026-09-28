import test from "node:test";
import assert from "node:assert/strict";

import { FLEET_CMDR_ROLES, FLEET_JOB_CREATOR, canTagInFleet, isFleetCommander } from "./fleetCommand.ts";
import type { FleetCenterSnapshot } from "./fleetCenter.ts";
import type { BoundFleetResult, FleetInitState, FleetMember } from "./boundFleet.ts";

// --- fixture builders -------------------------------------------------------
//
// Built directly against the typed shapes rather than through the wire
// decoders (boundFleet.ts / fleetCenter.ts already have their own decode
// tests) — this module only cares what canTagInFleet/isFleetCommander do with
// an already-decoded snapshot.

const NO_OPT_OUTS = {
  acceptsConduitJumps: false,
  acceptsFleetRegroups: false,
  acceptsFleetWarp: false,
} as const;

function member(overrides: Partial<FleetMember> & { charID: number | string }): FleetMember {
  return {
    squadID: null,
    wingID: null,
    skills: [],
    timestamp: null,
    stationID: null,
    clientID: null,
    job: 0,
    role: 4, // FLEET_ROLE_MEMBER — plain member unless overridden
    shipTypeID: null,
    solarSystemID: null,
    memberOptOuts: NO_OPT_OUTS,
    ...overrides,
  };
}

function ok<T>(value: T): BoundFleetResult<T> {
  return { value, error: null, message: null };
}

const EMPTY_INIT_STATE: FleetInitState = {
  motd: "",
  options: { isFreeMove: false, isRegistered: false, autoJoinSquadID: null },
  fleetID: null,
  members: [],
  isLootLogging: false,
  squads: [],
  wings: [],
};

function readySnapshot(members: readonly FleetMember[]): FleetCenterSnapshot {
  return {
    availability: "ready",
    fleet: {
      characterID: null,
      fleetID: 999000001,
      initState: ok({ ...EMPTY_INIT_STATE, fleetID: 999000001, members }),
      wings: ok([]),
      motd: ok(""),
      joinRequests: ok([]),
      composition: ok([]),
    },
  };
}

function notInFleetSnapshot(): FleetCenterSnapshot {
  return {
    availability: "not-in-fleet",
    fleet: {
      characterID: null,
      fleetID: null,
      initState: ok(EMPTY_INIT_STATE),
      wings: ok([]),
      motd: ok(""),
      joinRequests: ok([]),
      composition: ok([]),
    },
  };
}

function unavailableSnapshot(): FleetCenterSnapshot {
  return { ...notInFleetSnapshot(), availability: "unavailable" };
}

const OWN_ID = 90000001;
const OTHER_ID = 90000002;

// --- the constants themselves, and the job/role trap ------------------------

test("FLEET_JOB_CREATOR is 2, not 1 (1 is FLEET_JOB_SCOUT); FLEET_CMDR_ROLES is [1,2,3]", () => {
  assert.equal(FLEET_JOB_CREATOR, 2);
  assert.deepEqual(FLEET_CMDR_ROLES, [1, 2, 3]);
});

// --- isFleetCommander --------------------------------------------------------

test("isFleetCommander allows the fleet creator by the job BITMASK, not equality", () => {
  assert.equal(isFleetCommander(member({ charID: OWN_ID, job: FLEET_JOB_CREATOR, role: 4 })), true);
  // job=3 is FLEET_JOB_SCOUT (1) *and* FLEET_JOB_CREATOR (2) both set — a
  // `job === FLEET_JOB_CREATOR` check would miss this; `job & FLEET_JOB_CREATOR` must not.
  assert.equal(isFleetCommander(member({ charID: OWN_ID, job: 3, role: 4 })), true);
});

test("isFleetCommander allows every FLEET_CMDR_ROLES seat even with job=0", () => {
  for (const role of FLEET_CMDR_ROLES) {
    assert.equal(isFleetCommander(member({ charID: OWN_ID, job: 0, role })), true, `role ${role}`);
  }
});

test("isFleetCommander denies a plain member with no creator job bit", () => {
  assert.equal(isFleetCommander(member({ charID: OWN_ID, job: 0, role: 4 })), false);
});

// THE TRAP, exercised directly: a scout (job=1) must NOT be treated as a
// commander just because FLEET_JOB_SCOUT and FLEET_ROLE_LEADER share the
// value 1. job and role are unrelated fields.
test("isFleetCommander denies a scout (job=1) who holds no commander role", () => {
  assert.equal(isFleetCommander(member({ charID: OWN_ID, job: 1, role: 4 })), false);
});

// --- canTagInFleet: the three-state gate over a snapshot ---------------------

test("canTagInFleet is null when there is no snapshot at all", () => {
  assert.equal(canTagInFleet(null, OWN_ID), null);
  assert.equal(canTagInFleet(undefined, OWN_ID), null);
});

test("canTagInFleet is null when the roster read is unavailable (never guesses false)", () => {
  assert.equal(canTagInFleet(unavailableSnapshot(), OWN_ID), null);
});

test("canTagInFleet is false, and settled, when authoritatively not in a fleet", () => {
  assert.equal(canTagInFleet(notInFleetSnapshot(), OWN_ID), false);
});

test("canTagInFleet is null when in a fleet but the caller's own row is missing (inconsistent read, not evidence of non-command)", () => {
  const snapshot = readySnapshot([member({ charID: OTHER_ID, job: FLEET_JOB_CREATOR, role: 4 })]);
  assert.equal(canTagInFleet(snapshot, OWN_ID), null);
});

test("canTagInFleet is true for the caller's own row when it is the fleet creator", () => {
  const snapshot = readySnapshot([
    member({ charID: OWN_ID, job: FLEET_JOB_CREATOR, role: 4 }),
    member({ charID: OTHER_ID, job: 0, role: 4 }),
  ]);
  assert.equal(canTagInFleet(snapshot, OWN_ID), true);
});

test("canTagInFleet is true for the caller's own row when it holds a commander role", () => {
  const snapshot = readySnapshot([member({ charID: OWN_ID, job: 0, role: 2 })]);
  assert.equal(canTagInFleet(snapshot, OWN_ID), true);
});

test("canTagInFleet is false for the caller's own row when it is a plain member", () => {
  const snapshot = readySnapshot([member({ charID: OWN_ID, job: 0, role: 4 })]);
  assert.equal(canTagInFleet(snapshot, OWN_ID), false);
});

// charID can decode as an exact-decimal STRING (boundFleet.ts's idData, above
// Number.MAX_SAFE_INTEGER) rather than a Number; the own-row match must not
// silently miss that case.
test("canTagInFleet finds the caller's own row even when charID decoded as a string", () => {
  const snapshot = readySnapshot([member({ charID: String(OWN_ID), job: FLEET_JOB_CREATOR, role: 4 })]);
  assert.equal(canTagInFleet(snapshot, OWN_ID), true);
});
