// `OnChargeBeingLoadedToModule` — the server saying a reload has started.
//
// Wire shape (dogmaService.js `_notifyChargeBeingLoadedToModule`, the same
// three positional args the retail client gets):
//
//   [ list of module itemIDs, chargeTypeID or null, reload time in ms ]
//
// In space the server QUEUES a load for the module's reload time instead of
// moving the charges in the call, and this push is the only word that it did.
// It arrives in the LoadAmmo response's own drained notifications, so it is
// already in the store by the time the call returns.

import { isListValue, unwrapLong, unwrapReal } from "./wire.ts";
import { slotFlagOf } from "./fitting.ts";
import type { FittingSlot } from "../store/types.ts";

export interface ChargeLoadEvent {
  readonly moduleIDs: readonly number[];
  readonly chargeTypeID: number | null;
  readonly durationMs: number;
}

function positiveID(value: unknown): number | null {
  const unwrapped = unwrapLong(value);
  return unwrapped !== null && unwrapped > 0n && unwrapped <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(unwrapped)
    : null;
}

export function decodeChargeLoadNotification(
  method: string | null,
  args: readonly unknown[],
): ChargeLoadEvent | null {
  if (method !== "OnChargeBeingLoadedToModule") {
    return null;
  }
  const rawList = isListValue(args[0]) ? args[0].items : Array.isArray(args[0]) ? args[0] : [];
  const moduleIDs = rawList.map(positiveID).filter((id): id is number => id !== null);
  const duration = Number(unwrapLong(args[2]) ?? Number.NaN);
  if (moduleIDs.length === 0 || !(duration > 0)) {
    return null;
  }
  return { moduleIDs, chargeTypeID: positiveID(args[1]), durationMs: duration };
}

// `OnModuleAttributeChanges` carrying a loaded charge's QUANTITY — the round
// count going down as a gun fires.
//
// Wire shape (attributeChangeNotification.js `buildAttributeChange`, sent per
// shot by loadedChargeState.js `notifyChargeQuantityChangeToSession`):
//
//   [ list of [ "OnModuleAttributeChange", charID, itemID, attributeID,
//               time, newValue, oldValue, time ] ]
//
// where a loaded charge's itemID is the (shipID, slot flagID, chargeTypeID)
// tuple and attribute 805 is quantity. Nothing else in the client re-reads the
// fit while guns are firing, so without this the rack's counts froze at the
// last reload.

const ATTRIBUTE_QUANTITY = 805;

export interface ChargeQuantityChange {
  readonly shipID: number;
  readonly flagID: number;
  readonly chargeTypeID: number;
  readonly quantity: number;
}

function itemsOf(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items)
  ) {
    return (value as { items: unknown[] }).items;
  }
  return null;
}

export function decodeChargeQuantityChanges(
  method: string | null,
  args: readonly unknown[],
): readonly ChargeQuantityChange[] {
  if (method !== "OnModuleAttributeChanges") {
    return [];
  }
  const changes: ChargeQuantityChange[] = [];
  for (const entry of itemsOf(args[0]) ?? []) {
    const change = itemsOf(entry);
    if (!change || change[0] !== "OnModuleAttributeChange" || Number(unwrapLong(change[3])) !== ATTRIBUTE_QUANTITY) {
      continue;
    }
    // Only the charge tuple: a quantity change on a real item id is some
    // other stack, not the rounds in a gun.
    const tuple = itemsOf(change[2]);
    if (!tuple || tuple.length !== 3) {
      continue;
    }
    const [shipID, flagID, chargeTypeID] = tuple.map(positiveID);
    const quantity = unwrapReal(change[5]) ?? Number(unwrapLong(change[5]) ?? Number.NaN);
    if (shipID === null || flagID === null || chargeTypeID === null || !Number.isFinite(quantity) || quantity < 0) {
      continue;
    }
    changes.push({ shipID: shipID!, flagID: flagID!, chargeTypeID: chargeTypeID!, quantity: Math.trunc(quantity) });
  }
  return changes;
}

/**
 * The fit's slots with those round counts applied, or the SAME array when
 * nothing changed (so a push about another ship costs no redraw).
 *
 * A count of 0 empties the gun. A count for a type the slot does not hold is a
 * charge that has just gone in, and is recorded as loaded. A change for
 * another ship, or a slot with no module, is ignored.
 */
export function applyChargeQuantityChanges(
  slots: readonly FittingSlot[],
  activeShipID: number | null,
  changes: readonly ChargeQuantityChange[],
): readonly FittingSlot[] {
  let next: FittingSlot[] | null = null;
  for (const change of changes) {
    if (activeShipID === null || change.shipID !== activeShipID) {
      continue;
    }
    const current = next ?? slots;
    const at = current.findIndex((slot) => slotFlagOf(slot.family, slot.index) === change.flagID);
    const slot = at >= 0 ? current[at]! : null;
    if (!slot?.module) {
      continue;
    }
    const held = slot.module.charge;
    let charge = held;
    if (change.quantity === 0) {
      // Only empty the gun of the type that ran out: a swap sends the old
      // type to 0 and the new one up, in either order.
      charge = held && held.typeID === change.chargeTypeID ? null : held;
    } else if (!held || held.typeID !== change.chargeTypeID || held.quantity !== change.quantity) {
      charge = {
        itemID: [change.shipID, change.flagID, change.chargeTypeID],
        typeID: change.chargeTypeID,
        quantity: change.quantity,
      };
    }
    if (charge === held) {
      continue;
    }
    next ??= [...slots];
    next[at] = { ...slot, module: { ...slot.module, charge } };
  }
  return next ?? slots;
}
