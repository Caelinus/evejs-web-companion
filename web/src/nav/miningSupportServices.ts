import type { BurstServiceFacts, CompressionServiceObservation, SupportServiceState } from "../bridge/miningSupportServices.ts";
import type { SpaceSnapshot } from "../store/types.ts";
import type { MiningSupportCapabilities, MiningSupportModule } from "./miningSupportCapabilities.ts";
import { UNKNOWN_MOBILITY_RESTRICTION, UNKNOWN_MODULE_FUEL, type CoreEffectObservation, type ModuleFuelObservation, type MobilityRestriction } from "../bridge/miningSupportCore.ts";

export interface MiningSupportServiceSnapshot {
  readonly capabilities: MiningSupportCapabilities;
  /** Timestamp of this observation, not a freshness timer or expiry claim. */
  readonly sampledAtMs: number | null;
  /** Generic fitted-effect lifecycle, matched to own compressor item/type. */
  readonly compressorEffects?: readonly { readonly moduleID: number; readonly typeID: number; readonly effect: CoreEffectObservation }[];
  readonly cores: readonly {
    readonly capability: MiningSupportModule;
    readonly state: "inactive" | "active" | "deactivation-pending" | "unknown";
    readonly effect: CoreEffectObservation | null;
    readonly fuel: ModuleFuelObservation & { readonly typeName: string | null;
      readonly startupQuote: ModuleFuelObservation["startupQuote"] & { readonly fuelName: string | null } };
    /** Never inferred from available quantity, elapsed time, or inactivity. */
    readonly fuelFailure: "activation-no-fuel" | "cycle-fuel" | "unknown";
  }[];
  readonly mobility: {
    readonly scope: "runtime-action-restrictions";
    readonly movement: MobilityRestriction;
    readonly warp: MobilityRestriction;
  };
  readonly bursts: readonly {
    readonly capability: MiningSupportModule;
    readonly state: SupportServiceState | "deactivation-pending";
    readonly effect?: CoreEffectObservation | null;
    readonly facts: BurstServiceFacts | null;
  }[];
  readonly compression: {
    readonly observation: "available" | "unknown";
    readonly facilities: readonly (CompressionServiceObservation & {
      readonly shipID: number;
      readonly pilotID: number | null;
      readonly ownerID: number | null;
      /** External does not prove fleet membership or access. */
      readonly origin: "self" | "external";
    })[];
  };
}

/** Latest loaded service observation only. No fit cache, range arithmetic,
 * activation, recipient confirmation or inference from fitted equipment.
 */
export function deriveMiningSupportServices(capabilities: MiningSupportCapabilities, observation: SpaceSnapshot | null, typeNameOf: (typeID: number) => string | null = () => null): MiningSupportServiceSnapshot {
  const shipID = capabilities.scope.shipID;
  const current = shipID !== null && observation?.inSpace === true && observation.shipID === shipID && observation.ship?.itemID === shipID ? observation : null;
  const services = current?.ship?.miningBurstServices ?? null;
  const coreObservation = current?.ship?.coreMobilityFuel ?? null;
  const self = current?.entities.find(entity => entity.itemID === shipID);
  const facilities: MiningSupportServiceSnapshot["compression"]["facilities"][number][] = current === null ? [] : [{
    ...structuredClone(current.ship?.compressionService ?? { state: "unknown" as const, typeListRanges: null, compressors: null }),
    shipID: shipID!, pilotID: current.ship?.characterID ?? self?.characterID ?? null, ownerID: current.ship?.ownerID ?? self?.ownerID ?? null, origin: "self",
  }, ...current.entities.filter(entity => entity.kind === "ship" && !entity.isNpc && entity.itemID !== shipID).map(entity => ({
    ...structuredClone(entity.compressionService ?? { state: "unknown" as const, typeListRanges: null, compressors: null }),
    shipID: entity.itemID, pilotID: entity.characterID, ownerID: entity.ownerID, origin: "external" as const,
  }))];
  return {
    capabilities,
    sampledAtMs: current?.sampledAtMs ?? null,
    compressorEffects: capabilities.compressors.modules.flatMap(capability => {
      const module = coreObservation?.modules.find(row => row.moduleID === capability.itemID && row.typeID === capability.typeID);
      return module?.active === true && coreObservation?.activeModuleIDs?.includes(capability.itemID) &&
        module.effect?.effectName?.toLowerCase() === "industrialitemcompression"
        ? [{ moduleID: capability.itemID, typeID: capability.typeID, effect: structuredClone(module.effect) }] : [];
    }),
    cores: capabilities.industrialCores.modules.map(capability => {
      const module = coreObservation?.modules.find(module => module.moduleID === capability.itemID && module.typeID === capability.typeID);
      const activeIDs = coreObservation?.activeModuleIDs ?? null;
      let state: MiningSupportServiceSnapshot["cores"][number]["state"] = "unknown";
      if (activeIDs !== null) {
        if (!activeIDs.includes(capability.itemID) && (!module || module.active === false)) state = "inactive";
        else if (activeIDs.includes(capability.itemID) && module?.active === true && module.effect !== null) {
          // A passed boundary timestamp cannot end an effect that authority
          // still retains. Only a later effect-map absence proves inactivity.
          state = (module.effect.deactivationRequestedAtMs ?? 0) > 0 || (module.effect.deactivateAtMs ?? 0) > 0 ? "deactivation-pending" : "active";
        }
      }
      const fuel = structuredClone(module?.fuel ?? UNKNOWN_MODULE_FUEL);
      return { capability, state, effect: structuredClone(module?.effect ?? null),
        fuel: { ...fuel, typeName: fuel.typeID === null ? null : typeNameOf(fuel.typeID),
          startupQuote: { ...fuel.startupQuote, fuelName: fuel.startupQuote.fuelTypeID === null ? null : typeNameOf(fuel.startupQuote.fuelTypeID) } },
        fuelFailure: fuel.activationFailureCode === "NO_FUEL" ? "activation-no-fuel" as const : module?.effect?.stopReason === "fuel" ? "cycle-fuel" as const : "unknown" as const };
    }),
    mobility: { scope: "runtime-action-restrictions",
      movement: structuredClone(coreObservation?.mobility.movement ?? UNKNOWN_MOBILITY_RESTRICTION),
      warp: structuredClone(coreObservation?.mobility.warp ?? UNKNOWN_MOBILITY_RESTRICTION) },
    bursts: capabilities.bursts.modules.map(capability => {
      const facts = services?.bursts.find(burst => burst.moduleID === capability.itemID && burst.typeID === capability.typeID) ?? null;
      const module = coreObservation?.modules.find(row => row.moduleID === capability.itemID && row.typeID === capability.typeID);
      const effect = module?.active === true && coreObservation?.activeModuleIDs?.includes(capability.itemID) &&
        module.effect?.effectName?.toLowerCase() === "modulebonuswarfarelinkmining" &&
        module.effect.effectID === facts?.effectID ? module.effect : null;
      const state = services === null ? "unknown" : !services.activeModuleIDs.includes(capability.itemID) ? "inactive" : facts === null ? "unknown"
        : effect && (effect.deactivationRequestedAtMs ?? 0) > 0 && (effect.deactivateAtMs ?? 0) > 0 ? "deactivation-pending" : "active";
      return { capability, state, facts: state === "active" || state === "deactivation-pending" ? structuredClone(facts) : null, effect: structuredClone(effect) };
    }),
    compression: {
      observation: current === null || facilities.some(facility => facility.state === "unknown") ? "unknown" : "available",
      facilities,
    },
  };
}
