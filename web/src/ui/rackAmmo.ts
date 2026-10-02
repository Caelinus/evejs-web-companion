// Reloading from the HUD rack: which slots take charges, what in cargo could go
// into them, and what "Reload all" would do. Pure model, kept out of the
// .svelte file for the same reason moduleRack.ts is.
//
// ⚠ EVERY COMPATIBILITY VERDICT HERE IS ADVISORY. It comes from the fit's
// `chargeFits` table, which sorts the choices and never removes one: the
// SERVER decides what loads (see `chargeVerdict` below). The one place a
// verdict gates anything is "Reload all" choosing a charge for an EMPTY gun,
// because there nobody picked, and loading a guess into six launchers at once
// is a decision the player did not make.

import { isChargeRow } from "../bridge/fitting.ts";
import type { ChargeFitment } from "../bridge/fitting.ts";
import type { InventoryItemRow, ModuleReload } from "../store/types.ts";
import type { RackModule, RackRow } from "./moduleRack.ts";

type ChargeFits = Readonly<Record<number, ChargeFitment>>;

/**
 * Whether a slot takes charges at all — a launcher, a turret, a mining laser,
 * a module that runs scripts.
 *
 * Something already loaded proves it. Otherwise the fit's own charge-group
 * table answers; a module with no entry there is treated as one that takes
 * nothing, so an unread table makes the rack behave exactly as it did before
 * any of this existed rather than offering ammunition to a shield booster.
 */
export function rackTakesCharges(module: RackModule, chargeFits: ChargeFits): boolean {
  return module.charge !== null || (chargeFits[module.typeID]?.groups.length ?? 0) > 0;
}

/** A reload is running on this module right now, by the server's own announcement. */
export function rackReloading(
  reload: ModuleReload | undefined,
  nowMs: number,
): boolean {
  return reload !== undefined && nowMs < reload.startedAtMs + reload.durationMs;
}

/** How far through its reload a module is, 0-100, or null when none is running. */
export function rackReloadPercent(reload: ModuleReload | undefined, nowMs: number): number | null {
  if (!reload || !rackReloading(reload, nowMs) || !(reload.durationMs > 0)) {
    return null;
  }
  const elapsed = Math.max(0, nowMs - reload.startedAtMs);
  return Math.max(0, Math.min(100, Math.round((elapsed / reload.durationMs) * 100)));
}

/** What a tap on a slot means once reloading is in the picture. */
export type RackSlotAction = "activate" | "deactivate" | "load" | null;

/**
 * The tap decision with charges in it.
 *
 * ⚠ AN EMPTY GUN OPENS THE PICKER INSTEAD OF FIRING. Activating a weapon with
 * nothing in it is a call the server is certain to refuse ("That module has no
 * ammunition loaded"), so the tap does the thing the player was about to have
 * to do next. A gun that is RELOADING is not empty in that sense: its charges
 * are on their way, and the tap stays the plain activate it always was.
 *
 * `base` is moduleRack's own click decision, which this only ever overrides
 * for the empty case — an offline empty gun can still be loaded, which is why
 * the override does not wait for `base` to be non-null.
 */
export function rackSlotAction(
  module: RackModule,
  base: "activate" | "deactivate" | null,
  takesCharges: boolean,
  reloading: boolean,
): RackSlotAction {
  if (takesCharges && module.charge === null && !module.active && !reloading) {
    return "load";
  }
  return base;
}

/** One kind of charge in cargo, every stack of it merged. */
export interface AmmoChoice {
  readonly typeID: number;
  /**
   * Every cargo stack of this type. The server fills from the stacks it is
   * handed, so naming all of them lets one load drain several part-stacks.
   */
  readonly itemIDs: readonly number[];
  readonly quantity: number;
  /** true likely fits, false likely does not, null cannot say. */
  readonly verdict: boolean | null;
}

/**
 * Whether a charge looks like it fits a module.
 *
 * ⚠ NOT `chargeLooksCompatible`, ON ONE POINT. That function reads a module
 * with no charge size as "cannot say" — but a missile launcher HAS no
 * chargeSize attribute (launchers take their charges by group alone), so every
 * missile came back unjudged and "Reload all" could never pick for an empty
 * launcher. Here a module whose table entry has groups but no size is a module
 * with no size rule, and a group match is a fit. A charge whose own size is
 * unknown, against a module that has one, is still "cannot say".
 */
function chargeVerdict(
  fitment: ChargeFitment | undefined,
  chargeGroupID: number | null,
  chargeSize: number | null,
): boolean | null {
  if (!fitment || fitment.groups.length === 0 || chargeGroupID === null) {
    return null;
  }
  if (!fitment.groups.includes(chargeGroupID)) {
    return false;
  }
  if (fitment.size === null) {
    return true;
  }
  return chargeSize === null ? null : fitment.size === chargeSize;
}

/** A stack count: a singleton charge reports -1, and that is one charge. */
function countOf(row: InventoryItemRow): number {
  return row.quantity > 0 ? row.quantity : 1;
}

/**
 * The charges in cargo, merged by type, likely fits first.
 *
 * `moduleTypeID` null gives the list unjudged (every verdict null), for a
 * place that loads into several module types at once.
 */
export function ammoChoices(
  moduleTypeID: number | null,
  cargoRows: readonly InventoryItemRow[],
  chargeFits: ChargeFits,
): readonly AmmoChoice[] {
  const fitment = moduleTypeID === null ? undefined : chargeFits[moduleTypeID];
  const byType = new Map<number, { itemIDs: number[]; quantity: number; groupID: number | null }>();
  for (const row of cargoRows) {
    if (!isChargeRow(row.categoryID)) {
      continue;
    }
    const entry = byType.get(row.typeID);
    if (entry) {
      entry.itemIDs.push(row.itemID);
      entry.quantity += countOf(row);
    } else {
      byType.set(row.typeID, { itemIDs: [row.itemID], quantity: countOf(row), groupID: row.groupID });
    }
  }
  const rank = (verdict: boolean | null): number => (verdict === true ? 0 : verdict === null ? 1 : 2);
  return [...byType.entries()]
    .map(([typeID, entry]) => ({
      typeID,
      itemIDs: entry.itemIDs,
      quantity: entry.quantity,
      verdict:
        moduleTypeID === null
          ? null
          : chargeVerdict(fitment, entry.groupID, chargeFits[typeID]?.size ?? null),
    }))
    .sort((left, right) => rank(left.verdict) - rank(right.verdict) || right.quantity - left.quantity);
}

/** The guns of one type in the high rack, taken together. */
export interface WeaponGroup {
  readonly moduleTypeID: number;
  readonly modules: readonly RackModule[];
  /** How many of them hold any charge at all. */
  readonly loaded: number;
  /** Every charge type loaded across them, most-loaded first. Two or more is a mixed load. */
  readonly chargeTypeIDs: readonly number[];
  /** Rounds held across the group. */
  readonly rounds: number;
}

/**
 * The high rack's charge-taking modules, one group per module type, in rack
 * order.
 *
 * ⚠ HIGH RACK ONLY. Mid-slot modules can take charges too — scripts, cap
 * boosters — but a script is optional and a missing one is not a gun that
 * cannot fire; listing every sensor booster as "empty" would bury the one line
 * a pilot actually needs. Those still load from their own slot's menu.
 */
export function weaponGroups(rows: readonly RackRow[], chargeFits: ChargeFits): readonly WeaponGroup[] {
  const high = rows.find((row) => row.family === "high");
  const order: number[] = [];
  const byType = new Map<number, RackModule[]>();
  for (const slot of high?.slots ?? []) {
    const module = slot.module;
    if (!module || !rackTakesCharges(module, chargeFits)) {
      continue;
    }
    if (!byType.has(module.typeID)) {
      byType.set(module.typeID, []);
      order.push(module.typeID);
    }
    byType.get(module.typeID)!.push(module);
  }
  return order.map((moduleTypeID) => {
    const modules = byType.get(moduleTypeID)!;
    const heldByType = new Map<number, number>();
    let rounds = 0;
    for (const module of modules) {
      if (module.charge) {
        heldByType.set(module.charge.typeID, (heldByType.get(module.charge.typeID) ?? 0) + 1);
        rounds += module.charge.quantity > 0 ? module.charge.quantity : 1;
      }
    }
    return {
      moduleTypeID,
      modules,
      loaded: modules.filter((module) => module.charge !== null).length,
      chargeTypeIDs: [...heldByType.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([typeID]) => typeID),
      rounds,
    };
  });
}

/** One load "Reload all" will send. */
export interface ReloadStep {
  readonly moduleTypeID: number;
  readonly moduleIDs: readonly number[];
  readonly choice: AmmoChoice;
}

/** A group "Reload all" left alone, and why. */
export interface ReloadSkip {
  readonly moduleTypeID: number;
  /**
   * `out`: what these guns use is not in cargo. `choose`: they are empty and
   * nothing in cargo is known to fit, so the pilot has to pick.
   */
  readonly reason: "out" | "choose";
  /** The charge type they were using, for `out`. */
  readonly chargeTypeID: number | null;
}

/**
 * What "Reload all" does — the retail Ctrl+R, which tops every gun up with
 * what it already uses.
 *
 * A group keeps its own ammunition: the type most of its guns hold is the one
 * reloaded, and the guns holding something else are left out of that load
 * rather than having their choice overwritten. An EMPTY group gets the best
 * likely fit from cargo, and only a likely one — see the file comment.
 */
export function reloadAllPlan(
  groups: readonly WeaponGroup[],
  cargoRows: readonly InventoryItemRow[],
  chargeFits: ChargeFits,
): { readonly steps: readonly ReloadStep[]; readonly skipped: readonly ReloadSkip[] } {
  const steps: ReloadStep[] = [];
  const skipped: ReloadSkip[] = [];
  for (const group of groups) {
    const choices = ammoChoices(group.moduleTypeID, cargoRows, chargeFits);
    const using = group.chargeTypeIDs[0] ?? null;
    if (using !== null) {
      const choice = choices.find((entry) => entry.typeID === using);
      if (!choice) {
        skipped.push({ moduleTypeID: group.moduleTypeID, reason: "out", chargeTypeID: using });
        continue;
      }
      steps.push({
        moduleTypeID: group.moduleTypeID,
        // The empty guns join the majority; a gun holding another type keeps it.
        moduleIDs: group.modules
          .filter((module) => module.charge === null || module.charge.typeID === using)
          .map((module) => module.itemID),
        choice,
      });
      continue;
    }
    const choice = choices.find((entry) => entry.verdict === true);
    if (!choice) {
      skipped.push({ moduleTypeID: group.moduleTypeID, reason: "choose", chargeTypeID: null });
      continue;
    }
    steps.push({
      moduleTypeID: group.moduleTypeID,
      moduleIDs: group.modules.map((module) => module.itemID),
      choice,
    });
  }
  return { steps, skipped };
}

/** The badge on a charge-taking slot: rounds held, with a singleton as one. */
export function rackChargeBadge(module: RackModule): string {
  if (!module.charge) {
    return "0";
  }
  const count = module.charge.quantity > 0 ? module.charge.quantity : 1;
  return count >= 10_000 ? `${Math.floor(count / 1000)}k` : String(count);
}
