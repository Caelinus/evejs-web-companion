import test from "node:test";
import assert from "node:assert/strict";

import { validateBotLaunchGrant, createBotLaunchGrant } from "./runPolicy.ts";
import { analyzeCompanionRunPolicy, decodeFleetCompanionRequestValue } from "./companionRunPolicy.ts";
import {
  DEFAULT_FLEET_COMPANION_REQUEST,
  MAX_CAPACITOR_FLOOR,
  MAX_DRONE_HOLD_OFF_SECONDS,
  MAX_FLEE_ATTEMPTS,
  MAX_FLEE_HEALTH_FLOOR,
  MIN_CAPACITOR_FLOOR,
  MIN_DRONE_HOLD_OFF_SECONDS,
  MIN_FLEE_ATTEMPTS,
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

function validPayload(): Record<string, unknown> {
  return {
    role: "dps",
    defenseModuleIDs: [DEFENSE_MODULE_A],
    fleeHealthFloor: 0.3,
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
      fleeHealthFloor: 0.3,
      capacitorFloor: 0.2,
      maxFleeAttempts: 3,
      useDrones: false,
      droneRedeployHoldOffSeconds: 10,
      attemptsTagging: false,
      obeys: ["broadcast", "tag"],
      chatCommandSenders: [SYNTHETIC_CHARACTER_ID],
    });
  }
});

test("null, an array, and a primitive are all refused, not thrown", () => {
  assert.equal(decodeFleetCompanionRequestValue(null).ok, false);
  assert.equal(decodeFleetCompanionRequestValue([]).ok, false);
  assert.equal(decodeFleetCompanionRequestValue("dps").ok, false);
  assert.equal(decodeFleetCompanionRequestValue(42).ok, false);
});

test("an unknown extra key refuses the whole request", () => {
  const result = decodeFleetCompanionRequestValue({
    ...validPayload(),
    safeSpotBookmarkID: 12345,
  });
  assert.equal(result.ok, false);
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
