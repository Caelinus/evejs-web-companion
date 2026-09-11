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
// The kill-order authority (rung 7, "obeying the fleet"). Imported rather than
// re-derived for the same reason the get-safe helpers above are: one answer to
// "where does this tag rank", shared with the combat priority list.
import { fleetTagRank, pickPrimary } from "./targetPriority.ts";
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
 * Which authority a decision actually came from, for the readout.
 *
 * ⚠ THIS IS AN OBSERVATION, NOT A SETTING, AND IT NEVER WAS ONE AGAIN.
 * It used to be defined as `FleetCompanionOrderSource | "own-ladder"`, where
 * that first half was the set of channels an operator could switch on and off.
 * There are no such switches any more (docs/fleet-companion-simplification.md,
 * "What it listens to"): a companion listens to every channel there is and acts
 * on whatever it can. So the union is written out here in full, and the only
 * question it answers is the one it always really answered -- who did this
 * pilot just obey.
 *
 * `own-ladder` is the member that proves it was never a settings type: "nobody
 * told it, it decided for itself" is a real answer to that question and is not
 * a channel anybody could have ticked.
 *
 * ⚠ `squad-board` IS GONE, AND IT WAS NEVER REAL. It sat in this union and in
 * the settings screen, and nothing in this file ever produced it -- the BFF's
 * squad board (`src/squadBoard.js`) is read by the SCRIPTED bots and has never
 * been read by the companion. A readout member no decision can emit is a
 * promise the readout cannot keep. The board itself is untouched.
 *
 * Named here because it had been written out inline in four places -- this
 * file, the store's types, the store's feed, and the readout words -- and phase
 * 9's wire shape would have been a fifth. Four copies of a union with nothing
 * to fail if one drifted is the same shape of bug as two copies of a bare 1;
 * see COMPANION_GRANT_SCRIPT_REV.
 */
export type CompanionOrderAuthority = "broadcast" | "tag" | "chat" | "own-ladder";

/**
 * What one companion run actually FLIES WITH: the operator's few settings, plus
 * the eight module lists read off the hull it is sitting in.
 *
 * ⚠ THE EIGHT LISTS ARE DERIVED, NEVER CONFIGURED, AND THAT IS THE WHOLE OF THE
 * 2026-09-11 SIMPLIFICATION. They used to be eight checkbox columns in the
 * settings panel, each one defended by a comment saying the player must pick
 * because "a wrong guess cycles the wrong module". There was never a guess to
 * make. What a module is FOR comes from the game's own SDE group name, which is
 * the only thing `resolveDefenseModuleIDs` has ever looked at; whether it can be
 * CYCLED comes from dogma attribute 73, the duration the server sends per fitted
 * module (`itemHasActivationCycle`). Group plus duration answers both questions
 * exactly, so the player was being asked to disambiguate something that was
 * never ambiguous. See docs/fleet-companion-simplification.md.
 *
 * ⚠ THEY SURVIVE AS HANDLES, WHICH IS WHY THEY ARE STILL ITEM IDS. You activate
 * one particular fitted module, not a group, so the ladder still needs the id of
 * the thing to cycle. That is all these are now: the answer to "which item", not
 * the answer to "which of these did you want".
 *
 * ⚠ FLATNESS IS LOAD-BEARING. `CompanionSetup` below -- the stored half of this
 * -- is kept as the VALUE against a pilot in a Pilot Hangar squad, and squads
 * routinely span accounts. A setup that were a REFERENCE into an account-scoped
 * library could not be shared by a mixed squad; a value can.
 */
export interface FleetCompanionRequest {
  /**
   * Fitted modules that DEFEND this ship -- hardeners and the like -- by item
   * id, classified off the hull's own group names at start.
   *
   * ⚠ ONLY THE ONES THAT ACTUALLY CYCLE. A passive module in a defensive group
   * is filtered out by the duration check, because activating it means nothing
   * and the call would be wasted every tick. Group 60 "Damage Control" is the
   * case that proves the rule: it holds both the passive Damage Control II and
   * the cycling Assault Damage Control II, so no test on the group NAME could
   * ever have separated them.
   */
  readonly defenseModuleIDs: readonly number[];
  /**
   * Fitted SELF-repair modules by item id, one list per tank layer. Shield
   * boosters here, armour repairers below, hull repairers under that.
   *
   * ⚠ ONE LIST PER LAYER BECAUSE A SHIELD BOOSTER CANNOT REPAIR ARMOUR. The
   * hurt layer chooses the list, exactly as the DSL's `repairersFor` chooses
   * between `shieldRepairerIDs` / `armorRepairerIDs` / `hullRepairerIDs`, and
   * reaching across families would cycle a module that does nothing for the
   * layer actually taking damage.
   *
   * ⚠ THE TWO CLASSIFIER BUGS THIS COMMENT USED TO CITE ARE BOTH FIXED, which
   * is what made deriving these safe. It argued for asking the operator because
   * the classifier "cannot tell a free Damage Control from a cap-hungry active
   * hardener" and, until 2026-09-11, "read every REMOTE repairer as a self
   * repairer". The second was fixed by excluding `/remote/i` ahead of the self
   * tests; the first by the dogma duration check, which answers the question the
   * group name genuinely could not. Neither is an argument for a checkbox any
   * more.
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
   * Fitted REMOTE shield-repair modules by item id — the ones that repair
   * SOMEBODY ELSE. Answers a `HealShield` broadcast (and, alongside the other
   * two lists below, a `HealTarget` one — see `healModuleCandidates`'s own
   * comment for why that call draws on all three). Empty means this pilot has
   * no shield remote-rep fitted, and a `HealShield` call simply falls through
   * unanswered.
   *
   * ⚠ THE `/remote/i` TEST RUNS BEFORE THE SELF TESTS, and that ordering is what
   * keeps these three lists and the three above apart. Every remote-rep group
   * name also contains "shield booster" / "armor repair" / "hull repair", so an
   * unordered classifier files a Remote Shield Booster as a SELF repairer -- and
   * the repair rung then activates it self-targeted, which repairs nothing and
   * burns capacitor on the one hull whose job is repairing someone else.
   */
  readonly remoteShieldModuleIDs: readonly number[];
  /** As `remoteShieldModuleIDs`, for armour — a shield booster cannot repair
   *  armour, so `HealArmor` draws on this list and never the shield one. */
  readonly remoteArmorModuleIDs: readonly number[];
  /** As `remoteShieldModuleIDs`, for capacitor transfers — `HealCapacitor`
   *  draws on this list alone, for the same reason. */
  readonly remoteCapacitorModuleIDs: readonly number[];
  /**
   * Fitted WEAPONS (turrets, launchers) by item id, high slots only.
   *
   * ⚠ A COMPANION IS NOW ARMED BY DEFAULT, AND THAT IS A DELIBERATE LOSS OF A
   * SAFETY DEFAULT. This list used to be empty unless an operator ticked a gun,
   * and empty meant "lock whatever the fleet calls, never fire it" -- so no
   * companion could shoot without somebody explicitly arming it. Deriving the
   * list from the hull ends that: a pilot with guns fitted will fire them at
   * what it is told to fire at. The operator was told this consequence and chose
   * it (docs/fleet-companion-simplification.md, "The request, after").
   *
   * ⚠ IT IS ALSO WHY `combat` IS NOW AN UNCONDITIONAL RISK CLASS. A grant is
   * built before the fit has been read, and a hull nobody has looked at may hold
   * anything, so a run that claimed no combat and then bolted on whatever the
   * ship turned out to carry would be a falsehood the BFF validates as truth.
   * See `analyzeCompanionRunPolicy`.
   *
   * Empty still happens and is still a real answer -- a hull with no guns -- it
   * is simply no longer something an operator can choose.
   */
  readonly weaponModuleIDs: readonly number[];
  /**
   * Fitted SALVAGERS by item id, high slots only, classified off the game's own
   * group name ("Salvager").
   *
   * ⚠ A SALVAGE ORDER IS NOT A DRONE ORDER, AND THIS LIST IS WHY. The first cut
   * of the `salvage` chat verb acted on salvage DRONES alone, because that is
   * how the request was first phrased. It was wrong for the same reason every
   * module picker was wrong: what a pilot can do is a property of its FIT, and a
   * hull with a salvager bolted on can salvage whether or not it carries drones.
   * Found in live testing, 2026-09-11.
   *
   * ⚠ THE TWO ARE NOT EXCLUSIVE. A ship carrying both runs both: the drones
   * sweep on the server's own auto-pick while the salvager works the nearest
   * wreck through approach -> lock -> activate. They are separate rungs because
   * one costs a drone command and the other moves the ship.
   */
  readonly salvagerModuleIDs: readonly number[];
  // ─── From here down: the stored setup. See `COMPANION_SETUP_KEYS`. ─────────
  //
  // ⚠ THE FIELDS BELOW ARE THE ONLY ONES AN OPERATOR EVER SETS, and the only
  // ones that are persisted against a pilot in a squad. Everything above is read
  // off the hull at start. The dividing line is exactly "can this be read off
  // the ship" -- these six cannot: three of them are thresholds nobody could
  // derive, one is a budget, one is a wait, and one spends money.
  //
  // ⚠ `deriveModulesFromFit` USED TO LIVE HERE AND IS GONE. It was the flag that
  // said "read the lists off the hull instead of using the picked ones", because
  // the squad path had no operator to ask. There is no longer any other path: a
  // companion ALWAYS reads its own fit, so a flag selecting between two
  // mechanisms has only one mechanism left to select.

  /** Remaining fraction (0-1) of any health layer that starts a flee. */
  readonly fleeHealthFloor: number;
  /**
   * Bring a drone home when its worst layer drops below this, 0..1.
   *
   * ⚠ A RECALL IS A FREE SHIELD REPAIR ON THIS SERVER, and that - not breaking
   * anything's lock - is why this is worth doing. `buildDroneRecoveryItemPatch`
   * (`droneRuntime.js:4060`) stamps `charge: 1, shieldCharge: 1` onto the item
   * as it enters the bay, with the server's own comment saying that shields and
   * capacitor recharge on their own and ONLY armour and hull damage survives
   * being stowed. So a drone pulled while it is still losing shields comes back
   * whole, and one chewed into armour comes back with full shields and the same
   * armour hole.
   *
   * ⚠ IT IS NOT A LOCK-BREAK, WHATEVER THE ORIGINAL ASK SAID. This server has no
   * target-loss memory and no drone cooldown: a recalled drone leaves the scene
   * and the NPC simply re-scores every candidate by distance on its next think
   * tick, 100-500 ms later. Do not describe this to a player as shaking
   * anything off.
   *
   * The floor is on the WORST of the three layers, which in a fight is nearly
   * always the shield - so a middling floor pulls a drone while the recall can
   * still give everything back, and a very low one waits until the damage is
   * the kind that does not.
   */
  readonly droneHealthFloor: number;
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
  /**
   * Whether a pilot that flees hurt pays the station to fix it.
   *
   * ⚠ THIS EXISTS BECAUSE DOCKING DOES NOT REPAIR ARMOUR, which is a fact
   * about the server and not a balance choice:
   * `topOffShipShieldAndCapacitorForDockingTransition`
   * (`space/transitions.js:242`) writes `charge: 1.0` and `shieldCharge: 1.0`
   * and leaves `damage` and `armorDamage` exactly as they were. So a shield
   * flee heals itself by arriving, and an ARMOUR flee does not: without a
   * repair the recheck can never pass, and the pilot that fled would sit in
   * the station for the rest of the run.
   *
   * ⚠ AND IT SPENDS THE OPERATOR'S ISK, which is the whole reason it is a
   * setting rather than something the flee rung just does. `repairRuntime.js`
   * debits the wallet. Off by default: a pilot that stays docked is a pilot
   * that cost nothing, and an operator who wants the round trip can say so.
   * It earns `financial` and `inventory` in the risk derivation, matching
   * what the DSL's own `repair-ship` and `dock-and-repair` already claim.
   */
  readonly repairsAtStation: boolean;
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
}

/**
 * The stored half of a request: exactly what an operator configures, and exactly
 * what is persisted against a pilot in a Pilot Hangar squad.
 *
 * ⚠ THIS LIST IS A FENCE, NOT A CONVENIENCE, in the same sense the old
 * `COMPANION_PRESET_KEYS` was. The codec (`bots/companionRunPolicy.ts`) decodes
 * these keys and refuses anything else, so widening the stored surface means
 * widening this constant -- a deliberate act, with the whole of
 * docs/fleet-companion-simplification.md arguing against it.
 *
 * ⚠ THE TEST FOR MEMBERSHIP IS "CAN THIS BE READ OFF THE SHIP". If it can, it is
 * derived and does not belong here. Everything that survived the 2026-09-11
 * simplification failed that test: three thresholds nobody could derive, a
 * budget, a wait, and one setting that spends money.
 */
export const COMPANION_SETUP_KEYS = [
  "fleeHealthFloor",
  "capacitorFloor",
  "maxFleeAttempts",
  "repairsAtStation",
  "droneHealthFloor",
  "droneRedeployHoldOffSeconds",
] as const;

export type CompanionSetupKey = (typeof COMPANION_SETUP_KEYS)[number];

/**
 * What an operator saves. A `FleetCompanionRequest` is this plus the eight
 * module lists, filled in from the hull at start by `requestForFit`.
 *
 * ⚠ DERIVED FROM THE FLOWN SHAPE RATHER THAN DECLARED BESIDE IT, so the two can
 * never disagree about a field's type or drift apart when one is edited.
 */
export type CompanionSetup = Pick<FleetCompanionRequest, CompanionSetupKey>;

/** Bounds. Stated together rather than scattered, so they can be read at once. */
export const MIN_FLEE_HEALTH_FLOOR = 0.05;
export const MAX_FLEE_HEALTH_FLOOR = 0.95;
export const MIN_DRONE_HEALTH_FLOOR = 0.05;
export const MAX_DRONE_HEALTH_FLOOR = 0.95;
export const MIN_CAPACITOR_FLOOR = 0.05;
export const MAX_CAPACITOR_FLOOR = 0.95;
export const MIN_FLEE_ATTEMPTS = 1;
/**
 * The widest an operator may set the budget, NOT the budget itself.
 *
 * ⚠ THIS COMMENT USED TO READ "Three, matching MAX_RECOVER_TRIPS and
 * MAX_ESCAPE_ATTEMPTS", sitting above the value 10. Both halves were true of
 * different things and the pairing was not: those two constants are 3
 * (`scriptDecide.ts:744`, `scriptMacros.ts:4793`) and so is this request's
 * DEFAULT, while this is the ceiling on what the panel will accept. The
 * reasoning moved to the default, where it applies. Same shape as the drone
 * hold-off below: a wide range, a sensible default inside it.
 */
export const MAX_FLEE_ATTEMPTS = 10;
export const MIN_DRONE_HOLD_OFF_SECONDS = 1;
export const MAX_DRONE_HOLD_OFF_SECONDS = 300;

/**
 * The default request. Every field is a placeholder a UI overrides EXCEPT the
 * two marked unverified, which are honest guesses awaiting a live measurement
 * (docs/fleet-companion-plan.md, "Unknowns").
 */
export const DEFAULT_COMPANION_SETUP: CompanionSetup = Object.freeze({
  fleeHealthFloor: 0.3,
  // Half of the worst layer. In a fight that layer is the shield, and a recall
  // gives a shield back whole - so pulling at a half shield costs one round
  // trip and returns a fresh drone, while waiting for armour damage returns a
  // drone that is still hurt.
  droneHealthFloor: 0.5,
  // Not a guess and not a placeholder: the constant the script runner already
  // uses to switch a repairer off, with the same reasoning ("an empty capacitor
  // repairs nothing"). Reusing it means one answer to this question, not two.
  capacitorFloor: REPAIR_CAP_FLOOR,
  // Three, matching MAX_RECOVER_TRIPS and MAX_ESCAPE_ATTEMPTS, which is where
  // this number comes from rather than being picked for this file. A fourth
  // trip into the same camp is a bot commuting, not a bot recovering.
  maxFleeAttempts: 3,
  // Off: nothing this loop does spends money unless an operator asks it to.
  repairsAtStation: false,
  // A floor on the wait, not a safety guarantee — see the field's own comment.
  droneRedeployHoldOffSeconds: 10,
} satisfies CompanionSetup);

/**
 * A whole request with nothing fitted — the shipped setup plus eight empty
 * lists.
 *
 * ⚠ THIS IS NOT WHAT ANY PILOT FLIES, and it is not a default an operator ever
 * sees. `startFleetCompanion` reads the hull and replaces all eight lists before
 * the first tick, so a real run's lists are whatever that ship is carrying. This
 * constant exists for two callers: tests that want a valid request to vary one
 * field of, and the fallback for a fit that could not be read at all -- where
 * eight empty lists is the honest answer, because nothing can be cycled if
 * nothing could be classified.
 */
export const DEFAULT_FLEET_COMPANION_REQUEST: FleetCompanionRequest = Object.freeze({
  ...DEFAULT_COMPANION_SETUP,
  defenseModuleIDs: Object.freeze([]),
  shieldBoosterModuleIDs: Object.freeze([]),
  armorRepairerModuleIDs: Object.freeze([]),
  hullRepairerModuleIDs: Object.freeze([]),
  remoteShieldModuleIDs: Object.freeze([]),
  remoteArmorModuleIDs: Object.freeze([]),
  remoteCapacitorModuleIDs: Object.freeze([]),
  weaponModuleIDs: Object.freeze([]),
  salvagerModuleIDs: Object.freeze([]),
} satisfies FleetCompanionRequest);

/**
 * A flee in progress — rung 5's latch, null whenever the pilot is not running
 * from anything.
 *
 * ⚠ IT SATISFIES `SafetyRun` STRUCTURALLY, and that is what lets rung 5 fly
 * the very same ladder rung 2 does instead of growing a second copy of it. The
 * three flags under the divider ARE that contract — read `SafetyLeg` before
 * renaming any of them.
 *
 * ⚠ RUN-LOCAL, NOT PERSISTED, unlike `CompanionAbandonment`. That one keeps a
 * thirty-minute clock which only means something if it outlives a BFF restart.
 * This one keeps no clock anybody waits on: a companion that comes back up
 * reads its own health on the first tick and flees again within one tick if it
 * still needs to, so persisting it would buy nothing and would have to answer
 * what a half-finished flee means to a process that has forgotten where it was.
 */
export interface CompanionFlee {
  /** When the floor was breached. For the readout, and for phase 6's budget. */
  readonly triggeredAtMs: number;
  /**
   * The health reading that started it.
   *
   * Kept because the readout is the only place an operator ever sees WHY a
   * pilot left, and "it was at 12%" is the thing that happened while "below
   * 30%" is merely the setting they can already look up.
   */
  readonly triggeredAtHealth: number;
  /**
   * The system the pilot fled FROM, so a return has somewhere to go.
   *
   * ⚠ A SYSTEM, NOT A SPOT — option A, "remember the grid", chosen on
   * simplicity grounds. And the return it feeds is BLIND by construction:
   * there is no read anywhere that says whether a grid is clear. That was
   * checked rather than assumed, and it is absent from the server, from the
   * BFF and from this repo; the nearest thing, `hostileOnGrid`, counts NPCs
   * only and is scoped to the grid the ship is already on. The attempt budget
   * is the only thing that bounds a return, which is exactly why it exists.
   *
   * Null when the flight status could not say. A return this rung cannot name
   * a destination for is one it does not attempt, never one it guesses at.
   */
  readonly fromSolarSystemID: number | null;
  /**
   * How many times the repair shop has been asked on this trip.
   *
   * Bounded for the reason the DSL's own `repair-ship` block is bounded: a shop
   * that keeps answering without fixing anything is most likely a wallet that
   * cannot pay, and asking it for ever is not a plan.
   */
  readonly repairAttempts: number;

  // ── the `SafetyRun` contract ────────────────────────────────────────
  readonly safeSpotWarpIssued: boolean;
  readonly safeSpotWarpSeen: boolean;
  readonly droneRecallWaited: number | null;
}

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
   * Character IDs the fleet roster names as COMMANDERS — fleet boss, wing
   * commander, squad commander, or the fleet's creator. The chat-order rung
   * takes orders from these and from nobody else.
   *
   * ⚠ THE SAME TEST THE SERVER USES FOR TAGGING, POINTED AT A SECOND QUESTION.
   * `canTag` above is this test applied to THIS pilot's own row; this is the
   * same test applied to every row. One definition of "commander", used twice,
   * rather than a second idea of authority invented for chat.
   *
   * ⚠ NULL IS "COULD NOT READ THE ROSTER", AND IT MEANS NO CHAT ORDERS. It must
   * never collapse to "anybody", because the roster is the entire gate: a pilot
   * that cannot tell who is in charge must not act on somebody claiming to be.
   * Local chat is readable by everyone in the system, so this list is the only
   * thing standing between a companion and a stranger typing "target".
   */
  readonly fleetCommanderCharacterIDs?: readonly number[] | null;
  /**
   * Cans and wrecks the `loot` order is finished with -- emptied, or tried
   * enough times without emptying.
   *
   * ⚠ THE LADDER CANNOT LEARN THIS FOR ITSELF. It issues one atomic call per
   * tick and never sees what came back, so "did that can actually empty?" is a
   * fact only the layer that made the call has. Without it the rung marked a can
   * done the moment it ASKED, and a can that gave up one stack of three was
   * never opened again.
   */
  readonly lootFinishedItemIDs?: readonly number[];
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
  /**
   * The entity ids currently TACKLING this ship — scrambled or disrupted, so
   * this ship cannot warp out. Deduplicated, and ranked no further: which one
   * to letter first is the rung's own decision.
   *
   * Absent or empty means nothing is holding this pilot, which is what a pilot
   * with no jam pushes on its wire always sees, and what a host that has not
   * wired this read up sees too.
   *
   * ⚠ ALREADY NARROWED AND ALREADY FRESHNESS-FILTERED BY THE BUILDER, the same
   * way `fleetBroadcast` and `chatMessages` are. The store keeps every jam type
   * the wire carried — webs, paints, damps, neuts — and keeps them until an
   * `OnJamEnd` arrives; deciding which of them are TACKLE and which are still
   * believed happens once, where the clock is, so the whole tick reasons off
   * one answer.
   *
   * ⚠ AN EMPTY LIST IS NOT PROOF THIS SHIP IS FREE. It is the fold of pushes
   * that were received; a dropped SSE frame reads as "nothing is holding us".
   * Nothing downstream may invert this into a positive claim — it gates a tag
   * write and nothing else, so the failure is a tag not written, never a ship
   * that wrongly believes it can warp.
   */
  readonly tackledBy?: readonly number[];
  /**
   * This ship's own drones out in space, by entity id — the ones this hull can
   * actually ORDER, which is a narrower set than the ones it owns.
   *
   * ⚠ ORDERABLE, NOT MERELY OWNED, AND THE DIFFERENCE IS A REAL BUG. An
   * ABANDONED drone still belongs to this character and still shows on grid, but
   * no hull controls it: a recall aimed at one answers 200 and the drone does
   * not move (observed live — see `canMyShipOrderDrone`). Counting it would make
   * the drone rung wait for a recall that can never land, for ever.
   *
   * Absent or empty means nothing of this ship's is out. Free — folded from the
   * space snapshot the tick already read, never a call of its own.
   */
  readonly myDroneIDs?: readonly number[];
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
 *     leaveFleet / acceptFleetInvite — the one thing a
 *     companion left without a human may do unsupervised.
 *   • obeying the fleet (rung 7) — lock / align / activate / travelTo —
 *     answering a fleet tag or broadcast while a human IS supervising. See
 *     `decideFleetOrders`.
 */
export type FleetCompanionAction =
  | { readonly kind: "wait" }
  /**
   * The get-safe ladder: warp in, close the last few km, dock.
   *
   * ⚠ `warp` ALSO CARRIES THE SAFE-SPOT FALLBACK NOW. When no station is on
   * grid the pilot warps to the system's STAR, which is an ordinary scene entity
   * (`kind: "sun"`) reached by the ordinary warp call — so there is no separate
   * action for it, and the `warpToBookmark` kind that used to serve that case is
   * gone. See `sunOnGrid`.
   */
  | { readonly kind: "warp"; readonly targetID: number }
  /**
   * Close on something. `range` is where to STOP, in metres -- null hugs it.
   *
   * ⚠ HUGGING IS WRONG FOR A JOB WITH A REACH. A salvager works to about 5 km
   * and a loot transfer to 2.5 km, so flying all the way to the object wastes
   * the whole approach and leaves the ship sitting on top of a wreck for no
   * reason. The get-safe ladder still hugs deliberately: it is closing on a
   * station to dock, where there is no working distance to stop at.
   */
  | { readonly kind: "approach"; readonly targetID: number; readonly range?: number }
  | { readonly kind: "dock"; readonly stationID: number }
  | { readonly kind: "leaveFleet" }
  | { readonly kind: "acceptFleetInvite"; readonly fleetID: number }
  /**
   * Obeying the fleet (rung 7): a tag or a `Target` broadcast, locked. Locking
   * is the whole of what this rung does with a target — there is no weapons
   * rung yet, so this is never a stand-in for shooting.
   */
  | { readonly kind: "lock"; readonly targetID: number }
  /** Obeying the fleet (rung 7): an `AlignTo` broadcast. */
  | { readonly kind: "align"; readonly targetID: number }
  /**
   * Obeying the fleet (rung 7): a Heal broadcast, answered with a fitted
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
   * Obeying the fleet (rung 7): a `TravelTo` broadcast — a solar system, not
   * an on-grid object, so this hands off to the SHARED autopilot
   * (flow.ts's `startRoute`) rather than warping or approaching itself.
   */
  | { readonly kind: "travelTo"; readonly systemID: number }
  /**
   * Obeying the fleet: jump through the gate this ship is sitting on.
   *
   * ⚠ ONLY THE GATE WE ARE AT, AND NO FAR SIDE. The rung used to stop at the
   * gate because `api.jump` wanted a `toGateID` it had no way to solve without
   * the autopilot's route graph. That was OUR constraint, not the game's:
   * `jumpSessionViaStargate` (transitions.js) resolves the destination itself
   * from `sourceGate.destinationID` whenever the far id is absent, and the only
   * thing insisting on one was the BFF's own INVALID_GATE check. A stargate
   * knows where it goes; we do not have to tell it.
   */
  | { readonly kind: "jumpGate"; readonly gateID: number }
  /**
   * Rung 4, "tackle → tag": letter a ship that is holding this one down, so the
   * whole fleet can call it.
   *
   * ⚠ THE ONLY WRITE THIS LOOP MAKES THAT NOBODY CAN SEE FAIL. The server
   * refuses a non-commander SILENTLY (`fleetRuntime.js:1317` returns a bare
   * `false`, and `beyonceService.js:3320` throws it away and returns null), so
   * the ack is byte-identical either way. `bridge/fleetCommand.ts` is the gate
   * that has to answer before the call, and the confirmation is seeing the
   * letter arrive in a later `fleetTargetTags` — never the write's own 200.
   */
  | { readonly kind: "setFleetTargetTag"; readonly targetID: number; readonly tag: string }
  /**
   * Rung 6: put drones out. `droneItemIDs` are BAY STACK ids, not drone entity
   * ids - a stack and a drone in space live in different id spaces, and the
   * launch route takes the former.
   */
  | { readonly kind: "launchDrones"; readonly droneItemIDs: readonly number[] }
  /**
   * Rung 6: bring drones home. `droneIDs` are the ENTITY ids of drones in
   * space, the other half of the pair above.
   *
   * ⚠ THIS IS THE WHOLE MOVE, NOT HALF OF IT. There is no scoop to follow: the
   * server flies them back at full speed and scoops them itself once they are
   * inside 2500 m. They stay visibly on grid for the whole trip home, so a
   * caller must not read "still on grid" as "the recall was refused".
   */
  | { readonly kind: "recallDrones"; readonly droneIDs: readonly number[] }
  /**
   * Rung 6: point drones at a ship. ENTITY ids, like `recallDrones`.
   *
   * ⚠ ONE CALL, TWO MEANINGS, AND THE SERVER DECIDES WHICH. `CmdEngage` against
   * a HOSTILE is an attack; against a FRIENDLY ship it is a repair, dispatched
   * to `assignDroneRepairTask` instead. There is no separate "repair" command to
   * make, which is why the companion's repair-drone rung issues this one.
   *
   * ⚠ AND THE FRIENDLY TEST IS NOT FLEET MEMBERSHIP. `isFriendlyRepairTarget`
   * checks character, owner, corporation and alliance ONLY, so repair drones
   * cannot rep an out-of-corp fleet-mate: the call is accepted and nothing
   * happens. That is a server fact, recorded rather than worked around.
   */
  | { readonly kind: "engageDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  /**
   * Rung 6: set salvage drones sweeping. ENTITY ids.
   *
   * ⚠ `targetID: 0` MEANS "THE SERVER PICKS THE WRECK" and is the normal case,
   * not a missing value -- `resolveAutomaticSalvageTarget` chooses one. It is
   * why a standing salvage order does not have to be re-aimed as each wreck is
   * consumed.
   */
  | { readonly kind: "salvageDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  /**
   * The `loot` chat order: empty a wreck, or a container, this ship is already
   * within range of.
   *
   * ⚠ WRECKS ARE OWNERSHIP-GATED AND CONTAINERS ARE NOT, which is why they are
   * two actions and not one. A wreck is opened only when it belongs to this
   * pilot or its corporation, and one whose owner cannot be read is never opened
   * at all -- the no-can-flipping rule, structural rather than polite. Salvaging
   * has no such gate, because salvaging anything is legal.
   */
  | { readonly kind: "lootWreck"; readonly wreckID: number }
  | { readonly kind: "lootContainer"; readonly containerID: number }
  /**
   * Rung 5: pay the station to put the armour back.
   *
   * ⚠ `itemIDs` COMES FROM THE SHOP'S OWN QUOTE, never from a guess at what is
   * damaged -- the same authority the DSL's `repair-ship` block uses. The
   * route behind it carries `confirm: true` in the body, which is how this
   * server makes a caller state intent; it is not a dialog and there is no UI
   * to raise.
   */
  | { readonly kind: "repairItems"; readonly itemIDs: readonly number[] }
  /**
   * Rung 5: leave the station a flee ended at.
   *
   * The companion's first undock, and the only call it makes that puts the
   * ship deliberately back into danger -- which is why everything above it in
   * `recoverAndReturn` is about being sure first.
   */
  | { readonly kind: "undock" };

export interface FleetCompanionProgress {
  readonly status: FleetCompanionRunState;
  readonly phase: string | null;
  readonly action: string | null;
  readonly why: string | null;
  /** Whether this pilot is in a fleet at all. Null while the roster is unread. */
  readonly inFleet: boolean | null;
  /** Which authority the last decision came from, for the readout. */
  readonly followingOrderFrom: CompanionOrderAuthority | null;
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
  /**
   * How many ticks the get-safe step has spent waiting on a drone recall, or
   * null if it has not issued one.
   *
   * ⚠ THE SERVER ABANDONS EVERY CONTROLLED DRONE ON ANY WARP, JUMP OR DOCK, and
   * an abandoned drone can be scooped by ANYBODY on grid. `handleControllerLost`
   * (`droneRuntime.js:5735`) only attempts a bay recovery when the lifecycle
   * reason is a disconnect or a logoff; a normal departure passes neither, so
   * the recovery branch is skipped outright however close the drones are. So
   * leaving without recalling does not merely cost this pilot its drones -- it
   * hands them to whoever is still there.
   *
   * ⚠ AND IT MUST NEVER BLOCK THE ESCAPE. This is a bound, not a promise: a
   * recall that cannot complete -- a full bay, which the server refuses in
   * silence -- must not strand an unsupervised pilot in space for the whole
   * thirty-minute wait. Drones are worth a few seconds of delay and are not
   * worth the ship.
   */
  readonly droneRecallWaited: number | null;
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
   * The target rung 7 last issued a `lock` call for — the fallback for
   * `isAlreadyLocked` when `obs.lockedTargetIDs` itself is unreadable. See
   * that function's own comment for why the authoritative read still wins
   * whenever it is available.
   */
  readonly lastLockIssuedFor: number | null;
  /**
   * The ship rung 7 last aimed a Heal-family `activate` at, and which fitted
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
   * The solar system rung 7 last issued a `travelTo` route to, so a standing
   * `TravelTo` broadcast does not restart the shared autopilot every tick.
   */
  /**
   * The target rung 7 last aimed a WEAPON at, and which fitted weapons it has
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
  /**
   * The ship rung 4 (tackle → tag) last issued a `setFleetTargetTag` for, and
   * how many writes it has spent on it. The pair exists because the write's own
   * ack is worthless — see the action kind's comment — so the only confirmation
   * is the letter appearing in a later `fleetTargetTags`, which takes at least
   * one more tick to arrive.
   */
  readonly lastTagIssuedFor: number | null;
  readonly lastTagAttempts: number;
  /**
   * Ships whose tag budget ran out without the letter ever showing up.
   *
   * ⚠ WITHOUT THIS THE RUNG DEADLOCKS ON ITS OWN FIRST CANDIDATE. Give-up has
   * to be remembered per SHIP, not as a single "stop tagging" flag: the ranking
   * would hand back the same unconfirmable ship every tick, and a second
   * tackler that could have been lettered would never be reached. Capped, so a
   * long fight cannot grow it without bound.
   */
  readonly taggingGaveUpOn: readonly number[];
  /**
   * Rung 6's recall-and-relaunch cycle, or null when none is running.
   *
   * ⚠ A RECORD, BECAUSE THE TRIGGER EXTINGUISHES ITSELF. The instant the recall
   * lands the drones are not in space, so `lowestDroneHealth` reads null and the
   * condition that started the cycle is no longer true. A rung that re-derived
   * its state from the observation each tick would fire once and forget it was
   * ever in a cycle, orphaning the hold-off and the relaunch. This is the shape
   * `standDownAfterFight` uses, for exactly that reason.
   */
  readonly droneCycle: DroneCycle | null;
  /**
   * How many cycles this run has spent. Never reset, deliberately - see
   * `MAX_DRONE_REDEPLOY_CYCLES`: armour damage survives a recall, so the later
   * cycles buy less and less, and the budget is a property of the RUN rather
   * than of any one drone.
   */
  readonly droneCyclesSpent: number;
  /**
   * The ship this pilot's repair drones were last sent to.
   *
   * ⚠ WITHOUT THIS THE RUNG RE-ISSUES ITS ORDER EVERY TICK. Drones already
   * repairing the right ship need telling nothing, and re-sending the same
   * engage twice a second would spend this loop's one atomic call per tick on
   * an order the server has already obeyed -- starving every rung beneath it.
   * Same shape, and the same reason, as `lastHealModuleIDs` above.
   */
  readonly lastDroneRepairTargetID: number | null;
  /**
   * How many salvage drones the standing salvage order was last issued for.
   *
   * ⚠ A COUNT AND NOT A FLAG, because the set of drones out can CHANGE while
   * the order stands: one more launched, or one lost, is a different set, and
   * the new ones have been told nothing. A bare "already ordered" flag would
   * leave them drifting. The server auto-picks the wreck, so the order never
   * needs re-aiming -- only re-issuing to drones that missed it.
   */
  readonly lastSalvageOrderedFor: number | null;
  /**
   * Wrecks and containers the `loot` order has already emptied this run, and
   * the one currently being closed on.
   *
   * ⚠ A WRECK STAYS ON GRID AFTER IT IS EMPTIED, so "still there" cannot mean
   * "still has something in it" and this record is the only way the rung knows
   * to move on. A container is the opposite -- the server despawns an empty
   * jetcan -- but one list for both is simpler than two rules, and marking a
   * can that has already vanished costs nothing.
   */
  readonly lootedItemIDs: readonly number[];
  readonly lootApproaching: number | null;
  /**
   * The can or wreck this pilot has committed to opening.
   *
   * ⚠ WITHOUT THIS THE RUNG WANDERS, and it did (observed live, 2026-09-11: a
   * pilot flew to a container, did not loot it, and set off for a different
   * one). The target was re-picked from scratch on EVERY tick, and the inputs
   * move underneath it: this ship's own distances change as it closes, and the
   * fleet-mate claim flips as another pilot moves. So the nearest-unclaimed can
   * stopped being the same can halfway there, and it turned for the new one --
   * for ever, arriving at none of them.
   *
   * The salvage rung latched its wreck from the start (`salvageWreckID`) for
   * exactly this reason; looting was written without it and should not have
   * been. Choosing is a decision; a decision that is remade every two seconds is
   * not a decision.
   */
  readonly lootTargetID: number | null;
  /**
   * The wreck a fitted SALVAGER is working, and how long its lock has been
   * waited on. Null when no salvager ladder is under way.
   *
   * ⚠ A RECORD, NOT A RE-DERIVATION, for the reason the drone cycle carries one:
   * the ladder spans several ticks (approach, lock, activate) and the condition
   * that started it -- a wreck being the nearest -- can change underneath it. A
   * rung that re-picked the nearest wreck every tick would approach one, lock
   * another, and salvage neither.
   */
  readonly salvageWreckID: number | null;
  readonly salvageLockIssued: boolean;
  readonly salvageLockWaited: number;
  /**
   * Whether an approach has already been sent for `salvageWreckID`.
   *
   * ⚠ NOT DERIVABLE FROM DISTANCE. A ship that is closing is still out of
   * range, so "too far" cannot tell an approach that has not been issued from
   * one that is under way -- and re-sending it every tick would spend the
   * run's one call on a move the server is already making.
   */
  readonly salvageApproachIssued: boolean;
  /**
   * The standing area job -- `salvage`, `loot`, or none.
   *
   * ⚠ A LATCH, AND IT HAS TO BE. These verbs name a JOB ("salvage the wrecks in
   * vicinity"), not an instant. The first cut read them straight off the chat
   * backlog, which meant they inherited the BROADCAST freshness window -- right
   * for a target call, where a primary stops being one in seconds, and wrong
   * here. Observed live on 2026-09-11: a pilot salvaged exactly ONE wreck and
   * went back to standing by with two still on grid, because the order aged out
   * of its thirty-second window mid-job. An operator would have had to re-type
   * the word every half minute.
   *
   * ⚠ IT CLEARS ITSELF WHEN THE JOB IS DONE, which is what keeps a latch from
   * being a trap: no wrecks left to salvage, or nothing left to loot, and the
   * pilot goes back to its own ladder without anybody saying so. `stop` cancels
   * it early, and every rung ABOVE it still preempts it -- a flee, a fleet warp
   * or a target call interrupts a salvage job exactly as before.
   */
  readonly areaJob: "salvage" | "loot" | null;
  /**
   * The object a `WarpTo` order has already been answered for.
   *
   * ⚠ A WARP IS NOT IDEMPOTENT THE WAY A LOCK IS. Re-sending it while the ship
   * is already on its way is at best a wasted call and at worst a second warp
   * the moment the first lands, so the order is answered ONCE per destination
   * and a repeat of the same call is heard without being obeyed again.
   */
  readonly lastWarpedToID: number | null;
  /** Rung 5's flee, or null when the pilot is not running from anything. */
  readonly flee: CompanionFlee | null;
  /**
   * Round trips this run has spent, against `request.maxFleeAttempts`.
   *
   * Counted UP rather than down so the readout can say "2 of 3" without
   * needing the request to hand, and never reset by anything in this commit —
   * the return leg that earns a reset does not exist yet.
   */
  readonly fleeTripsSpent: number;
  /**
   * Consecutive ticks since a flee ended with nothing wrong, against
   * `FLEE_RECOVERY_HOLD_TICKS`. Reaching it puts the budget back to full.
   *
   * ⚠ THIS IS WHAT MAKES "A RETURN THAT HOLDS" CHECKABLE. A pilot that comes
   * back and drops through its floor again before the count runs out never
   * reaches the reset, so its trips keep accumulating and it eventually stays
   * home -- which is the entire purpose of bounding them.
   */
  readonly fleeRecoveryTicks: number;
}

/** One recall-and-relaunch cycle in flight. */
export interface DroneCycle {
  /**
   * `recalling` until every drone that was out has left the grid, then
   * `holding-off` until the operator's floor has passed.
   */
  readonly stage: "recalling" | "holding-off";
  /**
   * The drones that were out when the recall was issued, watched individually.
   * ⚠ NOT a count, and not the coarse `dronesOut` flag: this ship may launch
   * others mid-cycle, and a flag would call the recall finished the moment one
   * unrelated drone came home.
   */
  readonly recalledIDs: readonly number[];
  /** Ticks spent in the current stage. Bounded in both of them. */
  readonly waited: number;
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
    lastTagIssuedFor: null,
    lastTagAttempts: 0,
    taggingGaveUpOn: [],
    droneCycle: null,
    droneCyclesSpent: 0,
    lastDroneRepairTargetID: null,
    lastSalvageOrderedFor: null,
    lootedItemIDs: [],
    lootApproaching: null,
    lootTargetID: null,
    salvageWreckID: null,
    salvageLockIssued: false,
    salvageLockWaited: 0,
    salvageApproachIssued: false,
    areaJob: null,
    lastWarpedToID: null,
    flee: null,
    fleeTripsSpent: 0,
    fleeRecoveryTicks: 0,
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
   * `null` here — `tick()` supplies the default) by every rung except rung 7;
   * the controller reads that omission as `"own-ladder"`, which is the honest
   * answer for the warp yield, the supervision gate, the abandonment protocol
   * and "Standing by" alike — none of them are obeying an external order.
   */
  readonly followingOrderFrom?: "tag" | "broadcast" | "chat";
  /** Short plain words for the panel — never the broadcast's wire name. */
  readonly lastOrderHeard?: string;
  /**
   * True when this decision is a STANDING one: the pilot is already obeying
   * this order and has nothing new to issue for it this tick.
   *
   * ⚠ THIS EXISTS TO STOP A RUNG PARKING THE TICK, and it replaces the one
   * place that did. `lockThenEngage`'s last branch used to return an ordinary
   * `wait` once the called target was locked and the guns were running, which
   * ended the ladder — so while a target call stood, every rung BELOW the
   * fleet-order rung was starved, which is exactly when they most want a turn.
   * A pilot obeying a target call would never have fled.
   *
   * The readout is why it was parked rather than dropped, and the readout is
   * kept: `decideCompanionAction` HOLDS a standing decision aside, runs every
   * rung beneath it, and falls back to it only if none of them acted. So the
   * panel still says "Obeying fleet" while the guns run, and a lower rung that
   * has real work still gets the tick.
   *
   * ⚠ A STANDING DECISION'S ACTION MUST BE `wait`. It is only ever a readout;
   * holding a real call aside and then not issuing it would silently drop it.
   */
  readonly standing?: true;
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
 * ⚠ THE LADDER AS IT STANDS, IN FULL. Every phase has extended this list and
 * several left the prose behind, so it is written out here once rather than
 * assembled from the rung comments below:
 *
 *     1  yield to warp              server fleet warp wins, unconditionally
 *     2  supervision / abandonment  decision 5; getting safe lives here
 *     3  tank up                    hardeners, then each layer's repairer
 *     4  tackle -> tag              letter what is holding this ship
 *     5  flee                       leave, get whole, come back
 *     6  drones                     launch, recall a hurt one, redeploy
 *     7  obeying the fleet          tags, broadcasts, chat commands
 *        "Standing by"
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
 * ⚠ RUNG 5 IS THE FLEE, AND IT SITS ABOVE THE FLEET RUNG BECAUSE THE OPERATOR
 * PUT IT THERE. The plan doc's decision 3 originally read
 *
 *     server fleet warp > FC broadcast > chat command > own flee rule
 *
 * which makes a target call outrank a pilot's own survival. Phase 5's parking
 * fix took the worst of that away — a STANDING call is held aside and no
 * longer ends the tick — but a call with something real still to issue wins
 * outright, and `lockThenEngage` issues one lock plus one activate per weapon
 * before it goes quiet. The operator was asked and chose the flee; decision 3
 * was amended to match rather than left contradicting this file. Rung 1 still
 * outranks it, and that half was never in dispute: a fleet already leaving
 * does not need this pilot's opinion.
 *
 * Tank up and tackle-tag stay ABOVE it deliberately, which is how a ship
 * running away keeps hardening and keeps lettering whatever holds it. The
 * phase 6 spec asked for those to be "nested inside the flee continuation";
 * sitting above it is the same result with no nesting, and it only works
 * because both fall through the moment they have nothing to issue.
 *
 * ⚠ RUNG 7 IS OBEYING THE FLEET, THE LAST RUNG BEFORE "Standing by".
 * Unlike rung 2 it IS an order source (see `decideFleetOrders`'s own header
 * for the tag-over-broadcast reasoning and why an off-grid call is not an
 * order for this pilot at all).
 *
 * ⚠ NOTHING SITS BENEATH IT, AND PROBABLY NOTHING EVER WILL. That matters
 * because `CompanionDecision.standing` exists for something that sits there:
 * phase 5's parking fix was built so phase 6's flee could live below this rung,
 * and the operator's decision put the flee above it instead.
 *
 * There is no rung left to fill the slot either. Chat commands feed THIS rung
 * rather than a rung of their own, the fleet-chat channel work is cancelled for
 * good, and phase 9 is roles and a badge. So the hold-aside half of the
 * mechanism has no consumer.
 *
 * ⚠ IT IS STILL NOT DEAD CODE. The fallback at the end of this ladder returns
 * the standing decision on every tick where a call stands and nothing else
 * acted, which is what stops a pilot whose guns are running from reporting
 * "Standing by". Do not delete it on the grounds that nothing needs it; the
 * readout does.
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
    // ⚠ BOTH LATCHES, NOT JUST THE ABANDONMENT'S. Rung 5's flee flies the same
    // safe-spot ladder and needs the same confirmation, and this is still the
    // only tick that can give it: every later tick has left warp by definition,
    // so a mid-warp tick that recorded one latch and not the other would leave
    // a fleeing pilot waiting for a warp it had already finished.
    const abandoning = memory.abandonment;
    const fleeing = memory.flee;
    const sawIt = (run: SafetyRun): boolean => run.safeSpotWarpIssued && !run.safeSpotWarpSeen;
    let next = memory;
    if (abandoning !== null && sawIt(abandoning)) {
      next = { ...next, abandonment: { ...abandoning, safeSpotWarpSeen: true } };
    }
    if (fleeing !== null && sawIt(fleeing)) {
      next = { ...next, flee: { ...fleeing, safeSpotWarpSeen: true } };
    }
    return waiting(
      "In warp",
      "The fleet is warping this ship. Nothing is decided until it lands.",
      next,
    );
  }

  // ⚠ THE AREA LATCH IS UPDATED BEFORE ANY RUNG DECIDES, and before the
  // supervision gate, so that a `stop` typed while a pilot is getting safe is
  // still heard. It issues nothing; it only records what the last order said.
  memory = withAreaJobCleared(obs, withAreaJob(obs, memory));

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
    lastTagIssuedFor: memory.lastTagIssuedFor,
    lastTagAttempts: memory.lastTagAttempts,
    taggingGaveUpOn: memory.taggingGaveUpOn,
    lastDroneRepairTargetID: memory.lastDroneRepairTargetID,
    lastSalvageOrderedFor: memory.lastSalvageOrderedFor,
    lootedItemIDs: memory.lootedItemIDs,
    lootApproaching: memory.lootApproaching,
    lootTargetID: memory.lootTargetID,
    salvageWreckID: memory.salvageWreckID,
    salvageLockIssued: memory.salvageLockIssued,
    salvageLockWaited: memory.salvageLockWaited,
    salvageApproachIssued: memory.salvageApproachIssued,
    areaJob: memory.areaJob,
    lastWarpedToID: memory.lastWarpedToID,
    droneCycle: memory.droneCycle,
    droneCyclesSpent: memory.droneCyclesSpent,
    // ⚠ CARRIED, NOT CLEARED, and the difference from `abandonment` above is
    // the whole point. That one is cleared because a human coming back is
    // exactly the thing it was waiting for. A flee is about the ship's health
    // and has nothing to do with who is in the fleet -- clearing it here would
    // mean a supervisor logging back in cancelled a flee mid-warp and left a
    // hurt pilot sitting on the grid it was leaving.
    flee: memory.flee,
    fleeTripsSpent: memory.fleeTripsSpent,
    fleeRecoveryTicks: memory.fleeRecoveryTicks,
  };

  // Rung 3: tank up. Threaded even when it has nothing to do this tick —
  // `tankedUp.memory` may have forgotten a finished stand-down record on a
  // tick that issued no action, and dropping it here would lose that the same
  // way skipping `stand.memory` would in `scriptDecide.ts`'s own equivalent.
  const tankedUp = decideTankUp(request, obs, supervised);
  if (tankedUp.decision !== null) {
    return tankedUp.decision;
  }

  // Rung 4: tackle → tag. ABOVE obeying the fleet, and that placement is the
  // whole reason this rung works — see `decideTackleTag`'s own header. Threaded
  // the way rung 3 is, and for the same reason: the tick that GIVES UP on a
  // ship issues no action, so a call site that only took the decision would
  // throw the give-up away and re-pick the same ship for ever.
  const tagging = decideTackleTag(request, obs, tankedUp.memory);
  if (tagging.decision !== null) {
    return tagging.decision;
  }

  // Rung 5: flee. Above the drone rung and BELOW tank-up and tackle-tag, so a
  // ship running away still hardens and still letters what is holding it -- see
  // this rung's own header for why that placement does the spec's "nest tank-up
  // inside the flee continuation" without any nesting, and for the operator
  // decision that put it above the fleet rung at all.
  //
  // Threaded like rung 3: the tick that UNWINDS a flee it cannot fly issues no
  // action, and a call site that took only the decision would throw that away
  // and re-latch the same doomed flee for ever.
  const fleeing = decideFlee(request, obs, tagging.memory, nowMs);
  if (fleeing.decision !== null) {
    return fleeing.decision;
  }

  // Rung 6: drones. Above the fleet rung, like tank-up and tackle-tag and for
  // the same reason: it moves nothing, costs one call, and a pilot does not
  // stop obeying its commander to keep its drones alive. Threaded like rung 3
  // because most of what it does - waiting out a recall, counting down a
  // hold-off - happens on ticks that issue NO action at all.
  const drones = decideDrones(request, obs, fleeing.memory);
  if (drones.decision !== null) {
    return drones.decision;
  }

  // Rung 7: obeying the fleet.
  //
  // ⚠ A STANDING ORDER IS HELD ASIDE, NOT RETURNED. When this rung has a real
  // call to issue it wins outright, exactly as the precedence says. But when it
  // is merely CONTINUING to obey -- target locked, guns already running, nothing
  // new this tick -- it hands back a `standing` decision, and that one is kept
  // as a READOUT while the ladder goes on. Before this, that case returned an
  // ordinary wait and ended the tick, so a standing target call starved every
  // rung beneath it for as long as it stood. See `CompanionDecision.standing`.
  const obeying = decideFleetOrders(request, obs, drones.memory);
  if (obeying !== null && obeying.standing !== true) {
    return obeying;
  }

  // Rung 8: the `loot` order.
  //
  // ⚠ IT SITS HERE, AT THE VERY BOTTOM, BECAUSE IT MOVES THE SHIP. Every other
  // thing this loop does is fired from where the pilot already is, or is a move
  // somebody else ordered; looting approaches each wreck in turn and will drift
  // a companion off formation. Beneath the fleet-order rung means a target call,
  // a rep call, an align or a fleet warp all interrupt it -- and being beneath
  // the flee and the supervision gate as well means a pilot that is dying stops
  // looting without anybody having to say so.
  //
  // ⚠ AND IT IS BENEATH THE *STANDING* ORDER CHECK BELOW ON PURPOSE. That is the
  // slot `CompanionDecision.standing` was built for in phase 5 and which has had
  // no consumer since the flee moved above the fleet rung: a pilot whose guns are
  // already running on a called target should go on looting between shots rather
  // than reporting "Standing by" and doing nothing.
  const salvaging = decideSalvaging(request, obs, drones.memory);
  if (salvaging !== null) {
    return salvaging;
  }

  const looting = decideLooting(obs, drones.memory);
  if (looting !== null) {
    return looting;
  }

  // The standing order, if there was one and nothing beneath it acted. The
  // pilot IS obeying the fleet, so it says so rather than "Standing by".
  if (obeying !== null) {
    return obeying;
  }
  return waiting(
    "Standing by",
    "No fleet order to obey right now, nothing to loot, and nothing hostile to put drones on.",
    drones.memory,
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
    droneRecallWaited: null,
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
    const safe = runToSafety(obs, mem, {
      run: running,
      phase: "Getting safe",
      because: "there is nobody left in the fleet to fly with",
      write: (m, run) => ({ ...m, abandonment: { ...running, ...run } }),
    });
    if (safe !== null) {
      return safe;
    }
    // Nowhere to go, which for THIS caller is the end of the protocol: a pilot
    // with nobody to fly with and no way off this grid has nothing further to
    // try, and decision 5 says so rather than inventing a destination.
    return {
      action: WAIT,
      phase: "Getting safe",
      why: "No station in view and no safe spot set.",
      memory: mem,
      stop: "Nobody is left in the fleet, and there is no station in view and no safe spot set for this pilot.",
    };
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
function reachedSafety(obs: FleetCompanionObservation, running: SafetyRun): boolean {
  if (obs.docked === true) {
    return true;
  }
  return running.safeSpotWarpIssued && running.safeSpotWarpSeen;
}

/**
 * The bookkeeping a run to safety needs, wherever it happens to live on the
 * ladder memory.
 *
 * TWO RUNGS RUN THIS SAME LADDER FOR DIFFERENT REASONS — rung 2 because there
 * is nobody left to fly with, rung 5 because the ship is hurt — and they want
 * identical flying and different words. This is the seam that lets them share
 * one implementation instead of keeping two copies that drift.
 *
 * `CompanionAbandonment` and `CompanionFlee` both satisfy it structurally, so
 * neither had to be reshaped to fit.
 */
interface SafetyRun {
  readonly safeSpotWarpIssued: boolean;
  readonly safeSpotWarpSeen: boolean;
  readonly droneRecallWaited: number | null;
}

/**
 * One caller's half of the arrangement: its own state, its own readout, and
 * the way back to wherever that state is kept.
 */
interface SafetyLeg {
  readonly run: SafetyRun;
  /** The phase this leg reports while it flies. */
  readonly phase: string;
  /**
   * The tail of "Docking, because ..." — the single sentence that differs
   * between the two callers, kept as a fragment so the rest of the readout can
   * be written once.
   */
  readonly because: string;
  /** Put an updated run back where this caller keeps it. */
  readonly write: (mem: CompanionLadderMemory, run: SafetyRun) => CompanionLadderMemory;
}

/**
 * How long a run to safety waits for its recall before leaving anyway.
 *
 * Shorter than rung 6's own wait on purpose. That one is a pilot choosing to
 * spend time on its drones during a fight it is still in; this one is a pilot
 * with nobody left to fly with, which is the situation the whole abandonment
 * protocol exists to end quickly. Drones are worth a few seconds and are not
 * worth the ship.
 */
const MAX_GET_SAFE_RECALL_WAIT_TICKS = 8;

/**
 * The recall the get-safe ladder makes before it warps, or null when there is
 * nothing to wait for and it may leave.
 *
 * Returns null in three different situations that must not be conflated:
 * nothing is out, the recall has finished, or the wait has been given up on.
 * All three mean the same thing to the caller -- go -- and none of them is an
 * error.
 */
function recallBeforeLeaving(
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  leg: SafetyLeg,
): CompanionDecision | null {
  const out = obs.myDroneIDs ?? [];
  if (out.length === 0) {
    // Nothing of this ship's is in space. ⚠ This is also the only honest answer
    // when the read is simply absent: a host that does not wire `myDroneIDs` up
    // gets the behaviour it had before this existed, rather than a pilot that
    // refuses to leave over drones nobody can see.
    return null;
  }
  const waited = leg.run.droneRecallWaited;
  if (waited === null) {
    return {
      action: { kind: "recallDrones", droneIDs: out },
      phase: leg.phase,
      why: "Calling the drones in before leaving, so they are not left behind.",
      memory: leg.write(mem, { ...leg.run, droneRecallWaited: 0 }),
    };
  }
  if (waited >= MAX_GET_SAFE_RECALL_WAIT_TICKS) {
    // ⚠ GIVE UP AND GO. A recall that has not completed by now is most likely
    // one the server refused in silence for a full bay, and no amount of
    // further waiting fixes that. Leaving costs the drones; staying risks the
    // ship, and the ship is what the protocol is for.
    return null;
  }
  return waiting(
    leg.phase,
    "Waiting for the drones to come home before leaving.",
    leg.write(mem, { ...leg.run, droneRecallWaited: waited + 1 }),
  );
}

/**
 * The ladder that gets a ship out of here: recall what is in space, then the
 * nearest dock on grid, then the operator's safe spot.
 *
 * ⚠ RETURNS null FOR "NOWHERE TO GO", and that is the one thing the two
 * callers must answer differently. A pilot with nobody left to fly with and no
 * station in view has nothing else to try and stops (decision 5). A pilot that
 * is merely HURT still has a fight to be in, and stopping the run over a grid
 * with no station would take a shooting ship away from a fleet that still has
 * one. So the branch is left to the caller rather than decided here.
 */
function runToSafety(
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  leg: SafetyLeg,
): CompanionDecision | null {
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return waiting(leg.phase, "Waiting for the ship to be out in space.", mem);
  }
  // ⚠ RECALL BEFORE COMMITTING TO LEAVE. Every branch below that WARPS is a
  // point of no return for anything still in space: the server abandons every
  // controlled drone on a normal departure and does not try to recover them,
  // and an abandoned drone can be scooped by anyone on grid. See
  // `droneRecallWaited`. Docking and approaching are not departures and are
  // left alone -- a dock is the destination, and the recall happens before the
  // warp that reaches it.
  const recall = recallBeforeLeaving(obs, mem, leg);
  if (recall !== null) {
    return recall;
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
        phase: leg.phase,
        why: `Docking, because ${leg.because}.`,
        memory: mem,
      };
    }
    if (step.kind === "closing") {
      return waiting(leg.phase, "Closing on the station.", mem);
    }
    if (step.kind === "approach") {
      return {
        action: { kind: "approach", targetID: target.itemID },
        phase: leg.phase,
        why: "Closing on the station.",
        memory: { ...mem, closingOn: target.itemID },
      };
    }
    return {
      action: { kind: "warp", targetID: target.itemID },
      phase: leg.phase,
      why: "Warping to the nearest station.",
      memory: mem,
    };
  }

  // ⚠ THE SUN, AND IT IS AN ORDINARY ON-GRID ENTITY LIKE THE STATION ABOVE.
  // This used to be an operator-named bookmark, because a note here and in the
  // plan doc said eve.js has no celestial to warp to. That was wrong, and it was
  // wrong in a specific way worth remembering: it enumerated the entity kinds
  // this CLIENT's own code mentions and concluded the server emits no others.
  // Re-checked against the server on 2026-09-11 --
  //
  //   * every solar system has a star row (`groupID` 6, `kind: "sun"`) in the
  //     server's own celestial table, 8,089 of them, each at the system origin;
  //   * `space/runtime.js` adds every celestial to the scene UNCONDITIONALLY --
  //     unlike stargates, which sit behind a flag;
  //   * `canSessionSeeStaticEntityForSession` rejects only bubble-, grid- and
  //     site-scoped statics, and a star carries none of those markers, so it is
  //     visible to every session in the system;
  //   * and `warpState.js` has a dedicated `case "sun":` landing distance, so
  //     warping to one is a mechanic somebody implemented on purpose.
  //
  // The client simply never recognised it: `space/tactical.ts` tests for
  // `kind === "celestial"` and a star's kind is `"sun"`, so it has been arriving
  // in every snapshot and falling through unread. An absence in the reader was
  // read as an absence in the world.
  const sun = sunOnGrid(obs);
  if (sun === null) {
    // No station and no star. This should not happen in a normal system, so it
    // is reported rather than papered over: what SAYING so means differs per
    // caller — see this function's header.
    return null;
  }
  if (!leg.run.safeSpotWarpIssued) {
    return {
      action: { kind: "warp", targetID: sun },
      phase: leg.phase,
      why: "No station in view, so this pilot is warping to the sun.",
      memory: leg.write(mem, { ...leg.run, safeSpotWarpIssued: true }),
    };
  }
  // Issued, and no warp has been seen. Do NOT re-issue every two seconds, and
  // do NOT give up: the warp may simply not have started yet, and each caller's
  // own bound is already the answer to one that never does.
  return waiting(leg.phase, "Waiting for the warp to the sun to start.", mem);
}

/**
 * The system's star, by entity id, or null if this snapshot has none.
 *
 * ⚠ `kind === "sun"` IS THE SERVER'S OWN WORD, not a guess at a naming scheme.
 * `buildStaticCelestialEntity` stamps the kind straight from the celestial row,
 * and every star row carries `kind: "sun"`. Planets and moons arrive the same
 * way under their own kinds; this deliberately matches only the star, because
 * "the sun" is what a safe spot means and a planet is somewhere else entirely.
 *
 * ⚠ NOT FILTERED ON DISTANCE OR LOCK RANGE. A star is millions of kilometres
 * away and is warped to, never approached — the whole point of it is that it is
 * off this grid.
 */
function sunOnGrid(obs: FleetCompanionObservation): number | null {
  const entities = obs.snapshot?.entities ?? [];
  for (const entity of entities) {
    if (entity.kind === "sun") {
      return entity.itemID;
    }
  }
  return null;
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
 * sits above obeying the fleet (rung 7) and below the supervision gate.
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
  // ⚠ THREE STATES, NOT TWO, AND COLLAPSING THEM SPUN THIS RUNG FOREVER.
  // `activeModuleIDs` is `[]` when nothing is running and `null` when the read
  // COULD NOT ANSWER -- `store/types.ts` states that contract and the BFF
  // preserves it deliberately (`server.js`'s `readActiveModuleIDs`: "null (not
  // []) when the snapshot could not answer at all"). This read used to be
  // `?? []`, which threw the distinction away.
  //
  // What that cost: on a tick where the module map was unreadable, every
  // fitted module looked idle. Step 1's `find` tests only this set, never the
  // record of what it has already lit, so it re-picked THE SAME hardener every
  // tick -- issuing an action every tick, growing `lastTankUpModuleIDs`
  // without bound, and starving every rung below this one for as long as the
  // read stayed broken. The flee rung is one of those, and a fight is exactly
  // when both the read is most likely to be partial and the flee matters most.
  //
  // Unknown now falls back to what this rung KNOWS it lit. That is the only
  // honest answer available when nothing can say, and it CONVERGES: each tick
  // lights one module it has no record of, records it, and the rung falls
  // through once the operator's lists are accounted for. Crucially it still
  // never withholds a hardener from a module it has not lit -- lighting
  // something already lit is a wasted call, leaving something dark in a fight
  // is a lost ship, and only the second is worth avoiding at the cost of the
  // first.
  const readModules = obs.snapshot?.ship?.activeModuleIDs ?? null;
  const active = new Set(readModules ?? memory.lastTankUpModuleIDs);

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
  // ⚠ STANDING, NOT PARKED -- see `CompanionDecision.standing`. Everything
  // above issues a real call; this branch has nothing left to issue, so it
  // hands back a readout the ladder uses only if no rung beneath it acts.
  return {
    action: WAIT,
    standing: true,
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
 * Whether `moduleID` is already cycling on `targetID`, so rung 7 does not
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
type NamedOrderName = "Target" | "AlignTo" | "TravelTo" | "JumpTo" | "WarpTo";

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

/**
 * The chat verbs that name an OBJECT, and so have a broadcast to map onto.
 *
 * ⚠ WRITTEN AS AN EXCLUSION SO A NEW VERB BREAKS THE BUILD RATHER THAN THE RUN.
 * `CHAT_ORDER_NAMES` below is a total `Record` over this union, so the moment
 * `chatCommands.ts` learns a verb that IS a named order, this file stops
 * compiling until somebody says which broadcast it answers. Excluding the two
 * area verbs by name keeps that tripwire armed; typing the record over
 * `ChatCommand["kind"]` and adding `salvage`/`loot` entries pointing at some
 * arbitrary broadcast would have disarmed it AND been a lie about what they do.
 */
type NamedChatCommandKind = Exclude<ChatCommand["kind"], "salvage" | "loot" | "stop">;

const CHAT_ORDER_NAMES: Readonly<Record<NamedChatCommandKind, NamedOrderName>> = Object.freeze({
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
    WarpTo: { broadcast: "the fleet's warp call", chat: "a chat order to warp" },
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
    WarpTo: {
      broadcast: "The fleet broadcast something to warp to.",
      chat: "An allowed pilot called a warp destination in chat.",
    },
  });

function asNamedOrderName(name: string | undefined): NamedOrderName | null {
  return name === "Target" ||
    name === "AlignTo" ||
    name === "TravelTo" ||
    name === "JumpTo" ||
    name === "WarpTo"
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
function newestChatCommand(
  messages: readonly ChatMessage[],
  allowedSenders: readonly number[],
  wanted: (command: ChatCommand) => boolean,
): { readonly command: ChatCommand; readonly at: number } | null {
  let best: { readonly command: ChatCommand; readonly at: number } | null = null;
  for (const message of messages) {
    if (!isChatCommandSenderAllowed(message, allowedSenders)) {
      continue;
    }
    const command = parseChatCommand(message);
    if (command === null || !wanted(command)) {
      continue;
    }
    if (best === null || message.createdAtMs >= best.at) {
      best = { command, at: message.createdAtMs };
    }
  }
  return best;
}

/**
 * The newest chat order that names an OBJECT — `target`, `align`, `travel`,
 * `jump`.
 *
 * ⚠ SPLIT FROM THE AREA COMMANDS ON PURPOSE, AND NOT MERELY FOR TIDINESS. Every
 * command this function returns carries an `itemID` and is answered by
 * `resolveNamedOrder` mapping it onto the matching BROADCAST name. `salvage` and
 * `loot` carry no itemID and have no broadcast to map onto -- there is no
 * salvage call in the fleet vocabulary at all -- so feeding one into that path
 * would index `CHAT_ORDER_NAMES` with a kind it does not hold and hand
 * `isOrderActionable` an itemID that does not exist. They are read by their own
 * rung instead; see `newestAreaCommand`.
 */
/**
 * The newest AREA order standing in chat: `salvage` or `loot`, or null.
 *
 * ⚠ A STANDING ORDER, NOT AN EVENT, AND IT LAPSES BY ITSELF. Nothing here
 * remembers that a salvage order was ever given: the order is "live" exactly as
 * long as the message that carried it is still inside the freshness window the
 * observation builder applies to `chatMessages`. That is the same one staleness
 * policy a broadcast gets, and it is what makes "stop salvaging" require no verb
 * -- a commander simply stops saying it, and within the window the pilot goes
 * back to its own ladder.
 *
 * ⚠ WHICH ALSO MEANS A SALVAGE ORDER IS NOT A LOCK ON THE SHIP. The rungs above
 * this one -- the supervision gate, the flee, a fleet warp -- all still win. A
 * pilot told to salvage still runs when it is dying.
 */
function newestAreaCommand(
  obs: FleetCompanionObservation,
): "salvage" | "loot" | "stop" | null {
  const found = newestChatCommand(
    obs.chatMessages ?? [],
    commandersFor(obs),
    (command) =>
      command.kind === "salvage" || command.kind === "loot" || command.kind === "stop",
  );
  if (found === null) {
    return null;
  }
  return found.command.kind as "salvage" | "loot" | "stop";
}

/**
 * The area job after this tick's chat, given the one standing before it.
 *
 * ⚠ A HEARD ORDER LATCHES; SILENCE CHANGES NOTHING. That is the whole point of
 * this function and the reason these verbs are not read straight off the
 * backlog like a target call is: `salvage` names a job that takes minutes, so a
 * pilot must go on salvaging while nobody is saying anything. The chat window
 * only has to carry the order ONCE.
 *
 * ⚠ `stop` IS THE ONLY WAY TO CANCEL ONE EARLY, and it cancels nothing else. It
 * does not stop the bot and does not touch a broadcast or a target call -- those
 * have their own authority and their own freshness.
 */
function withAreaJob(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionLadderMemory {
  const heard = newestAreaCommand(obs);
  if (heard === null) {
    return memory;
  }
  const next = heard === "stop" ? null : heard;
  return next === memory.areaJob ? memory : { ...memory, areaJob: next };
}

/**
 * A standing area job, cleared if there is nothing left on this grid for it.
 *
 * ⚠ THIS IS WHAT KEEPS THE LATCH FROM BEING A TRAP. Without it a pilot told to
 * salvage stays "salvaging" for the rest of the run, reporting a job it
 * finished minutes ago and never falling back to its own ladder.
 *
 * ⚠ ONLY WHEN THE GRID CAN ACTUALLY BE SEEN. Docked, in warp, or with no
 * snapshot, "no wrecks" means "could not look" and must NOT cancel the job --
 * a pilot fleet-warped away mid-salvage would otherwise arrive with its order
 * silently forgotten.
 */
function withAreaJobCleared(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionLadderMemory {
  const job = memory.areaJob;
  if (job === null) {
    return memory;
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null || obs.inWarp === true) {
    return memory;
  }
  const left =
    job === "salvage"
      ? snapshot.entities.some((entity) => entity.kind === "wreck")
      : lootablesOnGrid(obs, memory).length > 0;
  return left ? memory : { ...memory, areaJob: null, salvageWreckID: null };
}

/**
 * What the `loot` job still has to open here: containers, and wrecks that are
 * legally ours, minus whatever this run has already emptied.
 */
function lootablesOnGrid(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): readonly SpaceEntity[] {
  const finished = obs.lootFinishedItemIDs ?? [];
  return (obs.snapshot?.entities ?? []).filter((entity) => {
    // ⚠ TWO SOURCES, AND BOTH ARE NEEDED. `lootedItemIDs` is this ladder's own
    // record and survives nothing; `lootFinishedItemIDs` is the OUTCOME of the
    // calls actually made. A can only leaves the list when it is genuinely
    // done with, not when it was merely reached for.
    if (memory.lootedItemIDs.includes(entity.itemID) || finished.includes(entity.itemID)) {
      return false;
    }
    return companionMayOpen(entity);
  });
}

/** Whether a `salvage` job is standing right now. */
function salvageWasOrdered(memory: CompanionLadderMemory): boolean {
  return memory.areaJob === "salvage";
}

type NamedChatCommand = Extract<ChatCommand, { readonly kind: NamedChatCommandKind }>;

function isNamedChatCommand(command: ChatCommand): command is NamedChatCommand {
  return command.kind !== "salvage" && command.kind !== "loot" && command.kind !== "stop";
}

function newestNamedChatOrder(
  messages: readonly ChatMessage[],
  allowedSenders: readonly number[],
): { readonly command: NamedChatCommand; readonly at: number } | null {
  const found = newestChatCommand(messages, allowedSenders, isNamedChatCommand);
  return found === null || !isNamedChatCommand(found.command)
    ? null
    : { command: found.command, at: found.at };
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
  // ⚠ NO CHANNEL GATE. Every source this pilot can hear, it acts on. The
  // `obeys` list that used to wrap each of these branches is gone -- see
  // docs/fleet-companion-simplification.md, "What it listens to". Precedence is
  // unchanged and is still expressed by the ORDER of these branches, which is
  // the only thing that ever decided it.
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
  const chat = newestNamedChatOrder(obs.chatMessages ?? [], commandersFor(obs));
  if (chat !== null) {
    const chatName = CHAT_ORDER_NAMES[chat.command.kind];
    if (!isOrderActionable(chatName, chat.command.itemID, entities)) {
      return null;
    }
    return {
      name: chatName,
      itemID: chat.command.itemID,
      source: "chat",
      heard: ORDER_HEARD[chatName].chat,
      why: ORDER_WHY[chatName].chat,
    };
  }
  return null;
}

/**
 * Who this pilot will take a chat order from: the fleet's own commanders.
 *
 * ⚠ THIS REPLACES A HAND-TYPED LIST OF CHARACTER IDS, AND IT FIXES A BUG RATHER
 * THAN RELAXING A GATE. The settings screen told operators that "whoever the
 * fleet roster already names a commander is obeyed regardless", and that was
 * simply false: the only gate that ever existed was
 * `chatCommandSenders.includes(sender)`, and `flow.ts` did not even FETCH chat
 * unless that list was non-empty. So an FC's chat orders were silently ignored
 * by every companion nobody had typed ids into. This is the screen's own
 * promise, finally implemented.
 *
 * ⚠ AND IT IS NARROWER THAN WHAT IT REPLACED, not wider. A hand-typed list could
 * name anybody, including somebody who is not in the fleet at all. This cannot:
 * the roster is the source, so a commander who leaves stops being obeyed on the
 * next tick without anyone editing anything.
 *
 * ⚠ NULL IS NOT EMPTY. A roster that could not be read yields no commanders and
 * therefore no chat orders, which is the safe answer -- never "anyone will do".
 *
 * The sender id itself is derived server-side from the authenticated session
 * (`chatRuntime.js`) and never from message text, which is what keeps this
 * unspoofable.
 */
function commandersFor(obs: FleetCompanionObservation): readonly number[] {
  return obs.fleetCommanderCharacterIDs ?? [];
}

// ─── Rung 4: tackle → tag ────────────────────────────────────────────────────

/**
 * The letters the retail client's own tag menu offers, in its own order
 * (decompiled `menusvc.py:1946` — `for i in 'ABCDEFGHIJXYZ'`). Not the whole
 * alphabet: K through W are simply not on the menu, and inventing them would
 * hand the fleet letters no player can type back.
 *
 * ⚠ THE NUMBERS ARE DELIBERATELY LEFT ALONE. The same menu also offers 0-9
 * (`menusvc.py:1945`), and the DSL's own `fleet-tag-target` block writes "1" as
 * its "shoot this now" primary. Keeping this rung on letters means a squad
 * running both never fights over the same tag — which matters, because a tag is
 * unique FLEET-WIDE: `setFleetTargetTag` deletes any other item holding the
 * same letter before it sets one (`fleetRuntime.js:1343`).
 */
const FLEET_TACKLE_TAG_LETTERS = "ABCDEFGHIJXYZ";

/**
 * Bound on writes for ONE ship, mirroring the DSL block's own
 * `MAX_FLEET_TAG_ATTEMPTS` and its reasoning: a write whose refusal is
 * invisible must not be resent for ever.
 */
const MAX_COMPANION_TAG_ATTEMPTS = 3;

/** How many given-up ships are remembered. See `taggingGaveUpOn`. */
const MAX_TAGGING_GIVE_UPS = 32;

/**
 * The first menu letter no item currently holds, or null when every one is
 * taken.
 *
 * Compared case-insensitively because the server normalizes a tag only by
 * TRIMMING it (`normalizeFleetTag`, `fleetRuntime.js:267`). A hand-typed "a"
 * and this rung's "A" are two different keys to the server's own uniqueness
 * sweep but the same letter to every human reading the overview, so writing the
 * second one would steal the first one's ship.
 */
function firstFreeTagLetter(tags: ReadonlyMap<number, string>): string | null {
  const taken = new Set<string>();
  for (const tag of tags.values()) {
    taken.add(tag.trim().toUpperCase());
  }
  for (const letter of FLEET_TACKLE_TAG_LETTERS) {
    if (!taken.has(letter)) {
      return letter;
    }
  }
  return null;
}

/** Remember one more give-up, oldest dropped once the cap is reached. */
function rememberGiveUp(gaveUpOn: readonly number[], itemID: number): readonly number[] {
  if (gaveUpOn.includes(itemID)) {
    return gaveUpOn;
  }
  const next = [...gaveUpOn, itemID];
  return next.length <= MAX_TAGGING_GIVE_UPS
    ? next
    : next.slice(next.length - MAX_TAGGING_GIVE_UPS);
}

/**
 * Rung 4: letter the ship that is holding this one down, so the whole fleet can
 * call it. Hands back a decision only on a tick it actually writes — which is
 * few of them — so everything below it keeps its turn.
 *
 * ⚠ IT SITS **ABOVE** OBEYING THE FLEET, AND THAT IS THE WHOLE REASON IT WORKS.
 * `decideFleetOrders` PARKS THE TICK once a target call stands and is locked
 * (see its own header). A standing FC primary is precisely the situation a
 * fleet fight is in while this pilot is being scrambled, so a tag rung placed
 * beneath it would be starved exactly when it has something to say. Above it,
 * the cost is bounded and small: at most `MAX_COMPANION_TAG_ATTEMPTS` writes
 * per tackler and then it falls through for good, so it can delay engaging a
 * called primary by a few ticks and never by more.
 *
 * ⚠ AND IT NEVER RETURNS A `wait`. Other rungs park to keep the readout honest;
 * this one has no branch that does, because a rung that parks starves the
 * ladder beneath it and this one has nothing worth starving anything for.
 * "Nothing to tag" and "cannot tag" both read as falling through.
 *
 * ⚠ IT RETURNS ITS MEMORY EVEN WHEN IT DECIDES NOTHING — the same shape
 * `decideTankUp` has, for the same reason. Giving up on a ship happens on a
 * tick that issues NO action, so a signature that dropped the memory on `null`
 * could never record the give-up, and the rung would hand back the same
 * unconfirmable ship for ever.
 *
 * The candidates are the ships the JAM PUSHES NAMED (`obs.tackledBy`), not a
 * ranking of the grid.
 *
 * ⚠ AND THEY ARE RESOLVED AGAINST `snapshot.entities`, NOT AGAINST
 * `hostileRows`. The phase spec said to rank with `hostileRows` + `pickPrimary`,
 * its point being that this pilot's own LOCK RANGE must not suppress a tag a
 * ship further out could use — which stands, and is honoured. But `hostileRows`
 * filters on `isHostile`, and `isHostile` is `entity.isNpc &&
 * npcEntityType !== "concord"`: it answers NPC-or-not, so every PLAYER tackler
 * fails it. Filtering through it would have silently dropped exactly the case
 * this feature exists for — a fleet fight against players — and would have done
 * so with no error anywhere. A ship running a scrambler on you has classified
 * itself; nothing else needs to agree.
 *
 * Ranking is `pickPrimary`'s, so a host that populates `targetGroupNames` gets
 * class priority and one that does not collapses to nearest-first — the same
 * ordering the rest of this client's combat code uses, never a second one.
 */
function decideTackleTag(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory } {
  const nothing = { decision: null, memory } as const;
  // ⚠ NO OPERATOR GATE. Every companion tags, and the three things below
  // are what make that safe rather than a letter-fight:
  //
  //   1. THE SERVER IS THE REAL GATE. Only a fleet creator, leader, wing
  //      commander or squad commander may tag at all, and `obs.canTag` mirrors
  //      that test off the roster. In an ordinary fleet the companions are
  //      plain members and this rung writes nothing, whatever anybody ticked.
  //   2. A LETTERED SHIP IS SKIPPED, below, so a second tagger seeing the same
  //      tackler leaves the letter it already has alone.
  //   3. THE TRIGGER IS NARROW: only ships tackling THIS pilot are candidates.
  //      Two companions collide only if one ship has tackled both of them in
  //      the same tick, before either letter is visible.
  //
  // The `attemptsTagging` checkbox that used to stand here gated behaviour that
  // was already exactly what was asked for -- tag what is holding you down, and
  // only that. See docs/fleet-companion-simplification.md, "Tagging".
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return nothing;
  }
  // ⚠ THREE STATES, AND ONLY ONE OF THEM WRITES. `null` is "could not read the
  // roster" and `false` is "read it, and this pilot is not a commander". Both
  // forbid the write; neither is remembered here, because a `null` cached as
  // "no" would freeze a transient roster outage into a pilot that never tags
  // again for the rest of the run.
  if (obs.canTag !== true) {
    return nothing;
  }
  const tacklers = obs.tackledBy ?? [];
  if (tacklers.length === 0) {
    return nothing;
  }
  // ⚠ NO TAG DICT, NO WRITE. `null` means this client has never received an
  // `OnFleetStateChange` (or could not parse one), so it cannot tell which
  // letters are free — and a tag is unique fleet-wide, so guessing "A" would
  // silently steal the letter off whatever the FC had already marked. This is
  // the caller `fleetBroadcasts.ts`'s null-versus-empty contract was written
  // for: an EMPTY map is a real answer, and it does write.
  const tags = obs.fleetTargetTags ?? null;
  if (tags === null) {
    return nothing;
  }

  const candidates = tacklers
    .map((itemID) => entityOnGrid(itemID, snapshot.entities))
    .filter((entity): entity is SpaceEntity => entity !== null)
    // Already lettered? Leave it alone. This is the rule that keeps the fleet's
    // letters STABLE — a ship that is B stays B for as long as it lives — and it
    // is also what makes the server's uniqueness sweep harmless in practice,
    // because this rung then only ever assigns letters nothing holds.
    .filter((entity) => !tags.has(entity.itemID))
    .filter((entity) => !memory.taggingGaveUpOn.includes(entity.itemID));
  if (candidates.length === 0) {
    return nothing;
  }

  const measurement = measureSpace(snapshot);
  const groups = obs.targetGroupNames ?? null;
  const target =
    pickPrimary(
      candidates,
      (entity) => entity.typeID,
      (entity) => measurement?.distances.get(entity.itemID) ?? null,
      (typeID) => (groups === null ? null : (groups[typeID] ?? null)),
    ) ?? candidates[0]!;

  // The budget, spent per SHIP. A fresh candidate re-stamps it; the same one
  // coming back means the previous write has not shown up in `fleetTargetTags`
  // yet, which is ordinary for a tick or two and hopeless after three.
  const attempts = memory.lastTagIssuedFor === target.itemID ? memory.lastTagAttempts : 0;
  if (attempts >= MAX_COMPANION_TAG_ATTEMPTS) {
    return {
      decision: null,
      memory: {
        ...memory,
        lastTagIssuedFor: null,
        lastTagAttempts: 0,
        taggingGaveUpOn: rememberGiveUp(memory.taggingGaveUpOn, target.itemID),
      },
    };
  }

  const letter = firstFreeTagLetter(tags);
  if (letter === null) {
    // Every menu letter is in use. Writing anyway would delete somebody else's
    // tag to make room, which is the one thing this rung must never do.
    return nothing;
  }

  return {
    decision: {
      action: { kind: "setFleetTargetTag", targetID: target.itemID, tag: letter },
      phase: "Tagging",
      why:
        attempts === 0
          ? `Something has this ship scrambled. Marking it ${letter} for the fleet.`
          : `Still waiting for the ${letter} tag to show up, and marking it again.`,
      memory: {
        ...memory,
        lastTagIssuedFor: target.itemID,
        lastTagAttempts: attempts + 1,
      },
    },
    memory,
  };
}

// ─── Rung 5: flee ────────────────────────────────────────────────────────────
//
// ⚠ ABOVE THE FLEET RUNG, AND THAT IS A DECISION THE OPERATOR MADE RATHER THAN
// A DEFAULT ANYBODY INHERITED. The plan doc's decision 3 used to read
//
//     server fleet warp > FC broadcast > chat command > own flee rule
//
// which put a standing target call above a pilot's own survival. Phase 5's
// parking fix had already removed the worst of that -- a STANDING call is held
// aside and no longer ends the tick -- but a call with something real left to
// issue still wins outright, and `lockThenEngage` issues one lock plus one
// activate per weapon before it goes quiet. On a fresh primary with six guns
// that is seven ticks, about fourteen seconds at this loop's cadence, and an FC
// that keeps re-calling extends it without limit.
//
// The operator was asked and chose the flee. Decision 3 in the plan doc was
// amended to match rather than left contradicting the code.
//
// ⚠ WHAT STAYS ABOVE IT: rung 1's warp yield (a fleet already leaving does not
// need this pilot's opinion, and that half was never in dispute), rung 2's
// supervision gate, rung 3's tank up and rung 4's tackle-tag. The last two
// matter for a reason the phase 6 spec called out: a ship running away must
// keep hardening and must keep lettering whatever is holding it, and rungs that
// sit ABOVE the flee get that for free with no nesting. Both fall through the
// moment they have nothing to issue -- which rung 3 only started reliably doing
// once its unreadable-module-map spin was fixed, in the commit before this one.

/**
 * Count a quiet tick towards putting the flee budget back.
 *
 * Runs only on ticks where the pilot is NOT fleeing and NOT below its floor,
 * which is what "a return that holds" means in practice. A pilot that never
 * fled counts too and nothing happens, because resetting a budget of zero is
 * the same as leaving it alone.
 */
function countTowardsRecovery(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionLadderMemory {
  if (memory.fleeTripsSpent === 0) {
    return memory;
  }
  // ⚠ THE HARDER THRESHOLD, not the floor. A pilot limping along just above the
  // number that would send it running has not recovered from anything, and
  // letting that count would hand the budget back to the pilot least able to
  // spend it well.
  if (!wellEnoughToReturn(request, obs)) {
    return memory.fleeRecoveryTicks === 0 ? memory : { ...memory, fleeRecoveryTicks: 0 };
  }
  const held = memory.fleeRecoveryTicks + 1;
  if (held < FLEE_RECOVERY_HOLD_TICKS) {
    return { ...memory, fleeRecoveryTicks: held };
  }
  return { ...memory, fleeRecoveryTicks: 0, fleeTripsSpent: 0 };
}

/** What rung 5 hands back: a decision when it has one, and always its memory. */
interface FleeStep {
  readonly decision: CompanionDecision | null;
  readonly memory: CompanionLadderMemory;
}

/**
 * Rung 5: leave while there is still a ship to leave in.
 *
 * ⚠ THE TRIGGER IS `obs.health`, WHICH IS ALREADY THE WORST LAYER. `lowestHealth`
 * folds shield, armour and hull to their minimum and skips any layer that could
 * not be read, and `observe()` runs it every tick. That matches what the field
 * has always promised -- `fleeHealthFloor` is documented as "remaining fraction
 * of ANY health layer that starts a flee" -- so no new read and no new fold.
 */
function decideFlee(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
  nowMs: number,
): FleeStep {
  const running = memory.flee;
  if (running !== null) {
    return flyTheFlee(request, obs, memory, running);
  }

  // ⚠ NULL IS NOT "HEALTHY", and this is the same three-state discipline the
  // tank-up rung keeps about a layer ratio and the stand-down keeps about
  // `hostileOnGrid`. A health read that could not answer is not evidence the
  // ship is whole, and it is not evidence the ship is dying either. Fleeing
  // blind would abandon a fleet on a dropped poll; the honest answer is to
  // decide nothing this tick and look again in two seconds.
  const health = obs.health ?? null;
  if (health === null || health >= request.fleeHealthFloor) {
    return { decision: null, memory: countTowardsRecovery(request, obs, memory) };
  }

  // Dropped through the floor, so whatever recovery was being counted is over.
  const hurt: CompanionLadderMemory = { ...memory, fleeRecoveryTicks: 0 };

  // ⚠ THE BUDGET IS CHECKED BEFORE THE LATCH, NOT INSIDE THE LEG. A pilot that
  // has spent its round trips is a pilot the operator told to stay home
  // ("Stay home after N flee round trips", in the panel's own words), and
  // staying home has to mean not starting a new trip rather than starting one
  // and stopping partway.
  if (memory.fleeTripsSpent >= request.maxFleeAttempts) {
    return { decision: null, memory: hurt };
  }

  const latched: CompanionFlee = {
    triggeredAtMs: nowMs,
    triggeredAtHealth: health,
    fromSolarSystemID: obs.flightStatus?.solarSystemID ?? null,
    repairAttempts: 0,
    safeSpotWarpIssued: false,
    safeSpotWarpSeen: false,
    droneRecallWaited: null,
  };
  const started: CompanionLadderMemory = {
    ...hurt,
    flee: latched,
    fleeTripsSpent: memory.fleeTripsSpent + 1,
    // ⚠ THE DRONE CYCLE DIES HERE, and the phase 6 spec asked for exactly this:
    // "flee outranks drone redeploy -- enforce it at runtime, not by authoring
    // order". The rung already sits above the drone rung, so this is the belt
    // to that braces: a redeploy record left standing would have rung 6 trying
    // to put drones back out of a ship that is in the middle of leaving.
    // Nothing is lost by dropping it -- the outbound leg recalls everything
    // this ship controls before it commits to a warp, whichever rung launched
    // it.
    droneCycle: null,
  };
  return flyTheFlee(request, obs, started, latched);
}

/**
 * How far ABOVE its floor a ship has to be before it goes back.
 *
 * ⚠ WITHOUT A MARGIN A RETURN IS A COMMUTE. Coming back at exactly the floor
 * means the very next tick reads the same number and flees again, spending the
 * whole budget on one fight without ever firing a shot. The margin is capped at
 * 1 so a jumpy floor (0.8, say) asks for a whole ship rather than an impossible
 * 1.0-plus.
 *
 * It rarely binds, and that is by design rather than by luck: docking gives the
 * shield and the capacitor back in full, so a shield-triggered flee is already
 * whole on arrival, and a repaired armour flee is too. What it catches is the
 * case in between -- a pilot that cannot repair, healing slowly on its own.
 */
const FLEE_RETURN_MARGIN = 0.2;

/**
 * How many ticks back on station with nothing wrong before a round trip counts
 * as having WORKED and the budget goes back to full.
 *
 * The spec's rule, in its words: "an attempt is spent when the same condition
 * re-fires shortly after a return; a return that holds resets the budget."
 * Counting ticks is how "holds" is made checkable -- a pilot that comes back
 * and immediately drops through its floor again never reaches this, so its
 * trips keep accumulating and it eventually stays home, which is the whole
 * point of the bound.
 */
const FLEE_RECOVERY_HOLD_TICKS = 15;

/**
 * How many times the shop is asked before a hurt pilot gives up on repairing.
 *
 * The DSL's `repair-ship` block keeps the same bound for the same reason, and
 * its comment names the likeliest cause: the shop quietly not fixing things
 * because there is not enough money. A pilot that cannot pay must stop asking
 * rather than ask for ever.
 */
const MAX_FLEE_REPAIR_ATTEMPTS = 3;

/**
 * Whether a ship is well enough to go back to the fight it left.
 *
 * ⚠ A DIFFERENT QUESTION FROM THE ONE THAT STARTED THE FLEE, and deliberately a
 * harder one to answer yes to. See `FLEE_RETURN_MARGIN`.
 */
function wellEnoughToReturn(request: FleetCompanionRequest, obs: FleetCompanionObservation): boolean {
  const health = obs.health ?? null;
  if (health === null) {
    // Unreadable is not "well". A pilot that undocked on a dropped poll would
    // be flying back into a fight on no information at all.
    return false;
  }
  return health >= Math.min(1, request.fleeHealthFloor + FLEE_RETURN_MARGIN);
}

/**
 * What a pilot does once it has got clear: get whole, then go back.
 *
 * ⚠ DOCKING IS NOT A REPAIR, and that fact is what this whole branch is shaped
 * around. `topOffShipShieldAndCapacitorForDockingTransition`
 * (`space/transitions.js:242`) sets `charge` and `shieldCharge` to 1 and leaves
 * `damage` and `armorDamage` exactly as they were. So a shield flee is whole
 * the moment it arrives and an ARMOUR flee is not -- and without paying the
 * shop it never will be, which is why an operator who has not opted in gets a
 * pilot that says it is staying put rather than one that silently commutes.
 */
function recoverAndReturn(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  running: CompanionFlee,
): FleeStep {
  const hurtAt = Math.round(running.triggeredAtHealth * 100);

  if (!wellEnoughToReturn(request, obs)) {
    // Not docked: the safe-spot case. There is no shop out here, so the only
    // thing to do is hold and let the layers come back on their own.
    if (obs.docked !== true) {
      return {
        decision: waiting("Safe", `Left the fight at ${hurtAt}% and is waiting out here to recover.`, mem),
        memory: mem,
      };
    }
    if (!request.repairsAtStation) {
      return {
        decision: waiting(
          "Safe",
          `Left the fight at ${hurtAt}%. Docking gave the shield back but not the armour, and this pilot is not set to pay for repairs, so it is staying put.`,
          mem,
        ),
        memory: mem,
      };
    }
    if (running.repairAttempts >= MAX_FLEE_REPAIR_ATTEMPTS) {
      return {
        decision: waiting(
          "Safe",
          "The repair shop kept leaving damage unfixed, so this pilot stopped asking and is staying docked.",
          mem,
        ),
        memory: mem,
      };
    }
    // ⚠ THE SHOP'S OWN QUOTE DECIDES WHAT IS DAMAGED, never a guess at the ship
    // item id -- the same authority the DSL's `repair-ship` uses. Null is "we
    // could not say", which is a tick spent waiting for the quote and never a
    // conclusion that nothing is wrong.
    const damaged = obs.damagedItemIDs ?? null;
    if (damaged === null) {
      return { decision: waiting("Safe", "Asking the repair shop for a quote.", mem), memory: mem };
    }
    if (damaged.length === 0) {
      // Nothing the shop will fix, and still below the return mark. Holding is
      // the honest answer: there is damage no station can take out.
      return {
        decision: waiting("Safe", `Left the fight at ${hurtAt}% and the shop has nothing left to fix.`, mem),
        memory: mem,
      };
    }
    const asked: CompanionLadderMemory = {
      ...mem,
      flee: { ...running, repairAttempts: running.repairAttempts + 1 },
    };
    return {
      decision: {
        action: { kind: "repairItems", itemIDs: damaged },
        phase: "Repairing",
        why: "Paying the station to put the armour back, so this pilot can rejoin.",
        memory: asked,
      },
      memory: asked,
    };
  }

  // Whole enough. ⚠ THE BUDGET IS CHECKED HERE TOO, not only at the trigger: a
  // pilot whose LAST trip took it over the limit must stay docked rather than
  // undock into the fight that keeps sending it home.
  if (mem.fleeTripsSpent >= request.maxFleeAttempts) {
    return {
      decision: waiting(
        "Safe",
        `Fixed up, but this pilot has used all ${request.maxFleeAttempts} of its flee round trips, so it is staying home.`,
        mem,
      ),
      memory: mem,
    };
  }

  // ⚠ THE LATCH IS DROPPED BEFORE THE MOVE, not after it. Undocking is what
  // ends the flee; holding the latch across it would leave this rung driving a
  // pilot that is already back out, and a ship that undocks hurt would then be
  // steered by a flee that thinks it is still going the other way.
  const done: CompanionLadderMemory = { ...mem, flee: null, fleeRecoveryTicks: 0 };

  if (obs.docked === true) {
    return {
      decision: {
        action: { kind: "undock" },
        phase: "Going back",
        why: "Fixed up, so this pilot is undocking to rejoin the fleet.",
        memory: done,
      },
      memory: done,
    };
  }

  // Out at the safe spot rather than in a station, and well again. If the fleet
  // is somewhere else, route there; otherwise there is nothing to fly and the
  // rungs below take over on the next tick.
  //
  // ⚠ THIS IS AS FAR AS "REMEMBER THE GRID" GOES, AND IT IS OPTION A ON PURPOSE.
  // A solar system is not a grid: nothing here flies the pilot back to the exact
  // spot it left, because a return point would need a bookmark written at the
  // moment of leaving and that is a whole feature rather than a step. There is
  // also no read anywhere that says whether that grid is clear, so a precise
  // return would be no safer than this one -- only more code. The attempt budget
  // is what bounds the blindness, for both.
  const here = obs.flightStatus?.solarSystemID ?? null;
  const home = running.fromSolarSystemID;
  if (home !== null && here !== null && home !== here) {
    return {
      decision: {
        action: { kind: "travelTo", systemID: home },
        phase: "Going back",
        why: "Recovered, so this pilot is heading back to the system it left.",
        memory: done,
      },
      memory: done,
    };
  }
  return { decision: null, memory: done };
}

/**
 * The leg itself, once a flee is latched.
 *
 * Split out so the latching tick and every tick after it fly the same code —
 * a flee that behaved differently on its first tick than its second would be a
 * flee whose first tick is untested by every test that starts from a latch.
 */
function flyTheFlee(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  mem: CompanionLadderMemory,
  running: CompanionFlee,
): FleeStep {
  if (reachedSafety(obs, running)) {
    return recoverAndReturn(request, obs, mem, running);
  }

  const safe = runToSafety(obs, mem, {
    run: running,
    phase: "Getting clear",
    because: "this ship is hurt",
    write: (m, run) => ({ ...m, flee: { ...running, ...run } }),
  });
  if (safe !== null) {
    return { decision: safe, memory: safe.memory };
  }

  // ⚠ NOWHERE TO GO IS NOT A STOP, AND IT IS NOT A FLEE EITHER. No station on
  // this grid and no safe spot named means this pilot cannot leave. Rung 2
  // answers that by ending the run, because a pilot with nobody to fly with has
  // nothing else to try. A pilot that is merely HURT does: it still has guns
  // and a fleet that still has a use for them, so it falls through to the rungs
  // below and fights on.
  //
  // The latch is UNWOUND rather than left standing, budget included. A trip
  // spent on a flee that never moved the ship is a trip the operator paid for
  // and got nothing from, and leaving the latch would park this rung on a
  // condition that cannot change until the ship is somewhere else.
  return { decision: null, memory: { ...mem, flee: null, fleeTripsSpent: mem.fleeTripsSpent - 1 } };
}

// ─── Rung 6: drones ──────────────────────────────────────────────────────────

/**
 * How long a recall is believed to be in progress before the rung stops waiting
 * on it, in ticks. The same number, for the same reason, as the DSL's own
 * `RECALL_MAX_WAIT_TICKS` (`scriptMacros.ts:60`).
 *
 * ⚠ THE STUCK CASE IS REAL AND IT IS SILENT, so this bound is not defensive
 * padding. A drone that arrives at scoop range to find a FULL BAY is refused by
 * `recallDronesToShipBay`, and the tick-driven recall path throws that refusal
 * away (`droneRuntime.js:7570`) - nothing is sent to the client. The drone then
 * circles at 2500 m for ever, still on grid, still in `myDroneIDs`, with no
 * error anywhere. Without this bound the rung would wait on it until the run
 * ended.
 */
const MAX_DRONE_RECALL_WAIT_TICKS = 15;

/**
 * How many recall-and-relaunch cycles one run will spend.
 *
 * ⚠ THE SECOND CYCLE IS WORTH LESS THAN THE FIRST AND THE FOURTH IS WORTH
 * NOTHING. A recall refills shields and capacitor but NOT armour or hull
 * (`buildDroneRecoveryItemPatch`, `droneRuntime.js:4060`). So the first cycle on
 * a shield-damaged drone returns it whole; once the damage is in armour, every
 * later cycle returns the same hurt drone, re-trips the floor immediately, and
 * spends two calls and a hold-off achieving nothing. Bounding the count is what
 * stops that becoming a loop that eats the run.
 */
const MAX_DRONE_REDEPLOY_CYCLES = 3;

/** The hold-off, in ticks. See `droneCycleHoldTicks` for why ticks. */
function droneCycleHoldTicks(request: FleetCompanionRequest): number {
  // ⚠ TICKS, NOT A WALL CLOCK, and deliberately. The loop sleeps AT LEAST
  // `FLEET_COMPANION_CADENCE_MS` between ticks, so N ticks is always a lower
  // bound on elapsed time - and undershooting a hold-off is the only failure
  // that matters here. The ladder carries no injected clock and threading one
  // through for this would be a cross-cutting change for precision nobody
  // needs. The operator sets SECONDS and this converts once.
  return Math.max(1, Math.ceil((request.droneRedeployHoldOffSeconds * 1000) / FLEET_COMPANION_CADENCE_MS));
}

// ─── The `loot` order ────────────────────────────────────────────────────────

/**
 * How close this ship must actually be, CENTRE TO CENTRE, before it reaches
 * into a wreck or a can.
 *
 * ⚠ CENTRE TO CENTRE, BECAUSE THAT IS WHAT THE SERVER MEASURES, and measuring
 * it any other way is what had a companion fly to a can and stand there.
 * `invbroker` refuses to bind a space container whose straight-line centre
 * distance from the ship exceeds 2,500 m, and it refuses with `FakeItemNotFound`
 * -- the same answer it gives for an id it has never heard of, so nothing on the
 * wire says "not yet, keep coming".
 *
 * This rung used to ask `measureSpace`, whose distances are SURFACE distances:
 * centres minus BOTH radii. So a pilot 2,400 m from the hull of a can was
 * 2,400 + its own radius + the can's radius away from the centre the server
 * measures to, and reached in from outside the gate while still flying. Observed
 * live 2026-09-11: three `GetInventoryFromId` calls answered `FakeItemNotFound`
 * over four seconds, and the fourth -- a few hundred metres later -- bound the
 * container and listed it. By then the attempt bound in `companionLootFrom` had
 * already set the can aside, so the pilot parked next to a can it never opened.
 *
 * ⚠ THE MARGIN IS FREE, SO IT IS GENEROUS. The approach below hugs the object
 * (no range), so a pilot that is going to loot at all is on its way to ~50 m --
 * waiting for 2,000 m costs it a second of travel and nothing else. Distance to
 * a can this ship is closing on only ever falls between ticks, so a stale
 * snapshot can only make this rung MORE cautious, never less.
 *
 * ⚠ IT IS NO LONGER THE DSL's `LOOT_RANGE_M`, and that divergence is deliberate
 * rather than drift. `loot-wrecks` keeps the same 2,400 m surface test and gets
 * away with it because it has a refusal ledger: a refused transfer marks the
 * wreck unreachable, the block closes in and tries again. This loop has no
 * ledger to consult (see the note on the loot action below), so it has to be
 * right the first time instead of recovering afterwards.
 */
const COMPANION_LOOT_REACH_M = 2000;

/**
 * Where to STOP when closing on a wreck to SALVAGE it.
 *
 * ⚠ COMFORTABLY INSIDE THE RANGE THAT LETS THE JOB HAPPEN, AND THAT MARGIN IS
 * THE WHOLE POINT. It was first set EQUAL to the working range above, and a
 * pilot then flew to a can and sat next to it doing nothing, for ever (observed
 * live, 2026-09-11). Asking the server to stop AT the threshold parks the ship
 * on the boundary, where a metre of overshoot or of rounding leaves
 * `distance > range` true on every tick -- so the rung waits on an approach that
 * has already finished, and reports nothing at all.
 *
 * A threshold you must be INSIDE must never be the distance you aim for.
 *
 * ⚠ LOOTING HAS NO SUCH RANGE, BY THE OPERATOR'S DECISION: "for loot do not use
 * range, for salvage do". A looter flies all the way to the can and takes what
 * is in it, which sidesteps the boundary problem entirely rather than managing
 * it -- and unlike a salvager, there is nothing it gains by standing off.
 */
const SALVAGE_APPROACH_STOP_M = 3000;

/**
 * Run a salvager inside its ~5-6 km reach, with margin.
 *
 * ⚠ DUPLICATED FROM `scriptMacros.ts`, DELIBERATELY, AND RECORDED RATHER THAN
 * SILENTLY ACCEPTED. The DSL has the same constant and it is not exported.
 * Importing it would pull the whole macro table into a loop whose entire point
 * is not to be part of the DSL -- the same reason the companion builds its own
 * observation instead of reusing `observe(hint)`. If these two drift, the
 * symptom is a companion that reaches from a slightly different distance than a
 * scripted bot does, which is confusing rather than wrong. The shared-constant
 * lesson from COMPANION_GRANT_SCRIPT_REV applies to values the SERVER
 * validates; a salvager's own reach is not one of those.
 */
const COMPANION_SALVAGE_RANGE_M = 4500;

/** How many ticks to wait on a wreck's lock before giving up on that wreck. */
const MAX_SALVAGE_LOCK_WAIT_TICKS = 10;


/**
 * Whether this ship is still under way toward something.
 *
 * ⚠ READ OFF THE SHIP, NOT OFF OUR OWN MEMORY OF HAVING ASKED. "I sent an
 * approach" and "the ship is approaching" are different claims, and only the
 * second one is worth waiting on.
 */
function isClosing(obs: FleetCompanionObservation): boolean {
  const mode = obs.snapshot?.ship?.mode ?? null;
  return mode !== null && /follow|approach|warp/i.test(mode);
}

/**
 * Straight-line metres between two things that carry a position.
 *
 * ⚠ NOT `measureSpace`, WHICH ONLY MEASURES FROM THIS SHIP. The claim rule below
 * has to ask how far a FLEET-MATE is from a wreck, and that pair never involves
 * this pilot at all.
 */
function metresBetween(a: SpaceEntity, b: SpaceEntity): number {
  const ax = a.position?.x ?? 0;
  const ay = a.position?.y ?? 0;
  const az = a.position?.z ?? 0;
  const bx = b.position?.x ?? 0;
  const by = b.position?.y ?? 0;
  const bz = b.position?.z ?? 0;
  return Math.hypot(ax - bx, ay - by, az - bz);
}

/**
 * Straight-line metres from THIS ship's centre to something else's centre.
 *
 * ⚠ THE SERVER'S OWN MEASURE, AND THE ONLY ONE WORTH TESTING A SERVER GATE
 * AGAINST. `measureSpace` answers SURFACE distances -- centres minus both radii
 * -- which is the right number to show a player and the wrong one to predict a
 * refusal with. See `COMPANION_LOOT_REACH_M` for what believing the wrong one
 * cost.
 *
 * ⚠ A MISSING POSITION IS INFINITY, NEVER ZERO. `metresBetween` above reads an
 * absent coordinate as the origin because both its arguments are grid rows that
 * always carry one; here a snapshot that cannot say where this ship is must read
 * as "too far to reach in", so the rung keeps closing instead of reaching from a
 * distance nobody measured.
 */
function centreMetresToShip(obs: FleetCompanionObservation, target: SpaceEntity): number {
  const snapshot = obs.snapshot ?? null;
  const self = snapshot?.entities.find((entity) => entity.isSelf === true) ?? null;
  const origin = snapshot?.ship?.position ?? self?.position ?? null;
  const there = target.position ?? null;
  if (origin === null || there === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(origin.x - there.x, origin.y - there.y, origin.z - there.z);
}

/**
 * The fleet's OTHER ships on this grid, by their character id.
 *
 * ⚠ FLEET MEMBERS ONLY, NEVER EVERY PLAYER ON GRID. A stranger racing us to a
 * wreck is not somebody to yield to; a fleet-mate is. And it excludes this ship,
 * because `claimedByThisPilot` compares against it separately.
 */
function fleetShipsOnGrid(obs: FleetCompanionObservation): readonly SpaceEntity[] {
  const fleet = obs.fleetMemberCharacterIDs ?? null;
  const me = obs.myCharacterID ?? null;
  if (fleet === null) {
    return [];
  }
  return (obs.snapshot?.entities ?? []).filter(
    (entity) =>
      entity.kind === "ship" &&
      entity.isSelf !== true &&
      entity.characterID !== null &&
      entity.characterID !== me &&
      fleet.includes(entity.characterID),
  );
}

/**
 * Which of `candidates` this pilot should take: the nearest one that NO
 * fleet-mate on grid is better placed for.
 *
 * ⚠ THIS IS DE-CONFLICTION WITHOUT A COORDINATION CHANNEL, and that is why it is
 * shaped as a claim rather than as a message. Every companion runs this same
 * rule over the same snapshot and reaches the same answer about who takes what,
 * so two pilots split a field of wrecks without ever telling each other
 * anything. Nothing is written, nothing is reserved, and a pilot that leaves or
 * arrives simply changes the answer on the next tick.
 *
 * ⚠ THE PROBLEM IT SOLVES IS REAL AND WAS PREDICTED BEFORE IT WAS SEEN: with
 * plain nearest-first, two pilots on one grid pick the SAME nearest wreck and
 * convoy to it, doing the work of one. It is not harmful -- the loser finds it
 * emptied, marks it and moves on -- but it wastes half the fleet.
 *
 * ⚠ TIES BREAK ON CHARACTER ID, NOT ARBITRARILY. Two pilots exactly equidistant
 * (the same wreck, ships abreast) would otherwise both claim or both yield. The
 * lower id wins, which every pilot computes identically.
 *
 * ⚠ AND A PILOT THAT CLAIMS NOTHING STILL WORKS. If a fleet-mate is better
 * placed for every candidate, this falls back to the plain nearest rather than
 * idling -- otherwise the last pilot in a big fleet would sit still while one
 * ship worked a field alone.
 */
function pickForThisPilot(
  obs: FleetCompanionObservation,
  candidates: readonly SpaceEntity[],
): SpaceEntity | null {
  const me = (obs.snapshot?.entities ?? []).find((entity) => entity.isSelf === true) ?? null;
  const myID = obs.myCharacterID ?? 0;
  const mates = me === null ? [] : fleetShipsOnGrid(obs);

  let claimed: { entity: SpaceEntity; metres: number } | null = null;
  let anyNearest: { entity: SpaceEntity; metres: number } | null = null;

  for (const candidate of candidates) {
    const mine = me === null ? Number.POSITIVE_INFINITY : metresBetween(me, candidate);
    if (anyNearest === null || mine < anyNearest.metres) {
      anyNearest = { entity: candidate, metres: mine };
    }
    const beaten = mates.some((mate) => {
      const theirs = metresBetween(mate, candidate);
      if (theirs < mine) {
        return true;
      }
      return theirs === mine && (mate.characterID ?? 0) < myID;
    });
    if (!beaten && (claimed === null || mine < claimed.metres)) {
      claimed = { entity: candidate, metres: mine };
    }
  }
  return (claimed ?? anyNearest)?.entity ?? null;
}

/**
 * Whether the `loot` order will open this entity.
 *
 * ⚠ NO OWNERSHIP CHECK, BY THE OPERATOR'S DECISION: "just loot everything. we
 * do not care about ownership. this is private server."
 *
 * ⚠ AND THE CODEBASE ALREADY SAID SO FOR CONTAINERS. `lootContainers` in the
 * DSL carries the same call in its own words -- "no ownership check: this is an
 * emulator, not a client guarding real players from can-flipping, and the
 * server enforces none either". Wrecks were the inconsistent half.
 *
 * ⚠ THE GATE THAT USED TO BE HERE WAS NOT MERELY STRICT, IT WAS BROKEN. It
 * allowed a wreck owned by this character or this CORPORATION -- but a wreck
 * carries the CHARACTER id of whoever got the kill, so the corp clause could
 * never match, and a companion (which kills nothing of its own) could never
 * attribute a single wreck to itself. Observed live on 2026-09-11: the FC
 * killed three rats and `loot` did nothing at all. Recorded so nobody
 * reinstates it believing it ever worked.
 */
function companionMayOpen(entity: SpaceEntity): boolean {
  return entity.kind === "wreck" || entity.kind === "container";
}

/**
 * The `loot` order: empty the wrecks that are ours and every can on the grid,
 * nearest first.
 *
 * ⚠ THIS IS THE ONLY THING A COMPANION DOES THAT MOVES THE SHIP OF ITS OWN
 * ACCORD. Everything else it does is fired from where it already is, or is a
 * move somebody else ordered. Looting approaches each target in turn, so a
 * companion told to loot will drift off formation -- which is why this rung sits
 * at the very bottom of the ladder, beneath the fleet orders and far beneath the
 * flee. A pilot that is dying, or being fleet-warped, stops looting instantly.
 */
function decideLooting(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionDecision | null {
  if (memory.areaJob !== "loot") {
    return null;
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null || obs.inWarp === true) {
    return null;
  }
  const reachable = lootablesOnGrid(obs, memory);
  if (reachable.length === 0) {
    return null;
  }
  // ⚠ THE TARGET IS CHOSEN ONCE AND THEN KEPT. Re-picking every tick made this
  // rung wander -- see `lootTargetID`. A target only stops being the target when
  // it has been opened or has left the grid, and `lootablesOnGrid` already drops
  // both of those.
  let target = reachable.find((entity) => entity.itemID === memory.lootTargetID) ?? null;
  let mem = memory;
  if (target === null) {
    // ⚠ AND THE CLAIM RULE IS CONSULTED HERE, AT THE MOMENT OF CHOOSING, not on
    // every tick. Two companions would otherwise converge on the same can. See
    // `pickForThisPilot`.
    target = pickForThisPilot(obs, reachable);
    if (target === null) {
      return null;
    }
    mem = { ...memory, lootTargetID: target.itemID, lootApproaching: null };
  }
  // ⚠ CENTRE TO CENTRE, THE WAY THE SERVER MEASURES IT. See
  // `COMPANION_LOOT_REACH_M`: the surface distance this used to ask for is
  // smaller by both radii, so it read "in range" while the bind was still being
  // refused, and the refusals spent the whole attempt budget on the last few
  // hundred metres of the approach.
  const best = centreMetresToShip(obs, target);
  if (best > COMPANION_LOOT_REACH_M) {
    // ⚠ ISSUED ONCE, THEN WAITED ON. Re-sending `approach` at every tick would
    // spend the run's one call per tick re-ordering a move already under way.
    // Same rule as the salvage rung: an approach that is no longer running is
    // not an approach, however recently it was sent.
    if (mem.lootApproaching === target.itemID && isClosing(obs)) {
      return waiting("Looting", "Closing on something to loot.", mem);
    }
    return {
      // No range: fly right up to it. See SALVAGE_APPROACH_STOP_M's comment.
      action: { kind: "approach", targetID: target.itemID },
      phase: "Looting",
      why: "Closing on something to loot, as asked.",
      memory: { ...mem, lootApproaching: target.itemID },
    };
  }
  // ⚠ MARKED LOOTED ON THE ASKING, NOT ON THE ANSWER, AND THAT IS A KNOWN
  // WEAKER GUARANTEE THAN THE DSL'S. `loot-wrecks` waits a tick and checks the
  // refusal ledger before believing a transfer landed; this loop has no refusal
  // ledger to consult. The consequence of being wrong is one skipped wreck on a
  // pilot whose real job is flying with the fleet, which is a better trade than
  // a rung that retries a full hold forever.
  return {
    action:
      target.kind === "container"
        ? { kind: "lootContainer", containerID: target.itemID }
        : { kind: "lootWreck", wreckID: target.itemID },
    phase: "Looting",
    why: "Taking what is inside, as asked.",
    // ⚠ NOT MARKED LOOTED HERE. Whether the can actually emptied is settled by
    // `lootFinishedItemIDs` on a later tick, from what the transfer really
    // moved. Marking it on the asking is what had a pilot take one stack of
    // three and fly off. The latch is kept for the same reason: this can is
    // still the target until somebody says it is done.
    memory: { ...mem, lootApproaching: null },
  };
}


/**
 * Run a fitted SALVAGER on the nearest wreck: close, lock, cycle.
 *
 * ⚠ THE OTHER HALF OF THE `salvage` ORDER, AND IT WAS MISSING. The first cut of
 * the verb acted on salvage DRONES alone, because that is how the order was
 * first described. A hull with a salvager bolted on and no drone bay could be
 * told to salvage and would stand there. What a pilot can do is a property of
 * its FIT -- the same principle that deleted every module picker -- so the order
 * acts on whatever this ship actually has for the job.
 *
 * ⚠ IT RUNS ALONGSIDE THE DRONES, NOT INSTEAD OF THEM. A ship carrying both
 * sweeps with the drones on the server's own auto-pick AND works the nearest
 * wreck with the module. They are separate rungs because one costs a drone
 * command and the other moves the ship; nothing here recalls or blocks the
 * drones.
 *
 * ⚠ AND IT MOVES THE SHIP, so it sits at the bottom of the ladder beside the
 * loot rung. A salvager reaches about 5 km, so closing on a wreck can pull a
 * companion off formation exactly as looting can -- and it yields to the flee,
 * to the supervision gate and to a fleet warp for the same reason.
 */
function decideSalvaging(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionDecision | null {
  if (!salvageWasOrdered(memory) || request.salvagerModuleIDs.length === 0) {
    return null;
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null || obs.inWarp === true) {
    return null;
  }
  const wrecks = snapshot.entities.filter((entity) => entity.kind === "wreck");
  if (wrecks.length === 0) {
    return null;
  }
  const measurement = measureSpace(snapshot);

  // ⚠ THE REMEMBERED WRECK IS DROPPED THE MOMENT IT IS GONE, which is how this
  // rung knows it finished one: a salvaged wreck leaves the grid. That is the
  // opposite of looting, where an emptied wreck STAYS and the rung has to keep
  // its own record of what it has already opened.
  let wreckID = memory.salvageWreckID;
  if (wreckID !== null && !wrecks.some((wreck) => wreck.itemID === wreckID)) {
    wreckID = null;
  }
  let mem = memory;
  if (wreckID === null) {
    // ⚠ PICKING IS NOT AN ACTION, AND THIS RUNG USED TO TREAT IT AS ONE. It
    // returned an `approach` the moment it chose a wreck, so a wreck ALREADY in
    // range cost a wasted tick closing on something it was already next to.
    // Choosing falls through to the range test below instead.
    // The wreck this pilot is best placed for, so a fleet splits a field
    // instead of queueing on one hull. See `pickForThisPilot`.
    const pick = pickForThisPilot(obs, wrecks);
    if (pick === null) {
      return null;
    }
    wreckID = pick.itemID;
    mem = {
      ...memory,
      salvageWreckID: wreckID,
      salvageLockIssued: false,
      salvageLockWaited: 0,
      salvageApproachIssued: false,
    };
  }

  const distance = measurement?.distances.get(wreckID) ?? Number.POSITIVE_INFINITY;
  if (distance > COMPANION_SALVAGE_RANGE_M) {
    // ⚠ ONLY BELIEVE AN APPROACH THAT IS STILL RUNNING. A move that was
    // refused, or that the server finished early, leaves the ship stopped and
    // out of reach -- and a rung that trusted its own "already issued" flag
    // would wait on it for the rest of the run.
    if (mem.salvageApproachIssued && isClosing(obs)) {
      return waiting("Salvaging", "Flying to the wreck.", mem);
    }
    return {
      action: { kind: "approach", targetID: wreckID, range: SALVAGE_APPROACH_STOP_M },
      phase: "Salvaging",
      why: "Closing on a wreck to salvage it, as asked.",
      memory: { ...mem, salvageApproachIssued: true },
    };
  }
  if (!(obs.lockedTargetIDs ?? []).includes(wreckID)) {
    if (!mem.salvageLockIssued) {
      return {
        action: { kind: "lock", targetID: wreckID },
        phase: "Salvaging",
        why: "Locking the wreck to salvage it.",
        memory: { ...mem, salvageLockIssued: true, salvageLockWaited: 0 },
      };
    }
    // ⚠ BOUNDED, BECAUSE A WRECK THAT WILL NOT LOCK NEVER SAYS SO. Without this
    // the rung waits on one wreck for the rest of the run while a grid full of
    // others goes unsalvaged.
    if (mem.salvageLockWaited >= MAX_SALVAGE_LOCK_WAIT_TICKS) {
      return waiting("Salvaging", "That wreck would not lock - moving on.", {
        ...mem,
        salvageWreckID: null,
        salvageLockIssued: false,
        salvageLockWaited: 0,
      });
    }
    return waiting("Salvaging", "Waiting for the lock.", {
      ...mem,
      salvageLockWaited: mem.salvageLockWaited + 1,
    });
  }
  // Locked and in range. Start the first salvager that is not already cycling.
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
  const next = request.salvagerModuleIDs.find((moduleID) => !active.has(moduleID));
  if (next === undefined) {
    return waiting("Salvaging", "Salvaging the wreck.", mem);
  }
  return {
    action: { kind: "activate", moduleID: next, targetID: wreckID },
    phase: "Salvaging",
    why: "Running the salvager on the wreck.",
    memory: mem,
  };
}

/**
 * The three drone jobs a companion will actually do.
 *
 * ⚠ A SUBSET OF `DroneRole` IN `droneRoles.ts`, ON PURPOSE. That module also
 * knows `mining` and `other`, and neither belongs here: a companion does not
 * mine, and `other` is the bucket that holds the drones this server cannot
 * usefully fly at all (webifier and energy-neutralizer drones have no effect
 * implementation, and the server refuses to engage them). Naming the subset
 * here means a new role cannot silently become something a companion launches.
 */
type CompanionDroneRole = "combat" | "logistic" | "salvage";

/**
 * Rung 6: keep the drones alive.
 *
 * Three states, driven by a record rather than by the condition that started
 * them - the shape `standDownAfterFight` uses, and for the same reason it does.
 *
 * ⚠ THE TRIGGER EXTINGUISHES ITSELF, WHICH IS WHY A RECORD IS THE ONLY WORKABLE
 * SHAPE. The instant the recall lands, the drones are not in space, so
 * `lowestDroneHealth` reads `null` and the condition that fired is no longer
 * true. A rung that re-derived its state from the observation every tick would
 * fire once and then forget it was ever in a cycle, orphaning the hold-off and
 * the relaunch.
 *
 * ⚠ HOLDING OFF ISSUES NOTHING AND RETURNS NOTHING, so the rungs below keep
 * their turn. The hold-off is a floor on a wait, not a reason to stop obeying
 * the fleet - a pilot that went quiet for ten seconds every time a drone got
 * shot would be worse than one with no drones at all.
 */
function decideDrones(
  request: FleetCompanionRequest,
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): { readonly decision: CompanionDecision | null; readonly memory: CompanionLadderMemory } {
  const nothing = { decision: null, memory } as const;
  // ⚠ NO `useDrones` FLAG. A pilot uses the drones it is carrying. What it does
  // with them is decided by WHAT THEY ARE, not by a checkbox -- see
  // `wantedDroneRole`.
  if (obs.inSpace !== true || obs.snapshot == null) {
    return nothing;
  }
  const out = obs.myDroneIDs ?? [];
  const cycle = memory.droneCycle;
  const role = wantedDroneRole(obs, memory);

  // --- a cycle already under way ------------------------------------------

  if (cycle !== null) {
    if (cycle.stage === "recalling") {
      // Observed PER RECORDED DRONE against the grid, never off a coarse
      // "any drones out" flag: this ship may have launched others since, and a
      // flag would call the recall finished the moment one unrelated drone
      // came home - or never, while one stayed out.
      const stillOut = cycle.recalledIDs.filter((droneID) => out.includes(droneID));
      if (stillOut.length === 0) {
        // Gone from the grid IS the confirmation the recall committed: the
        // server only removes the ball once the item has actually moved into
        // the bay (`recallDronesToShipBay`). It is not proof they are at the
        // ship - the scoop happens at 2500 m, mid-flight - but "in the bay" is
        // the fact the hold-off is about.
        return {
          decision: null,
          memory: { ...memory, droneCycle: { ...cycle, stage: "holding-off", waited: 0 } },
        };
      }
      if (cycle.waited >= MAX_DRONE_RECALL_WAIT_TICKS) {
        // Given up on, not retried. See MAX_DRONE_RECALL_WAIT_TICKS: the
        // commonest reason a recall never completes is a full bay, which the
        // server refuses SILENTLY, and re-issuing the same call cannot fix a
        // bay that has no room in it.
        return { decision: null, memory: { ...memory, droneCycle: null } };
      }
      return {
        decision: null,
        memory: { ...memory, droneCycle: { ...cycle, waited: cycle.waited + 1 } },
      };
    }

    // holding-off
    if (cycle.waited + 1 < droneCycleHoldTicks(request)) {
      return {
        decision: null,
        memory: { ...memory, droneCycle: { ...cycle, waited: cycle.waited + 1 } },
      };
    }
    // The hold-off is over. Whether anything goes back out is the launch
    // branch's decision, taken below on the NEXT tick against a fresh bay
    // read - a relaunch that reached for the ids it recalled would be reaching
    // for a listing a tick older than the one it is about to act on.
    //
    // ⚠ AND IT GOES BACK OUT BY ROLE, not as "whatever was in the bay". The
    // relaunch used to send `droneBayItemIDs` -- the WHOLE bay -- which is how
    // a hurt combat drone coming home could take a salvage drone back out with
    // it. The role is re-decided here because the fight may have ended while
    // the drones were in the bay.
    const bay = role === null ? null : droneBayFor(obs, role);
    if (role === null || bay === null || bay.length === 0) {
      return { decision: null, memory: { ...memory, droneCycle: null } };
    }
    return {
      decision: {
        action: { kind: "launchDrones", droneItemIDs: bay },
        phase: "Drones",
        why: `Sending the ${DRONE_ROLE_WORDS[role]} back out.`,
        memory: { ...memory, droneCycle: null },
      },
      memory,
    };
  }

  // --- never two kinds at once --------------------------------------------
  //
  // ⚠ THIS IS THE RUNG'S ONLY DEFENCE AGAINST A MIXED BAY IN SPACE, and it is
  // why it sits ABOVE the hurt-drone check rather than below it. The operator's
  // rule is "do not mix drones, at one time one type of the drones", and the
  // failure it prevents is concrete: a bay holding combat and salvage drones
  // launched together puts salvage drones into a fight they cannot fight and
  // fills the control slots the combat drones needed. The scripted bots have
  // always done this (`launchRoleDrones` recalls other-role drones first); the
  // companion is the one place in this app that did not.
  //
  // Wrong-role drones are brought home BEFORE anything of the right role goes
  // out, never at the same time -- one atomic call per tick is this loop's whole
  // contract, and a launch issued while the wrong drones are still on grid is
  // exactly the mixing this prevents.
  if (role !== null && out.length > 0) {
    const wrongRole = out.filter((droneID) => !droneIDsOutFor(obs, role).includes(droneID));
    if (wrongRole.length > 0) {
      return {
        decision: {
          action: { kind: "recallDrones", droneIDs: wrongRole },
          phase: "Drones",
          why: `Bringing the wrong drones home first - this pilot needs its ${DRONE_ROLE_WORDS[role]} out.`,
          memory,
        },
        memory,
      };
    }
  }

  // --- no cycle: should one start? ----------------------------------------

  const hurt = obs.lowestDroneHealth ?? null;
  if (
    hurt !== null &&
    hurt < request.droneHealthFloor &&
    out.length > 0 &&
    memory.droneCyclesSpent < MAX_DRONE_REDEPLOY_CYCLES
  ) {
    return {
      decision: {
        action: { kind: "recallDrones", droneIDs: out },
        phase: "Drones",
        why: "A drone is getting hurt. Bringing them home, which also gives it its shield back.",
        memory: {
          ...memory,
          droneCyclesSpent: memory.droneCyclesSpent + 1,
          droneCycle: { stage: "recalling", recalledIDs: [...out], waited: 0 },
        },
      },
      memory,
    };
  }

  // --- the job is over: bring them home -----------------------------------
  //
  // ⚠ THIS BRANCH WAS MISSING ENTIRELY, and drones stayed out for the rest of
  // the run once a grid went quiet (observed live, 2026-09-11). Nothing else
  // recalls them: the hurt-drone cycle needs a hurt drone, the wrong-role recall
  // needs another role to want the slots, and the flee only recalls on its way
  // out. A fight that simply ends left them drifting.
  //
  // ⚠ ONLY ON A GRID WE CAN SEE. `hostileOnGrid` is three-state and `null` means
  // the read failed -- recalling on that would pull drones in every time a
  // snapshot stumbled, mid-fight. Only a confident `false` ends the job.
  if (role === null) {
    if (out.length > 0 && obs.hostileOnGrid === false) {
      return {
        decision: {
          action: { kind: "recallDrones", droneIDs: out },
          phase: "Drones",
          why: "Nothing left to do here. Bringing the drones home.",
          memory,
        },
        memory,
      };
    }
    return nothing;
  }

  // --- putting the right drones out, and giving them their job ------------
  const roleOut = droneIDsOutFor(obs, role);
  if (roleOut.length === 0) {
    const bay = droneBayFor(obs, role);
    if (bay === null || bay.length === 0) {
      // `null` is "did not look" and `[]` is "none of that kind aboard".
      // Neither launches, and neither is an error: a pilot without the drones
      // for this job simply does the job without them, or not at all.
      return nothing;
    }
    return {
      decision: {
        action: { kind: "launchDrones", droneItemIDs: bay },
        phase: "Drones",
        why: DRONE_LAUNCH_WHY[role],
        memory,
      },
      memory,
    };
  }

  // They are out. Two of the three roles need to be TOLD what to do; the third
  // does not.
  //
  // ⚠ COMBAT DRONES ARE DELIBERATELY GIVEN NO ORDER, AND THAT IS NOT AN
  // OMISSION. The server assigns idle combat drones onto whatever shoots their
  // controller by itself (`noteIncomingAggression`, droneRuntime.js), and the
  // behaviour setting that gates it defaults to on with no client surface to
  // change it. So "use combat drones to defend" is achieved by HAVING THEM OUT.
  // Issuing an engage of our own would fight the server's own choice of target
  // for no gain, one call per tick.
  if (role === "combat") {
    return nothing;
  }
  if (role === "salvage") {
    // ⚠ `targetID: 0` IS THE SERVER'S OWN AUTO-PICK, not a null we forgot to
    // fill in: `resolveAutomaticSalvageTarget` chooses a wreck. It is the same
    // call the DSL's `salvage-wrecks` macro makes, and it means this rung does
    // not have to rank wrecks itself or re-issue as each one is consumed.
    if (memory.lastSalvageOrderedFor === roleOut.length) {
      return nothing;
    }
    return {
      decision: {
        action: { kind: "salvageDrones", droneIDs: roleOut, targetID: 0 },
        phase: "Drones",
        why: "Salvaging the wrecks here, as asked.",
        memory: { ...memory, lastSalvageOrderedFor: roleOut.length },
      },
      memory,
    };
  }
  // Logistic. The ship to repair is whoever the fleet is calling reps for.
  const healTarget = healCallTargetID(obs);
  if (healTarget === null || memory.lastDroneRepairTargetID === healTarget) {
    return nothing;
  }
  return {
    decision: {
      action: { kind: "engageDrones", droneIDs: roleOut, targetID: healTarget },
      phase: "Drones",
      why: "Sending the repair drones to the ship calling for reps.",
      memory: { ...memory, lastDroneRepairTargetID: healTarget },
    },
    memory,
  };
}

/** What to call each role in a sentence a player reads. Plain words, no jargon. */
const DRONE_ROLE_WORDS: Readonly<Record<CompanionDroneRole, string>> = Object.freeze({
  combat: "combat drones",
  logistic: "repair drones",
  salvage: "salvage drones",
});

const DRONE_LAUNCH_WHY: Readonly<Record<CompanionDroneRole, string>> = Object.freeze({
  combat: "Something hostile is on grid. Putting the combat drones out.",
  logistic: "A fleet-mate is calling for reps. Putting the repair drones out.",
  salvage: "Putting the salvage drones out.",
});

/**
 * The ONE kind of drone this pilot should have in space right now, or null for
 * none at all.
 *
 * ⚠ ONE ROLE, NEVER A SET, AND THAT IS THE WHOLE POINT. The operator's rule is
 * "at one time one type of the drones". Returning a single role is what makes
 * that structural rather than a thing the launch branches have to remember.
 *
 * ⚠ THE ORDER BELOW IS URGENCY, AND IT MATCHES THE LADDER'S OWN. Answering a
 * rep call outranks joining a fight for exactly the reason `decideFleetOrders`
 * already puts the Heal family above a tag: somebody is dying NOW, where a
 * fight is still there next tick. Salvage comes last because it is housekeeping
 * -- and in practice it never competes, because a hull carrying salvage drones
 * is rarely carrying combat drones too.
 *
 * ⚠ EACH BRANCH REQUIRES THE DRONES AS WELL AS THE REASON. A pilot with no
 * repair drones is not "the logistic role with nothing to launch", it is simply
 * not that pilot -- so the branch falls through and it fights instead. This is
 * what makes "if pilot has repair drones use them on fleet members" true without
 * anybody selecting a role.
 *
 * ⚠ WHAT IS ABSENT IS ABSENT ON PURPOSE. Mining drones are never launched: a
 * companion does not mine. Electronic-warfare drones are not launched either --
 * they work on this server, but nothing has asked for them and launching a jam
 * nobody planned is not a default. Webifier and energy-neutralizer drones CANNOT
 * be launched usefully at all: the server implements no effect for either, and
 * refuses to engage them. `droneRoles.ts` records that; none of the three
 * reaches this function, because `splitDroneRoles` never puts them in a role.
 */
function wantedDroneRole(
  obs: FleetCompanionObservation,
  memory: CompanionLadderMemory,
): CompanionDroneRole | null {
  const hasDrones = (role: CompanionDroneRole): boolean =>
    (droneBayFor(obs, role)?.length ?? 0) > 0 || droneIDsOutFor(obs, role).length > 0;

  if (healCallTargetID(obs) !== null && hasDrones("logistic")) {
    return "logistic";
  }
  // ⚠ ONLY INTO A FIGHT. `hostileOnGrid` is three-state and only `true` starts
  // a launch: `null` means the grid could not be read, and launching blind
  // would put drones out on a grid this pilot cannot see - the one place they
  // are hardest to get back.
  if (obs.hostileOnGrid === true && hasDrones("combat")) {
    return "combat";
  }
  if (salvageWasOrdered(memory) && hasDrones("salvage")) {
    return "salvage";
  }
  return null;
}

/** The bay stacks of one role. `null` is "the bay was not read", never "empty". */
function droneBayFor(
  obs: FleetCompanionObservation,
  role: CompanionDroneRole,
): readonly number[] | null {
  switch (role) {
    case "combat":
      return obs.combatDroneBayItemIDs ?? null;
    case "logistic":
      return obs.logisticDroneBayItemIDs ?? null;
    case "salvage":
      return obs.salvageDroneBayItemIDs ?? null;
  }
}

/**
 * This ship's drones of one role that are OUT, by entity id.
 *
 * ⚠ BAY IDS AND ENTITY IDS ARE DIFFERENT ID SPACES. A stack in the bay and a
 * drone in space are not the same object and never share an id; `launchDrones`
 * takes the former and `recallDrones` / `engageDrones` / `salvageDrones` take
 * the latter. Mixing them answers 200 and does nothing.
 */
function droneIDsOutFor(
  obs: FleetCompanionObservation,
  role: CompanionDroneRole,
): readonly number[] {
  switch (role) {
    case "combat":
      return obs.combatDroneIDs ?? [];
    case "logistic":
      return obs.logisticDroneIDs ?? [];
    case "salvage":
      return obs.salvageDroneIDs ?? [];
  }
}

/**
 * The ship the fleet is currently calling reps for, if that call is live and
 * that ship is on this grid.
 *
 * ⚠ THE SAME ANSWER `decideHealOrder` ACTS ON, read the same way, so a pilot's
 * repair DRONES and its remote repair MODULES cannot end up working on two
 * different ships. `itemID` is the ship to repair directly for all four Heal
 * names -- never `senderCharID` resolved to an entity.
 */
function healCallTargetID(obs: FleetCompanionObservation): number | null {
  const name = asHealBroadcastName(obs.fleetBroadcast?.name);
  if (name === null) {
    return null;
  }
  const targetID = obs.fleetBroadcast?.itemID ?? null;
  if (targetID === null) {
    return null;
  }
  return entityOnGrid(targetID, obs.snapshot?.entities ?? []) === null ? null : targetID;
}

/**
 * Rung 7: obeying the fleet. Below the supervision gate and rung 3 (tank up)
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
  const healDecision = decideHealOrder(request, obs, entities, memory);
  if (healDecision !== null) {
    return healDecision;
  }

  // b. The fleet's target tags — a commander's call.
  if (obs.fleetTargetTags !== null && obs.fleetTargetTags !== undefined) {
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

  // e2. A `WarpTo` order — warp to the thing the fleet named.
  //
  //    ⚠ THIS RUNG DID NOT EXIST, ON A FALSE PREMISE. `WarpTo` was classified
  //    `act: false` with the note that "the fleet warp itself is executed
  //    server-side once the broadcast lands". It is not: `sendBroadcast`
  //    (fleetRuntime.js) only ever calls `notifySession`, and warps nobody. The
  //    server-side fleet warp is a DIFFERENT command (`CmdWarpToStuff` with
  //    `fleet=1`), which this loop yields to by seeing its own ship in warp. So
  //    a `WarpTo` broadcast was simply being ignored, and a fleet that told this
  //    pilot to warp watched it sit still.
  if (order?.name === "WarpTo") {
    // ⚠ ANSWERED ONCE PER DESTINATION. A broadcast stands for its whole
    // freshness window, so a rung that re-warped on every tick would re-issue
    // the same warp for thirty seconds -- and land, then immediately warp again.
    if (memory.lastWarpedToID === order.itemID) {
      return {
        action: WAIT,
        phase: "Obeying fleet",
        why: order.why + " Already on the way.",
        memory,
        followingOrderFrom: order.source,
        lastOrderHeard: order.heard,
        standing: true,
      };
    }
    return {
      action: { kind: "warp", targetID: order.itemID },
      phase: "Obeying fleet",
      why: order.why + " Warping to it.",
      memory: { ...memory, lastWarpedToID: order.itemID },
      followingOrderFrom: order.source,
      lastOrderHeard: order.heard,
    };
  }

  // f. A `JumpTo` order — warp to the gate, close in, and jump through it.
  //
  //    ⚠ IT USED TO STOP AT THE GATE, AND THE REASON RECORDED HERE WAS WRONG.
  //    The note said a jump "needs the gate on the FAR SIDE too", which only
  //    `toGateID` on `api.jump` ever wanted -- solved by the autopilot's route
  //    graph, which this pure ladder has no copy of. But the GAME does not want
  //    it: `jumpSessionViaStargate` (transitions.js) resolves the destination
  //    itself from `sourceGate.destinationID` when the far id is absent, and
  //    rejects only a MISMATCHED one. The requirement was our own BFF's
  //    INVALID_GATE check, now relaxed to allow it to be omitted. A stargate
  //    knows where it goes.
  //
  //    ⚠ AND THE SHIP MUST BE AT THE GATE, not merely near it. `decideCloseIn`
  //    against MAX_STARGATE_JUMPING_DISTANCE_M is what makes the jump legal;
  //    firing it from further out is refused by the server, not by us.
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
        action: { kind: "jumpGate", gateID },
        phase: "Obeying fleet",
        why: order.why + " At the gate, jumping through.",
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
    // ⚠ "own-ladder" IS THE DEFAULT, NOT `null`. Every rung except rung 7
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
            // A restart cannot know about a recall the dead process issued, and
            // the server has already abandoned whatever was out when the session
            // dropped. Starting at null means this run makes its own one attempt.
            droneRecallWaited: null,
          },
          closingOn: null,
          // A resumed run has ordered no drones and looted nothing either: the
          // drones the dead process had out were abandoned by the server on the
          // session drop, and a wreck this run has not emptied is a wreck it
          // must be willing to try.
          lastDroneRepairTargetID: null,
          lastSalvageOrderedFor: null,
          lootedItemIDs: [],
          lootApproaching: null,
          lootTargetID: null,
          salvageWreckID: null,
          salvageLockIssued: false,
          salvageLockWaited: 0,
          salvageApproachIssued: false,
          areaJob: null,
          lastWarpedToID: null,
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
          lastTagIssuedFor: null,
          lastTagAttempts: 0,
          taggingGaveUpOn: [],
          // A resumed run has launched and recalled nothing either, and a cycle
          // it was mid-way through is gone with the process that held it. Its
          // drones, if any, are already abandoned in space - that is the
          // server's own doing on a session drop, not something a restart can
          // undo - so the honest state is "no cycle", not a half-remembered one.
          droneCycle: null,
          droneCyclesSpent: 0,
      // Run-local, both of them. See `CompanionFlee`'s header for why a flee is
      // not persisted the way an abandonment is: a companion coming back up
      // reads its own health on the first tick and leaves again within one tick
      // if it still needs to.
      flee: null,
      fleeTripsSpent: 0,
      fleeRecoveryTicks: 0,
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
