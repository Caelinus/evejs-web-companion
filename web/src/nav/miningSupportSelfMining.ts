import { decideMiningAction, freightHoldItemIDs, holdUnits, isMineableRock, lowestHealth, type MiningDecisionMemory, type MiningObservation, type MiningPlan } from "./miningBotLoop.ts";
import { decideMiningDroneFlight, freshDroneMemory, type MiningDroneState } from "./miningDroneFlight.ts";
import type { MiningSupportCapabilities } from "./miningSupportCapabilities.ts";
import type { SupportPositionScope } from "./miningSupportPositioning.ts";
import type { ScriptAction } from "./scriptDecide.ts";
import { readObservedModuleReach } from "../bridge/moduleReach.ts";
import { surfaceDistanceMeters } from "../space/overview.ts";
import { measureSpace } from "./autopilotLoop.ts";
import { hostilesInReach } from "./scriptConditions.ts";

type WorkAction = Extract<ScriptAction, { kind: "lock" | "activate" | "deactivate" | "launchDrones" | "recallDrones" | "mineDrones" | "engageDrones" }>;
interface Order { readonly actionID: number; readonly action: Extract<WorkAction, { kind: "lock" | "activate" | "deactivate" }>; readonly observations: number }
export interface SupportSelfMiningMemory {
  readonly scope: SupportPositionScope | null;
  readonly planKey: string | null;
  readonly engine: MiningDecisionMemory;
  readonly lastSampleMs: number | null;
  readonly lastUnits: number | null;
  readonly order: Order | null;
  readonly nextActionID: number;
  readonly stopReason: string | null;
  readonly fault: string | null;
  readonly settlementObservations: number;
  readonly targetSettlement: boolean;
}
export const freshSupportSelfMiningMemory = (): SupportSelfMiningMemory => ({ scope: null, planKey: null,
  engine: { currentRockID: null, lockRefusedRockIDs: new Set(), approachingTargetID: null, headingHome: null, launchGaveUp: false, noYieldCycles: 0, droneFlight: freshDroneMemory() },
  lastSampleMs: null, lastUnits: null, order: null, nextActionID: 1, stopReason: null, fault: null, settlementObservations: 0, targetSettlement: false });
export interface SupportSelfMiningFeedback { readonly scope: SupportPositionScope; readonly actionID: number; readonly outcome: "acknowledged" | "failed"; readonly reason?: string }
export interface SupportSelfMiningResult {
  readonly state: "WORKING" | "WAIT" | "SETTLING" | "SETTLED" | "HANDOFF" | "BLOCKED";
  readonly reason: string | null;
  readonly action: WorkAction | null;
  readonly actionID: number | null;
  readonly memory: SupportSelfMiningMemory;
}
export interface SupportSelfMiningDiagnostic {
  readonly evaluated: boolean;
  readonly state: SupportSelfMiningResult["state"] | null;
  readonly reason: string | null;
  readonly action: WorkAction["kind"] | null;
  readonly feedback: SupportSelfMiningFeedback["outcome"] | null;
  readonly targetID: number | null;
  readonly units: number | null;
  readonly stopReason: string | null;
  readonly fault: string | null;
  readonly flight: { readonly orderAttempts: number; readonly orderCooldown: number; readonly launchBlocked: boolean };
  readonly drones: readonly { itemID: number; typeID: number | null; role: string | null;
    activity: string | null; targetID: number | null; controlled: boolean }[] | null;
  readonly dronesTruncated: boolean;
}
/** Copy the observation used by this decision, without private scope or errors. */
export function supportSelfMiningDiagnostic(result: SupportSelfMiningResult | null, memory: SupportSelfMiningMemory,
  feedback: SupportSelfMiningFeedback | null, drones: MiningDroneState | null): SupportSelfMiningDiagnostic {
  const flight = memory.engine.droneFlight ?? freshDroneMemory();
  return { evaluated: result !== null, state: result?.state ?? null, reason: result?.reason ?? null,
    action: result?.action?.kind ?? null, feedback: feedback?.outcome ?? null,
    targetID: memory.engine.currentRockID, units: memory.lastUnits, stopReason: memory.stopReason, fault: memory.fault,
    flight: { orderAttempts: flight.orderAttempts, orderCooldown: flight.orderCooldown, launchBlocked: flight.blockedLaunchKey !== null },
    drones: drones?.out === null || !drones ? null : drones.out.slice(0, 32).map(row => ({ itemID: row.itemID, typeID: row.typeID,
      role: row.typeID === null ? null : drones.roles[row.typeID] ?? null, activity: row.activity, targetID: row.targetID, controlled: row.controlled })),
    dronesTruncated: (drones?.out?.length ?? 0) > 32 };
}
export interface SupportSelfMiningInput {
  readonly scope: SupportPositionScope;
  readonly observation: MiningObservation;
  readonly capabilities: MiningSupportCapabilities;
  readonly receivedAtMs: number;
  readonly nowMs: number;
  readonly maxTargetRangeM: number | null;
  /** Existing resolved command leash; not a claim about drone yield/optimal. */
  readonly droneControlRangeM: number | null;
  readonly settledSpeedMetersPerSecond: number;
  readonly enabled: boolean;
  readonly mayWork: boolean;
  readonly settleReason: string | null;
  readonly plan: MiningPlan;
}

/** Managed callers may explicitly select the current capability-proved online
 * fitted miners. Normal callers retain their own module selection by default. */
export function fittedSupportMiningPlan(plan: MiningPlan, capabilities: MiningSupportCapabilities): MiningPlan {
  return { ...plan, miningModuleIDs: capabilities.mining.presence === "unknown" ? []
    : capabilities.mining.modules.filter(row => row.online).map(row => row.itemID) };
}
const sameScope = (a: SupportPositionScope | null, b: SupportPositionScope) => a !== null &&
  a.characterID === b.characterID && a.sessionEpoch === b.sessionEpoch && a.shipID === b.shipID && a.fleetID === b.fleetID &&
  a.solarSystemID === b.solarSystemID && a.fittingSignature === b.fittingSignature;
const range = (n: number | null) => n !== null && Number.isFinite(n) && n >= 0;

/** Stationary adapter over the existing mining engine and #52 drone lifecycle.
 * Support/movement owners grant mayWork; all departures settle dependents first.
 * It never emits movement, unload, fleet or support-module actions. */
export function decideSupportSelfMining(input: SupportSelfMiningInput, previous: SupportSelfMiningMemory,
  feedback?: SupportSelfMiningFeedback): SupportSelfMiningResult {
  const planKey = JSON.stringify(input.plan);
  let memory = sameScope(previous.scope, input.scope) && previous.planKey === planKey ? { ...previous, engine: { ...previous.engine } } : { ...freshSupportSelfMiningMemory() };
  if (sameScope(previous.scope, input.scope) && previous.planKey !== planKey) memory = { ...memory,
    nextActionID: previous.nextActionID, lastSampleMs: previous.lastSampleMs, order: previous.order,
    fault: previous.fault, targetSettlement: true };
  memory.scope = { ...input.scope }; memory.planKey = planKey;
  let action: WorkAction | null = null, actionID: number | null = null;
  const finish = (state: SupportSelfMiningResult["state"], reason: string | null = null): SupportSelfMiningResult => ({ state, reason, action, actionID, memory });
  const scene = input.observation.snapshot, own = scene?.ship, sample = scene?.sampledAtMs;
  // A stationary support owner may have no travel target/home identity. This
  // adapter converts every travel/unload decision into a handoff; those IDs
  // cannot authorize a movement action or prevent local safety settlement.
  if (!Number.isFinite(input.plan.healthFloor) || input.plan.healthFloor < 0 || input.plan.healthFloor > 1 || input.plan.myCharacterID !== input.scope.characterID ||
    !Number.isFinite(input.settledSpeedMetersPerSecond) || input.settledSpeedMetersPerSecond < 0) return finish("WAIT", "plan-or-policy-invalid");
  if (!scene?.inSpace || !own || scene.shipID !== input.scope.shipID || own.itemID !== input.scope.shipID || own.characterID !== input.scope.characterID ||
    scene.solarSystemID !== input.scope.solarSystemID || input.observation.status.shipID !== input.scope.shipID || !input.observation.status.inSpace ||
    input.capabilities.scope.shipID !== input.scope.shipID || input.capabilities.scope.fittingSignature !== input.scope.fittingSignature ||
    sample == null || !Number.isFinite(sample) || !Number.isFinite(input.receivedAtMs) || input.receivedAtMs > input.nowMs || input.nowMs - input.receivedAtMs >= 10000 ||
    own.geometryAvailable !== true || own.activeModuleIDs === null) return finish("WAIT", "own-observation-unavailable");
  if (memory.lastSampleMs !== null && sample <= memory.lastSampleMs) return finish("WAIT", "observation-not-refreshed");
  memory.lastSampleMs = sample;
  const active = own.activeModuleIDs;
  const health = lowestHealth(scene);
  if (health !== null && health < input.plan.healthFloor) memory.stopReason = "emergency-health-floor";
  const oldLock = memory.order?.action;
  // An acknowledged lock can lose its asteroid before it is observed. This
  // noncustodial intent must not prevent target settlement forever. Module
  // orders still require their own physical proof; unknown targets retain it.
  if (!memory.fault && oldLock?.kind === "lock" && input.observation.lockedTargetIDs != null &&
      !input.observation.lockedTargetIDs.includes(oldLock.targetID) &&
      !scene.entities.some(row => row.itemID === oldLock.targetID)) {
    memory.order = null; memory.targetSettlement = true;
    memory.engine = { ...memory.engine, currentRockID: null, noYieldCycles: 0 };
  }
  const settlementRequested = () => !!memory.stopReason || !input.enabled || !input.mayWork || !!input.settleReason || memory.targetSettlement || !!memory.fault;
  const feedbackOrder = memory.order;
  let orderConfirmed = false;
  if (memory.order) {
    const pending = memory.order, issued = pending.action;
    const confirmed = issued.kind === "lock" ? input.observation.lockedTargetIDs?.includes(issued.targetID) === true
      : issued.kind === "activate" ? active.includes(issued.moduleID) : !active.includes(issued.moduleID);
    if (confirmed) { memory.order = null; orderConfirmed = true; }
    else if (settlementRequested() && issued.kind !== "deactivate") {
      memory.order = null;
      if (issued.kind === "activate") memory.fault = "productive-action-unconfirmed";
    }
    else {
      const effect = issued.kind === "deactivate" ? own.coreMobilityFuel?.modules.find(row => row.moduleID === issued.moduleID && row.typeID === issued.typeID)?.effect : null;
      const deferred = (effect?.deactivationRequestedAtMs ?? 0) > 0 && (effect?.deactivateAtMs ?? 0) > sample;
      memory.order = { ...pending, observations: pending.observations + (deferred ? 0 : 1) };
      if (memory.order.observations >= 8) memory.fault = "action-unconfirmed";
    }
  }
  if (!orderConfirmed && feedbackOrder && feedback && sameScope(feedback.scope, input.scope) && feedback.actionID === feedbackOrder.actionID && feedback.outcome === "failed") memory.fault = feedback.reason ?? "action-refused";
  if (memory.order && !settlementRequested()) return finish("WAIT", "action-pending");
  const emit = (next: WorkAction) => {
    action = next; actionID = memory.nextActionID++;
    if (next.kind === "lock" || next.kind === "activate" || next.kind === "deactivate") memory.order = { actionID, action: next, observations: 0 };
  };
  const settle = (why: string): SupportSelfMiningResult => {
    if (input.capabilities.mining.presence === "unknown") return finish("WAIT", "mining-capability-unknown");
    const running = input.capabilities.mining.modules.find(row => active.includes(row.itemID));
    if (running && !memory.order) { emit({ kind: "deactivate", moduleID: running.itemID, typeID: running.typeID }); return finish("SETTLING", why); }
    const state = input.observation.drones;
    if (!state?.out) return finish("WAIT", "controlled-flight-unknown");
    const controlled = state.out.filter(row => row.controlled);
    if (controlled.length === 0) {
      memory.settlementObservations = 0;
      if (memory.fault) return finish("BLOCKED", memory.fault);
      if (running || memory.order) return finish("SETTLING", "mining-module-stop-pending");
      return finish(memory.stopReason ? "HANDOFF" : "SETTLED", memory.stopReason ?? why);
    }
    memory.settlementObservations++;
    if (memory.settlementObservations > 90) { memory.fault = "controlled-flight-return-unconfirmed"; return finish("BLOCKED", memory.fault); }
    const flight = decideMiningDroneFlight(state, memory.engine.droneFlight ?? freshDroneMemory(), null, null, true);
    memory.engine = { ...memory.engine, droneFlight: flight.memory };
    if (flight.action?.kind === "recallDrones") emit(flight.action);
    else if (memory.settlementObservations % 15 === 1) {
      const ids = controlled.filter(row => row.activity !== "returning").map(row => row.itemID);
      if (ids.length) emit({ kind: "recallDrones", droneIDs: ids });
    }
    return finish("SETTLING", why);
  };
  if (memory.stopReason || !input.enabled || !input.mayWork || input.settleReason || memory.fault) return settle(memory.stopReason ?? input.settleReason ?? memory.fault ?? (input.enabled ? "support-not-ready" : "self-mining-disabled"));
  if (own.motionAvailable !== true || own.mode !== "STOP" || Math.hypot(own.velocity.x, own.velocity.y, own.velocity.z) > input.settledSpeedMetersPerSecond) return settle("support-motion-unsettled");
  if (input.observation.holds === null || !input.observation.holds.some(hold => hold.present) || input.observation.holds.some(hold => hold.present && (hold.capacity?.capacity == null || hold.capacity.used == null || hold.items === null))) return settle("mining-hold-unknown");
  if (input.capabilities.mining.presence === "unknown" || !range(input.maxTargetRangeM)) return settle("reach-or-capability-unknown");
  const modules = input.capabilities.mining.modules.filter(row => input.plan.miningModuleIDs.includes(row.itemID) && row.online);
  if (input.plan.miningModuleIDs.some(id => !modules.some(row => row.itemID === id))) return settle("plan-module-unavailable");
  const reaches = modules.map(module => readObservedModuleReach(scene, module.itemID, module.typeID));
  if (reaches.some(row => row?.family !== "mining" || row.maxRangeMeters === null || row.resourceFamily === null)) return settle("mining-reach-unavailable");
  const canMineWithDrones = input.plan.useDrones && range(input.droneControlRangeM) && input.observation.drones !== null && input.observation.drones !== undefined &&
    [...(input.observation.drones.bay ?? []), ...(input.observation.drones.out ?? [])].some(row => row.typeID !== null && input.observation.drones!.roles[row.typeID] === "mining");
  const candidates = scene.entities.filter(row => isMineableRock(row) && row.geometryAvailable === true &&
    [row.position.x, row.position.y, row.position.z, row.radius].every(Number.isFinite) && row.radius >= 0 &&
    surfaceDistanceMeters(own.position, own.radius, row.position, row.radius) <= input.maxTargetRangeM! &&
    (!canMineWithDrones || surfaceDistanceMeters(own.position, own.radius, row.position, row.radius) <= input.droneControlRangeM!) &&
    (modules.length ? reaches.every(reach => reach!.resourceFamily === row.miningResourceFamily &&
      surfaceDistanceMeters(own.position, own.radius, row.position, row.radius) <= reach!.maxRangeMeters!) : canMineWithDrones && row.miningResourceFamily === "ore" &&
      surfaceDistanceMeters(own.position, own.radius, row.position, row.radius) <= input.droneControlRangeM!));
  if (memory.engine.currentRockID !== null && !candidates.some(row => row.itemID === memory.engine.currentRockID)) {
    memory.targetSettlement = true;
    memory.engine = { ...memory.engine, currentRockID: null, noYieldCycles: 0 };
  }
  if (memory.targetSettlement) {
    const settled = settle("target-change");
    if (settled.state === "SETTLED") memory.targetSettlement = false;
    return { ...settled, memory };
  }
  const filtered = { ...scene, entities: scene.entities.filter(row => !isMineableRock(row) || candidates.includes(row)) };
  const reachableHostileIDs = hostilesInReach({ maxTargetRangeM: input.maxTargetRangeM }, scene, own.position).map(row => row.itemID);
  const decision = decideMiningAction({ ...input.observation, snapshot: filtered, measurement: measureSpace(filtered), reachableHostileIDs },
    { ...input.plan, miningModuleIDs: modules.map(row => row.itemID) }, memory.engine);
  const freightIDs = freightHoldItemIDs(input.observation.holds);
  const units = holdUnits(input.observation.holds?.map(hold => ({ ...hold, items: hold.items?.filter(row => freightIDs.includes(row.itemID)) ?? null })) ?? null);
  memory.engine = { ...memory.engine, ...(decision.takeRock !== undefined ? { currentRockID: decision.takeRock } : {}),
    ...(decision.dropRock ? { currentRockID: null, noYieldCycles: 0 } : {}),
    ...(decision.droneFlight ? { droneFlight: decision.droneFlight } : {}),
    noYieldCycles: units !== null && memory.lastUnits !== null && units > memory.lastUnits || decision.step !== "mining-running" ? 0 : memory.engine.noYieldCycles + 1 };
  memory.lastUnits = units;
  switch (decision.action.kind) {
    case "lock": emit({ kind: "lock", targetID: decision.action.targetID }); break;
    case "activate": emit({ kind: "activate", moduleID: decision.action.moduleID, targetID: decision.action.targetID }); break;
    case "launch": emit({ kind: "launchDrones", droneItemIDs: decision.action.droneItemIDs }); break;
    case "recallDrones": emit(decision.action); break;
    case "mineDrones": case "engageDrones": {
      const targetID = decision.action.targetID;
      const target = scene.entities.find(row => row.itemID === targetID);
      if (!target || target.geometryAvailable !== true || !range(input.droneControlRangeM) ||
        surfaceDistanceMeters(own.position, own.radius, target.position, target.radius) > input.droneControlRangeM!) return settle("drone-command-reach-unavailable");
      emit(decision.action); break;
    }
    case "wait": return finish("WAIT", decision.action.reason);
    default:
      memory.stopReason = decision.headHome ?? (decision.action.kind === "pause" ? decision.action.reason : candidates.length === 0 ? "no-reachable-resource" : `mining-${decision.action.kind}-handoff`);
      return settle(memory.stopReason);
  }
  return finish("WORKING", decision.why);
}
