// Ship-fitting reads decoded to plain slots and resource bars (goal R12).
//
// The BFF drives the retail calls and returns their raw results; this module
// turns them into what the panel renders:
//
//   ListByFlags   -> one entry per SLOT, in slot order, each either empty or
//                    holding a module (addressed by typeID so the panel can
//                    show its NAME — never an ID)
//   ShipGetInfo   -> the ship's dogma attribute map -> CPU / powergrid /
//                    capacitor / calibration used-vs-total
//   ShipOnlineModules -> which fitted modules are currently online
//
// Slot flagIDs live on the BFF and in this decoder only; the panel and every
// action address a slot by FAMILY + INDEX ("the third high slot"), so no raw
// flagID, typeID or itemID ever reaches the rendered UI.

import { isListValue, unwrapLong, type JsonValue } from "./wire.ts";
import type {
  FittedModule,
  FittingResource,
  FittingResources,
  FittingSlot,
  SlotFamily,
} from "../store/types.ts";

/**
 * Slot flag families (inventorycommon/const.py), mirroring the BFF's own map
 * and the server's SLOT_FAMILY_FLAGS. These are the SERVER's ranges (rig
 * 92-99, subsystem 125-132), which are wider than the retail client's own
 * lists (92-94 / 125-128); the server clamps each family to the ship's real
 * slot count, so the wider range never invents a slot.
 */
const SLOT_FAMILY_FLAGS: Readonly<Record<SlotFamily, readonly number[]>> = {
  high: [27, 28, 29, 30, 31, 32, 33, 34],
  mid: [19, 20, 21, 22, 23, 24, 25, 26],
  low: [11, 12, 13, 14, 15, 16, 17, 18],
  rig: [92, 93, 94, 95, 96, 97, 98, 99],
  subsystem: [125, 126, 127, 128, 129, 130, 131, 132],
};

/** The inventory flag of one slot, or null past the family's range. */
export function slotFlagOf(family: SlotFamily, index: number): number | null {
  return SLOT_FAMILY_FLAGS[family][index] ?? null;
}

/** Render order: how a fitting window reads top to bottom. */
export const SLOT_FAMILY_ORDER: readonly SlotFamily[] = [
  "high",
  "mid",
  "low",
  "rig",
  "subsystem",
];

/** Player-facing family names — plain language, never "flag 27". */
export const SLOT_FAMILY_LABELS: Readonly<Record<SlotFamily, string>> = {
  high: "High slots",
  mid: "Mid slots",
  low: "Low slots",
  rig: "Rigs",
  subsystem: "Subsystems",
};

/**
 * Dogma attribute IDs (dogma/const.py), cross-checked against this EveJS
 * build's own TYPE_DOGMA attribute names rather than assumed.
 */
const ATTR = {
  cpuOutput: 48,
  cpuLoad: 49,
  powerOutput: 11,
  powerLoad: 15,
  /** "Capacitor Capacity" — null on a DOCKED ship (see readCapacitor). */
  capacitorCapacity: 482,
  /** "charge" — the effective capacitor a docked ship reports instead. */
  capacitorCharge: 18,
  calibrationCapacity: 1132,
  calibrationUsed: 1152,
  slotsHigh: 14,
  slotsMid: 13,
  slotsLow: 12,
  slotsRig: 1137,
  slotsSubsystem: 1366,
} as const;

/** Which attribute carries each family's slot COUNT (how many to draw). */
const SLOT_COUNT_ATTRIBUTE: Readonly<Record<SlotFamily, number>> = {
  high: ATTR.slotsHigh,
  mid: ATTR.slotsMid,
  low: ATTR.slotsLow,
  rig: ATTR.slotsRig,
  subsystem: ATTR.slotsSubsystem,
};

function toNumberOrNull(value: JsonValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
}

function toNumber(value: JsonValue | undefined): number {
  return toNumberOrNull(value) ?? 0;
}

/** Unwrap a python-set-wrapped list (the empty flag-scoped List shape). */
function unwrapRowList(result: JsonValue): JsonValue {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return result;
  }
  const obj = result as { type?: unknown; header?: unknown; args?: unknown };
  if (obj.type === "objectex1" && Array.isArray(obj.header)) {
    const header = obj.header as readonly JsonValue[];
    const token = header[0] as { value?: unknown } | undefined;
    if (token && token.value === "__builtin__.set" && Array.isArray(header[1])) {
      return (header[1] as readonly JsonValue[])[0] ?? { type: "list", items: [] };
    }
  }
  if (obj.type === "object" && Array.isArray(obj.args)) {
    const args = obj.args as readonly JsonValue[];
    return args.length > 0 ? args[0]! : { type: "list", items: [] };
  }
  return result;
}

/** One fitted module as it comes off a ListByFlags row (before slotting). */
interface RawFittedRow {
  readonly itemID: number | readonly [number, number, number];
  readonly locationID: number;
  readonly typeID: number;
  readonly groupID: number | null;
  readonly flagID: number;
  /** 7 = Module, 8 = Charge. null when the row did not carry one. */
  readonly categoryID: number | null;
  /** How many, for a charge stack. -1 for a singleton module. */
  readonly quantity: number;
}

/**
 * inventory categoryID 8 — Charge. A loaded round shares its MODULE'S slot flag,
 * so the category is the only thing that separates the gun from what is in it.
 */
const CATEGORY_CHARGE = 8;

/**
 * Split the ListByFlags rows into the MODULES and the CHARGES loaded in them.
 *
 * A loaded charge shares its module's slot flag. Active-ship ListByFlags may
 * replace its numeric inventory ID with (shipID, flagID, chargeTypeID).
 * Preserve that identity after checking every component against the row;
 * category 8 keeps either representation out of the fitted-module map.
 */
function decodeFittedRows(result: JsonValue): RawFittedRow[] {
  const listValue = unwrapRowList(result);
  if (!isListValue(listValue)) {
    return [];
  }
  const rows: RawFittedRow[] = [];
  for (const item of listValue.items) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const candidate = item as { type?: unknown; fields?: unknown };
    const fields =
      candidate.type === "packedrow" &&
      typeof candidate.fields === "object" &&
      candidate.fields !== null
        ? (candidate.fields as Record<string, JsonValue>)
        : (item as Record<string, JsonValue>);
    const numericID = toNumber(fields.itemID);
    const flagID = toNumber(fields.flagID);
    const typeID = toNumber(fields.typeID), locationID = toNumber(fields.locationID);
    const categoryID = toNumberOrNull(fields.categoryID);
    const tuple = Array.isArray(fields.itemID) && fields.itemID.length === 3 ? fields.itemID.map(toNumber) : null;
    const sublocation = categoryID === CATEGORY_CHARGE && tuple !== null && tuple.every(value => Number.isSafeInteger(value) && value > 0)
      && tuple[0] === locationID && tuple[1] === flagID && tuple[2] === typeID ? tuple as [number, number, number] : null;
    const itemID = sublocation ?? numericID;
    if ((sublocation !== null || Number.isSafeInteger(numericID) && numericID > 0) && flagID > 0) {
      rows.push({
        itemID, locationID, typeID,
        groupID: toNumberOrNull(fields.groupID),
        flagID,
        // categoryID rides only as far as buildSlots, which uses it to tell a
        // module from the charge sharing its flag; it never reaches the panel.
        categoryID,
        quantity: toNumber(fields.quantity),
      });
    }
  }
  return rows;
}

/** Decode a dogmaIM.ShipGetInfo result to its attributeID -> value map. */
export function decodeShipAttributes(result: JsonValue): ReadonlyMap<number, number | null> {
  const byID = new Map<number, number | null>();
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return byID;
  }
  const dict = result as { type?: unknown; entries?: unknown };
  if (dict.type !== "dict" || !Array.isArray(dict.entries)) {
    return byID;
  }
  const first = (dict.entries as readonly JsonValue[])[0];
  const entry = Array.isArray(first) ? (first as readonly JsonValue[])[1] : null;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return byID;
  }
  const keyVal = entry as { args?: { entries?: unknown } };
  const keyValEntries = Array.isArray(keyVal.args?.entries)
    ? (keyVal.args!.entries as readonly JsonValue[])
    : [];
  let attributes: JsonValue | null = null;
  for (const pair of keyValEntries) {
    if (Array.isArray(pair) && pair[0] === "attributes") {
      attributes = (pair as readonly JsonValue[])[1] ?? null;
    }
  }
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
    return byID;
  }
  const attributeDict = attributes as { type?: unknown; entries?: unknown };
  if (attributeDict.type !== "dict" || !Array.isArray(attributeDict.entries)) {
    return byID;
  }
  for (const pair of attributeDict.entries as readonly JsonValue[]) {
    if (!Array.isArray(pair)) {
      continue;
    }
    const attributeID = toNumberOrNull((pair as readonly JsonValue[])[0]);
    if (attributeID !== null) {
      byID.set(attributeID, toNumberOrNull((pair as readonly JsonValue[])[1]));
    }
  }
  return byID;
}

/** Decode dogmaIM.ShipOnlineModules (a flat list of online module itemIDs). */
export function decodeOnlineModuleIDs(result: JsonValue): ReadonlySet<number> {
  const online = new Set<number>();
  if (!isListValue(result)) {
    return online;
  }
  for (const value of result.items) {
    const itemID = toNumberOrNull(value);
    if (itemID !== null && itemID > 0) {
      online.add(itemID);
    }
  }
  return online;
}

function resource(used: number | null, total: number | null): FittingResource {
  return {
    used: used ?? 0,
    total: total ?? 0,
    /** null when the ship reports no total (the bar renders as unknown). */
    known: total !== null && total > 0,
  };
}

/**
 * The capacitor a DOCKED ship reports: its "Capacitor Capacity" attribute is
 * null while docked and the effective capacitor arrives as "charge" instead.
 * Reading capacity-or-charge is what stops the bar going blank in station —
 * pinned by the gateway suite's ShipGetInfo test.
 */
function readCapacitor(attributes: ReadonlyMap<number, number | null>): number | null {
  const capacity = attributes.get(ATTR.capacitorCapacity);
  if (typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0) {
    return capacity;
  }
  const charge = attributes.get(ATTR.capacitorCharge);
  return typeof charge === "number" && Number.isFinite(charge) ? charge : null;
}

/** Decode the ship's CPU / powergrid / capacitor / calibration readings. */
export function decodeResources(result: JsonValue): FittingResources {
  const attributes = decodeShipAttributes(result);
  const capacitor = readCapacitor(attributes);
  return {
    cpu: resource(attributes.get(ATTR.cpuLoad) ?? null, attributes.get(ATTR.cpuOutput) ?? null),
    powergrid: resource(
      attributes.get(ATTR.powerLoad) ?? null,
      attributes.get(ATTR.powerOutput) ?? null,
    ),
    // A capacitor bar reads "full" at rest: the ship's whole capacitor is
    // available, so used is 0 of the total it can hold.
    capacitor: resource(0, capacitor),
    calibration: resource(
      attributes.get(ATTR.calibrationUsed) ?? null,
      attributes.get(ATTR.calibrationCapacity) ?? null,
    ),
  };
}

/**
 * Build the panel's slots: for each family, one entry per slot the SHIP
 * actually has (from its slot-count attribute), in order, each either empty or
 * holding the module fitted there.
 *
 * A module sitting in a slot beyond the reported count is still shown (the
 * server is authoritative about what is fitted; the count only decides how
 * many EMPTY slots to draw).
 */
export function buildSlots(
  slotsResult: JsonValue,
  shipInfoResult: JsonValue,
  onlineResult: JsonValue,
): readonly FittingSlot[] {
  const rows = decodeFittedRows(slotsResult);
  const attributes = decodeShipAttributes(shipInfoResult);
  const online = decodeOnlineModuleIDs(onlineResult);
  // Two maps, not one: a charge shares its module's flag, so a single map would
  // let whichever row arrived last win — and the charge arrives last.
  const byFlag = new Map<number, RawFittedRow>();
  const chargeByFlag = new Map<number, RawFittedRow>();
  for (const row of rows) {
    if (row.categoryID === CATEGORY_CHARGE) {
      chargeByFlag.set(row.flagID, row);
    } else if (typeof row.itemID === "number") {
      byFlag.set(row.flagID, row);
    }
  }

  const slots: FittingSlot[] = [];
  for (const family of SLOT_FAMILY_ORDER) {
    const flags = SLOT_FAMILY_FLAGS[family];
    const reported = attributes.get(SLOT_COUNT_ATTRIBUTE[family]);
    const declared =
      typeof reported === "number" && Number.isFinite(reported) && reported > 0
        ? Math.min(Math.trunc(reported), flags.length)
        : 0;
    // Never hide a fitted module: draw at least as many slots as the highest
    // occupied one in this family.
    let occupied = 0;
    for (let index = 0; index < flags.length; index += 1) {
      if (byFlag.has(flags[index]!)) {
        occupied = index + 1;
      }
    }
    const count = Math.max(declared, occupied);
    for (let index = 0; index < count; index += 1) {
      const row = byFlag.get(flags[index]!) ?? null;
      const charge = chargeByFlag.get(flags[index]!) ?? null;
      const module: FittedModule | null = row && typeof row.itemID === "number"
        ? {
            itemID: row.itemID,
            typeID: row.typeID,
            groupID: row.groupID,
            online: online.has(row.itemID),
            // What is loaded in it, or null for a module that holds nothing.
            // A charge with no module in its slot is dropped rather than shown
            // as a phantom: the server would not have put it there, and drawing
            // ammunition as a fitted item is the very bug this separates out.
            charge: charge && (typeof charge.itemID === "number" || charge.itemID[0] === row.locationID)
              ? { itemID: charge.itemID, typeID: charge.typeID, quantity: charge.quantity }
              : null,
          }
        : null;
      slots.push({ family, index, module });
    }
  }
  return slots;
}

/** The slots of one family, in slot order (the panel groups by family). */
export function slotsOfFamily(
  slots: readonly FittingSlot[],
  family: SlotFamily,
): readonly FittingSlot[] {
  return slots.filter((slot) => slot.family === family);
}

/**
 * Whether an inventory row is a module a player could try to fit: a Module
 * (category 7) or a Subsystem (category 32). Charges, drones and ships are
 * not offered — the panel only lists what "Fit" could plausibly act on, and
 * the SERVER remains the authority on whether any particular fit is legal.
 */
export function isFittableRow(categoryID: number | null): boolean {
  return categoryID === 7 || categoryID === 32;
}

/**
 * Whether an inventory row is a CHARGE — something that could be loaded into a
 * module rather than fitted to the hull.
 *
 * ⚠ DELIBERATELY NOT A COMPATIBILITY TEST. Which charges a given module accepts
 * lives in dogma attributes (chargeGroup1..4) the browser has no allowlisted
 * read for. Narrowing the list by a guess would hide ammunition that would have
 * loaded perfectly well, so the panel offers every charge in the chosen
 * inventory and the SERVER refuses the wrong ones in its own words.
 */
export function isChargeRow(categoryID: number | null): boolean {
  return categoryID === CATEGORY_CHARGE;
}

/** What a module type will take: its charge size, and the groups it accepts. */
export interface ChargeFitment {
  readonly size: number | null;
  readonly groups: readonly number[];
}

/**
 * Decode the fitting read's `chargeFits` map — `{typeID: {size, groups}}`.
 *
 * Absent or unreadable gives `{}`, which is the honest "we cannot say what
 * anything takes". That is deliberately the SAME outcome as a module with no
 * charge attributes: both mean the picker simply cannot sort, never that
 * nothing fits.
 */
export function decodeChargeFits(
  value: JsonValue | undefined,
): Readonly<Record<number, ChargeFitment>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const fits: Record<number, ChargeFitment> = {};
  for (const [key, raw] of Object.entries(value)) {
    const typeID = Number(key);
    if (!Number.isSafeInteger(typeID) || typeID <= 0 || typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, JsonValue>;
    const size = typeof entry.size === "number" && entry.size > 0 ? entry.size : null;
    const groups = Array.isArray(entry.groups)
      ? entry.groups
          .map((groupID) => (typeof groupID === "number" ? groupID : 0))
          .filter((groupID) => groupID > 0)
      : [];
    fits[typeID] = { size, groups };
  }
  return fits;
}

/**
 * Whether a charge LOOKS compatible with a module — group and size both match.
 *
 * ⚠ ADVISORY, AND ONLY EVER USED TO SORT. The SERVER decides what loads, and it
 * refuses silently, so the picker offers every charge and puts the likely ones
 * first. Returning false must never remove a charge from the list: this table
 * cannot know every special case, and hiding a charge that would have worked is
 * a worse failure than showing one that will not.
 *
 * `null` means "cannot say" — no fitment for the module, or no size on either
 * side — and callers must treat it as neutral rather than as a no.
 */
export function chargeLooksCompatible(
  fitment: ChargeFitment | undefined,
  chargeGroupID: number | null,
  chargeSize: number | null,
): boolean | null {
  if (!fitment || fitment.groups.length === 0 || chargeGroupID === null) {
    return null;
  }
  if (!fitment.groups.includes(chargeGroupID)) {
    return false;
  }
  // Same family, wrong calibre — this is the case that failed live: an XL
  // projectile round offered to a small autocannon, both group 83.
  if (fitment.size === null || chargeSize === null) {
    return null;
  }
  return fitment.size === chargeSize;
}
