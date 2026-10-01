// R109 slice 5: jobs against a plan.

import test from "node:test";
import assert from "node:assert/strict";

import { installBlockWords, installCheck, jobSupply, plannedCopies, startNext, type InstallPilot } from "./industryJobs.ts";
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

function pilot(overrides: Partial<InstallPilot> = {}): InstallPilot {
  return {
    characterName: "Pilot",
    solarSystemID: SYSTEM_A,
    dockedAt: STATION_A,
    skills: new Map([[SCM, 0]]),
    facilities: new Map([[STATION_A, SYSTEM_A], [STATION_B, SYSTEM_B]]),
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
