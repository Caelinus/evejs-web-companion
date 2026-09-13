// Target notifications: the server telling THIS ship that one of its own locks
// has landed, dropped, or been wiped.
//
// ⚠ WHY THIS EXISTS AT ALL, AND WHAT IT REPLACES. Nothing in this client read
// `OnTarget`. The only authority on "what is locked" was `dogmaIM.GetTargets`,
// polled once per loop tick — so a lock that completed a millisecond after a
// tick's read was invisible until the NEXT tick, a whole cadence later. That is
// dead time in the one place a fleet companion can least afford it: rung 6 will
// not send drones onto a ship this hull has not locked (`decideDrones`), and
// rung 7 will not open fire until the lock is OBSERVED (`lockThenEngage`), so
// every fight paid a full tick between "the lock landed" and "anything used
// it".
//
// The poll is NOT replaced. `GetTargets` stays the authority and still runs
// every tick; this decoder only lets the client learn the same fact sooner. A
// dropped push therefore costs freshness and never correctness — the next tick's
// read corrects whatever this folded.
//
// Wire contract, read off `space/runtime.js:32605` (`notifyTargetEvent`):
//   OnTarget args = [what]                    — "clear"
//                 = [what, targetID]          — "add"
//                 = [what, targetID, reason]  — "lost"
// `what` is always `String(...)`-ed server-side; the id and the reason are
// appended only when the caller passed them.
//
// The five `what` values the server actually sends, and which session gets them:
//
//   "add"        this ship's own lock on `targetID` COMPLETED (`:33046`, the
//                moment the pending lock resolves into `lockedTargets`)
//   "lost"       this ship's own lock on `targetID` ended (`:33102`)
//   "clear"      every one of this ship's locks was wiped (`:33340`)
//   "otheradd"   SOMEBODY ELSE locked this ship (`:33063`)
//   "otherlost"  somebody else dropped their lock on this ship (`:33115`)
//
// ⚠ ONLY THE FIRST THREE ARE DECODED, AND THE OTHER TWO ARE NOT AN OVERSIGHT.
// `otheradd`/`otherlost` carry the SOURCE ship's id, not a target of ours, and
// they describe who is pointing at us — a different question, answered today by
// `isTargetedByPlayer` off the space snapshot. Folding them into a lock list
// would put another ship's id where this hull's own locks live, and every
// `isAlreadyLocked` check downstream would read it as a lock we hold.
//
// ⚠ IT ALREADY REACHES THE BROWSER — no BFF route and no gateway patch. The web
// gateway's notification stub suppresses exactly one method, `DoDestinyUpdate`
// (`evejsWebGatewayRuntime.js:4317`), and captures every other `sendNotification`
// onto the push stream AND onto the response drain. The same is true of
// `OnJamStart`; see `jamNotifications.ts`'s header, which this file follows.

import { unwrapLong } from "./wire.ts";

/** What one `OnTarget` push says about THIS ship's own lock list. */
export type TargetEventKind = "locked" | "lost" | "cleared";

/** One `OnTarget` push, narrowed to this ship's own locks. */
export interface TargetEvent {
  readonly kind: TargetEventKind;
  /**
   * The ship whose lock changed. `null` only for `cleared`, which names
   * nothing because it is about all of them at once.
   */
  readonly targetID: number | null;
  /**
   * The server's own word for why a lock ended, verbatim and un-narrowed
   * (`TargetingAttemptCancelled`, and its siblings). Null on every other kind
   * and on a `lost` that carried none. Nothing decides on it today; it is kept
   * because dropping the only explanation the server offers, in the decoder,
   * would mean re-reading the wire to get it back.
   */
  readonly reason: string | null;
}

/**
 * A positive game id as a Number, accepting the `{type:"long"}` wrapper, a bare
 * integer, or a bare decimal string. Every bridge decoder keeps its own copy of
 * this coercer rather than sharing one (see `fleetBroadcasts.ts`'s note).
 */
function positiveSafeID(value: unknown): number | null {
  const unwrapped = unwrapLong(value);
  if (unwrapped !== null && unwrapped > 0n && unwrapped <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(unwrapped);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  }
  return null;
}

/**
 * Decode one `OnTarget` push, or null when this is a different method, a `what`
 * about somebody else's lock, or a payload this client cannot use.
 *
 * ⚠ AN `add` OR `lost` WITH NO READABLE ID IS DROPPED, NOT GUESSED. Both are
 * statements about ONE ship, and a fold that could not say which ship would
 * have to touch the whole list — adding a lock nothing can name, or dropping
 * one that is still held. Either is worse than waiting for the tick's own
 * `GetTargets` read, which is what returning null leaves this client doing.
 */
export function decodeTargetNotification(
  method: string | null,
  args: readonly unknown[],
): TargetEvent | null {
  if (method !== "OnTarget") {
    return null;
  }
  const what = typeof args[0] === "string" ? args[0].trim() : "";
  if (what === "clear") {
    return { kind: "cleared", targetID: null, reason: null };
  }
  if (what !== "add" && what !== "lost") {
    return null;
  }
  const targetID = positiveSafeID(args[1]);
  if (targetID === null) {
    return null;
  }
  const reason = typeof args[2] === "string" && args[2].trim() !== "" ? args[2].trim() : null;
  return {
    kind: what === "add" ? "locked" : "lost",
    targetID,
    reason: what === "lost" ? reason : null,
  };
}

/**
 * Fold one event into the locked-target list.
 *
 * Pure, and returns the SAME array reference when nothing changed, so a store
 * can skip a needless notify — the shape `applyJamEvent` uses, for the same
 * reason.
 *
 * ⚠ THIS IS A FOLD OVER A POLLED LIST, WHICH IS WHY IT MAY BE WRONG FOR A TICK
 * AND MUST NEVER BE TREATED AS THE AUTHORITY. `GetTargets` overwrites whatever
 * this produced on the very next read (`targeting/targets`), so a push that was
 * lost, doubled, or arrived out of order costs at most one tick of freshness.
 * Nothing downstream may invert that: this is here to make a lock visible
 * SOONER, never to let the client stop asking.
 */
export function applyTargetEvent(
  lockedTargetIDs: readonly number[],
  event: TargetEvent,
): readonly number[] {
  if (event.kind === "cleared") {
    return lockedTargetIDs.length === 0 ? lockedTargetIDs : [];
  }
  if (event.targetID === null) {
    return lockedTargetIDs;
  }
  if (event.kind === "locked") {
    return lockedTargetIDs.includes(event.targetID)
      ? lockedTargetIDs
      : [...lockedTargetIDs, event.targetID];
  }
  const remaining = lockedTargetIDs.filter((id) => id !== event.targetID);
  return remaining.length === lockedTargetIDs.length ? lockedTargetIDs : remaining;
}
