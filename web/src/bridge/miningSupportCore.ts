import { unwrapLong, type JsonValue } from "./wire.ts";

export interface RestrictionSource {
  readonly moduleID: number;
  readonly effectID: number | null;
  readonly effectName: string | null;
}
export interface MobilityRestriction {
  /** Runtime restriction gate only; not a promise that every action precondition passes. */
  readonly verdict: "restricted" | "unrestricted" | "unknown";
  readonly reasonCode: string | null;
  readonly sources: readonly RestrictionSource[] | null;
}
export interface ModuleStartupFuelQuote {
  readonly moduleID: number | null;
  readonly availability: "available" | "unknown" | "not-applicable";
  readonly reason: string | null;
  readonly fuelTypeID: number | null;
  readonly requiredQuantity: number | null;
  readonly availableQuantity: number | null;
  /** Server verdict, never recomputed from fitting dogma in WC. */
  readonly sufficient: boolean | null;
}
export interface ModuleFuelObservation {
  readonly typeID: number | null;
  readonly effectivePerActivation: number | null;
  readonly availableQuantity: number | null;
  readonly eligibleFlagIDs: readonly number[] | null;
  readonly stacks: readonly { readonly itemID: number | null; readonly locationID: number | null; readonly flagID: number | null; readonly quantity: number | null }[] | null;
  readonly activationFailureCode: string | null;
  readonly startupQuote: ModuleStartupFuelQuote;
}
export interface CoreEffectObservation extends RestrictionSource {
  readonly startedAtMs: number | null;
  readonly cycleDurationMs: number | null;
  readonly nextCycleAtMs: number | null;
  readonly deactivationRequestedAtMs: number | null;
  readonly deactivateAtMs: number | null;
  readonly stopReason: string | null;
}
export interface CoreMobilityFuelObservation {
  readonly activeModuleIDs: readonly number[] | null;
  readonly modules: readonly {
    readonly moduleID: number;
    readonly typeID: number | null;
    readonly active: boolean | null;
    readonly effect: CoreEffectObservation | null;
    readonly fuel: ModuleFuelObservation;
  }[];
  readonly mobility: { readonly movement: MobilityRestriction; readonly warp: MobilityRestriction };
}
export const UNKNOWN_MOBILITY_RESTRICTION: MobilityRestriction = { verdict: "unknown", reasonCode: null, sources: null };
export const UNKNOWN_STARTUP_FUEL_QUOTE: ModuleStartupFuelQuote = { moduleID: null, availability: "unknown", reason: "observation-unavailable", fuelTypeID: null, requiredQuantity: null, availableQuantity: null, sufficient: null };
export const UNKNOWN_MODULE_FUEL: ModuleFuelObservation = { typeID: null, effectivePerActivation: null, availableQuantity: null, eligibleFlagIDs: null, stacks: null, activationFailureCode: null, startupQuote: UNKNOWN_STARTUP_FUEL_QUOTE };

function object(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
}
function number(value: JsonValue | undefined): number | null {
  if (value == null) return null;
  const unwrapped = unwrapLong(value);
  const result = typeof value === "number" ? value : unwrapped === null ? NaN : Number(unwrapped);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function id(value: JsonValue | undefined): number | null {
  const result = number(value);
  return result !== null && Number.isSafeInteger(result) && result > 0 ? result : null;
}
function text(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function ids(value: JsonValue | undefined): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(id);
  return values.every((value): value is number => value !== null) ? values : null;
}
function source(value: JsonValue | undefined): RestrictionSource | null {
  const raw = object(value);
  const moduleID = id(raw?.moduleID);
  return raw && moduleID !== null ? { moduleID, effectID: id(raw.effectID), effectName: text(raw.effectName) } : null;
}
function restriction(value: JsonValue | undefined): MobilityRestriction {
  const raw = object(value);
  const verdict = raw?.verdict === "restricted" || raw?.verdict === "unrestricted" ? raw.verdict : "unknown";
  const sources = Array.isArray(raw?.sources) ? raw.sources.map(source) : null;
  return { verdict, reasonCode: verdict === "unknown" ? null : text(raw?.reasonCode),
    sources: sources?.every((value): value is RestrictionSource => value !== null) ? sources : null };
}
function startupQuote(value: JsonValue | undefined, moduleID: number): ModuleStartupFuelQuote {
  const raw = object(value);
  if (!raw) return { ...UNKNOWN_STARTUP_FUEL_QUOTE, moduleID };
  if (id(raw.moduleID) !== moduleID) return { ...UNKNOWN_STARTUP_FUEL_QUOTE, moduleID, reason: "module-scope-mismatch" };
  const fuelTypeID = id(raw.fuelTypeID);
  const requiredQuantity = number(raw.requiredQuantity);
  const availableQuantity = number(raw.availableQuantity);
  const complete = fuelTypeID !== null && requiredQuantity !== null && Number.isSafeInteger(requiredQuantity) &&
    availableQuantity !== null && typeof raw.sufficient === "boolean";
  const availability = raw.availability === "available" && complete ? "available"
    : raw.availability === "not-applicable" ? "not-applicable" : "unknown";
  return { moduleID, fuelTypeID, requiredQuantity, availableQuantity, availability,
    sufficient: availability === "available" ? raw.sufficient as boolean : null,
    reason: availability === "available" ? null : text(raw.reason) ?? "quote-unavailable" };
}
function fuel(value: JsonValue | undefined, moduleID: number): ModuleFuelObservation {
  const raw = object(value);
  if (!raw) return { ...UNKNOWN_MODULE_FUEL, startupQuote: { ...UNKNOWN_STARTUP_FUEL_QUOTE, moduleID } };
  return { typeID: id(raw.typeID), effectivePerActivation: number(raw.effectivePerActivation), availableQuantity: number(raw.availableQuantity),
    eligibleFlagIDs: ids(raw.eligibleFlagIDs), activationFailureCode: text(raw.activationFailureCode),
    startupQuote: startupQuote(raw.startupQuote, moduleID),
    stacks: Array.isArray(raw.stacks) ? raw.stacks.map(entry => {
      const stack = object(entry);
      return { itemID: id(stack?.itemID), locationID: id(stack?.locationID), flagID: id(stack?.flagID), quantity: number(stack?.quantity) };
    }) : null };
}

export function decodeCoreMobilityFuel(value: JsonValue | undefined): CoreMobilityFuelObservation | null {
  const raw = object(value);
  if (!raw || !Array.isArray(raw.modules)) return null;
  const modules: CoreMobilityFuelObservation["modules"][number][] = [];
  for (const value of raw.modules) {
    const row = object(value);
    const moduleID = id(row?.moduleID);
    if (!row || moduleID === null) return null;
    const effectRaw = object(row.effect);
    const identity = source(row.effect);
    const effect = identity && identity.moduleID === moduleID && effectRaw ? { ...identity,
      startedAtMs: number(effectRaw.startedAtMs), cycleDurationMs: number(effectRaw.cycleDurationMs), nextCycleAtMs: number(effectRaw.nextCycleAtMs),
      deactivationRequestedAtMs: number(effectRaw.deactivationRequestedAtMs), deactivateAtMs: number(effectRaw.deactivateAtMs), stopReason: text(effectRaw.stopReason) } : null;
    modules.push({ moduleID, typeID: id(row.typeID), active: typeof row.active === "boolean" ? row.active : null, effect, fuel: fuel(row.fuel, moduleID) });
  }
  const mobility = object(raw.mobility);
  return { activeModuleIDs: ids(raw.activeModuleIDs), modules, mobility: { movement: restriction(mobility?.movement), warp: restriction(mobility?.warp) } };
}
