// Stance (iteration 5 of the overview tabs): the three-word answer to
// "whose is that?" that hiding reads, and the words the menu uses for it.
//
// The contract under test: NPC FIRST (in exactly the rows `isHostile` flags),
// then the player's own side, and "neutral" whenever the client has no
// context or the identity cannot be read. A hostile is hostile even if an NPC
// row carried one of the player's ids; a missing context never reads friendly.

import test from "node:test";
import assert from "node:assert/strict";

import {
  STANCED_ROLES,
  roleWord,
  stanceContextFrom,
  stanceOf,
  stanceRowLabel,
  type StanceContext,
} from "./stance.ts";
import { isHostile } from "./overview.ts";
import { bracketRole } from "./tactical.ts";
import type { CharacterSummary, SpaceEntity } from "../store/types.ts";

const ORIGIN = { x: 0, y: 0, z: 0 };

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "ship",
    typeID: 606,
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

const MY_CHARACTER = 9101;
const MY_CORP = 9201;
const MY_ALLIANCE = 9301;
const CONTEXT: StanceContext = {
  characterID: MY_CHARACTER,
  corporationID: MY_CORP,
  allianceID: MY_ALLIANCE,
};

function summary(over: Partial<CharacterSummary> = {}): CharacterSummary {
  return {
    characterID: MY_CHARACTER,
    characterName: "Pilot",
    gender: null,
    typeID: null,
    corporationID: MY_CORP,
    allianceID: MY_ALLIANCE,
    stationID: null,
    solarSystemID: null,
    regionID: null,
    balance: null,
    skillPoints: null,
    shipTypeID: null,
    shipName: null,
    securityStatus: null,
    title: null,
    unreadMailCount: null,
    logoffDate: null,
    skillTypeID: null,
    toLevel: null,
    trainingStartTime: null,
    trainingEndTime: null,
    queueEndTime: null,
    ...over,
  };
}

// --- the context ----------------------------------------------------------------

test("stanceContextFrom builds the context from the character list", () => {
  assert.deepEqual(
    stanceContextFrom([summary(), summary({ characterID: 1, characterName: "Other" })], MY_CHARACTER),
    CONTEXT,
  );
});

test("stanceContextFrom answers null when there is nothing to read", () => {
  assert.equal(stanceContextFrom([summary()], null), null, "no character selected");
  assert.equal(stanceContextFrom([], MY_CHARACTER), null, "the list has not loaded");
  assert.equal(
    stanceContextFrom([summary({ characterID: 1, characterName: "Other" })], MY_CHARACTER),
    null,
    "the selected character is not in the list",
  );
});

// --- stanceOf --------------------------------------------------------------------

test("the player's own rows read friendly, in the context's own order", () => {
  assert.equal(stanceOf(entity({ itemID: 1, characterID: MY_CHARACTER }), CONTEXT), "friendly");
  assert.equal(
    stanceOf(entity({ itemID: 2, corporationID: MY_CORP }), CONTEXT),
    "friendly",
    "a corp-mate",
  );
  assert.equal(
    stanceOf(entity({ itemID: 3, allianceID: MY_ALLIANCE }), CONTEXT),
    "friendly",
    "an alliance-mate",
  );
  // ⚠ A DRONE THE PLAYER'S OWN HULL IS FLYING IS THEIRS: ownerID is the
  // multi-box path, and it must not need the drone to carry the character.
  assert.equal(
    stanceOf(entity({ itemID: 4, kind: "drone", ownerID: MY_CHARACTER }), CONTEXT),
    "friendly",
  );
});

test("⚠ the NPC question is asked FIRST, the same way isHostile asks it", () => {
  const rat = entity({ itemID: 5, isNpc: true, npcEntityType: "npc" });
  const drifter = entity({ itemID: 6, isNpc: true, npcEntityType: "drifter" });
  const unknown = entity({ itemID: 7, isNpc: true, npcEntityType: null });
  assert.equal(stanceOf(rat, CONTEXT), "hostile");
  assert.equal(stanceOf(drifter, CONTEXT), "hostile");
  assert.equal(
    stanceOf(unknown, CONTEXT),
    "hostile",
    "an unknown NPC kind is the loud direction",
  );
  // And an NPC that carried the player's own ids is still an NPC: the runtime's
  // "nobody is flying this" outranks any identity.
  assert.equal(
    stanceOf(
      entity({ itemID: 8, isNpc: true, npcEntityType: "npc", characterID: MY_CHARACTER }),
      CONTEXT,
    ),
    "hostile",
    "an NPC wearing the player's id is not the player",
  );
});

test("law enforcement is the one NPC that is not a threat, and it is not friendly", () => {
  // ⚠ Concord is nobody's side: not friendly, not the player's.
  const police = entity({ itemID: 9, isNpc: true, npcEntityType: "concord" });
  assert.equal(stanceOf(police, CONTEXT), "neutral");
  assert.equal(stanceOf(police, null), "neutral");
});

test("everything nobody owns reads neutral, and so does every unread identity", () => {
  assert.equal(stanceOf(entity({ itemID: 10 }), CONTEXT), "neutral", "a stranger's ship");
  assert.equal(stanceOf(entity({ itemID: 11, corporationID: 9999 }), CONTEXT), "neutral");
  assert.equal(stanceOf(entity({ itemID: 12, allianceID: 9999 }), CONTEXT), "neutral");
  // ⚠ THE SAFETY DIRECTION OF A MISSING CONTEXT. No character list yet, and a
  // corp-mate must not read friendly — nothing may read friendly at all.
  assert.equal(stanceOf(entity({ itemID: 13, corporationID: MY_CORP }), null), "neutral");
});

test("⚠ stanceOf answers hostile in EXACTLY the rows isHostile flags", () => {
  // ⚠ THE PROPERTY THAT KEEPS THE SAFETY RULE COHERENT. Any surface that said
  // "hostile" would already be one `isHostile` said so for, so the relaxed
  // invariant can never disagree with the threat strip.
  const samples = [
    entity({ itemID: 1, characterID: MY_CHARACTER }),
    entity({ itemID: 2 }),
    entity({ itemID: 3, isNpc: true, npcEntityType: "npc" }),
    entity({ itemID: 4, isNpc: true, npcEntityType: "concord" }),
    entity({ itemID: 5, isNpc: true, npcEntityType: "drifter" }),
    entity({ itemID: 6, isNpc: true, npcEntityType: null }),
    entity({ itemID: 7, kind: "drone", ownerID: MY_CHARACTER }),
    entity({ itemID: 8, kind: "structure" }),
  ];
  for (const row of samples) {
    for (const context of [CONTEXT, null]) {
      assert.equal(
        stanceOf(row, context) === "hostile",
        isHostile(row),
        "stance and hostility disagreed for item " + row.itemID,
      );
    }
  }
});

// --- the words --------------------------------------------------------------------

test("the menu words are words, not ids", () => {
  assert.equal(roleWord("ship"), "Ships");
  assert.equal(roleWord("drone"), "Drones");
  assert.equal(roleWord("wreck"), "Wrecks");
  assert.equal(roleWord("station"), "Structures");
  assert.equal(roleWord("hostile"), "Hostiles");
});

test("stanceRowLabel names the role AND the side — or just the word, for hostiles", () => {
  assert.equal(stanceRowLabel("ship", "friendly"), "Ships (Friendly)");
  assert.equal(stanceRowLabel("ship", "neutral"), "Ships (Neutral)");
  assert.equal(stanceRowLabel("drone", "neutral"), "Drones (Neutral)");
  assert.equal(stanceRowLabel("station", "friendly"), "Structures (Friendly)");
  // ⚠ HOSTILES GET NO PARENTHES: every row in the hostile role is hostile, so
  // the word would be said twice.
  assert.equal(stanceRowLabel("hostile", "hostile"), "Hostiles");
});

test("the stanced roles are the ones that come in more than one side", () => {
  for (const role of ["ship", "drone", "wreck", "station", "hostile"]) {
    assert.ok(STANCED_ROLES.has(role), `'${role}' lost its stance row`);
  }
  for (const role of ["gate", "asteroid", "celestial", "police", "self"]) {
    assert.equal(STANCED_ROLES.has(role), false, `'${role}' grew a stance row`);
  }
});

test("a gate, a rock and a police row earn no stance pair, even with a context", () => {
  // ⚠ The property stanceEntryFor turns on: bracketRole outside the stanced set
  // means the stance hide verb has nothing honest to name for that row.
  assert.equal(
    STANCED_ROLES.has(bracketRole(entity({ itemID: 1, kind: "celestial", groupID: 10 }))),
    false,
    "a stargate",
  );
  assert.equal(
    STANCED_ROLES.has(
      bracketRole(entity({ itemID: 2, kind: "celestial", miningYieldTypeID: 1230 })),
    ),
    false,
    "a rock",
  );
  assert.equal(
    STANCED_ROLES.has(
      bracketRole(entity({ itemID: 3, isNpc: true, npcEntityType: "concord" })),
    ),
    false,
    "police",
  );
});
