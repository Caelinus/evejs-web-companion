// The words a colony panel prints for one factory's recipe (goal R108 slice 2).
//
// What is checked, and why each matters:
//
//   1. DEGRADE, NOT BREAK. The recipe book arrives on a separate read from the
//      colony, and may never arrive at all on a server whose schematic table is
//      missing. `making` must keep reading from the colony read's own
//      `pin.schematicName` — the line the panel has always rendered — whether
//      or not the book has anything to say about it.
//   2. NEVER AN ID (R7d). An ingredient the book could not name must be
//      counted, never printed as a typeID and never silently dropped.
//   3. NULL, NEVER A GUESS. A missing cycle time yields `rate: null`, never a
//      manufactured "every 0 seconds".
//   4. SECONDS IN, MILLISECONDS OUT. `cycleTimeSeconds` is seconds;
//      `formatDuration` wants milliseconds. Asserted with an exact string so a
//      unit slip (this codebase has shipped one before) is caught, not merely
//      "some duration came out".
//
// The first case is driven off the real schematic table
// (D:/evet/_local/gameStore/data/planetSchematics/data.json) via the same
// wire-shaping piChain.test.ts uses, skipping cleanly when that file is
// absent. Every other case is a hand-built book: full control over shape,
// used for behaviour the real table's own strict, always-named-by-nothing
// data cannot exercise (the raw table carries no names at all, not even for
// its own outputs — see the loader below).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { decodeRecipeBook } from "./piRecipes.ts";
import type { PiIngredient, PiRecipeBook, PiSchematic } from "./piRecipes.ts";
import type { JsonValue } from "./wire.ts";
import type { ColonyPin } from "../store/types.ts";
import { factoryRecipeWords } from "./piFactoryWords.ts";

// ---------------------------------------------------------------------------
// The real recipe table, decoded through the same wire shape the BFF sends.
// See piChain.test.ts for why this path and this reshape.

const EVE_ROOT = process.env.EVEJS_ROOT ?? "D:/evet";
const REAL_DATA_PATH = `${EVE_ROOT}/_local/gameStore/data/planetSchematics/data.json`;

interface RealSchematicRow {
  readonly schematicID: number;
  readonly name: string;
  readonly cycleTime: number;
  readonly pinTypeIDs: readonly number[];
  readonly inputs: readonly { typeID: number; quantity: number }[];
  readonly outputs: readonly { typeID: number; quantity: number }[];
}

// The static table names NOTHING, not even its own outputs (confirmed by
// inspecting the raw file). Superconductors' two inputs are given their real,
// public EVE item names here purely so this test can prove the "needs" phrase
// actually NAMES things, rather than only proving it can count them — the
// counting path is exercised separately, below, on hand-built books.
const KNOWN_INPUT_NAMES: Readonly<Record<number, string>> = Object.freeze({
  2389: "Plasmoids",
  3645: "Water",
});

function loadRealBook(): PiRecipeBook | null {
  if (!existsSync(REAL_DATA_PATH)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(REAL_DATA_PATH, "utf8")) as {
    schematics: readonly RealSchematicRow[];
  };
  const wire = {
    schematics: parsed.schematics.map((row) => ({
      schematicID: row.schematicID,
      name: row.name,
      cycleTimeSeconds: row.cycleTime,
      factoryTypeIDs: row.pinTypeIDs,
      inputs: row.inputs.map((input) => ({
        ...input,
        typeName: KNOWN_INPUT_NAMES[input.typeID] ?? null,
      })),
      output: row.outputs[0] ?? null,
    })),
  };
  return decodeRecipeBook(wire as unknown as JsonValue);
}

const REAL = loadRealBook();

function skipIfNoRealData(t: { skip: (msg?: string) => void }): boolean {
  if (REAL === null) {
    t.skip(`real recipe table not found at ${REAL_DATA_PATH} — skipping the real-data case`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Hand-made books and pins: full control over shape.

function ingredient(typeID: number, quantity: number, typeName: string | null = null): PiIngredient {
  return { typeID, typeName, quantity };
}

function schematic(
  overrides: Partial<PiSchematic> & Pick<PiSchematic, "schematicID" | "output">,
): PiSchematic {
  return {
    name: `Schematic ${overrides.schematicID}`,
    cycleTimeSeconds: 3600,
    factoryTypeIDs: [],
    inputs: [],
    ...overrides,
  };
}

function makeBook(schematics: readonly PiSchematic[]): PiRecipeBook {
  const bySchematicID = new Map(schematics.map((s) => [s.schematicID, s]));
  const byOutputTypeID = new Map(schematics.map((s) => [s.output.typeID, s]));
  return {
    schematics: Object.freeze(schematics),
    bySchematicID,
    byOutputTypeID,
    commodities: new Map(),
    readable: true,
  };
}

/** A factory pin with sane defaults — override only what a case cares about. */
function pin(overrides: Partial<ColonyPin> = {}): ColonyPin {
  return {
    pinID: 1,
    typeID: 2254,
    typeName: "Advanced Industry Facility",
    kind: "factory",
    contents: [],
    usedM3: null,
    capacityM3: null,
    schematicID: null,
    schematicName: null,
    hasReceivedInputs: null,
    receivedInputsLastCycle: null,
    lastRunAtMs: null,
    lastLaunchAtMs: null,
    program: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. A real recipe from the real table: all three phrases, correctly.

test("a real recipe from the real table produces all three phrases correctly", (t) => {
  if (skipIfNoRealData(t)) {
    return;
  }
  const sch = REAL!.byOutputTypeID.get(9838); // Superconductors
  assert.ok(sch, "Superconductors (output typeID 9838) must exist in the real table");
  const words = factoryRecipeWords(
    REAL!,
    pin({ schematicID: sch!.schematicID, schematicName: sch!.name }),
  );
  assert.equal(words.making, "Making Superconductors");
  assert.equal(words.rate, "5 every 1 hour");
  assert.equal(words.needs, "needs 40 Plasmoids and 40 Water");
});

// ---------------------------------------------------------------------------
// 2. The book has no such recipe: making still names it from the pin.

test("the book has no such recipe: making still names it from the pin, rate and needs null", () => {
  const book = makeBook([]); // readable, but this schematicID is not in it
  const words = factoryRecipeWords(
    book,
    pin({ schematicID: 999, schematicName: "Superconductors" }),
  );
  assert.equal(words.making, "Making Superconductors");
  assert.equal(words.rate, null);
  assert.equal(words.needs, null);
});

// ---------------------------------------------------------------------------
// 3. The pin has no recipe at all: "No recipe set".

test('the pin has no recipe at all: "No recipe set"', () => {
  const book = makeBook([]);
  const words = factoryRecipeWords(book, pin({ schematicID: null, schematicName: null }));
  assert.equal(words.making, "No recipe set");
  assert.equal(words.rate, null);
  assert.equal(words.needs, null);
});

// ---------------------------------------------------------------------------
// 4. cycleTimeSeconds null: rate null, the other two phrases still render.

test("cycleTimeSeconds null: rate null, and the other two phrases still render", () => {
  const sch = schematic({
    schematicID: 1,
    name: "Widgetry",
    output: ingredient(100, 5),
    inputs: [ingredient(200, 10, "Chiral Structures")],
    cycleTimeSeconds: null,
  });
  const book = makeBook([sch]);
  const words = factoryRecipeWords(book, pin({ schematicID: 1, schematicName: "Widgetry" }));
  assert.equal(words.making, "Making Widgetry");
  assert.equal(words.rate, null);
  assert.equal(words.needs, "needs 10 Chiral Structures");
});

// ---------------------------------------------------------------------------
// 5. One unnamed ingredient among named ones: counted, not named, not dropped.

test("one unnamed ingredient among named ones: counted, not named, and not dropped", () => {
  const sch = schematic({
    schematicID: 2,
    name: "Mystery Widget",
    output: ingredient(101, 5),
    inputs: [
      ingredient(201, 10, "Chiral Structures"),
      ingredient(202, 3, null),
    ],
  });
  const book = makeBook([sch]);
  const words = factoryRecipeWords(book, pin({ schematicID: 2, schematicName: "Mystery Widget" }));
  assert.equal(words.needs, "needs 10 Chiral Structures and one more ingredient");
  assert.doesNotMatch(words.needs!, /\b202\b/);

  // Two unnamed among named pluralizes the trailing count.
  const sch2 = schematic({
    schematicID: 21,
    name: "Mystery Widget II",
    output: ingredient(111, 5),
    inputs: [
      ingredient(211, 10, "Chiral Structures"),
      ingredient(212, 3, null),
      ingredient(213, 4, null),
    ],
  });
  const words2 = factoryRecipeWords(
    makeBook([sch2]),
    pin({ schematicID: 21, schematicName: "Mystery Widget II" }),
  );
  assert.equal(words2.needs, "needs 10 Chiral Structures and 2 more ingredients");
});

// ---------------------------------------------------------------------------
// 6. Every ingredient unnamed: a count, no ids anywhere in the output.

test("every ingredient unnamed: a count, no ids anywhere in the output", () => {
  const sch = schematic({
    schematicID: 3,
    name: "Anonymous Widget",
    output: ingredient(102, 5),
    inputs: [ingredient(301, 10, null), ingredient(302, 20, null)],
  });
  const book = makeBook([sch]);
  const words = factoryRecipeWords(book, pin({ schematicID: 3, schematicName: "Anonymous Widget" }));
  assert.equal(words.needs, "needs 2 ingredients");
  const rendered = `${words.making} ${words.rate ?? ""} ${words.needs ?? ""}`;
  for (const id of [301, 302, 102]) {
    assert.doesNotMatch(rendered, new RegExp(`\\b${id}\\b`), `must not print bare id ${id}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Ingredient lists join correctly at one, two and three ingredients.

test("one ingredient joins with no conjunction", () => {
  const sch = schematic({
    schematicID: 10,
    name: "One-Input Widget",
    output: ingredient(500, 1),
    inputs: [ingredient(600, 4, "Alpha")],
  });
  const words = factoryRecipeWords(
    makeBook([sch]),
    pin({ schematicID: 10, schematicName: "One-Input Widget" }),
  );
  assert.equal(words.needs, "needs 4 Alpha");
});

test('two ingredients join with "and"', () => {
  const sch = schematic({
    schematicID: 11,
    name: "Two-Input Widget",
    output: ingredient(501, 1),
    inputs: [ingredient(601, 4, "Alpha"), ingredient(602, 6, "Beta")],
  });
  const words = factoryRecipeWords(
    makeBook([sch]),
    pin({ schematicID: 11, schematicName: "Two-Input Widget" }),
  );
  assert.equal(words.needs, "needs 4 Alpha and 6 Beta");
});

test('three ingredients join with commas and a final "and"', () => {
  const sch = schematic({
    schematicID: 12,
    name: "Three-Input Widget",
    output: ingredient(502, 1),
    inputs: [
      ingredient(701, 1, "Alpha"),
      ingredient(702, 2, "Beta"),
      ingredient(703, 3, "Gamma"),
    ],
  });
  const words = factoryRecipeWords(
    makeBook([sch]),
    pin({ schematicID: 12, schematicName: "Three-Input Widget" }),
  );
  assert.equal(words.needs, "needs 1 Alpha, 2 Beta and 3 Gamma");
});

// ---------------------------------------------------------------------------
// 8. Seconds, not milliseconds — asserted as an exact string.

test("a 3600-second cycle reads as exactly 1 hour, not 3600 milliseconds worth", () => {
  const sch = schematic({
    schematicID: 20,
    name: "Hourly Widget",
    output: ingredient(800, 5),
    inputs: [],
    cycleTimeSeconds: 3600,
  });
  const words = factoryRecipeWords(
    makeBook([sch]),
    pin({ schematicID: 20, schematicName: "Hourly Widget" }),
  );
  // If cycleTimeSeconds (3600) were handed to formatDuration without
  // converting to milliseconds first, formatDuration would see 3600ms
  // (3.6 seconds) and say "under a minute" instead.
  assert.equal(words.rate, "5 every 1 hour");
  assert.notEqual(words.rate, "5 every under a minute");
});

// ---------------------------------------------------------------------------
// 9. No output string ever contains a schematicID or an input typeID as a
//    bare number.

test("no output string contains the schematicID or any input typeID as a bare number", () => {
  const sch = schematic({
    schematicID: 424242,
    name: "Big Numbers Widget",
    output: ingredient(313131, 7),
    inputs: [ingredient(515151, 9, null), ingredient(616161, 2, "Named Thing")],
  });
  const words = factoryRecipeWords(
    makeBook([sch]),
    pin({ schematicID: 424242, schematicName: "Big Numbers Widget" }),
  );
  const rendered = [words.making, words.rate, words.needs]
    .filter((s): s is string => s !== null)
    .join(" | ");
  for (const id of [424242, 313131, 515151, 616161]) {
    assert.doesNotMatch(rendered, new RegExp(`\\b${id}\\b`), `output must not contain bare id ${id}`);
  }
});

// ---------------------------------------------------------------------------
// 10. A non-factory pin answers honestly instead of throwing (the panel only
//     calls this for a factory, but the function must not assume it).

test("a non-factory pin with no schematic reads as No recipe set rather than throwing", () => {
  const book = makeBook([]);
  const words = factoryRecipeWords(
    book,
    pin({ kind: "storage", schematicID: null, schematicName: null }),
  );
  assert.equal(words.making, "No recipe set");
  assert.equal(words.rate, null);
  assert.equal(words.needs, null);
});
