import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_FLEET_COMPANION_REQUEST,
  FLEET_COMPANION_ABANDONMENT_WAIT_MS,
  FLEET_COMPANION_ROLES,
  TANK_LAYER_HURT_THRESHOLD,
  createFleetCompanion,
  decideCompanionAction,
  freshLadderMemory,
  supervisorsInFleet,
  type CompanionDecision,
  type CompanionLadderMemory,
  type FleetCompanionDeps,
  type FleetCompanionObservation,
  type FleetCompanionRequest,
} from "./fleetCompanionLoop.ts";
import type { ChatMessage, SpaceSnapshot } from "../store/types.ts";
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

// --- rung 5: obeying the fleet ------------------------------------------------
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

test("an already-locked target is not re-locked, and an EMPTY weaponModuleIDs holds it without firing", () => {
  // ⚠ EMPTY IS A REAL SETTING, NOT A FAULT. `weaponModuleIDs`'s own comment
  // says so: it is the default, and an operator who left it empty by accident
  // must read this pilot's "why" as a setting, never as the feature being
  // broken.
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
  assert.match(decision.why, /locked/i);
  assert.match(decision.why, /no weapon is picked/i);
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

// --- rung 5: the Heal family --------------------------------------------------
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

// --- rung 5: opening fire once a called target is locked ---------------------
//
// `lockThenEngage` replaced `lockOrHold` (see its own header in
// fleetCompanionLoop.ts): a called target that is ALREADY locked no longer
// just sits there — it opens fire, one weapon a tick, using whatever this
// pilot has fitted in `weaponModuleIDs`. Lock, observe, THEN fire.

/** Synthetic weapon module ids — a small rack, none of them banked unless a test says so. */
const GUN_1 = 11300001;
const GUN_2 = 11300002;
const GUN_3 = 11300003;
const GUN_MASTER = 11300010;
const GUN_SLAVE = 11300011;
const GUN_UNBANKED = 11300012;

/**
 * As `gridWithEntities`, but the ship also carries `activeModuleIDs` and
 * `weaponBanks` — the two reads `decideOpenFire` consults. Neither
 * `gridWithEntities` (no rack) nor `gridWithShipsAndActive` (no tag/broadcast
 * targets — its ships are ALLY, the Heal family's own fixture) carries a
 * called target AND a rack state at once, which the fire tests below need.
 */
function gridWithEntitiesAndRack(
  itemIDs: readonly number[],
  activeModuleIDs: readonly number[] | null = [],
  weaponBanks: Readonly<Record<number, readonly number[]>> | null = {},
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
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null, activeModuleIDs, weaponBanks },
    entities,
  } as unknown as SpaceSnapshot;
}

test("a called target NOT YET LOCKED locks first, and does not fire", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
});

test("once the lock is OBSERVED, the very next tick opens fire on the called target", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
    }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });
  assert.match(decision.why, /opening fire/i);
});

test("the rack comes up ONE WEAPON PER TICK, and each confirmed weapon is skipped the next", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1, GUN_2, GUN_3] };
  const tagged = { fleetTargetTags: new Map([[TACKLE, "A"]]), lockedTargetIDs: [TACKLE] };

  const first = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], []) }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });

  const second = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_1]) }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "activate", moduleID: GUN_2, targetID: TACKLE });

  const third = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_1, GUN_2]) }),
    second.memory,
  );
  assert.deepEqual(third.action, { kind: "activate", moduleID: GUN_3, targetID: TACKLE });

  // The whole rack is now confirmed cycling — nothing NEW to start, and this
  // rung still reports "Obeying fleet", not a fall to "Standing by".
  const fourth = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_1, GUN_2, GUN_3]) }),
    third.memory,
  );
  assert.equal(fourth.action.kind, "wait");
  assert.equal(fourth.phase, "Obeying fleet");
  assert.equal(fourth.followingOrderFrom, "tag");
  assert.match(fourth.why, /firing on it/i);
});

test("A NEW CALL RE-AIMS THE WHOLE RACK, even while the old guns still read as cycling", () => {
  // ⚠ THIS IS THE ONE THAT MATTERS MOST. `activeModuleIDs` says a module is
  // cycling and never says AT WHOM — see `lastFireTargetID`'s own comment. A
  // commander who re-tags OTHER must see every gun re-issued, gun by gun, not
  // a pilot that reads the still-cycling old guns as already answering the
  // new call.
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1, GUN_2, GUN_3] };
  const firingOnTackle: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastFireTargetID: TACKLE,
    lastFireModuleIDs: [GUN_1, GUN_2, GUN_3],
  };
  // The server has not caught up: all three old guns still read as cycling,
  // unchanged, through every tick below — only the CALL has moved to OTHER.
  const stillCyclingFromTackle = [GUN_1, GUN_2, GUN_3];
  const called = { fleetTargetTags: new Map([[OTHER, "A"]]), lockedTargetIDs: [OTHER] };

  const first = decideCompanionAction(
    request,
    obs({ ...called, snapshot: gridWithEntitiesAndRack([OTHER], stillCyclingFromTackle) }),
    firingOnTackle,
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_1, targetID: OTHER });

  const second = decideCompanionAction(
    request,
    obs({ ...called, snapshot: gridWithEntitiesAndRack([OTHER], stillCyclingFromTackle) }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "activate", moduleID: GUN_2, targetID: OTHER });

  const third = decideCompanionAction(
    request,
    obs({ ...called, snapshot: gridWithEntitiesAndRack([OTHER], stillCyclingFromTackle) }),
    second.memory,
  );
  assert.deepEqual(third.action, { kind: "activate", moduleID: GUN_3, targetID: OTHER });

  // All three re-aimed at OTHER — the rack is done, and never once did a gun
  // read as already answering the new call just because it was still cycling.
  const fourth = decideCompanionAction(
    request,
    obs({ ...called, snapshot: gridWithEntitiesAndRack([OTHER], stillCyclingFromTackle) }),
    third.memory,
  );
  assert.equal(fourth.action.kind, "wait");
  assert.match(fourth.why, /firing on it/i);
});

test("a banked SLAVE counts as already firing the moment its MASTER is seen cycling", () => {
  // ⚠ WITHOUT THIS, THE RUNG PICKS THE SAME SLAVE FOREVER. `activeModuleIDs`
  // never names a slave — see `cyclingWeapons`'s own header — so a slave
  // checked against the raw list alone never reads as firing, and because
  // this loop issues one call per tick, that one slave would starve every
  // rung beneath it.
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_SLAVE] };
  const banks: Readonly<Record<number, readonly number[]>> = { [GUN_MASTER]: [GUN_SLAVE] };
  const tagged = { fleetTargetTags: new Map([[TACKLE, "A"]]), lockedTargetIDs: [TACKLE] };

  const first = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [], banks) }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_SLAVE, targetID: TACKLE });

  // The server reports only the MASTER cycling now — activating a slave fires
  // the whole bank through it.
  const second = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_MASTER], banks) }),
    first.memory,
  );
  assert.equal(second.action.kind, "wait");
  assert.match(second.why, /firing on it/i);
});

test("an UNBANKED weapon needs its OWN id in activeModuleIDs to count as firing", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_UNBANKED] };
  const tagged = { fleetTargetTags: new Map([[TACKLE, "A"]]), lockedTargetIDs: [TACKLE] };

  const first = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], []) }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_UNBANKED, targetID: TACKLE });

  const second = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_UNBANKED]) }),
    first.memory,
  );
  assert.equal(second.action.kind, "wait");
  assert.match(second.why, /firing on it/i);
});

test("an UNREADABLE activeModuleIDs falls back to memory alone, advancing the rack without re-firing it", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1, GUN_2] };
  const tagged = { fleetTargetTags: new Map([[TACKLE, "A"]]), lockedTargetIDs: [TACKLE] };

  const first = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], null) }),
  );
  assert.deepEqual(first.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });

  // Still unreadable — no authoritative read to prefer, so the memory of
  // GUN_1 alone is trusted, and GUN_2 is the one that goes up. Never GUN_1
  // again, and never the whole rack re-fired at once.
  const second = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], null) }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "activate", moduleID: GUN_2, targetID: TACKLE });

  const third = decideCompanionAction(
    request,
    obs({ ...tagged, snapshot: gridWithEntitiesAndRack([TACKLE], null) }),
    second.memory,
  );
  assert.equal(third.action.kind, "wait");
  assert.match(third.why, /firing on it/i);
});

test("a Target BROADCAST opens fire once its lock is observed, exactly as a tag does", () => {
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE], []),
      fleetTargetTags: null,
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
      lockedTargetIDs: [TACKLE],
    }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "broadcast");
});

test("a fully-firing tag still holds the tick, the same way an already-locked tag always did", () => {
  // Consistency check: `lockOrHold`'s already-locked branch always returned a
  // decision (never null) so nothing below it in `decideFleetOrders` was ever
  // reached that same tick. `lockThenEngage`'s fully-firing branch does the
  // same — a pending AlignTo broadcast here must NOT be answered instead.
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastFireTargetID: TACKLE,
    lastFireModuleIDs: [GUN_1],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE, LOGI], [GUN_1]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
      fleetBroadcast: fleetBroadcast("AlignTo", LOGI),
    }),
    memory,
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Obeying fleet");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.match(decision.why, /firing on it/i);
});

test("a satisfied Heal call falls through to the tag; a satisfied rack does not fall through any further", () => {
  // decideHealOrder's null and lockThenEngage's fully-firing WAIT are the SAME
  // "nothing NEW to start" answer, told two different ways for two different
  // reasons — see `decideHealOrder`'s own header on why heal falls through
  // (it does not compete with locking for the ship's state) versus why a tag
  // holds the tick outright (there is nothing lower-priority within
  // `decideFleetOrders` that a satisfied tag should yield to).
  const request: FleetCompanionRequest = {
    ...REQUEST,
    remoteShieldModuleIDs: [SHIELD_MODULE],
    weaponModuleIDs: [GUN_1],
  };
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastHealTargetID: ALLY,
    lastHealModuleIDs: [SHIELD_MODULE],
    lastFireTargetID: TACKLE,
    lastFireModuleIDs: [GUN_1],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE, ALLY], [SHIELD_MODULE, GUN_1]),
      fleetTargetTags: new Map([[TACKLE, "A"]]),
      lockedTargetIDs: [TACKLE],
      fleetBroadcast: fleetBroadcast("HealShield", ALLY),
    }),
    memory,
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.match(decision.why, /firing on it/i);
});

// --- rung 5: TravelTo ---------------------------------------------------------

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

// --- rung 5: JumpTo (honest partial) ------------------------------------------
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

// --- rung 5: chat commands ----------------------------------------------------
//
// A chat order reaches the SAME c-f branches a broadcast does, through
// `resolveNamedOrder` — see that function's own header and `decideFleetOrders`'s
// "c-f" comment. These tests exercise that shared path from the chat side: the
// sender gate (the whole security property of the feature), precedence against
// a broadcast, newest-wins, and each verb actually reaching its rung. They do
// NOT retest the parser's own grammar (link shape, verb aliases, truncation) —
// `chatCommands.test.ts` already owns that.

/** A character NOT on any request's `chatCommandSenders` in this section. */
const UNLISTED_SENDER = 90000006;

/** One chat line, addressed to whichever character id the test names. */
function chatLine(message: string, characterID: number, createdAtMs = 1_000): ChatMessage {
  return { characterID, characterName: "Fleet Mate", message, createdAtMs };
}

/** A well-formed chat-command line: a recognised verb plus a showinfo link
 *  naming `itemID` — see `chatCommands.ts`'s own header for the link format.
 *  The TYPEID (670 here) is never read back; any digits parse. */
function chatCommandText(verb: string, itemID: number): string {
  return verb + " <url=showinfo:670//" + itemID + ">Some Ship</url>";
}

/** As `gridWithGate`, but the ship reads FOLLOW — what `isFollowing` requires
 *  for `decideCloseIn`'s "closing" step (an approach already under way). */
function gridWithGateFollowing(distanceM: number): SpaceSnapshot {
  return {
    inSpace: true,
    ship: { position: { x: 0, y: 0, z: 0 }, radius: 0, mode: "FOLLOW" },
    entities: [
      { itemID: 1, kind: "ship", isSelf: true, position: { x: 0, y: 0, z: 0 }, radius: 0, mode: null },
      { itemID: GATE, kind: "stargate", isSelf: false, position: { x: distanceM, y: 0, z: 0 }, radius: 0, mode: null },
    ],
  } as unknown as SpaceSnapshot;
}

test("a chat 'target <link>' from an ALLOWED sender locks the named ship, then fires once the lock is observed", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
    weaponModuleIDs: [GUN_1],
  };
  const chatMessages = [chatLine(chatCommandText("target", TACKLE), HUMAN)];

  const locking = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntitiesAndRack([TACKLE]), chatMessages }),
  );
  assert.deepEqual(locking.action, { kind: "lock", targetID: TACKLE });
  assert.equal(locking.followingOrderFrom, "chat");

  // Same reachable path a broadcast target takes: lock, observe, then fire.
  const firing = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntitiesAndRack([TACKLE], []),
      chatMessages,
      lockedTargetIDs: [TACKLE],
    }),
    locking.memory,
  );
  assert.deepEqual(firing.action, { kind: "activate", moduleID: GUN_1, targetID: TACKLE });
  assert.equal(firing.followingOrderFrom, "chat");
});

test("THE SENDER GATE: a chat command from someone NOT in chatCommandSenders does nothing at all", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      chatMessages: [chatLine(chatCommandText("target", TACKLE), UNLISTED_SENDER)],
    }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.equal(decision.phase, "Standing by");
});

test("THE SENDER GATE: an EMPTY chatCommandSenders, the shipped default, obeys nobody over chat", () => {
  // ⚠ Not even the fleet's own supervising human. Nobody is authorised until
  // the operator says so on the request — see `chatCommandSenders`'s own
  // comment: "NEVER POPULATED FROM CHAT TEXT".
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
  };
  assert.deepEqual(request.chatCommandSenders, []);
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      chatMessages: [chatLine(chatCommandText("target", TACKLE), HUMAN)],
    }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.equal(decision.phase, "Standing by");
});

test("obeys without \"chat\" ignores a chat command even from an allowed sender", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag"],
    chatCommandSenders: [HUMAN],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      chatMessages: [chatLine(chatCommandText("target", TACKLE), HUMAN)],
    }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.equal(decision.phase, "Standing by");
});

test("A BROADCAST OUTRANKS A CHAT LINE when they disagree, and chat is obeyed once the broadcast is gone", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const chatMessages = [chatLine(chatCommandText("target", OTHER), HUMAN)];

  const withBroadcast = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([TACKLE, OTHER]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
      chatMessages,
    }),
  );
  assert.deepEqual(withBroadcast.action, { kind: "lock", targetID: TACKLE });
  assert.equal(withBroadcast.followingOrderFrom, "broadcast");

  const withoutBroadcast = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntities([TACKLE, OTHER]), chatMessages }),
  );
  assert.deepEqual(withoutBroadcast.action, { kind: "lock", targetID: OTHER });
  assert.equal(withoutBroadcast.followingOrderFrom, "chat");
});

test("an OFF-GRID broadcast falls through to a chat order instead of starving it", () => {
  // ⚠ THE REGRESSION THIS PINS IS A BUG THE RUNG'S OWN HEADER FORBADE. It has
  // always said a call for something not on this grid is skipped "falling
  // through to the NEXT SOURCE" — which was trivially satisfied while a
  // broadcast was the only source that could be unactionable, because the only
  // thing under it was "Standing by". Once chat became a real next source, a
  // resolver that picked the broadcast FIRST and only then discovered it was
  // off-grid stopped falling through to anything: the pilot stood by with an
  // actionable, allowed-sender chat order sitting right there. Choosing the
  // source and testing whether it can be acted on have to be the same step.
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      // OTHER is here to be shot; the broadcast names something that is not.
      snapshot: gridWithEntities([OTHER]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
      chatMessages: [chatLine(chatCommandText("target", OTHER), HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: OTHER });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("an off-grid broadcast with NO chat order to fall through to still just stands by", () => {
  // The other half of the same rule, and the one that proves the fix did not
  // simply start obeying off-grid calls: with nothing underneath to fall
  // through TO, an unactionable call is still no order for this pilot.
  const decision = decideCompanionAction(
    { ...REQUEST, obeys: ["broadcast", "tag", "chat"], chatCommandSenders: [HUMAN] },
    obs({
      snapshot: gridWithEntities([OTHER]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
      chatMessages: [],
    }),
  );
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.notEqual(decision.followingOrderFrom, "broadcast");
});

test("NEWEST WINS: the later createdAtMs is obeyed, regardless of which order the lines arrive in", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const older = chatLine(chatCommandText("target", TACKLE), HUMAN, 1_000);
  const newer = chatLine(chatCommandText("target", OTHER), HUMAN, 5_000);

  const olderFirst = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntities([TACKLE, OTHER]), chatMessages: [older, newer] }),
  );
  assert.deepEqual(olderFirst.action, { kind: "lock", targetID: OTHER });

  const newerFirst = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntities([TACKLE, OTHER]), chatMessages: [newer, older] }),
  );
  assert.deepEqual(newerFirst.action, { kind: "lock", targetID: OTHER });
});

test("a non-command chat line from an allowed sender is ignored, and does NOT suppress an older real command", () => {
  // ⚠ PINNED FROM THE CODE, NOT ASSUMED. `newestChatOrder` only ever compares
  // lines that PARSE against each other — a message that fails
  // `parseChatCommand` hits `continue` before it ever touches `best`, in the
  // same loop iteration a disallowed sender's line does. So ordinary chatter
  // typed after a real order never erases it; the order stands until a NEWER
  // command replaces it, exactly as a broadcast is only replaced by another
  // broadcast, never by silence.
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const order = chatLine(chatCommandText("target", TACKLE), HUMAN, 1_000);
  const chatter = chatLine("nice kill on that last one", HUMAN, 5_000);
  const decision = decideCompanionAction(
    request,
    obs({ snapshot: gridWithEntities([TACKLE]), chatMessages: [order, chatter] }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("a chat 'align <link>' reaches the align rung", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([LOGI]),
      chatMessages: [chatLine(chatCommandText("align", LOGI), HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "align", targetID: LOGI });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("a chat 'travel <link>' reaches the travelTo rung", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([]),
      chatMessages: [chatLine(chatCommandText("travel", SYSTEM_B), HUMAN)],
    }),
  );
  assert.deepEqual(decision.action, { kind: "travelTo", systemID: SYSTEM_B });
  assert.equal(decision.followingOrderFrom, "chat");
});

test("a chat 'jump <link>' reaches the JumpTo honest partial, through all four decideCloseIn steps", () => {
  // ⚠ FOUR STEP KINDS, ALL FOUR MUST STILL WORK FROM CHAT: arrive, closing,
  // approach, and the warp fallthrough. The broadcast tests above this section
  // never exercised "closing" at all (it needs the ship reading FOLLOW, not
  // merely a distance) — `gridWithGateFollowing` supplies that.
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const chatMessages = [chatLine(chatCommandText("jump", GATE), HUMAN)];

  // warp — far enough that the server will take the warp.
  const warping = decideCompanionAction(request, obs({ snapshot: gridWithGate(200_000), chatMessages }));
  assert.deepEqual(warping.action, { kind: "warp", targetID: GATE });
  assert.equal(warping.followingOrderFrom, "chat");

  // approach — too close for the server to accept a warp, nothing closing yet.
  const approaching = decideCompanionAction(
    request,
    obs({ snapshot: gridWithGate(50_000), chatMessages }),
  );
  assert.deepEqual(approaching.action, { kind: "approach", targetID: GATE });
  assert.equal(approaching.memory.closingOn, GATE);
  assert.equal(approaching.followingOrderFrom, "chat");

  // closing — this pilot's own approach is already running on this gate.
  const closing = decideCompanionAction(
    request,
    obs({ snapshot: gridWithGateFollowing(50_000), chatMessages }),
    approaching.memory,
  );
  assert.equal(closing.action.kind, "wait");
  assert.match(closing.why, /closing on it/i);
  assert.equal(closing.followingOrderFrom, "chat");

  // arrive — at jump range: holds, never invents a second gate id.
  const arrived = decideCompanionAction(request, obs({ snapshot: gridWithGate(1_000), chatMessages }));
  assert.equal(arrived.action.kind, "wait");
  assert.match(arrived.why, /holding here/i);
  assert.equal(arrived.followingOrderFrom, "chat");
});

test("lastOrderHeard and the why sentence name CHAT, not the fleet, when the order came from chat", () => {
  // A player reading the panel must be able to tell "the fleet called this"
  // from "somebody typed this" — see `NamedOrder`'s own comment.
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([LOGI]),
      chatMessages: [chatLine(chatCommandText("align", LOGI), HUMAN)],
    }),
  );
  assert.equal(decision.followingOrderFrom, "chat");
  assert.match(decision.lastOrderHeard ?? "", /chat/i);
  assert.match(decision.why, /chat/i);
  assert.doesNotMatch(decision.lastOrderHeard ?? "", /the fleet/i);
  assert.doesNotMatch(decision.why, /the fleet broadcast/i);
});

test("chat orders are ALSO skipped once the supervision gate has failed", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    obeys: ["broadcast", "tag", "chat"],
    chatCommandSenders: [HUMAN],
  };
  const decision = decideCompanionAction(
    request,
    alone({
      snapshot: gridWithEntities([TACKLE]),
      chatMessages: [chatLine(chatCommandText("target", TACKLE), HUMAN)],
    }),
  );
  assert.notEqual(decision.action.kind, "lock");
  assert.notEqual(decision.phase, "Obeying fleet");
});

// --- rung 5: everything above is skipped once abandonment starts -------------

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

// --- rung 3: tank up -----------------------------------------
//
// Above obeying the fleet, below the supervision gate -- see `decideTankUp`'s
// own header in fleetCompanionLoop.ts for the full ladder: a fitted hardener
// while a fight is on, then each layer's own repairer (on while hurt, inverted
// off below the capacitor floor), then the fight-end stand-down.
//
/** Synthetic module item ids for the tank-up rung, distinct from every id used above. */
const HARDENER_1 = 11400001;
const HARDENER_2 = 11400002;
const SHIELD_BOOSTER = 11400003;
const ARMOR_REPAIRER = 11400004;
const HULL_REPAIRER = 11400005;

/** A whole, unhurt ship with a full capacitor and no fight -- what every tank-up test overrides from. */
function tankObs(overrides: Partial<FleetCompanionObservation> = {}): FleetCompanionObservation {
  return obs({
    shieldRatio: 1,
    armorRatio: 1,
    hullRatio: 1,
    capacitorRatio: 1,
    hostileOnGrid: null,
    targetedByPlayer: null,
    snapshot: gridWithShipsAndActive([], []),
    ...overrides,
  });
}

test("a fitted hardener switches on, self-targeted, while hostiles are on this grid", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1] };
  const decision = decideCompanionAction(request, tankObs({ hostileOnGrid: true }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_1, targetID: 0 });
  assert.equal(decision.phase, "Tanking up");
});

test("targetedByPlayer ALONE is enough to light a hardener, with hostileOnGrid unreadable", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1] };
  const decision = decideCompanionAction(
    request,
    tankObs({ hostileOnGrid: null, targetedByPlayer: true }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_1, targetID: 0 });
});

test("an already-active hardener is skipped in favor of the next idle one", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1, HARDENER_2] };
  const decision = decideCompanionAction(
    request,
    tankObs({ hostileOnGrid: true, snapshot: gridWithShipsAndActive([], [HARDENER_1]) }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_2, targetID: 0 });
});

test("only ONE hardener switches on per tick, even with several idle at once", () => {
  const request: FleetCompanionRequest = { ...REQUEST, defenseModuleIDs: [HARDENER_1, HARDENER_2] };
  const decision = decideCompanionAction(request, tankObs({ hostileOnGrid: true }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HARDENER_1, targetID: 0 });
});

// --- EACH LAYER USES ITS OWN LIST AND NEVER ANOTHER'S -------------------------

test("a hurt SHIELD starts its own shield booster", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    shieldBoosterModuleIDs: [SHIELD_BOOSTER],
    armorRepairerModuleIDs: [ARMOR_REPAIRER],
    hullRepairerModuleIDs: [HULL_REPAIRER],
  };
  const decision = decideCompanionAction(request, tankObs({ shieldRatio: 0.5 }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: SHIELD_BOOSTER, targetID: 0 });
  assert.match(decision.why, /shield/i);
});

test("a hurt ARMOUR starts its own armour repairer, NEVER the shield booster", () => {
  // A shield booster cannot repair armour -- crossing families is the exact bug
  // this per-layer list shape exists to prevent. Both lists are fitted here so a
  // bug that reached across families would have something to reach for.
  const request: FleetCompanionRequest = {
    ...REQUEST,
    shieldBoosterModuleIDs: [SHIELD_BOOSTER],
    armorRepairerModuleIDs: [ARMOR_REPAIRER],
    hullRepairerModuleIDs: [HULL_REPAIRER],
  };
  const decision = decideCompanionAction(request, tankObs({ armorRatio: 0.5 }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_REPAIRER, targetID: 0 });
  assert.match(decision.why, /armor/i);
});

test("a hurt HULL starts its own hull repairer, never a shield or armour repairer", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    shieldBoosterModuleIDs: [SHIELD_BOOSTER],
    armorRepairerModuleIDs: [ARMOR_REPAIRER],
    hullRepairerModuleIDs: [HULL_REPAIRER],
  };
  const decision = decideCompanionAction(request, tankObs({ hullRatio: 0.5 }));
  assert.deepEqual(decision.action, { kind: "activate", moduleID: HULL_REPAIRER, targetID: 0 });
  assert.match(decision.why, /hull/i);
});

// --- THE CAPACITOR FLOOR INVERTS THE RUNG --------------------------------------

test("below the capacitor floor, a RUNNING repairer switches OFF even though the layer is still hurt", () => {
  const request: FleetCompanionRequest = {
    ...REQUEST,
    armorRepairerModuleIDs: [ARMOR_REPAIRER],
    capacitorFloor: 0.2,
  };
  const decision = decideCompanionAction(
    request,
    tankObs({
      armorRatio: 0.5,
      capacitorRatio: 0.1,
      snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]),
    }),
  );
  assert.deepEqual(decision.action, { kind: "deactivate", moduleID: ARMOR_REPAIRER });
  assert.match(decision.why, /capacitor/i);
});

test("an UNREADABLE capacitor fails OPEN toward repairing -- it starts the cycle", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const decision = decideCompanionAction(
    request,
    tankObs({ armorRatio: 0.5, capacitorRatio: null }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_REPAIRER, targetID: 0 });
});

// --- THE RECOVERED OFF-HALF ----------------------------------------------------

test("a layer that heals back to the threshold switches its running repairer off, saying the layer is whole -- not the capacitor sentence", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const decision = decideCompanionAction(
    request,
    tankObs({
      armorRatio: TANK_LAYER_HURT_THRESHOLD,
      capacitorRatio: 1,
      snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]),
    }),
  );
  assert.deepEqual(decision.action, { kind: "deactivate", moduleID: ARMOR_REPAIRER });
  assert.match(decision.why, /whole/i);
  assert.doesNotMatch(decision.why, /capacitor/i);
});

// --- an unreadable layer ratio is undecidable, not "not hurt" -----------------

test("an UNREADABLE layer ratio neither starts nor stops a cycle", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };

  // Idle, and unreadable: must not start.
  const idle = decideCompanionAction(
    request,
    tankObs({ armorRatio: null, snapshot: gridWithShipsAndActive([], []) }),
  );
  assert.notEqual(idle.phase, "Tanking up");

  // Running, and unreadable: must not stop either.
  const running = decideCompanionAction(
    request,
    tankObs({ armorRatio: null, snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]) }),
  );
  assert.notEqual(running.phase, "Tanking up");
  assert.notEqual(running.phase, "Standing down");
});

// --- STAND-DOWN NEVER FIRES ON A BLIND READ ------------------------------------

test("hostileOnGrid === false stands down ONE cycling module per tick, from the record", () => {
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastTankUpModuleIDs: [HARDENER_1, ARMOR_REPAIRER],
  };
  const decision = decideCompanionAction(
    REQUEST,
    tankObs({ hostileOnGrid: false, snapshot: gridWithShipsAndActive([], [HARDENER_1, ARMOR_REPAIRER]) }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "deactivate", moduleID: HARDENER_1 });
  assert.equal(decision.phase, "Standing down");
  assert.deepEqual(decision.memory.lastTankUpModuleIDs, [ARMOR_REPAIRER]);
});

test("hostileOnGrid === false skips a record entry that already stopped cycling on its own", () => {
  const memory: CompanionLadderMemory = {
    ...freshLadderMemory(),
    lastTankUpModuleIDs: [HARDENER_1, ARMOR_REPAIRER],
  };
  const decision = decideCompanionAction(
    REQUEST,
    // HARDENER_1 is no longer active -- only ARMOR_REPAIRER is still cycling.
    tankObs({ hostileOnGrid: false, snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]) }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "deactivate", moduleID: ARMOR_REPAIRER });
  assert.deepEqual(decision.memory.lastTankUpModuleIDs, [HARDENER_1]);
});

test("hostileOnGrid === null keeps the tank UP -- stand-down never fires on a blind read", () => {
  const memory: CompanionLadderMemory = { ...freshLadderMemory(), lastTankUpModuleIDs: [HARDENER_1] };
  const decision = decideCompanionAction(
    REQUEST,
    tankObs({ hostileOnGrid: null, snapshot: gridWithShipsAndActive([], [HARDENER_1]) }),
    memory,
  );
  assert.notEqual(decision.phase, "Standing down");
  assert.deepEqual(decision.memory.lastTankUpModuleIDs, [HARDENER_1]);
});

test("the stand-down clears its record once everything it lit is off, issuing NO action that tick", () => {
  const memory: CompanionLadderMemory = { ...freshLadderMemory(), lastTankUpModuleIDs: [HARDENER_1] };
  const decision = decideCompanionAction(
    REQUEST,
    // Nothing in the record is cycling any more -- ended on its own, or already
    // switched off over the last few ticks.
    tankObs({ hostileOnGrid: false, snapshot: gridWithShipsAndActive([], []) }),
    memory,
  );
  assert.equal(decision.action.kind, "wait");
  assert.equal(decision.phase, "Standing by");
  assert.deepEqual(decision.memory.lastTankUpModuleIDs, []);
});

// --- RUNG ORDER: the tank goes up before the fleet is obeyed -------------------

test("with both a hurt tank and a live fleet target call, the tank goes up FIRST", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const decision = decideCompanionAction(
    request,
    tankObs({
      armorRatio: 0.5,
      snapshot: gridWithEntities([TACKLE]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(decision.action, { kind: "activate", moduleID: ARMOR_REPAIRER, targetID: 0 });
  assert.equal(decision.phase, "Tanking up");
});

test("once the rack is up and nothing is hurt, the rung falls through and the fleet order is obeyed on that same tick", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const decision = decideCompanionAction(
    request,
    tankObs({
      snapshot: gridWithEntities([TACKLE]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.equal(decision.phase, "Obeying fleet");
});

// --- the shipped default (empty module lists) is unaffected --------------------

test("a pilot with EMPTY module lists is completely unaffected -- the rung falls through every tick", () => {
  // The shipped default: DEFAULT_FLEET_COMPANION_REQUEST's four tank-up lists are
  // all empty. Even a fight on every layer at once must not touch this rung, or
  // the existing 96 tests -- none of which set a module list -- would break.
  const decision = decideCompanionAction(
    REQUEST,
    tankObs({
      hostileOnGrid: true,
      targetedByPlayer: true,
      shieldRatio: 0.1,
      armorRatio: 0.1,
      hullRatio: 0.1,
      capacitorRatio: 0.1,
    }),
  );
  assert.notEqual(decision.phase, "Tanking up");
  assert.notEqual(decision.phase, "Standing down");
  assert.equal(decision.phase, "Standing by");
});

// --- the stand-down record states what is held ON right now --------------------

test("switching a repairer off -- for either reason -- drops it from the stand-down record", () => {
  const request: FleetCompanionRequest = { ...REQUEST, armorRepairerModuleIDs: [ARMOR_REPAIRER] };
  const memory: CompanionLadderMemory = { ...freshLadderMemory(), lastTankUpModuleIDs: [ARMOR_REPAIRER] };

  const recovered = decideCompanionAction(
    request,
    tankObs({ snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]) }),
    memory,
  );
  assert.equal(recovered.action.kind, "deactivate");
  assert.deepEqual(recovered.memory.lastTankUpModuleIDs, []);

  const capFloored = decideCompanionAction(
    request,
    tankObs({
      armorRatio: 0.5,
      capacitorRatio: 0.1,
      snapshot: gridWithShipsAndActive([], [ARMOR_REPAIRER]),
    }),
    memory,
  );
  assert.equal(capFloored.action.kind, "deactivate");
  assert.deepEqual(capFloored.memory.lastTankUpModuleIDs, []);
});

// --- the player-facing surface ----------------------------------------------

test("no player-facing string in this module carries a decorative non-ASCII character", () => {
  // ⚠ THIS SCANS THE SOURCE, NOT THE LADDER'S OUTPUT, ON PURPOSE. The panel
  // suite already has an ASCII check, but it renders against hand-written
  // fixture stores -- so it proves the FIXTURES are clean and never sees a
  // single `why` this ladder actually produces. Eight real strings slipped
  // past it that way, including the warp-yield line that fires on essentially
  // every fleet warp.
  //
  // Code COMMENTS are exempt and this file uses non-ASCII in them freely, so
  // they are stripped before the scan. Only string literals are judged.
  const source = readFileSync(new URL("./fleetCompanionLoop.ts", import.meta.url), "utf8");
  const blockComment = new RegExp("/\\*[\\s\\S]*?\\*/", "g");
  const code = source
    .replace(blockComment, "")
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("//");
      return comment < 0 ? line : line.slice(0, comment);
    })
    .join("\n");

  // ⚠ TEMPLATE LITERALS ARE SCANNED TOO, AND THEY WERE NOT UNTIL PHASE 5.
  // This swept double-quoted literals only. That was complete when it was
  // written -- every `why` in the file was a plain string -- and phase 7's tag
  // messages were the first to interpolate, so they were the first player-facing
  // strings this guard could not see. They happened to be clean; the guard was
  // blind to them either way, and a rung that reports a drone count or a
  // hold-off has every reason to interpolate. Backticked strings are now swept
  // on the same terms. The `${...}` holes are blanked first: what a hole
  // interpolates is a value, judged where it is built, not text this file wrote.
  const doubleQuoted = new RegExp('"((?:[^"\\\\\\n]|\\\\.)*)"', "g");
  const backticked = new RegExp("`((?:[^`\\\\]|\\\\.)*)`", "g");
  const offenders: string[] = [];
  const judge = (value: string): void => {
    const withoutHoles = value.replace(/\$\{[^}]*\}/g, "");
    if ([...withoutHoles].some((character) => (character.codePointAt(0) ?? 0) > 127)) {
      offenders.push(withoutHoles);
    }
  };
  for (const match of code.matchAll(doubleQuoted)) {
    judge(match[1] ?? "");
  }
  for (const match of code.matchAll(backticked)) {
    judge(match[1] ?? "");
  }
  assert.deepEqual(
    offenders,
    [],
    "player-facing strings must be plain ASCII; an em-dash is the usual culprit",
  );
});

test("nothing this ladder says about a NOT-YET-LOCKED Target call claims the pilot is shooting", () => {
  // ⚠ LOCK, OBSERVE, THEN FIRE — see `lockThenEngage`'s own header. On the
  // tick that ISSUES the lock, nothing has fired yet no matter what this
  // pilot has fitted, so the readout must not claim otherwise. A weapon IS
  // fitted here on purpose — this pins the ordering, not merely the case
  // where there is nothing to fire in the first place.
  const request: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };
  const decision = decideCompanionAction(
    request,
    obs({
      snapshot: gridWithEntities([TACKLE]),
      fleetBroadcast: fleetBroadcast("Target", TACKLE),
    }),
  );
  assert.equal(decision.action.kind, "lock");
  const said = `${decision.why} ${decision.lastOrderHeard ?? ""}`;
  assert.doesNotMatch(said, /shoot|shooting|fir(e|ing)|attack/i, said);
});

// --- rung 4: tackle -> tag ---------------------------------------------------
//
// ABOVE obeying the fleet, because that rung PARKS the tick once a called
// target is locked and a standing FC primary is exactly the situation this
// pilot is scrambled in. Reads `attemptsTagging`, which until this rung existed
// was a panel checkbox nothing consulted. Writes a LETTER, never a digit, so it
// can never collide with the DSL block that writes "1".

/** A request that tags, with the supervision default left alone. */
const TAGGING: FleetCompanionRequest = { ...REQUEST, attemptsTagging: true };

/** The commander verdict the gate produces for a real fleet boss. */
function taggingObs(
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return obs({
    snapshot: gridWithEntities([TACKLE]),
    canTag: true,
    fleetTargetTags: new Map(),
    tackledBy: [TACKLE],
    ...overrides,
  });
}

test("a ship that has this pilot scrambled is lettered for the fleet", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs());
  assert.deepEqual(decision.action, {
    kind: "setFleetTargetTag",
    targetID: TACKLE,
    tag: "A",
  });
  assert.equal(decision.phase, "Tagging");
});

// ⚠ THE DEAD-CONFIG TEST. `attemptsTagging` shipped with a panel checkbox and
// no reader at all; this is the assertion that it is wired to something.
test("attemptsTagging OFF writes no tag, however tackled the pilot is", () => {
  const decision = decideCompanionAction(REQUEST, taggingObs());
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
  assert.equal(REQUEST.attemptsTagging, false, "the default must stay off");
});

// ⚠ THREE STATES. `null` is "could not read the roster", `false` is "read it,
// and this pilot is not a commander". Both forbid the write, and NEITHER is
// remembered: the server drops a non-commander's tag silently, so a client that
// cached a transient `null` as "no" would stop tagging for the rest of the run
// with nothing anywhere to say why.
test("canTag null and canTag false both write nothing", () => {
  for (const canTag of [null, false] as const) {
    const decision = decideCompanionAction(TAGGING, taggingObs({ canTag }));
    assert.notEqual(decision.action.kind, "setFleetTargetTag", String(canTag));
  }
});

test("a pilot nothing is holding writes nothing", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs({ tackledBy: [] }));
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// ⚠ A tag is unique FLEET-WIDE: the server deletes any other item holding the
// same letter before it sets one. Writing without knowing which letters are
// taken would steal the FC's own mark.
test("an unreadable tag dict writes nothing, even for a commander that is tackled", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs({ fleetTargetTags: null }));
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// The other half of that contract: an EMPTY map is a real answer - "the fleet
// has tagged nothing" - and it is the commonest case at the start of a fight.
test("an EMPTY tag dict is a real answer and does write", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ fleetTargetTags: new Map() }),
  );
  assert.equal(decision.action.kind, "setFleetTargetTag");
});

test("a tackler that is not on this grid is not lettered", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ snapshot: gridWithEntities([OTHER]), tackledBy: [TACKLE] }),
  );
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// The rule that keeps the fleet's letters stable: a ship that is B stays B.
test("a tackler that already carries a tag is left alone", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ fleetTargetTags: new Map([[TACKLE, "B"]]) }),
  );
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

test("the first FREE menu letter is used, skipping the ones the fleet already holds", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ fleetTargetTags: new Map([[OTHER, "A"], [LOGI, "B"]]) }),
  );
  assert.deepEqual(decision.action, {
    kind: "setFleetTargetTag",
    targetID: TACKLE,
    tag: "C",
  });
});

// ⚠ The server normalizes a tag by TRIMMING it and nothing else, so "a" and "A"
// are two keys to its uniqueness sweep and one letter to every human reading
// the overview. Writing "A" over somebody's "a" would steal their ship.
test("a lower-case tag already in use still blocks its letter", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ fleetTargetTags: new Map([[OTHER, " a "]]) }),
  );
  assert.deepEqual(decision.action, {
    kind: "setFleetTargetTag",
    targetID: TACKLE,
    tag: "B",
  });
});

// ⚠ NEVER A DIGIT. The stock menu offers 0-9 as well, and the DSL's own
// fleet-tag-target block writes "1". Staying on letters is what stops a squad
// running both from fighting over one tag.
test("every letter taken writes nothing rather than stealing one", () => {
  const taken = new Map<number, string>();
  for (const [index, letter] of [..."ABCDEFGHIJXYZ"].entries()) {
    taken.set(500000 + index, letter);
  }
  const decision = decideCompanionAction(TAGGING, taggingObs({ fleetTargetTags: taken }));
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// ⚠ THE PLAYER-TACKLER CASE, AND THE WHOLE REASON THIS RUNG DOES NOT FILTER
// THROUGH `hostileRows`. That helper is `isHostile`, which is NPC-or-not, so a
// player holding this ship fails it - and a fleet fight against players is
// precisely what this feature is for. gridWithEntities builds plain ships with
// no `isNpc` flag at all, which is the shape a player row has.
test("a PLAYER tackler is lettered, not silently skipped for not being an NPC", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs());
  assert.equal(decision.action.kind, "setFleetTargetTag");
});

test("with two tacklers the nearer is lettered first, then the other", () => {
  // gridWithEntities puts the first id closest.
  const first = decideCompanionAction(
    TAGGING,
    taggingObs({ snapshot: gridWithEntities([TACKLE, OTHER]), tackledBy: [OTHER, TACKLE] }),
  );
  assert.deepEqual(first.action, { kind: "setFleetTargetTag", targetID: TACKLE, tag: "A" });

  // Once the first one carries its letter, the next tick moves to the other.
  const second = decideCompanionAction(
    TAGGING,
    taggingObs({
      snapshot: gridWithEntities([TACKLE, OTHER]),
      tackledBy: [OTHER, TACKLE],
      fleetTargetTags: new Map([[TACKLE, "A"]]),
    }),
    first.memory,
  );
  assert.deepEqual(second.action, { kind: "setFleetTargetTag", targetID: OTHER, tag: "B" });
});

// ⚠ THE WRITE'S OWN ACK IS WORTHLESS - the server refuses a non-commander with
// a bare false that its only caller discards - so the rung resends while it
// waits for the letter to appear, and STOPS after a bounded number of tries.
test("an unconfirmed tag is retried, then given up on", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const writes: number[] = [];
  for (let tick = 0; tick < 5; tick += 1) {
    const decision = decideCompanionAction(TAGGING, taggingObs(), memory);
    memory = decision.memory;
    if (decision.action.kind === "setFleetTargetTag") {
      writes.push(decision.action.targetID);
    }
  }
  assert.equal(writes.length, 3, "three attempts, then it stops resending for ever");
});

// ⚠ GIVE-UP IS REMEMBERED PER SHIP, and this is why the rung threads its memory
// back on a tick that issues NOTHING. A single "stop tagging" flag would work
// here and fail the moment a second tackler arrived.
test("giving up on one ship does not stop the next tackler being lettered", () => {
  let memory: CompanionLadderMemory = freshLadderMemory();
  const grid = gridWithEntities([TACKLE, OTHER]);
  // Burn the budget on TACKLE alone.
  for (let tick = 0; tick < 4; tick += 1) {
    memory = decideCompanionAction(
      TAGGING,
      taggingObs({ snapshot: grid, tackledBy: [TACKLE] }),
      memory,
    ).memory;
  }
  // Now a second ship joins in. It must still get a letter.
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({ snapshot: grid, tackledBy: [TACKLE, OTHER] }),
    memory,
  );
  assert.deepEqual(decision.action, { kind: "setFleetTargetTag", targetID: OTHER, tag: "A" });
});

// ⚠ PLACEMENT. decideFleetOrders parks the tick once a called target is locked,
// so a tag rung beneath it would be starved in every fight that has a primary
// called - which is every fight this rung exists for.
test("a standing fleet tag order does not starve the tackle rung", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({
      snapshot: gridWithEntities([LOGI, TACKLE]),
      // The FC has already called LOGI, so rung 5 has work and would park.
      fleetTargetTags: new Map([[LOGI, "A"]]),
      lockedTargetIDs: [LOGI],
      tackledBy: [TACKLE],
    }),
  );
  assert.deepEqual(decision.action, { kind: "setFleetTargetTag", targetID: TACKLE, tag: "B" });
});

// ...and the cost of that placement is bounded: once there is nothing left to
// tag, the very next tick obeys the fleet again.
test("with nothing left to tag the pilot goes back to obeying the fleet", () => {
  const decision = decideCompanionAction(
    TAGGING,
    taggingObs({
      snapshot: gridWithEntities([LOGI, TACKLE]),
      fleetTargetTags: new Map([[LOGI, "A"], [TACKLE, "B"]]),
      tackledBy: [TACKLE],
    }),
  );
  assert.equal(decision.phase, "Obeying fleet");
});

// Rung 1 outranks everything, this rung included.
test("nothing is tagged mid-warp", () => {
  const decision = decideCompanionAction(TAGGING, taggingObs({ inWarp: true }));
  assert.deepEqual(decision.action, { kind: "wait" });
});

// Rung 2 too: an unsupervised pilot is getting safe, not fighting.
test("an unsupervised pilot tags nothing", () => {
  const decision = decideCompanionAction(
    TAGGING,
    alone({
      snapshot: gridWithEntities([TACKLE]),
      canTag: true,
      fleetTargetTags: new Map(),
      tackledBy: [TACKLE],
    }),
  );
  assert.notEqual(decision.action.kind, "setFleetTargetTag");
});

// --- the parking fix: a standing order no longer ends the tick ---------------
//
// `lockThenEngage`'s last branch used to return an ordinary wait once the called
// target was locked and the guns were running. That ended the ladder, so while a
// target call stood every rung BELOW the fleet-order rung was starved - which is
// exactly when they most want a turn. A pilot obeying a target call would never
// have fled.
//
// It now hands back a `standing` decision instead: the ladder holds it aside,
// runs everything beneath it, and falls back to it only if nothing else acted.
//
// ⚠ THE FULL PROOF OF THIS ARRIVES WITH PHASE 6. Its flee is the first rung to
// sit BENEATH the fleet-order rung, and the test that matters - "a pilot obeying
// a standing target call still flees when it drops through its floor" - can only
// be written once that rung exists. What is provable here is the mechanism: the
// decision is marked standing, the readout survives, and the ladder reaches its
// own end rather than returning from the middle.

/** A pilot with a gun fitted, which is what makes the standing case reachable. */
const ENGAGING: FleetCompanionRequest = { ...REQUEST, weaponModuleIDs: [GUN_1] };

/** A pilot locked onto, and shooting, the target the fleet called. */
function standingEngagement(
  overrides: Partial<FleetCompanionObservation> = {},
): FleetCompanionObservation {
  return obs({
    snapshot: gridWithEntitiesAndRack([TACKLE], [GUN_1]),
    fleetTargetTags: new Map([[TACKLE, "A"]]),
    lockedTargetIDs: [TACKLE],
    ...overrides,
  });
}

/**
 * The tick AFTER the rack is running. A snapshot says a gun is cycling and
 * never says what it is cycling AT, so the first tick still has a weapon to
 * start and only the next one has nothing left to issue -- which is the tick
 * the standing case is about.
 */
function afterTheGunsAreUp(): CompanionDecision {
  const first = decideCompanionAction(ENGAGING, standingEngagement());
  assert.equal(first.action.kind, "activate", "the first tick starts the gun");
  return decideCompanionAction(ENGAGING, standingEngagement(), first.memory);
}

test("a standing, already-engaged target call is marked standing rather than parking", () => {
  const decision = afterTheGunsAreUp();
  assert.deepEqual(decision.action, { kind: "wait" });
  assert.equal(
    decision.standing,
    true,
    "the fleet rung has nothing new to issue, so its decision must be held aside, not returned outright",
  );
});

// ⚠ THE READOUT IS WHY IT WAS PARKED IN THE FIRST PLACE, so losing it would be
// trading one bug for another. A pilot whose guns are running must not tell its
// operator it is standing by.
test("the standing readout survives the fall-through and still says Obeying fleet", () => {
  const decision = afterTheGunsAreUp();
  assert.equal(decision.phase, "Obeying fleet");
  assert.notEqual(decision.phase, "Standing by");
  assert.equal(decision.followingOrderFrom, "tag");
  assert.ok(decision.lastOrderHeard);
  assert.match(decision.why, /firing/i);
});

// ⚠ A STANDING DECISION IS A READOUT AND NOTHING ELSE. If one ever carried a
// real call, holding it aside and then falling back to it a rung later would
// issue it late - or, if a lower rung acted, drop it silently.
test("nothing that is marked standing carries a real action", () => {
  for (const observation of [
    standingEngagement(),
    standingEngagement({ fleetTargetTags: null, fleetBroadcast: fleetBroadcast("Target", TACKLE) }),
  ]) {
    const decision = decideCompanionAction(ENGAGING, observation);
    if (decision.standing === true) {
      assert.deepEqual(decision.action, { kind: "wait" });
    }
  }
});

// The other half: a rung that DOES have something to issue still wins outright,
// which is what the decided precedence says and what must not regress.
test("a fleet order with a real call to make still beats everything beneath it", () => {
  const decision = decideCompanionAction(
    ENGAGING,
    standingEngagement({ lockedTargetIDs: [] }),
  );
  assert.deepEqual(decision.action, { kind: "lock", targetID: TACKLE });
  assert.notEqual(decision.standing, true, "a real call is never merely standing");
});
