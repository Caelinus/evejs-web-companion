import type { FittingSlot } from "../store/types.ts";

/** Shared fit identity used by script caching and read-only capability snapshots. */
export function describeFitting(shipID: number | null, slots: readonly FittingSlot[]): string {
  return [String(shipID ?? "none"), ...slots.map(slot => slot.module === null
    ? `${slot.family}:${slot.index}:empty`
    : [slot.family, slot.index, slot.module.itemID, slot.module.typeID, slot.module.online ? 1 : 0].join(":"))].join("|");
}

/** The two facts that make fitted-module capabilities safe to reuse. */
export interface CapabilityScope {
  /** The authoritative active hull observed this tick. */
  readonly shipID: number | null;
  /** A stable description of the fitting slice that produced the module ids. */
  readonly fittingSignature: string;
}

export interface LoadedCapabilities<T> {
  readonly value: T;
  readonly scope: CapabilityScope;
}

export interface CapabilityCache<T> {
  /** Reuse only when both the hull and fit still match; otherwise reload. */
  read(scope: CapabilityScope): Promise<T>;
  /** A refit/board action invalidates the cache before the next observation. */
  invalidate(): void;
  peek(): T;
}

function sameScope(left: CapabilityScope, right: CapabilityScope): boolean {
  return left.shipID === right.shipID && left.fittingSignature === right.fittingSignature;
}

/**
 * Tiny async cache used by the custom runner. It deliberately owns no fitting
 * logic; the flow supplies a loader, which keeps this race/invalidation policy
 * pure and directly testable.
 */
export function createCapabilityCache<T>(
  initial: LoadedCapabilities<T>,
  load: (requested: CapabilityScope) => Promise<LoadedCapabilities<T>>,
): CapabilityCache<T> {
  let current = initial;
  let dirty = false;

  return {
    async read(scope) {
      if (dirty || !sameScope(current.scope, scope)) {
        current = await load(scope);
        dirty = false;
      }
      return current.value;
    },
    invalidate() {
      dirty = true;
    },
    peek() {
      return current.value;
    },
  };
}
