// The dock-target model (dockTarget.ts): pick the nearest dockable entity, skip
// non-dockable kinds and the ship itself, null when nothing on grid docks.

import test from "node:test";
import assert from "node:assert/strict";

import { nearestDockable } from "./dockTarget.ts";
import type { SpaceEntity, SpaceVector } from "../store/types.ts";

function entity(over: Partial<SpaceEntity> & { itemID: number; kind: string | null }): SpaceEntity {
  return {
    typeID: 54,
    groupID: null,
    categoryID: null,
    name: "Station",
    ownerID: null,
    radius: 1000,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
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
    ...over,
  } as SpaceEntity;
}

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };

test("picks the nearest station/structure by distance", () => {
  const far = entity({ itemID: 1, kind: "station", name: "Far", position: { x: 1000, y: 0, z: 0 } });
  const near = entity({ itemID: 2, kind: "structure", name: "Near", position: { x: 10, y: 0, z: 0 } });
  const target = nearestDockable([far, near], ORIGIN);
  assert.equal(target?.itemID, 2);
  assert.equal(target?.name, "Near");
});

test("ignores non-dockable kinds (rocks, ships, the player's own ship)", () => {
  const rock = entity({ itemID: 1, kind: "asteroid" });
  const ship = entity({ itemID: 2, kind: "ship" });
  const self = entity({ itemID: 3, kind: "station", isSelf: true });
  assert.equal(nearestDockable([rock, ship, self], ORIGIN), null);
});

test("null when nothing on grid can be docked at", () => {
  assert.equal(nearestDockable([], ORIGIN), null);
  assert.equal(nearestDockable(null, ORIGIN), null);
});

test("a lone dockable is returned even without a ship position", () => {
  const station = entity({ itemID: 9, kind: "station", name: "Only" });
  assert.equal(nearestDockable([station], null)?.itemID, 9);
});
