import type { JsonValue } from "./wire.ts";

type Evidence = Record<string, JsonValue>;
interface ObservationDeps {
  read: (shipID: number) => Promise<Evidence>;
  current: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Extend only authoritative pending OFF; never dispatch another mutation. */
export async function observeDeferredShutdown(initial: Evidence, itemID: number, deps: ObservationDeps): Promise<Evidence> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const remaining = initial.remainingMs, shipID = initial.shipID;
  if (initial.itemID !== itemID || initial.stopped !== false ||
      typeof remaining !== "number" || !Number.isFinite(remaining) || remaining <= 0 || remaining > 305_000 ||
      typeof shipID !== "number" || !Number.isSafeInteger(shipID) || shipID <= 0) return initial;
  const deadline = now() + remaining;
  let result = initial;
  while (now() < deadline) {
    deps.current();
    await sleep(Math.min(1000, deadline - now()));
    deps.current();
    if (now() >= deadline) break;
    const fresh = await deps.read(shipID);
    deps.current();
    if (fresh.itemID !== itemID || fresh.shipID !== shipID) return { ...fresh, stopped: null };
    result = fresh;
    if (fresh.stopped !== false) return fresh;
  }
  return result;
}
