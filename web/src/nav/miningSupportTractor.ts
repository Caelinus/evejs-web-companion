import type { BoundDogmaAllInfo } from "../bridge/boundDogma.ts";
import { readDictPairs, unwrapLong, type JsonValue } from "../bridge/wire.ts";
import { readObservedModuleReach } from "../bridge/moduleReach.ts";
import type { SpaceSnapshot } from "../store/types.ts";
import { surfaceDistanceMeters } from "../space/overview.ts";
import type { MiningSupportCapabilities, MiningSupportModule } from "./miningSupportCapabilities.ts";
import type { SupportPositionScope } from "./miningSupportPositioning.ts";
import type { ScriptAction } from "./scriptDecide.ts";

type ModuleAction = Extract<ScriptAction, { kind: "lock" | "activate" | "deactivate" }>;
export type SupportTractorAction = ModuleAction | { readonly kind: "claimContainer"; readonly itemID: number; readonly renewOnly: boolean }
  | { readonly kind: "releaseContainerClaim" };
interface Order { readonly actionID: number; readonly action: SupportTractorAction; readonly observations: number }
export interface SupportTractorMemory {
  readonly scope: SupportPositionScope | null;
  readonly runID: string | null;
  readonly targetID: number | null;
  readonly moduleID: number | null;
  readonly claim: { readonly itemID: number; readonly renewAtMs: number } | null;
  readonly order: Order | null;
  readonly nextActionID: number;
  readonly lastSampleMs: number | null;
  readonly lastDistanceMeters: number | null;
  readonly stalledObservations: number;
  readonly servedItemIDs: readonly number[];
  readonly fault: string | null;
}
export const freshSupportTractorMemory = (): SupportTractorMemory => ({ scope: null, runID: null, targetID: null, moduleID: null,
  claim: null, order: null, nextActionID: 1, lastSampleMs: null, lastDistanceMeters: null, stalledObservations: 0, servedItemIDs: [], fault: null });
export interface SupportTractorFeedback {
  readonly scope: SupportPositionScope; readonly runID: string; readonly actionID: number;
  readonly outcome: "acknowledged" | "failed"; readonly claimed?: boolean; readonly reason?: string;
}
export interface SupportTractorInput {
  readonly scope: SupportPositionScope; readonly runID: string;
  readonly scene: SpaceSnapshot | null; readonly dogma: BoundDogmaAllInfo | null;
  readonly capabilities: MiningSupportCapabilities; readonly lockedTargetIDs: readonly number[] | null;
  readonly receivedAtMs: number; readonly nowMs: number;
  /** Proven operation/test creation provenance, never all overview containers. */
  readonly eligibleContainerIDs: readonly number[];
  readonly allowedOwnerIDs: readonly number[];
  /** An inventory outcome is unresolved; stop the beam but retain its lease. */
  readonly claimSettlementBlocked?: boolean;
  readonly claimedByOtherItemIDs: readonly number[] | null;
  readonly mayWork: boolean; readonly settleReason: string | null;
  /** Collection retains the settled lease until its own source-empty proof. */
  readonly retainSettledClaim: boolean;
  readonly collectedContainerID?: number;
}
export interface SupportTractorResult {
  readonly state: "IDLE" | "WAIT" | "CLAIMING" | "PULLING" | "SETTLING" | "SETTLED" | "BLOCKED";
  readonly reason: string | null; readonly surfaceDistanceMeters: number | null;
  readonly readyContainerID: number | null;
  readonly action: SupportTractorAction | null; readonly actionID: number | null;
  readonly memory: SupportTractorMemory;
}
const sameScope = (a: SupportPositionScope | null, b: SupportPositionScope) => a !== null &&
  a.characterID === b.characterID && a.sessionEpoch === b.sessionEpoch && a.shipID === b.shipID && a.fleetID === b.fleetID &&
  a.solarSystemID === b.solarSystemID && a.fittingSignature === b.fittingSignature;
const id = (value: JsonValue | undefined) => { const n = unwrapLong(value); return n !== null && n > 0 && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null; };

/** Existing GetAllInfo active-effects environment proves the exact target.
 * The coherent scene supplies the activation effect identity; locks and ACKs
 * cannot substitute for either read. A disagreement remains unknown. */
export function readObservedTractorTarget(scene: SpaceSnapshot, dogma: BoundDogmaAllInfo | null, scope: SupportPositionScope,
  module: MiningSupportModule): { readonly state: "active" | "inactive" | "unknown"; readonly targetID: number | null } {
  const unknown = { state: "unknown" as const, targetID: null };
  if (!dogma || String(dogma.activeShipID) !== String(scope.shipID) || String(dogma.characterID) !== String(scope.characterID)) return unknown;
  const entry = dogma.ships.find(row => String(row.itemID) === String(module.itemID) && row.typeID === module.typeID && row.categoryID === 7
    && String(row.locationID) === String(scope.shipID) && String(row.ownerID) === String(scope.characterID));
  const raw = entry?.activeEffects;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("type" in raw) || raw.type !== "dict" || !("entries" in raw) || !Array.isArray(raw.entries)) return unknown;
  const active = scene.ship?.activeModuleIDs;
  if (!active) return unknown;
  const pairs = readDictPairs(raw);
  if (!active.includes(module.itemID)) {
    // A targeted effect still present in dogma is not a settled beam.
    if (pairs.some(([, value]) => !Array.isArray(value) || value[3] != null)) return unknown;
    return { state: "inactive", targetID: null };
  }
  const effect = scene.ship?.coreMobilityFuel?.modules.find(row => row.moduleID === module.itemID && row.typeID === module.typeID)?.effect;
  if (effect?.effectName?.toLowerCase() !== "tractorbeamcan" || effect.effectID === null) return unknown;
  const values = pairs.filter(([key]) => id(key as JsonValue) === effect.effectID).map(([, value]) => value);
  const value = values.length === 1 && Array.isArray(values[0]) ? values[0] : null;
  if (!value || value.length < 10 || id(value[0]) !== module.itemID || id(value[1]) !== scope.characterID || id(value[2]) !== scope.shipID ||
    id(value[6]) !== effect.effectID || id(value[3]) === null) return unknown;
  return { state: "active", targetID: id(value[3]) };
}

/** Sequential beam/lease owner. No movement, transfer, empty mark or mining.
 * Refusal/unknown keeps the selected lease; safe release requires actual beam
 * inactivity. The normal adapter arbitrates support/movement before this. */
export function decideSupportTractor(input: SupportTractorInput, previous: SupportTractorMemory,
  feedback?: SupportTractorFeedback): SupportTractorResult {
  const changed = !sameScope(previous.scope, input.scope) || previous.runID !== input.runID;
  let memory = changed ? { ...freshSupportTractorMemory(), scope: { ...input.scope }, runID: input.runID } : { ...previous };
  let action: SupportTractorAction | null = null, actionID: number | null = null, distance: number | null = null, ready: number | null = null;
  const finish = (state: SupportTractorResult["state"], reason: string | null = null): SupportTractorResult => ({ state, reason,
    surfaceDistanceMeters: distance, readyContainerID: ready, action, actionID, memory });
  if (changed && previous.scope && (previous.claim || previous.order)) { memory = { ...previous }; return finish("BLOCKED", "previous-tractor-scope-needs-settlement"); }
  const scene = input.scene, own = scene?.ship, sample = scene?.sampledAtMs;
  if (!input.runID || !scene?.inSpace || !own || scene.shipID !== input.scope.shipID || own.itemID !== input.scope.shipID || own.characterID !== input.scope.characterID ||
    scene.solarSystemID !== input.scope.solarSystemID || own.geometryAvailable !== true || own.activeModuleIDs === null ||
    input.capabilities.scope.shipID !== input.scope.shipID || input.capabilities.scope.fittingSignature !== input.scope.fittingSignature || sample == null ||
    !Number.isFinite(input.receivedAtMs) || !Number.isFinite(input.nowMs) || input.receivedAtMs > input.nowMs || input.nowMs - input.receivedAtMs >= 10000) return finish("WAIT", "own-observation-unknown");
  if (memory.lastSampleMs !== null && sample <= memory.lastSampleMs) return finish("WAIT", "observation-not-refreshed");
  memory.lastSampleMs = sample;
  const modules = [...input.capabilities.tractors.modules].sort((a, b) => a.itemID - b.itemID);
  if (input.capabilities.tractors.presence === "unknown") return finish("WAIT", "tractor-capability-unknown");
  const targets = modules.map(module => ({ module, observed: readObservedTractorTarget(scene, input.dogma, input.scope, module) }));
  const running = modules.find(row => own.activeModuleIDs!.includes(row.itemID));
  const emit = (next: SupportTractorAction) => { action = next; actionID = memory.nextActionID++;
    memory.order = { actionID, action: next, observations: 0 }; };
  const order = memory.order;
  const otherRunning = memory.claim ? modules.find(row => row.itemID !== memory.moduleID && own.activeModuleIDs!.includes(row.itemID)) : null;
  if (otherRunning) { memory.fault = "concurrent-tractor-activity"; emit({ kind: "deactivate", moduleID: otherRunning.itemID, typeID: otherRunning.typeID }); return finish("SETTLING", memory.fault); }
  if (order) {
    const issued = order.action;
    const receipt = feedback && sameScope(feedback.scope, input.scope) && feedback.runID === input.runID && feedback.actionID === order.actionID ? feedback : null;
    const observed = "moduleID" in issued ? targets.find(row => row.module.itemID === issued.moduleID)?.observed : null;
    const confirmed = issued.kind === "lock" ? input.lockedTargetIDs?.includes(issued.targetID) === true
      : issued.kind === "activate" ? observed?.state === "active" && observed.targetID === issued.targetID
      : issued.kind === "deactivate" ? observed?.state === "inactive" : false;
    if (confirmed) memory.order = null;
    else if (receipt && (issued.kind === "claimContainer" || issued.kind === "releaseContainerClaim")) {
      memory.order = null;
      if (receipt.outcome === "failed" || issued.kind === "claimContainer" && receipt.claimed !== true) {
        if (issued.kind === "claimContainer" && !issued.renewOnly && receipt.claimed === false) { memory.targetID = null; memory.moduleID = null; return finish("WAIT", "container-claimed-by-other"); }
        memory.fault = receipt.reason ?? "claim-action-unconfirmed";
      } else if (issued.kind === "claimContainer") memory.claim = { itemID: issued.itemID, renewAtMs: input.nowMs + 10000 };
      else { memory.servedItemIDs = [...memory.servedItemIDs, memory.targetID!].slice(-128); memory.claim = null;
        memory.targetID = null; memory.moduleID = null; memory.lastDistanceMeters = null; memory.stalledObservations = 0; return finish("SETTLED"); }
    } else {
      const lifecycle = "moduleID" in issued ? own.coreMobilityFuel?.modules.find(row => row.moduleID === issued.moduleID)?.effect : null;
      const deferred = issued.kind === "deactivate" && (lifecycle?.deactivationRequestedAtMs ?? 0) > 0 && (lifecycle?.deactivateAtMs ?? 0) > sample;
      memory.order = { ...order, observations: order.observations + (deferred ? 0 : 1) };
      if (issued.kind === "activate" && observed?.state === "active" && observed.targetID !== issued.targetID) memory.fault = "tractor-target-unconfirmed";
      if (receipt?.outcome === "failed") memory.fault = receipt.reason ?? "tractor-action-refused";
      if (memory.order.observations >= 8) memory.fault = "tractor-action-unconfirmed";
    }
  }
  const stable = own.motionAvailable === true && own.mode === "STOP" && Math.hypot(own.velocity.x, own.velocity.y, own.velocity.z) <= 0.5;
  const settle = !input.mayWork || !!input.settleReason || !stable;
  // Deactivation of observed activity is safe even if a prior lock/activation
  // was refused. Keep uncertainty and lease until explicit recovery.
  if (settle || memory.fault) {
    if (running && memory.order?.action.kind !== "deactivate") { emit({ kind: "deactivate", moduleID: running.itemID, typeID: running.typeID }); return finish("SETTLING", input.settleReason ?? memory.fault); }
    if (memory.fault) return finish("BLOCKED", memory.fault);
    if (memory.order || targets.some(row => row.observed.state !== "inactive")) return finish("SETTLING", "tractor-stop-pending");
    if (memory.claim) {
      if (input.claimSettlementBlocked) return finish("BLOCKED", "collection-transfer-unresolved");
      emit({ kind: "releaseContainerClaim" }); return finish("SETTLING", input.settleReason);
    }
    memory.targetID = null; memory.moduleID = null;
    return finish("SETTLED", input.settleReason);
  }
  if (memory.order) return finish("WAIT", "tractor-action-pending");
  // A successful full transfer may remove the empty can from the scene. Its
  // caller-owned source-empty proof is sufficient only after every beam is
  // positively inactive; missing target geometry must not strand this lease.
  if (memory.claim && input.collectedContainerID === memory.claim.itemID) {
    if (targets.some(row => row.observed.state !== "inactive")) return finish("WAIT", "tractor-stop-pending");
    if (input.claimSettlementBlocked) return finish("BLOCKED", "collection-transfer-unresolved");
    emit({ kind: "releaseContainerClaim" }); return finish("SETTLING", "collected-container-empty");
  }
  if (!memory.claim) {
    if (running) { emit({ kind: "deactivate", moduleID: running.itemID, typeID: running.typeID }); return finish("SETTLING", "unowned-beam-activity"); }
    if (targets.some(row => row.observed.state === "unknown") || input.claimedByOtherItemIDs === null || input.lockedTargetIDs === null) return finish("WAIT", "tractor-or-claim-authority-unknown");
    if (input.eligibleContainerIDs.length > 128 || input.allowedOwnerIDs.length > 128 || [...input.eligibleContainerIDs, ...input.allowedOwnerIDs].some(n => !Number.isSafeInteger(n) || n <= 0)) return finish("WAIT", "container-provenance-invalid");
    const usable = modules.filter(row => row.online && row.hasActivationCycle === true).map(module => ({ module, reach: readObservedModuleReach(scene, module.itemID, module.typeID) }))
      .filter(row => row.reach?.family === "tractor" && row.reach.maxRangeMeters !== null && row.reach.settlementSurfaceDistanceMeters !== null);
    const candidates = scene.entities.filter(row => input.eligibleContainerIDs.includes(row.itemID) && !memory.servedItemIDs.includes(row.itemID) &&
      !input.claimedByOtherItemIDs!.includes(row.itemID) && (row.kind === "container" || row.kind === "wreck") && row.ownerID !== null && input.allowedOwnerIDs.includes(row.ownerID) && row.geometryAvailable === true)
      .map(row => ({ row, distance: surfaceDistanceMeters(own.position, own.radius, row.position, row.radius) })).filter(row => Number.isFinite(row.distance))
      .sort((a, b) => a.distance - b.distance || a.row.itemID - b.row.itemID);
    for (const candidate of candidates) {
      const chosen = usable.find(row => candidate.distance <= row.reach!.maxRangeMeters!);
      if (!chosen) continue;
      memory.targetID = candidate.row.itemID; memory.moduleID = chosen.module.itemID; distance = candidate.distance;
      emit({ kind: "claimContainer", itemID: candidate.row.itemID, renewOnly: false }); return finish("CLAIMING");
    }
    return finish(usable.length ? "IDLE" : "WAIT", usable.length ? "no-eligible-container" : "tractor-reach-unavailable");
  }
  const selected = modules.find(row => row.itemID === memory.moduleID);
  const observed = targets.find(row => row.module.itemID === memory.moduleID)?.observed;
  const container = scene.entities.filter(row => row.itemID === memory.claim!.itemID);
  const target = container.length === 1 ? container[0] : null;
  const reach = selected ? readObservedModuleReach(scene, selected.itemID, selected.typeID) : null;
  if (!target || target.geometryAvailable !== true || !input.eligibleContainerIDs.includes(target.itemID) || target.ownerID === null || !input.allowedOwnerIDs.includes(target.ownerID) ||
    !selected?.online || reach?.family !== "tractor" || reach.maxRangeMeters === null || reach.settlementSurfaceDistanceMeters === null) {
    const ineligible = target && (!input.eligibleContainerIDs.includes(target.itemID) || target.ownerID !== null && !input.allowedOwnerIDs.includes(target.ownerID));
    if (ineligible) memory.fault = "selected-container-ineligible";
    if (running) { emit({ kind: "deactivate", moduleID: running.itemID, typeID: running.typeID }); return finish("SETTLING", memory.fault ?? "selected-container-or-reach-unknown"); }
    if (memory.fault) return finish("BLOCKED", memory.fault);
    if (input.nowMs >= memory.claim.renewAtMs) { emit({ kind: "claimContainer", itemID: memory.claim.itemID, renewOnly: true }); return finish("WAIT", "renewing-claim-with-unknown-target"); }
    return finish("WAIT", "selected-container-or-reach-unknown");
  }
  distance = surfaceDistanceMeters(own.position, own.radius, target.position, target.radius);
  if (!Number.isFinite(distance)) return finish("WAIT", "container-geometry-unknown");
  // Millimetre quantisation absorbs floating-point geometry at AU-sized origin
  // coordinates; it does not borrow the activation gate's one-metre grace.
  const arrived = Math.round(distance * 1000) / 1000 <= reach.settlementSurfaceDistanceMeters && target.motionAvailable === true && Math.hypot(target.velocity.x, target.velocity.y, target.velocity.z) <= 0.5;
  if (observed?.state === "active" && observed.targetID !== target.itemID || observed?.state === "unknown") {
    memory.fault = "tractor-target-unconfirmed"; return finish("BLOCKED", memory.fault);
  }
  if (arrived || input.collectedContainerID === target.itemID) {
    if (observed?.state === "active") { emit({ kind: "deactivate", moduleID: selected.itemID, typeID: selected.typeID }); return finish("SETTLING", "container-arrived"); }
    if (targets.some(row => row.observed.state !== "inactive")) return finish("WAIT", "other-tractor-unsettled");
    if (input.retainSettledClaim && input.collectedContainerID !== target.itemID) {
      if (input.nowMs >= memory.claim.renewAtMs) { emit({ kind: "claimContainer", itemID: target.itemID, renewOnly: true }); return finish("SETTLING", "renewing-settled-claim"); }
      ready = target.itemID; return finish("SETTLED", "container-ready-for-collection");
    }
    if (input.claimSettlementBlocked) return finish("BLOCKED", "collection-transfer-unresolved");
    emit({ kind: "releaseContainerClaim" }); return finish("SETTLING", "container-arrived");
  }
  if (input.nowMs >= memory.claim.renewAtMs) { emit({ kind: "claimContainer", itemID: target.itemID, renewOnly: true }); return finish("PULLING", "renewing-claim"); }
  if (distance > reach.maxRangeMeters) return finish("WAIT", "container-outside-tractor-range");
  if (observed?.state === "active") {
    memory.stalledObservations = memory.lastDistanceMeters !== null && distance >= memory.lastDistanceMeters - 0.001 ? memory.stalledObservations + 1 : 0;
    memory.lastDistanceMeters = distance;
    if (memory.stalledObservations >= 90) { memory.fault = "tractor-progress-unconfirmed"; return finish("BLOCKED", memory.fault); }
    return finish("PULLING");
  }
  if (input.lockedTargetIDs === null) return finish("WAIT", "target-locks-unknown");
  if (!input.lockedTargetIDs.includes(target.itemID)) { emit({ kind: "lock", targetID: target.itemID }); return finish("PULLING"); }
  emit({ kind: "activate", moduleID: selected.itemID, targetID: target.itemID }); return finish("PULLING");
}
