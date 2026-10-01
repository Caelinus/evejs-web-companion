// Invention odds for a plan (goal R109 slice 6): how likely an attempt is, how
// many attempts the plan needs on average, and what those attempts use up.
// Pure.
//
// ---------------------------------------------------------------------------
// THE SERVER'S FORMULA (server/src/services/industry/industryRuntimeState.js,
// computeInventionProbability), not a wiki's:
//
//     chance = base x (1 + sum over the activity's skills of level x rate) x decryptor
//
// capped at 1, where `base` is the average of the products' stated
// probabilities, `rate` is 1/40 for a skill on client type list 799 (the
// encryption skills) and 1/30 for every other, and `decryptor` is the chosen
// decryptor's attribute 1112 (1 with none). A successful attempt gives one copy
// at ME 2 / TE 4 plus the decryptor's, carrying the product's runs plus the
// decryptor's, never fewer than one.
//
// ---------------------------------------------------------------------------
// ON AVERAGE, AND SAID SO. An attempt either succeeds or does not; a plan can
// only say how many attempts it takes on average (copies / chance, to the
// nearest whole attempt, never fewer than the copies) and what they use.
// Rounding up would plan a third attempt at 49.6% (1 / 0.496 = 2.02), which
// is not the average. Variance is not modelled, and the words say "on average".
// Attempts already running (jobSupply's `inventing`) are taken off what is
// still to start, and their datacores are already spent.

import type { JsonValue } from "./wire.ts";
import type { IndustryInvention } from "./industryRecipes.ts";
import type { IndustryChain, IndustryLine } from "./industryChain.ts";

/** The server's INVENTION_MATERIAL_EFFICIENCY and INVENTION_TIME_EFFICIENCY. */
export const INVENTED_MATERIAL_EFFICIENCY = 2;
export const INVENTED_TIME_EFFICIENCY = 4;
/** The server's INVENTION_SKILL_PROBABILITY and ..._LOWER. */
export const SKILL_RATE = 1 / 30;
export const LOWER_SKILL_RATE = 1 / 40;

export interface DecryptorTerms {
  readonly typeID: number;
  readonly name: string | null;
  readonly probabilityMultiplier: number;
  readonly materialEfficiency: number;
  readonly timeEfficiency: number;
  readonly maxRuns: number;
}

export interface InventionTerms {
  /** Skills counted at the lower rate (client type list 799). */
  readonly lowerRateSkills: ReadonlySet<number>;
  readonly decryptors: ReadonlyMap<number, DecryptorTerms>;
  readonly readable: boolean;
}

export const NO_INVENTION_TERMS: InventionTerms = Object.freeze({
  lowerRateSkills: new Set<number>(),
  decryptors: new Map<number, DecryptorTerms>(),
  readable: false,
});

function finite(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The answer of `GET /api/industry/invention-terms`. */
export function decodeInventionTerms(value: JsonValue): InventionTerms {
  const body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
  if (!Array.isArray(body.decryptors) || !Array.isArray(body.lowerRateSkillTypeIDs)) {
    return NO_INVENTION_TERMS;
  }
  const lowerRateSkills = new Set<number>();
  for (const raw of body.lowerRateSkillTypeIDs) {
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) lowerRateSkills.add(raw);
  }
  const decryptors = new Map<number, DecryptorTerms>();
  for (const raw of body.decryptors) {
    const row = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, JsonValue>) : {};
    const typeID = finite(row.typeID, 0);
    const probabilityMultiplier = finite(row.probabilityMultiplier, 0);
    if (!Number.isSafeInteger(typeID) || typeID <= 0 || probabilityMultiplier <= 0) continue;
    decryptors.set(typeID, {
      typeID,
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : null,
      probabilityMultiplier,
      materialEfficiency: Math.trunc(finite(row.materialEfficiency, 0)),
      timeEfficiency: Math.trunc(finite(row.timeEfficiency, 0)),
      maxRuns: Math.trunc(finite(row.maxRuns, 0)),
    });
  }
  return { lowerRateSkills, decryptors, readable: true };
}

/**
 * One attempt's chance of success, 0..1. `skills` is the inventor's trained
 * level per skill type; a skill not trained counts as level 0.
 */
export function inventionChance(
  source: IndustryInvention,
  skills: ReadonlyMap<number, number>,
  terms: InventionTerms,
  decryptor: DecryptorTerms | null,
): number {
  const base = source.probability ?? 1;
  let skillSum = 0;
  for (const skill of source.skills) {
    const level = Math.max(0, skills.get(skill.typeID) ?? 0);
    skillSum += level * (terms.lowerRateSkills.has(skill.typeID) ? LOWER_SKILL_RATE : SKILL_RATE);
  }
  const multiplier = decryptor?.probabilityMultiplier ?? 1;
  return Math.min(Math.max(base * (1 + skillSum) * multiplier, 0), 1);
}

/** What the attempts for `copies` successes use, on average. */
export interface InventionNeed {
  readonly chance: number;
  /** Attempts on average: copies / chance, to the nearest whole, at least `copies`. */
  readonly attempts: number;
  /** Of those, how many are running already. */
  readonly running: number;
  /** attempts - running, never below 0. */
  readonly toStart: number;
  /** Datacores and the like, then the decryptor, per type, for the attempts still to start. */
  readonly materials: ReadonlyMap<number, number>;
}

export function inventionNeed(
  source: IndustryInvention,
  copies: number,
  chance: number,
  decryptor: DecryptorTerms | null,
  running = 0,
): InventionNeed {
  const attempts = copies <= 0 || chance <= 0 ? 0 : Math.max(copies, Math.round(copies / chance));
  const underway = Math.min(Math.max(running, 0), attempts);
  const toStart = attempts - underway;
  const materials = new Map<number, number>();
  for (const material of source.materials) {
    materials.set(material.typeID, (materials.get(material.typeID) ?? 0) + material.quantity * toStart);
  }
  if (decryptor !== null && toStart > 0) {
    materials.set(decryptor.typeID, (materials.get(decryptor.typeID) ?? 0) + toStart);
  }
  return { chance, attempts, running: underway, toStart, materials };
}

/** The pilot whose skills give the best chance, among those whose skills are known. */
export function bestInventor<P extends { readonly skills: ReadonlyMap<number, number> }>(
  source: IndustryInvention,
  pilots: readonly P[],
  terms: InventionTerms,
  decryptor: DecryptorTerms | null,
): { readonly pilot: P; readonly chance: number } | null {
  let best: { pilot: P; chance: number } | null = null;
  for (const pilot of pilots) {
    const chance = inventionChance(source, pilot.skills, terms, decryptor);
    if (best === null || chance > best.chance) best = { pilot, chance };
  }
  return best;
}

/** "34%", "4.5%": plain words for a chance. */
export function chanceWords(chance: number): string {
  const percent = chance * 100;
  return percent >= 10 || Number.isInteger(percent) ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
}

// --- a plan's inventions ------------------------------------------------------

/** One T2 blueprint the plan needs invented copies of. */
export interface PlanInvention {
  readonly line: IndustryLine;
  readonly source: IndustryInvention;
  readonly copies: number;
  readonly runsPerCopy: number;
  readonly decryptor: DecryptorTerms | null;
  /** Whose skills the chance is worked with; null when no skills are known. */
  readonly inventorName: string | null;
  readonly need: InventionNeed;
}

/** A pilot whose trained skills are known. */
export interface Inventor {
  readonly name: string;
  readonly skills: ReadonlyMap<number, number>;
}

/**
 * Every invention the plan needs, each worked with the best inventor's skills
 * and the decryptor chosen for that blueprint. With no skills known the chance
 * is the base one, and `inventorName` says so by being null. `running` is
 * jobSupply's `inventing`: attempts underway per T2 blueprint type.
 */
export function planInventions(
  chain: IndustryChain,
  decryptorFor: (blueprintTypeID: number) => DecryptorTerms | null,
  inventors: readonly Inventor[],
  terms: InventionTerms,
  running: ReadonlyMap<number, number> = new Map(),
): PlanInvention[] {
  const rows: PlanInvention[] = [];
  for (const typeID of [...chain.order].reverse()) {
    const line = chain.lines.get(typeID);
    const invention = line?.blueprint?.invention;
    const source = invention?.sources[0];
    if (!line || !invention || !source || invention.copies <= 0) continue;
    const decryptor = decryptorFor(line.blueprint?.blueprintTypeID ?? 0);
    const best = bestInventor(source, inventors, terms, decryptor);
    const chance = best?.chance ?? inventionChance(source, new Map(), terms, decryptor);
    rows.push({
      line,
      source,
      copies: invention.copies,
      runsPerCopy: invention.runsPerCopy,
      decryptor,
      inventorName: best?.pilot.name ?? null,
      need: inventionNeed(source, invention.copies, chance, decryptor, running.get(line.blueprint?.blueprintTypeID ?? 0) ?? 0),
    });
  }
  return rows;
}

/** One invention input still short, shaped like a buy line for the Missing list. */
export interface InventionShortfall {
  readonly typeID: number;
  readonly name: string | null;
  readonly needed: number;
  readonly held: number;
  readonly short: number;
}

/**
 * What every invention together uses, against what is held. Datacores and
 * decryptors are no part of the build tree, so nothing else draws on the same
 * stock.
 */
export function inventionShortfalls(
  rows: readonly PlanInvention[],
  held: ReadonlyMap<number, number>,
  nameOf: (typeID: number) => string | null,
): InventionShortfall[] {
  const needed = new Map<number, number>();
  for (const row of rows) {
    for (const [typeID, quantity] of row.need.materials) {
      needed.set(typeID, (needed.get(typeID) ?? 0) + quantity);
    }
  }
  const out: InventionShortfall[] = [];
  for (const [typeID, quantity] of needed) {
    const have = Math.min(Math.max(held.get(typeID) ?? 0, 0), quantity);
    if (quantity - have > 0) {
      out.push({ typeID, name: nameOf(typeID), needed: quantity, held: have, short: quantity - have });
    }
  }
  return out;
}
