// The drone-role classifier: the game's group name in, the job out. Pins the
// anchoring (a rat's "Rogue Drone" group is not a combat drone) and the
// cannot-tell rule (an unresolved group is NO role, never a guess).

import test from "node:test";
import assert from "node:assert/strict";

import { droneRoleForGroup, splitDroneRoles } from "./droneRoles.ts";

test("the game's own drone groups map to the jobs the blocks act on", () => {
  assert.equal(droneRoleForGroup("Combat Drone"), "combat");
  assert.equal(droneRoleForGroup("Salvage Drone"), "salvage");
  assert.equal(droneRoleForGroup("Mining Drone"), "mining");
  assert.equal(droneRoleForGroup("combat drone"), "combat", "case is not load-bearing");
});

test("every other drone is 'other' — it is never launched for a job it cannot do", () => {
  for (const group of ["Electronic Warfare Drone", "Logistic Drone", "Stasis Webifying Drone", "Energy Neutralizer Drone", "Fighter Drone"]) {
    assert.equal(droneRoleForGroup(group), "other", group);
  }
});

test("the match is anchored — rats and modules that merely mention drones do not qualify", () => {
  assert.equal(droneRoleForGroup("Rogue Drone"), "other");
  assert.equal(droneRoleForGroup("Asteroid Rogue Drone Frigate"), "other");
  assert.equal(droneRoleForGroup("Drone Damage Modules"), "other");
  assert.equal(droneRoleForGroup("Combat Drone Blueprint"), "other");
});

test("an unresolved group is NO role, not a guess", () => {
  assert.equal(droneRoleForGroup(null), null);
  assert.equal(droneRoleForGroup(undefined), null);
});

test("splitDroneRoles keeps order, drops unknown types and unresolved groups", () => {
  const groups: Record<number, string> = { 2454: "Combat Drone", 32787: "Salvage Drone", 10246: "Mining Drone", 23707: "Electronic Warfare Drone" };
  const rows = [
    { itemID: 1, typeID: 2454 },
    { itemID: 2, typeID: 32787 },
    { itemID: 3, typeID: 10246 },
    { itemID: 4, typeID: 23707 },
    { itemID: 5, typeID: 2454 },
    { itemID: 6, typeID: 99999 }, // group never resolved
    { itemID: 7, typeID: null }, // type unreadable
  ];
  const roles = splitDroneRoles(rows, (r) => r.typeID, (r) => r.itemID, (typeID) => groups[typeID] ?? null);
  assert.deepEqual(roles.combat, [1, 5]);
  assert.deepEqual(roles.salvage, [2]);
});
