import { itemHasActivationCycle, type BoundDogmaAllInfo, type DogmaAttribute } from "../bridge/boundDogma.ts";
import type { JsonValue } from "../bridge/wire.ts";
import type { FittingSlot, LoadedCharge, ShipBay } from "../store/types.ts";
import { isMiningGroup } from "../space/rowActions.ts";
import { droneRoleForGroup } from "./droneRoles.ts";
import type { CapabilityScope } from "./scriptCapabilities.ts";

export type CapabilityPresence = "present" | "absent" | "unknown";

/** Observed fitted equipment, never a promise that activation will succeed. */
export interface MiningSupportModule {
  readonly itemID: number;
  readonly typeID: number;
  readonly groupID: number | null;
  readonly groupName: string | null;
  readonly typeName: string | null;
  readonly online: boolean;
  readonly charge: LoadedCharge | null;
  /** null means matching item dogma was unavailable; false means no cycle. */
  readonly hasActivationCycle: boolean | null;
  readonly effectiveAttributes: readonly DogmaAttribute[] | null;
  /** Raw observed effects; does not invent a default activation effect. */
  readonly activeEffects: JsonValue | null;
  readonly maxRangeMeters: number | null;
  readonly capacitorNeed: number | null;
  readonly maxTractorVelocity: number | null;
  readonly fuelTypeID: number | null;
  readonly fuelPerCycle: number | null;
  readonly compressionTypeListID: number | null;
  readonly requiresActiveCore: boolean | null;
}

export interface MiningSupportModuleFamily {
  /** present proves fitted family membership, not online/usable/active state. */
  readonly presence: CapabilityPresence;
  readonly modules: readonly MiningSupportModule[];
}

export interface MiningSupportDroneCapability {
  readonly presence: CapabilityPresence;
  readonly stacks: readonly { readonly itemID: number; readonly typeID: number; readonly quantity: number }[];
  readonly unclassifiedItemIDs: readonly number[];
}

export interface MiningSupportStorage {
  readonly presence: CapabilityPresence;
  /** Existing bay facts only. No routing, capacity arithmetic or transfers. */
  readonly bays: readonly ShipBay[];
}

export interface MiningSupportCapabilities {
  readonly scope: CapabilityScope;
  readonly bursts: MiningSupportModuleFamily;
  readonly mining: MiningSupportModuleFamily;
  readonly tractors: MiningSupportModuleFamily;
  readonly industrialCores: MiningSupportModuleFamily;
  readonly compressors: MiningSupportModuleFamily;
  readonly unclassifiedModuleItemIDs: readonly number[];
  readonly miningDrones: MiningSupportDroneCapability;
  readonly storage: {
    readonly cargo: MiningSupportStorage;
    readonly mining: MiningSupportStorage;
    readonly fleetHangar: MiningSupportStorage;
  };
}

/** Supply current decoded reads. null means unreadable, [] means observed empty.
 * Dogma and bays must belong to scope.shipID. No hull name/type is accepted.
 */
export interface MiningSupportCapabilityInputs {
  readonly scope: CapabilityScope;
  readonly slots: readonly FittingSlot[] | null;
  readonly dogma: BoundDogmaAllInfo | null;
  readonly bays: { readonly shipID: number; readonly rows: readonly ShipBay[] } | null;
  readonly groupOf: (typeID: number) => string | null;
  readonly typeNameOf: (typeID: number) => string | null;
}

// SDE group mappings, not module-type or hull whitelists. 1770 also contains
// combat bursts; 515 also contains siege/triage/bastion. Resolve their equipment
// names before claiming the narrower support families. Mining and drones use
// WC's existing classifiers. No missing name can prove a shared-group subtype.
const SUPPORT_GROUPS = { bursts: 1770, tractors: 650, industrialCores: 515, compressors: 4174 } as const;
const MINING_BAYS = new Set(["ore", "gas", "ice", "asteroid"]);

function numberAttribute(attributes: readonly DogmaAttribute[] | null, id: number): number | null {
  const value = attributes?.find(attribute => attribute.attributeID === id)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function storage(rows: readonly ShipBay[] | null, matches: (key: string) => boolean): MiningSupportStorage {
  const bays = rows?.filter(bay => matches(bay.key)) ?? [];
  const presence = bays.some(bay => bay.present === true) ? "present"
    : rows === null || bays.length === 0 || bays.some(bay => bay.present === null || bay.error !== null) ? "unknown" : "absent";
  return { presence, bays: structuredClone(bays) };
}

/** Pure snapshot derivation. Recompute on new observations; do not cache charges
 * or drone/storage contents by fitting signature (those can change without refit).
 * A known group proves fitted equipment only. Missing dogma stays null and cannot
 * be treated as activation authority by a future controller.
 */
export function deriveMiningSupportCapabilities(input: MiningSupportCapabilityInputs): MiningSupportCapabilities {
  const shipID = input.scope.shipID;
  const slots = shipID === null ? null : input.slots;
  const dogma = shipID !== null && Number(input.dogma?.activeShipID) === shipID ? input.dogma : null;
  const bays = shipID !== null && input.bays?.shipID === shipID ? input.bays.rows : null;
  const modules: MiningSupportModule[] = [];
  const unclassified: number[] = [];
  const miners = new Set<number>();
  for (const slot of slots ?? []) {
    const fitted = slot.module;
    if (!fitted || slot.family === "rig" || slot.family === "subsystem") continue;
    const groupName = input.groupOf(fitted.typeID);
    if (fitted.groupID === null && groupName === null) unclassified.push(fitted.itemID);
    if (slot.family === "high" && groupName !== null && isMiningGroup(groupName)) miners.add(fitted.itemID);
    // Match item identity, type, location and category before using effective
    // dogma retained by the fitting store across a refit/ship switch.
    const entry = dogma?.ships.find(item => Number(item.itemID) === fitted.itemID &&
      item.typeID === fitted.typeID && Number(item.locationID) === shipID && item.categoryID === 7);
    const attributes = entry?.attributes ?? null;
    const requiresCore = numberAttribute(attributes, 3265);
    modules.push({
      itemID: fitted.itemID, typeID: fitted.typeID, groupID: fitted.groupID, groupName, typeName: input.typeNameOf(fitted.typeID),
      online: fitted.online, charge: fitted.charge === null ? null : { ...fitted.charge },
      hasActivationCycle: entry ? itemHasActivationCycle({ ...dogma!, ships: [entry] }, fitted.itemID) : null,
      effectiveAttributes: attributes === null ? null : attributes.map(attribute => ({ ...attribute })),
      activeEffects: entry ? structuredClone(entry.activeEffects) : null,
      maxRangeMeters: numberAttribute(attributes, 54), capacitorNeed: numberAttribute(attributes, 6),
      maxTractorVelocity: numberAttribute(attributes, 1045), fuelTypeID: numberAttribute(attributes, 713),
      fuelPerCycle: numberAttribute(attributes, 714), compressionTypeListID: numberAttribute(attributes, 3255),
      requiresActiveCore: requiresCore === null ? null : requiresCore > 0,
    });
  }
  function family(matches: (module: MiningSupportModule) => boolean, classificationUnknown: boolean): MiningSupportModuleFamily {
    const selected = modules.filter(matches);
    return { presence: selected.length > 0 ? "present" : slots === null || classificationUnknown ? "unknown" : "absent", modules: selected };
  }
  const support = (key: keyof typeof SUPPORT_GROUPS) => family(module => module.groupID === SUPPORT_GROUPS[key], modules.some(module => module.groupID === null));
  const namedSupport = (key: "bursts" | "industrialCores", pattern: RegExp) => family(
    module => module.groupID === SUPPORT_GROUPS[key] && module.typeName !== null && pattern.test(module.typeName),
    modules.some(module => module.groupID === null || (module.groupID === SUPPORT_GROUPS[key] && module.typeName === null)),
  );
  const droneBay = bays?.find(bay => bay.key === "drone");
  const stacks: MiningSupportDroneCapability["stacks"][number][] = [];
  const unknownDrones: number[] = [];
  const droneItems = droneBay?.present === false && droneBay.error === null ? []
    : droneBay?.present === true && droneBay.error === null ? droneBay.items : null;
  for (const row of droneItems ?? []) {
    const role = droneRoleForGroup(input.groupOf(row.typeID));
    if (role === "mining") stacks.push({ itemID: row.itemID, typeID: row.typeID, quantity: row.quantity });
    else if (role === null) unknownDrones.push(row.itemID);
  }
  return {
    scope: { ...input.scope }, bursts: namedSupport("bursts", /\bmining foreman burst\b/i), mining: family(module => miners.has(module.itemID),
      (slots ?? []).some(slot => slot.family === "high" && slot.module !== null && input.groupOf(slot.module.typeID) === null)),
    tractors: support("tractors"), industrialCores: namedSupport("industrialCores", /\bindustrial core\b/i), compressors: support("compressors"),
    unclassifiedModuleItemIDs: unclassified,
    miningDrones: { presence: stacks.length > 0 ? "present" : droneItems == null || unknownDrones.length > 0 ? "unknown" : "absent", stacks, unclassifiedItemIDs: unknownDrones },
    storage: { cargo: storage(bays, key => key === "cargo"), mining: storage(bays, key => MINING_BAYS.has(key)), fleetHangar: storage(bays, key => key === "fleet") },
  };
}
