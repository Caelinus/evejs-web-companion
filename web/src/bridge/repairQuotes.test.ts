// The repair shop's quote (repairSvc.GetRepairQuotes), decoded.
//
// The rules under test are the two that keep a wallet-charging button honest:
// an item the shop lists with NO damaged parts is NOT damaged, and a price is
// only ever reported when the shop actually quoted one.

import test from "node:test";
import assert from "node:assert/strict";

import { decodeRepairQuotes, repairQuoteTotal, repairTargets } from "./repairQuotes.ts";

function part(fields: Record<string, unknown>): unknown {
  return { type: "packedrow", fields };
}

/** A decoded part, with the fields a test does not set left null. */
function quoted(itemID: number, fields: Partial<Record<"typeID" | "damage" | "maxHealth" | "cost", number>> = {}): unknown {
  return { itemID, typeID: null, damage: null, maxHealth: null, cost: null, ...fields };
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

  assert.deepEqual(decoded, [{ itemID: 9001, repairItemIDs: [9001], damagedParts: 1, parts: [quoted(9001, { cost: 1250 })], cost: 1250 }]);
});

test("the parts of one item sum into that item's cost", () => {
  const decoded = decodeRepairQuotes(
    quotes([[9001, { type: "list", items: [part({ cost: 1000 }), part({ cost: 250.5 })] }]]),
  );

  assert.deepEqual(decoded, [{
    itemID: 9001,
    repairItemIDs: [9001],
    damagedParts: 2,
    parts: [quoted(9001, { cost: 1000 }), quoted(9001, { cost: 250.5 })],
    cost: 1250.5,
  }]);
});

test("a quote with no price reads as no price, never as free", () => {
  const decoded = decodeRepairQuotes(quotes([[9001, { type: "list", items: [part({ damage: 0.4 })] }]]));

  assert.deepEqual(decoded, [{ itemID: 9001, repairItemIDs: [9001], damagedParts: 1, parts: [quoted(9001, { damage: 0.4 })], cost: null }]);
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
    { itemID: 9001, repairItemIDs: [9001], damagedParts: 1, parts: [quoted(9001, { cost: 7 })], cost: 7 },
  ]);
  const keyVal = {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: [["items", { type: "list", items: [part({ cost: 7 })] }]] },
  };
  assert.deepEqual(decodeRepairQuotes(quotes([[9001, keyVal]])), [
    { itemID: 9001, repairItemIDs: [9001], damagedParts: 1, parts: [quoted(9001, { cost: 7 })], cost: 7 },
  ]);
});

// A hull's quote lists what is ON it — fitted modules and every drone in the bay
// — under the HULL's key, each part row naming its own item. RepairItems fixes
// exactly the ids it is handed, so repairing by the key fixed nothing: a clean
// hull with two chewed drones answered OK and quoted damaged again, and a bot's
// repair step stopped on "not enough money?" with a full wallet.
test("a hull's quote repairs each damaged PART by its own id, not the hull's", () => {
  const decoded = decodeRepairQuotes(
    quotes([
      [
        9001,
        {
          type: "list",
          items: [part({ itemID: 7002, damage: 120 }), part({ itemID: 7003, damage: 480 })],
        },
      ],
    ]),
  );

  assert.deepEqual(decoded, [{
    itemID: 9001,
    repairItemIDs: [7002, 7003],
    damagedParts: 2,
    parts: [quoted(7002, { damage: 120 }), quoted(7003, { damage: 480 })],
    cost: null,
  }]);
  assert.deepEqual(repairTargets(decoded), [7002, 7003], "the hull itself is not damaged, so it is not named");
});

test("a part row in the handler's own util.KeyVal shape yields its id the same way", () => {
  const keyValPart = {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: [["itemID", 7003], ["damage", 480], ["costToRepairOneUnitOfDamage", 1]] },
  };
  const decoded = decodeRepairQuotes(quotes([[9001, { type: "list", items: [keyValPart] }]]));
  assert.deepEqual(repairTargets(decoded), [7003]);
});

test("repair targets are every part once, in quote order; a row without parts stands for itself", () => {
  assert.deepEqual(
    repairTargets([
      { itemID: 9001, repairItemIDs: [9001, 7002] },
      { itemID: 5001, repairItemIDs: [7002, 5001] },
      { itemID: 6001 },
    ]),
    [9001, 7002, 5001, 6001],
  );
  assert.deepEqual(repairTargets([]), []);
});

// The running server's own row (repairService buildRepairQuoteRow): a util.KeyVal
// with damage in HP and a PER-HP price, never a total. The retail repair window
// prices each part as ceil(damage) * costToRepairOneUnitOfDamage; a decoder that
// only read `cost` showed "—" and "did not quote a price" on every quote.
function serverRow(fields: readonly (readonly [string, number])[]): unknown {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries: fields } };
}

test("the server's per-HP row is priced as ceil(damage) * unit cost, as the client does", () => {
  const drone = serverRow([
    ["itemID", 7002], ["typeID", 2454], ["damage", 108.65], ["maxHealth", 1000],
    ["costToRepairOneUnitOfDamage", 12.5],
  ]);
  const decoded = decodeRepairQuotes(quotes([[9001, { type: "list", items: [drone] }]]));

  assert.deepEqual(decoded, [{
    itemID: 9001,
    repairItemIDs: [7002],
    damagedParts: 1,
    parts: [quoted(7002, { typeID: 2454, damage: 108.65, maxHealth: 1000, cost: 109 * 12.5 })],
    cost: 109 * 12.5,
  }]);
  assert.equal(repairQuoteTotal(decoded), 1362.5);
});

test("a hull quoted clean but with a damaged drone names the DRONE, not the hull", () => {
  const drone = serverRow([["itemID", 7002], ["typeID", 2454], ["damage", 30], ["costToRepairOneUnitOfDamage", 2]]);
  const [row] = decodeRepairQuotes(quotes([[9001, { type: "list", items: [drone] }]]));

  assert.deepEqual(row!.parts.map((p) => [p.itemID, p.typeID]), [[7002, 2454]]);
});

test("a part the client would skip (ceil(damage) is 0) is not quoted", () => {
  const clean = serverRow([["itemID", 7002], ["damage", 0], ["costToRepairOneUnitOfDamage", 2]]);
  assert.deepEqual(decodeRepairQuotes(quotes([[9001, { type: "list", items: [clean] }]])), []);
});

test("a result that is not a dict is no damage, and an empty quote has no total", () => {
  assert.deepEqual(decodeRepairQuotes(null), []);
  assert.deepEqual(decodeRepairQuotes({ type: "list", items: [] }), []);
  assert.equal(repairQuoteTotal([]), null);
});
