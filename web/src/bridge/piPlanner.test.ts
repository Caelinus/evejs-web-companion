// The planner's proof (R108 slice 5): held stock is taken off before inputs are
// worked out, and every shortfall is named as one of the four gaps, in order.
//
// Most cases run on a hand-built book so every number is known in advance; the
// real-table case at the end checks the netting against the emulator's own
// recipes and SKIPS when that table is not on this machine.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { decodeRecipeBook, type PiCommodity, type PiRecipeBook, type PiSchematic, type PiTier } from "./piRecipes.ts";
import type { JsonValue } from "./wire.ts";
import type { Colony, ColonyPin } from "../store/types.ts";
import type { Holding } from "./piStock.ts";
import { parseWithin, planWithStock, type PlannerColony, type PlannerInput } from "./piPlanner.ts";

// --- a small book with known numbers ---------------------------------------

const RAW_A = 100;
const RAW_B = 101;
const P1_A = 200;
const P1_B = 201;
const P2_C = 300;
const P2_X = 301;
const P3_Y = 400;
const BASIC_FACTORY = 2473;
const ADVANCED_FACTORY = 2474;
const HOUR = 3_600_000;

function recipe(
  schematicID: number,
  name: string,
  inputs: readonly [number, number][],
  output: [number, number],
  factoryTypeID: number,
  cycleTimeSeconds: number,
): PiSchematic {
  return {
    schematicID,
    name,
    cycleTimeSeconds,
    factoryTypeIDs: [factoryTypeID],
    inputs: inputs.map(([typeID, quantity]) => ({ typeID, typeName: null, quantity })),
    output: { typeID: output[0], typeName: name, quantity: output[1] },
  };
}

const SCHEMATICS = [
  recipe(1, "Alpha", [[RAW_A, 3000]], [P1_A, 20], BASIC_FACTORY, 1800),
  recipe(2, "Beta", [[RAW_B, 3000]], [P1_B, 20], BASIC_FACTORY, 1800),
  recipe(3, "Gamma", [[P1_A, 40], [P1_B, 40]], [P2_C, 5], ADVANCED_FACTORY, 3600),
  recipe(4, "Xi", [[P1_A, 40], [P1_B, 40]], [P2_X, 5], ADVANCED_FACTORY, 3600),
  recipe(5, "Upsilon", [[P2_C, 10], [P2_X, 10]], [P3_Y, 3], ADVANCED_FACTORY, 3600),
] as const;
const [, , GAMMA_RECIPE, XI_RECIPE] = SCHEMATICS;

const TIERS: readonly [number, string, PiTier][] = [
  [RAW_A, "Raw A", 0],
  [RAW_B, "Raw B", 0],
  [P1_A, "Alpha", 1],
  [P1_B, "Beta", 1],
  [P2_C, "Gamma", 2],
  [P2_X, "Xi", 2],
  [P3_Y, "Upsilon", 3],
];

const BOOK: PiRecipeBook = {
  schematics: SCHEMATICS,
  bySchematicID: new Map(SCHEMATICS.map((row) => [row.schematicID, row])),
  byOutputTypeID: new Map(SCHEMATICS.map((row) => [row.output.typeID, row])),
  commodities: new Map<number, PiCommodity>(TIERS.map(([typeID, typeName, tier]) => [typeID, { typeID, typeName, tier }])),
  readable: true,
};

function pin(pinID: number, fields: Partial<ColonyPin>): ColonyPin {
  return {
    pinID,
    typeID: 0,
    typeName: "",
    kind: "other",
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
    ...fields,
  };
}

function colony(planetID: number, planetName: string, pins: readonly ColonyPin[], resources: Colony["resources"] = null): PlannerColony {
  return {
    clockOffsetMs: 0,
    colony: {
      planetID,
      planetName,
      solarSystemID: 30000001,
      solarSystemName: "Alpha",
      planetTypeID: 2016,
      planetTypeName: "Planet (Lava)",
      commandCenterLevel: 4,
      lastSimulatedAtMs: null,
      pins,
      linkCount: 0,
      links: [],
      routes: [],
      resources,
    },
  };
}

function factory(pinID: number, typeID: number, schematic: PiSchematic | null): ColonyPin {
  return pin(pinID, {
    typeID,
    kind: "factory",
    schematicID: schematic?.schematicID ?? null,
    schematicName: schematic?.name ?? null,
  });
}

function extractor(pinID: number, resourceTypeID: number, quantityPerCycle: number, expiresAtMs: number | null): ColonyPin {
  return pin(pinID, {
    kind: "extractor-control",
    program: {
      resourceTypeID,
      resourceTypeName: null,
      cycleTimeSeconds: 1800,
      quantityPerCycle,
      installedAtMs: null,
      expiresAtMs,
      headCount: 4,
    },
  });
}

function held(typeID: number, quantity: number, source: Holding["source"] = "hangar", placeWords = "Station hangar"): Holding {
  return {
    typeID,
    typeName: null,
    quantity,
    source,
    placeWords,
    ownerWords: "Pilot One",
    planetID: null,
    readAtMs: null,
    clockOffsetMs: 0,
  };
}

const NOW = 1_800_000_000_000;

function plan(overrides: Partial<PlannerInput>) {
  const result = planWithStock({
    book: BOOK,
    targetTypeID: P2_C,
    quantity: 10,
    holdings: [],
    colonies: [],
    withinMs: null,
    browserNowMs: NOW,
    ...overrides,
  });
  assert.ok(result);
  return result;
}

const rowOf = (result: ReturnType<typeof plan>, typeID: number) => result.rows.find((row) => row.typeID === typeID);

// --- netting -----------------------------------------------------------------

test("held stock is taken off BEFORE inputs are worked out", () => {
  // 10 Gamma, 5 held: one run of 5 is left, so 40 of each input — not 80.
  const result = plan({ holdings: [held(P2_C, 5)] });
  const target = rowOf(result, P2_C)!;
  assert.equal(target.needed, 10);
  assert.equal(target.held, 5);
  assert.equal(target.toMake, 5);
  assert.equal(target.runs, 1);
  assert.equal(rowOf(result, P1_A)!.needed, 40);
  assert.equal(rowOf(result, P1_B)!.needed, 40);
});

test("an input held in full stops the walk there: nothing below it is asked for", () => {
  const result = plan({ holdings: [held(P1_A, 100)] });
  const alpha = rowOf(result, P1_A)!;
  assert.equal(alpha.toMake, 0);
  assert.equal(alpha.runs, null);
  assert.equal(alpha.sourceWords, "held");
  assert.equal(rowOf(result, RAW_A), undefined, "no raw A is needed once Alpha is held");
  assert.ok(rowOf(result, RAW_B), "the other branch still expands");
});

test("held means everywhere: colony, hangar and corp hangar all count, and each keeps its place", () => {
  const result = plan({
    holdings: [
      held(P1_A, 10, "colony", "Alpha III launchpad"),
      held(P1_A, 15, "hangar", "Station hangar"),
      held(P1_A, 20, "corp", "Station office, division 3"),
    ],
  });
  const alpha = rowOf(result, P1_A)!;
  // 10 Gamma is 2 runs, so 80 Alpha: the 45 held everywhere leave 35.
  assert.equal(alpha.needed, 80);
  assert.equal(alpha.held, 45);
  assert.equal(alpha.toMake, 35);
  assert.deepEqual(alpha.holdings.map((holding) => holding.source), ["colony", "hangar", "corp"]);
});

test("what sits in a factory's input buffer is not counted: it is already committed", () => {
  const result = plan({
    holdings: [{ ...held(P1_A, 1000, "colony", "Alpha III factory input"), inFactory: true }, held(P1_A, 30)],
  });
  const alpha = rowOf(result, P1_A)!;
  assert.equal(alpha.held, 30);
  assert.equal(alpha.toMake, 50);
});

test("a commodity two branches share is one row, netted and rounded once", () => {
  // Upsilon needs Gamma and Xi, and both need Alpha: one Alpha row, whole need.
  const result = plan({ targetTypeID: P3_Y, quantity: 3 });
  const alphas = result.rows.filter((row) => row.typeID === P1_A);
  assert.equal(alphas.length, 1);
  // 1 run of Upsilon -> 10 Gamma (2 runs) + 10 Xi (2 runs) -> 80 + 80 Alpha.
  assert.equal(alphas[0]!.needed, 160);
  assert.equal(alphas[0]!.runs, 8);
  assert.deepEqual(result.rows.map((row) => row.depth), [...result.rows.map((row) => row.depth)].sort((a, b) => a - b));
  assert.equal(result.rows[0]!.typeID, P3_Y, "the target comes first");
});

// --- gaps ------------------------------------------------------------------

test("with no factory anywhere, the gap is 'nothing you own makes this'", () => {
  const result = plan({});
  const gamma = result.gaps.find((gap) => gap.typeID === P2_C)!;
  assert.equal(gamma.kind, "nothing-makes");
  assert.equal(gamma.headline, "Nothing you own makes Gamma.");
  assert.equal(result.covered, false);
});

test("a factory that could run the recipe but makes something else is named, with what it makes now", () => {
  const xi = XI_RECIPE;
  const result = plan({ colonies: [colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, xi)])] });
  const gamma = result.gaps.find((gap) => gap.typeID === P2_C)!;
  assert.equal(gamma.kind, "factory-busy");
  assert.equal(gamma.headline, "Alpha III could make Gamma.");
  assert.equal(gamma.detail, "Its factory makes Xi now.");
});

test("a factory making it gives the rate, labelled 'up to', and no gap without a deadline", () => {
  const gammaRecipe = GAMMA_RECIPE;
  const result = plan({
    colonies: [colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, gammaRecipe), factory(11, ADVANCED_FACTORY, gammaRecipe)])],
    holdings: [held(P1_A, 1000), held(P1_B, 1000)],
  });
  const target = rowOf(result, P2_C)!;
  // Two factories, 5 a run, one run an hour each.
  assert.equal(target.sourceWords, "Alpha III (2), up to 10 an hour");
  assert.equal(target.coverWords, "1 hour at that rate");
  assert.equal(result.gaps.length, 0);
  assert.equal(result.covered, true);
  assert.match(result.verdict, /Nothing needs to change\.$/);
});

test("'too slow' is a gap only against a deadline, and says the rate and the shortfall", () => {
  const gammaRecipe = GAMMA_RECIPE;
  const colonies = [colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, gammaRecipe)])];
  const holdings = [held(P1_A, 1000), held(P1_B, 1000)];
  assert.equal(plan({ colonies, holdings, quantity: 50 }).gaps.length, 0);
  const late = plan({ colonies, holdings, quantity: 50, withinMs: 2 * HOUR });
  assert.equal(late.gaps.length, 1);
  assert.equal(late.gaps[0]!.kind, "too-slow");
  assert.equal(late.gaps[0]!.headline, "Gamma is made at 5 an hour.");
  assert.equal(late.gaps[0]!.detail, "The 50 still to make take 10 hours, longer than the 2 hours you gave.");
  assert.equal(late.verdict, "You can't make 50 Gamma within 2 hours. 1 thing is missing.");
});

test("a raw resource extracted nowhere names the colonised planets that carry it, richest first", () => {
  const colonies = [
    colony(1, "Alpha III", [], [{ typeID: RAW_B, typeName: "Raw B", quality: 96 }]),
    colony(2, "Alpha V", [], [{ typeID: RAW_B, typeName: "Raw B", quality: 140 }]),
  ];
  const result = plan({ colonies, holdings: [held(P1_A, 1000)] });
  const raw = result.gaps.find((gap) => gap.typeID === RAW_B)!;
  assert.equal(raw.kind, "not-extracted");
  assert.equal(raw.headline, "Nothing you own extracts Raw B.");
  assert.equal(raw.detail, "Alpha V (Lava) at quality 140 and Alpha III (Lava) at quality 96 carry it.");
});

test("an extractor whose program has ended is not a producer, and the gap says it ended", () => {
  const colonies = [colony(1, "Alpha III", [extractor(20, RAW_B, 6000, NOW - HOUR)])];
  const result = plan({ colonies, holdings: [held(P1_A, 1000)] });
  const raw = result.gaps.find((gap) => gap.typeID === RAW_B)!;
  assert.equal(raw.headline, "Raw B is extracted nowhere right now.");
  assert.equal(raw.detail, "Its program on Alpha III has ended. None of your colonised planets carries it.");
});

test("a running extractor's rate is the server's, for the installed program", () => {
  const colonies = [colony(1, "Alpha III", [extractor(20, RAW_B, 6000, NOW + HOUR)])];
  const result = plan({ colonies, holdings: [held(P1_A, 1000)] });
  assert.equal(rowOf(result, RAW_B)!.sourceWords, "Alpha III, 12,000 an hour on the installed program");
});

test("gaps come in the order worth telling: makes-nothing, busy factory, too slow, not extracted", () => {
  // Upsilon: no factory runs it (nothing-makes); Xi's advanced factory could
  // make Gamma (busy); Raw B is carried but not extracted.
  const xi = XI_RECIPE;
  const colonies = [
    colony(1, "Alpha III", [factory(10, ADVANCED_FACTORY, xi)], [{ typeID: RAW_B, typeName: null, quality: 50 }]),
  ];
  const result = plan({ targetTypeID: P3_Y, quantity: 3, colonies, holdings: [held(P1_A, 1000)] });
  const kinds = result.gaps.map((gap) => gap.kind);
  assert.deepEqual(kinds, [...kinds].sort((left, right) =>
    ["nothing-makes", "factory-busy", "too-slow", "not-extracted"].indexOf(left)
      - ["nothing-makes", "factory-busy", "too-slow", "not-extracted"].indexOf(right)));
  assert.equal(kinds[0], "nothing-makes");
  assert.equal(kinds.at(-1), "not-extracted");
  // Every gap is numbered on its row.
  const numbered = result.rows.filter((row) => row.gapNumber !== null).map((row) => row.gapNumber).sort();
  assert.deepEqual(numbered, result.gaps.map((_, index) => index + 1));
});

test("holding the target outright is the fifth kind: nothing needs to change", () => {
  const result = plan({ holdings: [held(P2_C, 12)] });
  assert.equal(result.verdict, "You hold 12 Gamma already. Nothing needs to change.");
  assert.equal(result.covered, true);
  assert.equal(result.rows.length, 1);
});

test("a nonsensical request is null, as resolveChain's is", () => {
  assert.equal(planWithStock({ book: BOOK, targetTypeID: P2_C, quantity: 0, holdings: [], colonies: [], withinMs: null, browserNowMs: NOW }), null);
});

// --- the deadline field ------------------------------------------------------

test("a deadline reads days, hours and minutes, or a bare number of hours", () => {
  assert.equal(parseWithin(""), null);
  assert.equal(parseWithin("3d"), 3 * 24 * HOUR);
  assert.equal(parseWithin("2d 6h"), 54 * HOUR);
  assert.equal(parseWithin("36"), 36 * HOUR);
  assert.equal(parseWithin("90m"), 1.5 * HOUR);
  assert.ok(Number.isNaN(parseWithin("soon")));
  assert.ok(Number.isNaN(parseWithin("3d later")));
});

// --- the real table ---------------------------------------------------------

const EVE_ROOT = process.env.EVEJS_ROOT ?? "D:/evet";
const REAL_DATA_PATH = `${EVE_ROOT}/_local/gameStore/data/planetSchematics/data.json`;

function loadRealBook(): PiRecipeBook | null {
  if (!existsSync(REAL_DATA_PATH)) return null;
  const parsed = JSON.parse(readFileSync(REAL_DATA_PATH, "utf8")) as {
    schematics: readonly {
      schematicID: number;
      name: string;
      cycleTime: number;
      pinTypeIDs: readonly number[];
      inputs: readonly { typeID: number; quantity: number }[];
      outputs: readonly { typeID: number; quantity: number }[];
    }[];
  };
  return decodeRecipeBook({
    schematics: parsed.schematics.map((row) => ({
      schematicID: row.schematicID,
      name: row.name,
      cycleTimeSeconds: row.cycleTime,
      factoryTypeIDs: row.pinTypeIDs,
      inputs: row.inputs,
      output: row.outputs[0] ?? null,
    })),
  } as unknown as JsonValue);
}

test("real table: Robotics nets held stock before expanding, and names every missing raw resource", (t) => {
  const book = loadRealBook();
  if (book === null) {
    t.skip(`real recipe table not found at ${REAL_DATA_PATH}`);
    return;
  }
  const robotics = book.schematics.find((row) => row.name === "Robotics")!;
  const firstInput = robotics.inputs[0]!;
  const secondInput = robotics.inputs[1]!;
  // 6 Robotics = 2 runs = 20 of each input. Hold 12 of the first: 8 are left.
  const result = planWithStock({
    book,
    targetTypeID: robotics.output.typeID,
    quantity: 6,
    holdings: [held(firstInput.typeID, 12)],
    colonies: [],
    withinMs: null,
    browserNowMs: NOW,
  })!;
  const first = result.rows.find((row) => row.typeID === firstInput.typeID)!;
  const second = result.rows.find((row) => row.typeID === secondInput.typeID)!;
  assert.equal(first.needed, 20);
  assert.equal(first.toMake, 8);
  assert.equal(second.toMake, 20);
  // The first input's own recipe is taken for 8, not 20.
  const firstRecipe = book.byOutputTypeID.get(firstInput.typeID)!;
  assert.equal(first.runs, Math.ceil(8 / firstRecipe.output.quantity));
  // With no colonies at all, every leaf is a raw resource extracted nowhere.
  const leaves = result.rows.filter((row) => row.madeBy === null);
  assert.ok(leaves.length > 0);
  for (const leaf of leaves) {
    assert.equal(result.gaps.find((gap) => gap.typeID === leaf.typeID)?.kind, "not-extracted");
  }
});
