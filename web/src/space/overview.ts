// Overview view logic (goal R11) — pure, framework-free, fully testable.
//
// The server hands the browser positions; everything a player actually reads in
// an overview — how far away a thing is, what order the list is in, what is
// filtered out — is computed HERE, in the client. That is not a shortcut: it is
// how the retail client works. The server pushes ball state and the client
// re-derives distance and re-renders on its own cadence.
//
// Nothing in this module renders a numeric game ID (goal R7d). It carries IDs so
// the caller can key rows, resolve names, and issue a move; the strings it
// produces (`formatDistance`) are units, never identifiers.

import type { SpaceEntity, SpaceSnapshot, SpaceVector } from "../store/types.ts";

/** One astronomical unit in metres — the unit EVE distances read in at range. */
export const METRES_PER_AU = 149_597_870_700;

/** Straight-line distance between two points, in metres. */
export function distanceMeters(from: SpaceVector, to: SpaceVector): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * SURFACE distance between two objects, in metres: the gap between their hulls,
 * not between their centres.
 *
 *     max(0, centreToCentre - radiusA - radiusB)
 *
 * This is the measure the SERVER uses everywhere it asks "how far is that?"
 * (services/drone/droneRuntime.js computes it identically), and it is the
 * measure retail's autopilot decides jump / dock / approach / warp from. It
 * matters: a station's radius is kilometres, so centre-to-centre would have the
 * client believe it is far outside docking range while the server considers it
 * docked-close.
 */
export function surfaceDistanceMeters(
  from: SpaceVector,
  fromRadius: number,
  to: SpaceVector,
  toRadius: number,
): number {
  const centres = distanceMeters(from, to);
  const radii = (Number.isFinite(fromRadius) ? fromRadius : 0) + (Number.isFinite(toRadius) ? toRadius : 0);
  return Math.max(0, centres - radii);
}

/**
 * A distance as a player reads it: metres up close, kilometres in between,
 * AU once it is a warp away. Mirrors the retail overview's own thresholds.
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) {
    return "—";
  }
  if (meters >= METRES_PER_AU / 10) {
    return `${(meters / METRES_PER_AU).toFixed(1)} AU`;
  }
  if (meters >= 1_000) {
    const km = meters / 1_000;
    // ⚠ GROUPED once it is whole kilometres. A moon 12 million km out rendered
    // as `12040310 km` — eight unbroken digits, in the one column a pilot reads
    // by comparing figures down a list. Under 100 km the decimal is the
    // information and there is nothing to group.
    return `${km >= 100 ? Math.round(km).toLocaleString() : km.toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}

/** An overview row: a visible object plus the distance the client computed. */
export interface OverviewRow extends SpaceEntity {
  /** Distance from the player's ship, in metres. */
  readonly distance: number;
}

export type OverviewSort = "distance" | "name";

export interface OverviewFilter {
  /** Free-text match over the row's name / type name / group name. */
  readonly text?: string;
  /** Restrict to one category, or null for all. */
  readonly categoryID?: number | null;
  /** Restrict to one group, or null for all. */
  readonly groupID?: number | null;
}

/**
 * Names the caller has already resolved for a row, so text search can match what
 * the player actually SEES (a type or group name) rather than an id.
 */
export interface OverviewRowNames {
  readonly typeName?: string | null;
  readonly groupName?: string | null;
}

/** Look up the resolved names for one row (supplied by the component). */
export type OverviewNameLookup = (entity: SpaceEntity) => OverviewRowNames;

const NO_NAMES: OverviewRowNames = {};

function matchesText(
  entity: SpaceEntity,
  names: OverviewRowNames,
  needle: string,
): boolean {
  const haystack = [entity.name, names.typeName, names.groupName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Build the overview list: drop the player's own ship, apply the filters,
 * compute each remaining row's distance from the ship, and sort.
 *
 * `cap` bounds how many rows the caller renders — a busy grid can hold hundreds
 * of balls and the panel must stay responsive at a 1s cadence. The cap is
 * applied AFTER sorting, so capping always keeps the nearest objects.
 */
export function buildOverviewRows(
  snapshot: SpaceSnapshot | null,
  origin: SpaceVector,
  options: {
    readonly filter?: OverviewFilter;
    readonly sort?: OverviewSort;
    readonly cap?: number;
    readonly names?: OverviewNameLookup;
  } = {},
): { readonly rows: readonly OverviewRow[]; readonly matched: number } {
  if (!snapshot) {
    return { rows: [], matched: 0 };
  }
  const filter = options.filter ?? {};
  const lookup = options.names ?? (() => NO_NAMES);
  const needle = (filter.text ?? "").trim().toLowerCase();

  const matched: OverviewRow[] = [];
  for (const entity of snapshot.entities) {
    if (entity.isSelf) {
      continue;
    }
    if (
      filter.categoryID !== null &&
      filter.categoryID !== undefined &&
      entity.categoryID !== filter.categoryID
    ) {
      continue;
    }
    if (
      filter.groupID !== null &&
      filter.groupID !== undefined &&
      entity.groupID !== filter.groupID
    ) {
      continue;
    }
    if (needle.length > 0 && !matchesText(entity, lookup(entity), needle)) {
      continue;
    }
    matched.push({ ...entity, distance: distanceMeters(origin, entity.position) });
  }

  const sort = options.sort ?? "distance";
  matched.sort((left, right) => {
    if (sort === "name") {
      const byName = (left.name ?? "").localeCompare(right.name ?? "");
      if (byName !== 0) {
        return byName;
      }
    }
    // Distance is the tiebreaker for name sort and the primary key otherwise —
    // nearest first, as an overview always reads.
    return left.distance - right.distance;
  });

  const cap = options.cap;
  const rows =
    typeof cap === "number" && cap > 0 && matched.length > cap
      ? matched.slice(0, cap)
      : matched;
  return { rows, matched: matched.length };
}

/**
 * The distinct category / group ids present in a snapshot, so the panel can
 * offer only filters that would actually match something. Ids only — the
 * component resolves each to a NAME before rendering it (R7d).
 */
export function overviewFilterIDs(snapshot: SpaceSnapshot | null): {
  readonly categoryIDs: readonly number[];
  readonly groupIDs: readonly number[];
} {
  if (!snapshot) {
    return { categoryIDs: [], groupIDs: [] };
  }
  const categories = new Set<number>();
  const groups = new Set<number>();
  for (const entity of snapshot.entities) {
    if (entity.isSelf) {
      continue;
    }
    if (entity.categoryID !== null) {
      categories.add(entity.categoryID);
    }
    if (entity.groupID !== null) {
      groups.add(entity.groupID);
    }
  }
  return {
    categoryIDs: [...categories],
    groupIDs: [...groups],
  };
}

// --- R25 slice B: telling a pirate from a person -----------------------------
//
// ⚠ THE FINDING THIS SECTION EXISTS FOR: a belt rat is `kind: "ship"`. It is
// built through the same server-side entity path as the player parked next to
// you and carries the same name, position, health and velocity. `kind` cannot
// separate them, and neither could anything else the snapshot carried before
// R25 — which is why the gateway projects exactly two new fields, `isNpc` and
// `npcEntityType`, and why the whole of this client's threat logic reads them
// and nothing else.
//
// ⚠ AND THE TRAP THAT LOOKS LIKE A SHORTCUT: `characterID === 0` would ALMOST
// work. Structures and corp-owned balls also carry characterID 0, so a panel
// built on it flags harmless furniture as a threat — and a threat warning that
// cries wolf gets ignored, which is worse than not having one.

/**
 * Is this row something that will SHOOT AT YOU?
 *
 * True only for a ship the runtime says nobody is flying, of a kind that
 * attacks: "npc" (pirates, and the belt rats a miner actually meets) and
 * "drifter". Deliberately NOT "concord" — law enforcement is an NPC that does
 * not attack a miner, and painting it red would make the colour meaningless.
 *
 * An NPC ship whose kind we could not read is treated as hostile: for a warning
 * whose job is to keep a miner alive, an unknown NPC is the case you want to be
 * wrong about in the loud direction.
 */
export function isHostile(entity: SpaceEntity): boolean {
  if (!entity.isNpc || entity.isSelf) {
    return false;
  }
  return entity.npcEntityType !== "concord";
}

/**
 * What a player should CALL this row (R9a: plain player language, never
 * "NPC entity kind"). Returns null for anything that is not an NPC, so a
 * caller renders no badge at all rather than an empty one.
 */
export function hostileLabel(entity: SpaceEntity): string | null {
  if (!entity.isNpc) {
    return null;
  }
  switch (entity.npcEntityType) {
    case "concord":
      return "Police";
    case "drifter":
      return "Drifter";
    default:
      return "Pirate";
  }
}

/** Is this drone row one of MINE — owned by me, or flown by my hull? */
export function isMyDrone(
  entity: SpaceEntity,
  myCharacterID: number | null,
  myShipID: number | null,
): boolean {
  if (entity.kind !== "drone") {
    return false;
  }
  if (myCharacterID !== null && entity.ownerID === myCharacterID) {
    return true;
  }
  return myShipID !== null && entity.controllerID === myShipID;
}

/**
 * Can my ship give this drone ORDERS? (goal R33)
 *
 * ⚠ DELIBERATELY NARROWER THAN `isMyDrone`, AND THE GAP BETWEEN THE TWO IS THE
 * WHOLE OF R33. `isMyDrone` is the LISTING rule — owner OR controller — and the
 * BFF's `readDronesInSpace` uses the same disjunction to decide what appears in
 * the Drones panel. This is the CONTROL rule, and eve.js applies exactly one
 * test for it: `droneRuntime.js` refuses every drone order
 * (`commandReturnDrones`, `commandEngage`, `commandMineRepeatedly`,
 * `commandSalvage`, `commandAbandonDrone`) unless
 * `droneEntity.controllerID === shipRecord.itemID`.
 *
 * So a drone you OWN but no longer CONTROL is listed and cannot be ordered.
 * That is not hypothetical: an abandoned `Ice Harvesting Drone II`
 * (`controllerID: null`) in Perimeter II - Asteroid Belt 1 was recalled live,
 * answered 200, and did not move for 20 s. The server's reason was sitting in
 * the call RESULT dict, which the BFF drops — so nothing ever reached the
 * player. This predicate is what lets the control say so up front.
 *
 * ⚠ NOTE IT COMPARES AGAINST THE HULL, NOT AGAINST NULL. "Abandoned" is only
 * the commonest way to fail this; a drone under ANOTHER ship's control fails it
 * too, and a `controllerID !== null` test would wave that one through.
 *
 * `null` means WE CANNOT TELL — the snapshot carries no row for this drone, or
 * we do not know our own hull's id. A null must leave the control ENABLED, so
 * the server can give the real answer; guessing here would be the exact failure
 * this function exists to fix, pointed the other way.
 */
export function canMyShipOrderDrone(
  entity: SpaceEntity | null | undefined,
  myShipID: number | null,
): boolean | null {
  if (!entity || entity.kind !== "drone" || myShipID === null) {
    return null;
  }
  return entity.controllerID === myShipID;
}

/**
 * The hostiles in a snapshot, nearest first.
 *
 * Separate from `buildOverviewRows` on purpose: the overview is a filtered,
 * capped, sortable list, and a threat must NOT be something a player can filter
 * away or push off the bottom of a hundred-row cap. This reads the whole
 * snapshot every time, ignores every filter, and is never capped.
 */
export function hostileRows(
  snapshot: SpaceSnapshot | null,
  origin: SpaceVector,
): readonly OverviewRow[] {
  if (!snapshot) {
    return [];
  }
  return snapshot.entities
    .filter((entity) => isHostile(entity))
    .map((entity) => ({ ...entity, distance: distanceMeters(origin, entity.position) }))
    .sort((left, right) => left.distance - right.distance);
}

/**
 * Which hostiles are NEW since the last look — the ones worth interrupting the
 * player for ("A pirate has arrived").
 *
 * Pure and caller-driven: the caller owns the "seen" set, so this never holds
 * state across a dock, a session change, or a panel remount. `seen` being EMPTY
 * on the very first poll would otherwise announce every rat already in the belt
 * as an arrival, so the caller is expected to prime it from the first snapshot;
 * that is documented at the call site rather than guessed at here.
 */
export function newlyArrivedHostiles(
  hostiles: readonly OverviewRow[],
  seen: ReadonlySet<number>,
): readonly OverviewRow[] {
  return hostiles.filter((row) => !seen.has(row.itemID));
}

/**
 * Is the ship's shield/armor/hull dropping fast enough to be worth shouting
 * about?
 *
 * The honest, sourceable version of "you are under attack", and still the one
 * this function computes: what two consecutive HUD readings show, a health
 * layer that went down. `null` for either reading means unknown, and unknown is
 * never reported as damage.
 *
 * ⚠ CORRECTED IN R29. This comment used to claim the client has no damage log
 * to read and that no such server read exists. The second half is still true —
 * there is no CALL that returns a damage history — but the first half was
 * wrong: `OnDamageMessage` is PUSHED, in both directions, and R29 measured it
 * live (16 frames from a rat shooting an idle ship, plus our own hits on the
 * way back). The store keeps a bounded tail of it in `targeting.damageLog`.
 *
 * That log does NOT replace this function, and this function is not built on
 * it. The push channel is lossy by design, so a quiet log is not evidence of a
 * quiet fight; two health readings are. The log says what we were TOLD about,
 * this says what the ship's own numbers DID. Keep them independent.
 */
export function healthIsDropping(
  previous: { readonly shieldRatio: number | null; readonly armorRatio: number | null; readonly hullRatio: number | null } | null,
  current: { readonly shieldRatio: number | null; readonly armorRatio: number | null; readonly hullRatio: number | null } | null,
): boolean {
  if (!previous || !current) {
    return false;
  }
  const dropped = (before: number | null, after: number | null): boolean =>
    before !== null && after !== null && after < before;
  return (
    dropped(previous.shieldRatio, current.shieldRatio) ||
    dropped(previous.armorRatio, current.armorRatio) ||
    dropped(previous.hullRatio, current.hullRatio)
  );
}

/**
 * A health/capacitor ratio as a whole percentage for a labelled bar, or null
 * when the ship has no such layer to report.
 */
export function ratioPercent(ratio: number | null | undefined): number | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return null;
  }
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}
