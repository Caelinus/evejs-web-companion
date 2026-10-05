// HIDE CATEGORIES (PLAN.txt goal 2) — WHAT THE PLAYER HIDES BY.
//
// The overview used to hide by EVE's `groupID`, which is a very fine taxonomy:
// the real SDE (build 3396210) carries 1605 groups, so "Planet" (7), "Moon" (8)
// and "Frigate" (25) are each their own entry. That is precise and it is also
// unusable as an interface — a player reading a list of buttons wants "hide the
// scenery", not a decision between 49 ore groups.
//
// This module is the replacement axis: a small, player-facing set of CATEGORIES,
// decided from the object's group first and its runtime kind second. It is a
// SEPARATE classifier from `bracketRole` on purpose:
//
// ⚠ TWO CLASSIFIERS, TWO JOBS, AND THEY MUST NOT BE CONFUSED.
// `bracketRole` answers "what colour is this on the radar" and is deliberately
// coarse — ten roles, one catch-all. This answers "what may the player hide",
// and is finer where hiding benefits. They are allowed to disagree about an
// object, and they usually do: a Stargate is the `gate` role AND the `gate`
// category, but a Large Collidable Object is the `scenery` category while
// `bracketRole` still calls it a `ship`.
//
// ⚠ WHY THE OLD CATCH-ALL WAS THE BUG. `bracketRole` ends with
// `return "ship"` (tactical.ts), so anything it did not recognise became a ship.
// Group 226 — literally named "Large Collidable Object", a category-2 Celestial,
// i.e. static scenery — matched none of the earlier tests and fell through to
// `ship`. A player who hid "Ships" to silence the scenery lost their real ships
// with it. Here the same object is `scenery`, and hiding `ship` no longer
// reaches it.
//
// ⚠ THE GROUP IS THE PRIMARY KEY, NOT THE KIND. The runtime `kind` is coarse and
// lossy — everything the server did not tag arrives as a plain string, and a
// group is a fact about the TYPE, which is what the player is actually looking
// at. The kind is only consulted for a row whose group we could not read, so a
// missing group degrades to something sensible instead of to nothing.
//
// ⚠ NO CATEGORY EVER HIDES A HOSTILE BY ACCIDENT. That rule does not live here
// — it lives in `tabShows`, and it reads whatever entry kind it is given. This
// module stores and matches categories and knows nothing about threats.

import type { SpaceEntity } from "../store/types.ts";

/** The player-facing hide categories, in menu order. */
export type HideCategoryID =
  | "ship"
  | "drone"
  | "turret"
  | "wreck"
  | "gate"
  | "station"
  | "structure"
  | "asteroid"
  | "planet"
  | "moon"
  | "celestial"
  | "scenery"
  | "container"
  | "police"
  | "other";

export interface HideCategory {
  readonly id: HideCategoryID;
  /** The word the menu and the button use. */
  readonly label: string;
  /** One line explaining what it covers, shown as the button's tooltip. */
  readonly hint: string;
}

export const HIDE_CATEGORIES: readonly HideCategory[] = [
  { id: "ship", label: "Ships", hint: "Every hull on the grid, yours and theirs." },
  { id: "drone", label: "Drones", hint: "Drones and fighters in flight." },
  {
    id: "turret",
    label: "Turrets",
    hint: "Sentry guns and batteries — things that shoot at you without moving.",
  },
  { id: "wreck", label: "Wrecks", hint: "Wrecks and hulks worth looting." },
  { id: "gate", label: "Gates", hint: "Stargates and warp gates." },
  { id: "station", label: "Stations", hint: "NPC stations you can dock at." },
  { id: "structure", label: "Structures", hint: "Player-built structures and citadels." },
  { id: "asteroid", label: "Rocks", hint: "Asteroids and the belts they sit in." },
  { id: "planet", label: "Planets", hint: "Planets." },
  { id: "moon", label: "Moons", hint: "Moons." },
  { id: "celestial", label: "Celestials", hint: "Everything else in the system view." },
  {
    id: "scenery",
    label: "Scenery",
    hint: "Static scenery that is not a rock — the things you cannot shoot.",
  },
  { id: "container", label: "Containers", hint: "Cargo and audit containers." },
  { id: "police", label: "Police", hint: "Concord and other law enforcement." },
  { id: "other", label: "Other", hint: "Anything the server did not classify." },
];

/**
 * Group id -> category, for the groups a pilot actually meets on a grid.
 *
 * ⚠ FROM THE REAL SDE, NOT FROM MEMORY. Read out of
 * `eve.js/_local/sde/eve-online-static-data-3396210-jsonl/groups.jsonl`; the
 * numbers below are that build's ids. A wrong id here does not throw — it
 * silently mis-files an object — so `hideCategory.test.ts` checks this table
 * against the SDE rather than trusting it by inspection.
 */
const GROUP_CATEGORY: ReadonlyMap<number, HideCategoryID> = new Map([
  // Rocks and belts. Category 25 is every ore group (49 of them) — all "Rocks"
  // to a pilot, which is exactly the merge this classifier exists for.
  [9, "asteroid"],
  [11, "asteroid"],
  [4430, "asteroid"],
  [4935, "asteroid"],
  [4937, "asteroid"],
  [4938, "asteroid"],
  [4918, "asteroid"],
  // Gates.
  [10, "gate"],
  [366, "gate"],
  [4081, "gate"],
  // Wrecks.
  [186, "wreck"],
  // Drones in flight. The rig/blueprint drone groups are never on a grid and are
  // deliberately absent.
  [273, "drone"],
  [97, "drone"],
  [100, "drone"],
  [101, "drone"],
  [299, "drone"],
  [470, "drone"],
  [544, "drone"],
  [545, "drone"],
  [549, "drone"],
  [639, "drone"],
  [640, "drone"],
  [641, "drone"],
  [1159, "drone"],
  [1452, "drone"],
  // Police.
  [182, "police"],
  [301, "police"],
  // ⚠ SENTRY GUNS AND BATTERIES. Reported unhidable in game: a "Caldari Sentry
  // Gun" carries group 99 ("Sentry Gun") and the runtime gave it no kind this
  // module could read, so it classified as `other` — and `other` is never
  // offered as a button, which is exactly "cannot be hidden". Named here, and
  // backed up by the category fallback below.
  [99, "turret"],
  [180, "turret"],
  [383, "turret"],
  [495, "turret"],
  [417, "turret"],
  [426, "turret"],
  [430, "turret"],
  [449, "turret"],
  [439, "turret"],
  [440, "turret"],
  [441, "turret"],
  [443, "turret"],
  [837, "turret"],
  [877, "turret"],
  [418, "turret"],
  // ⚠ ORBITALS. Also reported unhidable: "Customs Office (<planet>)" carries
  // group 1025 ("Orbital Infrastructure"). These are STATIC and not
  // combat-capable, so they are hideable individually by category but are never
  // reached by the Friendly/Neutral combat toggle — which is the distinction
  // the plan draws.
  [1025, "structure"],
  [1073, "structure"],
  [1106, "structure"],
  [4736, "structure"],
  // Containers.
  [12, "container"],
  [340, "container"],
  [448, "container"],
  [649, "container"],
  // Stations and station services.
  [15, "station"],
  [16, "station"],
  [307, "station"],
  [874, "station"],
  // Planet, moon, and the rest of the system view (all category 2).
  [7, "planet"],
  [8, "moon"],
  [6, "celestial"],
  [1165, "celestial"],
  [995, "celestial"],
  [305, "celestial"],
  [227, "celestial"],
  [312, "celestial"],
  [711, "celestial"],
  [1975, "celestial"],
  [1978, "celestial"],
  [1980, "celestial"],
  [1983, "celestial"],
  [1882, "celestial"],
  // ⚠ 226 IS THE ONE THAT MATTERS. Literally named "Large Collidable Object",
  // category 2. This is the scenery `bracketRole` files under `ship`.
  [226, "scenery"],
  [517, "scenery"],
  [502, "scenery"],
  [885, "scenery"],
  [411, "scenery"],
  [368, "scenery"],
  [336, "scenery"],
  [1071, "scenery"],
  [4719, "scenery"],
  [1971, "scenery"],
  [288, "scenery"],
  [287, "scenery"],
  [298, "scenery"],
]);

// ⚠ THE CATEGORY FALLBACK, AND IT IS WHY NOTHING IS UN-HIDEABLE. A group this
// table has never heard of is not a reason to give up: its `categoryID` still
// says what KIND of thing it is. This is the fix for the in-game report that a
// Sentry Gun and a Customs Office "cannot be hidden" — both reached `other`,
// and `other` is never offered as a button. An unfamiliar group now lands on the
// right broad word instead of on nothing.
const CATEGORY_FALLBACK: Readonly<Record<number, HideCategoryID>> = {
  6: "ship", // Ship
  11: "turret", // Entity — NPCs: sentries, rats, officers, overseers
  18: "drone", // Drone
  16: "drone", // Skill — a drone bucket the client still uses
  87: "drone", // Fighter
  23: "turret", // Starbase — sentries, batteries, mobile arrays
  65: "structure", // Structure
  46: "structure", // Orbitals
  25: "asteroid", // Asteroid
  3: "station", // Station
  2: "celestial", // Celestial
  1: "celestial", // Celestial
};

/**
 * Does this category describe something that can SHOOT AT YOU?
 *
 * PLAN pivot (2026-04-10), and this is the axis the Friendly/Neutral toggles
 * hide on. It is deliberately NOT "mobile": a sentry gun never moves, and it is
 * one of the things a pilot most wants off the screen.
 */
export function isCombatCapable(category: HideCategoryID): boolean {
  return COMBAT_CAPABLE_CATEGORIES.has(category);
}

/** ⚠ THE PLAYER-FACING CATEGORIES THAT CAN SHOOT BACK. */
export const COMBAT_CAPABLE_CATEGORIES: ReadonlySet<HideCategoryID> = new Set<HideCategoryID>([
  "ship",
  "drone",
  "turret",
  "police",
  "wreck",
]);

/**
 * ⚠ THE SDE CATEGORIES THAT CAN SHOOT BACK — read off build 3396210's
 * `categories.jsonl`:
 *   6 Ship (50 groups) · 11 Entity/NPC (410) · 18 Drone (13) · 16 (25)
 *   87 Fighter (6) · 23 Starbase/turrets (34) · 65 Structure (15)
 *
 * ⚠ AND THE ONES DELIBERATELY EXCLUDED, because "not locked in place" is half
 * the rule the plan states: 25 Asteroid, 2/1 Celestial, 3 Station, and
 * **46 Orbitals** — a Customs Office is a structure and IS hideable by
 * category, but it never shoots at you and never moves, so the Friendly/Neutral
 * toggles must not reach it. That distinction is LOST if combat-capable is
 * decided on the player-facing category alone, because player structures (65)
 * and orbitals (46) both file as `structure` — hence this set is on the SDE id.
 */
export const COMBAT_CAPABLE_SDE_CATEGORIES: ReadonlySet<number> = new Set([
  6, 11, 16, 18, 23, 65, 87,
]);

/**
 * Is this OBJECT combat-capable?
 *
 * ⚠ THE SDE CATEGORY WINS WHEN IT IS THERE. It is the only signal that tells a
 * player structure from an orbital, and it is a fact about the type rather than
 * a guess from the runtime. The player-facing category is the fallback, for a row
 * the server sent no category for at all.
 */
export function entityIsCombatCapable(entity: SpaceEntity): boolean {
  const categoryID = entity.categoryID;
  if (typeof categoryID === "number" && categoryID > 0) {
    return COMBAT_CAPABLE_SDE_CATEGORIES.has(categoryID);
  }
  return hideCategoriesFor(entity).some(isCombatCapable);
}

/**
 * The category a runtime `kind` implies, for a row whose group we cannot read.
 *
 * ⚠ A FALLBACK, NOT A CLASSIFIER. Reached only when `groupID` is missing or
 * unknown, so an ungrouped row still has a word instead of nothing.
 */
const KIND_CATEGORY: Readonly<Record<string, HideCategoryID>> = {
  ship: "ship",
  drone: "drone",
  wreck: "wreck",
  station: "station",
  structure: "structure",
  asteroid: "asteroid",
  gate: "gate",
  celestial: "celestial",
  container: "container",
};

/**
 * Every category this object belongs to — one, or `other` when we know nothing.
 *
 * ⚠ NEVER A HOSTILE-SAFE LIST. The returned set is the full classification; the
 * refusal to hide a threat is applied by `tabShows`, so that rule is stated
 * once and cannot drift between here and the resolver.
 *
 * ⚠ THE ORDER IS STABLE. A caller renders these as buttons, and a list that
 * reordered itself between renders would shuffle controls under the cursor.
 */
export function hideCategoriesFor(entity: SpaceEntity): readonly HideCategoryID[] {
  // Law enforcement answers before anything else, for the same reason
  // `isHostile` and `stanceOf` both ask the NPC question first: a Concord hull
  // is a ship by kind and by group, and reading it any other way would file
  // the one NPC that is not a threat as ordinary traffic.
  if (entity.isNpc && entity.npcEntityType === "concord") {
    return ["police"];
  }

  const group = entity.groupID;
  if (typeof group === "number" && Number.isFinite(group) && group > 0) {
    const mapped = GROUP_CATEGORY.get(group);
    if (mapped !== undefined) {
      return [mapped];
    }
    // An ungrouped-but-known group id. Category 6 is the hull category, so a
    // ship the group table has not heard of is still a ship — better than the
    // "scenery by elimination" that made this module necessary.
    if (entity.categoryID === 6) {
      return ["ship"];
    }
    // ⚠ AND THEN THE BROADER FALLBACK, BEFORE `kind`. The SDE category says what
    // KIND of thing this is even when the group is unfamiliar and the runtime
    // kind is missing or nonsense — which is exactly how a Sentry Gun ended up
    // un-hideable. `kind` is consulted only once this has failed, because a
    // coarse runtime string is a worse answer than a category the server sent.
    const categoryID = entity.categoryID;
    if (typeof categoryID === "number" && categoryID > 0) {
      const fallback = CATEGORY_FALLBACK[categoryID];
      if (fallback !== undefined) {
        return [fallback];
      }
    }
  }

  // ⚠ THE ROCK TEST IS THE RUNTIME'S, NOT OURS. A rock is a celestial to the
  // server; what says "rock" is that it was stamped with an ore yield or a
  // remaining quantity. Same proxy `bracketRole` uses, and deliberately the
  // same one — two modules disagreeing about a rock is the bug this file exists
  // to stop.
  if (entity.miningYieldTypeID !== null || entity.remainingQuantity !== null) {
    return ["asteroid"];
  }

  const kind = entity.kind;
  if (typeof kind === "string" && kind !== "") {
    const mapped = KIND_CATEGORY[kind];
    if (mapped !== undefined) {
      return [mapped];
    }
  }

  // ⚠ NOTHING WE KNOW. `other` rather than an empty list, so the row stays
  // hideable; an empty list would refuse the press and the player would read
  // that as a broken button.
  return ["other"];
}

/** Does this object carry this category? */
export function categoryCovers(category: HideCategoryID, entity: SpaceEntity): boolean {
  return hideCategoriesFor(entity).includes(category);
}

/**
 * The hide categories a player may be OFFERED for this object.
 *
 * ⚠ THE OFFER LIST IS NOT THE CLASSIFICATION. `other` is withheld: it is where
 * unclassified rows go, and offering it would put a button on screen that hides
 * nothing — the one thing the old no-groupID refusal existed to prevent.
 */
export function offeredCategoriesFor(entity: SpaceEntity): readonly HideCategoryID[] {
  return hideCategoriesFor(entity).filter((id) => id !== "other");
}

const BY_ID: ReadonlyMap<HideCategoryID, HideCategory> = new Map(
  HIDE_CATEGORIES.map((category) => [category.id, category]),
);

/**
 * Every valid category id, for validating STORED state.
 *
 * ⚠ THE STORAGE SANITIZER NEEDS THIS, AND NEEDS IT TO BE COMPLETE. A stored
 * entry naming anything outside this set is dropped on read rather than coerced,
 * so a hand-edited or stale record can never install a category the classifier
 * would never produce.
 */
export const HIDE_CATEGORY_IDS: ReadonlySet<string> = new Set(HIDE_CATEGORIES.map((c) => c.id));

/** The category's own record, falling back to `other` for anything unknown. */
export function hideCategoryByID(id: HideCategoryID | string): HideCategory {
  return BY_ID.get(id as HideCategoryID) ?? (BY_ID.get("other") as HideCategory);
}