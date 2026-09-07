// B1 — the macro adapters. Each block is an independent "task": it decides ONE
// action per tick and confirms by re-reading next tick, composing the SAME
// proven calls the mining/mission bots fire (undock, warp, orbit, lock,
// activate, unload, launch/engage drones). No new ship control — the block model
// over the existing engine, driven by the player's blocks.
//
// Stoppers (ore hold full, low health, a pirate) are NOT the block's job: the
// player's `until` and the "always watching" interrupts handle them in the
// orchestrator. A block just does its task and reports done / blocked.

import type {
  CompleteMacroRegistry,
  HomeTravelDecider,
  MacroDecider,
  MacroMemory,
  MacroTick,
  ScriptBoard,
} from "./scriptDecide.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import { BOARD_SLOT_KEY } from "../bots/botScript.ts";
import type { MacroStep, WorldRef } from "../bots/botScript.ts";
import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import { BELT_ARRIVAL_RADIUS_M, holdItemIDs, isMineableRock } from "./miningBotLoop.ts";
import {
  agentActionID,
  cargoRoom,
  completeActionID,
  completed,
  findPackageStack,
  gateOffer,
  missionAccepted,
  packageAboard,
} from "./missionBotLoop.ts";
import { decideCloseIn, measureSpace, type SpaceMeasurement } from "./autopilotLoop.ts";
import { canMyShipOrderDrone, hostileRows, type OverviewRow } from "../space/overview.ts";
import { compressionFacilities } from "../space/compression.ts";
import { AGENT_BUTTON } from "../bridge/agents.ts";

const WAIT = { kind: "wait" } as const;
const ACTING = { kind: "acting" } as const;

const ORBIT_RANGE_M = 5000; // the operator's "orbit of 5km" — inside mining range
// The "close enough to activate" check, kept DELIBERATELY BELOW even a basic
// mining laser or strip miner's ~10-15km optimal range (same margin style as
// SALVAGE_RANGE_M and ORBIT_BOOST_RANGE_M/REMOTE_ASSIST_RANGE_M below) — the
// orbit command targets 5km, but an orbit holds APPROXIMATELY that radius, not
// exactly it, so gating "in range" on the same 5km the orbit aims for meant a
// ship settling at 6-7km could circle forever without ever reading as close
// enough to try. Checking against this wider, still-safe floor instead lets
// the orbit's normal wobble stay inside the range that matters.
const MINING_RANGE_M = 10_000;
const DOCK_RANGE_M = 2500; // dock once this close (retail's docking radius)
const MAX_LOCK_WAIT_TICKS = 8; // ~16s acquiring one rock before moving on
const RECALL_MAX_WAIT_TICKS = 15; // ~30s waiting for drones home before we leave anyway

function tick(
  action: MacroTick["action"],
  why: string,
  phase: string,
  outcome: MacroTick["outcome"],
  armed = true,
  nextMem: MacroMemory = {},
): MacroTick {
  return { action, why, phase, armed, outcome, nextMem };
}

function num(mem: MacroMemory, key: string): number | null {
  const value = mem[key];
  return typeof value === "number" ? value : null;
}
function flag(mem: MacroMemory, key: string): boolean {
  return mem[key] === true;
}

/** Nearest entity in a set, by measured surface distance (unknown sorts last). */
function nearest(entities: readonly SpaceEntity[], measurement: SpaceMeasurement | null): SpaceEntity | null {
  let best: SpaceEntity | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const entity of entities) {
    const dist = measurement?.distances.get(entity.itemID) ?? Number.POSITIVE_INFINITY;
    if (dist < bestDist) {
      best = entity;
      bestDist = dist;
    }
  }
  return best;
}

/** The drones out in space that THIS ship can order home (controlled by this hull). */
function myDroneIDs(snapshot: SpaceSnapshot | null): readonly number[] {
  if (snapshot === null) {
    return [];
  }
  const shipID = snapshot.ship?.itemID ?? null;
  return snapshot.entities.filter((e) => canMyShipOrderDrone(e, shipID) === true).map((e) => e.itemID);
}

/**
 * Before a block warps AWAY from the grid, don't abandon the drones. The standard
 * move: call them home ONCE, align toward the exit so the ship is ready to warp,
 * and hold there until 0 drones are left in space — then return null so the caller
 * warps out already aligned. Bounded by `recallWaited`: if they never make it home
 * we leave anyway rather than sit forever. `target` is where we're headed (what to
 * align to); null skips the align and just waits.
 */
function recallBeforeLeaving(
  obs: ScriptObservation,
  mem: MacroMemory,
  phase: string,
  target: number | null,
): MacroTick | null {
  // 0 drones still in space → nothing to wait for; the caller may warp out.
  if (obs.dronesOut !== true) {
    return null;
  }
  const ids = myDroneIDs(obs.snapshot ?? null);
  if (ids.length === 0) {
    return null;
  }
  const waited = num(mem, "recallWaited") ?? 0;
  if (waited > RECALL_MAX_WAIT_TICKS) {
    return null; // waited long enough; leaving now beats never leaving
  }
  if (!flag(mem, "recalled")) {
    return tick(
      { kind: "recallDrones", droneIDs: ids },
      "Calling the drones home before we leave.",
      phase,
      ACTING,
      false,
      { ...mem, recalled: true, recallWaited: 0 },
    );
  }
  if (target !== null && !flag(mem, "aligned")) {
    return tick(
      { kind: "align", targetID: target },
      "Aligning out while the drones come home.",
      phase,
      ACTING,
      false,
      { ...mem, aligned: true, recallWaited: waited + 1 },
    );
  }
  return tick(
    WAIT,
    "Holding aligned until every drone is back in.",
    phase,
    ACTING,
    false,
    { ...mem, recallWaited: waited + 1 },
  );
}

/**
 * The station id a station-arg points at. Three ways to say it: a chosen id, the
 * STARTING station, or a NAMED BOARD SLOT filled in by an earlier block ("the
 * agent's station", "the mission's drop-off"). The slot reads the run board, so
 * a bot follows whatever agent/mission it actually picked up; an unfilled slot
 * reads null, which the callers treat as "not set yet" rather than guessing.
 */
export function resolveStationRef(
  ref: WorldRef,
  startingStationID: number | null,
  board: ScriptBoard = {},
): number | null {
  if (ref.slot !== undefined) {
    return boardNum(board, BOARD_SLOT_KEY[ref.slot]);
  }
  if (ref.starting === true) {
    return startingStationID;
  }
  return ref.id;
}

function stationTarget(step: MacroStep, obs: ScriptObservation, board: ScriptBoard = {}): number | null {
  const arg = step.args["station"];
  if (arg === undefined || arg.kind !== "station") {
    return null;
  }
  return resolveStationRef(arg.ref, obs.startingStationID ?? null, board);
}

function rockLabel(rock: SpaceEntity): string {
  return rock.name ?? "a rock";
}

/** True when a step pins a specific belt rather than "nearest". */
function isChosenBelt(step: MacroStep): boolean {
  const arg = step.args["belt"];
  return arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen";
}

/**
 * The belt a mine-at-belt step should head for when no rocks are in range.
 * "chosen" pins one belt by NAME (never id — unlike a station, a belt's id is
 * grid-local, not globally stable, so it can only be re-resolved against what
 * is actually on THIS grid, the same way "nearest" already is). No match on
 * this grid comes back null so the caller can block rather than silently
 * drifting to the wrong belt.
 */
function beltTarget(
  step: MacroStep,
  belts: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
): SpaceEntity | null {
  const arg = step.args["belt"];
  if (arg !== undefined && arg.kind === "belt" && arg.belt.mode === "chosen") {
    const ref = arg.belt.ref;
    return ref.name !== null ? (belts.find((b) => b.name === ref.name) ?? null) : null;
  }
  return nearest(belts, measurement);
}

/**
 * Which rock to work next. Default (and the shipped behaviour) is the NEAREST;
 * "biggest" reaches for the most ore left instead, which means fewer rock changes
 * per hold for a strip miner.
 *
 * ⚠ `remainingQuantity` IS NULL FOR UNKNOWN, NEVER ZERO (the snapshot is explicit
 * about this because a zero reads as a mined-out rock and would send a miner past
 * a full belt). So an unknown-amount rock is not treated as empty: it sorts after
 * every known one, and if NOTHING is known the pick falls back to nearest rather
 * than picking arbitrarily.
 */
function pickRock(
  step: MacroStep,
  rocks: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
): SpaceEntity | null {
  const arg = step.args["pick"];
  if (arg === undefined || arg.kind !== "rockPick" || arg.pick !== "biggest") {
    return nearest(rocks, measurement);
  }
  let best: SpaceEntity | null = null;
  let bestLeft = -1;
  for (const rock of rocks) {
    const left = rock.remainingQuantity;
    if (left !== null && left > bestLeft) {
      best = rock;
      bestLeft = left;
    }
  }
  return best ?? nearest(rocks, measurement);
}

// ── undock ───────────────────────────────────────────────────────────────────
const undock: MacroDecider = (_step, obs) => {
  const docked = obs.flightStatus?.docked ?? null;
  if (docked === false) {
    return tick(WAIT, "Already out in space.", "Leaving the station", { kind: "done" });
  }
  if (docked === true) {
    return tick({ kind: "undock" }, "Leaving the station.", "Leaving the station", ACTING, false);
  }
  return tick(WAIT, "Waiting for the ship to say where it is.", "Leaving the station", ACTING, false);
};

// ── travel-to-belt ───────────────────────────────────────────────────────────
// Warp to a belt — a pinned one, or the nearest — and stop once on grid with
// it. No rocks, no locking: just the trip, for a hauler heading out to pick up
// a jetcan without ever sitting down to mine. Reuses mine-at-belt's own
// beltTarget/isChosenBelt (below) so "pin a belt" behaves identically in both.
const travelToBelt: MacroDecider = (step, obs) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Flying to the belt", ACTING, false, {});
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Getting ready", ACTING, false, {});
  }
  const measurement = measureSpace(snapshot);
  const belts = snapshot.entities.filter((e) => /belt/i.test(e.name ?? ""));
  const belt = beltTarget(step, belts, measurement);
  if (belt === null) {
    const reason = isChosenBelt(step)
      ? "The belt this step is pinned to is not on this grid."
      : "There is no asteroid belt here to fly to.";
    return tick(WAIT, "No asteroid belt in view.", "Nothing to fly to", { kind: "blocked", reason });
  }
  const beltDist = measurement?.distances.get(belt.itemID) ?? Number.POSITIVE_INFINITY;
  if (beltDist <= BELT_ARRIVAL_RADIUS_M) {
    return tick(WAIT, "At the belt.", "Arrived", { kind: "done" });
  }
  return tick({ kind: "warp", targetID: belt.itemID }, `Warping to ${rockLabel(belt)}.`, "Flying to the belt", ACTING, false, {});
};

// ── mine-at-belt ───────────────────────────────────────────────────────────
// Find the nearest rock, orbit it at 5km, lock it, run the miners, and when it
// is gone pick the next — warping to the step's belt (a pinned one, or else
// the nearest) first if no rock is in range. The player's `until` (ore hold
// full) is what ends the block.
const mineAtBelt: MacroDecider = (step, obs, mem) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Flying to the belt", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Getting ready", ACTING, false, mem);
  }

  const measurement = measureSpace(snapshot);
  const rocks = snapshot.entities.filter(isMineableRock);

  if (rocks.length === 0) {
    // No rocks in range. If we are already sitting on the right belt, it is
    // mined out; otherwise fly there to find some.
    const belts = snapshot.entities.filter((e) => /belt/i.test(e.name ?? ""));
    const belt = beltTarget(step, belts, measurement);
    if (belt === null) {
      const reason = isChosenBelt(step)
        ? "The belt this step is pinned to is not on this grid."
        : "There is no asteroid belt here to mine at.";
      return tick(WAIT, "No asteroid belt in view to mine at.", "Nothing to mine", {
        kind: "blocked",
        reason,
      });
    }
    const beltDist = measurement?.distances.get(belt.itemID) ?? Number.POSITIVE_INFINITY;
    if (beltDist <= BELT_ARRIVAL_RADIUS_M) {
      return tick(WAIT, "At the belt, but there are no rocks left.", "Belt empty", {
        kind: "blocked",
        reason: "This belt has no rocks left to mine.",
      });
    }
    return tick({ kind: "warp", targetID: belt.itemID }, `Warping to ${rockLabel(belt)}.`, "Flying to the belt", ACTING, false, {});
  }

  // We have rocks. Track the one we are working.
  let rockID = num(mem, "rockID");
  const present = rockID !== null && rocks.some((r) => r.itemID === rockID);
  if (!present) {
    rockID = null;
  }

  if (rockID === null) {
    const pick = pickRock(step, rocks, measurement);
    if (pick === null) {
      return tick(WAIT, "Nothing pickable to mine.", "Picking a rock", ACTING, true, {});
    }
    // Orbit the new rock at 5km to get into mining range; lock next tick.
    return tick(
      { kind: "orbit", targetID: pick.itemID, range: ORBIT_RANGE_M },
      `Closing in on ${rockLabel(pick)}.`,
      "Approaching a rock",
      ACTING,
      true,
      { rockID: pick.itemID, lockIssued: false, waited: 0, approachedRockID: pick.itemID },
    );
  }

  const locked = (obs.lockedTargetIDs ?? []).includes(rockID);
  if (!locked) {
    if (!flag(mem, "lockIssued")) {
      return tick({ kind: "lock", targetID: rockID }, "Locking the rock.", "Locking on", ACTING, true, {
        rockID,
        lockIssued: true,
        waited: 0,
        approachedRockID: num(mem, "approachedRockID"),
      });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      // It will not lock — let it go and pick another next tick.
      return tick(WAIT, "That rock would not lock, so moving on.", "Picking another rock", ACTING, true, {});
    }
    return tick(WAIT, "Waiting for the lock.", "Locking on", ACTING, true, {
      rockID,
      lockIssued: true,
      waited,
      approachedRockID: num(mem, "approachedRockID"),
    });
  }

  // Locked, but a lock reaches much further than the mining equipment does — a
  // rock picked far across the belt can land its lock well before the orbit
  // issued above has actually closed the distance. Same check repHurtMate and
  // the combat engage do: measure, and if still out of range, close in before
  // ever trying to switch the equipment on rather than silently doing nothing.
  const rockDist = measurement?.distances.get(rockID) ?? null;
  const outOfRange = rockDist !== null && rockDist > MINING_RANGE_M;
  if (outOfRange) {
    if (num(mem, "approachedRockID") !== rockID) {
      return tick(
        { kind: "orbit", targetID: rockID, range: ORBIT_RANGE_M },
        "Closing in — too far out to mine yet.",
        "Approaching a rock",
        ACTING,
        true,
        { rockID, lockIssued: true, waited: 0, approachedRockID: rockID },
      );
    }
    return tick(WAIT, "Closing in — too far out to mine yet.", "Approaching a rock", ACTING, true, {
      rockID,
      lockIssued: true,
      waited: 0,
      approachedRockID: rockID,
    });
  }

  // Locked and in range — switch on any mining module that is not already cycling.
  //
  // ⚠ AN EMPTY LIST IS NOT "NOTHING LEFT TO SWITCH ON". `miningModuleIDs` is
  // auto-detected from the ship's fit (flow.ts's `resolveMiningModuleIDs`, by
  // high-slot + the game's own mining group names) — if that comes back empty
  // (a fit that failed to load, or a module whose group never resolved), the
  // `.find()` below would ALSO report "nothing left to activate" and this
  // block would silently declare "Mining the rock" having never issued an
  // activate at all. Reported as blocked instead, so a genuinely fitted-but-
  // undetected miner is not indistinguishable from a fully spun-up one.
  const miners = obs.miningModuleIDs ?? [];
  if (miners.length === 0) {
    return tick(WAIT, "No mining equipment was found fitted to this ship.", "No miners fitted", {
      kind: "blocked",
      reason: "No mining equipment was found fitted to this ship.",
    });
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  const nextMiner = miners.find((id) => !active.has(id));
  if (nextMiner !== undefined) {
    return tick(
      { kind: "activate", moduleID: nextMiner, targetID: rockID },
      "Switching the mining equipment on.",
      "Mining",
      ACTING,
      true,
      { rockID, lockIssued: true, waited: 0, approachedRockID: rockID },
    );
  }
  return tick(WAIT, "Mining the rock.", "Mining", ACTING, true, { rockID, lockIssued: true, waited: 0, approachedRockID: rockID });
};

// ── deliver-ore ──────────────────────────────────────────────────────────────
// Fly to the station — same system or across the map, on the SHARED autopilot —
// and unload; done once the hold is empty AT THE TARGET (an unload anywhere
// else would scatter the ore across stations).
const deliverOre: MacroDecider = (step, obs, mem, board) => {
  const target = stationTarget(step, obs, board);
  if (target === null) {
    return tick(WAIT, "No station picked to unload at.", "Hauling", {
      kind: "blocked",
      reason: "This step needs a station to unload at.",
    });
  }
  if (obs.flightStatus?.docked === true && obs.flightStatus.stationID === target) {
    const items = holdItemIDs(obs.holds ?? null);
    if (items.length > 0) {
      return tick({ kind: "unloadOre", itemIDs: items }, "Unloading the ore into the hangar.", "Unloading", ACTING);
    }
    return tick(WAIT, "The ore is unloaded.", "Done hauling", { kind: "done" });
  }
  // Heading out to haul — never warp off with drones still out. Align only to a
  // target actually on this grid; off-grid, the recall just holds.
  const onGrid = (obs.snapshot?.entities ?? []).some((e) => e.itemID === target);
  const recall = recallBeforeLeaving(obs, mem, "Hauling", onGrid ? target : null);
  if (recall !== null) {
    return recall;
  }
  const ride = rideAutopilotTo(obs, target, "Flying to the station");
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Arrived to unload.", "Docking", ACTING, false);
};

// ── travel-to-station ────────────────────────────────────────────────────────
// Fly to ANY station and dock — same system or across the map. The trip rides
// the SHARED autopilot (route solver, gate jumps, the R24 dock ladder), so this
// block is a destination plus the never-abandon-drones send-off.
const travelToStation: MacroDecider = (step, obs, mem, board) => {
  const target = stationTarget(step, obs, board);
  if (target === null) {
    return tick(WAIT, "No station picked.", "Travelling", { kind: "blocked", reason: "This step needs a station to go to." });
  }
  if (obs.flightStatus?.docked === true && obs.flightStatus.stationID === target) {
    return tick(WAIT, "Docked.", "Arrived", { kind: "done" });
  }
  // Align only to something actually on this grid; off-grid, recall just holds.
  const onGrid = (obs.snapshot?.entities ?? []).some((e) => e.itemID === target);
  const recall = recallBeforeLeaving(obs, mem, "Travelling", onGrid ? target : null);
  if (recall !== null) {
    return recall;
  }
  const ride = rideAutopilotTo(obs, target, "Travelling");
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Docked.", "Arrived", { kind: "done" });
};

// ── defend-with-drones ───────────────────────────────────────────────────────
// Launch combat drones, set them on the nearest pirate, and finish once the
// pirates are gone.
const defendWithDrones: MacroDecider = (_step, obs, mem) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Not in space, so nothing to defend against.", "Defending", { kind: "done" });
  }
  if (obs.dronesOut !== true) {
    const bay = obs.droneBayItemIDs ?? [];
    if (bay.length === 0) {
      return tick(WAIT, "No combat drones in the bay.", "Defending", {
        kind: "blocked",
        reason: "There are no combat drones in the bay to launch.",
      });
    }
    return tick({ kind: "launchDrones", droneItemIDs: bay }, "Launching the combat drones.", "Launching drones", ACTING);
  }
  const shipID = snapshot.ship?.itemID ?? null;
  const myDrones = snapshot.entities.filter((e) => canMyShipOrderDrone(e, shipID) === true).map((e) => e.itemID);
  const origin = snapshot.ship?.position ?? { x: 0, y: 0, z: 0 };
  const target = hostileRows(snapshot, origin)[0]?.itemID ?? null;
  if (target === null) {
    // The pirates are gone. Bring the drones home BEFORE finishing — the block
    // is done only once they are actually back, so the loop never warps off to
    // the next task and abandons them.
    if (myDrones.length > 0) {
      return tick({ kind: "recallDrones", droneIDs: myDrones }, "The pirates are gone — calling the drones back in.", "Recalling drones", ACTING);
    }
    return tick(WAIT, "The drones are back; nothing left to fight.", "Defending", { kind: "done" });
  }
  if (myDrones.length === 0) {
    return tick(WAIT, "No drones we can command out here.", "Defending", { kind: "done" });
  }
  if (num(mem, "engaged") === target) {
    return tick(WAIT, "The drones are on the pirate.", "Fighting", ACTING);
  }
  return tick(
    { kind: "engageDrones", droneIDs: myDrones, targetID: target },
    "Sending the drones onto the pirate.",
    "Fighting",
    ACTING,
    true,
    { engaged: target },
  );
};

// ═══ The distribution-mission set ═══════════════════════════════════════════
// Each block is one operation of the PROVEN mission-bot loop, reusing its
// helpers verbatim (agentActionID / missionAccepted / findPackageStack /
// packageAboard / gateOffer). Cross-block facts (the agent, the mission) ride
// the run BOARD; each block confirms by re-read, one action per tick.

const MAX_BLOCK_ATTEMPTS = 5; // presses/moves per block before it says so and stops

function boardNum(board: ScriptBoard, key: string): number | null {
  const value = board[key];
  return typeof value === "number" ? value : null;
}

/** The agent this mission step works with: its own pick, or the board's. */
function stepAgentID(step: MacroStep, board: ScriptBoard): number | null {
  const arg = step.args["agent"];
  if (arg !== undefined && arg.kind === "agent" && arg.ref.id !== null) {
    return arg.ref.id;
  }
  return boardNum(board, "agentID");
}

function countArg(step: MacroStep, key: string): number | null {
  const arg = step.args[key];
  return arg !== undefined && arg.kind === "count" ? arg.value : null;
}

/** Riding the shared autopilot to a station, multi-system. Null once docked there. */
function rideAutopilotTo(obs: ScriptObservation, stationID: number, phase: string): MacroTick | null {
  if (obs.flightStatus?.docked === true && obs.flightStatus.stationID === stationID) {
    return null; // arrived
  }
  const travel = obs.travel ?? null;
  // Only a failure on THIS destination blocks — a stale reason left over from an
  // earlier route (or an abort the bot itself issued at start) must not.
  if (travel !== null && travel.failureReason !== null && travel.destinationStationID === stationID) {
    return tick(WAIT, travel.failureReason, phase, {
      kind: "blocked",
      reason: `The trip could not be finished: ${travel.failureReason}`,
    });
  }
  if (travel !== null && travel.status === "running" && travel.destinationStationID === stationID) {
    return tick(WAIT, "Flying there — the autopilot has the ship.", phase, ACTING, false);
  }
  return tick({ kind: "startRoute", stationID }, "Setting the destination and heading out.", phase, ACTING, false);
}

// ── find-*-agent ─────────────────────────────────────────────────────────────
// Publish the search criteria (incl. the agent KIND) on the board; the flow runs
// the search and hands back the best match as obs.foundAgent; remember it for
// the blocks after. One factory, two blocks: delivery and combat agents.
function makeFindAgent(kindWord: string, finderKind: string): MacroDecider {
  return (step, obs, _mem, board) => {
    if (boardNum(board, "agentID") !== null) {
      return tick(WAIT, "An agent is already picked for this run.", "Finding an agent", { kind: "done" });
    }
    const found = obs.foundAgent ?? null;
    if (found !== null) {
      return {
        ...tick(WAIT, `Found a ${kindWord} agent to work with.`, "Finding an agent", { kind: "done" }),
        boardPatch: {
          agentID: found.agentID,
          agentStationID: found.stationID,
          agentName: found.name,
          agentStationName: found.stationName,
        },
      };
    }
    // Publish the criteria (once) so the flow's next read can run the search.
    return {
      ...tick(WAIT, `Searching for a ${kindWord} agent.`, "Finding an agent", ACTING, false),
      boardPatch: {
        findKind: finderKind,
        findLevel: countArg(step, "level") ?? 1,
        findMaxJumps: countArg(step, "maxJumps"),
        findCorpID: (() => {
          const corp = step.args["corporation"];
          return corp !== undefined && corp.kind === "corp" ? corp.id : null;
        })(),
      },
    };
  };
}
const findDistributionAgent: MacroDecider = makeFindAgent("delivery", "courier");
const findCombatAgent: MacroDecider = makeFindAgent("combat", "encounter");

// ── request-mission ──────────────────────────────────────────────────────────
// Fly to the agent's station, dock, and press Request. Done when an offer (or an
// already-accepted mission) is on the table.
const requestMission: MacroDecider = (step, obs, mem, board) => {
  const agentID = stepAgentID(step, board);
  if (agentID === null) {
    return tick(WAIT, "No agent picked or found.", "Asking for work", {
      kind: "blocked",
      reason: "Put a Find-an-agent block before this one, or pick an agent on this step.",
    });
  }
  // An override pick lands on the board so the later blocks use the same agent.
  const patch: Record<string, number | string | null> =
    boardNum(board, "agentID") === agentID ? {} : { agentID };
  if (missionAccepted(obs.journal ?? null, agentID) === true) {
    return { ...tick(WAIT, "A mission is already accepted.", "Asking for work", { kind: "done" }), boardPatch: patch };
  }
  const agentStationID = boardNum(board, "agentStationID");
  if (agentStationID !== null) {
    const ride = rideAutopilotTo(obs, agentStationID, "Flying to the agent");
    if (ride !== null) {
      return { ...ride, boardPatch: patch };
    }
  } else if (obs.flightStatus?.docked === true && obs.flightStatus.stationID !== null) {
    // No station known for a hand-picked agent: assume they are at THIS station
    // (the practical case), and remember it as the return point.
    patch["agentStationID"] = obs.flightStatus.stationID;
  } else {
    return tick(WAIT, "This step needs to start docked with its agent when the agent was picked by hand.", "Asking for work", {
      kind: "blocked",
      reason: "Dock at the picked agent's station first, or use a Find-an-agent block.",
    });
  }
  if (obs.briefing !== undefined && obs.briefing !== null) {
    return { ...tick(WAIT, "The agent has an offer on the table.", "Asking for work", { kind: "done" }), boardPatch: patch };
  }
  const conversation = obs.conversation ?? null;
  if (conversation === null) {
    return { ...tick(WAIT, "Talking to the agent.", "Asking for work", ACTING, false), boardPatch: patch };
  }
  const requestID = agentActionID(conversation, AGENT_BUTTON.REQUEST_MISSION);
  if (requestID === null) {
    return { ...tick(WAIT, "Waiting for the agent to offer work.", "Asking for work", ACTING, false), boardPatch: patch };
  }
  const asked = (num(mem, "asked") ?? 0) + 1;
  if (asked > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The agent kept not offering a mission.", "Asking for work", {
      kind: "blocked",
      reason: "The agent would not offer a mission after several asks.",
    });
  }
  return {
    ...tick(
      { kind: "agentButton", agentID, actionID: requestID, label: "Request Mission" },
      "Asking the agent for a mission.",
      "Asking for work",
      ACTING,
      false,
      { asked },
    ),
    boardPatch: patch,
  };
};

// ── accept-mission ───────────────────────────────────────────────────────────
// Gate the offer (cargo fits, trip length), then Accept — or Decline and ask
// again, bounded. Done once the journal says the mission is accepted.
/**
 * Why this offer cannot be JUDGED yet, or null when every reading it needs is in.
 *
 * Only the blind cases live here. "The cargo will not fit" and "that is further
 * than your limit" are real verdicts and stay in `gateOffer`; these are the ones
 * where the bot has simply not been told yet, and the honest answer is to wait a
 * tick rather than throw the job away.
 */
function unreadableOffer(
  briefing: ScriptObservation["briefing"] | null,
  obs: ScriptObservation,
  maxJumps: number | null,
): string | null {
  if (briefing === null || briefing === undefined) {
    return null; // no offer on the table at all — the caller asks for one
  }
  const isCourier = briefing.cargoTypeID !== null;
  if (isCourier) {
    if (briefing.cargoVolume === null) {
      return "Waiting for the offer to say how big the cargo is.";
    }
    if (cargoRoom(obs.cargo ?? null) === null) {
      return "Waiting for the ship to report its cargo hold.";
    }
  }
  // The jump gate is only owed a reading when the player actually set a ceiling.
  if (maxJumps !== null && briefing.destinationSystemID !== null && (obs.jumpsToDropoff ?? null) === null) {
    return "Waiting for a route to the delivery point.";
  }
  return null;
}

const acceptMission: MacroDecider = (step, obs, mem, board) => {
  const agentID = stepAgentID(step, board);
  if (agentID === null) {
    return tick(WAIT, "No agent picked or found.", "Accepting", {
      kind: "blocked",
      reason: "Put a Find-an-agent block before this one, or pick an agent on this step.",
    });
  }
  if (missionAccepted(obs.journal ?? null, agentID) === true) {
    const briefing = obs.briefing ?? null;
    return {
      ...tick(WAIT, "The mission is accepted.", "Accepting", { kind: "done" }),
      boardPatch: {
        cargoTypeID: briefing?.cargoTypeID ?? null,
        cargoQuantity: briefing?.cargoQuantity ?? null,
        pickupStationID: briefing?.pickupLocationID ?? null,
        dropoffStationID: briefing?.destinationLocationID ?? null,
      },
    };
  }
  const conversation = obs.conversation ?? null;
  const briefing = obs.briefing ?? null;
  if (conversation === null) {
    return tick(WAIT, "Talking to the agent.", "Accepting", ACTING, false, mem);
  }
  const rounds = num(mem, "rounds") ?? 0;
  if (rounds > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "No acceptable offer after several tries.", "Accepting", {
      kind: "blocked",
      reason: "The agent kept offering jobs outside your limits, so the bot stopped.",
    });
  }
  const maxJumps = countArg(step, "maxJumps");
  // ⚠ A READING WE DO NOT HAVE IS NOT A REASON TO TURN A JOB DOWN. Declining is
  // an irreversible act against the agent — it burns the offer and starts a
  // decline timer — so it must never be the answer to "I could not see".
  //
  // Watched live 2026-07-26: the first tick after docking gated on a cargo hold
  // that had not been read yet and the bot DECLINED a perfectly good courier
  // job, reason "Your ship did not report how much room its cargo hold has".
  // `gateOffer` folds cannot-tell and fails-the-gate into one string, which is
  // fine for a readout and wrong for a decision, so the unreadable cases are
  // pulled out here and answered with a WAIT instead.
  //
  // Bounded like everything else: the wait spends a round, so a reading that
  // never arrives ends as a blocked step with its own reason rather than a
  // silent forever-wait.
  const blind = unreadableOffer(briefing, obs, maxJumps);
  if (blind !== null) {
    if (rounds >= MAX_BLOCK_ATTEMPTS) {
      return tick(WAIT, blind, "Accepting", {
        kind: "blocked",
        reason: `The bot could not read enough to judge the offer: ${blind}`,
      });
    }
    return tick(WAIT, blind, "Accepting", ACTING, false, { ...mem, rounds: rounds + 1 });
  }
  if (briefing !== null) {
    // A COURIER offer names cargo and gets the full volume + jumps gate; an
    // ENCOUNTER offer names none, so only the player's jump ceiling applies.
    const hasCargo = briefing.cargoTypeID !== null && briefing.cargoVolume !== null;
    // ⚠ NO CEILING MEANS THE ROUTE DOES NOT MATTER. `gateOffer` turns a job down
    // when it has no jump count at all — right when a limit is in play, wrong
    // when there is none, because then the number was never going to be used.
    // A stand-in 0 against an unbounded ceiling keeps that gate out of the way
    // instead of declining a job over a number nobody asked about.
    const jumpsForGate = maxJumps === null ? 0 : (obs.jumpsToDropoff ?? null);
    const reason = hasCargo
      ? gateOffer(briefing, obs.cargo ?? null, jumpsForGate, {
          agentID,
          agentName: null,
          agentStationID: 0,
          agentStationName: null,
          maxJumps: maxJumps ?? Number.MAX_SAFE_INTEGER,
          maxMissions: 0,
        })
      : (maxJumps !== null && obs.jumpsToDropoff !== undefined && obs.jumpsToDropoff !== null && obs.jumpsToDropoff > maxJumps
          ? `The job is ${obs.jumpsToDropoff} jumps away and you set a limit of ${maxJumps}, so the bot turned it down.`
          : null);
    if (reason === null) {
      const acceptID = agentActionID(conversation, AGENT_BUTTON.ACCEPT) ?? agentActionID(conversation, AGENT_BUTTON.ACCEPT_REMOTELY);
      if (acceptID === null) {
        return tick(WAIT, "The offer has no way to accept it yet.", "Accepting", ACTING, false, mem);
      }
      return tick(
        { kind: "agentButton", agentID, actionID: acceptID, label: "Accept" },
        "Taking the job.",
        "Accepting",
        ACTING,
        false,
        { rounds: rounds + 1 },
      );
    }
    // The offer fails a gate: turn it down, then ask for another.
    const declineID = agentActionID(conversation, AGENT_BUTTON.DECLINE);
    if (declineID !== null) {
      return tick(
        { kind: "agentButton", agentID, actionID: declineID, label: "Decline" },
        reason,
        "Accepting",
        ACTING,
        false,
        { rounds: rounds + 1 },
      );
    }
    return tick(WAIT, reason, "Accepting", ACTING, false, { rounds: rounds + 1 });
  }
  // No offer on the table — ask for one (covers the after-a-decline case).
  const requestID = agentActionID(conversation, AGENT_BUTTON.REQUEST_MISSION);
  if (requestID !== null) {
    return tick(
      { kind: "agentButton", agentID, actionID: requestID, label: "Request Mission" },
      "Asking for another offer.",
      "Accepting",
      ACTING,
      false,
      { rounds: rounds + 1 },
    );
  }
  return tick(WAIT, "Waiting for the agent's offer.", "Accepting", ACTING, false, mem);
};

// ── load-mission-cargo ───────────────────────────────────────────────────────
// Move the package from the pickup hangar into the ship, and confirm it is
// really aboard before calling itself done — never trusting the 200.
const loadMissionCargo: MacroDecider = (_step, obs, mem, board) => {
  const briefing = obs.briefing ?? null;
  const typeID = briefing?.cargoTypeID ?? boardNum(board, "cargoTypeID");
  const quantity = briefing?.cargoQuantity ?? boardNum(board, "cargoQuantity");
  if (typeID === null || quantity === null) {
    return tick(WAIT, "No mission cargo to load.", "Loading cargo", {
      kind: "blocked",
      reason: "There is no accepted mission naming cargo to load — accept one first.",
    });
  }
  if (packageAboard(obs.cargo ?? null, briefing) === true) {
    return tick(WAIT, "The mission cargo is aboard.", "Loading cargo", { kind: "done" });
  }
  const pickup = briefing?.pickupLocationID ?? boardNum(board, "pickupStationID");
  if (pickup !== null) {
    const ride = rideAutopilotTo(obs, pickup, "Flying to the pickup");
    if (ride !== null) {
      return ride;
    }
  }
  const attempts = num(mem, "attempts") ?? 0;
  if (attempts > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The cargo would not load.", "Loading cargo", {
      kind: "blocked",
      reason: "The mission cargo could not be moved aboard after several tries.",
    });
  }
  const stack = findPackageStack(obs.stationHangar ?? null, typeID, quantity);
  if (stack.item === null) {
    return tick(WAIT, "Looking for the mission package in the hangar.", "Loading cargo", ACTING, false, {
      attempts: attempts + 1,
    });
  }
  return tick(
    { kind: "loadMissionCargo", typeID, quantity },
    stack.sure ? "Moving the package into the ship." : "Moving what looks like the package into the ship.",
    "Loading cargo",
    ACTING,
    false,
    { attempts: attempts + 1 },
  );
};

// ── travel-to-dropoff ────────────────────────────────────────────────────────
const travelToDropoff: MacroDecider = (_step, obs, _mem, board) => {
  const dropoff = (obs.briefing ?? null)?.destinationLocationID ?? boardNum(board, "dropoffStationID");
  if (dropoff === null) {
    return tick(WAIT, "No delivery destination.", "Flying the delivery", {
      kind: "blocked",
      reason: "There is no accepted mission naming a drop-off station.",
    });
  }
  const ride = rideAutopilotTo(obs, dropoff, "Flying the delivery");
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Docked at the drop-off.", "Flying the delivery", { kind: "done" });
};

// ── turn-in-mission ──────────────────────────────────────────────────────────
// At the drop-off: put the package in the hangar, then tell the agent. Done only
// when the agent's own answer says the mission completed.
const turnInMission: MacroDecider = (_step, obs, mem, board) => {
  const agentID = boardNum(board, "agentID");
  if (agentID === null) {
    return tick(WAIT, "No agent for this run.", "Turning in", {
      kind: "blocked",
      reason: "This run has no agent to turn the mission in to.",
    });
  }
  if (missionAccepted(obs.journal ?? null, agentID) === false) {
    return tick(WAIT, "The mission is turned in.", "Turning in", { kind: "done" });
  }
  const attempts = num(mem, "attempts") ?? 0;
  if (attempts > MAX_BLOCK_ATTEMPTS * 2) {
    return tick(WAIT, "The mission would not complete.", "Turning in", {
      kind: "blocked",
      reason: "The agent kept not completing the mission, so the bot stopped.",
    });
  }
  // The package goes into the drop-off hangar first.
  const typeID = boardNum(board, "cargoTypeID");
  if (typeID !== null && obs.cargo != null) {
    const aboard = obs.cargo.rows.filter((row) => row.typeID === typeID).map((row) => row.itemID);
    if (aboard.length > 0) {
      return tick(
        { kind: "unloadMissionCargo", itemIDs: aboard },
        "Handing the cargo over.",
        "Turning in",
        ACTING,
        false,
        { attempts: attempts + 1 },
      );
    }
  }
  const conversation = obs.conversation ?? null;
  if (completed(conversation)) {
    return tick(WAIT, "The agent confirmed the job is done.", "Turning in", { kind: "done" });
  }
  if (conversation === null) {
    return tick(WAIT, "Telling the agent.", "Turning in", ACTING, false, { attempts: attempts + 1 });
  }
  const completeID = completeActionID(conversation);
  if (completeID === null) {
    return tick(WAIT, "The agent is not offering to complete the job yet.", "Turning in", ACTING, false, {
      attempts: attempts + 1,
    });
  }
  return tick(
    { kind: "agentButton", agentID, actionID: completeID, label: "Complete Mission" },
    "Turning the mission in.",
    "Turning in",
    ACTING,
    false,
    { attempts: attempts + 1 },
  );
};

// ── wait ─────────────────────────────────────────────────────────────────────
// A plain delay: do nothing for N seconds (default 10), counted in ticks off the
// runner's own cadence — no clock reads, so it is pure and testable. ARMED from
// tick one, so a player's `until` ("stop when shields are back over 80%") can end
// it early — which turns the same block into "wait for X".
const SCRIPT_TICK_SECONDS = 2; // must match scriptRunner's SCRIPT_CADENCE_MS
const waitBlock: MacroDecider = (step, _obs, mem) => {
  const seconds = countArg(step, "seconds") ?? 10;
  const needed = Math.max(1, Math.ceil(seconds / SCRIPT_TICK_SECONDS));
  const ticked = (num(mem, "ticked") ?? 0) + 1;
  if (ticked >= needed) {
    return tick(WAIT, "Done waiting.", "Waiting", { kind: "done" });
  }
  const remaining = Math.max(0, seconds - ticked * SCRIPT_TICK_SECONDS);
  return tick(WAIT, `Waiting — about ${remaining} seconds left.`, "Waiting", ACTING, true, { ticked });
};

// ── unload-cargo ─────────────────────────────────────────────────────────────
// Docked: move EVERYTHING in the cargo hold into the station hangar. Done only
// when a fresh cargo read shows the hold empty — a 200 is not an empty hold.
const unloadCargo: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked, so there is no hangar to unload into.", "Emptying the hold", {
      kind: "blocked",
      reason: "Dock at a station first — this block empties your cargo into its hangar.",
    });
  }
  const cargo = obs.cargo ?? null;
  if (cargo === null) {
    return tick(WAIT, "Reading the cargo hold.", "Emptying the hold", ACTING, false, mem);
  }
  if (cargo.rows.length === 0) {
    return tick(WAIT, "The cargo hold is empty.", "Emptying the hold", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The cargo would not move.", "Emptying the hold", {
      kind: "blocked",
      reason: "The station kept refusing the cargo, so the bot stopped.",
    });
  }
  return tick(
    { kind: "unloadMissionCargo", itemIDs: cargo.rows.map((row) => row.itemID) },
    "Moving the cargo into the hangar.",
    "Emptying the hold",
    ACTING,
    false,
    { attempts },
  );
};

// ── return-to-agent ──────────────────────────────────────────────────────────
const returnToAgent: MacroDecider = (_step, obs, _mem, board) => {
  const station = boardNum(board, "agentStationID");
  if (station === null) {
    return tick(WAIT, "No agent station to return to.", "Heading back", {
      kind: "blocked",
      reason: "This run has no remembered agent station to go back to.",
    });
  }
  const ride = rideAutopilotTo(obs, station, "Heading back to the agent");
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Back at the agent's station.", "Heading back", { kind: "done" });
};

// ── salvage-wrecks / loot-wrecks ─────────────────────────────────────────────

const LOOT_RANGE_M = 2400; // open a wreck inside retail's 2,500 m, with margin
const SALVAGE_RANGE_M = 4500; // run a salvager inside its ~5-6 km range
const SALVAGE_REISSUE_TICKS = 5; // re-point idle salvage drones every ~10 s

function wrecksOnGrid(snapshot: SpaceSnapshot | null): readonly SpaceEntity[] {
  return (snapshot?.entities ?? []).filter((e) => e.kind === "wreck");
}

/** A wreck that is YOURS to open — owned by you or your corp. Unknown owner = NO. */
function isOwnWreck(wreck: SpaceEntity, obs: ScriptObservation): boolean {
  const me = obs.myCharacterID ?? null;
  const corp = obs.myCorporationID ?? null;
  if (wreck.ownerID === null) {
    return false; // cannot tell whose it is — never open it
  }
  return (me !== null && wreck.ownerID === me) || (corp !== null && wreck.ownerID === corp);
}

// Salvage the grid: salvage drones sweep on auto-pick; fitted salvagers run the
// nearest wreck through the approach→lock→activate ladder. Done (drones home)
// when no wrecks remain. Salvaging any wreck is legal — only LOOTING is gated.
const salvageWrecks: MacroDecider = (_step, obs, mem) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Salvaging", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Salvaging", ACTING, false, mem);
  }
  const wrecks = wrecksOnGrid(snapshot);
  const myDrones = myDroneIDs(snapshot);
  if (wrecks.length === 0) {
    // Swept clean — bring the drones home before finishing (never abandon them).
    if (myDrones.length > 0) {
      return tick({ kind: "recallDrones", droneIDs: myDrones }, "All salvaged — calling the drones home.", "Salvaging", ACTING);
    }
    return tick(WAIT, "Nothing left to salvage.", "Salvaging", { kind: "done" });
  }

  // Drones out: point them at wrecks (auto-pick), re-issued on a slow beat so a
  // drone that finished one wreck moves to the next without micromanagement.
  if (myDrones.length > 0) {
    const sinceIssue = (num(mem, "sinceIssue") ?? SALVAGE_REISSUE_TICKS) + 1;
    if (sinceIssue > SALVAGE_REISSUE_TICKS) {
      return tick(
        { kind: "salvageDrones", droneIDs: myDrones, targetID: 0 },
        "Setting the drones on the wrecks.",
        "Salvaging",
        ACTING,
        true,
        { ...mem, sinceIssue: 0 },
      );
    }
    // Fall through with the beat advanced: the MODULE ladder below still runs
    // this tick if salvagers are fitted; otherwise we wait while the drones work.
    mem = { ...mem, sinceIssue };
  }

  const salvagers = obs.salvageModuleIDs ?? [];
  if (salvagers.length === 0) {
    if (myDrones.length > 0) {
      return tick(WAIT, "The drones are working the wrecks.", "Salvaging", ACTING, true, mem);
    }
    if ((obs.droneBayItemIDs ?? []).length > 0) {
      return tick({ kind: "launchDrones", droneItemIDs: obs.droneBayItemIDs ?? [] }, "Launching the drones to salvage.", "Salvaging", ACTING, true, mem);
    }
    return tick(WAIT, "No way to salvage.", "Salvaging", {
      kind: "blocked",
      reason: "This ship has no salvage drones in the bay and no salvager fitted.",
    });
  }

  // The module ladder, one wreck at a time — the mine block's shape on a wreck.
  const measurement = measureSpace(snapshot);
  let wreckID = num(mem, "wreckID");
  if (wreckID !== null && !wrecks.some((w) => w.itemID === wreckID)) {
    wreckID = null; // it salvaged away — pick the next
  }
  if (wreckID === null) {
    const pick = nearest(wrecks, measurement);
    if (pick === null) {
      return tick(WAIT, "Nothing pickable to salvage.", "Salvaging", ACTING, true, { ...mem, wreckID: null });
    }
    return tick(
      { kind: "approach", targetID: pick.itemID },
      "Closing in on a wreck.",
      "Salvaging",
      ACTING,
      true,
      { ...mem, wreckID: pick.itemID, lockIssued: false, waited: 0 },
    );
  }
  const dist = measurement?.distances.get(wreckID) ?? Number.POSITIVE_INFINITY;
  if (dist > SALVAGE_RANGE_M) {
    return tick(WAIT, "Flying to the wreck.", "Salvaging", ACTING, true, mem);
  }
  const locked = (obs.lockedTargetIDs ?? []).includes(wreckID);
  if (!locked) {
    if (!flag(mem, "lockIssued")) {
      return tick({ kind: "lock", targetID: wreckID }, "Locking the wreck.", "Salvaging", ACTING, true, { ...mem, lockIssued: true, waited: 0 });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      return tick(WAIT, "That wreck would not lock — moving on.", "Salvaging", ACTING, true, { ...mem, wreckID: null });
    }
    return tick(WAIT, "Waiting for the lock.", "Salvaging", ACTING, true, { ...mem, waited });
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  const nextSalvager = salvagers.find((id) => !active.has(id));
  if (nextSalvager !== undefined) {
    return tick(
      { kind: "activate", moduleID: nextSalvager, targetID: wreckID },
      "Running the salvager on the wreck.",
      "Salvaging",
      ACTING,
      true,
      mem,
    );
  }
  return tick(WAIT, "Salvaging the wreck.", "Salvaging", ACTING, true, mem);
};

// Loot YOUR OWN wrecks, nearest first: fly inside loot range, empty it, mark it,
// next. A wreck whose owner cannot be read is NEVER opened — that is the whole
// "no can flipping" rule, structural rather than polite.
const lootWrecks: MacroDecider = (_step, obs, mem) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Looting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Looting", ACTING, false, mem);
  }
  const lootedRaw = mem["looted"];
  const looted = new Set<number>(Array.isArray(lootedRaw) ? (lootedRaw as number[]) : []);
  const mine = wrecksOnGrid(snapshot).filter((w) => isOwnWreck(w, obs) && !looted.has(w.itemID));
  if (mine.length === 0) {
    return tick(WAIT, "Every wreck of yours here is emptied.", "Looting", { kind: "done" });
  }
  const measurement = measureSpace(snapshot);
  const target = nearest(mine, measurement);
  if (target === null) {
    return tick(WAIT, "Nothing reachable to loot.", "Looting", ACTING, true, mem);
  }
  const dist = measurement?.distances.get(target.itemID) ?? Number.POSITIVE_INFINITY;
  if (dist > LOOT_RANGE_M) {
    if (num(mem, "approaching") === target.itemID) {
      return tick(WAIT, "Flying to your wreck.", "Looting", ACTING, true, mem);
    }
    return tick(
      { kind: "approach", targetID: target.itemID },
      "Heading for your wreck.",
      "Looting",
      ACTING,
      true,
      { ...mem, approaching: target.itemID },
    );
  }
  // In range: empty it and mark it done (the flow's transfer verifies the move;
  // an empty wreck is a no-op either way).
  return tick(
    { kind: "lootWreck", wreckID: target.itemID },
    "Taking what's inside.",
    "Looting",
    ACTING,
    true,
    { ...mem, approaching: null, looted: [...looted, target.itemID] },
  );
};

// ── loot-containers ───────────────────────────────────────────────────────────

function containersOnGrid(snapshot: SpaceSnapshot | null): readonly SpaceEntity[] {
  return (snapshot?.entities ?? []).filter((e) => e.kind === "container");
}

// How long to keep checking an apparently-empty grid before believing it —
// generous on purpose. This block has nothing better to do than wait for a
// can that has not shown up yet, so there is no cost to giving the snapshot
// plenty of room to catch up rather than racing it.
const CONTAINER_SETTLE_TICKS = 30; // ~2s/tick elsewhere in this file -> roughly a minute

// Loot every container on the grid, nearest first: fly inside loot range, empty
// it, next. No ownership check — this is an emulator, not a client guarding
// real players from can-flipping, and the server enforces none either.
//
// ⚠ NOT MARKED DONE THE INSTANT IT IS ISSUED. flow.ts's lootContainer dispatch
// re-reads the transfer's own result, but nothing here ever saw it — so
// marking a can "looted" the moment the action went out (the old behaviour)
// believed a silently-declined transfer exactly as readily as a real one, and
// moved on leaving the ore sitting in an untouched can. A jetcan despawns the
// instant the SERVER sees it truly empty (any looter, not just this one — see
// jettisonRuntime.js's maybeExpireEmptySpaceContainer) — so "still on grid" IS
// "still has something in it", and re-targeting the same can next tick is
// exactly the retry a decline needs. Only a can that keeps refusing for
// MAX_BLOCK_ATTEMPTS running gets set aside, so a genuinely stuck one does not
// loop the block forever.
const lootContainers: MacroDecider = (_step, obs, mem) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Looting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Looting", ACTING, false, mem);
  }
  const skippedRaw = mem["skipped"];
  const skipped = new Set<number>(Array.isArray(skippedRaw) ? (skippedRaw as number[]) : []);
  const cans = containersOnGrid(snapshot).filter((c) => !skipped.has(c.itemID));
  if (cans.length === 0) {
    // A can that has not shown up in THIS tick's snapshot is not proof the
    // grid never had one — landing on a belt and checking for containers on
    // the very next tick (no natural pause the way a player starting the bot
    // by hand gets) can read one tick ahead of a not-yet-caught-up snapshot.
    // Wait out a short settle window of consecutive empty reads before
    // believing "nothing here" for real, so one stale tick right after
    // arrival does not turn the bot straight back around.
    const emptyChecks = (num(mem, "emptyChecks") ?? 0) + 1;
    if (emptyChecks <= CONTAINER_SETTLE_TICKS) {
      return tick(WAIT, "Checking the grid for containers.", "Looting", ACTING, true, { ...mem, emptyChecks });
    }
    return tick(WAIT, "Every container here is emptied.", "Looting", { kind: "done" });
  }
  // A can IS present this tick — the settle window above was for nothing, and
  // any leftover count from an earlier blip must not linger and delay the
  // eventual "done" once every can here really is emptied.
  const memClean: MacroMemory = { ...mem, emptyChecks: 0 };
  const measurement = measureSpace(snapshot);
  const target = nearest(cans, measurement);
  if (target === null) {
    return tick(WAIT, "Nothing reachable to loot.", "Looting", ACTING, true, memClean);
  }
  const dist = measurement?.distances.get(target.itemID) ?? Number.POSITIVE_INFINITY;
  if (dist > LOOT_RANGE_M) {
    if (num(memClean, "approaching") === target.itemID) {
      return tick(WAIT, "Flying to the container.", "Looting", ACTING, true, memClean);
    }
    return tick(
      { kind: "approach", targetID: target.itemID },
      "Heading for the container.",
      "Looting",
      ACTING,
      true,
      { ...memClean, approaching: target.itemID },
    );
  }
  const triesRaw = memClean["tries"];
  const tries: Record<string, number> =
    triesRaw !== null && typeof triesRaw === "object" ? { ...(triesRaw as Record<string, number>) } : {};
  const targetTries = (tries[target.itemID] ?? 0) + 1;
  if (targetTries > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "That container would not give up its contents.", "Looting", ACTING, true, {
      ...memClean,
      approaching: null,
      skipped: [...skipped, target.itemID],
    });
  }
  tries[target.itemID] = targetTries;
  return tick(
    { kind: "lootContainer", containerID: target.itemID },
    "Taking what's inside.",
    "Looting",
    ACTING,
    true,
    { ...memClean, approaching: null, tries },
  );
};

// ── refine-ore ───────────────────────────────────────────────────────────────
// Docked: refine every ore stack in the station hangar. Ore is the game's own
// Asteroid category (25) on the row — a row whose category CANNOT be read is
// left alone, because refining is destructive (the station taxes it) and
// "cannot tell" never passes. Done when a fresh hangar read shows no ore left.
const CATEGORY_ORE = 25; // retail's Asteroid category — every ore type lives in it

const refineOre: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked, so there is no refinery to use.", "Refining", {
      kind: "blocked",
      reason: "Dock at a station first — this block refines the ore in its hangar.",
    });
  }
  const hangar = obs.stationHangar ?? null;
  if (hangar === null) {
    return tick(WAIT, "Reading the hangar.", "Refining", ACTING, false, mem);
  }
  const ore = hangar.filter((row) => row.categoryID === CATEGORY_ORE && !row.singleton);
  if (ore.length === 0) {
    return tick(WAIT, "No ore left in the hangar.", "Refining", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The refinery kept leaving ore behind.", "Refining", {
      kind: "blocked",
      reason: "The station kept refusing to refine the ore, so the bot stopped.",
    });
  }
  return tick(
    { kind: "reprocessOre", itemIDs: ore.map((row) => row.itemID) },
    `Refining ${ore.length === 1 ? "the ore stack" : `${ore.length} ore stacks`}.`,
    "Refining",
    ACTING,
    false,
    { attempts },
  );
};

// ── hardeners-on ─────────────────────────────────────────────────────────────
// One press at the top of a fight or a trip: switch every fitted hardener and
// damage control on, one per tick, and finish once they are all running.
const hardenersOn: MacroDecider = (_step, obs, mem) => {
  const hardeners = obs.hardenerModuleIDs ?? [];
  if (hardeners.length === 0) {
    return tick(WAIT, "Nothing to harden with.", "Hardening", {
      kind: "blocked",
      reason: "This ship has no hardener or damage control fitted.",
    });
  }
  if (obs.inSpace !== true) {
    return tick(WAIT, "Waiting to be in space (hardeners only run out there).", "Hardening", ACTING, false, mem);
  }
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
  const idle = hardeners.find((id) => !active.has(id));
  if (idle === undefined) {
    return tick(WAIT, "Everything is hardened.", "Hardening", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS * 2) {
    return tick(WAIT, "A hardener would not switch on.", "Hardening", {
      kind: "blocked",
      reason: "A hardener kept refusing to switch on, so the bot stopped.",
    });
  }
  return tick(
    { kind: "activate", moduleID: idle, targetID: 0 },
    "Switching a hardener on.",
    "Hardening",
    ACTING,
    false,
    { attempts },
  );
};

// ── fight-the-rats ───────────────────────────────────────────────────────────
// The full combat loop: nearest pirate first — lock it (bounded), set the drones
// on it, run every idle gun on it; when it dies the list shrinks and the next
// one is picked. Done when the grid is clear AND the drones are back aboard.
// Players on grid are FRIENDLY in this world (operator decision) — only NPC
// hostiles (hostileRows) are ever engaged.
const fightTheRats: MacroDecider = (_step, obs, mem) => {
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Fighting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Fighting", ACTING, false, mem);
  }
  const origin = snapshot.ship?.position ?? { x: 0, y: 0, z: 0 };
  const hostiles = hostileRows(snapshot, origin);
  const myDrones = myDroneIDs(snapshot);

  if (hostiles.length === 0) {
    if (myDrones.length > 0) {
      return tick({ kind: "recallDrones", droneIDs: myDrones }, "Grid clear — calling the drones home.", "Fighting", ACTING);
    }
    return tick(WAIT, "The grid is clear.", "Fighting", { kind: "done" });
  }

  const weapons = obs.weaponModuleIDs ?? [];
  const bay = obs.droneBayItemIDs ?? [];
  if (weapons.length === 0 && myDrones.length === 0 && bay.length === 0) {
    return tick(WAIT, "No way to fight.", "Fighting", {
      kind: "blocked",
      reason: "This ship has no guns fitted and no combat drones in the bay.",
    });
  }

  // Drones out first — they defend on their own the moment they undock.
  if (obs.dronesOut !== true && bay.length > 0) {
    return tick({ kind: "launchDrones", droneItemIDs: bay }, "Launching the drones.", "Fighting", ACTING, true, mem);
  }

  // The primary: nearest hostile (hostileRows is nearest-first), remembered so
  // fire is CONCENTRATED — spread damage kills nothing.
  let targetID = num(mem, "targetID");
  if (targetID !== null && !hostiles.some((h) => h.itemID === targetID)) {
    targetID = null; // it died — next
  }
  if (targetID === null) {
    const primary = hostiles[0]!;
    return tick(
      { kind: "lock", targetID: primary.itemID },
      "Locking the nearest pirate.",
      "Fighting",
      ACTING,
      true,
      { targetID: primary.itemID, lockIssued: true, waited: 0, dronesOn: null },
    );
  }
  const locked = (obs.lockedTargetIDs ?? []).includes(targetID);
  if (!locked) {
    if (!flag(mem, "lockIssued")) {
      return tick({ kind: "lock", targetID }, "Locking the pirate.", "Fighting", ACTING, true, { ...mem, lockIssued: true, waited: 0 });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      return tick(WAIT, "That one would not lock — picking another.", "Fighting", ACTING, true, {});
    }
    return tick(WAIT, "Waiting for the lock.", "Fighting", ACTING, true, { ...mem, waited });
  }

  // Locked: drones onto it once, then every idle gun onto it.
  if (myDrones.length > 0 && num(mem, "dronesOn") !== targetID) {
    return tick(
      { kind: "engageDrones", droneIDs: myDrones, targetID },
      "Setting the drones on it.",
      "Fighting",
      ACTING,
      true,
      { ...mem, dronesOn: targetID },
    );
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  const idleGun = weapons.find((id) => !active.has(id));
  if (idleGun !== undefined) {
    return tick(
      { kind: "activate", moduleID: idleGun, targetID },
      "Guns on the pirate.",
      "Fighting",
      ACTING,
      true,
      mem,
    );
  }
  return tick(WAIT, "Fighting it.", "Fighting", ACTING, true, mem);
};

// ── warp-to-anomaly ──────────────────────────────────────────────────────────
// Read the onboard scanner, warp to the next combat anomaly this run has not
// visited (visited labels live on the BOARD so a repeat loop walks the system's
// dens one by one), and finish once the warp lands. With Fight-the-rats after it
// in a loop, this is the ratting bot.
const WARP_START_WAIT_TICKS = 10; // ~20s for a warp to actually begin

const warpToAnomaly: MacroDecider = (_step, obs, mem, board) => {
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked — there is no scanner to fly on from here.", "Scanning", {
      kind: "blocked",
      reason: "Undock first — put a Leave-the-station block before this one.",
    });
  }
  if (flag(mem, "issued")) {
    if (obs.inWarp === true) {
      return tick(WAIT, "In warp to the den.", "Flying to the den", ACTING, false, { ...mem, sawWarp: true });
    }
    if (flag(mem, "sawWarp")) {
      return tick(WAIT, "Arrived at the den.", "Arrived", { kind: "done" });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > WARP_START_WAIT_TICKS) {
      return tick(WAIT, "The warp never started.", "Scanning", {
        kind: "blocked",
        reason: "The ship would not warp to the den, so the bot stopped.",
      });
    }
    return tick(WAIT, "Waiting for the warp to start.", "Flying to the den", ACTING, false, { ...mem, waited });
  }
  const anomalies = obs.anomalies ?? null;
  if (anomalies === null) {
    return tick(WAIT, "Reading the scanner.", "Scanning", ACTING, false, mem);
  }
  const visited = String(board["anomsVisited"] ?? "")
    .split(",")
    .filter((label) => label.length > 0);
  const next = anomalies.find((label) => !visited.includes(label));
  if (next === undefined) {
    return tick(WAIT, "Every den here has been visited this run.", "Scanning", {
      kind: "blocked",
      reason: "The scanner shows no pirate den left to visit in this system.",
    });
  }
  return {
    ...tick({ kind: "warpScan", target: next }, "Warping to the next den.", "Flying to the den", ACTING, false, {
      issued: true,
      waited: 0,
    }),
    boardPatch: { anomsVisited: [...visited, next].join(",") },
  };
};

// ── refit-ship ───────────────────────────────────────────────────────────────
// The "reship and go" block, docked only: find the saved fitting BY NAME (the id
// is only a same-world hint), board a hull of its ship type from the hangar if
// the active ship is something else, then apply the fitting. Confirmed by
// re-read at each stage: boarding by the active ship's type changing, and the
// apply is issued once (the server pulls modules from this hangar).
const CATEGORY_SHIP_ROW = 6;

const refitShip: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked — refitting happens in a station.", "Refitting", {
      kind: "blocked",
      reason: "Dock at a station first — refitting happens in its hangar.",
    });
  }
  const arg = step.args["fitting"];
  if (arg === undefined || arg.kind !== "fitting" || (arg.fittingID === null && (arg.name === null || arg.name === ""))) {
    return tick(WAIT, "No fitting picked.", "Refitting", {
      kind: "blocked",
      reason: "Pick the saved fitting this step should apply.",
    });
  }
  const library = obs.savedFittings ?? null;
  if (library === null) {
    return tick(WAIT, "Reading your saved fittings.", "Refitting", ACTING, false, mem);
  }
  const fitting =
    library.find((f) => arg.name !== null && f.name === arg.name) ??
    library.find((f) => arg.fittingID !== null && f.fittingID === arg.fittingID) ??
    null;
  if (fitting === null) {
    return tick(WAIT, "That fitting is not in your library.", "Refitting", {
      kind: "blocked",
      reason: `There is no saved fitting called ${arg.name ?? "that"} in your library.`,
    });
  }
  const hangar = obs.stationHangar ?? null;
  const activeShipID = obs.activeShipID ?? null;
  if (hangar === null || activeShipID === null) {
    return tick(WAIT, "Reading the hangar.", "Refitting", ACTING, false, mem);
  }
  const activeRow = hangar.find((row) => row.itemID === activeShipID) ?? null;
  const activeTypeID = activeRow?.typeID ?? null;
  if (activeTypeID !== fitting.shipTypeID) {
    // Wrong hull (or the active ship's row is unreadable): board the right one.
    const candidate = hangar.find(
      (row) => row.categoryID === CATEGORY_SHIP_ROW && row.typeID === fitting.shipTypeID && row.itemID !== activeShipID && row.singleton,
    );
    if (candidate === undefined) {
      return tick(WAIT, "No hull of the fitting's ship type here.", "Refitting", {
        kind: "blocked",
        reason: "There is no ship of that fitting's type in this hangar to board.",
      });
    }
    const boards = (num(mem, "boards") ?? 0) + 1;
    if (boards > MAX_BLOCK_ATTEMPTS) {
      return tick(WAIT, "Boarding kept not landing.", "Refitting", {
        kind: "blocked",
        reason: "The ship swap kept not taking, so the bot stopped.",
      });
    }
    return tick({ kind: "boardShip", shipID: candidate.itemID }, "Boarding the right hull.", "Refitting", ACTING, false, {
      ...mem,
      boards,
    });
  }
  if (flag(mem, "applied")) {
    return tick(WAIT, "The fitting is applied.", "Refitting", { kind: "done" });
  }
  return tick(
    { kind: "applyFitting", fittingID: fitting.fittingID },
    `Applying ${fitting.name}.`,
    "Refitting",
    ACTING,
    false,
    { ...mem, applied: true },
  );
};

// ── move-items ───────────────────────────────────────────────────────────────
// The generic logistics block, docked only: move a picked ITEM between the
// hangar, the cargo hold and the ore hold — a set amount (split off one stack
// per tick) or every stack of it. Confirmed by re-read: done only when the FROM
// place shows the job finished. Unknown rows never count as the item.
const movePlaceRows = (obs: ScriptObservation, place: string): readonly { itemID: number; typeID: number; quantity: number }[] | null => {
  if (place === "hangar") {
    return obs.stationHangar ?? null;
  }
  if (place === "cargo") {
    return obs.cargo?.rows ?? null;
  }
  // ore-hold: the mining-holds read, its "ore" (first specialty) hold.
  const holds = obs.holds ?? null;
  if (holds === null) {
    return null;
  }
  const ore = holds.find((hold) => hold.key !== "cargo" && hold.present) ?? null;
  return ore === null ? [] : (ore.items ?? []);
};

const moveItems: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - moving cargo happens in a station.", "Moving items", {
      kind: "blocked",
      reason: "Dock at a station first - this block moves items between your hangar and holds.",
    });
  }
  const item = step.args["item"];
  const from = step.args["from"];
  const to = step.args["to"];
  if (
    item === undefined || item.kind !== "itemType" || item.typeID === null ||
    from === undefined || from.kind !== "place" ||
    to === undefined || to.kind !== "place" || from.place === to.place
  ) {
    return tick(WAIT, "This step is not fully set up.", "Moving items", {
      kind: "blocked",
      reason: "Pick the item, where it is, and where it goes (two different places).",
    });
  }
  const rows = movePlaceRows(obs, from.place);
  if (rows === null) {
    return tick(WAIT, "Reading what is where.", "Moving items", ACTING, false, mem);
  }
  const stacks = rows.filter((row) => row.typeID === item.typeID);
  const wanted = countArg(step, "amount");
  const movedSoFar = num(mem, "moved") ?? 0;
  const remaining = wanted === null ? null : Math.max(0, wanted - movedSoFar);
  if (stacks.length === 0 || remaining === 0) {
    if (movedSoFar > 0 || stacks.length === 0) {
      return tick(WAIT, "The move is finished.", "Moving items", { kind: "done" });
    }
  }
  if (stacks.length === 0) {
    return tick(WAIT, "None of that item is there.", "Moving items", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS * 2) {
    return tick(WAIT, "The items would not move.", "Moving items", {
      kind: "blocked",
      reason: "The station kept refusing to move those items, so the bot stopped.",
    });
  }
  if (remaining === null) {
    // Move EVERY stack of it in one go; confirm next tick by the FROM re-read.
    return tick(
      { kind: "moveItems", itemIDs: stacks.map((row) => row.itemID), from: from.place, to: to.place, qty: null },
      "Moving it all over.",
      "Moving items",
      ACTING,
      false,
      { ...mem, attempts, moved: movedSoFar },
    );
  }
  // A set amount: one stack per tick, splitting when the stack is bigger.
  const stack = stacks[0]!;
  const take = Math.min(stack.quantity, remaining);
  return tick(
    { kind: "moveItems", itemIDs: [stack.itemID], from: from.place, to: to.place, qty: take < stack.quantity ? take : null },
    `Moving ${take.toLocaleString()} over.`,
    "Moving items",
    ACTING,
    false,
    { ...mem, attempts, moved: movedSoFar + take },
  );
};

// ── warp-to-bookmark ─────────────────────────────────────────────────────────
// Warp to a saved spot, matched BY NAME from the live bookmark list (the id is a
// same-world hint). In-space only, and only in the spot's own system — a saved
// spot two systems over needs a travel block first, and the block says so.
const warpToBookmark: MacroDecider = (step, obs, mem) => {
  const arg = step.args["bookmark"];
  if (arg === undefined || arg.kind !== "bookmark" || (arg.bookmarkID === null && (arg.name === null || arg.name === ""))) {
    return tick(WAIT, "No saved spot picked.", "Warping", {
      kind: "blocked",
      reason: "Pick the saved spot this step warps to.",
    });
  }
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked - warping happens in space.", "Warping", {
      kind: "blocked",
      reason: "Undock first - put a Leave-the-station block before this one.",
    });
  }
  if (flag(mem, "issued")) {
    if (obs.inWarp === true) {
      return tick(WAIT, "In warp to the spot.", "Warping", ACTING, false, { ...mem, sawWarp: true });
    }
    if (flag(mem, "sawWarp")) {
      return tick(WAIT, "Arrived at the spot.", "Arrived", { kind: "done" });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > 10) {
      return tick(WAIT, "The warp never started.", "Warping", {
        kind: "blocked",
        reason: "The ship would not warp to that spot, so the bot stopped.",
      });
    }
    return tick(WAIT, "Waiting for the warp to start.", "Warping", ACTING, false, { ...mem, waited });
  }
  const list = obs.bookmarks ?? null;
  if (list === null) {
    return tick(WAIT, "Reading your saved spots.", "Warping", ACTING, false, mem);
  }
  const match =
    list.find((bm) => arg.name !== null && bm.name === arg.name) ??
    list.find((bm) => arg.bookmarkID !== null && bm.bookmarkID === arg.bookmarkID) ??
    null;
  if (match === null) {
    return tick(WAIT, "That saved spot is not in your list.", "Warping", {
      kind: "blocked",
      reason: `There is no saved spot called ${arg.name ?? "that"} in your bookmarks.`,
    });
  }
  const here = obs.flightStatus?.solarSystemID ?? null;
  if (match.solarSystemID !== null && here !== null && match.solarSystemID !== here) {
    return tick(WAIT, "That spot is in another system.", "Warping", {
      kind: "blocked",
      reason: "That saved spot is in another system - put a travel block before this one.",
    });
  }
  return tick({ kind: "warpBookmark", bookmarkID: match.bookmarkID }, "Warping to the spot.", "Warping", ACTING, false, {
    issued: true,
    waited: 0,
  });
};

// ── fly-to-mission-site ──────────────────────────────────────────────────────
// Warp to the accepted mission's own marked spot: the bookmark the agent filed
// under "Agent Missions". Prefers a bookmark with real coordinates (the site
// itself) over an agent-base marker; in-system only, with a plain travel hint
// otherwise. Done when the warp lands.
const MISSION_FOLDER = "agent missions";

const flyToMissionSite: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked - warping happens in space.", "Flying to the site", {
      kind: "blocked",
      reason: "Undock first - put a Leave-the-station block before this one.",
    });
  }
  if (flag(mem, "issued")) {
    if (obs.inWarp === true) {
      return tick(WAIT, "In warp to the mission site.", "Flying to the site", ACTING, false, { ...mem, sawWarp: true });
    }
    if (flag(mem, "sawWarp")) {
      return tick(WAIT, "Arrived at the mission site.", "Arrived", { kind: "done" });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > 10) {
      return tick(WAIT, "The warp never started.", "Flying to the site", {
        kind: "blocked",
        reason: "The ship would not warp to the mission site, so the bot stopped.",
      });
    }
    return tick(WAIT, "Waiting for the warp to start.", "Flying to the site", ACTING, false, { ...mem, waited });
  }
  const list = obs.bookmarks ?? null;
  if (list === null) {
    return tick(WAIT, "Reading the mission's marked spots.", "Flying to the site", ACTING, false, mem);
  }
  const missionMarks = list.filter(
    (bm) => (bm.folderName ?? "").trim().toLowerCase() === MISSION_FOLDER,
  );
  if (missionMarks.length === 0) {
    return tick(WAIT, "The agent has marked no spot.", "Flying to the site", {
      kind: "blocked",
      reason: "There is no mission spot marked - accept a mission first.",
    });
  }
  const here = obs.flightStatus?.solarSystemID ?? null;
  const inSystem = missionMarks.filter((bm) => bm.solarSystemID === null || here === null || bm.solarSystemID === here);
  if (inSystem.length === 0) {
    return tick(WAIT, "The mission site is in another system.", "Flying to the site", {
      kind: "blocked",
      reason: "The mission site is in another system - put a travel block before this one.",
    });
  }
  const pick = inSystem.find((bm) => bm.hasSpot === true) ?? inSystem[0]!;
  return tick({ kind: "warpBookmark", bookmarkID: pick.bookmarkID }, "Warping to the mission site.", "Flying to the site", ACTING, false, {
    issued: true,
    waited: 0,
  });
};

// ── restart-extractors ───────────────────────────────────────────────────────
// Walk every colony and restart each extractor whose program has EXPIRED — on
// the SAME resource it was already pulling (never a guess). One restart per
// tick, confirmed by the next colonies re-read (the expiry moves into the
// future); a pin with no known last resource is left alone and said so.
const restartExtractors: MacroDecider = (_step, obs, mem) => {
  const colonies = obs.colonies ?? null;
  if (colonies === null) {
    return tick(WAIT, "Reading your planet colonies.", "Restarting extractors", ACTING, false, mem);
  }
  if (colonies.length === 0) {
    return tick(WAIT, "You have no planet colonies.", "Restarting extractors", { kind: "done" });
  }
  const now = Date.now();
  const doneRaw = mem["restarted"];
  const restarted = new Set<number>(Array.isArray(doneRaw) ? (doneRaw as number[]) : []);
  let skippedUnknown = 0;
  for (const colony of colonies) {
    for (const pin of colony.extractors) {
      if (restarted.has(pin.pinID)) {
        continue;
      }
      const expired = pin.expiresAtMs !== null && pin.expiresAtMs <= now;
      const neverRan = pin.expiresAtMs === null;
      if (!expired && !neverRan) {
        continue; // still running — leave it be
      }
      if (pin.resourceTypeID === null) {
        skippedUnknown += 1;
        continue; // no last resource to reuse — never guess what to pull
      }
      const attempts = (num(mem, "attempts") ?? 0) + 1;
      if (attempts > MAX_BLOCK_ATTEMPTS * 4) {
        return tick(WAIT, "The restarts kept not landing.", "Restarting extractors", {
          kind: "blocked",
          reason: "The extractor restarts kept not taking, so the bot stopped.",
        });
      }
      return tick(
        { kind: "restartExtractor", planetID: colony.planetID, pinID: pin.pinID, resourceTypeID: pin.resourceTypeID },
        colony.planetName !== null ? `Restarting an extractor at ${colony.planetName}.` : "Restarting an extractor.",
        "Restarting extractors",
        ACTING,
        false,
        { ...mem, attempts, restarted: [...restarted, pin.pinID] },
      );
    }
  }
  if (skippedUnknown > 0) {
    return tick(
      WAIT,
      `Done - ${skippedUnknown} extractor${skippedUnknown === 1 ? "" : "s"} had no previous programme to reuse and ${skippedUnknown === 1 ? "was" : "were"} left alone.`,
      "Restarting extractors",
      { kind: "done" },
    );
  }
  return tick(WAIT, "Every extractor is running.", "Restarting extractors", { kind: "done" });
};

// ── repair-ship ──────────────────────────────────────────────────────────────
// Docked: the shop's own quote decides what is damaged; repair it; done only
// when a FRESH quote says nothing is left. The wallet charge is the server's.
const repairShip: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - repairs happen at a station.", "Repairing", {
      kind: "blocked",
      reason: "Dock at a station first - this block uses its repair shop.",
    });
  }
  const damaged = obs.damagedItemIDs ?? null;
  if (damaged === null) {
    return tick(WAIT, "Asking the repair shop for a quote.", "Repairing", ACTING, false, mem);
  }
  if (damaged.length === 0) {
    return tick(WAIT, "Nothing needs repairing.", "Repairing", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The shop kept leaving damage unfixed.", "Repairing", {
      kind: "blocked",
      reason: "The repair shop kept not fixing the damage (not enough money?), so the bot stopped.",
    });
  }
  return tick(
    { kind: "repairItems", itemIDs: damaged },
    `Repairing ${damaged.length === 1 ? "the damage" : `${damaged.length} damaged things`}.`,
    "Repairing",
    ACTING,
    false,
    { attempts },
  );
};

// ── buy-item ─────────────────────────────────────────────────────────────────
// Docked: place ONE buy order at this station's market for the picked item, at
// the player's price ceiling, for the quantity they set. One-shot — it places the
// order (the server confirm-gates it and charges the broker fee) and is done; it
// does not wait for the order to fill (a resting order may take time, an
// aggressive price fills at once). Inside a loop it re-orders each lap, by design.
const buyItem: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - orders are placed at a station's market.", "Buying", {
      kind: "blocked",
      reason: "Dock at a station first - this block places a buy order at its market.",
    });
  }
  const item = step.args["item"];
  const qty = step.args["quantity"];
  const price = step.args["price"];
  if (
    item === undefined || item.kind !== "itemType" || item.typeID === null ||
    qty === undefined || qty.kind !== "qty" ||
    price === undefined || price.kind !== "isk"
  ) {
    return tick(WAIT, "This step is not fully set up.", "Buying", {
      kind: "blocked",
      reason: "Pick the item, how many to buy, and the most to pay for each.",
    });
  }
  if (flag(mem, "placed")) {
    return tick(WAIT, "The buy order is placed.", "Buying", { kind: "done" });
  }
  return tick(
    { kind: "placeBuyOrder", typeID: item.typeID, price: price.value, quantity: qty.value },
    `Placing a buy order for ${qty.value.toLocaleString()} at up to ${price.value.toLocaleString()} ISK each.`,
    "Buying",
    ACTING,
    false,
    { ...mem, placed: true },
  );
};

// ── sell-item ────────────────────────────────────────────────────────────────
// Docked: list EVERY stack of the picked item from the hangar onto the market at
// the player's price floor, one order per tick. A listed stack LEAVES the hangar
// (into the order), so the next hangar re-read shows it gone - that is the
// confirmation, no 200 trusted. Done when no stack of the item is left. Only
// plain (non-singleton) stacks are sold, never an assembled ship or module.
const sellItem: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked - selling happens at a station's market.", "Selling", {
      kind: "blocked",
      reason: "Dock at a station first - this block lists your items on its market.",
    });
  }
  const item = step.args["item"];
  const price = step.args["price"];
  if (
    item === undefined || item.kind !== "itemType" || item.typeID === null ||
    price === undefined || price.kind !== "isk"
  ) {
    return tick(WAIT, "This step is not fully set up.", "Selling", {
      kind: "blocked",
      reason: "Pick the item to sell and the least to take for each.",
    });
  }
  const hangar = obs.stationHangar ?? null;
  if (hangar === null) {
    return tick(WAIT, "Reading the hangar.", "Selling", ACTING, false, mem);
  }
  const stacks = hangar.filter((row) => row.typeID === item.typeID && !row.singleton && row.quantity > 0);
  if (stacks.length === 0) {
    return tick(WAIT, "Every stack of that item is listed.", "Selling", { kind: "done" });
  }
  const attempts = (num(mem, "attempts") ?? 0) + 1;
  if (attempts > MAX_BLOCK_ATTEMPTS * 2) {
    return tick(WAIT, "The market kept refusing the sell.", "Selling", {
      kind: "blocked",
      reason: "The market kept not listing the item, so the bot stopped.",
    });
  }
  const stack = stacks[0]!;
  return tick(
    { kind: "placeSellOrder", itemID: stack.itemID, typeID: item.typeID, price: price.value, quantity: stack.quantity },
    `Listing ${stack.quantity.toLocaleString()} at ${price.value.toLocaleString()} ISK each.`,
    "Selling",
    ACTING,
    false,
    { ...mem, attempts },
  );
};

// ═══ The fleet-support set ══════════════════════════════════════════════════
// Remote-repair friendly ships on grid. Players are FRIENDLY in this world
// (operator decision), so a "fleet-mate" is any non-NPC ship on the grid that is
// not your own. Both blocks ride the SAME lock + activate the engine already
// proves; only picking the target (the most-hurt friendly) is new. No new gateway
// read: the space snapshot already carries every ship's health and owner.

const REMOTE_REP_HURT = 0.95; // anyone not essentially full is worth a rep
const ORBIT_BOOST_RANGE_M = 2000; // stay close so remote reps reach

/**
 * How far remote assistance reaches — remote reps and cap transmitters alike.
 *
 * ⚠ DELIBERATELY THE SMALL END, with margin, in the style of `SALVAGE_RANGE_M`.
 * The small modules sit around 5-6 km and the larger ones reach further, so a
 * ship fitted with a big one closes a little more than it strictly had to; that
 * costs seconds. Being generous costs correctness: a limit above what the module
 * can do turns the range check into a machine for spending the attempt budget on
 * refusals.
 *
 * Measured live: a Small Remote Capacitor Transmitter I refused
 * `TargetNotWithinRangeGeneric` at 17.9 km and ran fine at 2.2 km.
 * `ORBIT_BOOST_RANGE_M` (2 km) sits comfortably inside this, so orbit-and-boost's
 * hold always satisfies it.
 */
const REMOTE_ASSIST_RANGE_M = 5000;

/**
 * How many times one target may be offered a remote module that will not come on.
 *
 * ⚠ THIS BOUND WAS MISSING ENTIRELY. Both remote blocks used to return `mem`
 * UNCHANGED after issuing an activate, so a refused module was re-found idle on
 * the next tick and re-fired — forever, with no counter, no progress and no
 * reason surfaced. remote-rep only reports `done` when everyone on grid is full
 * and remote-cap when everyone has cap to spare, so neither could ever finish
 * either: a mate parked out of reach was an infinite loop, which is the exact
 * failure mode the house rule about bounding every branch exists to prevent.
 */
const MAX_REMOTE_ASSIST_ATTEMPTS = 3;

/**
 * Authoritative fleet-mates on grid. Presence, corporation, and alliance are
 * not membership: if the bound-fleet roster is unreadable, callers wait.
 */
function fleetMatesOnGrid(obs: ScriptObservation): readonly SpaceEntity[] | null {
  const snapshot = obs.snapshot ?? null;
  const roster = obs.fleetMemberCharacterIDs ?? null;
  if (snapshot === null || roster === null) {
    return null;
  }
  const memberIDs = new Set(roster);
  const selfID = snapshot.ship?.itemID ?? null;
  if (memberIDs.size === 0) {
    return [];
  }
  return snapshot.entities.filter(
    (e) =>
      e.kind === "ship" &&
      e.isNpc === false &&
      e.isSelf === false &&
      e.itemID !== selfID &&
      e.characterID !== null &&
      memberIDs.has(e.characterID),
  );
}

/** The lowest readable health layer of a ship (shield/armor/hull), or null. */
function lowestShipRatio(e: SpaceEntity): number | null {
  const ratios = [e.shieldRatio, e.armorRatio, e.hullRatio].filter((r): r is number => r !== null);
  return ratios.length === 0 ? null : Math.min(...ratios);
}

/** The most-hurt friendly below the rep threshold, or null when all are full. */
function mostHurtFriendly(friendlies: readonly SpaceEntity[]): SpaceEntity | null {
  let best: SpaceEntity | null = null;
  let bestRatio = REMOTE_REP_HURT;
  for (const e of friendlies) {
    const r = lowestShipRatio(e);
    if (r !== null && r < bestRatio) {
      best = e;
      bestRatio = r;
    }
  }
  return best;
}

function remoteRepIDs(obs: ScriptObservation): readonly number[] {
  return [
    ...(obs.remoteShieldRepairerIDs ?? []),
    ...(obs.remoteArmorRepairerIDs ?? []),
    ...(obs.remoteHullRepairerIDs ?? []),
  ];
}

/**
 * The shared logistics action: lock the hurt fleet-mate (bounded), close on them
 * if the reps cannot reach (bounded), then switch on any idle remote rep onto it.
 * Returns the tick to emit, or null when there is nobody to rep right now — the
 * caller decides what "nothing to rep" means.
 *
 * `mayApproach` is false for orbit-and-boost: that block is ALREADY closing, by
 * orbiting the anchor at `ORBIT_BOOST_RANGE_M`. Issuing an approach from in here
 * as well would fight its own orbit command every tick.
 */
function repHurtMate(
  obs: ScriptObservation,
  mem: MacroMemory,
  phase: string,
  mayApproach = true,
): MacroTick | null {
  const snapshot = obs.snapshot ?? null;
  if (snapshot === null) {
    return null;
  }
  const friendlies = fleetMatesOnGrid(obs);
  if (friendlies === null) {
    return null;
  }
  const target = mostHurtFriendly(friendlies);
  if (target === null) {
    return null;
  }
  const locked = (obs.lockedTargetIDs ?? []).includes(target.itemID);
  if (!locked) {
    if (num(mem, "repLockOn") !== target.itemID) {
      // A NEW mate resets everything counted per-target, or the last one's spent
      // budget silently disarms the reps for this one (the bug the PvP ladder
      // had, where a shared counter outlived the target it was counting for).
      return tick({ kind: "lock", targetID: target.itemID }, "Locking the hurt fleet-mate.", phase, ACTING, true, {
        ...mem,
        repLockOn: target.itemID,
        repWaited: 0,
        repTries: 0,
        repApproached: null,
      });
    }
    const waited = (num(mem, "repWaited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      return tick(WAIT, "That fleet-mate would not lock - watching for another.", phase, ACTING, true, { ...mem, repLockOn: null });
    }
    return tick(WAIT, "Waiting for the lock.", phase, ACTING, true, { ...mem, repWaited: waited });
  }
  // Reps have a range, and a lock reaches much further than they do. Close first
  // (once per target — `approach` is a standing follow order, not a nudge), and
  // do not spend an attempt on a module we can see cannot reach.
  const rangeToMate = measureSpace(snapshot)?.distances.get(target.itemID) ?? null;
  const outOfReach = rangeToMate !== null && rangeToMate > REMOTE_ASSIST_RANGE_M;
  if (outOfReach && mayApproach && num(mem, "repApproached") !== target.itemID) {
    return tick(
      { kind: "approach", targetID: target.itemID },
      "Closing in — too far out for the reps to reach.",
      phase,
      ACTING,
      true,
      { ...mem, repApproached: target.itemID },
    );
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  // ⚠ CONSECUTIVE failures only. A rep that HAS come on refills the budget, so
  // the bound can only ever stop a module that is not landing — never one that is
  // cycling normally and simply needs switching on again. Get this wrong and the
  // "fix" becomes a bot that stops repping mid-fight after three cycles.
  const landed = remoteRepIDs(obs).some((id) => active.has(id));
  const repTries = landed ? 0 : num(mem, "repTries") ?? 0;
  if (!outOfReach && repTries < MAX_REMOTE_ASSIST_ATTEMPTS) {
    const idle = remoteRepIDs(obs).find((id) => !active.has(id));
    if (idle !== undefined) {
      return tick(
        { kind: "activate", moduleID: idle, targetID: target.itemID },
        "Running the remote reps on the fleet-mate.",
        phase,
        ACTING,
        true,
        { ...mem, repTries: repTries + 1 },
      );
    }
  }
  return tick(WAIT, "Repping the fleet-mate.", phase, ACTING, true, mem);
}

// ── remote-rep ───────────────────────────────────────────────────────────────
// Reactive: rep the most-hurt fleet-mate; done once everyone on grid is full.
const remoteRep: MacroDecider = (_step, obs, mem) => {
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp - nothing decided mid-warp.", "Supporting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || obs.snapshot == null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Supporting", ACTING, false, mem);
  }
  if (remoteRepIDs(obs).length === 0) {
    return tick(WAIT, "No remote reps fitted.", "Supporting", {
      kind: "blocked",
      reason: "This ship has no remote shield or armor repairer fitted.",
    });
  }
  if ((obs.fleetMemberCharacterIDs ?? null) === null) {
    return tick(WAIT, "Reading the authoritative fleet roster.", "Supporting", ACTING, false, mem);
  }
  const rep = repHurtMate(obs, mem, "Supporting");
  if (rep === null) {
    return tick(WAIT, "Everyone on grid is at full health.", "Supporting", { kind: "done" });
  }
  return rep;
};

// ── orbit-and-boost ──────────────────────────────────────────────────────────
// Sustained: orbit the nearest fleet-mate up close and keep repping whoever is
// hurt. Never finishes on its own - a watch or the player stops it. Orbits ONCE
// (re-issued only when the anchor changes), so it does not spam orbit commands.
const orbitAndBoost: MacroDecider = (_step, obs, mem) => {
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp - nothing decided mid-warp.", "Boosting", ACTING, false, mem);
  }
  if (obs.inSpace !== true || obs.snapshot == null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Boosting", ACTING, false, mem);
  }
  if (remoteRepIDs(obs).length === 0) {
    return tick(WAIT, "No remote reps fitted.", "Boosting", {
      kind: "blocked",
      reason: "This ship has no remote shield or armor repairer fitted.",
    });
  }
  if ((obs.fleetMemberCharacterIDs ?? null) === null) {
    return tick(WAIT, "Reading the authoritative fleet roster.", "Boosting", ACTING, false, mem);
  }
  const snapshot = obs.snapshot;
  const friendlies = fleetMatesOnGrid(obs) ?? [];
  if (friendlies.length === 0) {
    return tick(WAIT, "No fleet-mate on grid to support yet.", "Boosting", ACTING, false, mem);
  }
  const anchor = nearest(friendlies, measureSpace(snapshot));
  if (anchor !== null && num(mem, "orbiting") !== anchor.itemID) {
    return tick(
      { kind: "orbit", targetID: anchor.itemID, range: ORBIT_BOOST_RANGE_M },
      "Orbiting the fleet-mate to stay in rep range.",
      "Boosting",
      ACTING,
      false,
      { ...mem, orbiting: anchor.itemID },
    );
  }
  // No approach from in here — the orbit above is this block's way of closing.
  const rep = repHurtMate(obs, mem, "Boosting", false);
  if (rep !== null) {
    return rep;
  }
  return tick(WAIT, "Boosting - everyone's healthy for now.", "Boosting", ACTING, false, mem);
};

// ═══ The fleet-management set ═══════════════════════════════════════════════
// Form up / invite / join — the multibox alt-fleeting loop. All confirm-gated
// server-side; each confirms by re-reading the bound-fleet state (`obs.inFleet`,
// which is authoritative: a char with no fleet reads a real "not in a fleet",
// never a blank). ⚠ the WRITES were never fired live — flagged for QA.

// ── create-fleet ─────────────────────────────────────────────────────────────
const createFleet: MacroDecider = (_step, obs, mem) => {
  const inFleet = obs.inFleet ?? null;
  if (inFleet === true) {
    return tick(WAIT, "You are already in a fleet.", "Forming a fleet", { kind: "done" });
  }
  if (inFleet === null) {
    return tick(WAIT, "Checking your fleet status.", "Forming a fleet", ACTING, false, mem);
  }
  const tries = (num(mem, "tries") ?? 0) + 1;
  if (tries > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The fleet would not form.", "Forming a fleet", {
      kind: "blocked",
      reason: "The fleet would not form after several tries, so the bot stopped.",
    });
  }
  return tick({ kind: "createFleet" }, "Forming a fleet.", "Forming a fleet", ACTING, false, { ...mem, tries });
};

// ── invite-to-fleet ──────────────────────────────────────────────────────────
const inviteToFleet: MacroDecider = (step, obs, mem) => {
  const who = step.args["who"];
  if (who === undefined || who.kind !== "character" || who.charID === null) {
    return tick(WAIT, "No pilot picked to invite.", "Inviting", {
      kind: "blocked",
      reason: "Pick the pilot this block invites.",
    });
  }
  const inFleet = obs.inFleet ?? null;
  if (inFleet === null) {
    return tick(WAIT, "Checking your fleet status.", "Inviting", ACTING, false, mem);
  }
  if (inFleet === false) {
    return tick(WAIT, "You are not in a fleet to invite into.", "Inviting", {
      kind: "blocked",
      reason: "Form or join a fleet first - put a Form-a-fleet block before this one.",
    });
  }
  if (flag(mem, "invited")) {
    return tick(WAIT, "The invite is sent.", "Inviting", { kind: "done" });
  }
  return tick(
    { kind: "inviteToFleet", charID: who.charID },
    who.name !== null && who.name.length > 0 ? `Inviting ${who.name} to the fleet.` : "Inviting a pilot to the fleet.",
    "Inviting",
    ACTING,
    false,
    { ...mem, invited: true },
  );
};

// ── join-fleet ───────────────────────────────────────────────────────────────
// Reactive: keep accepting a pending invite until this character is in a fleet.
// Bounded so a bot that is never invited stops rather than trying forever.
const JOIN_MAX_WAIT_TICKS = 150; // a few minutes at the settle-paced cadence
const joinFleet: MacroDecider = (_step, obs, mem) => {
  const inFleet = obs.inFleet ?? null;
  if (inFleet === true) {
    return tick(WAIT, "You are in a fleet now.", "Joining a fleet", { kind: "done" });
  }
  if (inFleet === null) {
    return tick(WAIT, "Checking your fleet status.", "Joining a fleet", ACTING, false, mem);
  }
  const waited = (num(mem, "waited") ?? 0) + 1;
  if (waited > JOIN_MAX_WAIT_TICKS) {
    return tick(WAIT, "No fleet invitation arrived.", "Joining a fleet", {
      kind: "blocked",
      reason: "No fleet invitation arrived in time, so the bot stopped.",
    });
  }
  return tick({ kind: "acceptFleetInvite" }, "Waiting for a fleet invite to accept.", "Joining a fleet", ACTING, false, { ...mem, waited });
};

// ═══ Movement extras ════════════════════════════════════════════════════════

// ── set-destination ──────────────────────────────────────────────────────────
// Point the SHARED autopilot at a station or a whole system and hand the ship
// over. Unlike travel-to-station this does NOT wait for the arrival: it is done
// once the trip is under way, so a player can put their own checks after it.
// A system destination lands in space (no dock) — the autopilot's own
// system-only plan, which the roam already rides.
const setDestination: MacroDecider = (step, obs, mem) => {
  const arg = step.args["destination"];
  if (arg === undefined || arg.kind !== "destination" || arg.ref.id === null) {
    return tick(WAIT, "No destination picked.", "Setting a course", {
      kind: "blocked",
      reason: "Pick where this step should send you.",
    });
  }
  const id = arg.ref.id;
  const toSystem = arg.ref.entity === "system";
  const travel = obs.travel ?? null;
  const targetKey = toSystem ? (travel?.destinationSystemID ?? null) : (travel?.destinationStationID ?? null);
  if (travel !== null && travel.failureReason !== null && targetKey === id) {
    return tick(WAIT, travel.failureReason, "Setting a course", {
      kind: "blocked",
      reason: `The course could not be set: ${travel.failureReason}`,
    });
  }
  // Under way (or already arrived) on THIS destination — the block's job is done.
  if (targetKey === id && travel !== null && travel.status !== "idle") {
    return tick(WAIT, "The autopilot has the ship.", "On course", { kind: "done" });
  }
  if (flag(mem, "issued")) {
    // Give the route a tick or two to appear in the travel reading before we
    // decide it never took (starting a route does a couple of reads first).
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > WARP_START_WAIT_TICKS) {
      return tick(WAIT, "The autopilot never started.", "Setting a course", {
        kind: "blocked",
        reason: "The trip would not start, so the bot stopped.",
      });
    }
    return tick(WAIT, "Setting the course.", "Setting a course", ACTING, false, { ...mem, waited });
  }
  return tick(
    toSystem ? { kind: "startSystemRoute", systemID: id } : { kind: "startRoute", stationID: id },
    "Setting the destination and starting the autopilot.",
    "Setting a course",
    ACTING,
    false,
    { issued: true, waited: 0 },
  );
};

// ── dock-at-nearest ──────────────────────────────────────────────────────────
// The get-inside-now block: the closest station or structure ON THE GRID, right
// now. The same "nearest dockable" pick the panic override makes, promoted to a
// block — and deliberately grid-local, because a station chosen when the script
// was written would not be the nearest one later. Drones come home first (a warp
// with drones out abandons them), then the shared close-in ladder docks it.
const DOCKABLE = new Set(["station", "structure"]);

const dockAtNearest: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked.", "Docking", { kind: "done" });
  }
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Docking", ACTING, false, mem);
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Docking", ACTING, false, mem);
  }
  const measurement = measureSpace(snapshot);
  const docks = snapshot.entities.filter((e) => DOCKABLE.has(e.kind ?? ""));
  const target = nearest(docks, measurement);
  if (target === null) {
    return tick(WAIT, "No station in view.", "Docking", {
      kind: "blocked",
      reason: "There is no station in view here to dock at.",
    });
  }
  const recall = recallBeforeLeaving(obs, mem, "Docking", target.itemID);
  if (recall !== null) {
    return recall;
  }
  const step = decideCloseIn(target.itemID, DOCK_RANGE_M, measurement, num(mem, "closingOn"));
  if (step === null || step.kind === "arrive") {
    return tick({ kind: "dock", stationID: target.itemID }, "Docking at the nearest station.", "Docking", ACTING, false, mem);
  }
  if (step.kind === "closing") {
    return tick(WAIT, "Closing on the station.", "Docking", ACTING, false, mem);
  }
  if (step.kind === "approach") {
    return tick(
      { kind: "approach", targetID: target.itemID },
      "Closing on the station.",
      "Docking",
      ACTING,
      false,
      { ...mem, closingOn: target.itemID },
    );
  }
  return tick({ kind: "warp", targetID: target.itemID }, "Warping to the nearest station.", "Docking", ACTING, false, mem);
};

// ── remote-cap ───────────────────────────────────────────────────────────────
// The cap-chain twin of remote-rep: find the fleet-mate whose capacitor is
// emptiest, lock them, and run the fitted remote capacitor transmitters into
// them. Same shape, same verified calls, a different module family and a
// different reading (the snapshot already carries every ship's capacitorRatio).
const CAP_HUNGRY = 0.9; // below this is worth a cycle

const remoteCap: MacroDecider = (_step, obs, mem) => {
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Feeding cap", ACTING, false, mem);
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", "Feeding cap", ACTING, false, mem);
  }
  const transmitters = obs.remoteCapModuleIDs ?? [];
  if (transmitters.length === 0) {
    return tick(WAIT, "No remote capacitor transmitter fitted.", "Feeding cap", {
      kind: "blocked",
      reason: "This ship has no remote capacitor transmitter fitted.",
    });
  }
  if ((obs.fleetMemberCharacterIDs ?? null) === null) {
    return tick(WAIT, "Reading the authoritative fleet roster.", "Feeding cap", ACTING, false, mem);
  }
  const friendlies = fleetMatesOnGrid(obs) ?? [];
  let target: SpaceEntity | null = null;
  let worst = CAP_HUNGRY;
  for (const mate of friendlies) {
    const cap = mate.capacitorRatio;
    if (cap !== null && cap < worst) {
      target = mate;
      worst = cap;
    }
  }
  if (target === null) {
    return tick(WAIT, "Everyone on grid has capacitor to spare.", "Feeding cap", { kind: "done" });
  }
  const locked = (obs.lockedTargetIDs ?? []).includes(target.itemID);
  if (!locked) {
    if (num(mem, "capLockOn") !== target.itemID) {
      // A new mate resets what is counted per-target (see repHurtMate).
      return tick({ kind: "lock", targetID: target.itemID }, "Locking the fleet-mate who needs cap.", "Feeding cap", ACTING, true, {
        ...mem,
        capLockOn: target.itemID,
        capWaited: 0,
        capTries: 0,
        capApproached: null,
      });
    }
    const waited = (num(mem, "capWaited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      return tick(WAIT, "That fleet-mate would not lock — watching for another.", "Feeding cap", ACTING, true, { ...mem, capLockOn: null });
    }
    return tick(WAIT, "Waiting for the lock.", "Feeding cap", ACTING, true, { ...mem, capWaited: waited });
  }
  // Same two rules as repHurtMate: a transmitter has a range the lock does not,
  // and an activation that will not land has to be bounded.
  const rangeToMate = measureSpace(snapshot)?.distances.get(target.itemID) ?? null;
  const outOfReach = rangeToMate !== null && rangeToMate > REMOTE_ASSIST_RANGE_M;
  if (outOfReach && num(mem, "capApproached") !== target.itemID) {
    return tick(
      { kind: "approach", targetID: target.itemID },
      "Closing in — too far out to pass them cap.",
      "Feeding cap",
      ACTING,
      true,
      { ...mem, capApproached: target.itemID },
    );
  }
  const active = new Set(snapshot.ship?.activeModuleIDs ?? []);
  // Consecutive failures only — see the note in repHurtMate.
  const capTries = transmitters.some((id) => active.has(id)) ? 0 : num(mem, "capTries") ?? 0;
  if (!outOfReach && capTries < MAX_REMOTE_ASSIST_ATTEMPTS) {
    const idle = transmitters.find((id) => !active.has(id));
    if (idle !== undefined) {
      return tick(
        { kind: "activate", moduleID: idle, targetID: target.itemID },
        "Feeding them capacitor.",
        "Feeding cap",
        ACTING,
        true,
        { ...mem, capTries: capTries + 1 },
      );
    }
  }
  return tick(WAIT, "Feeding the fleet-mate cap.", "Feeding cap", ACTING, true, mem);
};

// ═══ Cargo extras ═══════════════════════════════════════════════════════════

// ── jettison-cargo ───────────────────────────────────────────────────────────
// Dump the cargo hold into space as a can — the jetcan a miner fills instead of
// flying home. One item type if the player picked one, otherwise the whole hold.
// Confirmed by re-reading the hold: what was jettisoned has LEFT it, so the
// block is done when nothing matching is aboard. That means a silently refused
// jettison retries within its bound rather than being believed.
const jettisonCargo: MacroDecider = (step, obs, mem) => {
  // Docked is a verdict; unreadable is not (see compress-ore's note).
  if (obs.flightStatus?.docked === true || obs.inSpace === false) {
    return tick(WAIT, "Not in space — a can has to go somewhere.", "Jettisoning", {
      kind: "blocked",
      reason: "Undock first — jettisoning drops a container into space.",
    });
  }
  if (obs.inSpace !== true) {
    return tick(WAIT, "Waiting for the ship to say where it is.", "Jettisoning", ACTING, false, mem);
  }
  const cargo = obs.cargo ?? null;
  if (cargo === null) {
    return tick(WAIT, "Reading the cargo hold.", "Jettisoning", ACTING, false, mem);
  }
  const item = step.args["item"];
  const wanted =
    item !== undefined && item.kind === "itemType" && item.typeID !== null ? item.typeID : null;
  const rows = cargo.rows.filter((row) => wanted === null || row.typeID === wanted);
  if (rows.length === 0) {
    return tick(WAIT, "Nothing left in the hold to jettison.", "Jettisoning", { kind: "done" });
  }
  const tries = (num(mem, "tries") ?? 0) + 1;
  if (tries > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The cargo would not go out.", "Jettisoning", {
      kind: "blocked",
      reason: "The cargo would not jettison after several tries, so the bot stopped.",
    });
  }
  return tick(
    { kind: "jettison", itemIDs: rows.map((row) => row.itemID) },
    "Jettisoning the cargo into space.",
    "Jettisoning",
    ACTING,
    false,
    { ...mem, tries },
  );
};

// ── jettison-ore ─────────────────────────────────────────────────────────────
// The same jetcan-drop as jettison-cargo, but empties the ORE hold (or
// whichever specialty hold — ice, gas — the ship carries) instead: a mining
// ship's own cargo hold sits empty the whole run, so a hauling loop built
// around jettison-cargo has nothing to work with. Same one-item-or-everything
// filter, same retry-then-block on a refused jettison; the only difference is
// which hold it reads.
const jettisonOre: MacroDecider = (step, obs, mem) => {
  if (obs.flightStatus?.docked === true || obs.inSpace === false) {
    return tick(WAIT, "Not in space — a can has to go somewhere.", "Jettisoning", {
      kind: "blocked",
      reason: "Undock first — jettisoning drops a container into space.",
    });
  }
  if (obs.inSpace !== true) {
    return tick(WAIT, "Waiting for the ship to say where it is.", "Jettisoning", ACTING, false, mem);
  }
  const holds = obs.holds ?? null;
  if (holds === null) {
    return tick(WAIT, "Reading the ore hold.", "Jettisoning", ACTING, false, mem);
  }
  // The specialty hold — ore, ice, gas, whichever this hull has — never cargo,
  // same selection move-items already makes for its own "ore-hold" place.
  const oreHold = holds.find((hold) => hold.key !== "cargo" && hold.present) ?? null;
  if (oreHold === null) {
    return tick(WAIT, "This ship has no ore hold.", "Jettisoning", {
      kind: "blocked",
      reason: "This ship has no ore hold to jettison from.",
    });
  }
  const item = step.args["item"];
  const wanted =
    item !== undefined && item.kind === "itemType" && item.typeID !== null ? item.typeID : null;
  const rows = (oreHold.items ?? []).filter((row) => wanted === null || row.typeID === wanted);
  if (rows.length === 0) {
    return tick(WAIT, "Nothing left in the ore hold to jettison.", "Jettisoning", { kind: "done" });
  }
  const tries = (num(mem, "tries") ?? 0) + 1;
  if (tries > MAX_BLOCK_ATTEMPTS) {
    return tick(WAIT, "The ore would not go out.", "Jettisoning", {
      kind: "blocked",
      reason: "The ore would not jettison after several tries, so the bot stopped.",
    });
  }
  return tick(
    { kind: "jettison", itemIDs: rows.map((row) => row.itemID) },
    "Jettisoning the ore into space.",
    "Jettisoning",
    ACTING,
    false,
    { ...mem, tries },
  );
};

// ── tidy-hangar ──────────────────────────────────────────────────────────────
// Stack everything loose in the station hangar. One shot: the server merges what
// it can, and a second pass would find nothing to do — so this issues once and is
// done, rather than trying to prove a stack count went down (which a concurrent
// change would make a lie).
const tidyHangar: MacroDecider = (_step, obs, mem) => {
  if (obs.flightStatus?.docked !== true) {
    return tick(WAIT, "Not docked — the hangar is at a station.", "Tidying", {
      kind: "blocked",
      reason: "Dock at a station first — this block tidies its hangar.",
    });
  }
  if (flag(mem, "stacked")) {
    return tick(WAIT, "The hangar is stacked.", "Tidying", { kind: "done" });
  }
  return tick({ kind: "stackHangar" }, "Stacking the hangar.", "Tidying", ACTING, false, { ...mem, stacked: true });
};

// ── compress-ore ─────────────────────────────────────────────────────────────
// The fleet mechanic: a mining support ship on grid — your own hull or a
// fleet-mate's — running an industrial core plus compression gear is a FACILITY,
// and ore in your own hold can be squeezed to a fraction of its volume while you
// sit inside its range.
//
// ⚠ THE FACILITY IS FOUND FROM A READING, NOT GUESSED. `compressionFacility` is
// projected onto a ship row only while the modules really are running, so the
// block can say "there is no support ship compressing here" instead of firing
// hopefully into the dark — which matters because the server answers "not a
// facility", "out of range" and "this ore has no compressed form" with the SAME
// silence. A ship whose facility reading is absent is simply not a candidate.
//
// ⚠ AND EACH STACK IS JUDGED BY THE HOLD, NOT BY THE ANSWER. A compressed stack
// becomes a different TYPE at the same quantity, so the next hold read shows it
// gone from the ore's type. `triedItemIDs` remembers which stacks have had their
// one attempt, so an ore with no compressed form is skipped after one try rather
// than retried forever — that is what keeps this bounded without pretending the
// refusal told us why.
const COMPRESS_MAX_TRIES_PER_STACK = 1;

// ⚠ THE FACILITY RULE MOVED TO `space/compression.ts`, and this now imports it.
// The Mining panel needs the same answer, and the branch two copies get wrong
// is the `?? null` one — an ABSENT reading has to mean "not a facility", never
// "an unknown worth firing at". One implementation, one place to get it right.

function parseTried(mem: MacroMemory): readonly string[] {
  const raw = mem["triedItemIDs"];
  return typeof raw === "string" && raw.length > 0 ? raw.split(",") : [];
}

const compressOre: MacroDecider = (_step, obs, mem) => {
  // ⚠ DOCKED is a verdict; UNREADABLE is not. `inSpace !== true` would lump the
  // two together and tell a player to undock a ship whose location simply had not
  // been read yet — the "null is never a verdict" rule, in the one place it is
  // easiest to get wrong.
  if (obs.flightStatus?.docked === true || obs.inSpace === false) {
    return tick(WAIT, "Not in space — compression happens at a ship on grid.", "Compressing", {
      kind: "blocked",
      reason: "Undock first — this block uses a support ship out on the grid.",
    });
  }
  if (obs.inSpace !== true) {
    return tick(WAIT, "Waiting for the ship to say where it is.", "Compressing", ACTING, false, mem);
  }
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", "Compressing", ACTING, false, mem);
  }
  const snapshot = obs.snapshot ?? null;
  const holds = obs.holds ?? null;
  if (snapshot === null || holds === null) {
    return tick(WAIT, "Reading the hold.", "Compressing", ACTING, false, mem);
  }

  const tried = parseTried(mem);
  // ⚠ A hold whose read FAILED carries items:null, which is "we could not look",
  // not "it is empty" — so a failed read must not finish the block. Wait for a
  // hold we can actually see rather than declaring the job done.
  if (holds.some((hold) => hold.present && hold.items === null)) {
    return tick(WAIT, "Could not read a hold just now.", "Compressing", ACTING, false, mem);
  }
  // Ore still worth trying: in a hold, and not already given its one attempt.
  const pending = holds
    .flatMap((hold) => hold.items ?? [])
    .filter((item) => !tried.includes(String(item.itemID)));
  if (pending.length === 0) {
    return tick(WAIT, "Nothing left in the hold to compress.", "Compressing", { kind: "done" });
  }

  const facility = compressionFacilities(snapshot)[0] ?? null;
  if (facility === null) {
    return tick(WAIT, "No support ship is compressing here.", "Compressing", {
      kind: "blocked",
      reason:
        "No mining support ship on this grid is running its compression gear — bring one, or switch it on, and try again.",
    });
  }

  // In range? The facility's own reach, which is the number the server checks.
  const measurement = measureSpace(snapshot);
  const isOwnShip = facility.itemID === (snapshot.ship?.itemID ?? null);
  if (!isOwnShip) {
    const distance = measurement?.distances.get(facility.itemID) ?? null;
    const reach = facility.compressionFacility?.rangeMeters ?? 0;
    if (distance !== null && distance > reach) {
      // Close in on it — the same shared ladder every other block uses. Its own
      // range is the arrival radius, so we stop when the server would accept us.
      const step = decideCloseIn(facility.itemID, reach, measurement, num(mem, "closingOn"));
      if (step !== null && step.kind === "closing") {
        return tick(WAIT, "Closing on the support ship.", "Compressing", ACTING, false, mem);
      }
      if (step !== null && step.kind === "warp") {
        return tick({ kind: "warp", targetID: facility.itemID }, "Warping to the support ship.", "Compressing", ACTING, false, mem);
      }
      return tick(
        { kind: "approach", targetID: facility.itemID },
        "Closing on the support ship.",
        "Compressing",
        ACTING,
        false,
        { ...mem, closingOn: facility.itemID },
      );
    }
  }

  const target = pending[0]!;
  return tick(
    { kind: "compressOre", itemID: target.itemID, facilityID: facility.itemID },
    "Compressing a stack of ore.",
    "Compressing",
    ACTING,
    false,
    {
      ...mem,
      closingOn: null,
      triedItemIDs: [...tried, String(target.itemID)].slice(-MAX_TRIED_STACKS).join(","),
    },
  );
};

/** How many attempted stacks to remember — a hold cannot hold more than this. */
const MAX_TRIED_STACKS = 200;

const launchScanProbes: MacroDecider = (_step, obs) => {
  const scanner = obs.scannerOperations;
  if (scanner === null || scanner === undefined) {
    return tick(WAIT, "Could not read the probe launcher just now.", "Launching probes", ACTING, false);
  }
  if (!scanner.inSpace) {
    return tick(WAIT, "The ship must be in space to launch probes.", "Launching probes", {
      kind: "blocked",
      reason: "Launch scan probes needs the ship to be in space.",
    });
  }
  if (scanner.probes.length > 0) {
    return tick(WAIT, "The scan probes are out.", "Launching probes", { kind: "done" });
  }
  if (scanner.launcher === null || scanner.launcher.launchCount <= 0) {
    return tick(WAIT, "No probes are ready in an online launcher.", "Launching probes", {
      kind: "blocked",
      reason: "Fit an online probe launcher with scanner probes and leave room for active probes.",
    });
  }
  return tick(
    { kind: "scannerLaunch" },
    `Launching ${scanner.launcher.launchCount} scan probe${scanner.launcher.launchCount === 1 ? "" : "s"}.`,
    "Launching probes",
    ACTING,
    false,
  );
};

const analyzeSignatures: MacroDecider = (_step, obs, mem) => {
  const scanner = obs.scannerOperations;
  if (scanner === null || scanner === undefined) {
    return tick(WAIT, "Could not read the probe formation just now.", "Analyzing signatures", ACTING, false, mem);
  }
  if (scanner.probes.length === 0) {
    return tick(WAIT, "No active probes can analyze signatures.", "Analyzing signatures", {
      kind: "blocked",
      reason: "Launch scan probes before analyzing signatures.",
    });
  }
  if (flag(mem, "issued")) {
    return tick(WAIT, "The signature analysis was requested.", "Analyzing signatures", { kind: "done" });
  }
  return tick(
    { kind: "scannerAnalyze" },
    "Analyzing signatures with the current probe formation.",
    "Analyzing signatures",
    ACTING,
    false,
    { ...mem, issued: true },
  );
};

const recoverScanProbes: MacroDecider = (_step, obs) => {
  const scanner = obs.scannerOperations;
  if (scanner === null || scanner === undefined) {
    return tick(WAIT, "Could not read the active probes just now.", "Recovering probes", ACTING, false);
  }
  if (scanner.probes.length === 0) {
    return tick(WAIT, "All scan probes are aboard.", "Recovering probes", { kind: "done" });
  }
  return tick(
    { kind: "scannerRecover" },
    `Recovering ${scanner.probes.length} scan probe${scanner.probes.length === 1 ? "" : "s"}.`,
    "Recovering probes",
    ACTING,
    false,
  );
};

/** The registry the runner dispatches on, keyed by MacroID. */
export const SCRIPT_MACROS: CompleteMacroRegistry = {
  undock,
  "travel-to-belt": travelToBelt,
  "mine-at-belt": mineAtBelt,
  "deliver-ore": deliverOre,
  "travel-to-station": travelToStation,
  "defend-with-drones": defendWithDrones,
  "find-distribution-agent": findDistributionAgent,
  "request-mission": requestMission,
  "accept-mission": acceptMission,
  "load-mission-cargo": loadMissionCargo,
  "travel-to-dropoff": travelToDropoff,
  "turn-in-mission": turnInMission,
  "return-to-agent": returnToAgent,
  wait: waitBlock,
  "unload-cargo": unloadCargo,
  "salvage-wrecks": salvageWrecks,
  "loot-wrecks": lootWrecks,
  "loot-containers": lootContainers,
  "refine-ore": refineOre,
  "hardeners-on": hardenersOn,
  "fight-the-rats": fightTheRats,
  "warp-to-anomaly": warpToAnomaly,
  "refit-ship": refitShip,
  "move-items": moveItems,
  "warp-to-bookmark": warpToBookmark,
  "find-combat-agent": findCombatAgent,
  "fly-to-mission-site": flyToMissionSite,
  "restart-extractors": restartExtractors,
  "repair-ship": repairShip,
  "buy-item": buyItem,
  "sell-item": sellItem,
  "remote-rep": remoteRep,
  "orbit-and-boost": orbitAndBoost,
  "create-fleet": createFleet,
  "invite-to-fleet": inviteToFleet,
  "join-fleet": joinFleet,
  "set-destination": setDestination,
  "dock-at-nearest": dockAtNearest,
  "remote-cap": remoteCap,
  "jettison-cargo": jettisonCargo,
  "jettison-ore": jettisonOre,
  "tidy-hangar": tidyHangar,
  "compress-ore": compressOre,
  "launch-scan-probes": launchScanProbes,
  "analyze-signatures": analyzeSignatures,
  "recover-scan-probes": recoverScanProbes,
};

/**
 * Home-travel for a latched "dock and stop" response. `flow.ts` resolves the
 * document's configured home every tick — fixed id, starting station, or a
 * station published onto the run board — and puts the result on the observation.
 * The shared autopilot makes that station reachable from any system.
 */
export const scriptTravelHome: HomeTravelDecider = (obs, mem) => {
  if (obs.flightStatus?.docked === true) {
    // Docked ANYWHERE is safe — the point of a fired watch is to be in a
    // station, not to commute. Stop here.
    return tick(WAIT, "Stopped.", "Heading home", { kind: "done" });
  }
  const target = obs.homeStationID ?? null;
  if (target === null) {
    // Starting in space cannot resolve "where I started" to a station, and a
    // board-slot home may not have been published when an early watch fires.
    // Pausing IN SPACE is not the desired safety outcome, but it is honest and
    // bounded; reporting `done` here used to claim the ship was safe while it
    // was still exposed. Never invent a destination.
    return tick(WAIT, "Home is not known, so the ship stopped instead of guessing.", "Heading home", {
      kind: "blocked",
      reason: "This bot does not know which station is home, so it stopped instead of flying to a guess.",
    });
  }
  const onGrid = (obs.snapshot?.entities ?? []).some((e) => e.itemID === target);
  const recall = recallBeforeLeaving(obs, mem, "Heading home", onGrid ? target : null);
  if (recall !== null) {
    return recall;
  }
  const ride = rideAutopilotTo(obs, target, "Heading home");
  if (ride !== null) {
    return ride;
  }
  return tick(WAIT, "Stopped.", "Heading home", { kind: "done" });
};
