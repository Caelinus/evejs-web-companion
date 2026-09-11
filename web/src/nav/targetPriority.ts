// Which hostile to shoot FIRST. A fight is decided by what dies in what order:
// the frigate holding you down is worth more dead than the battleship you could
// simply have warped away from. Every combat block until now shot whatever was
// NEAREST, which is the one ordering that ignores the question entirely.
//
// ⚠ HULL CLASS IS A PROXY, AND IT IS THE ONLY ONE THERE IS. Nothing in a grid
// read says what a ship has FITTED — a snapshot row carries position, health,
// owner and type, never modules — and no read tells this client "that one is
// pointing me". So a class here is the job the HULL was built for, read from
// the game's own group name: an Interceptor is tackle because that is what
// interceptors are for, not because this one was seen holding anybody. A
// battleship with a scrambler on it reads "other" and a Logistics hull with no
// reps fitted still reads "logi". Said plainly so nobody reads more into a
// class than it carries — this is a better opening guess than distance, not
// knowledge of the enemy fit.
//
// The group name is resolved through /api/names (`typeGroup`), the same
// resolve-then-judge pass nav/droneRoles.ts makes: the game says what a hull IS
// and this file only reads the answer. Matched EXACTLY (trimmed, lowercased)
// against the SDE's own ship-group names — verified against the local SDE
// (`groups.jsonl`, categoryID 6, the build src/config.js pins):
//
//   tackle  831 "Interceptor", 541 "Interdictor", 894 "Heavy Interdiction Cruiser"
//   ewar    893 "Electronic Attack Ship", 833 "Force Recon Ship", 906 "Combat Recon Ship"
//   logi    832 "Logistics", 1527 "Logistics Frigate", 1538 "Force Auxiliary"
//
// EXACT, never a loose /recon/i or /logi/i, for the same reason droneRoles.ts
// anchors its patterns: "Prototype Exploration Ship" and "Industrial Command
// Ship" are neither of those things, and a substring match against a localised
// name is how a hauler ends up primaried.

import type { TargetClassArg } from "../bots/botScript.ts";

/**
 * The job a hull was built for, as far as a grid read can tell. The vocabulary
 * itself belongs to the document format (a saved script carries the player's
 * ordering of it), so it is named there and only interpreted here.
 */
export type TargetClass = TargetClassArg;

/**
 * The shipped order, and the order unlisted classes keep among themselves.
 *
 * Tackle first because it is what stops the ship LEAVING — every other problem
 * on the grid has an exit while it is alive. Ewar second because it stops the
 * ship FIGHTING (a jammed hull cannot shoot the tackle either). Logi third
 * because it undoes damage rather than dealing it. Everything else last, which
 * is where the old nearest-first behaviour lives on: within one class the
 * nearest is still taken first.
 */
export const DEFAULT_TARGET_PRIORITY: readonly TargetClass[] = ["tackle", "ewar", "logi", "other"];

const TACKLE_GROUPS = new Set(["interceptor", "interdictor", "heavy interdiction cruiser"]);
const EWAR_GROUPS = new Set(["electronic attack ship", "force recon ship", "combat recon ship"]);
const LOGI_GROUPS = new Set(["logistics", "logistics frigate", "force auxiliary"]);

/**
 * The class for a resolved group name. `null` = the group has not resolved (or
 * could not be read) — cannot tell, which is NEVER promoted: an unclassified
 * hull is ranked with "other" rather than guessed into a class it may not be.
 */
export function targetClassForGroup(groupName: string | null | undefined): TargetClass | null {
  if (groupName === null || groupName === undefined) {
    return null;
  }
  const name = groupName.trim().toLowerCase();
  if (TACKLE_GROUPS.has(name)) {
    return "tackle";
  }
  if (EWAR_GROUPS.has(name)) {
    return "ewar";
  }
  if (LOGI_GROUPS.has(name)) {
    return "logi";
  }
  return "other";
}

/**
 * Where a class sits in one player's ordering.
 *
 * ⚠ A PRIORITY LIST IS A RANKING, NOT A FILTER. This is the one place it
 * differs from the mine block's ore list, which mines ONLY what it names and
 * blocks when none is left: a combat block that refused to shoot anything off
 * its list would sit there being killed by the battleship it had no line for.
 * So a class the player left out ranks AFTER every class they listed, in the
 * shipped default order — last in line, never unshootable.
 */
function rankOf(cls: TargetClass | null, priority: readonly TargetClass[]): number {
  const known: TargetClass = cls ?? "other";
  const listed = priority.indexOf(known);
  return listed >= 0 ? listed : priority.length + DEFAULT_TARGET_PRIORITY.indexOf(known);
}

// ── fleet tags ───────────────────────────────────────────────────────────────
//
// ⚠ THE ALPHABET IS OURS, AND THE READER MUST TOLERATE ANYTHING. There is NO
// tag vocabulary on the server — the broadcast decoder trims and accepts any
// non-empty string, no allowlist and no ordering exists there. STOCK_TAG_ORDER
// below is this client's OWN opinion about the stock game client's tag menu
// (the only tags a human FC clicking through that menu can actually send), not
// a protocol constraint. A non-stock client, or a hand-typed broadcast, can
// carry any string at all, and fleetTagRank MUST still return a finite rank
// for it (see the fallback below) — never treat "not in our list" as "drop
// it", or a tag this code has not heard of silently stops being a target the
// fleet singled out.
//
// Digits before letters: a digit tag reads as an ordinal kill order (1st,
// 2nd, ...) — the most explicit "shoot this now" a human can send — so the
// whole digit group outranks the whole letter group, which carries no
// inherent order of its own. Within digits, keyboard-row order (1-9 then 0)
// rather than numeric order: these are quick-select hotkeys, and 0 sits after
// 9 on every keyboard row they'd be bound to. Within letters, the menu's own
// listed order (A-J, then the classic K-W gap, then X Y Z) — there is no
// other signal to rank them by, so the order the menu presents them in is the
// order kept.
const STOCK_TAG_ORDER: readonly string[] = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "X", "Y", "Z",
];

const STOCK_TAG_RANK: ReadonlyMap<string, number> = new Map(
  STOCK_TAG_ORDER.map((tag, index) => [tag, index]),
);

/**
 * Where a fleet-assigned tag sits in the kill order. Lower ranks first, same
 * convention as `rankOf`.
 *
 * An absent tag (null, undefined, or all-whitespace) ranks below every real
 * tag — POSITIVE_INFINITY, so it only wins when nothing tagged is on the
 * grid. A tag outside STOCK_TAG_ORDER — ⚠ which the server tolerates and this
 * function must too — ranks at STOCK_TAG_ORDER.length: worse than every
 * recognised tag, but still finite, so it is never mistaken for "no tag" and
 * never dropped. Matched case-insensitively: a hand-typed "a" and the menu's
 * "A" are the same instruction.
 */
export function fleetTagRank(tag: string | null | undefined): number {
  if (tag === null || tag === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const trimmed = tag.trim();
  if (trimmed.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const known = STOCK_TAG_RANK.get(trimmed.toUpperCase());
  return known ?? STOCK_TAG_ORDER.length;
}

/**
 * The row to shoot first: the fleet's tag wins, class breaks that tie,
 * nearest breaks what's left.
 *
 * Shaped like `splitDroneRoles` — the caller hands in how to read a row's type
 * and distance and how to resolve a group name, so this stays pure and both
 * combat call sites (overview rows with a measured distance, snapshot entities
 * measured against the ship) can use the one ordering.
 *
 * ⚠ TAG OUTRANKS CLASS, DELIBERATELY. Class priority is this client's own
 * guess at what matters most on a grid it cannot see modules on (see the
 * file-header note). A tag is not a guess — it is the fleet commander looking
 * at the fight and saying "this one, now". When the two disagree the human
 * wins, so tag is compared FIRST, class second, distance last.
 *
 * `tagOf` is optional and defaults to "nothing is tagged" (every row ties at
 * POSITIVE_INFINITY), which collapses the ordering back to exactly the old
 * (class, distance) behaviour — every caller that does not pass it keeps its
 * current result unchanged.
 *
 * A row whose distance is unreadable sorts last WITHIN its tag-and-class
 * group rather than being dropped: an unmeasurable ship is still a ship, and
 * dropping it would hand the fight to whatever the measurement happened to
 * miss. Ties keep the order the caller passed, so a nearest-first list stays
 * nearest-first.
 */
export function pickPrimary<T>(
  rows: readonly T[],
  typeIDOf: (row: T) => number | null,
  distanceOf: (row: T) => number | null,
  groupOf: (typeID: number) => string | null,
  priority: readonly TargetClass[] = DEFAULT_TARGET_PRIORITY,
  tagOf: (row: T) => string | null | undefined = () => null,
): T | null {
  let best: T | null = null;
  let bestTagRank = Number.POSITIVE_INFINITY;
  let bestClassRank = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const typeID = typeIDOf(row);
    const cls = targetClassForGroup(typeID === null ? null : groupOf(typeID));
    const classRank = rankOf(cls, priority);
    const tagRank = fleetTagRank(tagOf(row));
    const distance = distanceOf(row) ?? Number.POSITIVE_INFINITY;
    const better =
      tagRank < bestTagRank ||
      (tagRank === bestTagRank &&
        (classRank < bestClassRank || (classRank === bestClassRank && distance < bestDistance)));
    if (better) {
      best = row;
      bestTagRank = tagRank;
      bestClassRank = classRank;
      bestDistance = distance;
    }
  }
  return best;
}
