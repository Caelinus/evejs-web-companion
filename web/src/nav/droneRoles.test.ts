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
  assert.equal(droneRoleForGroup("Logistic Drone"), "logistic");
  assert.equal(droneRoleForGroup("combat drone"), "combat", "case is not load-bearing");
  assert.equal(droneRoleForGroup("logistic drone"), "logistic", "case is not load-bearing");
});

// Electronic Warfare and Stasis Webifying and Energy Neutralizer drones stay
// "other" on purpose, not by omission — the server (`droneDogma.js`) defines
// no engage effect for the webifier or neutralizer groups at all, so
// `commandEngage` refuses them outright; there is no job here to route them
// to. Logistic Drone is NOT in this list any more — it now has its own role,
// covered above and in splitDroneRoles below.
test("every other drone is 'other' — it is never launched for a job it cannot do", () => {
  for (const group of ["Electronic Warfare Drone", "Stasis Webifying Drone", "Energy Neutralizer Drone", "Fighter Drone", "not a real drone group"]) {
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
  const groups: Record<number, string> = {
    2454: "Combat Drone",
    32787: "Salvage Drone",
    10246: "Mining Drone",
    23707: "Electronic Warfare Drone",
    28211: "Logistic Drone",
  };
  const rows = [
    { itemID: 1, typeID: 2454 },
    { itemID: 2, typeID: 32787 },
    { itemID: 3, typeID: 10246 },
    { itemID: 4, typeID: 23707 },
    { itemID: 5, typeID: 2454 },
    { itemID: 6, typeID: 99999 }, // group never resolved
    { itemID: 7, typeID: null }, // type unreadable
    { itemID: 8, typeID: 28211 },
    { itemID: 9, typeID: 28211 },
  ];
  const roles = splitDroneRoles(rows, (r) => r.typeID, (r) => r.itemID, (typeID) => groups[typeID] ?? null);
  assert.deepEqual(roles.combat, [1, 5]);
  assert.deepEqual(roles.salvage, [2]);
  assert.deepEqual(roles.logistic, [8, 9], "logistic rows land in their own list, in order");
  assert.deepEqual(roles.unknown, [6, 7], "the unreadable ones are named, not silently dropped");
});
