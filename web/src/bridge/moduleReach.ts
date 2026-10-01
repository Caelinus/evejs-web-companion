import { unwrapLong, type JsonValue } from "./wire.ts";
import type { SpaceSnapshot } from "../store/types.ts";

export interface ModuleReach {
  readonly moduleID: number;
  readonly typeID: number;
  readonly family: "mining" | "tractor";
  readonly resourceFamily: "ore" | "ice" | "gas" | null;
  readonly maxRangeMeters: number | null;
  readonly settlementSurfaceDistanceMeters: number | null;
  readonly availability: "available" | "unknown";
  readonly reason: string | null;
}
export interface ModuleReachObservation {
  readonly shipID: number | null;
  readonly sampledAtSimTimeMs: number | null;
  readonly availability: "available" | "unknown";
  readonly reason: string | null;
  readonly modules: readonly ModuleReach[] | null;
}
const object = (value: JsonValue | undefined): Record<string, JsonValue> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
function number(value: JsonValue | undefined): number | null {
  if (value == null) return null;
  const valueNumber = typeof value === "number" ? value : Number(unwrapLong(value) ?? NaN);
  return Number.isFinite(valueNumber) && valueNumber >= 0 ? valueNumber : null;
}
const id = (value: JsonValue | undefined): number | null => {
  const n = number(value); return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
};
const reason = (value: JsonValue | undefined) => typeof value === "string" ? value : null;

export function decodeModuleReach(value: JsonValue | undefined): ModuleReachObservation | null {
  const raw = object(value);
  if (!raw) return null;
  const shipID = id(raw.shipID), sampledAtSimTimeMs = number(raw.sampledAtSimTimeMs);
  const unknown = (why: string): ModuleReachObservation => ({ shipID, sampledAtSimTimeMs,
    availability: "unknown", reason: why, modules: null });
  if (raw.availability !== "available") return unknown(reason(raw.reason) ?? "range-authority-unavailable");
  if (shipID === null || sampledAtSimTimeMs === null || !Array.isArray(raw.modules)) return unknown("scope-or-modules-unavailable");
  const modules: ModuleReach[] = [];
  for (const value of raw.modules) {
    const row = object(value), moduleID = id(row?.moduleID), typeID = id(row?.typeID);
    if (!row || moduleID === null || typeID === null || modules.some(m => m.moduleID === moduleID) ||
      (row.family !== "mining" && row.family !== "tractor")) return unknown("module-identity-unavailable");
    const maxRangeMeters = number(row.maxRangeMeters), settlementSurfaceDistanceMeters = number(row.settlementSurfaceDistanceMeters);
    const complete = maxRangeMeters !== null && (row.family !== "tractor" || settlementSurfaceDistanceMeters !== null);
    const availability = row.availability === "available" && complete ? "available" : "unknown";
    modules.push({ moduleID, typeID, family: row.family,
      resourceFamily: row.resourceFamily === "ore" || row.resourceFamily === "ice" || row.resourceFamily === "gas" ? row.resourceFamily : null,
      maxRangeMeters: availability === "available" ? maxRangeMeters : null, settlementSurfaceDistanceMeters,
      availability, reason: availability === "available" ? null : reason(row.reason) ?? "range-calculation-unavailable" });
  }
  return { shipID, sampledAtSimTimeMs, availability: "available", reason: null, modules };
}

/** Same-scene, item/type-scoped reach. No base-dogma fallback or activation grace. */
export function readObservedModuleReach(scene: SpaceSnapshot | null, moduleID: number, typeID: number): ModuleReach | null {
  const observation = scene?.ship?.moduleReach;
  if (!scene?.inSpace || scene.shipID === null || scene.ship?.itemID !== scene.shipID ||
    observation?.availability !== "available" || observation.shipID !== scene.shipID ||
    scene.sampledAtMs === null || observation.sampledAtSimTimeMs !== scene.sampledAtMs) return null;
  return observation.modules?.find(row => row.moduleID === moduleID && row.typeID === typeID && row.availability === "available") ?? null;
}
