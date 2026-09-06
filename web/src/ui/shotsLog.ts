// The combat log's model — the rows, and what a total over them may claim.
//
// Pure, so the one thing that matters here can be tested without a DOM: the
// totals are a sum over a BOUNDED TAIL, and the panel must say so.

import { DAMAGE_LOG_LIMIT } from "../store/clientStore.ts";
import type { DamageEvent } from "../store/types.ts";

export { DAMAGE_LOG_LIMIT };

/** One line of the log, already in the words the player reads. */
export interface ShotRow {
  readonly id: number;
  readonly summary: string;
  readonly weaponLabel: string;
  readonly amountLabel: string;
}

/**
 * Damage dealt and taken, summed over whatever the log currently holds.
 *
 * ⚠ THIS IS NOT A FIGHT TOTAL AND MUST NEVER BE LABELLED AS ONE. The store
 * keeps a bounded tail of the push channel (`DAMAGE_LOG_LIMIT`), and that
 * channel is allowed to drop and resynchronise — so the sum is "what these rows
 * add up to", full stop. A fight lasting more than the cap has already had its
 * earliest shots dropped, and a longer fight would be under-reported by an
 * amount nothing here can know.
 *
 * The panel renders it with the count it was taken over for exactly that
 * reason: a number with its own denominator attached cannot be mistaken for a
 * claim about the whole engagement.
 */
export interface ShotTotals {
  readonly dealt: number;
  readonly taken: number;
  /** How many shots the sums are over — never assumed to be the cap. */
  readonly shots: number;
  /** True when the log is at its cap, so earlier shots have been dropped. */
  readonly truncated: boolean;
}

export function shotTotals(log: readonly DamageEvent[]): ShotTotals {
  let dealt = 0;
  let taken = 0;
  for (const shot of log) {
    // A miss is `amount <= 0`. It is still a shot (it is counted), but it adds
    // nothing to the damage — adding a negative would be inventing healing.
    if (shot.amount <= 0) {
      continue;
    }
    if (shot.direction === "dealt") {
      dealt += shot.amount;
    } else {
      taken += shot.amount;
    }
  }
  return {
    dealt,
    taken,
    shots: log.length,
    truncated: log.length >= DAMAGE_LOG_LIMIT,
  };
}

/**
 * The sentence under the totals.
 *
 * ⚠ IT ALWAYS NAMES THE DENOMINATOR, and it says out loud when the log is full.
 * "Over the last 40 shots" and "over the last 6 shots" are different claims and
 * the panel is never allowed to blur them into "damage this fight".
 */
export function totalsCaption(totals: ShotTotals): string {
  if (totals.shots === 0) {
    return "Nothing to add up yet.";
  }
  const over = totals.shots === 1 ? "the last shot" : `the last ${totals.shots} shots`;
  return totals.truncated
    ? `Over ${over} — the log keeps ${DAMAGE_LOG_LIMIT}, so anything earlier in this fight is not in these figures.`
    : `Over ${over}. Not a fight total: the live channel may drop and pick up again.`;
}

/** A damage figure as the panel prints it. A miss is a dash, never a 0. */
export function damageText(amount: number): string {
  return amount <= 0 ? "—" : amount.toFixed(1);
}
