import test from "node:test";
import assert from "node:assert/strict";
import { decideSupportTractor, freshSupportTractorMemory, readObservedTractorTarget, type SupportTractorInput, type SupportTractorResult } from "./miningSupportTractor.ts";
import { deriveMiningSupportCapabilities } from "./miningSupportCapabilities.ts";
import { describeFitting } from "./scriptCapabilities.ts";
import { decodeSpaceSnapshot } from "../bridge/space.ts";
import type { BoundDogmaAllInfo, DogmaItemInfo } from "../bridge/boundDogma.ts";
function input(options: { sample?: number; distance?: number; active?: boolean; target?: number; locked?: boolean; reach?: boolean; mayWork?: boolean; present?: boolean; owner?: number; retain?: boolean; now?: number } = {}): SupportTractorInput {
  const sample = options.sample ?? 200, active = options.active ?? false;
  const slots = [{ family: "high" as const, index: 0, module: { itemID: 301, typeID: 401, groupID: 650, online: true, charge: null } }];
  const entry: DogmaItemInfo = { itemID: 301, typeID: 401, categoryID: 7, groupID: 650, ownerID: 501, locationID: 101, flagID: 27,
    quantity: -1, stacksize: -1, customInfo: null, time: null, wallclockTime: null, attributes: [{ attributeID: 73, value: 5000 }],
    activeEffects: { type: "dict", entries: active ? [[601, [301, 501, 101, options.target ?? 901, null, [], 601, "134000000000000000", 5000, -1]]] : [] } };
  const dogma: BoundDogmaAllInfo = { activeShipID: 101, characterID: 501, ships: [entry], character: null, shipModifiedCharAttributes: null,
    shipState: null, charBrain: null, systemWideEffectsOnShip: null, structureInfo: null, locationInfo: null };
  const fittingSignature = describeFitting(101, slots);
  const capabilities = deriveMiningSupportCapabilities({ scope: { shipID: 101, fittingSignature }, slots, dogma, bays: null, groupOf: () => "Tractor Beam", typeNameOf: () => "Tractor" });
  const scene = decodeSpaceSnapshot({ inSpace: true, shipID: 101, solarSystemID: 801, sampledAtMs: sample,
    ship: { itemID: 101, characterID: 501, mode: "STOP", position: { x: 0, y: 0, z: 0 }, radius: 10, velocity: { x: 0, y: 0, z: 0 }, activeModuleIDs: active ? [301] : [],
      coreMobilityFuel: { activeModuleIDs: active ? [301] : [], modules: [{ moduleID: 301, typeID: 401, active,
        effect: active ? { moduleID: 301, effectID: 601, effectName: "tractorBeamCan" } : null }] },
      moduleReach: options.reach === false ? null : { shipID: 101, sampledAtSimTimeMs: sample, availability: "available", modules: [{ moduleID: 301, typeID: 401, family: "tractor", availability: "available", maxRangeMeters: 84000, settlementSurfaceDistanceMeters: 500 }] } },
    entities: options.present === false ? [] : [{ itemID: 901, kind: "container", ownerID: options.owner ?? 502,
      position: { x: (options.distance ?? 10000) + 20, y: 0, z: 0 }, radius: 10, velocity: { x: 0, y: 0, z: 0 } }] });
  return { scope: { characterID: 501, sessionEpoch: "run", shipID: 101, fleetID: "701", solarSystemID: 801, fittingSignature },
    runID: "tractor-run", scene, dogma, capabilities, lockedTargetIDs: options.locked ? [901] : [], receivedAtMs: options.now ?? 1000, nowMs: options.now ?? 1000,
    eligibleContainerIDs: [901], allowedOwnerIDs: [502], claimedByOtherItemIDs: [], mayWork: options.mayWork ?? true, settleReason: null, retainSettledClaim: options.retain ?? false };
}
function claimed(options: Parameters<typeof input>[0] = {}): SupportTractorResult {
  const first = decideSupportTractor(input(options), freshSupportTractorMemory());
  const next = input({ ...options, sample: 201 });
  return decideSupportTractor(next, first.memory, { scope: next.scope, runID: next.runID, actionID: first.actionID!, outcome: "acknowledged", claimed: true });
}
test("sequential claim -> lock -> exact beam -> observed pull -> stop -> release, never an empty mark", () => {
  let result = claimed(); assert.equal(result.action?.kind, "lock");
  result = decideSupportTractor(input({ sample: 202, locked: true }), result.memory);
  assert.deepEqual(result.action, { kind: "activate", moduleID: 301, targetID: 901 });
  result = decideSupportTractor(input({ sample: 203, locked: true, active: true }), result.memory);
  assert.equal(result.state, "PULLING"); assert.equal(result.action, null);
  result = decideSupportTractor(input({ sample: 204, locked: true, active: true, distance: 500 }), result.memory);
  assert.deepEqual(result.action, { kind: "deactivate", moduleID: 301, typeID: 401 });
  result = decideSupportTractor(input({ sample: 205, locked: true, distance: 500 }), result.memory);
  assert.equal(result.action?.kind, "releaseContainerClaim");
  const next = input({ sample: 206, distance: 500 });
  result = decideSupportTractor(next, result.memory, { scope: next.scope, runID: next.runID, actionID: result.actionID!, outcome: "acknowledged" });
  assert.equal(result.state, "SETTLED"); assert.equal(result.memory.claim, null); assert.deepEqual(result.memory.servedItemIDs, [901]);
  assert.equal(decideSupportTractor(input({ sample: 207 }), result.memory).state, "IDLE");
});
test("provenance/owners/other claims and exact observed range gate selection, without fitting fallback", () => {
  for (const options of [{ owner: 999 }, { reach: false }, { distance: 84001 }]) assert.equal(decideSupportTractor(input(options), freshSupportTractorMemory()).action, null);
  const other = { ...input(), claimedByOtherItemIDs: [901] };
  assert.equal(decideSupportTractor(other, freshSupportTractorMemory()).action, null);
  assert.equal(decideSupportTractor({ ...input(), eligibleContainerIDs: [] }, freshSupportTractorMemory()).action, null);
  assert.equal(decideSupportTractor(input({ distance: 84000 }), freshSupportTractorMemory()).action?.kind, "claimContainer");
});
test("FULL collection can yield a settled nonempty can without reclaiming it or bypassing ambiguity", () => {
  const prior = claimed({ locked: true, distance: 500, retain: true });
  const read = { ...input({ sample: 203, locked: true, distance: 500, retain: true, mayWork: false }), settleReason: "support-full-handoff" };
  const release = decideSupportTractor(read, prior.memory);
  assert.equal(release.action?.kind, "releaseContainerClaim");
  assert.equal(decideSupportTractor({ ...read, claimSettlementBlocked: true }, prior.memory).action, null);
  const done = decideSupportTractor(input({ sample: 204, locked: true, distance: 500, mayWork: false }), release.memory,
    { scope: read.scope, runID: read.runID, actionID: release.actionID!, outcome: "acknowledged" });
  assert.equal(done.memory.claim, null);
  assert.equal(decideSupportTractor(input({ sample: 205 }), done.memory).action, null);
});
test("fresh GetAllInfo target identity must match module, pilot, ship and current effect", () => {
  const read = input({ active: true }); const module = read.capabilities.tractors.modules[0]!;
  assert.deepEqual(readObservedTractorTarget(read.scene!, read.dogma, read.scope, module), { state: "active", targetID: 901 });
  for (const dogma of [null, { ...read.dogma!, activeShipID: 999 }, { ...read.dogma!, characterID: 999 },
    { ...read.dogma!, ships: [{ ...read.dogma!.ships[0]!, ownerID: 999 }] }, { ...read.dogma!, ships: [{ ...read.dogma!.ships[0]!, typeID: 999 }] }]) {
    assert.equal(readObservedTractorTarget(read.scene!, dogma, read.scope, module).state, "unknown");
  }
});
test("relocation stops observed beam before releasing; ACK never proves inactive", () => {
  let result = claimed({ locked: true });
  result = decideSupportTractor(input({ sample: 202, active: true, mayWork: false }), result.memory);
  assert.equal(result.action?.kind, "deactivate");
  const pending = input({ sample: 203, active: true, mayWork: false });
  result = decideSupportTractor(pending, result.memory, { scope: pending.scope, runID: pending.runID, actionID: result.actionID!, outcome: "acknowledged" });
  assert.equal(result.action, null); assert.ok(result.memory.claim);
  result = decideSupportTractor(input({ sample: 204, mayWork: false }), result.memory);
  assert.equal(result.action?.kind, "releaseContainerClaim");
});

test("unresolved collection stops known beam but cannot release the settled claim", () => {
  let result = claimed({ locked: true });
  result = decideSupportTractor({ ...input({ sample: 202, active: true, mayWork: false }), claimSettlementBlocked: true }, result.memory);
  assert.equal(result.action?.kind, "deactivate");
  const stopped = { ...input({ sample: 203, distance: 500, mayWork: false }), claimSettlementBlocked: true };
  result = decideSupportTractor(stopped, result.memory, { scope: stopped.scope, runID: stopped.runID, actionID: result.actionID!, outcome: "acknowledged" });
  assert.equal(result.state, "BLOCKED"); assert.equal(result.action, null); assert.ok(result.memory.claim);
});

test("verified empty can may disappear from scene before safe claim release", () => {
  const prior = claimed({ locked: true, distance: 500, retain: true });
  const empty = input({ sample: 203, locked: true });
  const read = { ...empty, scene: { ...empty.scene!, entities: empty.scene!.entities.filter(row => row.itemID !== 901) }, collectedContainerID: 901 };
  const result = decideSupportTractor(read, prior.memory);
  assert.equal(result.action?.kind, "releaseContainerClaim"); assert.equal(result.reason, "collected-container-empty");
  const blocked = decideSupportTractor({ ...read, claimSettlementBlocked: true }, prior.memory);
  assert.equal(blocked.action, null); assert.ok(blocked.memory.claim);
});
test("temporary refusal retains claim and cleans known beam; ambiguous identity never starts another pull", () => {
  let result = claimed({ locked: true }); const pending = input({ sample: 202, active: true, target: 999 });
  result = decideSupportTractor(pending, result.memory);
  assert.equal(result.state, "SETTLING"); assert.ok(result.memory.claim); assert.equal(result.action?.kind, "deactivate");
  result = decideSupportTractor(input({ sample: 204 }), result.memory);
  assert.equal(result.state, "BLOCKED"); assert.ok(result.memory.claim); assert.equal(result.action, null);
});
test("a refused productive action retains the acquired lease without blind retry", () => {
  let result = claimed({ locked: true }); const next = input({ sample: 202, locked: true });
  result = decideSupportTractor(next, result.memory, { scope: next.scope, runID: next.runID, actionID: result.actionID!, outcome: "failed", reason: "CALL_REFUSED" });
  assert.equal(result.state, "BLOCKED"); assert.ok(result.memory.claim); assert.equal(result.action, null);
});
test("claim renewal is retained through unknown target geometry; settled collection holds its lease", () => {
  let result = claimed({ locked: true });
  result = decideSupportTractor(input({ sample: 202, active: true }), result.memory);
  result = decideSupportTractor(input({ sample: 203, active: true, present: false, now: 11000 }), result.memory);
  assert.equal(result.action?.kind, "deactivate");
  result = decideSupportTractor(input({ sample: 204, present: false, now: 11001 }), result.memory);
  assert.deepEqual(result.action, { kind: "claimContainer", itemID: 901, renewOnly: true }); assert.ok(result.memory.claim);
  let ready = claimed({ distance: 500, retain: true });
  assert.equal(ready.state, "SETTLED"); assert.equal(ready.readyContainerID, 901); assert.ok(ready.memory.claim); assert.equal(ready.action, null);
  ready = decideSupportTractor({ ...input({ sample: 202, distance: 500, retain: true }), collectedContainerID: 901 }, ready.memory);
  assert.equal(ready.action?.kind, "releaseContainerClaim");
});
test("lost owner/provenance stops known activity and keeps its lease", () => {
  let result = claimed({ locked: true });
  result = decideSupportTractor(input({ sample: 202, active: true }), result.memory);
  result = decideSupportTractor(input({ sample: 203, active: true, owner: 999 }), result.memory);
  assert.equal(result.action?.kind, "deactivate"); assert.ok(result.memory.claim); assert.equal(result.memory.fault, "selected-container-ineligible");
});
test("missing motion cannot prove a settled container", () => {
  const first = claimed({ locked: true }); const read = input({ sample: 202, distance: 500, retain: true });
  const scene = { ...read.scene!, entities: read.scene!.entities.map(row => ({ ...row, motionAvailable: false })) };
  const result = decideSupportTractor({ ...read, scene }, { ...first.memory, order: null });
  assert.equal(result.readyContainerID, null); assert.notEqual(result.state, "SETTLED");
});
test("another active beam is stopped before the selected item can activate", () => {
  const first = claimed({ locked: true }); const read = input({ sample: 202 });
  const capabilities = { ...read.capabilities, tractors: { ...read.capabilities.tractors,
    modules: [...read.capabilities.tractors.modules, { ...read.capabilities.tractors.modules[0]!, itemID: 302 }] } };
  const scene = { ...read.scene!, ship: { ...read.scene!.ship!, activeModuleIDs: [302] } };
  const result = decideSupportTractor({ ...read, capabilities, scene }, first.memory);
  assert.deepEqual(result.action, { kind: "deactivate", moduleID: 302, typeID: 401 });
  assert.equal(result.memory.fault, "concurrent-tractor-activity"); assert.ok(result.memory.claim);
});
test("scope changes preserve unresolved lease diagnostics; same samples cannot replay orders", () => {
  const first = decideSupportTractor(input(), freshSupportTractorMemory());
  assert.equal(decideSupportTractor(input(), first.memory).action, null);
  const changed = { ...input({ sample: 202 }), runID: "new-run" };
  const result = decideSupportTractor(changed, first.memory);
  assert.equal(result.state, "BLOCKED"); assert.equal(result.memory.runID, "tractor-run");
  assert.equal(decideSupportTractor(changed, result.memory).state, "BLOCKED");
});
