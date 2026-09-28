// The mining bot (goal R26) — automated play you can walk away from.
//
// THIS IS THE FOURTH INSTANCE OF ONE PATTERN, not a new one. R5b's autopilot,
// R13's measured distance ladder and R24's Dock are all the same shape, and so
// is this: a browser-side decide-loop that reads AUTHORITATIVE state each tick,
// issues AT MOST ONE atomic call, never simulates or predicts, bounds every
// branch, and PAUSES WITH A REASON rather than guessing. The rungs are new; the
// discipline is inherited, and the closing-on-a-target rungs are literally the
// autopilot's own (`decideCloseIn`), imported rather than re-derived.
//
// It runs in the BROWSER. Closing the tab is closing the client: this JS stops,
// the ship completes whatever server-side command was last issued, and sits.
// The BFF never drives a mining loop with no client attached — that is the
// honest boundary and it is deliberate.
//
// ─── THE HARDEST RULE: A 200 IS NOT PROOF ────────────────────────────────────
//
// This server has six confirmed cases of answering success without acting,
// including R25's live finding that a drone LAUNCH returns 200 while refusing
// two of three drones inline. So NOTHING here believes a call's own answer.
// Every action is confirmed by re-reading the authority that owns the fact:
//
//     locked a rock          -> dogmaIM.GetTargets              (`lockedTargetIDs`)
//     switched a laser on    -> the snapshot's ship block       (`activeModuleIDs`)
//     launched drones        -> the snapshot's drone rows       (`canMyShipOrderDrone`)
//     mined ore              -> the ship's mining hold          (`used` / items)
//     unloaded              -> the ship's mining hold           (items gone)
//     undocked / docked      -> flight status                   (`docked`)
//     closed on something    -> the snapshot's measured distance
//
// And because the decision only ever CHOOSES an action while the authority
// still says it has not happened, counting consecutive identical decisions is
// exactly the bound this needs: a call that lands resets its own counter, and a
// call that keeps answering 200 while changing nothing runs out. That is the
// same construction R24 slice A/B used for warp and dock, applied to every
// branch this ladder has.

import {
  MAX_SILENT_DOCK_ATTEMPTS,
  MAX_WARP_ATTEMPTS,
  STATION_DOCKING_RADIUS_M,
  decideCloseIn,
  measureSpace,
  type SpaceMeasurement,
} from "./autopilotLoop.ts";
import { refusalWords } from "../bridge/refusals.ts";
// R44 — the rung NAMES. Instrumentation only: this module decides nothing and
// is never read by the ladder below, which returns bare identifiers.
import type { MiningCallerRungID, MiningRungID, MiningStepID } from "./miningLadder.ts";
import { canMyShipOrderDrone, formatDistance, hostileRows } from "../space/overview.ts";
import type {
  FlightStatus,
  MiningHold,
  SpaceEntity,
  SpaceSnapshot,
} from "../store/types.ts";

// --- Thresholds and bounds ---------------------------------------------------

/** How often the loop re-decides. The autopilot's cadence, for the same reason. */
export const MINING_BOT_CADENCE_MS = 2000;

/**
 * The bot's own "the warp has landed" test for a belt, in SURFACE metres.
 *
 * ⚠ THIS IS THE ONE NUMBER HERE THAT IS NOT THE SERVER'S. A belt has no
 * interaction radius to borrow — you do not dock with a belt — so the bot needs
 * its own answer to "am I there yet", and it is used for exactly one thing:
 * deciding whether "no rocks in the snapshot" means "still flying" or "this
 * belt is finished". A warp lands the ship inside a few kilometres of its
 * target, so anything inside this is arrival. It is never used as a mining
 * range, a lock range or a yield rule — the SERVER owns all three, and the bot
 * finds them out by being refused.
 */
export const BELT_ARRIVAL_RADIUS_M = 20_000;

/** Settle windows for asynchronous movement/writes and recoverable refusals. */
const SETTLE_DOCK_REFUSAL = 2;
const SETTLE_WARP = 2;
const SETTLE_APPROACH = 2;
const SETTLE_LOCK = 2;
const SETTLE_ACTIVATE = 2;
const SETTLE_LAUNCH = 3;
const SETTLE_UNLOAD = 2;

/**
 * Consecutive lock decisions for the SAME rock with GetTargets still not
 * showing it. A lock is not instant, and SETTLE_LOCK covers the acquisition
 * ticks, so three tries with the authority unchanged is already past "the last
 * one did not take". Exceeding it gives up on that ROCK, not on the run.
 */
export const MAX_LOCK_ATTEMPTS = 3;
/**
 * How many rocks in a row may be given up on without a single lock ever
 * landing. One rock that will not lock is that rock's problem; three in a row
 * is the ship's, and wandering the belt trying every rock is the unbounded
 * repeat this project has been bitten by twice.
 */
export const MAX_CONSECUTIVE_LOCK_FAILURES = 3;
/**
 * Consecutive activate decisions for the same module with `activeModuleIDs`
 * still not listing it. Exceeding it PAUSES rather than skipping quietly: a
 * laser that will not run is the one thing this bot exists to do, and "I asked
 * three times and the ship still says it is off" is precisely the case the
 * "say so and pause" rule was written for.
 */
export const MAX_ACTIVATE_ATTEMPTS = 3;
/**
 * Consecutive launch decisions with no drone of ours appearing in the snapshot.
 * Exceeding it does NOT pause — pausing a defenceless ship next to a pirate is
 * the worst of the available outcomes — it HEADS HOME, which is bounded, safe,
 * and readable.
 */
export const MAX_LAUNCH_ATTEMPTS = 3;
/** Consecutive unload decisions with the ore still sitting in the hold. */
export const MAX_UNLOAD_ATTEMPTS = 3;
/** Consecutive undock decisions with flight status still saying docked. */
export const MAX_UNDOCK_ATTEMPTS = 3;
/** Consecutive ticks spent waiting on an approach that is already running. */
export const MAX_CLOSE_IN_CYCLES = 300;
/** Transient read failures tolerated before the loop stops trusting the read. */
export const MAX_READ_FAILURES = 5;
/**
 * Ticks the lasers may run, on a rock that still has ore, without the hold
 * growing by a single unit. At the 2 s cadence this is three minutes — longer
 * than any mining cycle — so reaching it means the cycle is not producing and
 * the bot must stop claiming it is mining.
 */
export const MAX_NO_YIELD_CYCLES = 90;

// --- Reading the world -------------------------------------------------------

/** Everything one tick looked at. Pure input to the decision. */
export interface MiningObservation {
  readonly status: FlightStatus;
  readonly snapshot: SpaceSnapshot | null;
  readonly measurement: SpaceMeasurement | null;
  /** dogmaIM.GetTargets — THE authority on locks. null = the read failed. */
  readonly lockedTargetIDs: readonly number[] | null;
  /** The ship's holds — THE authority on ore. null = the read failed. */
  readonly holds: readonly MiningHold[] | null;
  /** The drone bay's stacks. null = not read this tick (or the read failed). */
  readonly droneBayItemIDs: readonly number[] | null;
}

/** What the player set the bot to do. */
export interface MiningPlan {
  /** The belt to work. */
  readonly beltID: number;
  readonly beltName: string | null;
  /** Where a full hold goes. */
  readonly stationID: number;
  readonly stationName: string | null;
  /**
   * The equipment the bot runs on the rock — the PLAYER's pick, by name, from
   * the ship's own online modules. The browser never decides which of your
   * modules is a mining laser and never guesses which effect one runs: the
   * server resolves the module's default activation effect from its type.
   */
  readonly miningModuleIDs: readonly number[];
  /**
   * The safety floor, as a remaining fraction (0-1) of any health layer.
   * Dropping below it on shield, armour OR hull abandons the belt and docks.
   * Unattended play means nobody is watching the shield bar.
   */
  readonly healthFloor: number;
  /** Launch drones when a pirate turns up (they auto-engage — R25). */
  readonly useDrones: boolean;
  /** So a drone row can be recognised as one of ours. */
  readonly myCharacterID: number | null;
}

// --- The one atomic action a tick produces -----------------------------------

export type MiningBotAction =
  | { readonly kind: "undock" }
  | { readonly kind: "warp"; readonly destinationID: number; readonly label: string }
  | { readonly kind: "approach"; readonly destinationID: number; readonly label: string }
  | { readonly kind: "dock"; readonly stationID: number; readonly label: string }
  | { readonly kind: "unload"; readonly itemIDs: readonly number[] }
  | { readonly kind: "lock"; readonly targetID: number; readonly label: string }
  | {
      readonly kind: "activate";
      readonly moduleID: number;
      readonly targetID: number;
      readonly label: string;
    }
  | { readonly kind: "launch"; readonly droneItemIDs: readonly number[] }
  | { readonly kind: "wait"; readonly reason: string }
  | { readonly kind: "pause"; readonly reason: string }
  | { readonly kind: "stopped" };

/**
 * One decision: the action, and the plain-language WHY that goes on screen.
 *
 * The `why` is not decoration. A bot you cannot interrogate is one you cannot
 * trust, so every branch of the ladder states its own reason in the words a
 * player uses, and the panel shows the reason for the LAST thing it did at all
 * times — not only when something goes wrong.
 */
export interface MiningDecision {
  readonly action: MiningBotAction;
  readonly why: string;
  /**
   * R44 — WHICH ROW OF THE LADDER FIRED, for the readout only.
   *
   * ⚠ IT IS REQUIRED ON PURPOSE. Every return below must name itself, so the
   * compiler — not a reviewer — is what proves the ladder on screen is the whole
   * ladder. Nothing in the loop branches on it; it is carried to the panel and
   * dropped. See `nav/miningLadder.ts` for the names and for the places this
   * identifier is a LOOSER statement than the code it labels.
   *
   * ⚠ R46 — this is the row the loop TRIED, never a sub-ladder's leaf. The type
   * says so: `MiningCallerRungID` excludes every `MiningStepID`, so a leaf
   * cannot be reported here even by accident. What the sub-ladder then chose is
   * `step`, below, and the two are reported TOGETHER.
   */
  readonly rung: MiningCallerRungID;
  /**
   * R46 — WHICH LEAF OF THE SUB-LADDER THE RUNG CALLED, or null when the rung
   * answered on its own.
   *
   * ⚠ THIS FIELD EXISTS BECAUSE THE READOUT COULD OTHERWISE LIE. R44 let the
   * adopt shortcut SUBSTITUTE its own row for the leaf's, and a decision carried
   * exactly one row — so on a tick where the ship would not say which modules
   * were cycling, the bot switched NOTHING on while the only lit row read
   * "…skip the lock and go straight to the equipment". Carrying both names means
   * the row that fired and the thing that actually happened are never in
   * competition for the same slot, and neither can be dropped to make room for
   * the other.
   *
   * Null means one of two things, and both are honest: the rung produced its own
   * action, or it called the TRAVEL sub-ladder, whose warp / approach / closing
   * / dock steps deliberately have no rows (see `miningLadder.ts`). The belt
   * arrival is the one travel step that does.
   */
  readonly step: MiningStepID | null;
  /** This tick found a reason to abandon the belt and dock (sticky). */
  readonly headHome?: string;
  /** This tick concluded the current rock is finished with, and why. */
  readonly dropRock?: string;
  /** This tick chose a rock to work. */
  readonly takeRock?: number;
}

export type MiningBotStatus = "idle" | "running" | "paused" | "stopped" | "error";

/** The live readout the panel renders (pushed every cycle). */
export interface MiningBotProgress {
  readonly status: MiningBotStatus;
  /** Where in the loop it is, in a couple of words ("Mining", "Hauling"). */
  readonly phase: string | null;
  /** What it just did. */
  readonly action: string | null;
  /** WHY it did that. Always present while running. */
  readonly why: string | null;
  /**
   * R44 — WHICH RUNG of the ladder produced the last decision, for the panel to
   * light up. Null before the first decision, and for anything the CONTROLLER
   * decided rather than the ladder (a settle tick, a spent bound, a refusal) —
   * which is itself a finding: not everything this bot does comes from a row.
   *
   * ⚠ R7d — the panel renders the rung's NAME, never this identifier.
   */
  readonly rung: MiningRungID | null;
  /**
   * R46 — the LEAF the rung called, so the panel lights the caller and what it
   * actually did at the same time. Null when the rung answered on its own, when
   * it called the rowless travel steps, or when no rung fired at all.
   *
   * ⚠ R7d — this identifier never renders either.
   */
  readonly step: MiningStepID | null;
  /** The rock it is working, by NAME (R7d: never an id). */
  readonly rockName: string | null;
  /** Hauls completed: loads actually unloaded into the hangar. */
  readonly cyclesCompleted: number;
  /** Ore units this run, counted from the HOLD growing — never from a yield sum. */
  readonly oreUnitsMined: number;
  readonly holdUsed: number | null;
  readonly holdCapacity: number | null;
  /** Set when it stopped. Always a sentence a player can act on. */
  readonly failureReason: string | null;
}

// --- Reading the authorities -------------------------------------------------

/**
 * The hold mining actually fills: the first specialised hold the hull has, else
 * cargo. That is the runtime's OWN fallback order (the BFF reads ore, gas, ice,
 * asteroid, then cargo), so the bot watches the hold the server will fill
 * rather than picking the fullest one and calling a full cargo bay a full ship.
 */
export function destinationHold(holds: readonly MiningHold[] | null): MiningHold | null {
  if (!holds) {
    return null;
  }
  const present = holds.filter((hold) => hold.present);
  return present.find((hold) => hold.key !== "cargo") ?? present.find((hold) => hold.key === "cargo") ?? null;
}

/**
 * How full the hold gets before the bot takes the load home. The OPERATOR's
 * number: "mine until we hit % full, so do like 90%".
 *
 * ⚠ THIS HEADROOM IS LOAD-BEARING — see `holdShouldHaul`. It is not a rounding
 * allowance and not politeness to the server: it is what stops the bot ever
 * having to work out whether one more unit fits. DO NOT raise it to 1.0.
 */
export const HAUL_AT_FRACTION = 0.9;

/**
 * Time to take the load home? `null` is UNKNOWN — the ship did not report a
 * capacity — and unknown never reads as "go" or as "room to spare".
 *
 * ⚠ THE QUESTION THIS DELIBERATELY NO LONGER ASKS IS "DOES ONE MORE UNIT FIT".
 *
 * It used to. A hold that stops one part-unit short of capacity is the R26 bug:
 * a Retriever stopped at 15999.95 of 16000 m³ with the server refusing to start
 * another cycle, `used >= capacity` is FALSE there, so the bot re-lit the lasers
 * forever and never hauled. The answer then was to derive one unit's volume as
 * `used / units` and ask whether the remaining space was smaller than that.
 *
 * That derivation was itself wrong in a way the R39 soak measured. Across a
 * MIXED hold `used / units` is an AVERAGE describing neither ore — 0.1433 on a
 * hold of Veldspar (0.1 m³) and Scordite (0.15 m³) while the bot was mining the
 * 0.15. Whenever that average sits BELOW the volume of the ore actually
 * arriving, the test fires too late and the original bug is back: the bot reads
 * "not full", relights on a rock whose unit cannot fit, stalls for three
 * minutes and then ends the run with a reason that is not true. One of the two
 * soak hauls was in exactly that state and escaped only because the fill landed
 * on 0.00 free.
 *
 * THE HEADROOM DISSOLVES THE WHOLE CLASS. Stopping at a FRACTION of capacity
 * makes the decision immune to cycle size, to unit volume, to a mixed hold and
 * to wherever the server chooses to stop filling — because the last cycle no
 * longer has to fit exactly. There is nothing left to derive, so the item list
 * is not read here at all and an unreadable one costs nothing: capacity alone
 * decides. A little space goes unused, which is the harmless direction and the
 * entire point.
 */
export function holdShouldHaul(hold: MiningHold | null): boolean | null {
  const capacity = hold?.capacity;
  if (!capacity || capacity.capacity === null || capacity.used === null || !(capacity.capacity > 0)) {
    return null;
  }
  return capacity.used >= capacity.capacity * HAUL_AT_FRACTION;
}

/**
 * Every stack sitting in any readable hold — INCLUDING the cargo hold.
 *
 * ⚠ Read the note on `freightHoldItemIDs` before reaching for this to decide
 * what to unload. The mining-holds route reports the cargo hold as a fallback
 * entry on every hull, so "every stack in any hold" is a superset of "the ore
 * this trip was for" and sweeps the ship's kit along with it.
 */
export function holdItemIDs(holds: readonly MiningHold[] | null): readonly number[] {
  if (!holds) {
    return [];
  }
  return holds.flatMap((hold) => (hold.items ?? []).map((item) => item.itemID));
}

/**
 * Retail's Asteroid category — every ore, ice and harvestable gas type lives in
 * it, so it is exactly "what a mining ship could have mined". The same constant
 * `refine-ore` and the loot router reach for.
 */
const CATEGORY_ASTEROID = 25;

/**
 * Is this one of the hull's OWN specialised mining holds, rather than the cargo
 * hold the route appends as a fallback?
 *
 * ⚠ `present` ALONE IS NOT ENOUGH HERE. Unlike `/bays`, which is strictly
 * three-valued, the mining-holds route computes `present` as
 * `reading !== null && capacity > 0` (src/server.js) — so a hold whose CAPACITY
 * read failed is reported exactly like a hold the hull does not have. Contents
 * are the second witness: a hold that listed a stack demonstrably exists,
 * whatever its capacity read did. Without that, one failed capacity read would
 * demote a Retriever to "no ore hold" and send its cargo ashore instead.
 */
function isSpecialisedHold(hold: MiningHold): boolean {
  if (hold.key === "cargo") {
    return false;
  }
  return hold.present || (hold.items ?? []).length > 0;
}

/**
 * The stacks a DELIVERY should actually put ashore.
 *
 * ⚠ WHY THIS IS NOT `holdItemIDs`. `MINING_HOLDS` on the BFF ends with the
 * cargo hold, and its own comment says what that entry is for: "a hull with no
 * specialised hold mines straight into cargo, so a miner flying a frigate must
 * still be able to see and unload the ore." It is a FALLBACK. But `holdItemIDs`
 * flattens every hold unconditionally, so on a hull that *does* have an ore
 * hold the fallback fired anyway and the delivery emptied the cargo hold too —
 * spare mining crystals, ammunition, scripts and all, into the station hangar,
 * every single lap. Nobody chose that; the filter was simply missing.
 *
 * So: deliver from the specialised holds when the hull has any, and fall back
 * to cargo only when it has none — which is the case the fallback was written
 * for and the only case in which cargo holds the ore.
 *
 * A hull with NO specialised hold carries its kit in the same cargo hold as its
 * ore, so that fallback is filtered by category: only what the ship could have
 * mined is delivered, and the crystals stowed beside it stay put. A row whose
 * category cannot be read is LEFT ABOARD — unknown is never a verdict, the same
 * rule `refine-ore` applies when it refuses to refine a row it cannot classify.
 * Nothing is filtered out of a specialised hold: an ore hold holds ore, and the
 * player put anything else in there on purpose.
 */
export function freightHoldItemIDs(holds: readonly MiningHold[] | null): readonly number[] {
  if (!holds) {
    return [];
  }
  const specialised = holds.filter(isSpecialisedHold);
  if (specialised.length > 0) {
    return specialised.flatMap((hold) => (hold.items ?? []).map((item) => item.itemID));
  }
  const fallback = holds.filter((hold) => hold.key === "cargo").flatMap((hold) => hold.items ?? []);
  // ⚠ NO CLASSIFIER, NO FILTER. If not one row in the hold carries a category,
  // we are not looking at a cargo hold full of unclassifiable things — we are
  // talking to a bridge that does not publish the field at all. Filtering on it
  // then would deliver NOTHING, and a miner would sit at the station mining
  // into a hold that never empties. Falling back to the pre-Part-1b behaviour
  // is the safe reading; a single classified row is enough to trust the filter.
  // `typeof … === "number"`, not `!== null`: a row from a source that omits the
  // field entirely reads as `undefined`, and treating that as "classified"
  // would filter every stack out and deliver nothing.
  const canClassify = fallback.some((item) => typeof item.categoryID === "number");
  if (!canClassify) {
    return fallback.map((item) => item.itemID);
  }
  return fallback.filter((item) => item.categoryID === CATEGORY_ASTEROID).map((item) => item.itemID);
}

/**
 * Total free m³ across every hold that can be READ, or null when none could be.
 *
 * What a loot block asks before reaching into a can: with nowhere to put
 * anything, the answer is not to try and be refused — it is that this ship is
 * full and the trip is over. Absent/unreadable holds contribute nothing rather
 * than a zero, so "we could not look" never masquerades as "there is no room".
 */
export function holdsFreeM3(holds: readonly MiningHold[] | null): number | null {
  if (!holds) {
    return null;
  }
  let total = 0;
  let sawOne = false;
  for (const hold of holds) {
    const capacity = hold.capacity;
    if (!hold.present || capacity === null || capacity.capacity === null || capacity.used === null) {
      continue;
    }
    sawOne = true;
    total += Math.max(0, capacity.capacity - capacity.used);
  }
  return sawOne ? total : null;
}

/** Total units across the holds, or null when nothing could be read. */
export function holdUnits(holds: readonly MiningHold[] | null): number | null {
  if (!holds) {
    return null;
  }
  let total = 0;
  let sawOne = false;
  for (const hold of holds) {
    if (hold.items === null) {
      continue;
    }
    sawOne = true;
    for (const item of hold.items) {
      total += item.quantity;
    }
  }
  return sawOne ? total : null;
}

/**
 * Is this row a rock a laser can work?
 *
 * Read off the mining fields the gateway projects onto ASTEROID ROWS ONLY
 * (R23 slice B): which ore it yields and which belt it belongs to. Nothing else
 * in the snapshot carries them, so this never mistakes a wreck, a can or a
 * planet for something to mine — and it does not need a category number to say
 * so.
 */
export function isMineableRock(entity: SpaceEntity): boolean {
  return !entity.isSelf && (entity.miningYieldTypeID !== null || entity.beltID !== null);
}

/**
 * The lowest health layer the ship reported, or null when it reported none.
 * Unknown is never reassuring and never alarming — it is unknown, and the
 * caller decides what that means where it matters (next to a pirate, it means
 * stop).
 */
export function lowestHealth(snapshot: SpaceSnapshot | null): number | null {
  const ship = snapshot?.ship;
  if (!ship) {
    return null;
  }
  const layers = [ship.shieldRatio, ship.armorRatio, ship.hullRatio].filter(
    (ratio): ratio is number => ratio !== null && Number.isFinite(ratio),
  );
  return layers.length === 0 ? null : Math.min(...layers);
}

function isWarping(shipMode: string | null): boolean {
  return shipMode !== null && /warp/i.test(shipMode);
}

/**
 * The bot's SOLE release verb: the rock it was on is gone from the grid, so let
 * it go and pick another. It must NOT blacklist — a rock is off the grid for the
 * whole trip to the station and back, so treating "not here" as "finished with"
 * would empty a belt by bookkeeping alone. Depletion is the server's: it removes
 * a mined-out rock, and the bot reacts to whatever is still on field (R49).
 */
export const OUT_OF_VIEW = "it went out of view";

/** What to CALL a row on screen. Never an id (R7d). */
function rowLabel(entity: SpaceEntity | null): string {
  return entity?.name ?? "that rock";
}

// --- The decision ------------------------------------------------------------

/** Memory the decision reads. It never mutates it — the controller does. */
export interface MiningDecisionMemory {
  readonly currentRockID: number | null;
  /**
   * Rocks the ship has DEMONSTRABLY REFUSED TO LOCK (asked, declined, past the
   * lock bound). An observed refusal, never a predicted ore count — so the
   * picker steps past a rock that will not lock instead of retrying the same
   * nearest one. Depletion is not tracked here: the server removes mined-out
   * rocks, so a rock still on the grid is always a candidate again (R49).
   */
  readonly lockRefusedRockIDs: ReadonlySet<number>;
  readonly approachingTargetID: number | null;
  /** Sticky: once heading home, shields regenerating does not send it back. */
  readonly headingHome: string | null;
  /** Set once the launch bound is spent, so the launch rung stops re-deciding. */
  readonly launchGaveUp: boolean;
  /** Ticks the lasers have run on this rock with the hold not growing. */
  readonly noYieldCycles: number;
}

/**
 * The pure decision. Given one tick's reading of the world, choose ONE action
 * and say why.
 *
 * The ladder, in order — danger, then the hold, then the rock:
 *
 *   1. danger        health floor -> abandon the belt; pirate -> get the drones out
 *   2. docked+ore    unload
 *   3. docked+empty  undock
 *   4. hold full     dock at the chosen station (R24's ladder, imported)
 *   5. rock we are on  gone from the grid -> let it go; locked -> run the lasers
 *   6. no rock       pick the nearest mineable rock on the grid and lock it
 *   7. none left     pause with a plain reason — do NOT wander
 *   8. otherwise     wait
 *
 * ⚠ THERE IS NO DEPLETION RUNG (R49). The bot does not decide a rock is empty;
 * the server removes a mined-out rock from the grid, and rung 5's "gone from the
 * grid" is that removal seen reactively. The client never predicts depletion.
 */
export function decideMiningAction(
  observation: MiningObservation,
  plan: MiningPlan,
  memory: MiningDecisionMemory,
): MiningDecision {
  const { status, snapshot, measurement, lockedTargetIDs, holds } = observation;

  // ── Docked ────────────────────────────────────────────────────────────────
  if (status.docked) {
    // The hold is the authority on whether there is anything to unload. Without
    // it we do not undock: heading back out with a full hold would mine nothing
    // and burn the trip.
    if (holds === null) {
      return {
        action: { kind: "wait", reason: "reading holds" },
        why: "Looking in the hold.",
        rung: "reading-hold",
        step: null,
      };
    }
    const items = freightHoldItemIDs(holds);
    if (items.length > 0) {
      return {
        action: { kind: "unload", itemIDs: items },
        why: "Docked with ore aboard, so it goes into the hangar first.",
        rung: "docked-with-ore",
        step: null,
      };
    }
    // The hold is empty and confirmed empty. If we came back for a reason
    // other than a full hold, this is where the run ends — going straight back
    // out to the thing that drove us off would be the opposite of safe.
    if (memory.headingHome) {
      return {
        action: { kind: "pause", reason: memory.headingHome },
        why: memory.headingHome,
        rung: "run-over",
        step: null,
      };
    }
    return {
      action: { kind: "undock" },
      why: `The hold is empty, so it is time to head back${plan.beltName ? ` to ${plan.beltName}` : " to the belt"}.`,
      rung: "docked-and-empty",
      step: null,
    };
  }

  if (!status.inSpace) {
    return {
      action: { kind: "wait", reason: "no location" },
      why: "Waiting for the ship to say where it is.",
      rung: "no-location",
      step: null,
    };
  }

  // Never act mid-warp: retail returns immediately on DSTBALL_WARP, and so does
  // every loop in this client.
  if (isWarping(status.shipMode) || isWarping(measurement?.shipMode ?? null)) {
    return {
      action: { kind: "wait", reason: "in warp" },
      why: "In warp.",
      rung: "in-warp",
      step: null,
    };
  }

  // ── 1. Danger first ───────────────────────────────────────────────────────
  //
  // The floor is checked BEFORE the drones on purpose. The goal lists drones
  // first, but once the ship is already under the floor no launch saves it —
  // survival outranks yield, and it outranks defence too.
  const origin = snapshot?.ship?.position ?? { x: 0, y: 0, z: 0 };
  const hostiles = snapshot ? hostileRows(snapshot, origin) : [];
  const health = lowestHealth(snapshot);

  if (health !== null && health < plan.healthFloor) {
    const percent = Math.round(health * 100);
    const reason = `Your ship is down to ${percent}%, so the bot broke off and is heading for ${plan.stationName ?? "the station"}.`;
    const home = travelDecision(plan.stationID, plan.stationName, STATION_DOCKING_RADIUS_M, "dock", observation, memory, reason, "health-floor");
    return { ...home, headHome: reason };
  }

  if (hostiles.length > 0 && health === null) {
    // A pirate is here and we cannot see the shield bar. That is exactly the
    // "cannot tell what is happening" case: say so and stop.
    return {
      action: {
        kind: "pause",
        reason: "There is a pirate here and your ship's condition could not be read, so the bot stopped rather than guess.",
      },
      why: "A pirate is here and the ship's condition could not be read.",
      rung: "pirate-unknown-health",
      step: null,
    };
  }

  const nearestHostile = hostiles[0] ?? null;
  if (nearestHostile && plan.useDrones && !memory.launchGaveUp) {
    const shipID = status.shipID ?? snapshot?.shipID ?? null;
    // "Already defended" means drones this ship COMMANDS, not merely ones we own.
    // ⚠ R48 LIVE FINDING: `isMyDrone` (owner OR controller) counted an abandoned
    // `Ice Harvesting Drone II` (controllerID null) drifting off Perimeter II as
    // defence, so a pirate on grid got no drones while ten combat drones sat in
    // the bay. A drone the ship cannot order (R33) defends nothing — so the guard
    // reads the CONTROL predicate, and an owned-but-abandoned drone no longer
    // suppresses the launch.
    const mine = (snapshot?.entities ?? []).filter(
      (entity) => canMyShipOrderDrone(entity, shipID) === true,
    );
    if (mine.length === 0) {
      const bay = observation.droneBayItemIDs;
      if (bay === null) {
        return {
          action: { kind: "wait", reason: "reading drone bay" },
          why: `${nearestHostile.name ?? "A pirate"} is here — looking in the drone bay.`,
          rung: "reading-drone-bay",
          step: null,
        };
      }
      if (bay.length > 0) {
        return {
          action: { kind: "launch", droneItemIDs: bay },
          why: `${nearestHostile.name ?? "A pirate"} is here, so the drones go out — they defend the ship on their own.`,
          rung: "launch-drones",
          step: null,
        };
      }
      // No drones to send. Not an error and not a reason to stop: the health
      // floor above is still armed and is the real protection.
    }
  }

  // ── 2/4. The hold ─────────────────────────────────────────────────────────
  if (memory.headingHome) {
    return travelDecision(
      plan.stationID,
      plan.stationName,
      STATION_DOCKING_RADIUS_M,
      "dock",
      observation,
      memory,
      memory.headingHome,
      "heading-home",
    );
  }

  const hold = destinationHold(holds);
  const full = holdShouldHaul(hold);
  if (full === true) {
    return travelDecision(
      plan.stationID,
      plan.stationName,
      STATION_DOCKING_RADIUS_M,
      "dock",
      observation,
      memory,
      // R9a — say what actually happened. The bot leaves on a FRACTION now, so
      // announcing a full hold would be a small lie the player can see through
      // by opening the cargo bay.
      `The ${hold?.label.toLowerCase() ?? "hold"} is ${Math.round(HAUL_AT_FRACTION * 100)}% full, so the load is going to ${plan.stationName ?? "the station"}.`,
      "hold-full",
    );
  }
  // The lasers have run for minutes on a rock that still has ore and not one
  // unit has arrived. We cannot tell why, so we do not pretend to: if there is
  // ore aboard, take it home; if there is not, stop and say so.
  if (memory.noYieldCycles > MAX_NO_YIELD_CYCLES) {
    const aboard = holdUnits(holds) ?? 0;
    if (aboard > 0) {
      const reason = "The mining equipment has been running for minutes without the hold growing, so the bot is taking what it has back to the station.";
      return {
        ...travelDecision(plan.stationID, plan.stationName, STATION_DOCKING_RADIUS_M, "dock", observation, memory, reason, "no-yield-haul"),
        headHome: reason,
      };
    }
    return {
      action: {
        kind: "pause",
        reason: "Your mining equipment says it is running but nothing is arriving in the hold, so the bot stopped rather than claim it is mining.",
      },
      why: "The equipment is running and the hold is not growing.",
      rung: "no-yield-stop",
      step: null,
    };
  }

  // ── The rock ──────────────────────────────────────────────────────────────
  //
  // GetTargets is the ONLY authority on what is locked. Without it, nothing
  // that depends on a lock may be decided at all.
  if (lockedTargetIDs === null) {
    return {
      action: { kind: "wait", reason: "reading targets" },
      why: "Checking what your ship has locked.",
      rung: "reading-targets",
      step: null,
    };
  }

  const byID = new Map<number, SpaceEntity>();
  for (const entity of snapshot?.entities ?? []) {
    byID.set(entity.itemID, entity);
  }

  // ── 5. The rock we are on: is it still on the grid? ───────────────────────
  //
  // The ONLY reason the bot lets a rock go. It does not decide a rock is empty —
  // the server removes a mined-out rock, and this is that removal seen reactively
  // (R49). A rock the snapshot still shows is mined; its ore count is never read.
  const currentRock = memory.currentRockID;
  if (currentRock !== null) {
    const entity = byID.get(currentRock) ?? null;
    if (!entity) {
      return {
        action: { kind: "wait", reason: "rock gone" },
        why: "That rock is no longer in view, so the bot is picking another.",
        dropRock: OUT_OF_VIEW,
        rung: "rock-out-of-view",
        step: null,
      };
    }

    // ── 6. Locked: run the equipment ────────────────────────────────────────
    //
    // R46 — this call site names ITSELF as the rung. Before R46 it passed no
    // rung at all and simply reported the equipment leaf, so "the bot is on the
    // rock it remembered" was invisible on every mining tick: the readout showed
    // the equipment step with nothing saying which branch had reached it, and
    // there was no row for this branch in the ladder to light.
    if (lockedTargetIDs.includes(currentRock)) {
      return runTheLasers(entity, snapshot, plan, "rock-is-locked");
    }

    // ── 5. Ours, but not locked yet: lock it ────────────────────────────────
    return {
      action: {
        kind: "lock",
        targetID: currentRock,
        label: `Lock ${rowLabel(entity)}`,
      },
      why: `Locking ${rowLabel(entity)} — your equipment acts on what you lock.`,
      rung: "lock-current-rock",
      step: null,
    };
  }

  // ── 6. Pick a rock ────────────────────────────────────────────────────────
  //
  // The nearest rock that IS a rock (`isMineableRock`) and has not refused to
  // lock. No ore-count filter: a rock the server still shows is mineable, and
  // one that is truly empty is gone from `entities` because the server took it.
  const candidates = (snapshot?.entities ?? [])
    .filter(
      (entity) =>
        isMineableRock(entity) && !memory.lockRefusedRockIDs.has(entity.itemID),
    )
    .map((entity) => ({
      entity,
      distance: measurement?.distances.get(entity.itemID) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.distance - right.distance);

  if (candidates.length === 0) {
    // ── 7. Nothing to mine. Are we even there yet? ──────────────────────────
    return travelDecision(
      plan.beltID,
      plan.beltName,
      BELT_ARRIVAL_RADIUS_M,
      "belt",
      observation,
      memory,
      `Heading for ${plan.beltName ?? "the belt"}.`,
      "travel-to-belt",
    );
  }

  const pick = candidates[0];
  if (!pick) {
    return {
      action: { kind: "wait", reason: "no rock" },
      why: "Looking for a rock to mine.",
      rung: "no-rock",
      step: null,
    };
  }
  const where = Number.isFinite(pick.distance) ? `, ${formatDistance(pick.distance)} away` : "";

  // ALREADY LOCKED? Then adopt it rather than asking for a lock the ship has.
  // The authority says the ball is held — most often because the player locked
  // it themselves before pressing Start — and re-issuing AddTarget for it would
  // spend a whole tick to change nothing. Adopting is a pure memory change, so
  // it costs no tick at all: the same decision goes straight to the lasers.
  //
  // ⚠ R44 THOUGHT THIS RUNG HAD TO LOSE SOMETHING. IT DID NOT — IT LIED.
  //
  // This tick does TWO things (it goes on to the equipment AND adopts the rock)
  // and it BORROWS its action from the equipment sub-ladder below. R44 made that
  // a choice between naming the shortcut and naming the move, and chose the
  // shortcut — so the equipment rows stayed dark on a tick that ran the
  // equipment.
  //
  // THAT WAS NOT A LOSS OF DETAIL, IT WAS A FALSE STATEMENT. The row reads
  // "…skip the lock and go straight to the equipment", and when the ship does
  // not report its active modules the sub-ladder switches NOTHING on — so the
  // one lit row asserted an action the bot had not taken. R46 reports the caller
  // AND the leaf, so the shortcut and what it actually did are both on screen
  // and neither has to be given up for the other.
  if (lockedTargetIDs.includes(pick.entity.itemID)) {
    return {
      ...runTheLasers(pick.entity, snapshot, plan, "rock-already-locked"),
      takeRock: pick.entity.itemID,
    };
  }

  return {
    action: {
      kind: "lock",
      targetID: pick.entity.itemID,
      label: `Lock ${rowLabel(pick.entity)}`,
    },
    why: `${rowLabel(pick.entity)} is the nearest rock${where}, so the bot is locking it.`,
    takeRock: pick.entity.itemID,
    rung: "lock-nearest-rock",
    step: null,
  };
}

/**
 * RUNG 6 — the rock is locked, so put the equipment on it.
 *
 * One module per tick (at most one atomic call), chosen against
 * `activeModuleIDs`: the SERVER's own answer to what is cycling, never what the
 * loop remembers switching on. A NULL there is "we could not tell", and this
 * never treats that as "off" — switching a laser on twice because the ship
 * would not say is exactly the fabricated progress the loop refuses to make.
 */
function runTheLasers(
  entity: SpaceEntity,
  snapshot: SpaceSnapshot | null,
  plan: MiningPlan,
  /**
   * R46 — the rung that CALLED this sub-ladder, reported alongside whichever
   * leaf answers. It used to be an OVERRIDE that replaced the leaf, and that is
   * what let the readout state something the bot had not done: see the adopt
   * shortcut's comment above. A caller and a leaf are two different facts and
   * they now travel in two different fields.
   */
  rung: MiningCallerRungID,
): MiningDecision {
  const active = snapshot?.ship?.activeModuleIDs ?? null;
  if (active === null) {
    return {
      action: { kind: "wait", reason: "unknown module state" },
      why: "Your ship did not say which equipment is running, so nothing was switched on this time.",
      rung,
      step: "equipment-unknown",
    };
  }
  const nextModule = plan.miningModuleIDs.filter((moduleID) => !active.includes(moduleID))[0];
  if (nextModule !== undefined) {
    return {
      action: {
        kind: "activate",
        moduleID: nextModule,
        targetID: entity.itemID,
        label: `Switch the mining equipment on ${rowLabel(entity)}`,
      },
      why: `${rowLabel(entity)} is locked, so the mining equipment goes on.`,
      rung,
      step: "equipment-on",
    };
  }
  return {
    action: { kind: "wait", reason: "mining" },
    // No "units left" — the bot no longer tracks a depletion count, so it does
    // not put one on screen. The server owns depletion and removes the rock (R49).
    why: `Mining ${rowLabel(entity)}.`,
    rung,
    // ⚠ THE STALL CLOCK READS THIS. `noYieldCycles` is incremented on exactly
    // the ticks that reach this return; see the controller's comment.
    step: "mining-running",
  };
}

/**
 * Close on something and then do the thing — the autopilot's own three rungs
 * (`decideCloseIn`), with the arrival step supplied by the caller.
 *
 * `arrival: "dock"` is R24 slice B's Dock, including its 2,500 m SURFACE gate;
 * `arrival: "belt"` arrives by simply being there, and then reports that the
 * belt has nothing left — which is rung 8, and the reason it does not wander.
 */
function travelDecision(
  targetID: number,
  targetName: string | null,
  interactionRadiusM: number,
  arrival: "dock" | "belt",
  observation: MiningObservation,
  memory: MiningDecisionMemory,
  why: string,
  /**
   * R44 — the CALLER's rung, reported for every step of this sub-ladder.
   *
   * ⚠ THIS IS WHERE THE ROW MODEL RAN OUT, AND IT STILL HAS. These four steps
   * are reached from FIVE different rungs, so they are not rows of their own:
   * rendering them as rows would take a caller × step cross-product for code
   * written once. They report `step: null` and what this sub-ladder chose shows
   * in the action and the why instead — which the `travel-to-belt` row says
   * about itself on screen, so the omission is disclosed rather than hidden.
   *
   * The ONE exception is the belt arrival below, which the ladder's own doc
   * comment already calls a rung in its own right — and it is, because arriving
   * at an empty belt is a different rule from travelling to it. R46 reports it
   * as this caller's STEP. It used to overwrite the caller's rung on the way
   * out, which hid which of the five callers had got there.
   */
  rung: MiningCallerRungID,
): MiningDecision {
  const name = targetName ?? (arrival === "dock" ? "the station" : "the belt");
  // ⚠ NOT `step` — that is now a field on every decision this function builds,
  // and a shorthand `step` in one of the object literals below would silently
  // report this local instead of the leaf id.
  const closeIn = decideCloseIn(
    targetID,
    interactionRadiusM,
    observation.measurement,
    memory.approachingTargetID,
  );

  // Not measurable this tick — the belt or station is not on the snapshot's
  // grid, which is the normal case for somewhere you have not flown to yet.
  // Warp is the right call and the warp bound catches one that never starts.
  if (closeIn === null) {
    return {
      action: { kind: "warp", destinationID: targetID, label: `Warp to ${name}` },
      why,
      rung,
      step: null,
    };
  }

  switch (closeIn.kind) {
    case "warp":
      return {
        action: { kind: "warp", destinationID: targetID, label: `Warp to ${name}` },
        why,
        rung,
        step: null,
      };
    case "approach":
      return {
        action: { kind: "approach", destinationID: targetID, label: `Approach ${name}` },
        why,
        rung,
        step: null,
      };
    case "closing":
      return {
        action: { kind: "wait", reason: "closing in" },
        why: `Closing in on ${name}.`,
        rung,
        step: null,
      };
    case "arrive":
      if (arrival === "dock") {
        return {
          action: { kind: "dock", stationID: targetID, label: `Dock at ${name}` },
          why,
          rung,
          step: null,
        };
      }
      // ── 8. At the belt with nothing left to mine. Stop; do not wander. ────
      return {
        action: {
          kind: "pause",
          reason: `There are no rocks left to mine at ${name}. Pick another belt and start the bot again.`,
        },
        why: `${name} has nothing left to mine.`,
        rung,
        step: "belt-empty",
      };
  }
}

// --- The controller ----------------------------------------------------------

/** Everything the loop needs from the outside — all injectable for tests. */
export interface MiningBotDeps {
  getStatus(): Promise<FlightStatus>;
  getSpaceSnapshot(): Promise<SpaceSnapshot | null>;
  /** dogmaIM.GetTargets. Return null when the read failed — never []. */
  getLockedTargetIDs(): Promise<readonly number[] | null>;
  /** The ship's mining holds. Return null when the read failed — never []. */
  getHolds(): Promise<readonly MiningHold[] | null>;
  /** The drone bay's stacks. Only read when a launch is being considered. */
  getDroneBayItemIDs(): Promise<readonly number[] | null>;
  undock(): Promise<void>;
  warp(destinationID: number): Promise<void>;
  approach(destinationID: number): Promise<void>;
  dock(stationID: number): Promise<void>;
  lockTarget(targetID: number): Promise<void>;
  activateModule(moduleID: number, targetID: number): Promise<void>;
  launchDrones(itemIDs: readonly number[]): Promise<void>;
  unloadHolds(itemIDs: readonly number[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  onProgress(progress: MiningBotProgress): void;
  isSessionLost(error: unknown): boolean;
  refusalReason(error: unknown): string;
}

export interface MiningBotController {
  start(plan: MiningPlan): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** One decision cycle: read, decide, issue at most one atomic call. */
  tick(): Promise<MiningBotAction>;
  /** Drive until the loop leaves the running state (production driver). */
  run(): Promise<void>;
  snapshot(): MiningBotProgress;
}

interface BotMemory {
  status: MiningBotStatus;
  phase: string | null;
  action: string | null;
  why: string | null;
  /** R44 — the last rung the LADDER fired. Read-only instrumentation. */
  rung: MiningRungID | null;
  /** R46 — the leaf that rung called, if it called one. Instrumentation only. */
  step: MiningStepID | null;
  rockName: string | null;
  failureReason: string | null;
  settleTicks: number;
  currentRockID: number | null;
  /** Rocks the ship refused to lock — an observed refusal, never an ore count. */
  lockRefusedRockIDs: Set<number>;
  approachingTargetID: number | null;
  headingHome: string | null;
  launchGaveUp: boolean;
  noYieldCycles: number;
  // Every one of these counts CONSECUTIVE decisions of one kind whose authority
  // has not changed. A landed action resets its own counter by construction,
  // because the decision stops choosing it.
  lockTargetID: number | null;
  lockAttempts: number;
  consecutiveLockFailures: number;
  activateModuleID: number | null;
  activateAttempts: number;
  launchAttempts: number;
  unloadAttempts: number;
  undockAttempts: number;
  warpTargetID: number | null;
  warpAttempts: number;
  silentDockAttempts: number;
  closeInCycles: number;
  statusReadFailures: number;
  cyclesCompleted: number;
  /**
   * An unload was issued and the hold has not yet CONFIRMED empty. The haul is
   * counted when it does — on the unload's own read-back when that lands, or
   * on any later docked tick's observation when it raced the transfer settling
   * or dropped. Immediate-read-only counting silently lost those hauls.
   */
  haulPending: boolean;
  oreUnitsMined: number;
  lastHoldUnits: number | null;
  holdUsed: number | null;
  holdCapacity: number | null;
}

function freshMemory(): BotMemory {
  return {
    status: "idle",
    phase: null,
    action: null,
    why: null,
    rung: null,
    step: null,
    rockName: null,
    failureReason: null,
    settleTicks: 0,
    currentRockID: null,
    lockRefusedRockIDs: new Set<number>(),
    approachingTargetID: null,
    headingHome: null,
    launchGaveUp: false,
    noYieldCycles: 0,
    lockTargetID: null,
    lockAttempts: 0,
    consecutiveLockFailures: 0,
    activateModuleID: null,
    activateAttempts: 0,
    launchAttempts: 0,
    unloadAttempts: 0,
    undockAttempts: 0,
    warpTargetID: null,
    warpAttempts: 0,
    silentDockAttempts: 0,
    closeInCycles: 0,
    statusReadFailures: 0,
    cyclesCompleted: 0,
    haulPending: false,
    oreUnitsMined: 0,
    lastHoldUnits: null,
    holdUsed: null,
    holdCapacity: null,
  };
}

/**
 * The phase label, decided from WHERE the move is aimed rather than from the
 * heading-home flag.
 *
 * ⚠ FROM THE LIVE RUN: a full hold sets no flag — it does not need one, the hold
 * says it every tick — so keying the label off `headingHome` had the readout
 * announce "Flying to the belt" while the ship warped to the station with a full
 * load. The reason line was right and the phase contradicted it, which is worse
 * than no phase at all in a panel whose whole job is being interrogable.
 */
function phaseFor(action: MiningBotAction, plan: MiningPlan): string {
  switch (action.kind) {
    case "undock":
      return "Leaving the station";
    case "warp":
      return action.destinationID === plan.stationID ? "Hauling" : "Flying to the belt";
    case "approach":
      return action.destinationID === plan.stationID ? "Hauling" : "Flying to the belt";
    case "dock":
      return "Docking";
    case "unload":
      return "Unloading";
    case "lock":
      return "Locking a rock";
    case "activate":
      return "Starting the equipment";
    case "launch":
      return "Defending";
    case "pause":
      return "Stopped";
    case "stopped":
      return "Stopped";
    case "wait":
      return action.reason === "mining" ? "Mining" : "Working";
  }
}

function actionText(action: MiningBotAction): string {
  switch (action.kind) {
    case "undock":
      return "Undocking";
    case "warp":
    case "approach":
    case "dock":
    case "lock":
    case "activate":
      return action.label;
    case "unload":
      return `Unloading ${action.itemIDs.length} ${action.itemIDs.length === 1 ? "stack" : "stacks"}`;
    case "launch":
      return "Launching drones";
    case "wait":
      return "Working";
    case "pause":
      return "Stopped";
    case "stopped":
      return "Stopped";
  }
}

export function createMiningBot(deps: MiningBotDeps): MiningBotController {
  let memory = freshMemory();
  let plan: MiningPlan | null = null;
  // Bumped on pause/stop/start so a stale in-flight run() loop stops driving.
  let runToken = 0;

  function snapshot(): MiningBotProgress {
    return {
      status: memory.status,
      phase: memory.phase,
      action: memory.action,
      why: memory.why,
      rung: memory.rung,
      step: memory.step,
      rockName: memory.rockName,
      cyclesCompleted: memory.cyclesCompleted,
      oreUnitsMined: memory.oreUnitsMined,
      holdUsed: memory.holdUsed,
      holdCapacity: memory.holdCapacity,
      failureReason: memory.failureReason,
    };
  }

  function emit(): void {
    deps.onProgress(snapshot());
  }

  function setPause(reason: string): void {
    memory.status = "paused";
    memory.failureReason = reason;
    memory.phase = "Stopped";
    memory.action = null;
    memory.why = reason;
    runToken += 1;
  }

  function setError(reason: string): void {
    memory.status = "error";
    memory.failureReason = reason;
    memory.phase = "Stopped";
    memory.action = null;
    memory.why = reason;
    runToken += 1;
  }

  /**
   * Let go of the rock we were on and take the next one.
   *
   * `blacklist` is the difference between a rock the ship DEMONSTRABLY WILL NOT
   * LOCK (asked, refused, past the lock bound) and one that has merely left the
   * grid. Only the refusal blacklists — an OBSERVED fact, never a predicted ore
   * count. A rock is off the grid for the whole haul home, so blacklisting "not
   * here" would empty a belt the ship has not finished, which is a bug this loop
   * had. Depletion is the server's (R49): it removes a mined-out rock, and the
   * bot picks whatever is still on field — so out of view is just out of view.
   */
  function dropRock(blacklist: boolean): void {
    if (blacklist && memory.currentRockID !== null) {
      memory.lockRefusedRockIDs.add(memory.currentRockID);
    }
    memory.currentRockID = null;
    memory.rockName = null;
    memory.lockTargetID = null;
    memory.lockAttempts = 0;
    memory.activateModuleID = null;
    memory.activateAttempts = 0;
    memory.noYieldCycles = 0;
  }

  /**
   * The hold confirmed the ore left after an unload: the haul is real. One
   * counting path, whichever read confirmed it first — the unload's own
   * read-back or a later docked tick's observation.
   */
  function completeHaul(): void {
    memory.cyclesCompleted += 1;
    memory.haulPending = false;
    memory.lastHoldUnits = 0;
    // A completed haul is real progress, so rocks that would not lock get a
    // fresh chance on the next trip — the belt may have changed, and this
    // blacklist keys on a refusal, not a permanent fact about the rock.
    memory.lockRefusedRockIDs.clear();
    memory.consecutiveLockFailures = 0;
  }

  /**
   * ORE, counted from the authority. The hold growing is the only evidence this
   * loop accepts that mining happened — never a cycle count, never a yield sum,
   * never a module that answered 200.
   */
  function countOre(holds: readonly MiningHold[] | null): void {
    const hold = destinationHold(holds);
    memory.holdUsed = hold?.capacity?.used ?? null;
    memory.holdCapacity = hold?.capacity?.capacity ?? null;

    // A PARTIAL read is not a total. When one hold's items failed while
    // another's landed, the sum is missing a hold — and adopting that dip as
    // the new baseline made the missing ore read as FRESHLY MINED when the
    // next full read brought it back. A tick that could not read every
    // present hold counts nothing and moves no baseline.
    if (holds !== null && holds.some((entry) => entry.present && entry.items === null)) {
      return;
    }

    const units = holdUnits(holds);
    if (units === null) {
      return;
    }
    if (memory.lastHoldUnits !== null && units > memory.lastHoldUnits) {
      memory.oreUnitsMined += units - memory.lastHoldUnits;
      // Ore arrived, so the lasers are producing: the stall clock restarts.
      memory.noYieldCycles = 0;
    }
    memory.lastHoldUnits = units;
  }

  /** Read what this tick needs. Each read is independent and may fail alone. */
  async function observe(status: FlightStatus, current: MiningPlan): Promise<MiningObservation> {
    if (status.docked) {
      // Docked, nothing in space to read: the hold is the whole world.
      return {
        status,
        snapshot: null,
        measurement: null,
        lockedTargetIDs: null,
        holds: await safely(() => deps.getHolds()),
        droneBayItemIDs: null,
      };
    }
    const [space, locked, holds] = await Promise.all([
      safely(() => deps.getSpaceSnapshot()),
      safely(() => deps.getLockedTargetIDs()),
      safely(() => deps.getHolds()),
    ]);
    // The bay is only read when a launch is actually on the table — it is a
    // real call, and polling it every tick for a belt with no pirates in it
    // would be load for nothing.
    let bay: readonly number[] | null = null;
    if (current.useDrones && !memory.launchGaveUp && space) {
      const origin = space.ship?.position ?? { x: 0, y: 0, z: 0 };
      const shipID = status.shipID ?? space.shipID ?? null;
      // Same control test as the launch rung (R48): only drones this ship
      // COMMANDS count as "already out", so an abandoned owned drone does not
      // stop the bay being read when a pirate is here.
      const mine = space.entities.filter(
        (entity) => canMyShipOrderDrone(entity, shipID) === true,
      );
      if (hostileRows(space, origin).length > 0 && mine.length === 0) {
        bay = await safely(() => deps.getDroneBayItemIDs());
      }
    }
    return {
      status,
      snapshot: space,
      measurement: measureSpace(space),
      lockedTargetIDs: locked,
      holds,
      droneBayItemIDs: bay,
    };
  }

  /**
   * A read that failed is a read that failed — null, never a confident empty.
   * A LOST SESSION is different and is allowed to propagate: the run is over.
   */
  async function safely<T>(read: () => Promise<T | null>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      if (deps.isSessionLost(error)) {
        throw error;
      }
      return null;
    }
  }

  /**
   * BOUND THE BRANCH. Each counter tracks consecutive decisions of one kind
   * whose authority still says the thing has not happened. Anything else resets
   * it. Returns false when the bound is spent and the loop has already stopped
   * or moved on.
   */
  function bound(action: MiningBotAction): boolean {
    // Lock — bounded per ROCK. Spending it gives up on the rock, not the run,
    // unless nothing at all will lock (MAX_CONSECUTIVE_LOCK_FAILURES).
    if (action.kind === "lock") {
      if (memory.lockTargetID === action.targetID) {
        memory.lockAttempts += 1;
      } else {
        memory.lockTargetID = action.targetID;
        memory.lockAttempts = 1;
      }
      if (memory.lockAttempts > MAX_LOCK_ATTEMPTS) {
        memory.consecutiveLockFailures += 1;
        const name = memory.rockName ?? "that rock";
        if (memory.consecutiveLockFailures >= MAX_CONSECUTIVE_LOCK_FAILURES) {
          setPause(
            `Your ship would not lock anything here after trying ${MAX_CONSECUTIVE_LOCK_FAILURES} rocks, so the bot stopped.`,
          );
          return false;
        }
        memory.why = `${name} would not lock, so the bot is trying a different rock.`;
        // Blacklist THIS rock: the ship has been asked to lock it and refuses —
        // an observed refusal, so the picker steps past it to a different rock
        // rather than retrying the same nearest one forever.
        dropRock(true);
        return false;
      }
    } else if (action.kind !== "wait") {
      memory.lockTargetID = null;
      memory.lockAttempts = 0;
    }

    // Activate — bounded per MODULE. Spending it PAUSES: a laser the ship keeps
    // reporting as off after three tries is the "we cannot tell what happened"
    // case, and this loop says so rather than carrying on as if it were mining.
    if (action.kind === "activate") {
      if (memory.activateModuleID === action.moduleID) {
        memory.activateAttempts += 1;
      } else {
        memory.activateModuleID = action.moduleID;
        memory.activateAttempts = 1;
      }
      if (memory.activateAttempts > MAX_ACTIVATE_ATTEMPTS) {
        setPause(
          "Your mining equipment was switched on three times and your ship still reports it as off, so the bot stopped rather than pretend it is mining.",
        );
        return false;
      }
    } else if (action.kind !== "wait") {
      memory.activateModuleID = null;
      memory.activateAttempts = 0;
    }

    // Launch — bounded, and spending it HEADS HOME rather than pausing. A ship
    // that cannot get its drones out next to a pirate should leave, not sit.
    if (action.kind === "launch") {
      memory.launchAttempts += 1;
      if (memory.launchAttempts > MAX_LAUNCH_ATTEMPTS) {
        memory.launchGaveUp = true;
        memory.headingHome =
          "Your drones would not launch and there is a pirate here, so the bot is heading back to the station.";
        memory.why = memory.headingHome;
        return false;
      }
    } else if (action.kind !== "wait") {
      memory.launchAttempts = 0;
    }

    // Unload — bounded. The hold still holding the ore after three tries is a
    // stop: the alternative is undocking with a full hold, over and over.
    if (action.kind === "unload") {
      memory.unloadAttempts += 1;
      if (memory.unloadAttempts > MAX_UNLOAD_ATTEMPTS) {
        setPause("The ore would not move into the hangar, so the bot stopped with it still aboard.");
        return false;
      }
    } else if (action.kind !== "wait") {
      memory.unloadAttempts = 0;
    }

    // Undock — bounded, against flight status still saying docked.
    if (action.kind === "undock") {
      memory.undockAttempts += 1;
      if (memory.undockAttempts > MAX_UNDOCK_ATTEMPTS) {
        setPause("The ship would not undock, so the bot stopped.");
        return false;
      }
    } else if (action.kind !== "wait") {
      memory.undockAttempts = 0;
    }

    // Warp — R24 slice A's bound, unchanged: this server answers 200 to a warp
    // it silently refuses, so a warp that changes nothing must not repeat.
    if (action.kind === "warp") {
      if (memory.warpTargetID === action.destinationID) {
        memory.warpAttempts += 1;
      } else {
        memory.warpTargetID = action.destinationID;
        memory.warpAttempts = 1;
      }
      if (memory.warpAttempts > MAX_WARP_ATTEMPTS) {
        setPause("The warp did not start and the ship has not moved, so the bot stopped.");
        return false;
      }
    } else if (action.kind !== "wait") {
      memory.warpTargetID = null;
      memory.warpAttempts = 0;
    }

    // Dock — R24 slice B's bound, unchanged: `Handle_CmdDock` can answer 200
    // and seat nobody, and docked-ness is read back out of FLIGHT STATUS.
    if (action.kind === "dock") {
      memory.silentDockAttempts += 1;
      if (memory.silentDockAttempts > MAX_SILENT_DOCK_ATTEMPTS) {
        setPause("The station accepted the request but has not taken the ship, so the bot stopped.");
        return false;
      }
    } else if (action.kind !== "wait") {
      memory.silentDockAttempts = 0;
    }

    // A running approach is waited on, not restarted — and the wait is bounded,
    // so a ship that can never close still stops rather than waiting forever.
    if (action.kind === "wait" && action.reason === "closing in") {
      memory.closeInCycles += 1;
      if (memory.closeInCycles > MAX_CLOSE_IN_CYCLES) {
        setPause("The ship is not getting any closer, so the bot stopped.");
        return false;
      }
    } else if (action.kind !== "wait") {
      memory.closeInCycles = 0;
    }

    return true;
  }

  /** Issue AT MOST ONE atomic call and record what it means for memory. */
  async function issue(action: MiningBotAction): Promise<void> {
    if (memory.status !== "running") {
      return;
    }
    try {
      switch (action.kind) {
        case "undock":
          await deps.undock();
          // Ready-returning BFF: authoritative undocked scene/ship is visible.
          memory.settleTicks = 0;
          return;
        case "warp":
          await deps.warp(action.destinationID);
          memory.approachingTargetID = null;
          memory.settleTicks = SETTLE_WARP;
          return;
        case "approach":
          await deps.approach(action.destinationID);
          memory.approachingTargetID = action.destinationID;
          memory.closeInCycles = 0;
          memory.settleTicks = SETTLE_APPROACH;
          return;
        case "dock":
          await deps.dock(action.stationID);
          memory.approachingTargetID = null;
          // Ready-returning BFF: authoritative docked location is visible.
          memory.settleTicks = 0;
          return;
        case "unload":
          await deps.unloadHolds(action.itemIDs);
          memory.settleTicks = SETTLE_UNLOAD;
          return;
        case "lock":
          await deps.lockTarget(action.targetID);
          memory.settleTicks = SETTLE_LOCK;
          return;
        case "activate":
          await deps.activateModule(action.moduleID, action.targetID);
          memory.settleTicks = SETTLE_ACTIVATE;
          return;
        case "launch":
          await deps.launchDrones(action.droneItemIDs);
          memory.settleTicks = SETTLE_LAUNCH;
          return;
        default:
          return;
      }
    } catch (error) {
      await handleActionError(action, error);
    }
  }

  /** True when a refusal is the server saying "you are too far away". */
  function isRangeRefusal(reason: string): boolean {
    return /range|too far|not close|distance|closer/i.test(reason);
  }

  async function handleActionError(action: MiningBotAction, error: unknown): Promise<void> {
    if (deps.isSessionLost(error)) {
      setError("The live session ended (idle timeout or another client took over).");
      return;
    }
    // ⚠ TWO STRINGS, AND THEY ARE NOT INTERCHANGEABLE (R31). `reason` is the
    // server's RAW text, which every classification below reads — isRangeRefusal()
    // decides whether to close in and retry rather than stop, and the undock /
    // dock / warp guards match on the handler's own wording. Those regexes are
    // written against the SERVER's vocabulary, so classifying on translated
    // prose would silently turn a recoverable refusal into a dead bot. `words`
    // is the same refusal in player language, and is the only one that may be
    // shown — `failureReason` renders in the cockpit strip, where R9a applies.
    const reason = deps.refusalReason(error);
    const words = refusalWords(reason);

    if (action.kind === "undock" && /already in space|already_in_space/i.test(reason)) {
      // Benign: we wanted to be in space and we are.
      memory.settleTicks = 0;
      return;
    }

    // THE SERVER OWNS THE RULES. A lock or a laser refused for RANGE is the
    // server telling us to close in — which is a real answer, not a failure, so
    // we close in and try again rather than reimplementing a range check the
    // server already has. Bounded by the close-in cycle counter.
    if ((action.kind === "lock" || action.kind === "activate") && isRangeRefusal(reason)) {
      memory.why = `${memory.rockName ?? "That rock"} is out of range, so the ship is closing in.`;
      memory.closeInCycles += 1;
      if (memory.closeInCycles > MAX_CLOSE_IN_CYCLES) {
        setPause("The ship could not get close enough to mine, so the bot stopped.");
        return;
      }
      memory.approachingTargetID = action.targetID;
      await issueApproach(action.targetID);
      return;
    }

    if (action.kind === "dock") {
      // The server REFUSED and said why, so this is not the silent-decline
      // case; it is R24's DockingApproach and the loop re-issues.
      if (isRangeRefusal(reason) || /dockingapproach|docking approach|approach/i.test(reason)) {
        memory.silentDockAttempts = 0;
        memory.settleTicks = SETTLE_DOCK_REFUSAL;
        return;
      }
      setPause(`The station refused to take the ship: ${words}`);
      return;
    }

    if (action.kind === "warp" && /already within warp|within warp distance|too close to warp/i.test(reason)) {
      memory.settleTicks = SETTLE_APPROACH;
      return;
    }

    // Anything else: do not guess. Stop and show the server's own words.
    setPause(`${actionText(action)} was refused: ${words}`);
  }

  /** The one place an approach is issued outside the ladder (a range refusal). */
  async function issueApproach(targetID: number): Promise<void> {
    if (memory.status !== "running") {
      return;
    }
    try {
      await deps.approach(targetID);
      memory.settleTicks = SETTLE_APPROACH;
    } catch (error) {
      if (deps.isSessionLost(error)) {
        setError("The live session ended (idle timeout or another client took over).");
        return;
      }
      setPause(`The ship could not close in: ${refusalWords(deps.refusalReason(error))}`);
    }
  }

  async function tick(): Promise<MiningBotAction> {
    if (memory.status !== "running" || !plan) {
      return memory.status === "stopped"
        ? { kind: "stopped" }
        : { kind: "wait", reason: memory.failureReason ?? "not running" };
    }
    const current = plan;

    let status: FlightStatus;
    try {
      status = await deps.getStatus();
      memory.statusReadFailures = 0;
    } catch (error) {
      if (deps.isSessionLost(error)) {
        setError("The live session ended (idle timeout or another client took over).");
        emit();
        return { kind: "pause", reason: memory.failureReason ?? "session lost" };
      }
      memory.statusReadFailures += 1;
      if (memory.statusReadFailures > MAX_READ_FAILURES) {
        setPause(
          `Your ship's status could not be read after ${memory.statusReadFailures} tries, so the bot stopped: ${refusalWords(deps.refusalReason(error))}`,
        );
        emit();
        return { kind: "pause", reason: memory.failureReason ?? "status read failed" };
      }
      memory.phase = "Reconnecting";
      memory.why = "Waiting for your ship to answer.";
      // R44 — the ladder was never reached, so NO rung fired. Saying so is the
      // point: a readout that kept the last rung lit would claim a rule ran on
      // a tick where the loop never got as far as asking one.
      memory.rung = null;
      memory.step = null;
      emit();
      return { kind: "wait", reason: "status read retry" };
    }

    if (memory.status !== "running") {
      emit();
      return { kind: memory.status === "stopped" ? "stopped" : "wait", reason: "stopped" };
    }

    // Settle asynchronous movement/writes and recoverable refusals. Successful
    // BFF undock/dock returns are already authoritative and skip this window.
    if (memory.settleTicks > 0) {
      memory.settleTicks -= 1;
      memory.phase = "Working";
      memory.action = "Waiting for the last move to take effect";
      // R44 — a settle window is the CONTROLLER's, not the ladder's. No rung.
      memory.rung = null;
      memory.step = null;
      emit();
      return { kind: "wait", reason: "settling" };
    }

    let observation: MiningObservation;
    try {
      observation = await observe(status, current);
    } catch (error) {
      if (deps.isSessionLost(error)) {
        setError("The live session ended (idle timeout or another client took over).");
        emit();
        return { kind: "pause", reason: memory.failureReason ?? "session lost" };
      }
      emit();
      return { kind: "wait", reason: "read failed" };
    }
    if (memory.status !== "running") {
      emit();
      return { kind: memory.status === "stopped" ? "stopped" : "wait", reason: "stopped" };
    }

    // Ore is counted from the hold BEFORE the decision, so the readout and the
    // "is it actually producing" clock are both looking at this tick's truth.
    countOre(observation.holds);

    // The haul count's SLOW PATH: the unload's own read-back raced the
    // transfer settling (or dropped), and this tick's docked observation is
    // the authority that finally says the ore left. Without it, exactly those
    // hauls vanished from the readout — counted nowhere, ever.
    if (
      memory.haulPending &&
      observation.status.docked &&
      observation.holds !== null &&
      freightHoldItemIDs(observation.holds).length === 0
    ) {
      completeHaul();
    }

    const decision = decideMiningAction(observation, current, {
      currentRockID: memory.currentRockID,
      lockRefusedRockIDs: memory.lockRefusedRockIDs,
      approachingTargetID: memory.approachingTargetID,
      headingHome: memory.headingHome,
      launchGaveUp: memory.launchGaveUp,
      noYieldCycles: memory.noYieldCycles,
    });

    // Record what the decision discovered.
    if (decision.headHome && !memory.headingHome) {
      memory.headingHome = decision.headHome;
    }
    if (decision.takeRock !== undefined) {
      memory.currentRockID = decision.takeRock;
      memory.rockName =
        observation.snapshot?.entities.find((entity) => entity.itemID === decision.takeRock)?.name ??
        null;
      memory.noYieldCycles = 0;
    }
    if (decision.dropRock) {
      // The only release verb the ladder now sets is OUT_OF_VIEW — a rock that
      // has merely left the grid (the whole haul home, every time). It NEVER
      // blacklists: the ship has not refused it, the server simply took it away.
      // (The lock bound, elsewhere, is the one path that blacklists, on a refusal.)
      dropRock(false);
    }
    // The stall clock only runs while the loop believes it is mining.
    //
    // ⚠ R46 — THIS USED TO MATCH A WAIT REASON STRING (`reason === "mining"`),
    // so the clock behind the two `unexpressible` rungs was driven by which
    // sub-ladder leaf ran, IDENTIFIED BY PROSE. It now keys on the leaf's own
    // id, which is the same set of ticks and not a wider or narrower one:
    //
    //   · `wait "mining"` is built at exactly ONE return in this module — the
    //     third leaf of `runTheLasers` — so no other decision could ever have
    //     satisfied the old condition.
    //   · That same return is the ONLY place `step: "mining-running"` is set,
    //     so nothing satisfies the new condition that did not satisfy the old.
    //
    // The equivalence is both ways because it is one return statement, and a
    // test asserts the pair travels together from BOTH of that sub-ladder's
    // callers. The three reset sites (`dropRock`, `countOre`, and adopting a
    // rock above) are untouched and still zero the same counter.
    if (decision.step === "mining-running") {
      memory.noYieldCycles += 1;
    }

    memory.why = decision.why;
    memory.action = actionText(decision.action);
    memory.phase = phaseFor(decision.action, current);
    // R44 — record which rung answered. Recorded next to `why` because it is the
    // same fact in a different form. R46 — and the leaf it called, so the panel
    // can light the caller and what it actually did at the same time. These two
    // are set TOGETHER, always: a tick that set one and left the other stale is
    // the readout claiming a pairing that never happened.
    memory.rung = decision.rung;
    memory.step = decision.step;

    if (decision.action.kind === "pause") {
      setPause(decision.action.reason);
      emit();
      return decision.action;
    }
    if (decision.action.kind === "wait") {
      if (!bound(decision.action)) {
        emit();
        return { kind: "wait", reason: "bounded" };
      }
      emit();
      return decision.action;
    }

    if (!bound(decision.action)) {
      emit();
      return { kind: "wait", reason: "bounded" };
    }

    emit();
    await issue(decision.action);
    // A haul is only complete once the HOLD says the ore left. The read right
    // here is the FAST PATH and it races the transfer settling — so the
    // pending flag stays up until some read confirms empty, and the docked
    // slow path above counts the haul on a later tick when this one missed.
    if (decision.action.kind === "unload") {
      memory.haulPending = true;
      const after = await safely(() => deps.getHolds()).catch(() => null);
      if (after !== null && freightHoldItemIDs(after).length === 0) {
        completeHaul();
      }
    }
    emit();
    return decision.action;
  }

  async function run(): Promise<void> {
    const token = runToken;
    while (token === runToken && memory.status === "running") {
      await tick();
      if (token !== runToken || memory.status !== "running") {
        break;
      }
      await deps.sleep(MINING_BOT_CADENCE_MS);
    }
  }

  return {
    start(nextPlan: MiningPlan): void {
      plan = nextPlan;
      memory = freshMemory();
      memory.status = "running";
      memory.phase = "Starting";
      memory.why = `Starting at ${nextPlan.beltName ?? "the belt"}, hauling to ${nextPlan.stationName ?? "the station"}.`;
      runToken += 1;
      emit();
    },
    pause(): void {
      if (memory.status === "running") {
        memory.status = "paused";
        memory.phase = "Paused";
        memory.action = null;
        memory.why = "You paused the bot. Your ship keeps doing whatever it was last told to.";
        memory.rung = null;
        memory.step = null;
        runToken += 1;
        emit();
      }
    },
    resume(): void {
      if (memory.status === "paused") {
        memory.status = "running";
        memory.failureReason = null;
        memory.phase = "Resuming";
        memory.why = "Picking up where it left off.";
        runToken += 1;
        emit();
      }
    },
    stop(): void {
      if (memory.status === "running" || memory.status === "paused") {
        memory.status = "stopped";
        memory.phase = "Stopped";
        memory.action = null;
        memory.why = "You stopped the bot. It will not send your ship any more orders.";
        memory.rung = null;
        memory.step = null;
        runToken += 1;
        emit();
      }
    },
    tick,
    run,
    snapshot,
  };
}
