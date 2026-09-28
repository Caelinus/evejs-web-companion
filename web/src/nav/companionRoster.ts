// THE FLEET COMPANIONS WINDOW'S OWN WORDS AND SUMS — pure, so they are testable
// without a DOM.
//
// The window is a roster: every pilot signed into this browser, plus every
// companion the SERVER is flying for this account. Two things about such a list
// are worth stating once rather than at each render — what a run's status is
// called, and what the list adds up to — and both are the kind of thing that
// quietly drifts when it lives inline in a component nobody can unit-test.
//
// ⚠ THIS IS NOT bots/pilotRoster.ts, AND IT MUST NOT GROW INTO IT. That module
// answers "what is flying this pilot's ship, and did the tab or the host start
// it" for the Bot Manager, where a run is a SCRIPT with a library row, a risk
// class and a runtime cap. A companion has none of those. The two lists look
// alike from a distance and are about different systems; merging them is how a
// fleet readout ended up inside a bot manager in the first place.

/**
 * What a companion's run state is called, in words a player can act on.
 *
 * ⚠ NEVER THE RAW STATE WORD (R9a), and "not running" is deliberately the
 * answer for both a companion that was never started and one that was stopped
 * cleanly. The finished run's own outcome is on the panel below; a roster row
 * restating it would be a second, staler version of the same sentence.
 */
export function companionStatusWords(status: string | null): string {
  if (status === "running") return "Running";
  if (status === "paused") return "Paused";
  if (status === "error") return "Stopped after a problem";
  return "Not running";
}

/**
 * The companions the SERVER is flying right now.
 *
 * ⚠ `endedAt`, NOT `status`. A finished run keeps being listed so its last
 * readout stays readable — bots/pilotRoster.ts's `serverBotFor` follows the
 * same rule for the same reason — so filtering on a status word would leave
 * yesterday's companion in a roster of who is flying.
 *
 * Structurally typed rather than taking `ServerBot`, so this module stays free
 * of the API layer and its decoders: what it needs is the two fields, and any
 * shape carrying them can be summed here.
 */
export function serverCompanions<T extends { readonly kind: string; readonly endedAt: string | null }>(
  bots: readonly T[],
): readonly T[] {
  return bots.filter((bot) => bot.kind === "companion" && bot.endedAt === null);
}

/** One row's contribution to the summary: is it flying, resting, or neither. */
export interface CompanionTally {
  readonly running: number;
  readonly paused: number;
  readonly idle: number;
}

/** Count a list of status words' worth of rows. */
export function tallyCompanions(statuses: readonly (string | null)[]): CompanionTally {
  let running = 0;
  let paused = 0;
  let idle = 0;
  for (const status of statuses) {
    if (status === "running") running += 1;
    else if (status === "paused") paused += 1;
    else idle += 1;
  }
  return { running, paused, idle };
}

/**
 * The one-line summary above the roster.
 *
 * ⚠ IT NEVER SAYS "0 RUNNING". A count of nothing is a number a player has to
 * read before they can dismiss it; the sentence that means the same thing is
 * shorter and lands faster. Paused is named separately from idle for the reason
 * `holdsTheShip` exists: a paused companion has not let go of the hull.
 */
export function companionSummaryWords(tally: CompanionTally): string {
  const total = tally.running + tally.paused + tally.idle;
  if (total === 0) {
    return "No pilots are signed in here.";
  }
  if (tally.running === 0 && tally.paused === 0) {
    return "No pilot is flying as a companion.";
  }
  const parts: string[] = [];
  if (tally.running > 0) parts.push(`${tally.running} running`);
  if (tally.paused > 0) parts.push(`${tally.paused} paused`);
  if (tally.idle > 0) parts.push(`${tally.idle} idle`);
  return parts.join(", ");
}

/**
 * Whether a pilot is in a fleet, for the roster's own column.
 *
 * ⚠ TWO SOURCES, AND THE RUNNING ONE WINS. A companion that is flying reports
 * the fleet IT can see, which is the reading its own decisions are made on —
 * that is the answer worth showing about a run. An idle pilot has no companion
 * to ask, so the column falls back to the Fleet Center's availability, the same
 * read the panel's own checklist uses.
 *
 * ⚠ AND AN IDLE PILOT MUST NOT READ AS "no". Before anything has fetched a
 * roster the honest answer is "not known": `unavailable` means the read failed
 * and `unknown` means nobody has asked yet, and neither is a pilot who is out
 * of a fleet. Flattening either into a no is how a roster tells a player to go
 * join a fleet they are already in.
 */
export function inFleetFrom(
  availability: string | null,
  companionInFleet: boolean | null,
  companionHoldsTheShip: boolean,
): boolean | null {
  if (companionHoldsTheShip && companionInFleet !== null) {
    return companionInFleet;
  }
  if (availability === "ready") return true;
  if (availability === "not-in-fleet") return false;
  return null;
}

/**
 * The three columns that describe a RUN, blanked when there is no run.
 *
 * ⚠ THE SLICE OUTLIVES ITS RUN, AND A ROSTER THAT FORGETS THAT LIES QUIETLY.
 * A companion's store slice keeps its last readout after it stops, so a stopped
 * pilot went on reading "following its own judgement - can tag: no" across the
 * roster: three confident statements about a pilot that is doing nothing at
 * all, and "can tag: no" in particular reads as a standing fact about the pilot
 * rather than the last thing a finished run happened to see. Found by stopping
 * one and watching the row keep talking.
 *
 * ⚠ IN FLEET IS NOT IN HERE, deliberately. That column has a live source of its
 * own for an idle pilot (`inFleetFrom`, off the Fleet Center read), so blanking
 * it would throw away an answer that is still true.
 *
 * Paused counts as holding, by `holdsTheShip`'s rule: a paused companion has
 * not let go, and its last order is still the order it will act on when it
 * resumes.
 */
export interface CompanionRunFacts<T> {
  readonly followingOrderFrom: T | null;
  readonly lastOrderHeard: string | null;
  readonly canTag: boolean | null;
}

export function runFactsFor<T>(
  holding: boolean,
  facts: CompanionRunFacts<T> | null,
): CompanionRunFacts<T> {
  if (!holding || facts === null) {
    return { followingOrderFrom: null, lastOrderHeard: null, canTag: null };
  }
  return {
    followingOrderFrom: facts.followingOrderFrom,
    lastOrderHeard: facts.lastOrderHeard,
    canTag: facts.canTag,
  };
}
