// Which ship on the grid can compress your ore (space/compression.ts).
//
// ⚠ THE BRANCH THIS FILE EXISTS FOR IS THE ABSENT ONE. `compressionFacility` is
// both OPTIONAL and NULLABLE — three wire states (absent, explicit null, a
// value) that must all collapse to "not a facility" through `?? null`. An
// absent reading is an older server or a row the gateway did not project; it is
// NOT an unknown worth firing at, and treating it as one has a player pressing
// Compress at a hull that was never going to answer.
//
// The rule is shared with the `compress-ore` bot macro rather than copied, and
// `scriptMacros.test.ts` exercises the same function through the macro — so
// these two suites are two views of one implementation, which is the point.

import test from "node:test";
import assert from "node:assert/strict";

import {
  compressionFacilities,
  compressionRefusal,
  facilityDistanceMeters,
  facilityReachMeters,
} from "./compression.ts";
import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";

const SELF_ID = 9001;

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "ship",
    typeID: 622,
    groupID: null,
    categoryID: null,
    name: null,
    ownerID: null,
    radius: 100,
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
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...over,
  } as SpaceEntity;
}

function snapshot(entities: readonly SpaceEntity[]): SpaceSnapshot {
  return {
    inSpace: true,
    solarSystemID: 30000142,
    shipID: SELF_ID,
    sampledAtMs: 1,
    entities,
    ship: {
      itemID: SELF_ID,
      typeID: 622,
      name: null,
      mode: "STOP",
      shieldRatio: 1,
      armorRatio: 1,
      hullRatio: 1,
      capacitorRatio: 1,
      shieldCapacity: 400,
      armorCapacity: 300,
      hullCapacity: 600,
      radius: 100,
      maxVelocity: 300,
      activeModuleIDs: [],
      overloadedModuleIDs: [],
      moduleDamage: {},
      weaponBanks: {},
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    },
  } as unknown as SpaceSnapshot;
}

const LIVE = { rangeMeters: 10_000, typeListIDs: [] };

test("a ship running its compression gear is a facility", () => {
  const found = compressionFacilities(
    snapshot([entity({ itemID: 5, compressionFacility: LIVE })]),
  );
  assert.deepEqual(found.map((f) => f.itemID), [5]);
});

test("⚠ AN ABSENT READING IS NOT A FACILITY — never an unknown worth trying", () => {
  // The field is optional: an older server, or a row the gateway did not
  // project, simply has no `compressionFacility` at all.
  assert.deepEqual(compressionFacilities(snapshot([entity({ itemID: 5 })])), []);
});

test("an explicit null is not a facility either — the gear is switched off", () => {
  assert.deepEqual(
    compressionFacilities(snapshot([entity({ itemID: 5, compressionFacility: null })])),
    [],
  );
});

test("⚠ AN NPC HULL IS NEVER A FACILITY, whatever it is carrying", () => {
  assert.deepEqual(
    compressionFacilities(
      snapshot([entity({ itemID: 5, isNpc: true, compressionFacility: LIVE })]),
    ),
    [],
  );
});

test("only SHIPS qualify — a structure with the reading is not one", () => {
  assert.deepEqual(
    compressionFacilities(
      snapshot([entity({ itemID: 5, kind: "structure", compressionFacility: LIVE })]),
    ),
    [],
  );
});

test("⚠ OWN HULL SORTS FIRST — no range to solve, no fleet check to fail", () => {
  const found = compressionFacilities(
    snapshot([
      entity({ itemID: 7, compressionFacility: LIVE, position: { x: 100, y: 0, z: 0 } }),
      entity({ itemID: SELF_ID, compressionFacility: LIVE }),
    ]),
  );
  assert.deepEqual(found.map((f) => f.itemID), [SELF_ID, 7]);
});

test("no snapshot yields no facilities, rather than throwing", () => {
  assert.deepEqual(compressionFacilities(null), []);
});

// --- reach and refusal -------------------------------------------------------

test("the reach is the facility's OWN stated range; an absent one is zero", () => {
  assert.equal(facilityReachMeters(entity({ itemID: 5, compressionFacility: LIVE })), 10_000);
  assert.equal(facilityReachMeters(entity({ itemID: 5 })), 0);
  assert.equal(facilityReachMeters(null), 0);
});

test("no facility at all is a refusal, in words", () => {
  assert.match(compressionRefusal(snapshot([]), null) ?? "", /No mining support ship/);
});

test("⚠ YOUR OWN HULL IS NEVER OUT OF RANGE OF ITSELF", () => {
  const snap = snapshot([entity({ itemID: SELF_ID, compressionFacility: LIVE })]);
  assert.equal(compressionRefusal(snap, snap.entities[0]!), null);
});

test("a mate's hull inside its own reach is fine", () => {
  const mate = entity({
    itemID: 7,
    compressionFacility: LIVE,
    position: { x: 5_000, y: 0, z: 0 },
  });
  assert.equal(compressionRefusal(snapshot([mate]), mate), null);
});

test("a mate's hull outside its own reach is refused, and says which way to fix it", () => {
  const mate = entity({
    itemID: 7,
    compressionFacility: LIVE,
    position: { x: 50_000, y: 0, z: 0 },
  });
  const refusal = compressionRefusal(snapshot([mate]), mate);
  assert.match(refusal ?? "", /Too far/);
  assert.match(refusal ?? "", /move closer/i);
});

test("⚠ AN UNMEASURABLE DISTANCE IS NOT A REFUSAL — the server answers instead", () => {
  // Every other range decision in this client works the same way: we do not
  // pre-refuse on a number we do not have.
  const mate = entity({ itemID: 7, compressionFacility: LIVE, position: { x: 50_000, y: 0, z: 0 } });
  assert.equal(facilityDistanceMeters(null, mate), null);
  assert.equal(compressionRefusal(null, mate), null);
});

test("⚠ THE BROWSER JUDGES ONLY THE TWO THINGS IT CAN SEE", () => {
  // Fleet membership, a foreign item, an ore with no compressed form — the
  // server refuses all of those with ONE silence, so naming any of them here
  // would put an invented cause on screen beside a real one.
  const mate = entity({ itemID: 7, compressionFacility: LIVE, position: { x: 1_000, y: 0, z: 0 } });
  assert.equal(
    compressionRefusal(snapshot([mate]), mate),
    null,
    "the browser must not pre-judge what only the server knows",
  );
});
