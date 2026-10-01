// R109 slice 5: jobs against a plan.

import test from "node:test";
import assert from "node:assert/strict";

import { installBlockWords, installCheck, inventionCheck, jobSupply, plannedCopies, startNext, type InstallPilot } from "./industryJobs.ts";
import { inventionNeed, type PlanInvention } from "./industryInvention.ts";
import { decodeRecipeClosure } from "./industryRecipes.ts";
import { resolveIndustryChain } from "./industryChain.ts";
import type { IndustryJobRow } from "../store/types.ts";
import type { OwnedBlueprint } from "./industryOwned.ts";
import type { JsonValue } from "./wire.ts";

// Widget II <- Widget + Gizmo(reaction, 200/run) ; Widget <- Tritanium.
const BOOK = decodeRecipeClosure({
  recipes: [
    { productTypeID: 900, activity: "manufacturing", blueprintTypeID: 1900, quantityPerRun: 1,
      materials: [{ typeID: 101, quantity: 1 }, { typeID: 102, quantity: 2 }], inventedFrom: [] },
    { productTypeID: 101, activity: "manufacturing", blueprintTypeID: 1101, quantityPerRun: 1,
      materials: [{ typeID: 34, quantity: 10 }], inventedFrom: [] },
    { productTypeID: 102, activity: "reaction", blueprintTypeID: 1102, quantityPerRun: 200,
      materials: [{ typeID: 202, quantity: 100 }], inventedFrom: [] },
  ],
  types: {},
} as unknown as JsonValue);

function job(overrides: Partial<IndustryJobRow>): IndustryJobRow {
  return {
    jobID: 1,
    activity: "manufacturing",
    status: "running",
    blueprintID: 1,
    blueprintTypeID: 1101,
    productTypeID: 101,
    facilityID: 60000004,
    runs: 2,
    successfulRuns: 0,
    cost: 0,
    ...overrides,
  } as IndustryJobRow;
}

test("active jobs count as units of their product, once each, ready ones noted", () => {
  const supply = jobSupply([
    [job({ jobID: 1, runs: 2 }), job({ jobID: 2, productTypeID: 102, activity: "reaction", runs: 1, status: "ready" })],
    [job({ jobID: 1, runs: 2 })],
    [job({ jobID: 3, status: "delivered" }), job({ jobID: 4, activity: "copying" })],
  ], BOOK);
  assert.deepEqual([...supply.inProduction], [[101, 2], [102, 200]]);
  assert.deepEqual([...supply.ready], [[102, 200]]);
  assert.deepEqual([...supply.inventing], []);
});

test("invention jobs count as attempts underway for the T2 blueprint they invent, until delivered", () => {
  const supply = jobSupply([[
    job({ jobID: 1, activity: "invention", blueprintTypeID: 1101, productTypeID: 1900, runs: 2 }),
    job({ jobID: 2, activity: "invention", blueprintTypeID: 1101, productTypeID: 1900, runs: 1, status: "ready" }),
    job({ jobID: 3, activity: "invention", blueprintTypeID: 1101, productTypeID: 1900, runs: 5, status: "delivered" }),
  ]], BOOK);
  assert.deepEqual([...supply.inventing], [[1900, 3]]);
  // Not units of anything: an attempt is no blueprint until it succeeds.
  assert.deepEqual([...supply.inProduction], []);
});

test("start next: stages in build order, and a step can start only with every input in hand", () => {
  const nothing = resolveIndustryChain({ book: BOOK, productTypeID: 900, runs: 4 });
  assert.ok(nothing);
  const groups = startNext(nothing);
  assert.deepEqual(groups.map((group) => group.label), ["Reactions", "Components", "Final"]);
  // Nothing is held: the reaction and the component wait on bought inputs.
  assert.deepEqual(groups.flatMap((group) => group.steps.map((step) => [step.line.typeID, step.canStart])), [
    [102, false],
    [101, false],
    [900, false],
  ]);

  const stocked = resolveIndustryChain({
    book: BOOK, productTypeID: 900, runs: 4,
    held: new Map([[34, 40], [202, 100]]),
    inProduction: new Map([[102, 200]]),
  });
  assert.ok(stocked);
  const steps = startNext(stocked).flatMap((group) => group.steps.map((step) => [step.line.typeID, step.canStart]));
  // The reaction is already running, so it is not listed; Widgets can start;
  // the final step waits for them.
  assert.deepEqual(steps, [[101, true], [900, false]]);
});

// --- where a job can start ----------------------------------------------------

const STATION_A = 60000004;
const STATION_B = 60000007;
const SYSTEM_A = 30000001;
const SYSTEM_B = 30000002;
const SCM = 24268;

const SYSTEM_OF: Readonly<Record<number, number>> = { [STATION_A]: SYSTEM_A, [STATION_B]: SYSTEM_B };

function copy(characterID: number, itemID: number, facilityID: number | null, busy = false): OwnedBlueprint {
  return {
    characterID, characterName: `Pilot ${characterID}`, itemID, blueprintTypeID: 1101, blueprintName: "Widget Blueprint",
    productTypeID: 101, original: true, runs: null, materialEfficiency: 10, timeEfficiency: 20, busy, facilityID,
    solarSystemID: facilityID === null ? null : SYSTEM_OF[facilityID] ?? 30000099,
  };
}

function hangarStack(locationID: number, holder: "hangar" | "ship" = "hangar") {
  return { typeID: 34, typeName: null, quantity: 100, locationID, locationName: null, holder, holderName: holder === "ship" ? "Hauler" : null };
}

const ALL_WORK = ["manufacturing", "reaction", "invention"];

function offering(solarSystemID: number, activities: readonly string[] = ALL_WORK) {
  return { solarSystemID, activities: new Set(activities) };
}

function pilot(overrides: Partial<InstallPilot> = {}): InstallPilot {
  return {
    characterName: "Pilot",
    solarSystemID: SYSTEM_A,
    dockedAt: STATION_A,
    skills: new Map([[SCM, 0]]),
    facilities: new Map([[STATION_A, offering(SYSTEM_A)], [STATION_B, offering(SYSTEM_B)]]),
    stock: [hangarStack(STATION_A)],
    ...overrides,
  };
}

// One Widget run: 10 Tritanium.
function widgetLine() {
  const chain = resolveIndustryChain({ book: BOOK, productTypeID: 101, runs: 1 });
  assert.ok(chain);
  const widget = chain.lines.get(101);
  assert.ok(widget);
  return widget;
}

const ONE_JUMP = (from: number, to: number) => (from === to ? 0 : 1);

test("installCheck: a copy where the pilot is docked, materials in its hangar there, can start", () => {
  const check = installCheck(widgetLine(), [copy(1, 1, STATION_A)], new Map([[1, pilot()]]), ONE_JUMP);
  assert.equal(check.ok, true);
  assert.equal(check.ok && check.from.itemID, 1);
});

test("installCheck: a copy in no facility, busy, or held by nobody online is never offered", () => {
  const notInFacility = installCheck(widgetLine(), [copy(1, 1, null)], new Map([[1, pilot()]]), ONE_JUMP);
  assert.equal(!notInFacility.ok && notInFacility.block, "not-in-facility");
  const busy = installCheck(widgetLine(), [copy(1, 1, STATION_A, true)], new Map([[1, pilot()]]), ONE_JUMP);
  assert.equal(!busy.ok && busy.block, "no-copy");
  const offline = installCheck(widgetLine(), [copy(1, 1, STATION_A)], new Map(), ONE_JUMP);
  assert.equal(!offline.ok && offline.block, "no-copy");
});

test("installCheck: range is measured to the blueprint's own system, which the facility list may not cover", () => {
  // A copy in another region: not in the (region-scoped) facility list, and
  // reported by its distance, not by the list.
  const far = installCheck(widgetLine(), [copy(1, 1, 60000099)], new Map([[1, pilot()]]), () => 12);
  assert.equal(!far.ok && far.block, "out-of-range");
  assert.equal(!far.ok && far.jumps, 12);
  // In reach, but not a facility the Industry panel lists.
  const unlisted = installCheck(widgetLine(), [copy(1, 1, 60000099)], new Map([[1, pilot({ skills: new Map([[SCM, 3]]) })]]), () => 12);
  assert.equal(!unlisted.ok && unlisted.block, "facility-not-offered");
});

test("installCheck: reach is 5 jumps per level of Supply Chain Management, level 0 meaning the same system", () => {
  const atB = { stock: [hangarStack(STATION_B)] };
  const far = installCheck(widgetLine(), [copy(1, 1, STATION_B)], new Map([[1, pilot(atB)]]), () => 6);
  assert.equal(!far.ok && far.block, "out-of-range");
  assert.equal(!far.ok && far.jumps, 6);
  assert.equal(!far.ok && far.range, 0);
  const levelOne = { ...atB, skills: new Map([[SCM, 1]]) };
  assert.equal(installCheck(widgetLine(), [copy(1, 1, STATION_B)], new Map([[1, pilot(levelOne)]]), () => 5).ok, true);
  const tooFar = installCheck(widgetLine(), [copy(1, 1, STATION_B)], new Map([[1, pilot(levelOne)]]), () => 6);
  assert.equal(!tooFar.ok && tooFar.block, "out-of-range");
  const noRoute = installCheck(widgetLine(), [copy(1, 1, STATION_B)], new Map([[1, pilot(levelOne)]]), () => null);
  assert.equal(!noRoute.ok && noRoute.block, "out-of-range");
  const unread = installCheck(widgetLine(), [copy(1, 1, STATION_A)], new Map([[1, pilot({ skills: null })]]), ONE_JUMP);
  assert.equal(!unread.ok && unread.block, "skills-unknown");
});

test("installCheck: materials must be in the pilot's own hangar where the blueprint is, not a ship or another station", () => {
  const inShip = installCheck(widgetLine(), [copy(1, 1, STATION_A)], new Map([[1, pilot({ stock: [hangarStack(STATION_A, "ship")] })]]), ONE_JUMP);
  assert.equal(!inShip.ok && inShip.block, "materials-elsewhere");
  const elsewhere = installCheck(widgetLine(), [copy(1, 1, STATION_A)], new Map([[1, pilot({ stock: [hangarStack(STATION_B)] })]]), ONE_JUMP);
  assert.equal(!elsewhere.ok && elsewhere.block, "materials-elsewhere");
});

test("installCheck: the copy where its pilot is docked is tried first, and the furthest failure is reported", () => {
  const owned = [copy(1, 1, STATION_B), copy(1, 2, STATION_A)];
  // Both copies could start (materials at both, both in reach): the docked one wins although listed second.
  const both = pilot({ stock: [hangarStack(STATION_A), hangarStack(STATION_B)], skills: new Map([[SCM, 1]]) });
  const check = installCheck(widgetLine(), owned, new Map([[1, both]]), ONE_JUMP);
  assert.equal(check.ok && check.from.itemID, 2);
  const stuck = installCheck(widgetLine(), [copy(1, 1, null), copy(1, 2, STATION_B)], new Map([[1, pilot({ stock: [] })]]), () => 0);
  assert.equal(stuck.ok, false);
  if (!stuck.ok) {
    assert.equal(stuck.block, "materials-elsewhere");
    assert.match(installBlockWords(stuck), /materials are not all in Pilot 1/);
  }
});

// --- the copy a plan is worked out with ---------------------------------------

function at(materialEfficiency: number, timeEfficiency: number, base: OwnedBlueprint): OwnedBlueprint {
  return { ...base, materialEfficiency, timeEfficiency };
}

test("plannedCopies: the best copy a job can start from, not the best owned one", () => {
  // Owned is best first: the 10% copy sits in a container (no facility).
  const owned = [at(10, 20, copy(1, 1, null)), at(0, 0, copy(1, 2, STATION_A))];
  const planned = plannedCopies(owned, new Map([[1, pilot()]]), ONE_JUMP);
  assert.equal(planned.get(1101)?.copy.itemID, 2);
  assert.equal(planned.get(1101)?.inReach, true);
});

test("plannedCopies: among copies in reach the better wins, where the pilot is docked only breaking a tie", () => {
  const skilled = pilot({ skills: new Map([[SCM, 1]]) });
  const better = plannedCopies([at(10, 20, copy(1, 1, STATION_B)), at(4, 20, copy(1, 2, STATION_A))], new Map([[1, skilled]]), ONE_JUMP);
  assert.equal(better.get(1101)?.copy.itemID, 1);
  const timeOnly = plannedCopies([at(4, 20, copy(1, 1, STATION_B)), at(4, 10, copy(1, 2, STATION_A))], new Map([[1, skilled]]), ONE_JUMP);
  assert.equal(timeOnly.get(1101)?.copy.itemID, 1);
  const tie = plannedCopies([at(4, 20, copy(1, 1, STATION_B)), at(4, 20, copy(1, 2, STATION_A))], new Map([[1, skilled]]), ONE_JUMP);
  assert.equal(tie.get(1101)?.copy.itemID, 2);
});

test("plannedCopies: with no copy in reach, the best owned one, said to be out of reach", () => {
  const owned = [at(10, 20, copy(1, 1, null)), at(0, 0, copy(1, 2, STATION_B))];
  const planned = plannedCopies(owned, new Map([[1, pilot()]]), ONE_JUMP);
  assert.equal(planned.get(1101)?.copy.itemID, 1);
  assert.equal(planned.get(1101)?.inReach, false);
  // Held by nobody online: the same.
  assert.equal(plannedCopies(owned, new Map(), ONE_JUMP).get(1101)?.inReach, false);
});

test("plannedCopies: a reaction formula's reach is Remote Reactions, not Supply Chain Management", () => {
  const owned = [copy(1, 1, STATION_B)];
  const scmOnly = new Map([[1, pilot({ skills: new Map([[SCM, 5]]) })]]);
  assert.equal(plannedCopies(owned, scmOnly, ONE_JUMP).get(1101)?.inReach, true);
  assert.equal(plannedCopies(owned, scmOnly, ONE_JUMP, new Set([1101])).get(1101)?.inReach, false);
  const reactor = new Map([[1, pilot({ skills: new Map([[45750, 1]]) })]]);
  assert.equal(plannedCopies(owned, reactor, ONE_JUMP, new Set([1101])).get(1101)?.inReach, true);
});

test("installCheck: with a planned copy, only copies at its material efficiency are tried", () => {
  const planned = at(10, 20, copy(1, 1, STATION_B));
  const docked = at(0, 0, copy(1, 2, STATION_A));
  const owned = [planned, docked];
  // Without a plan the docked copy would do; with one, its job would use other amounts.
  assert.equal(installCheck(widgetLine(), owned, new Map([[1, pilot()]]), ONE_JUMP).ok, true);
  const check = installCheck(widgetLine(), owned, new Map([[1, pilot()]]), ONE_JUMP, planned);
  assert.equal(check.ok, false);
  assert.equal(!check.ok && check.from?.itemID, 1);
  // Another copy at the same efficiency is as good as the planned one.
  const twin = at(10, 0, copy(1, 3, STATION_A));
  const same = installCheck(widgetLine(), [planned, twin], new Map([[1, pilot()]]), ONE_JUMP, planned);
  assert.equal(same.ok && same.from.itemID, 3);
});

test("installCheck: a facility that does not host the work is no place to start it", () => {
  const inventionOnly = pilot({ facilities: new Map([[STATION_A, offering(SYSTEM_A, ["invention"])]]) });
  const check = installCheck(widgetLine(), [copy(1, 1, STATION_A)], new Map([[1, inventionOnly]]), ONE_JUMP);
  assert.equal(!check.ok && check.block, "work-not-offered");
  assert.match(installBlockWords(check as Extract<typeof check, { ok: false }>), /does not offer manufacturing/);
  // And the planned copy follows: a copy there is not in reach for manufacturing.
  assert.equal(plannedCopies([copy(1, 1, STATION_A)], new Map([[1, inventionOnly]]), ONE_JUMP).get(1101)?.inReach, false);
});

// --- setting up invention -------------------------------------------------------

const DATACORE = 20418;
const SCIENTIFIC_NETWORKING = 24270;

/** Widget II invented from the Widget blueprint (1101), 1 datacore an attempt. */
function inventionRow(toStart: number, decryptor: PlanInvention["decryptor"] = null): PlanInvention {
  const source = { blueprintTypeID: 1101, blueprintName: "Widget Blueprint", runsPerCopy: 10, probability: 0.5, timeSeconds: 100,
    materials: [{ typeID: DATACORE, quantity: 1 }], skills: [] };
  // toStart copies at a certain chance: toStart attempts, none running.
  const need = inventionNeed(source, toStart, 1, decryptor);
  return { line: widgetLine(), source, copies: toStart, runsPerCopy: 10, decryptor, inventorName: "Pilot", need };
}

function t1Copy(itemID: number, runs: number | null, facilityID: number | null = STATION_A): OwnedBlueprint {
  return { ...copy(1, itemID, facilityID), original: runs === null, runs };
}

function datacores(quantity: number, locationID = STATION_A) {
  return { ...hangarStack(locationID), typeID: DATACORE, quantity };
}

test("inventionCheck: from a copy where invention is offered, with its datacores there, as many runs as attempts", () => {
  const check = inventionCheck(inventionRow(2), [t1Copy(1, 5)], new Map([[1, pilot({ stock: [datacores(2)] })]]), ONE_JUMP);
  assert.equal(check.ok, true);
  assert.equal(check.ok && check.activity, "invention");
  assert.equal(check.ok && check.runs, 2);
  assert.equal(check.ok && check.from.itemID, 1);
});

test("inventionCheck: never from an original, and no more runs than the copy carries", () => {
  const original = inventionCheck(inventionRow(2), [t1Copy(1, null)], new Map([[1, pilot({ stock: [datacores(9)] })]]), ONE_JUMP);
  assert.equal(!original.ok && original.block, "no-copy");
  assert.match(installBlockWords(original as Extract<typeof original, { ok: false }>), /invented from/);
  const short = inventionCheck(inventionRow(4), [t1Copy(1, null), t1Copy(2, 3)], new Map([[1, pilot({ stock: [datacores(9)] })]]), ONE_JUMP);
  assert.equal(short.ok && short.from.itemID, 2);
  assert.equal(short.ok && short.runs, 3);
});

test("inventionCheck: the datacores for every run must be in the hangar where the copy is", () => {
  const fewer = inventionCheck(inventionRow(3), [t1Copy(1, 5)], new Map([[1, pilot({ stock: [datacores(2)] })]]), ONE_JUMP);
  assert.equal(!fewer.ok && fewer.block, "materials-elsewhere");
  assert.match(installBlockWords(fewer as Extract<typeof fewer, { ok: false }>), /datacores/);
  const elsewhere = inventionCheck(inventionRow(1), [t1Copy(1, 5)], new Map([[1, pilot({ stock: [datacores(5, STATION_B)] })]]), ONE_JUMP);
  assert.equal(!elsewhere.ok && elsewhere.block, "materials-elsewhere");
});

test("inventionCheck: a factory with no invention is refused, and reach is Scientific Networking's", () => {
  const factory = pilot({ facilities: new Map([[STATION_A, offering(SYSTEM_A, ["manufacturing"])]]), stock: [datacores(5)] });
  const there = inventionCheck(inventionRow(1), [t1Copy(1, 5)], new Map([[1, factory]]), ONE_JUMP);
  assert.equal(!there.ok && there.block, "work-not-offered");
  assert.match(installBlockWords(there as Extract<typeof there, { ok: false }>), /does not offer invention/);
  // One jump away: Supply Chain Management does not reach it, Scientific Networking does.
  const atB = { stock: [datacores(5, STATION_B)] };
  const scm = inventionCheck(inventionRow(1), [t1Copy(1, 5, STATION_B)], new Map([[1, pilot({ ...atB, skills: new Map([[SCM, 5]]) })]]), ONE_JUMP);
  assert.equal(!scm.ok && scm.block, "out-of-range");
  assert.match(installBlockWords(scm as Extract<typeof scm, { ok: false }>), /start invention jobs only in the same system/);
  const sn = inventionCheck(inventionRow(1), [t1Copy(1, 5, STATION_B)], new Map([[1, pilot({ ...atB, skills: new Map([[SCIENTIFIC_NETWORKING, 1]]) })]]), ONE_JUMP);
  assert.equal(sn.ok, true);
});

test("inventionCheck: a plan with a decryptor cannot be set up, as the Industry panel sends none", () => {
  const parity = { typeID: 34204, name: "Parity Decryptor", probabilityMultiplier: 1.5, materialEfficiency: 1, timeEfficiency: -2, maxRuns: 3 };
  const check = inventionCheck(inventionRow(1, parity), [t1Copy(1, 5)], new Map([[1, pilot({ stock: [datacores(5), { ...datacores(5), typeID: 34204 }] })]]), ONE_JUMP);
  assert.equal(!check.ok && check.block, "needs-decryptor");
  assert.match(installBlockWords(check as Extract<typeof check, { ok: false }>), /decryptor/);
});
