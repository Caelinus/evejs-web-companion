// Reloading from the rack (rackAmmo.ts): which slots take charges, what an
// empty gun's tap means, how cargo becomes a menu, and what "Reload all" sends.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ammoChoices,
  rackChargeBadge,
  rackReloadPercent,
  rackReloading,
  rackSlotAction,
  rackTakesCharges,
  reloadAllPlan,
  weaponGroups,
} from "./rackAmmo.ts";
import { decodeChargeLoadNotification } from "../bridge/reloadNotifications.ts";
import type { RackModule, RackRow } from "./moduleRack.ts";
import type { InventoryItemRow } from "../store/types.ts";

const LAUNCHER = 2410;
const SHIELD_BOOSTER = 10858;
const HAM_GROUP = 772;
const SCOURGE = 2629;
const INFERNO = 2621;
const LIGHT_MISSILE = 210;
const LIGHT_GROUP = 384;

const FITS = {
  [LAUNCHER]: { size: null, groups: [HAM_GROUP] },
};

function gun(
  itemID: number,
  charge: { typeID: number; quantity: number } | null = null,
  extra: Partial<RackModule> = {},
): RackModule {
  return {
    itemID,
    typeID: LAUNCHER,
    online: true,
    active: false,
    charge,
    overloaded: false,
    damage: 0,
    bankMasterID: null,
    bankMaster: false,
    bankSize: 1,
    ...extra,
  };
}

function rack(high: readonly (RackModule | null)[], mid: readonly (RackModule | null)[] = []): RackRow[] {
  return [
    { family: "high", label: "High", heat: null, slots: high.map((module) => ({ module })) },
    { family: "mid", label: "Mid", heat: null, slots: mid.map((module) => ({ module })) },
    { family: "low", label: "Low", heat: null, slots: [] },
  ];
}

function cargo(itemID: number, typeID: number, groupID: number, quantity: number): InventoryItemRow {
  return { itemID, typeID, groupID, categoryID: 8, flagID: 5, quantity, singleton: false } as InventoryItemRow;
}

test("a slot takes charges when the fit's table says so, or when something is already loaded", () => {
  assert.equal(rackTakesCharges(gun(1), FITS), true);
  assert.equal(rackTakesCharges({ ...gun(2), typeID: SHIELD_BOOSTER }, FITS), false);
  // No table entry, but a charge in it: proof enough.
  assert.equal(
    rackTakesCharges({ ...gun(3, { typeID: SCOURGE, quantity: 40 }), typeID: SHIELD_BOOSTER }, FITS),
    true,
  );
  // An unread table makes nothing a gun.
  assert.equal(rackTakesCharges(gun(4), {}), false);
});

test("⚠ an empty gun's tap opens the picker instead of a doomed activate", () => {
  assert.equal(rackSlotAction(gun(1), "activate", true, false), "load");
  // Even offline: loading is not activating.
  assert.equal(rackSlotAction(gun(1, null, { online: false }), null, true, false), "load");
});

test("a loaded gun, a reloading gun and a non-gun keep the plain tap", () => {
  assert.equal(rackSlotAction(gun(1, { typeID: SCOURGE, quantity: 40 }), "activate", true, false), "activate");
  assert.equal(rackSlotAction(gun(1), "activate", true, true), "activate", "charges are on their way");
  assert.equal(rackSlotAction(gun(1), "activate", false, false), "activate");
  assert.equal(rackSlotAction(gun(1, null, { active: true }), "deactivate", true, false), "deactivate");
});

test("cargo becomes one choice per charge type, likely fits first, stacks merged", () => {
  const rows = [
    cargo(10, LIGHT_MISSILE, LIGHT_GROUP, 500),
    cargo(11, SCOURGE, HAM_GROUP, 1000),
    cargo(12, INFERNO, HAM_GROUP, 30000),
    cargo(13, SCOURGE, HAM_GROUP, 2000),
    // Not a charge: never offered.
    { ...cargo(14, 34, 18, 100), categoryID: 4 },
  ];
  const choices = ammoChoices(LAUNCHER, rows, FITS);
  assert.deepEqual(
    choices.map((choice) => [choice.typeID, choice.quantity, choice.verdict]),
    [
      [INFERNO, 30000, true],
      [SCOURGE, 3000, true],
      [LIGHT_MISSILE, 500, false],
    ],
  );
  assert.deepEqual(choices[1]!.itemIDs, [11, 13], "every stack goes to the server");
});

test("⚠ a likely misfit is sorted last, never removed", () => {
  const choices = ammoChoices(LAUNCHER, [cargo(10, LIGHT_MISSILE, LIGHT_GROUP, 500)], FITS);
  assert.equal(choices.length, 1);
  assert.equal(choices[0]!.verdict, false);
});

test("weapon groups are the high rack's charge-taking modules, by type", () => {
  const rows = rack(
    [
      gun(1, { typeID: SCOURGE, quantity: 40 }),
      gun(2, { typeID: SCOURGE, quantity: 40 }),
      gun(3),
      { ...gun(4), typeID: SHIELD_BOOSTER },
      null,
    ],
    // Mid-rack charge takers stay out of the strip.
    [gun(5)],
  );
  const groups = weaponGroups(rows, FITS);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.modules.map((module) => module.itemID), [1, 2, 3]);
  assert.equal(groups[0]!.loaded, 2);
  assert.deepEqual(groups[0]!.chargeTypeIDs, [SCOURGE]);
  assert.equal(groups[0]!.rounds, 80);
});

test("reload all tops a group up with what most of it already uses", () => {
  const groups = weaponGroups(
    rack([
      gun(1, { typeID: SCOURGE, quantity: 10 }),
      gun(2, { typeID: SCOURGE, quantity: 40 }),
      gun(3),
      gun(4, { typeID: INFERNO, quantity: 40 }),
    ]),
    FITS,
  );
  const plan = reloadAllPlan(
    groups,
    [cargo(11, SCOURGE, HAM_GROUP, 3000), cargo(12, INFERNO, HAM_GROUP, 3000)],
    FITS,
  );
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]!.choice.typeID, SCOURGE);
  // The empty gun joins the majority; the Inferno gun keeps its choice.
  assert.deepEqual(plan.steps[0]!.moduleIDs, [1, 2, 3]);
});

test("reload all says when a group's ammunition has run out of cargo", () => {
  const groups = weaponGroups(rack([gun(1, { typeID: SCOURGE, quantity: 10 })]), FITS);
  const plan = reloadAllPlan(groups, [cargo(12, INFERNO, HAM_GROUP, 3000)], FITS);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.skipped, [{ moduleTypeID: LAUNCHER, reason: "out", chargeTypeID: SCOURGE }]);
});

test("⚠ an empty group gets only a LIKELY fit, never a guess", () => {
  const groups = weaponGroups(rack([gun(1), gun(2)]), FITS);
  const fits = reloadAllPlan(groups, [cargo(10, LIGHT_MISSILE, LIGHT_GROUP, 500), cargo(11, SCOURGE, HAM_GROUP, 99)], FITS);
  assert.equal(fits.steps[0]!.choice.typeID, SCOURGE);
  assert.deepEqual(fits.steps[0]!.moduleIDs, [1, 2]);

  const misfitOnly = reloadAllPlan(groups, [cargo(10, LIGHT_MISSILE, LIGHT_GROUP, 500)], FITS);
  assert.deepEqual(misfitOnly.steps, []);
  assert.equal(misfitOnly.skipped[0]!.reason, "choose");
});

test("the badge counts rounds, shortens big stacks, and reads 0 when empty", () => {
  assert.equal(rackChargeBadge(gun(1)), "0");
  assert.equal(rackChargeBadge(gun(1, { typeID: SCOURGE, quantity: 40 })), "40");
  assert.equal(rackChargeBadge(gun(1, { typeID: SCOURGE, quantity: -1 })), "1");
  assert.equal(rackChargeBadge(gun(1, { typeID: SCOURGE, quantity: 12500 })), "12k");
});

test("a reload runs from its announcement for the reload time it gave", () => {
  const reload = { chargeTypeID: SCOURGE, startedAtMs: 1000, durationMs: 10000 };
  assert.equal(rackReloading(reload, 1000), true);
  assert.equal(rackReloadPercent(reload, 6000), 50);
  assert.equal(rackReloading(reload, 11000), false);
  assert.equal(rackReloadPercent(reload, 11000), null);
  assert.equal(rackReloading(undefined, 0), false);
});

test("OnChargeBeingLoadedToModule decodes in either list shape", () => {
  assert.deepEqual(
    decodeChargeLoadNotification("OnChargeBeingLoadedToModule", [{ type: "list", items: [11, 12] }, SCOURGE, 10000]),
    { moduleIDs: [11, 12], chargeTypeID: SCOURGE, durationMs: 10000 },
  );
  assert.deepEqual(
    decodeChargeLoadNotification("OnChargeBeingLoadedToModule", [[{ type: "long", value: "13" }], null, 5000]),
    { moduleIDs: [13], chargeTypeID: null, durationMs: 5000 },
  );
  assert.equal(decodeChargeLoadNotification("OnChargeBeingLoadedToModule", [[], SCOURGE, 10000]), null);
  assert.equal(decodeChargeLoadNotification("OnChargeBeingLoadedToModule", [[11], SCOURGE, 0]), null);
  assert.equal(decodeChargeLoadNotification("OnTarget", [[11], SCOURGE, 10000]), null);
});
