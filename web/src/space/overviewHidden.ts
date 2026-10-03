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
//   `hidden` — groups the player actively hid while ON this tab;
//   `shown`  — groups the player ADDED to this tab beyond what its preset
//              shows. A preset (the tab's recipe) is the baseline; the preset
//              "hides" everything it does not name by omission, and `shown`
//              is how the player expands a tab's use without losing that.
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
// ⚠ AND THE LISTS ARE NEVER AUTHORITATIVE FOR SAFETY. The one rule that
// outranks them lives in `tabShows` (a hostile is never hidden, and the
// fixed All tab shows everything), not here — this module stores what the
// player asked for and knows nothing about threats.
//
// ⚠ THE OLD GLOBAL LIST IS INERT, NOT MIGRATED. Entries written by the
// single-list version live under `…overview-hidden:v2` and are no longer
// read: a global list has no per-tab meaning, and guessing which tab hid
// which group would be worse than saying the list moved. Say so if a player
// loses a list.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import { recipeAllows, recipeByID } from "./overviewRecipes.ts";
import type { OverviewTab } from "./overviewTabs.ts";
import { isHostile } from "./overview.ts";
import type { SpaceEntity } from "../store/types.ts";

/**
 * How one hidden entry is remembered.
 *
 * ⚠ THIS IS A GROUP, NOT AN OBJECT, AND NOT A TYPE. An earlier pass keyed on
 * typeID, which reads finer than anyone means when they say "hide that": a
 * station and a hauler and a drone can all be different types of the same
 * broad kind, and a player who hid one planet should not have to hide the next
 * one too. `groupID` is EVE's own taxonomy — group 7 is "Planet", 8 is "Moon",
 * 3 is "Station", 10 is "Stargate" — so hiding the group a row belongs to hides
 * every row that answers to the same word, and names that word in the menu.
 *
 * ⚠ THE GROUP, NOT THE `categoryID`. "Large Collidable Object" is a CATEGORY
 * (6), not a group: it is the parent of most of what you can fly near, so
 * hiding it would empty the grid. A group is the level where "Planet" is its
 * own entry rather than one of a dozen things under a heading.
 *
 * ⚠ THE OLDER KEY IS STILL READ, ONCE. Entries written by the typeID version of
 * this list are migrated on load rather than discarded — a player who hid a type
 * keeps it hidden, and their entry becomes a group the first time an object of
 * that type is seen (see `migrateEntry`).
 */
export interface HiddenEntry {
  /** EVE's group id for the thing that was hidden. */
  readonly groupID: number;
  /**
   * The group's own name, for the restore menu.
   *
   * ⚠ CARRIED, NOT RESOLVED ON DISPLAY. It is stored rather than looked up
   * because a group name comes from the type cache keyed on `typeID`, and an
   * entry that no object on the grid can answer for has nothing to look up. A
   * name is also the only thing in the record that tells the player what they
   * hid.
   */
  readonly label: string;
}

/**
 * The entry for an object, as the toolbar's Hide button builds it.
 *
 * ⚠ A ROW WITH NO groupID CANNOT BE HIDDEN BY GROUP, and this returns null
 * rather than inventing a key. A `groupID` of 0 would match every ungrouped row
 * in the system, which is how one press could empty the overview — and a row
 * that carries no group is a row the server did not classify, so there is
 * nothing honest for the player to hide.
 */
export function hiddenEntryFor(entity: SpaceEntity, label: string): HiddenEntry | null {
  if (entity.groupID === null || !Number.isFinite(entity.groupID) || entity.groupID <= 0) {
    return null;
  }
  return { groupID: entity.groupID, label };
}

/** Does this entry cover this object? */
export function covers(entry: HiddenEntry, entity: SpaceEntity): boolean {
  return entity.groupID !== null && entry.groupID === entity.groupID;
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

/** Does this tab's `hidden` list cover this group? */
export function groupIsHidden(groupID: number, state: TabHiddenState): boolean {
  return state.hidden.some((entry) => entry.groupID === groupID);
}

/** Does this tab's `shown` list cover this group? */
export function groupIsShown(groupID: number, state: TabHiddenState): boolean {
  return state.shown.some((entry) => entry.groupID === groupID);
}

/**
 * Does this tab's PRESET pre-hide this group — the groups a preset hides are
 * pre-selected the same way the player's own hides do, just in advance?
 *
 * ⚠ ONLY THE UNDECIDED PRE-HIDINGS COUNT. A group the tab hid itself is owned
 * by the tab's `hidden` list (Show undoes THAT entry), and one the player
 * already un-pre-hid is owned by `shown`. The preset's virtual entries exist
 * for everything else the preset does not name — so a tab's whole "hidden"
 * list, in one go, is `hidden` plus the groups `presetHides` says yes to.
 * Hostiles and the fixed All tab never count: nothing the preset names is
 * ever a hiding candidate there.
 */
export function presetHides(tab: OverviewTab, entity: SpaceEntity, state: TabHiddenState): boolean {
  if (isHostile(entity) || tab.fixed) {
    return false;
  }
  const group = entity.groupID;
  if (group !== null && group > 0) {
    if (groupIsHidden(group, state)) {
      return false;
    }
    if (groupIsShown(group, state)) {
      return false;
    }
  }
  return !recipeAllows(recipeByID(tab.recipeId), entity);
}

/**
 * THE ONE QUESTION BOTH SURFACES ASK: does this tab show this object?
 *
 * The list and the picture MUST answer through the same function, or R79
 * comes back — a rock drawn in the ore colour while its own tab has filtered
 * it out. Resolution order, in priority:
 *
 *   1. A hostile is never hidden. The rule that outranks every recipe and
 *      every player list lives HERE, in the one place the lists are
 *      consulted from: a player who hid a belt and then gets ambushed still
 *      sees the rat, on every tab, picture and list alike.
 *   2. The fixed All tab shows everything — it is the fallback, and a way
 *      back that respected the hidden lists would not be one. It therefore
 *      carries no lists of its own at all.
 *   3. The tab's own `hidden` list. It beats even `shown`: a group the
 *      player hid on this tab does not come back through the added list.
 *   4. The tab's own `shown` list. The record of the preset's pre-hidings the
 *      player chose to undo: a group the preset does not name that the player
 *      showed anyway on this tab.
 *   5. The preset itself. The baseline is "everything visible", and the
 *      preset pre-hides what it does not name — so its virtual entries decide
 *      everything the two lists above have not.
 */
export function tabShows(tab: OverviewTab, entity: SpaceEntity, state: TabHiddenState): boolean {
  if (isHostile(entity)) {
    return true;
  }
  if (tab.fixed) {
    return true;
  }
  const group = entity.groupID;
  if (group !== null && group > 0) {
    if (groupIsHidden(group, state)) {
      return false;
    }
    if (groupIsShown(group, state)) {
      return true;
    }
  }
  return recipeAllows(recipeByID(tab.recipeId), entity);
}

const STORAGE_KEY = "evejs-web:overview-hidden:v3";

/** One stored list: an array of `{ groupID, label }` records, all untrusted. */
type StoredList = unknown;

/**
 * Turn a stored list into entries, discarding anything that is not a usable
 * entry.
 *
 * ⚠ AN ENTRY THAT CANNOT NAME A GROUP IS DROPPED. A blank group would match
 * every ungrouped row in the system, which is how one corrupt record turns
 * into an empty overview.
 *
 * ⚠ DUPLICATES ARE COLLAPSED. The same group can arrive twice — a double hide,
 * or a hand-edited store — and the restore menu showing it twice would leave
 * the player wondering why one of them does nothing.
 */
function sanitizeEntries(raw: StoredList): HiddenEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: HiddenEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as { readonly groupID?: unknown; readonly label?: unknown };
    if (typeof candidate.groupID !== "number" || !Number.isFinite(candidate.groupID) || candidate.groupID <= 0) {
      continue;
    }
    if (entries.some((existing) => existing.groupID === candidate.groupID)) continue;
    entries.push({
      groupID: candidate.groupID,
      label:
        typeof candidate.label === "string" && candidate.label.length > 0
          ? candidate.label
          : "Hidden group",
    });
  }
  return entries;
}

/** Read the stored map, discarding anything that is not usable state. */
function load(): TabHiddenMap {
  if (typeof localStorage === "undefined") return new Map();
  try {
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
   * Hide everything in this row's group, ON THIS TAB ONLY. `label` is the
   * GROUP's name, which is what the restore menu will say.
   *
   * ⚠ RETURNS THE ENTRY, OR null WHEN THERE WAS NOTHING TO HIDE — a row with no
   * usable group. The caller needs to know: a silent no-op is the one case
   * where the player pressed a button and nothing happened.
   */
  hide(tabID: string, entity: SpaceEntity, label: string): HiddenEntry | null;
  /** Bring one of THIS tab's hidden groups back. */
  unhideGroup(tabID: string, groupID: number): void;
  /** Add one group to THIS tab beyond what its preset shows. */
  addGroup(tabID: string, groupID: number, label: string): void;
  /** Remove one group from THIS tab's added list. */
  removeGroup(tabID: string, groupID: number): void;
  /** Forget everything THIS tab hides, for its "show everything" control. */
  clearHidden(tabID: string): void;
  /** Drop both of a tab's lists, called when the tab itself is deleted. */
  dropTab(tabID: string): void;
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
    hide: (tabID, entity, label) => {
      const entry = hiddenEntryFor(entity, label);
      // ⚠ THE PLAYER IS TOLD WHEN THERE WAS NOTHING TO HIDE. A row with no usable
      // group is one the server did not classify, and pressing Hide on it and
      // watching nothing happen is the silent decline this panel rejects
      // everywhere else — so `null` goes back to the caller to be stated in the
      // button's tooltip, not left unsaid.
      if (entry === null) return null;
      // ⚠ IDEMPOTENT. Hiding the same group twice on this tab would otherwise
      // leave two identical entries, and the restore menu would show the same
      // name twice with one of them doing nothing.
      if (groupIsHidden(entry.groupID, map.get().get(tabID) ?? EMPTY_STATE)) {
        return entry;
      }
      rewrite(tabID, (state) => ({ hidden: [...state.hidden, entry], shown: state.shown }));
      return entry;
    },
    unhideGroup: (tabID, groupID) => {
      // ⚠ A NO-OP THAT DOES NOT REWRITE. Bringing back a group this tab never
      // hid must not create an entry for it, and a double press on Show must
      // not leave a trace.
      if (!groupIsHidden(groupID, map.get().get(tabID) ?? EMPTY_STATE)) return;
      rewrite(tabID, (state) => ({
        ...state,
        hidden: state.hidden.filter((entry) => entry.groupID !== groupID),
      }));
    },
    addGroup: (tabID, groupID, label) => {
      // ⚠ THE SAME ADMISSION RULE AS HIDING. A group that cannot be named is
      // nothing to add, and one already added is already expanded.
      if (groupID <= 0) return;
      if (groupIsShown(groupID, map.get().get(tabID) ?? EMPTY_STATE)) return;
      rewrite(tabID, (state) => ({
        hidden: state.hidden,
        shown: [...state.shown, { groupID, label }],
      }));
    },
    removeGroup: (tabID, groupID) => {
      if (!groupIsShown(groupID, map.get().get(tabID) ?? EMPTY_STATE)) return;
      rewrite(tabID, (state) => ({
        ...state,
        shown: state.shown.filter((entry) => entry.groupID !== groupID),
      }));
    },
    clearHidden: (tabID) => {
      if (stateFor(map.get(), tabID).hidden.length === 0) return;
      rewrite(tabID, (state) => ({ ...state, hidden: [] }));
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
