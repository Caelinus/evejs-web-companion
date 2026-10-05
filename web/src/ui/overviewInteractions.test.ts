import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compile } from "svelte/compiler";

register("./svelteSsrHook.ts", import.meta.url);
const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { overviewTabs } = await import("../space/overviewTabs.ts");
const { tabHidden, combatToggles, combatToggleMap, tabShows } = await import("../space/overviewHidden.ts");

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const flow = new Proxy({}, { get: () => async () => {} });
const neutral = entity(11, "Neutral ship");
const planet = entity(12, "Test planet", { kind: "celestial", groupID: 7, categoryID: 2 });
const rat = entity(13, "Belt Rat", { isNpc: true, npcEntityType: "npc" });

function entity(itemID: number, name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { itemID, name, kind: "ship", typeID: 606, groupID: 25, categoryID: 6,
    ownerID: null, radius: 100, position: { x: 1000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    isSelf: false, shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null,
    corporationID: null, allianceID: null, securityStatus: null, maxVelocity: null,
    mode: null, capacitorRatio: null, remainingQuantity: null, miningYieldTypeID: null,
    beltID: null, oreGrade: null, oreValuePerM3: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null, ...overrides };
}

function fixtureStore() {
  const store = createClientStore();
  store.apply({ type: "flight/status", status: { inSpace: true, docked: false,
    solarSystemID: 30000142, stationID: null, structureID: null, shipID: 9001,
    shipMode: "STOP", shipSpeedFraction: 0 } } as never);
  store.apply({ type: "space/snapshot", snapshot: { inSpace: true,
    solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1, entities: [neutral, planet, rat],
    ship: { itemID: 9001, typeID: 606, name: "Ibis", mode: "STOP", maxVelocity: 300,
      radius: 30, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
      shieldCapacity: 300, armorCapacity: 300, hullCapacity: 300, activeModuleIDs: [],
      overloadedModuleIDs: [], moduleDamage: {}, weaponBanks: {} } } } as never);
  return store;
}

async function panel(file = "SpaceOverview.svelte", actions = ""): Promise<string> {
  const filename = path.join(UI_DIR, file);
  let source = readFileSync(filename, "utf8");
  if (file === "Tactical.svelte") {
    // SSR has no ResizeObserver. Give the actual projection a measured viewport.
    source = source.replace("let width = $state(0);", "let width = $state(500);")
      .replace("let height = $state(0);", "let height = $state(500);");
  }
  // SSR cannot click controls. Invoke the real component handlers in their own
  // scope, then inspect both their model writes and the real editor/menu template.
  const { js } = compile(source.replace("</script>", `${actions}\n</script>`), { filename, generate: "server" });
  const code = js.code.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier: string) =>
    `from ${JSON.stringify(import.meta.resolve(specifier))}`);
  const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return render(Component, { props: { store: fixtureStore(), flow } }).body;
}

function selectRecipe(recipe: string) {
  const tab = overviewTabs.tabs.get().find(tab => tab.recipeId === recipe);
  assert.ok(tab);
  overviewTabs.select(tab.id);
  return tab;
}

test.beforeEach(() => {
  for (const id of combatToggleMap.get().keys()) combatToggles.clear(id);
  overviewTabs.reset();
  tabHidden.clearAll();
});
test.afterEach(() => {
  for (const id of combatToggleMap.get().keys()) combatToggles.clear(id);
  overviewTabs.reset();
  tabHidden.clearAll();
});

test("saving the offered recipe edit updates the existing tab without losing its hides", async () => {
  const tab = selectRecipe("mining");
  tabHidden.hide(tab.id, planet as never, "planet");
  await panel("SpaceOverview.svelte", 'openRename(activeTabID); draftName = "Routes"; draftRecipe = "travel"; submitEditor();');
  assert.equal(overviewTabs.selected.get().id, tab.id);
  assert.equal(overviewTabs.selected.get().name, "Routes");
  assert.equal(overviewTabs.selected.get().recipeId, "travel");
  assert.equal(tabHidden.stateFor(tab.id).hidden.length, 1);
});

test("Show undoes a category-and-stance hide through the actual menu handler", async () => {
  const tab = selectRecipe("system");
  tabHidden.hideCategoryStance(tab.id, neutral as never, null);
  assert.equal(tabShows(tab, neutral as never, tabHidden.stateFor(tab.id), null), false);
  await panel("SpaceOverview.svelte", 'showEntry(hiddenMenuRows.find(row => row.kind === "stance"));');
  assert.equal(tabHidden.stateFor(tab.id).hidden.length, 0);
  assert.equal(tabShows(tab, neutral as never, tabHidden.stateFor(tab.id), null), true);
});

test("shown preset categories leave the hidden menu and a player hide owns one undo row", async () => {
  const tab = selectRecipe("mining");
  tabHidden.addCategory(tab.id, "planet");
  let body = await panel("SpaceOverview.svelte", "hiddenMenuOpen = true;");
  assert.match(body, /Test planet/);
  assert.doesNotMatch(body, /aria-label="Show Planets"/);
  tabHidden.hide(tab.id, planet as never, "planet");
  body = await panel("SpaceOverview.svelte", "hiddenMenuOpen = true;");
  assert.equal((body.match(/aria-label="Show Planets"/g) ?? []).length, 1);
  await panel("SpaceOverview.svelte", 'showEntry(hiddenMenuRows.find(row => row.category === "planet"));');
  assert.equal(tabShows(tab, planet as never, tabHidden.stateFor(tab.id), null), true);
});

test("combat toggle filters the radar and overview together while keeping planets and hostiles", async () => {
  const tab = selectRecipe("system");
  combatToggles.toggle(tab.id, "neutral");
  const overview = await panel();
  assert.doesNotMatch(overview, /Neutral ship/);
  assert.match(overview, /Test planet/);
  assert.match(overview, /Belt Rat/);
  assert.match(await panel("Tactical.svelte"), /Tactical view: 2 objects on grid/);
  overviewTabs.select("all");
  assert.match(await panel("Tactical.svelte"), /Tactical view: 3 objects on grid/);
  overviewTabs.select(tab.id);
  combatToggles.toggle(tab.id, "neutral");
  assert.match(await panel("Tactical.svelte"), /Tactical view: 3 objects on grid/);
});

test("Reset Tab returns hidden entries and combat toggles to the preset", async () => {
  const tab = selectRecipe("system");
  tabHidden.hide(tab.id, planet as never, "planet");
  combatToggles.toggle(tab.id, "neutral");
  await panel("SpaceOverview.svelte", "resetTabToPreset();");
  assert.equal(tabHidden.stateFor(tab.id).hidden.length, 0);
  assert.equal(combatToggles.forTab(tab.id).size, 0);
});

test("deleting a tab also retires its combat toggle state", async () => {
  const tab = selectRecipe("system");
  combatToggles.toggle(tab.id, "neutral");
  await panel("SpaceOverview.svelte", "openDelete(activeTabID); confirmDelete();");
  assert.equal(overviewTabs.tabs.get().some(candidate => candidate.id === tab.id), false);
  assert.equal(combatToggleMap.get().has(tab.id), false);
});
