import { unwrapLong, type JsonValue } from "./wire.ts";

export type SupportServiceState = "active" | "inactive" | "unknown";
export interface BurstServiceFacts {
  readonly moduleID: number;
  readonly typeID: number | null;
  readonly effectID: number | null;
  readonly effectName: string | null;
  readonly chargeTypeID: number | null;
  readonly chargeItemID: number | null;
  readonly rangeMeters: number | null;
  readonly cycleDurationMs: number | null;
  readonly buffDurationMs: number | null;
  readonly buffs: readonly { readonly collectionID: number; readonly value: number | null }[] | null;
}
export interface MiningBurstServices {
  readonly activeModuleIDs: readonly number[];
  readonly bursts: readonly BurstServiceFacts[];
}
export interface CompressionServiceObservation {
  readonly state: SupportServiceState;
  /** Exact runtime typelist/range association, never reconstructed from a max. */
  readonly typeListRanges: readonly { readonly typeListID: number; readonly rangeMeters: number }[] | null;
  /** Identity only; does not claim a module-to-typelist pairing not supplied. */
  readonly compressors: readonly { readonly moduleID: number; readonly typeID: number | null }[] | null;
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
}
function id(value: JsonValue | undefined): number | null {
  if (value == null) return null;
  const decoded = unwrapLong(value);
  const numeric = decoded === null ? NaN : Number(decoded);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}
function measurement(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function text(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function decodeMiningBurstServices(value: JsonValue | undefined): MiningBurstServices | null {
  const raw = object(value);
  if (!raw || !Array.isArray(raw.activeModuleIDs) || !Array.isArray(raw.bursts)) return null;
  const activeModuleIDs = raw.activeModuleIDs.map(id);
  if (activeModuleIDs.some(value => value === null)) return null;
  const bursts: BurstServiceFacts[] = [];
  for (const entry of raw.bursts) {
    const row = object(entry);
    const moduleID = id(row?.moduleID);
    if (!row || moduleID === null) return null;
    let buffs: BurstServiceFacts["buffs"] = null;
    if (Array.isArray(row.buffs)) {
      const decoded = row.buffs.map(entry => {
        const buff = object(entry);
        return { collectionID: id(buff?.collectionID), value: typeof buff?.value === "number" && Number.isFinite(buff.value) ? buff.value : null };
      });
      if (decoded.every((buff): buff is { collectionID: number; value: number | null } => buff.collectionID !== null)) buffs = decoded;
    }
    bursts.push({ moduleID, typeID: id(row.typeID), effectID: id(row.effectID), effectName: text(row.effectName),
      chargeTypeID: id(row.chargeTypeID), chargeItemID: id(row.chargeItemID), rangeMeters: measurement(row.rangeMeters),
      cycleDurationMs: measurement(row.cycleDurationMs), buffDurationMs: measurement(row.buffDurationMs), buffs });
  }
  return { activeModuleIDs: activeModuleIDs as number[], bursts };
}

export function decodeCompressionService(value: JsonValue | undefined): CompressionServiceObservation {
  const raw = object(value);
  const unknown: CompressionServiceObservation = { state: "unknown", typeListRanges: null, compressors: null };
  if (!raw || (raw.state !== "active" && raw.state !== "inactive" && raw.state !== "unknown")) return unknown;
  let compressors: CompressionServiceObservation["compressors"] = null;
  if (Array.isArray(raw.compressors)) {
    const decoded = raw.compressors.map(entry => {
      const module = object(entry);
      return { moduleID: id(module?.moduleID), typeID: id(module?.typeID) };
    });
    if (decoded.every((module): module is { moduleID: number; typeID: number | null } => module.moduleID !== null)) compressors = decoded;
  }
  if (raw.state === "unknown") return { ...unknown, compressors };
  if (!Array.isArray(raw.typeListRanges)) return { ...unknown, compressors };
  const pairs = raw.typeListRanges.map(entry => {
    const pair = object(entry);
    return { typeListID: id(pair?.typeListID), rangeMeters: measurement(pair?.rangeMeters) };
  });
  if (!pairs.every((pair): pair is { typeListID: number; rangeMeters: number } => pair.typeListID !== null && pair.rangeMeters !== null && pair.rangeMeters > 0)) return { ...unknown, compressors };
  if ((raw.state === "active" && pairs.length === 0) || (raw.state === "inactive" && pairs.length > 0)) return { ...unknown, compressors };
  return { state: raw.state, typeListRanges: pairs, compressors };
}
