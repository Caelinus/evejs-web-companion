// Drones by ROLE — the roster a block reads, and the launch it issues.
//
// A block launches and orders drones for the job they can do: the combat blocks
// take the combat drones, the salvage block the salvage drones, and neither
// touches the rest. The whole bay used to go out for either job — a Hobgoblin
// ordered to salvage is refused by the server, and the wrong drones then held
// the slots the right ones needed, so the block waited on them forever. The
// roles come off the observation (flow.ts classifies bay stacks and drones in
// space by the game's own group name — see nav/droneRoles.ts). Recalls stay
// role-blind: every drone this hull can order comes home.
//
// ─── WHY THIS IS A LEAF AND NOT A PRIVATE HELPER ─────────────────────────────
//
// This lived twice: once private to `nav/scriptMacros.ts` (`droneRoster` and
// `launchRoleDrones`, for the gun ladders) and once copied into
// `nav/droneBoatLadder.ts`, which cannot import from `scriptMacros.ts` because
// `scriptMacros.ts` imports `decideDroneBoat` FROM it — the copy was a cycle
// being paid for in duplication.
//
// ⚠ THE DRIFT THAT THE COPY RISKED IS NOT COSMETIC. If one copy learns about a
// new drone role and the other does not, the block with the older copy launches
// drones it cannot use into slots the usable ones needed, and the symptom the
// player reports is a fight that never starts: the ship sits on the grid with a
// full bay, the rats shoot it, and nothing in the readout says why. One copy,
// here, is the only thing that makes a new role a one-line change.
//
// This module is PURE: an observation and a memory record in, a roster or one
// `MacroTick` out. No store, no bridge, no clock.

import { canMyShipOrderDrone } from "../space/overview.ts";
import type { SpaceSnapshot } from "../store/types.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { MacroMemory, MacroTick } from "./scriptDecide.ts";

/** The jobs a drone can be carried for. A role is a GROUP, never a hand-picked list. */
export type DroneRole = "combat" | "salvage";

/** A launch the server keeps refusing is not retried forever. */
export const LAUNCH_MAX_TRIES = 3;

/** ~30 s waiting for the other role's drones to come home before launching anyway. */
export const RECALL_MAX_WAIT_TICKS = 15;

/** The outcome every action tick in this tree carries. */
const ACTING: MacroTick["outcome"] = { kind: "acting" };

/**
 * One drone in space, as much of it as the rotation machine needs.
 *
 * Declared structurally rather than imported from `nav/droneRotation.ts` so this
 * module stays a leaf of that one too: a roster is a thing you read, and it has
 * no business knowing what a rotation is.
 */
export interface RosterDrone {
  readonly itemID: number;
  readonly shieldRatio: number | null;
  readonly armorRatio: number | null;
  readonly hullRatio: number | null;
}

export interface DroneRoster {
  /** Every drone this ship can order, whatever it is — what a recall takes. */
  readonly out: readonly number[];
  /** The role's drones out in space, and its stacks still in the bay. */
  readonly roleOut: readonly number[];
  readonly roleBay: readonly number[];
  /** Drones out that are NOT this role — they hold the slots the role needs. */
  readonly othersOut: readonly number[];
  /**
   * The role's drones out, as rotation rows, or null when the per-drone fold was
   * not readable. ⚠ NULL IS "NOBODY LOOKED" AND NOT "NO DRONES ARE OUT" — the
   * rotation machine reads the distinction and would otherwise write a live
   * drone off as dead.
   *
   * Both halves must be readable for a row to exist: the per-drone health fold
   * AND the role split. Without the role split a salvage drone losing shield
   * would be rotated by the COMBAT block, which is a recall of something that
   * block never launched and never wanted.
   */
  readonly roleRows: readonly RosterDrone[] | null;
}

/**
 * A number out of untyped step memory, or null.
 *
 * ⚠ NON-FINITE IS NULL, and the two pre-extraction copies DISAGREED about this:
 * `fight-the-rats` kept a looser reader (any `typeof number`), the drone boat's
 * copy already tested `Number.isFinite`. Nothing reachable tells them apart —
 * `launchTries` has exactly one writer, the function below, which seeds it at 0
 * and only ever adds 1, and every writer of `recallWaited` does the same — so
 * the finite reader is taken because it is the one that cannot fail badly if
 * that ever stops being true. Under the loose reader
 * `Infinity >= LAUNCH_MAX_TRIES` is TRUE, which abandons the launch for good
 * and leaves a drone boat on a grid with a full bay; `NaN >= LAUNCH_MAX_TRIES`
 * is FALSE, which retries it for ever and books a refusal every time. Neither
 * shape can come out of this reader.
 */
function num(mem: MacroMemory, key: string): number | null {
  const value = mem[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flag(mem: MacroMemory, key: string): boolean {
  return mem[key] === true;
}

/** The drones out in space that THIS ship can order home (controlled by this hull). */
function myDroneIDs(snapshot: SpaceSnapshot | null): readonly number[] {
  if (snapshot === null) {
    return [];
  }
  const shipID = snapshot.ship?.itemID ?? null;
  return snapshot.entities.filter((e) => canMyShipOrderDrone(e, shipID) === true).map((e) => e.itemID);
}

/** Split what this hull can order into "this role" and "everything else". */
export function droneRoster(obs: ScriptObservation, role: DroneRole): DroneRoster {
  const out = myDroneIDs(obs.snapshot ?? null);
  const roleIDs = (role === "combat" ? obs.combatDroneIDs : obs.salvageDroneIDs) ?? null;
  const roleSet = new Set(roleIDs ?? []);
  const mine = obs.myDrones ?? null;
  return {
    out,
    roleOut: out.filter((id) => roleSet.has(id)),
    roleBay: (role === "combat" ? obs.combatDroneBayItemIDs : obs.salvageDroneBayItemIDs) ?? [],
    othersOut: out.filter((id) => !roleSet.has(id)),
    roleRows: mine === null || roleIDs === null ? null : mine.filter((row) => roleSet.has(row.itemID)),
  };
}

/**
 * Put THIS role's drones out, or a null tick when there is nothing to do right
 * now (they are out already, the bay has none, or the launch has been tried
 * enough). The three behaviours that matter, each with the failure it prevents:
 *
 *   • Nothing to do when the role's drones are already out, or when the bay
 *     holds none — otherwise this rung wins every tick and the ship never fires.
 *   • Drones of ANOTHER role hold the slots, so they are called in ONCE and the
 *     launch waits for them, bounded by `RECALL_MAX_WAIT_TICKS` and then tried
 *     anyway. Unbounded, a drone that never comes home ends the fight. While
 *     waiting the caller carries on with its own work: a fight keeps shooting
 *     while the salvage drones come home.
 *   • `LAUNCH_MAX_TRIES`, because a launch the server keeps refusing (bandwidth,
 *     most often) is not fixed by asking a fourth time, and every refusal is
 *     booked in the ledger where enough of them on one key END THE RUN.
 *
 * The returned memory carries the bookkeeping whichever way it went, so callers
 * must take it.
 *
 * `roster` is optional only to save the caller a second walk of the snapshot
 * when it already holds one for this same role; omitted, it is read here.
 */
export function launchRoleDrones(
  obs: ScriptObservation,
  mem: MacroMemory,
  phase: string,
  role: DroneRole,
  why: string,
  roster: DroneRoster = droneRoster(obs, role),
): { readonly tick: MacroTick | null; readonly mem: MacroMemory } {
  if (roster.roleOut.length > 0 || roster.roleBay.length === 0) {
    return { tick: null, mem };
  }
  if (roster.othersOut.length > 0) {
    if (!flag(mem, "othersRecalled")) {
      return {
        tick: {
          action: { kind: "recallDrones", droneIDs: roster.othersOut },
          why: `Calling the other drones in to make room for the ${role} drones.`,
          phase,
          armed: true,
          outcome: ACTING,
          nextMem: { ...mem, othersRecalled: true, recallWaited: 0 },
        },
        mem,
      };
    }
    const waited = (num(mem, "recallWaited") ?? 0) + 1;
    if (waited <= RECALL_MAX_WAIT_TICKS) {
      return { tick: null, mem: { ...mem, recallWaited: waited } };
    }
  }
  const tries = num(mem, "launchTries") ?? 0;
  if (tries >= LAUNCH_MAX_TRIES) {
    return { tick: null, mem };
  }
  return {
    tick: {
      action: { kind: "launchDrones", droneItemIDs: roster.roleBay },
      why,
      phase,
      armed: true,
      outcome: ACTING,
      nextMem: { ...mem, launchTries: tries + 1 },
    },
    mem,
  };
}

/** True once the role's launch has been tried its full budget and still nothing is out. */
export function launchStalled(mem: MacroMemory): boolean {
  return (num(mem, "launchTries") ?? 0) >= LAUNCH_MAX_TRIES;
}
