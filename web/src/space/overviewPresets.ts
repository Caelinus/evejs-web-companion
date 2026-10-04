// OVERVIEW PRESETS (goal R79) — the retail client's overview tabs.
//
// A busy grid is a couple of hundred objects, and a pilot only ever wants a
// slice of it: rocks while mining, gates and stations while travelling, ships
// and wrecks while fighting. Retail solves this with a row of tabs across the
// top of the overview, and so does this.
//
// ---------------------------------------------------------------------------
// WHY PRESETS ARE DEFINED OVER `bracketRole`, NOT OVER `groupID`
//
// The obvious implementation is a list of group ids per preset. It is also the
// one that goes wrong: the ids are a server-side taxonomy this client is not the
// authority on, a preset written against them silently stops matching when the
// world data changes, and — worst — the tactical viewport already classifies
// every object through `bracketRole` for its colours. Two classifications would
// mean the picture and the list disagreeing about what a thing IS, so a rock
// could be drawn in the ore colour and filtered out of the Mining tab at the
// same time.
//
// So a preset is a set of ROLES, and `bracketRole` is the single classifier.
// Adding a role to the game means deciding once which presets it belongs to.
//
// ---------------------------------------------------------------------------
// ⚠ NO PRESET CAN HIDE SOMETHING THAT IS SHOOTING AT YOU
//
// Every preset includes hostiles, whatever else it selects. A filter is a
// convenience; a threat is not something a convenience may remove from the
// screen. This is the same rule `hostileRows` already enforces for the threat
// block (it deliberately ignores every filter and is never capped), applied to
// the tab row so the two cannot disagree.
//
// It is also the honest reading of what a preset is FOR. Someone who picks
// "Mining" is saying "show me the rocks", not "stop telling me about the
// frigate that just landed on me".

import type { SpaceEntity } from "../store/types.ts";
import { bracketRole, type TacticalRole } from "./tactical.ts";

export type OverviewPresetID = "all" | "mining" | "travel" | "combat";

export interface OverviewPreset {
  readonly id: OverviewPresetID;
  readonly label: string;
  /** What the tab is for, shown as its tooltip. */
  readonly hint: string;
  /**
   * The roles this preset shows, or null for "everything". Hostiles are added
   * on top of this set by `presetAllows` and never need listing.
   */
  readonly roles: ReadonlySet<TacticalRole> | null;
}

const set = (...roles: TacticalRole[]): ReadonlySet<TacticalRole> => new Set(roles);

/** The tabs, in the order they are drawn. */
export const OVERVIEW_PRESETS: readonly OverviewPreset[] = [
  {
    id: "all",
    label: "All",
    hint: "Everything on the grid.",
    roles: null,
  },
  {
    id: "mining",
    label: "Mining",
    hint: "Rocks, and the places to unload them.",
    // Stations because a full hold is the other half of a mining trip.
    roles: set("asteroid", "station", "drone"),
  },
  {
    id: "travel",
    label: "Travel",
    hint: "Gates, stations and celestials — the things you fly to.",
    roles: set("gate", "station", "celestial"),
  },
  {
    id: "combat",
    label: "Combat",
    hint: "Ships, drones and wrecks.",
    roles: set("ship", "police", "drone", "wreck"),
  },
];

export const DEFAULT_PRESET: OverviewPresetID = "all";

/** The preset for an id, falling back to All for anything unrecognised. */
export function presetByID(id: OverviewPresetID | string): OverviewPreset {
  return (
    OVERVIEW_PRESETS.find((preset) => preset.id === id) ??
    (OVERVIEW_PRESETS[0] as OverviewPreset)
  );
}

/**
 * Does this preset show this object?
 *
 * ⚠ THE HOSTILE CLAUSE IS FIRST AND UNCONDITIONAL. See the note at the top: a
 * preset is a convenience and a threat is not something a convenience removes.
 */
export function presetAllows(preset: OverviewPreset, entity: SpaceEntity): boolean {
  const role = bracketRole(entity);
  if (role === "hostile") {
    return true;
  }
  if (preset.roles === null) {
    return true;
  }
  return preset.roles.has(role);
}

/** Filter a list of objects through a preset, keeping their order. */
export function applyPreset<T extends SpaceEntity>(
  entities: readonly T[],
  preset: OverviewPreset,
): readonly T[] {
  if (preset.roles === null) {
    return entities;
  }
  return entities.filter((entity) => presetAllows(preset, entity));
}
