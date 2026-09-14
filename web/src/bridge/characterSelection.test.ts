// Unit tests for the typed reference call (goal R1b):
// charUnboundMgr.GetCharacterSelectionData end to end against a stubbed
// fetch, plus the KeyVal/long decoding it rests on. The fixture mirrors
// eve.js Handle_GetCharacterSelectionData output after the gateway's JSON
// encoding (BigInt longs as decimal strings — docs/bridge-wire-contract.md).

import test from "node:test";
import assert from "node:assert/strict";

import {
  CHARACTER_SELECTION_METHOD,
  CHARACTER_SELECTION_SERVICE,
  decodeCharacterRow,
  decodeCharacterSelectionData,
  getCharacterSelectionData,
} from "./characterSelection.ts";
import { unwrapLong, type JsonValue, type KeyValValue } from "./wire.ts";

function keyVal(entries: readonly (readonly [string, JsonValue])[]): KeyValValue {
  return {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  };
}

// Mirrors the handler's characterDetails row: plain numbers/strings, a
// number-valued long wrapper (logoffDate), a decimal-string long wrapper
// (BigInt trainingStartTime after gateway encoding), a real wrapper (the ISK
// balance, which eve.js sends as a marshalled real), and a null training end.
const pilotRow = keyVal([
  ["characterID", 91000001],
  ["characterName", "Test Pilot"],
  ["gender", 1],
  ["typeID", 1373],
  ["corporationID", 1000009],
  ["allianceID", null],
  ["stationID", 60000004],
  ["solarSystemID", 30000142],
  ["regionID", 10000002],
  ["balance", { type: "real", value: 100000.5 }],
  ["skillPoints", 512345],
  ["shipTypeID", 606],
  ["shipName", "Velator"],
  ["securityStatus", 0.42],
  ["title", ""],
  ["unreadMailCount", 3],
  ["logoffDate", { type: "long", value: 1320000000000 }],
  ["skillTypeID", 3300],
  ["toLevel", 4],
  ["trainingStartTime", { type: "long", value: "157469184000000000" }],
  ["trainingEndTime", null],
  ["queueEndTime", null],
]);

function selectionTuple(rows: readonly JsonValue[]): JsonValue {
  return [
    { type: "list", items: [keyVal([["userName", "ceo"], ["characterSlots", 3]])] },
    [null, null],
    { type: "list", items: rows },
    { type: "list", items: [] },
  ];
}

test("decodeCharacterRow types every field class: numbers, strings, nulls, and both long encodings", () => {
  const row = decodeCharacterRow(pilotRow);
  assert.ok(row);
  assert.equal(row.characterID, 91000001);
  assert.equal(row.characterName, "Test Pilot");
  assert.equal(row.corporationID, 1000009);
  assert.equal(row.allianceID, null);
  assert.equal(row.balance, 100000.5);
  assert.equal(row.skillPoints, 512345);
  assert.equal(row.shipName, "Velator");
  assert.equal(row.securityStatus, 0.42);
  assert.equal(row.unreadMailCount, 3);
  // Number-valued long wrapper -> bigint.
  assert.equal(row.logoffDate, 1320000000000n);
  // BigInt-marshaled long crosses the gateway as a decimal string -> bigint.
  assert.equal(row.trainingStartTime, 157469184000000000n);
  assert.equal(row.trainingEndTime, null);
  assert.equal(row.queueEndTime, null);
  assert.equal(row.skillTypeID, 3300);
  assert.equal(row.toLevel, 4);
});

test("unwrapLong accepts both wire encodings and rejects garbage", () => {
  assert.equal(unwrapLong({ type: "long", value: 7 }), 7n);
  assert.equal(unwrapLong({ type: "long", value: "133742000000000000" }), 133742000000000000n);
  assert.equal(unwrapLong(12), 12n);
  assert.equal(unwrapLong(null), null);
  assert.equal(unwrapLong({ type: "long", value: "not-a-number" }), null);
  assert.equal(unwrapLong({ type: "long", value: 1.5 }), null);
  assert.equal(unwrapLong("133742"), null, "bare strings are not longs");
});

test("decodeCharacterSelectionData skips malformed rows and keeps valid ones", () => {
  const decoded = decodeCharacterSelectionData(
    selectionTuple([
      pilotRow,
      "garbage",
      keyVal([["characterName", "No ID Pilot"]]),
    ]),
  );
  assert.equal(decoded.characters.length, 1);
  assert.equal(decoded.characters[0]?.characterID, 91000001);
  // The raw tuple stays available for not-yet-decoded fields.
  assert.equal(decoded.raw.length, 4);
});

test("decodeCharacterSelectionData rejects non-retail-shaped results", () => {
  assert.throws(() => decodeCharacterSelectionData(null), /4-tuple/);
  assert.throws(() => decodeCharacterSelectionData([1, 2, 3]), /4-tuple/);
  assert.throws(
    () => decodeCharacterSelectionData([[], [null, null], { notAList: true }, []]),
    /characterDetails/,
  );
});

test("getCharacterSelectionData drives the reference tuple through the bridge and decodes it", async () => {
  const bodies: unknown[] = [];
  const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        ok: true,
        service: CHARACTER_SELECTION_SERVICE,
        method: CHARACTER_SELECTION_METHOD,
        result: selectionTuple([pilotRow]),
        notifications: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const selection = await getCharacterSelectionData({ fetch: fetchStub });

  assert.deepEqual(bodies, [
    {
      service: "charUnboundMgr",
      method: "GetCharacterSelectionData",
      args: [],
      kwargs: null,
    },
  ]);
  assert.equal(selection.characters.length, 1);
  assert.equal(selection.characters[0]?.characterName, "Test Pilot");
  assert.equal(selection.characters[0]?.trainingStartTime, 157469184000000000n);
  // The real-wrapped balance survives the JSON hop and still decodes.
  assert.equal(selection.characters[0]?.balance, 100000.5);
  assert.deepEqual(selection.notifications, []);
});

test("decodeCharacterRow reads the ISK balance from a real wrapper or a bare number", () => {
  // The trap: reading only bare numbers turned eve.js's real-wrapped balance into "0 ISK".
  const real = decodeCharacterRow(keyVal([["characterID", 1], ["balance", { type: "real", value: 1000001000 }]]));
  assert.equal(real?.balance, 1000001000);
  const bare = decodeCharacterRow(keyVal([["characterID", 1], ["balance", 42]]));
  assert.equal(bare?.balance, 42);
  const absent = decodeCharacterRow(keyVal([["characterID", 1]]));
  assert.equal(absent?.balance, null);
  const garbage = decodeCharacterRow(keyVal([["characterID", 1], ["balance", { type: "real", value: "lots" }]]));
  assert.equal(garbage?.balance, null);
});
