// Overview presets (goal R79): tabs defined over the ONE classifier the viewport
// already uses, and a filter that can never hide something shooting at you.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRESET,
  OVERVIEW_PRESETS,
  applyPreset,
  presetAllows,
  presetByID,
} from "./overviewPresets.ts";
import { createOverviewPresetChoice, overviewPreset } from "./overviewPreset.ts";
import { bracketRole } from "./tactical.ts";
import type { SpaceEntity } from "../store/types.ts";

const ORIGIN = { x: 0, y: 0, z: 0 };

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "celestial",
    typeID: 16,
    groupID: 500,
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
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...over,
  };
}

const ROCK = entity({ itemID: 1, miningYieldTypeID: 1230 });
const GATE = entity({ itemID: 2, groupID: 10 });
const STATION = entity({ itemID: 3, kind: "structure" });
const PLANET = entity({ itemID: 4, groupID: 7 });
const PLAYER_SHIP = entity({ itemID: 5, kind: "ship" });
const WRECK = entity({ itemID: 6, kind: "wreck" });
const DRONE = entity({ itemID: 7, kind: "drone" });
const RAT = entity({ itemID: 8, kind: "ship", isNpc: true, npcEntityType: "npc" });
const POLICE = entity({ itemID: 9, kind: "ship", isNpc: true, npcEntityType: "concord" });

const EVERYTHING = [ROCK, GATE, STATION, PLANET, PLAYER_SHIP, WRECK, DRONE, RAT, POLICE];

function idsFor(presetID: string): number[] {
  return applyPreset(EVERYTHING, presetByID(presetID)).map((row) => row.itemID);
}

// --- the tabs ----------------------------------------------------------------

test("the presets are the four the retail overview offers", () => {
  assert.deepEqual(OVERVIEW_PRESETS.map((preset) => preset.id), [
    "all",
    "mining",
    "travel",
    "combat",
  ]);
});

test("All is the default and shows everything", () => {
  assert.equal(DEFAULT_PRESET, "all");
  assert.deepEqual(idsFor("all"), EVERYTHING.map((row) => row.itemID));
});

test("Mining shows rocks and somewhere to unload them", () => {
  const ids = idsFor("mining");
  assert.ok(ids.includes(ROCK.itemID), "rocks");
  assert.ok(ids.includes(STATION.itemID), "a full hold is the other half of the trip");
  assert.ok(ids.includes(DRONE.itemID), "mining drones");
  assert.equal(ids.includes(GATE.itemID), false, "gates are not mining");
  assert.equal(ids.includes(PLANET.itemID), false, "planets are not mining");
});

test("Travel shows the things you fly to", () => {
  const ids = idsFor("travel");
  assert.ok(ids.includes(GATE.itemID));
  assert.ok(ids.includes(STATION.itemID));
  assert.ok(ids.includes(PLANET.itemID));
  assert.equal(ids.includes(ROCK.itemID), false, "rocks are not a destination");
  assert.equal(ids.includes(WRECK.itemID), false);
});

test("Combat shows ships, drones and wrecks", () => {
  const ids = idsFor("combat");
  assert.ok(ids.includes(PLAYER_SHIP.itemID));
  assert.ok(ids.includes(WRECK.itemID));
  assert.ok(ids.includes(DRONE.itemID));
  assert.ok(ids.includes(POLICE.itemID));
  assert.equal(ids.includes(ROCK.itemID), false);
  assert.equal(ids.includes(GATE.itemID), false);
});

// --- the rule that outranks the tabs -----------------------------------------

test("EVERY preset shows a hostile, including the ones that filter it out by role", () => {
  // ⚠ THE RULE THAT OUTRANKS THE TABS. A preset is a convenience; a threat is
  // not something a convenience may remove from the screen. Mining and Travel
  // both exclude the "ship" role, and a rat is a ship.
  for (const preset of OVERVIEW_PRESETS) {
    assert.ok(
      presetAllows(preset, RAT),
      `the '${preset.id}' preset hid something that is shooting at you`,
    );
    assert.ok(
      applyPreset(EVERYTHING, preset).some((row) => row.itemID === RAT.itemID),
      `the '${preset.id}' preset filtered a hostile out of the list`,
    );
  }
});

test("law enforcement is NOT force-shown — only actual threats are", () => {
  // CONCORD is an NPC that does not attack, so it obeys the tabs like anything
  // else. Force-showing it would make the exemption meaningless.
  assert.equal(presetAllows(presetByID("mining"), POLICE), false);
  assert.equal(presetAllows(presetByID("combat"), POLICE), true);
});

test("an NPC of unknown kind counts as a threat and is force-shown", () => {
  // `bracketRole` treats an unreadable NPC as hostile — the loud direction to be
  // wrong in — and the presets inherit that rather than second-guessing it.
  const unknown = entity({ itemID: 99, kind: "ship", isNpc: true, npcEntityType: null });
  assert.equal(bracketRole(unknown), "hostile");
  assert.equal(presetAllows(presetByID("travel"), unknown), true);
});

// --- one classifier ----------------------------------------------------------

test("presets classify through bracketRole, so the list and the picture agree", () => {
  // If these ever disagreed, a rock could be drawn in the ore colour and
  // filtered out of the Mining tab at the same time.
  for (const row of EVERYTHING) {
    const role = bracketRole(row);
    const shown = presetAllows(presetByID("combat"), row);
    const expected = role === "hostile" || ["ship", "police", "drone", "wreck"].includes(role);
    assert.equal(shown, expected, `'${role}' was classified differently by the preset`);
  }
});

test("an unknown preset id falls back to All rather than hiding everything", () => {
  assert.equal(presetByID("not-a-preset").id, "all");
  assert.deepEqual(idsFor("not-a-preset"), EVERYTHING.map((row) => row.itemID));
});

test("filtering keeps the order it was given", () => {
  const ids = idsFor("travel");
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "order must be preserved, not re-sorted");
});

// --- the shared choice -------------------------------------------------------

test("the choice starts on All", () => {
  const choice = createOverviewPresetChoice();
  assert.equal(choice.id.get(), "all");
  assert.equal(choice.preset.get().id, "all");
});

test("choosing updates the id AND the resolved preset together", () => {
  const choice = createOverviewPresetChoice();
  choice.choose("mining");
  assert.equal(choice.id.get(), "mining");
  assert.equal(choice.preset.get().id, "mining");
});

test("an unrecognised choice leaves BOTH describing All, never one of each", () => {
  const choice = createOverviewPresetChoice();
  choice.choose("nonsense" as never);
  assert.equal(choice.id.get(), "all");
  assert.equal(choice.preset.get().id, "all");
});

test("a subscriber is told when the tab changes", () => {
  // This is what makes a click in the overview repaint the viewport.
  const choice = createOverviewPresetChoice();
  const seen: string[] = [];
  const stop = choice.id.subscribe((id) => seen.push(id));
  choice.choose("combat");
  stop();
  assert.deepEqual(seen, ["all", "combat"]);
});

test("two choices built separately do not share state", () => {
  const a = createOverviewPresetChoice();
  const b = createOverviewPresetChoice();
  a.choose("mining");
  assert.equal(b.id.get(), "all");
});

test("the app's shared choice is a real choice", () => {
  assert.equal(typeof overviewPreset.choose, "function");
});
