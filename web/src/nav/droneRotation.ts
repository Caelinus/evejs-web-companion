// Drone rotation — §4 of docs/drone-boat-block-spec.md, one drone at a time.
//
// The player's rule, in their own words: "if drone STARTS loosing shield, that
// individual drone is recalled to drone bay, and then launched again to target."
// It is deliberately NOT a percentage, and reading it as one loses the whole
// idea. A drone that has begun taking damage is already the thing the rats have
// decided to kill; waiting for it to fall past some fraction is waiting for it to
// be nearly dead before doing the one cheap thing that saves it. Pulling it
// drops the rat's aggro, the rat picks a fresh target, and the drone goes back
// out whole.
//
// This is why the existing `drone-health-below` watch cannot express it. That
// watch reads `lowestDroneHealth`, which is the MINIMUM across the whole flight
// folded into one number: it cannot name WHICH drone is hurt, and naming the
// drone is the entire action. `ScriptObservation.myDrones` is the per-drone half
// of that same fold and is what this module consumes.
//
// ─── THE CYCLE ───────────────────────────────────────────────────────────────
//
//   idle       -> recalling    shieldRatio < 1.0   issue recall(thisDrone)
//   recalling  -> relaunching  it is IN THE BAY    issue launch(thisDrone)
//   relaunching-> idle         it is IN SPACE      (the block's engage rung
//                                                   picks it up again; that is
//                                                   not this module's business)
//
// ⚠ ONE DRONE AT A TIME, AND THE REASON IS DAMAGE AND NOT TIDINESS. A drone in
// transit is a drone doing nothing. Rotating two at once halves the flight's
// damage output for as long as both are travelling, which on a boat whose only
// weapon is the flight is the same thing as halving the ship's DPS. So a
// rotation in flight blocks every other drone from starting one, however hurt
// they are — the hurt one will still be hurt in ten seconds, and if it dies
// meanwhile, it dies while the flight was still shooting.
//
// ⚠ THE TRIGGER IS THE SHIELD AND ONLY THE SHIELD, AND ARMOUR IS DELIBERATELY
// IGNORED. This looks like an oversight and is the opposite of one. A drone's
// shield REGENERATES; its armour does not — nothing repairs drone armour in
// space, so `armorRatio < 1` is TRUE FOR THE REST OF THE SITE from the first
// scratch onwards. Rotating on it would therefore not be a trigger at all but a
// permanent condition: the drone would be recalled on the very next tick after
// coming back, and again after that, spending all three of its rotations inside
// six ticks and then being disqualified for the rest of the site — the exact
// opposite of what the feature is for. A shield below full, by contrast, is a
// LIVE fact: it means something is hitting this drone right now, or was a moment
// ago. History does not get to order the ship around; only the present tick
// does. A full-shielded drone with chewed armour has survived something and is
// currently being left alone, and the right response to that is to let it shoot.
//
// ⚠ AND AN UNREADABLE SHIELD IS NOT A LOW ONE. `shieldRatio` is three-state per
// the observation's own contract: `null` is "that layer did not read", never "a
// layer at zero". Unreadable never decides anything in this codebase, and here
// the cost of getting it wrong is a drone yanked off the field every tick on a
// snapshot that simply never carries the ratio.
//
// ⚠ BOUNDED AT MAX_DRONE_ROTATIONS PER DRONE PER SITE. A drone that keeps being
// picked is a drone the rats keep choosing, and after three saves the rotation
// costs more damage (its own, while it flies home and back) than the drone is
// worth. Past the cap it is left out to die and the OTHER drones stay eligible.
//
// ⚠ A DRONE THAT DIES MID-ROTATION MUST NOT WEDGE THIS MACHINE. It will simply
// stop appearing in space and never appear in the bay, and a naive "wait until
// it is home" waits for ever — no further rotation for the rest of the site,
// silently, on a block that otherwise looks like it is working. See
// `DEAD_DRONE_TICKS` for how absence is told apart from an unreadable tick, and
// `MAX_RECALL_TICKS` / `MAX_RELAUNCH_TICKS` for the other two ways an order can
// fail to land.
//
// This module is PURE. Plain data in, plain data out. No store, no bridge, no
// loop, no clock, no randomness — the caller keeps the record in its step memory
// and hands it back next tick, so every case below is testable as arithmetic on
// two lists and a record.

/**
 * How many times one drone may be rotated before it is left to die.
 *
 * Three, from the spec. Not a knob: a player asked to tune this would be being
 * asked to guess at a number whose right value is "few", and the argument for
 * "few" is above — each rotation is bought with the drone's own flight time.
 */
export const MAX_DRONE_ROTATIONS = 3;

/**
 * How many consecutive READABLE ticks a rotating drone must be absent from BOTH
 * space and the bay before it is written off as dead.
 *
 * ⚠ ONE TICK IS NOT ENOUGH, AND THE REASON IS THAT THE TWO LISTS DO NOT COME
 * FROM THE SAME PLACE. "In space" is folded from the snapshot's entity walk and
 * "in the bay" from the ship's own bay contents; a drone that has just finished
 * flying home can plausibly be out of the first before it is in the second for a
 * single tick. Writing it off on that tick would abandon a perfectly alive drone
 * one tick before it was ready to be relaunched — and, worse, would spend a
 * rotation on nothing.
 *
 * Two is the smallest number that survives that seam. It is a tick of latency in
 * the rare real-death case, which costs nothing: the drone is already gone.
 */
export const DEAD_DRONE_TICKS = 2;

/**
 * How many ticks to wait for a recalled drone to reach the bay before giving up
 * on the rotation.
 *
 * Generous on purpose — this is a real flight home across the stand-off band,
 * and a drone crawling back from 25 km takes tens of seconds. This bound is not
 * here to hurry it along; it is here so that a recall which never LANDED (a
 * refused call, an order eaten by a reconnect) cannot wedge the machine for the
 * rest of the site. Hitting it abandons the rotation and leaves the drone in
 * space, where it is still shooting.
 */
export const MAX_RECALL_TICKS = 30;

/**
 * How many ticks to wait for a relaunched drone to appear in space.
 *
 * Much tighter than the recall wait, because a launch is not a journey: the
 * drone is in space the moment the call lands. A drone still sitting in the bay
 * several ticks later means the launch was REFUSED, and the most likely reason
 * is bandwidth — something else went out while this one was away. Waiting
 * longer does not fix bandwidth. Giving up hands the drone back to the block's
 * own launch rung, which is where "there is a drone in the bay" is normally
 * answered, and frees the machine for another drone.
 */
export const MAX_RELAUNCH_TICKS = 5;

/**
 * One drone in space, exactly as `ScriptObservation.myDrones` carries it, so a
 * caller hands the observation rows straight through without reshaping them.
 *
 * `armorRatio` and `hullRatio` are part of the row and are deliberately NOT read
 * by the decision — see the armour warning in the header. They stay in the type
 * because the caller has them and because a future readout ("it came back with
 * half its armour") is a sentence about this row.
 */
export type RotationDrone = {
  readonly itemID: number;
  readonly shieldRatio: number | null;
  readonly armorRatio: number | null;
  readonly hullRatio: number | null;
};

/** The rotation currently in flight. */
export type ActiveRotation = {
  readonly itemID: number;
  /** `recalling`: the recall is issued and we are waiting for the bay.
   *  `relaunching`: the launch is issued and we are waiting for space. */
  readonly phase: "recalling" | "relaunching";
  /** Consecutive readable ticks spent in this phase without it advancing. */
  readonly waitTicks: number;
  /**
   * Ticks that could see BOTH space and the bay and found the drone in neither.
   * Cleared by actually seeing the drone, never by a tick that could not look —
   * a snapshot that stutters must not erase the evidence either side of it.
   */
  readonly missingTicks: number;
};

/**
 * The record the caller carries from tick to tick.
 *
 * ⚠ IT IS A `type` AND NOT AN `interface`, AND THAT IS LOAD-BEARING. Step memory
 * is typed `Readonly<Record<string, unknown>>`; TypeScript gives an object-literal
 * type alias an implicit index signature and does not give one to an interface,
 * so declaring this as an interface would make the caller's `memory: result.memory`
 * fail to compile for a reason that reads like a mistake in the caller.
 *
 * ⚠ AND IT IS PLAIN JSON, DELIBERATELY. No Map, no Set, no class, no undefined —
 * the record goes through the step-memory slot and may be serialised on the way.
 * `rotations` is keyed by the drone's itemID AS A STRING for the same reason: a
 * JSON object has no numeric keys, so a numeric-keyed record would come back
 * string-keyed and the counts would silently start again from zero. Doing it in
 * string form from the outset means the round trip changes nothing.
 *
 * SCOPE: "per site" is the CALLER's, not this module's. Nothing here knows what a
 * site is; the counts last exactly as long as the record the caller keeps, and
 * dropping the record on leaving the site is what makes the cap per-site.
 * ⚠ The counts must NOT be pruned when a drone stops being visible — a drone in
 * the bay is the same drone when it comes back, and forgetting its tally there
 * would hand it a fresh three every time it went home.
 */
export type DroneRotationMemory = {
  readonly active: ActiveRotation | null;
  readonly rotations: Readonly<Record<string, number>>;
};

export type DroneRotationInputs = {
  /**
   * The drones in space this ship can ORDER, this tick.
   *
   * ⚠ `null`/`undefined` IS "NOBODY LOOKED", NOT "NO DRONES ARE OUT", and the
   * two must not be confused: an empty array says the flight is in the bay, an
   * absent one says the snapshot did not carry the fold. `myDrones` is an
   * optional field on the observation for exactly that reason.
   */
  readonly dronesInSpace: readonly RotationDrone[] | null | undefined;
  /** The drone itemIDs sitting in the bay. Same three states as above. */
  readonly droneIDsInBay: readonly number[] | null | undefined;
  /**
   * Whatever came back out of the step-memory slot, untyped on purpose: it may
   * be absent on the first tick of a site, or a shape written by an older
   * version of this module, or something another rung left in the same slot.
   * It is rebuilt defensively rather than trusted — see `readRotationMemory`.
   */
  readonly memory: unknown;
};

/**
 * Why this tick decided what it decided — so the block's readout can finish the
 * sentence, the way `kiteBand.reason` does.
 */
export type DroneRotationReason =
  /** Nothing is losing shield and nothing is in flight. */
  | "idle"
  /** The snapshot did not carry enough to decide anything. Never a verdict. */
  | "unreadable"
  /** A recall was issued this tick, or we are waiting for it to reach the bay. */
  | "recalling"
  /** A launch was issued this tick, or we are waiting for it to reach space. */
  | "relaunching"
  /** The drone is back in space; the rotation is over. */
  | "complete"
  /** A drone qualifies but has spent its rotations, and no other one does. */
  | "capped"
  /** The rotating drone vanished from space and bay: it died. Record dropped. */
  | "lost"
  /** The recall or the launch never landed. Rotation abandoned, machine freed. */
  | "stalled";

export type DroneRotationStep = {
  /**
   * What to do NOW — at most one world call per tick, always naming exactly one
   * drone. `itemID` is non-null if and only if `action` is not `"none"`.
   */
  readonly action: "none" | "recall" | "relaunch";
  readonly itemID: number | null;
  readonly reason: DroneRotationReason;
  /** The record to carry into the next tick. Always a fresh plain object. */
  readonly memory: DroneRotationMemory;
};

/** A record with nothing in it — the first tick of a site. */
export function emptyDroneRotationMemory(): DroneRotationMemory {
  return { active: null, rotations: {} };
}

/** How many rotations this drone has already spent. For the block's readout. */
export function rotationsSpent(
  memory: DroneRotationMemory,
  itemID: number,
): number {
  const key = String(itemID);
  const spent = memory?.rotations?.[key];
  return typeof spent === "number" && Number.isFinite(spent) && spent > 0
    ? Math.floor(spent)
    : 0;
}

/**
 * A health ratio we are willing to compare against 1.
 *
 * Three-state in, three-state out: anything that is not a finite number is
 * `null`, which this module reads as "did not say" and never as "empty". Values
 * outside [0, 1] are clamped rather than dropped — a ratio of 1.0000001 off a
 * float division is a FULL shield and must not read as damage, and a negative
 * one is a drone in trouble rather than a reason to ignore the row.
 */
function ratio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** An itemID we are willing to put into a world call, or null. */
function identifier(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** A non-negative whole tick count out of a record that may have been mangled. */
function ticks(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/**
 * Rebuild the carried record from whatever was in the slot.
 *
 * ⚠ NOTHING HERE IS TRUSTED. The value has been through a step-memory slot typed
 * `unknown` and possibly through JSON; a wrong shape must degrade to "no rotation
 * in flight, no counts" rather than throw, because a throw in a bot rung is a run
 * that stops. The cost of degrading is at most one forgotten tally, and the
 * alternative is a crash on a snapshot nobody can reproduce.
 */
export function readRotationMemory(value: unknown): DroneRotationMemory {
  if (value === null || typeof value !== "object") return emptyDroneRotationMemory();
  const raw = value as { active?: unknown; rotations?: unknown };

  const rotations: Record<string, number> = {};
  if (raw.rotations !== null && typeof raw.rotations === "object") {
    for (const [key, count] of Object.entries(
      raw.rotations as Record<string, unknown>,
    )) {
      const spent = ticks(count);
      if (spent > 0) rotations[key] = spent;
    }
  }

  let active: ActiveRotation | null = null;
  if (raw.active !== null && typeof raw.active === "object") {
    const row = raw.active as {
      itemID?: unknown;
      phase?: unknown;
      waitTicks?: unknown;
      missingTicks?: unknown;
    };
    const id = identifier(row.itemID);
    // An active row without a usable drone id is not a rotation — it is a
    // corrupt record, and keeping it would block every future rotation while
    // naming nothing to recall.
    if (id !== null && (row.phase === "recalling" || row.phase === "relaunching")) {
      active = {
        itemID: id,
        phase: row.phase,
        waitTicks: ticks(row.waitTicks),
        missingTicks: ticks(row.missingTicks),
      };
    }
  }

  return { active, rotations };
}

/** The counts record with one more rotation booked against this drone. */
function bookRotation(
  rotations: Readonly<Record<string, number>>,
  itemID: number,
): Readonly<Record<string, number>> {
  const key = String(itemID);
  const next: Record<string, number> = { ...rotations };
  next[key] = ticks(rotations[key]) + 1;
  return next;
}

/**
 * One tick of the machine: what to do now, and the record to carry forward.
 *
 * Call it every tick with the observation as it is and the record as it was.
 * Exactly one world call comes out of it at most, and a tick that finishes or
 * abandons a rotation does NOT also start a new one — the next tick does that.
 * A tick is cheap; two drone orders in one tick is the thing the whole "one at a
 * time" rule exists to prevent, and it would be a shabby way to break it.
 */
export function decideDroneRotation(
  inputs: DroneRotationInputs,
): DroneRotationStep {
  const memory = readRotationMemory(inputs?.memory);

  // ─── WHAT THE TICK CAN SEE ────────────────────────────────────────────────
  // Each list is readable or it is not, SEPARATELY, and the facts they support
  // are kept apart on purpose. An unreadable bay does not stop us seeing that a
  // drone is alive in space, and an unreadable space list does not stop us
  // seeing that a recalled drone has made it home. Folding them into one "is
  // this tick usable?" flag would throw away half of what did arrive.
  const spaceReadable = Array.isArray(inputs?.dronesInSpace);
  const bayReadable = Array.isArray(inputs?.droneIDsInBay);

  const spaceRows: RotationDrone[] = [];
  const inSpace = new Set<number>();
  if (spaceReadable) {
    for (const row of inputs.dronesInSpace as readonly RotationDrone[]) {
      const id = identifier(row?.itemID);
      if (id === null) continue;
      spaceRows.push(row);
      inSpace.add(id);
    }
  }

  const inBay = new Set<number>();
  if (bayReadable) {
    for (const value of inputs.droneIDsInBay as readonly number[]) {
      const id = identifier(value);
      if (id !== null) inBay.add(id);
    }
  }

  // ─── A ROTATION IN FLIGHT OWNS THE TICK ───────────────────────────────────
  const active = memory.active;
  if (active !== null) {
    const here = inSpace.has(active.itemID);
    const home = inBay.has(active.itemID);

    // ⚠ DEATH, AND ONLY FROM A TICK THAT COULD ACTUALLY SEE BOTH PLACES. A drone
    // that died mid-rotation stops appearing in space and never appears in the
    // bay; it is the one failure that has no event of its own and must be
    // inferred from absence. Absence is only evidence when both lists were
    // READ — with either one missing, "not in it" is not a fact about the drone,
    // it is a fact about the snapshot, and a machine that writes drones off on
    // that would lose a healthy drone to one bad tick.
    if (spaceReadable && bayReadable && !here && !home) {
      const missingTicks = active.missingTicks + 1;
      if (missingTicks >= DEAD_DRONE_TICKS) {
        // Let it go. The tally stays booked: the rotation was spent, and if the
        // id ever comes back (it will not — drones do not un-die) it has used it.
        return {
          action: "none",
          itemID: null,
          reason: "lost",
          memory: { active: null, rotations: memory.rotations },
        };
      }
      return {
        action: "none",
        itemID: null,
        reason: active.phase,
        memory: {
          active: { ...active, missingTicks, waitTicks: active.waitTicks + 1 },
          rotations: memory.rotations,
        },
      };
    }

    if (active.phase === "recalling") {
      if (home) {
        // It made it. Send it back out; the block's engage rung will put it on
        // a target again, which is deliberately not this module's business.
        return {
          action: "relaunch",
          itemID: active.itemID,
          reason: "relaunching",
          memory: {
            active: {
              itemID: active.itemID,
              phase: "relaunching",
              waitTicks: 0,
              missingTicks: 0,
            },
            rotations: memory.rotations,
          },
        };
      }
      // Still out there, or the tick could not tell. Either way: WAIT, and do
      // NOT re-issue the recall. The order is standing on the server and the
      // drone is flying; re-issuing it every tick would spend the block's one
      // action on a call that changes nothing for the whole flight home, which
      // is the same mistake `shouldReissueHold` exists to stop in kiteBand.
      const waitTicks = bayReadable ? active.waitTicks + 1 : active.waitTicks;
      if (waitTicks >= MAX_RECALL_TICKS) {
        // The recall never landed. Give the machine back — the drone is still in
        // space and still shooting, which is a perfectly survivable outcome.
        return {
          action: "none",
          itemID: null,
          reason: "stalled",
          memory: { active: null, rotations: memory.rotations },
        };
      }
      // ⚠ THE DEATH COUNTER IS CLEARED BY SEEING THE DRONE, NOT BY SURVIVING A
      // TICK. Zeroing it here unconditionally would let a single unreadable tick
      // wipe the evidence gathered by the readable ones either side of it, and a
      // drone that dies while the snapshot is stuttering would never be written
      // off at all. Only actually laying eyes on it in space proves it alive.
      return {
        action: "none",
        itemID: null,
        reason: "recalling",
        memory: {
          active: {
            ...active,
            waitTicks,
            missingTicks: here ? 0 : active.missingTicks,
          },
          rotations: memory.rotations,
        },
      };
    }

    // phase === "relaunching"
    if (here) {
      return {
        action: "none",
        itemID: null,
        reason: "complete",
        memory: { active: null, rotations: memory.rotations },
      };
    }
    const waitTicks = spaceReadable ? active.waitTicks + 1 : active.waitTicks;
    if (waitTicks >= MAX_RELAUNCH_TICKS) {
      // The launch was refused — bandwidth, most likely. Leave the drone in the
      // bay for the block's own launch rung to find and free the machine, so a
      // second drone losing shield is not held hostage by this one.
      return {
        action: "none",
        itemID: null,
        reason: "stalled",
        memory: { active: null, rotations: memory.rotations },
      };
    }
    // Same rule as the recall branch above: seeing it in the bay is what clears
    // the death counter, not merely reaching this line.
    return {
      action: "none",
      itemID: null,
      reason: "relaunching",
      memory: {
        active: {
          ...active,
          waitTicks,
          missingTicks: home ? 0 : active.missingTicks,
        },
        rotations: memory.rotations,
      },
    };
  }

  // ─── NOTHING IN FLIGHT: IS ANYBODY LOSING SHIELD? ─────────────────────────
  // Only a readable space list can answer that. An unreadable one is reported as
  // such rather than as "idle", because the two are different sentences to the
  // player and only one of them means the drones are fine.
  if (!spaceReadable) {
    return {
      action: "none",
      itemID: null,
      reason: "unreadable",
      memory: { active: null, rotations: memory.rotations },
    };
  }

  let pick: RotationDrone | null = null;
  let pickShield = Number.POSITIVE_INFINITY;
  let cappedSomeone = false;
  for (const row of spaceRows) {
    const shield = ratio(row.shieldRatio);
    // Unreadable shield: not a trigger, not a candidate, no opinion at all.
    if (shield === null || shield >= 1) continue;
    // Safe: `spaceRows` only ever holds rows whose id already passed
    // `identifier` on the way in, so there is no second validation here.
    const id = row.itemID;
    if (rotationsSpent(memory, id) >= MAX_DRONE_ROTATIONS) {
      // This one is being focused and has had its three. Leaving it out is the
      // decision, not a failure to act — but remember that somebody qualified,
      // so the readout can say "that drone is on its own now" instead of "all
      // quiet", which would be a lie.
      cappedSomeone = true;
      continue;
    }
    // Worst shield first, ties by lowest itemID. The tie-break is not cosmetic:
    // two drones on identical ratios must not flip the pick from tick to tick,
    // or the machine starts a rotation on a different drone each time the list
    // order changes underneath it.
    if (
      pick === null ||
      shield < pickShield ||
      (shield === pickShield && id < pick.itemID)
    ) {
      pick = row;
      pickShield = shield;
    }
  }

  if (pick === null) {
    return {
      action: "none",
      itemID: null,
      reason: cappedSomeone ? "capped" : "idle",
      memory: { active: null, rotations: memory.rotations },
    };
  }

  // ⚠ THE TALLY IS BOOKED WHEN THE ROTATION STARTS, NOT WHEN IT FINISHES. The
  // cap exists to stop this rung picking the same drone over and over, and a
  // rotation that fails (the recall never lands, the launch is refused, the
  // drone dies on the way home) has still cost the block its actions and the
  // drone its flight time. Booking on success would make exactly the failing
  // case unbounded, which is the case the bound is for.
  const id = pick.itemID;
  return {
    action: "recall",
    itemID: id,
    reason: "recalling",
    memory: {
      active: {
        itemID: id,
        phase: "recalling",
        waitTicks: 0,
        missingTicks: 0,
      },
      rotations: bookRotation(memory.rotations, id),
    },
  };
}
