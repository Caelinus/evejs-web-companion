import type { FlightStatus } from "../store/types.ts";

export type DockableKind = "station" | "structure";

/** Stable, kind-aware identity for a place at which a pilot may dock. */
export interface DockableLocation {
  readonly kind: DockableKind;
  readonly id: number;
  readonly name: string;
  readonly solarSystemID: number;
  readonly solarSystemName: string | null;
}

export type DockableCapability = "dock" | "personalInventory" | "corporationHangar" |
  "fitting" | "repair" | "reprocessing" | "market" | "industry";

const SERVICE_ID: Readonly<Record<Exclude<DockableCapability, "personalInventory">, number>> = {
  dock: 1, fitting: 2, corporationHangar: 3, reprocessing: 4, market: 5, repair: 8, industry: 20,
};

/** A service read is access-scoped; null means unreadable and grants nothing. */
export function structureHasCapability(ids: readonly number[] | null, capability: DockableCapability): boolean {
  if (ids === null) return false;
  return ids.includes(SERVICE_ID[capability === "personalInventory" ? "dock" : capability]);
}

export function dockedAt(status: FlightStatus | null | undefined, location: Pick<DockableLocation, "kind" | "id">): boolean {
  return status?.docked === true &&
    (location.kind === "structure" ? status.structureID : status.stationID) === location.id;
}
