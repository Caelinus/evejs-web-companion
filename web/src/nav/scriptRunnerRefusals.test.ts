// Refusals through the REAL runner and the REAL macros.
//
// ⚠ WHY THIS FILE EXISTS. The runner commits a block's memory and board patch
// only when its world-call action SUCCEEDS (2fd4a77), so a block that sets an
// "I issued that" flag on the issuing tick and reads it back on the next one to
// react to a refusal never gets there: after a refusal its memory is unchanged.
// scriptMacros.test.ts drives macros one tick at a time and hands each tick the
// previous tick's nextMem, which is exactly what the runner does NOT do for a
// refused action — so those tests passed while two blocks were unreachable live.
// Everything here goes through `createScriptRunner` with `issue` throwing.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, MacroStep, ProgramNode } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import type { HomeTravelDecider, MacroDecider, ScriptAction } from "./scriptDecide.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import { createScriptRunner } from "./scriptRunner.ts";

const ORIGIN = { x: 0, y: 0, z: 0 };
const AU = 149_597_870_700;

function calm(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null,
      shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null },
    lockedTargetIDs: [], holds: null, droneBayItemIDs: [], miningModuleIDs: [], startingStationID: null,
    systemName: "Test System",
    ...over,
  } as ScriptObservation;
}

function rock(itemID: number, x: number): SpaceEntity {
  return {
    itemID, kind: "celestial", typeID: 1, groupID: 1, categoryID: 2, name: "Veldspar", ownerID: null,
    radius: 10, position: { x, y: 0, z: 0 }, velocity: ORIGIN, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: 1230, beltID: 40001, oreGrade: null,
    oreValuePerM3: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null,
  } as SpaceEntity;
}

function space(entities: SpaceEntity[]): SpaceSnapshot {
  return {
    inSpace: true, solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1, entities,
    ship: {
      itemID: 9001, typeID: 17476, name: "Procurer", mode: null, maxVelocity: 100, radius: 100,
      position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
      shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
      overloadedModuleIDs: null, moduleDamage: null, weaponBanks: null,
    },
  };
}

const home: HomeTravelDecider = () => ({
  action: { kind: "wait" }, why: "home", phase: "Heading home", armed: true, outcome: { kind: "acting" }, nextMem: {},
});

function script(program: readonly ProgramNode[]): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null },
    interrupts: [{ id: "floor", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" }],
    program,
  };
}

const REFUSED_WARP = "CALL_REFUSED: You cannot warp there right now.";
const REFUSED_LOCK = "CALL_REFUSED: TargetNotWithinRangeGeneric";

/** The runner, the real macros, and an `issue` that throws whatever `refuse` says. */
function rig(
  program: readonly ProgramNode[],
  observation: () => ScriptObservation,
  refuse: (action: ScriptAction) => string | null,
  registry: Record<string, MacroDecider> = SCRIPT_MACROS as unknown as Record<string, MacroDecider>,
) {
  const issued: ScriptAction[] = [];
  const runner = createScriptRunner({
    observe: async () => observation(),
    issue: async (action) => {
      issued.push(action);
      const words = refuse(action);
      if (words !== null) {
        throw new Error(words);
      }
      return null;
    },
    sleep: async () => {},
    onProgress: () => {},
    isSessionLost: () => false,
    refusalReason: (error) => (error instanceof Error ? error.message : String(error)),
    registry: registry as never,
    travelHome: home,
  });
  runner.start(script(program));
  const run = async (ticks: number, until: () => boolean = () => false): Promise<void> => {
    for (let i = 0; i < ticks && runner.getStatus() === "running" && !until(); i += 1) {
      await runner.tick();
    }
  };
  return { runner, issued, run };
}

const oreSite = (label: string, x: number) => ({ label, kind: "ore" as const, position: { x, y: 0, z: 0 } });
const warpStep: MacroStep = { id: "w", kind: "macro", macro: "warp-to-ore-anomaly", args: {} };
const marker: MacroStep = { id: "u", kind: "macro", macro: "undock", args: {} };
const mineStep: MacroStep = {
  id: "m", kind: "macro", macro: "mine-at-belt",
  args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
  until: { kind: "ore-hold-at-least", fraction: 0.9 },
};

/** `undock` stands in for "the block after the warp": reaching it proves the warp step finished. */
function withMarker() {
  const state = { reached: false };
  const registry = {
    ...(SCRIPT_MACROS as unknown as Record<string, MacroDecider>),
    undock: ((_step, _obs) => {
      state.reached = true;
      return { action: { kind: "wait" }, why: "reached", phase: "Reached", armed: true, outcome: { kind: "done" }, nextMem: {} };
    }) as MacroDecider,
  };
  return { state, registry };
}

const warpScans = (issued: readonly ScriptAction[]) =>
  issued.filter((a): a is Extract<ScriptAction, { kind: "warpScan" }> => a.kind === "warpScan");

test("warp-to-ore-anomaly: a refused warp from INSIDE the site is one press, then the step is done", async () => {
  const { state, registry } = withMarker();
  const world = calm({
    snapshot: space([]),
    anomalies: [oreSite("ORE-111", 100_000)], // 100 km: under the server's own 150 km warp floor
    completedWarps: 3,
  });
  const { issued, run, runner } = rig(
    [warpStep, marker],
    () => world,
    (action) => (action.kind === "warpScan" ? REFUSED_WARP : null),
    registry,
  );
  await run(60, () => state.reached);
  assert.equal(warpScans(issued).length, 1, "pressed once, not until the ten-refusal cap");
  assert.equal(state.reached, true, "the step finished and the program moved on");
  assert.notEqual(runner.snapshot().phase, "Heading home");
});

test("warp-to-ore-anomaly: a refused site is set aside and the OTHER site gets the next warp", async () => {
  const world = calm({
    snapshot: space([]),
    anomalies: [oreSite("GUN-001", 4 * AU), oreSite("GUV-002", 6 * AU)],
    completedWarps: 3,
  });
  const { issued, run } = rig(
    [warpStep],
    () => world,
    (action) => (action.kind === "warpScan" && action.target === "GUN-001" ? REFUSED_WARP : null),
  );
  await run(60, () => warpScans(issued).length >= 2);
  assert.deepEqual(
    warpScans(issued).map((a) => a.target),
    ["GUN-001", "GUV-002"],
    "the refused label is not asked for again",
  );
});

test("mine-at-belt: a lock refused for range is NOT re-pressed at an unchanged distance, and is once the rock is 20% closer", async () => {
  let x = 60_000;
  const { issued, run, runner } = rig(
    [mineStep],
    () => calm({ snapshot: space([rock(50001, x)]), miningModuleIDs: [700], maxTargetRangeM: null }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
  );
  const locks = () => issued.filter((a) => a.kind === "lock").length;
  await run(40);
  assert.equal(locks(), 1, "one refused lock, then the block holds instead of spending the refusal cap");
  assert.equal(runner.getStatus(), "running", "and the ship is not sent home");

  x = 47_000; // under 0.8 x the refused distance
  await run(40, () => locks() >= 2);
  assert.equal(locks(), 2, "real progress buys a second press");
});

test("mine-at-belt: with a known lock range nothing is pressed beyond it, and one lock goes out once inside", async () => {
  let x = 60_000;
  const { issued, run, runner } = rig(
    [mineStep],
    () => calm({ snapshot: space([rock(50001, x)]), miningModuleIDs: [700], maxTargetRangeM: 40_000 }),
    (action) => (action.kind === "lock" ? REFUSED_LOCK : null),
  );
  const locks = () => issued.filter((a) => a.kind === "lock").length;
  await run(40);
  assert.equal(locks(), 0, "beyond the lock range the block closes in and presses nothing");
  assert.equal(runner.getStatus(), "running");

  x = 39_000;
  await run(40, () => locks() >= 1);
  assert.equal(locks(), 1, "inside it, one lock");
});
