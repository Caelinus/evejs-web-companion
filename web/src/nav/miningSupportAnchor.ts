import type { MiningBurstServices, CompressionServiceObservation } from "../bridge/miningSupportServices.ts";
import type { CoreMobilityFuelObservation } from "../bridge/miningSupportCore.ts";
import type { SpaceSnapshot, SpaceVector } from "../store/types.ts";
import { surfaceDistanceMeters } from "../space/overview.ts";

export interface SupportAnchorServices {
  readonly bursts: MiningBurstServices | null;
  readonly compression: CompressionServiceObservation;
  /** Runtime effect identities/state; no fitted-hull classification or fuel policy. */
  readonly supportEffects: Pick<CoreMobilityFuelObservation, "activeModuleIDs" | "mobility"> & {
    readonly modules: readonly Pick<CoreMobilityFuelObservation["modules"][number], "moduleID" | "typeID" | "active" | "effect">[];
  } | null;
}

/** Used by the BFF after decoding its own fresh space read. No external facilities. */
export function observedSupportAnchorServices(space: SpaceSnapshot): SupportAnchorServices {
  const effects = space.ship?.coreMobilityFuel;
  return structuredClone({ bursts: space.ship?.miningBurstServices ?? null,
    compression: space.ship?.compressionService ?? { state: "unknown", typeListRanges: null, compressors: null },
    supportEffects: effects ? { activeModuleIDs: effects.activeModuleIDs, mobility: effects.mobility,
      modules: effects.modules.map(({ moduleID, typeID, active, effect }) => ({ moduleID, typeID, active, effect })) } : null });
}

export interface MiningSupportAnchor {
  readonly characterID: number;
  readonly shipID: number;
  readonly fleetID: string;
  readonly solarSystemID: number | null;
  /** Opaque BFF epoch, never a gateway handle or auth token. */
  readonly sessionEpoch: string;
  readonly sampledAtMs: number;
  readonly observedAtMs: number;
  readonly publishedAtMs: number;
  readonly expiresAtMs: number;
  readonly ageMs: number;
  readonly freshness: "fresh" | "stale" | "invalid";
  readonly reason: string | null;
  readonly services: SupportAnchorServices;
}
export interface SupportFleetRoster {
  readonly fleetID: string;
  readonly readerCharacterID: number;
  readonly members: readonly { readonly characterID: number; readonly solarSystemID: number | null }[];
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
}
export interface MiningSupportAnchorRead {
  readonly availability: "available" | "unknown";
  readonly reason: string | null;
  readonly readAtMs: number;
  readonly fleet: SupportFleetRoster | null;
  readonly anchors: readonly MiningSupportAnchor[];
}
export interface ResolvedSupportAnchor {
  readonly publication: MiningSupportAnchor;
  readonly characterID: number;
  readonly shipID: number;
  readonly position: SpaceVector;
  readonly radius: number;
  readonly sameFleet: true;
  readonly onGrid: true;
  readonly solarSystemID: number;
  readonly services: SupportAnchorServices;
  readonly surfaceDistanceMeters: number;
}
export type SupportAnchorResolution =
  | { readonly availability: "available"; readonly reason: null; readonly anchor: ResolvedSupportAnchor }
  | { readonly availability: "unknown" | "unavailable"; readonly reason: string; readonly anchor: null };

function current(start: number, end: number, now: number): boolean {
  return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(now) && start <= now && now < end;
}
function geometry(position: SpaceVector, radius: number): boolean {
  return [position.x, position.y, position.z, radius].every(Number.isFinite) && radius >= 0;
}

/** All times are receipt/lease wall-clock times. sampledAtMs is simulation time
 * and cannot prove freshness. The caller supplies its current scene receipt.
 */
export function resolveSupportAnchor(publication: MiningSupportAnchor, scene: {
  readonly snapshot: SpaceSnapshot | null; readonly receivedAtMs: number;
}, fleet: SupportFleetRoster | null, nowMs: number): SupportAnchorResolution {
  const unknown = (reason: string): SupportAnchorResolution => ({ availability: "unknown", reason, anchor: null });
  const unavailable = (reason: string): SupportAnchorResolution => ({ availability: "unavailable", reason, anchor: null });
  if (publication.freshness !== "fresh" || !current(publication.publishedAtMs, publication.expiresAtMs, nowMs)) return unknown("publication-stale");
  if (!fleet || !current(fleet.observedAtMs, fleet.expiresAtMs, nowMs)) return unknown("fleet-unknown");
  if (fleet.fleetID !== publication.fleetID || !fleet.members.some(row => row.characterID === fleet.readerCharacterID)
    || !fleet.members.some(row => row.characterID === publication.characterID)) return unavailable("fleet-mismatch");
  // The scene may be no older than this publication's bounded lease.
  if (!current(scene.receivedAtMs, scene.receivedAtMs + (publication.expiresAtMs - publication.observedAtMs), nowMs)) return unknown("scene-stale");
  const snapshot = scene.snapshot;
  const own = snapshot?.ship;
  if (!snapshot?.inSpace || !own || snapshot.shipID !== own.itemID || own.characterID !== fleet.readerCharacterID) return unknown("miner-ship-unknown");
  if (publication.solarSystemID === null || snapshot.solarSystemID === null) return unknown("system-unknown");
  if (publication.solarSystemID !== snapshot.solarSystemID) return unavailable("system-mismatch");
  const member = fleet.members.find(row => row.characterID === publication.characterID)!;
  if (member.solarSystemID !== null && member.solarSystemID !== snapshot.solarSystemID) return unavailable("system-mismatch");
  const visible = snapshot.entities.find(row => row.itemID === publication.shipID);
  if (!visible) return unavailable(snapshot.entities.some(row => row.characterID === publication.characterID) ? "ship-mismatch" : "off-grid");
  if (visible.kind !== "ship" || visible.isNpc || visible.characterID !== publication.characterID) return unavailable("ship-mismatch");
  // Decoder provenance prevents its legacy origin/zero fallbacks being used as measurements.
  if (visible.geometryAvailable !== true || own.geometryAvailable !== true || !geometry(visible.position, visible.radius) || !geometry(own.position, own.radius)) return unknown("geometry-unknown");
  return { availability: "available", reason: null, anchor: {
    publication, characterID: publication.characterID, shipID: publication.shipID,
    position: { ...visible.position }, radius: visible.radius, sameFleet: true, onGrid: true,
    solarSystemID: snapshot.solarSystemID, services: publication.services,
    surfaceDistanceMeters: surfaceDistanceMeters(own.position, own.radius, visible.position, visible.radius),
  } };
}

export interface SupportRequirements {
  readonly requireMiningBurst: boolean;
  /** Exact accepted typelist ID; no ore/ice/gas family inference. */
  readonly requireCompressionTypeListID?: number | null;
}
export interface SupportEnvelope {
  readonly status: "bounded" | "unbounded" | "unsatisfied" | "unknown";
  readonly maxSurfaceDistanceMeters: number | null;
  readonly reason: string | null;
}
export function supportEnvelope(resolution: SupportAnchorResolution, requirements: SupportRequirements): SupportEnvelope {
  if (resolution.availability !== "available" && (requirements.requireMiningBurst || requirements.requireCompressionTypeListID != null)) {
    return { status: resolution.availability === "unknown" ? "unknown" : "unsatisfied", reason: resolution.reason, maxSurfaceDistanceMeters: null };
  }
  return supportServiceEnvelope(resolution.anchor?.services ?? null, requirements);
}
/** Same envelope for the supporting pilot's OWN observed services. */
export function supportServiceEnvelope(services: SupportAnchorServices | null, requirements: SupportRequirements): SupportEnvelope {
  const result = (status: SupportEnvelope["status"], reason: string | null): SupportEnvelope => ({ status, reason, maxSurfaceDistanceMeters: null });
  const typeListID = requirements.requireCompressionTypeListID;
  if (!requirements.requireMiningBurst && typeListID == null) return result("unbounded", "no-ranged-requirements");
  if (!services) return result("unknown", "services-unknown");
  const ranges: number[] = [];
  if (requirements.requireMiningBurst) {
    if (services.bursts === null) return result("unknown", "burst-unknown");
    const active = services.bursts.bursts.filter(row => services.bursts!.activeModuleIDs.includes(row.moduleID));
    if (active.length === 0) return result("unsatisfied", "burst-unavailable");
    for (const burst of active) {
      if (burst.rangeMeters === null || !Number.isFinite(burst.rangeMeters) || burst.rangeMeters < 0) return result("unknown", "burst-range-unknown");
      ranges.push(burst.rangeMeters);
    }
  }
  if (typeListID != null) {
    if (!Number.isSafeInteger(typeListID) || typeListID <= 0) return result("unknown", "typelist-invalid");
    const service = services.compression;
    if (service.state === "unknown" || service.typeListRanges === null) return result("unknown", "compression-unknown");
    const matching = service.typeListRanges.filter(pair => pair.typeListID === typeListID);
    if (service.state !== "active" || matching.length === 0) return result("unsatisfied", "compression-unavailable");
    for (const pair of matching) {
      if (!Number.isFinite(pair.rangeMeters) || pair.rangeMeters <= 0) return result("unknown", "compression-range-unknown");
      ranges.push(pair.rangeMeters);
    }
  }
  // Conservative intersection of ALL required active burst/typelist ranges.
  return { status: "bounded", maxSurfaceDistanceMeters: Math.min(...ranges), reason: null };
}
export function evaluateSupportEnvelope(resolution: SupportAnchorResolution, requirements: SupportRequirements): {
  readonly status: "inside" | "outside" | "unknown" | "unsatisfied" | "not-applicable";
  readonly surfaceDistanceMeters: number | null; readonly envelope: SupportEnvelope;
} {
  const envelope = supportEnvelope(resolution, requirements);
  const distance = resolution.anchor?.surfaceDistanceMeters ?? null;
  const status = envelope.status === "unbounded" ? "not-applicable"
    : envelope.status !== "bounded" ? envelope.status
    : distance === null || !Number.isFinite(distance) ? "unknown"
    : distance <= envelope.maxSurfaceDistanceMeters! ? "inside" : "outside";
  return { status, surfaceDistanceMeters: distance, envelope };
}
