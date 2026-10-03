// THE PLAYER'S OWN OVERVIEW TABS (goal R90, second pass).
//
// R79 gave the overview four fixed tabs. This replaces that with a tab row the
// PLAYER owns: named, ordered, created, renamed, deleted. The recipes live
// in `overviewRecipes.ts` and are what a tab is BUILT FROM — a tab is a name
// plus a recipe, nothing more.
//
// ⚠ WHY TABS AND RECIPES ARE SEPARATE THINGS. The first pass of this feature
// made the tabs the recipes: it held Mining/Travel/Combat plus a Friendlies, an
// Enemies, a Mission and a Hidden, and each decided membership itself. That
// coupled the vocabulary to the model — to show a fleet-mate the tab had to know
// what a fleet-mate IS, which meant reading my own corporation and fleet roster
// on every snapshot and classifying every object against them. A tab the player
// named "Ratting" should be a name and a recipe; nothing about it should have
// opinions about who is friendly.
//
// ⚠ SO NOTHING HERE CLASSIFIES ANY OBJECT. A tab is `{id, name, recipeId}`. The
// recipe decides membership, the recipe decides it by styling role, and no tab
// ever reads the player's identity, a fleet roster, a mission briefing, or an
// object beyond the role `bracketRole` already gives it.
//
// ⚠ PERSISTED, LIKE THE HIDDEN LIST, AND FOR THE SAME REASON. Which tabs a
// pilot has built is their own arrangement of their own screen. It must survive
// a reload, and it must not live in the client store — that holds what the
// SERVER reports, and a snapshot poll must never be able to rewrite a tab bar.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import {
  applyRecipe,
  DEFAULT_TAB_RECIPES,
  recipeByID,
  type OverviewRecipeID,
} from "./overviewRecipes.ts";
import type { StanceContext } from "./stance.ts";
import type { SpaceEntity } from "../store/types.ts";

const STORAGE_KEY = "evejs-web:overview-tabs:v1";

/** Longest a tab name may be. Long enough to be useful, short enough to fit. */
export const MAX_TAB_NAME_LENGTH = 24;

/**
 * One of the player's tabs.
 *
 * ⚠ `id` IS OPAQUE AND MINTED BY THE CLIENT. It is a row key and a selection
 * key and is never rendered. It is NOT the recipe id, because two tabs may share
 * a recipe — a player who wants "Mining" and "Rocks" wants two tabs, not one tab
 * and a duplicate the client silently collapsed into it.
 */
export interface HiddenEntry {
  readonly groupID: number;
  readonly label: string;
}
export interface OverviewTab {
  readonly id: string;
  readonly name: string;
  readonly recipeId: OverviewRecipeID;
  /**
   * ⚠ THE ONE TAB THAT CANNOT BE DELETED, RENAMED OR MOVED. See
   * `overviewRecipes.ts`: `All` is the only recipe that shows everything, so a
   * second copy would be a duplicate and a tab bar with no All has no way back
   * to seeing everything.
   */
  readonly fixed: boolean;
}

/**
 * A stored name, trimmed and length-capped.
 *
 * ⚠ EMPTY FALLS BACK TO THE RECIPE'S LABEL rather than to an empty string. A
 * tab with no name is indistinguishable from a tab that failed to render, and
 * the player would have to guess which unnamed tab they had clicked.
 */
export function normalizeTabName(raw: string, recipeId: OverviewRecipeID): string {
  const trimmed = raw.trim().slice(0, MAX_TAB_NAME_LENGTH);
  return trimmed.length > 0 ? trimmed : recipeByID(recipeId).label;
}

let minted = 0;

/** An id that cannot collide with a stored one: monotonic within this session. */
function mintTabID(): string {
  minted += 1;
  return `t${minted}-${Math.floor(Date.now() % 1_000_000)}`;
}

/** The starting tab bar: All, fixed, plus the five that ship as editable. */
export function defaultTabs(): readonly OverviewTab[] {
  const editable = DEFAULT_TAB_RECIPES.map((recipeId) => ({
    id: mintTabID(),
    name: recipeByID(recipeId).label,
    recipeId: recipeId as OverviewRecipeID,
    fixed: false,
  }));
  return [{ id: "all", name: "All", recipeId: "all" as OverviewRecipeID, fixed: true }, ...editable];
}

/** One tab, as stored. Every field is untrusted. */
interface StoredTab {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly recipeId?: unknown;
  readonly fixed?: unknown;
}

/**
 * The stored bar, or null when the store holds nothing usable.
 *
 * ⚠ A STALE RECIPE FALLS BACK TO `all`, NEVER TO A TAB THAT DISAPPEARS. Dropping
 * the entry would delete a tab the player can see no trace of, and a tab
 * showing everything is a harmless place to land.
 */
function parseTabs(raw: unknown): readonly OverviewTab[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const parsed: OverviewTab[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as StoredTab;
    if (typeof candidate.recipeId !== "string") continue;
    const recipe = recipeByID(candidate.recipeId);
    parsed.push({
      id: typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : mintTabID(),
      name: normalizeTabName(typeof candidate.name === "string" ? candidate.name : "", recipe.id),
      recipeId: recipe.id,
      fixed: candidate.fixed === true,
    });
  }
  if (parsed.length === 0) {
    return null;
  }
  // ⚠ THE All TAB IS REBUILT, NOT TRUSTED, AND KEPT FIRST. A stored list that
  // lost it — a partial write, an older build, a hand-edited store — must still
  // come back with a way to see everything. A stored name for it is discarded:
  // the tab is called All because it shows everything, and calling it something
  // else would be a lie about what it does.
  const all: OverviewTab = { id: "all", name: "All", recipeId: "all", fixed: true };
  const editable = parsed.filter((tab) => !tab.fixed);
  const unique = editable.filter(
    (tab, index) => editable.findIndex((other) => other.id === tab.id) === index,
  );
  return [all, ...unique];
}

function load(): readonly OverviewTab[] {
  if (typeof localStorage === "undefined") return defaultTabs();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultTabs();
    return parseTabs(JSON.parse(raw)) ?? defaultTabs();
  } catch {
    return defaultTabs();
  }
}

/**
 * ⚠ THE ONE ADMISSION RULE, AND IT IS ABOUT HOSTILITY.
 *
 * A recipe already force-shows a hostile whatever else it selects, so this adds
 * nothing to that — it exists here to make the guarantee legible at the point
 * where a tab is DEFINED rather than one layer down in the recipe, because "my
 * new tab hid the thing shooting at me" is the failure this feature is most
 * likely to produce and the player cannot diagnose it from a tab bar.
 */
export function tabAllows(
  tab: OverviewTab,
  entity: SpaceEntity,
  context: StanceContext | null = null,
): boolean {
  return applyRecipe([entity], recipeByID(tab.recipeId), context).length > 0;
}

export interface TabBar {
  readonly tabs: ReadableSignal<readonly OverviewTab[]>;
  readonly selectedID: ReadableSignal<string>;
  /** The tab in hand, resolved so callers do not each look it up. */
  readonly selected: ReadableSignal<OverviewTab>;
  select(id: string): void;
  /** Create a tab from a recipe. Returns the new tab, already selected. */
  create(recipeId: OverviewRecipeID, name?: string): OverviewTab;
  rename(id: string, name: string): void;
  /** Delete a tab. The fixed All tab is never deleted. */
  remove(id: string): void;
  /** Move a tab one place left or right. All never moves. */
  move(id: string, direction: -1 | 1): void;
  /** Put the bar back to All plus the three that ship. */
  reset(): void;
}

export function createTabBar(): TabBar {
  const tabs = createSignal<readonly OverviewTab[]>(load());
  const selectedID = createSignal<string>("all");
  const selected = createSignal<OverviewTab>(
    tabs.get().find((tab) => tab.fixed) ?? (tabs.get()[0] as OverviewTab),
  );

  const persist = (value: readonly OverviewTab[]): void => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // A full or blocked store costs the tabs across reloads, not the session.
    }
  };
  tabs.subscribe((value) => persist(value));

  /**
   * ⚠ PUBLISH BOTH FROM ONE RESOLUTION. `selectedID` and `selected` must never
   * describe different tabs — an id naming a deleted tab beside a preset naming
   * a live one is how deleting a tab turns into a panel filtering by nothing.
   */
  const select = (id: string): void => {
    const found = tabs.get().find((tab) => tab.id === id);
    if (!found) return;
    selectedID.set(found.id);
    selected.set(found);
  };

  /** Write a new bar and keep the selection pointing at something that exists. */
  const commit = (next: readonly OverviewTab[]): void => {
    tabs.set(next);
    const current = selectedID.get();
    select(next.some((tab) => tab.id === current) ? current : next[0]?.id ?? "all");
  };

  return {
    tabs: readonlySignal(tabs),
    selectedID: readonlySignal(selectedID),
    selected: readonlySignal(selected),
    select,
    create: (recipeId, name) => {
      const recipe = recipeByID(recipeId);
      const tab: OverviewTab = {
        id: mintTabID(),
        name: normalizeTabName(name ?? "", recipe.id),
        recipeId: recipe.id,
        fixed: false,
      };
      commit([...tabs.get(), tab]);
      // ⚠ A NEWLY CREATED TAB IS SELECTED. The player asked for it in order to
      // look through it; leaving them on the previous one reads as the button
      // having done nothing.
      select(tab.id);
      return tab;
    },
    rename: (id, name) => {
      commit(
        tabs.get().map((tab) =>
          tab.fixed || tab.id !== id
            ? tab
            : { ...tab, name: normalizeTabName(name, tab.recipeId) },
        ),
      );
    },
    remove: (id) => {
      const target = tabs.get().find((tab) => tab.id === id);
      if (!target || target.fixed) return;
      // ⚠ Deleting the SELECTED tab falls back to All, which is still there.
      // The panel's standing rule is that a selection never silently retargets
      // onto something the player did not choose.
      commit(tabs.get().filter((tab) => tab.id !== id));
    },
    move: (id, direction) => {
      const current = tabs.get();
      const index = current.findIndex((tab) => tab.id === id);
      const target = current[index];
      if (index < 0 || !target || target.fixed) return;
      const swapWith = index + direction;
      // ⚠ NEVER PAST All. All is index 0 and is the way back to everything, so a
      // "move left" that could swap with it would let the player push it out of
      // its own slot.
      if (swapWith < 1 || swapWith >= current.length) return;
      const next = [...current];
      next[index] = current[swapWith] as OverviewTab;
      next[swapWith] = current[index] as OverviewTab;
      commit(next);
    },
    reset: () => {
      commit(defaultTabs());
      select("all");
    },
  };
}

/** The app's one tab bar. */
export const overviewTabs: TabBar = createTabBar();