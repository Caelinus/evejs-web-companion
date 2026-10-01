import type { SpaceSnapshot, SpaceVector } from "../store/types.ts";
import { surfaceDistanceMeters } from "../space/overview.ts";
import type { SupportEnvelope, SupportFleetRoster } from "./miningSupportAnchor.ts";
import { decideMiningSupport, freshMiningSupportMemory, type MiningSupportActionResult,
  type MiningSupportMemory, type MiningSupportPolicy, type MiningSupportResult } from "./miningSupportController.ts";
import type { MiningSupportServiceSnapshot } from "./miningSupportServices.ts";
import type { ScriptAction } from "./scriptDecide.ts";

export interface SupportPositionScope { readonly characterID: number; readonly sessionEpoch: string; readonly shipID: number; readonly fleetID: string; readonly solarSystemID: number; readonly fittingSignature: string }
export interface SupportPositionPolicy {
  readonly service: MiningSupportPolicy;
  readonly deadbandMeters: number;
  readonly arrivalMeters: number;
  readonly settledSpeedMetersPerSecond: number;
}
export interface SupportPositionObservation {
  readonly scope: SupportPositionScope;
  readonly scene: SpaceSnapshot | null;
  readonly receivedAtMs: number;
  readonly nowMs: number;
  readonly fleet: SupportFleetRoster | null;
  readonly intendedCharacterIDs: readonly number[];
  readonly services: MiningSupportServiceSnapshot | null;
  readonly envelope: SupportEnvelope;
  /** Mining/drone/tractor owners must positively prove settlement first. */
  readonly dependentsSettled: boolean;
}
interface Relocation {
  readonly target: SpaceVector; readonly rangeMeters: number; readonly phase: "settling" | "moving" | "stopping";
  readonly issuedAtMs: number | null;
  readonly progressAtMs: number | null; readonly progressDistanceMeters: number | null; readonly progressSampleMs: number | null;
}
export interface SupportPositionMemory {
  readonly scope: SupportPositionScope | null;
  readonly support: MiningSupportMemory;
  readonly relocation: Relocation | null;
  readonly braking: { readonly issuedAtMs: number | null } | null;
  readonly lastActionSampleMs: number | null;
  readonly fault: string | null;
}
export const freshSupportPositionMemory = (): SupportPositionMemory => ({ scope: null, support: freshMiningSupportMemory(), relocation: null, braking: null, lastActionSampleMs: null, fault: null });
export type SupportPositionAction = Extract<ScriptAction, { kind: "activate" | "deactivate" | "gotoPoint" | "stopShip" }>;
export interface SupportPositionResult {
  readonly state: "HOLD" | "WAIT" | "UNSATISFIED" | "SETTLING" | "MOVING" | "ARRIVED" | "BLOCKED";
  readonly reason: string | null;
  readonly recipientIssue?: { readonly characterID: number; readonly reason: "not-in-roster" | "other-system" | "not-visible" | "geometry-unknown" };
  readonly worstSurfaceDistanceMeters: number | null;
  readonly target: SpaceVector | null;
  readonly relocationRequested: boolean;
  readonly support: MiningSupportResult | null;
  readonly action: SupportPositionAction | null;
  readonly memory: SupportPositionMemory;
}
export interface SupportPositionFeedback {
  readonly scope: SupportPositionScope;
  readonly module?: MiningSupportActionResult;
  /** Refused/ambiguous movement is latched. ACK never proves arrival. */
  readonly movement?: "acknowledged" | "refused" | "unknown";
}
const distance = (a: SpaceVector, b: SpaceVector) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const finitePoint = (p: SpaceVector) => [p.x, p.y, p.z].every(Number.isFinite);
const sameScope = (a: SupportPositionScope | null, b: SupportPositionScope) => a !== null &&
  a.characterID === b.characterID && a.sessionEpoch === b.sessionEpoch && a.shipID === b.shipID && a.fleetID === b.fleetID
  && a.solarSystemID === b.solarSystemID && a.fittingSignature === b.fittingSignature;
const fresh = (at: number, now: number) => Number.isFinite(at) && Number.isFinite(now) && at <= now && now - at < 10_000;
interface Recipient { readonly characterID: number; readonly position: SpaceVector; readonly radius: number }

/** Bounded deterministic candidate minimax. Includes centroid, all medoids and
 * pair midpoints, then 96 farthest-recipient steps. It makes no global optimality
 * claim. Pair separation proves impossibility; an inconclusive search waits. */
function targetFor(rows: readonly Recipient[], radius: number, range: number): { target: SpaceVector | null; impossible: boolean } {
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    if (distance(rows[i]!.position, rows[j]!.position) > 2 * (range + radius) + rows[i]!.radius + rows[j]!.radius) return { target: null, impossible: true };
  }
  const score = (point: SpaceVector) => Math.max(...rows.map(row => surfaceDistanceMeters(point, radius, row.position, row.radius)));
  const centre = { x: 0, y: 0, z: 0 };
  for (const row of rows) { centre.x += row.position.x / rows.length; centre.y += row.position.y / rows.length; centre.z += row.position.z / rows.length; }
  let best = centre, value = score(centre);
  const consider = (point: SpaceVector) => { const next = score(point); if (Number.isFinite(next) && next < value) { best = point; value = next; } };
  for (let i = 0; i < rows.length; i++) {
    consider(rows[i]!.position);
    for (let j = i + 1; j < rows.length; j++) consider({ x: rows[i]!.position.x / 2 + rows[j]!.position.x / 2,
      y: rows[i]!.position.y / 2 + rows[j]!.position.y / 2, z: rows[i]!.position.z / 2 + rows[j]!.position.z / 2 });
  }
  let point = { ...best };
  for (let step = 0; step < 96; step++) {
    let farthest = rows[0]!;
    for (const row of rows) if (surfaceDistanceMeters(point, radius, row.position, row.radius) > surfaceDistanceMeters(point, radius, farthest.position, farthest.radius)) farthest = row;
    const fraction = 1 / (step + 2);
    point = { x: point.x + (farthest.position.x - point.x) * fraction,
      y: point.y + (farthest.position.y - point.y) * fraction, z: point.z + (farthest.position.z - point.z) * fraction };
    consider(point);
  }
  return { target: finitePoint(best) && value <= range ? { ...best } : null, impossible: false };
}

/** One memory/movement owner per pilot. No targeting/mining or fleet mutations.
 * Relocation captures the observed envelope before shutdown removes services.
 * Off-grid members never acquire invented positions. */
export function decideSupportPositioning(input: SupportPositionObservation, previous: SupportPositionMemory,
  policy: SupportPositionPolicy, feedback?: SupportPositionFeedback): SupportPositionResult {
  let memory: { -readonly [K in keyof SupportPositionMemory]: SupportPositionMemory[K] } = sameScope(previous.scope, input.scope) ? { ...previous } : { ...freshSupportPositionMemory() };
  memory.scope = { ...input.scope };
  let support: MiningSupportResult | null = null, action: SupportPositionAction | null = null, worst: number | null = null;
  let recipientIssue: SupportPositionResult["recipientIssue"];
  const finish = (state: SupportPositionResult["state"], reason: string | null = null): SupportPositionResult => ({ state, reason,
    ...(recipientIssue ? { recipientIssue } : {}),
    worstSurfaceDistanceMeters: worst, target: memory.relocation?.target ?? null, relocationRequested: memory.relocation !== null || memory.braking != null, support, action, memory });
  if ([policy.deadbandMeters, policy.arrivalMeters, policy.settledSpeedMetersPerSecond].some(n => !Number.isFinite(n) || n < 0)
    || !Number.isSafeInteger(input.scope.characterID) || input.scope.characterID <= 0 || !input.scope.sessionEpoch) return finish("WAIT", "policy-or-scope-invalid");
  const scene = input.scene, own = scene?.ship, fleet = input.fleet;
  if (!scene?.inSpace || !own || scene.shipID !== input.scope.shipID || own.itemID !== input.scope.shipID
    || own.characterID !== input.scope.characterID || own.geometryAvailable !== true || !finitePoint(own.position) || !Number.isFinite(own.radius) || own.radius < 0
    || scene.solarSystemID !== input.scope.solarSystemID || scene.sampledAtMs === null || !fresh(input.receivedAtMs, input.nowMs) || input.services?.sampledAtMs !== scene.sampledAtMs
    || input.services.capabilities.scope.shipID !== input.scope.shipID) return finish("WAIT", "scene-unknown-or-stale");
  if (!fleet || fleet.readerCharacterID !== input.scope.characterID || fleet.fleetID !== input.scope.fleetID
    || !fresh(fleet.observedAtMs, input.nowMs) || !(input.nowMs < fleet.expiresAtMs)
    || !fleet.members.some(row => row.characterID === input.scope.characterID) || scene.solarSystemID === null) return finish("WAIT", "fleet-unknown-or-stale");
  const ids = [...new Set(input.intendedCharacterIDs)].sort((a, b) => a - b);
  if (ids.length > 32 || ids.some(id => !Number.isSafeInteger(id) || id <= 0 || id === input.scope.characterID)) return finish("WAIT", "intended-members-invalid");
  const rows: Recipient[] = [];
  for (const characterID of ids) {
    const member = fleet.members.find(row => row.characterID === characterID);
    const visible = scene.entities.filter(row => row.characterID === characterID && row.kind === "ship" && !row.isNpc);
    const unavailable = !member ? "not-in-roster" : member.solarSystemID !== null && member.solarSystemID !== scene.solarSystemID ? "other-system"
      : visible.length !== 1 ? "not-visible" : visible[0]!.geometryAvailable !== true || !finitePoint(visible[0]!.position)
      || !Number.isFinite(visible[0]!.radius) || visible[0]!.radius < 0 ? "geometry-unknown" : null;
    if (unavailable) { recipientIssue = { characterID, reason: unavailable }; return finish("WAIT", "recipient-unknown-or-off-grid"); }
    rows.push({ characterID, position: visible[0]!.position, radius: visible[0]!.radius });
  }
  if ((memory.relocation || memory.braking) && feedback && sameScope(feedback.scope, input.scope) && feedback.movement && feedback.movement !== "acknowledged") memory.fault = `movement-${feedback.movement}`;
  if (memory.fault) return finish("BLOCKED", memory.fault);
  if (!memory.relocation) {
    // Warp arrival can report STOP while residual velocity remains. Core must
    // not freeze that drift and prevent stationary dependent work indefinitely.
    const motionKnown = own.motionAvailable === true && finitePoint(own.velocity) && own.mode !== null;
    if (!motionKnown) return finish("WAIT", "motion-unknown");
    if (/warp/i.test(own.mode!)) return finish("WAIT", "warp-unsettled");
    const settled = own.mode === "STOP" && Math.hypot(own.velocity.x, own.velocity.y, own.velocity.z) <= policy.settledSpeedMetersPerSecond;
    if (!settled && !memory.braking) memory.braking = { issuedAtMs: null };
    if (memory.braking) {
      if (!input.dependentsSettled) return finish("SETTLING", "dependent-flight-unsettled");
      support = decideMiningSupport(input.services, memory.support, policy.service, true,
        feedback && sameScope(feedback.scope, input.scope) ? feedback.module : undefined);
      memory.support = support.memory;
      if (support.action) { action = support.action; return finish("SETTLING", "support-action"); }
      if (support.state !== "ready-for-relocation") return finish("SETTLING", support.issues[0]?.reason ?? "support-settling");
      if (memory.lastActionSampleMs === scene.sampledAtMs) return finish("WAIT", "new-observation-required");
      if (memory.braking.issuedAtMs === null) {
        action = { kind: "stopShip" };
        memory.braking = { issuedAtMs: input.nowMs }; memory.lastActionSampleMs = scene.sampledAtMs;
        return finish("MOVING", "settling-motion");
      }
      if (settled) { memory.braking = null; return finish("ARRIVED"); }
      if (input.nowMs - memory.braking.issuedAtMs > 120000) { memory.fault = "braking-unconfirmed"; return finish("BLOCKED", memory.fault); }
      return finish("WAIT", "motion-unsettled");
    }
  }
  const range = memory.relocation?.rangeMeters ?? input.envelope.maxSurfaceDistanceMeters;
  if (range === null || !Number.isFinite(range) || range < 0 || (!memory.relocation && input.envelope.status !== "bounded")) {
    support = decideMiningSupport(input.services, memory.support, policy.service, false,
      feedback && sameScope(feedback.scope, input.scope) ? feedback.module : undefined);
    memory.support = support.memory;
    action = support.action;
    return finish("WAIT", "envelope-unknown-or-unavailable");
  }
  worst = rows.length === 0 ? 0 : Math.max(...rows.map(row => surfaceDistanceMeters(own.position, own.radius, row.position, row.radius)));
  if (!memory.relocation && worst > range) {
    const candidate = targetFor(rows, own.radius, Math.max(0, range - policy.deadbandMeters));
    if (candidate.impossible) {
      // A deadband must not turn a geometrically possible envelope impossible.
      if (targetFor(rows, own.radius, range).impossible) return finish("UNSATISFIED", "recipient-spread-exceeds-envelope");
    }
    const target = candidate.target ?? targetFor(rows, own.radius, range).target;
    if (!target) return finish("WAIT", "bounded-search-inconclusive");
    memory.relocation = { target, rangeMeters: range, phase: "settling", issuedAtMs: null,
      progressAtMs: null, progressDistanceMeters: null, progressSampleMs: null };
  }
  if (memory.relocation && !input.dependentsSettled) return finish("SETTLING", "dependent-flight-unsettled");
  const moduleFeedback = feedback && sameScope(feedback.scope, input.scope) ? feedback.module : undefined;
  support = decideMiningSupport(input.services, memory.support, policy.service, memory.relocation !== null, moduleFeedback);
  memory.support = support.memory;
  if (support.action) { action = support.action; return finish(memory.relocation ? "SETTLING" : "HOLD", "support-action"); }
  const relocation = memory.relocation;
  if (!relocation) return finish("HOLD", worst > Math.max(0, range - policy.deadbandMeters) ? "coverage-deadband" : null);
  if (support.state !== "ready-for-relocation") return finish("SETTLING", support.issues[0]?.reason ?? "support-settling");
  if (memory.lastActionSampleMs === scene.sampledAtMs) return finish("WAIT", "new-observation-required");
  const remainingMeters = distance(own.position, relocation.target);
  const arrived = remainingMeters <= policy.arrivalMeters;
  const covered = worst <= Math.max(0, range - policy.deadbandMeters);
  const stopped = own.motionAvailable === true && own.mode === "STOP" && finitePoint(own.velocity)
    && Math.hypot(own.velocity.x, own.velocity.y, own.velocity.z) <= policy.settledSpeedMetersPerSecond;
  if (relocation.phase === "settling") {
    // Recipients can return during a long Core shutdown. Fresh comfortable
    // coverage supersedes the old minimax target, after all settlement gates.
    if (covered) {
      if (stopped) { memory.relocation = null; return finish("ARRIVED", "coverage-restored"); }
      action = { kind: "stopShip" };
      memory.relocation = { ...relocation, phase: "stopping", issuedAtMs: input.nowMs };
      memory.lastActionSampleMs = scene.sampledAtMs;
      return finish("MOVING", "settling-motion");
    }
    action = { kind: "gotoPoint", position: relocation.target, shipID: input.scope.shipID, solarSystemID: input.scope.solarSystemID };
    memory.relocation = { ...relocation, phase: "moving", issuedAtMs: input.nowMs,
      progressAtMs: input.nowMs, progressDistanceMeters: remainingMeters, progressSampleMs: scene.sampledAtMs };
  } else {
    if (relocation.phase === "moving") {
      if (!arrived && !covered) {
        // A long, slow approach can outlast two minutes without being stuck.
        // Renew only on a newer authoritative scene and measurable distance
        // reduction. Repeated reads, lateral drift and reverse motion cannot
        // extend the stall window; total travel remains bounded to ten minutes.
        const progressed = relocation.progressSampleMs !== null && scene.sampledAtMs > relocation.progressSampleMs
          && relocation.progressDistanceMeters !== null && remainingMeters <= relocation.progressDistanceMeters - 1;
        const progressAtMs = progressed ? input.nowMs : relocation.progressAtMs ?? relocation.issuedAtMs;
        if (relocation.issuedAtMs !== null && (input.nowMs - relocation.issuedAtMs > 600_000
          || progressAtMs !== null && input.nowMs - progressAtMs > 120_000)) {
          memory.fault = "movement-unconfirmed"; return finish("BLOCKED", memory.fault);
        }
        if (progressed) memory.relocation = { ...relocation, progressAtMs, progressDistanceMeters: remainingMeters, progressSampleMs: scene.sampledAtMs };
        return finish("MOVING", "arrival-unconfirmed");
      }
      action = { kind: "stopShip" };
      memory.relocation = { ...relocation, phase: "stopping", issuedAtMs: input.nowMs };
    } else {
      // Arrival was measured before the stop order. Real deceleration can
      // leave that narrow point window; final recipient coverage is the goal.
      // Never clear relocation if the stopped ship drifted outside coverage.
      if (worst > range || !stopped) {
        if (relocation.issuedAtMs !== null && input.nowMs - relocation.issuedAtMs > 120_000) {
          memory.fault = "braking-unconfirmed"; return finish("BLOCKED", memory.fault);
        }
        return finish("WAIT", worst > range ? "settled-outside-envelope" : "motion-unsettled");
      }
      memory.relocation = null;
      return finish("ARRIVED");
    }
  }
  memory.lastActionSampleMs = scene.sampledAtMs;
  return finish("MOVING", action.kind === "stopShip" ? "settling-motion" : null);
}
