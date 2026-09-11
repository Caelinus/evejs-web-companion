import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPANION_PRESET_KEYS,
  COMPANION_ROLE_PRESETS,
  presetForRole,
  remoteRepairsCanFire,
} from "./companionRolePresets.ts";
import {
  DEFAULT_FLEET_COMPANION_REQUEST,
  FLEET_COMPANION_ROLES,
  MAX_FLEE_HEALTH_FLOOR,
  MIN_FLEE_HEALTH_FLOOR,
} from "../nav/fleetCompanionLoop.ts";

test("every role has a preset, and nothing else does", () => {
  for (const role of FLEET_COMPANION_ROLES) {
    assert.ok(COMPANION_ROLE_PRESETS[role], `no preset for role ${role}`);
    assert.equal(presetForRole(role), COMPANION_ROLE_PRESETS[role]);
  }
  assert.equal(Object.keys(COMPANION_ROLE_PRESETS).length, FLEET_COMPANION_ROLES.length);
});

test("the dps preset IS the shipped default, because the default request says it is dps", () => {
  // ⚠ IF THIS EVER FAILS, THE FORM LIES ON FIRST PAINT. The panel seeds its
  // controls from DEFAULT_FLEET_COMPANION_REQUEST and its role picker starts on
  // that request's own role. A dps preset that differed would mean the form
  // changed the instant an operator touched the picker without choosing
  // anything different from what was already shown.
  assert.equal(
    COMPANION_ROLE_PRESETS.dps.fleeHealthFloor,
    DEFAULT_FLEET_COMPANION_REQUEST.fleeHealthFloor,
  );
  assert.equal(DEFAULT_FLEET_COMPANION_REQUEST.role, "dps");
});

test("no preset touches a field outside the documented fence", () => {
  // ⚠ THE FENCE IS THE FEATURE. Widening the table has to mean widening
  // COMPANION_PRESET_KEYS, which is where the reasoning against each excluded
  // field is written down. This stops a preset growing a field by eye.
  const allowed = new Set<string>(COMPANION_PRESET_KEYS);
  for (const role of FLEET_COMPANION_ROLES) {
    for (const key of Object.keys(COMPANION_ROLE_PRESETS[role])) {
      assert.ok(allowed.has(key), `preset for ${role} sets ${key}, which is not a preset key`);
    }
  }
});

test("no preset can turn tagging on, however the table is edited", () => {
  // ⚠ ONLY ONE PILOT PER SQUAD MAY TAG -- a tag is unique fleet-wide and two
  // taggers fight over letters. A role cannot know how many of itself are in
  // the squad, so this can never be a role preset no matter how convenient it
  // looks for `tackle`. Asserted against the table rather than the fence so it
  // still bites if somebody widens COMPANION_PRESET_KEYS.
  for (const role of FLEET_COMPANION_ROLES) {
    const preset = COMPANION_ROLE_PRESETS[role] as Record<string, unknown>;
    assert.equal(preset["attemptsTagging"], undefined, `${role} must not preset attemptsTagging`);
  }
});

test("no preset can spend the operator's money", () => {
  // `repairsAtStation` is opt-in, default off, by the operator's own decision:
  // nothing this loop does spends ISK unless it is asked to. Same shape of
  // guard as the tagging one above, and for the same reason.
  for (const role of FLEET_COMPANION_ROLES) {
    const preset = COMPANION_ROLE_PRESETS[role] as Record<string, unknown>;
    assert.equal(preset["repairsAtStation"], undefined, `${role} must not preset repairsAtStation`);
  }
});

test("every preset value is inside the range the panel would clamp it to", () => {
  // ⚠ THE PANEL CLAMPS ONLY AT ASSEMBLE TIME, never on input. So an
  // out-of-range preset would SHOW in the form and then be silently corrected
  // by start() -- the operator would be told one number and the pilot would fly
  // another. Every preset value must already be legal.
  for (const role of FLEET_COMPANION_ROLES) {
    const floor = COMPANION_ROLE_PRESETS[role].fleeHealthFloor;
    assert.ok(
      floor >= MIN_FLEE_HEALTH_FLOOR && floor <= MAX_FLEE_HEALTH_FLOOR,
      `${role}'s flee floor ${floor} is outside ${MIN_FLEE_HEALTH_FLOOR}..${MAX_FLEE_HEALTH_FLOOR}`,
    );
  }
});

test("a preset value survives the panel's percent round trip unchanged", () => {
  // The form holds these as whole percents and divides by 100 on assemble. A
  // preset of 0.455 would render as 46 and fly as 0.46 -- close enough to look
  // right and wrong enough to be a lie. Whole percents only.
  for (const role of FLEET_COMPANION_ROLES) {
    const floor = COMPANION_ROLE_PRESETS[role].fleeHealthFloor;
    assert.equal(
      Math.round(floor * 100) / 100,
      floor,
      `${role}'s flee floor ${floor} does not survive the panel's percent round trip`,
    );
  }
});

test("the roles do not all start from the same place", () => {
  // A preset table whose entries were identical would be machinery that does
  // nothing. This does not judge the NUMBERS -- they are a stated judgement --
  // only that picking a role changes something.
  const floors = new Set(
    FLEET_COMPANION_ROLES.map((role) => COMPANION_ROLE_PRESETS[role].fleeHealthFloor),
  );
  assert.ok(floors.size > 1, "every role presets the same flee floor; the table does nothing");
});

test("remote reps with broadcasts off is the one thing worth warning about", () => {
  const base = {
    remoteShieldModuleIDs: [] as readonly number[],
    remoteArmorModuleIDs: [] as readonly number[],
    remoteCapacitorModuleIDs: [] as readonly number[],
  };
  // Nothing fitted for the job: no warning, whatever `obeys` says. A dps pilot
  // that does not listen to broadcasts is not misconfigured.
  assert.equal(remoteRepairsCanFire({ ...base, obeys: ["tag"] }), true);
  assert.equal(remoteRepairsCanFire({ ...base, obeys: [] }), true);

  // Fitted AND listening: fine.
  assert.equal(
    remoteRepairsCanFire({ ...base, remoteArmorModuleIDs: [1], obeys: ["broadcast", "tag"] }),
    true,
  );

  // ⚠ THE REAL CASE. `decideFleetOrders` gates the whole Heal family on
  // `obeys` carrying "broadcast", so these modules can never fire.
  assert.equal(
    remoteRepairsCanFire({ ...base, remoteShieldModuleIDs: [1], obeys: ["tag"] }),
    false,
  );
  assert.equal(
    remoteRepairsCanFire({ ...base, remoteArmorModuleIDs: [1], obeys: ["tag"] }),
    false,
  );
  assert.equal(
    remoteRepairsCanFire({ ...base, remoteCapacitorModuleIDs: [1], obeys: [] }),
    false,
  );
});
