// WHERE NOTICES COME FROM — the store's own error slices, as data.
//
// ⚠ THE NOTICE SYSTEM ALREADY EXISTED AND HAD NO PRODUCERS. `notices.ts` has a
// board, dedupe, a cap, a transient surface, a permanent log and sound cues, all
// built and all tested — and `notify()` was called by nothing at all. It was a
// display with no input, so every refusal `flow.ts` raises reached only the
// panel it happened in: exactly the failure that file's own header names,
// "anything that happened in a window you had closed happened silently."
//
// ---------------------------------------------------------------------------
// ⚠ WHY A TABLE, AND NOT ~45 HAND-WRITTEN CALLS TO `notify()`
//
// Wiring each raise site by hand means the refusal somebody adds next year is
// silent again until they remember this file exists. Every one of them already
// lands in a STORE SLICE, and the slices are the choke point: watch those and a
// source is covered by construction.
//
// ---------------------------------------------------------------------------
// ⚠ ONLY FIELDS THAT RECORD SOMETHING THAT HAPPENED. NOT LOAD ERRORS.
//
// Roughly half the slices also carry a plain `error` — dogma, assets, rewards,
// space, planets, chat, the agent finder. Those are deliberately NOT here. An
// `error` is the STATE of a panel you just opened and are looking at; an
// `actionError` or a `silentDecline` is an EVENT, something that happened
// because a button was pressed or a bot ticked, and an event is the only thing
// worth throwing across the middle of the screen. Flashing load state would
// also mean re-flashing it every time a poll retried and failed.
//
// `mining.holdsError` is the one load failure in the list, and it earns its
// place: the holds are read in the BACKGROUND of a mining run, by a player who
// is watching space and not the holds. A load failure nobody is looking at is
// the same shape as an event.
//
// ---------------------------------------------------------------------------
// ⚠ WHAT THIS DOES NOT DO: REPLACE THE INLINE ERROR AT THE CONTROL
//
// R30's rule stands — the reason a button did nothing belongs ON that button,
// where the player is already looking. The flash is for what they would
// otherwise MISS: something raised by a panel they do not have open, or that
// they did not press at all (a bot, the server, another client). Nothing is
// removed from a panel to make room for it.

import type { NoticeKind } from "./notices.ts";

/** One watched field on one slice. */
export interface NoticeSource {
  /** The slice's name on the store, e.g. "mining". */
  readonly slice: string;
  /** The field on it that carries a message, or null when nothing is wrong. */
  readonly field: string;
  readonly kind: NoticeKind;
  /**
   * What to call it on the flash's first line. Never the slice's own name:
   * "mining" is a variable, "Mining" is what a player calls the panel.
   */
  readonly title: string;
}

/**
 * Every slice field that carries something worth telling a player.
 *
 * ⚠ `silentDecline` MATTERS MORE THAN `actionError`, NOT LESS. A refusal at
 * least says something; a silent decline is the server accepting a call and
 * then not doing it, which is the failure this whole client exists to make
 * visible. It is a WARNING and not a danger: nothing broke, something simply
 * did not happen.
 */
export const NOTICE_SOURCES: readonly NoticeSource[] = [
  { slice: "flight", field: "actionError", kind: "danger", title: "Flight" },
  { slice: "targeting", field: "actionError", kind: "danger", title: "Targeting" },
  { slice: "targeting", field: "silentDecline", kind: "warn", title: "Targeting" },
  { slice: "mining", field: "actionError", kind: "danger", title: "Mining" },
  { slice: "mining", field: "silentDecline", kind: "warn", title: "Mining" },
  { slice: "mining", field: "holdsError", kind: "warn", title: "Mining holds" },
  { slice: "drones", field: "actionError", kind: "danger", title: "Drones" },
  { slice: "drones", field: "silentDecline", kind: "warn", title: "Drones" },
  { slice: "inventory", field: "actionError", kind: "danger", title: "Inventory" },
  { slice: "fitting", field: "actionError", kind: "danger", title: "Fitting" },
  { slice: "industry", field: "actionError", kind: "danger", title: "Industry" },
  { slice: "market", field: "actionError", kind: "danger", title: "Market" },
  { slice: "mail", field: "actionError", kind: "danger", title: "Mail" },
  { slice: "agents", field: "actionError", kind: "danger", title: "Agents" },
  { slice: "skills", field: "actionError", kind: "danger", title: "Skills" },
  { slice: "fleet", field: "actionError", kind: "danger", title: "Fleet" },
];

/**
 * The dedupe key for one source's message.
 *
 * ⚠ IT INCLUDES THE MESSAGE, NOT JUST THE SOURCE. Two different refusals from
 * the same panel are two events and both deserve saying; the same refusal
 * re-observed is one. Keying on the source alone would swallow the second of
 * two genuinely different failures, which is the more expensive mistake.
 */
export function noticeKey(source: NoticeSource, message: string): string {
  return `${source.slice}.${source.field}:${message}`;
}

/**
 * The message a slice is currently carrying, or null for "nothing is wrong".
 *
 * ⚠ AN EMPTY STRING IS NOT A MESSAGE. These fields are `string | null` by
 * contract, but a flash with no words in it is worse than no flash at all, so
 * anything that trims to nothing reads as absent. Same for a non-string: this
 * walks a field name that is checked by no compiler, and a wrong guess must
 * come back silent rather than render `[object Object]` at a player.
 */
export function messageOf(slice: unknown, field: string): string | null {
  if (slice === null || typeof slice !== "object") {
    return null;
  }
  const value = (slice as Record<string, unknown>)[field];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
