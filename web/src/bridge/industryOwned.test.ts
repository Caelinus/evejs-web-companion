// R109 slice 2: the owned blueprints the Industry Manager plans with.

import test from "node:test";
import assert from "node:assert/strict";

import { groupOwned, groupWords, ownedBlueprints, ownedTerms, ownedWords, productOf } from "./industryOwned.ts";
import type { PilotBlueprintRead } from "./industryOwned.ts";
import type { IndustryBlueprintRow, IndustryDefinition } from "../store/types.ts";

function row(overrides: Partial<IndustryBlueprintRow>): IndustryBlueprintRow {
  return {
    itemID: 1,
    typeID: 1101,
    materialEfficiency: 0,
    timeEfficiency: 0,
    runs: -1,
    original: true,
    locationID: 60003760,
    facilityID: null,
    jobID: null,
    ...overrides,
  };
}

const WIDGET: IndustryDefinition = {
  blueprintTypeID: 1101,
  blueprintName: "Widget Blueprint",
  productTypeID: 101,
  productName: "Widget",
  maxProductionLimit: 300,
  recipes: [{ activity: "manufacturing", materials: [], products: [{ typeID: 101, quantity: 1 }], timeSeconds: 600 }],
};

// A reaction formula's row says product 0; its product lives in the recipe.
const GIZMO: IndustryDefinition = {
  blueprintTypeID: 1102,
  blueprintName: "Gizmo Reaction Formula",
  productTypeID: null,
  productName: null,
  maxProductionLimit: null,
  recipes: [{ activity: "reaction", materials: [], products: [{ typeID: 102, quantity: 200 }], timeSeconds: 10800 }],
};

const DEFINITIONS = { 1101: WIDGET, 1102: GIZMO };

function read(characterID: number, characterName: string, blueprints: IndustryBlueprintRow[]): PilotBlueprintRead {
  return { characterID, characterName, blueprints, definitions: DEFINITIONS };
}

test("productOf: a reaction formula's product comes from its recipe, not its empty row", () => {
  assert.equal(productOf(WIDGET), 101);
  assert.equal(productOf(GIZMO), 102);
  assert.equal(productOf(null), null);
});

test("a blueprint whose definition has not arrived is left out, not listed nameless", () => {
  const owned = ownedBlueprints([read(90000001, "Pilot One", [row({ itemID: 5, typeID: 9999 })])]);
  assert.deepEqual(owned, []);
});

test("every pilot's blueprints, each saying whose it is; a copy's runs, an original's none", () => {
  const owned = ownedBlueprints([
    read(90000001, "Pilot One", [row({ itemID: 1, original: false, runs: 7, materialEfficiency: 2, timeEfficiency: 4 })]),
    read(90000002, "Pilot Two", [row({ itemID: 2, typeID: 1102 }), row({ itemID: 3, materialEfficiency: 10, jobID: 77 })]),
  ]);
  assert.deepEqual(owned.map((blueprint) => [blueprint.itemID, blueprint.characterName]), [
    [2, "Pilot Two"],
    [3, "Pilot Two"],
    [1, "Pilot One"],
  ]);
  const copy = owned.find((blueprint) => blueprint.itemID === 1);
  assert.equal(copy?.runs, 7);
  assert.equal(owned.find((blueprint) => blueprint.itemID === 3)?.runs, null);
  assert.equal(owned.find((blueprint) => blueprint.itemID === 3)?.busy, true);
  assert.equal(owned.find((blueprint) => blueprint.itemID === 2)?.productTypeID, 102);
});

test("the same item read through two sessions is listed once", () => {
  const owned = ownedBlueprints([
    read(90000001, "Pilot One", [row({ itemID: 1 })]),
    read(90000001, "Pilot One", [row({ itemID: 1 })]),
  ]);
  assert.equal(owned.length, 1);
});

test("ownedTerms: the best copy per type wins, an original breaking a tie", () => {
  const owned = ownedBlueprints([
    read(90000001, "Pilot One", [
      row({ itemID: 1, original: false, runs: 5, materialEfficiency: 10, timeEfficiency: 20 }),
      row({ itemID: 2, materialEfficiency: 10, timeEfficiency: 20 }),
      row({ itemID: 3, materialEfficiency: 4, timeEfficiency: 20 }),
    ]),
  ]);
  assert.deepEqual(ownedTerms(owned).get(1101), { materialEfficiency: 10, timeEfficiency: 20, owned: true });
  assert.equal(owned[0]?.itemID, 2, "the original is listed first among equals");
});

test("ownedWords: plain words, no ME or TE jargon", () => {
  const [copy] = ownedBlueprints([read(90000001, "Pilot One", [row({ original: false, runs: 1, materialEfficiency: 2, timeEfficiency: 4 })])]);
  assert.ok(copy);
  assert.equal(ownedWords(copy), "Copy, 1 run - material 2%, time 4%");
});

test("groupOwned: one group per blueprint, copies best first, in name order", () => {
  const owned = ownedBlueprints([
    read(90000001, "Pilot One", [row({ itemID: 1, materialEfficiency: 2 }), row({ itemID: 2, typeID: 1102 })]),
    read(90000002, "Pilot Two", [row({ itemID: 3, materialEfficiency: 10 }), row({ itemID: 4, original: false, runs: 5 })]),
  ]);
  const groups = groupOwned(owned);
  assert.deepEqual(groups.map((group) => [group.blueprintName, group.copies.map((copy) => copy.itemID)]), [
    ["Gizmo Reaction Formula", [2]],
    ["Widget Blueprint", [3, 1, 4]],
  ]);
  const widget = groups[1];
  assert.ok(widget);
  assert.equal(groupWords(widget, widget.copies[0]!), "3 copies - Original 10/0 - Pilot Two");
  const gizmo = groups[0];
  assert.ok(gizmo);
  assert.equal(groupWords(gizmo, gizmo.copies[0]!), "Original 0/0 - Pilot One");
});
