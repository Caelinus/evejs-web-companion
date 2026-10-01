import test from "node:test";
import assert from "node:assert/strict";
import { decideMiningSupport, freshMiningSupportMemory, observeMiningSupportOrders, type MiningSupportPolicy } from "./miningSupportController.ts";
import { deriveMiningSupportCapabilities } from "./miningSupportCapabilities.ts";
import { deriveMiningSupportServices } from "./miningSupportServices.ts";
import { describeFitting } from "./scriptCapabilities.ts";
import { decodeSpaceSnapshot } from "../bridge/space.ts";
import type { BoundDogmaAllInfo, DogmaItemInfo } from "../bridge/boundDogma.ts";
import type { FittingSlot } from "../store/types.ts";
import type { JsonValue } from "../bridge/wire.ts";

const policy: MiningSupportPolicy = { maintainBursts: true, useIndustrialCore: false, enableCompression: false, coreRequirement: "continueWithoutCore" };
const withCore = { ...policy, useIndustrialCore: true };
const all = { ...withCore, enableCompression: true };

test("quiesced recovery observes completed exact orders without activating services or discarding unknown custody", () => {
  const active = observed({ core: "active", sample: 100 });
  const stop = decideMiningSupport(active, freshMiningSupportMemory(), withCore, true);
  assert.equal(stop.action?.kind, "deactivate"); assert.equal(stop.memory.orders.length, 1);
  assert.equal(observeMiningSupportOrders(observed({ core: "inactive", sample: 101 }), stop.memory).length, 0);
  for (const next of [observed({ core: "inactive", sample: 100 }), observed({ core: "unknown", sample: 101 }),
    observed({ core: "deactivation-pending", sample: 101 }), observed({ core: "inactive", sample: 101, shipID: 123 })])
    assert.equal(observeMiningSupportOrders(next, stop.memory).length, 1);
  assert.equal(stop.memory.orders.length, 1, "read reconciliation leaves the caller's previous memory unchanged");
  const burst = decideMiningSupport(observed({ bursts: ["inactive"], sample: 100 }), freshMiningSupportMemory(), policy, false);
  assert.equal(observeMiningSupportOrders(observed({ bursts: ["active"], sample: 101 }), burst.memory).length, 0);
  assert.equal(observeMiningSupportOrders(observed({ bursts: ["active"], burstIDs: [102], sample: 101 }), burst.memory).length, 1);
  const compressor = decideMiningSupport(observed({ core: "active", compressors: ["active"], sample: 100 }), freshMiningSupportMemory(), all, true);
  const next = observed({ core: "active", compressors: ["inactive"], sample: 101 });
  assert.equal(observeMiningSupportOrders(next, compressor.memory).length, 0);
  const unknown = { ...next, compression: { ...next.compression, facilities: next.compression.facilities.map(row => ({ ...row, state: "unknown" as const })) } };
  assert.equal(observeMiningSupportOrders(unknown, compressor.memory).length, 1);
  assert.equal(decideMiningSupport(unknown, compressor.memory, all, true).action, null);
});

test("burst startup accepts a validated own-ship charge sublocation without inventing an item ID", () => {
  const services = observed({ bursts: ["inactive"] });
  const original = services.bursts[0]!;
  const charge = { itemID: [services.capabilities.scope.shipID!, 27, 42831] as const, typeID: 42831, quantity: 300 };
  const update = (itemID: readonly [number, number, number]) => ({ ...services, bursts: [{ ...original, capability: { ...original.capability, charge: { ...charge, itemID } } }] });
  assert.equal(decideMiningSupport(update(charge.itemID), freshMiningSupportMemory(), policy, false).action?.kind, "activate");
  assert.equal(decideMiningSupport(update([999, 27, 42831]), freshMiningSupportMemory(), policy, false).action, null);
  assert.equal(decideMiningSupport(update([charge.itemID[0], 27, 42830]), freshMiningSupportMemory(), policy, false).action, null);
});
type State = "active" | "inactive" | "unknown";
interface Options {
  sample?: number; shipID?: number; shipTypeID?: number;
  bursts?: readonly State[]; burstIDs?: readonly number[]; noCharge?: readonly number[]; zeroCharge?: boolean;
  core?: State | "deactivation-pending"; sufficient?: boolean | null; required?: number; available?: number; baseCost?: number;
  compressors?: readonly State[]; requiresCore?: boolean | null; typelist?: number | null;
  movement?: "restricted" | "unrestricted" | "unknown"; warp?: "restricted" | "unrestricted" | "unknown";
  dogma?: boolean; offline?: readonly number[]; fuelFailure?: "NO_FUEL" | "fuel"; unknownFit?: boolean;
  compressorStopAt?: number; compressorEffectType?: number; compressorEffectName?: string;
}
function observed(options: Options = {}) {
  const shipID = options.shipID ?? 9988400023309;
  const slots: FittingSlot[] = [];
  const burstIDs = options.burstIDs ?? (options.bursts ?? []).map((_, i) => 101 + i);
  function fitted(itemID: number, typeID: number, groupID: number, charge = false) {
    slots.push({ family: "high", index: slots.length, module: { itemID, typeID, groupID,
      online: !options.offline?.includes(itemID), charge: charge && !options.noCharge?.includes(itemID)
        ? { itemID: itemID + 1000, typeID: 42831, quantity: options.zeroCharge ? 0 : 12 } : null } });
  }
  for (const itemID of burstIDs) fitted(itemID, 42528, 1770, true);
  if (options.core) fitted(201, 62590, 515);
  for (let i = 0; i < (options.compressors?.length ?? 0); i++) fitted(301 + i, 62586, 4174);
  const items: DogmaItemInfo[] = slots.map(slot => ({ itemID: slot.module!.itemID, typeID: slot.module!.typeID,
    locationID: shipID, ownerID: 501, flagID: 27 + slot.index, groupID: slot.module!.groupID, categoryID: 7,
    quantity: -1, stacksize: -1, customInfo: null, time: null, wallclockTime: null, activeEffects: {},
    attributes: [{ attributeID: 73, value: 60000 }, { attributeID: 714, value: options.baseCost ?? 500 },
      ...(options.requiresCore === null ? [] : [{ attributeID: 3265, value: options.requiresCore === false ? 0 : 1 }]),
      ...(options.typelist === null ? [] : [{ attributeID: 3255, value: options.typelist ?? 23 }])] }));
  const dogma: BoundDogmaAllInfo = { activeShipID: shipID, ships: items, character: null, characterID: 501,
    shipModifiedCharAttributes: null, shipState: null, charBrain: null, systemWideEffectsOnShip: null, structureInfo: null, locationInfo: null };
  const capabilities = deriveMiningSupportCapabilities({ scope: { shipID, fittingSignature: describeFitting(shipID, slots) },
    slots: options.unknownFit ? null : slots, dogma: options.dogma === false ? null : dogma, bays: null,
    groupOf: () => "Support equipment", typeNameOf: typeID => typeID === 42528 ? "Mining Foreman Burst I"
      : typeID === 62590 ? "Medium Industrial Core I" : "Medium Asteroid Ore Compressor I" });
  const active = options.core === "active" || options.core === "deactivation-pending";
  const coreModule: JsonValue = { moduleID: 201, typeID: 62590, active,
    effect: active ? { moduleID: 201, effectID: 4575, effectName: "industrialCoreEffect2", startedAtMs: 1, cycleDurationMs: 100,
      nextCycleAtMs: 101, deactivationRequestedAtMs: options.core === "deactivation-pending" ? 20 : 0,
      deactivateAtMs: options.core === "deactivation-pending" ? 101 : 0, stopReason: options.fuelFailure === "fuel" ? "fuel" : null } : null,
    fuel: { typeID: 16272, effectivePerActivation: active ? 80 : null, availableQuantity: options.available ?? 80,
      activationFailureCode: options.fuelFailure === "NO_FUEL" ? "NO_FUEL" : null,
      startupQuote: { moduleID: 201, fuelTypeID: 16272, requiredQuantity: options.required ?? 80,
        availableQuantity: options.available ?? 80, sufficient: options.sufficient === undefined ? true : options.sufficient,
        availability: options.sufficient === null ? "unknown" : "available", reason: options.sufficient === null ? "fuel-calculation-unavailable" : null } } };
  const activeBursts = burstIDs.filter((_, i) => options.bursts?.[i] === "active");
  const activeCompressors = (options.compressors ?? []).flatMap((state, i) => state === "active" ? [{ moduleID: 301 + i, typeID: 62586 }] : []);
  const space = decodeSpaceSnapshot({ inSpace: true, shipID, sampledAtMs: options.sample ?? 100, entities: [],
    ship: { itemID: shipID, typeID: options.shipTypeID ?? 42244,
      miningBurstServices: options.bursts?.includes("unknown") ? null : { activeModuleIDs: activeBursts,
        bursts: activeBursts.map(moduleID => ({ moduleID, typeID: 42528 })) },
      compressionService: { state: options.compressors?.includes("unknown") ? "unknown" : activeCompressors.length > 0 && active ? "active" : "inactive",
        compressors: options.compressors?.includes("unknown") ? null : activeCompressors,
        typeListRanges: activeCompressors.length > 0 && active ? [{ typeListID: 23, rangeMeters: 60000 }] : [] },
      coreMobilityFuel: { activeModuleIDs: options.core === "unknown" ? null : [...(active ? [201] : []), ...activeCompressors.map(row => row.moduleID)],
        modules: [...(options.core ? [coreModule] : []), ...(options.compressorStopAt ? activeCompressors.map(row => ({ ...row,
          typeID: options.compressorEffectType ?? row.typeID, active: true,
          effect: { moduleID: row.moduleID, effectName: options.compressorEffectName ?? "industrialItemCompression", deactivationRequestedAtMs: 101, deactivateAtMs: options.compressorStopAt ?? null } })) : [])],
        mobility: { movement: { verdict: options.movement ?? (active ? "restricted" : "unrestricted") },
          warp: { verdict: options.warp ?? (active ? "restricted" : "unrestricted"), reasonCode: active ? "SHIP_IMMOBILE" : null } } } } });
  return deriveMiningSupportServices(capabilities, space);
}
const decide = (options: Options = {}, desired = policy, relocating = false) => decideMiningSupport(observed(options), freshMiningSupportMemory(), desired, relocating);
const reason = (result: ReturnType<typeof decide>, value: string) => result.issues.some(issue => issue.reason === value);

test("full support Stop observes a burst's real deferred boundary then final inactivity", () => {
  let result = decideMiningSupport(observed({ bursts: ["active"], sample: 100 }), freshMiningSupportMemory(), policy, true, undefined, true);
  assert.deepEqual(result.action, { kind: "deactivate", moduleID: 101, typeID: 42528 });
  for (let sample = 101; sample < 130; sample++) {
    const services = observed({ bursts: ["active"], sample });
    result = decideMiningSupport({ ...services, bursts: services.bursts.map(row => ({ ...row, state: "deactivation-pending" as const,
      effect: { moduleID: 101, effectID: 6736, effectName: "moduleBonusWarfareLinkMining", startedAtMs: 1, cycleDurationMs: 150,
        nextCycleAtMs: 150, deactivationRequestedAtMs: 100, deactivateAtMs: 150, stopReason: null } })) }, result.memory, policy, true, undefined, true);
    assert.equal(result.state, "waiting"); assert.equal(result.action, null);
    assert.equal(result.memory.orders[0]?.unconfirmedObservations, 0);
  }
  result = decideMiningSupport(observed({ bursts: ["inactive"], sample: 151 }), result.memory, policy, true, undefined, true);
  assert.equal(result.state, "ready-for-relocation"); assert.equal(result.memory.orders.length, 0);
});

test("observed compressor cycle stop waits without spending uncertainty polls, then requires effect removal", () => {
  let result = decide({ core: "active", compressors: ["active"] }, all, true);
  assert.equal(result.action?.moduleID, 301);
  for (let sample = 102; sample < 130; sample++) {
    result = decideMiningSupport(observed({ core: "active", compressors: ["active"], sample, compressorStopAt: 150 }), result.memory, all, true);
    assert.equal(result.state, "waiting"); assert.equal(result.action, null);
    assert.equal(result.memory.orders[0]?.unconfirmedObservations, 0);
  }
  for (let sample = 150; sample < 158; sample++) {
    result = decideMiningSupport(observed({ core: "active", compressors: ["active"], sample, compressorStopAt: 150 }), result.memory, all, true);
  }
  assert.equal(result.state, "blocked"); assert.ok(reason(result, "action-unconfirmed"));
  result = decideMiningSupport(observed({ core: "active", compressors: ["inactive"], sample: 159 }), result.memory, all, true);
  assert.equal(result.action?.moduleID, 201, "only observed compressor absence permits Core shutdown");
});

test("ACK and mismatched compressor effect cannot waive uncertainty or prove stop", () => {
  for (const mismatch of [{}, { compressorEffectType: 999, compressorStopAt: 10000 }, { compressorEffectName: "other", compressorStopAt: 10000 }]) {
    let result = decide({ core: "active", compressors: ["active"] }, all, true);
    for (let sample = 102; sample < 111; sample++) {
      result = decideMiningSupport(observed({ core: "active", compressors: ["active"], sample, ...mismatch }), result.memory, all, true,
        { actionID: 1, outcome: "acknowledged" });
      assert.equal(result.action, null);
    }
    assert.equal(result.state, "blocked");
  }
});

test("active burst is left alone and inactive usable burst activates by fitted item ID", () => {
  assert.equal(decide({ bursts: ["active"] }).action, null);
  assert.deepEqual(decide({ bursts: ["inactive"] }).action, { kind: "activate", moduleID: 101, targetID: 0 });
});

test("multiple bursts start in deterministic item order, once per refreshed observation", () => {
  let result = decide({ bursts: ["inactive", "inactive"], burstIDs: [102, 101] });
  assert.equal(result.action?.moduleID, 101);
  const duplicate = decideMiningSupport(observed({ bursts: ["inactive", "inactive"], burstIDs: [102, 101] }), result.memory, policy, false);
  assert.equal(duplicate.action, null);
  result = decideMiningSupport(observed({ bursts: ["inactive", "active"], burstIDs: [102, 101], sample: 101 }), duplicate.memory, policy, false);
  assert.equal(result.action?.moduleID, 102);
  result = decideMiningSupport(observed({ bursts: ["active", "active"], burstIDs: [102, 101], sample: 102 }), result.memory, policy, false);
  assert.equal(result.state, "ready"); assert.equal(result.memory.orders.length, 0);
});

test("unknown burst, missing dogma, offline module and missing/empty charge fail closed", () => {
  for (const options of [{ bursts: ["unknown"] as const }, { bursts: ["inactive"] as const, dogma: false },
    { bursts: ["inactive"] as const, offline: [101] }, { bursts: ["inactive"] as const, noCharge: [101] },
    { bursts: ["inactive"] as const, zeroCharge: true }]) assert.equal(decide(options).action, null);
  assert.ok(reason(decide({ bursts: ["unknown"] }), "service-state-unknown"));
  assert.ok(reason(decide({ bursts: ["inactive"], noCharge: [101] }), "burst-no-charge"));
  assert.equal(decide({ bursts: ["inactive"], noCharge: [101] }).state, "degraded");
  const other = decide({ bursts: ["inactive", "inactive"], noCharge: [101] });
  assert.equal(other.action?.moduleID, 102); assert.equal(other.state, "degraded");
});

test("inactive desired Core starts only from the authoritative quote, without base dogma arithmetic", () => {
  const result = decide({ core: "inactive", sufficient: true, required: 80, available: 80, baseCost: 9000 }, withCore);
  assert.deepEqual(result.action, { kind: "activate", moduleID: 201, targetID: 0 });
  assert.equal(result.state, "maintaining");
  assert.equal(decide({ core: "active" }, withCore).action, null);
  const veto = decide({ core: "inactive", sufficient: false, available: 100000, baseCost: 1 }, withCore);
  assert.equal(veto.action, null); assert.ok(reason(veto, "no-fuel"), "server verdict is not recomputed from quantities");
});

test("false fuel quote covers zero/insufficient fuel under both policies; continue maintains independent bursts", () => {
  for (const available of [0, 79]) {
    const options: Options = { core: "inactive", sufficient: false, available };
    assert.equal(decide(options, withCore).state, "degraded");
    const required = decide(options, { ...withCore, coreRequirement: "requireCore" });
    assert.equal(required.state, "blocked"); assert.equal(required.action, null); assert.ok(reason(required, "no-fuel"));
    const independent = decide({ ...options, bursts: ["inactive"], compressors: ["inactive"] }, all);
    assert.equal(independent.action?.moduleID, 101); assert.equal(independent.state, "degraded");
  }
});

test("unknown quote, unknown Core and foreign quote item wait without no-fuel inference", () => {
  for (const options of [{ core: "inactive" as const, sufficient: null }, { core: "unknown" as const }]) {
    const result = decide(options, withCore); assert.equal(result.action, null); assert.equal(result.state, "waiting");
    assert.equal(reason(result, "no-fuel"), false);
  }
  const services = observed({ core: "inactive" });
  const core = services.cores[0]!;
  const result = decideMiningSupport({ ...services, cores: [{ ...core, fuel: { ...core.fuel,
    startupQuote: { ...core.fuel.startupQuote, moduleID: 999 } } }] }, freshMiningSupportMemory(), withCore, false);
  assert.equal(result.action, null); assert.ok(reason(result, "fuel-unknown"));
});

test("missing Core uses generic degraded/blocked policy and supplied fuel reasons use the same result", () => {
  assert.equal(decide({}, withCore).state, "degraded");
  assert.ok(reason(decide({}, withCore), "no-core-fitted"));
  assert.equal(decide({}, { ...withCore, coreRequirement: "requireCore" }).state, "blocked");
  for (const fuelFailure of ["NO_FUEL", "fuel"] as const) {
    const result = decide({ core: fuelFailure === "fuel" ? "active" : "inactive", fuelFailure }, withCore);
    assert.equal(result.action, null); assert.ok(reason(result, "no-fuel"));
  }
});

test("Core disable requests shutdown; ACK and expired boundary do not prove final inactivity", () => {
  const initial = decide({ core: "active" });
  assert.deepEqual(initial.action, { kind: "deactivate", moduleID: 201, typeID: 62590 });
  const ack = decideMiningSupport(observed({ core: "active", sample: 101 }), initial.memory, policy, false,
    { actionID: initial.actionID!, outcome: "acknowledged" });
  assert.equal(ack.action, null); assert.ok(reason(ack, "core-shutting-down"));
  const pending = decideMiningSupport(observed({ core: "deactivation-pending", sample: 999 }), ack.memory, policy, false);
  assert.equal(pending.action, null); assert.ok(reason(pending, "core-shutting-down"));
  const final = decideMiningSupport(observed({ core: "inactive", sample: 1000 }), pending.memory, policy, false);
  assert.equal(final.state, "ready"); assert.equal(final.memory.orders.length, 0);
});

test("desired Core pending shutdown waits rather than starting a second lifecycle", () => {
  const result = decide({ core: "deactivation-pending", bursts: ["inactive"] }, withCore);
  assert.equal(result.action, null); assert.ok(reason(result, "core-shutting-down"));
});

test("policy reversal waits for an issued shutdown even before the pending flag appears, then starts from final state", () => {
  let result = decide({ core: "active" });
  result = decideMiningSupport(observed({ core: "active", compressors: ["inactive"], bursts: ["inactive"], sample: 101 }), result.memory, all, false,
    { actionID: result.actionID!, outcome: "acknowledged" });
  assert.equal(result.action, null); assert.ok(reason(result, "core-shutting-down"));
  for (let sample = 102; sample < 114; sample++) {
    result = decideMiningSupport(observed({ core: "deactivation-pending", compressors: ["inactive"], sample }), result.memory, all, false);
    assert.equal(result.action, null); assert.ok(reason(result, "core-shutting-down"));
    assert.equal(reason(result, "action-unconfirmed"), false, "proved cycle-end stop is allowed to finish");
  }
  result = decideMiningSupport(observed({ core: "inactive", compressors: ["inactive"], sample: 114 }), result.memory, all, false);
  assert.equal(result.action?.kind, "activate"); assert.equal(result.action?.moduleID, 201);
  const compressorStop = decide({ core: "active", compressors: ["active"] }, withCore);
  const enabled = decideMiningSupport(observed({ core: "active", compressors: ["active"], bursts: ["inactive"], sample: 101 }), compressorStop.memory, all, false);
  assert.equal(enabled.action, null); assert.ok(reason(enabled, "compressor-shutting-down"));
});

test("relocation readiness requires finalized inactive Core plus both authoritative mobility gates", () => {
  for (const options of [{ movement: "restricted" as const }, { warp: "restricted" as const },
    { movement: "unknown" as const }, { warp: "unknown" as const }]) {
    const result = decide({ core: "inactive", ...options }, all, true);
    assert.notEqual(result.state, "ready-for-relocation"); assert.equal(result.action, null);
  }
  assert.equal(decide({ core: "inactive" }, all, true).state, "ready-for-relocation");
  assert.notEqual(decide({ core: "deactivation-pending", movement: "unrestricted", warp: "unrestricted" }, all, true).state, "ready-for-relocation");
});

test("compressor startup waits for required Core, then activates the fitted compatible typelist module", () => {
  const prerequisite = decide({ core: "inactive", compressors: ["inactive"], bursts: ["inactive"] }, all);
  assert.equal(prerequisite.action?.moduleID, 201);
  const compressor = decideMiningSupport(observed({ core: "active", compressors: ["inactive"], sample: 101 }), prerequisite.memory, all, false);
  assert.deepEqual(compressor.action, { kind: "activate", moduleID: 301, targetID: 0 });
  assert.equal(compressor.compressors[0]?.capability.compressionTypeListID, 23);
  const active = decideMiningSupport(observed({ core: "active", compressors: ["active"], sample: 102 }), compressor.memory, all, false);
  assert.equal(active.action, null); assert.equal(active.state, "ready");
});

test("unknown dependency/typelist/service and disabled Core do not start dependent compressors", () => {
  for (const options of [{ requiresCore: null }, { typelist: null }, { compressors: ["unknown"] as const }]) {
    assert.equal(decide({ core: "active", compressors: ["inactive"], ...options }, all).action, null);
  }
  assert.equal(decide({ compressors: ["inactive"] }, { ...policy, enableCompression: true }).action, null);
  assert.ok(reason(decide({ compressors: ["inactive"] }, { ...policy, enableCompression: true }), "core-disabled"));
  const independent = decide({ compressors: ["inactive"], requiresCore: false }, { ...policy, enableCompression: true });
  assert.equal(independent.action?.moduleID, 301, "observed dependency is used, never a universal hull assumption");
});

test("relocation stops compressors before Core, waits for both effects and never starts bursts", () => {
  let result = decide({ core: "active", compressors: ["active"], bursts: ["inactive"] }, all, true);
  assert.equal(result.state, "preparing-relocation"); assert.equal(result.action?.kind, "deactivate"); assert.equal(result.action?.moduleID, 301);
  result = decideMiningSupport(observed({ core: "active", compressors: ["active"], bursts: ["inactive"], sample: 101 }), result.memory, all, true,
    { actionID: result.actionID!, outcome: "acknowledged" });
  assert.equal(result.action, null); assert.notEqual(result.state, "ready-for-relocation");
  result = decideMiningSupport(observed({ core: "active", compressors: ["inactive"], bursts: ["inactive"], sample: 102 }), result.memory, all, true);
  assert.equal(result.action?.moduleID, 201); assert.equal(result.action?.kind, "deactivate");
  result = decideMiningSupport(observed({ core: "deactivation-pending", compressors: ["inactive"], sample: 1000 }), result.memory, all, true);
  assert.equal(result.action, null);
  result = decideMiningSupport(observed({ core: "inactive", compressors: ["inactive"], sample: 1001 }), result.memory, all, true);
  assert.equal(result.state, "ready-for-relocation"); assert.equal(result.action, null);
});

test("compression disable settles service while desired Core stays active; dependent service settles before Core disable", () => {
  assert.equal(decide({ core: "active", compressors: ["active"] }, withCore).action?.moduleID, 301);
  const disabled = decide({ core: "active", compressors: ["active"] }, { ...policy, enableCompression: true });
  assert.equal(disabled.action?.moduleID, 301);
});

test("pending startup cannot grant relocation-ready even when the last observation is still inactive", () => {
  const starting = decide({ core: "inactive" }, withCore);
  const relocating = decideMiningSupport(observed({ core: "inactive", sample: 101 }), starting.memory, all, true);
  assert.equal(relocating.action, null); assert.notEqual(relocating.state, "ready-for-relocation");
});

test("unconfirmed orders are bounded, never retried blindly, and settle only from actual state", () => {
  let result = decide({ core: "inactive" }, withCore);
  for (let sample = 101; sample <= 112; sample++) {
    result = decideMiningSupport(observed({ core: "inactive", sample }), result.memory, withCore, false);
    assert.equal(result.action, null);
  }
  assert.equal(result.state, "blocked"); assert.ok(reason(result, "action-unconfirmed"));
  result = decideMiningSupport(observed({ core: "active", sample: 113 }), result.memory, withCore, false);
  assert.equal(result.state, "ready"); assert.equal(result.memory.orders.length, 0);
});

test("failed generic charge activation is bounded and preserves refusal code until eligible input changes", () => {
  const start = decide({ bursts: ["inactive"] });
  const fail = decideMiningSupport(observed({ bursts: ["inactive"], sample: 101 }), start.memory, policy, false,
    { actionID: start.actionID!, outcome: "failed", code: "CHARGE_NOT_COMPATIBLE" });
  assert.equal(fail.action, null); assert.equal(fail.state, "blocked"); assert.equal(fail.issues[0]?.code, "CHARGE_NOT_COMPATIBLE");
  const again = decideMiningSupport(observed({ bursts: ["inactive"], sample: 102 }), fail.memory, policy, false);
  assert.equal(again.action, null);
  const recovered = decideMiningSupport(observed({ bursts: ["active"], sample: 103 }), again.memory, policy, false);
  assert.equal(recovered.memory.refusals.length, 0, "observed success clears the refusal latch");
  assert.equal(decideMiningSupport(observed({ bursts: ["inactive"], sample: 104 }), recovered.memory, policy, false).action?.moduleID, 101);
});

test("Core NO_FUEL action refusal applies policy even if a prior quote said sufficient", () => {
  const start = decide({ core: "inactive" }, withCore);
  const fail = decideMiningSupport(observed({ core: "inactive", sample: 101 }), start.memory, withCore, false,
    { actionID: start.actionID!, outcome: "failed", code: "NO_FUEL" });
  assert.equal(fail.state, "degraded"); assert.equal(fail.action, null); assert.ok(reason(fail, "no-fuel"));
});

test("ship changes discard old orders; stale/unreadable observations and unknown fit fail closed", () => {
  const start = decide({ core: "inactive" }, withCore);
  const switched = decideMiningSupport(observed({ core: "inactive", shipID: 42, sample: 1 }), start.memory, withCore, false,
    { actionID: start.actionID!, outcome: "failed", code: "NO_FUEL" });
  assert.equal(switched.action?.moduleID, 201); assert.notEqual(switched.actionID, start.actionID);
  assert.equal(decideMiningSupport(observed({ sample: 99 }), start.memory, policy, true).action, null);
  assert.equal(decideMiningSupport(null, start.memory, policy, true).state, "waiting");
  assert.notEqual(decide({ unknownFit: true }, policy, true).state, "ready-for-relocation");
});

test("one action maximum and priority are independent of hull identity across mixed fits", () => {
  for (const shipTypeID of [42244, 28606, 28352, 123456]) {
    const first = decide({ shipTypeID, core: "inactive", compressors: ["inactive", "inactive"], bursts: ["inactive", "inactive"] }, all);
    assert.equal(first.action?.moduleID, 201); assert.equal(first.memory.orders.length, 1);
    const second = decide({ shipTypeID, core: "active", compressors: ["inactive", "inactive"], bursts: ["inactive", "inactive"] }, all);
    assert.equal(second.action?.moduleID, 301); assert.equal(second.memory.orders.length, 1);
  }
});
