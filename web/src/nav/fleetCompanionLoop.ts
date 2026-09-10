// The fleet companion (fleet-companion phase 0) — a pilot that flies beside you
// in your own fleet and obeys the fleet, not a script.
//
// THIS IS THE FOURTH INSTANCE OF ONE PATTERN, not a new one. `autopilotLoop.ts`,
// `miningBotLoop.ts` and `missionBotLoop.ts` are the other three, and the
// discipline is inherited wholesale: read AUTHORITATIVE state each tick, issue
// AT MOST ONE atomic call, never simulate or predict, bound every branch, and
// PAUSE WITH A REASON rather than guessing. Read `miningBotLoop.ts`'s header
// before changing anything here; the rules it states apply to this file too.
//
// ─── WHY THIS IS NOT A BOT SCRIPT ────────────────────────────────────────────
//
// The block DSL (`web/src/bots/`) exists so a player can compose behaviour as
// text. A fleet companion is bigger than that and worse suited to it: fifteen
// broadcast names, target tags, jam events, chat commands and a flee policy do
// not read as a step list, and exposing them as one asks the player to
// hand-assemble something that should simply have settings. So the companion
// takes a TYPED REQUEST — the shape `MiningBotRequest` already has — and nothing
// here touches `MacroID`, `Condition`, `InterruptResponse` or the editor.
//
// See docs/fleet-companion-plan.md, "The shape of the thing — DECIDED".
//
// ─── WHAT PHASE 0 IS ─────────────────────────────────────────────────────────
//
// The skeleton only. The ladder decides `wait` and nothing else: no broadcasts
// are read, no modules are cycled, no target is tagged. That is deliberate — it
// makes the lifecycle (start / pause / resume / stop / claim / headless resume)
// reviewable on its own, before any behaviour can obscure it. Each later phase
// adds rungs to `decideCompanionAction` without touching the plumbing below.

import type { ScriptObservation } from "./scriptConditions.ts";
import { REPAIR_CAP_FLOOR } from "./scriptDecide.ts";

/** The run states, mirroring the other loops exactly (`MiningBotRunState`). */
export type FleetCompanionRunState = "idle" | "running" | "paused" | "stopped" | "error";

/**
 * What this pilot is FOR. Descriptive, and it picks the defaults a UI offers —
 * it does NOT gate behaviour by itself.
 *
 * ⚠ EVERY CAPABILITY IS ITS OWN FIELD ON THE REQUEST, deliberately. Two `dps`
 * pilots in one squad must be able to differ (one tags, one does not; one flees
 * at a third, one at a tenth), and hiding capability behind a role name would
 * make the role a second, implicit config surface nobody can see.
 */
export type FleetCompanionRole = "dps" | "logi" | "tackle" | "support";

export const FLEET_COMPANION_ROLES: readonly FleetCompanionRole[] =
  Object.freeze<FleetCompanionRole[]>(["dps", "logi", "tackle", "support"]);

/**
 * Which order sources this pilot listens to.
 *
 * ⚠ THIS TURNS A CHANNEL ON OR OFF. It never reorders precedence, which is
 * fixed (docs/fleet-companion-plan.md, Decisions §3):
 *
 *     server fleet warp > FC broadcast > chat command > own flee rule > own ladder
 */
export type FleetCompanionOrderSource = "broadcast" | "tag" | "chat" | "squad-board";

export const FLEET_COMPANION_ORDER_SOURCES: readonly FleetCompanionOrderSource[] =
  Object.freeze<FleetCompanionOrderSource[]>(["broadcast", "tag", "chat", "squad-board"]);

/**
 * One companion run's whole configuration. Flat, serialisable, UI-editable.
 *
 * ⚠ FLATNESS IS LOAD-BEARING. This is stored as the VALUE against a pilot in a
 * Pilot Hangar squad, and squads routinely span accounts. A role that were a
 * REFERENCE into an account-scoped script library could not be shared by a
 * mixed squad; a value can. See docs/fleet-companion-plan.md, "How the player
 * says which pilots these are".
 */
export interface FleetCompanionRequest {
  readonly role: FleetCompanionRole;
  /**
   * The player's OWN pick of fitted defensive modules, by item id — never
   * guessed here, for the same reason `MiningBotRequest.miningModuleIDs` is not
   * guessed: a wrong guess cycles the wrong module.
   */
  readonly defenseModuleIDs: readonly number[];
  /** Remaining fraction (0-1) of any health layer that starts a flee. */
  readonly fleeHealthFloor: number;
  /**
   * Capacitor fraction below which no repairer may be STARTED, and a running
   * one is stopped even while a layer is still hurt.
   *
   * ⚠ AN EARLIER DRAFT SAID THIS "PROTECTS THE ESCAPE". IT DOES NOT, ON THIS
   * SERVER. Retail charges capacitor to warp (`warpCapacitorNeed`, dogma
   * attribute 153), so a flattened capacitor there means a ship that cannot
   * leave. eve.js does not implement that: there is no reference to capacitor
   * anywhere under `space/destiny/` — not in `warp.js`, `warpState.js`,
   * `warpContract.js`, `warpBuilders.js` or `warpCommands.js` — so a ship here
   * warps fine at zero capacitor. Checked 2026-09-10.
   *
   * The floor that DOES earn its place is the one this codebase already
   * shipped: an empty capacitor repairs nothing, so a repairer running below it
   * is burning cycles that heal nothing and cost everything. Hence the default
   * is `REPAIR_CAP_FLOOR`, not a number invented for this file.
   */
  readonly capacitorFloor: number;
  /** Bound on flee round trips before the pilot stays home. */
  readonly maxFleeAttempts: number;
  readonly useDrones: boolean;
  /**
   * Seconds to hold drones in the bay before relaunching them.
   *
   * ⚠ THIS DOES NOT "BREAK THE NPC'S LOCK", WHICH IS WHAT IT WAS ASKED FOR.
   * eve.js has no target-loss memory and no drone-specific cooldown: a recalled
   * drone leaves the scene instantly, and on the NPC's next think tick
   * (`thinkIntervalMs`, 100-500 ms, ~185 ms median) it simply re-scores every
   * candidate by distance. Roughly 40% of behaviour profiles set no
   * `allowTargetSwitching` at all, so they can relock the relaunched drone on
   * the very next tick. Checked against the live profile table, 2026-09-10.
   *
   * What the recall DOES do is get a damaged drone out of danger, which is
   * worth having on its own. The safe moment to relaunch is when something else
   * is holding the rat's aggro — an OBSERVABLE condition, not a timer — so this
   * value is a floor on the wait, never the thing that makes it safe.
   */
  readonly droneRedeployHoldOffSeconds: number;
  /**
   * Whether this pilot ATTEMPTS to tag. Only "try": the server silently drops a
   * non-commander's tag write and still answers ok, so the real gate is the
   * fleet roster read, not this flag.
   *
   * ⚠ ONLY ONE PILOT PER SQUAD SHOULD SET THIS. A tag is unique fleet-wide, so
   * two taggers fight over letters and the fleet stops trusting them.
   */
  readonly attemptsTagging: boolean;
  readonly obeys: readonly FleetCompanionOrderSource[];
  /**
   * Character ids whose fleet-chat commands this pilot will act on, IN ADDITION
   * to whoever the fleet roster says is a commander. Empty is the safe default.
   *
   * ⚠ NEVER POPULATED FROM CHAT TEXT. It comes off the request the operator
   * controls, which is what keeps it unspoofable.
   */
  readonly chatCommandSenders: readonly number[];
}

/** Bounds. Stated together rather than scattered, so they can be read at once. */
export const MIN_FLEE_HEALTH_FLOOR = 0.05;
export const MAX_FLEE_HEALTH_FLOOR = 0.95;
export const MIN_CAPACITOR_FLOOR = 0.05;
export const MAX_CAPACITOR_FLOOR = 0.95;
export const MIN_FLEE_ATTEMPTS = 1;
/** Three, matching MAX_RECOVER_TRIPS and MAX_ESCAPE_ATTEMPTS. A fourth trip into
 *  the same camp is a bot commuting, not a bot recovering. */
export const MAX_FLEE_ATTEMPTS = 10;
export const MIN_DRONE_HOLD_OFF_SECONDS = 1;
export const MAX_DRONE_HOLD_OFF_SECONDS = 300;

/**
 * The default request. Every field is a placeholder a UI overrides EXCEPT the
 * two marked unverified, which are honest guesses awaiting a live measurement
 * (docs/fleet-companion-plan.md, "Unknowns").
 */
export const DEFAULT_FLEET_COMPANION_REQUEST: FleetCompanionRequest = Object.freeze({
  role: "dps",
  defenseModuleIDs: Object.freeze([]),
  fleeHealthFloor: 0.3,
  // Not a guess and not a placeholder: the constant the script runner already
  // uses to switch a repairer off, with the same reasoning ("an empty capacitor
  // repairs nothing"). Reusing it means one answer to this question, not two.
  capacitorFloor: REPAIR_CAP_FLOOR,
  maxFleeAttempts: 3,
  useDrones: false,
  // A floor on the wait, not a safety guarantee — see the field's own comment.
  droneRedeployHoldOffSeconds: 10,
  attemptsTagging: false,
  obeys: Object.freeze<FleetCompanionOrderSource[]>(["broadcast", "tag"]),
  chatCommandSenders: Object.freeze([]),
} satisfies FleetCompanionRequest);

/**
 * What the companion sees each tick.
 *
 * ⚠ IT EXTENDS `ScriptObservation` ON PURPOSE, and not because the companion is
 * a script. That interface is a plain data shape — it names no `Condition`, no
 * `MacroID`, no `InterruptRow` — and the pure helpers in `scriptMacros.ts` are
 * typed over it. Extending it means those helpers accept a companion
 * observation by structural subtyping, with no adapter and no cast.
 *
 * The fields below are the ones `ScriptObservation` has no reason to carry.
 * They stay EMPTY in phase 0; each is filled by the phase that needs it.
 */
export interface FleetCompanionObservation extends ScriptObservation {
  /**
   * Fleet target tags, itemID -> tag. `null` means never received; an empty map
   * means received and nothing is tagged. The distinction decides whether a
   * tagger may pick a letter at all.
   */
  readonly fleetTargetTags: ReadonlyMap<number, string> | null;
  /**
   * Whether THIS pilot's tag write can land, from the fleet roster's role/job.
   *
   * ⚠ THREE STATES. `null` (roster unreadable) and `false` (not a commander)
   * both forbid a write, but only `false` is settled. Never guess "no".
   */
  readonly canTag: boolean | null;
}

/**
 * Everything the loop is allowed to do to the world. The controller is pure
 * against this — same construction as `MiningBotDeps`, and what makes the whole
 * ladder testable without a browser.
 */
export interface FleetCompanionDeps {
  observe(): Promise<FleetCompanionObservation>;
  issue(action: FleetCompanionAction): Promise<void>;
  sleep(ms: number): Promise<void>;
  /**
   * Push the readout after EVERY state change — including `stop()`.
   *
   * ⚠ NOT OPTIONAL, and not merely for the panel. The store's `botStatus`
   * record reads this loop's status to decide who is holding the ship. A loop
   * that stops without reporting leaves the store believing it still holds the
   * hull, so the next bot's claim looks like it stopped nothing and the readout
   * never clears.
   */
  onProgress?(progress: FleetCompanionProgress): void;
}

/** What one tick decided to do. Phase 0 only ever waits. */
export type FleetCompanionAction = { readonly kind: "wait" };

export interface FleetCompanionProgress {
  readonly status: FleetCompanionRunState;
  readonly phase: string | null;
  readonly action: string | null;
  readonly why: string | null;
  readonly role: FleetCompanionRole | null;
  /** Whether this pilot is in a fleet at all. Null while the roster is unread. */
  readonly inFleet: boolean | null;
  /** Which authority the last decision came from, for the readout. */
  readonly followingOrderFrom:
    | "broadcast"
    | "tag"
    | "chat"
    | "squad-board"
    | "own-ladder"
    | null;
  readonly lastOrderHeard: string | null;
  /**
   * Whether this pilot's tag write would land. Three states, and the third is
   * the point: a pilot silently unable to tag looks exactly like one with
   * nothing to tag unless the readout can tell them apart.
   */
  readonly canTag: boolean | null;
  readonly failureReason: string | null;
}

export interface FleetCompanionController {
  start(request: FleetCompanionRequest): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** One decision cycle: read, decide, issue at most one atomic call. */
  tick(): Promise<FleetCompanionAction>;
  /** Drive until the loop leaves the running state (production driver). */
  run(): Promise<void>;
  snapshot(): FleetCompanionProgress;
}

/** The cadence the other loops use. Two seconds is a lower bound, never exact. */
export const FLEET_COMPANION_CADENCE_MS = 2000;

export interface CompanionDecision {
  readonly action: FleetCompanionAction;
  readonly phase: string;
  readonly why: string;
}

/**
 * The ladder. Pure, synchronous, and the whole of what later phases extend.
 *
 * ⚠ RUNG 1 IS THE WARP YIELD AND IT MUST STAY FIRST. Fleet warp is
 * server-authoritative: when the fleet commander warps the fleet, this ship is
 * already moving whether or not the companion notices, and anything it issues
 * meanwhile fights the server and produces refusals. So a tick in warp decides
 * NOTHING — and that single rung satisfies the decided precedence for every
 * behaviour beneath it at once, instead of each one remembering the rule.
 *
 * `inWarp` cannot distinguish a fleet warp from a self-issued one; nothing in
 * the codebase can (`flow.ts` derives it from `shipMode` alone). That is an
 * accepted limit, not a gap this file introduces.
 *
 * ⚠ `=== true`, NEVER `!== false`. An unreadable `inWarp` must fail open, the
 * same way every other tri-state read in this codebase does — a ship that
 * cannot be read is not a ship that is known to be in warp.
 */
export function decideCompanionAction(obs: FleetCompanionObservation): CompanionDecision {
  if (obs.inWarp === true) {
    return {
      action: { kind: "wait" },
      phase: "In warp",
      why: "The fleet is warping this ship — nothing is decided until it lands.",
    };
  }
  // Phases 2-8 add their rungs here, in the order documented in
  // docs/fleet-companion-implementation.md, "The rung ladder".
  return {
    action: { kind: "wait" },
    phase: "Standing by",
    why: "No companion behaviour is built yet.",
  };
}

interface CompanionMemory {
  status: FleetCompanionRunState;
  phase: string | null;
  action: string | null;
  why: string | null;
  role: FleetCompanionRole | null;
  inFleet: boolean | null;
  followingOrderFrom: FleetCompanionProgress["followingOrderFrom"];
  lastOrderHeard: string | null;
  canTag: boolean | null;
  failureReason: string | null;
}

function freshMemory(): CompanionMemory {
  return {
    status: "idle",
    phase: null,
    action: null,
    why: null,
    role: null,
    inFleet: null,
    followingOrderFrom: null,
    lastOrderHeard: null,
    canTag: null,
    failureReason: null,
  };
}

export function createFleetCompanion(deps: FleetCompanionDeps): FleetCompanionController {
  let mem = freshMemory();
  /**
   * ⚠ THE STALE-RUN GUARD. A `run()` in flight keeps its token; `start()` mints
   * a new one. So a tick belonging to a run the player already stopped and
   * restarted cannot land its call on top of the new run — the same
   * construction the other loops use.
   */
  let runToken = 0;

  function report(): void {
    deps.onProgress?.(snapshot());
  }

  function snapshot(): FleetCompanionProgress {
    return {
      status: mem.status,
      phase: mem.phase,
      action: mem.action,
      why: mem.why,
      role: mem.role,
      inFleet: mem.inFleet,
      followingOrderFrom: mem.followingOrderFrom,
      lastOrderHeard: mem.lastOrderHeard,
      canTag: mem.canTag,
      failureReason: mem.failureReason,
    };
  }

  async function tick(): Promise<FleetCompanionAction> {
    if (mem.status !== "running") {
      return { kind: "wait" };
    }
    const token = runToken;
    let obs: FleetCompanionObservation;
    try {
      obs = await deps.observe();
    } catch (error) {
      // A read that fails is not a licence to act on the last one. Pause with
      // the reason rather than deciding against stale state.
      mem.status = "error";
      mem.failureReason = error instanceof Error ? error.message : String(error);
      mem.why = "Could not read the ship.";
      report();
      return { kind: "wait" };
    }
    if (token !== runToken || mem.status !== "running") {
      return { kind: "wait" };
    }
    // The readout fields the observation already answers. Cheap, and it keeps
    // the badge honest without a second read.
    mem.inFleet = obs.inFleet ?? null;
    mem.canTag = obs.canTag;
    const decision = decideCompanionAction(obs);
    mem.phase = decision.phase;
    mem.why = decision.why;
    mem.action = decision.action.kind;
    if (decision.action.kind !== "wait") {
      await deps.issue(decision.action);
    }
    report();
    return decision.action;
  }

  return {
    start(next: FleetCompanionRequest): void {
      mem = freshMemory();
      mem.status = "running";
      mem.role = next.role;
      mem.phase = "Standing by";
      runToken += 1;
      report();
    },
    pause(): void {
      if (mem.status === "running") {
        mem.status = "paused";
        report();
      }
    },
    resume(): void {
      if (mem.status === "paused") {
        mem.status = "running";
        report();
      }
    },
    stop(): void {
      // Bump the token so a tick already in flight cannot land after the stop.
      runToken += 1;
      mem.status = "stopped";
      mem.phase = null;
      mem.action = null;
      mem.why = null;
      report();
    },
    tick,
    async run(): Promise<void> {
      const token = runToken;
      while (mem.status === "running" && token === runToken) {
        await tick();
        if (mem.status !== "running" || token !== runToken) {
          break;
        }
        await deps.sleep(FLEET_COMPANION_CADENCE_MS);
      }
    },
    snapshot,
  };
}
