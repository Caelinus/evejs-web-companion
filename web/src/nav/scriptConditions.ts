// A4a — reading the world for a player script: tri-state conditions and which
// interrupt fires. Pure over an observation; the runner (slice B) builds the
// observation from fresh reads each tick and feeds it here.
//
// ⚠ CANNOT-TELL NEVER PASSES, AND THAT IS THE WHOLE POINT. Every check is
// met / not-met / cannot-tell. A read that FAILED is not a read that said "no" —
// so an `until` that cannot be read does not advance the program, and an
// interrupt that cannot be read does not fire (nor is it quietly treated as
// "fine", which is how a dead-man switch rots). Two guards live here:
//
//   • THE ACUTE RULE (sealed, from the hand-written mining bot): a hostile is on
//     the grid AND ship health cannot be read → pause immediately. You do not
//     keep working blind next to a pirate. This only applies when no player
//     interrupt already handled the hostile — if the player chose "launch drones
//     on a pirate", that fires first and defends the ship.

import type { Condition, InterruptRow } from "../bots/botScript.ts";
import type {
  AgentConversation,
  CourierBriefing,
  FlightStatus,
  InventoryItemRow,
  JournalState,
  MiningHold,
  SpaceSnapshot,
} from "../store/types.ts";
import type { CargoReading, TravelReading } from "./missionBotLoop.ts";
import type { SavedFitting } from "../bridge/fittings.ts";
import type { ScannerOperationsSnapshot } from "../scanner/scannerCenter.ts";

// ─── The observation ─────────────────────────────────────────────────────────

/**
 * Everything a condition can test, read FRESH each tick. `null` means UNREADABLE
 * throughout — never a value, never "no". `health` is the lowest of the three
 * ship-health ratios (the mining bot's `lowestHealth`), carried as its own field
 * because `health-below` watches the weakest layer while `shield-below` watches
 * one specific layer.
 */
export interface ScriptObservation {
  readonly inSpace: boolean | null;
  readonly docked: boolean | null;
  readonly inWarp: boolean | null;
  readonly shieldRatio: number | null;
  readonly armorRatio: number | null;
  readonly hullRatio: number | null;
  readonly health: number | null;
  /** Own-ship capacitor, 0..1. Optional: older observations simply cannot tell. */
  readonly capacitorRatio?: number | null;
  /** Own wallet balance in ISK. Optional: read only when a wallet watch is set. */
  readonly walletBalance?: number | null;
  readonly oreHoldFraction: number | null;
  readonly holdEmpty: boolean | null;
  readonly hostileOnGrid: boolean | null;
  /**
   * The ordinary CARGO hold's fill level, 0..1 — NOT the ore hold above. Optional
   * and read only when something watches it, so a mining bot never pays for the
   * inventory read a hauler needs.
   */
  readonly cargoFraction?: number | null;
  /** True when a PLAYER's ship on this grid has locked this ship. */
  readonly targetedByPlayer?: boolean | null;
  /** The lowest health, 0..1, among YOUR drones out in space; null with none out. */
  readonly lowestDroneHealth?: number | null;
  /**
   * True when this ship's own drones are out — ANY drones, whatever they are.
   * Not a player condition: the blocks that warp away read it to know there is
   * something to call home first, and the "launch drones on a pirate" interrupt
   * reads it to know the drone slots are taken (a launch into full slots is
   * refused every tick and would starve the step under it). Which drones are
   * out, by role, is the `combatDroneIDs` / `salvageDroneIDs` pair below.
   */
  readonly dronesOut: boolean | null;
  // ── Raw reads the macro adapters need (the conditions above are DERIVED from
  //    these). Optional so the pure decide/condition tests need not supply them;
  //    the live runner always does. Never trusted for tri-state — a null here is
  //    unreadable, same rule as everywhere.
  readonly flightStatus?: FlightStatus | null;
  readonly snapshot?: SpaceSnapshot | null;
  readonly lockedTargetIDs?: readonly number[] | null;
  readonly holds?: readonly MiningHold[] | null;
  readonly droneBayItemIDs?: readonly number[] | null;
  /**
   * The drone bay and the drones out BY ROLE, classified from the game's own
   * group name (see nav/droneRoles.ts). A block launches and orders drones for
   * the job they can do — combat drones fight, salvage drones salvage — never
   * the whole bay. `*DroneBayItemIDs` are bay stacks; `*DroneIDs` are drones in
   * space under THIS ship's control. null mirrors an unreadable bay / snapshot,
   * and a drone whose group has not resolved is in NO list: cannot tell, so it
   * is never launched for a job it may not be able to do.
   */
  readonly combatDroneBayItemIDs?: readonly number[] | null;
  readonly salvageDroneBayItemIDs?: readonly number[] | null;
  readonly combatDroneIDs?: readonly number[] | null;
  readonly salvageDroneIDs?: readonly number[] | null;
  /** Bay stacks whose type or group could not be read this tick — in no role. */
  readonly unclassifiedDroneBayItemIDs?: readonly number[] | null;
  /** Fitted mining-module ids, refreshed when the active hull or fit changes. */
  readonly miningModuleIDs?: readonly number[];
  /** Fitted salvager ids, refreshed when the active hull or fit changes. */
  readonly salvageModuleIDs?: readonly number[];
  /** Fitted repairers by layer, refreshed when the active hull or fit changes. */
  readonly shieldRepairerIDs?: readonly number[];
  readonly armorRepairerIDs?: readonly number[];
  readonly hullRepairerIDs?: readonly number[];
  /** Fitted REMOTE repairers, refreshed when the active hull or fit changes. */
  readonly remoteShieldRepairerIDs?: readonly number[];
  readonly remoteArmorRepairerIDs?: readonly number[];
  readonly remoteHullRepairerIDs?: readonly number[];
  /** Fitted REMOTE CAPACITOR TRANSMITTERS (SDE group 67) — the cap-chain block. */
  readonly remoteCapModuleIDs?: readonly number[];
  /** Whether the character is in a fleet — read for the fleet-management blocks. true/false/null=unreadable. */
  readonly inFleet?: boolean | null;
  /**
   * Character IDs from a fresh, authoritative bound-fleet roster. `null` means
   * the roster was unavailable; `[]` means the service authoritatively says the
   * pilot is fleetless. Remote assistance must never infer membership from the
   * presence of another player ship on grid.
   */
  readonly fleetMemberCharacterIDs?: readonly number[] | null;
  /** Fitted hardeners + damage controls, refreshed when the active hull or fit changes. */
  readonly hardenerModuleIDs?: readonly number[];
  /** Fitted WEAPONS (turrets/launchers), resolved once at start (the fight block runs these). */
  readonly weaponModuleIDs?: readonly number[];
  /**
   * How far this hull can LOCK, in metres — the ship's own `maxTargetRange`
   * after the server's dogma pass. The combat ladder engages nothing beyond it.
   *
   * ⚠ NULL IS "DO NOT GATE", NOT "NOTHING IS IN RANGE". It rides the fitting
   * read, which a bot run does not force, so it is frequently unreadable — and
   * the null rule everywhere else in this file (unreadable never decides) has to
   * hold here too: a bot whose fit was never opened must still be able to shoot
   * back. With it null the ladder falls back to its bounded lock, which gives up
   * on an unlockable target after `MAX_LOCK_WAIT_TICKS` and moves on.
   */
  readonly maxTargetRangeM?: number | null;
  /** Who "you" are — the loot block only ever touches YOUR wrecks (no can flipping). */
  readonly myCharacterID?: number | null;
  readonly myCorporationID?: number | null;
  /** The station the bot started docked at — resolves a "starting station" ref at run time. */
  readonly startingStationID?: number | null;
  /** The bot document's emergency home, resolved for THIS tick (fixed/start/board slot). */
  readonly homeStationID?: number | null;
  // ── Mission reads (the distribution blocks). Read ONLY when the active step is
  //    a mission block (the runner passes an observe hint), so a mining bot never
  //    pays for an agent-conversation read. Same null rule: null = unreadable.
  /** A freshly opened conversation with the run's agent, read THIS tick. */
  readonly conversation?: AgentConversation | null;
  /** The offered/accepted mission's courier briefing. */
  readonly briefing?: CourierBriefing | null;
  /** THE authority on whether a mission is accepted. */
  readonly journal?: JournalState | null;
  /** The active ship's cargo rows + capacity. */
  readonly cargo?: CargoReading | null;
  /** The docked station's hangar rows (the mission package is picked from here). */
  readonly stationHangar?: readonly InventoryItemRow[] | null;
  /** What the shared autopilot is doing (mission travel rides it). */
  readonly travel?: TravelReading | null;
  /**
   * The agent the finder matched for a find-distribution-agent step (the flow
   * runs the search once the step has published its criteria on the board).
   */
  readonly foundAgent?: {
    readonly agentID: number;
    readonly stationID: number;
    readonly name: string | null;
    readonly stationName: string | null;
  } | null;
  /** Jumps from HERE to the offered mission's drop-off (the accept gate). */
  readonly jumpsToDropoff?: number | null;
  /**
   * The onboard scanner's combat anomalies for THIS system (their scan labels),
   * read only when a warp-to-anomaly step is active. null = unreadable.
   */
  readonly anomalies?: readonly string[] | null;
  /** Held-session probe authority, read only for exploration macros. */
  readonly scannerOperations?: ScannerOperationsSnapshot | null;
  /** The character's saved-fitting library (read when a refit step is active). */
  readonly savedFittings?: readonly SavedFitting[] | null;
  /** Saved bookmarks (label + id + system), read when a bookmark-flying step is active. */
  readonly bookmarks?: readonly {
    readonly bookmarkID: number;
    readonly name: string;
    readonly solarSystemID: number | null;
    /** The folder the bookmark sits in ("Agent Missions" marks mission spots). */
    readonly folderName?: string | null;
    /** True when the bookmark carries raw coordinates (a real spot in space). */
    readonly hasSpot?: boolean;
  }[] | null;
  /** The ACTIVE ship's item id (from the docked inventory read). */
  readonly activeShipID?: number | null;
  /** Item ids the repair shop quotes as DAMAGED (read when a repair step is active). */
  readonly damagedItemIDs?: readonly number[] | null;
  /**
   * The character's PI colonies, projected to what the restart block needs:
   * each colony's extractor pins with their last program + expiry. Read only
   * when a restart-extractors step is active. null = unreadable.
   */
  readonly colonies?: readonly {
    readonly planetID: number;
    readonly planetName: string | null;
    readonly extractors: readonly {
      readonly pinID: number;
      readonly resourceTypeID: number | null;
      readonly expiresAtMs: number | null;
    }[];
  }[] | null;
}

// ─── Tri-state condition evaluation ──────────────────────────────────────────

export type Verdict = "met" | "not-met" | "cannot-tell";

function below(value: number | null, threshold: number): Verdict {
  if (value === null) {
    return "cannot-tell";
  }
  return value < threshold ? "met" : "not-met";
}

function atLeast(value: number | null, threshold: number): Verdict {
  if (value === null) {
    return "cannot-tell";
  }
  return value >= threshold ? "met" : "not-met";
}

function above(value: number | null, threshold: number): Verdict {
  if (value === null) {
    return "cannot-tell";
  }
  return value > threshold ? "met" : "not-met";
}

function fromBool(value: boolean | null): Verdict {
  if (value === null) {
    return "cannot-tell";
  }
  return value ? "met" : "not-met";
}

/** Evaluate one condition against one observation. Exhaustive by compiler. */
export function evaluateCondition(condition: Condition, obs: ScriptObservation): Verdict {
  switch (condition.kind) {
    case "ore-hold-at-least":
      return atLeast(obs.oreHoldFraction, condition.fraction);
    case "hold-empty":
      return fromBool(obs.holdEmpty);
    case "shield-below":
      return below(obs.shieldRatio, condition.fraction);
    case "armor-below":
      return below(obs.armorRatio, condition.fraction);
    case "hull-below":
      return below(obs.hullRatio, condition.fraction);
    case "health-below":
      return below(obs.health, condition.fraction);
    case "capacitor-below":
      return below(obs.capacitorRatio ?? null, condition.fraction);
    case "wallet-below":
      return below(obs.walletBalance ?? null, condition.isk);
    case "wallet-above":
      return above(obs.walletBalance ?? null, condition.isk);
    case "hostile-on-grid":
      return fromBool(obs.hostileOnGrid);
    case "cargo-full":
      return atLeast(obs.cargoFraction ?? null, condition.fraction);
    case "targeted-by-player":
      return fromBool(obs.targetedByPlayer ?? null);
    case "drone-health-below":
      // No drones out reads as null (nothing to judge), NOT as "healthy" — the
      // same rule as everywhere: a missing reading is never a verdict.
      return below(obs.lowestDroneHealth ?? null, condition.fraction);
  }
}

// ─── Interrupt resolution ────────────────────────────────────────────────────

/** How long a load-bearing read may stay unreadable before the runner pauses. */
export const MAX_CANNOT_TELL_STREAK = 15; // ~30s at the 2s tick cadence

/** Player-facing pause reasons owned here (R9a). */
export const SENTENCE = {
  safetyBlind:
    "A pirate is here and I could not read the ship's condition, so I stopped rather than guess.",
  cannotTellStreak:
    "I could not read what I needed for about half a minute, so I stopped rather than guess.",
} as const;

/**
 * What the interrupt scan decided this tick.
 *
 *   • "fire"            — this row's condition is met; the runner runs its response.
 *   • "safety-override" — the acute rule: a pirate is here and health is
 *                         unreadable, and nothing else handled it → pause now.
 *   • "none"            — nothing fired.
 */
export type InterruptResolution =
  | { readonly kind: "fire"; readonly row: InterruptRow }
  | { readonly kind: "safety-override"; readonly reason: string }
  | { readonly kind: "none" };

/**
 * Decide which interrupt (if any) fires this tick.
 *
 * Order matters and is the behaviour: the FIRST row whose condition is met wins,
 * so a player's hostile response (launch drones / run) that sits above — or is —
 * the thing watching the pirate fires before the acute pause can. Only when
 * nothing fired and a pirate is present with unreadable health does the sealed
 * pause take over. A cannot-tell never fires a row.
 */
export function resolveInterrupt(
  interrupts: readonly InterruptRow[],
  obs: ScriptObservation,
  spentAlerts: readonly string[] = [],
): InterruptResolution {
  for (const row of interrupts) {
    const verdict = evaluateCondition(row.when, obs);
    if (verdict === "met") {
      // ⚠ A SPENT ALERT ROW IS TRANSPARENT. It has already said its piece for this
      // episode, and first-match-wins would otherwise park on it forever — so an
      // "alert me" row above a dock-and-pause row would silence the dock. Skipping
      // it lets the rest of the ladder work, which is what makes "tell me AND
      // dock" two rows that both fire. Only "alert" is ever skipped: every other
      // response DOES something to the ship and must keep winning while it holds.
      if (row.respond === "alert" && spentAlerts.includes(row.id)) {
        continue;
      }
      return { kind: "fire", row };
    }
  }
  if (obs.hostileOnGrid === true && obs.health === null) {
    return { kind: "safety-override", reason: SENTENCE.safetyBlind };
  }
  return { kind: "none" };
}

// ─── The cannot-tell streak ──────────────────────────────────────────────────

/**
 * Which alert rows are still spent, given what the world reads THIS tick: a row
 * whose condition has gone not-met is released (its episode is over, so the next
 * time it holds it alerts again). A cannot-tell keeps a row spent — an unreadable
 * check is not evidence the trouble passed, and re-alerting on a blind read is
 * exactly the crying-wolf behaviour the once-per-episode rule exists to stop.
 */
export function releaseSpentAlerts(
  interrupts: readonly InterruptRow[],
  obs: ScriptObservation,
  spentAlerts: readonly string[],
): readonly string[] {
  if (spentAlerts.length === 0) {
    return spentAlerts;
  }
  const kept = spentAlerts.filter((id) => {
    const row = interrupts.find((r) => r.id === id);
    if (row === undefined) {
      return false; // the row was edited away — forget it
    }
    return evaluateCondition(row.when, obs) !== "not-met";
  });
  return kept.length === spentAlerts.length ? spentAlerts : kept;
}

/** Advance a streak: one longer when blind this tick, back to zero otherwise. */
export function bumpCannotTellStreak(streak: number, blindThisTick: boolean): number {
  return blindThisTick ? streak + 1 : 0;
}

/** True when the streak has run long enough that the runner should pause. */
export function cannotTellStreakExhausted(streak: number): boolean {
  return streak >= MAX_CANNOT_TELL_STREAK;
}
