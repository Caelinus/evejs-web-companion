import test from "node:test";
import assert from "node:assert/strict";

import {
  companionFitWarnings,
  requestForFit,
  type CompanionFitFacts,
  type CompanionFitModule,
} from "./companionFitCheck.ts";
import { DEFAULT_FLEET_COMPANION_REQUEST } from "../nav/fleetCompanionLoop.ts";

// Obviously synthetic ids throughout. 90000001-and-up mirrors ESI's own
// documented example CharacterID; the module ids below are the same family.
const GUN_A = 90000101;
const GUN_B = 90000102;
const HARDENER = 90000103;
const REMOTE_ARMOR = 90000104;

function module(over: Partial<CompanionFitModule> & { itemID: number }): CompanionFitModule {
  return { typeID: 90000900, hasCharge: true, takesCharge: true, ...over };
}

function facts(over: Partial<CompanionFitFacts> = {}): CompanionFitFacts {
  return {
    defenseModuleIDs: [HARDENER],
    shieldBoosterModuleIDs: [],
    armorRepairerModuleIDs: [],
    hullRepairerModuleIDs: [],
    remoteShieldModuleIDs: [],
    remoteArmorModuleIDs: [],
    remoteCapacitorModuleIDs: [],
    weaponModuleIDs: [GUN_A],
    modules: [module({ itemID: HARDENER, takesCharge: false }), module({ itemID: GUN_A })],
    droneBay: null,
    fitReadable: true,
    ...over,
  };
}

const DERIVING = { ...DEFAULT_FLEET_COMPANION_REQUEST, deriveModulesFromFit: true };

// --- requestForFit ----------------------------------------------------------

test("a request that does not derive is handed back untouched", () => {
  const picked = {
    ...DEFAULT_FLEET_COMPANION_REQUEST,
    weaponModuleIDs: [GUN_B],
    deriveModulesFromFit: false,
  };
  assert.equal(requestForFit(picked, facts()), picked, "same object, nothing rewritten");
});

test("a deriving request takes the hull's lists", () => {
  const flown = requestForFit(DERIVING, facts());
  assert.deepEqual(flown.weaponModuleIDs, [GUN_A]);
  assert.deepEqual(flown.defenseModuleIDs, [HARDENER]);
});

test("deriving keeps every setting that is not read off the fit", () => {
  // ⚠ THE POINT OF THE SPLIT. A squad stores thresholds and toggles; only the
  // eight module lists come from the hull. A derive that reset a flee floor or
  // an obeys list would be throwing away the operator's actual configuration.
  const configured = {
    ...DERIVING,
    fleeHealthFloor: 0.45,
    maxFleeAttempts: 7,
    useDrones: true,
    attemptsTagging: true,
    repairsAtStation: true,
    obeys: ["broadcast"] as const,
    safeSpotBookmarkID: 90000500,
  };
  const flown = requestForFit(configured, facts());
  assert.equal(flown.fleeHealthFloor, 0.45);
  assert.equal(flown.maxFleeAttempts, 7);
  assert.equal(flown.useDrones, true);
  assert.equal(flown.attemptsTagging, true);
  assert.equal(flown.repairsAtStation, true);
  assert.deepEqual(flown.obeys, ["broadcast"]);
  assert.equal(flown.safeSpotBookmarkID, 90000500);
  assert.equal(flown.deriveModulesFromFit, true);
});

// --- the warnings -----------------------------------------------------------

test("an unreadable fit says NOTHING, rather than everything", () => {
  // ⚠ FAIL SILENT, NOT LOUD. A fit that could not be read would otherwise
  // report every list as empty and every gun as unloaded. A readout that cries
  // wolf on an unreadable fit teaches an operator to ignore it, and the one
  // time it is right is the time they ignore it too.
  const blind = facts({
    fitReadable: false,
    defenseModuleIDs: [],
    shieldBoosterModuleIDs: [],
    armorRepairerModuleIDs: [],
    hullRepairerModuleIDs: [],
    weaponModuleIDs: [],
    modules: [],
    droneBay: [],
  });
  assert.deepEqual(companionFitWarnings({ ...DERIVING, useDrones: true }, blind), []);
});

test("a gun with nothing in it is worth saying, once per count", () => {
  const one = companionFitWarnings(
    DERIVING,
    facts({ modules: [module({ itemID: GUN_A, hasCharge: false })] }),
  );
  assert.equal(one.length, 1);
  assert.match(one[0]!, /One weapon has nothing loaded/);

  const two = companionFitWarnings(
    DERIVING,
    facts({
      weaponModuleIDs: [GUN_A, GUN_B],
      modules: [
        module({ itemID: GUN_A, hasCharge: false }),
        module({ itemID: GUN_B, hasCharge: false }),
      ],
    }),
  );
  assert.match(two[0]!, /2 weapons have nothing loaded/);
});

test("a module that takes no charge is never reported as missing one", () => {
  // A hardener has nowhere to load anything. Reporting it would be noise, and
  // noise is how a real warning gets ignored.
  const quiet = companionFitWarnings(
    DERIVING,
    facts({ modules: [module({ itemID: HARDENER, takesCharge: false, hasCharge: false })] }),
  );
  assert.deepEqual(quiet, []);
});

test("a module whose charge data could not be read is not reported either", () => {
  // ⚠ THE THIRD STATE EARNS ITS KEEP HERE. `chargeFits` is empty both for a
  // module that takes no charge and for a fit whose charge data is missing, so
  // `takesCharge: null` must be treated as "cannot say", never as "yes".
  const unknown = companionFitWarnings(
    DERIVING,
    facts({ modules: [module({ itemID: GUN_A, takesCharge: null, hasCharge: false })] }),
  );
  assert.deepEqual(unknown, []);
});

test("an empty drone bay only matters to a pilot that uses drones", () => {
  const usingDrones = { ...DERIVING, useDrones: true };
  const empty = facts({ droneBay: [] });
  assert.ok(
    companionFitWarnings(usingDrones, empty).some((line) => /drone bay is empty/i.test(line)),
  );

  // Same empty bay, a pilot that never asked for drones: not a fault.
  assert.ok(
    !companionFitWarnings(DERIVING, empty).some((line) => /drone bay/i.test(line)),
    "a ship without drones doing something else is not misconfigured",
  );

  // ⚠ NULL IS UNREADABLE, NOT EMPTY -- the distinction decodeDroneBay is built
  // around. An unread bay must not be reported as an empty one.
  assert.ok(
    !companionFitWarnings(usingDrones, facts({ droneBay: null })).some((line) =>
      /drone bay/i.test(line),
    ),
  );
});

test("a ship with nothing that defends it says so, but only when deriving", () => {
  const naked = facts({
    defenseModuleIDs: [],
    shieldBoosterModuleIDs: [],
    armorRepairerModuleIDs: [],
    hullRepairerModuleIDs: [],
    modules: [module({ itemID: GUN_A })],
  });
  assert.ok(
    companionFitWarnings(DERIVING, naked).some((line) => /Nothing on this ship defends it/.test(line)),
  );

  // An operator who picked by hand and ticked nothing defensive chose that; the
  // panel already says "nothing is ticked for you" over every one of those
  // lists. Second-guessing it here would nag on a deliberate setup.
  const picked = { ...DEFAULT_FLEET_COMPANION_REQUEST, deriveModulesFromFit: false };
  assert.ok(!companionFitWarnings(picked, naked).some((line) => /defends it/.test(line)));
});

test("warnings judge the modules this run will CYCLE, not the whole fit", () => {
  // A hand-picked run flies its own lists. An unloaded gun the operator did not
  // pick is not this run's problem -- and warning about it would bury the ones
  // that are.
  const picked = {
    ...DEFAULT_FLEET_COMPANION_REQUEST,
    weaponModuleIDs: [GUN_A],
    deriveModulesFromFit: false,
  };
  const fit = facts({
    weaponModuleIDs: [GUN_A, GUN_B],
    modules: [module({ itemID: GUN_A }), module({ itemID: GUN_B, hasCharge: false })],
  });
  assert.deepEqual(companionFitWarnings(picked, fit), [], "GUN_B is not in this run's list");

  // The same fit, derived: now GUN_B IS being cycled, so it counts.
  assert.ok(
    companionFitWarnings(DERIVING, fit).some((line) => /One weapon has nothing loaded/.test(line)),
  );
});

test("a remote repairer with no charge reads as a module, not as a weapon", () => {
  const logi = companionFitWarnings(
    DERIVING,
    facts({
      weaponModuleIDs: [],
      remoteArmorModuleIDs: [REMOTE_ARMOR],
      modules: [
        module({ itemID: HARDENER, takesCharge: false }),
        module({ itemID: REMOTE_ARMOR, hasCharge: false }),
      ],
    }),
  );
  assert.equal(logi.length, 1);
  assert.match(logi[0]!, /One fitted module has nothing loaded/);
  assert.doesNotMatch(logi[0]!, /weapon/i);
});

test("every warning is plain ASCII", () => {
  // Player-facing, so the repo's plain-ASCII rule applies. Gathered from a fit
  // that trips every branch at once.
  const everything = companionFitWarnings(
    { ...DERIVING, useDrones: true },
    facts({
      defenseModuleIDs: [],
      shieldBoosterModuleIDs: [],
      armorRepairerModuleIDs: [],
      hullRepairerModuleIDs: [],
      weaponModuleIDs: [GUN_A, GUN_B],
      remoteArmorModuleIDs: [REMOTE_ARMOR],
      modules: [
        module({ itemID: GUN_A, hasCharge: false }),
        module({ itemID: GUN_B, hasCharge: false }),
        module({ itemID: REMOTE_ARMOR, hasCharge: false }),
      ],
      droneBay: [],
    }),
  );
  assert.ok(everything.length >= 3, "this fixture should trip several branches");
  for (const line of everything) {
    const offenders = [...line].filter((ch) => (ch.codePointAt(0) ?? 0) > 127);
    assert.deepEqual(offenders, [], `non-ASCII in: ${line}`);
  }
});
