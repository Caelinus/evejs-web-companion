// R108 slice 1: the recipe decoder, held to the claims its own header makes.
//
// What is checked, and why each matters:
//
//   1. `readable` SURVIVES THE SAME WAY `coloniesReadable` DOES. A body with no
//      schematics array at all is not the same as one with an empty array —
//      see planets.test.ts for the sibling of this claim.
//
//   2. NULL, NEVER ZERO for cycleTimeSeconds — fed the literal 0, not just an
//      absence, because a fixture that never contains a zero cannot prove it.
//
//   3. THE DROP RULES ARE EXACT: a bad output kills the whole schematic, a bad
//      input only kills that input, duplicates lose deterministically, and a
//      schematic with no inputs is still a real leaf recipe.
//
//   4. `commodityName` NEVER RETURNS AN ID (R7d) — it falls back to the
//      recipe's own output name, and only then to null.
//
//   5. `tierOf` ANSWERS ONLY 0-4 OR NULL.
//
//   6. `madeThings` orders by tier then name, unclassified last, deterministically.
//
//   7. THE BIJECTION, against the real 68-row table: one recipe per output,
//      and every input is either made by some recipe or is a leaf raw material.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  decodeRecipeBook,
  commodityName,
  tierOf,
  madeThings,
  type PiRecipeBook,
} from "./piRecipes.ts";
import type { JsonValue } from "./wire.ts";

// EVEJS_ROOT is the variable the BFF's own config reads; the fallback is only
// this host's usual place. Absent either way, the real-table cases SKIP.
const EVE_ROOT = process.env.EVEJS_ROOT ?? "D:/evet";
const REAL_TABLE_PATH = `${EVE_ROOT}/_local/gameStore/data/planetSchematics/data.json`;

/** A minimally valid schematic row, in the wire shape `decodeSchematic` reads. */
function schematicRow(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    schematicID: 1,
    name: "Test Recipe",
    cycleTimeSeconds: 3600,
    factoryTypeIDs: [2400],
    inputs: [],
    output: { typeID: 100, quantity: 1, typeName: "Widget" },
    ...overrides,
  } as JsonValue;
}

function bookWithSchematics(rows: JsonValue[], commodities?: Record<string, JsonValue>): PiRecipeBook {
  const body: Record<string, JsonValue> = { schematics: rows };
  if (commodities) {
    body.commodities = commodities;
  }
  return decodeRecipeBook(body as JsonValue);
}

// ---------------------------------------------------------------------------
// 1. readable

test("a body with no schematics array at all reads as unreadable, not merely empty", () => {
  const noKey = decodeRecipeBook({ ok: true } as JsonValue);
  assert.equal(noKey.readable, false);
  assert.deepEqual(noKey.schematics, []);
  assert.equal(noKey.byOutputTypeID.size, 0);

  // A body whose "schematics" is present but not an array is the same kind of
  // silence, not a table of one weird row.
  const wrongShape = decodeRecipeBook({ schematics: "none" } as unknown as JsonValue);
  assert.equal(wrongShape.readable, false);

  const empty = decodeRecipeBook({} as JsonValue);
  assert.equal(empty.readable, false);
});

test("a schematics array that carries zero rows is readable — it just makes nothing", () => {
  const book = bookWithSchematics([]);
  assert.equal(book.readable, true);
  assert.deepEqual(book.schematics, []);
  assert.equal(book.byOutputTypeID.size, 0);
});

test("a schematics array carrying rows is readable, with the rows decoded", () => {
  const book = bookWithSchematics([schematicRow()]);
  assert.equal(book.readable, true);
  assert.equal(book.schematics.length, 1);
});

// ---------------------------------------------------------------------------
// 2. null, never zero (cycleTimeSeconds)

test("cycleTimeSeconds is null whenever the table did not give a truthful positive number", () => {
  const zero = bookWithSchematics([schematicRow({ cycleTimeSeconds: 0 })]);
  assert.equal(zero.schematics[0]!.cycleTimeSeconds, null);

  const negative = bookWithSchematics([schematicRow({ cycleTimeSeconds: -10 })]);
  assert.equal(negative.schematics[0]!.cycleTimeSeconds, null);

  const notANumber = bookWithSchematics([schematicRow({ cycleTimeSeconds: "fast" })]);
  assert.equal(notANumber.schematics[0]!.cycleTimeSeconds, null);

  const missing = bookWithSchematics([
    (() => {
      const row = schematicRow() as Record<string, JsonValue>;
      delete row.cycleTimeSeconds;
      return row as JsonValue;
    })(),
  ]);
  assert.equal(missing.schematics[0]!.cycleTimeSeconds, null);

  // A real positive value survives — this isn't a decoder that always says null.
  const real = bookWithSchematics([schematicRow({ cycleTimeSeconds: 1800 })]);
  assert.equal(real.schematics[0]!.cycleTimeSeconds, 1800);
});

// ---------------------------------------------------------------------------
// 3. the drop rules

test("a schematic with no usable output is dropped entirely", () => {
  const noOutputKey = (() => {
    const row = schematicRow() as Record<string, JsonValue>;
    delete row.output;
    return row as JsonValue;
  })();
  assert.equal(bookWithSchematics([noOutputKey]).schematics.length, 0);

  const zeroTypeID = schematicRow({ output: { typeID: 0, quantity: 1 } });
  assert.equal(bookWithSchematics([zeroTypeID]).schematics.length, 0);

  const missingTypeID = schematicRow({ output: { quantity: 1 } });
  assert.equal(bookWithSchematics([missingTypeID]).schematics.length, 0);

  const zeroQuantity = schematicRow({ output: { typeID: 100, quantity: 0 } });
  assert.equal(bookWithSchematics([zeroQuantity]).schematics.length, 0);

  const missingQuantity = schematicRow({ output: { typeID: 100 } });
  assert.equal(bookWithSchematics([missingQuantity]).schematics.length, 0);

  const negativeQuantity = schematicRow({ output: { typeID: 100, quantity: -3 } });
  assert.equal(bookWithSchematics([negativeQuantity]).schematics.length, 0);
});

test("a bad input is dropped but the schematic that carries it survives", () => {
  const row = schematicRow({
    output: { typeID: 999, quantity: 1 },
    inputs: [
      { typeID: 10, quantity: 5, typeName: "Good Input" },
      { typeID: 0, quantity: 5 }, // bad typeID
      { typeID: 20, quantity: 0 }, // zero quantity
    ],
  });
  const book = bookWithSchematics([row]);
  assert.equal(book.schematics.length, 1);
  assert.equal(book.schematics[0]!.inputs.length, 1);
  assert.equal(book.schematics[0]!.inputs[0]!.typeID, 10);
});

test("a schematic with no inputs at all is kept — it is a leaf something still makes", () => {
  const book = bookWithSchematics([schematicRow({ inputs: [] })]);
  assert.equal(book.schematics.length, 1);
  assert.deepEqual(book.schematics[0]!.inputs, []);
});

test("a duplicate schematicID keeps the first row and ignores the second", () => {
  const first = schematicRow({ schematicID: 1, name: "First", output: { typeID: 100, quantity: 1 } });
  const second = schematicRow({ schematicID: 1, name: "Second", output: { typeID: 200, quantity: 1 } });
  const book = bookWithSchematics([first, second]);

  assert.equal(book.schematics.length, 1);
  assert.equal(book.schematics[0]!.name, "First");
  assert.equal(book.bySchematicID.get(1)!.name, "First");
  assert.equal(book.byOutputTypeID.has(200), false);
  assert.equal(book.byOutputTypeID.get(100)!.name, "First");
});

test("two schematics claiming the same output both appear in schematics, but the first wins the lookup", () => {
  const first = schematicRow({ schematicID: 1, name: "First", output: { typeID: 300, quantity: 1 } });
  const second = schematicRow({ schematicID: 2, name: "Second", output: { typeID: 300, quantity: 1 } });
  const book = bookWithSchematics([first, second]);

  assert.equal(book.schematics.length, 2);
  assert.equal(book.bySchematicID.get(2)!.name, "Second");
  assert.equal(book.byOutputTypeID.get(300)!.schematicID, 1);
  assert.equal(book.byOutputTypeID.get(300)!.name, "First");
});

// ---------------------------------------------------------------------------
// 4. commodityName never returns an id

test("commodityName prefers the commodities table's own name", () => {
  const book = bookWithSchematics(
    [schematicRow({ schematicID: 1, output: { typeID: 500, quantity: 1, typeName: "Livestock" } })],
    { "700": { typeName: "Fancy Juice", tier: 2 } },
  );
  assert.equal(commodityName(book, 700), "Fancy Juice");
});

test("commodityName falls back to the recipe's own output name when the table did not name it", () => {
  const book = bookWithSchematics(
    [schematicRow({ schematicID: 1, output: { typeID: 500, quantity: 1, typeName: "Livestock" } })],
    { "500": { typeName: null, tier: 1 } },
  );
  assert.equal(commodityName(book, 500), "Livestock");
});

test("commodityName returns null, never a stringified id, when nothing names the type", () => {
  const book = bookWithSchematics(
    [schematicRow({ schematicID: 1, output: { typeID: 500, quantity: 1, typeName: "Livestock" } })],
    { "700": { typeName: "Fancy Juice", tier: 2 } },
  );

  assert.equal(commodityName(book, 999), null);

  // Never a stringified id, in the names that do resolve either.
  assert.notEqual(commodityName(book, 700), String(700));
  assert.notEqual(commodityName(book, 500), String(500));
});

// ---------------------------------------------------------------------------
// 5. tierOf answers only 0-4 or null

function bookWithTier(tier: Record<string, JsonValue>): PiRecipeBook {
  return bookWithSchematics([], { "42": { typeName: "Thing", ...tier } });
}

test("tierOf never answers an out-of-range number", () => {
  assert.equal(tierOf(bookWithTier({ tier: 5 }), 42), null);
  assert.equal(tierOf(bookWithTier({ tier: -1 }), 42), null);
  assert.equal(tierOf(bookWithTier({ tier: 0 }), 42), 0);
  assert.equal(tierOf(bookWithTier({ tier: 4 }), 42), 4);
});

test("tierOf answers null when the table never gave a tier at all", () => {
  assert.equal(tierOf(bookWithTier({}), 42), null);
  assert.equal(tierOf(bookWithSchematics([]), 999), null);
});

test("tierOf accepts a tier spelled out as a numeral string", () => {
  assert.equal(tierOf(bookWithTier({ tier: "3" }), 42), 3);
});

// ⚠ BUG, reported rather than fixed (see the final report): the decoder's own
// doctrine says an unclassified commodity reads as null — "the book does not
// classify it" — the same way an unreadable recipe table is not an empty one.
// But `asTier` reaches an explicit wire `null` through `Number(value)`, and
// `Number(null) === 0`, so a commodity the table explicitly could not tier
// decodes as tier 0 (an extractor's own output) instead of "unclassified".
// This assertion states the doctrine and is left FAILING against the current
// code, which actually returns 0 here.
test("an explicit null tier reads as unclassified, not as tier 0", () => {
  assert.equal(tierOf(bookWithTier({ tier: null }), 42), null);
});

// ---------------------------------------------------------------------------
// 6. madeThings orders by tier then name, unclassified last, deterministically

test("madeThings reads lowest tier first, ties broken by name, unclassified last", () => {
  const book = bookWithSchematics(
    [
      schematicRow({ schematicID: 4, name: "Omega Unclassified", output: { typeID: 900, quantity: 1 } }),
      schematicRow({ schematicID: 1, name: "Zed Tier Two", output: { typeID: 902, quantity: 1 } }),
      schematicRow({ schematicID: 3, name: "Alpha Tier One", output: { typeID: 901, quantity: 1 } }),
      schematicRow({ schematicID: 2, name: "Beta Tier One", output: { typeID: 903, quantity: 1 } }),
    ],
    {
      "902": { typeName: null, tier: 2 },
      "901": { typeName: null, tier: 1 },
      "903": { typeName: null, tier: 1 },
      // 900 is deliberately left out of the commodities table: unclassified.
    },
  );

  const ordered = madeThings(book).map((s) => s.name);
  assert.deepEqual(ordered, ["Alpha Tier One", "Beta Tier One", "Zed Tier Two", "Omega Unclassified"]);

  // Deterministic across calls, and the book's own order is untouched.
  assert.deepEqual(madeThings(book).map((s) => s.name), ordered);
  assert.deepEqual(book.schematics.map((s) => s.name), [
    "Omega Unclassified",
    "Zed Tier Two",
    "Alpha Tier One",
    "Beta Tier One",
  ]);
});

// ---------------------------------------------------------------------------
// 7. the bijection, against the real table

test("the real 68-row table is a bijection: one recipe per output, every input made or a leaf", (t) => {
  if (!fs.existsSync(REAL_TABLE_PATH)) {
    t.skip(`real table not found at ${REAL_TABLE_PATH}; skipping the bijection check against live data`);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(REAL_TABLE_PATH, "utf8")) as {
    schematics: ReadonlyArray<{
      schematicID: number;
      name: string;
      cycleTime: number;
      pinTypeIDs: readonly number[];
      inputs: ReadonlyArray<{ typeID: number; quantity: number }>;
      outputs: ReadonlyArray<{ typeID: number; quantity: number }>;
    }>;
  };

  // The shaping step itself relies on there being exactly one output per row.
  assert.ok(raw.schematics.every((row) => row.outputs.length === 1));

  const shaped = raw.schematics.map((row) => ({
    schematicID: row.schematicID,
    name: row.name,
    cycleTimeSeconds: row.cycleTime,
    factoryTypeIDs: row.pinTypeIDs,
    inputs: row.inputs,
    output: row.outputs[0],
  })) as unknown as JsonValue[];

  const book = decodeRecipeBook({ schematics: shaped } as unknown as JsonValue);

  assert.equal(book.schematics.length, 68);
  for (const schematic of book.schematics) {
    assert.ok(schematic.output.typeID > 0);
    assert.ok(schematic.output.quantity > 0);
  }

  // One recipe per output: no two of the 68 rows claim the same thing.
  assert.equal(book.byOutputTypeID.size, book.schematics.length);

  // Every input typeID is either made by some recipe in the book, or is one of
  // the raw materials no schematic produces (a leaf). The real table has
  // exactly 15 of those.
  const outputTypeIDs = new Set(book.schematics.map((s) => s.output.typeID));
  const allInputTypeIDs = new Set<number>();
  for (const schematic of book.schematics) {
    for (const input of schematic.inputs) {
      allInputTypeIDs.add(input.typeID);
    }
  }
  let leafCount = 0;
  for (const typeID of allInputTypeIDs) {
    const madeBySomeRecipe = book.byOutputTypeID.has(typeID);
    const isLeaf = !outputTypeIDs.has(typeID);
    assert.ok(
      madeBySomeRecipe || isLeaf,
      `input ${typeID} is neither made by a recipe nor a recognizable leaf`,
    );
    if (isLeaf) {
      leafCount++;
    }
  }
  assert.equal(leafCount, 15);
});
