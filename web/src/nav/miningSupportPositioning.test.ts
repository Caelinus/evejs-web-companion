import test from "node:test";
import assert from "node:assert/strict";
import { decideSupportPositioning, freshSupportPositionMemory, type SupportPositionObservation, type SupportPositionPolicy } from "./miningSupportPositioning.ts";
import { deriveMiningSupportCapabilities } from "./miningSupportCapabilities.ts";
import { deriveMiningSupportServices } from "./miningSupportServices.ts";
import { decodeSpaceSnapshot } from "../bridge/space.ts";
import type { JsonValue } from "../bridge/wire.ts";
const policy: SupportPositionPolicy = { deadbandMeters: 10, arrivalMeters: 2, settledSpeedMetersPerSecond: 0.1,
  service: { maintainBursts: false, useIndustrialCore: false, enableCompression: false, coreRequirement: "continueWithoutCore" } };
function observation(xs = [200], options: { sample?: number; ownX?: number; core?: "active" | "pending" | "inactive";
  movement?: string; mode?: string; velocity?: number | null; dependents?: boolean } = {}): SupportPositionObservation {
  const core = options.core;
  const fitted = core ? [{ family: "high" as const, index: 0, module: { itemID: 201, typeID: 58945, groupID: 515, online: true, charge: null } }] : [];
  const capabilities = deriveMiningSupportCapabilities({ scope: { shipID: 1001, fittingSignature: "fit" }, slots: fitted,
    dogma: core ? { activeShipID: 1001, ships: [{ itemID: 201, typeID: 58945, locationID: 1001, ownerID: 1, flagID: 27,
      groupID: 515, categoryID: 7, quantity: -1, stacksize: -1, customInfo: null, time: null, wallclockTime: null,
      activeEffects: {}, attributes: [{ attributeID: 73, value: 150000 }] }], character: null, characterID: 1,
      shipModifiedCharAttributes: null, shipState: null, charBrain: null, systemWideEffectsOnShip: null, structureInfo: null, locationInfo: null } : null,
    bays: null, groupOf: () => "Industrial Core", typeNameOf: () => "Large Industrial Core I" });
  const active = core === "active" || core === "pending";
  const scene = decodeSpaceSnapshot({ inSpace: true, solarSystemID: 3001, shipID: 1001, sampledAtMs: options.sample ?? 100,
    ship: { itemID: 1001, characterID: 1, position: { x: options.ownX ?? 0, y: 0, z: 0 }, radius: 0,
      velocity: options.velocity === null ? null : { x: options.velocity ?? 0, y: 0, z: 0 }, mode: options.mode ?? "STOP",
      compressionService: { state: "inactive", typeListRanges: [], compressors: [] }, miningBurstServices: { activeModuleIDs: [], bursts: [] },
      coreMobilityFuel: { activeModuleIDs: active ? [201] : [], modules: core ? [{ moduleID: 201, typeID: 58945, active,
        effect: active ? { moduleID: 201, effectID: 8119, effectName: "industrialCompactCoreEffect2", deactivationRequestedAtMs: core === "pending" ? 50 : 0,
          deactivateAtMs: core === "pending" ? 500 : 0 } : null }] : [], mobility: {
        movement: { verdict: options.movement ?? (active ? "restricted" : "unrestricted") }, warp: { verdict: active ? "restricted" : "unrestricted" } } } },
    entities: xs.map((x, i) => ({ itemID: 2001 + i, characterID: i + 2, kind: "ship", radius: 0, position: { x, y: 0, z: 0 } })) } as JsonValue);
  return { scope: { characterID: 1, sessionEpoch: "session", shipID: 1001, fleetID: "fleet", solarSystemID: 3001, fittingSignature: "fit" },
    scene, services: deriveMiningSupportServices(capabilities, scene), receivedAtMs: 1000, nowMs: 1000,
    fleet: { readerCharacterID: 1, fleetID: "fleet", members: [1, ...xs.map((_, i) => i + 2)].map(characterID => ({ characterID, solarSystemID: 3001 })), observedAtMs: 1000, expiresAtMs: 11000 },
    intendedCharacterIDs: xs.map((_, i) => i + 2), envelope: { status: "bounded", maxSurfaceDistanceMeters: 100, reason: null }, dependentsSettled: options.dependents ?? true };
}
const decide = (input: SupportPositionObservation) => decideSupportPositioning(input, freshSupportPositionMemory(), policy);
test("comfortable coverage and boundary deadband hold without a movement", () => {
  assert.equal(decide(observation([80])).state, "HOLD");
  const edge = decide(observation([99])); assert.equal(edge.state, "HOLD"); assert.equal(edge.reason, "coverage-deadband"); assert.equal(edge.action, null);
});
test("one outside recipient yields one deterministic existing movement action", () => {
  const result = decide(observation()); assert.equal(result.state, "MOVING");
  assert.deepEqual(result.action, { kind: "gotoPoint", shipID: 1001, solarSystemID: 3001, position: { x: 200, y: 0, z: 0 } });
  const duplicate = decideSupportPositioning(observation(), result.memory, policy);
  assert.equal(duplicate.action, null);
});
test("multiple recipients are ordered deterministically and pair separation proves impossible spread", () => {
  const a = decide(observation([150, 250, 220]));
  assert.equal(a.state, "MOVING"); assert.ok(a.target!.x >= 160 && a.target!.x <= 240);
  assert.deepEqual(decide(observation([220, 250, 150])).target, a.target);
  const impossible = decide(observation([-101, 101])); assert.equal(impossible.state, "UNSATISFIED"); assert.equal(impossible.action, null);
});
test("unknown/off-grid/non-member geometry and stale reads cannot move", () => {
  const base = observation();
  for (const input of [{ ...base, scene: null }, { ...base, nowMs: 12000 }, { ...base, intendedCharacterIDs: [99] },
    { ...base, fleet: null }, { ...base, scene: { ...base.scene!, entities: [] } },
    { ...base, scene: { ...base.scene!, ship: { ...base.scene!.ship!, geometryAvailable: false } } }]) assert.equal(decide(input).action, null);
});
test("Core active, pending and final-off restrictions gate relocation through 2A", () => {
  const active = decide(observation([200], { core: "active" }));
  assert.equal(active.state, "SETTLING"); assert.deepEqual(active.action, { kind: "deactivate", moduleID: 201, typeID: 58945 });
  const pending = decideSupportPositioning(observation([200], { core: "pending", sample: 101 }), active.memory, policy);
  assert.equal(pending.action, null); assert.equal(pending.state, "SETTLING");
  const restricted = decideSupportPositioning(observation([200], { core: "inactive", sample: 102, movement: "restricted" }), pending.memory, policy);
  assert.equal(restricted.action, null);
  const allowed = decideSupportPositioning(observation([200], { core: "inactive", sample: 103 }), restricted.memory, policy);
  assert.equal(allowed.action?.kind, "gotoPoint");
});
test("dependent flight must settle before Core shutdown or movement", () => {
  const result = decide(observation([200], { core: "active", dependents: false }));
  assert.equal(result.state, "SETTLING"); assert.equal(result.action, null); assert.equal(result.reason, "dependent-flight-unsettled");
});

test("recipients returning during Core shutdown cancel the old target only after actual mobility and stopped motion", () => {
  const start = decide(observation([200], { core: "active" }));
  const pending = decideSupportPositioning(observation([50], { core: "pending", sample: 101 }), start.memory, policy);
  assert.equal(pending.state, "SETTLING"); assert.equal(pending.relocationRequested, true);
  const restricted = decideSupportPositioning(observation([50], { core: "inactive", movement: "restricted", sample: 102 }), pending.memory, policy);
  assert.equal(restricted.state, "SETTLING"); assert.equal(restricted.action, null);
  const final = decideSupportPositioning(observation([50], { core: "inactive", sample: 103 }), restricted.memory, policy);
  assert.equal(final.state, "ARRIVED"); assert.equal(final.action, null); assert.equal(final.relocationRequested, false);
  const unsettled = decideSupportPositioning(observation([50], { core: "inactive", sample: 103, dependents: false }), restricted.memory, policy);
  assert.equal(unsettled.relocationRequested, true); assert.equal(unsettled.action, null);
});

test("comfortable coverage brakes an approach before its old minimax point; boundary drift does not", () => {
  const start = decide(observation([200]));
  const boundary = decideSupportPositioning(observation([200], { ownX: 100, sample: 101, mode: "GOTO", velocity: 10 }), start.memory, policy);
  assert.equal(boundary.state, "MOVING"); assert.equal(boundary.action, null);
  const covered = decideSupportPositioning(observation([200], { ownX: 110, sample: 102, mode: "GOTO", velocity: 10 }), boundary.memory, policy);
  assert.equal(covered.action?.kind, "stopShip"); assert.equal(covered.relocationRequested, true);
  const final = decideSupportPositioning(observation([200], { ownX: 120, sample: 103 }), covered.memory, policy);
  assert.equal(final.state, "ARRIVED"); assert.equal(final.relocationRequested, false);
});
test("ACK never proves arrival; fresh geometric arrival then stop and measured settled motion restore maintenance", () => {
  const start = decide(observation());
  const ack = decideSupportPositioning(observation([200], { sample: 101 }), start.memory, policy, { scope: start.memory.scope!, movement: "acknowledged" });
  assert.equal(ack.state, "MOVING"); assert.equal(ack.action, null);
  const arrive = decideSupportPositioning(observation([201], { sample: 102, ownX: 200, mode: "GOTO", velocity: 1 }), ack.memory, policy);
  assert.deepEqual(arrive.action, { kind: "stopShip" });
  const unknown = decideSupportPositioning(observation([201], { sample: 103, ownX: 200, velocity: null }), arrive.memory, policy);
  assert.equal(unknown.state, "WAIT");
  const settled = decideSupportPositioning(observation([201], { sample: 104, ownX: 200 }), unknown.memory, policy);
  assert.equal(settled.state, "ARRIVED"); assert.equal(settled.relocationRequested, false);
  const next = decideSupportPositioning(observation([202], { sample: 105, ownX: 200 }), settled.memory, policy);
  assert.equal(next.state, "HOLD"); assert.equal(next.action, null);
});
test("shutdown keeps last proved range when active services disappear; refit/session/system resets target", () => {
  const start = decide(observation());
  const missing = { ...observation([200], { sample: 101 }), envelope: { status: "unsatisfied" as const, reason: "compression-unavailable", maxSurfaceDistanceMeters: null } };
  assert.equal(decideSupportPositioning(missing, start.memory, policy).state, "MOVING");
  const reset = decideSupportPositioning({ ...missing, scope: { ...missing.scope, sessionEpoch: "new" } }, start.memory, policy);
  assert.equal(reset.state, "WAIT"); assert.equal(reset.target, null);
});
test("live braking drift after measured arrival completes only with settled motion and recipient coverage", () => {
  const start = decide(observation());
  const stop = decideSupportPositioning(observation([200], { sample: 101, ownX: 200, mode: "GOTO", velocity: 70 }), start.memory, policy);
  assert.equal(stop.action?.kind, "stopShip");
  const covered = decideSupportPositioning(observation([200], { sample: 102, ownX: 250 }), stop.memory, policy);
  assert.equal(covered.state, "ARRIVED");
  const outside = decideSupportPositioning(observation([200], { sample: 102, ownX: 301 }), stop.memory, policy);
  assert.equal(outside.state, "WAIT"); assert.equal(outside.reason, "settled-outside-envelope"); assert.equal(outside.relocationRequested, true);
});
test("ambiguous movement and bounded unconfirmed travel latch; old-scope feedback ignored", () => {
  const start = decide(observation());
  const failed = decideSupportPositioning(observation([200], { sample: 101 }), start.memory, policy, { scope: start.memory.scope!, movement: "unknown" });
  assert.equal(failed.state, "BLOCKED"); assert.equal(failed.action, null);
  const old = decideSupportPositioning(observation([200], { sample: 101 }), start.memory, policy, { scope: { ...start.memory.scope!, sessionEpoch: "old" }, movement: "unknown" });
  assert.equal(old.state, "MOVING");
  const late = observation([200], { sample: 102 });
  const timed = decideSupportPositioning({ ...late, nowMs: 122001, receivedAtMs: 122001, fleet: { ...late.fleet!, observedAtMs: 122001, expiresAtMs: 132001 } }, start.memory, policy);
  assert.equal(timed.state, "BLOCKED");
});

function travelRead(at: number, ownX: number, sample = at) {
  const value = observation([1000], { ownX, sample, mode: at === 1000 ? "STOP" : "GOTO", velocity: at === 1000 ? 0 : 1 });
  return { ...value, nowMs: at, receivedAtMs: at, fleet: { ...value.fleet!, observedAtMs: at, expiresAtMs: at + 10000 } };
}

test("fresh geometric progress permits slow travel beyond two minutes but total duration remains bounded", () => {
  let result = decide(travelRead(1000, 0));
  for (const [at, ownX] of [[101000, 100], [201000, 200], [301000, 300], [401000, 400], [501000, 500]]) {
    result = decideSupportPositioning(travelRead(at!, ownX!), result.memory, policy);
    assert.equal(result.state, "MOVING"); assert.equal(result.action, null);
  }
  const capped = decideSupportPositioning(travelRead(601001, 600), result.memory, policy);
  assert.equal(capped.state, "BLOCKED"); assert.equal(capped.reason, "movement-unconfirmed");
});

test("unchanged, reverse and repeated scene geometry cannot renew the progress window", () => {
  const start = decide(travelRead(1000, 0));
  for (const [ownX, sample] of [[0, 122001], [-20, 122001]]) {
    const blocked = decideSupportPositioning(travelRead(122001, ownX!, sample!), start.memory, policy);
    assert.equal(blocked.state, "BLOCKED"); assert.equal(blocked.action, null);
  }
  const repeated = decideSupportPositioning(travelRead(122001, 100, 1000), start.memory, policy);
  assert.equal(repeated.action, null);
  assert.equal(repeated.memory.relocation?.progressAtMs, 1000);
  const subsequent = decideSupportPositioning(travelRead(122002, 0), repeated.memory, policy);
  assert.equal(subsequent.state, "BLOCKED");
  const moved = decideSupportPositioning(travelRead(101000, 100), start.memory, policy);
  const stalled = decideSupportPositioning(travelRead(222001, 100), moved.memory, policy);
  assert.equal(stalled.state, "BLOCKED");
});

test("measured arrival and final braking confirmation take precedence over elapsed travel windows", () => {
  const start = decide(travelRead(1000, 0));
  const arrival = decideSupportPositioning(travelRead(122001, 1000), start.memory, policy);
  assert.equal(arrival.action?.kind, "stopShip");
  const value = travelRead(244002, 1000);
  const final = decideSupportPositioning({ ...value, scene: observation([1000], { ownX: 1000, sample: 244002 }).scene }, arrival.memory, policy);
  assert.equal(final.state, "ARRIVED"); assert.equal(final.relocationRequested, false);
});
test("covered warp-arrival drift brakes before inactive-envelope service bootstrap", () => {
  const own = observation([50], { velocity: 4.5, core: "inactive" });
  const inactiveEnvelope = { status: "unknown" as const, maxSurfaceDistanceMeters: null, reason: "burst-inactive" };
  const start = decide({ ...own, envelope: inactiveEnvelope });
  assert.deepEqual(start.action, { kind: "stopShip" }); assert.equal(start.relocationRequested, true);
  const ack = decideSupportPositioning({ ...observation([50], { sample: 101, velocity: 4.5, core: "inactive" }), envelope: inactiveEnvelope }, start.memory, policy,
    { scope: own.scope, movement: "acknowledged" });
  assert.equal(ack.state, "WAIT"); assert.equal(ack.action, null);
  const final = decideSupportPositioning({ ...observation([50], { sample: 102, core: "inactive" }), envelope: inactiveEnvelope }, ack.memory, policy);
  assert.equal(final.state, "ARRIVED"); assert.equal(final.relocationRequested, false);
});
test("covered drift under active/pending Core settles and proves mobility before braking", () => {
  const active = decide(observation([50], { velocity: 4.5, core: "active" }));
  assert.equal(active.action?.kind, "deactivate");
  const pending = decideSupportPositioning(observation([50], { sample: 101, velocity: 4.5, core: "pending" }), active.memory, policy);
  assert.equal(pending.action, null); assert.equal(pending.state, "SETTLING");
  const locked = decideSupportPositioning(observation([50], { sample: 102, velocity: 4.5, core: "inactive", movement: "restricted" }), pending.memory, policy);
  assert.equal(locked.action, null);
  const mobile = decideSupportPositioning(observation([50], { sample: 103, velocity: 4.5, core: "inactive" }), locked.memory, policy);
  assert.deepEqual(mobile.action, { kind: "stopShip" });
});
test("unknown motion and warp never start services or invent stable STOP", () => {
  for (const o of [observation([50], { velocity: null }), observation([50], { mode: "WARP", velocity: 100 })]) {
    const r = decide(o); assert.equal(r.state, "WAIT"); assert.equal(r.action, null);
  }
  const start = decide(observation([50], { velocity: 4.5, dependents: false }));
  assert.equal(start.action, null); assert.equal(start.reason, "dependent-flight-unsettled");
});
test("braking drift outside coverage is re-evaluated before services or dependent work resume", () => {
  const start = decide(observation([50], { velocity: 4.5 }));
  const final = decideSupportPositioning(observation([50], { sample: 101, ownX: -100 }), start.memory, policy);
  assert.equal(final.state, "ARRIVED"); assert.equal(final.action, null);
  const reposition = decideSupportPositioning(observation([50], { sample: 102, ownX: -100 }), final.memory, policy);
  assert.equal(reposition.relocationRequested, true); assert.equal(reposition.action?.kind, "gotoPoint");
  assert.notEqual(reposition.state, "HOLD");
});
