// The repair shop's quote (repairSvc.GetRepairQuotes), decoded.
//
// The rules under test are the two that keep a wallet-charging button honest:
// an item the shop lists with NO damaged parts is NOT damaged, and a price is
// only ever reported when the shop actually quoted one.

import test from "node:test";
import assert from "node:assert/strict";

import { decodeRepairQuotes, repairQuoteTotal } from "./repairQuotes.ts";

function part(fields: Record<string, unknown>): unknown {
  return { type: "packedrow", fields };
}

function quotes(entries: readonly (readonly [number, unknown])[]): unknown {
  return { type: "dict", entries };
}

test("only the items the shop lists damage on are quoted", () => {
  const decoded = decodeRepairQuotes(
    quotes([
      [9001, { type: "list", items: [part({ cost: 1250 })] }],
      [9002, { type: "list", items: [] }],
    ]),
  );

  assert.deepEqual(decoded, [{ itemID: 9001, damagedParts: 1, cost: 1250 }]);
});

test("the parts of one item sum into that item's cost", () => {
  const decoded = decodeRepairQuotes(
    quotes([[9001, { type: "list", items: [part({ cost: 1000 }), part({ cost: 250.5 })] }]]),
  );

  assert.deepEqual(decoded, [{ itemID: 9001, damagedParts: 2, cost: 1250.5 }]);
});

test("a quote with no price reads as no price, never as free", () => {
  const decoded = decodeRepairQuotes(quotes([[9001, { type: "list", items: [part({ damage: 0.4 })] }]]));

  assert.deepEqual(decoded, [{ itemID: 9001, damagedParts: 1, cost: null }]);
  assert.equal(repairQuoteTotal(decoded), null);
});

test("a total is withheld unless EVERY quoted item carried a price", () => {
  const decoded = decodeRepairQuotes(
    quotes([
      [9001, { type: "list", items: [part({ cost: 1000 })] }],
      [9002, { type: "list", items: [part({ damage: 0.4 })] }],
    ]),
  );

  assert.equal(repairQuoteTotal(decoded), null, "a partial sum would understate the charge");
  assert.equal(repairQuoteTotal(decoded.filter((row) => row.cost !== null)), 1000);
});

test("a bare-array parts list and a util.KeyVal wrapper decode the same as {type:list}", () => {
  assert.deepEqual(decodeRepairQuotes(quotes([[9001, [part({ cost: 7 })]]])), [
    { itemID: 9001, damagedParts: 1, cost: 7 },
  ]);
  const keyVal = {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: [["items", { type: "list", items: [part({ cost: 7 })] }]] },
  };
  assert.deepEqual(decodeRepairQuotes(quotes([[9001, keyVal]])), [
    { itemID: 9001, damagedParts: 1, cost: 7 },
  ]);
});

test("a result that is not a dict is no damage, and an empty quote has no total", () => {
  assert.deepEqual(decodeRepairQuotes(null), []);
  assert.deepEqual(decodeRepairQuotes({ type: "list", items: [] }), []);
  assert.equal(repairQuoteTotal([]), null);
});
