// OVERVIEW RECIPES (goal R79, iteration 5) — the filter recipes the overview
// offers.
//
// A busy grid is a couple of hundred objects, and a pilot only ever wants a
// slice of it: rocks while mining, gates and stations while travelling, ships
// and wrecks while fighting. Retail solves this with a row of tabs across the
// top of the overview, and its own presets prove the two axes they work on:
// WHICH ROLES ("System", "Warp", "Ships") and, for the ship-carrying roles,
// WHICH SIDE OF THE GRID THEY ARE ON ("red", "Friendly"). A recipe is a role
// set, and it may pre-select stance hides on top of it — the two axes the
// retail presets use, nothing else.
//
// ---------------------------------------------------------------------------
// R90 (SECOND PASS): THESE ARE RECIPES, NOT TABS
//
// They are the options a player picks FROM when creating their own tab, plus
// the five that ship as the starting tabs. The tab row itself is the player's:
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
// one that goes wrong: the ids are a server-side taxonomy this client is not
// the authority on, a recipe written against them silently stops matching when
// the world data changes, and — worst — the tactical viewport already
// classifies every object through `bracketRole` for its colours. Two
// classifications would mean the picture and the list disagreeing about what a
// thing IS, so a rock could be drawn in the ore colour and filtered out of a
// Mining tab at the same time.
//
// So a recipe is a set of ROLES, and `bracketRole` is the single classifier.
// Adding a role to the game means deciding once which recipes it belongs to.
//
// ---------------------------------------------------------------------------
// THE STANCE AXIS: WHAT A RECIPE MAY HIDE AND WHAT IT MAY NOT
//
// ⚠ NO RECIPE CAN HIDE SOMETHING THAT IS SHOOTING AT YOU, BY ROLE. Every
// recipe includes hostiles, whatever else it selects. A filter is a
// convenience; a threat is not something a convenience removes from the
// screen. This is the same rule `hostileRows` already enforces for the threat
// block (it deliberately ignores every filter and is never capped), applied
// here so the two cannot disagree.
//
// ⚠ BUT A RECIPE MAY SAY "HIDE THE FRIENDLY SHIPS", AND THAT IS A DIFFERENT
// KIND OF CHOICE. `stancePreHides` names a role AND a side — "hide ships that
// are ours, keep the rest" — which is the retail presets' own move. Naming the
// side keeps the safety rule intact: no default recipe pre-hides the hostile
// stance, so every recipe still shows everything that is hostile, and hiding a
// hostile requires NAMING it — either a recipe entry or the player's own
// "Hostiles" hide — never an accident of a group.

import type { SpaceEntity } from "../store/types.ts";
import { bracketRole, type TacticalRole } from "./tactical.ts";
import { stanceOf, type Stance, type StanceContext } from "./stance.ts";

export type OverviewRecipeID = "all" | "system" | "pve" | "pvp" | "mining" | "travel";

/** One role-and-side the preset pre-hides: "hide ships that are friendly". */
export interface RecipeStancePreHide {
  readonly role: string;
  readonly stance: Stance;
}

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
  /**
   * The stance hides the preset pre-selects, when it has any. Consulted
   * between the tab's own lists and the role allow-list — see
   * `recipePreHidesStance`.
   */
  readonly stancePreHides?: readonly RecipeStancePreHide[];
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
    id: "system",
    label: "System",
    hint: "The whole system: ships, structures, drones, wrecks, gates and celestials.",
    // Everything except the rocks — the retail overview's own first tab.
    roles: set("ship", "police", "drone", "wreck", "station", "gate", "celestial"),
  },
  {
    id: "pve",
    label: "PVE",
    hint: "Ships, police, drones and wrecks — plus the gates and stations you run to.",
    // ⚠ STATIONS AND GATES TOO, reported missing in game. A combat filter that
    // omits them hides the way out of the fight and the way back into it, which
    // is the opposite of what a combat tab is for.
    roles: set("ship", "police", "drone", "wreck", "station", "gate"),
  },
  {
    id: "pvp",
    label: "PVP",
    hint: "What PVE shows, minus your own side — and the places you escape to.",
    // Same roles as PVE, plus the STATION and GATE a fight runs to or from. A PvP
    // filter that hides the station is hiding the escape: reported in game, and
    // the pilot is left without a way to dock out of the fight they chose.
    roles: set("ship", "police", "drone", "wreck", "station", "gate"),
    stancePreHides: [
      { role: "ship", stance: "friendly" },
      { role: "drone", stance: "friendly" },
      { role: "wreck", stance: "friendly" },
    ],
  },
  {
    id: "mining",
    label: "Mining",
    hint: "Rocks, and the places to unload them.",
    // Stations because a full hold is the other half of a mining trip. A lone
    // neutral ship near the belt is noise; your logi (friendly) and the rats
    // (hostile, role-forced) stay.
    roles: set("asteroid", "station", "drone"),
    stancePreHides: [{ role: "ship", stance: "neutral" }],
  },
  {
    id: "travel",
    label: "Travel",
    hint: "Gates, stations and celestials — the things you fly to.",
    roles: set("gate", "station", "celestial"),
  },
];

/**
 * The ids a saved bar may still hold from earlier versions, answered as the
 * recipe they renamed into. "Combat" became "PVE" in the preset refresh —
 * the same roles, a truer name — and a tab that named it keeps working
 * instead of falling back to All and quietly showing the whole grid.
 *
 * ⚠ AN ALIAS, NOT A RECIPE. It is never rendered and never offered; it only
 * keeps the player's saved bar from being rewritten under them.
 */
const RECIPE_ALIASES: Readonly<Record<string, OverviewRecipeID>> = {
  combat: "pve",
};

/**
 * ⚠ `All` IS NOT A DEFAULT TAB LIKE THE OTHERS, and the difference is not
 * cosmetic: it is the one tab a player cannot delete, because it is the only
 * one that shows everything. The five that DO ship as editable defaults are
 * in `DEFAULT_TAB_RECIPES`.
 */
export const ALL_RECIPE: OverviewRecipeID = "all";

/** The five editable tabs a new profile starts with, in order. */
export const DEFAULT_TAB_RECIPES: readonly OverviewRecipeID[] = [
  "system",
  "pve",
  "pvp",
  "mining",
  "travel",
];

/** The recipe for an id, falling back to All for anything unrecognised. */
export function recipeByID(id: OverviewRecipeID | string): OverviewRecipe {
  const known = RECIPE_ALIASES[id] ?? id;
  return (
    OVERVIEW_RECIPES.find((recipe) => recipe.id === known) ??
    (OVERVIEW_RECIPES[0] as OverviewRecipe)
  );
}

/**
 * Does this recipe show this object, by ROLE?
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

/**
 * Does this recipe's preset PRE-HIDE this object by stance — "hide the
 * friendly ships", said in advance, the way the retail presets do?
 *
 * ⚠ AN ENTRY NAMES A SIDE, SO IT MAY REACH A HOSTILE IF IT SAYS SO. The role
 * rule above never hides a hostile, and no default recipe pre-hides the
 * hostile stance — but a stance entry that DID would be honoured, because it
 * is the explicit choice the relaxed invariant allows: specificity beats
 * generality.
 */
export function recipePreHidesStance(
  recipe: OverviewRecipe,
  entity: SpaceEntity,
  context: StanceContext | null,
): boolean {
  const preHides = recipe.stancePreHides;
  if (preHides === undefined || preHides.length === 0) {
    return false;
  }
  const role = bracketRole(entity);
  const stance = stanceOf(entity, context);
  return preHides.some((entry) => entry.role === role && entry.stance === stance);
}

/** Filter a list of objects through a recipe, keeping their order. */
export function applyRecipe<T extends SpaceEntity>(
  entities: readonly T[],
  recipe: OverviewRecipe,
  context: StanceContext | null = null,
): readonly T[] {
  if (recipe.roles === null && recipe.stancePreHides === undefined) {
    return entities;
  }
  return entities.filter(
    (entity) => recipeAllows(recipe, entity) && !recipePreHidesStance(recipe, entity, context),
  );
}
