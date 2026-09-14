// The stand-off band — the arithmetic behind §2 of docs/drone-boat-block-spec.md.
//
// A drone boat's stand-off distance is not one number. The player's instinct is
// "kite at drone control range with a buffer", and that instinct produces a
// single number that is wrong in both directions at once: too far and the drones
// stop answering, too close and a frigate holds you there. What there actually
// is, is a BAND with a floor and a ceiling — and the interesting case, the one
// this module exists to name out loud, is the band that is EMPTY.
//
//     floor   = (largest scram range among hostiles ON GRID that actually scram)
//               + THREAT_BUFFER_M
//     ceiling = min(drone leash, lock leash) - LEASH_BUFFER_M
//     hold    = floor, clamped into the band
//
// — where the two leashes are resolved SEPARATELY and never substitute for each
// other (see the warning below, and the ceiling half of `kiteBand`): the drone leash is the
// control range, the player's override, or the 20 km guess, in that order; the
// lock leash is the targeting range or nothing at all.
//
// ─── WHY EACH NUMBER IS THE NUMBER ───────────────────────────────────────────
//
// FLOOR — what can grab you. Not a constant and not a property of the fit: it is
// read off the grid every tick, from the hostiles that are on it. A rat that
// cannot scram contributes NOTHING to the floor, however frightening it is
// otherwise, because the floor answers exactly one question ("how far out does
// the thing that can hold me reach?"). A fresh wave carrying a longer-ranged
// scrammer therefore moves the floor up under the block's feet mid-fight, which
// is the whole reason this is recomputed rather than solved once at site entry.
//
// CEILING — the leash, and there are two of them. Past drone control range the
// drones stop answering; past lock range there is nothing to put them on.
// Whichever is smaller wins, minus a buffer, because a ship drifting at exactly
// its control range spends half its time outside it.
//
// HOLD AT THE FLOOR, NOT THE CEILING. This is the part that reads backwards
// until you think about who flies the distance. Further out is not safer in any
// way that matters to a drone boat — the ship is not the thing shooting. The
// DRONES fly every metre of stand-off, on every single target switch, and a
// drone in transit is a drone doing nothing. So sit just outside what can grab
// you and no further.
//
// ⚠ …AND THAT ARGUMENT ONLY OUTRANKS SAFETY WHILE SOMETHING CAN ACTUALLY GRAB
// YOU. When there are hostiles on grid but NONE of them scram, the floor is 0,
// and holding at the floor would be an order to sit on top of the rats — which
// is not what "drone travel time is the cost" was ever meant to buy. Nothing out
// there can hold the ship, so the ship sits at the FAR end of its leash instead:
// hold at the ceiling, `reason: "no-tackle"`, anchor on the nearest threat so
// there is still an object to keep station against. `floorM` stays 0, because 0
// is the honest answer to "how far out does the thing that can hold me reach?".
//
// `"no-tackle"` and `"no-threat"` are two different facts and therefore two
// different words: the first is "they are here and none of them can point you",
// the second is strictly "the grid is empty, there is nobody here". The block's
// readout can say either one truthfully; it could not if they shared a name.
//
// ⚠ THE EMPTY BAND (floor > ceiling) IS THE ORDINARY CASE FOR A LOW-SKILL
// PILOT, NOT AN EXOTIC ONE. From the spec's own worked table: ~27.5 km of drone
// control range against a Dire Pithi Arrogator that scrams at 20 km leaves a
// ceiling of 24.5 km under a floor of 25 km. There is no room to kite. That is
// a real, common, perfectly reasonable fit — so `empty` is a first-class field
// of the result and not an error, and the block above is expected to brawl at
// the ceiling and SAY SO ("your drones only reach 27.5 km and that frigate
// scrams at 20 km, so there is no room to kite — fighting at 24.5 km instead")
// rather than fly to a distance that means nothing.
//
// ⚠ AN UNREADABLE DRONE CONTROL RANGE IS ANSWERED WITH A GUESS OF 20 KM, AND
// THE CONSEQUENCE LOOKS WRONG AT A GLANCE. A pilot whose real control range is
// 27.5 km, on a fit that does not report it, is told to brawl at 17 km —
// closer than they ever needed to fly, and against a 20 km scrammer the band
// comes back EMPTY when in truth it merely had no room to spare.
//
// That is the correct direction to be wrong in. Drones that answer while the
// ship sits too close beat drones that go silent at the range we invented for
// them, and the second failure is the one nobody diagnoses from the readout: the
// bot looks like it is fighting and the drones are simply not there. The way out
// is the OVERRIDE — the player states the leash themselves — and not a cleverer
// guess, because there is nothing on the wire to be clever with.
//
// ⚠ AND THE LOCK RANGE IS NOT A SUBSTITUTE FOR IT. The two leashes are resolved
// separately below, for the reason written there: reading "40 km of lock range"
// as "40 km of drone control range" routes the common fit straight around the
// empty-band protection while leaving the protection sitting in the code looking
// like it works.
//
// So `reason: "fallback"` has to carry a whole sentence to the player — "I could
// not read your drone control range, so I assumed the no-skills 20 km; set the
// hold range if that is wrong" — and it is reported in preference to `"ceiling"`
// for exactly that reason.
//
// ⚠ THE ANCHOR IS ONE ROCK IN A FIELD OF THEM. You can only hold range FROM one
// object, and a grid holds many. Holding 25 km off the nearest scrammer says
// precisely nothing about the scrammer behind you. This module does not pretend
// otherwise and the block must not either: it is an approximation, and it is the
// same approximation a human player makes at the keyboard.
//
// This module is PURE. No store, no bridge, no loop, no clock — plain objects in,
// plain object out — so the whole band can be tested as arithmetic, which is what
// kiteBand.test.ts does.

/**
 * How far OUTSIDE the reach of the worst scrammer on grid to sit.
 *
 * Scram range is a hard edge on the server's side but not on ours: the ship
 * drifts, the rat burns, and a keepAtRange order is a target the ship oscillates
 * around rather than a rail it runs on. Sitting exactly at the edge means being
 * inside it a good fraction of the time.
 */
export const THREAT_BUFFER_M = 5000;

/**
 * How far INSIDE the shorter of the two leashes to sit.
 *
 * Same drift, opposite edge — but the failure is worse here, because crossing
 * this one does not merely risk a point, it silently stops the drones answering
 * commands while the readout still says everything is fine.
 */
export const LEASH_BUFFER_M = 3000;

/**
 * How far the wanted hold has to move before it is worth re-issuing the order.
 *
 * `keepAtRange` is a STANDING order on the server: once given it keeps being
 * true, so re-issuing it is harmless in itself — but it costs the tick's one
 * action, and a block that spends every tick nudging its own distance by 200 m
 * is a block that never shoots. See `shouldReissueHold`.
 */
export const RANGE_HYSTERESIS_M = 2000;

/**
 * The leash to assume when the fit will not say what it is: 20 km, the no-skills
 * base drone control range.
 *
 * ⚠ AN UNREADABLE LEASH IS NOT AN INFINITE ONE. Drone control range is derived
 * from CHARACTER SKILLS and is not on the hull's own attribute row, so a null
 * here is a likely real answer rather than a corner case, and the tempting
 * reading of null as "no limit" would park a drone boat at lock range with its
 * drones deaf. Guessing LOW is the cheap half of being wrong: the cost is a
 * shorter stand-off than the pilot could have held, and the block reports
 * `reason: "fallback"` so the readout can say the leash was guessed.
 *
 * This is the last resort for the DRONE leash only — reached whenever the
 * control range is unreadable and the player has not stated a hold range. A
 * readable lock range does not avert it; lock range is a different leash.
 */
export const FALLBACK_CONTROL_RANGE_M = 20000;

export interface BandThreat {
  readonly itemID: number;
  readonly distanceM: number;
  /** Null when this hostile does not scram; such a row never raises the floor. */
  readonly scramRangeM: number | null;
  /**
   * Does this hostile web?
   *
   * ⚠ A WEB NEVER TOUCHES THE FLOOR. It slows the ship, it does not stop it
   * leaving, so it has no business raising the stand-off — the floor answers
   * "what can hold me here?" and the answer to that is scram or nothing. What a
   * web DOES decide is which rat is worth keeping station against when nothing
   * on the grid points: being slowed by the one you are flying relative to is a
   * different problem from being slowed by one across the grid.
   */
  readonly webs: boolean;
}

export interface BandInputs {
  readonly threats: readonly BandThreat[];
  /** Null when the fit did not report it — see the fallback rule below. */
  readonly droneControlRangeM: number | null;
  /** Null when the hull does not report it; commonly null in this codebase. */
  readonly maxTargetRangeM: number | null;
  /** The player's override in metres, null when unset. */
  readonly overrideHoldM: number | null;
}

export interface KiteBand {
  readonly holdM: number;
  /** The hostile to hold range FROM: nearest scrammer, else nearest threat, else null. */
  readonly anchorID: number | null;
  readonly floorM: number;
  readonly ceilingM: number;
  /** floor > ceiling: there is no room to kite, and the block must brawl at the ceiling. */
  readonly empty: boolean;
  /**
   * Which input decided `holdM` — so the block can say WHY in the player's
   * readout.
   *
   * `"no-tackle"` (hostiles on grid, none of them scram) and `"no-threat"` (the
   * grid is empty) both hold at the ceiling and are deliberately NOT the same
   * word: they are different sentences to the player, and the second one is a
   * lie if said while rats are shooting at him.
   */
  readonly reason:
    | "override"
    | "floor"
    | "ceiling"
    | "no-tackle"
    | "no-threat"
    | "fallback";
}

/**
 * A metre count we are willing to do arithmetic on, or null.
 *
 * ⚠ EVERY NUMBER THIS MODULE RETURNS GOES STRAIGHT INTO A `keepAtRange` CALL, so
 * a NaN or a negative is not a cosmetic defect — it is a world call with a
 * meaningless argument, and the server's answer to a meaningless argument is not
 * something worth finding out mid-fight. The inputs come off a live snapshot
 * where a missing attribute can arrive as undefined, a string, or a negative
 * left over from a signed field, so nothing is trusted to be a number here.
 * Negative distances are folded to 0 rather than dropped: a hostile at "-5 m" is
 * still a hostile on the grid.
 */
function metres(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 0 ? 0 : value;
}

/**
 * Distance used only for ORDERING (which rat is nearest).
 *
 * An unreadable distance sorts last rather than first: a row we cannot measure
 * must not win the anchor and become the thing the whole ship flies relative to.
 * This value is never returned, so the Infinity cannot leak into a world call.
 */
function orderingDistance(value: unknown): number {
  const m = metres(value);
  return m === null ? Number.POSITIVE_INFINITY : m;
}

/** Nearest first, then lowest itemID, so a tie between two rats is not a coin flip
 *  that flickers the anchor (and with it the keepAtRange order) every tick. */
function nearest(rows: readonly BandThreat[]): BandThreat | null {
  let best: BandThreat | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const distance = orderingDistance(row.distanceM);
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && row.itemID < best.itemID)
    ) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The three numbers, from the grid as it is this tick.
 *
 * Pure: call it every tick, throw the answer away, call it again. Nothing here
 * remembers the last one — `shouldReissueHold` is where "has this moved enough
 * to be worth an action?" lives, deliberately separate, because the band and the
 * decision to act on the band are two different questions and the tests for them
 * do not overlap.
 */
export function kiteBand(inputs: BandInputs): KiteBand {
  const threats = Array.isArray(inputs?.threats) ? inputs.threats : [];

  // ─── FLOOR ────────────────────────────────────────────────────────────────
  // Only rows that ACTUALLY SCRAM count. A null scramRangeM is the common case
  // (most rats on a belt cannot point anything) and it must not be read as a
  // zero-range scram, which would be a different claim: "it can grab you if you
  // are touching it" versus "it cannot grab you at all". Both leave the floor at
  // 0 here only because THREAT_BUFFER_M is added to a real scrammer's reach —
  // a scrammer at 0 m reach still pushes the floor to THREAT_BUFFER_M, a
  // non-scrammer does not move it at all.
  const scrammers = threats.filter((row) => metres(row?.scramRangeM) !== null);
  let worstScramM = 0;
  for (const row of scrammers) {
    const reach = metres(row.scramRangeM) ?? 0;
    if (reach > worstScramM) worstScramM = reach;
  }
  // ⚠ THE WORST SCRAMMER ON GRID, NOT THE NEAREST ONE. The anchor is chosen by
  // distance below, but the floor is chosen by REACH — a long-ranged scrammer
  // sitting at the back of the wave sets the distance even though the block will
  // be holding range off somebody else. Taking the nearest one's reach instead
  // would produce a hold that is comfortably outside the harmless rat in front
  // and comfortably inside the point behind it.
  const floorM = scrammers.length === 0 ? 0 : worstScramM + THREAT_BUFFER_M;

  // ─── CEILING ──────────────────────────────────────────────────────────────
  const controlM = metres(inputs?.droneControlRangeM);
  const overrideM = metres(inputs?.overrideHoldM);
  const lockM = metres(inputs?.maxTargetRangeM);

  // ⚠ THE TWO LEASHES ARE NOT INTERCHANGEABLE AND MUST BE RESOLVED SEPARATELY.
  // Lock range is how far the ship can TARGET; drone control range is how far the
  // drones still ANSWER. Taking a min over "whichever of the two we can read"
  // silently substitutes one for the other, and since `maxTargetRangeM` is the
  // one that is usually readable, the substitution runs on the common path: a
  // hull reporting 40 km of lock and no control range would be held at 37 km
  // with its drones deaf from 27.5 km out — the exact pilot the empty band
  // exists to protect, quietly routed around the protection. So: the drone leash
  // is resolved from drone-leash sources only, and a readable lock range is
  // never allowed to stand in for an unreadable control range.
  type LeashSource = "measured" | "override" | "fallback";
  let droneLeashM: number;
  let droneSource: LeashSource;
  if (controlM !== null) {
    droneLeashM = controlM;
    droneSource = "measured";
  } else if (overrideM !== null) {
    // The player typing a number IS them stating the leash — they know their own
    // skills, and we do not. Taken at FACE VALUE, with no buffer off it: the
    // leash buffer protects against drift around a MEASURED edge, and there is
    // no measured edge here, so subtracting it would be silently correcting the
    // player by 3 km against a number we never had.
    droneLeashM = overrideM;
    droneSource = "override";
  } else {
    droneLeashM = FALLBACK_CONTROL_RANGE_M;
    droneSource = "fallback";
  }

  // Clamped at 0: a leash shorter than the buffer (a badly damaged sensor, a
  // stub row reporting 500 m) yields a ceiling of 0 rather than a negative hold.
  // The band is then empty for any real scrammer, which is the honest answer.
  const droneCeilingM =
    droneSource === "override"
      ? droneLeashM
      : Math.max(0, droneLeashM - LEASH_BUFFER_M);
  // A null lock range drops out of the arithmetic entirely — it is commonly null
  // on the hull rows in this codebase, and "the hull did not say" is not "the
  // hull cannot lock anything". The Infinity is internal and cannot escape: the
  // drone ceiling is always finite, so the min always is.
  const lockCeilingM =
    lockM === null ? Number.POSITIVE_INFINITY : Math.max(0, lockM - LEASH_BUFFER_M);

  const ceilingM = Math.max(0, Math.min(droneCeilingM, lockCeilingM));
  // Which side of the min won decides what the readout gets to blame. A tie goes
  // to the drone leash, because when both edges sit at the same distance the
  // drone one is the more useful thing to say.
  const droneLeashDecided = droneCeilingM <= lockCeilingM;
  const ceilingIsGuess = droneSource === "fallback" && droneLeashDecided;

  // ─── WHAT WE WANT, BEFORE THE CEILING GETS A VOTE ─────────────────────────
  let wantedM: number;
  let baseReason: KiteBand["reason"];
  if (overrideM !== null) {
    // The player's number wins outright over the computed floor — including when
    // it is CLOSER than the floor. Someone who deliberately asks to brawl inside
    // scram range is allowed to; the one thing they are not allowed to do is sit
    // past their own drone leash, because that is not a tactic, it is drones
    // that do not answer.
    wantedM = overrideM;
    baseReason = "override";
  } else if (threats.length === 0) {
    // Nothing on grid to hold range from. The floor is 0 and the anchor is null,
    // so there is no meaningful stand-off to compute; report the ceiling so the
    // block has the outer edge of its own leash to work with (for a rat that has
    // not landed yet, or a grid that just went quiet).
    wantedM = ceilingM;
    baseReason = "no-threat";
  } else if (scrammers.length === 0) {
    // Rats on grid, none of them able to point anything. Nothing can hold the
    // ship, so the "hold at the floor" argument stops applying (see the header)
    // and the far end of the leash is the right place to be. The anchor below is
    // still a real hostile, so `keepAtRange` has an object to work with.
    wantedM = ceilingM;
    baseReason = "no-tackle";
  } else {
    wantedM = floorM;
    baseReason = "floor";
  }

  const holdM = Math.max(0, Math.min(wantedM, ceilingM));
  const empty = floorM > ceilingM;

  // ─── WHICH INPUT ACTUALLY DECIDED IT ──────────────────────────────────────
  // The readout has to be able to finish the sentence "holding at 24.5 km
  // because…", and the honest answer is whichever bound bit LAST. A guessed
  // ceiling is reported as `fallback` in preference to `ceiling` whenever the
  // hold is resting on it, because "we do not know your drone control range" is
  // the more actionable half of that sentence — but only then: when the floor
  // decides the hold, the guess decided nothing and saying `fallback` would send
  // the player off to fix a number that is not in their way.
  let reason: KiteBand["reason"];
  if (ceilingIsGuess && holdM === ceilingM) reason = "fallback";
  else if (holdM < wantedM) reason = "ceiling";
  else reason = baseReason;

  // ─── ANCHOR ───────────────────────────────────────────────────────────────
  // Scrammers first: the thing that can hold you is the thing worth measuring
  // against, and it is the reason the floor is where it is. Then webbers — a web
  // does not set the distance but it does decide which rat is worth holding
  // station against. Failing both, the nearest hostile at all, so the block
  // still has something to keep range from on a grid of harmless rats.
  const webbers = threats.filter((row) => row?.webs === true);
  const anchor = nearest(scrammers) ?? nearest(webbers) ?? nearest(threats);

  return {
    holdM,
    anchorID: anchor === null ? null : anchor.itemID,
    floorM,
    ceilingM,
    empty,
    reason,
  };
}

/**
 * Is the wanted hold different enough from the standing one to spend an action
 * re-issuing it?
 *
 * ⚠ THIS IS THE ONLY THING STOPPING THE BLOCK FROM NUDGING ITS OWN DISTANCE
 * FOREVER. `keepAtRange` is a standing server order, so re-issuing it is SAFE —
 * which is exactly the trap, because "safe" reads as "free" and it is not: it
 * costs the tick's one action, and the band moves by a few hundred metres on its
 * own every time a rat drifts. A block without this check re-issues every tick,
 * never reaches the shooting rungs, and looks from the outside like a bot that
 * has decided to fly in circles.
 *
 * An anchor change is always worth the action: the old order is measured against
 * a different object, so the distance it maintains is no longer the distance
 * anybody asked for. A null `currentHoldM` means there is no standing order at
 * all (first tick of the site, or one issued before a reconnect and no longer
 * ours to assume) — issue it.
 */
export function shouldReissueHold(
  currentHoldM: number | null,
  wantedHoldM: number,
  anchorChanged: boolean,
): boolean {
  if (anchorChanged) return true;
  const current = metres(currentHoldM);
  if (current === null) return true;
  const wanted = metres(wantedHoldM);
  // An unreadable wanted hold is not a reason to fire off a call with it. Leave
  // the standing order alone and let the next tick produce a real number.
  if (wanted === null) return false;
  return Math.abs(current - wanted) > RANGE_HYSTERESIS_M;
}
