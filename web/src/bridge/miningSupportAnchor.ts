import { decodeMiningBurstServices, decodeCompressionService } from "./miningSupportServices.ts";
import { decodeCoreMobilityFuel } from "./miningSupportCore.ts";
import type { JsonValue } from "./wire.ts";
import type { MiningSupportAnchor, MiningSupportAnchorRead, SupportFleetRoster } from "../nav/miningSupportAnchor.ts";

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
function id(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function time(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function fleetID(value: JsonValue | undefined): string | null {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : null;
}
function text(value: JsonValue | undefined): string | null { return typeof value === "string" && value.length > 0 ? value : null; }

export function decodeMiningSupportAnchor(value: JsonValue | undefined): MiningSupportAnchor | null {
  const raw = object(value);
  const characterID = id(raw.characterID), shipID = id(raw.shipID), fleet = fleetID(raw.fleetID), sessionEpoch = text(raw.sessionEpoch);
  const sampledAtMs = time(raw.sampledAtMs), observedAtMs = time(raw.observedAtMs), publishedAtMs = time(raw.publishedAtMs), expiresAtMs = time(raw.expiresAtMs), ageMs = time(raw.ageMs);
  const freshness = raw.freshness;
  if (characterID === null || shipID === null || fleet === null || sessionEpoch === null || sampledAtMs === null || observedAtMs === null
    || publishedAtMs === null || expiresAtMs === null || ageMs === null || observedAtMs > publishedAtMs || expiresAtMs <= publishedAtMs
    || (freshness !== "fresh" && freshness !== "stale" && freshness !== "invalid")) return null;
  const services = object(raw.services);
  const effects = decodeCoreMobilityFuel(services.supportEffects);
  return { characterID, shipID, fleetID: fleet, sessionEpoch, sampledAtMs, observedAtMs, publishedAtMs, expiresAtMs, ageMs, freshness,
    solarSystemID: id(raw.solarSystemID), reason: text(raw.reason), services: {
      bursts: decodeMiningBurstServices(services.bursts), compression: decodeCompressionService(services.compression),
      supportEffects: effects ? { activeModuleIDs: effects.activeModuleIDs, mobility: effects.mobility,
        modules: effects.modules.map(({ moduleID, typeID, active, effect }) => ({ moduleID, typeID, active, effect })) } : null,
    } };
}
function decodeRoster(value: JsonValue | undefined): SupportFleetRoster | null {
  const raw = object(value);
  const fleet = fleetID(raw.fleetID), readerCharacterID = id(raw.readerCharacterID), observedAtMs = time(raw.observedAtMs), expiresAtMs = time(raw.expiresAtMs);
  if (!fleet || readerCharacterID === null || observedAtMs === null || expiresAtMs === null || expiresAtMs <= observedAtMs || !Array.isArray(raw.members)) return null;
  const members: SupportFleetRoster["members"][number][] = [];
  for (const value of raw.members) {
    const row = object(value), characterID = id(row.characterID);
    if (characterID === null) return null;
    members.push({ characterID, solarSystemID: id(row.solarSystemID) });
  }
  if (!members.some(row => row.characterID === readerCharacterID)) return null;
  return { fleetID: fleet, readerCharacterID, observedAtMs, expiresAtMs, members };
}
export function decodeMiningSupportAnchorRead(value: JsonValue | undefined): MiningSupportAnchorRead {
  const raw = object(value);
  const readAtMs = time(raw.readAtMs) ?? 0;
  const unknown = (reason: string): MiningSupportAnchorRead => ({ availability: "unknown", reason, readAtMs, fleet: null, anchors: [] });
  if (raw.availability !== "available") return unknown(text(raw.reason) ?? "read-unavailable");
  const fleet = decodeRoster(raw.fleet);
  if (!fleet || !Array.isArray(raw.anchors)) return unknown("invalid-board-read");
  const anchors: MiningSupportAnchor[] = [];
  for (const value of raw.anchors) {
    const anchor = decodeMiningSupportAnchor(value);
    if (!anchor || anchor.fleetID !== fleet.fleetID) return unknown("invalid-anchor");
    anchors.push(anchor);
  }
  return { availability: "available", reason: null, readAtMs, fleet, anchors };
}
