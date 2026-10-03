// Overview recipes (goal R79) + the tab bar built from them (goal R90).
//
// The split under test is the whole of the second-pass design: RECIPES decide
// membership and know nothing about the player; TABS are a name plus a recipe
// and are the player's to create and delete. Nothing here may classify an object
// by who the player is.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ALL_RECIPE,
  DEFAULT_TAB_RECIPES,
  OVERVIEW_RECIPES,
  applyRecipe,
  recipeAllows,
  recipeByID,
  recipePreHidesStance,
  type OverviewRecipeID,
} from "./overviewRecipes.ts";
import {
  MAX_TAB_NAME_LENGTH,
  createTabBar,
  defaultTabs,
  normalizeTabName,
  tabAllows,
} from "./overviewTabs.ts";
import { bracketRole } from "./tactical.ts";
import { isHostile } from "./overview.ts";
import type { SpaceEntity } from "../store/types.ts";

const ORIGIN = { x: 0, y: 0, z: 0 };

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "ship",
    typeID: 1000,
    groupID: 25,
    categoryID: 6,
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

const ROCK = entity({ itemID: 1, kind: "celestial", miningYieldTypeID: 1230 });
const GATE = entity({ itemID: 2, kind: "celestial", groupID: 10 });
const STATION = entity({ itemID: 3, kind: "structure" });
const PLANET = entity({ itemID: 4, kind: "celestial", groupID: 7 });
const PLAYER_SHIP = entity({ itemID: 5, kind: "ship" });
const WRECK = entity({ itemID: 6, kind: "wreck" });
const DRONE = entity({ itemID: 7, kind: "drone" });
const RAT = entity({ itemID: 8, kind: "ship", isNpc: true, npcEntityType: "npc" });
const POLICE = entity({ itemID: 9, kind: "ship", isNpc: true, npcEntityType: "concord" });
const EVERYTHING = [ROCK, GATE, STATION, PLANET, PLAYER_SHIP, WRECK, DRONE, RAT, POLICE];

function idsFor(recipeID: string): number[] {
  return applyRecipe(EVERYTHING, recipeByID(recipeID)).map((row) => row.itemID);
}

// --- the six recipes ---------------------------------------------------------

test("there are exactly the six recipes the preset refresh offers", () => {
  assert.deepEqual(OVERVIEW_RECIPES.map((recipe) => recipe.id), [
    "all",
    "system",
    "pve",
    "pvp",
    "mining",
    "travel",
  ]);
});

test("All shows everything", () => {
  assert.deepEqual(idsFor("all"), EVERYTHING.map((row) => row.itemID));
});

test("Mining shows rocks and somewhere to unload them", () => {
  const ids = idsFor("mining");
  assert.ok(ids.includes(ROCK.itemID), "rocks");
  assert.ok(ids.includes(STATION.itemID), "a full hold is the other half of the trip");
  assert.ok(ids.includes(DRONE.itemID), "mining drones");
  assert.equal(ids.includes(GATE.itemID), false, "gates are not mining");
});

test("Travel shows the things you fly to", () => {
  const ids = idsFor("travel");
  assert.ok(ids.includes(GATE.itemID));
  assert.ok(ids.includes(STATION.itemID));
  assert.ok(ids.includes(PLANET.itemID));
  assert.equal(ids.includes(ROCK.itemID), false, "rocks are not a destination");
});

test("System shows the whole system and only the rocks fall out", () => {
  const ids = idsFor("system");
  assert.ok(ids.includes(PLAYER_SHIP.itemID), "ships");
  assert.ok(ids.includes(POLICE.itemID), "law enforcement");
  assert.ok(ids.includes(WRECK.itemID), "wrecks");
  assert.ok(ids.includes(DRONE.itemID), "drones");
  assert.ok(ids.includes(STATION.itemID), "structures");
  assert.ok(ids.includes(GATE.itemID), "gates");
  assert.ok(ids.includes(PLANET.itemID), "celestials");
  assert.equal(ids.includes(ROCK.itemID), false, "rocks are the one thing left out");
});

test("PVE shows ships, drones and wrecks", () => {
  const ids = idsFor("pve");
  assert.ok(ids.includes(PLAYER_SHIP.itemID));
  assert.ok(ids.includes(WRECK.itemID));
  assert.ok(ids.includes(DRONE.itemID));
  assert.equal(ids.includes(ROCK.itemID), false);
});

test("⚠ the old 'combat' id still answers as PVE, so a saved bar keeps working", () => {
  // ⚠ THE RENAME MIGRATION. A bar that shipped before the refresh names its
  // combat tab 'combat'; it must resolve to the renamed recipe, not fall back
  // to All and quietly start showing the whole grid.
  assert.equal(recipeByID("combat").id, "pve");
  assert.deepEqual(idsFor("combat"), idsFor("pve"), "the alias answers a different recipe");
  // A truly unknown id still falls back to All.
  assert.equal(recipeByID("not-a-recipe").id, "all");
});

test("the default tabs are the five editable ones — All is not one of them", () => {
  // ⚠ THE DISTINCTION THE PANEL'S FIXED-TAB RULE TURNS ON. All is a recipe and
  // it is the fixed tab, but it is NOT a default *editable* tab; shipping it in
  // this list would create a second copy of it on first run.
  assert.deepEqual(DEFAULT_TAB_RECIPES, ["system", "pve", "pvp", "mining", "travel"]);
  assert.equal(DEFAULT_TAB_RECIPES.includes(ALL_RECIPE), false);
});

test("EVERY recipe shows a hostile, including the ones that filter it out by role", () => {
  // ⚠ THE RULE THAT OUTRANKS THE TABS. Mining and Travel both exclude the "ship"
  // role, and a rat is a ship.
  for (const recipe of OVERVIEW_RECIPES) {
    assert.ok(recipeAllows(recipe, RAT), `'${recipe.id}' hid something shooting at you`);
  }
});

test("law enforcement obeys the recipes like anything else", () => {
  assert.equal(recipeAllows(recipeByID("mining"), POLICE), false);
  assert.equal(recipeAllows(recipeByID("combat"), POLICE), true);
});

test("an NPC of unknown kind counts as a threat and is force-shown", () => {
  const unknown = entity({ itemID: 99, kind: "ship", isNpc: true, npcEntityType: null });
  assert.equal(bracketRole(unknown), "hostile");
  assert.equal(recipeAllows(recipeByID("travel"), unknown), true);
});

// --- the stance axis ---------------------------------------------------------

const MY_CHARACTER = 9101;
const MY_CORP = 9201;
const MY_ALLIANCE = 9301;
const CONTEXT = { characterID: MY_CHARACTER, corporationID: MY_CORP, allianceID: MY_ALLIANCE };

const FRIENDLY_SHIP = entity({
  itemID: 20,
  kind: "ship",
  characterID: MY_CHARACTER,
});
const CORP_SHIP = entity({
  itemID: 21,
  kind: "ship",
  corporationID: MY_CORP,
});
const ALLIANCE_SHIP = entity({
  itemID: 22,
  kind: "ship",
  allianceID: MY_ALLIANCE,
});
const OWNED_DRONE = entity({ itemID: 23, kind: "drone", ownerID: MY_CHARACTER });

test("PVP hides the friendly side by role-and-side, and nothing else", () => {
  const pvp = recipeByID("pvp");
  // ⚠ THE REQUEST IT EXISTS FOR. A hostile stays, a friendly one goes —
  // same role, different side, different answer.
  assert.equal(recipePreHidesStance(pvp, FRIENDLY_SHIP, CONTEXT), true, "own ship");
  assert.equal(recipePreHidesStance(pvp, CORP_SHIP, CONTEXT), true, "corp-mate");
  assert.equal(recipePreHidesStance(pvp, ALLIANCE_SHIP, CONTEXT), true, "alliance-mate");
  assert.equal(recipePreHidesStance(pvp, OWNED_DRONE, CONTEXT), true, "own drone");
  assert.equal(recipePreHidesStance(pvp, PLAYER_SHIP, CONTEXT), false, "a neutral ship");
  assert.equal(recipePreHidesStance(pvp, RAT, CONTEXT), false, "a hostile is never pre-hidden");
  // And the role allow-list alone still admits them: the HIDE comes from the
  // stance entry, not from the roles.
  assert.equal(recipeAllows(pvp, FRIENDLY_SHIP), true);
});

test("PVP differs from PVE only by its stance pre-hides", () => {
  // ⚠ THE SPLIT THE PLAN PINNED: PVE and PVP are the same roles; the preset
  // refresh's whole "PVP" column is stance.
  const pve = recipeByID("pve");
  const pvp = recipeByID("pvp");
  assert.ok(pve.roles, "PVE lost its role set");
  assert.ok(pvp.roles, "PVP lost its role set");
  assert.deepEqual([...pve.roles], [...pvp.roles], "the roles changed");
  assert.equal(pve.stancePreHides, undefined, "PVE names a side");
  assert.ok(pvp.stancePreHides?.length, "PVP names no side");
  // Without a context nothing reads as friendly, so the two answer alike.
  assert.deepEqual(
    applyRecipe([FRIENDLY_SHIP], pve).length,
    applyRecipe([FRIENDLY_SHIP], pvp, null).length,
  );
  // With one, PVP drops the friendly ship and PVE keeps it.
  assert.equal(applyRecipe([FRIENDLY_SHIP], pve, CONTEXT).length, 1);
  assert.equal(applyRecipe([FRIENDLY_SHIP], pvp, CONTEXT).length, 0, "the friendly ship stayed on PVP");
});

test("Mining pre-hides a lone neutral ship; a logi and a rat both stay", () => {
  const mining = recipeByID("mining");
  assert.equal(recipePreHidesStance(mining, PLAYER_SHIP, CONTEXT), true, "neutral noise");
  assert.equal(recipePreHidesStance(mining, FRIENDLY_SHIP, CONTEXT), false, "your logi is not noise");
  assert.equal(recipePreHidesStance(mining, RAT, CONTEXT), false, "a threat is not noise");
  // And a friendly ship is not shown on Mining at all: the role allow-list
  // (ships are not mining) still governs; the stance axis only refines roles
  // the recipe shows, it never admits or ejects on its own.
  assert.equal(recipeAllows(mining, FRIENDLY_SHIP), false, "the role rule still governs");
});

test("no default recipe pre-hides the hostile stance", () => {
  // ⚠ THE INVARIANT THAT KEEPS THE RELAXATION SAFE. Hiding a hostile requires
  // naming it — a recipe entry or the player's own "Hostiles" hide — and no
  // shipped preset names the hostile side.
  for (const recipe of OVERVIEW_RECIPES) {
    assert.equal(
      recipePreHidesStance(recipe, RAT, CONTEXT),
      false,
      `'${recipe.id}' pre-hides a hostile`,
    );
  }
});

test("recipes classify through bracketRole, so the list and the picture agree", () => {
  for (const row of EVERYTHING) {
    const role = bracketRole(row);
    const shown = recipeAllows(recipeByID("combat"), row);
    const expected = role === "hostile" || ["ship", "police", "drone", "wreck"].includes(role);
    assert.equal(shown, expected, `'${role}' was classified differently`);
  }
});

test("an unknown recipe id falls back to All rather than hiding everything", () => {
  assert.equal(recipeByID("not-a-recipe").id, "all");
  assert.deepEqual(idsFor("not-a-recipe"), EVERYTHING.map((row) => row.itemID));
});

test("filtering keeps the order it was given", () => {
  const ids = idsFor("travel");
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "order must be preserved, not re-sorted");
});

// --- the tab bar -------------------------------------------------------------

test("a fresh tab bar is All plus the five defaults, All first", () => {
  const bar = createTabBar();
  const tabs = bar.tabs.get();
  assert.deepEqual(tabs.map((tab) => tab.name), [
    "All",
    "System",
    "PVE",
    "PVP",
    "Mining",
    "Travel",
  ]);
  assert.equal(tabs[0]?.fixed, true, "All must be first and fixed");
  assert.equal(bar.selectedID.get(), "all", "the bar opens on All");
});

test("exactly one tab is fixed, and it is All", () => {
  const bar = createTabBar();
  assert.deepEqual(
    bar.tabs.get().filter((tab) => tab.fixed).map((tab) => tab.name),
    ["All"],
  );
});

test("All cannot be deleted, renamed or moved", () => {
  // ⚠ THE THREE THINGS THE FIXED FLAG IS FOR. Each of them would leave the
  // player without a tab that shows everything, or with one that lies about it.
  const bar = createTabBar();
  bar.remove("all");
  assert.ok(bar.tabs.get().some((tab) => tab.id === "all"), "All was deleted");

  bar.rename("all", "Dock");
  assert.equal(bar.tabs.get()[0]?.name, "All", "All was renamed");

  bar.move("all", 1);
  assert.equal(bar.tabs.get()[0]?.id, "all", "All moved out of its slot");
});

test("creating a tab takes a name and a recipe, and selects the new tab", () => {
  const bar = createTabBar();
  const tab = bar.create("pve", "Ratting");
  assert.equal(tab.name, "Ratting");
  assert.equal(tab.recipeId, "pve");
  assert.equal(tab.fixed, false);
  assert.equal(bar.selectedID.get(), tab.id, "the new tab was not selected");
  assert.equal(bar.selected.get().name, "Ratting");
});

test("two tabs may share a recipe", () => {
  // ⚠ A PLAYER WHO WANTS "Mining" AND "Rocks" WANTS TWO TABS. Collapsing them
  // would silently destroy a tab the player can still see named.
  const bar = createTabBar();
  const first = bar.create("mining", "Rocks");
  const second = bar.create("mining", "Belt");
  assert.equal(first.recipeId, second.recipeId);
  // The bar already SHIPS a Mining tab, so this is the default one plus the two
  // just made — which is the point: adding a Mining-shaped tab must not replace
  // or merge with the existing one.
  assert.equal(bar.tabs.get().filter((tab) => tab.recipeId === "mining").length, 3);
  assert.deepEqual(
    bar.tabs.get().filter((tab) => tab.recipeId === "mining").map((tab) => tab.name),
    ["Mining", "Rocks", "Belt"],
  );
  assert.notEqual(first.id, second.id);
});

test("a tab can be renamed and the rename sticks", () => {
  const bar = createTabBar();
  const tab = bar.create("travel", "Jump");
  bar.rename(tab.id, "  Gates  ");
  assert.equal(bar.tabs.get().find((candidate) => candidate.id === tab.id)?.name, "Gates");
});

test("an empty name falls back to the recipe's label", () => {
  // ⚠ NOT REFUSED. A tab with no name is indistinguishable from one that failed
  // to draw, so it takes the recipe's own name instead.
  assert.equal(normalizeTabName("", "mining"), "Mining");
  assert.equal(normalizeTabName("   ", "pve"), "PVE");
  const bar = createTabBar();
  const tab = bar.create("travel", "");
  assert.equal(tab.name, "Travel");
});

test("a name is trimmed and length-capped", () => {
  const long = "x".repeat(MAX_TAB_NAME_LENGTH + 40);
  assert.equal(normalizeTabName(long, "all").length, MAX_TAB_NAME_LENGTH);
  assert.equal(normalizeTabName("  Spaced  ", "all"), "Spaced");
});

test("duplicate names are allowed — two identically named tabs are the player's call", () => {
  const bar = createTabBar();
  const first = bar.create("mining", "Rocks");
  bar.create("travel", "Rocks");
  assert.equal(bar.tabs.get().filter((tab) => tab.name === "Rocks").length, 2);
  assert.ok(bar.tabs.get().some((tab) => tab.id === first.id));
});

test("deleting the selected tab falls back to All rather than to whatever is next", () => {
  // ⚠ THE PANEL'S STANDING RULE, applied here: a selection never silently
  // retargets onto something the player did not choose.
  const bar = createTabBar();
  const tab = bar.create("pve", "Ratting");
  assert.equal(bar.selectedID.get(), tab.id);
  bar.remove(tab.id);
  assert.equal(bar.selectedID.get(), "all");
  assert.equal(bar.selected.get().name, "All");
});

test("deleting some OTHER tab leaves the selection alone", () => {
  const bar = createTabBar();
  const keep = bar.create("pve", "Keep");
  const drop = bar.create("travel", "Drop");
  bar.select(keep.id);
  bar.remove(drop.id);
  assert.equal(bar.selectedID.get(), keep.id);
  assert.equal(bar.selected.get().name, "Keep");
});

test("moving a tab swaps it with its neighbour and never past All", () => {
  const bar = createTabBar();
  const names = (): string[] => bar.tabs.get().map((tab) => tab.name);
  assert.deepEqual(names(), ["All", "System", "PVE", "PVP", "Mining", "Travel"]);

  bar.select("all");
  // Move the LAST tab left twice: over Mining, then over PVP. It must stop there.
  const travel = bar.tabs.get()[5];
  assert.ok(travel);
  bar.move(travel.id, -1);
  assert.deepEqual(names(), ["All", "System", "PVE", "PVP", "Travel", "Mining"]);
  const moved = bar.tabs.get()[4];
  assert.ok(moved);
  bar.move(moved.id, -1);
  assert.deepEqual(names(), ["All", "System", "PVE", "Travel", "PVP", "Mining"]);
  // ⚠ One more step left would swap with All. It must NOT.
  bar.move(bar.tabs.get()[1]?.id ?? "", -1);
  assert.equal(names()[0], "All", "All was pushed out of its slot");
});

test("moving past either end is a no-op, not a wrap-around", () => {
  const bar = createTabBar();
  const before = bar.tabs.get().map((tab) => tab.id);
  // ⚠ SYSTEM IS THE FIRST EDITABLE SLOT, so a move LEFT is already off the end
  // — and it must not wrap round and swap with All, which sits one place left.
  const system = bar.tabs.get()[1];
  assert.ok(system);
  bar.move(system.id, -1);
  assert.deepEqual(bar.tabs.get().map((tab) => tab.id), before);
  // And the LAST tab moved RIGHT is off the far end: it must not wrap.
  const travel = bar.tabs.get()[5];
  assert.ok(travel);
  bar.move(travel.id, 1);
  assert.deepEqual(bar.tabs.get().map((tab) => tab.id), before);
});

test("selecting an id that names no tab changes nothing", () => {
  // ⚠ THE DELETE-RACE GUARD: a click on a tab the bar has already dropped must
  // not leave the id and the preset describing different things.
  const bar = createTabBar();
  bar.select("combat-ish");
  assert.equal(bar.selectedID.get(), "all");
  assert.equal(bar.selected.get().name, "All");
});

test("the selected tab and its id never describe different tabs", () => {
  const bar = createTabBar();
  const tab = bar.create("mining", "Rocks");
  assert.equal(bar.selectedID.get(), tab.id);
  assert.equal(bar.selected.get().id, tab.id);
  bar.rename(tab.id, "Belt");
  assert.equal(bar.selected.get().id, tab.id, "the rename orphaned the id");
});

test("reset puts the bar back to All plus the five defaults", () => {
  const bar = createTabBar();
  bar.create("pve", "Ratting");
  bar.remove(bar.tabs.get()[2]?.id ?? "");
  bar.reset();
  assert.deepEqual(bar.tabs.get().map((tab) => tab.name), [
    "All",
    "System",
    "PVE",
    "PVP",
    "Mining",
    "Travel",
  ]);
  assert.equal(bar.selectedID.get(), "all");
});

test("a subscriber is told when the tab changes", () => {
  // ⚠ This is what makes a click in the overview repaint the viewport.
  const bar = createTabBar();
  const seen: string[] = [];
  const stop = bar.selectedID.subscribe((id) => seen.push(id));
  const tab = bar.create("pve", "Ratting");
  stop();
  assert.deepEqual(seen, ["all", tab.id]);
});

test("two tab bars built separately never share state", () => {
  const a = createTabBar();
  const b = createTabBar();
  a.create("pve", "Only mine");
  assert.equal(b.tabs.get().length, 6);
  assert.equal(b.tabs.get().some((tab) => tab.name === "Only mine"), false);
});

test("every created tab carries a recipe that exists", () => {
  const bar = createTabBar();
  const tab = bar.create("travel", "Gates");
  assert.ok(OVERVIEW_RECIPES.some((recipe) => recipe.id === tab.recipeId));
  assert.equal(recipeByID(tab.recipeId).id, "travel");
});

test("a tab never hides a hostile BY ROLE, whatever recipe it is built on", () => {
  // ⚠ THE GUARANTEE THE PLAYER CANNOT BREAK BY MAKING THEIR OWN TAB. A tab is a
  // name and a recipe; it has no way to express "and also hide the rat" by
  // ROLE. (The stance axis can reach a hostile — that is the relaxed rule —
  // but no default recipe pre-hides the hostile side, which the test above
  // pins.)
  const bar = createTabBar();
  for (const recipeId of ["all", "system", "pve", "pvp", "mining", "travel"] as OverviewRecipeID[]) {
    const tab = { id: "t", name: "x", recipeId, fixed: false };
    assert.equal(tabAllows(tab, RAT), true, `a '${recipeId}' tab hid a threat`);
    assert.equal(tabAllows(tab, isHostile(RAT) ? RAT : RAT), true);
  }
});

test("defaultTabs is the same bar every call, and always yields a usable All", () => {
  const first = defaultTabs();
  const second = defaultTabs();
  assert.deepEqual(first.map((tab) => tab.name), second.map((tab) => tab.name));
  assert.equal(first[0]?.fixed, true);
  // Ids differ between builds — they are minted, not fixed strings — but the
  // NAMES must line up or a second tab bar would open on a different bar.
  assert.notDeepEqual(first.map((tab) => tab.id), second.map((tab) => tab.id));
});