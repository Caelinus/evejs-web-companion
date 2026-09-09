// The R11 overview view logic: distance is computed IN THE BROWSER from the
// reported positions (as the retail client does), the list sorts nearest-first,
// filters narrow it by category / group / text, and the cap always keeps the
// nearest matches.

import test from "node:test";
import assert from "node:assert/strict";

import {
  METRES_PER_AU,
  buildOverviewRows,
  distanceMeters,
  formatDistance,
  healthIsDropping,
  hostileLabel,
  hostileRows,
  isHostile,
  isMyDrone,
  newlyArrivedHostiles,
  overviewFilterIDs,
  ratioPercent,
} from "./overview.ts";
import type { SpaceEntity, SpaceSnapshot, SpaceVector } from "../store/types.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };

function entity(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return {
    kind: "celestial",
    typeID: 16,
    groupID: 10,
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

function snapshotOf(entities: SpaceEntity[]): SpaceSnapshot {
  return {
    inSpace: true,
    solarSystemID: 30000142,
    shipID: 9001,
    sampledAtMs: 1,
    entities,
    ship: null,
  };
}

const SELF = entity({ itemID: 9001, kind: "ship", isSelf: true, name: "My ship" });
const NEAR = entity({
  itemID: 50001,
  name: "Near gate",
  groupID: 10,
  categoryID: 2,
  position: { x: 1_000, y: 0, z: 0 },
});
const MID = entity({
  itemID: 50002,
  name: "Mid station",
  groupID: 15,
  categoryID: 3,
  position: { x: 0, y: 500_000, z: 0 },
});
const FAR = entity({
  itemID: 50003,
  name: "Far planet",
  groupID: 7,
  categoryID: 2,
  position: { x: 0, y: 0, z: 5 * METRES_PER_AU },
});

test("distance is computed client-side from the reported positions", () => {
  assert.equal(distanceMeters(ORIGIN, { x: 3, y: 4, z: 0 }), 5);
  assert.equal(distanceMeters({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }), 0);
  // Distance is measured from the SHIP, not the system origin.
  assert.equal(distanceMeters({ x: 10, y: 0, z: 0 }, { x: 4, y: 8, z: 0 }), 10);
});

test("distances read in the units a player expects", () => {
  assert.equal(formatDistance(0), "0 m");
  assert.equal(formatDistance(750), "750 m");
  assert.equal(formatDistance(1_500), "1.5 km");
  assert.equal(formatDistance(250_000), "250 km");
  // ⚠ Whole kilometres are GROUPED, asserted locale-independently: the
  // separator differs by machine, the digits and their count do not.
  const far = formatDistance(12_040_310_000);
  assert.match(far, /km$/);
  assert.equal(far.replace(/\D/g, ""), "12040310");
  assert.notEqual(far, "12040310 km", "a long distance must be grouped to be read");
  assert.equal(formatDistance(3 * METRES_PER_AU), "3.0 AU");
  assert.equal(formatDistance(Number.NaN), "—");
});

test("the overview sorts nearest first and never lists the player's own ship", () => {
  const { rows, matched } = buildOverviewRows(snapshotOf([FAR, SELF, NEAR, MID]), ORIGIN);

  assert.deepEqual(rows.map((row) => row.itemID), [NEAR.itemID, MID.itemID, FAR.itemID]);
  assert.equal(matched, 3, "the player's own ship is excluded from the list");
  assert.ok(rows.every((row) => row.isSelf === false));
  // Each row carries the distance the client computed.
  assert.equal(rows[0]?.distance, 1_000);
  assert.equal(rows[2]?.distance, 5 * METRES_PER_AU);
});

test("sorting by name still breaks ties by distance", () => {
  const a1 = entity({ itemID: 1, name: "Alpha", position: { x: 900, y: 0, z: 0 } });
  const a2 = entity({ itemID: 2, name: "Alpha", position: { x: 100, y: 0, z: 0 } });
  const b = entity({ itemID: 3, name: "Beta", position: { x: 10, y: 0, z: 0 } });

  const { rows } = buildOverviewRows(snapshotOf([a1, b, a2]), ORIGIN, { sort: "name" });

  assert.deepEqual(rows.map((row) => row.itemID), [2, 1, 3]);
});

test("filtering narrows by category, by group, and by free text", () => {
  const snapshot = snapshotOf([SELF, NEAR, MID, FAR]);

  const byCategory = buildOverviewRows(snapshot, ORIGIN, { filter: { categoryID: 3 } });
  assert.deepEqual(byCategory.rows.map((row) => row.itemID), [MID.itemID]);

  const byGroup = buildOverviewRows(snapshot, ORIGIN, { filter: { groupID: 7 } });
  assert.deepEqual(byGroup.rows.map((row) => row.itemID), [FAR.itemID]);

  const byText = buildOverviewRows(snapshot, ORIGIN, { filter: { text: "  GATE " } });
  assert.deepEqual(byText.rows.map((row) => row.itemID), [NEAR.itemID]);

  // Filters compose.
  const both = buildOverviewRows(snapshot, ORIGIN, {
    filter: { categoryID: 2, text: "planet" },
  });
  assert.deepEqual(both.rows.map((row) => row.itemID), [FAR.itemID]);

  // A filter that matches nothing yields an empty list, not everything.
  const none = buildOverviewRows(snapshot, ORIGIN, { filter: { text: "wormhole" } });
  assert.deepEqual(none.rows, []);
  assert.equal(none.matched, 0);
});

test("rocks and rats are always listed — nothing but self is hidden", () => {
  const gate = entity({ itemID: 1, name: "Stargate", kind: "celestial" });
  const rock = entity({ itemID: 2, name: "Veldspar", kind: "asteroid", miningYieldTypeID: 1230, beltID: 99 });
  const rat = entity({ itemID: 3, name: "Pirate", kind: "ship", isNpc: true, npcEntityType: "npc" });
  const player = entity({ itemID: 4, name: "Someone", kind: "ship", isNpc: false });
  const snapshot = snapshotOf([gate, rock, rat, player]);

  // The "hide rocks & rats" clutter filter was removed — the overview shows every
  // object around the ship (only the ship itself is dropped).
  const result = buildOverviewRows(snapshot, ORIGIN, { filter: {} });
  assert.deepEqual(result.rows.map((row) => row.itemID).sort(), [1, 2, 3, 4]);
});

test("text search matches the resolved type and group names a player sees", () => {
  const ship = entity({ itemID: 77, kind: "ship", name: null, typeID: 670 });
  const snapshot = snapshotOf([ship]);
  const names = () => ({ typeName: "Capsule", groupID: null, groupName: "Capsule" });

  const hit = buildOverviewRows(snapshot, ORIGIN, { filter: { text: "capsule" }, names });
  assert.deepEqual(hit.rows.map((row) => row.itemID), [77]);

  // Without the name lookup the same nameless row cannot be found by type.
  const miss = buildOverviewRows(snapshot, ORIGIN, { filter: { text: "capsule" } });
  assert.deepEqual(miss.rows, []);
});

test("the cap keeps the nearest matches and still reports the full match count", () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    entity({ itemID: 100 + index, position: { x: (10 - index) * 1_000, y: 0, z: 0 } }),
  );

  const { rows, matched } = buildOverviewRows(snapshotOf(many), ORIGIN, { cap: 3 });

  assert.equal(matched, 10, "the count reflects everything that matched, not what was shown");
  assert.equal(rows.length, 3);
  // Nearest three: the ones seeded with the smallest x.
  assert.deepEqual(rows.map((row) => row.distance), [1_000, 2_000, 3_000]);
});

test("filter choices come from what is actually visible, excluding the ship", () => {
  const { categoryIDs, groupIDs } = overviewFilterIDs(snapshotOf([SELF, NEAR, MID, FAR]));

  assert.deepEqual([...categoryIDs].sort((a, b) => a - b), [2, 3]);
  assert.deepEqual([...groupIDs].sort((a, b) => a - b), [7, 10, 15]);
  // A null snapshot offers no filters rather than throwing.
  assert.deepEqual(overviewFilterIDs(null), { categoryIDs: [], groupIDs: [] });
});

test("a missing snapshot yields an empty overview rather than throwing", () => {
  assert.deepEqual(buildOverviewRows(null, ORIGIN), { rows: [], matched: 0 });
});

test("ratios become whole percentages for the HUD bars", () => {
  assert.equal(ratioPercent(1), 100);
  assert.equal(ratioPercent(0), 0);
  assert.equal(ratioPercent(0.257), 26);
  // Out-of-range or absent values are clamped / reported as "no bar".
  assert.equal(ratioPercent(1.4), 100);
  assert.equal(ratioPercent(-0.2), 0);
  assert.equal(ratioPercent(null), null);
  assert.equal(ratioPercent(undefined), null);
  assert.equal(ratioPercent(Number.NaN), null);
});

// --- R25 slice B: telling a pirate from a person -----------------------------
//
// ⚠ THE FINDING THIS WHOLE SECTION EXISTS FOR: a belt rat is `kind: "ship"`.
// The server builds it through the same entity path as the player parked next
// to you, with the same name, position, health and velocity fields. So `kind`
// cannot separate them — and neither could anything else this row carried
// before R25. Every test below is a guard against re-deriving that the wrong
// way.

/** A ship row, player-flown or NPC, otherwise identical. */
function shipRow(over: Partial<SpaceEntity> & { itemID: number }): SpaceEntity {
  return entity({ kind: "ship", typeID: 606, groupID: 25, categoryID: 6, ...over });
}

test("a rat and a player ship differ ONLY in isNpc / npcEntityType", () => {
  const rat = shipRow({ itemID: 1, isNpc: true, npcEntityType: "npc", characterID: null });
  const player = shipRow({ itemID: 2, isNpc: false, npcEntityType: null, characterID: 90000042 });

  // The trap, asserted so nobody re-introduces it: kind is identical.
  assert.equal(rat.kind, player.kind);

  assert.equal(isHostile(rat), true);
  assert.equal(isHostile(player), false);
  assert.equal(hostileLabel(rat), "Pirate");
  assert.equal(hostileLabel(player), null, "a player gets no badge at all");
});

test("⚠ characterID === 0 is NOT the test — a structure would be flagged", () => {
  // The shortcut that almost works. A structure and a corp-owned ball both
  // carry no characterID, and a warning that flags harmless furniture gets
  // ignored — which is worse than having no warning.
  const structure = entity({
    itemID: 3,
    kind: "structure",
    characterID: null,
    isNpc: false,
    npcEntityType: null,
  });
  assert.equal(isHostile(structure), false);
  assert.equal(hostileLabel(structure), null);
});

test("police are an NPC that is NOT a threat; a drifter is", () => {
  const concord = shipRow({ itemID: 4, isNpc: true, npcEntityType: "concord" });
  const drifter = shipRow({ itemID: 5, isNpc: true, npcEntityType: "drifter" });
  assert.equal(isHostile(concord), false, "law enforcement does not shoot a miner");
  assert.equal(hostileLabel(concord), "Police");
  assert.equal(isHostile(drifter), true);
  assert.equal(hostileLabel(drifter), "Drifter");
});

test("an NPC of an unreadable kind is treated as hostile — loud, not silent", () => {
  // For a warning whose job is to keep a miner alive, an unknown NPC is the
  // case you want to be wrong about in the loud direction.
  const unknown = shipRow({ itemID: 6, isNpc: true, npcEntityType: null });
  assert.equal(isHostile(unknown), true);
  assert.equal(hostileLabel(unknown), "Pirate");
});

test("your own ship is never a threat to itself", () => {
  const self = shipRow({ itemID: 7, isNpc: true, npcEntityType: "npc", isSelf: true });
  assert.equal(isHostile(self), false);
});

test("R9a: every badge is a word a player uses, with no id in it", () => {
  for (const npcEntityType of ["npc", "concord", "drifter", null]) {
    const label = hostileLabel(shipRow({ itemID: 8, isNpc: true, npcEntityType }));
    assert.ok(label);
    assert.doesNotMatch(label, /\d/, `"${label}" must contain no number`);
    assert.doesNotMatch(label, /npc|entity|kind/i, `"${label}" must not leak runtime wording`);
  }
});

test("threats are read from the WHOLE snapshot, nearest first, uncapped", () => {
  // The reason this is not a filter over the overview: the overview is
  // searchable, filterable and capped at 200 rows, so a miner who searched for
  // "Veldspar" would have filtered away the thing shooting them.
  const far = shipRow({ itemID: 10, isNpc: true, npcEntityType: "npc", position: { x: 50_000, y: 0, z: 0 } });
  const near = shipRow({ itemID: 11, isNpc: true, npcEntityType: "npc", position: { x: 900, y: 0, z: 0 } });
  const rock = entity({ itemID: 12, kind: "asteroid", position: { x: 100, y: 0, z: 0 } });
  const rows = hostileRows(snapshotOf([far, rock, near]), ORIGIN);
  assert.deepEqual(rows.map((row) => row.itemID), [11, 10]);
  assert.ok(Number(rows[0]?.distance) < Number(rows[1]?.distance));
  assert.deepEqual(hostileRows(null, ORIGIN), []);
});

test("only NEW hostiles are announced — the ones already there are not news", () => {
  const first = shipRow({ itemID: 20, isNpc: true, npcEntityType: "npc" });
  const second = shipRow({ itemID: 21, isNpc: true, npcEntityType: "npc" });
  const rows = hostileRows(snapshotOf([first, second]), ORIGIN);

  // Primed from the first look: landing in an occupied belt announces nothing.
  assert.deepEqual(newlyArrivedHostiles(rows, new Set([20, 21])), []);
  // The one that just warped in.
  assert.deepEqual(
    newlyArrivedHostiles(rows, new Set([20])).map((row) => row.itemID),
    [21],
  );
});

test("a drone is mine by owner OR by the hull flying it", () => {
  const mine = entity({ itemID: 30, kind: "drone", ownerID: 7, controllerID: 9001 });
  const ownedButSwapped = entity({ itemID: 31, kind: "drone", ownerID: 7, controllerID: 5555 });
  const someoneElses = entity({ itemID: 32, kind: "drone", ownerID: 999, controllerID: 8888 });
  const notADrone = entity({ itemID: 33, kind: "ship", ownerID: 7, controllerID: 9001 });

  assert.equal(isMyDrone(mine, 7, 9001), true);
  assert.equal(isMyDrone(ownedButSwapped, 7, 9001), true, "still mine after a hull swap");
  assert.equal(isMyDrone(someoneElses, 7, 9001), false);
  assert.equal(isMyDrone(notADrone, 7, 9001), false, "only drone rows count");
});

test("a drone is never mistaken for a hostile, whoever owns it", () => {
  const someoneElses = entity({ itemID: 34, kind: "drone", ownerID: 999, isNpc: false });
  assert.equal(isHostile(someoneElses), false);
});

// --- "You are under attack", the honest version ------------------------------

test("damage is reported from two consecutive readings, never invented", () => {
  // There is NO damage-log read on this server, so this client does not invent
  // one. All it claims is what the HUD actually showed: a layer went down.
  const full = { shieldRatio: 1, armorRatio: 1, hullRatio: 1 };
  assert.equal(healthIsDropping(full, { ...full, shieldRatio: 0.8 }), true);
  assert.equal(healthIsDropping(full, { ...full, armorRatio: 0.9 }), true);
  assert.equal(healthIsDropping(full, { ...full, hullRatio: 0.99 }), true);
  assert.equal(healthIsDropping(full, full), false, "steady is not damage");
  // Recharging is not damage either.
  assert.equal(healthIsDropping({ ...full, shieldRatio: 0.5 }, full), false);
});

test("an unknown health layer is never reported as damage", () => {
  const unknown = { shieldRatio: null, armorRatio: null, hullRatio: null };
  assert.equal(healthIsDropping(unknown, { shieldRatio: 0.2, armorRatio: null, hullRatio: null }), false);
  assert.equal(healthIsDropping({ shieldRatio: 1, armorRatio: null, hullRatio: null }, unknown), false);
  // And nothing to compare against is nothing to claim.
  assert.equal(healthIsDropping(null, { shieldRatio: 0.1, armorRatio: null, hullRatio: null }), false);
  assert.equal(healthIsDropping({ shieldRatio: 1, armorRatio: null, hullRatio: null }, null), false);
});
