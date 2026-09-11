// Fleet companion — reading the ship it is actually in, and saying what is
// missing before it flies.
//
// ⚠ WHY THIS EXISTS AT ALL: A SQUAD HAS NOBODY TO ASK. Every module list on a
// `FleetCompanionRequest` is an `itemID` of one particular fitted module on one
// particular hull, picked by an operator looking at that ship in the fitting
// panel. A squad start has no such operator -- the pilots are not mounted,
// nobody can see their fits, and a list saved earlier would be stale the moment
// that pilot refits or swaps hull. So a squad stores settings, and the bot
// host, which HAS signed the pilot in and CAN read the fit, fills the lists in
// here. Nothing about a fit is ever saved.
//
// ⚠ THE WARNINGS ARE ADVISORY AND MUST STAY THAT WAY. The operator's own words:
// warn, and let a human either load the missing thing or ignore it and fly.
// Nothing in this module refuses a start. A blocking check here would ground a
// squad over one empty ammo bay.
//
// ⚠ EVERY CHECK FAILS SILENT RATHER THAN LOUD. A fit that cannot be read
// produces NO warnings, not a warning about everything: this module only ever
// speaks when it is confident, because a readout that cries wolf on an
// unreadable fit teaches an operator to ignore it -- and the one time it is
// right is the time they will ignore it too.
//
// PURE. No store, no I/O. The caller hands it plain data read elsewhere.

import type { FleetCompanionRequest } from "../nav/fleetCompanionLoop.ts";

/** One module as the classifier judged it, with what it is carrying. */
export interface CompanionFitModule {
  readonly itemID: number;
  readonly typeID: number;
  /** Whether anything is loaded: ammunition, or a script. Same field on the wire. */
  readonly hasCharge: boolean;
  /**
   * Whether this module has somewhere to load a charge at all.
   *
   * ⚠ THREE-STATE, AND THE THIRD IS WHY. `chargeFits` is `{}` both for a module
   * that takes no charge AND for a fit whose charge data could not be read --
   * `decodeChargeFits`'s own comment says so. Null keeps those apart from a
   * confident "this takes a charge", so an unreadable fit stays quiet instead
   * of reporting every module as missing ammunition.
   */
  readonly takesCharge: boolean | null;
}

/** What the ship turned out to be carrying, and what the classifier made of it. */
export interface CompanionFitFacts {
  /** The eight lists, as derived from the hull. */
  readonly defenseModuleIDs: readonly number[];
  readonly shieldBoosterModuleIDs: readonly number[];
  readonly armorRepairerModuleIDs: readonly number[];
  readonly hullRepairerModuleIDs: readonly number[];
  readonly remoteShieldModuleIDs: readonly number[];
  readonly remoteArmorModuleIDs: readonly number[];
  readonly remoteCapacitorModuleIDs: readonly number[];
  readonly weaponModuleIDs: readonly number[];
  /** Every online module the fit carries, for the charge checks. */
  readonly modules: readonly CompanionFitModule[];
  /**
   * Drones in the bay.
   *
   * ⚠ NULL IS UNREADABLE AND `[]` IS CONFIDENTLY EMPTY, which is the same
   * distinction `decodeDroneBay` is built around and states in its own header.
   * Only the empty array is worth warning about.
   */
  readonly droneBay: readonly { readonly quantity: number }[] | null;
  /** False when the fit itself could not be read; nothing is judged then. */
  readonly fitReadable: boolean;
}

/**
 * The request this pilot will actually fly, with the eight lists filled in from
 * the hull.
 *
 * ⚠ IT REPLACES THE LISTS RATHER THAN MERGING THEM. A deriving request's lists
 * are empty by construction, but if one ever were not, the hull is still the
 * authority -- the whole point is that the saved value cannot be trusted to
 * describe the ship in front of us. Everything that is NOT read off the fit
 * (thresholds, toggles, obeys, the safe spot) is kept exactly as configured.
 */
export function requestForFit(
  request: FleetCompanionRequest,
  facts: CompanionFitFacts,
): FleetCompanionRequest {
  if (!request.deriveModulesFromFit) {
    return request;
  }
  return {
    ...request,
    defenseModuleIDs: [...facts.defenseModuleIDs],
    shieldBoosterModuleIDs: [...facts.shieldBoosterModuleIDs],
    armorRepairerModuleIDs: [...facts.armorRepairerModuleIDs],
    hullRepairerModuleIDs: [...facts.hullRepairerModuleIDs],
    remoteShieldModuleIDs: [...facts.remoteShieldModuleIDs],
    remoteArmorModuleIDs: [...facts.remoteArmorModuleIDs],
    remoteCapacitorModuleIDs: [...facts.remoteCapacitorModuleIDs],
    weaponModuleIDs: [...facts.weaponModuleIDs],
  };
}

/**
 * What is missing or unusable about this pilot's fit, in the player's words.
 *
 * Empty means nothing worth saying -- which is also what an unreadable fit
 * gives, deliberately (see the header).
 */
export function companionFitWarnings(
  request: FleetCompanionRequest,
  facts: CompanionFitFacts,
): readonly string[] {
  if (!facts.fitReadable) {
    return [];
  }
  const warnings: string[] = [];
  const byID = new Map(facts.modules.map((module) => [module.itemID, module]));

  // ⚠ JUDGED AGAINST THE LISTS THIS RUN WILL ACTUALLY FLY, not against the
  // whole fit. A module the companion was never going to cycle is not this
  // pilot's problem, and warning about it would bury the ones that are.
  const flying = modulesThisRunWillCycle(request, facts);

  const unloaded = (ids: readonly number[]): number =>
    ids.filter((id) => {
      const module = byID.get(id);
      return module !== undefined && module.takesCharge === true && !module.hasCharge;
    }).length;

  const gunsUnloaded = unloaded(flying.weaponModuleIDs);
  if (gunsUnloaded > 0) {
    warnings.push(
      gunsUnloaded === 1
        ? "One weapon has nothing loaded. It will not fire until you load it."
        : `${gunsUnloaded} weapons have nothing loaded. They will not fire until you load them.`,
    );
  }

  // Everything that is not a weapon but still wants something in it: a script
  // in a tracking computer, a charge in an ancillary repairer. Counted together
  // because the fit read cannot tell a script from a round -- they are the same
  // field on the wire -- so naming one would be a guess.
  const others = [
    ...flying.defenseModuleIDs,
    ...flying.shieldBoosterModuleIDs,
    ...flying.armorRepairerModuleIDs,
    ...flying.hullRepairerModuleIDs,
    ...flying.remoteShieldModuleIDs,
    ...flying.remoteArmorModuleIDs,
    ...flying.remoteCapacitorModuleIDs,
  ];
  const othersUnloaded = unloaded(others);
  if (othersUnloaded > 0) {
    warnings.push(
      othersUnloaded === 1
        ? "One fitted module has nothing loaded in it - it may want a script or a charge."
        : `${othersUnloaded} fitted modules have nothing loaded in them - they may want scripts or charges.`,
    );
  }

  // ⚠ ONLY WHEN THIS RUN ACTUALLY USES DRONES. An empty drone bay on a pilot
  // whose operator never ticked drones is not a fault, it is a ship without
  // drones doing something else.
  if (request.useDrones && facts.droneBay !== null) {
    const carried = facts.droneBay.reduce((total, stack) => total + stack.quantity, 0);
    if (carried === 0) {
      warnings.push("The drone bay is empty, and this pilot is set to use drones.");
    }
  }

  if (
    request.deriveModulesFromFit &&
    facts.defenseModuleIDs.length === 0 &&
    facts.shieldBoosterModuleIDs.length === 0 &&
    facts.armorRepairerModuleIDs.length === 0 &&
    facts.hullRepairerModuleIDs.length === 0
  ) {
    warnings.push("Nothing on this ship defends it - no hardener and no repairer was found.");
  }

  return warnings;
}

/** Just the eight lists this run will actually cycle: the hull's, or the operator's. */
interface ModulesInPlay {
  readonly weaponModuleIDs: readonly number[];
  readonly defenseModuleIDs: readonly number[];
  readonly shieldBoosterModuleIDs: readonly number[];
  readonly armorRepairerModuleIDs: readonly number[];
  readonly hullRepairerModuleIDs: readonly number[];
  readonly remoteShieldModuleIDs: readonly number[];
  readonly remoteArmorModuleIDs: readonly number[];
  readonly remoteCapacitorModuleIDs: readonly number[];
}

function modulesThisRunWillCycle(
  request: FleetCompanionRequest,
  facts: CompanionFitFacts,
): ModulesInPlay {
  return request.deriveModulesFromFit ? facts : request;
}
