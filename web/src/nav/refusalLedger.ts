// What the server has been turning down, and how long it has been saying no.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// A bot answered 227 consecutive NotEnoughCargoSpace refusals over TWELVE HOURS
// and reported "Taking what's inside." throughout. The refusals existed only in
// the BFF's log, because `scriptRunner.ts` caught every non-session error and
// dropped it with a comment — no counter, no store event, no status change, and
// the same settle window as a success, so it retried at full speed forever.
//
// Nothing here fixes a refusal. This is the thing that NOTICES one, and that
// turns out to be the whole difference between a bot that is wrong for a minute
// and a bot that is wrong overnight.
//
// ── WHY IT LIVES ON THE RUN, NOT ON THE STEP ────────────────────────────────
//
// Macros already count their own attempts (`MAX_BLOCK_ATTEMPTS`), and those
// counters do not hold: `scriptDecide.ts` drops a step's memory whenever the
// step is left, so a `forever` loop hands the same failing target a fresh
// budget on every lap. That is exactly why the log shows repeating bursts of
// five rather than one burst and then silence. A ledger owned by the RUNNER
// outlives the step, so its bound is the one that actually binds.
//
// ── THE RULE IT KEEPS ───────────────────────────────────────────────────────
//
// Wording goes through `describeRefusal`, which R31 makes the ONLY place a
// refusal becomes language. Nothing here writes a sentence of its own and
// nothing here shows a code to a player.

import { describeRefusal } from "../bridge/refusals.ts";

/**
 * What kind of "no" this was.
 *
 * ⚠ `gone` AND `unreachable` ARRIVE AS THE SAME SERVER CODE, and telling them
 * apart matters more than it looks. eve.js's `Handle_GetInventoryFromId` throws
 * `FakeItemNotFound` both when an itemID matches no inventory target at all AND
 * when its own scene/range check fails — so a can that merely drifted out of
 * range between the snapshot tick and the bind call is reported exactly like one
 * that despawned. Retiring a target on the bare code would abandon every can the
 * ship drifted away from, which on a jetcan hauling loop is most of them.
 *
 * The caller separates them with something it already holds: if the target is
 * still in this tick's snapshot it is `unreachable` (close the distance); if it
 * has left the snapshot too, it is `gone`.
 */
export type RefusalKind = "refused" | "unreachable" | "gone";

export interface RefusalRecord {
  /** stepPath + action kind + target, so one failing can does not mask another. */
  readonly key: string;
  /** Consecutive failures. Reset by the first success on the same key. */
  readonly count: number;
  readonly firstAt: number;
  readonly lastAt: number;
  /** Player language, from `describeRefusal`. Never a code. */
  readonly words: string;
  readonly kind: RefusalKind;
}

/**
 * Consecutive failures on ONE key before the run stops rather than keeps asking.
 *
 * Deliberately larger than a macro's own `MAX_BLOCK_ATTEMPTS` (5): that one
 * bounds a single visit to a block and is right to be twitchy, because giving up
 * on one can and trying the next is cheap. This one ends the RUN, so it should
 * only fire when a thing has been refused past any reasonable doubt. With the
 * backoff below, ten of these take a couple of minutes — minutes, not twelve
 * hours, which was the entire problem.
 */
export const MAX_CONSECUTIVE_REFUSALS = 10;

/** Base settle, matching the runner's own SETTLE_TICKS. */
const BASE_SETTLE_TICKS = 2;
/** Ceiling on the backoff, in ticks (~2s each), so a run never sleeps forever. */
const MAX_SETTLE_TICKS = 30;

/**
 * How long to wait after the Nth consecutive failure on a key.
 *
 * Linear rather than geometric, and capped. The point is not to be clever: it is
 * that retrying a hold that has no room, at full speed, 227 times, is pure noise
 * against the server — while a bot that has hit one bad can should still be
 * responsive when the player comes back to it.
 */
export function settleTicksForRefusals(count: number): number {
  if (!(count > 0)) {
    return BASE_SETTLE_TICKS;
  }
  return Math.min(BASE_SETTLE_TICKS + count * 2, MAX_SETTLE_TICKS);
}

/**
 * The identity of a failure. A target id is part of it on purpose: one jetcan
 * that will not give up its contents must not spend the budget that belongs to
 * the next one, and must not be masked by it either.
 */
export function refusalKey(
  stepPath: string | null,
  actionKind: string,
  targetID: number | null,
): string {
  return `${stepPath ?? "-"}:${actionKind}:${targetID ?? "-"}`;
}

/** Classify a raw wire refusal. `stillOnGrid` is only consulted for a bind miss. */
export function classifyRefusal(raw: string, stillOnGrid: boolean | null): RefusalKind {
  if (!/FakeItemNotFound/i.test(String(raw ?? ""))) {
    return "refused";
  }
  // The object could not be bound. Still on the grid this tick means it exists
  // and we are simply too far away or off its scene; absent from the grid too
  // means it has genuinely stopped existing. An UNREADABLE grid (null) is not
  // evidence of either, and "we could not look" must never retire a target —
  // so it reads as the recoverable one.
  return stillOnGrid === false ? "gone" : "unreachable";
}

export interface RefusalLedger {
  /** Record one failure and return the running record for its key. */
  note(key: string, raw: string, at: number, stillOnGrid: boolean | null): RefusalRecord;
  /** A success on this key: the streak is over. */
  clear(key: string): void;
  /** Consecutive failures on this key, 0 when it is not failing. */
  consecutive(key: string): number;
  /** Everything currently failing, worst first — what a readout shows. */
  records(): readonly RefusalRecord[];
}

/**
 * A run's ledger. Mutable and closure-owned, the same shape as
 * `createCapabilityCache` — the runner owns exactly one and drops it when the
 * run ends, which is what makes "per run" true without any explicit lifetime.
 */
export function createRefusalLedger(): RefusalLedger {
  const byKey = new Map<string, RefusalRecord>();
  return {
    note(key, raw, at, stillOnGrid) {
      const previous = byKey.get(key) ?? null;
      const record: RefusalRecord = {
        key,
        count: (previous?.count ?? 0) + 1,
        firstAt: previous?.firstAt ?? at,
        lastAt: at,
        words: describeRefusal(raw).text,
        kind: classifyRefusal(raw, stillOnGrid),
      };
      byKey.set(key, record);
      return record;
    },
    clear(key) {
      byKey.delete(key);
    },
    consecutive(key) {
      return byKey.get(key)?.count ?? 0;
    },
    records() {
      return [...byKey.values()].sort((left, right) => right.count - left.count);
    },
  };
}
