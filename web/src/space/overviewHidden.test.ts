// The per-tab hidden state (goal R90, refined; re-based on categories in
// PLAN.txt goal 2): EACH tab's two lists — the CATEGORIES the player hid on
// that tab, and the CATEGORIES the player added to that tab beyond its preset —
// plus the one rule that outranks their choice.
//
// Hiding is BY CATEGORY, not by object, not by type and no longer by group
// (the SDE has 1605 groups; `hideCategory.ts` is the single place a group id is
// read). Pressing Hide on a planet hides every planet ON THAT TAB, and the
// tab's restore menu says "Planets". Every other tab keeps showing the planets,
// and All shows them all — it is the fallback and hides nothing at all.

import test from "node:test";
import assert from "node:assert/strict";

import {
  categoryIsHidden,
  categoryIsShown,
  combatStanceHides,
  covers,
  createCombatToggleStore,
  createTabHiddenStore,
  type CombatStance,
  EMPTY_STATE,
  hiddenEntryFor,
  presetHides,
  presetHidesRow,
  stateFor,
  tabShows,
  type TabHiddenState,
} from "./overviewHidden.ts";
import { OVERVIEW_RECIPES, recipeByID, recipeAllows } from "./overviewRecipes.ts";
import { isHostile } from "./overview.ts";
import type { OverviewTab } from "./overviewTabs.ts";
import type { OverviewRecipeID } from "./overviewRecipes.ts";
import type { SpaceEntity } from "../store/types.ts";
import { hideCategoriesFor, offeredCategoriesFor } from "./hideCategory.ts";
import type { StanceContext } from "./stance.ts";

/** One plain tab: `id` as its name, built from a recipe, never fixed. */
function tab(id: string, recipeId: OverviewRecipeID): OverviewTab {
  return { id, name: id, recipeId, fixed: false };
}

/** The fixed All tab — the one that shows everything and hides nothing. */
const ALL: OverviewTab = { id: "all", name: "All", recipeId: "all", fixed: true };
const mining = tab("mining", "mining");
const travel = tab("travel", "travel");
const pve = tab("combat", "combat");
const pvp = tab("pvp", "pvp" as never);

const ORIGIN = { x: 0, y: 0, z: 0 };

/** EVE group 7 is "Planet", group 8 is "Moon", group 3 is "Station". */
const PLANET_GROUP = 7;
const MOON_GROUP = 8;
const PLANET_TYPE = 13;

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "celestial",
    typeID: PLANET_TYPE,
    groupID: PLANET_GROUP,
    categoryID: 2,
    name: null,
    ownerID: null,
    radius: 100,
    position: ORIGIN,
    velocity: ORIGIN,
    isSelf: false,
    shieldRatio: null,
    armorRatio: null,
    hullRatio: null,
    characterID: null,
    corporationID: null,
    allianceID: null,
    securityStatus: null,
    maxVelocity: null,
    mode: null,
    capacitorRatio: null,
    remainingQuantity: null,
    miningYieldTypeID: null,
    beltID: null,
    oreGrade: null,
    oreValuePerM3: null,
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...over,
  };
}

const PLANET = entity({ itemID: 1 });
const OTHER_PLANET = entity({ itemID: 2, typeID: 14 });
const MOON = entity({ itemID: 3, groupID: MOON_GROUP, typeID: 15 });
/** Group 226 is the SDE's "Large Collidable Object" — scenery, and the bug. */
const DECOR = entity({ itemID: 4, groupID: 226, categoryID: 2, typeID: 5555, kind: "structure" });
const RAT = entity({ itemID: 5, kind: "ship", groupID: 25, categoryID: 6, isNpc: true, npcEntityType: "npc" });
/** An ore group is a rock only once the runtime stamps it with a yield. */
const ASTEROID_GROUP = 450;
const GATE_GROUP = 10;
const ROCK = entity({ itemID: 14, groupID: ASTEROID_GROUP, categoryID: 25, typeID: 1230, kind: "celestial", miningYieldTypeID: 1230 });
const GATE = entity({ itemID: 15, groupID: GATE_GROUP, categoryID: 2, typeID: 101, kind: "celestial" });
const FRIGATE = entity({ itemID: 16, kind: "ship", groupID: 25, typeID: 1232 });

// --- the entry is a category --------------------------------------------------

test("⚠ hiding a planet hides EVERY planet, not just that one", () => {
  // ⚠ THE WHOLE OF THE AXIS. Two different planet TYPES, one category, both
  // gone — which is what "hide the planets" means and what a type-keyed list
  // could not do.
  const entry = hiddenEntryFor(PLANET, "planet");
  assert.ok(entry, "a classifiable row should produce an entry");
  assert.equal(entry.category, "planet");
  assert.equal(entry.label, "Planets", "the entry is named for the CATEGORY, not the object");
  assert.equal(covers(entry, PLANET), true);
  assert.equal(covers(entry, OTHER_PLANET), true, "a different planet type matched too");
});

test("hiding one category does not hide another", () => {
  const entry = hiddenEntryFor(PLANET, "planet");
  assert.ok(entry);
  assert.equal(covers(entry, MOON), false, "a moon went missing with the planets");
  assert.equal(covers(entry, DECOR), false);
});

test("the entry carries the CATEGORY's name, never the object's own name", () => {
  // ⚠ THE MENU READS THIS. A named rock ("Veldspar") would put a specific object
  // in a list whose unit is the category, and the player could not tell what
  // pressing Show would bring back.
  const namedRock = entity({ itemID: 6, name: "Veldspar", groupID: 450, categoryID: 25, kind: "celestial", miningYieldTypeID: 450 });
  const entry = hiddenEntryFor(namedRock, "asteroid");
  assert.ok(entry);
  assert.equal(entry.label, "Rocks");
  assert.ok(!entry.label.includes("Veldspar"));
});

test("⚠ a row that classifies as `other` cannot be hidden at all", () => {
  // ⚠ RETURNS null RATHER THAN INVENTING A KEY. An `other` entry would match
  // every unclassified row in the system, so one press could empty the
  // overview — the same failure the old groupID-of-0 rule existed to prevent.
  const other = entity({ itemID: 7, groupID: null, kind: null, categoryID: null });
  assert.equal(hiddenEntryFor(other), null);
});

test("a row with a bad group still classifies by kind, and hides on that", () => {
  // The new axis is more forgiving than the old one by design: an absent or
  // nonsense group is no longer automatically un-hideable.
  assert.equal(hiddenEntryFor(entity({ itemID: 8, groupID: 0, kind: "ship", categoryID: 6 }))?.category, "ship");
  assert.equal(hiddenEntryFor(entity({ itemID: 9, groupID: -3, kind: "ship", categoryID: 6 }))?.category, "ship");
});

test("⚠ a category the row does NOT carry is refused, not accepted", () => {
  // ⚠ THE GUARD BEHIND THE MULTI-BUTTON UI. Goal 1b puts one Hide button per
  // category on a row; if the store accepted a category the row lacks, that
  // button would hide nothing while looking like it worked.
  assert.equal(hiddenEntryFor(PLANET, "scenery"), null, "a planet is not scenery");
  assert.equal(hiddenEntryFor(PLANET, "ship"), null);
});

test("a row with a category is always matched by it, whatever its type", () => {
  const shared = entity({ itemID: 10, groupID: 450, categoryID: 25, miningYieldTypeID: 450 });
  const other = entity({ itemID: 11, groupID: 450, categoryID: 25, typeID: 1230, kind: "celestial", miningYieldTypeID: 450 });
  const entry = hiddenEntryFor(shared, "asteroid");
  assert.ok(entry);
  assert.equal(covers(entry, other), true, "a different type in the same category stayed");
});

test("covers is the whole of the matching rule", () => {
  const entry = { kind: "category" as const, category: "planet" as const, label: "Planets" };
  assert.equal(covers(entry, PLANET), true);
  assert.equal(covers(entry, OTHER_PLANET), true);
  assert.equal(covers(entry, MOON), false);
  assert.equal(covers(entry, FRIGATE), false);
});

// --- the resolver: the order hostile, all, hidden, shown, preset --------------

test("⚠ a HOSTILE is never hidden, even when its group is hidden", () => {
  // ⚠ THIS GOT MORE LIKELY TO MATTER, NOT LESS. Hiding is broad — one group,
  // not one object — so a group that happens to contain a threat is a far easier
  // accident. A rat is `kind: "ship"`, and a group covering player hulls would
  // otherwise take the contents of the threat strip out of the list.
  const state: TabHiddenState = { hidden: [{ kind: "category", category: "ship", label: "Ships" }], shown: [] };
  assert.equal(tabShows(mining, RAT, state), true, "a threat was hidden by category");
  assert.equal(categoryIsHidden("ship", state), true, "the list still records the ask");
  assert.equal(isHostile(RAT), true);
});

test("⚠ ALL IS ABSOLUTE, EVEN WITH FULL LISTS LOADED FOR IT", () => {
  // ⚠ THE FALLBACK. A state loaded with enough to empty a whole tab must not be
  // able to empty the tab that is the way back to seeing everything.
  const state: TabHiddenState = {
    hidden: [
      { kind: "category", category: "planet", label: "Planets" },
      { kind: "category", category: "ship", label: "Ships" },
      { kind: "category", category: "asteroid", label: "Rocks" },
    ],
    shown: [],
  };
  assert.equal(tabShows(ALL, PLANET, state), true, "All respected its own hidden list");
  assert.equal(tabShows(ALL, ROCK, state), true);
  assert.equal(tabShows(ALL, RAT, state), true);
  assert.equal(tabShows(ALL, DECOR, state), true);
});

test("⚠ hiding on one tab hides it NOWHERE ELSE", () => {
  // ⚠ THE WHOLE OF THE PER-TAB CHANGE. The same entry, the same group, another
  // tab: the tab that never hid the group keeps showing it, because it has its
  // own state — not because the group is special.
  const hiddenHere: TabHiddenState = {
    hidden: [{ kind: "category", category: "planet", label: "Planets" }],
    shown: [],
  };
  assert.equal(tabShows(mining, PLANET, hiddenHere), false, "the tab that hid it lost it");
  assert.equal(tabShows(travel, PLANET, EMPTY_STATE), true, "the other tab kept it");
  assert.equal(tabShows(ALL, PLANET, hiddenHere), true, "All kept it too");
});

test("the preset is the baseline: what it does not name is not shown", () => {
  // ⚠ THE PRESET HIDES BY OMISSION. A planet is not in the mining role set, so a
  // fresh Mining tab does not show it — no entry for it needed anywhere.
  assert.ok(!recipeAllows(recipeByID("mining"), PLANET), "the premise: planets are not mining");
  assert.equal(tabShows(mining, PLANET, EMPTY_STATE), false, "the preset omitted it");
  // And what the preset DOES name is shown, still with no lists involved.
  assert.ok(recipeAllows(recipeByID("mining"), ROCK), "the premise: rocks are mining");
  assert.equal(tabShows(mining, ROCK, EMPTY_STATE), true, "a rock left the rocks tab");
});

test("the preset PRE-HIDES what it does not name — and only while undecided", () => {
  // ⚠ THE UNIFIED HIDDEN SYSTEM. The preset's omissions are pre-selected
  // hides: one virtual entry per group, living in the very list the player's
  // own hides live in. So `presetHides` must say yes to the omissions, and no
  // to everything the tab has already decided on in either direction — each
  // group owns exactly one entry, so no row can ever sit in the menu doing
  // nothing.
  assert.ok(!recipeAllows(recipeByID("mining"), GATE), "the premise: gates are not mining");
  assert.equal(presetHides(mining, GATE, EMPTY_STATE), true, "the pre-hiding is not virtual at all");
  // What the preset names is never a hiding candidate.
  assert.equal(presetHides(mining, ROCK, EMPTY_STATE), false, "a rock pre-hidden on the rocks tab");
  // The tab hid it itself: the player's entry owns the row, not the preset's.
  const hidIt: TabHiddenState = { hidden: [{ kind: "category", category: "gate", label: "Gates" }], shown: [] };
  assert.equal(presetHides(mining, GATE, hidIt), false, "the hiding is listed twice");
  // The player undid the pre-hiding: the `shown` entry owns it.
  const unPreHid: TabHiddenState = { hidden: [], shown: [{ kind: "category", category: "gate", label: "Gates" }] };
  assert.equal(presetHides(mining, GATE, unPreHid), false, "the undo was not recorded");
  // Hostiles and the fixed All tab never count: the rules that outrank the
  // preset sit in one place, and All pre-hides nothing.
  assert.equal(presetHides(mining, RAT, EMPTY_STATE), false, "a threat is a pre-hiding candidate");
  assert.equal(presetHides(ALL, GATE, EMPTY_STATE), false, "All is a pre-hiding tab");
  // And each tab's pre-hidings are its own: Travel omits what Mining names.
  assert.equal(presetHides(travel, ROCK, EMPTY_STATE), true, "the pre-hide is not this tab's");
  assert.equal(presetHides(mining, ROCK, EMPTY_STATE), false, "a rock pre-hidden on the rocks tab, twice");
});

test("⚠ adding a group expands the tab beyond its preset", () => {
  // ⚠ THE EXPANSION THE PLAYER ASKED FOR. The preset hides the gate by omission;
  // one entry in the tab's `shown` list puts it back — on that tab only.
  const state: TabHiddenState = { hidden: [], shown: [{ kind: "category", category: "gate", label: "Gates" }] };
  assert.ok(!recipeAllows(recipeByID("mining"), GATE), "the premise: gates are not mining");
  assert.equal(tabShows(mining, GATE, EMPTY_STATE), false, "before: the preset did not show it");
  assert.equal(tabShows(mining, GATE, state), true, "after: the tab was expanded");
  assert.equal(tabShows(travel, GATE, state), true, "the other tab is not affected either way");
});

test("⚠ a group the tab hid beats a group the tab added", () => {
  // ⚠ THE ORDER MATTERS AND IT IS FIXED: hidden beats shown. A group that is in
  // both of one tab's lists is the player's last word winning, not the first.
  const state: TabHiddenState = {
    hidden: [{ kind: "category", category: "gate", label: "Gates" }],
    shown: [{ kind: "category", category: "gate", label: "Gates" }],
  };
  assert.equal(tabShows(mining, GATE, state), false, "the hidden word came first");
});

test("⚠ a category hide reaches a row with no group — the old axis could not", () => {
  // ⚠ WHAT CHANGED, ASSERTED. This row has no group at all, so under the old
  // group-based axis it was UNHIDEABLE: `hiddenEntryFor` refused it and the
  // player could do nothing with it. The category axis classifies it by kind
  // and hides it like anything else.
  const ungrouped = entity({ itemID: 16, groupID: null, kind: "asteroid", miningYieldTypeID: 1230 });
  const entry = hiddenEntryFor(ungrouped, "asteroid");
  assert.ok(entry, "an ungrouped rock is hideable now");
  assert.equal(entry.category, "asteroid");

  const state: TabHiddenState = { hidden: [entry], shown: [] };
  assert.equal(tabShows(mining, ungrouped, state), false, "the category hide did not reach it");
});

test("⚠ `other` cannot be WRITTEN, so a tab cannot be emptied by one entry", () => {
  // ⚠ THE GUARANTEE IS NOW ABOUT ADMISSION, NOT ABOUT MATCHING. A recipe is a
  // deny-list, so a stored `other` entry would cover every unclassifiable row —
  // and that is exactly the catch-all that emptied the overview under the old
  // group-0 rule. So the invariant moved: no code path can produce the entry.
  //
  // `hiddenEntryFor` refuses it, and so does the storage sanitizer (pinned in the
  // storage tests below). The test is here to say the first of those is still true
  // and to name why it matters now.
  const unknowable = entity({ itemID: 17, groupID: null, kind: null, categoryID: null });
  assert.deepEqual(hideCategoriesFor(unknowable), ["other"], "the fixture stopped being unknown");
  assert.deepEqual(hiddenEntryFor(unknowable), null, "an `other` entry can be built");
  assert.deepEqual(offeredCategoriesFor(unknowable), [], "`other` is offered as a button");

  // And no default recipe names it either, so a preset cannot empty a tab.
  for (const recipe of OVERVIEW_RECIPES) {
    assert.equal(recipe.hides.has("other"), false, `${recipe.id} excludes "other"`);
  }
});

// --- the store ----------------------------------------------------------------

test("hiding the same group twice on a tab is one entry", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.hide("mining", OTHER_PLANET, "planet");
  assert.equal(store.stateFor("mining").hidden.length, 1, "the restore menu would show a duplicate");
});

test("hiding two categories gives two entries, named for their categories", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.hide("mining", DECOR, "scenery");
  assert.deepEqual(
    store.stateFor("mining").hidden.map((entry) => entry.label),
    ["Planets", "Scenery"],
  );
});

test("hiding tells the caller when there was nothing to hide", () => {
  // ⚠ THE ONLY CASE WHERE A PRESS DOES NOTHING, so the caller has to be able to
  // SAY so in the tooltip rather than leave the player watching an inert button.
  const store = createTabHiddenStore();
  assert.equal(store.hide("mining", PLANET, "planet")?.category, "planet");
  assert.equal(store.hide("mining", entity({ itemID: 17, groupID: null, kind: null, categoryID: null })), null);
  assert.equal(store.stateFor("mining").hidden.length, 1, "a refused hide still added an entry");
});

test("⚠ the two tabs' states never touch each other", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.addCategory("travel", "gate");
  assert.equal(store.stateFor("mining").hidden.length, 1);
  assert.deepEqual(store.stateFor("travel").hidden, [], "the other tab gained a hiding");
  assert.equal(store.stateFor("travel").shown.length, 1);
  assert.deepEqual(stateFor(store.map.get(), "combat"), EMPTY_STATE);
});

test("unhideCategory removes exactly one category, on its own tab", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.hide("mining", DECOR, "scenery");
  store.unhideCategory("mining", "planet");
  assert.deepEqual(store.stateFor("mining").hidden.map((entry) => entry.label), ["Scenery"]);
  // Bringing back a category the tab never hid is a no-op, not a creation.
  store.unhideCategory("mining", "gate");
  assert.equal(store.stateFor("mining").hidden.length, 1);
});

test("addCategory expands the tab; removeCategory takes it off again", () => {
  const store = createTabHiddenStore();
  store.addCategory("mining", "gate");
  assert.equal(store.stateFor("mining").shown.length, 1, "the tab was not expanded");
  // Adding the same category twice is one entry.
  store.addCategory("mining", "gate");
  assert.equal(store.stateFor("mining").shown.length, 1, "the expansion was doubled");
  // ⚠ `other` IS REFUSED, LIKE A HIDE. It is the bucket for objects nothing
  // could name, and adding it would widen a tab to every unclassified row.
  store.addCategory("mining", "other");
  assert.equal(store.stateFor("mining").shown.length, 1);
  store.removeCategory("mining", "gate");
  assert.deepEqual(store.stateFor("mining").shown, []);
  // A category never added is a no-op, not an error or a hole.
  store.removeCategory("mining", "gate");
  assert.deepEqual(store.stateFor("mining").shown, []);
});

test("clearHidden forgets the tab's hiding, and the tab's additions only", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.addCategory("mining", "gate");
  store.clearHidden("mining");
  assert.deepEqual(store.stateFor("mining").hidden, [], "the hiding was not cleared");
  assert.equal(store.stateFor("mining").shown.length, 1, "clear dragged in the additions");
  // Clearing a tab that hides nothing must not create a state for it.
  store.clearHidden("travel");
  assert.equal(store.map.get().has("travel"), false, "an empty clear left an entry");
});

test("dropTab takes both lists with the tab", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.addCategory("mining", "gate");
  store.dropTab("mining");
  assert.equal(store.map.get().has("mining"), false, "the deleted tab's lists outlived it");
  store.dropTab("mining");
  assert.equal(store.map.get().has("mining"), false, "dropping an absent tab left a trace");
});

test("clearAll forgets every tab's lists", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.addCategory("travel", "gate");
  store.clearAll();
  assert.equal(store.map.get().size, 0);
});

test("two stores built separately never share state", () => {
  const a = createTabHiddenStore();
  const b = createTabHiddenStore();
  a.hide("mining", PLANET, "planet");
  assert.equal(a.stateFor("mining").hidden.length, 1);
  assert.deepEqual(b.stateFor("mining"), EMPTY_STATE);
});

test("a subscriber is told when a tab's lists change", () => {
  const store = createTabHiddenStore();
  const seen: number[] = [];
  const stop = store.map.subscribe((map) => seen.push(map.get("mining")?.hidden.length ?? 0));
  store.hide("mining", PLANET, "planet");
  store.unhideCategory("mining", "planet");
  stop();
  assert.deepEqual(seen, [0, 1, 0]);
});

test("a hostile ask is recorded, and the resolver still shows it", () => {
  // ⚠ THE ONE PLACE THE RECORD AND THE VIEW DIVERGE, AND IT IS DELIBERATE. The
  // tab's list answers "did the player ask to hide this"; `tabShows` answers
  // "does it show", and refuses to hide a threat on the spot.
  const store = createTabHiddenStore();
  store.hide("mining", RAT, "ship");
  assert.equal(categoryIsHidden("ship", store.stateFor("mining")), true, "the ask was not recorded");
  assert.equal(tabShows(mining, RAT, store.stateFor("mining")), true, "the threat was hidden");
  assert.equal(isHostile(RAT), true);
});

// --- the stance axis -----------------------------------------------------------

const MY_CHARACTER = 9101;
const MY_CORP = 9201;
const MY_ALLIANCE = 9301;
const STANCE_CONTEXT = {
  characterID: MY_CHARACTER,
  corporationID: MY_CORP,
  allianceID: MY_ALLIANCE,
};

const FRIENDLY_SHIP = entity({ itemID: 30, kind: "ship", groupID: 25, categoryID: 6, characterID: MY_CHARACTER });
const NEUTRAL_SHIP = entity({ itemID: 31, kind: "ship", groupID: 25, categoryID: 6, characterID: 999 });

test("⚠ a STANCE entry is the only entry that may hide a hostile", () => {
  // ⚠ THE RELAXED INVARIANT, AS A RULE: a group entry that would cover a
  // threat does not apply (the test above pins it), while an entry that NAMES
  // the hostile side does. Hiding "Hostiles" is the explicit choice the
  // relaxation allows; a blanket group is no one's choice about a threat.
  const state: TabHiddenState = {
    hidden: [{ kind: "stance", role: "hostile", stance: "hostile", label: "Hostiles" }],
    shown: [],
  };
  assert.equal(tabShows(mining, RAT, state, STANCE_CONTEXT), false, "the player named the side");
  assert.equal(tabShows(ALL, RAT, state, STANCE_CONTEXT), true, "All is still absolute");
});

test("a stance hide covers the side, not the whole role", () => {
  const state: TabHiddenState = {
    hidden: [{ kind: "stance", role: "ship", stance: "neutral", label: "Ships (Neutral)" }],
    shown: [],
  };
  // PVE allows ships, so only the stance entry can keep them out.
  assert.equal(tabShows(pve, NEUTRAL_SHIP, state, STANCE_CONTEXT), false, "the neutral side went");
  assert.equal(tabShows(pve, FRIENDLY_SHIP, state, STANCE_CONTEXT), true, "the friendly side stayed");
});

test("⚠ hiding your own side is the TOGGLE's job, not a preset's", () => {
  // ⚠ PVP AND PRESET STANCE PRE-HIDES ARE BOTH GONE. A recipe no longer reads
  // stance, so there is nothing for a preset to pre-hide by side, and "pvp" was
  // only ever the vehicle for exactly that.
  const pve = tab("combat", "combat");
  assert.equal(tabShows(pve, FRIENDLY_SHIP, EMPTY_STATE, STANCE_CONTEXT), true, "PVE dropped a friendly ship");
  assert.equal(tabShows(pve, NEUTRAL_SHIP, EMPTY_STATE, STANCE_CONTEXT), true, "PVE dropped a neutral ship");
  // ⚠ AND A RECIPE IGNORES THE CONTEXT ENTIRELY — even one it is handed.
  assert.equal(tabShows(pve, FRIENDLY_SHIP, EMPTY_STATE, null), true, "no context, different answer");
});

test("a hostile ask is recorded, and the resolver still shows it", () => {
  // ⚠ THE ONE PLACE THE RECORD AND THE VIEW DIVERGE, AND IT IS DELIBERATE. The
  // tab's list answers "did the player ask to hide this"; `tabShows` answers
  // "does it show", and refuses to hide a threat on the spot.
  const store = createTabHiddenStore();
  store.hide("mining", RAT, "ship");
  assert.equal(categoryIsHidden("ship", store.stateFor("mining")), true, "the ask was not recorded");
  assert.equal(tabShows(mining, RAT, store.stateFor("mining")), true, "the threat was hidden");
  assert.equal(isHostile(RAT), true);
  // ⚠ THE RELAXED INVARIANT, AS A RULE: a group entry that would cover a
  // threat does not apply (the test above pins it), while an entry that NAMES
  // the hostile side does. Hiding "Hostiles" is the explicit choice the
  // relaxation allows; a blanket group is no one's choice about a threat.
  const state: TabHiddenState = {
    hidden: [{ kind: "stance", role: "hostile", stance: "hostile", label: "Hostiles" }],
    shown: [],
  };
  assert.equal(tabShows(mining, RAT, state, STANCE_CONTEXT), false, "the player named the side");
  assert.equal(tabShows(ALL, RAT, state, STANCE_CONTEXT), true, "All is still absolute");
});

test("a stance hide covers the side, not the whole role", () => {
  const state: TabHiddenState = {
    hidden: [{ kind: "stance", role: "ship", stance: "neutral", label: "Ships (Neutral)" }],
    shown: [],
  };
  // PVE allows ships, so only the stance entry can keep them out.
  assert.equal(tabShows(pve, NEUTRAL_SHIP, state, STANCE_CONTEXT), false, "the neutral side went");
  assert.equal(tabShows(pve, FRIENDLY_SHIP, state, STANCE_CONTEXT), true, "the friendly side stayed");
});

test("⚠ hiding your own side is the TOGGLE's job, not a preset's", () => {
  // ⚠ PVP AND PRESET STANCE PRE-HIDES ARE BOTH GONE. A recipe no longer reads
  // stance, so there is nothing left for a preset to pre-hide by side — and
  // "pvp" was only ever the vehicle for exactly that.
  assert.equal(tabShows(pve, FRIENDLY_SHIP, EMPTY_STATE, STANCE_CONTEXT), true, "PVE dropped a friendly ship");
  assert.equal(tabShows(pve, NEUTRAL_SHIP, EMPTY_STATE, STANCE_CONTEXT), true, "PVE dropped a neutral ship");
  // ⚠ AND A RECIPE IGNORES THE CONTEXT ENTIRELY — even when handed one.
  assert.equal(tabShows(pve, FRIENDLY_SHIP, EMPTY_STATE, null), true, "no context, different answer");
});

test("a preset's category hides show up as menu rows, one word each", () => {
  // ⚠ THE MENU IS THE RECIPE'S OWN LIST. Mining excludes ships, and the tab's
  // Hidden Items menu says so without anything having to scan the grid.
  assert.equal(presetHidesRow(mining, NEUTRAL_SHIP, EMPTY_STATE, STANCE_CONTEXT), true);
  assert.equal(presetHidesRow(mining, ROCK, EMPTY_STATE, STANCE_CONTEXT), false, "a rock is mining");
  // Decided in either direction, the row leaves the preset's hands and the tab's
  // own list owns it.
  const hidIt: TabHiddenState = {
    hidden: [{ kind: "category", category: "ship", label: "Ships" }],
    shown: [],
  };
  assert.equal(presetHidesRow(mining, NEUTRAL_SHIP, hidIt, STANCE_CONTEXT), false, "the player's entry owns it");
  const unPreHid: TabHiddenState = {
    hidden: [],
    shown: [{ kind: "category", category: "ship", label: "Ships" }],
  };
  assert.equal(presetHidesRow(mining, NEUTRAL_SHIP, unPreHid, STANCE_CONTEXT), false, "the undo is recorded");
  // All pre-hides nothing.
  assert.equal(presetHidesRow(ALL, FRIENDLY_SHIP, EMPTY_STATE, STANCE_CONTEXT), false, "All pre-hides something");
  // And a hostile is never a preset's business.
  assert.equal(presetHidesRow(mining, RAT, EMPTY_STATE, STANCE_CONTEXT), false, "a threat is a pre-hiding");
});

// --- the stance entries in the store -------------------------------------------

test("the store hides a stance pair, idempotently, per tab", () => {
  const store = createTabHiddenStore();
  const entry = store.hideStance("pvp", FRIENDLY_SHIP, STANCE_CONTEXT);
  assert.ok(entry);
  assert.equal(entry.kind, "stance");
  assert.equal(entry.role, "ship");
  assert.equal(entry.stance, "friendly");
  assert.equal(entry.label, "Ships (Friendly)");
  // The same pair twice is one entry…
  store.hideStance("pvp", FRIENDLY_SHIP, STANCE_CONTEXT);
  assert.equal(store.stateFor("pvp").hidden.length, 1, "the pair was doubled");
  // …and a different side is a different entry.
  store.hideStance("pvp", NEUTRAL_SHIP, STANCE_CONTEXT);
  assert.equal(store.stateFor("pvp").hidden.length, 2, "the other side is the same row, not the same entry");
  // The other tab keeps its own lists.
  assert.deepEqual(store.stateFor("combat"), EMPTY_STATE, "the hiding leaked to a tab");
  // A row whose role carries no stance row is refused with null, like the group hide.
  assert.equal(store.hideStance("pvp", GATE, STANCE_CONTEXT), null);
  // And undoing drops exactly the pair.
  store.unhideStance("pvp", "ship", "neutral");
  assert.equal(store.stateFor("pvp").hidden.length, 1, "the undo took the wrong side");
  store.unhideStance("pvp", "ship", "neutral");
  assert.equal(store.stateFor("pvp").hidden.length, 1, "a second undo is not a no-op");
});

test("addStance / removeStance are the stance mirror of the group side", () => {
  const store = createTabHiddenStore();
  store.addStance("pvp", "ship", "friendly");
  assert.equal(store.stateFor("pvp").shown.length, 1, "the expansion was not recorded");
  store.addStance("pvp", "ship", "friendly");
  assert.equal(store.stateFor("pvp").shown.length, 1, "the undo was doubled");
  store.addStance("pvp", "gate", "neutral");
  assert.equal(store.stateFor("pvp").shown.length, 1, "a role without a stance row was admitted");
  store.removeStance("pvp", "ship", "friendly");
  assert.deepEqual(store.stateFor("pvp").shown, [], "the expansion was not taken off");
});

test("clearHidden forgets the tab's stance hides too", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.hideStance("mining", FRIENDLY_SHIP, STANCE_CONTEXT);
  store.clearHidden("mining");
  assert.deepEqual(store.stateFor("mining").hidden, [], "a stance hide survived the clear");
});

test("⚠ resetTab puts the tab back to its PRESET alone — both lists go", () => {
  // ⚠ GOAL 4'S RESET IS NOT `clearHidden`. A reset must also drop the `shown`
  // overrides the player accumulated while expanding the tab — otherwise a
  // "reset" Mining tab would still show things Mining hides, and the word would
  // not mean what it says.
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.addCategory("mining", "gate");
  assert.equal(store.stateFor("mining").hidden.length, 1);
  assert.equal(store.stateFor("mining").shown.length, 1);

  store.resetTab("mining");
  assert.deepEqual(store.stateFor("mining"), EMPTY_STATE, "the tab kept its own lists");

  // ⚠ AND THE TAB ITSELF IS UNTOUCHED — name, order and recipe are not the
  // store's business, and `resetTab` is a different event from `dropTab`.
  assert.equal(store.stateFor("travel"), EMPTY_STATE, "another tab was disturbed");
  // A second press is a no-op rather than an error or a new entry.
  store.resetTab("mining");
  assert.deepEqual(store.stateFor("mining"), EMPTY_STATE);
});

test("⚠ resetTab and show-everything are different, and both are per-tab", () => {
  // The pair is the point of goals 3 and 4: one clears the hidden list (the tab
  // then shows everything), the other restores the preset. They touch different
  // state, and neither touches another tab.
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "planet");
  store.hide("travel", MOON, "moon");

  store.resetTab("mining");
  assert.deepEqual(store.stateFor("mining"), EMPTY_STATE);
  assert.equal(store.stateFor("travel").hidden.length, 1, "the other tab was reset too");

  store.clearHidden("travel");
  assert.deepEqual(store.stateFor("travel").hidden, []);
  assert.equal(store.stateFor("travel").shown.length, 0);
});

// --- the friendly / neutral combat toggles (PLAN pivot, 2026-04-10) -----------
//
// ⚠ REUSES `FRIENDLY_SHIP` / `NEUTRAL_SHIP` from the stance section above, now
// carrying the SDE hull category. The sentry and the orbital are new, and are
// the two objects the in-game report and the plan's carve-out turn on.
const SENTRY = entity({ itemID: 32, groupID: 99, categoryID: 11, kind: null, characterID: MY_CHARACTER });
const CUSTOMS = entity({ itemID: 33, groupID: 1025, categoryID: 46, kind: null });
const PLANET_ROW = entity({ itemID: 34, groupID: PLANET_GROUP, categoryID: 2 });
// ⚠ THE SAME CONTEXT THE STANCE SECTION USES, so a fixture that is friendly
// there is friendly here — two contexts would silently test different ships.
const CTX: StanceContext = { characterID: MY_CHARACTER, corporationID: null, allianceID: null };

test("⚠ the friendly toggle hides friendly COMBAT-CAPABLE things and nothing else", () => {
  const on = new Set<CombatStance>(["friendly"]);

  assert.equal(combatStanceHides(FRIENDLY_SHIP, on, CTX), true, "a friendly ship stayed");
  assert.equal(combatStanceHides(SENTRY, on, CTX), true, "a friendly sentry stayed");
  assert.equal(combatStanceHides(NEUTRAL_SHIP, on, CTX), false, "a neutral ship was hidden too");
  // ⚠ AND THE FURNISHING IS NOT REACHED, which is the plan's own carve-out.
  assert.equal(combatStanceHides(PLANET_ROW, on, CTX), false, "a planet was hidden by side");
  assert.equal(combatStanceHides(CUSTOMS, on, CTX), false, "an orbital was hidden by side");
  // ⚠ AND NEITHER TOGGLE REACHES A HOSTILE.
  assert.equal(combatStanceHides(RAT, on, CTX), false, "a threat was hidden by the friendly toggle");
  assert.equal(
    combatStanceHides(RAT, new Set<CombatStance>(["neutral"]), CTX),
    false,
    "a threat was hidden by the neutral toggle",
  );
});

test("⚠ the neutral toggle hides neutral combat-capable things, and only those", () => {
  const on = new Set<CombatStance>(["neutral"]);
  assert.equal(combatStanceHides(NEUTRAL_SHIP, on, CTX), true);
  assert.equal(combatStanceHides(FRIENDLY_SHIP, on, CTX), false);
  assert.equal(combatStanceHides(PLANET_ROW, on, CTX), false, "a neutral planet was hidden");
});

test("⚠ no toggle on, nothing hidden", () => {
  const none = new Set<CombatStance>();
  for (const row of [FRIENDLY_SHIP, NEUTRAL_SHIP, SENTRY, CUSTOMS, PLANET_ROW]) {
    assert.equal(combatStanceHides(row, none, CTX), false);
  }
});

test("⚠ the toggles are per-tab and are NOT hidden entries", () => {
  // ⚠ THE WHOLE POINT OF MAKING THEM SEPARATE. They never reach `hidden`, so
  // they cannot appear in the Hidden Items menu — their state is the struck-
  // through button, and retoggling undoes them.
  const store = createTabHiddenStore();
  const toggles = createCombatToggleStore();

  assert.equal(toggles.toggle("mining", "friendly"), true, "the toggle did not switch on");
  assert.equal(toggles.forTab("mining").has("friendly"), true);
  assert.deepEqual(store.stateFor("mining"), EMPTY_STATE, "a toggle wrote a hidden entry");
  assert.equal(toggles.forTab("travel").size, 0, "another tab was touched");

  // A second press turns it back off, and the entry is dropped rather than
  // left behind empty.
  assert.equal(toggles.toggle("mining", "friendly"), false);
  assert.equal(toggles.forTab("mining").has("friendly"), false);
  assert.equal(toggles.map.get().has("mining"), false, "an empty toggle entry was left behind");
});

test("⚠ clear() puts both sides back for one tab only", () => {
  const toggles = createCombatToggleStore();
  toggles.toggle("mining", "friendly");
  toggles.toggle("mining", "neutral");
  toggles.toggle("travel", "neutral");

  toggles.clear("mining");
  assert.equal(toggles.map.get().has("mining"), false);
  assert.equal(toggles.forTab("travel").has("neutral"), true, "another tab was cleared");
});

// --- the storage key -------------------------------------------------------------

/** A localStorage stub the store can read and write against. */
function storageStub(seed: Record<string, string>): {
  readonly store: Map<string, string>;
  readonly api: unknown;
} {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    api: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };
}

/** Run a body with a stubbed localStorage, restoring whatever was there. */
function withStorage<T>(seed: Record<string, string>, body: (store: Map<string, string>) => T): T {
  const stub = storageStub(seed);
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = stub.api;
  try {
    return body(stub.store);
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  }
}

test("a v5 store round-trips through storage", () => {
  withStorage({}, (store) => {
    const hidden = createTabHiddenStore();
    hidden.hide("mining", PLANET, "planet");
    hidden.addCategory("mining", "gate");

    assert.ok(store.has("evejs-web:overview-hidden:v5"), "the write went to the wrong key");

    // A fresh store must read back exactly what the first one wrote.
    const reloaded = createTabHiddenStore();
    const state = reloaded.stateFor("mining");
    assert.equal(state.hidden.length, 1);
    assert.equal(state.hidden[0]?.kind, "category");
    assert.equal(state.hidden[0]?.label, "Planets");
    assert.equal(state.shown.length, 1);
    assert.equal(state.shown[0]?.kind, "category");
  });
});

test("⚠ v3 and v4 group stores are NOT read — the hard cut, asserted", () => {
  // ⚠ THE USER'S CALL, AND IT LOSES DATA ON PURPOSE. Group ids have no honest
  // translation into categories — group 7 could be `planet` or `scenery`, and
  // guessing would silently hide a different set of objects. So the old keys are
  // not read, and a player's pre-category hides are gone rather than mistranslated.
  const legacy = JSON.stringify({
    mining: {
      hidden: [{ groupID: 7, label: "Planet" }],
      shown: [{ groupID: 10, label: "Stargate" }],
    },
  });

  withStorage({ "evejs-web:overview-hidden:v4": legacy }, (store) => {
    const reloaded = createTabHiddenStore();
    assert.deepEqual(reloaded.stateFor("mining"), EMPTY_STATE, "a v4 store leaked through");
  });

  withStorage({ "evejs-web:overview-hidden:v3": legacy }, (store) => {
    const reloaded = createTabHiddenStore();
    assert.deepEqual(reloaded.stateFor("mining"), EMPTY_STATE, "a v3 store leaked through");
  });

  // ⚠ AND THE DEAD KEYS ARE LEFT ALONE, not deleted. Nothing reads them and
  // nothing writes them, but they are the player's browser and this module does
  // not get to decide to destroy data it merely no longer understands.
  withStorage({ "evejs-web:overview-hidden:v4": legacy }, (store) => {
    createTabHiddenStore();
    assert.ok(store.has("evejs-web:overview-hidden:v4"), "the v4 record was destroyed");
  });
});

test("a stored record naming an unknown category is dropped, not coerced", () => {
  // ⚠ THE SANITIZER IS THE TRUST BOUNDARY. A hand-edited or corrupt record must
  // not be able to install a category the classifier would never produce, and
  // `other` in particular is refused: it is the bucket for objects nothing could
  // name, and a stored `other` entry would hide all of them at once.
  const hostile = JSON.stringify({
    mining: {
      hidden: [
        { kind: "category", category: "not-a-category", label: "Nonsense" },
        { kind: "category", category: "other", label: "Other" },
        { kind: "category", category: "planet", label: "STALE LABEL" },
      ],
      shown: [],
    },
  });

  withStorage({ "evejs-web:overview-hidden:v5": hostile }, () => {
    const reloaded = createTabHiddenStore();
    const state = reloaded.stateFor("mining");
    assert.equal(state.hidden.length, 1, "a forged category survived the sanitizer");
    // ⚠ AND THE LABEL IS RE-DERIVED, not trusted, so a stale word cannot reach
    // the restore menu.
    assert.equal(state.hidden[0]?.label, "Planets");
  });
});

