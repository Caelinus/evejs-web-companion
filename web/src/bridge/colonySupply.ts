// Is anything feeding this factory? (R108) — judged from how the colony is WIRED.
//
// ⚠ ONE CYCLE IS NOT A VERDICT. "Fed nothing last cycle" is the normal state of
// most factories on a colony whose extraction is the bottleneck, which is most
// colonies: four Water factories want 24,000 Aqueous Liquids an hour, two
// extractors deliver a few thousand, and on any given cycle most factories
// wait their turn. Calling each of those "needs you now" put an alarm on every
// planet of a working roster. So a factory the server says went unfed is only
// worth a word when one of its inputs has NO LIVE SOURCE:
//
//   • nothing routes it in at all — a real wiring fault, named as one;
//   • everything that routes it in leads back to nothing — dead supply.
//
// Slower than it could use is how the colony was built, and says nothing here.
// Rates are the planner's business, not the monitor's.
//
// ⚠ THE CAUSE IS SAID ONCE. When the dead supply leads back to an extractor
// that has run out or has no program, that extractor already has a finding of
// its own that names the cause and the fix. Listing its factories as well would
// turn one fault into five lines, so they are left out.
//
// NOTHING HERE SIMULATES A COLONY. It follows routes the server reported and
// reads what pins hold and whether programs are running, all as stated. It
// computes no rate and no throughput.
//
// ⚠ UNKNOWN RAISES NOTHING (colonyAttention.ts). A source factory whose recipe
// the table does not know is presumed live: this module only speaks when it can
// show the supply is gone.

import type { Colony, ColonyPin } from "../store/types.ts";
import type { PiRecipeBook } from "./piRecipes.ts";

interface Need {
  readonly typeID: number;
  readonly name: string | null;
  /** How much one run takes, when the recipe table says; null otherwise. */
  readonly batch: number | null;
}

interface Supply {
  readonly live: boolean;
  /** The dead chain reaches an extractor that ran out or has no program. */
  readonly extractorStopped: boolean;
}

const DEAD: Supply = Object.freeze({ live: false, extractorStopped: false });
const LIVE: Supply = Object.freeze({ live: true, extractorStopped: false });

function recipeOf(recipes: PiRecipeBook | null, pin: ColonyPin) {
  if (recipes === null || !recipes.readable || pin.schematicID === null) return null;
  return recipes.bySchematicID.get(pin.schematicID) ?? null;
}

function held(pin: ColonyPin, typeID: number): number {
  return pin.contents
    .filter((item) => item.typeID === typeID)
    .reduce((sum, item) => sum + item.quantity, 0);
}

/** Where routes carrying `typeID` into `pinID` start. */
function sourcesOf(colony: Colony, pinID: number, typeID: number): number[] {
  return colony.routes
    .filter((route) => route.commodityTypeID === typeID && route.path[route.path.length - 1] === pinID)
    .map((route) => route.path[0]!)
    .filter((source) => source !== pinID);
}

/** What a factory needs: the recipe's inputs when known, else what its routes bring. */
function needsOf(colony: Colony, factory: ColonyPin, recipes: PiRecipeBook | null): Need[] {
  const recipe = recipeOf(recipes, factory);
  if (recipe !== null) {
    return recipe.inputs.map((input) => ({ typeID: input.typeID, name: input.typeName, batch: input.quantity }));
  }
  const seen = new Map<number, Need>();
  for (const route of colony.routes) {
    if (route.path[route.path.length - 1] !== factory.pinID || route.path[0] === factory.pinID) continue;
    if (!seen.has(route.commodityTypeID)) {
      seen.set(route.commodityTypeID, {
        typeID: route.commodityTypeID,
        name: route.commodityTypeName,
        batch: null,
      });
    }
  }
  return [...seen.values()];
}

function combine(supplies: readonly Supply[]): Supply {
  if (supplies.some((supply) => supply.live)) return LIVE;
  return { live: false, extractorStopped: supplies.some((supply) => supply.extractorStopped) };
}

/** Can `pinID` hand out `typeID`, now or as it keeps running? */
function supplyFrom(
  colony: Colony,
  pinID: number,
  typeID: number,
  serverNowMs: number,
  recipes: PiRecipeBook | null,
  visiting: Set<string>,
): Supply {
  const key = `${pinID}:${typeID}`;
  if (visiting.has(key)) return DEAD;
  visiting.add(key);
  try {
    const pin = colony.pins.find((candidate) => candidate.pinID === pinID);
    if (!pin) return DEAD;

    if (pin.kind === "extractor-control") {
      const program = pin.program;
      if (program === null || program.expiresAtMs === null) {
        return { live: false, extractorStopped: true };
      }
      if (program.resourceTypeID !== typeID) return DEAD;
      return program.expiresAtMs > serverNowMs ? LIVE : { live: false, extractorStopped: true };
    }

    if (pin.kind === "factory") {
      const recipe = recipeOf(recipes, pin);
      // A factory the table cannot describe is presumed to be working.
      if (recipe === null) return LIVE;
      if (recipe.output.typeID !== typeID) return DEAD;
      return fed(colony, pin, serverNowMs, recipes, visiting);
    }

    // Storage, launchpads and the command centre: stock, or something live
    // routing into them.
    if (held(pin, typeID) > 0) return LIVE;
    return combine(
      sourcesOf(colony, pinID, typeID).map((source) =>
        supplyFrom(colony, source, typeID, serverNowMs, recipes, visiting)),
    );
  } finally {
    visiting.delete(key);
  }
}

/** Every input of this factory has somewhere live to come from. */
function fed(
  colony: Colony,
  factory: ColonyPin,
  serverNowMs: number,
  recipes: PiRecipeBook | null,
  visiting: Set<string>,
): Supply {
  const needs = needsOf(colony, factory, recipes);
  if (needs.length === 0) return DEAD;
  let stopped = false;
  for (const need of needs) {
    const supply = supplyForNeed(colony, factory, need, serverNowMs, recipes, visiting);
    if (!supply.live) {
      if (!supply.extractorStopped) return DEAD;
      stopped = true;
    }
  }
  return stopped ? { live: false, extractorStopped: true } : LIVE;
}

function supplyForNeed(
  colony: Colony,
  factory: ColonyPin,
  need: Need,
  serverNowMs: number,
  recipes: PiRecipeBook | null,
  visiting: Set<string>,
): Supply {
  const stock = held(factory, need.typeID);
  if (need.batch === null ? stock > 0 : stock >= need.batch) return LIVE;
  return combine(
    sourcesOf(colony, factory.pinID, need.typeID).map((source) =>
      supplyFrom(colony, source, need.typeID, serverNowMs, recipes, visiting)),
  );
}

/**
 * Why this factory is stuck, in a player's words — or null when it is not.
 *
 * Only asked about a factory the server said went unfed last cycle; a factory
 * it said was fed, or said nothing about, is never judged here.
 */
export function factoryStarvationWords(
  colony: Colony,
  factory: ColonyPin,
  serverNowMs: number,
  recipes: PiRecipeBook | null,
): string | null {
  if (factory.kind !== "factory" || factory.receivedInputsLastCycle !== false) return null;
  const making = factory.schematicName ?? recipeOf(recipes, factory)?.output.typeName ?? null;
  const target = making ? `the factory making ${making}` : "a factory";
  const needs = needsOf(colony, factory, recipes);
  if (needs.length === 0) {
    return `No route brings anything to ${target}`;
  }
  for (const need of needs) {
    const what = need.name ?? "what it needs";
    const stock = held(factory, need.typeID);
    if (need.batch === null ? stock > 0 : stock >= need.batch) continue;
    const sources = sourcesOf(colony, factory.pinID, need.typeID);
    if (sources.length === 0) {
      return `No route brings ${what} to ${target}`;
    }
    const supply = supplyForNeed(colony, factory, need, serverNowMs, recipes, new Set());
    if (supply.live || supply.extractorStopped) continue;
    return `Nothing is sending ${what} to ${target}`;
  }
  return null;
}
