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
  ShipBay,
  SpaceSnapshot,
} from "../store/types.ts";
import type { CargoReading, TravelReading } from "./missionBotLoop.ts";
import type { SavedFitting } from "../bridge/fittings.ts";
import type { ScannerOperationsSnapshot } from "../scanner/scannerCenter.ts";
import type { ExplorationSiteKind } from "../scanner/siteKind.ts";
import type { RefusalRecord } from "./refusalLedger.ts";
import type { FleetBroadcast } from "../bridge/fleetBroadcasts.ts";

// ─── The observation ─────────────────────────────────────────────────────────

/**
 * Everything a condition can test, read FRESH each tick. `null` means UNREADABLE
 * throughout — never a value, never "no". `health` is the lowest of the three
 * ship-health ratios (the mining bot's `lowestHealth`), carried as its own field
 * because `health-below` watches the weakest layer while `shield-below` watches
 * one specific layer.
 */
/**
 * One cosmic anomaly on the scanner: the scan label a warp is issued against,
 * and WHAT KIND of site it is so a block can skip the ones it does not want.
 * `kind` is "unknown" when the row carried nothing that classifies it — never a
 * guess (see scanner/siteKind.ts).
 */
export interface ScannedAnomaly {
  readonly label: string;
  readonly kind: ExplorationSiteKind;
}

/** One belt the shared memory says is dry: entirely (`all`) or of these ore families (type groups). */
export interface DryBelt {
  readonly beltName: string;
  readonly all: boolean;
  readonly families: readonly number[];
}

/**
 * One row of the fleet finder, as a block sees it. Deliberately NOT the bridge's
 * full `FleetAdvert`: a decider needs the name to match on, the id to apply with,
 * and the size to break a tie between two fleets sharing a name - and nothing
 * else here should depend on the wire shape.
 */
export interface FleetAdRow {
  readonly fleetID: number;
  readonly fleetName: string;
  readonly numMembers: number;
}

/**
 * The answer the last fleet-finder apply gave, carried back to the block that
 * asked for it.
 *
 * An apply does not join you: on an open advert the server mints an INVITE and
 * the client must accept it, and on an approval-gated one it stores a request
 * only the boss can act on. Those two need different behaviour from the block,
 * and the server's own answer at the moment of the call is the authority on
 * which happened -- better than the advert's `joinNeedsApproval`, which was read
 * earlier and may since have changed.
 */
export interface FleetApplication {
  readonly fleetID: number;
  /** "unknown" means try the accept anyway -- see FleetApplyOutcome. */
  readonly outcome: "needs-approval" | "invited" | "unknown";
}

/**
 * The advert to apply to for a fleet the player named, or null when no listed
 * advert carries that name. `wanted` is already lowercased.
 *
 * ⚠ THE TIE-BREAK IS PART OF THE ANSWER, NOT AN IMPLEMENTATION DETAIL. Fleet
 * names are not unique, so two adverts can both match: the BIGGER fleet wins,
 * because the op with people already in it is the one the player meant, and the
 * lower id breaks a tie between equals so two pilots reading the same listing
 * never split across two fleets of the same size and name.
 *
 * ⚠ IT LIVES IN THIS LEAF MODULE, NOT IN scriptMacros.ts WHERE IT WAS WRITTEN,
 * because there are now two callers: the `join-advertised-fleet` block and the
 * Fleet companions window's own join watch (nav/fleetJoinWatch.ts). A second
 * copy of a tie-break is a second copy that drifts, and the window must not
 * import the whole macro catalogue to ask one question.
 */
export function pickAdvertisedFleet(
  ads: readonly FleetAdRow[],
  wanted: string,
): FleetAdRow | null {
  let best: FleetAdRow | null = null;
  for (const ad of ads) {
    if (ad.fleetID <= 0 || ad.fleetName.trim().toLowerCase() !== wanted) {
      continue;
    }
    if (
      best === null ||
      ad.numMembers > best.numMembers ||
      (ad.numMembers === best.numMembers && ad.fleetID < best.fleetID)
    ) {
      best = ad;
    }
  }
  return best;
}

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
  /** The solar system the ship is in, by NAME — the key of the shared belt memory. */
  readonly systemName?: string | null;
  /**
   * Belts already found dry in THIS system, from the BFF's shared in-process
   * belt memory (every pilot running a mining bot reports into it, entries
   * expire on their own). Read only while a mine step is active. null =
   * unreadable — treated as "nothing known", never as "all dry".
   */
  readonly dryBelts?: readonly DryBelt[] | null;
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
  /**
   * Logistic (remote-repair) drones, same two shapes as the pairs above.
   *
   * ⚠ FILLED FOR THE FLEET COMPANION, WHICH IS SO FAR THE ONLY THING THAT USES
   * THEM. The scripted blocks have no repair job to do, so nothing in
   * `scriptMacros.ts` reads these -- they are here rather than on the companion's
   * own observation because every other drone role already lives on this type
   * and splitting one role out would mean two places to look.
   *
   * ⚠ THE SERVER WILL NOT REPAIR AN OUT-OF-CORP FLEET-MATE. `isFriendlyRepairTarget`
   * tests character, owner, corporation and alliance, never fleet membership, so
   * an engage aimed at a fleet-mate outside the corp is accepted and does
   * nothing. Anything reading these must not promise otherwise.
   */
  readonly logisticDroneBayItemIDs?: readonly number[] | null;
  readonly logisticDroneIDs?: readonly number[] | null;
  /** Bay stacks whose type or group could not be read this tick — in no role. */
  readonly unclassifiedDroneBayItemIDs?: readonly number[] | null;
  /**
   * The game's own GROUP NAME per ship type on this grid, for the combat blocks'
   * target priority (see nav/targetPriority.ts) — the same resolve-then-judge
   * pass the drone roles above make, over hostiles and other players instead of
   * drones. Keyed by typeID, because a group belongs to a type and not to a
   * hull sitting in space.
   *
   * A type missing from the map, or carrying null, is one whose group has not
   * resolved: it is ranked with "everything else" rather than guessed into a
   * class, and it is never dropped from the fight. Absent entirely (the whole
   * field) means no read was made this tick, which is the same thing — the
   * shipped ladder simply lands on nearest-first, exactly as before.
   */
  readonly targetGroupNames?: Readonly<Record<number, string | null>> | null;
  /**
   * The ship this pilot's FLEET has called as its primary (the BFF's shared
   * squad board, src/squadBoard.js) — read only for a block set to follow one.
   *
   * null covers every way there is nothing to follow: nobody has called, the
   * call went stale, this character's fleet is unknown, or the read failed. All
   * four mean the same thing to a block — pick for yourself — so none of them
   * is an error and none of them stops a bot.
   */
  readonly squadPrimaryTargetID?: number | null;
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
   * The fleet-finder listing as this session may see it - one row per advert,
   * trimmed to the three fields a block can act on. `null` means the listing was
   * unreadable; `[]` means it was read and NOBODY is advertising, which is a real
   * answer the join-by-name block is allowed to act on (it finishes).
   *
   * ⚠ The server filters this listing per session (`isAdvertOpenToSession`), so a
   * fleet missing from it is one this pilot could not have joined anyway.
   */
  readonly fleetAds?: readonly FleetAdRow[] | null;
  /** What the last apply this run answered, or null if none has been made. */
  readonly fleetApplication?: FleetApplication | null;
  /**
   * Character IDs from a fresh, authoritative bound-fleet roster. `null` means
   * the roster was unavailable; `[]` means the service authoritatively says the
   * pilot is fleetless. Remote assistance must never infer membership from the
   * presence of another player ship on grid.
   */
  readonly fleetMemberCharacterIDs?: readonly number[] | null;
  /**
   * Fleet target tags, itemID -> tag, from the last `OnFleetStateChange`. Read
   * straight off the store, never a fresh call — so unlike the gated fleet
   * reads above this is never behind a macro gate.
   *
   * ⚠ `null` = never received or unreadable; an EMPTY MAP = received and
   * nothing is tagged. Those are different answers and both are real — the
   * decoder (`decodeFleetStateChangeNotification`) is careful about this and
   * an observation that collapsed them would undo that care. Moved up from
   * `FleetCompanionObservation`, which declared this field first; kept here
   * because any script (not only the fleet companion) may want to read it.
   */
  readonly fleetTargetTags?: ReadonlyMap<number, string> | null;
  /**
   * Whether THIS character may set a fleet target tag right now — three states,
   * not two (see `bridge/fleetCommand.ts`'s header, which this mirrors exactly).
   * `null` = the roster could not be read (or this character's own row was not
   * in it) — WAIT, never guess "no". `false` = read cleanly, and this pilot is
   * not the fleet boss or a wing/squad commander — a settled, safe-to-remember
   * "no". `true` = go ahead. Populated from the SAME bound-fleet read that fills
   * `fleetMemberCharacterIDs` (gated the same way, behind the tagging block
   * being the active step) — not a second roster call.
   */
  readonly canTag?: boolean | null;
  /**
   * The most recent `OnFleetBroadcast` call ("shoot that"), read off the
   * store and ALREADY freshness-filtered against `FLEET_BROADCAST_TTL_MS` at
   * observation build time — never here, and never in the store's reducer.
   * `null` covers both "never received" and "received, but the call has gone
   * stale"; a follower whose call has lapsed falls back to its own ladder,
   * which is a working bot, not a stopped one.
   */
  readonly fleetBroadcast?: FleetBroadcast | null;
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
  /**
   * The active hull's SPECIALISED bays, contents included — what `unload-cargo`
   * needs to empty a hauler whose freight went to the ore hold rather than to
   * cargo. Read only while a block that empties the ship is active, because the
   * BFF answers it with one capacity call per candidate flag and that is far too
   * much to pay on every tick of a mining run.
   */
  readonly shipBays?: readonly ShipBay[] | null;
  /**
   * What the RUN has been refused so far, injected by the runner (the ledger is
   * its state, not a read). A decider treats this as an ordinary fact: "this can
   * has turned me down nine times across four laps" is as much a property of the
   * world as a distance is, and unlike a per-step counter it survives the lap.
   */
  readonly refusals?: readonly RefusalRecord[] | null;
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
   * The onboard scanner's cosmic anomalies for THIS system, read only when an
   * anomaly-flying step is active. null = unreadable.
   */
  readonly anomalies?: readonly ScannedAnomaly[] | null;
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
