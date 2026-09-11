import test from "node:test";
import assert from "node:assert/strict";

import { validateBotLaunchGrant, createBotLaunchGrant } from "./runPolicy.ts";
import {
  analyzeCompanionRunPolicy,
  decodeCompanionAbandonmentValue,
  decodeFleetCompanionRequestValue,
} from "./companionRunPolicy.ts";
import {
  DEFAULT_FLEET_COMPANION_REQUEST,
  MAX_CAPACITOR_FLOOR,
  MAX_DRONE_HOLD_OFF_SECONDS,
  MAX_FLEE_ATTEMPTS,
  MAX_FLEE_HEALTH_FLOOR,
  MIN_CAPACITOR_FLOOR,
  MIN_DRONE_HOLD_OFF_SECONDS,
  MIN_FLEE_ATTEMPTS,
  MAX_DRONE_HEALTH_FLOOR,
  MIN_DRONE_HEALTH_FLOOR,
  MIN_FLEE_HEALTH_FLOOR,
  type FleetCompanionRequest,
} from "../nav/fleetCompanionLoop.ts";

/**
 * A complete, valid request with named overrides — same builder shape
 * `fleetCompanionLoop.test.ts` uses for observations, so a test never
 * hand-rolls a partial object and forgets a field.
 */
function request(overrides: Partial<FleetCompanionRequest> = {}): FleetCompanionRequest {
  return { ...DEFAULT_FLEET_COMPANION_REQUEST, ...overrides };
}

// A synthetic item-type id, not a real game identifier — nothing here names an
// actual character, corp, or asset.
const DEFENSE_MODULE_A = 11200001;
// Same, for a fitted weapon.
const WEAPON_MODULE_A = 11200005;
// Same, for the three SELF-repair families (one per tank layer).
const SHIELD_BOOSTER_MODULE_A = 11200006;
const ARMOR_REPAIRER_MODULE_A = 11200007;
const HULL_REPAIRER_MODULE_A = 11200008;
// The ESI docs' own example CharacterID (obviously synthetic, self-describing).
const SYNTHETIC_CHARACTER_ID = 90000001;

// ─── analyzeCompanionRunPolicy ───────────────────────────────────────────────

test("fleet and social are unconditional, even on the least capable companion", () => {
  const policy = analyzeCompanionRunPolicy(
    request({ useDrones: false, defenseModuleIDs: [], attemptsTagging: false }),
  );
  assert.deepEqual(policy.riskClasses, ["fleet", "social"]);
});

test("attemptsTagging adds nothing — fleet was already unconditional", () => {
  const withoutTag = analyzeCompanionRunPolicy(request({ attemptsTagging: false }));
  const withTag = analyzeCompanionRunPolicy(request({ attemptsTagging: true }));
  assert.deepEqual(withoutTag.riskClasses, withTag.riskClasses);
});

test("useDrones alone earns combat authority", () => {
  const policy = analyzeCompanionRunPolicy(
    request({ useDrones: true, defenseModuleIDs: [] }),
  );
  assert.deepEqual(policy.riskClasses, ["combat", "fleet", "social"]);
});

test("a fitted defensive module alone earns combat authority", () => {
  const policy = analyzeCompanionRunPolicy(
    request({ useDrones: false, defenseModuleIDs: [DEFENSE_MODULE_A] }),
  );
  assert.deepEqual(policy.riskClasses, ["combat", "fleet", "social"]);
});

test("a fitted SELF-repair module ALONE earns combat authority, one layer at a time", () => {
  // No drones, no defensive module, nothing else that fights — just one
  // self-repair module. Cycling a shield booster in a fight is fighting,
  // even though it never touches another pilot's ship.
  for (const field of [
    "shieldBoosterModuleIDs",
    "armorRepairerModuleIDs",
    "hullRepairerModuleIDs",
  ] as const) {
    const policy = analyzeCompanionRunPolicy(
      request({ useDrones: false, defenseModuleIDs: [], [field]: [11200098] }),
    );
    assert.deepEqual(policy.riskClasses, ["combat", "fleet", "social"], `${field} should earn combat`);
  }
});

test("a fitted remote-repair module ALONE earns combat authority — a logi is a participant too", () => {
  // No drones, no defensive module, nothing else that fights — just one
  // remote shield booster. The header comment says a working repairer makes
  // this pilot a participant in a fight exactly like a gunner is, and this
  // pins that for each of the three families in turn.
  for (const field of [
    "remoteShieldModuleIDs",
    "remoteArmorModuleIDs",
    "remoteCapacitorModuleIDs",
  ] as const) {
    const policy = analyzeCompanionRunPolicy(
      request({ useDrones: false, defenseModuleIDs: [], [field]: [11200099] }),
    );
    assert.deepEqual(policy.riskClasses, ["combat", "fleet", "social"], `${field} should earn combat`);
  }
});

test("a fitted weapon ALONE earns combat authority", () => {
  const policy = analyzeCompanionRunPolicy(
    request({ useDrones: false, defenseModuleIDs: [], weaponModuleIDs: [WEAPON_MODULE_A] }),
  );
  assert.deepEqual(policy.riskClasses, ["combat", "fleet", "social"]);
});

test("risk classes come out in the same stable order runPolicy.ts uses", () => {
  const policy = analyzeCompanionRunPolicy(request({ useDrones: true }));
  assert.deepEqual([...policy.riskClasses], ["combat", "fleet", "social"]);
});

test("a companion carries no macros, no restart blockers, and no sub-bots", () => {
  const policy = analyzeCompanionRunPolicy(request());
  assert.deepEqual(policy.macroIDs, []);
  assert.deepEqual(policy.restartBlockers, []);
  assert.equal(policy.containsSubBots, false);
});

test("a companion is always restart-safe — it re-reads authoritative state every tick", () => {
  const policy = analyzeCompanionRunPolicy(request({ useDrones: true, attemptsTagging: true }));
  assert.equal(policy.restartSafe, true);
});

test("financial, inventory, mission, and colony never appear", () => {
  const policy = analyzeCompanionRunPolicy(
    request({ useDrones: true, attemptsTagging: true, defenseModuleIDs: [DEFENSE_MODULE_A] }),
  );
  for (const forbidden of ["financial", "inventory", "mission", "colony", "destructive"] as const) {
    assert.ok(!policy.riskClasses.includes(forbidden));
  }
});

test("validateBotLaunchGrant works on a companion's policy unchanged", () => {
  const policy = analyzeCompanionRunPolicy(request({ useDrones: true }));
  const grant = createBotLaunchGrant(1, policy, 60);
  assert.deepEqual(validateBotLaunchGrant(grant, 1, policy), { ok: true, grant });
  assert.equal(validateBotLaunchGrant({ ...grant, riskClasses: [] }, 1, policy).ok, false);
});

// ─── decodeFleetCompanionRequestValue ────────────────────────────────────────

// Synthetic item-type ids for the three remote-repair families — as
// obviously not-a-real-item as DEFENSE_MODULE_A above.
const REMOTE_SHIELD_MODULE_A = 11200002;
const REMOTE_ARMOR_MODULE_A = 11200003;
const REMOTE_CAPACITOR_MODULE_A = 11200004;

function validPayload(): Record<string, unknown> {
  return {
    role: "dps",
    defenseModuleIDs: [DEFENSE_MODULE_A],
    shieldBoosterModuleIDs: [SHIELD_BOOSTER_MODULE_A],
    armorRepairerModuleIDs: [ARMOR_REPAIRER_MODULE_A],
    hullRepairerModuleIDs: [HULL_REPAIRER_MODULE_A],
    remoteShieldModuleIDs: [REMOTE_SHIELD_MODULE_A],
    remoteArmorModuleIDs: [REMOTE_ARMOR_MODULE_A],
    remoteCapacitorModuleIDs: [REMOTE_CAPACITOR_MODULE_A],
    weaponModuleIDs: [WEAPON_MODULE_A],
    fleeHealthFloor: 0.3,
    droneHealthFloor: 0.5,
    capacitorFloor: 0.2,
    maxFleeAttempts: 3,
    useDrones: false,
    droneRedeployHoldOffSeconds: 10,
    attemptsTagging: false,
    obeys: ["broadcast", "tag"],
    chatCommandSenders: [SYNTHETIC_CHARACTER_ID],
  };
}

test("a well-formed request round-trips", () => {
  const result = decodeFleetCompanionRequestValue(validPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.request, {
      role: "dps",
      defenseModuleIDs: [DEFENSE_MODULE_A],
      shieldBoosterModuleIDs: [SHIELD_BOOSTER_MODULE_A],
      armorRepairerModuleIDs: [ARMOR_REPAIRER_MODULE_A],
      hullRepairerModuleIDs: [HULL_REPAIRER_MODULE_A],
      remoteShieldModuleIDs: [REMOTE_SHIELD_MODULE_A],
      remoteArmorModuleIDs: [REMOTE_ARMOR_MODULE_A],
      remoteCapacitorModuleIDs: [REMOTE_CAPACITOR_MODULE_A],
      weaponModuleIDs: [WEAPON_MODULE_A],
      fleeHealthFloor: 0.3,
      droneHealthFloor: 0.5,
      capacitorFloor: 0.2,
      maxFleeAttempts: 3,
      useDrones: false,
      droneRedeployHoldOffSeconds: 10,
      attemptsTagging: false,
      obeys: ["broadcast", "tag"],
      chatCommandSenders: [SYNTHETIC_CHARACTER_ID],
      // Absent in the payload, and null is the right answer for it: "no safe
      // spot has been named" is what most requests mean, and the ladder acts
      // on it (it stops rather than inventing somewhere to hide).
      safeSpotBookmarkID: null,
      // Also absent, and false for a stronger reason than convenience: a row
      // written before this field existed was saved by an operator who was
      // never shown the choice, so it cannot be read as consent to spend ISK.
      // Leaving it out of validPayload() is what keeps that path tested.
      repairsAtStation: false,
      // Absent too, and false for the same shape of reason as both above: a row
      // written before this field existed carries eight module lists an
      // operator actually picked, so reading its absence as "go and read the
      // fit instead" would override those picks on every restart.
      deriveModulesFromFit: false,
    });
  }
});

// ─── repairsAtStation ────────────────────────────────────────────────────────

test("repairsAtStation round-trips both ways when the key IS present", () => {
  for (const value of [true, false]) {
    const result = decodeFleetCompanionRequestValue({ ...validPayload(), repairsAtStation: value });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.request.repairsAtStation, value);
    }
  }
});

test("a non-boolean repairsAtStation is refused rather than coerced", () => {
  // ⚠ INCLUDING THE TRUTHY ONES. "true" and 1 are exactly what a hand-edited
  // or half-migrated row would carry, and coercing either would turn a row
  // that never consented to spending ISK into one that does.
  for (const bad of ["true", 1, 0, null, {}, []]) {
    const result = decodeFleetCompanionRequestValue({ ...validPayload(), repairsAtStation: bad });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

test("repairsAtStation earns financial and inventory, and nothing else does", () => {
  // The claim is two-sided: the flag turns them on, and no OTHER field in the
  // request can. If something else ever earns financial, this test says so
  // rather than letting the flag quietly stop being the reason.
  const off = analyzeCompanionRunPolicy(request({ repairsAtStation: false }));
  assert.equal(off.riskClasses.includes("financial"), false);
  assert.equal(off.riskClasses.includes("inventory"), false);

  const on = analyzeCompanionRunPolicy(request({ repairsAtStation: true }));
  assert.equal(on.riskClasses.includes("financial"), true);
  assert.equal(on.riskClasses.includes("inventory"), true);
});

test("null, an array, and a primitive are all refused, not thrown", () => {
  assert.equal(decodeFleetCompanionRequestValue(null).ok, false);
  assert.equal(decodeFleetCompanionRequestValue([]).ok, false);
  assert.equal(decodeFleetCompanionRequestValue("dps").ok, false);
  assert.equal(decodeFleetCompanionRequestValue(42).ok, false);
});

test("an unknown extra key refuses the whole request", () => {
  // A stored key this codec does not recognise is a field a later version
  // wrote and this one cannot honour; running the request anyway would run a
  // request that is not the one that was saved.
  const result = decodeFleetCompanionRequestValue({
    ...validPayload(),
    anchorToFleetCommander: true,
  });
  assert.equal(result.ok, false);
});

test("safeSpotBookmarkID takes a positive id, null, or nothing at all", () => {
  // ⚠ THIS KEY USED TO BE REFUSED, and that was correct at the time — the
  // codec's whole contract is that an unrecognised key means a request this
  // version cannot honour. Phase 0b gave the request the field, so the codec
  // learned it the same day (decision 5: there is no sun to warp to, so the
  // safe spot is a bookmark).
  const withID = decodeFleetCompanionRequestValue({ ...validPayload(), safeSpotBookmarkID: 4242 });
  assert.equal(withID.ok, true);
  if (withID.ok) {
    assert.equal(withID.request.safeSpotBookmarkID, 4242);
  }
  // Explicit null and absent mean the same thing, so a request written before
  // the field existed still reads.
  const explicitNull = decodeFleetCompanionRequestValue({
    ...validPayload(),
    safeSpotBookmarkID: null,
  });
  assert.equal(explicitNull.ok, true);
  if (explicitNull.ok) {
    assert.equal(explicitNull.request.safeSpotBookmarkID, null);
  }
});

test("safeSpotBookmarkID refuses a zero, a fraction, or a string", () => {
  for (const bad of [0, -1, 1.5, "4242", {}]) {
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), safeSpotBookmarkID: bad }).ok,
      false,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

// --- the persisted abandonment (decision 5's clock) --------------------------

test("a well-formed abandonment round-trips", () => {
  const result = decodeCompanionAbandonmentValue(
    { abandonedAtMs: 1_000, supervisorCharacterIDs: [SYNTHETIC_CHARACTER_ID] },
    2_000,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.abandonment.abandonedAtMs, 1_000);
    assert.deepEqual(result.abandonment.supervisorCharacterIDs, [SYNTHETIC_CHARACTER_ID]);
  }
});

test("an EMPTY supervisor list is valid, and means 'accept nobody'", () => {
  // It is what a companion abandoned before it ever saw a human legitimately
  // has. It must not be confused with a missing field, which is refused.
  const empty = decodeCompanionAbandonmentValue(
    { abandonedAtMs: 1_000, supervisorCharacterIDs: [] },
    2_000,
  );
  assert.equal(empty.ok, true);
  assert.equal(
    decodeCompanionAbandonmentValue({ abandonedAtMs: 1_000 }, 2_000).ok,
    false,
  );
});

test("a clock in the FUTURE is refused — it would never expire", () => {
  // ⚠ The failure it would cause is the whole point of persisting it: an
  // abandonment dated an hour from now never runs out, which is exactly the
  // unbounded wait the persistence exists to prevent. A refused row starts a
  // fresh thirty minutes, which is bounded and safe.
  assert.equal(
    decodeCompanionAbandonmentValue({ abandonedAtMs: 9_000, supervisorCharacterIDs: [] }, 2_000).ok,
    false,
  );
});

test("an abandonment refuses junk rather than throwing", () => {
  for (const bad of [
    null,
    [],
    "now",
    { abandonedAtMs: 0, supervisorCharacterIDs: [] },
    { abandonedAtMs: 1.5, supervisorCharacterIDs: [] },
    { abandonedAtMs: 1_000, supervisorCharacterIDs: [0] },
    { abandonedAtMs: 1_000, supervisorCharacterIDs: "nobody" },
    { abandonedAtMs: 1_000, supervisorCharacterIDs: [], safeSpotWarpIssued: true },
  ]) {
    assert.equal(
      decodeCompanionAbandonmentValue(bad, 2_000).ok,
      false,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("an unknown role refuses", () => {
  const result = decodeFleetCompanionRequestValue({ ...validPayload(), role: "commander" });
  assert.equal(result.ok, false);
});

test("defenseModuleIDs rejects a non-positive or non-integer entry", () => {
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), defenseModuleIDs: [0] }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), defenseModuleIDs: [-1] }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), defenseModuleIDs: [1.5] }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), defenseModuleIDs: "not-an-array" }).ok,
    false,
  );
});

test("each remote-repair module list rejects a non-positive or non-integer entry, on its own", () => {
  for (const key of ["remoteShieldModuleIDs", "remoteArmorModuleIDs", "remoteCapacitorModuleIDs"] as const) {
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), [key]: [0] }).ok,
      false,
      `${key} should refuse 0`,
    );
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), [key]: [-1] }).ok,
      false,
      `${key} should refuse -1`,
    );
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), [key]: [1.5] }).ok,
      false,
      `${key} should refuse a fraction`,
    );
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), [key]: "not-an-array" }).ok,
      false,
      `${key} should refuse a non-array`,
    );
    // Empty is valid: no remote repairer fitted is a real answer.
    assert.equal(decodeFleetCompanionRequestValue({ ...validPayload(), [key]: [] }).ok, true);
  }
});

test("a request missing a remote-repair module list is refused, like defenseModuleIDs", () => {
  const payload = validPayload();
  delete payload.remoteShieldModuleIDs;
  assert.equal(decodeFleetCompanionRequestValue(payload).ok, false);
});

test("each SELF-repair module list refuses a bad entry, and an ABSENT list resumes as empty", () => {
  for (const key of ["shieldBoosterModuleIDs", "armorRepairerModuleIDs", "hullRepairerModuleIDs"] as const) {
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), [key]: [0] }).ok,
      false,
      `${key} should refuse 0`,
    );
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), [key]: [-1] }).ok,
      false,
      `${key} should refuse -1`,
    );
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), [key]: [1.5] }).ok,
      false,
      `${key} should refuse a fraction`,
    );
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), [key]: "not-an-array" }).ok,
      false,
      `${key} should refuse a non-array`,
    );
    // Empty is valid: no self-repair module fitted for that layer is a real
    // answer, and the hurt reading for it simply falls through.
    assert.equal(decodeFleetCompanionRequestValue({ ...validPayload(), [key]: [] }).ok, true);

    // ⚠ A MISSING LIST IS ACCEPTED, same rule and same reason as
    // `weaponModuleIDs` below: `src/botHost.js` puts a persisted roster row's
    // own request back through this decoder on every BFF restart, and for a
    // companion that row IS the authority. Absent decodes to empty, which is
    // what such a row already meant: nothing fitted for that layer.
    const payload = validPayload();
    delete payload[key];
    const resumed = decodeFleetCompanionRequestValue(payload);
    assert.equal(resumed.ok, true, `${key} absent should still resume`);
    assert.deepEqual(
      resumed.ok ? resumed.request[key] : null,
      [],
      `${key} should resume empty, not refused`,
    );
  }
});

test("weaponModuleIDs refuses a bad entry, and an ABSENT list resumes as empty", () => {
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), weaponModuleIDs: [0] }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), weaponModuleIDs: [-1] }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), weaponModuleIDs: [1.5] }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), weaponModuleIDs: "not-an-array" }).ok,
    false,
  );
  // Empty is valid, and the default: no weapon picked means locks, never fires.
  assert.equal(decodeFleetCompanionRequestValue({ ...validPayload(), weaponModuleIDs: [] }).ok, true);
  // ⚠ A MISSING LIST IS ACCEPTED, and unlike its neighbours that is deliberate.
  // `src/botHost.js` puts a persisted roster row's own request back through this
  // decoder on every BFF restart -- for a companion that row IS the authority,
  // there being no library entry to re-bind to. So refusing an absent field
  // would refuse every row written before the field existed, and a headless
  // companion would quietly fail to come back from a restart it used to
  // survive. Absent decodes to empty, which is what such a row already meant:
  // lock what the fleet calls, never fire. Same rule, same reason, as
  // safeSpotBookmarkID.
  const payload = validPayload();
  delete payload.weaponModuleIDs;
  const resumed = decodeFleetCompanionRequestValue(payload);
  assert.equal(resumed.ok, true, "a pre-field request still resumes");
  assert.deepEqual(resumed.ok ? resumed.request.weaponModuleIDs : null, [],
    "and it resumes holding its fire, not firing");
});

test("fleeHealthFloor and capacitorFloor are refused outside their real domain bounds", () => {
  assert.equal(
    decodeFleetCompanionRequestValue({
      ...validPayload(),
      fleeHealthFloor: MIN_FLEE_HEALTH_FLOOR - 0.01,
    }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({
      ...validPayload(),
      fleeHealthFloor: MAX_FLEE_HEALTH_FLOOR + 0.01,
    }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({
      ...validPayload(),
      capacitorFloor: MIN_CAPACITOR_FLOOR - 0.01,
    }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({
      ...validPayload(),
      capacitorFloor: MAX_CAPACITOR_FLOOR + 0.01,
    }).ok,
    false,
  );
  // The bounds are inclusive.
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), fleeHealthFloor: MIN_FLEE_HEALTH_FLOOR }).ok,
    true,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), capacitorFloor: MAX_CAPACITOR_FLOOR }).ok,
    true,
  );
});

test("fleeHealthFloor refuses NaN, Infinity, and non-numbers", () => {
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), fleeHealthFloor: Number.NaN }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), fleeHealthFloor: Number.POSITIVE_INFINITY }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), fleeHealthFloor: "0.3" }).ok,
    false,
  );
});

test("maxFleeAttempts is a bounded, positive, safe integer", () => {
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), maxFleeAttempts: MIN_FLEE_ATTEMPTS - 1 }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), maxFleeAttempts: MAX_FLEE_ATTEMPTS + 1 }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), maxFleeAttempts: 2.5 }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), maxFleeAttempts: MAX_FLEE_ATTEMPTS }).ok,
    true,
  );
});

test("useDrones and attemptsTagging refuse anything but a strict boolean", () => {
  assert.equal(decodeFleetCompanionRequestValue({ ...validPayload(), useDrones: 1 }).ok, false);
  assert.equal(decodeFleetCompanionRequestValue({ ...validPayload(), useDrones: "true" }).ok, false);
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), attemptsTagging: 0 }).ok,
    false,
  );
});

test("droneRedeployHoldOffSeconds is refused outside its real domain bounds", () => {
  assert.equal(
    decodeFleetCompanionRequestValue({
      ...validPayload(),
      droneRedeployHoldOffSeconds: MIN_DRONE_HOLD_OFF_SECONDS - 1,
    }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({
      ...validPayload(),
      droneRedeployHoldOffSeconds: MAX_DRONE_HOLD_OFF_SECONDS + 1,
    }).ok,
    false,
  );
});

test("obeys must be drawn from the known order sources", () => {
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), obeys: ["broadcast", "carrier-pigeon"] }).ok,
    false,
  );
  assert.equal(decodeFleetCompanionRequestValue({ ...validPayload(), obeys: "broadcast" }).ok, false);
  assert.equal(decodeFleetCompanionRequestValue({ ...validPayload(), obeys: [] }).ok, true);
});

test("chatCommandSenders rejects a non-positive or non-integer entry", () => {
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), chatCommandSenders: [0] }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), chatCommandSenders: [-5] }).ok,
    false,
  );
  assert.equal(decodeFleetCompanionRequestValue({ ...validPayload(), chatCommandSenders: [] }).ok, true);
});

test("a request decoded from bytes produces the same run policy as one built in memory", () => {
  const result = decodeFleetCompanionRequestValue(validPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    const policy = analyzeCompanionRunPolicy(result.request);
    // validPayload() fits one defensive module, so combat rides along too.
    assert.deepEqual(policy.riskClasses, ["combat", "fleet", "social"]);
  }
});

// ⚠ THE CLOSED KEY SET IS WHAT MAKES THIS WORTH TESTING. A request that reaches
// the bot host has crossed a process boundary and been sat in a database; the
// decoder refuses anything it does not recognise and anything out of domain,
// which is why adding droneHealthFloor broke every fixture in this file until
// they carried it. A field with no bounds test is a field that can arrive as
// 47 and have a rung quietly compare a health ratio against it.
test("droneHealthFloor is refused outside its real domain bounds", () => {
  assert.equal(
    decodeFleetCompanionRequestValue({
      ...validPayload(),
      droneHealthFloor: MIN_DRONE_HEALTH_FLOOR - 0.01,
    }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({
      ...validPayload(),
      droneHealthFloor: MAX_DRONE_HEALTH_FLOOR + 0.01,
    }).ok,
    false,
  );
  assert.equal(
    decodeFleetCompanionRequestValue({ ...validPayload(), droneHealthFloor: MIN_DRONE_HEALTH_FLOOR })
      .ok,
    true,
    "the bound itself is inside the domain",
  );
});

test("droneHealthFloor refuses NaN, Infinity, a string and an absent key", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "0.5", null]) {
    assert.equal(
      decodeFleetCompanionRequestValue({ ...validPayload(), droneHealthFloor: bad }).ok,
      false,
      String(bad),
    );
  }
  const withoutIt: Record<string, unknown> = { ...validPayload() };
  delete withoutIt.droneHealthFloor;
  assert.equal(
    decodeFleetCompanionRequestValue(withoutIt).ok,
    false,
    "a missing threshold is refused, never defaulted -- a silent default here would fly a pilot on a number nobody chose",
  );
});


test("deriving from the fit is COMBAT risk even with every module list empty", () => {
  // ⚠ THE HOLE THIS CLOSES. Every module list on a deriving request is empty,
  // so without a rule of its own such a run would be granted "fleet, social"
  // and then bolt on whatever weapons the hull turned out to carry. botHost
  // re-derives this policy and checks it matches the grant exactly -- the same
  // lie on both sides passes that check, which is precisely why the lie has to
  // be prevented here rather than caught there.
  const bare = { ...DEFAULT_FLEET_COMPANION_REQUEST, deriveModulesFromFit: true };
  assert.deepEqual([...analyzeCompanionRunPolicy(bare).riskClasses].sort(), [
    "combat",
    "fleet",
    "social",
  ]);

  const notDeriving = { ...DEFAULT_FLEET_COMPANION_REQUEST, deriveModulesFromFit: false };
  assert.ok(
    !analyzeCompanionRunPolicy(notDeriving).riskClasses.includes("combat"),
    "an empty, non-deriving request is not combat",
  );
});

test("a non-boolean deriveModulesFromFit is refused rather than coerced", () => {
  for (const bad of ["yes", 1, null, {}]) {
    const result = decodeFleetCompanionRequestValue({
      ...validPayload(),
      deriveModulesFromFit: bad,
    });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

test("deriveModulesFromFit round-trips when the key IS present", () => {
  const result = decodeFleetCompanionRequestValue({
    ...validPayload(),
    deriveModulesFromFit: true,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.request.deriveModulesFromFit, true);
  }
});
