import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FLEET_COMPANION_REQUEST,
  FLEET_COMPANION_ABANDONMENT_WAIT_MS,
  FLEET_COMPANION_ROLES,
  createFleetCompanion,
  decideCompanionAction,
  freshLadderMemory,
  supervisorsInFleet,
  type CompanionLadderMemory,
  type FleetCompanionDeps,
  type FleetCompanionObservation,
  type FleetCompanionRequest,
} from "./fleetCompanionLoop.ts";
import type { SpaceSnapshot } from "../store/types.ts";
import type { FleetBroadcast } from "../bridge/fleetBroadcasts.ts";

/**
 * Two obviously-synthetic character ids: the human whose presence satisfies the
 * supervision gate, and the companion itself. `90000001` is the example CCP's
 * own ESI documentation publishes for a character id, which is why it is the
 * one to reach for — documented, unmistakably not a real pilot.
 */
const HUMAN = 90000001;
const COMPANION = 90000002;

/**
 * A complete, valid observation with named overrides — the same builder shape
 * `miningBotLoop.test.ts` uses, so a test never hand-rolls a partial object and
 * then asserts against a field it forgot to set.
 */
function obs(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return {
    inSpace: true,
    inWarp: false,
    docked: false,
    fleetTargetTags: null,
    canTag: null,
    // SUPERVISED by default, and every test that does not say otherwise relies
    // on it: a human and this pilot in the fleet, only this pilot bot-driven.
    // The alternative default — an empty fleet — would silently put every
    // unrelated test into the abandonment protocol.
    inFleet: true,
    fleetMemberCharacterIDs: [HUMAN, COMPANION],
    botDrivenCharacterIDs: [COMPANION],
    myCharacterID: COMPANION,
    pendingFleetInvite: null,
    ...overrides,
  } as FleetCompanionObservation;
}

/** An observation with nobody in the fleet this host is not flying. */
function alone(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return obs({ fleetMemberCharacterIDs: [COMPANION], ...overrides });
}

const REQUEST = DEFAULT_FLEET_COMPANION_REQUEST;

/** A space snapshot carrying one station at a given surface distance. */
function gridWithStation(distanceM: number | null): SpaceSnapshot {
  const entities = [
    {
      itemID: 1,
      kind: "ship",
      isSelf: true,
      position: { x: 0, y: 0, z: 0 },
      radius: 0,
      mode: null,
    },
  ];
  if (distanceM !== null) {
    entities.push({
      itemID: 60000001,
      kind: "station",
      isSelf: false,
      position: { x: distanceM, y: 0, z: 0 },
      radius: 0,
      mode: null,
    });
  }
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities,
  } as unknown as SpaceSnapshot;
}

/**
 * A space snapshot carrying a self ship plus one entity per given itemID, at
 * INCREASING distance in the order given — the first id is nearest. Used by
 * the rung-3 ("obeying the fleet") tests, where distance must sometimes lose
 * to a better tag rank, and sometimes be the only thing distinguishing
 * otherwise-equal candidates.
 */
function gridWithEntities(itemIDs: readonly number[]): SpaceSnapshot {
  const entities = [
    {
      itemID: 1,
      kind: "ship",
      isSelf: true,
      position: { x: 0, y: 0, z: 0 },
      radius: 0,
      mode: null,
    },
    ...itemIDs.map((itemID, index) => ({
      itemID,
      kind: "ship",
      isSelf: false,
      position: { x: (index + 1) * 10_000, y: 0, z: 0 },
      radius: 0,
      mode: null,
    })),
  ];
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities,
  } as unknown as SpaceSnapshot;
}

/** A minimal, already-fresh fleet broadcast — decideCompanionAction never re-checks the TTL. */
function fleetBroadcast(name: FleetBroadcast["name"], itemID: number | null): FleetBroadcast {
  return {
    name,
    scope: 3,
    senderCharID: HUMAN,
    senderSolarSystemID: null,
    itemID,
    typeID: null,
    receivedAtMs: 0,
  };
}

function makeDeps(
  overrides: Partial<FleetCompanionDeps> = {},
): { deps: FleetCompanionDeps; issued: unknown[] } {
  const issued: unknown[] = [];
  const deps: FleetCompanionDeps = {
    observe: async () => obs(),
    issue: async (action) => {
      issued.push(action);
    },
    sleep: async () => {},
    ...overrides,
  };
  return { deps, issued };
}

// --- the ladder -------------------------------------------------------------

test("in warp, the companion decides nothing at all", () => {
  const decision = decideCompanionAction(REQUEST, obs({ inWarp: true }));
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "In warp");
  assert.match(decision.why, /warping/i);
});

test("an UNREADABLE inWarp fails open — null is not 'in warp'", () => {
  // ⚠ The rule is `=== true`, never `!== false`. A ship that cannot be read is
  // not a ship known to be warping, and treating it as one would freeze the
  // companion whenever a read degraded.
  const decision = decideCompanionAction(REQUEST, obs({ inWarp: null }));
  assert.notEqual(decision.phase, "In warp");
});

test("not in warp, phase 0 stands by rather than inventing behaviour", () => {
  const decision = decideCompanionAction(REQUEST, obs({ inWarp: false }));
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Standing by");
});

// --- the request ------------------------------------------------------------

test("the default request is inside its own bounds", () => {
  const request = DEFAULT_FLEET_COMPANION_REQUEST;
  assert.ok(request.fleeHealthFloor >= 0.05 && request.fleeHealthFloor <= 0.95);
  assert.ok(request.capacitorFloor >= 0.05 && request.capacitorFloor <= 0.95);
  assert.ok(request.maxFleeAttempts >= 1);
  assert.ok(request.droneRedeployHoldOffSeconds >= 1);
});

test("the default request does NOT tag — one tagger per squad is opt-in", () => {
  // A tag is unique fleet-wide, so a default of `true` would mean every
  // companion in a squad fighting over letters the moment two are launched.
  assert.equal(DEFAULT_FLEET_COMPANION_REQUEST.attemptsTagging, false);
});

test("every role is a distinct, non-empty id", () => {
  assert.equal(new Set(FLEET_COMPANION_ROLES).size, FLEET_COMPANION_ROLES.length);
  for (const role of FLEET_COMPANION_ROLES) {
    assert.ok(role.length > 0);
  }
});

// --- lifecycle --------------------------------------------------------------

test("a companion that was never started does not read the world", async () => {
  const { deps, issued } = makeDeps();
  let observed = 0;
  const controller = createFleetCompanion({
    ...deps,
    observe: async () => {
      observed += 1;
      return obs();
    },
  });
  await controller.tick();
  assert.equal(observed, 0, "an idle companion must not call observe");
  assert.equal(issued.length, 0);
  assert.equal(controller.snapshot().status, "idle");
});

test("start / pause / resume / stop move through the states", () => {
  const { deps } = makeDeps();
  const controller = createFleetCompanion(deps);

  assert.equal(controller.snapshot().status, "idle");
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  assert.equal(controller.snapshot().status, "running");
  assert.equal(controller.snapshot().role, DEFAULT_FLEET_COMPANION_REQUEST.role);

  controller.pause();
  assert.equal(controller.snapshot().status, "paused");
  controller.resume();
  assert.equal(controller.snapshot().status, "running");
  controller.stop();
  assert.equal(controller.snapshot().status, "stopped");
});

test("a paused companion stops reading the world", async () => {
  let observed = 0;
  const controller = createFleetCompanion({
    observe: async () => {
      observed += 1;
      return obs();
    },
    issue: async () => {},
    sleep: async () => {},
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  await controller.tick();
  assert.equal(observed, 1);
  controller.pause();
  await controller.tick();
  assert.equal(observed, 1, "a paused tick must not read");
});

test("a read that throws pauses with the reason rather than acting on stale state", async () => {
  const controller = createFleetCompanion({
    observe: async () => {
      throw new Error("space read failed");
    },
    issue: async () => {},
    sleep: async () => {},
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  const action = await controller.tick();
  assert.equal(action.kind, "wait");
  assert.equal(controller.snapshot().status, "error");
  assert.equal(controller.snapshot().failureReason, "space read failed");
});

test("a tick from a STOPPED run cannot land after a restart", async () => {
  // ⚠ The stale-run guard. `observe` is held open across a stop+start, so the
  // tick that resumes belongs to a run the player already ended.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const issued: unknown[] = [];
  let first = true;
  const controller = createFleetCompanion({
    observe: async () => {
      if (first) {
        first = false;
        await gate;
      }
      return obs();
    },
    issue: async (action) => {
      issued.push(action);
    },
    sleep: async () => {},
  });

  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  const inFlight = controller.tick();
  controller.stop();
  release();
  const action = await inFlight;

  assert.equal(action.kind, "wait");
  assert.equal(issued.length, 0, "a stopped run must not issue");
  assert.equal(controller.snapshot().status, "stopped");
});

test("run() drives ticks and ends when the companion is stopped", async () => {
  // ⚠ STOP FROM INSIDE THE READ, not from a timer. `sleep` is faked to resolve
  // immediately, so the loop never yields to the timer phase — a
  // `setTimeout`-driven stop would never fire and this test would hang forever
  // rather than fail. Anything driving `run()` with an instant `sleep` has to
  // end the run from within the loop's own await chain.
  let ticks = 0;
  let controller: ReturnType<typeof createFleetCompanion>;
  const deps = {
    observe: async () => {
      ticks += 1;
      if (ticks >= 3) {
        controller.stop();
      }
      return obs();
    },
    issue: async () => {},
    sleep: async () => {},
  };
  controller = createFleetCompanion(deps);
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  await controller.run();
  assert.equal(ticks, 3, "run() must stop driving the moment the run ends");
  assert.equal(controller.snapshot().status, "stopped");
});

test("phase 0 issues NOTHING — the skeleton is reviewable before behaviour lands", async () => {
  const issued: unknown[] = [];
  const controller = createFleetCompanion({
    observe: async () => obs({ inWarp: false, inSpace: true }),
    issue: async (action) => {
      issued.push(action);
    },
    sleep: async () => {},
  });
  controller.start(DEFAULT_FLEET_COMPANION_REQUEST);
  await controller.tick();
  await controller.tick();
  assert.deepEqual(issued, []);
});

// --- phase 0b: the supervision gate (decision 5) -----------------------------
//
// The rule the operator stated is that a companion does no unsupervised work,
// CONTINUOUSLY and not merely at launch. These pin the check itself; the block
// below pins what happens when it fails.

test("supervisorsInFleet subtracts the bots this host flies, and this pilot", () => {
  assert.deepEqual(
    supervisorsInFleet(
      obs({
        fleetMemberCharacterIDs: [HUMAN, COMPANION, 90000003],
        botDrivenCharacterIDs: [COMPANION, 90000003],
      }),
    ),
    [HUMAN],
  );
});

test("supervisorsInFleet subtracts THIS pilot even if the host forgot to list it", () => {
  // Belt and braces: a companion must never read as its own supervisor, and a
  // host with a stale claim map must not be able to make it one.
  assert.deepEqual(
    supervisorsInFleet(obs({ fleetMemberCharacterIDs: [COMPANION], botDrivenCharacterIDs: [] })),
    [],
  );
});

test("supervisorsInFleet is null — not empty — when either read failed", () => {
  // ⚠ The distinction is the whole gate. `[]` means "looked, nobody there" and
  // starts the abandonment protocol; `null` means "could not look" and must not.
  assert.equal(supervisorsInFleet(obs({ fleetMemberCharacterIDs: null })), null);
  assert.equal(supervisorsInFleet(obs({ botDrivenCharacterIDs: null })), null);
});

test("COUNTING the fleet would pass where subtracting fails — four companions, no human", () => {
  // The failure decision 5 names: four companions plus an operator is still
  // four members the moment the operator logs off, so a size test sees a
  // healthy fleet. Subtraction sees the truth.
  const fleetOfBots = obs({
    fleetMemberCharacterIDs: [COMPANION, 90000003, 90000004, 90000005],
    botDrivenCharacterIDs: [COMPANION, 90000003, 90000004, 90000005],
  });
  assert.equal(fleetOfBots.fleetMemberCharacterIDs?.length, 4);
  assert.deepEqual(supervisorsInFleet(fleetOfBots), []);
  assert.equal(decideCompanionAction(REQUEST, fleetOfBots).phase, "Getting safe");
});

test("an UNREADABLE roster fails open: no abandonment is started", () => {
  // A transient roster failure must not dock a live fleet operation and disband
  // it. What bounds a read that stays broken is the run's own deadline.
  const decision = decideCompanionAction(REQUEST, obs({ fleetMemberCharacterIDs: null }));
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Checking supervision");
  assert.equal(decision.memory.abandonment, null);
});

test("an unreadable roster does not CLEAR an abandonment already under way", () => {
  // The other half of failing open: not being able to see the fleet is not
  // evidence that a human came back.
  const started = decideCompanionAction(REQUEST, alone({ docked: true, inFleet: false }));
  assert.notEqual(started.memory.abandonment, null);
  const blind = decideCompanionAction(
    REQUEST,
    obs({ fleetMemberCharacterIDs: null }),
    started.memory,
  );
  assert.equal(blind.memory.abandonment?.abandonedAtMs, started.memory.abandonment?.abandonedAtMs);
});

test("the supervision gate sits ABOVE the ladder but BELOW the warp yield", () => {
  // Rung 1 is not an order source; it is the tick on which nothing can be
  // issued at all. So a fleet-warping ship decides nothing even when abandoned.
  const decision = decideCompanionAction(REQUEST, alone({ inWarp: true }));
  assert.equal(decision.phase, "In warp");
  assert.equal(decision.memory.abandonment, null);
});

test("supervision returning CLEARS the abandonment and remembers who is here", () => {
  const abandoned = decideCompanionAction(REQUEST, alone({ docked: true, inFleet: false }));
  assert.notEqual(abandoned.memory.abandonment, null);
  const back = decideCompanionAction(REQUEST, obs(), abandoned.memory);
  assert.equal(back.memory.abandonment, null);
  assert.equal(back.phase, "Standing by");
  assert.deepEqual(back.memory.lastSupervisorIDs, [HUMAN]);
});

// --- phase 0b: the abandonment protocol --------------------------------------
//
// Get safe, THEN disband, then wait a bounded thirty minutes, and take a way
// back only from someone who was actually here.

test("a station beyond the warp floor is warped to", () => {
  const decision = decideCompanionAction(REQUEST, alone({ snapshot: gridWithStation(200_000) }));
  assert.deepEqual(decision.action, { kind: "warp", targetID: 60000001 });
  assert.equal(decision.phase, "Getting safe");
});

test("a station too close for the server to warp to is approached", () => {
  const decision = decideCompanionAction(REQUEST, alone({ snapshot: gridWithStation(50_000) }));
  assert.deepEqual(decision.action, { kind: "approach", targetID: 60000001 });
  // The approach is remembered, so the next tick reads "closing" rather than
  // restarting the approach every two seconds.
  assert.equal(decision.memory.closingOn, 60000001);
});

test("a station inside the docking radius is docked at", () => {
  const decision = decideCompanionAction(REQUEST, alone({ snapshot: gridWithStation(1_000) }));
  assert.deepEqual(decision.action, { kind: "dock", stationID: 60000001 });
});

test("SAFE FIRST, THEN LEAVE — a companion still in space does not drop fleet", () => {
  // ⚠ The order is load-bearing. Leaving first gives up the fleet-warp channel
  // while the ship is still sitting in space.
  const decision = decideCompanionAction(
    REQUEST,
    alone({ inFleet: true, docked: false, snapshot: gridWithStation(200_000) }),
  );
  assert.notEqual(decision.action.kind, "leaveFleet");
  assert.equal(decision.action.kind, "warp");
});

test("docked and still in the fleet, it leaves — one pilot, for itself", () => {
  const decision = decideCompanionAction(REQUEST, alone({ docked: true, inFleet: true }));
  assert.deepEqual(decision.action, { kind: "leaveFleet" });
});

test("docked and out of the fleet, it waits and says how long is left", () => {
  const decision = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, fleetMemberCharacterIDs: [] }),
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Abandoned");
  assert.match(decision.why, /30 more minute/);
});

test("the thirty-minute wait ENDS the run, releasing the hull", () => {
  // Stopping is what releases the ship: the BFF's bot host treats a terminal
  // status as the end of the bot and logs its session out. A pause would hold
  // the hull for ever.
  const start = decideCompanionAction(REQUEST, alone({ docked: true, inFleet: false }), undefined, 1_000);
  const expired = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    start.memory,
    1_000 + FLEET_COMPANION_ABANDONMENT_WAIT_MS,
  );
  assert.ok(expired.stop);
  assert.match(expired.stop as string, /thirty minutes/i);
});

test("a rejoin from a pilot who WAS in the fleet is accepted", () => {
  // The allowlist can only be collected forward: at the moment of abandonment
  // there are no humans left to read, by definition.
  const supervised = decideCompanionAction(REQUEST, obs());
  assert.deepEqual(supervised.memory.lastSupervisorIDs, [HUMAN]);
  const waiting = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    supervised.memory,
  );
  const invited = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, pendingFleetInvite: { fleetID: 77, inviterID: HUMAN } }),
    waiting.memory,
  );
  assert.deepEqual(invited.action, { kind: "acceptFleetInvite", fleetID: 77 });
});

test("a rejoin from a STRANGER is refused — an idle docked pilot is not free to take", () => {
  // ⚠ Without this gate an idle docked companion can be fleet-invited by anyone
  // and handed a ship.
  const supervised = decideCompanionAction(REQUEST, obs());
  const waiting = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    supervised.memory,
  );
  const invited = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, pendingFleetInvite: { fleetID: 77, inviterID: 90000009 } }),
    waiting.memory,
  );
  assert.equal(invited.action.kind, "wait");
  assert.match(invited.why, /not in the fleet/i);
});

test("an invite with NO usable inviter id is refused", () => {
  // An unmatchable invite is exactly the one the gate exists to refuse.
  const supervised = decideCompanionAction(REQUEST, obs());
  const waiting = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    supervised.memory,
  );
  const invited = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, pendingFleetInvite: { fleetID: 77, inviterID: null } }),
    waiting.memory,
  );
  assert.equal(invited.action.kind, "wait");
});

test("the deadline beats a VALID invite — a bounded wait is not extendable", () => {
  // A rejoin past the deadline would be one bounded wait extended by another,
  // which is the unbounded life the persisted clock exists to prevent.
  const supervised = decideCompanionAction(REQUEST, obs(), undefined, 1_000);
  const waiting = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false }),
    supervised.memory,
    1_000,
  );
  const late = decideCompanionAction(
    REQUEST,
    alone({ docked: true, inFleet: false, pendingFleetInvite: { fleetID: 77, inviterID: HUMAN } }),
    waiting.memory,
    1_000 + FLEET_COMPANION_ABANDONMENT_WAIT_MS,
  );
  assert.ok(late.stop);
  assert.notEqual(late.action.kind, "acceptFleetInvite");
});

test("no station in view and NO safe spot: it stops where it is, and says why", () => {
  // Decision 5's one case with nothing to do. A fabricated safe spot would be
  // worse than an honest stop — there is no sun here to warp to.
  assert.equal(REQUEST.safeSpotBookmarkID, null);
  const decision = decideCompanionAction(REQUEST, alone({ snapshot: gridWithStation(null) }));
  assert.ok(decision.stop);
  assert.match(decision.stop as string, /no safe spot/i);
});

test("no station in view but a safe spot named: it warps there, ONCE", () => {
  const request: FleetCompanionRequest = { ...REQUEST, safeSpotBookmarkID: 4242 };
  const first = decideCompanionAction(request, alone({ snapshot: gridWithStation(null) }));
  assert.deepEqual(first.action, { kind: "warpToBookmark", bookmarkID: 4242 });
  assert.equal(first.memory.abandonment?.safeSpotWarpIssued, true);
  // Not re-issued every two seconds while the server gets around to it.
  const second = decideCompanionAction(request, alone({ snapshot: gridWithStation(null) }), first.memory);
  assert.equal(second.action.kind, "wait");
  assert.match(second.why, /warp to the safe spot to start/i);
});

test("the safe spot counts as safe only once the warp has been SEEN and is over", () => {
  // ⚠ "Issued the warp" is not "left the grid": the POST returns before
  // shipMode flips, and treating the two as the same would drop fleet with the
  // ship still sitting where it was. Confirmed by a reading, never by a timer.
  const request: FleetCompanionRequest = { ...REQUEST, safeSpotBookmarkID: 4242 };
  const issued = decideCompanionAction(request, alone({ snapshot: gridWithStation(null) }));
  // Still on grid, warp not yet seen: it must NOT decide it is safe.
  const notYet = decideCompanionAction(
    request,
    alone({ inFleet: true, snapshot: gridWithStation(null) }),
    issued.memory,
  );
  assert.notEqual(notYet.action.kind, "leaveFleet");
  // The warp is observed...
  const inWarp = decideCompanionAction(request, alone({ inWarp: true }), issued.memory);
  assert.equal(inWarp.memory.abandonment?.safeSpotWarpSeen, true);
  // ...and once it is over, the ship is safe and may drop fleet.
  const landed = decideCompanionAction(
    request,
    alone({ inFleet: true, snapshot: gridWithStation(null) }),
    inWarp.memory,
  );
  assert.deepEqual(landed.action, { kind: "leaveFleet" });
});

// --- phase 0b: the controller ------------------------------------------------

test("start() re-seats a persisted abandonment, keeping its ORIGINAL clock", () => {
  // ⚠ The whole point of persisting it. A fresh thirty minutes on every restart
  // is an unbounded wait assembled out of bounded ones.
  const { deps } = makeDeps();
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST, { abandonedAtMs: 12_345, supervisorCharacterIDs: [HUMAN] });
  assert.equal(companion.snapshot().abandonment?.abandonedAtMs, 12_345);
  assert.deepEqual(companion.snapshot().abandonment?.supervisorCharacterIDs, [HUMAN]);
});

test("a re-seated abandonment does NOT claim the ship already reached safety", async () => {
  // The warp that was in flight when the process died is not a warp THIS run
  // observed. Claiming it had landed would let the next tick drop fleet with
  // the ship still in space.
  const { deps, issued } = makeDeps({
    observe: async () => alone({ inFleet: true, snapshot: gridWithStation(200_000) }),
  });
  const companion = createFleetCompanion(deps);
  companion.start(
    { ...REQUEST, safeSpotBookmarkID: 4242 },
    { abandonedAtMs: Date.now(), supervisorCharacterIDs: [HUMAN] },
  );
  await companion.tick();
  assert.deepEqual(issued, [{ kind: "warp", targetID: 60000001 }]);
});

test("a ladder stop ends the run and KEEPS the sentence that says which one", async () => {
  const { deps } = makeDeps({ observe: async () => alone({ snapshot: gridWithStation(null) }) });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  const readout = companion.snapshot();
  assert.equal(readout.status, "stopped");
  assert.match(readout.failureReason as string, /no safe spot/i);
});

test("the readout carries the abandonment, which is how the clock gets persisted", async () => {
  const seen: (number | undefined)[] = [];
  const { deps } = makeDeps({
    observe: async () => alone({ docked: true, inFleet: false }),
    onProgress: (progress) => seen.push(progress.abandonment?.abandonedAtMs),
  });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  assert.ok(seen.some((at) => typeof at === "number"));
});

test("the ladder's memory is threaded, not dropped, between ticks", async () => {
  // ⚠ A decision whose memory is dropped silently un-does whatever that tick
  // learned — the safe-spot warp it just issued, or the humans it just saw.
  const { deps } = makeDeps({ observe: async () => obs() });
  const companion = createFleetCompanion(deps);
  companion.start(REQUEST);
  await companion.tick();
  const memory: CompanionLadderMemory = freshLadderMemory();
  assert.deepEqual(memory.lastSupervisorIDs, []);
  // After one supervised tick the loop is holding the human, ready to become
  // the rejoin allowlist the moment they leave.
  assert.equal(companion.snapshot().inFleet, true);
});

// --- rung 3: obeying the fleet ------------------------------------------------
//
// Below the supervision gate (only reached while a human is here) and above
// "Standing by". Tag beats broadcast — AUTHORITY, not freshness: a tag can
// only be a commander's write, a `Target` broadcast can come from any member.
// An order for something off THIS grid is not an order for this pilot at all,
// and it falls through rather than waiting.

/** Synthetic on-grid item ids — ordinary ships, not player or station ids. */
const TACKLE = 200001;
const LOGI = 200002;
const OTHER = 200003;

test("a fleet tag on grid is locked", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([TACKLE]), fleetTargetTags: new Map([[TACKLE, "A"]]) }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.ok(decision.lastOrderHeard);
});

test("the BEST tag wins when several are tagged, not the nearest", () => {
  // TACKLE is nearer (gridWithEntities puts the first id closest) but tagged
  // "Z" — the worst recognised letter. OTHER is farther but tagged "1", a
  // digit, which outranks every letter. Rank must win over distance.
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE, OTHER]),
      fleetTargetTags: new Map([
        [TACKLE, "Z"],
        [OTHER, "1"],
      ]),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: OTHER });
});

test("an unrecognised tag is still obeyed, not dropped", () => {
  // "Q" is not in the stock menu's A-J/X/Y/Z alphabet, but fleetTagRank still
  // gives it a finite rank — a hand-typed or non-stock tag is a real order.
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([TACKLE]), fleetTargetTags: new Map([[TACKLE, "Q"]]) }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
});

test("a tag on an item OFF this grid falls through to a broadcast", () => {
  // The tagged item (999999) never appears in the snapshot's entities, so the
  // tag names nothing this pilot can act on — it falls through to the Target
  // broadcast, which names an entity that IS on grid.
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: new Map([[999999, "A"]]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("a Target broadcast locks the item it names, when it is on grid", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: null,
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("a tag BEATS a simultaneous conflicting Target broadcast — authority, not freshness", () => {
  // ⚠ This is the ordering that looks backwards. The broadcast is the fresher
  // act, but `setFleetTargetTag` refuses anyone who is not a fleet commander
  // while `sendBroadcast` checks only membership — a tag that exists is
  // provably the FC's, a broadcast could be any squad member's. The tag must
  // win even though the broadcast points at a DIFFERENT, equally on-grid item.
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE, OTHER]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      fleetBroadcast: fleetBroadcast("Target", OTHER),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "tag");
});

test("an AlignTo broadcast aligns to the item it names", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([LOGI]),
      fleetTargetTags: null,
      fleetBroadcast: fleetBroadcast("AlignTo", LOGI),
    }),
  );
  assert.deepEqual(decision.action, { kind: "align", targetID: LOGI });
  assert.equal(decision.followingOrderFrom, "broadcast");
  // Never the wire name verbatim — the panel shows plain words.
  assert.ok(!decision.lastOrderHeard?.includes("AlignTo"));
});

test("obeys without \"tag\" ignores a tag on grid", () => {
  const request: FleetCompanionRequest = { ...REQUEST, obeys: ["broadcast"] };
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntities([TACKLE]), fleetTargetTags: new Map([[TACKLE, "A"]]) }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.equal(decision.phase, "Standing by");
});

test("obeys without \"broadcast\" ignores a Target broadcast", () => {
  const request: FleetCompanionRequest = { ...REQUEST, obeys: ["tag"] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: null,
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.equal(decision.phase, "Standing by");
});

test("an already-locked target is not re-locked", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
    }),
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.match(decision.why, /already locked/i);
});

test("a lock the SERVER refused is retried, because the real list is consulted", () => {
  // ⚠ THE REGRESSION THIS PINS IS PERMANENT AND SILENT. A lock is issued
  // optimistically; the server can refuse it (out of range, already at max
  // targets, the ship died). If the already-locked check trusted this loop's
  // own memory of what it last ASKED for, a refused lock would read as done
  // for the rest of the run and the pilot would sit next to the fleet's
  // primary never locking it, with nothing in the readout saying why.
  //
  // So `obs.lockedTargetIDs` -- the authoritative list, re-read every tick --
  // wins over memory whenever it is available. An empty array is a real
  // "nothing is locked" answer and must be trusted as one.
  const memory = { ...freshLadderMemory(), lastLockIssuedFor: TACKLE };
  const decision = decideCompanionAction(
    REQUEST,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [],
    }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
});

test("obeying the fleet is skipped entirely once the supervision gate has failed", () => {
  // ⚠ An abandoned pilot getting safe must not start locking things. Nobody is
  // left to have given the order in the first place, and the whole point of
  // rung 2 sitting ABOVE this one is that it never runs while abandoned.
  const decision = decideCompanionAction(
    REQUEST,
    alone({ snapshot: gridWithEntities([TACKLE]), fleetTargetTags: new Map([[TACKLE, "A"]]) }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.notEqual(decision.phase, "Obeying fleet");
  // The abandonment protocol ran instead — no station and no safe spot here,
  // so it stops the run rather than doing anything with the tagged ship.
  assert.ok(decision.stop);
  assert.match(decision.stop as string, /no safe spot/i);
});

// --- rung 3: the Heal family --------------------------------------------------
//
// HealShield/HealArmor/HealCapacitor/HealTarget. Checked BEFORE the tag and
// the Target broadcast (a rep call is time-critical; a tag is standing
// state), but an already-satisfied Heal falls through to them instead of
// parking the tick — repairing and locking are not mutually exclusive for
// the same ship. See `decideFleetOrders`'s header for the full reasoning.

/** A fleet-mate's ship, distinct from the TACKLE/LOGI/OTHER combat targets. */
const ALLY = 200004;
const SHIELD_MODULE = 11200002;
const ARMOR_MODULE = 11200003;
const CAPACITOR_MODULE = 11200004;

/**
 * A grid carrying one or more ships plus this ship's own `activeModuleIDs` —
 * the authoritative "what is cycling" read the Heal rungs consult. `null`
 * means unreadable, matching `SpaceShipStatus.activeModuleIDs`'s own
 * null-means-unknown contract.
 */
function gridWithShipsAndActive(
  itemIDs: readonly number[],
  activeModuleIDs: readonly number[] | null = [],
): SpaceSnapshot {
  const entities = [
    { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    ...itemIDs.map((itemID, index) => ({
      itemID,
      kind: "ship",
      isSelf: false,
      position: { x: (index + 1) * 10_000, y: 0, z: 0 },
      radius: 0,
      mode: null,
    })),
  ];
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null, activeModuleIDs },
    entities,
  } as unknown as SpaceSnapshot;
}

test("HealShield activates a fitted remote SHIELD module on the ship the call names", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithShipsAndActive([ALLY]), fleetBroadcast: fleetBroadcast("HealShield", ALLY) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: ALLY });
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("HealArmor activates the ARMOUR list, never the shield one — families do not cross", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    remoteShieldModuleIDs: [SHIELD_MODULE],
    remoteArmorModuleIDs: [ARMOR_MODULE],
  };
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithShipsAndActive([ALLY]), fleetBroadcast: fleetBroadcast("HealArmor", ALLY) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_MODULE, targetID: ALLY });
});

test("HealCapacitor activates the CAPACITOR list", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteCapacitorModuleIDs: [CAPACITOR_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithShipsAndActive([ALLY]), fleetBroadcast: fleetBroadcast("HealCapacitor", ALLY) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: CAPACITOR_MODULE, targetID: ALLY });
});

test("HealTarget draws on whichever remote-repair family this pilot has fitted", () => {
  // Real fleet logi use HealTarget to say "focus on THIS ship" without
  // saying which layer is hurt — this pilot brings whatever it has.
  const request: FleetCompanionRequest = { ...REQUEST, remoteArmorModuleIDs: [ARMOR_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithShipsAndActive([ALLY]), fleetBroadcast: fleetBroadcast("HealTarget", ALLY) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_MODULE, targetID: ALLY });
});

test("a Heal call with no matching module fitted falls through — a logi-less pilot still flies", () => {
  const decision = decideCompanionAction(
    REQUEST, // no remote modules fitted at all
    obs({ snapshot: gridWithShipsAndActive([ALLY]), fleetBroadcast: fleetBroadcast("HealShield", ALLY) }),
  );
  assert.notEqual(decision.action.kind, "activate");
  assert.equal(decision.phase, "Standing by");
});

test("a Heal call for a ship OFF this grid falls through rather than waiting", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({
      // ALLY, the ship the call names, is not among these entities.
      snapshot: gridWithShipsAndActive([TACKLE]),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  assert.notEqual(decision.action.kind, "activate");
  assert.equal(decision.phase, "Standing by");
});

test("a module the server confirms is already running on this target is not re-activated", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const first = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], []),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: ALLY });
  // The server now shows it cycling, and this ladder's own memory agrees it
  // was the one that aimed it at ALLY — nothing new to start.
  const second = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], [SHIELD_MODULE]),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
    first.memory,
  );
  assert.notEqual(second.action.kind, "activate");
});

test("with no authoritative module read, the ladder falls back to its OWN memory of what it issued", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const first = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], null),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: ALLY });
  const second = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], null),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
    first.memory,
  );
  assert.notEqual(second.action.kind, "activate");
});

test("the heal call moving to a DIFFERENT ship re-issues the module at the new one", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const OTHER_ALLY = 200005;
  const first = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([ALLY], [SHIELD_MODULE]),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  const second = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([OTHER_ALLY], [SHIELD_MODULE]),
      fleetBroadcast: fleetBroadcast("HealShield", OTHER_ALLY),
    }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: OTHER_ALLY });
});

test("a fresh Heal call is answered even while a tag also stands — urgency wins this tick", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([TACKLE, ALLY]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: SHIELD_MODULE, targetID: ALLY });
});

test("once the heal is already running, the SAME tick's tag is obeyed — not mutually exclusive", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastHealTargetID: ALLY,
    lastHealModuleIDs: [SHIELD_MODULE],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithShipsAndActive([TACKLE, ALLY], [SHIELD_MODULE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "tag");
});

// --- rung 3: TravelTo ---------------------------------------------------------

/** Synthetic solar system ids — no on-grid meaning, just a destination. */
const SYSTEM_B = 30000001;
const SYSTEM_C = 30000002;

test("a TravelTo broadcast starts the route once, and not again for the same system", () => {
  const first = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_B) }),
  );
  assert.deepEqual(first.action, { kind: "travelTo", systemID: SYSTEM_B });
  assert.equal(first.memory.lastRoutedSystemID, SYSTEM_B);
  assert.equal(first.followingOrderFrom, "broadcast");

  const second = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_B) }),
    first.memory,
  );
  assert.notEqual(second.action.kind, "travelTo");
});

test("a TravelTo broadcast naming a NEW system routes again", () => {
  const first = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_B) }),
  );
  const second = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_C) }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "travelTo", systemID: SYSTEM_C });
});

// --- rung 3: JumpTo (honest partial) ------------------------------------------
//
// `itemID` is a single stargate; `api.jump` needs the gate on the far side
// too, which nothing available to this pure, synchronous ladder can supply
// without inventing it. So this rung gets the ship TO the gate and holds —
// see `decideFleetOrders`'s own comment for the full reasoning.

const GATE = 200006;

/** A grid carrying one stargate at a given surface distance (or none). */
function gridWithGate(distanceM: number | null): SpaceSnapshot {
  const entities = [
    { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
  ];
  if (distanceM !== null) {
    entities.push({
      itemID: GATE,
      kind: "stargate",
      isSelf: false,
      position: { x: distanceM, y: 0, z: 0 },
      radius: 0,
      mode: null,
    });
  }
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
    entities,
  } as unknown as SpaceSnapshot;
}

test("a JumpTo broadcast warps to the named gate when it is far", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(200_000), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
  );
  assert.deepEqual(decision.action, { kind: "warp", targetID: GATE });
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("a JumpTo broadcast closes in when too close for the server to warp to", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(50_000), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
  );
  assert.deepEqual(decision.action, { kind: "approach", targetID: GATE });
  assert.equal(decision.memory.closingOn, GATE);
});

test("a JumpTo broadcast HOLDS at jump range — it never invents a second gate id", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(1_000), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "broadcast");
  assert.match(decision.why, /holding here/i);
});

test("a JumpTo broadcast for a gate OFF this grid falls through", () => {
  const decision = decideCompanionAction(
    REQUEST,
    obs({ snapshot: gridWithGate(null), fleetBroadcast: fleetBroadcast("JumpTo", GATE) }),
  );
  assert.notEqual(decision.action.kind, "warp");
  assert.equal(decision.phase, "Standing by");
});

// --- rung 3: everything above is skipped once abandonment starts -------------

test("Heal and TravelTo are ALSO skipped once the supervision gate has failed", () => {
  const request: FleetCompanionRequest = { ...REQUEST, remoteShieldModuleIDs: [SHIELD_MODULE] };
  const healDecision = decideCompanionAction(
    request,
    alone({ snapshot: gridWithShipsAndActive([ALLY]), fleetBroadcast: fleetBroadcast("HealShield", ALLY) }),
  );
  assert.notEqual(healDecision.action.kind, "activate");
  assert.notEqual(healDecision.phase, "Obeying fleet");

  const travelDecision = decideCompanionAction(
    REQUEST,
    alone({ snapshot: gridWithEntities([]), fleetBroadcast: fleetBroadcast("TravelTo", SYSTEM_B) }),
  );
  assert.notEqual(travelDecision.action.kind, "travelTo");
  assert.notEqual(travelDecision.phase, "Obeying fleet");
});
