// One pilot's walk from "added" to "in the fleet", pure and DOM-free.
//
// ⚠ WHAT THESE TESTS EXIST TO STOP IS ON RECORD. The `join-advertised-fleet`
// block shipped with 29 green tests and hung on the first live fleet, because
// every one of them stopped at "emits an apply" — the bug was in what happened
// AFTER the apply, which nothing asserted. So the round trip is driven whole
// here: apply, the server's own answer, the accept, and membership.

import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_JOIN_MEMORY,
  FLEET_JOIN_ACCEPT_ATTEMPTS,
  decideFleetJoin,
  type FleetJoinMemory,
  type FleetJoinReads,
} from "./fleetJoinWatch.ts";

const OP = "Gabu ops";

function reads(over: Partial<FleetJoinReads> = {}): FleetJoinReads {
  return {
    wantedName: OP,
    inFleet: false,
    currentFleetID: null,
    currentFleetName: null,
    ads: [],
    application: null,
    standingDown: false,
    ...over,
  };
}

const ad = (fleetID: number, fleetName: string, numMembers = 1) => ({
  fleetID,
  fleetName,
  numMembers,
});

// ─── the round trip ──────────────────────────────────────────────────────────

test("an advertised fleet is applied to, and the id is remembered", () => {
  const out = decideFleetJoin(reads({ ads: [ad(7, OP)] }), EMPTY_JOIN_MEMORY);
  assert.deepEqual(out.action, { kind: "apply", fleetID: 7 });
  assert.equal(out.state, "joining");
  assert.equal(out.memory.appliedTo, 7);
});

test("an apply still in flight waits — it does not apply twice", () => {
  const out = decideFleetJoin(reads({ ads: [ad(7, OP)] }), { appliedTo: 7, acceptAttempts: 0 });
  assert.deepEqual(out.action, { kind: "wait" });
  assert.equal(out.state, "joining");
});

test("APPLYING IS NOT JOINING: an invited answer is accepted, naming the fleet", () => {
  // The whole defect the handoff records. An apply mints an invite and notifies
  // the applicant; membership happens only when the client accepts it.
  const out = decideFleetJoin(
    reads({ application: { fleetID: 7, outcome: "invited" } }),
    { appliedTo: 7, acceptAttempts: 0 },
  );
  assert.deepEqual(out.action, { kind: "accept", fleetID: 7 });
  assert.equal(out.memory.acceptAttempts, 1);
});

test('"unknown" tries the accept rather than assuming approval', () => {
  const out = decideFleetJoin(
    reads({ application: { fleetID: 7, outcome: "unknown" } }),
    { appliedTo: 7, acceptAttempts: 0 },
  );
  assert.deepEqual(out.action, { kind: "accept", fleetID: 7 });
});

test("membership ends the walk, and the row says which fleet", () => {
  const out = decideFleetJoin(
    reads({ inFleet: true, currentFleetID: 7, currentFleetName: OP }),
    { appliedTo: 7, acceptAttempts: 1 },
  );
  assert.equal(out.state, "in");
  assert.deepEqual(out.action, { kind: "wait" });
  assert.match(out.words, /Gabu ops/);
});

test("⚠ FOUND LIVE — retyping the op's fleet does not rename the one a pilot is IN", () => {
  // The first live run caught this: the rung that recognised "we put it there"
  // ran BEFORE the name check and printed the TYPED name, so retyping the
  // field left a pilot sitting in "Gabu ops" reading `In "Nightshift"`. A watch
  // may only ever name a fleet the server named back.
  const out = decideFleetJoin(
    reads({ wantedName: "Nightshift", inFleet: true, currentFleetID: 7, currentFleetName: OP }),
    { appliedTo: 7, acceptAttempts: 1 },
  );
  assert.equal(out.state, "blocked");
  assert.match(out.words, /Already in "Gabu ops", not "Nightshift"/);
});

test("a previous lap's answer is not mistaken for this one's", () => {
  // The application outlives a lap; the fleet id is what keeps a stale answer
  // out of a new application.
  const out = decideFleetJoin(
    reads({ application: { fleetID: 4, outcome: "invited" } }),
    { appliedTo: 7, acceptAttempts: 0 },
  );
  assert.deepEqual(out.action, { kind: "wait" });
  assert.match(out.words, /Applying/);
});

// ─── waiting, which is what this module is for ───────────────────────────────

test("an advert that is not there YET is a wait, not an answer", () => {
  // ⚠ THE ONE DELIBERATE DIFFERENCE FROM THE SCRIPT BLOCK, which finishes on an
  // empty listing because it has somewhere else to be. This window promised to
  // wait, so an empty finder keeps the row watching with no bound.
  const out = decideFleetJoin(reads({ ads: [] }), EMPTY_JOIN_MEMORY);
  assert.equal(out.state, "watching");
  assert.deepEqual(out.action, { kind: "wait" });
  assert.match(out.words, /is advertised yet/i);
  assert.equal(out.memory.appliedTo, null);
});

test("a fleet finder that could not be read is not an empty one", () => {
  const out = decideFleetJoin(reads({ ads: null }), EMPTY_JOIN_MEMORY);
  assert.equal(out.state, "watching");
  assert.match(out.words, /Reading the fleet finder/);
});

test("an unread fleet decides nothing either way", () => {
  const out = decideFleetJoin(reads({ inFleet: null, ads: [ad(7, OP)] }), EMPTY_JOIN_MEMORY);
  assert.deepEqual(out.action, { kind: "wait" });
  assert.equal(out.state, "watching");
});

test("matching is exact, not a substring", () => {
  // An unattended ship must not end up in a stranger's fleet because their
  // name happened to contain the player's word.
  const out = decideFleetJoin(reads({ ads: [ad(7, "Gabu ops recruiting")] }), EMPTY_JOIN_MEMORY);
  assert.equal(out.state, "watching");
});

test("where two adverts share a name the bigger fleet wins", () => {
  const out = decideFleetJoin(
    reads({ ads: [ad(7, OP, 2), ad(9, OP, 40)] }),
    EMPTY_JOIN_MEMORY,
  );
  assert.deepEqual(out.action, { kind: "apply", fleetID: 9 });
});

// ─── the states only the player can clear ────────────────────────────────────

test("an unnamed fleet asks for a name instead of looking for one", () => {
  const out = decideFleetJoin(reads({ wantedName: "   " }), EMPTY_JOIN_MEMORY);
  assert.equal(out.state, "blocked");
  assert.match(out.words, /Name the fleet/);
});

test("an approval-gated fleet stops at once, and does not apply again", () => {
  // The server stored a join REQUEST and minted no invite: there is nothing to
  // accept and no amount of waiting helps.
  const memory: FleetJoinMemory = { appliedTo: 7, acceptAttempts: 0 };
  const out = decideFleetJoin(
    reads({ application: { fleetID: 7, outcome: "needs-approval" } }),
    memory,
  );
  assert.equal(out.state, "blocked");
  assert.deepEqual(out.action, { kind: "wait" });
  assert.equal(out.memory.appliedTo, 7, "the id is kept so the next tick does not re-apply");
  assert.match(out.words, /approves its own members/);
});

test("a pilot in somebody else's fleet is named, and never silently yanked", () => {
  const out = decideFleetJoin(
    reads({ inFleet: true, currentFleetID: 4, currentFleetName: "Home defence" }),
    EMPTY_JOIN_MEMORY,
  );
  assert.equal(out.state, "blocked");
  assert.deepEqual(out.action, { kind: "wait" });
  assert.match(out.words, /Home defence/);
});

test("a fleet nobody advertises cannot be told from the op, so it is not assumed to be it", () => {
  // The cost of guessing right is one saved click; the cost of guessing wrong
  // is an unattended ship taking orders from a fleet the player never picked.
  const out = decideFleetJoin(
    reads({ inFleet: true, currentFleetID: 4, currentFleetName: null }),
    EMPTY_JOIN_MEMORY,
  );
  assert.equal(out.state, "blocked");
  assert.match(out.words, /not advertised/);
});

test("a pilot already in the named fleet when it was added is simply in", () => {
  const out = decideFleetJoin(
    reads({ inFleet: true, currentFleetID: 7, currentFleetName: " gabu OPS " }),
    EMPTY_JOIN_MEMORY,
  );
  assert.equal(out.state, "in");
});

test("an advert closed AFTER this watch got the pilot in does not un-join it", () => {
  // A boss who stops advertising once everyone is aboard must not turn a
  // flying companion's row into a problem — and must not get it a fleet name
  // nothing can prove either.
  const out = decideFleetJoin(
    reads({ inFleet: true, currentFleetID: 7, currentFleetName: null }),
    { appliedTo: 7, acceptAttempts: 1 },
  );
  assert.equal(out.state, "in");
  assert.doesNotMatch(out.words, /Gabu ops/, "it cannot name a fleet the server did not name");
  assert.match(out.words, /no longer advertised/);
});

// ─── the two systems that must not fight ─────────────────────────────────────

test("a companion standing down is left alone, and its application forgotten", () => {
  // Decision 5 docks a pilot nobody is supervising and LEAVES the fleet. A
  // watch that rejoined would loop join -> abandon -> join for as long as the
  // advert stood.
  const out = decideFleetJoin(
    reads({ standingDown: true, ads: [ad(7, OP)] }),
    { appliedTo: 7, acceptAttempts: 1 },
  );
  assert.equal(out.state, "standing-down");
  assert.deepEqual(out.action, { kind: "wait" });
  assert.equal(out.memory.appliedTo, null);
});

test("accepting an invite that never lands gives up on that advert and keeps watching", () => {
  // Most likely the fleet filled up between the listing and the accept — a
  // temporary fact, and waiting for temporary facts to change is the promise.
  const out = decideFleetJoin(
    reads({ application: { fleetID: 7, outcome: "invited" } }),
    { appliedTo: 7, acceptAttempts: FLEET_JOIN_ACCEPT_ATTEMPTS },
  );
  assert.equal(out.state, "watching");
  assert.deepEqual(out.action, { kind: "wait" });
  assert.equal(out.memory.appliedTo, null);
  assert.match(out.words, /may be full/);
});
