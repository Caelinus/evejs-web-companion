// The CLOSE-IN STALL rung — shared by every ladder that orders the hull to
// close on something and then waits for it to get there.
//
// ⚠ A CLOSE-IN ORDER THE SERVER ACCEPTS AND IGNORES LOOKS EXACTLY LIKE ONE IT
// IS FLYING. `Handle_CmdFollowBall` and `Handle_CmdOrbit` both throw away what
// `spaceRuntime.followBall` / `orbitShipEntity` returned and answer 200/null
// either way, so the bridge reports `ok` for an order that moved nothing — and
// `keepAtRange` is the same server method as approach, so it is the same story
// again. The ONLY honest evidence this client has is the hull's own movement
// mode, the same reading the autopilot's close-in ladder already decides on
// (autopilotLoop.ts `decideCloseIn`). A block that says "flying to the wreck"
// or "closing on the wave" for the rest of the night while the mode says
// otherwise is telling the operator something it has not checked.
//
// ⚠ THE DEADLOCK THIS EXISTS FOR, because a re-issued order alone cannot break
// it. eve.js marks a ship `landingPending` the moment a warp completes and
// commits that landing on a later tick — but only while the hull is STOPped.
// EVERY close-in route this client has sends `CmdSetSpeedFraction(1.0)` first,
// and the speed command is NOT gated on the pending landing while the follow
// and the orbit both ARE: the fraction moves the hull STOP -> GOTO (a straight
// line to a point 1e16 m away), the order after it is refused for the pending
// landing, and the two hold each other — GOTO keeps the landing from ever
// committing, the pending landing keeps every follow and every orbit refused.
// Every command reports success, the hull flies away from the grid, and the
// eventual warp out is refused too (`WARP_LANDING_PENDING`, which arrives as
// "You cannot warp there right now"), which stops the run.
//
// Landing from a warp is when a bot issues its FIRST close-in order of a site,
// so this is not a rare race: it is one lost coin-flip per site, per pilot.
//
// `CmdStop` is the one order NOT gated on the pending landing. It puts the hull
// back in STOP, the server commits the landing on its next tick, and the order
// re-issued after it takes. So the rung is: give the order a grace window,
// re-issue it, and if the hull still is not under course, STOP and try again.
// What a caller does after that is the caller's own call — a travelling block
// has nothing left to do and says so; a fighting block still has guns.
//
// ⚠ THIS IS WHY THE TEST IS ON MODES AND NOT ON DISTANCE. A hull under SOME
// target-relative order is closing on something, however slowly; STOP and GOTO
// are the two readings that prove nothing target-relative is running. The rung
// deliberately cannot tell "orbiting the WRONG rock" from "orbiting ours",
// because the ship's own row carries no `targetEntityID` on this server (see
// ui/shipHud.ts's note) — and a reading it cannot make is one it must not act
// on. Distance was the other candidate and is worse: a slow hull far out is
// indistinguishable from a stopped one for minutes at a time.

import type { SpaceSnapshot } from "../store/types.ts";
import type { MacroMemory } from "./scriptDecide.ts";

/** ~6 s of ordered-to-fly and demonstrably not flying. */
const STALL_TICKS = 3;

export type CloseInStallStep =
  /** Under course (or still inside the grace window) — carry on waiting. */
  | "flying"
  /** The order did not take: send it again — approach, orbit or hold, the caller's own. */
  | "reorder"
  /** It still did not take: stop the hull, which is what frees a stuck landing. */
  | "unstick"
  /** Stopped, re-ordered, and STILL not moving — the hull is not ours to fly. */
  | "stuck";

export interface CloseInStall {
  readonly step: CloseInStallStep;
  readonly mem: MacroMemory;
}

function num(mem: MacroMemory, key: string): number | null {
  const value = mem[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The two modes that PROVE no target-relative order is running. Everything else
 * — FOLLOW, ORBIT, WARP, or a mode this client has never seen — is read as "the
 * hull is doing something", never as a stall, because acting on a reading this
 * client cannot make is how a rung like this breaks working flights.
 */
export function isCourseStalled(mode: string): boolean {
  return /^(stop(ped)?|goto)$/i.test(mode.trim());
}

/**
 * The hull's own movement mode, read the way `measureSpace` reads it: the ship
 * block where it has one, else this pilot's own row in the entity list. Null is
 * "the snapshot did not say", which every caller must treat as unknown.
 */
export function hullMode(snapshot: SpaceSnapshot | null): string | null {
  return snapshot?.ship?.mode ?? snapshot?.entities.find((entity) => entity.isSelf)?.mode ?? null;
}

/**
 * One tick of the stall ladder. `mem` carries the two counters; a caller resets
 * them (`clearCloseInStall`) whenever it picks a NEW thing to close on, so a
 * fresh leg always starts with its full grace window. The caller owns the
 * re-order itself: a `"reorder"` step means "send YOUR order again", never
 * "send an approach".
 */
export function closeInStall(mode: string | null, mem: MacroMemory): CloseInStall {
  // ⚠ AN UNREADABLE MODE IS "I CANNOT TELL", NEVER "IT IS NOT MOVING". This
  // whole rung is built on one reading; a tick that did not get it is no
  // evidence at all, and stopping a hull on the strength of a missing field
  // would break far more flights than the deadlock it is here for.
  if (mode === null || !isCourseStalled(mode)) {
    return { step: "flying", mem: clearCloseInStall(mem) };
  }
  const ticks = (num(mem, "stallTicks") ?? 0) + 1;
  if (ticks <= STALL_TICKS) {
    // The bridge answers before the mode flips (see fleetCompanionLoop's own
    // note on this), so a mode that has not caught up yet is not a stall.
    return { step: "flying", mem: { ...mem, stallTicks: ticks } };
  }
  const stage = num(mem, "stallStage") ?? 0;
  const next = (step: CloseInStallStep): CloseInStall => ({
    step,
    mem: { ...mem, stallTicks: 0, stallStage: stage + 1 },
  });
  if (stage === 0) {
    return next("reorder");
  }
  if (stage === 1) {
    return next("unstick");
  }
  if (stage === 2) {
    // The stop went out on the last pass; the order after it deserves its own
    // window before a caller calls the hull unflyable.
    return next("reorder");
  }
  return { step: "stuck", mem };
}

export function clearCloseInStall(mem: MacroMemory): MacroMemory {
  return { ...mem, stallTicks: 0, stallStage: 0 };
}

/** The line a block says while it is putting a refused close-in order back in. */
export const STALL_REORDER_WHY = "The course did not take — ordering it again.";
/** The line a block says on the tick it cuts the engines to free a stuck landing. */
export const STALL_UNSTICK_WHY = "The ship is not flying the course — stopping it first.";
/** The line a travelling block says once it has given up on moving the hull. */
export const STALL_STUCK_WHY = "The ship will not move.";

/**
 * What a block says when it has stopped the hull, re-ordered it and watched it
 * sit there anyway. BLOCKED and not skipped: a ship that will not move under
 * sublight will not warp either, so every block after this one is in the same
 * trouble and finishing the program is not on offer.
 */
export const STALL_STUCK_REASON =
  "The ship takes move orders and does not move - the server still has it landing from its last warp, " +
  "and a stop did not clear it. Sign this pilot in again before running the bot.";
