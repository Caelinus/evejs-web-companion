// Names-everywhere name cache (goal R7c).
//
// Every UI tab used to show raw numeric IDs (typeIDs, corp/alliance/faction/
// character IDs, agent IDs, station/system IDs). This module is the shared
// vocabulary for turning those into names: the kinds the batch /api/names route
// understands, the key format the store slice is keyed by, and the pure
// `displayName` reader the Svelte components use (ID until the name arrives,
// then the name; the raw ID stays the fallback for a definitive "unknown").
//
// The resolution itself (batching, caching, no-refetch, no-block) lives in
// app/flow.ts (createNameCache) and pushes results into the store's `names`
// slice via the `names/resolved` feed event; components are pure readers.

/**
 * The entity kinds the batch resolver understands. Mirrors the server-side
 * resolveOneName switch (src/staticData.js). `owner` resolves an ID whose
 * entity type is unknown at the call site (a station owner or a standings
 * `fromID` — a corp, faction, character, or alliance) by trying each in turn.
 *
 * R38 — `structure` is a PLAYER-OWNED Upwell structure, the one kind that is
 * runtime data rather than static reference data. Callers that cannot tell a
 * structure from an NPC station do not need to: `station` resolves either, so
 * every existing caller picked up structure names without changing. Use
 * `structure` only where the call site genuinely knows.
 */
export type NameKind =
  | "type"
  | "typeGroup"
  | "typeCategory"
  /**
   * A typeID -> its PROPULSION effect name, or null for anything that is not an
   * afterburner/MWD. The one kind here that does not answer a display name: it
   * returns the server's own `moduleBonusAfterburner` /
   * `moduleBonusMicrowarpdrive`, which is never shown to a player.
   *
   * It is a name kind anyway because it is the same question in the same shape
   * — one typeID against the static tables, batched and cached per key — and
   * because the answer is needed in two places that would otherwise each invent
   * their own route: telling an afterburner from an MWD (SDE group 46 holds
   * both, so no group name can), and naming the effect a Deactivate must carry
   * for a prop mod to actually stop.
   */
  | "propulsionEffect"
  | "category"
  | "corporation"
  | "alliance"
  | "faction"
  | "character"
  | "agent"
  | "station"
  | "structure"
  | "system"
  | "region"
  | "owner";

/** One name request: resolve `id` as `kind`. */
export interface NameRef {
  readonly kind: NameKind;
  readonly id: number;
}

/**
 * The names slice: resolved names keyed by `${kind}:${id}`. A string is a
 * resolved name; null is a definitive "unknown" (cached so it is never
 * refetched); an absent key means "not resolved yet" (show the ID).
 */
export interface NamesState {
  readonly resolved: Readonly<Record<string, string | null>>;
}

/** The store-slice key for a (kind, id) pair. */
export function nameKey(kind: NameKind, id: number): string {
  return `${kind}:${id}`;
}

/**
 * The display string for an ID: the resolved name if the cache has one, else
 * the `fallback` (defaults to the raw ID as a string). A null/absent id yields
 * `fallback ?? "—"`. Pure — components call this while reading the `names`
 * slice, so they re-render when a name arrives.
 */
export function displayName(
  resolved: Readonly<Record<string, string | null>>,
  kind: NameKind,
  id: number | null | undefined,
  fallback?: string,
): string {
  if (id === null || id === undefined || !Number.isFinite(id) || id <= 0) {
    return fallback ?? "—";
  }
  const name = resolved[nameKey(kind, id)];
  return name ?? fallback ?? String(id);
}

/**
 * The resolved display name for an ID, or a NON-ID `fallback` (default "—") when
 * the name has not resolved yet or is a definitive "unknown". Unlike
 * `displayName`, this NEVER returns the raw numeric ID — the R7d rule that a
 * player never sees a game ID rendered as data. Use it for every rendered name
 * cell; the raw ID belongs only in interactive inputs, `{#each}` keys, and
 * onclick args. Pure — components call it while reading the `names` slice, so
 * they re-render when a name arrives.
 */
export function resolvedName(
  resolved: Readonly<Record<string, string | null>>,
  kind: NameKind,
  id: number | null | undefined,
  fallback = "—",
): string {
  if (id === null || id === undefined || !Number.isFinite(id) || id <= 0) {
    return fallback;
  }
  return resolved[nameKey(kind, id)] ?? fallback;
}
