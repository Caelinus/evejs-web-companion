// Browser autopilot decide-loop (goal R5b), driven against a SIMULATED
// flight-status timeline whose fake "server" advances the way the real space
// handlers do: docked -> undock -> in space -> warp to gate -> jump (new
// system) -> warp to station -> dock (out of range: DockingApproach) ->
// re-dock -> docked. The loop must issue the right atomic call at each state,
// replicate approach-then-redock, pause on an injected refusal, and never call
// the bridge after abort/stop.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SILENT_DOCK_ATTEMPTS,
  MAX_WARP_ATTEMPTS,
  WARP_EXIT_VARIANCE_M,
  createAutopilot,
  decideAutopilotAction,
  measureSpace,
  warpFloorMeters,
  type AutopilotAction,
  type AutopilotController,
  type AutopilotDeps,
  type AutopilotProgress,
  type RoutePlan,
  type SpaceMeasurement,
} from "./autopilotLoop.ts";
import { surfaceDistanceMeters } from "../space/overview.ts";
import type { FlightStatus, SpaceEntity, SpaceSnapshot } from "../store/types.ts";

const ORIGIN_SYSTEM = 30000142;
const DEST_SYSTEM = 30000140;
const ORIGIN_STATION = 60003760;
const DEST_STATION = 60003454;
const GATE_ORIGIN = 50000802; // source gate in ORIGIN_SYSTEM (warp + jump through)
const GATE_DEST = 50001248; // gate on the DEST_SYSTEM side (CmdStargateJump toGate)
const SHIP_ID = 9001;

const PLAN: RoutePlan = {
  destinationSystemID: DEST_SYSTEM,
  destinationStationID: DEST_STATION,
  destinationName: "Destination Station",
  hops: [
    {
      fromSystemID: ORIGIN_SYSTEM,
      toSystemID: DEST_SYSTEM,
      gateToWarpID: GATE_ORIGIN,
      jumpToGateID: GATE_DEST,
    },
  ],
};

interface Call {
  readonly m: "undock" | "warp" | "approach" | "jump" | "dock";
  readonly a?: readonly number[];
}

function refusal(message: string, code = "CALL_REFUSED"): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

/**
 * A fake in-space server. `getStatus` advances warp on each read. Session
 * changes model the BFF contract: undock, jump, and dock return only after the
 * authoritative location is ready to read. Docking refuses `DockingApproach`
 * `dockRefusals` times (entering a FOLLOW approach) before it docks.
 */
function makeMock(
  opts: {
    dockRefusals?: number;
    jumpRangeRefusals?: number;
    statusReadFailures?: number;
    warpBehavior?: (dest: number) => void;
  } = {},
) {
  const state = {
    docked: true,
    inSpace: false,
    system: ORIGIN_SYSTEM,
    stationID: ORIGIN_STATION as number | null,
    shipMode: null as string | null,
    warpTicks: 0,
    dockRefusalsRemaining: opts.dockRefusals ?? 1,
    // The ship lands near the gate but out of jump range: jump refuses
    // NotWithinMaxJumpDist until this many approaches close the distance.
    jumpRangeRefusalsRemaining: opts.jumpRangeRefusals ?? 0,
    // Flight-status reads time out this many times (e.g. jump-handoff scene
    // load) before succeeding — transient, not fatal.
    statusReadFailuresRemaining: opts.statusReadFailures ?? 0,
  };
  const calls: Call[] = [];

  function snapshot(): FlightStatus {
    if (state.warpTicks > 0) {
      state.warpTicks -= 1;
      if (state.warpTicks === 0) {
        state.shipMode = "STOP";
      }
    }
    return {
      inSpace: state.inSpace,
      docked: state.docked,
      solarSystemID: state.system,
      stationID: state.docked ? state.stationID : null,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: state.docked ? null : state.shipMode,
      shipSpeedFraction: state.shipMode === "WARP" ? 1 : 0,
    };
  }

  return {
    calls,
    state,
    getStatus: async (): Promise<FlightStatus> => {
      if (state.statusReadFailuresRemaining > 0) {
        state.statusReadFailuresRemaining -= 1;
        throw refusal("EveJS gateway timed out.", "EVE_GATEWAY_TIMEOUT");
      }
      return snapshot();
    },
    undock: async (): Promise<void> => {
      calls.push({ m: "undock" });
      state.docked = false;
      state.inSpace = true;
      state.stationID = null;
      state.shipMode = "STOP";
    },
    warp: async (dest: number): Promise<void> => {
      calls.push({ m: "warp", a: [dest] });
      if (opts.warpBehavior) {
        opts.warpBehavior(dest);
      }
      state.shipMode = "WARP";
      state.warpTicks = 1;
    },
    approach: async (dest: number): Promise<void> => {
      calls.push({ m: "approach", a: [dest] });
      if (state.jumpRangeRefusalsRemaining > 0) {
        state.jumpRangeRefusalsRemaining -= 1; // closed some distance
      }
      state.shipMode = "FOLLOW";
    },
    jump: async (from: number, to: number): Promise<void> => {
      calls.push({ m: "jump", a: [from, to] });
      if (state.jumpRangeRefusalsRemaining > 0) {
        state.shipMode = "FOLLOW";
        throw refusal("CmdStargateJump refused: 101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist");
      }
      // Ready-returning BFF: the destination location/scene/ship is already
      // authoritative when the promise resolves.
      state.system = DEST_SYSTEM;
      state.shipMode = "STOP";
    },
    dock: async (station: number): Promise<void> => {
      calls.push({ m: "dock", a: [station] });
      if (state.dockRefusalsRemaining > 0) {
        state.dockRefusalsRemaining -= 1;
        state.shipMode = "FOLLOW"; // enters approach
        throw refusal("CmdDock refused: DockingApproach (too far, approaching).");
      }
      state.docked = true;
      state.inSpace = false;
      state.stationID = station;
      state.shipMode = null;
    },
  };
}

function makeDeps(mock: ReturnType<typeof makeMock>): {
  deps: AutopilotDeps;
  progress: AutopilotProgress[];
} {
  const progress: AutopilotProgress[] = [];
  return {
    progress,
    deps: {
      getStatus: mock.getStatus,
      undock: mock.undock,
      warp: mock.warp,
      approach: mock.approach,
      jump: mock.jump,
      dock: mock.dock,
      sleep: async () => {},
      now: () => 0,
      onProgress: (p) => progress.push(p),
      isSessionLost: (e) => (e as { code?: string })?.code === "SESSION_NOT_FOUND",
      refusalReason: (e) => (e instanceof Error ? e.message : String(e)),
    },
  };
}

async function drive(
  controller: AutopilotController,
  maxTicks = 60,
): Promise<AutopilotAction[]> {
  const actions: AutopilotAction[] = [];
  for (let i = 0; i < maxTicks; i += 1) {
    const snap = controller.snapshot();
    if (snap.status !== "running") {
      break;
    }
    actions.push(await controller.tick());
  }
  return actions;
}

test("the loop sequences undock -> warp gate -> jump -> warp station -> dock (with approach-then-redock) -> arrived", async () => {
  const mock = makeMock({ dockRefusals: 1 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await drive(controller);

  assert.deepEqual(mock.calls, [
    { m: "undock" },
    { m: "warp", a: [GATE_ORIGIN] },
    { m: "jump", a: [GATE_ORIGIN, GATE_DEST] },
    { m: "warp", a: [DEST_STATION] },
    { m: "dock", a: [DEST_STATION] }, // refused (DockingApproach) -> FOLLOW
    { m: "dock", a: [DEST_STATION] }, // re-issued once in range -> docked
  ]);
  const snap = controller.snapshot();
  assert.equal(snap.status, "arrived");
  assert.equal(snap.remainingJumps, 0);
  assert.equal(snap.totalJumps, 1);
});

test("ready-returning undock, jump, and dock allow the next decision immediately without duplicate calls", async () => {
  const mock = makeMock({ dockRefusals: 0 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);
  controller.start(PLAN);

  assert.equal((await controller.tick()).kind, "undock");
  const afterUndock = await controller.tick();
  assert.equal(afterUndock.kind, "warp", "ready undock skips the old settle window");
  assert.equal(mock.calls.filter((call) => call.m === "undock").length, 1);

  // Warp remains asynchronous and deliberately keeps its two settle ticks.
  assert.equal((await controller.tick()).kind, "wait");
  assert.equal((await controller.tick()).kind, "wait");
  assert.equal((await controller.tick()).kind, "jump");

  const afterJump = await controller.tick();
  assert.equal(afterJump.kind, "warp", "ready jump can route in the destination next tick");
  assert.equal(mock.calls.filter((call) => call.m === "jump").length, 1);

  // The destination warp still settles before the dock decision.
  assert.equal((await controller.tick()).kind, "wait");
  assert.equal((await controller.tick()).kind, "wait");
  assert.equal((await controller.tick()).kind, "dock");

  const afterDock = await controller.tick();
  assert.equal(afterDock.kind, "arrived", "ready dock is observed without fixed delay");
  assert.equal(mock.calls.filter((call) => call.m === "dock").length, 1);
});

test("approach-then-redock: dock is re-issued repeatedly until in range", async () => {
  // Three DockingApproach refusals before the dock accepts.
  const mock = makeMock({ dockRefusals: 3 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await drive(controller, 120);

  const dockCalls = mock.calls.filter((c) => c.m === "dock");
  assert.equal(dockCalls.length, 4, "3 approach refusals + 1 successful dock");
  assert.equal(controller.snapshot().status, "arrived");
});

test("NotWithinMaxJumpDist: the loop approaches the gate, then jumps (does not pause)", async () => {
  // The autopilot-warp lands the ship near the gate but out of jump range; the
  // jump refuses NotWithinMaxJumpDist twice, an approach closes in each time.
  const mock = makeMock({ jumpRangeRefusals: 2 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await drive(controller, 120);

  const seq = mock.calls.map((c) => c.m);
  // warp to the gate, then jump(refused)->approach cycles until the jump takes.
  assert.ok(seq.includes("approach"), "the loop must approach, not pause, on a range refusal");
  const firstJump = seq.indexOf("jump");
  const firstApproach = seq.indexOf("approach");
  assert.ok(firstApproach > firstJump && firstJump !== -1, "approach follows the first refused jump");
  assert.equal(mock.calls.filter((c) => c.m === "approach").length, 2, "one approach per range refusal");
  assert.equal(controller.snapshot().status, "arrived", "the route completes after approaching into range");
});

test("transient flight-status timeouts are retried, not treated as fatal", async () => {
  // Three status reads time out (a slow jump-handoff scene load) then recover;
  // the route must still complete rather than pausing on the first slow read.
  const mock = makeMock({ statusReadFailures: 3 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await drive(controller, 120);

  assert.equal(controller.snapshot().status, "arrived", "a transient status timeout must not end the route");
});

test("a persistent flight-status timeout eventually pauses (bounded retries)", async () => {
  const mock = makeMock({ statusReadFailures: 999 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await drive(controller, 30);

  const snap = controller.snapshot();
  assert.equal(snap.status, "paused");
  assert.match(snap.failureReason ?? "", /flight status/i);
});

test("the loop pauses (does not guess) on an injected warp-scramble refusal", async () => {
  const mock = makeMock({
    warpBehavior: (dest) => {
      if (dest === GATE_ORIGIN) {
        throw refusal("You cannot warp while warp scrambled.");
      }
    },
  });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await drive(controller);

  const snap = controller.snapshot();
  assert.equal(snap.status, "paused");
  assert.match(snap.failureReason ?? "", /warp scrambled/i);
  // Undock + the refused warp were issued; nothing past the pause.
  assert.deepEqual(
    mock.calls.map((c) => c.m),
    ["undock", "warp"],
  );
});

test("abort stops the loop and it never calls the bridge afterward", async () => {
  const mock = makeMock();
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await controller.tick(); // undock
  assert.deepEqual(mock.calls.map((c) => c.m), ["undock"]);

  controller.abort();
  const callsAtAbort = mock.calls.length;

  // Any further ticks are no-ops that issue nothing.
  const action1 = await controller.tick();
  const action2 = await controller.tick();
  assert.equal(action1.kind, "aborted");
  assert.equal(action2.kind, "aborted");
  assert.equal(mock.calls.length, callsAtAbort, "no bridge call after abort");
  assert.equal(controller.snapshot().status, "aborted");
});

test("pause then resume continues the route from where it stopped", async () => {
  const mock = makeMock();
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await controller.tick(); // undock
  controller.pause();
  const pausedCalls = mock.calls.length;

  // Paused: ticks issue nothing.
  await controller.tick();
  assert.equal(mock.calls.length, pausedCalls);
  assert.equal(controller.snapshot().status, "paused");

  controller.resume();
  await drive(controller);
  assert.equal(controller.snapshot().status, "arrived");
  assert.ok(mock.calls.some((c) => c.m === "jump"), "route completed after resume");
});

test("a lost session during the loop stops it as an error (no further bridge calls)", async () => {
  const mock = makeMock();
  const lostDeps = makeDeps(mock);
  // Make undock report a lost session.
  const deps: AutopilotDeps = {
    ...lostDeps.deps,
    undock: async () => {
      throw refusal("Bridge session gone.", "SESSION_NOT_FOUND");
    },
  };
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await controller.tick(); // undock -> session lost
  const callsAfter = mock.calls.length;
  await controller.tick();

  const snap = controller.snapshot();
  assert.equal(snap.status, "error");
  assert.match(snap.failureReason ?? "", /session ended/i);
  assert.equal(mock.calls.length, callsAfter, "no further bridge calls after session loss");
});

// --- direct decision-function assertions (the pure branches) ---------------

function status(overrides: Partial<FlightStatus>): FlightStatus {
  return {
    inSpace: false,
    docked: false,
    solarSystemID: ORIGIN_SYSTEM,
    stationID: null,
    structureID: null,
    shipID: SHIP_ID,
    shipMode: null,
    shipSpeedFraction: null,
    ...overrides,
  };
}

const COMPILED = {
  ...PLAN,
  hopsByFromSystem: new Map(PLAN.hops.map((h) => [h.fromSystemID, h])),
  totalJumps: PLAN.hops.length,
};

test("decide: docked away from destination -> undock; docked at destination -> arrived", () => {
  assert.equal(
    decideAutopilotAction(status({ docked: true, solarSystemID: ORIGIN_SYSTEM, stationID: ORIGIN_STATION }), COMPILED, {
      warpedInSystem: null,
      jumpedFromSystem: null,
      pendingApproachGate: null,
    }).kind,
    "undock",
  );
  assert.equal(
    decideAutopilotAction(
      status({ docked: true, solarSystemID: DEST_SYSTEM, stationID: DEST_STATION }),
      COMPILED,
      { warpedInSystem: null, jumpedFromSystem: null, pendingApproachGate: null },
    ).kind,
    "arrived",
  );
});

test("decide: in warp -> wait; at gate system already warped -> jump", () => {
  assert.equal(
    decideAutopilotAction(status({ inSpace: true, shipMode: "WARP", solarSystemID: ORIGIN_SYSTEM }), COMPILED, {
      warpedInSystem: null,
      jumpedFromSystem: null,
      pendingApproachGate: null,
    }).kind,
    "wait",
  );
  const jump = decideAutopilotAction(
    status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
    COMPILED,
    { warpedInSystem: ORIGIN_SYSTEM, jumpedFromSystem: null, pendingApproachGate: null },
  );
  assert.equal(jump.kind, "jump");
  if (jump.kind === "jump") {
    assert.equal(jump.fromGateID, GATE_ORIGIN);
    assert.equal(jump.toGateID, GATE_DEST);
  }
});

test("decide: jump handoff (still in old system) waits", () => {
  const action = decideAutopilotAction(
    status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
    COMPILED,
    { warpedInSystem: ORIGIN_SYSTEM, jumpedFromSystem: ORIGIN_SYSTEM, pendingApproachGate: null },
  );
  assert.equal(action.kind, "wait");
});

test("decide: off-route system pauses", () => {
  const action = decideAutopilotAction(
    status({ inSpace: true, shipMode: "STOP", solarSystemID: 39999999 }),
    COMPILED,
    { warpedInSystem: null, jumpedFromSystem: null, pendingApproachGate: null },
  );
  assert.equal(action.kind, "pause");
});

// --- R13: the loop MEASURES, it does not guess -------------------------------
//
// Retail's autopilot reads `GetSurfaceDist(ship, destination)` once per tick and
// picks the right call the first time. These tests drive the ladder off
// SYNTHETIC distances: each case hands the decision one measured surface
// distance and asserts which of jump / dock / approach / warp comes back, at
// retail's own thresholds and in retail's evaluation order.

function spaceEntity(overrides: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: null,
    typeID: null,
    groupID: null,
    categoryID: null,
    name: null,
    ownerID: null,
    radius: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isSelf: false,
    shieldRatio: null,
    armorRatio: null,
    hullRatio: null,
    characterID: null,
    corporationID: null,
    allianceID: null,
    securityStatus: null,
    maxVelocity: null,
    mode: null,
    capacitorRatio: null,
  remainingQuantity: null,
  miningYieldTypeID: null,
  beltID: null,
  oreGrade: null,
  isNpc: false,
  npcEntityType: null,
  controllerID: null,
  droneActivity: null,
  targetEntityID: null,
    ...overrides,
  };
}

/** A snapshot with the ship at the origin and one target on the x axis. */
function gridSnapshot(
  targetID: number,
  metres: number,
  solarSystemID: number,
  shipMode: string | null = "STOP",
): SpaceSnapshot {
  return {
    inSpace: true,
    solarSystemID,
    shipID: SHIP_ID,
    sampledAtMs: 0,
    ship: null,
    entities: [
      spaceEntity({
        itemID: SHIP_ID,
        isSelf: true,
        radius: 0,
        position: { x: 0, y: 0, z: 0 },
        mode: shipMode,
      }),
      spaceEntity({ itemID: targetID, radius: 0, position: { x: metres, y: 0, z: 0 } }),
    ],
  };
}

/**
 * A measurement that puts exactly one target at a chosen surface distance.
 * `shipRadius` defaults to 0 (the smallest hull), which makes the R24 warp
 * floor the pure `150 km + WARP_EXIT_VARIANCE_M` worst case.
 */
function measuredAt(
  targetID: number,
  metres: number,
  shipMode: string | null = "STOP",
  shipRadius = 0,
): SpaceMeasurement {
  return { distances: new Map([[targetID, metres]]), shipMode, shipRadius };
}

/** The action chosen for the outbound gate at `metres`. */
function gateDecisionAt(metres: number, shipMode = "STOP"): AutopilotAction {
  return decideAutopilotAction(
    status({ inSpace: true, shipMode, solarSystemID: ORIGIN_SYSTEM }),
    COMPILED,
    { warpedInSystem: null, jumpedFromSystem: null, pendingApproachGate: null },
    measuredAt(GATE_ORIGIN, metres, shipMode),
  );
}

/** The action chosen for the destination station at `metres`. */
function stationDecisionAt(metres: number, shipMode = "STOP"): AutopilotAction {
  return decideAutopilotAction(
    status({ inSpace: true, shipMode, solarSystemID: DEST_SYSTEM }),
    COMPILED,
    { warpedInSystem: null, jumpedFromSystem: null, pendingApproachGate: null },
    measuredAt(DEST_STATION, metres, shipMode),
  );
}

test("surface distance is max(0, centre-to-centre - both radii), as the server measures it", () => {
  // 10 km apart centre-to-centre with 1 km and 500 m radii: the gap between the
  // hulls is 8.5 km, not 10 km.
  assert.equal(
    surfaceDistanceMeters({ x: 0, y: 0, z: 0 }, 1000, { x: 10000, y: 0, z: 0 }, 500),
    8500,
  );
  // Overlapping hulls never read as a negative distance.
  assert.equal(
    surfaceDistanceMeters({ x: 0, y: 0, z: 0 }, 5000, { x: 1000, y: 0, z: 0 }, 5000),
    0,
  );
});

test("measureSpace builds surface distances from the snapshot (and skips the ship itself)", () => {
  const measurement = measureSpace({
    ...gridSnapshot(GATE_ORIGIN, 5000, ORIGIN_SYSTEM),
    entities: [
      spaceEntity({
        itemID: SHIP_ID,
        isSelf: true,
        radius: 100,
        position: { x: 0, y: 0, z: 0 },
        mode: "FOLLOW",
      }),
      spaceEntity({ itemID: GATE_ORIGIN, radius: 900, position: { x: 5000, y: 0, z: 0 } }),
    ],
  });
  assert.ok(measurement);
  // 5000 centre-to-centre, minus the ship's 100 and the gate's 900.
  assert.equal(measurement.distances.get(GATE_ORIGIN), 4000);
  assert.equal(measurement.distances.has(SHIP_ID), false, "the ship is not one of its own targets");
  assert.equal(measurement.shipMode, "FOLLOW");
});

test("measureSpace returns null when there is nothing to measure from", () => {
  assert.equal(measureSpace(null), null);
  assert.equal(
    measureSpace({
      inSpace: false,
      solarSystemID: ORIGIN_SYSTEM,
      shipID: null,
      sampledAtMs: null,
      ship: null,
      entities: [],
    }),
    null,
    "a docked snapshot measures nothing",
  );
});

test("ladder: a GATE inside 2500 m is JUMPED, not approached", () => {
  for (const metres of [0, 100, 2499]) {
    const action = gateDecisionAt(metres);
    assert.equal(action.kind, "jump", `${metres} m from the gate`);
    if (action.kind === "jump") {
      assert.equal(action.fromGateID, GATE_ORIGIN);
      assert.equal(action.toGateID, GATE_DEST);
    }
  }
  // 2500 exactly is NOT inside the threshold (retail's test is `<`).
  assert.equal(gateDecisionAt(2500).kind, "approach");
});

test("ladder: a STATION inside its 2.5 km docking radius is DOCKED, not approached", () => {
  // R24 slice B — the gate is `DEFAULT_STATION_DOCKING_RADIUS` (runtime.js:700)
  // measured as SURFACE distance, not the 50 km `maxDockingDistance`, which is
  // only retail's outer hand-off trigger.
  for (const metres of [0, 1_000, 2_499]) {
    const action = stationDecisionAt(metres);
    assert.equal(action.kind, "dock", `${metres} m from the station`);
    if (action.kind === "dock") {
      assert.equal(action.stationID, DEST_STATION);
    }
  }
  assert.equal(stationDecisionAt(2_500).kind, "approach", "2.5 km exactly is outside");
  // And the distance R13 docked from is now closed in on instead: firing Dock
  // out here only earns a `DockingApproach` refusal (beyonceService.js:3013).
  assert.equal(stationDecisionAt(25_000).kind, "approach");
  assert.equal(stationDecisionAt(49_999).kind, "approach");
});

test("ladder: the close-range rule is per target KIND, as retail splits it", () => {
  // A gate 30 km out is approached (it is not a station, so 50 km does not
  // dock); a station 1 km out is docked (it is not a gate, so 2.5 km does not
  // jump).
  assert.equal(gateDecisionAt(30_000).kind, "approach");
  assert.equal(stationDecisionAt(1_000).kind, "dock");
});

test("ladder: below the warp floor the ship APPROACHES; at or above it, it WARPS", () => {
  const floor = warpFloorMeters(0);
  for (const metres of [3_000, 100_000, 149_999, floor - 1]) {
    const action = gateDecisionAt(metres);
    assert.equal(action.kind, "approach", `${metres} m from the gate`);
    if (action.kind === "approach") {
      assert.equal(action.gateID, GATE_ORIGIN);
    }
  }
  for (const metres of [floor, 1_000_000, 5_000_000_000]) {
    const action = gateDecisionAt(metres);
    assert.equal(action.kind, "warp", `${metres} m from the gate`);
    if (action.kind === "warp") {
      assert.equal(action.destinationID, GATE_ORIGIN);
    }
  }
});

// --- R24 slice A: the warp DEAD BAND ----------------------------------------

test("warp floor: never below retail's 150 km, and it tracks the hull it is asked about", () => {
  // A small hull is dominated by the server's randomised stargate warp-exit
  // scatter (WARP_EXIT_VARIANCE_M).
  assert.equal(warpFloorMeters(0), 150_000 + WARP_EXIT_VARIANCE_M);
  assert.equal(warpFloorMeters(60), 150_000 + WARP_EXIT_VARIANCE_M);
  // A hull bigger than that scatter dominates instead: a station warp's stop
  // distance carries +shipRadius (warpState.js:632).
  assert.equal(warpFloorMeters(4_000), 154_000);
  // The 10 km the AUTOPILOT call hardcodes, for comparison — this is the term
  // R24 removes by sending retail's minRange=0 instead.
  assert.equal(warpFloorMeters(0, 10_000), 162_500);
  // Never optimistic about junk input.
  assert.equal(warpFloorMeters(Number.NaN), 150_000 + WARP_EXIT_VARIANCE_M);
});

test("dead band: a target the SERVER would silently refuse is approached, never warped", () => {
  // THE BUG. R13 warped at >= 150,000 m surface distance. The server refuses
  // (warpState.js:236) and says nothing a client can see: WARP_DISTANCE_TOO_CLOSE
  // (warpCommands.js:250-255) is not one of the four cases
  // _throwWarpFailureUserError translates (beyonceService.js:1693-1713), so the
  // browser gets ok:true / result:null and a ship that has not moved. The loop
  // then re-measured the SAME distance and decided "warp" again, forever.
  //
  // Every distance here is inside the band R13 warped in and the server refuses.
  for (const metres of [150_000, 150_001, 151_000, 152_499]) {
    assert.equal(
      gateDecisionAt(metres).kind,
      "approach",
      `${metres} m from the gate is inside the dead band`,
    );
    assert.equal(
      stationDecisionAt(metres).kind,
      "approach",
      `${metres} m from the station is inside the dead band`,
    );
  }
});

test("dead band: a warp that changes nothing is BOUNDED — the loop pauses, it does not spin", async () => {
  // A server that accepts the warp call and does nothing with it: 200, null,
  // ship still parked. This is the shape the four confirmed silent-decline
  // sites on this server all take, so the loop must survive it by construction
  // rather than by trusting any particular refusal text.
  const DEAD_BAND_M = 151_000;
  const calls: string[] = [];
  const deps: AutopilotDeps = {
    getStatus: async () => status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
    // The ship never moves, however many warps we issue.
    getSpaceSnapshot: async () => gridSnapshot(GATE_ORIGIN, DEAD_BAND_M, ORIGIN_SYSTEM),
    undock: async () => { calls.push("undock"); },
    warp: async () => { calls.push("warp"); },
    approach: async () => { calls.push("approach"); },
    jump: async () => { calls.push("jump"); },
    dock: async () => { calls.push("dock"); },
    sleep: async () => {},
    now: () => 0,
    onProgress: () => {},
    isSessionLost: () => false,
    refusalReason: (error) => String((error as Error).message || error),
  };
  const pilot: AutopilotController = createAutopilot(deps);
  pilot.start(PLAN);

  // Far more ticks than any bound: if the branch were unbounded this would
  // issue ~40 warps.
  for (let i = 0; i < 40; i += 1) {
    await pilot.tick();
  }

  // At the corrected floor this distance decides APPROACH, so no warp is even
  // attempted — the loop makes real progress instead of asking for one the
  // server will not honour.
  assert.equal(calls.filter((c) => c === "warp").length, 0, "no warp inside the dead band");
  assert.ok(calls.includes("approach"), "it closes the gap under sublight instead");
  assert.notEqual(pilot.snapshot().status, "error");
});

test("dead band: even a warp the ladder DOES choose cannot repeat unboundedly", async () => {
  // Belt and braces for the residual uncertainty: the stargate warp-in point is
  // randomised inside WARP_EXIT_VARIANCE_M, so no client can predict the
  // server's gate exactly. If a warp we legitimately chose still changes
  // nothing, the branch must stop, not spin — the jump branch has had this
  // counter since R5b and warp had none.
  const FAR_M = 5_000_000;
  const calls: string[] = [];
  const deps: AutopilotDeps = {
    getStatus: async () => status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
    // Accepted, and the ship stays exactly where it was: the silent decline.
    getSpaceSnapshot: async () => gridSnapshot(GATE_ORIGIN, FAR_M, ORIGIN_SYSTEM),
    undock: async () => { calls.push("undock"); },
    warp: async () => { calls.push("warp"); },
    approach: async () => { calls.push("approach"); },
    jump: async () => { calls.push("jump"); },
    dock: async () => { calls.push("dock"); },
    sleep: async () => {},
    now: () => 0,
    onProgress: () => {},
    isSessionLost: () => false,
    refusalReason: (error) => String((error as Error).message || error),
  };
  const pilot: AutopilotController = createAutopilot(deps);
  pilot.start(PLAN);
  for (let i = 0; i < 40; i += 1) {
    await pilot.tick();
  }

  const warps = calls.filter((c) => c === "warp").length;
  assert.ok(warps > 0, "the ladder does choose a warp out here");
  assert.ok(warps <= MAX_WARP_ATTEMPTS, `bounded (issued ${warps})`);
  // And it stops with a reason a player can read, rather than running forever.
  const final = pilot.snapshot();
  assert.equal(final.status, "paused");
  assert.match(String(final.failureReason), /warp did not start/i);
});

test("ladder: a RUNNING approach on the same target is never re-issued", () => {
  const base = { warpedInSystem: null, jumpedFromSystem: null, pendingApproachGate: null };
  // Nothing of ours is running yet: issue the approach.
  assert.equal(
    decideAutopilotAction(
      status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
      COMPILED,
      { ...base, approachingTargetID: null },
      measuredAt(GATE_ORIGIN, 100_000, "STOP"),
    ).kind,
    "approach",
  );
  // Our approach is running against THIS target and the server agrees the ship
  // is following: wait, do not restart it (retail skips on DSTBALL_FOLLOW).
  const waiting = decideAutopilotAction(
    status({ inSpace: true, shipMode: "FOLLOW", solarSystemID: ORIGIN_SYSTEM }),
    COMPILED,
    { ...base, approachingTargetID: GATE_ORIGIN },
    measuredAt(GATE_ORIGIN, 100_000, "FOLLOW"),
  );
  assert.equal(waiting.kind, "wait");
  if (waiting.kind === "wait") {
    assert.equal(waiting.reason, "Closing in");
  }
  // A follow against a DIFFERENT target is not our approach: issue ours.
  assert.equal(
    decideAutopilotAction(
      status({ inSpace: true, shipMode: "FOLLOW", solarSystemID: ORIGIN_SYSTEM }),
      COMPILED,
      { ...base, approachingTargetID: 42424242 },
      measuredAt(GATE_ORIGIN, 100_000, "FOLLOW"),
    ).kind,
    "approach",
  );
  // And if the ship is not actually following, the approach is re-issued even
  // though we believed one was running — the measurement is the authority.
  assert.equal(
    decideAutopilotAction(
      status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
      COMPILED,
      { ...base, approachingTargetID: GATE_ORIGIN },
      measuredAt(GATE_ORIGIN, 100_000, "STOP"),
    ).kind,
    "approach",
  );
});

test("ladder: mid-warp does NOTHING, however close the measurement says the target is", () => {
  // Retail returns immediately on DSTBALL_WARP. The distance here is inside
  // jump range — the loop must still not act.
  const action = gateDecisionAt(100, "WARP");
  assert.equal(action.kind, "wait");
  if (action.kind === "wait") {
    assert.equal(action.reason, "In warp");
  }
  assert.equal(stationDecisionAt(100, "WARP").kind, "wait");
});

test("ladder: an UNMEASURABLE target falls back to the mode-and-refusal path", () => {
  // The snapshot cannot see the gate (off grid, or a scene that has not caught
  // up): the decision must not stall — it falls back to R5b's behaviour, which
  // warps when it has not warped in this system yet...
  const blind: SpaceMeasurement = { distances: new Map(), shipMode: "STOP", shipRadius: 0 };
  assert.equal(
    decideAutopilotAction(
      status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
      COMPILED,
      { warpedInSystem: null, jumpedFromSystem: null, pendingApproachGate: null },
      blind,
    ).kind,
    "warp",
  );
  // ...and jumps once it has, exactly as before R13.
  assert.equal(
    decideAutopilotAction(
      status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
      COMPILED,
      { warpedInSystem: ORIGIN_SYSTEM, jumpedFromSystem: null, pendingApproachGate: null },
      blind,
    ).kind,
    "jump",
  );
});

test("ladder: measurement OVERRIDES the old mode heuristic (no warp-then-blind-jump)", () => {
  // Before R13 this state ("we already warped in this system") jumped
  // unconditionally and learned the range only from the server's refusal. With
  // a measurement saying the gate is still 80 km away, the ship approaches.
  assert.equal(
    decideAutopilotAction(
      status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
      COMPILED,
      { warpedInSystem: ORIGIN_SYSTEM, jumpedFromSystem: null, pendingApproachGate: null },
      measuredAt(GATE_ORIGIN, 80_000, "STOP"),
    ).kind,
    "approach",
  );
});

test("ladder: the jump handoff still wins over any measurement", () => {
  assert.equal(
    decideAutopilotAction(
      status({ inSpace: true, shipMode: "STOP", solarSystemID: ORIGIN_SYSTEM }),
      COMPILED,
      { warpedInSystem: ORIGIN_SYSTEM, jumpedFromSystem: ORIGIN_SYSTEM, pendingApproachGate: null },
      measuredAt(GATE_ORIGIN, 100, "STOP"),
    ).kind,
    "wait",
  );
});

test("a measured run flies the route with no refusal: warp, approach, jump, warp, approach, dock", async () => {
  // A fake grid whose distance to the current target shrinks as the ship moves,
  // wired into the loop through getSpaceSnapshot. Nothing ever refuses: every
  // call has to be chosen from the measurement alone.
  const mock = makeMock({ dockRefusals: 0, jumpRangeRefusals: 0 });
  const grid = { gate: 4_000_000_000, station: 4_000_000_000 };
  const { deps } = makeDeps(mock);
  const controller = createAutopilot({
    ...deps,
    warp: async (dest: number) => {
      await mock.warp(dest);
      // A warp lands the ship NEAR the target, not on it.
      if (dest === GATE_ORIGIN) {
        grid.gate = 120_000;
      } else {
        grid.station = 120_000;
      }
    },
    approach: async (dest: number) => {
      await mock.approach(dest);
      // The approach closes the remaining gap into jump / dock range.
      if (dest === GATE_ORIGIN) {
        grid.gate = 1_000;
      } else {
        // Inside the station's real 2.5 km docking radius (R24 slice B) — a
        // followBall on a station runs the ship right up to the hull.
        grid.station = 1_000;
      }
    },
    getSpaceSnapshot: async () => {
      if (mock.state.docked) {
        return null;
      }
      return mock.state.system === DEST_SYSTEM
        ? gridSnapshot(DEST_STATION, grid.station, DEST_SYSTEM, mock.state.shipMode)
        : gridSnapshot(GATE_ORIGIN, grid.gate, ORIGIN_SYSTEM, mock.state.shipMode);
    },
  });

  controller.start(PLAN);
  await drive(controller, 120);

  assert.equal(controller.snapshot().status, "arrived");
  const sequence = mock.calls.map((c) => c.m);
  assert.deepEqual(
    sequence,
    ["undock", "warp", "approach", "jump", "warp", "approach", "dock"],
    "every call was chosen from the measured distance, first time, with no refusal",
  );
  // The approach was issued ONCE per leg — a running approach is waited on, not
  // restarted every cycle.
  assert.equal(sequence.filter((m) => m === "approach").length, 2);
  // And dock was issued once: measurement had the ship in range before it
  // asked, so there was no approach-then-redock round trip.
  assert.equal(sequence.filter((m) => m === "dock").length, 1);
});

test("a snapshot read that fails never fails the tick — the loop falls back and still arrives", async () => {
  const mock = makeMock({ dockRefusals: 1 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot({
    ...deps,
    getSpaceSnapshot: async () => {
      throw refusal("EveJS gateway timed out.", "EVE_GATEWAY_TIMEOUT");
    },
  });
  controller.start(PLAN);
  await drive(controller, 120);

  assert.equal(controller.snapshot().status, "arrived");
  assert.ok(mock.calls.some((c) => c.m === "jump"), "it still jumped");
  assert.ok(mock.calls.some((c) => c.m === "dock"), "it still docked");
});

test("an unexpected refusal still PAUSES rather than guessing, even when measuring", async () => {
  const mock = makeMock({ dockRefusals: 0 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot({
    ...deps,
    // The gate measures 1 km away, so the ladder says JUMP...
    getSpaceSnapshot: async () =>
      gridSnapshot(GATE_ORIGIN, 1_000, mock.state.system, mock.state.shipMode),
    // ...and the server refuses it for a reason we must not guess around.
    jump: async () => {
      throw refusal("Your standing with this faction is too low to use this gate.");
    },
  });
  controller.start(PLAN);
  await drive(controller, 30);

  assert.equal(controller.snapshot().status, "paused");
  assert.match(String(controller.snapshot().failureReason), /standing/i);
});

// --- Transient transport on ACTIONS (the false "server took too long") -------
//
// A gateway timeout on an issued command says nothing about what the game
// decided. Reads already had this tolerance (MAX_STATUS_READ_FAILURES); these
// pin the same for actions: settle, re-observe, retry bounded — never a
// terminal "refused" on the first unanswered call.

test("a gateway timeout on an action is settled and retried, and the flight still arrives", async () => {
  const mock = makeMock({ dockRefusals: 0 });
  const { deps } = makeDeps(mock);
  let failuresLeft = 2;
  const controller = createAutopilot({
    ...deps,
    warp: async (dest: number) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw refusal("EveJS gateway timed out.", "EVE_GATEWAY_TIMEOUT");
      }
      await mock.warp(dest);
    },
  });
  controller.start(PLAN);
  await drive(controller, 120);

  assert.equal(
    controller.snapshot().status,
    "arrived",
    "two unanswered warp calls must not end the flight",
  );
  assert.ok(mock.calls.some((c) => c.m === "jump"), "it still jumped");
  assert.ok(mock.calls.some((c) => c.m === "dock"), "it still docked");
});

test("BOUNDED: a wire that never answers pauses with the transport truth, not a fake refusal", async () => {
  const mock = makeMock({ dockRefusals: 0 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot({
    ...deps,
    warp: async () => {
      throw refusal("EveJS gateway timed out.", "EVE_GATEWAY_TIMEOUT");
    },
  });
  controller.start(PLAN);
  await drive(controller, 60);

  const snap = controller.snapshot();
  assert.equal(snap.status, "paused");
  assert.match(
    String(snap.failureReason),
    /no answer from the server/i,
    "the pause must say the wire did not answer — not that the game refused",
  );
});

// --- R24 slice B: the smart Dock command ------------------------------------

test("Dock ladder: a zero-hop plan warps, approaches and docks, and only ARRIVES when flight status says docked", async () => {
  // Retail's Dock is `GetCloseAndTryCommand(itemID, RealDock, interactionRange=2500)`
  // driven by `__NavigateSystemTo`, re-armed every 2000 ms. The same ladder,
  // the same loop, no second autopilot: a plan with NO hops whose destination
  // is the station.
  const DOCK_ONLY: RoutePlan = {
    destinationSystemID: DEST_SYSTEM,
    destinationStationID: DEST_STATION,
    destinationName: "Destination Station",
    hops: [],
  };
  const mock = makeMock({ dockRefusals: 0 });
  mock.state.docked = false;
  mock.state.inSpace = true;
  mock.state.system = DEST_SYSTEM;
  mock.state.stationID = null;
  mock.state.shipMode = "STOP";

  // The ship starts a long way out; each move closes the gap the way the sim
  // would. The dock rung is the server's real 2.5 km SURFACE radius.
  let range = 900_000_000;
  const { deps } = makeDeps(mock);
  const controller = createAutopilot({
    ...deps,
    warp: async (dest: number) => {
      await mock.warp(dest);
      range = 60_000; // a station warp lands you close, but not docked
    },
    approach: async (dest: number) => {
      await mock.approach(dest);
      range = 800; // followBall runs the ship up to the hull
    },
    getSpaceSnapshot: async () =>
      mock.state.docked
        ? null
        : gridSnapshot(DEST_STATION, range, DEST_SYSTEM, mock.state.shipMode),
  });

  controller.start(DOCK_ONLY);
  await drive(controller, 120);

  assert.deepEqual(
    mock.calls.map((c) => c.m),
    ["warp", "approach", "dock"],
    "close the distance, then dock — each chosen from the measurement",
  );
  // And the ONLY thing that made it "arrived" is the flight status coming back
  // docked at this station. The Dock call itself resolved without throwing on
  // the very first attempt, which on this server proves nothing.
  assert.equal(controller.snapshot().status, "arrived");
  assert.equal(mock.state.docked, true);
});

test("Dock ladder: a Dock that returns fine but does not dock is bounded, and stops with a reason", async () => {
  // `Handle_CmdDock` can return 200/null WITHOUT docking (beyonceService.js:3031-3042).
  // Here the call always succeeds and the ship is never docked: the loop must
  // stop asking rather than re-issuing Dock forever.
  const DOCK_ONLY: RoutePlan = {
    destinationSystemID: DEST_SYSTEM,
    destinationStationID: DEST_STATION,
    destinationName: "Destination Station",
    hops: [],
  };
  let docks = 0;
  const deps: AutopilotDeps = {
    getStatus: async () =>
      status({ inSpace: true, shipMode: "STOP", solarSystemID: DEST_SYSTEM }),
    // In range for the whole run — so the ladder keeps choosing dock.
    getSpaceSnapshot: async () => gridSnapshot(DEST_STATION, 800, DEST_SYSTEM),
    undock: async () => {},
    warp: async () => {},
    approach: async () => {},
    jump: async () => {},
    dock: async () => {
      docks += 1;
    },
    sleep: async () => {},
    now: () => 0,
    onProgress: () => {},
    isSessionLost: () => false,
    refusalReason: (error) => String((error as Error).message || error),
  };
  const controller = createAutopilot(deps);
  controller.start(DOCK_ONLY);
  await drive(controller, 400);

  assert.ok(docks > 0, "it does try");
  assert.notEqual(controller.snapshot().status, "arrived", "a 200 is not proof it docked");
  assert.equal(controller.snapshot().status, "paused", "it gives up rather than spinning");
  assert.ok(
    String(controller.snapshot().failureReason).length > 0,
    "and says why, in the loop's own words",
  );
});

test("Dock ladder: a REFUSED dock is not a silent decline — the generous refusal bound still applies", async () => {
  // The two failure modes must not be conflated. A `DockingApproach` refusal is
  // the server TELLING us to close in, and on the unmeasured fallback path that
  // legitimately repeats many times while the ship covers the last stretch — so
  // it is governed by MAX_DOCK_ATTEMPTS (30), not by the much tighter
  // silent-decline bound.
  const mock = makeMock({ dockRefusals: MAX_SILENT_DOCK_ATTEMPTS + 5 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await drive(controller, 200);

  assert.equal(controller.snapshot().status, "arrived", "it waits the refusals out");
  assert.ok(
    mock.calls.filter((c) => c.m === "dock").length > MAX_SILENT_DOCK_ATTEMPTS,
    "and re-issued dock more times than the silent-decline bound allows",
  );
});

// --- R31: translated for the player, classified on the server's own words ----

test("R31 — a jump refusal is still CLASSIFIED on the raw text, not on the prose", async () => {
  // ⚠ THE REGRESSION THIS PREVENTS IS SILENT AND EXPENSIVE. classifyJumpRefusal
  // decides approach-and-retry versus a dead stop by looking for
  // `NotWithingMaxJumpDist` in the SERVER's own string. R31 translates that
  // string for the player — and if the translation had been applied before the
  // classifier instead of after it, "That gate is too far away to jump
  // through." would match none of those patterns, every recoverable
  // out-of-range jump would be reclassified as fatal, and the autopilot would
  // pause on the single most ordinary refusal in the game.
  //
  // Three jump-range refusals, exactly the live string, and it must still
  // arrive.
  const mock = makeMock({ jumpRangeRefusals: 3 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await drive(controller, 200);

  assert.equal(controller.snapshot().status, "arrived", "it closed in and jumped");
  assert.ok(
    mock.calls.filter((c) => c.m === "approach").length > 0,
    "the range refusal was recognised as 'close in', not as 'give up'",
  );
});

test("R31 — an autopilot pause never shows the player a resource key", async () => {
  // A refusal the classifier treats as fatal goes straight into failureReason,
  // which renders in the cockpit strip (R30 slice C). That is a player-facing
  // string and R9a applies to it.
  const mock = makeMock({});
  mock.jump = async () => {
    throw refusal("CmdStargateJump refused: 101,UI/GateIcons/GateClosed");
  };
  const { deps } = makeDeps(mock);
  const controller = createAutopilot(deps);

  controller.start(PLAN);
  await drive(controller, 200);

  const why = String(controller.snapshot().failureReason ?? "");
  assert.ok(why.length > 0, "it still says the jump failed — a refusal is never swallowed");
  assert.ok(!why.includes("UI/"), `resource path reached the player: ${why}`);
  assert.ok(!why.includes("101,"), `localization marker reached the player: ${why}`);
  assert.match(why, /gate is closed/i, "and it says what actually happened");
});

// --- The approach bound (slice: the third silent-decline hole) ---------------
//
// `followBall` declines silently exactly like warp and dock: the route answers
// ok and the ship never enters FOLLOW. Warp got MAX_WARP_ATTEMPTS (slice A),
// dock got MAX_SILENT_DOCK_ATTEMPTS (slice B); these pin the same bound for
// approach — the reported "hangs waiting to approach".

test("BOUNDED: an approach the server keeps silently declining pauses instead of re-issuing forever", async () => {
  const mock = makeMock({ dockRefusals: 0 });
  const { deps } = makeDeps(mock);
  let approaches = 0;
  const controller = createAutopilot({
    ...deps,
    approach: async () => {
      // 200/ok with the ship untouched — the silent decline. Mode never
      // becomes FOLLOW, so every measured tick re-decides "approach".
      approaches += 1;
    },
    getSpaceSnapshot: async () =>
      gridSnapshot(GATE_ORIGIN, 20_000, mock.state.system, mock.state.shipMode),
  });
  controller.start(PLAN);
  await drive(controller, 80);

  const snap = controller.snapshot();
  assert.equal(snap.status, "paused", "an approach that never takes must stop the flight");
  assert.match(String(snap.failureReason), /approach was sent/i);
  assert.equal(approaches, 5, "exactly the bound's worth of issues, then the pause");
});

test("a follow that TAKES ends the silent-decline streak and the flight arrives", async () => {
  const mock = makeMock({ dockRefusals: 0 });
  const { deps } = makeDeps(mock);
  let approaches = 0;
  const controller = createAutopilot({
    ...deps,
    approach: async () => {
      approaches += 1;
      if (approaches >= 3) {
        mock.state.shipMode = "FOLLOW"; // the third issue takes
      }
    },
    getSpaceSnapshot: async () =>
      mock.state.system === DEST_SYSTEM
        ? gridSnapshot(DEST_STATION, 1_000, DEST_SYSTEM, mock.state.shipMode)
        : gridSnapshot(
            GATE_ORIGIN,
            mock.state.shipMode === "FOLLOW" ? 1_000 : 20_000,
            ORIGIN_SYSTEM,
            mock.state.shipMode,
          ),
  });
  controller.start(PLAN);
  await drive(controller, 120);

  assert.equal(controller.snapshot().status, "arrived", "two silent declines then a real follow must not pause");
  assert.equal(approaches, 3);
});

// --- Session-change vocabulary (409 settling / 504 timeout) ------------------

test("a command turned back by a settling session change is waited out, not paused on", async () => {
  const mock = makeMock({ dockRefusals: 0 });
  const { deps } = makeDeps(mock);
  const undock = mock.undock;
  let turnbacks = 0;
  const controller = createAutopilot({
    ...deps,
    undock: async () => {
      // The BFF's transition gate: five 409s while the previous session change
      // settles (legitimately tens of seconds), then the command goes through.
      if (turnbacks < 5) {
        turnbacks += 1;
        throw refusal("The dock transition is still finishing.", "SESSION_CHANGE_IN_PROGRESS");
      }
      await undock();
    },
  });
  controller.start(PLAN);
  await drive(controller, 120);

  assert.equal(controller.snapshot().status, "arrived", "five turn-backs are inside the settling bound");
  assert.equal(turnbacks, 5);
});

test("BOUNDED: a session change that never settles pauses with its own words", async () => {
  const mock = makeMock({ dockRefusals: 0 });
  const { deps } = makeDeps(mock);
  const controller = createAutopilot({
    ...deps,
    undock: async () => {
      throw refusal("The dock transition is still finishing.", "SESSION_CHANGE_IN_PROGRESS");
    },
  });
  controller.start(PLAN);
  await drive(controller, 120);

  const snap = controller.snapshot();
  assert.equal(snap.status, "paused");
  assert.match(String(snap.failureReason), /session change was finishing/i);
});

test("TRANSITION_TIMEOUT on a jump that actually landed: re-observe, move on, never re-jump", async () => {
  const mock = makeMock({ dockRefusals: 0 });
  const { deps } = makeDeps(mock);
  let jumps = 0;
  const controller = createAutopilot({
    ...deps,
    jump: async (from: number, to: number) => {
      // The barrier gave up waiting — but the sim completed the jump. The 504
      // is an UNKNOWN outcome; the next authoritative read must settle it.
      jumps += 1;
      mock.state.system = DEST_SYSTEM;
      mock.state.shipMode = "STOP";
      mock.calls.push({ m: "jump", a: [from, to] });
      throw refusal(
        "The session change did not become ready in time. No command was repeated.",
        "TRANSITION_TIMEOUT",
      );
    },
  });
  controller.start(PLAN);
  await drive(controller, 120);

  assert.equal(controller.snapshot().status, "arrived");
  assert.equal(jumps, 1, "the landed jump must never be re-issued");
});
