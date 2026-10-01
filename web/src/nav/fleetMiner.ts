import { readObservedModuleReach } from "../bridge/moduleReach.ts";
import type { SpaceEntity, SpaceSnapshot, SpaceVector } from "../store/types.ts";
import { surfaceDistanceMeters } from "../space/overview.ts";
import { resolveSupportAnchor, supportEnvelope, type MiningSupportAnchorRead, type ResolvedSupportAnchor, type SupportRequirements } from "./miningSupportAnchor.ts";

export interface FleetMinerInput {
  readonly scene: SpaceSnapshot | null; readonly sceneReceivedAtMs: number; readonly nowMs: number;
  readonly supportCharacterID: number; readonly anchors: MiningSupportAnchorRead | null; readonly requirements: SupportRequirements;
  readonly modules: readonly { readonly itemID: number; readonly typeID: number; readonly online: boolean }[] | null;
  readonly resourceCandidates: readonly SpaceEntity[]; readonly preferredTargetID: number | null;
}
export interface FleetMinerGeometry {
  readonly state: "MINE" | "REPOSITION" | "REPOSITION_NEEDED" | "SUPPORT_UNAVAILABLE" | "UNKNOWN";
  readonly reason: string | null; readonly targetID: number | null;
  readonly position: SpaceVector | null; readonly rangeMeters: number | null;
  readonly support: ResolvedSupportAnchor | null;
}
const distance = (a: SpaceVector, b: SpaceVector) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const finitePoint = (a: SpaceVector) => [a.x, a.y, a.z].every(Number.isFinite);
const add = (a: SpaceVector, b: SpaceVector, scale: number): SpaceVector => ({ x: a.x + b.x * scale, y: a.y + b.y * scale, z: a.z + b.z * scale });
const delta = (a: SpaceVector, b: SpaceVector): SpaceVector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: SpaceVector, b: SpaceVector) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: SpaceVector) => Math.hypot(a.x, a.y, a.z);

/** Closest point in two intersecting balls; fixed candidates plus their
 * intersection circle, with a deterministic perpendicular at its centre. */
export function fleetMiningPoint(current: SpaceVector, support: SpaceVector, supportRadius: number,
  resource: SpaceVector, miningRadius: number): SpaceVector | null {
  if (![current, support, resource].every(finitePoint) || ![supportRadius, miningRadius].every(value => Number.isFinite(value) && value >= 0)) return null;
  const inside = (point: SpaceVector) => distance(point, support) <= supportRadius + 0.0005 && distance(point, resource) <= miningRadius + 0.0005;
  if (inside(current)) return { ...current };
  const d = distance(support, resource);
  if (d > supportRadius + miningRadius) return null;
  const project = (centre: SpaceVector, radius: number): SpaceVector => {
    const offset = delta(current, centre), norm = length(offset);
    return norm <= radius ? { ...current } : add(centre, offset, radius / norm);
  };
  const candidates = [project(support, supportRadius), project(resource, miningRadius)].filter(inside);
  if (candidates.length) return candidates.sort((a, b) => distance(current, a) - distance(current, b))[0]!;
  if (d === 0) return null;
  const axis = add({ x: 0, y: 0, z: 0 }, delta(resource, support), 1 / d);
  const along = (d * d + supportRadius * supportRadius - miningRadius * miningRadius) / (2 * d);
  const radiusSquared = supportRadius * supportRadius - along * along;
  if (radiusSquared < -0.0005) return null;
  const centre = add(support, axis, along), offset = delta(current, centre);
  let perpendicular = add(offset, axis, -dot(offset, axis));
  if (length(perpendicular) < 1e-8) {
    const seed = Math.abs(axis.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    perpendicular = add(seed, axis, -dot(seed, axis));
  }
  const point = add(centre, perpendicular, Math.sqrt(Math.max(0, radiusSquared)) / length(perpendicular));
  return inside(point) ? point : null;
}

/** Source-independent resource/support intersection. No retail mining range,
 * orbit, asteroid choice for support, or movement ownership is invented here. */
export function decideFleetMinerGeometry(input: FleetMinerInput): FleetMinerGeometry {
  const result = (state: FleetMinerGeometry["state"], reason: string | null, support: ResolvedSupportAnchor | null = null,
    targetID: number | null = null, position: SpaceVector | null = null, rangeMeters: number | null = null): FleetMinerGeometry =>
    ({ state, reason, support, targetID, position, rangeMeters });
  const scene = input.scene, own = scene?.ship;
  if (!scene?.inSpace || !own || scene.shipID !== own.itemID || own.geometryAvailable !== true || !finitePoint(own.position) ||
    !Number.isFinite(own.radius) || own.radius < 0 || !Number.isFinite(input.nowMs) || !Number.isFinite(input.sceneReceivedAtMs) ||
    input.sceneReceivedAtMs > input.nowMs || input.nowMs - input.sceneReceivedAtMs >= 10000) return result("UNKNOWN", "miner-scene-unavailable");
  const board = input.anchors;
  if (!Number.isSafeInteger(input.supportCharacterID) || input.supportCharacterID <= 0 || input.supportCharacterID === own.characterID ||
    board?.availability !== "available") return result("SUPPORT_UNAVAILABLE", "support-authority-unavailable");
  const selected = board.anchors.filter(row => row.characterID === input.supportCharacterID);
  if (selected.length !== 1) return result("SUPPORT_UNAVAILABLE", "selected-support-anchor-unavailable");
  const resolution = resolveSupportAnchor(selected[0]!, { snapshot: scene, receivedAtMs: input.sceneReceivedAtMs }, board.fleet, input.nowMs);
  if (resolution.availability !== "available") return result("SUPPORT_UNAVAILABLE", resolution.reason);
  const envelope = supportEnvelope(resolution, input.requirements), support = resolution.anchor;
  if (envelope.status !== "bounded" || envelope.maxSurfaceDistanceMeters === null) return result("SUPPORT_UNAVAILABLE", envelope.reason ?? "support-envelope-unavailable", support);
  if (input.modules === null || !input.modules.length || new Set(input.modules.map(row => row.itemID)).size !== input.modules.length)
    return result("UNKNOWN", "effective-mining-reach-unavailable", support);
  const reaches = input.modules.filter(module => module.online).map(module => readObservedModuleReach(scene, module.itemID, module.typeID));
  if (!reaches.length) return result("UNKNOWN", "effective-mining-reach-unavailable", support);
  if (reaches.some(row => row?.family !== "mining" || row.maxRangeMeters === null || row.maxRangeMeters <= 0))
    return result("UNKNOWN", "effective-mining-reach-unavailable", support);
  const range = Math.min(...reaches.map(row => row!.maxRangeMeters!));
  const supported = surfaceDistanceMeters(own.position, own.radius, support.position, support.radius) <= envelope.maxSurfaceDistanceMeters;
  const candidates = input.resourceCandidates.filter(resource => resource.geometryAvailable === true && finitePoint(resource.position) &&
    Number.isFinite(resource.radius) && resource.radius >= 0 && resource.miningYieldTypeID !== null &&
    resource.miningResourceFamily !== null && reaches.every(reach => reach!.resourceFamily === resource.miningResourceFamily));
  const feasible = candidates.flatMap(resource => {
    const supportRadius = envelope.maxSurfaceDistanceMeters! + support.radius + own.radius;
    const miningRadius = range + resource.radius + own.radius;
    const overlap = supportRadius + miningRadius - distance(support.position, resource.position);
    if (overlap < 0) return [];
    const inReach = surfaceDistanceMeters(own.position, own.radius, resource.position, resource.radius) <= range;
    // Prefer current coverage. Movement uses an interior point where possible,
    // leaving braking headroom without pretending an impossible spread fits.
    const margin = Math.min(100, Math.max(0, overlap / 4), supportRadius / 4, miningRadius / 4);
    const point = supported && inReach ? own.position : fleetMiningPoint(own.position, support.position, supportRadius - margin, resource.position, miningRadius - margin);
    return point ? [{ resource, point, inReach: supported && inReach, movement: distance(own.position, point) }] : [];
  }).sort((a, b) => Number(b.inReach) - Number(a.inReach) || Number(b.resource.itemID === input.preferredTargetID) - Number(a.resource.itemID === input.preferredTargetID) ||
    a.movement - b.movement || distance(own.position, a.resource.position) - distance(own.position, b.resource.position) || a.resource.itemID - b.resource.itemID);
  const chosen = feasible[0];
  if (!chosen) return result("REPOSITION_NEEDED", candidates.length ? "no-resource-support-intersection" : "resource-geometry-or-family-unavailable", support, null, null, range);
  return result(chosen.inReach ? "MINE" : "REPOSITION", null, support, chosen.resource.itemID, { ...chosen.point }, range);
}
