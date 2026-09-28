// The planetary production recipes, as pure functions (goal R108 slice 1).
//
// ---------------------------------------------------------------------------
// THESE ARE FIXED FACTS, AND THAT IS WHY THEY MAY BE MULTIPLIED.
//
// A recipe is static reference data: so many of each input, one output, a fixed
// run length. Multiplying a recipe by a number of runs is arithmetic on a
// constant, not a simulation, which is what makes `piChain.ts` legitimate.
//
// ⚠ THE SAME IS NOT TRUE OF AN EXTRACTOR. Its yield decays across a program and
// is the emulator's to compute; nothing here or downstream may reconstruct it.
// `planets.ts` states the rule for the colony and it holds for the whole
// feature: NOTHING HERE SIMULATES A COLONY.
//
// ---------------------------------------------------------------------------
// ONE OUTPUT, AND ONLY ONE RECIPE MAKES IT.
//
// Every row in the table has exactly one output, and across all 68 rows the
// output types are distinct — output type to recipe is a bijection. So "what
// makes this?" is a lookup with no choice in it, and a chain has no branches to
// weigh. `piRecipes.test.ts` drives that claim from the real table rather than
// leaving it as a comment, because everything in `piChain.ts` leans on it.
//
// ---------------------------------------------------------------------------
// NULL, NEVER ZERO.
//
// A missing cycle length is `null`. Zero would read as a run that takes no time
// and would divide into a rate of infinity; the absence is the honest answer
// and forces the caller to say "we do not know" instead of printing a number.

import type { JsonValue } from "./wire.ts";

/**
 * How far up the chain a commodity sits: 0 is what an extractor pulls out of
 * the ground, 4 is the top of the tree.
 *
 * ⚠ THIS IS NOT A LABEL. The tier is the server's own classification, keyed off
 * the type's category and group — never a list of item ids picked by hand,
 * which is wrong the day the table changes.
 */
export type PiTier = 0 | 1 | 2 | 3 | 4;

/** So much of one thing: an input to a recipe, or the thing it produces. */
export interface PiIngredient {
  readonly typeID: number;
  /** Named by the BFF, as the colony read names a stored item. Never an id. */
  readonly typeName: string | null;
  /** Always > 0 — a row that asks for none of something is dropped. */
  readonly quantity: number;
}

/** One recipe: what goes in, what comes out, and how long a run takes. */
export interface PiSchematic {
  readonly schematicID: number;
  readonly name: string;
  /**
   * Seconds per run, or null when the table did not say.
   *
   * ⚠ SECONDS, AND THE NAME SAYS SO. The colony read learned this the hard way:
   * a duration carried across in the wrong unit rendered a cycle 285 years long
   * and every test agreed with it, because the fixture shared the assumption.
   * The wire field is spelled out for the same reason.
   */
  readonly cycleTimeSeconds: number | null;
  /** The factory types that can run it. For matching, not display. */
  readonly factoryTypeIDs: readonly number[];
  readonly inputs: readonly PiIngredient[];
  readonly output: PiIngredient;
}

/** A thing that can be made or extracted, and where it sits in the chain. */
export interface PiCommodity {
  readonly typeID: number;
  readonly typeName: string | null;
  readonly tier: PiTier | null;
}

/**
 * Every recipe, indexed the three ways the feature asks for them.
 *
 * Built once per read and passed around: the maps are the point, since a chain
 * walk asks "what makes this?" once per node.
 */
export interface PiRecipeBook {
  readonly schematics: readonly PiSchematic[];
  readonly bySchematicID: ReadonlyMap<number, PiSchematic>;
  /** Output type to the one recipe that makes it. See the header. */
  readonly byOutputTypeID: ReadonlyMap<number, PiSchematic>;
  readonly commodities: ReadonlyMap<number, PiCommodity>;
  /**
   * False when the read did not carry a recipe table at all.
   *
   * ⚠ NOT THE SAME AS AN EMPTY ONE, and the distinction is the one the colony
   * read already draws with `coloniesReadable`. A planner that cannot tell
   * "no recipes were sent" from "this makes nothing" will confidently tell a
   * player their target is impossible.
   */
  readonly readable: boolean;
}

const TIERS: readonly PiTier[] = Object.freeze([0, 1, 2, 3, 4]);

export const EMPTY_RECIPE_BOOK: PiRecipeBook = Object.freeze({
  schematics: Object.freeze([]) as readonly PiSchematic[],
  bySchematicID: new Map<number, PiSchematic>(),
  byOutputTypeID: new Map<number, PiSchematic>(),
  commodities: new Map<number, PiCommodity>(),
  readable: false,
});

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? (value as readonly JsonValue[]) : [];
}

/** A positive whole identifier, or null. Zero and negatives are absences. */
function asIdentifier(value: JsonValue | undefined): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/** A positive count, or null. See the header: null, never zero. */
function asCount(value: JsonValue | undefined): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function asName(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A tier, or null.
 *
 * ⚠ ZERO IS A READING HERE, WHICH IS WHY null MUST BE REJECTED FIRST.
 * Everywhere else in this file an absence can be filtered by demanding a
 * positive number, because a quantity or an id of zero is meaningless. A tier
 * of zero is not: it is the extractor's own classification, the difference
 * between "dig this out of the ground" and "we have no idea what this is".
 * `Number(null)` is `0`, so a wire `tier: null` — this codebase's own spelling
 * of "the server did not say" — would arrive looking exactly like a raw
 * resource. It is rejected before it can be coerced.
 */
function asTier(value: JsonValue | undefined): PiTier | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  return TIERS.find((tier) => tier === numeric) ?? null;
}

/**
 * One ingredient, or null when it names nothing or asks for none of it.
 *
 * Dropping it is deliberate: a chain cannot reason about an input it cannot
 * count, and carrying a zero would quietly satisfy a requirement.
 */
function decodeIngredient(value: JsonValue): PiIngredient | null {
  const row = asRecord(value);
  const typeID = asIdentifier(row.typeID);
  const quantity = asCount(row.quantity);
  if (typeID === null || quantity === null) {
    return null;
  }
  return { typeID, typeName: asName(row.typeName), quantity };
}

/**
 * One recipe, or null when it has no usable output.
 *
 * A recipe whose output cannot be identified is unusable by every caller — it
 * can neither be looked up nor multiplied — so it never enters the book.
 * A recipe with NO INPUTS is kept: it is a leaf that something still makes.
 */
function decodeSchematic(value: JsonValue): PiSchematic | null {
  const row = asRecord(value);
  const schematicID = asIdentifier(row.schematicID);
  const name = asName(row.name);
  const output = decodeIngredient(row.output ?? null);
  if (schematicID === null || name === null || output === null) {
    return null;
  }
  const inputs: PiIngredient[] = [];
  for (const raw of asArray(row.inputs)) {
    const ingredient = decodeIngredient(raw);
    if (ingredient !== null) {
      inputs.push(ingredient);
    }
  }
  const factoryTypeIDs: number[] = [];
  for (const raw of asArray(row.factoryTypeIDs)) {
    const typeID = asIdentifier(raw);
    if (typeID !== null) {
      factoryTypeIDs.push(typeID);
    }
  }
  return {
    schematicID,
    name,
    cycleTimeSeconds: asCount(row.cycleTimeSeconds),
    factoryTypeIDs: Object.freeze(factoryTypeIDs),
    inputs: Object.freeze(inputs),
    output,
  };
}

/**
 * The recipe book from `GET /api/pi/schematics`.
 *
 * ⚠ A READ THAT CARRIED NO TABLE IS NOT AN EMPTY TABLE — see `readable`.
 */
export function decodeRecipeBook(value: JsonValue): PiRecipeBook {
  const body = asRecord(value);
  const rows = body.schematics;
  if (!Array.isArray(rows)) {
    return EMPTY_RECIPE_BOOK;
  }

  const schematics: PiSchematic[] = [];
  const bySchematicID = new Map<number, PiSchematic>();
  const byOutputTypeID = new Map<number, PiSchematic>();
  for (const raw of asArray(rows)) {
    const schematic = decodeSchematic(raw);
    if (schematic === null || bySchematicID.has(schematic.schematicID)) {
      continue;
    }
    schematics.push(schematic);
    bySchematicID.set(schematic.schematicID, schematic);
    // First one wins. The real table has no collision here and a test proves
    // it; this only decides that a corrupted one stays deterministic.
    if (!byOutputTypeID.has(schematic.output.typeID)) {
      byOutputTypeID.set(schematic.output.typeID, schematic);
    }
  }

  const commodities = new Map<number, PiCommodity>();
  const commodityRows = asRecord(body.commodities);
  for (const key of Object.keys(commodityRows)) {
    const typeID = asIdentifier(Number(key));
    if (typeID === null) {
      continue;
    }
    const row = asRecord(commodityRows[key]);
    commodities.set(typeID, {
      typeID,
      typeName: asName(row.typeName),
      tier: asTier(row.tier),
    });
  }

  return {
    schematics: Object.freeze(schematics),
    bySchematicID,
    byOutputTypeID,
    commodities,
    readable: true,
  };
}

/** The one recipe that makes this, or null when nothing in the book does. */
export function recipeFor(book: PiRecipeBook, typeID: number): PiSchematic | null {
  return book.byOutputTypeID.get(typeID) ?? null;
}

/** Where this sits in the chain, or null when the book does not classify it. */
export function tierOf(book: PiRecipeBook, typeID: number): PiTier | null {
  return book.commodities.get(typeID)?.tier ?? null;
}

/**
 * This thing's name, or null.
 *
 * ⚠ NEVER FALLS BACK TO THE ID (R7d). A caller with no name renders the
 * designed fallback, exactly as `TypeIcon` does.
 */
export function commodityName(book: PiRecipeBook, typeID: number): string | null {
  const named = book.commodities.get(typeID)?.typeName ?? null;
  if (named !== null) {
    return named;
  }
  // A recipe names its own output even when the commodity table missed it.
  const recipe = book.byOutputTypeID.get(typeID);
  return recipe ? recipe.output.typeName : null;
}

/** Everything the book can make, in reading order: lowest tier first. */
export function madeThings(book: PiRecipeBook): readonly PiSchematic[] {
  return Object.freeze(
    [...book.schematics].sort((left, right) => {
      const leftTier = tierOf(book, left.output.typeID) ?? 9;
      const rightTier = tierOf(book, right.output.typeID) ?? 9;
      return leftTier !== rightTier
        ? leftTier - rightTier
        : left.name.localeCompare(right.name);
    }),
  );
}
