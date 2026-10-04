// THE PLAYER'S PER-TAB HIDDEN STATE (goal R90, refined) — the overview's one
// piece of per-object state, kept in localStorage, ONE LIST PER TAB.
//
// R90 kept a single global list: hide a group on one tab and it was hidden on
// every tab, including the picture. That collapsed the tab bar into one filter
// with several names. Now EACH tab tracks what is hidden on it independently,
// and `All` stays absolute — the fallback where anything hidden anywhere else
// is still visible, and the route back to it.
//
// A tab's state has two lists:
//   `hidden` — groups the player actively hid while ON this tab, plus the
//              role-and-side (stance) pairs they hid ("Ships (Friendly)");
//   `shown`  — groups the player ADDED to this tab beyond what its preset
//              shows, plus stance pairs they un-pre-hid. A preset (the tab's
//              recipe) is the baseline; the preset "hides" everything it does
//              not name by omission — by ROLE, and by STANCE where it pre-
//              selects one — and `shown` is how the player expands a tab's
//              use without losing that.
//
// Why localStorage and not the client store: the store holds what the SERVER
// reports. Which objects a pilot has chosen not to look at is a preference of
// theirs, belongs to no session, and has to survive a reload and a
// reconnection. Putting it in the store would mean it reset on every
// character switch and could be clobbered by a snapshot poll — see the same
// argument in `overviewPreset.ts` for why view state is kept out.
//
// ⚠ PERSISTENCE IS BEST-EFFORT AND ITS FAILURE IS NOT HIDDEN. A blocked or
// full store costs the lists across reloads, not the session, so the write is
// swallowed — but the READ is not: a corrupt or unparseable stored value starts
// from EMPTY rather than throwing, so a bad entry can never leave the overview
// unable to render.
//
// ⚠ AND THE LISTS ARE NEVER AUTHORITATIVE FOR SAFETY. The rule that outranks
// them lives in `tabShows` (a hostile is never hidden BY A GROUP — a whole
// entry that names no side is no one's explicit choice — and the fixed All
// tab shows everything), not here. A STANCE entry is the one entry kind that
// may name a hostile, because hiding "Hostiles" is a side the player named
// out loud; a group entry may never reach one. This module stores what the
// player asked for and knows nothing about threats.
//
// ⚠ THE OLD GLOBAL LIST IS INERT, NOT MIGRATED. Entries written by the
// single-list version live under `…overview-hidden:v2` and are no longer
// read: a global list has no per-tab meaning, and guessing which tab hid
// which group would be worse than saying the list moved. Say so if a player
// loses a list.

import {
  categoryCovers,
  entityIsCombatCapable,
  hideCategoriesFor,
  hideCategoryByID,
  offeredCategoriesFor,
  HIDE_CATEGORY_IDS,
  type HideCategoryID,
} from "./hideCategory.ts";
import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import {
  recipeAllows,
  recipeByID,
  recipePreHidesStance,
} from "./overviewRecipes.ts";
import type { OverviewTab } from "./overviewTabs.ts";
import { isHostile } from "./overview.ts";
import { bracketRole } from "./tactical.ts";
import {
  STANCED_CATEGORIES,
  STANCED_ROLES,
  categoryStanceLabel,
  stanceOf,
  stanceRowLabel,
  type Stance,
  type StanceContext,
} from "./stance.ts";
import type { SpaceEntity } from "../store/types.ts";

/**
 * How one hidden entry is remembered: TWO KINDS, ONE PER GRID AXIS.
 *
 * ⚠ A GROUP ENTRY HIDES A GROUP, NOT AN OBJECT, AND NOT A TYPE. An earlier
 * pass keyed on typeID, which reads finer than anyone means when they say
 * "hide that": a station and a hauler and a drone can all be different types
 * of the same broad kind, and a player who hid one planet should not have to
 * hide the next one too. `groupID` is EVE's own taxonomy — group 7 is "Planet",
 * 8 is "Moon", 3 is "Station", 10 is "Stargate" — so hiding the group a row
 * belongs to hides every row that answers to the same word, and names that
 * word in the menu.
 *
 * ⚠ THE GROUP, NOT THE `categoryID`. "Large Collidable Object" is a CATEGORY
 * (6), not a group: it is the parent of most of what you can fly near, so
 * hiding it would empty the grid. A group is the level where "Planet" is its
 * own entry rather than one of a dozen things under a heading.
 *
 * ⚠ A CATEGORY ENTRY HIDES A CATEGORY, NOT AN OBJECT, A TYPE, OR A GROUP.
 * Group-based hiding was retired in favour of this axis: the SDE has 1605
 * groups, and a player hiding scenery should not have to decide between "Large
 * Collidable Object" and "Agents in Space". `hideCategory.ts` owns the group →
 * category mapping, and it is the ONLY place a `groupID` is read for hiding.
 *
 * ⚠ "Large Collidable Object" IS A REAL GROUP (226) AND IS SCENERY. That entry
 * was the reason this axis exists: `bracketRole` ends in `return "ship"`, so
 * scenery the runtime tagged with an unrecognised kind was filed as a hull, and
 * hiding Ships took the scenery with it.
 *
 * ⚠ A STANCE ENTRY HIDES A CATEGORY AND A SIDE — "Ship (Hostile)" — for the
 * rows that come in more than one stance (see `stance.ts`). This is the axis a
 * player means when they say "hide the hostile ships and keep the friendly
 * ones", and it is the ONLY entry kind that may cover a hostile: a category
 * entry names a KIND, never a side, and the safety rule keeps it there.
 *
 * ⚠ STORED UNDER THE v5 KEY ONLY. The user's call: a hard cut. The v4 and v3
 * keys hold group-shaped entries, and a group id has no honest translation into
 * a category — "Planet" could become `planet` or `scenery`, and guessing would
 * silently hide the wrong things. So the old keys are not read at all: every
 * saved hide from before this change is gone, with no way back. That is the
 * deliberate cost of a model that cannot lie.
 */
export interface CategoryHiddenEntry {
  readonly kind: "category";
  /**
   * The category's own word — "scenery", "ship", "asteroid" — from
   * `hideCategory.ts`. NOT a group id: this is the player's axis, and the
   * classifier that produces it is the single place a group id is read.
   */
  readonly category: HideCategoryID;
  /**
   * The category's display label, for the restore menu.
   *
   * ⚠ CARRIED, NOT RESOLVED ON DISPLAY. Re-derived from the id on read, so a
   * hand-edited record cannot put a stale or alarming word in the menu — but it
   * is stored so an entry whose object has left the grid still says something.
   */
  readonly label: string;
}

export interface StanceHiddenEntry {
  readonly kind: "stance";
  /**
   * The ROLE's own word, from `bracketRole` — "ship", "drone", … "hostile".
   *
   * ⚠ EXACTLY ONE OF `role` AND `category` IS SET. The preset axis speaks
   * roles (a recipe's `stancePreHides` names roles) and the player's axis
   * speaks categories (PLAN goal 1b's "Ships (Hostile)"). Two vocabularies, so
   * two fields rather than one overloaded one: a single `role` holding a
   * category name would be compared against `bracketRole` by `covers` and
   * would quietly match nothing.
   */
  readonly role?: string;
  /** The CATEGORY's own word — "ship", "drone" — for a player's own hide. */
  readonly category?: HideCategoryID;
  /** The side of the grid the hide applies to. */
  readonly stance: Stance;
  /** The menu's word for the pair: "Ships (Friendly)", "Hostiles". */
  readonly label: string;
}

export type HiddenEntry = CategoryHiddenEntry | StanceHiddenEntry;

/**
 * The category entry for an object, as a toolbar Hide button builds it.
 *
 * ⚠ NULL WHEN THE ROW HAS NO CATEGORY WORTH OFFERING, which is exactly one
 * case: it classified as `other`. Everything else always has a category, so
 * this returns null far less often than the old group version did — the
 * classifier's job is to make sure "I cannot classify this" is rare rather than
 * to make hiding impossible.
 *
 * @param category the specific category to hide, when the caller is offering
 *   several buttons for one row (PLAN goal 1b). Omit for the row's own.
 */
export function hiddenEntryFor(
  entity: SpaceEntity,
  category?: HideCategoryID,
): CategoryHiddenEntry | null {
  const offered = offeredCategoriesFor(entity);
  const chosen = category ?? offered[0];
  if (chosen === undefined) {
    return null;
  }
  // ⚠ A CATEGORY THE ROW DOES NOT CARRY IS REFUSED, NOT ACCEPTED. A button that
  // hides nothing looks like a broken Hide, and this is the same guard the old
  // no-groupID refusal existed to provide.
  if (!offered.includes(chosen)) {
    return null;
  }
  return { kind: "category", category: chosen, label: hideCategoryByID(chosen).label };
}

/**
 * The stance entry for an object, as the toolbar's stance-Hide button builds
 * it.
 *
 * ⚠ NULL WHEN THE ROW'S ROLE CARRIES NO STANCE ROW AT ALL. Gates, rocks and
 * celestials have no side, and police are the one neutral family — hiding
 * them is already a group hide, and inventing "Stargates (Neutral)" would be a
 * menu entry that hides the same things as one that already exists.
 */
export function stanceEntryFor(
  entity: SpaceEntity,
  context: StanceContext | null,
): StanceHiddenEntry | null {
  const role = bracketRole(entity);
  if (!STANCED_ROLES.has(role)) {
    return null;
  }
  const stance = stanceOf(entity, context);
  return { kind: "stance", role, stance, label: stanceRowLabel(role, stance) };
}

/**
 * The CATEGORY-AND-SIDE entry for an object — the `<Item Category> (<Stance>)`
 * Hide button goal 1b asks for, e.g. "Ships (Hostile)".
 *
 * ⚠ NULL WHEN THE ROW'S CATEGORY CARRIES NO SIDE. Gates, rocks, scenery and
 * celestials have none, so there is no honest word for their stance and
 * inventing one would be a menu entry that hides exactly what the plain
 * category hide already hides.
 *
 * ⚠ THE CATEGORY IS THE ROW'S OWN, NOT A CHOICE. A stance entry names one
 * category AND one side; which category a player means is the one the row is.
 * (Offering every stanced category for every row would put a "Wrecks
 * (Friendly)" button on a live frigate, and it would hide nothing.)
 */
export function categoryStanceEntryFor(
  entity: SpaceEntity,
  context: StanceContext | null,
): StanceHiddenEntry | null {
  const category = hideCategoriesFor(entity)[0];
  if (category === undefined || !STANCED_CATEGORIES.has(category)) {
    return null;
  }
  const stance = stanceOf(entity, context);
  return {
    kind: "stance",
    category,
    stance,
    label: categoryStanceLabel(category, stance),
  };
}

/** Does this entry cover this object? */
export function covers(
  entry: HiddenEntry,
  entity: SpaceEntity,
  context: StanceContext | null = null,
): boolean {
  if (entry.kind === "category") {
    return categoryCovers(entry.category, entity);
  }
  // ⚠ A STANCE ENTRY IS KEYED BY WHICHEVER AXIS IT WAS BUILT ON. The preset
  // speaks roles, the player speaks categories (goal 1b), and an entry that
  // named neither would be a no-op the menu had no honest way to describe.
  if (entry.category !== undefined) {
    return categoryCovers(entry.category, entity) && stanceOf(entity, context) === entry.stance;
  }
  return bracketRole(entity) === entry.role && stanceOf(entity, context) === entry.stance;
}

/**
 * Does this entry APPLY to this object — cover it AND be allowed to reach it?
 *
 * ⚠ THE RELAXED INVARIANT, ASKED OF ONE ENTRY. A category entry that would cover
 * a hostile does not apply: hiding every "Ship" is no one's explicit choice
 * about a threat, so the hostile shows through it. A stance entry has
 * named a side, and it applies — that is how "Hostiles" hides a rat and how
 * every other entry kind still refuses it.
 */
function entryApplies(
  entry: HiddenEntry,
  entity: SpaceEntity,
  context: StanceContext | null,
): boolean {
  if (!covers(entry, entity, context)) {
    return false;
  }
  return !(entry.kind === "category" && isHostile(entity));
}

/**
 * One tab's two lists.
 *
 * ⚠ THE PRESET PRE-HIDES; THE PLAYER CORRECTS. Every tab starts from
 * "everything visible" and its preset then pre-selects the groups to hide —
 * pre-hidings exactly like the player's own hides, just set in advance. What
 * a tab hides is therefore ONE list in the player's head: the preset's
 * pre-hidings plus the groups they hid themselves (`hidden`), and `shown` is
 * the record of the pre-hidings they chose to undo. A fresh Mining tab hence
 * hides everything the mining preset does not name — and pressing Show on any
 * one entry undoes that one pre-hiding without touching the others. Adding a
 * new preset is just a new list of pre-hidings.
 */
export interface TabHiddenState {
  /** Groups the player hid on this tab, in hide order. */
  readonly hidden: readonly HiddenEntry[];
  /** Preset pre-hidings the player chose to undo on this tab. */
  readonly shown: readonly HiddenEntry[];
}

/** The state map: tab id to its two lists. Tabs with no lists have no entry. */
export type TabHiddenMap = ReadonlyMap<string, TabHiddenState>;

/** The state a tab with no lists of its own answers with. */
export const EMPTY_STATE: TabHiddenState = { hidden: [], shown: [] };

/** The one tab's state, or the empty one when it has never been touched. */
export function stateFor(map: TabHiddenMap, tabID: string): TabHiddenState {
  return map.get(tabID) ?? EMPTY_STATE;
}

/** Does this tab's `hidden` list cover this category? */
export function categoryIsHidden(category: HideCategoryID, state: TabHiddenState): boolean {
  return state.hidden.some(
    (entry) => entry.kind === "category" && entry.category === category,
  );
}

/** Does this tab's `shown` list cover this category? */
export function categoryIsShown(category: HideCategoryID, state: TabHiddenState): boolean {
  return state.shown.some(
    (entry) => entry.kind === "category" && entry.category === category,
  );
}

/**
 * Does this tab's `hidden` list hold this axis-and-side pair?
 *
 * ⚠ MATCHES ON WHICHEVER AXIS THE ENTRY WAS BUILT ON — a preset's role-keyed
 * entry and the player's category-keyed one are distinct entries even when the
 * word is the same ("ship"), and comparing them as equal would let one hide
 * report the other as already done and do nothing.
 */
export function stanceIsHidden(key: string, stance: Stance, state: TabHiddenState): boolean {
  return state.hidden.some(
    (entry) =>
      entry.kind === "stance" && (entry.role ?? entry.category) === key && entry.stance === stance,
  );
}

/** Does this tab's `shown` list hold this axis-and-side pair? */
export function stanceIsShown(key: string, stance: Stance, state: TabHiddenState): boolean {
  return state.shown.some(
    (entry) =>
      entry.kind === "stance" && (entry.role ?? entry.category) === key && entry.stance === stance,
  );
}

/**
 * Does this tab's PRESET pre-hide this row — everything the preset's recipe
 * does not admit is pre-selected the same way the player's own hides are, just
 * in advance?
 *
 * ⚠ THE RECIPE STILL FILTERS BY ROLE, NOT BY CATEGORY. The player's own hides
 * moved to categories (goal 2) but the preset recipes are a separate axis and
 * were left on `bracketRole` deliberately: changing them would move what every
 * existing tab SHOWS, which is a much larger change than what it hides. This is
 * the one place the two axes meet, and it is a deliberate seam.
 *
 * ⚠ ONLY THE UNDECIDED PRE-HIDINGS COUNT. A row the tab hid itself is owned
 * by the tab's `hidden` list (Show undoes THAT entry), and one the player
 * already un-pre-hid is owned by `shown`. The preset's virtual entries exist
 * for everything else the preset does not name. Hostiles and the fixed All
 * tab never count: nothing the preset names is ever a hiding candidate there,
 * and a row the stance pre-hides own is listed under the stance word instead,
 * once, not twice.
 */
export function presetHidesRow(
  tab: OverviewTab,
  entity: SpaceEntity,
  state: TabHiddenState,
  context: StanceContext | null = null,
): boolean {
  if (isHostile(entity) || tab.fixed) {
    return false;
  }
  for (const entry of state.hidden) {
    if (entryApplies(entry, entity, context)) {
      return false;
    }
  }
  for (const entry of state.shown) {
    if (covers(entry, entity, context)) {
      return false;
    }
  }
  return !recipeAllows(recipeByID(tab.recipeId), entity);
}

/**
 * Does this tab's PRESET pre-hide this row BY STANCE — the role-and-side pairs
 * the preset named in advance ("the PVP tab hides friendly ships")?
 *
 * ⚠ THE SAME DECIDED-ONCE RULE AS THE GROUP SIDE. A pair the tab hid itself or
 * the player already undid is owned by the tab's own lists, not by the
 * preset. And a row the GROUP pre-hides already own keeps the group's word in
 * the menu: one row, one word, one Show.
 */
export function presetStanceHides(
  tab: OverviewTab,
  entity: SpaceEntity,
  state: TabHiddenState,
  context: StanceContext | null = null,
): boolean {
  if (tab.fixed) {
    return false;
  }
  for (const entry of state.hidden) {
    if (entryApplies(entry, entity, context)) {
      return false;
    }
  }
  for (const entry of state.shown) {
    if (covers(entry, entity, context)) {
      return false;
    }
  }
  const recipe = recipeByID(tab.recipeId);
  if (!recipePreHidesStance(recipe, entity, context)) {
    return false;
  }
  return !presetHidesRow(tab, entity, state, context);
}

/**
 * Does this tab's PRESET pre-hide this row at all — either axis? The union
 * kept for callers that ask the whole question; the menu's two lists use the
 * two halves above so a row never earns two words.
 */
export function presetHides(
  tab: OverviewTab,
  entity: SpaceEntity,
  state: TabHiddenState,
  context: StanceContext | null = null,
): boolean {
  return (
    presetHidesRow(tab, entity, state, context) || presetStanceHides(tab, entity, state, context)
  );
}

/**
 * THE ONE QUESTION BOTH SURFACES ASK: does this tab show this object?
 *
 * The list and the picture MUST answer through the same function, or R79
 * comes back — a rock drawn in the ore colour while its own tab has filtered
 * it out. Resolution order, in priority:
 *
 *   1. The fixed All tab shows everything — it is the fallback, and a way
 *      back that respected the hidden lists would not be one. It therefore
 *      carries no lists of its own at all.
 *   2. The tab's own `hidden` list, entry by entry. It beats even `shown`:
 *      a row the player hid on this tab does not come back through the added
 *      list. The safety rule sits on the ENTRY, not the row: a GROUP entry
 *      that would cover a hostile does not apply (a player who hid a belt and
 *      then gets ambushed still sees the rat), while a STANCE entry that
 *      named the hostile side does — hiding "Hostiles" is the explicit choice
 *      the relaxed invariant allows.
 *   3. The tab's own `shown` list. The record of the preset's pre-hidings the
 *      player chose to undo: a group or a stance pair the preset hides that
 *      the player showed anyway on this tab.
 *   4. The preset's stance pre-hides. The role-and-side pairs the recipe named
 *      in advance ("the PVP tab hides friendly ships"), consulted before the
 *      role allow-list so a pre-hidden friendly ship does not leak back in
 *      through the recipe.
 *   5. The preset's role allow-list. The baseline is "everything visible", and
 *      the recipe hides every role it does not name — so its virtual entries
 *      decide everything the two lists above have not.
 */
export function tabShows(
  tab: OverviewTab,
  entity: SpaceEntity,
  state: TabHiddenState,
  context: StanceContext | null = null,
): boolean {
  if (tab.fixed) {
    return true;
  }
  for (const entry of state.hidden) {
    if (entryApplies(entry, entity, context)) {
      return false;
    }
  }
  for (const entry of state.shown) {
    if (covers(entry, entity, context)) {
      return true;
    }
  }
  const recipe = recipeByID(tab.recipeId);
  if (recipePreHidesStance(recipe, entity, context)) {
    return false;
  }
  return recipeAllows(recipe, entity);
}

/**
 * Does this row go because the FRIENDLY / NEUTRAL COMBAT TOGGLE is on?
 *
 * ⚠ SEPARATE FROM `tabShows` ON PURPOSE. The toggle is not a hidden entry, so
 * folding it into the resolver would make it reach the Hidden Items menu and the
 * All tab's guarantees by accident. The caller asks this question alongside
 * `tabShows`, and it is deliberately a smaller question: only a COMBAT-CAPABLE
 * object, only the switched-on side, and never a hostile.
 *
 * ⚠ THE ORDER IS FIXED, AND THE HOSTILE CHECK IS FIRST. A rat must not be
 * reachable through the neutral toggle even when it is nominally neutral to
 * nobody — the same absolute rule the category axis obeys, and it is stated here
 * rather than inherited so it cannot drift.
 */
export function combatStanceHides(
  entity: SpaceEntity,
  toggles: ReadonlySet<CombatStance>,
  context: StanceContext | null,
): boolean {
  if (toggles.size === 0) return false;
  if (isHostile(entity)) return false;
  if (!entityIsCombatCapable(entity)) return false;
  const stance = stanceOf(entity, context);
  return stance === "friendly" || stance === "neutral" ? toggles.has(stance) : false;
}

const STORAGE_KEY = "evejs-web:overview-hidden:v5";

/**
 * ⚠ THE v4 AND v3 KEYS ARE NOT READ, AND THAT IS THE POINT. Both held group-shaped
 * entries, and a group id has no honest translation into a category: group 7
 * could mean `planet` or, read loosely, `scenery`, and guessing would silently
 * hide a different set of objects than the player chose. The user's call was a
 * hard cut — saved hides from before the category era are discarded rather than
 * guessed at.
 *
 * ⚠ A GROUP ID IS STILL IN THE STORE UNTIL THE PLAYER CLEARS IT. Nothing reads
 * it and nothing writes it; it is simply dead weight in the player's browser.
 */
const DEAD_STORAGE_KEYS = ["evejs-web:overview-hidden:v4", "evejs-web:overview-hidden:v3"];

/** One stored list: an array of category or stance records, all untrusted. */
type StoredList = unknown;

/**
 * Turn a stored list into entries, discarding anything that is not a usable
 * entry.
 *
 * ⚠ AN ENTRY THAT CANNOT NAME ITS KEY IS DROPPED. A blank group would match
 * every ungrouped row in the system, which is how one corrupt record turns
 * into an empty overview; a stance entry that cannot name its role and side
 * hides nothing at all and earns nothing in the menu.
 *
 * ⚠ DUPLICATES ARE COLLAPSED. The same group, or the same role-and-side pair,
 * can arrive twice — a double hide, or a hand-edited store — and the restore
 * menu showing it twice would leave the player wondering why one of them does
 * nothing.
 *
 * ⚠ OLD ENTRIES CARRY NO `kind`, AND THAT IS HOW THEY ARE RECOGNIZED. Anything
 * that is not a stance entry by name is read as a group entry, which is all a
 * v3 record ever was.
 */
function sanitizeEntries(raw: StoredList): HiddenEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: HiddenEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as {
      readonly kind?: unknown;
      readonly category?: unknown;
      readonly label?: unknown;
      readonly role?: unknown;
      readonly stance?: unknown;
    };
    if (candidate.kind === "stance") {
      const stance = candidate.stance;
      if (stance !== "friendly" && stance !== "neutral" && stance !== "hostile") continue;

      // ⚠ EITHER AXIS IS ACCEPTED, AND EXACTLY ONE MUST BE NAMED. A record may
      // be the preset's role-keyed entry or the player's category-keyed one;
      // a record naming neither — or both — cannot be resolved honestly and is
      // dropped rather than guessed at.
      const role = typeof candidate.role === "string" ? candidate.role : undefined;
      const category =
        typeof candidate.category === "string" &&
        HIDE_CATEGORY_IDS.has(candidate.category) &&
        STANCED_CATEGORIES.has(candidate.category)
          ? (candidate.category as HideCategoryID)
          : undefined;
      if ((role === undefined) === (category === undefined)) continue;
      if (role !== undefined && !STANCED_ROLES.has(role)) continue;

      const key = role ?? (category as string);
      if (
        entries.some(
          (existing) =>
            existing.kind === "stance" &&
            (existing.role ?? existing.category) === key &&
            existing.stance === stance,
        )
      ) {
        continue;
      }
      // ⚠ THE CANONICAL WORD, NOT THE STORED ONE, on whichever axis. The label
      // is a projection of the entry and its side; re-deriving it keeps the
      // menu's words honest even if a record was hand-edited with a stale one.
      entries.push(
        role !== undefined
          ? { kind: "stance", role, stance, label: stanceRowLabel(role, stance) }
          : {
              kind: "stance",
              category: category as HideCategoryID,
              stance,
              label: categoryStanceLabel(category as HideCategoryID, stance),
            },
      );
      continue;
    }
    // ⚠ AN UNKNOWN CATEGORY NAME IS DROPPED, NOT COERCED. `other` is refused
    // here as well as in the classifier: an entry that hides "everything I
    // could not name" is exactly the catch-all that emptied the overview under
    // the old group-0 rule, and it would be reachable by hand-editing the
    // store.
    if (typeof candidate.category !== "string") {
      continue;
    }
    if (!HIDE_CATEGORY_IDS.has(candidate.category)) {
      continue;
    }
    const category = candidate.category as HideCategoryID;
    if (category === "other") {
      continue;
    }
    if (
      entries.some(
        (existing) => existing.kind === "category" && existing.category === category,
      )
    ) {
      continue;
    }
    // ⚠ THE CANONICAL WORD, NOT THE STORED ONE. Same rule as the stance branch:
    // the label is a projection of the id, so re-deriving it keeps the menu's
    // words honest even if a record was hand-edited with a stale label.
    entries.push({
      kind: "category",
      category,
      label: hideCategoryByID(category).label,
    });
  }
  return entries;
}

/** Read the stored map, discarding anything that is not usable state. */
function load(): TabHiddenMap {
  if (typeof localStorage === "undefined") return new Map();
  try {
    // ⚠ ONLY THE v5 KEY IS READ. No fallback, on purpose — see DEAD_STORAGE_KEYS.
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    const map = new Map<string, TabHiddenState>();
    for (const [tabID, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (tabID.length === 0 || typeof value !== "object" || value === null) continue;
      const candidate = value as { readonly hidden?: StoredList; readonly shown?: StoredList };
      const state: TabHiddenState = {
        hidden: sanitizeEntries(candidate.hidden),
        shown: sanitizeEntries(candidate.shown),
      };
      // ⚠ AN EMPTY STATE IS NO STATE. Storing it would make the menu's map
      // grow forever — a tab that has never hidden or added anything gets no
      // entry at all, which is also what `stateFor` answers with.
      if (state.hidden.length === 0 && state.shown.length === 0) continue;
      map.set(tabID, state);
    }
    return map;
  } catch {
    // A corrupt store costs the lists, not the app.
    return new Map();
  }
}

export interface TabHiddenStore {
  /**
   * The whole map, as a signal — the one a Svelte component reads as
   * `$tabHiddenMap` and answers from with `stateFor`.
   *
   * ⚠ THE SAME SIGNAL, TWICE, AND NOT A WRAPPER. Svelte's `$name` sugar reads
   * `$name` as "the value of this store", which requires `name.subscribe` to
   * exist. A component cannot write `$tabHidden` — the `$` applies to `tabHidden`,
   * an object with no `subscribe`. Exporting the signal itself is the fix; the
   * alias on the store exists so a caller holding only the store can reach it
   * without unwrapping.
   */
  readonly map: ReadableSignal<TabHiddenMap>;
  /** The one tab's state, or `EMPTY_STATE` when it has never been touched. */
  stateFor(tabID: string): TabHiddenState;
  /**
   * Hide everything in this row's CATEGORY, ON THIS TAB ONLY.
   *
   * ⚠ `category` IS OPTIONAL, and when given it must be one this row actually
   * carries — that is what lets goal 1b put one button per category on a row
   * and still have every one of them do something. Omitted, it hides the row's
   * own category.
   *
   * ⚠ RETURNS THE ENTRY, OR null WHEN THERE WAS NOTHING TO HIDE — a row that
   * classified as `other`. The caller needs to know: a silent no-op is the one
   * case where the player pressed a button and nothing happened.
   */
  hide(
    tabID: string,
    entity: SpaceEntity,
    category?: HideCategoryID,
  ): CategoryHiddenEntry | null;
  /**
   * Hide everything this row's role-and-side names, ON THIS TAB ONLY — the
   * "Hide Ships (Friendly)" verb. Same contract as `hide`: idempotent, and
   * null when the row's role carries no stance row at all.
   */
  hideStance(tabID: string, entity: SpaceEntity, context: StanceContext | null): StanceHiddenEntry | null;
  /**
   * Hide everything in this row's category AND side — the goal 1b
   * "Ships (Hostile)" verb. The one entry kind that may reach a hostile,
   * because pressing it names the side out loud.
   */
  hideCategoryStance(
    tabID: string,
    entity: SpaceEntity,
    context: StanceContext | null,
  ): StanceHiddenEntry | null;
  /** Bring one of THIS tab's hidden categories back. */
  unhideCategory(tabID: string, category: HideCategoryID): void;
  /** Bring one of THIS tab's hidden role-and-side pairs back. */
  unhideStance(tabID: string, role: string, stance: Stance): void;
  /** Add one category to THIS tab beyond what its preset shows. */
  addCategory(tabID: string, category: HideCategoryID): void;
  /** Add one role-and-side pair to THIS tab beyond what its preset shows. */
  addStance(tabID: string, role: string, stance: Stance): void;
  /** Remove one category from THIS tab's added list. */
  removeCategory(tabID: string, category: HideCategoryID): void;
  /** Remove one role-and-side pair from THIS tab's added list. */
  removeStance(tabID: string, role: string, stance: Stance): void;
  /** Forget everything THIS tab hides, for its "show everything" control. */
  clearHidden(tabID: string): void;
  /** Drop both of a tab's lists, called when the tab itself is deleted. */
  dropTab(tabID: string): void;
  /**
   * Put a tab back to its PRESET alone: both of its lists go, so the tab shows
   * exactly what its recipe says — nothing the player hid, and none of the
   * things they added.
   */
  resetTab(tabID: string): void;
  /** Forget every tab's lists. */
  clearAll(): void;
}

export function createTabHiddenStore(): TabHiddenStore {
  const map = createSignal<TabHiddenMap>(load());
  const readable = readonlySignal(map);

  const persist = (value: TabHiddenMap): void => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(value)));
    } catch {
      // A full or blocked store costs persistence across reloads, not the setting.
    }
  };

  // The subscriber lives for the app's life — one global preference, never torn down.
  map.subscribe(persist);

  /**
   * Rewrite one tab's entry from the current state, or drop it when the result
   * is null.
   *
   * ⚠ A NEW MAP, NOT A MUTATION. The signal compares by identity, and a
   * component that already read the old map must not see it quietly change
   * under it without the signal telling it.
   */
  const rewrite = (tabID: string, fn: (state: TabHiddenState) => TabHiddenState | null): void => {
    const next = new Map(map.get());
    const updated = fn(next.get(tabID) ?? EMPTY_STATE);
    if (updated === null) {
      next.delete(tabID);
    } else {
      next.set(tabID, updated);
    }
    map.set(next);
  };

  return {
    map: readable,
    stateFor: (tabID) => map.get().get(tabID) ?? EMPTY_STATE,
    hide: (tabID, entity, category) => {
      const entry = hiddenEntryFor(entity, category);
      // ⚠ THE PLAYER IS TOLD WHEN THERE WAS NOTHING TO HIDE. A row that
      // classified as `other` is one the server did not describe, and pressing
      // Hide on it and watching nothing happen is the silent decline this panel
      // rejects everywhere else — so `null` goes back to the caller to be
      // stated in the button's tooltip, not left unsaid.
      if (entry === null) return null;
      // ⚠ IDEMPOTENT. Hiding the same category twice on this tab would otherwise
      // leave two identical entries, and the restore menu would show the same
      // name twice with one of them doing nothing.
      if (categoryIsHidden(entry.category, map.get().get(tabID) ?? EMPTY_STATE)) {
        return entry;
      }
      rewrite(tabID, (state) => ({ hidden: [...state.hidden, entry], shown: state.shown }));
      return entry;
    },
    unhideCategory: (tabID, category) => {
      // ⚠ A NO-OP THAT DOES NOT REWRITE. Bringing back a category this tab never
      // hid must not create an entry for it, and a double press on Show must
      // not leave a trace.
      if (!categoryIsHidden(category, map.get().get(tabID) ?? EMPTY_STATE)) return;
      rewrite(tabID, (state) => ({
        ...state,
        hidden: state.hidden.filter(
          (entry) => !(entry.kind === "category" && entry.category === category),
        ),
      }));
    },
    addCategory: (tabID, category) => {
      // ⚠ THE SAME ADMISSION RULE AS HIDING. `other` is not something to add —
      // it is the bucket for objects nothing could name, and a button that adds
      // it would widen a tab to everything at once.
      if (category === "other") return;
      if (categoryIsShown(category, map.get().get(tabID) ?? EMPTY_STATE)) return;
      rewrite(tabID, (state) => ({
        hidden: state.hidden,
        shown: [
          ...state.shown,
          { kind: "category", category, label: hideCategoryByID(category).label },
        ],
      }));
    },
    removeCategory: (tabID, category) => {
      if (!categoryIsShown(category, map.get().get(tabID) ?? EMPTY_STATE)) return;
      rewrite(tabID, (state) => ({
        ...state,
        shown: state.shown.filter(
          (entry) => !(entry.kind === "category" && entry.category === category),
        ),
      }));
    },
    hideStance: (tabID, entity, context) => {
      const entry = stanceEntryFor(entity, context);
      // ⚠ THE SAME CONTRACT AS THE CATEGORY HIDE: null when the row's role has no
      // stance row, and idempotent when the pair is already hidden on this tab.
      if (entry === null) return null;
      if (stanceIsHidden(entry.role ?? "", entry.stance, map.get().get(tabID) ?? EMPTY_STATE)) {
        return entry;
      }
      rewrite(tabID, (state) => ({ hidden: [...state.hidden, entry], shown: state.shown }));
      return entry;
    },
    hideCategoryStance: (tabID, entity, context) => {
      const entry = categoryStanceEntryFor(entity, context);
      // ⚠ THE SAME CONTRACT AGAIN, ON THE CATEGORY AXIS: null when the row's
      // category carries no side (a gate, a rock, scenery), and idempotent when
      // the pair is already hidden on this tab.
      if (entry === null || entry.category === undefined) return null;
      if (stanceIsHidden(entry.category, entry.stance, map.get().get(tabID) ?? EMPTY_STATE)) {
        return entry;
      }
      rewrite(tabID, (state) => ({ hidden: [...state.hidden, entry], shown: state.shown }));
      return entry;
    },
    unhideStance: (tabID, role, stance) => {
      if (!stanceIsHidden(role, stance, map.get().get(tabID) ?? EMPTY_STATE)) return;
      rewrite(tabID, (state) => ({
        ...state,
        hidden: state.hidden.filter(
          (entry) => !(entry.kind === "stance" && entry.role === role && entry.stance === stance),
        ),
      }));
    },
    addStance: (tabID, role, stance) => {
      // ⚠ THE SAME ADMISSION RULE AS THE GROUP SIDE. A pair the tab already
      // showed is already undone, and one whose role carries no stance row
      // hides nothing it would matter for.
      if (!STANCED_ROLES.has(role)) return;
      if (stanceIsShown(role, stance, map.get().get(tabID) ?? EMPTY_STATE)) return;
      rewrite(tabID, (state) => ({
        hidden: state.hidden,
        shown: [...state.shown, { kind: "stance", role, stance, label: stanceRowLabel(role, stance) }],
      }));
    },
    removeStance: (tabID, role, stance) => {
      if (!stanceIsShown(role, stance, map.get().get(tabID) ?? EMPTY_STATE)) return;
      rewrite(tabID, (state) => ({
        ...state,
        shown: state.shown.filter(
          (entry) => !(entry.kind === "stance" && entry.role === role && entry.stance === stance),
        ),
      }));
    },
    clearHidden: (tabID) => {
      if (stateFor(map.get(), tabID).hidden.length === 0) return;
      rewrite(tabID, (state) => ({ ...state, hidden: [] }));
    },
    resetTab: (tabID) => {
      // ⚠ BOTH LISTS GO, AND THAT IS THE DIFFERENCE FROM `clearHidden`. A reset
      // puts the tab back to what its RECIPE alone decides, so it must also drop
      // the `shown` overrides the player accumulated while expanding the tab —
      // otherwise a reset tab would still show things its preset hides, and
      // "reset" would be a word that did not mean what it says.
      //
      // ⚠ IT IS NOT `dropTab`'s DELETION CASE, only its shape. `dropTab` fires
      // because the tab itself is gone; this fires because the player asked, and
      // the tab is still here afterwards with its name, order and recipe intact.
      if (!map.get().has(tabID)) return;
      rewrite(tabID, () => null);
    },
    dropTab: (tabID) => {
      // ⚠ THE TAB'S ARRANGEMENT DIES WITH THE TAB. Keeping a deleted tab's lists
      // would grow the store one dead entry per deleted tab, and renaming a tab
      // is safe because the key is its opaque id, never its name.
      if (!map.get().has(tabID)) return;
      rewrite(tabID, () => null);
    },
    clearAll: () => {
      if (map.get().size === 0) return;
      map.set(new Map());
    },
  };
}

/**
 * ⚠ THE FRIENDLY / NEUTRAL COMBAT TOGGLES (PLAN pivot, 2026-04-10).
 *
 * Per tab, per side: when on, every FRIENDLY (or NEUTRAL) object that can shoot
 * at you is off the list. Two properties are deliberate and both were asked for.
 *
 * ⚠ THEY ARE NOT HIDDEN ENTRIES. They live here, in their own map, and never
 * reach `TabHiddenState.hidden` — so they never appear in the Hidden Items menu.
 * Their state is shown by the button being struck through, and retoggling undoes
 * them. A tab's hidden list stays a list of things the player chose to remove;
 * "I want the friendlies out of my way for now" is not that.
 *
 * ⚠ A HOSTILE IS NEVER REACHED. There is no hostile toggle at all, and a hostile
 * is force-shown below even when the category list would otherwise cover it — the
 * same absolute rule the category axis obeys.
 *
 * ⚠ AND ONLY COMBAT-CAPABLE THINGS. `entityIsCombatCapable` decides, off the
 * SDE category, so planets, moons, stations, asteroids, gates and orbitals are
 * untouched: those are almost always neutral, and hiding them by side would
 * remove the furniture of the system along with the traffic.
 */
export type CombatStance = "friendly" | "neutral";

const TOGGLE_STORAGE_KEY = "evejs-web:overview-combat-toggles:v1";

export type CombatToggleMap = ReadonlyMap<string, ReadonlySet<CombatStance>>;

const EMPTY_TOGGLES: ReadonlySet<CombatStance> = new Set<CombatStance>();

function loadToggles(): CombatToggleMap {
  if (typeof localStorage === "undefined") return new Map();
  try {
    const raw = localStorage.getItem(TOGGLE_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    const map = new Map<string, ReadonlySet<CombatStance>>();
    for (const [tabID, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const stances = value.filter(
        (item): item is CombatStance => item === "friendly" || item === "neutral",
      );
      if (stances.length > 0) map.set(tabID, new Set(stances));
    }
    return map;
  } catch {
    return new Map();
  }
}

export interface CombatToggleStore {
  readonly map: ReadableSignal<CombatToggleMap>;
  /** The sides switched on for one tab, or none. */
  forTab(tabID: string): ReadonlySet<CombatStance>;
  /** Flip one side and answer with the new state of that side. */
  toggle(tabID: string, stance: CombatStance): boolean;
  /** Put both sides back, for `resetTab`. */
  clear(tabID: string): void;
}

export function createCombatToggleStore(): CombatToggleStore {
  const map = createSignal<CombatToggleMap>(loadToggles());
  const readable = readonlySignal(map);

  map.subscribe((value) => {
    if (typeof localStorage === "undefined") return;
    try {
      // ⚠ AN EMPTY TAB IS NO ENTRY. Storing it would grow the map one dead key
      // per deleted tab, the same rule `load` applies to the hidden lists.
      const out: Record<string, CombatStance[]> = {};
      for (const [tabID, stances] of value) {
        if (stances.size > 0) out[tabID] = [...stances];
      }
      localStorage.setItem(TOGGLE_STORAGE_KEY, JSON.stringify(out));
    } catch {
      // A full or blocked store costs persistence across reloads, not the setting.
    }
  });

  return {
    map: readable,
    forTab: (tabID) => map.get().get(tabID) ?? EMPTY_TOGGLES,
    toggle: (tabID, stance) => {
      const next = new Map(map.get());
      const stances = new Set(next.get(tabID) ?? EMPTY_TOGGLES);
      if (stances.has(stance)) {
        stances.delete(stance);
      } else {
        stances.add(stance);
      }
      if (stances.size === 0) {
        next.delete(tabID);
      } else {
        next.set(tabID, stances);
      }
      map.set(next);
      return stances.has(stance);
    },
    clear: (tabID) => {
      if (!map.get().has(tabID)) return;
      const next = new Map(map.get());
      next.delete(tabID);
      map.set(next);
    },
  };
}

/** The app's one per-tab combat-stance toggle state. */
export const combatToggles: CombatToggleStore = createCombatToggleStore();

/** The app's toggles as a bare signal, for a component to bind to. */
export const combatToggleMap: ReadableSignal<CombatToggleMap> = combatToggles.map;

/** The app's one per-tab hidden state. */
export const tabHidden: TabHiddenStore = createTabHiddenStore();

/**
 * The app's per-tab hidden ENTRIES, as a bare signal.
 *
 * ⚠ THE ONE A COMPONENT USES. A Svelte component cannot write `$tabHidden` —
 * the `$` prefix would call `tabHidden.subscribe`, which an object does not
 * have — so the signal it binds to is exported directly, and the mutable API
 * stays on `tabHidden` beside it. The two are the same signal object, so there
 * is exactly one map however a caller reaches it.
 */
export const tabHiddenMap: ReadableSignal<TabHiddenMap> = tabHidden.map;
