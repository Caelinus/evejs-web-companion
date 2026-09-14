// Reward-read decoders (goal R6, inventory Step 12) against real handler-shaped
// marshaled fixtures captured from the gateway: account.GetCashBalance (a plain
// number or a long), LPSvc.GetAllMyCharacterWalletLPBalances (a CRowset of
// packed [issuerCorpID, loyaltyPoints] rows), and standingMgr.GetCharStandings
// (a header/lines Rowset of [fromID, standing]).

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeCashBalance,
  decodeCharStandings,
  decodeLpBalances,
  toAmountString,
  decodeLpWriteAck,
} from "./rewards.ts";
import type { JsonValue } from "./wire.ts";

test("decodeCashBalance handles a plain number, a decimal string, and a long wrapper", () => {
  assert.equal(decodeCashBalance(1000000000), "1000000000");
  assert.equal(decodeCashBalance(1000000.5), "1000000.5");
  assert.equal(decodeCashBalance({ type: "long", value: "133742000000000000" } as JsonValue), "133742000000000000");
  assert.equal(decodeCashBalance("500000"), "500000");
  assert.equal(decodeCashBalance(null), null);
  assert.equal(decodeCashBalance(undefined as unknown as JsonValue), null);
});

test("toAmountString never zeroes a long-encoded amount", () => {
  // The trap: `typeof === "number" ? … : 0` would drop this to "0".
  assert.equal(toAmountString({ type: "long", value: 250 } as JsonValue), "250");
});

test("toAmountString reads a real-wrapped amount exactly like the plain number", () => {
  // The trap: reading only bare numbers turns eve.js's real-wrapped ISK into null.
  assert.equal(toAmountString({ type: "real", value: 1000001000 } as JsonValue), "1000001000");
  assert.equal(toAmountString({ type: "real", value: 100000.5 } as JsonValue), "100000.5");
  assert.equal(toAmountString({ type: "real", value: 0 } as JsonValue), "0");
  assert.equal(toAmountString({ type: "real", value: "lots" } as JsonValue), null);
});

// LPSvc.GetAllMyCharacterWalletLPBalances marshals as a CRowset (objectex2)
// whose `list` is packed rows [issuerCorpID, loyaltyPoints].
const LP_DESCRIPTOR: JsonValue = {
  type: "objectex1",
  header: [{ type: "token", value: "blue.DBRowDescriptor" }, [[["issuerCorpID", 3], ["loyaltyPoints", 3]]]],
  list: [],
  dict: [],
};

function lpRowset(rows: ReadonlyArray<readonly [number, number]>): JsonValue {
  return {
    type: "objectex2",
    header: [
      [{ type: "token", value: "carbon.common.script.sys.crowset.CRowset" }],
      { type: "dict", entries: [["header", LP_DESCRIPTOR]] },
    ],
    list: rows.map(([issuerCorpID, loyaltyPoints]) => ({
      type: "packedrow",
      header: LP_DESCRIPTOR,
      columns: [["issuerCorpID", 3], ["loyaltyPoints", 3]],
      values: [issuerCorpID, loyaltyPoints],
    })),
    dict: [],
  };
}

test("decodeLpBalances reads packed CRowset rows; empty list -> []", () => {
  assert.deepEqual(decodeLpBalances(lpRowset([])), []);
  assert.deepEqual(decodeLpBalances(lpRowset([[1000165, 250], [1000044, 13500]])), [
    { issuerCorpID: 1000165, loyaltyPoints: "250" },
    { issuerCorpID: 1000044, loyaltyPoints: "13500" },
  ]);
});

test("decodeLpBalances tolerates a named-fields packed row and drops corp-less rows", () => {
  const rowset: JsonValue = {
    type: "objectex2",
    header: [],
    list: [
      { type: "packedrow", fields: { issuerCorpID: 1000165, loyaltyPoints: 999 } },
      { type: "packedrow", columns: [["issuerCorpID", 3], ["loyaltyPoints", 3]], values: [0, 5] },
    ],
    dict: [],
  };
  assert.deepEqual(decodeLpBalances(rowset), [{ issuerCorpID: 1000165, loyaltyPoints: "999" }]);
});

// standingMgr.GetCharStandings marshals as a header/lines Rowset; each line is a
// {type:"list"} of [fromID, standing].
function standingsRowset(rows: ReadonlyArray<readonly [number, number]>): JsonValue {
  return {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [
        ["header", { type: "list", items: ["fromID", "standing"] }],
        ["RowClass", { type: "token", value: "util.Row" }],
        ["lines", { type: "list", items: rows.map(([fromID, standing]) => ({ type: "list", items: [fromID, standing] })) }],
      ],
    },
  };
}

test("decodeCharStandings reads [fromID, standing] lines by column name", () => {
  assert.deepEqual(decodeCharStandings(standingsRowset([])), []);
  assert.deepEqual(decodeCharStandings(standingsRowset([[500001, 0.75], [1000044, 1.25]])), [
    { fromID: 500001, standing: 0.75 },
    { fromID: 1000044, standing: 1.25 },
  ]);
});

test("the decoders tolerate malformed input without throwing", () => {
  assert.deepEqual(decodeLpBalances(null), []);
  assert.deepEqual(decodeLpBalances({ type: "dict", entries: [] } as JsonValue), []);
  assert.deepEqual(decodeCharStandings(null), []);
  assert.deepEqual(decodeCharStandings(42 as unknown as JsonValue), []);
});

// --- R89 LPSvc financial write acks (Phase-3 WRITES) ------------------------

function plainAck(fields: Record<string, JsonValue>): JsonValue {
  return { ...fields };
}

test("R89 — an LPSvc transfer ack decodes to {ok, applied}", () => {
  const ack = decodeLpWriteAck(plainAck({ ok: true, applied: true, result: null }));
  assert.deepEqual(ack, { ok: true, applied: true });
});

test("R89 — a declined LP transfer is read as not-applied, not a throw", () => {
  const ack = decodeLpWriteAck(plainAck({ ok: true, applied: false }));
  assert.equal(ack.ok, true);
  assert.equal(ack.applied, false);
});
