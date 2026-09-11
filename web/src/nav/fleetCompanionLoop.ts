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
  MAX_STARGATE_JUMPING_DISTANCE_M,
  STATION_DOCKING_RADIUS_M,
  type SpaceMeasurement,
} from "./autopilotLoop.ts";
// The kill-order authority (rung 4, "obeying the fleet"). Imported rather than
// re-derived for the same reason the get-safe helpers above are: one answer to
// "where does this tag rank", shared with the combat priority list.
import { fleetTagRank } from "./targetPriority.ts";
import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
import type { ChatMessage } from "../store/types.ts";
import {
  isChatCommandSenderAllowed,
  parseChatCommand,
  type ChatCommand,
} from "./chatCommands.ts";

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
  /**
   * The player's OWN pick of fitted SELF-repair modules, by item id, one list
   * per tank layer. Shield boosters here, armour repairers below, hull
   * repairers under that.
   *
   * ⚠ ONE LIST PER LAYER BECAUSE A SHIELD BOOSTER CANNOT REPAIR ARMOUR. The
   * hurt layer chooses the list, exactly as the DSL's `repairersFor` chooses
   * between `shieldRepairerIDs` / `armorRepairerIDs` / `hullRepairerIDs`, and
   * reaching across families would cycle a module that does nothing for the
   * layer actually taking damage.
   *
   * ⚠ PICKED, NOT CLASSIFIED, AND THAT BUYS TWO BUGS FOR FREE. The DSL derives
   * these from the fit by matching the SDE group NAME, and that classifier
   * cannot tell a free Damage Control from a cap-hungry active hardener (one
   * regex, `/hardener|damage control|resistance/i`, for both) -- and until
   * 2026-09-11 it also read every REMOTE repairer as a self repairer, because
   * its self branches were unanchored. Asking the operator has neither problem
   * to solve: there is nothing to misclassify.
   *
   * Empty is a real answer: this pilot has nothing fitted for that layer, and a
   * hurt reading there simply falls through.
   */
  readonly shieldBoosterModuleIDs: readonly number[];
  /** As `shieldBoosterModuleIDs`, for armour. */
  readonly armorRepairerModuleIDs: readonly number[];
  /** As `shieldBoosterModuleIDs`, for hull. */
  readonly hullRepairerModuleIDs: readonly number[];
  /**
   * The player's OWN pick of fitted REMOTE shield-repair modules, by item id
   * — never guessed, for the same reason `defenseModuleIDs` above is not: a
   * wrong guess cycles the wrong module. Answers a `HealShield` broadcast
   * (and, alongside the other two lists below, a `HealTarget` one — see
   * `healModuleCandidates`'s own comment for why that call draws on all
   * three). Empty means this pilot has no shield remote-rep fitted, and a
   * `HealShield` call simply falls through unanswered.
   */
  readonly remoteShieldModuleIDs: readonly number[];
  /** As `remoteShieldModuleIDs`, for armour — a shield booster cannot repair
   *  armour, so `HealArmor` draws on this list and never the shield one. */
  readonly remoteArmorModuleIDs: readonly number[];
  /** As `remoteShieldModuleIDs`, for capacitor transfers — `HealCapacitor`
   *  draws on this list alone, for the same reason. */
  readonly remoteCapacitorModuleIDs: readonly number[];
  /**
   * The player's OWN pick of fitted WEAPONS (turrets, launchers), by item id.
   *
   * ⚠ EMPTY IS A REAL ANSWER AND IT IS THE DEFAULT: this pilot locks what the
   * fleet calls and never fires. That is the phase 1 behaviour, kept as the
   * setting nobody has changed, so adding a weapons rung cannot arm a pilot
   * whose operator never asked for one.
   *
   * ⚠ PICKED, NOT DERIVED, AND THE DSL DOES THE OPPOSITE. `fight-the-rats`
   * reads `obs.weaponModuleIDs`, which `resolveDefenseModuleIDs` classifies out
   * of the fit by matching the group NAME against `/weapon|launcher|turret/i`.
   * The companion asks instead, for the same reason `defenseModuleIDs` and the
   * three remote lists are asked for: this loop obeys somebody ELSE's target
   * call, so the cost of a misclassified module is firing something the
   * operator did not know was armed at something they did not choose. A
   * mystery module is skipped by that classifier; it is not skipped by a
   * commander's broadcast.
   */
  readonly weaponModuleIDs: readonly number[];
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
  shieldBoosterModuleIDs: Object.freeze([]),
  armorRepairerModuleIDs: Object.freeze([]),
  hullRepairerModuleIDs: Object.freeze([]),
  remoteShieldModuleIDs: Object.freeze([]),
  remoteArmorModuleIDs: Object.freeze([]),
  remoteCapacitorModuleIDs: Object.freeze([]),
  // Empty: locks the call, never fires it. See the field comment for why an
  // unset weapon list is the right default for a loop that obeys other people.
  weaponModuleIDs: Object.freeze([]),
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
  /**
   * Recent chat lines, for the chat-command rung. Absent or empty means no
   * chat was read this tick, which is the same answer as "nobody said
   * anything" and is what a pilot that does not obey chat always sees.
   *
   * ⚠ ALREADY FRESHNESS-FILTERED BY THE BUILDER, exactly as `fleetBroadcast`
   * is, and against the same window. The loop deliberately carries no clock for
   * this: a stale order has to lapse so the pilot falls back to its own ladder,
   * and having ONE staleness policy for both sources is what stops "the fleet
   * called it" and "somebody typed it" ageing at different rates.
   *
   * ⚠ RAW LINES, NOT PARSED COMMANDS, AND THAT IS THE SECURITY BOUNDARY. The
   * sender allowlist lives on the REQUEST, which the builder does not hold, so
   * the gate has to run here where the request is. Handing this rung
   * pre-approved commands would move the decision about WHO MAY ORDER THIS SHIP
   * out of the layer that knows the operator's answer.
   */
  readonly chatMessages?: readonly ChatMessage[];
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
 * `wait` is what most ticks decide — nothing new to do. Below it sit two
 * unrelated groups, each belonging to its own rung:
 *
 *   • the abandonment protocol (decision 5, rung 2) — warp / approach / dock /
 *     warpToBookmark / leaveFleet / acceptFleetInvite — the one thing a
 *     companion left without a human may do unsupervised.
 *   • obeying the fleet (rung 4) — lock / align / activate / travelTo —
 *     answering a fleet tag or broadcast while a human IS supervising. See
 *     `decideFleetOrders`.
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
  | { readonly kind: "acceptFleetInvite"; readonly fleetID: number }
  /**
   * Obeying the fleet (rung 4): a tag or a `Target` broadcast, locked. Locking
   * is the whole of what this rung does with a target — there is no weapons
   * rung yet, so this is never a stand-in for shooting.
   */
  | { readonly kind: "lock"; readonly targetID: number }
  /** Obeying the fleet (rung 4): an `AlignTo` broadcast. */
  | { readonly kind: "align"; readonly targetID: number }
  /**
   * Obeying the fleet (rung 4): a Heal broadcast, answered with a fitted
   * remote-repair module aimed at the ship named. `repeat: -1` (run
   * continuously) is this codebase's own "keep cycling" — see the DSL's
   * `activate` case in flow.ts.
   */
  | { readonly kind: "activate"; readonly moduleID: number; readonly targetID: number }
  /**
   * Switch a module OFF. The companion's first: until the tank-up rung there
   * was nothing it started that it ever had to stop.
   *
   * ⚠ NOT FOR PROP MODS AS IT STANDS. `api.deactivateModule`'s own comment
   * warns that an afterburner or MWD only actually STOPS when Deactivate names
   * its propulsion effect -- the server infers a default effect on activate but
   * not on deactivate. Hardeners and repairers are unaffected. Read that
   * comment before widening this to anything that moves the ship.
   */
  | { readonly kind: "deactivate"; readonly moduleID: number }
  /**
   * Obeying the fleet (rung 4): a `TravelTo` broadcast — a solar system, not
   * an on-grid object, so this hands off to the SHARED autopilot
   * (flow.ts's `startRoute`) rather than warping or approaching itself.
   */
  | { readonly kind: "travelTo"; readonly systemID: number };

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
  /**
   * Modules RUNG 3 (tank up) has switched on and not yet switched back off —
   * the stand-down record. Mirrors `standDownAfterFight`'s own `hardened`
   * list, generalised to every module kind rung 3 can light (hardeners AND
   * self-repairers alike, both self-targeted), because the fight-end
   * stand-down switches off everything this rung is responsible for, not
   * hardeners alone.
   *
   * ⚠ WITHOUT THIS THE STAND-DOWN COULD SWITCH OFF A MODULE SOMEBODY ELSE
   * LIT. `activeModuleIDs` says a module is cycling; it never says WHO
   * switched it on. Only a module this rung remembers lighting is ever a
   * candidate for this rung to switch back off.
   */
  readonly lastTankUpModuleIDs: readonly number[];
  /**
   * The target rung 4 last issued a `lock` call for — the fallback for
   * `isAlreadyLocked` when `obs.lockedTargetIDs` itself is unreadable. See
   * that function's own comment for why the authoritative read still wins
   * whenever it is available.
   */
  readonly lastLockIssuedFor: number | null;
  /**
   * The ship rung 4 last aimed a Heal-family `activate` at, and which fitted
   * modules it has issued for THAT ship. This is the fallback
   * `isHealModuleAlreadyRunning` uses when `activeModuleIDs` cannot say —
   * nothing in a space snapshot exposes a remote-repair module's target, so
   * the server confirming a module is cycling is not by itself proof it is
   * cycling on the ship THIS tick's call names. Reset to a fresh list the
   * moment the call names a different ship.
   */
  readonly lastHealTargetID: number | null;
  readonly lastHealModuleIDs: readonly number[];
  /**
   * The solar system rung 4 last issued a `travelTo` route to, so a standing
   * `TravelTo` broadcast does not restart the shared autopilot every tick.
   */
  /**
   * The target rung 4 last aimed a WEAPON at, and which fitted weapons it has
   * issued for THAT target. The same pair, for the same reason, as
   * `lastHealTargetID` above: a snapshot says a module is cycling and never
   * says what it is cycling AT, so a gun still chewing on the rat the commander
   * has moved off looks identical to one obeying the current call. Reset to a
   * fresh list the moment the call names a different ship, which is what makes
   * a new call re-aim the whole rack.
   */
  readonly lastFireTargetID: number | null;
  readonly lastFireModuleIDs: readonly number[];
  readonly lastRoutedSystemID: number | null;
}

export function freshLadderMemory(): CompanionLadderMemory {
  return {
    lastSupervisorIDs: [],
    abandonment: null,
    closingOn: null,
    lastTankUpModuleIDs: [],
    lastLockIssuedFor: null,
    lastHealTargetID: null,
    lastHealModuleIDs: [],
    lastFireTargetID: null,
    lastFireModuleIDs: [],
    lastRoutedSystemID: null,
  };
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
  /**
   * Which authority this decision came from, for the readout. Omitted (never
   * `null` here — `tick()` supplies the default) by every rung except rung 4;
   * the controller reads that omission as `"own-ladder"`, which is the honest
   * answer for the warp yield, the supervision gate, the abandonment protocol
   * and "Standing by" alike — none of them are obeying an external order.
   */
  readonly followingOrderFrom?: "tag" | "broadcast" | "chat";
  /** Short plain words for the panel — never the broadcast's wire name. */
  readonly lastOrderHeard?: string;
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
 *
 * ⚠ RUNG 3 IS TANK UP, BELOW THE SUPERVISION GATE AND ABOVE OBEYING THE
 * FLEET. THE TANK GOES UP FIRST — the DSL's own fight-back watch lights
 * hardeners before it ever calls `fight-the-rats`, and its comment states the
 * principle this ordering rests on: a hardener is instant and self-targeted,
 * the same thing a player reaches for before they reach for the guns. It
 * costs at most a tick or two of a standing order going unobeyed, because
 * this rung has something to do only while a module is off and falls through
 * — returns null — the moment the rack is up. See `decideTankUp`'s own
 * header for the ladder inside this rung.
 *
 * ⚠ RUNG 4 IS OBEYING THE FLEET, BELOW TANK UP AND ABOVE "Standing by".
 * Unlike rung 2 it IS an order source (see `decideFleetOrders`'s own header
 * for the tag-over-broadcast reasoning and why an off-grid call is not an
 * order for this pilot at all).
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
      "The fleet is warping this ship. Nothing is decided until it lands.",
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
    lastTankUpModuleIDs: memory.lastTankUpModuleIDs,
    lastLockIssuedFor: memory.lastLockIssuedFor,
    lastFireTargetID: memory.lastFireTargetID,
    lastFireModuleIDs: memory.lastFireModuleIDs,
    lastHealTargetID: memory.lastHealTargetID,
    lastHealModuleIDs: memory.lastHealModuleIDs,
    lastRoutedSystemID: memory.lastRoutedSystemID,
  };

  // Rung 3: tank up. Threaded even when it has nothing to do this tick —
  // `tankedUp.memory` may have forgotten a finished stand-down record on a
  // tick that issued no action, and dropping it here would lose that the same
  // way skipping `stand.memory` would in `scriptDecide.ts`'s own equivalent.
  const tankedUp = decideTankUp(request, obs, supervised);
  if (tankedUp.decision !== null) {
    return tankedUp.decision;
  }

  const obeying = decideFleetOrders(request, obs, tankedUp.memory);
  if (obeying !== null) {
    return obeying;
  }

  // Phases 5-8 add further rungs here, in the order documented in
  // docs/fleet-companion-implementation.md, "The rung ladder".
  return waiting(
    "Standing by",
    "No fleet order to obey right now, and no further companion behaviour is built yet.",
    tankedUp.memory,
  );
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
      why: "Safe, and nobody is left to fly with, so this pilot is leaving the fleet.",
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
      why: "No station in view, so this pilot is warping to the safe spot.",
      memory: { ...mem, abandonment: { ...running, safeSpotWarpIssued: true } },
    };
  }
  // Issued, and no warp has been seen. Do NOT re-issue every two seconds, and
  // do NOT give up: the warp may simply not have started yet, and the
  // thirty-minute bound above is already the answer to one that never does.
  return waiting("Getting safe", "Waiting for the warp to the safe spot to start.", mem);
}

// ─── Rung 3: tank up ─────────────────────────────────────────────────────────
//
// A PORT, not an invention — see docs/fleet-companion-implementation.md,
// "Phase 3 — the spec". `scriptDecide.ts`'s `repair` interrupt response, fed by
// `repairersFor`, is a per-layer self-repair thermostat with a capacitor floor
// that INVERTS below the floor; `standDownAfterFight` is the shape the
// fight-end stand-down below copies; `scriptMacros.ts`'s `hardenersOn` is the
// ON-only hardener ladder this rung's first step mirrors. None of that code
// runs here — `observe(hint)` and `InterruptRow` belong to the DSL runner this
// loop is deliberately not part of — so the SHAPE is copied and the DATA comes
// off the request the operator picked (`defenseModuleIDs`,
// `shieldBoosterModuleIDs`, `armorRepairerModuleIDs`, `hullRepairerModuleIDs`),
// never off a fit classifier. See those fields' own comments for the two DSL
// bugs that disappear by asking instead of guessing.

/**
 * Below this fraction of a layer's max, that layer counts as hurt and this
 * rung cycles its own repairer.
 *
 * ⚠ NOT `request.fleeHealthFloor`. That field is phase 6's flee trigger and is
 * deliberately a lower, more desperate number — a pilot reaches for its own
 * repairer long before it reaches for the door. 0.75 is high enough that a
 * repairer switched on here has room to land a cycle before ordinary combat
 * damage could push the layer past what one cycle restores; low enough that a
 * layer sitting at 90-99% from routine passive regen never trips a repairer
 * that has nothing useful to do.
 */
export const TANK_LAYER_HURT_THRESHOLD = 0.75;

/** One tank layer: its current reading and the operator's own repairer picks. */
interface TankLayer {
  readonly name: "shield" | "armor" | "hull";
  readonly ratio: number | null;
  readonly moduleIDs: readonly number[];
}

/**
 * Shield, then armour, then hull — the same order `repairersFor` lists them
 * in, and the order a shield-first tank actually loses layers in.
 */
function tankLayers(request: FleetCompanionRequest, obs: FleetCompanionObservation): readonly TankLayer[] {
  return [
    { name: "shield", ratio: obs.shieldRatio, moduleIDs: request.shieldBoosterModuleIDs },
    { name: "armor", ratio: obs.armorRatio, moduleIDs: request.armorRepairerModuleIDs },
    { name: "hull", ratio: obs.hullRatio, moduleIDs: request.hullRepairerModuleIDs },
  ];
}

type LayerRepairAction =
  | { readonly kind: "activate"; readonly moduleID: number; readonly layerName: TankLayer["name"] }
  | {
      readonly kind: "deactivate";
      readonly moduleID: number;
      readonly layerName: TankLayer["name"];
      /** Which off-half fired: the capacitor floor, or the layer being whole again. */
      readonly because: "cap-floor" | "recovered";
    };

/**
 * One layer's own repair decision — the `repair` interrupt response's body,
 * scoped to a single layer instead of a single watch row: this loop has no
 * rows, so each layer plays the part a `shield-below` / `armor-below` /
 * `hull-below` row would.
 *
 * ⚠ CANNOT-TELL NEVER STARTS A CYCLE. An unreadable layer ratio reads as "not
 * hurt" here, the same rule every tri-state read in this file follows — a
 * layer this loop cannot see is not one it can decide is hurt.
 *
 * ⚠ THE INVERSION IS THE POINT OF THE WHOLE RUNG. Below `capacitorFloor`, a
 * RUNNING repairer for this layer switches off instead of an idle one
 * starting, even though the layer is (by definition, to have reached this
 * branch) still hurt. The floor is not "can this ship still warp" — warp
 * costs no capacitor on this server, see `capacitorFloor`'s own comment for
 * the length of that answer — it is that an empty capacitor repairs nothing,
 * so a repairer cycling below the floor is spending capacity that heals
 * nobody.
 *
 * `null` covers every "nothing NEW for this layer" case: not hurt,
 * unreadable, nothing fitted for it, or every fitted candidate is already in
 * the state this layer wants it in.
 */
function decideLayerRepairer(
  layer: TankLayer,
  active: ReadonlySet<number>,
  capacitorRatio: number | null,
  capacitorFloor: number,
): LayerRepairAction | null {
  if (layer.ratio === null) {
    // Cannot tell: neither start a cycle nor stop one. Stopping blind is the
    // same mistake as standing the hardeners down blind -- an unreadable layer
    // is not a layer this rung has seen recover.
    return null;
  }
  if (layer.ratio >= TANK_LAYER_HURT_THRESHOLD) {
    // ⚠ THE THERMOSTAT'S OTHER OFF-HALF, and the rung is wrong without it. A
    // layer that heals back up mid-fight leaves its repairer cycling on a whole
    // layer, and the DSL has a whole pass for exactly this (`repairShutdown`,
    // scriptDecide.ts) whose comment gives the reason: they "stop eating
    // capacitor once the ship is whole".
    //
    // Leaving it out does not merely waste a little capacitor -- it aims the
    // ship at the capacitor floor, and the floor is the SAFETY NET, not the
    // normal off-switch. A rung that only ever stops repairing by hitting the
    // floor has arranged to spend every fight at the one capacitor level it
    // exists to keep the ship away from.
    //
    // One threshold serves both directions, exactly as a `shield-below` watch
    // and its `repairShutdown` share one. That can chatter for a layer sitting
    // right on the line; the DSL has lived with the same property, and a second
    // hysteresis number tuned by nobody would be worse than the chatter.
    const running = layer.moduleIDs.find((id) => active.has(id));
    return running === undefined
      ? null
      : { kind: "deactivate", moduleID: running, layerName: layer.name, because: "recovered" };
  }
  // Unreadable capacitor fails OPEN toward repairing, not against it — the
  // same choice the DSL's own `repair` case makes (`cap !== null && cap <
  // REPAIR_CAP_FLOOR`). The risk of an unseen empty cap is a wasted cycle; the
  // risk of refusing to repair on a guess is a layer this rung could have saved.
  if (capacitorRatio !== null && capacitorRatio < capacitorFloor) {
    const running = layer.moduleIDs.find((id) => active.has(id));
    return running === undefined
      ? null
      : { kind: "deactivate", moduleID: running, layerName: layer.name, because: "cap-floor" };
  }
  const idle = layer.moduleIDs.find((id) => !active.has(id));
  return idle === undefined ? null : { kind: "activate", moduleID: idle, layerName: layer.name };
}

interface TankUpStep {
  /** Non-null when this rung has something NEW to do this tick. */
  readonly decision: CompanionDecision | null;
  /**
   * The memory to carry forward regardless of `decision`. Needed because the
   * fight-end stand-down below can finish — forgetting its own record — on a
   * tick where it has nothing left to switch off, the same way
   * `standDownAfterFight` threads a forgotten record through even when its own
   * action for that tick is null.
   */
  readonly memory: CompanionLadderMemory;
}

/**
 * Rung 3: tank up. See the header above `decideCompanionAction` for why this
 * sits above obeying the fleet (rung 4) and below the supervision gate.
 *
 * ⚠ HARDENERS ARE NEVER CAP-GATED, UNLIKE THE REPAIRERS BELOW. The
 * implementation doc's earlier rung-2 table said to gate them too, because
 * the DSL's fit classifier cannot tell a free Damage Control from a
 * cap-hungry active hardener — one regex, `/hardener|damage control|
 * resistance/i`, for both. `defenseModuleIDs` is the operator's OWN pick, so
 * there is nothing left here to be unsure about, and delaying a free cycle
 * for a floor that exists to protect REPAIR throughput is a cost with no
 * matching benefit.
 *
 * The ladder, one action per tick, falling through (returning a null
 * `decision`) the moment there is nothing NEW to do — the same shape and the
 * same reason `decideHealOrder` uses:
 *
 *   1. a fitted hardener switches on while a fight is on
 *   2. a hurt layer's OWN repairer switches on — shield from the shield list,
 *      armour from the armour list, hull from the hull list, never across
 *      families
 *   3. INVERTED below `request.capacitorFloor`: a RUNNING repairer switches
 *      OFF instead of another one starting, even while that layer is still
 *      hurt — see `decideLayerRepairer`'s own comment for why
 *   4. once the fight is confirmed over, every module THIS rung switched on
 *      switches back off, one per tick
 *
 * ⚠ NEVER STAND DOWN ON A BLIND READ. Step 4 fires only on an explicit
 * `hostileOnGrid === false`, never on `null` (cannot tell) — the same rule
 * `standDownAfterFight`'s own comment states: "standing down blind is the
 * worst possible moment to drop the tank."
 *
 * ⚠ A LAYER THAT HEALS MID-FIGHT IS AN ACCEPTED GAP, NOT AN OVERSIGHT. The
 * DSL's `repairShutdown` stands a repairer down the instant ITS OWN watch
 * reads not-met, independently of whether a fight is still on at all. This
 * rung does not port that: a repairer it lit keeps cycling on a layer that has
 * since topped up until EITHER the capacitor floor inverts it OR the fight
 * ends and step 4 clears it. A cycle spent on a full layer is a wasted one,
 * not a dangerous one, and the capacitor floor already bounds how long that
 * waste can run — a third, per-layer recovery-driven off switch was not asked
 * for and would need its own bookkeeping distinct from steps 3 and 4's.
 */
function decideTankUp(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): TankUpStep {
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);

  // 1. Hardeners up while a fight is on. Both reads already exist on the
  //    observation; either one alone is enough to mean "a fight is on".
  const fightOn = obs.hostileOnGrid === true || obs.targetedByPlayer === true;
  if (fightOn) {
    const idleHardener = request.defenseModuleIDs.find((id) => !active.has(id));
    if (idleHardener !== undefined) {
      const lit: CompanionLadderMemory = {
        ...memory,
        lastTankUpModuleIDs: [...memory.lastTankUpModuleIDs, idleHardener],
      };
      return {
        decision: {
          action: { kind: "activate", moduleID: idleHardener, targetID: 0 },
          phase: "Tanking up",
          why: "Hostiles are on this grid, so a fitted hardener is switching on.",
          memory: lit,
        },
        memory: lit,
      };
    }
  }

  // 2 & 3. Each layer's own repairer — on while hurt, inverted off below the
  //        capacitor floor. See `decideLayerRepairer`'s own comment.
  for (const layer of tankLayers(request, obs)) {
    const layerAction = decideLayerRepairer(layer, active, obs.capacitorRatio ?? null, request.capacitorFloor);
    if (layerAction === null) {
      continue;
    }
    if (layerAction.kind === "activate") {
      const lit: CompanionLadderMemory = {
        ...memory,
        lastTankUpModuleIDs: [...memory.lastTankUpModuleIDs, layerAction.moduleID],
      };
      return {
        decision: {
          action: { kind: "activate", moduleID: layerAction.moduleID, targetID: 0 },
          phase: "Tanking up",
          why: `The ${layerAction.layerName} is hurt, so a fitted repairer is switching on.`,
          memory: lit,
        },
        memory: lit,
      };
    }
    // Whatever switched it off, this rung is no longer holding it on, so it
    // leaves the stand-down record. A stale entry would be harmless (the
    // stand-down only ever switches off what it can still see running) but it
    // would make the record a log of what this rung once did rather than a
    // statement of what it is holding on right now, which is what it is for.
    const dropped: CompanionLadderMemory = {
      ...memory,
      lastTankUpModuleIDs: memory.lastTankUpModuleIDs.filter((id) => id !== layerAction.moduleID),
    };
    return {
      decision: {
        action: { kind: "deactivate", moduleID: layerAction.moduleID },
        phase: "Tanking up",
        why:
          layerAction.because === "cap-floor"
            ? "The capacitor is too low to keep repairing, so a running repairer is switching off."
            : `The ${layerAction.layerName} is whole again, so its repairer is switching off.`,
        memory: dropped,
      },
      memory: dropped,
    };
  }

  // 4. Stand down once the fight is confirmed over — never on a blind read.
  if (obs.hostileOnGrid === false && memory.lastTankUpModuleIDs.length > 0) {
    const stillOn = memory.lastTankUpModuleIDs.find((id) => active.has(id));
    if (stillOn !== undefined) {
      const remaining: CompanionLadderMemory = {
        ...memory,
        lastTankUpModuleIDs: memory.lastTankUpModuleIDs.filter((id) => id !== stillOn),
      };
      return {
        decision: {
          action: { kind: "deactivate", moduleID: stillOn },
          phase: "Standing down",
          why: "The fight is over, so a module this pilot switched on is switching back off.",
          memory: remaining,
        },
        memory: remaining,
      };
    }
    // Everything this rung lit is already off (switched off here over the
    // last few ticks, or ended on its own) — forget the record so the next
    // fight starts clean, with no action issued this tick.
    return { decision: null, memory: { ...memory, lastTankUpModuleIDs: [] } };
  }

  return { decision: null, memory };
}

/** An entity present on THIS grid, or null when the snapshot does not carry it. */
function entityOnGrid(itemID: number, entities: readonly SpaceEntity[]): SpaceEntity | null {
  return entities.find((entity) => entity.itemID === itemID) ?? null;
}

/**
 * The best-ranked TAGGED entity on grid, by `fleetTagRank` — nearest breaks a
 * tie between two entities carrying tags of equal rank (an unrecognised tag,
 * or two hand-typed tags that happen to collide; see `fleetTagRank`'s own
 * comment on why an unrecognised tag still gets a finite rank rather than
 * being dropped).
 */
function bestTaggedEntity(
  tags: ReadonlyMap<number, string>,
  entities: readonly SpaceEntity[],
  measurement: SpaceMeasurement | null,
): SpaceEntity | null {
  let bestRank = Number.POSITIVE_INFINITY;
  let candidates: SpaceEntity[] = [];
  for (const entity of entities) {
    const tag = tags.get(entity.itemID);
    if (tag === undefined) {
      continue;
    }
    const rank = fleetTagRank(tag);
    if (rank < bestRank) {
      bestRank = rank;
      candidates = [entity];
    } else if (rank === bestRank) {
      candidates.push(entity);
    }
  }
  return candidates.length === 0 ? null : nearestOf(candidates, measurement);
}

/**
 * Whether `targetID` is already locked.
 *
 * ⚠ THE AUTHORITATIVE READ WINS WHENEVER IT IS READABLE AT ALL. `obs.lockedTargetIDs`
 * comes straight off the server's own lock list, the same authority
 * `miningBotLoop.ts`'s `getLockedTargetIDs` trusts over its own memory — an
 * EMPTY array is a real "nothing locked" answer, not a failed read, so it is
 * trusted exactly like a non-empty one. Only `null`/`undefined` (unreadable,
 * or simply not wired up by this host's `observe()` yet) falls back to the
 * ladder's own memory of the last target IT issued a `lock` call for — the
 * same "compare and stamp" `closingOn` already uses, so a target whose lock is
 * merely in flight is not re-issued every tick just because this tick's
 * authoritative read did not arrive.
 */
function isAlreadyLocked(
  targetID: number,
  lockedTargetIDs: readonly number[] | null | undefined,
  memory: CompanionLadderMemory,
): boolean {
  if (lockedTargetIDs !== null && lockedTargetIDs !== undefined) {
    return lockedTargetIDs.includes(targetID);
  }
  return memory.lastLockIssuedFor === targetID;
}

/**
 * Every weapon the ship is running, counting a banked SLAVE as running whenever
 * its master is.
 *
 * ⚠ WITHOUT THE BANK PASS THIS RUNG RE-ISSUES THE SAME GUN FOREVER, and the
 * pilot does nothing else for as long as the order stands.
 * `SpaceShipStatus.weaponBanks` says it plainly: activating a slave fires the
 * whole bank THROUGH its master, and `activeModuleIDs` then names only the
 * master. So a slave never appears to be cycling on its own, and because this
 * loop issues at most one call per tick, that one slave eats the action slot
 * every rung beneath it needs.
 *
 * ⚠ THE SAME GAP IS LIVE IN THE DSL, and is deliberately not fixed from here.
 * `fightTheRats` and `engagePrey` both do the naive `find` over
 * `activeModuleIDs`, and nothing under `nav/` reads `weaponBanks` at all --
 * only the manual rack does. It costs them less, because their tick has nowhere
 * else to be, so it reads there as wasted calls rather than as a stall. Worth
 * fixing; not worth a companion rung quietly changing what the ratting block
 * does.
 */
function cyclingWeapons(snapshot: SpaceSnapshot | null): ReadonlySet<number> {
  const cycling = new Set(snapshot?.ship?.activeModuleIDs ?? []);
  const banks = snapshot?.ship?.weaponBanks ?? null;
  for (const masterID of Object.keys(banks ?? {})) {
    if (!cycling.has(Number(masterID))) {
      continue;
    }
    for (const slaveID of banks?.[Number(masterID)] ?? []) {
      cycling.add(slaveID);
    }
  }
  return cycling;
}

/**
 * Is this weapon already firing at THIS target?
 *
 * The same two-part test `isHealModuleAlreadyRunning` makes, for the same
 * reason: a snapshot says a module is cycling, and never says what it is
 * cycling AT. So "cycling" alone cannot answer this -- a gun happily chewing on
 * the rat the commander has just moved off is cycling, and it is exactly the
 * gun that needs re-issuing. The memory of what this rung aimed where is the
 * half that knows the target, and it is reset the moment the call names a
 * different ship, so a new call re-aims the whole rack a gun at a time.
 *
 * When `activeModuleIDs` is unreadable the memory is trusted ALONE, which is
 * what stops an unreadable snapshot re-firing the rack every tick.
 */
function isWeaponAlreadyFiringAt(
  moduleID: number,
  targetID: number,
  cycling: ReadonlySet<number>,
  activeModuleIDs: readonly number[] | null,
  memory: CompanionLadderMemory,
): boolean {
  const issuedAtThisTarget =
    memory.lastFireTargetID === targetID && memory.lastFireModuleIDs.includes(moduleID);
  if (activeModuleIDs !== null) {
    return cycling.has(moduleID) && issuedAtThisTarget;
  }
  return issuedAtThisTarget;
}

/**
 * The fleet called this target and the lock has landed: open fire.
 *
 * One weapon per tick, the same discipline `hardenersOn` uses on a rack of
 * hardeners -- the guns come up over a few ticks rather than in one burst of
 * calls, and every tick re-reads what is actually cycling before it picks the
 * next one.
 *
 * `null` is "nothing NEW to start", covering no weapon picked and every picked
 * weapon already firing at this target alike, and the caller falls through on
 * both -- the same shape, and the same reason, as `decideHealOrder`.
 */
function decideOpenFire(
  targetID: number,
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): { readonly moduleID: number; readonly memory: CompanionLadderMemory } | null {
  const activeModuleIDs = obs.snapshot?.ship?.activeModuleIDs ?? null;
  const cycling = cyclingWeapons(obs.snapshot ?? null);
  const next = request.weaponModuleIDs.find(
    (id) => !isWeaponAlreadyFiringAt(id, targetID, cycling, activeModuleIDs, memory),
  );
  if (next === undefined) {
    return null;
  }
  const aimed =
    memory.lastFireTargetID === targetID ? [...memory.lastFireModuleIDs, next] : [next];
  return {
    moduleID: next,
    memory: { ...memory, lastFireTargetID: targetID, lastFireModuleIDs: aimed },
  };
}

/**
 * One rung-3 decision over a called target: lock it, then shoot it.
 *
 * ⚠ THE ORDER IS LOCK, OBSERVE, THEN FIRE, and the middle step is not a
 * formality. `isAlreadyLocked` prefers the authoritative `lockedTargetIDs`
 * read precisely because a lock this loop ISSUED may have been refused, and a
 * weapon activated against an unlocked ship is a call the server throws away.
 * Firing only past that check means the guns come up on the tick the lock is
 * seen to exist, never on the tick it was asked for.
 */
function lockThenEngage(
  targetID: number,
  source: "tag" | "broadcast" | "chat",
  heard: string,
  why: string,
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionDecision {
  if (!isAlreadyLocked(targetID, obs.lockedTargetIDs, memory)) {
    return {
      action: { kind: "lock", targetID },
      phase: "Obeying fleet",
      why: why + " Locking it.",
      memory: { ...memory, lastLockIssuedFor: targetID },
      followingOrderFrom: source,
      lastOrderHeard: heard,
    };
  }
  const fire = decideOpenFire(targetID, request, obs, memory);
  if (fire !== null) {
    return {
      action: { kind: "activate", moduleID: fire.moduleID, targetID },
      phase: "Obeying fleet",
      why: why + " Opening fire on it.",
      memory: fire.memory,
      followingOrderFrom: source,
      lastOrderHeard: heard,
    };
  }
  return {
    action: WAIT,
    phase: "Obeying fleet",
    // ⚠ THE NO-WEAPON CASE SAYS SO, and that is the whole of its job. An empty
    // weapon list is a setting, not a fault, so it must not read as one -- but
    // a pilot that locks a called target and never shoots it is EXACTLY what
    // this rung was built to stop being, and an operator who left the list
    // empty by accident would otherwise watch the old behaviour and conclude
    // the feature is broken.
    why:
      why +
      (request.weaponModuleIDs.length === 0
        ? " Locked. No weapon is picked for this pilot, so it holds the lock without firing."
        : " Locked, and firing on it."),
    memory,
    followingOrderFrom: source,
    lastOrderHeard: heard,
  };
}

/** The four Heal broadcast names, narrowed out of `FleetBroadcastName`. */
type HealBroadcastName = "HealShield" | "HealArmor" | "HealCapacitor" | "HealTarget";

function asHealBroadcastName(name: string | undefined): HealBroadcastName | null {
  return name === "HealShield" ||
    name === "HealArmor" ||
    name === "HealCapacitor" ||
    name === "HealTarget"
    ? name
    : null;
}

/**
 * Which of this pilot's fitted REMOTE repair modules answer a given Heal
 * broadcast.
 *
 * `HealShield`/`HealArmor`/`HealCapacitor` each name their own layer, so each
 * draws from exactly one list — a shield booster cannot repair armour, and
 * reaching across families would cycle a module that does nothing for the
 * layer the call is actually about.
 *
 * `HealTarget` is different, and deliberately not treated as a fourth family
 * of its own: real fleet logi use it to say "concentrate on THIS ship"
 * without saying which layer is hurt — that judgement is left to whichever
 * logi answers, using whatever they have fitted. So it draws on all three
 * lists, shield first then armour then capacitor, and this pilot brings
 * whatever remote reps it owns to a call that does not specify one.
 */
function healModuleCandidates(
  name: HealBroadcastName,
  request: FleetCompanionRequest,
): readonly number[] {
  switch (name) {
    case "HealShield":
      return request.remoteShieldModuleIDs;
    case "HealArmor":
      return request.remoteArmorModuleIDs;
    case "HealCapacitor":
      return request.remoteCapacitorModuleIDs;
    case "HealTarget":
      return [
        ...request.remoteShieldModuleIDs,
        ...request.remoteArmorModuleIDs,
        ...request.remoteCapacitorModuleIDs,
      ];
  }
}

/** Plain words for a Heal broadcast, for the readout — never the wire name. */
function healOrderWhy(name: HealBroadcastName): string {
  switch (name) {
    case "HealShield":
      return "The fleet called for shield reps on a ship on this grid.";
    case "HealArmor":
      return "The fleet called for armour reps on a ship on this grid.";
    case "HealCapacitor":
      return "The fleet called for a capacitor transfer to a ship on this grid.";
    case "HealTarget":
      return "The fleet called to focus reps on a ship on this grid.";
  }
}

function healOrderHeard(name: HealBroadcastName): string {
  switch (name) {
    case "HealShield":
      return "the fleet's call for shield reps";
    case "HealArmor":
      return "the fleet's call for armour reps";
    case "HealCapacitor":
      return "the fleet's call for a capacitor transfer";
    case "HealTarget":
      return "the fleet's call to focus reps";
  }
}

/**
 * Whether `moduleID` is already cycling on `targetID`, so rung 4 does not
 * re-activate a running repairer every tick.
 *
 * ⚠ THE AUTHORITATIVE READ (`activeModuleIDs`, the ship snapshot's own
 * cycling set — see `SpaceShipStatus.activeModuleIDs`'s own comment) IS
 * PREFERRED, exactly as `isAlreadyLocked` prefers `obs.lockedTargetIDs`. But
 * it answers a DIFFERENT question: it says whether the module is cycling at
 * all, never AT WHOM — nothing in a space snapshot exposes a remote-repair
 * module's target. So a module the server confirms is active only counts as
 * "already answering THIS call" when this ladder's own memory also agrees it
 * was the one that aimed that module at `targetID`; otherwise it is cycling
 * on a stale target from before the broadcast changed, and must be
 * re-issued to redirect it.
 *
 * When `activeModuleIDs` cannot be read at all (`null`), there is nothing
 * authoritative to prefer, so this falls back to the memory alone — the same
 * "compare and stamp" `isAlreadyLocked` falls back to.
 */
function isHealModuleAlreadyRunning(
  moduleID: number,
  targetID: number,
  activeModuleIDs: readonly number[] | null,
  memory: CompanionLadderMemory,
): boolean {
  const issuedForThisTarget =
    memory.lastHealTargetID === targetID && memory.lastHealModuleIDs.includes(moduleID);
  if (activeModuleIDs !== null) {
    return activeModuleIDs.includes(moduleID) && issuedForThisTarget;
  }
  return issuedForThisTarget;
}

/**
 * The Heal family's own rung-3 sub-decision. `null` covers every "nothing
 * NEW to do" case at once — no matching broadcast, no matching module
 * fitted, the named ship is off this grid, or every fitted candidate for
 * this call is already cycling on it — and the caller falls through on all
 * of them alike; see `decideFleetOrders`'s header for why that fall-through,
 * rather than a parked "wait", is the point.
 */
function decideHealOrder(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  entities: readonly SpaceEntity[],
  memory: CompanionLadderMemory,
): CompanionDecision | null {
  const name = asHealBroadcastName(obs.fleetBroadcast?.name);
  if (name === null) {
    return null;
  }
  // ⚠ ITEMID IS THE SHIP TO REPAIR, DIRECTLY, FOR ALL FOUR NAMES — never
  // `senderCharID` resolved to an entity. `HealShield`/`HealArmor`/
  // `HealCapacitor` name the SENDER's own ship this way; `HealTarget` names
  // a third party's. See `FLEET_BROADCAST_CLASSIFICATION` in
  // fleetBroadcasts.ts.
  const targetID = obs.fleetBroadcast?.itemID ?? null;
  if (targetID === null || entityOnGrid(targetID, entities) === null) {
    // Off this grid — not an order for this pilot right now. A logi two
    // systems away is not being asked to do anything.
    return null;
  }
  const activeModuleIDs = obs.snapshot?.ship?.activeModuleIDs ?? null;
  const moduleID = healModuleCandidates(name, request).find(
    (id) => !isHealModuleAlreadyRunning(id, targetID, activeModuleIDs, memory),
  );
  if (moduleID === undefined) {
    // Either this pilot has nothing fitted for this call — a dps-role
    // companion is not obligated to grow a repairer it was never given, and
    // A LOGI-LESS PILOT IS STILL A WORKING PILOT: it must fall through to
    // its tag/Target lock rather than freeze on a call it cannot answer —
    // or everything fitted for this call is already cycling on this target,
    // in which case there is still nothing NEW to start.
    return null;
  }
  return {
    action: { kind: "activate", moduleID, targetID },
    phase: "Obeying fleet",
    why: healOrderWhy(name) + " Activating the fitted remote repairer.",
    memory: {
      ...memory,
      lastHealTargetID: targetID,
      lastHealModuleIDs:
        memory.lastHealTargetID === targetID ? [...memory.lastHealModuleIDs, moduleID] : [moduleID],
    },
    followingOrderFrom: "broadcast",
    lastOrderHeard: healOrderHeard(name),
  };
}

/** The four broadcast names that name a thing to go to or shoot. */
type NamedOrderName = "Target" | "AlignTo" | "TravelTo" | "JumpTo";

/**
 * One order this pilot is being given, with the source it came from already
 * decided. `why` is the readout sentence's opening clause and `heard` is the
 * one-line "what it is obeying" the panel shows; both name the SOURCE, because
 * "the fleet called this" and "somebody typed this" are different claims and a
 * player reading the panel is entitled to know which one they are looking at.
 */
interface NamedOrder {
  readonly name: NamedOrderName;
  readonly itemID: number;
  readonly source: "broadcast" | "chat";
  readonly heard: string;
  readonly why: string;
}

const CHAT_ORDER_NAMES: Readonly<Record<ChatCommand["kind"], NamedOrderName>> = Object.freeze({
  target: "Target",
  align: "AlignTo",
  travel: "TravelTo",
  jump: "JumpTo",
});

const ORDER_HEARD: Readonly<Record<NamedOrderName, { readonly broadcast: string; readonly chat: string }>> =
  Object.freeze({
    Target: { broadcast: "the fleet's target call", chat: "a chat order to shoot a target" },
    AlignTo: { broadcast: "the fleet's align call", chat: "a chat order to align" },
    TravelTo: { broadcast: "the fleet's travel call", chat: "a chat order to travel" },
    JumpTo: { broadcast: "the fleet's jump call", chat: "a chat order to jump" },
  });

const ORDER_WHY: Readonly<Record<NamedOrderName, { readonly broadcast: string; readonly chat: string }>> =
  Object.freeze({
    Target: {
      broadcast: "The fleet broadcast a target on this grid.",
      chat: "An allowed pilot called a target in chat.",
    },
    AlignTo: {
      broadcast: "The fleet broadcast an align point on this grid.",
      chat: "An allowed pilot called an align point in chat.",
    },
    TravelTo: {
      broadcast: "The fleet broadcast a system to travel to.",
      chat: "An allowed pilot called a system to travel to in chat.",
    },
    JumpTo: {
      broadcast: "The fleet called a gate on this grid.",
      chat: "An allowed pilot called a gate in chat.",
    },
  });

function asNamedOrderName(name: string | undefined): NamedOrderName | null {
  return name === "Target" || name === "AlignTo" || name === "TravelTo" || name === "JumpTo"
    ? name
    : null;
}

/**
 * The newest chat line that is BOTH from a sender the operator allowed AND a
 * command this loop has a rung for.
 *
 * ⚠ THE GATE IS THE SENDER, AND IT IS CHECKED BEFORE THE TEXT MEANS ANYTHING.
 * `isChatCommandSenderAllowed` keys on `characterID`, which the chat backend
 * fills in server-side from the authenticated session and never from the
 * message body — so no amount of crafting the text changes who a line is
 * attributed to. `chatCommandSenders` comes off the request the operator
 * controls, and is NEVER populated from chat itself. An empty list allows
 * nobody, which is the shipped default: a companion nobody has explicitly
 * authorised takes orders from no one over chat.
 *
 * Newest wins, because a later order supersedes an earlier one exactly as a
 * later broadcast replaces the one before it.
 */
function newestChatOrder(
  messages: readonly ChatMessage[],
  chatCommandSenders: readonly number[],
): { readonly command: ChatCommand; readonly at: number } | null {
  let best: { readonly command: ChatCommand; readonly at: number } | null = null;
  for (const message of messages) {
    if (!isChatCommandSenderAllowed(message, chatCommandSenders)) {
      continue;
    }
    const command = parseChatCommand(message);
    if (command === null) {
      continue;
    }
    if (best === null || message.createdAtMs >= best.at) {
      best = { command, at: message.createdAtMs };
    }
  }
  return best;
}

/**
 * Can this pilot actually act on that order, here, now?
 *
 * ⚠ THIS IS THE TEST THAT MAKES "FALL THROUGH TO THE NEXT SOURCE" TRUE, and it
 * has to run while choosing the source rather than inside the branch that acts.
 * The rung's header has always said that a call for something not on this grid
 * is skipped "falling through to the next source" -- back when a broadcast was
 * the only source that could not be observed, because the only thing below it
 * was "Standing by". Now that chat is a real next source, an off-grid broadcast
 * that is chosen and only THEN found unactionable does not fall through to
 * anything: it silently starves a perfectly good chat order, and the pilot
 * stands by while somebody with authority is telling it what to shoot.
 *
 * `TravelTo` is the standing exception, for the reason the header gives: its
 * itemID is a solar SYSTEM, not an object, so there is nothing on this grid to
 * check it against.
 */
function isOrderActionable(
  name: NamedOrderName,
  itemID: number,
  entities: readonly SpaceEntity[],
): boolean {
  return name === "TravelTo" || entityOnGrid(itemID, entities) !== null;
}

/**
 * Which named order this pilot is obeying this tick, from whichever source is
 * entitled to give it one.
 *
 * ⚠ A BROADCAST OUTRANKS A CHAT LINE, and the decided precedence table says so:
 * server fleet warp > FC broadcast > chat command > own flee rule > own ladder.
 * The reason is that a broadcast is the game's own fleet mechanism, carried on
 * a channel only fleet members can reach, while a chat line is text on a
 * channel anybody in the system can type into — it is trustworthy here only
 * because the operator named its sender in advance. When both speak at once,
 * the in-game mechanism is the one that wins.
 *
 * ⚠ STALENESS IS NOT HANDLED HERE, ON PURPOSE. Both sources arrive already
 * freshness-filtered by the observation builder — `fleetBroadcast` against
 * `FLEET_BROADCAST_TTL_MS`, and `chatMessages` against the same window for the
 * same reason. That is what makes a lapsed order fall back to this pilot's own
 * ladder rather than standing forever, and it is deliberately ONE policy rather
 * than two: a chat order that has gone quiet is exactly as stale as a broadcast
 * that has.
 */
function resolveNamedOrder(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  entities: readonly SpaceEntity[],
): NamedOrder | null {
  if (request.obeys.includes("broadcast")) {
    const name = asNamedOrderName(obs.fleetBroadcast?.name);
    const itemID = obs.fleetBroadcast?.itemID ?? null;
    if (name !== null && itemID !== null && isOrderActionable(name, itemID, entities)) {
      return {
        name,
        itemID,
        source: "broadcast",
        heard: ORDER_HEARD[name].broadcast,
        why: ORDER_WHY[name].broadcast,
      };
    }
  }
  if (request.obeys.includes("chat")) {
    const chat = newestChatOrder(obs.chatMessages ?? [], request.chatCommandSenders);
    if (chat !== null) {
      const name = CHAT_ORDER_NAMES[chat.command.kind];
      if (!isOrderActionable(name, chat.command.itemID, entities)) {
        return null;
      }
      return {
        name,
        itemID: chat.command.itemID,
        source: "chat",
        heard: ORDER_HEARD[name].chat,
        why: ORDER_WHY[name].chat,
      };
    }
  }
  return null;
}

/**
 * Rung 4: obeying the fleet. Below the supervision gate and rung 3 (tank up)
 * and above "Standing by". Returns `null` when there is nothing to obey,
 * which is how the caller falls through to standing by.
 *
 * Checked in this order — the Heal family, then a fleet tag, then a `Target`
 * broadcast, then `AlignTo`, then `TravelTo`, then `JumpTo` — for two
 * DIFFERENT reasons, not one:
 *
 * ⚠ HEAL OUTRANKS EVEN THE TAG, AND THE REASON IS NOT AUTHORITY, IT IS
 * URGENCY AND NON-EXCLUSIVITY. A tag is standing fleet state — still true
 * next tick, and the tick after that — where a rep call is time-critical:
 * someone is dying now. And unlike locking, which competes with a tag for
 * the very same action, healing does not compete with locking for the
 * SHIP'S STATE at all — a logi can run a repairer and hold a lock at once.
 * It only competes for THIS TICK'S one atomic call. That is exactly why
 * `decideHealOrder` returns `null` — falls through, rather than parking the
 * tick the way `lockThenEngage`'s "already locked" branch does — the moment
 * there is nothing NEW to start: a logi whose repairer is already cycling is
 * still free to lock the primary on the very same tick's next check, and a
 * dps pilot with nothing fitted for the call is never blocked by it at all.
 *
 * ⚠ A TAG OUTRANKS A BROADCAST, WHICH LOOKS BACKWARDS: a broadcast is the
 * FRESHER, more deliberate act, so a later reader will want to swap these.
 * Don't — the reason is AUTHORITY, and it is in the server, not in freshness.
 * `setFleetTargetTag` refuses any writer who is not a fleet commander, so a
 * tag that EXISTS is provably a commander's. `sendBroadcast` checks fleet
 * MEMBERSHIP and nothing else — any member may broadcast `Target` — and
 * receiving one says nothing at all about who sent it. When the two disagree,
 * the tag is the one that can only be the FC's. (This is a SEPARATE ranking
 * question from Heal-vs-tag above: Target/AlignTo/TravelTo/JumpTo are all
 * read off the SAME `obs.fleetBroadcast` slot as Heal, so only one of them
 * can ever match in a given tick anyway — their relative order below never
 * actually competes for anything.)
 *
 * ⚠ A CALL FOR SOMETHING NOT ON THIS GRID IS NOT AN ORDER FOR THIS PILOT. A
 * tagged or called item absent from `obs.snapshot` is skipped — falling
 * through to the next source, and ultimately to "Standing by" — rather than
 * waited on. That is what keeps a follower flying its own ladder while the FC
 * is off doing something two systems away. `TravelTo` is the one exception:
 * its itemID is a solar SYSTEM, not an object, so there is nothing on this
 * grid to check it against.
 *
 * ⚠ THIS RUNG NOW LOCKS **AND FIRES**, and the sentence that used to stand here
 * said the opposite: "there is no weapons rung yet and no weapon-module field
 * on `FleetCompanionRequest` -- shooting is a later phase. A lock is the real,
 * complete first half of answering a primary." That was honest when it was
 * written and it is dead now. `weaponModuleIDs` exists, and `lockThenEngage`
 * opens fire once the lock is OBSERVED. Locking alone is still what a pilot
 * with an empty weapon list does, and the readout says so in those words --
 * but it is now a SETTING, not the limit of the feature.
 *
 * ⚠ AND IT STILL PARKS THE TICK, which matters more now than it did. The
 * "already locked" branch returns a wait rather than falling through the way
 * `decideHealOrder` does, so while a target call stands, every rung BELOW this
 * one is starved. That was harmless when the branch meant "locked, nothing
 * more to do"; it is load-bearing now that the same branch means "locked and
 * shooting", because a standing primary is exactly the situation in which the
 * rungs below want a turn.
 *
 * It is left parked deliberately, for the readout: a pilot fighting the FC's
 * primary should say "Obeying fleet", not fall through to "Standing by" while
 * its guns are running. **But phase 6 must not put its flee beneath this rung**
 * -- a pilot that never stops obeying a target call would never flee -- and
 * phase 5's drone recall has the same problem. The planned ladder puts both
 * below; that ordering has to be revisited when they are built, not inherited.
 */
function decideFleetOrders(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionDecision | null {
  const snapshot = obs.snapshot ?? null;
  if (snapshot === null) {
    return null;
  }
  const entities = snapshot.entities;
  const measurement = measureSpace(snapshot);

  // a. The Heal family — see the header above for why this is checked first.
  if (request.obeys.includes("broadcast")) {
    const healDecision = decideHealOrder(request, obs, entities, memory);
    if (healDecision !== null) {
      return healDecision;
    }
  }

  // b. The fleet's target tags — a commander's call.
  if (
    request.obeys.includes("tag") &&
    obs.fleetTargetTags !== null &&
    obs.fleetTargetTags !== undefined
  ) {
    const tagged = bestTaggedEntity(obs.fleetTargetTags, entities, measurement);
    if (tagged !== null) {
      return lockThenEngage(
        tagged.itemID,
        "tag",
        "the fleet's tagged target",
        "The fleet has tagged a target on this grid.",
        request,
        obs,
        memory,
      );
    }
  }

  // c-f. ONE SET OF BRANCHES, TWO SOURCES. A named order reaches this pilot
  //       either as a fleet broadcast or as a line somebody typed in chat, and
  //       from here down it is deliberately the same order. Resolving the
  //       source ONCE, above the branches, is what stops chat being a second
  //       copy of Target/AlignTo/TravelTo/JumpTo that drifts out of step with
  //       the first -- the JumpTo branch alone is thirty lines of honest
  //       partial nobody should be maintaining twice.
  const order = resolveNamedOrder(request, obs, entities);

  // c. A `Target` order.
  if (order?.name === "Target") {
    return lockThenEngage(order.itemID, order.source, order.heard, order.why, request, obs, memory);
  }

  // d. An `AlignTo` order.
  if (order?.name === "AlignTo") {
    return {
      action: { kind: "align", targetID: order.itemID },
      phase: "Obeying fleet",
      why: order.why + " Aligning to it.",
      memory,
      followingOrderFrom: order.source,
      lastOrderHeard: order.heard,
    };
  }

  // e. A `TravelTo` order — a destination SOLAR SYSTEM
  //    (`FLEET_BROADCAST_CLASSIFICATION`'s "destination-system"), not an
  //    on-grid object, so there is no grid-presence check here. Routing
  //    restarts the shared autopilot, so it is issued once per DISTINCT
  //    destination and never re-issued merely because the tick repeats —
  //    `lastRoutedSystemID` is this ladder's memory of that, the same
  //    "compare and stamp" `closingOn`/`lastLockIssuedFor` already use.
  //
  //    ⚠ ONCE ISSUED, THIS RUNG DOES NOT SUPPRESS ITSELF FURTHER. The route
  //    runs on the SHARED autopilot controller (flow.ts's `startRoute`), a
  //    SEPARATE decide-loop from this one, and this ladder keeps ticking at
  //    its own cadence throughout. Rung 1's warp yield covers the actual
  //    transit (`inWarp` is true while the autopilot's own warp is in
  //    flight), but the moments between hops — approaching or sitting at a
  //    gate — are NOT covered, and a fleet order landing in one of those
  //    gaps could still issue a lock/align/heal call alongside the
  //    autopilot's own navigation. That is an accepted, un-solved gap, not a
  //    claim that this rung fully hands off control.
  if (order?.name === "TravelTo" && order.itemID !== memory.lastRoutedSystemID) {
    return {
      action: { kind: "travelTo", systemID: order.itemID },
      phase: "Obeying fleet",
      why: order.why + " Starting the route.",
      memory: { ...memory, lastRoutedSystemID: order.itemID },
      followingOrderFrom: order.source,
      lastOrderHeard: order.heard,
    };
  }

  // f. A `JumpTo` order — HONEST PARTIAL, not a full jump.
  //
  //    ⚠ WHAT IS MISSING, AND WHY. `itemID` here is a single stargate
  //    (`FLEET_BROADCAST_CLASSIFICATION`'s "stargate"), but `api.jump` needs
  //    the gate on the FAR SIDE too (`fromGateID`, `toGateID` —
  //    autopilotLoop.ts's own `jump` case), and the only place `toGateID`
  //    comes from is a planned hop's `RouteHop.jumpToGateID`, solved by the
  //    static route graph `loadRouteGraph()` loads ASYNCHRONOUSLY. This
  //    ladder is pure and synchronous and carries no route graph — giving a
  //    fleet-order rung its own copy of the autopilot's route solver just to
  //    answer one broadcast is a bigger change than this rung earns, and
  //    inventing a second gate id could fling an unattended ship into the
  //    wrong system. So this rung gets the ship TO the named gate and stops
  //    there: warp, then close in, then hold at jump range — it never fires
  //    the jump itself. A later phase that threads the route graph in can
  //    finish this.
  if (order?.name === "JumpTo") {
    const gateID = order.itemID;
    const step = decideCloseIn(gateID, MAX_STARGATE_JUMPING_DISTANCE_M, measurement, memory.closingOn);
    if (step === null) {
      return {
        action: WAIT,
        phase: "Obeying fleet",
        why: order.why + " It is not measurable this tick.",
        memory,
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    if (step.kind === "arrive") {
      return {
        action: WAIT,
        phase: "Obeying fleet",
        // The explanation is the point of this sentence, not decoration: the
        // pilot is sitting still ON the thing it was told to jump through, which
        // looks exactly like a stuck bot unless it says why it stopped.
        why:
          order.why +
          " At it now, holding here. Jumping needs the gate on the far side too, and there " +
          "is no safe way to get that from the call alone.",
        memory,
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    if (step.kind === "closing") {
      return {
        action: WAIT,
        phase: "Obeying fleet",
        why: order.why + " Closing on it.",
        memory,
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    if (step.kind === "approach") {
      return {
        action: { kind: "approach", targetID: gateID },
        phase: "Obeying fleet",
        why: order.why + " Starting to close on it.",
        memory: { ...memory, closingOn: gateID },
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
      };
    }
    return {
      action: { kind: "warp", targetID: gateID },
      phase: "Obeying fleet",
      why: order.why + " Warping to it.",
      memory,
      followingOrderFrom: order.source,
      lastOrderHeard: order.heard,
    };
  }

  return null;
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
    // ⚠ "own-ladder" IS THE DEFAULT, NOT `null`. Every rung except rung 4
    // (obeying the fleet) leaves these two fields unset on its decision, and
    // that omission means "this pilot is not obeying an external order" —
    // the warp yield, the supervision gate, the abandonment protocol and
    // "Standing by" are all the companion's own ladder, not a fleet order.
    mem.followingOrderFrom = decision.followingOrderFrom ?? "own-ladder";
    mem.lastOrderHeard = decision.lastOrderHeard ?? null;
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
          // A resumed run has tanked up, locked, healed and routed nothing yet
          // either — same reasoning as the get-safe flags just above: this run
          // has not issued any of those calls, so it must not assume one
          // already landed. A restart mid-fight simply re-lights whatever is
          // still off on its first live tick.
          lastTankUpModuleIDs: [],
          lastLockIssuedFor: null,
          lastFireTargetID: null,
          lastFireModuleIDs: [],
          lastHealTargetID: null,
          lastHealModuleIDs: [],
          lastRoutedSystemID: null,
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
