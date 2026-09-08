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

/**
 * The row to shoot first: best class wins, nearest breaks the tie.
 *
 * Shaped like `splitDroneRoles` — the caller hands in how to read a row's type
 * and distance and how to resolve a group name, so this stays pure and both
 * combat call sites (overview rows with a measured distance, snapshot entities
 * measured against the ship) can use the one ordering.
 *
 * A row whose distance is unreadable sorts last WITHIN its class rather than
 * being dropped: an unmeasurable ship is still a ship, and dropping it would
 * hand the fight to whatever the measurement happened to miss. Ties keep the
 * order the caller passed, so a nearest-first list stays nearest-first.
 */
export function pickPrimary<T>(
  rows: readonly T[],
  typeIDOf: (row: T) => number | null,
  distanceOf: (row: T) => number | null,
  groupOf: (typeID: number) => string | null,
  priority: readonly TargetClass[] = DEFAULT_TARGET_PRIORITY,
): T | null {
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const typeID = typeIDOf(row);
    const cls = targetClassForGroup(typeID === null ? null : groupOf(typeID));
    const rank = rankOf(cls, priority);
    const distance = distanceOf(row) ?? Number.POSITIVE_INFINITY;
    if (rank < bestRank || (rank === bestRank && distance < bestDistance)) {
      best = row;
      bestRank = rank;
      bestDistance = distance;
    }
  }
  return best;
}
