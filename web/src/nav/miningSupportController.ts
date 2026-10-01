import type { MiningSupportModule } from "./miningSupportCapabilities.ts";
import type { MiningSupportServiceSnapshot } from "./miningSupportServices.ts";
import type { CapabilityScope } from "./scriptCapabilities.ts";
import type { ScriptAction } from "./scriptDecide.ts";

export interface MiningSupportPolicy {
  readonly maintainBursts: boolean;
  readonly useIndustrialCore: boolean;
  readonly enableCompression: boolean;
  readonly coreRequirement: "continueWithoutCore" | "requireCore";
}
export type MiningSupportAction = Extract<ScriptAction, { kind: "activate" | "deactivate" }>;
export type MiningSupportState = "maintaining" | "ready" | "degraded" | "blocked" | "waiting" | "preparing-relocation" | "ready-for-relocation";
export type MiningSupportReason = "observation-unavailable" | "observation-stale" | "observation-not-refreshed" |
  "capability-unknown" | "service-state-unknown" | "module-offline" | "module-cycle-unknown" | "module-no-cycle" |
  "no-core-fitted" | "core-disabled" | "no-fuel" | "fuel-unknown" | "burst-no-charge" |
  "core-shutting-down" | "compressor-shutting-down" | "core-required" | "compressor-typelist-unknown" |
  "compression-service-inactive" | "mobility-unknown" | "mobility-restricted" | "action-pending" | "action-unconfirmed" | "action-refused";
export interface MiningSupportIssue {
  readonly reason: MiningSupportReason;
  readonly severity: "waiting" | "degraded" | "blocked";
  readonly moduleID: number | null;
  readonly code: string | null;
}
type Family = "core" | "compressor" | "burst";
interface Order {
  readonly actionID: number;
  readonly action: MiningSupportAction;
  readonly typeID: number;
  readonly family: Family;
  readonly unconfirmedObservations: number;
}
interface Refusal {
  readonly action: MiningSupportAction;
  readonly moduleID: number;
  readonly fingerprint: string;
  readonly code: string | null;
}
export interface MiningSupportMemory {
  readonly scope: CapabilityScope | null;
  readonly lastSampleMs: number | null;
  readonly lastActionSampleMs: number | null;
  readonly nextActionID: number;
  readonly orders: readonly Order[];
  readonly refusals: readonly Refusal[];
}
export interface MiningSupportActionResult {
  /** Correlate feedback with result.actionID; an ACK never completes an order. */
  readonly actionID: number;
  readonly outcome: "acknowledged" | "failed";
  readonly code?: string | null;
}
export interface MiningSupportResult {
  readonly state: MiningSupportState;
  readonly issues: readonly MiningSupportIssue[];
  readonly action: MiningSupportAction | null;
  readonly actionID: number | null;
  readonly memory: MiningSupportMemory;
  /** Own fitted identities/typelists only; external facilities grant no authority. */
  readonly compressors: readonly { readonly capability: MiningSupportModule; readonly state: "active" | "inactive" | "deactivation-pending" | "unknown" }[];
}
export const freshMiningSupportMemory = (): MiningSupportMemory => ({ scope: null, lastSampleMs: null,
  lastActionSampleMs: null, nextActionID: 1, orders: [], refusals: [] });
const MAX_UNCONFIRMED_OBSERVATIONS = 8;
const sorted = <T extends { readonly itemID: number }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => a.itemID - b.itemID);

/** Read-only reconciliation for a quiesced session. Never creates new orders
 * or treats dispatch feedback as completion. Exact fresh module state wins. */
export function observeMiningSupportOrders(services: MiningSupportServiceSnapshot, previous: MiningSupportMemory): readonly Order[] {
  if (services.capabilities.scope.shipID !== previous.scope?.shipID ||
      services.capabilities.scope.fittingSignature !== previous.scope.fittingSignature || services.sampledAtMs === null || !Number.isFinite(services.sampledAtMs) ||
      previous.lastSampleMs !== null && services.sampledAtMs <= previous.lastSampleMs) return previous.orders;
  const self = services.compression.facilities.find(row => row.origin === "self" && row.shipID === previous.scope!.shipID);
  return previous.orders.filter(order => {
    let state: string = "unknown";
    if (order.family === "core" || order.family === "burst") {
      const row = (order.family === "core" ? services.cores : services.bursts).find(row =>
        row.capability.itemID === order.action.moduleID && row.capability.typeID === order.typeID);
      state = row?.state ?? "unknown";
    } else {
      const fitted = services.capabilities.compressors.modules.find(row => row.itemID === order.action.moduleID && row.typeID === order.typeID);
      const present = self?.compressors?.find(row => row.moduleID === order.action.moduleID);
      if (fitted && self && self.state !== "unknown" && self.compressors !== null && (!present || present.typeID === order.typeID))
        state = present ? "active" : "inactive";
    }
    return !(order.action.kind === "activate" ? state === "active" || state === "deactivation-pending" : state === "inactive");
  });
}

/** Pure stateful decider for ONE pilot. Caller owns observation refresh and
 * dispatch through the existing generic module action executor. Keep ONE memory
 * owner per pilot; other module controllers must yield the same module IDs.
 * Priority: compressor/Core settlement > desired Core > compressors > bursts.
 * Each call emits at most one action; completion always comes from observation.
 */
export function decideMiningSupport(
  services: MiningSupportServiceSnapshot | null,
  previous: MiningSupportMemory,
  policy: MiningSupportPolicy,
  relocationRequested: boolean,
  feedback?: MiningSupportActionResult,
  stopAll = false,
): MiningSupportResult {
  const issues: MiningSupportIssue[] = [];
  let action: MiningSupportAction | null = null;
  let actionID: number | null = null;
  let memory = { ...previous, orders: [...previous.orders], refusals: [...previous.refusals] };
  const compressors: MiningSupportResult["compressors"][number][] = [];
  const issue = (reason: MiningSupportReason, severity: MiningSupportIssue["severity"] = "waiting", moduleID: number | null = null, code: string | null = null) => {
    issues.push({ reason, severity, moduleID, code });
  };
  const finish = (state?: MiningSupportState): MiningSupportResult => ({ action, actionID, memory, compressors,
    issues, state: state ?? (issues.some(i => i.severity === "blocked") ? "blocked"
      : issues.some(i => i.severity === "waiting") ? "waiting"
      : issues.length > 0 ? "degraded" : action !== null ? "maintaining" : "ready") });
  const shipID = services?.capabilities.scope.shipID ?? null;
  const sample = services?.sampledAtMs ?? null;
  if (!services || shipID === null || sample === null || !Number.isFinite(sample)) {
    issue("observation-unavailable"); return finish();
  }
  const sameShip = previous.scope?.shipID === shipID;
  if (sameShip && previous.lastSampleMs !== null && sample < previous.lastSampleMs) {
    issue("observation-stale"); return finish();
  }
  const caps = services.capabilities;
  const self = services.compression.facilities.find(row => row.origin === "self" && row.shipID === shipID);
  for (const capability of sorted(caps.compressors.modules)) {
    const present = self?.compressors?.find(row => row.moduleID === capability.itemID);
    const effect = services.compressorEffects?.find(row => row.moduleID === capability.itemID && row.typeID === capability.typeID)?.effect;
    compressors.push({ capability, state: !self || self.state === "unknown" || self.compressors === null || (present && present.typeID !== capability.typeID) ? "unknown"
      : present ? (effect?.deactivationRequestedAtMs ?? 0) > 0 || (effect?.deactivateAtMs ?? 0) > 0 ? "deactivation-pending" : "active" : "inactive" });
  }
  const cores = [...services.cores].sort((a, b) => a.capability.itemID - b.capability.itemID);
  const bursts = [...services.bursts].sort((a, b) => a.capability.itemID - b.capability.itemID);
  const modules = [...cores.map(row => ({ capability: row.capability, state: row.state, family: "core" as const })),
    ...compressors.map(row => ({ ...row, family: "compressor" as const })), ...bursts.map(row => ({ ...row, family: "burst" as const }))];
  const fingerprint = (moduleID: number): string => {
    const row = modules.find(row => row.capability.itemID === moduleID);
    const core = cores.find(row => row.capability.itemID === moduleID);
    return JSON.stringify([row?.capability, core?.fuel.startupQuote]);
  };
  memory = { ...memory, scope: { ...caps.scope }, lastSampleMs: sample,
    lastActionSampleMs: sameShip ? previous.lastActionSampleMs : null,
    orders: sameShip ? memory.orders.filter(order => modules.some(row => row.capability.itemID === order.action.moduleID && row.capability.typeID === order.typeID)) : [],
    refusals: sameShip ? memory.refusals.filter(refusal => {
      const state = modules.find(row => row.capability.itemID === refusal.moduleID)?.state;
      const resolved = refusal.action.kind === "activate" ? state === "active" || state === "deactivation-pending" : state === "inactive";
      return !resolved && refusal.fingerprint === fingerprint(refusal.moduleID);
    }) : [] };
  const freshSample = !sameShip || previous.lastSampleMs !== sample;
  const compressorStopBeforeBoundary = (order: Order): boolean => {
    if (order.action.kind !== "deactivate" || order.family === "core") return false;
    const effect = order.family === "burst" ? services.bursts.find(row => row.capability.itemID === order.action.moduleID && row.capability.typeID === order.typeID)?.effect
      : services.compressorEffects?.find(row => row.moduleID === order.action.moduleID && row.typeID === order.typeID)?.effect;
    const deadline = effect?.deactivateAtMs;
    return effect?.effectName?.toLowerCase() === (order.family === "burst" ? "modulebonuswarfarelinkmining" : "industrialitemcompression") &&
      typeof deadline === "number" && Number.isFinite(deadline) && deadline > sample &&
      (effect?.deactivationRequestedAtMs ?? 0) > 0;
  };
  for (const order of [...memory.orders]) {
    const state = modules.find(row => row.capability.itemID === order.action.moduleID)?.state;
    const confirmed = order.action.kind === "activate" ? state === "active" || state === "deactivation-pending" : state === "inactive";
    // Confirmation beats delayed refusal feedback; neither HTTP success nor ACK
    // is used as an inactive/active state observation.
    if (confirmed || (feedback?.actionID === order.actionID && feedback.outcome === "failed")) {
      memory.orders = memory.orders.filter(row => row.actionID !== order.actionID);
      if (!confirmed) memory.refusals.push({ action: order.action, moduleID: order.action.moduleID,
        fingerprint: fingerprint(order.action.moduleID), code: feedback?.code ?? null });
    } else if (freshSample && !compressorStopBeforeBoundary(order)) {
      memory.orders = memory.orders.map(row => row.actionID === order.actionID
        ? { ...row, unconfirmedObservations: row.unconfirmedObservations + 1 } : row);
    }
  }
  const pending = (moduleID: number): boolean => {
    const order = memory.orders.find(row => row.action.moduleID === moduleID);
    if (!order) return false;
    const provedPending = compressorStopBeforeBoundary(order) || (order.family === "core" && order.action.kind === "deactivate" &&
      modules.find(row => row.capability.itemID === moduleID)?.state === "deactivation-pending");
    const unconfirmed = !provedPending && order.unconfirmedObservations >= MAX_UNCONFIRMED_OBSERVATIONS;
    issue(unconfirmed ? "action-unconfirmed"
      : order.action.kind === "deactivate" ? order.family === "core" ? "core-shutting-down" : "compressor-shutting-down" : "action-pending",
    unconfirmed ? "blocked" : "waiting", moduleID);
    return true;
  };
  const refused = (moduleID: number, kind: MiningSupportAction["kind"]) => memory.refusals.find(row => row.moduleID === moduleID && row.action.kind === kind);
  const emit = (capability: MiningSupportModule, family: Family, kind: MiningSupportAction["kind"]): boolean => {
    if (pending(capability.itemID)) return false;
    const refusal = refused(capability.itemID, kind);
    if (refusal) { issue("action-refused", "blocked", capability.itemID, refusal.code); return false; }
    if (memory.lastActionSampleMs === sample) { issue("observation-not-refreshed"); return false; }
    action = kind === "activate" ? { kind, moduleID: capability.itemID, targetID: 0 }
      : { kind, moduleID: capability.itemID, typeID: capability.typeID };
    actionID = memory.nextActionID++;
    memory.orders.push({ actionID, action, family, typeID: capability.typeID, unconfirmedObservations: 0 });
    memory.lastActionSampleMs = sample;
    return true;
  };
  const eligible = (capability: MiningSupportModule): boolean => {
    if (!capability.online) { issue("module-offline", "degraded", capability.itemID); return false; }
    if (capability.hasActivationCycle === null) { issue("module-cycle-unknown", "waiting", capability.itemID); return false; }
    if (!capability.hasActivationCycle) { issue("module-no-cycle", "degraded", capability.itemID); return false; }
    return true;
  };
  const noCore = (reason: "no-fuel" | "no-core-fitted" | "core-disabled", moduleID: number | null = null) =>
    issue(reason, policy.coreRequirement === "requireCore" ? "blocked" : "degraded", moduleID);
  const stopCore = relocationRequested || !policy.useIndustrialCore;
  const stops = compressors.filter(row => relocationRequested || !policy.enableCompression || (stopCore && row.capability.requiresActiveCore !== false));
  // Manual generic stops may defer to a cycle boundary. Stop compressors FIRST
  // and observe effect removal before stopping their Core prerequisite.
  for (const row of stops) {
    if (row.state === "active") {
      if (emit(row.capability, "compressor", "deactivate")) return finish(relocationRequested ? "preparing-relocation" : undefined);
    } else if (row.state === "deactivation-pending") {
      if (!pending(row.capability.itemID)) issue("compressor-shutting-down", "waiting", row.capability.itemID);
    } else if (row.state === "unknown") issue("service-state-unknown", "waiting", row.capability.itemID);
    else pending(row.capability.itemID);
  }
  if (issues.length > 0) return finish();
  if (stopCore) {
    if (caps.industrialCores.presence === "unknown" || caps.compressors.presence === "unknown") issue("capability-unknown");
    for (const core of cores) {
      if (core.state === "active") {
        if (emit(core.capability, "core", "deactivate")) return finish(relocationRequested ? "preparing-relocation" : undefined);
      } else if (core.state === "deactivation-pending") issue("core-shutting-down", "waiting", core.capability.itemID);
      else if (core.state === "unknown") issue("service-state-unknown", "waiting", core.capability.itemID);
      else pending(core.capability.itemID);
    }
    if (issues.length > 0) return finish();
  }
  if (relocationRequested) {
    if (stopAll) {
      if (caps.bursts.presence === "unknown") issue("capability-unknown");
      for (const row of bursts) {
        if (row.state === "active") { if (emit(row.capability, "burst", "deactivate")) return finish("preparing-relocation"); }
        else if (row.state === "deactivation-pending") { if (!pending(row.capability.itemID)) issue("action-pending"); }
        else if (row.state === "unknown") issue("service-state-unknown");
        else pending(row.capability.itemID);
      }
    }
    if (!self || self.state !== "inactive" || self.compressors?.length !== 0) issue("service-state-unknown");
    const { movement, warp } = services.mobility;
    if (movement.verdict === "unknown" || warp.verdict === "unknown") issue("mobility-unknown");
    else if (movement.verdict !== "unrestricted" || warp.verdict !== "unrestricted") issue("mobility-restricted", "waiting", null, movement.reasonCode ?? warp.reasonCode);
    return finish(issues.length > 0 ? undefined : "ready-for-relocation");
  }
  // Policy reversal cannot cancel an already-issued deferred shutdown. Observe
  // its completion before restarting Core/compressors or beginning maintenance.
  const shutdown = memory.orders.find(order => order.action.kind === "deactivate");
  if (shutdown) { pending(shutdown.action.moduleID); return finish(); }
  let coreReady = cores.some(core => core.state === "active" && core.fuelFailure === "unknown");
  if (policy.useIndustrialCore) {
    const stopping = cores.find(core => core.state === "deactivation-pending");
    if (stopping) { issue("core-shutting-down", "waiting", stopping.capability.itemID); return finish(); }
    if (cores.some(core => core.fuelFailure !== "unknown")) { noCore("no-fuel"); coreReady = false; }
    else if (!coreReady) {
      if (caps.industrialCores.presence === "unknown" || cores.some(core => core.state === "unknown")) { issue("service-state-unknown"); return finish(); }
      const core = cores[0];
      if (!core) noCore("no-core-fitted");
      else if (pending(core.capability.itemID)) return finish();
      else {
        const quote = core.fuel.startupQuote;
        const failure = refused(core.capability.itemID, "activate");
        if (failure?.code === "NO_FUEL") noCore("no-fuel", core.capability.itemID);
        else if (quote.availability !== "available" || quote.moduleID !== core.capability.itemID || quote.sufficient === null) {
          issue("fuel-unknown", "waiting", core.capability.itemID, quote.reason); return finish();
        } else if (quote.sufficient === false) noCore("no-fuel", core.capability.itemID);
        else if (eligible(core.capability) && emit(core.capability, "core", "activate")) return finish();
      }
    }
    if (issues.some(row => row.severity === "blocked" || row.severity === "waiting")) return finish();
  }
  if (policy.enableCompression) {
    if (caps.compressors.presence === "unknown") { issue("capability-unknown"); return finish(); }
    for (const row of compressors) {
      if (row.state === "unknown") { issue("service-state-unknown", "waiting", row.capability.itemID); continue; }
      if (row.state === "deactivation-pending") {
        if (!pending(row.capability.itemID)) issue("compressor-shutting-down", "waiting", row.capability.itemID);
        continue;
      }
      if (row.state === "active") {
        if (self?.state !== "active") issue("compression-service-inactive", "degraded", row.capability.itemID);
        continue;
      }
      if (pending(row.capability.itemID)) continue;
      const cap = row.capability;
      if (cap.requiresActiveCore === null) { issue("core-required", "waiting", cap.itemID); continue; }
      if (cap.requiresActiveCore && !coreReady) {
        issue(policy.useIndustrialCore ? "core-required" : "core-disabled", "degraded", cap.itemID); continue;
      }
      if (cap.compressionTypeListID === null || cap.compressionTypeListID <= 0) { issue("compressor-typelist-unknown", "waiting", cap.itemID); continue; }
      if (eligible(cap) && emit(cap, "compressor", "activate")) return finish();
    }
  }
  if (policy.maintainBursts) {
    if (caps.bursts.presence === "unknown") issue("capability-unknown");
    for (const row of bursts) {
      if (row.state === "deactivation-pending") { if (!pending(row.capability.itemID)) issue("action-pending"); continue; }
      if (row.state === "active") continue;
      if (row.state === "unknown") { issue("service-state-unknown", "waiting", row.capability.itemID); continue; }
      if (pending(row.capability.itemID)) continue;
      const charge = row.capability.charge;
      const chargeIdentity = charge && (typeof charge.itemID === "number" ? Number.isSafeInteger(charge.itemID) && charge.itemID > 0
        : charge.itemID.length === 3 && charge.itemID[0] === caps.scope.shipID && charge.itemID[1] > 0 && charge.itemID[2] === charge.typeID);
      if (!charge || !(chargeIdentity && charge.typeID > 0 && Number.isFinite(charge.quantity) && charge.quantity > 0)) {
        issue("burst-no-charge", "degraded", row.capability.itemID); continue;
      }
      if (eligible(row.capability) && emit(row.capability, "burst", "activate")) return finish();
    }
  }
  return finish();
}
