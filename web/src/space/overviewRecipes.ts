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
import { hideCategoriesFor, type HideCategoryID } from "./hideCategory.ts";
import { isHostile } from "./overview.ts";
import type { StanceContext } from "./stance.ts";

export type OverviewRecipeID = "all" | "system" | "pve" | "mining" | "travel";

export interface OverviewRecipe {
  readonly id: OverviewRecipeID;
  /** What the player sees in the tab-creation picker. */
  readonly label: string;
  /** What the recipe is for, shown as its tooltip. */
  readonly hint: string;
  /**
   * ⚠ THE EXCLUSIONS, NOT THE INCLUSIONS. Every tab starts from "everything
   * visible" and a recipe removes what it does not want — the same direction as
   * pressing Hide, and for the same reason: the thing a player hides is a thing
   * they can name, so the thing a preset hides must be nameable too.
   *
   * ⚠ THESE ARE THE HIDE BUTTON'S CATEGORIES, so a preset's exclusion list IS
   * its Hidden Items list. There is one classifier and one vocabulary, and a
   * tab that hides "Rocks" because its recipe says so is hiding them by exactly
   * the same rule as a player who pressed Hide on a rock.
   *
   * ⚠ EMPTY MEANS "HIDE NOTHING" — `all` is the empty set, not a null.
   */
  readonly hides: ReadonlySet<HideCategoryID>;
}

const set = (...ids: HideCategoryID[]): ReadonlySet<HideCategoryID> => new Set(ids);

/** The recipes, in the order they are offered when creating a tab. */
export const OVERVIEW_RECIPES: readonly OverviewRecipe[] = [
  {
    id: "all",
    label: "All",
    hint: "Everything on the grid.",
    hides: set(),
  },
  {
    id: "system",
    label: "System",
    hint: "The whole system: ships, structures, drones, wrecks, gates and celestials.",
    // Everything except the rocks — the retail overview's own first tab.
    // ⚠ SCENERY STAYS. System is the general "what is around me" view, and the
    // static clutter is part of that answer; it is the ROCKS a pilot flying past
    // a belt does not want in the way. The combat tabs below do hide scenery.
    hides: set("asteroid"),
  },
  {
    id: "pve",
    label: "PVE",
    hint: "Ships, police, drones and wrecks — plus the gates and stations you run to.",
    // ⚠ STATIONS AND GATES STAY OUT OF THE EXCLUSIONS, reported missing in game:
    // a combat filter that hides the dock hides the way out of the fight.
    hides: set(
      "asteroid",
      "scenery",
      "planet",
      "moon",
      "celestial",
      "container",
      "turret",
      "structure",
    ),
  },
  {
    id: "mining",
    label: "Mining",
    hint: "Rocks, and the places to unload them.",
    // Stations because a full hold is the other half of a mining trip.
    hides: set(
      "ship",
      "police",
      "wreck",
      "gate",
      "celestial",
      "planet",
      "moon",
      "scenery",
      "container",
      "turret",
      "structure",
    ),
  },
  {
    id: "travel",
    label: "Travel",
    hint: "Gates, stations and celestials — the things you fly to.",
    hides: set(
      "ship",
      "police",
      "drone",
      "wreck",
      "asteroid",
      "scenery",
      "container",
      "turret",
      "structure",
    ),
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
  // ⚠ "pvp" ANSWERS AS PVE RATHER THAN FALLING BACK TO ALL. A saved bar can name
  // a tab's recipe id, and PVP was one of the five a profile shipped with.
  // Falling back to All would silently turn that player's PVP tab into a
  // show-everything tab; answering as PVE keeps it a combat tab. The distinction
  // it used to carry — hiding your own side — now lives in the toolbar toggles.
  pvp: "pve",
};

/**
 * ⚠ `All` IS NOT A DEFAULT TAB LIKE THE OTHERS, and the difference is not
 * cosmetic: it is the one tab a player cannot delete, because it is the only
 * one that shows everything. The five that DO ship as editable defaults are
 * in `DEFAULT_TAB_RECIPES`.
 */
export const ALL_RECIPE: OverviewRecipeID = "all";

/**
 * ⚠ FIVE TABS, NOT SIX. "PVP" existed only to pre-hide your own side by stance,
 * and that job now belongs to the two standing toggles on the toolbar, which do
 * it for every ship on the grid rather than one preset at a time. Left in place
 * it would have been a second tab with an identical exclusion list.
 */
export const DEFAULT_TAB_RECIPES: readonly OverviewRecipeID[] = [
  "system",
  "pve",
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
 * Does this recipe show this object?
 *
 * ⚠ AN EXCLUSION TEST ON THE CATEGORY, THE SAME ONE THE HIDE BUTTON USES. The
 * recipe names categories to remove; this asks whether this object is one of
 * them. There is no second vocabulary and no second direction.
 *
 * ⚠ THE HOSTILE CLAUSE IS FIRST AND UNCONDITIONAL. A filter is a convenience
 * and a threat is not something a convenience removes — so a recipe naming
 * "ship" does not reach a rat.
 */
export function recipeAllows(recipe: OverviewRecipe, entity: SpaceEntity): boolean {
  if (isHostile(entity)) {
    return true;
  }
  return !recipe.hides.has(hideCategoriesFor(entity)[0] ?? "other");
}

/** Filter a list of objects through a recipe, keeping their order. */
export function applyRecipe<T extends SpaceEntity>(
  entities: readonly T[],
  recipe: OverviewRecipe,
  context: StanceContext | null = null,
): readonly T[] {
  // ⚠ `context` IS KEPT IN THE SIGNATURE but no longer read: hiding your own side
  // is the toolbar toggles' job now, so a recipe no longer looks at stance at
  // all. The parameter stays so callers keep compiling and so the day a recipe
  // needs a side again it does not become a breaking change.
  void context;
  if (recipe.hides.size === 0) {
    return entities;
  }
  return entities.filter((entity) => recipeAllows(recipe, entity));
}
