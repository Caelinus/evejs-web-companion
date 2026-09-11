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
// The get-safe ladder is the autopilot's, imported rather than re-derived —
// the same reuse `miningBotLoop.ts` makes of the same two functions. Note what
// is NOT imported: `scriptMacros.ts`'s `dockAtNearest` is the same shape, but
// it is a `MacroDecider` over the DSL's own step/memory types, and reaching for
// it would couple this file to the editor it exists not to be part of. These
// three names live in `autopilotLoop.ts`, which the DSL does not own.
import {
  decideCloseIn,
  measureSpace,
  STATION_DOCKING_RADIUS_M,
  type SpaceMeasurement,
} from "./autopilotLoop.ts";
import type { SpaceEntity } from "../store/types.ts";

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
  /**
   * Where to run to when the abandonment protocol finds no station on grid —
   * a bookmark id, or `null` for "nowhere has been named".
   *
   * ⚠ A BOOKMARK BECAUSE THERE IS NO SUN. Decision 5 asked for "a safe spot
   * (the sun) if no station exists", and that step cannot be built as asked:
   * eve.js's scene carries no celestial at all — its entity kinds are `ship`,
   * `structure`, `drone`, `asteroid`, `stargate`, `station`, `sentryGun`,
   * `container`, `cynoField` and `signatureSite` — and no read in `api.ts` or
   * on the BFF exposes one. Checked 2026-09-10.
   *
   * A bookmark is better than the celestial would have been. `api.warpToBookmark`
   * already exists, and the operator names somewhere they have actually checked
   * rather than the one object every other pilot in the system also warps to.
   *
   * `null` is honest, not unfinished: a system with no station on grid AND no
   * bookmark is the one case with nothing to do, and the companion stops where
   * it is and says why. A fabricated safe spot would be worse than an honest
   * stop.
   */
  readonly safeSpotBookmarkID: number | null;
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
  // No safe spot until an operator names one. See the field's own comment for
  // why null is a real answer here rather than a missing setting.
  safeSpotBookmarkID: null,
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
   * Whether THIS pilot's tag write can land, from the fleet roster's role/job.
   *
   * ⚠ THREE STATES. `null` (roster unreadable) and `false` (not a commander)
   * both forbid a write, but only `false` is settled. Never guess "no".
   */
  readonly canTag: boolean | null;
  /**
   * Character IDs THIS HOST is flying with a bot — companions included, and
   * this pilot itself. The supervision gate SUBTRACTS them from the fleet
   * roster; whatever is left is a human.
   *
   * `null` means the set could not be read, which leaves the gate undecidable
   * rather than failed. Rung 2 says what it does about that.
   *
   * ⚠ SUBTRACTION, NEVER A COUNT. "Is the fleet bigger than one?" passes for
   * four companions the moment their operator logs off — which is the exact
   * situation this gate exists to catch (decision 5).
   *
   * ⚠ AN HONEST LIMIT, ACCEPTED. Only the bots THIS host knows about can be
   * subtracted, so another account's companion in the same fleet reads as a
   * human. Decision 5 accepts that; the run's deadline is what bounds it.
   */
  readonly botDrivenCharacterIDs: readonly number[] | null;
  /**
   * A fleet invite waiting to be answered, if any. The abandonment protocol's
   * ONLY way back into a fleet, and rung 2 gates it on who sent it.
   */
  readonly pendingFleetInvite: CompanionFleetInvite | null;
}

/** A pending fleet invite, narrowed to the two ids the rejoin gate needs. */
export interface CompanionFleetInvite {
  readonly fleetID: number;
  /**
   * ⚠ `null` IS NEVER ACCEPTED. An invite whose notification carried no usable
   * inviter id cannot be matched against the remembered supervisors, and an
   * unmatchable invite is exactly the one the gate exists to refuse.
   */
  readonly inviterID: number | null;
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
   * The clock, injectable ONLY so a test can drive the thirty-minute wait
   * without waiting thirty minutes. Defaults to `Date.now`.
   */
  now?(): number;
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

/**
 * What one tick decided to do.
 *
 * Everything below `wait` belongs to ONE behaviour — the abandonment protocol
 * (decision 5). The companion's ordinary work still decides `wait` and issues
 * nothing; these exist because a companion left without a human has somewhere
 * to be, and getting there is the one thing it may do unsupervised.
 */
export type FleetCompanionAction =
  | { readonly kind: "wait" }
  /** The get-safe ladder: warp in, close the last few km, dock. */
  | { readonly kind: "warp"; readonly targetID: number }
  | { readonly kind: "approach"; readonly targetID: number }
  | { readonly kind: "dock"; readonly stationID: number }
  /** The fallback when no station is on grid: the operator's own safe spot. */
  | { readonly kind: "warpToBookmark"; readonly bookmarkID: number }
  | { readonly kind: "leaveFleet" }
  | { readonly kind: "acceptFleetInvite"; readonly fleetID: number };

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
  /**
   * Non-null while the supervision gate has failed and the abandonment
   * protocol is running (decision 5).
   *
   * ⚠ THIS IS THE CHANNEL THE PERSISTED CLOCK TRAVELS ON, not decoration. The
   * BFF's bot host reads it off this readout and writes it into the durable
   * roster row, and hands it back to `start()` after a restart. A readout that
   * dropped it would give the companion a fresh thirty minutes on every
   * restart — see `FLEET_COMPANION_ABANDONMENT_WAIT_MS`.
   */
  readonly abandonment: CompanionAbandonmentRecord | null;
  readonly failureReason: string | null;
}

export interface FleetCompanionController {
  /**
   * `resuming` re-seats an abandonment that was already under way before a BFF
   * restart. Omitted for a fresh start, which is every browser start and every
   * launch a player actually presses.
   */
  start(request: FleetCompanionRequest, resuming?: CompanionAbandonmentRecord | null): void;
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

/**
 * How long an abandoned companion waits before giving up and releasing the
 * hull. Decision 5's number.
 *
 * ⚠ IT IS ONLY A BOUND IF THE CLOCK SURVIVES A RESTART. The BFF's roster row
 * outlives a restart, so an `abandonedAtMs` held only in memory would hand the
 * companion a fresh thirty minutes every time the process came back — an
 * unbounded wait assembled out of bounded ones. `CompanionAbandonmentRecord`
 * is the shape that gets persisted, and `start()` takes it back.
 */
export const FLEET_COMPANION_ABANDONMENT_WAIT_MS = 30 * 60 * 1000;

/** What can be docked at. Stations and player structures both take a dock. */
const DOCKABLE_KINDS: ReadonlySet<string> = new Set(["station", "structure"]);

/**
 * The two facts about an abandonment that MUST outlive a BFF restart: when it
 * started, and who may invite this pilot back.
 *
 * Deliberately NOT the whole of `CompanionAbandonment`. The get-safe flags
 * below describe a warp that is over the moment the process dies, so carrying
 * them across a restart would claim the ship had reached safety when nothing
 * knows whether it did. They reset; the clock does not.
 */
export interface CompanionAbandonmentRecord {
  readonly abandonedAtMs: number;
  /**
   * The non-bot fleet-mates seen on the last tick that PASSED the supervision
   * check — "the human who left". The rejoin gate's whole allowlist.
   *
   * ⚠ WITHOUT THIS GATE AN IDLE DOCKED COMPANION CAN BE FLEET-INVITED BY A
   * STRANGER AND HANDED A SHIP. That is why the protocol rejoins a CHARACTER
   * rather than a fleet.
   */
  readonly supervisorCharacterIDs: readonly number[];
}

/** The live abandonment: the persisted record plus this run's get-safe state. */
export interface CompanionAbandonment extends CompanionAbandonmentRecord {
  /** Whether the safe-spot warp has been issued. Bounds it to one attempt. */
  readonly safeSpotWarpIssued: boolean;
  /**
   * Whether the ship has since been OBSERVED in warp.
   *
   * ⚠ THIS IS WHY THERE IS NO TIMER HERE. "Issued the warp" is not "left the
   * grid" — the POST returns before `shipMode` flips — and treating it as such
   * would drop fleet while the ship still sat where it was, which is the one
   * ordering mistake decision 5 calls out. Safety is confirmed by a READING,
   * never by elapsed time.
   */
  readonly safeSpotWarpSeen: boolean;
}

/**
 * The memory the ladder threads from tick to tick. Pure in, pure out: the
 * ladder never mutates it and the controller stores whatever comes back — the
 * same construction the script runner's deciders use.
 */
export interface CompanionLadderMemory {
  /** Refreshed on every tick the supervision check passes. */
  readonly lastSupervisorIDs: readonly number[];
  /** Non-null from the tick the check first fails until supervision returns. */
  readonly abandonment: CompanionAbandonment | null;
  /** The target of an approach this loop started, for `decideCloseIn`. */
  readonly closingOn: number | null;
}

export function freshLadderMemory(): CompanionLadderMemory {
  return { lastSupervisorIDs: [], abandonment: null, closingOn: null };
}

export interface CompanionDecision {
  readonly action: FleetCompanionAction;
  readonly phase: string;
  readonly why: string;
  /** The memory the NEXT tick carries. The caller stores it verbatim. */
  readonly memory: CompanionLadderMemory;
  /**
   * Set when the ladder has decided this run is OVER, carrying the sentence to
   * show for it. The controller stops and reports; it does not decide.
   *
   * ⚠ IT IS A STOP, NOT A PAUSE, AND THAT IS THE POINT. Both reasons that set
   * it — the wait ran out, or there is nowhere safe to go — mean nobody is
   * coming. Stopping is what RELEASES THE HULL: the BFF's bot host treats a
   * terminal status as the end of the bot and logs its session out, so the
   * pilot is flyable from a tab again. A pause would hold the ship forever.
   */
  readonly stop?: string;
}

/**
 * Fleet members this host is NOT flying with a bot — the humans.
 *
 * `null` when either half is unreadable, which is a genuinely different answer
 * from the empty array and must stay that way: `[]` means "looked, nobody
 * there", `null` means "could not look".
 */
export function supervisorsInFleet(obs: FleetCompanionObservation): readonly number[] | null {
  const members = obs.fleetMemberCharacterIDs ?? null;
  const driven = obs.botDrivenCharacterIDs ?? null;
  if (members === null || driven === null) {
    return null;
  }
  const ours = new Set<number>(driven);
  // This pilot is never its own supervisor. Belt and braces: a host reporting
  // its claims correctly already includes it, and a host that does not must
  // still never be told it is being watched by itself.
  if (obs.myCharacterID !== null && obs.myCharacterID !== undefined) {
    ours.add(obs.myCharacterID);
  }
  return members.filter((characterID) => !ours.has(characterID));
}

const WAIT: FleetCompanionAction = { kind: "wait" };

function waiting(phase: string, why: string, memory: CompanionLadderMemory): CompanionDecision {
  return { action: WAIT, phase, why, memory };
}

/** Nearest of a set by measured surface distance; unmeasurable sorts last. */
function nearestOf(
  entities: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
): SpaceEntity | null {
  let best: SpaceEntity | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entity of entities) {
    const distance = measurement?.distances.get(entity.itemID) ?? Number.POSITIVE_INFINITY;
    if (distance < bestDistance) {
      best = entity;
      bestDistance = distance;
    }
  }
  return best;
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
 *
 * ⚠ RUNG 2 IS THE SUPERVISION GATE, AND IT SITS ABOVE EVERY ORDER SOURCE.
 * Decision 5: a companion does no unsupervised work, CONTINUOUSLY and not
 * merely at launch. It is a liveness gate rather than an order, which is why it
 * is not itself part of the precedence list it sits on top of — and rung 1
 * above it is not an order source either, it is the tick on which nothing can
 * be issued at all.
 *
 * Why the naive versions of this check fail, read out of the server on
 * 2026-09-10 (`/d/evet/server/src/services/fleets/fleetRuntime.js`):
 *
 *   • A disconnect REMOVES the character from the fleet
 *     (`handleSessionDisconnected`, :1861), so a logged-off human cannot
 *     satisfy this check and the roster read is not hollow. Good.
 *   • But the fleet SURVIVES with one member — the size test runs BEFORE the
 *     removal — and `assignBossToAnyRemainingMember` (:1838) then PROMOTES the
 *     companion to boss. So what this catches is not merely "kept flying
 *     unsupervised"; it is "was made fleet commander, and its tag writes
 *     started landing", in a fleet nobody is in.
 */
export function decideCompanionAction(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory = freshLadderMemory(),
  nowMs: number = Date.now(),
): CompanionDecision {
  if (obs.inWarp === true) {
    // The one thing a mid-warp tick still RECORDS. Nothing may be issued here,
    // but this reading is the only confirmation the get-safe step ever gets
    // that its warp actually took — every later tick has left warp by
    // definition, so a tick that discarded it would lose the fact for good.
    const running = memory.abandonment;
    const next =
      running !== null && running.safeSpotWarpIssued && !running.safeSpotWarpSeen
        ? { ...memory, abandonment: { ...running, safeSpotWarpSeen: true } }
        : memory;
    return waiting(
      "In warp",
      "The fleet is warping this ship — nothing is decided until it lands.",
      next,
    );
  }

  const supervisors = supervisorsInFleet(obs);
  if (supervisors === null) {
    // FAIL OPEN, deliberately. A transient roster failure must not dock a live
    // fleet operation and disband it; the run's own deadline (maxRuntimeMinutes,
    // the only thing that ever ends an unattended run) is what bounds a read
    // that stays broken. Note it leaves an abandonment already under way
    // exactly as it is — an unreadable roster is not evidence a human returned.
    return waiting(
      "Checking supervision",
      "Cannot tell who else is in the fleet, so nothing is decided this tick.",
      memory,
    );
  }
  if (supervisors.length === 0) {
    return decideAbandonment(request, obs, memory, nowMs);
  }

  // Supervised. Remember who: the moment they leave is the moment this list
  // becomes the rejoin gate's allowlist, and there is no second chance to
  // collect it. Clear any abandonment, because a human is demonstrably here.
  const supervised: CompanionLadderMemory = {
    lastSupervisorIDs: [...supervisors],
    abandonment: null,
    closingOn: memory.closingOn,
  };

  // Phases 2-8 add their rungs here, in the order documented in
  // docs/fleet-companion-implementation.md, "The rung ladder".
  return waiting("Standing by", "No companion behaviour is built yet.", supervised);
}

/**
 * The abandonment protocol (decision 5): get safe, then disband, then wait.
 *
 * ⚠ THE ORDER IS LOAD-BEARING. Safe FIRST, then leave. Leaving first gives up
 * the fleet-warp channel while the ship is still sitting in space.
 */
function decideAbandonment(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): CompanionDecision {
  const running: CompanionAbandonment = memory.abandonment ?? {
    abandonedAtMs: nowMs,
    // The last tick that PASSED the check is where the humans were. At this
    // tick there are none by definition, so the allowlist can only ever be
    // remembered forward — it cannot be read now.
    supervisorCharacterIDs: [...memory.lastSupervisorIDs],
    safeSpotWarpIssued: false,
    safeSpotWarpSeen: false,
  };
  const mem: CompanionLadderMemory = { ...memory, abandonment: running };
  const remainingMs = FLEET_COMPANION_ABANDONMENT_WAIT_MS - (nowMs - running.abandonedAtMs);

  // 1. The bound, checked FIRST — ahead even of a waiting invite. A rejoin
  //    accepted past the deadline would be a bounded wait extended by another
  //    bounded wait, which is exactly the unbounded life the persisted clock
  //    exists to prevent. A companion out of time stops; a human who still
  //    wants it can start it again.
  if (remainingMs <= 0) {
    return {
      action: WAIT,
      phase: "Abandoned",
      why: "Nobody came back within the wait, so this pilot is releasing the ship.",
      memory: mem,
      stop: "No fleet member this host is not flying, for thirty minutes. Released the ship.",
    };
  }

  // 2. Get safe.
  if (!reachedSafety(obs, running)) {
    return getSafe(request, obs, mem, running);
  }

  // 3. Drop fleet — each companion for itself. "All pilots drop fleet" is the
  //    emergent effect of every one of them running this rung, never a
  //    broadcast and never one pilot acting for another.
  if (obs.inFleet === true) {
    return {
      action: { kind: "leaveFleet" },
      phase: "Abandoned",
      why: "Safe, and nobody is left to fly with — leaving the fleet.",
      memory: mem,
    };
  }

  // 4. Wait, and take a way back only from someone who was actually here.
  const invite = obs.pendingFleetInvite;
  if (
    obs.inFleet === false &&
    invite !== null &&
    invite.inviterID !== null &&
    running.supervisorCharacterIDs.includes(invite.inviterID)
  ) {
    return {
      action: { kind: "acceptFleetInvite", fleetID: invite.fleetID },
      phase: "Abandoned",
      why: "A pilot who was in the fleet before is inviting this one back.",
      memory: mem,
    };
  }
  const minutes = Math.ceil(remainingMs / 60_000);
  return waiting(
    "Abandoned",
    invite === null
      ? "Waiting " + minutes + " more minute(s) for someone to come back."
      : "Ignoring an invite from a pilot who was not in the fleet. Waiting " +
          minutes +
          " more minute(s).",
    mem,
  );
}

/**
 * Whether the ship has got where the protocol was taking it.
 *
 * Callers reach this only BELOW rung 1, so `inWarp` is already known not to be
 * true — which is what makes "the warp was seen, and it is over" a safe read of
 * having arrived rather than of having merely been issued.
 */
function reachedSafety(obs: FleetCompanionObservation, running: CompanionAbandonment): boolean {
  if (obs.docked === true) {
    return true;
  }
  return running.safeSpotWarpIssued && running.safeSpotWarpSeen;
}

/**
 * Step 1 of the protocol: the nearest dock on grid, else the operator's safe
 * spot, else an honest stop.
 *
 * ⚠ NO DRONE RECALL HERE YET, AND PHASE 5 MUST ADD ONE. `dockAtNearest` recalls
 * before it warps because a warp with drones out abandons them. Nothing in the
 * companion launches a drone yet, so there is nothing to leave behind — the day
 * a rung does, this warp starts costing drones.
 */
function getSafe(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  running: CompanionAbandonment,
): CompanionDecision {
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return waiting("Getting safe", "Waiting for the ship to be out in space.", mem);
  }
  const measurement = measureSpace(snapshot);
  const target = nearestOf(
    snapshot.entities.filter((entity) => DOCKABLE_KINDS.has(entity.kind ?? "")),
    measurement,
  );
  if (target !== null) {
    const step = decideCloseIn(target.itemID, STATION_DOCKING_RADIUS_M, measurement, mem.closingOn);
    if (step === null || step.kind === "arrive") {
      return {
        action: { kind: "dock", stationID: target.itemID },
        phase: "Getting safe",
        why: "Docking, because there is nobody left in the fleet to fly with.",
        memory: mem,
      };
    }
    if (step.kind === "closing") {
      return waiting("Getting safe", "Closing on the station.", mem);
    }
    if (step.kind === "approach") {
      return {
        action: { kind: "approach", targetID: target.itemID },
        phase: "Getting safe",
        why: "Closing on the station.",
        memory: { ...mem, closingOn: target.itemID },
      };
    }
    return {
      action: { kind: "warp", targetID: target.itemID },
      phase: "Getting safe",
      why: "Warping to the nearest station.",
      memory: mem,
    };
  }

  const bookmarkID = request.safeSpotBookmarkID;
  if (bookmarkID === null) {
    // The one case decision 5 says has nothing to do. An invented safe spot
    // would be worse than saying so.
    return {
      action: WAIT,
      phase: "Getting safe",
      why: "No station in view and no safe spot set.",
      memory: mem,
      stop: "Nobody is left in the fleet, and there is no station in view and no safe spot set for this pilot.",
    };
  }
  if (!running.safeSpotWarpIssued) {
    return {
      action: { kind: "warpToBookmark", bookmarkID },
      phase: "Getting safe",
      why: "No station in view — warping to the safe spot.",
      memory: { ...mem, abandonment: { ...running, safeSpotWarpIssued: true } },
    };
  }
  // Issued, and no warp has been seen. Do NOT re-issue every two seconds, and
  // do NOT give up: the warp may simply not have started yet, and the
  // thirty-minute bound above is already the answer to one that never does.
  return waiting("Getting safe", "Waiting for the warp to the safe spot to start.", mem);
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
  /** The live request. Null until `start()`; the ladder needs it every tick. */
  request: FleetCompanionRequest | null;
  /** The ladder's own threaded memory — see `CompanionLadderMemory`. */
  ladder: CompanionLadderMemory;
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
    request: null,
    ladder: freshLadderMemory(),
  };
}

/** The persisted half of the ladder's abandonment, or null when there is none. */
function abandonmentRecord(ladder: CompanionLadderMemory): CompanionAbandonmentRecord | null {
  const running = ladder.abandonment;
  return running === null
    ? null
    : {
        abandonedAtMs: running.abandonedAtMs,
        supervisorCharacterIDs: [...running.supervisorCharacterIDs],
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
      abandonment: abandonmentRecord(mem.ladder),
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
    // The request is set by start() before the status can become "running", so
    // this fallback is unreachable in practice — it exists so the ladder's
    // signature needs no optional request and no cast.
    const request = mem.request ?? DEFAULT_FLEET_COMPANION_REQUEST;
    const decision = decideCompanionAction(request, obs, mem.ladder, deps.now?.() ?? Date.now());
    // ⚠ STORE THE MEMORY BEFORE ANYTHING ELSE CAN RETURN. The ladder is pure,
    // so a decision whose memory is dropped silently un-does whatever that tick
    // learned — the safe-spot warp it just issued, or the humans it just saw.
    mem.ladder = decision.memory;
    mem.phase = decision.phase;
    mem.why = decision.why;
    mem.action = decision.action.kind;
    if (decision.stop !== undefined) {
      // The ladder has decided the run is over. Not `stop()`: that clears the
      // readout, and the whole value of these two endings is the sentence that
      // says which one happened. Bump the token the same way stop() does, so a
      // tick already in flight cannot land after this one.
      runToken += 1;
      mem.status = "stopped";
      mem.action = null;
      mem.failureReason = decision.stop;
      report();
      return { kind: "wait" };
    }
    if (decision.action.kind !== "wait") {
      await deps.issue(decision.action);
    }
    report();
    return decision.action;
  }

  return {
    start(next: FleetCompanionRequest, resuming: CompanionAbandonmentRecord | null = null): void {
      mem = freshMemory();
      mem.status = "running";
      mem.role = next.role;
      mem.request = next;
      mem.phase = "Standing by";
      if (resuming !== null) {
        // A restart re-enters an abandonment already under way, keeping its
        // ORIGINAL clock. The get-safe flags start false on purpose: whatever
        // warp was in flight when the process died is not a warp this run has
        // observed, and claiming it had landed would let the next tick drop
        // fleet with the ship still sitting in space.
        mem.ladder = {
          lastSupervisorIDs: [...resuming.supervisorCharacterIDs],
          abandonment: {
            abandonedAtMs: resuming.abandonedAtMs,
            supervisorCharacterIDs: [...resuming.supervisorCharacterIDs],
            safeSpotWarpIssued: false,
            safeSpotWarpSeen: false,
          },
          closingOn: null,
        };
      }
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
