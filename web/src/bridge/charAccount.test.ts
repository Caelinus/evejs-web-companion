// charUnboundMgr character/account decoders (goal R70) against REAL captured
// bytes + the server's own populated shapes.
//
// ⚠ The empty/stub paths (GetCharacterLockType -> null, GetCohortsForUser -> empty
// list) and the scalar reads (GetNumCharacters, GetValidRandomName, ValidateNameEx,
// GetQAStarterSystemIDs) were all captured LIVE through GET /api/bridge/char-account
// on 2026-07-22 (Farmer 140000005) and are asserted below. The GetCharacterInfo
// POPULATED fixture mirrors Handle_GetCharacterToSelect's exact util.KeyVal output
// (eve.js server/src/services/character/charService.js:756), so the decoder is proven
// against the shape the handler emits — and its ownership guarantee (a FOREIGN charID
// returns null) is asserted directly.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeCharacterInfo,
  decodeCharacterLockType,
  decodeCohortsForUser,
  decodeNameValidation,
  decodeNumCharacters,
  decodeStarterSystemIDs,
  decodeValidRandomName,
  isNameValid,
  type CharacterAccountInfo,
  decodeCharUnboundWriteAck,
  decodeCharacterCreatedAck,
} from "./charAccount.ts";
import type { JsonValue } from "./wire.ts";

// Handle_GetCharacterToSelect's exact KeyVal output for Farmer's own character.
const CHARACTER_INFO: JsonValue = {
  type: "object",
  name: "util.KeyVal",
  args: {
    type: "dict",
    entries: [
      ["unreadMailCount", 3],
      ["upcomingEventCount", 0],
      ["unprocessedNotifications", 5],
      ["characterID", 140000005],
      ["petitionMessage", ""],
      ["gender", 1],
      ["raceID", 1],
      ["bloodlineID", 1],
      ["ancestryID", 1],
      ["schoolID", null],
      ["createDateTime", { type: "long", value: "132000000000000000" }],
      ["startDateTime", { type: "long", value: "132000000000000000" }],
      ["corporationID", 98000001],
      ["worldSpaceID", 0],
      ["stationID", 60000004],
      ["solarSystemID", 30000142],
      ["constellationID", 20000020],
      ["regionID", 10000002],
      ["allianceID", null],
      ["allianceMemberStartDate", null],
      ["shortName", "none"],
      // eve.js sends ISK money (bounty, balance, aurBalance) as a marshalled real.
      ["bounty", { type: "real", value: 0 }],
      ["skillQueueEndTime", { type: "long", value: "134285151537020000" }],
      ["skillPoints", 5500000],
      ["shipTypeID", 606],
      ["shipName", "Farmer's Reaper"],
      ["securityRating", 0.14],
      ["securityStatus", 0.14],
      ["title", ""],
      ["balance", { type: "real", value: 100000 }],
      ["aurBalance", { type: "real", value: 0 }],
      ["plexBalance", 2222],
      ["daysLeft", 365],
      ["userType", 30],
      ["paperDollState", 2],
      ["paperdollState", 2],
    ],
  },
};

test("decodeNumCharacters reads the account's character count", () => {
  assert.equal(decodeNumCharacters(1), 1);
  assert.equal(decodeNumCharacters(0), 0);
});

test("decodeCharacterInfo decodes the account's OWN character selection data", () => {
  const info = decodeCharacterInfo(CHARACTER_INFO);
  assert.notEqual(info, null);
  const decoded = info as CharacterAccountInfo;
  assert.equal(decoded.characterID, 140000005);
  assert.equal(decoded.corporationID, 98000001);
  // 0/absent alliance is carried as null so a future UI omits the row.
  assert.equal(decoded.allianceID, null);
  assert.equal(decoded.stationID, 60000004);
  assert.equal(decoded.solarSystemID, 30000142);
  assert.equal(decoded.regionID, 10000002);
  assert.equal(decoded.shipTypeID, 606);
  assert.equal(decoded.shipName, "Farmer's Reaper");
  assert.equal(decoded.skillPoints, 5500000);
  assert.equal(decoded.securityStatus, 0.14);
  // ISK amounts are bigint-safe strings; FILETIMEs are bigints.
  assert.equal(decoded.balance, "100000");
  assert.equal(decoded.bounty, "0");
  assert.equal(decoded.createDateTime, 132000000000000000n);
  assert.equal(decoded.skillQueueEndTime, 134285151537020000n);
});

test("decodeCharacterInfo still reads ISK money sent as a bare number", () => {
  const info = decodeCharacterInfo({
    type: "object",
    name: "util.KeyVal",
    args: {
      type: "dict",
      entries: [
        ["characterID", 140000005],
        ["balance", 100000.5],
        ["bounty", 2500000],
      ],
    },
  });
  assert.equal(info?.balance, "100000.5");
  assert.equal(info?.bounty, "2500000");
});

test("decodeCharacterInfo returns null for a FOREIGN/unknown charID (the ownership guard)", () => {
  // ⚠ Handle_GetCharacterToSelect returns null for a charID not on the account,
  // so a foreign read arrives as null — never that character's data.
  assert.equal(decodeCharacterInfo(null), null);
  assert.equal(decodeCharacterInfo(undefined), null);
  // A non-KeyVal shape is not a character row either.
  assert.equal(decodeCharacterInfo({ type: "list", items: [] }), null);
});

test("decodeCharacterLockType reads the (stub) null lock type", () => {
  assert.equal(decodeCharacterLockType(null), null);
  assert.equal(decodeCharacterLockType(2), 2);
});

test("decodeCohortsForUser reads the empty-by-design cohort list", () => {
  assert.deepEqual(decodeCohortsForUser({ type: "list", items: [] }), []);
  assert.deepEqual(decodeCohortsForUser(null), []);
});

test("decodeValidRandomName reads the random name string", () => {
  assert.equal(decodeValidRandomName("Aldrik Vaugn"), "Aldrik Vaugn");
  assert.equal(decodeValidRandomName(null), null);
});

test("decodeNameValidation reads the validation code, isNameValid gates on 1 (VALID)", () => {
  // Live: an empty name returned -1 (TOO_SHORT); "Zaphod Beeblebrox" returned 1 (VALID).
  assert.equal(decodeNameValidation(1), 1);
  assert.equal(decodeNameValidation(-1), -1);
  assert.equal(decodeNameValidation(-6), -6);
  assert.equal(decodeNameValidation(null), null);
  assert.equal(isNameValid(1), true);
  assert.equal(isNameValid(-1), false);
  assert.equal(isNameValid(0), false);
  assert.equal(isNameValid(null), false);
});

test("decodeStarterSystemIDs keeps the starter system ids as numbers (R7d)", () => {
  assert.deepEqual(decodeStarterSystemIDs([30000142, 30002187, 30001407]), [
    30000142, 30002187, 30001407,
  ]);
  // Non-positive / non-array inputs drop out.
  assert.deepEqual(decodeStarterSystemIDs([0, -1]), []);
  assert.deepEqual(decodeStarterSystemIDs(null), []);
});

// R7d id-sweep: the character info preserves its entity ids as numeric fields.
function characterInfoIdFields(info: CharacterAccountInfo): number[] {
  return [
    info.corporationID,
    info.stationID,
    info.solarSystemID,
    info.constellationID,
    info.regionID,
    info.shipTypeID,
    ...(info.allianceID === null ? [] : [info.allianceID]),
  ];
}

test("R7d: decoded character info preserves its entity ids as numeric fields", () => {
  const info = decodeCharacterInfo(CHARACTER_INFO) as CharacterAccountInfo;
  const ids = characterInfoIdFields(info);
  assert.ok(ids.includes(98000001), "corporationID preserved");
  assert.ok(ids.includes(60000004), "stationID preserved");
  assert.ok(ids.includes(30000142), "solarSystemID preserved");
  assert.ok(ids.includes(10000002), "regionID preserved");
});

test("the character-info id-field extractor actually reads the decoded content", () => {
  // Companion: distinct fields yield distinct ids, so the sweep is not vacuous.
  const ids = characterInfoIdFields({
    corporationID: 11,
    stationID: 22,
    solarSystemID: 33,
    constellationID: 44,
    regionID: 55,
    shipTypeID: 66,
    allianceID: 77,
  } as CharacterAccountInfo);
  assert.deepEqual(ids, [11, 22, 33, 44, 55, 66, 77]);
});

// --- R88 write acks (Phase-3 charUnboundMgr WRITES) --------------------------

/** The ordinary JSON object emitted by the BFF's Express response. */
function plainAck(fields: Record<string, JsonValue>): JsonValue {
  return { ...fields };
}

test("R88 — a charUnboundMgr write ack decodes to {ok, applied}", () => {
  const ack = decodeCharUnboundWriteAck(plainAck({ ok: true, applied: true, result: null }));
  assert.deepEqual(ack, { ok: true, applied: true });
});

test("R88 — a declined charUnboundMgr write is read as not-applied, not a throw", () => {
  const ack = decodeCharUnboundWriteAck(plainAck({ ok: true, applied: false }));
  assert.equal(ack.ok, true);
  assert.equal(ack.applied, false);
});

test("R88 — a CreateCharacterWithDoll ack surfaces the new characterID from result", () => {
  const ack = decodeCharacterCreatedAck(plainAck({ ok: true, applied: true, result: 140000042 }));
  assert.equal(ack.applied, true);
  assert.equal(ack.characterID, 140000042);
});

test("R88 — a CreateCharacterWithDoll ack with no id reads characterID null", () => {
  const ack = decodeCharacterCreatedAck(plainAck({ ok: true, applied: false, result: null }));
  assert.equal(ack.characterID, null);
});
