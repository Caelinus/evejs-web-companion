// The per-tab hidden state (goal R90, refined): EACH tab's two lists — the
// GROUPS the player hid on that tab, and the GROUPS the player added to that
// tab beyond its preset — plus the one rule that outranks their choice.
//
// Hiding is BY GROUP, not by object and not by type, and BY TAB: pressing Hide
// on a planet hides every planet ON THAT TAB, and the tab's restore menu says
// "Planet". Every other tab keeps showing the planets, and All shows them all —
// it is the fallback and hides nothing at all.

import test from "node:test";
import assert from "node:assert/strict";

import {
  covers,
  createTabHiddenStore,
  EMPTY_STATE,
  groupIsHidden,
  groupIsShown,
  hiddenEntryFor,
  presetHides,
  stateFor,
  tabShows,
  type TabHiddenState,
} from "./overviewHidden.ts";
import { recipeByID, recipeAllows } from "./overviewRecipes.ts";
import { isHostile } from "./overview.ts";
import type { OverviewTab } from "./overviewTabs.ts";
import type { SpaceEntity } from "../store/types.ts";

/** One plain tab: `id` as its name, built from a recipe, never fixed. */
function tab(id: string, recipeId: "all" | "mining" | "travel" | "combat"): OverviewTab {
  return { id, name: id, recipeId, fixed: false };
}

/** The fixed All tab — the one that shows everything and hides nothing. */
const ALL: OverviewTab = { id: "all", name: "All", recipeId: "all", fixed: true };
const mining = tab("mining", "mining");
const travel = tab("travel", "travel");

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
const DECOR = entity({ itemID: 4, groupID: 1250, typeID: 5555, kind: "structure" });
const RAT = entity({ itemID: 5, kind: "ship", groupID: 25, isNpc: true, npcEntityType: "npc" });
/** Group 450 holds the asteroids; group 10 the stargates (the classifier's own id). */
const ASTEROID_GROUP = 450;
const GATE_GROUP = 10;
/** A rock (asteroid group) and a gate — the two presets' stock examples. */
const ROCK = entity({ itemID: 14, groupID: ASTEROID_GROUP, typeID: 1230, kind: "celestial", miningYieldTypeID: 1230 });
const GATE = entity({ itemID: 15, groupID: GATE_GROUP, typeID: 101, kind: "celestial" });

// --- the entry is a group ----------------------------------------------------

test("⚠ hiding a planet hides EVERY planet, not just that one", () => {
  // ⚠ THE WHOLE OF THE CHANGE. Two different planet TYPES, one group, both gone —
  // which is what "hide the planets" means and what a type-keyed list could not do.
  const entry = hiddenEntryFor(PLANET, "Planet");
  assert.ok(entry, "a grouped row should produce an entry");
  assert.equal(entry.groupID, PLANET_GROUP);
  assert.equal(entry.label, "Planet", "the entry is named for the GROUP, not the object");
  assert.equal(covers(entry, PLANET), true);
  assert.equal(covers(entry, OTHER_PLANET), true, "a different planet type matched too");
});

test("hiding one group does not hide another", () => {
  const entry = hiddenEntryFor(PLANET, "Planet");
  assert.ok(entry);
  assert.equal(covers(entry, MOON), false, "a moon went missing with the planets");
  assert.equal(covers(entry, DECOR), false);
});

test("the entry carries the GROUP's name, never the object's own name", () => {
  // ⚠ THE MENU READS THIS. A named rock ("Veldspar") would put a specific object
  // in a list whose unit is the group, and the player could not tell what
  // pressing Show would bring back.
  const namedRock = entity({ itemID: 6, name: "Veldspar", groupID: 450, kind: "asteroid" });
  const entry = hiddenEntryFor(namedRock, "Asteroid");
  assert.ok(entry);
  assert.equal(entry.label, "Asteroid");
  assert.ok(!entry.label.includes("Veldspar"));
});

test("⚠ a row with no group cannot be hidden at all", () => {
  // ⚠ RETURNS null RATHER THAN INVENTING A KEY. A groupID of 0 would match every
  // ungrouped row in the system, so one press could empty the overview.
  assert.equal(hiddenEntryFor(entity({ itemID: 7, groupID: null }), "Mystery"), null);
  assert.equal(hiddenEntryFor(entity({ itemID: 8, groupID: 0 }), "Zero"), null);
  assert.equal(hiddenEntryFor(entity({ itemID: 9, groupID: -3 }), "Negative"), null);
});

test("a row with a group is always matched by that group, whatever its type", () => {
  const shared = entity({ itemID: 10, groupID: 450 });
  const other = entity({ itemID: 11, groupID: 450, typeID: 1230, kind: "asteroid" });
  const entry = hiddenEntryFor(shared, "Asteroid");
  assert.ok(entry);
  assert.equal(covers(entry, other), true, "a different type in the same group stayed");
});

test("covers is the whole of the matching rule", () => {
  const entry = { groupID: PLANET_GROUP, label: "Planet" };
  assert.equal(covers(entry, PLANET), true);
  assert.equal(covers(entry, OTHER_PLANET), true);
  assert.equal(covers(entry, MOON), false);
  assert.equal(covers(entry, entity({ itemID: 12, groupID: null })), false);
});

// --- the resolver: the order hostile, all, hidden, shown, preset --------------

test("⚠ a HOSTILE is never hidden, even when its group is hidden", () => {
  // ⚠ THIS GOT MORE LIKELY TO MATTER, NOT LESS. Hiding is broad — one group,
  // not one object — so a group that happens to contain a threat is a far easier
  // accident. A rat is `kind: "ship"`, and a group covering player hulls would
  // otherwise take the contents of the threat strip out of the list.
  const state: TabHiddenState = { hidden: [{ groupID: 25, label: "Pirate" }], shown: [] };
  assert.equal(tabShows(mining, RAT, state), true, "a threat was hidden by group");
  assert.equal(groupIsHidden(25, state), true, "the list still records the ask");
  assert.equal(isHostile(RAT), true);
});

test("⚠ ALL IS ABSOLUTE, EVEN WITH FULL LISTS LOADED FOR IT", () => {
  // ⚠ THE FALLBACK. A state loaded with enough to empty a whole tab must not be
  // able to empty the tab that is the way back to seeing everything.
  const state: TabHiddenState = {
    hidden: [
      { groupID: PLANET_GROUP, label: "Planet" },
      { groupID: 25, label: "Pirate" },
      { groupID: ASTEROID_GROUP, label: "Asteroid" },
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
    hidden: [{ groupID: PLANET_GROUP, label: "Planet" }],
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
  const hidIt: TabHiddenState = { hidden: [{ groupID: GATE_GROUP, label: "Stargate" }], shown: [] };
  assert.equal(presetHides(mining, GATE, hidIt), false, "the hiding is listed twice");
  // The player undid the pre-hiding: the `shown` entry owns it.
  const unPreHid: TabHiddenState = { hidden: [], shown: [{ groupID: GATE_GROUP, label: "Stargate" }] };
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
  const state: TabHiddenState = { hidden: [], shown: [{ groupID: GATE_GROUP, label: "Stargate" }] };
  assert.ok(!recipeAllows(recipeByID("mining"), GATE), "the premise: gates are not mining");
  assert.equal(tabShows(mining, GATE, EMPTY_STATE), false, "before: the preset did not show it");
  assert.equal(tabShows(mining, GATE, state), true, "after: the tab was expanded");
  assert.equal(tabShows(travel, GATE, state), true, "the other tab is not affected either way");
});

test("⚠ a group the tab hid beats a group the tab added", () => {
  // ⚠ THE ORDER MATTERS AND IT IS FIXED: hidden beats shown. A group that is in
  // both of one tab's lists is the player's last word winning, not the first.
  const state: TabHiddenState = {
    hidden: [{ groupID: GATE_GROUP, label: "Stargate" }],
    shown: [{ groupID: GATE_GROUP, label: "Stargate" }],
  };
  assert.equal(tabShows(mining, GATE, state), false, "the hidden word came first");
});

test("a row with no group is decided by the preset alone", () => {
  // ⚠ THE LISTS CANNOT REACH IT. An ungrouped row has no group to hide or add,
  // so it answers to the recipe and nothing else.
  const ungrouped = entity({ itemID: 16, groupID: null, kind: "asteroid" });
  const state: TabHiddenState = { hidden: [{ groupID: 0, label: "None" }], shown: [] };
  assert.equal(
    tabShows(mining, ungrouped, state),
    recipeAllows(recipeByID("mining"), ungrouped),
    "the lists reached an ungrouped row",
  );
});

// --- the store ----------------------------------------------------------------

test("hiding the same group twice on a tab is one entry", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "Planet");
  store.hide("mining", OTHER_PLANET, "Planet");
  assert.equal(store.stateFor("mining").hidden.length, 1, "the restore menu would show a duplicate");
});

test("hiding two groups gives two entries, named for their groups", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "Planet");
  store.hide("mining", DECOR, "Emitter");
  assert.deepEqual(
    store.stateFor("mining").hidden.map((entry) => entry.label),
    ["Planet", "Emitter"],
  );
});

test("hiding tells the caller when there was nothing to hide", () => {
  // ⚠ THE ONLY CASE WHERE A PRESS DOES NOTHING, so the caller has to be able to
  // SAY so in the tooltip rather than leave the player watching an inert button.
  const store = createTabHiddenStore();
  assert.equal(store.hide("mining", PLANET, "Planet")?.groupID, PLANET_GROUP);
  assert.equal(store.hide("mining", entity({ itemID: 17, groupID: null }), "Mystery"), null);
  assert.equal(store.stateFor("mining").hidden.length, 1, "a refused hide still added an entry");
});

test("⚠ the two tabs' states never touch each other", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "Planet");
  store.addGroup("travel", GATE_GROUP, "Stargate");
  assert.equal(store.stateFor("mining").hidden.length, 1);
  assert.deepEqual(store.stateFor("travel").hidden, [], "the other tab gained a hiding");
  assert.equal(store.stateFor("travel").shown.length, 1);
  assert.deepEqual(stateFor(store.map.get(), "combat"), EMPTY_STATE);
});

test("unhideGroup removes exactly one group, by id, on its own tab", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "Planet");
  store.hide("mining", DECOR, "Emitter");
  store.unhideGroup("mining", PLANET_GROUP);
  assert.deepEqual(store.stateFor("mining").hidden.map((entry) => entry.label), ["Emitter"]);
  // Bringing back a group the tab never hid is a no-op, not a creation.
  store.unhideGroup("mining", PLANET_GROUP);
  assert.equal(store.stateFor("mining").hidden.length, 1);
});

test("addGroup expands the tab; removeGroup takes it off again", () => {
  const store = createTabHiddenStore();
  store.addGroup("mining", GATE_GROUP, "Stargate");
  assert.equal(store.stateFor("mining").shown.length, 1, "the tab was not expanded");
  // Adding the same group twice is one entry.
  store.addGroup("mining", GATE_GROUP, "Stargate");
  assert.equal(store.stateFor("mining").shown.length, 1, "the expansion was doubled");
  // And a group that cannot be named is refused, like a hide.
  store.addGroup("mining", 0, "Nothing");
  assert.equal(store.stateFor("mining").shown.length, 1);
  store.removeGroup("mining", GATE_GROUP);
  assert.deepEqual(store.stateFor("mining").shown, []);
  // A group never added is a no-op, not an error or a hole.
  store.removeGroup("mining", GATE_GROUP);
  assert.deepEqual(store.stateFor("mining").shown, []);
});

test("clearHidden forgets the tab's hiding, and the tab's additions only", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "Planet");
  store.addGroup("mining", GATE_GROUP, "Stargate");
  store.clearHidden("mining");
  assert.deepEqual(store.stateFor("mining").hidden, [], "the hiding was not cleared");
  assert.equal(store.stateFor("mining").shown.length, 1, "clear dragged in the additions");
  // Clearing a tab that hides nothing must not create a state for it.
  store.clearHidden("travel");
  assert.equal(store.map.get().has("travel"), false, "an empty clear left an entry");
});

test("dropTab takes both lists with the tab", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "Planet");
  store.addGroup("mining", GATE_GROUP, "Stargate");
  store.dropTab("mining");
  assert.equal(store.map.get().has("mining"), false, "the deleted tab's lists outlived it");
  store.dropTab("mining");
  assert.equal(store.map.get().has("mining"), false, "dropping an absent tab left a trace");
});

test("clearAll forgets every tab's lists", () => {
  const store = createTabHiddenStore();
  store.hide("mining", PLANET, "Planet");
  store.addGroup("travel", GATE_GROUP, "Stargate");
  store.clearAll();
  assert.equal(store.map.get().size, 0);
});

test("two stores built separately never share state", () => {
  const a = createTabHiddenStore();
  const b = createTabHiddenStore();
  a.hide("mining", PLANET, "Planet");
  assert.equal(a.stateFor("mining").hidden.length, 1);
  assert.deepEqual(b.stateFor("mining"), EMPTY_STATE);
});

test("a subscriber is told when a tab's lists change", () => {
  const store = createTabHiddenStore();
  const seen: number[] = [];
  const stop = store.map.subscribe((map) => seen.push(map.get("mining")?.hidden.length ?? 0));
  store.hide("mining", PLANET, "Planet");
  store.unhideGroup("mining", PLANET_GROUP);
  stop();
  assert.deepEqual(seen, [0, 1, 0]);
});

test("a hostile ask is recorded, and the resolver still shows it", () => {
  // ⚠ THE ONE PLACE THE RECORD AND THE VIEW DIVERGE, AND IT IS DELIBERATE. The
  // tab's list answers "did the player ask to hide this"; `tabShows` answers
  // "does it show", and refuses to hide a threat on the spot.
  const store = createTabHiddenStore();
  store.hide("mining", RAT, "Pirate");
  assert.equal(groupIsHidden(25, store.stateFor("mining")), true, "the ask was not recorded");
  assert.equal(tabShows(mining, RAT, store.stateFor("mining")), true, "the threat was hidden");
  assert.equal(isHostile(RAT), true);
});