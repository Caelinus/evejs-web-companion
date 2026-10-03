// OVERVIEW RECIPES (goal R79) — the FOUR filter recipes the overview offers.
//
// A busy grid is a couple of hundred objects, and a pilot only ever wants a
// slice of it: rocks while mining, gates and stations while travelling, ships
// and wrecks while fighting. Retail solves this with a row of tabs across the
// top of the overview.
//
// ---------------------------------------------------------------------------
// R90 (SECOND PASS): THESE ARE RECIPES, NOT TABS
//
// There are exactly four of these and they are NOT the tab row any more. They
// are the options a player picks FROM when creating their own tab, plus the
// three that ship as the starting tabs. The tab row itself is the player's:
// named, ordered, editable, deletable — see `overviewTabs.ts`.
//
// ⚠ `All` IS BOTH A RECIPE AND THE ONE FIXED TAB. It is the only recipe whose
// filter admits everything, which is exactly why it is the one tab a player
// cannot rename, delete, or reorder into a different place. The two facts are
// the same fact: a tab with no filter IS the "show everything" tab, and a
// second one would be a duplicate of it wearing a different name.
//
// ---------------------------------------------------------------------------
// WHY RECIPES ARE DEFINED OVER `bracketRole`, NOT OVER `groupID`
//
// The obvious implementation is a list of group ids per recipe. It is also the
// one that goes wrong: the ids are a server-side taxonomy this client is not the
// authority on, a recipe written against them silently stops matching when the
// world data changes, and — worst — the tactical viewport already classifies
// every object through `bracketRole` for its colours. Two classifications would
// mean the picture and the list disagreeing about what a thing IS, so a rock
// could be drawn in the ore colour and filtered out of a Mining tab at the same
// time.
//
// So a recipe is a set of ROLES, and `bracketRole` is the single classifier.
// Adding a role to the game means deciding once which recipes it belongs to.
//
// ---------------------------------------------------------------------------
// ⚠ NO RECIPE CAN HIDE SOMETHING THAT IS SHOOTING AT YOU
//
// Every recipe includes hostiles, whatever else it selects. A filter is a
// convenience; a threat is not something a convenience may remove from the
// screen. This is the same rule `hostileRows` already enforces for the threat
// block (it deliberately ignores every filter and is never capped), applied here
// so the two cannot disagree.
//
// It is also the honest reading of what a recipe is FOR. Someone who picks
// "Mining" is saying "show me the rocks", not "stop telling me about the
// frigate that just landed on me".

import type { SpaceEntity } from "../store/types.ts";
import { bracketRole, type TacticalRole } from "./tactical.ts";

export type OverviewRecipeID = "all" | "mining" | "travel" | "combat";

export interface OverviewRecipe {
  readonly id: OverviewRecipeID;
  /** What the player sees in the tab-creation picker. */
  readonly label: string;
  /** What the recipe is for, shown as its tooltip. */
  readonly hint: string;
  /**
   * The roles this recipe shows, or null for "everything". Hostiles are added
   * on top of this set by `recipeAllows` and never need listing.
   */
  readonly roles: ReadonlySet<TacticalRole> | null;
}

const set = (...roles: TacticalRole[]): ReadonlySet<TacticalRole> => new Set(roles);

/** The recipes, in the order they are offered when creating a tab. */
export const OVERVIEW_RECIPES: readonly OverviewRecipe[] = [
  {
    id: "all",
    label: "All",
    hint: "Everything on the grid.",
    roles: null,
  },
  {
    id: "mining",
    label: "Mining",
    hint: "Rocks, and the places to unload them.",
    // Stations because a full hold is the other half of a mining trip.
    roles: set("asteroid", "station", "drone"),
  },
  {
    id: "travel",
    label: "Travel",
    hint: "Gates, stations and celestials — the things you fly to.",
    roles: set("gate", "station", "celestial"),
  },
  {
    id: "combat",
    label: "Combat",
    hint: "Ships, drones and wrecks.",
    roles: set("ship", "police", "drone", "wreck"),
  },
];

/**
 * ⚠ `All` IS NOT A DEFAULT TAB LIKE THE OTHERS, and the difference is not
 * cosmetic: it is the one tab a player cannot delete, because it is the only
 * one that shows everything. The three that DO ship as editable defaults are in
 * `DEFAULT_TAB_RECIPES`.
 */
export const ALL_RECIPE: OverviewRecipeID = "all";

/** The three editable tabs a new profile starts with, in order. */
export const DEFAULT_TAB_RECIPES: readonly OverviewRecipeID[] = ["mining", "travel", "combat"];

/** The recipe for an id, falling back to All for anything unrecognised. */
export function recipeByID(id: OverviewRecipeID | string): OverviewRecipe {
  return (
    OVERVIEW_RECIPES.find((recipe) => recipe.id === id) ??
    (OVERVIEW_RECIPES[0] as OverviewRecipe)
  );
}

/**
 * Does this recipe show this object?
 *
 * ⚠ THE HOSTILE CLAUSE IS FIRST AND UNCONDITIONAL. See the note at the top: a
 * filter is a convenience and a threat is not something a convenience removes.
 */
export function recipeAllows(recipe: OverviewRecipe, entity: SpaceEntity): boolean {
  const role = bracketRole(entity);
  if (role === "hostile") {
    return true;
  }
  if (recipe.roles === null) {
    return true;
  }
  return recipe.roles.has(role);
}

/** Filter a list of objects through a recipe, keeping their order. */
export function applyRecipe<T extends SpaceEntity>(
  entities: readonly T[],
  recipe: OverviewRecipe,
): readonly T[] {
  if (recipe.roles === null) {
    return entities;
  }
  return entities.filter((entity) => recipeAllows(recipe, entity));
}