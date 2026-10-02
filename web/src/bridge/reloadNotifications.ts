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

import { isListValue, unwrapLong } from "./wire.ts";

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
