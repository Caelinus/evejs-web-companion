// The planner (goal R108 slice 5): can what you hold and what your colonies
// make produce N of X — and if not, exactly where the gaps are.
//
// ---------------------------------------------------------------------------
// HELD STOCK IS TAKEN OFF BEFORE INPUTS ARE WORKED OUT.
//
// `planProduction` (piChain.ts) expands the whole requirement. A player who
// already holds 12 of the 20 Consumer Electronics needs the inputs for 8, not
// for 20 — so this does the netting a materials plan does: walk the chain from
// the target down, and at every commodity subtract what is held BEFORE taking
// the whole runs and pushing demand onto its inputs. The walk order and the
// consolidation are planProduction's, for its reason: a commodity two branches
// share is netted and rounded ONCE, against its whole-chain need.
//
// Held means everywhere: colony storage, personal hangars and corporation
// hangars all count. Where each unit sits is kept on the row, because stock in
// a station hangar needs a hauler before a factory can use it — the plan says
// so by naming the place, and does not pretend to move it.
//
// ---------------------------------------------------------------------------
// NOTHING HERE SIMULATES A COLONY.
//
// A factory rate is recipe arithmetic — one run's output per cycle — and is
// labelled "up to", because a factory only runs when fed. An extractor rate is
// the server's own `quantityPerCycle` over its cycle, for the program
// installed NOW; yield decays across a program, and that curve is the
// emulator's, so the words say which program the number belongs to. No rate is
// ever summed into a time for the whole chain: steps overlap, and pretending to
// schedule them would be a simulation.
//
// ---------------------------------------------------------------------------
// GAPS, IN THE ORDER THEY ARE WORTH TELLING SOMEONE.
//
//   1. nothing you own makes this — no factory anywhere can run its recipe;
//   2. a factory could make this but is making something else — named, with
//      what it makes now;
//   3. it is made too slowly — only against a deadline the player gave, with
//      the rate and the shortfall, never an adjective;
//   4. it is extracted nowhere you own — naming the colonised planets that
//      carry it, with the server's quality number.
//
// With none of these, the verdict is the fifth kind: nothing needs to change.

import type { Colony, ColonyPin } from "../store/types.ts";
import { colonyPlaceWords, formatDuration, serverNow } from "./planets.ts";
import { resolveChain, type ChainNode } from "./piChain.ts";
import { commodityName, tierOf, type PiRecipeBook, type PiSchematic, type PiTier } from "./piRecipes.ts";
import { compareHoldings, countWords, type Holding } from "./piStock.ts";

/** One colony the planner may count on, with the clock it was read against. */
export interface PlannerColony {
  readonly colony: Colony;
  readonly clockOffsetMs: number;
}

export interface PlannerInput {
  readonly book: PiRecipeBook;
  readonly targetTypeID: number;
  readonly quantity: number;
  readonly holdings: readonly Holding[];
  readonly colonies: readonly PlannerColony[];
  /** A deadline in ms from now, or null for none. Only a deadline makes "too slow" a gap. */
  readonly withinMs: number | null;
  readonly browserNowMs: number;
}

export type PlanGapKind = "nothing-makes" | "factory-busy" | "too-slow" | "not-extracted";

export interface PlanGap {
  readonly kind: PlanGapKind;
  readonly typeID: number;
  readonly headline: string;
  readonly detail: string | null;
}

/** What produces a commodity today, and how fast. */
export interface PlanProducer {
  readonly kind: "factory" | "extractor";
  readonly placeWords: string;
  readonly count: number;
  /** Units an hour, all of `count` together. */
  readonly perHour: number;
}

export interface PlanRow {
  readonly typeID: number;
  readonly typeName: string;
  readonly tier: PiTier | null;
  /** Longest distance from the target: 0 is the target. For indenting. */
  readonly depth: number;
  /** Required across the whole chain, after what is held above it. */
  readonly needed: number;
  /** Everything held of it, wherever it is. May exceed `needed`. */
  readonly held: number;
  /** What must still be made (or extracted): needed minus held, never below 0. */
  readonly toMake: number;
  readonly madeBy: PiSchematic | null;
  /** Whole runs to cover `toMake`; null for a leaf or when nothing is to be made. */
  readonly runs: number | null;
  readonly producers: readonly PlanProducer[];
  /** "Alpha III, up to 40 an hour" — what the Made-by cell says. */
  readonly sourceWords: string;
  /** How long the current producers take to cover `toMake`; null when not applicable. */
  readonly coverWords: string | null;
  /** 1-based index into the plan's gaps, when this row has one. */
  readonly gapNumber: number | null;
  readonly holdings: readonly Holding[];
}

export interface Plan {
  readonly verdict: string;
  /** True when nothing needs to change. */
  readonly covered: boolean;
  readonly gaps: readonly PlanGap[];
  /** Target first, then deeper steps; each commodity once. */
  readonly rows: readonly PlanRow[];
}

const GAP_ORDER: Readonly<Record<PlanGapKind, number>> = Object.freeze({
  "nothing-makes": 0,
  "factory-busy": 1,
  "too-slow": 2,
  "not-extracted": 3,
});

function rateWords(perHour: number): string {
  return perHour >= 10 ? countWords(perHour) : (Math.round(perHour * 10) / 10).toString();
}

function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Group pins by colony, as producers. */
function producersFrom(
  kind: PlanProducer["kind"],
  found: readonly { colony: Colony; perHour: number }[],
): PlanProducer[] {
  const byPlanet = new Map<number, PlanProducer>();
  for (const entry of found) {
    const known = byPlanet.get(entry.colony.planetID);
    byPlanet.set(entry.colony.planetID, known
      ? { ...known, count: known.count + 1, perHour: known.perHour + entry.perHour }
      : { kind, placeWords: colonyPlaceWords(entry.colony), count: 1, perHour: entry.perHour });
  }
  return [...byPlanet.values()].sort((left, right) => right.perHour - left.perHour);
}

function factoriesRunning(recipe: PiSchematic, colonies: readonly PlannerColony[]): PlanProducer[] {
  if (recipe.cycleTimeSeconds === null) return [];
  const perHour = (recipe.output.quantity * 3600) / recipe.cycleTimeSeconds;
  const found: { colony: Colony; perHour: number }[] = [];
  for (const { colony } of colonies) {
    for (const pin of colony.pins) {
      if (pin.kind === "factory" && pin.schematicID === recipe.schematicID) {
        found.push({ colony, perHour });
      }
    }
  }
  return producersFrom("factory", found);
}

/** A factory of a type that can run this recipe, set to something else. */
function idleCandidates(recipe: PiSchematic, colonies: readonly PlannerColony[]): { colony: Colony; pin: ColonyPin }[] {
  const types = new Set(recipe.factoryTypeIDs);
  const found: { colony: Colony; pin: ColonyPin }[] = [];
  for (const { colony } of colonies) {
    for (const pin of colony.pins) {
      if (pin.kind === "factory" && types.has(pin.typeID) && pin.schematicID !== recipe.schematicID) {
        found.push({ colony, pin });
      }
    }
  }
  return found;
}

function extractors(typeID: number, colonies: readonly PlannerColony[], browserNowMs: number) {
  const running: { colony: Colony; perHour: number }[] = [];
  const stopped: Colony[] = [];
  for (const { colony, clockOffsetMs } of colonies) {
    const nowMs = serverNow(clockOffsetMs, browserNowMs);
    for (const pin of colony.pins) {
      const program = pin.program;
      if (pin.kind !== "extractor-control" || program === null || program.resourceTypeID !== typeID) continue;
      const ended = program.expiresAtMs !== null && program.expiresAtMs <= nowMs;
      if (ended || program.cycleTimeSeconds <= 0 || program.quantityPerCycle <= 0) {
        stopped.push(colony);
      } else {
        running.push({ colony, perHour: (program.quantityPerCycle * 3600) / program.cycleTimeSeconds });
      }
    }
  }
  return { running: producersFrom("extractor", running), stopped };
}

/** Which colonised planets carry this resource, richest first. */
function carriers(typeID: number, colonies: readonly PlannerColony[]): string[] {
  const found: { words: string; quality: number | null }[] = [];
  const seen = new Set<number>();
  for (const { colony } of colonies) {
    if (seen.has(colony.planetID)) continue;
    const resource = colony.resources?.find((entry) => entry.typeID === typeID);
    if (!resource) continue;
    seen.add(colony.planetID);
    const kind = colony.planetTypeName ? ` (${colony.planetTypeName.replace(/^Planet \((.*)\)$/, "$1")})` : "";
    found.push({ words: `${colonyPlaceWords(colony)}${kind}`, quality: resource.quality });
  }
  found.sort((left, right) => (right.quality ?? -1) - (left.quality ?? -1));
  return found.map((entry) => (entry.quality === null ? entry.words : `${entry.words} at quality ${countWords(entry.quality)}`));
}

/** Longest distance of every commodity from the target, and the recipe the tree used. */
function chainShape(root: ChainNode) {
  const depthOf = new Map<number, number>();
  const recipeOf = new Map<number, PiSchematic | null>();
  const walk = (node: ChainNode, depth: number): void => {
    const known = depthOf.get(node.typeID);
    if (known === undefined || depth > known) depthOf.set(node.typeID, depth);
    if (node.madeBy !== null || !recipeOf.has(node.typeID)) recipeOf.set(node.typeID, node.madeBy);
    for (const input of node.inputs) walk(input, depth + 1);
  };
  walk(root, 0);
  return { depthOf, recipeOf };
}

/**
 * The plan for `quantity` of the target, or null for a nonsensical request (a
 * bad quantity or target) — the same null resolveChain gives.
 */
export function planWithStock(input: PlannerInput): Plan | null {
  const { book } = input;
  const root = resolveChain(book, input.targetTypeID, input.quantity);
  if (root === null) return null;
  const { depthOf, recipeOf } = chainShape(root);

  const heldBy = new Map<number, Holding[]>();
  for (const holding of input.holdings) {
    if (holding.quantity <= 0) continue;
    const list = heldBy.get(holding.typeID) ?? [];
    list.push(holding);
    heldBy.set(holding.typeID, list);
  }
  const heldOf = (typeID: number) => (heldBy.get(typeID) ?? []).reduce((total, holding) => total + holding.quantity, 0);

  // Nearest the target first: every demand on a commodity is counted before it
  // is netted (see planProduction's own proof of this ordering).
  const order = [...depthOf.keys()].sort((left, right) => (depthOf.get(left) ?? 0) - (depthOf.get(right) ?? 0));
  const needs = new Map<number, number>([[root.typeID, root.needed]]);
  const rows: PlanRow[] = [];
  const gaps: { gap: PlanGap; rowIndex: number; depth: number }[] = [];

  for (const typeID of order) {
    const needed = needs.get(typeID) ?? 0;
    if (needed <= 0) continue;
    const recipe = recipeOf.get(typeID) ?? null;
    const typeName = commodityName(book, typeID) ?? "A commodity this table does not name";
    const tier = tierOf(book, typeID);
    const held = heldOf(typeID);
    const toMake = Math.max(0, needed - held);
    const runs = recipe !== null && toMake > 0 ? Math.ceil(toMake / recipe.output.quantity) : null;
    if (recipe !== null && runs !== null) {
      for (const ingredient of recipe.inputs) {
        needs.set(ingredient.typeID, (needs.get(ingredient.typeID) ?? 0) + runs * ingredient.quantity);
      }
    }

    let producers: PlanProducer[] = [];
    let sourceWords: string;
    let gap: PlanGap | null = null;
    let stopped: Colony[] = [];
    if (recipe !== null) {
      producers = factoriesRunning(recipe, input.colonies);
    } else {
      const found = extractors(typeID, input.colonies, input.browserNowMs);
      producers = found.running;
      stopped = found.stopped;
    }
    const perHour = producers.reduce((total, producer) => total + producer.perHour, 0);

    if (producers.length > 0) {
      const places = listWords(producers.map((producer) =>
        producer.count > 1 ? `${producer.placeWords} (${producer.count})` : producer.placeWords));
      sourceWords = recipe !== null
        ? `${places}, up to ${rateWords(perHour)} an hour`
        : `${places}, ${rateWords(perHour)} an hour on the installed program`;
    } else if (toMake === 0) {
      sourceWords = "held";
    } else {
      sourceWords = recipe !== null ? "nothing" : "not extracted";
    }

    const coverMs = toMake > 0 && perHour > 0 ? (toMake / perHour) * 3_600_000 : null;
    const coverWords = coverMs === null ? null : `${formatDuration(coverMs)} at that rate`;

    if (toMake > 0) {
      if (producers.length > 0) {
        if (input.withinMs !== null && coverMs !== null && coverMs > input.withinMs) {
          gap = {
            kind: "too-slow",
            typeID,
            headline: `${typeName} is made at ${rateWords(perHour)} an hour.`,
            detail: `The ${countWords(toMake)} still to make take ${formatDuration(coverMs)}, longer than the ${formatDuration(input.withinMs)} you gave.`,
          };
        }
      } else if (recipe !== null) {
        const candidates = idleCandidates(recipe, input.colonies);
        if (candidates.length > 0) {
          const first = candidates[0]!;
          const more = candidates.length - 1;
          gap = {
            kind: "factory-busy",
            typeID,
            headline: `${colonyPlaceWords(first.colony)} could make ${typeName}.`,
            detail: `Its factory makes ${first.pin.schematicName ?? "nothing"} now${
              more > 0 ? `; ${more} more factor${more === 1 ? "y" : "ies"} could too` : ""}.`,
          };
        } else {
          gap = {
            kind: "nothing-makes",
            typeID,
            headline: `Nothing you own makes ${typeName}.`,
            detail: "No colony has a factory that can run its recipe.",
          };
        }
      } else if (tier === 0 || tier === null) {
        // A leaf nothing in the book makes is a raw resource unless the book
        // itself classifies it higher: in the real table every such leaf is.
        const planets = carriers(typeID, input.colonies);
        const stoppedWords = stopped.length > 0
          ? `Its program on ${listWords([...new Set(stopped.map(colonyPlaceWords))])} has ended. `
          : "";
        gap = {
          kind: "not-extracted",
          typeID,
          headline: stopped.length > 0 ? `${typeName} is extracted nowhere right now.` : `Nothing you own extracts ${typeName}.`,
          detail: planets.length > 0
            ? `${stoppedWords}${listWords(planets)} ${planets.length === 1 ? "carries" : "carry"} it.`
            : `${stoppedWords}None of your colonised planets carries it.`,
        };
      } else {
        gap = {
          kind: "nothing-makes",
          typeID,
          headline: `Nothing you own makes ${typeName}.`,
          detail: "The recipe table has no recipe for it.",
        };
      }
    }

    const depth = depthOf.get(typeID) ?? 0;
    if (gap !== null) gaps.push({ gap, rowIndex: rows.length, depth });
    rows.push({
      typeID,
      typeName,
      tier,
      depth,
      needed,
      held,
      toMake,
      madeBy: recipe,
      runs,
      producers,
      sourceWords,
      coverWords,
      gapNumber: null,
      holdings: Object.freeze([...(heldBy.get(typeID) ?? [])].sort(compareHoldings)),
    });
  }

  gaps.sort((left, right) => GAP_ORDER[left.gap.kind] - GAP_ORDER[right.gap.kind] || left.depth - right.depth);
  const gapOfRow = new Map<number, number>();
  gaps.forEach((entry, index) => gapOfRow.set(entry.rowIndex, index + 1));
  const numbered = rows.map((row, rowIndex): PlanRow => {
    const gapNumber = gapOfRow.get(rowIndex);
    if (gapNumber === undefined) return row;
    return {
      ...row,
      gapNumber,
      sourceWords: row.producers.length === 0 ? `${row.sourceWords} - see gap ${gapNumber}` : row.sourceWords,
    };
  });

  // The target is always the first row: resolveChain's root needs more than 0.
  const target = numbered[0]!;
  const quantityWords = countWords(input.quantity);
  let verdict: string;
  if (target.toMake === 0) {
    verdict = `You hold ${countWords(target.held)} ${target.typeName} already. Nothing needs to change.`;
  } else if (gaps.length === 0) {
    verdict = `What you hold and what your colonies make cover ${quantityWords} ${target.typeName}. Nothing needs to change.`;
  } else {
    const within = input.withinMs !== null && gaps.every((entry) => entry.gap.kind === "too-slow")
      ? ` within ${formatDuration(input.withinMs)}`
      : " yet";
    verdict = `You can't make ${quantityWords} ${target.typeName}${within}. ${gaps.length} thing${
      gaps.length === 1 ? " is" : "s are"} missing.`;
  }

  return {
    verdict,
    covered: gaps.length === 0,
    gaps: Object.freeze(gaps.map((entry) => entry.gap)),
    rows: Object.freeze(numbered),
  };
}

/**
 * A deadline typed by the player: "3d", "36h", "2d 6h", or a bare number of
 * hours. Null for empty; NaN for something that is not a duration.
 */
export function parseWithin(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "") return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 3_600_000;
  const pattern = /(\d+(?:\.\d+)?)\s*([dhm])/g;
  let total = 0;
  let consumed = "";
  for (const match of trimmed.matchAll(pattern)) {
    const amount = Number(match[1]);
    total += amount * (match[2] === "d" ? 86_400_000 : match[2] === "h" ? 3_600_000 : 60_000);
    consumed += match[0];
  }
  return consumed.replace(/\s/g, "") === trimmed.replace(/\s/g, "") && total > 0 ? total : NaN;
}
