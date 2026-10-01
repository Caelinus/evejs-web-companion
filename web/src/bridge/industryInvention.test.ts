// R109 slice 6: invention odds, by the server's formula.

import test from "node:test";
import assert from "node:assert/strict";

import {
  bestInventor,
  chanceWords,
  decodeInventionTerms,
  inventionChance,
  inventionNeed,
  inventionShortfalls,
  planInventions,
  NO_INVENTION_TERMS,
  type DecryptorTerms,
} from "./industryInvention.ts";
import { decodeRecipeClosure, type IndustryInvention } from "./industryRecipes.ts";
import { resolveIndustryChain } from "./industryChain.ts";
import type { JsonValue } from "./wire.ts";

const SCIENCE_A = 11442;
const SCIENCE_B = 11454;
const ENCRYPTION = 21790;
const DATACORE_A = 20418;
const DATACORE_B = 20419;

const SOURCE: IndustryInvention = {
  blueprintTypeID: 2455,
  blueprintName: "Widget Blueprint",
  runsPerCopy: 10,
  probability: 0.34,
  timeSeconds: 7800,
  materials: [{ typeID: DATACORE_A, quantity: 1 }, { typeID: DATACORE_B, quantity: 1 }],
  skills: [{ typeID: SCIENCE_A, level: 1 }, { typeID: SCIENCE_B, level: 1 }, { typeID: ENCRYPTION, level: 1 }],
};

const TERMS = decodeInventionTerms({
  lowerRateSkillTypeIDs: [ENCRYPTION],
  decryptors: [
    { typeID: 34201, name: "Parity Decryptor", probabilityMultiplier: 1.5, materialEfficiency: 1, timeEfficiency: -2, maxRuns: 3 },
    { typeID: 34202, name: "Augmentation Decryptor", probabilityMultiplier: 0.6, materialEfficiency: -2, timeEfficiency: 2, maxRuns: 9 },
    { typeID: 0, name: "broken", probabilityMultiplier: 1 },
  ],
} as unknown as JsonValue);
const PARITY = TERMS.decryptors.get(34201) as DecryptorTerms;

test("the terms decode; a decryptor with no id is dropped; no answer is unreadable", () => {
  assert.equal(TERMS.readable, true);
  assert.deepEqual([...TERMS.decryptors.keys()], [34201, 34202]);
  assert.equal(decodeInventionTerms({ ok: false } as unknown as JsonValue).readable, false);
});

test("chance: science at 1/30 a level, encryption at 1/40, times the decryptor, capped at 1", () => {
  const skills = new Map([[SCIENCE_A, 4], [SCIENCE_B, 4], [ENCRYPTION, 4]]);
  // 0.34 x (1 + 4/30 + 4/30 + 4/40) = 0.34 x 1.366... = 0.46466...
  assert.ok(Math.abs(inventionChance(SOURCE, skills, TERMS, null) - 0.34 * (1 + 8 / 30 + 4 / 40)) < 1e-12);
  assert.ok(Math.abs(inventionChance(SOURCE, skills, TERMS, PARITY) - 0.34 * (1 + 8 / 30 + 4 / 40) * 1.5) < 1e-12);
  // Without the list, encryption is counted like any other skill: a different number.
  assert.notEqual(inventionChance(SOURCE, skills, NO_INVENTION_TERMS, null), inventionChance(SOURCE, skills, TERMS, null));
  // Untrained skills count as zero: the base chance alone.
  assert.equal(inventionChance(SOURCE, new Map(), TERMS, null), 0.34);
  assert.equal(inventionChance({ ...SOURCE, probability: 0.9 }, skills, TERMS, PARITY), 1);
});

test("attempts on average, to the nearest whole, and what they use, decryptor included", () => {
  const need = inventionNeed(SOURCE, 3, 0.4, PARITY);
  // 3 copies at 40% = 7.5 attempts -> 8.
  assert.equal(need.attempts, 8);
  assert.deepEqual([...need.materials], [[DATACORE_A, 8], [DATACORE_B, 8], [34201, 8]]);
  // An exact ratio is not pushed up by float error: 2 / 0.5 = 4.
  assert.equal(inventionNeed(SOURCE, 2, 0.5, null).attempts, 4);
  assert.equal(inventionNeed(SOURCE, 0, 0.5, null).attempts, 0);
  // The average, not a ceiling: 1 copy at 49.6% is 2.02 attempts, so 2 (seen
  // live as "about 3"); at 45% it is 2.2, also 2.
  assert.equal(inventionNeed(SOURCE, 1, 0.496, null).attempts, 2);
  assert.equal(inventionNeed(SOURCE, 1, 0.45, null).attempts, 2);
  // Never fewer attempts than copies, even at a certain chance.
  assert.equal(inventionNeed(SOURCE, 3, 1, null).attempts, 3);
});

test("attempts already running are taken off what is still to start, and so are their datacores", () => {
  const need = inventionNeed(SOURCE, 3, 0.4, PARITY, 5);
  assert.equal(need.attempts, 8);
  assert.equal(need.running, 5);
  assert.equal(need.toStart, 3);
  assert.deepEqual([...need.materials], [[DATACORE_A, 3], [DATACORE_B, 3], [34201, 3]]);
  // More running than needed: nothing left to start, nothing to buy.
  const covered = inventionNeed(SOURCE, 1, 0.5, PARITY, 4);
  assert.equal(covered.running, 2);
  assert.equal(covered.toStart, 0);
  assert.deepEqual([...covered.materials], [[DATACORE_A, 0], [DATACORE_B, 0]]);
});

test("the best inventor is whoever's skills give the best chance", () => {
  const best = bestInventor(SOURCE, [
    { name: "low", skills: new Map([[SCIENCE_A, 1]]) },
    { name: "high", skills: new Map([[SCIENCE_A, 5], [SCIENCE_B, 5]]) },
  ], TERMS, null);
  assert.equal(best?.pilot.name, "high");
  assert.equal(bestInventor(SOURCE, [], TERMS, null), null);
});

test("chanceWords stays plain", () => {
  assert.equal(chanceWords(0.4647), "46%");
  assert.equal(chanceWords(0.045), "4.5%");
  assert.equal(chanceWords(1), "100%");
});

test("the resolver: a decryptor's extra runs mean fewer invented copies", () => {
  const book = decodeRecipeClosure({
    recipes: [{
      productTypeID: 900, activity: "manufacturing", blueprintTypeID: 1900, quantityPerRun: 1,
      materials: [{ typeID: 34, quantity: 1 }],
      inventedFrom: [{ blueprintTypeID: 2455, runsPerCopy: 10, probability: 0.34, materials: [], skills: [] }],
    }],
    types: {},
  } as unknown as JsonValue);
  const plain = resolveIndustryChain({ book, productTypeID: 900, runs: 25 });
  assert.equal(plain?.lines.get(900)?.blueprint?.invention?.copies, 3);
  const parity = resolveIndustryChain({ book, productTypeID: 900, runs: 25, choices: { inventionRunsBonus: new Map([[1900, 3]]) } });
  assert.equal(parity?.lines.get(900)?.blueprint?.invention?.runsPerCopy, 13);
  assert.equal(parity?.lines.get(900)?.blueprint?.invention?.copies, 2);
  // A decryptor can never take a copy below one run.
  const harsh = resolveIndustryChain({ book, productTypeID: 900, runs: 3, choices: { inventionRunsBonus: new Map([[1900, -50]]) } });
  assert.equal(harsh?.lines.get(900)?.blueprint?.invention?.runsPerCopy, 1);
});

test("a plan's inventions: the best inventor's chance, the chosen decryptor, and what is short", () => {
  const book = decodeRecipeClosure({
    recipes: [{
      productTypeID: 900, activity: "manufacturing", blueprintTypeID: 1900, quantityPerRun: 1,
      materials: [{ typeID: 34, quantity: 1 }],
      inventedFrom: [{ ...SOURCE }],
    }],
    types: {},
  } as unknown as JsonValue);
  const chain = resolveIndustryChain({ book, productTypeID: 900, runs: 20 });
  assert.ok(chain);
  const rows = planInventions(
    chain,
    (blueprintTypeID) => (blueprintTypeID === 1900 ? PARITY : null),
    [{ name: "Pilot One", skills: new Map([[SCIENCE_A, 5], [SCIENCE_B, 5], [ENCRYPTION, 5]]) }],
    TERMS,
  );
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.ok(row);
  assert.equal(row.inventorName, "Pilot One");
  assert.equal(row.copies, 2);
  // 0.34 x (1 + 10/30 + 5/40) x 1.5 = 0.74 or so: 2 copies take 2.7, so 3 attempts.
  assert.equal(row.need.attempts, 3);
  const short = inventionShortfalls(rows, new Map([[DATACORE_A, 10], [34201, 1]]), (typeID) => (typeID === 34201 ? "Parity Decryptor" : null));
  assert.deepEqual(short.map((entry) => [entry.typeID, entry.held, entry.short]), [
    [DATACORE_B, 0, row.need.attempts],
    [34201, 1, row.need.attempts - 1],
  ]);
  // An invention job already running for the T2 blueprint counts its runs.
  const underway = planInventions(chain, (blueprintTypeID) => (blueprintTypeID === 1900 ? PARITY : null),
    [{ name: "Pilot One", skills: new Map([[SCIENCE_A, 5], [SCIENCE_B, 5], [ENCRYPTION, 5]]) }], TERMS, new Map([[1900, 2], [1901, 9]]));
  assert.equal(underway[0]?.need.running, 2);
  assert.equal(underway[0]?.need.toStart, 1);
  // Nobody's skills known: the base chance, and no inventor named.
  const unskilled = planInventions(chain, () => null, [], TERMS);
  assert.equal(unskilled[0]?.inventorName, null);
  assert.equal(unskilled[0]?.need.chance, 0.34);
});
