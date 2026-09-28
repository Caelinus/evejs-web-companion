// The words for what a colony's factory makes (goal R108 slice 2).
//
// ---------------------------------------------------------------------------
// IT MUST DEGRADE, NOT BREAK.
//
// The recipe book is fetched separately from the colony read, so the panel
// WILL render factories before the book arrives — and on a server whose
// schematic table is missing, it may never arrive at all. `making` is read
// straight from the colony read's own `pin.schematicName`, exactly as the
// panel has rendered it since R41; a missing or not-yet-loaded book can only
// ever take away `rate` and `needs`, never the line that already worked.
//
// ---------------------------------------------------------------------------
// NEVER AN ID (R7d).
//
// An ingredient the book could not name is counted, never printed as a bare
// typeID, and never silently dropped either — a player reading "needs 40
// Plasmoids" when a second, unnamed ingredient exists has been told
// something false. See `needsWords` below for how the count is folded in.
//
// ---------------------------------------------------------------------------
// SECONDS IN, MILLISECONDS OUT.
//
// `cycleTimeSeconds` is the schematic's own unit (see piRecipes.ts);
// `formatDuration` (planets.ts) wants milliseconds. The `* 1000` is the one
// place that conversion happens, and it stays visible here rather than
// hiding behind a shared helper — this codebase has already shipped one
// duration bug by carrying a value across in the wrong unit.

import { formatDuration } from "./planets.ts";
import type { PiIngredient, PiRecipeBook } from "./piRecipes.ts";
import type { ColonyPin } from "../store/types.ts";

export interface FactoryRecipeWords {
  /** "Making Superconductors", or "No recipe set". Never an id. */
  readonly making: string;
  /** "5 every 1 hour", or null when the run length is not known. */
  readonly rate: string | null;
  /** "needs 40 Plasmoids and 40 Water", or null. */
  readonly needs: string | null;
}

/** "A", "A and B", "A, B and C" — an Oxford join, never a bare list. */
function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts[0] ?? "";
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * "needs 40 Plasmoids and 40 Water", or null when there is
 * nothing to list.
 *
 * ⚠ NEVER AN ID, NEVER A DROP. An ingredient the book could not name is
 * folded into a trailing count instead of being printed or omitted: "and one
 * more ingredient" / "and N more ingredients". When NOTHING among the inputs
 * is nameable, the whole sentence falls back to a bare count of ingredients
 * — still honest about how many there are, without inventing a name for any
 * of them.
 */
function needsWords(inputs: readonly PiIngredient[]): string | null {
  if (inputs.length === 0) {
    return null;
  }
  const named = inputs.filter((input) => input.typeName !== null);
  const unnamedCount = inputs.length - named.length;

  if (named.length === 0) {
    return `needs ${unnamedCount} ingredient${unnamedCount === 1 ? "" : "s"}`;
  }

  const phrases = named.map((input) => `${input.quantity.toLocaleString()} ${input.typeName}`);
  if (unnamedCount > 0) {
    phrases.push(
      unnamedCount === 1 ? "one more ingredient" : `${unnamedCount} more ingredients`,
    );
  }
  return `needs ${joinWithAnd(phrases)}`;
}

/**
 * The words for one factory pin's recipe: what it makes, how fast, and what
 * it costs. Three independently-nullable phrases, because `making` comes
 * from the colony read while `rate` and `needs` need the recipe book, and the
 * two arrive on separate wires (see header).
 *
 * ⚠ The panel only ever calls this for `pin.kind === "factory"`; a pin of any
 * other kind simply has no schematic and reads back "No recipe set" with the
 * other two phrases null, the same as a factory whose recipe is not yet set
 * — this function answers honestly rather than assuming the kind.
 */
export function factoryRecipeWords(book: PiRecipeBook, pin: ColonyPin): FactoryRecipeWords {
  const making = pin.schematicName ? `Making ${pin.schematicName}` : "No recipe set";

  const schematic = pin.schematicID !== null ? (book.bySchematicID.get(pin.schematicID) ?? null) : null;
  if (schematic === null) {
    return { making, rate: null, needs: null };
  }

  const rate = schematic.cycleTimeSeconds === null
    ? null
    : `${schematic.output.quantity.toLocaleString()} every ${formatDuration(schematic.cycleTimeSeconds * 1000)}`;

  return { making, rate, needs: needsWords(schematic.inputs) };
}
