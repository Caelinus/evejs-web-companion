// Which ship on the grid can compress your ore, and whether you are close
// enough to it.
//
// ⚠ A COMPRESSION FACILITY IS A SHIP, NOT A STRUCTURE. It is a mining support
// hull — your own or a fleet-mate's — running an Industrial Core plus a
// compression module. That is why this reads the snapshot's entities rather
// than looking for a station.
//
// ⚠ AND THIS FILE EXISTS BECAUSE TWO CALLERS NEED THE SAME ANSWER. The
// `compress-ore` bot macro picks a facility to fly to; the Mining panel offers
// one to press. Two copies of the rule would not diverge loudly — they would
// diverge in the `?? null` branch, where an ABSENT reading (an older server, a
// row the gateway did not project) has to mean "not a facility" and never "an
// unknown worth trying". That is the branch a second copy gets wrong, and the
// cost is a player firing compress at a hull that was never going to answer.

import { distanceMeters } from "./overview.ts";
import type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";

/**
 * Ships on grid that are live compression facilities — OWN HULL FIRST.
 *
 * Own ship first is not cosmetic: there is no range problem to solve and no
 * fleet check to fail, so it is the candidate most likely to work.
 *
 * The three conditions, in order:
 *   1. the row is a SHIP
 *   2. it carries a compression reading (`?? null` — see the header)
 *   3. it is not an NPC
 */
export function compressionFacilities(
  snapshot: SpaceSnapshot | null,
): readonly SpaceEntity[] {
  if (snapshot === null) {
    return [];
  }
  const selfID = snapshot.ship?.itemID ?? null;
  const facilities = snapshot.entities.filter(
    (entity) =>
      entity.kind === "ship" &&
      (entity.compressionFacility ?? null) !== null &&
      entity.isNpc === false,
  );
  return [...facilities].sort((left, right) => {
    const leftSelf = left.itemID === selfID ? 0 : 1;
    const rightSelf = right.itemID === selfID ? 0 : 1;
    return leftSelf - rightSelf;
  });
}

/** The facility's own reach in metres — the number the SERVER checks. */
export function facilityReachMeters(facility: SpaceEntity | null): number {
  return facility?.compressionFacility?.rangeMeters ?? 0;
}

/** Metres from the ship to a facility, or null when either position is missing. */
export function facilityDistanceMeters(
  snapshot: SpaceSnapshot | null,
  facility: SpaceEntity | null,
): number | null {
  const from = snapshot?.ship?.position ?? null;
  if (!from || !facility) {
    return null;
  }
  return distanceMeters(from, facility.position);
}

/**
 * Why compressing against this facility would not work — or null when it would.
 *
 * ⚠ IT NEVER PRE-JUDGES WHAT THE SERVER OWNS. Only two things are decided here:
 * there is no facility at all, and the ship is measurably outside the
 * facility's own stated reach. Fleet membership, ore that has no compressed
 * form, a foreign item — those are the server's calls, and it refuses all of
 * them with one silence, so guessing which would put an invented cause on
 * screen next to a real refusal.
 *
 * ⚠ AN UNMEASURABLE DISTANCE IS NOT A REFUSAL. If we cannot work out how far
 * away it is, the control stays live and the server answers — the same rule
 * every other range decision in this client follows.
 */
export function compressionRefusal(
  snapshot: SpaceSnapshot | null,
  facility: SpaceEntity | null,
): string | null {
  if (facility === null) {
    return "No mining support ship on this grid is running its compression gear.";
  }
  const isOwnShip = facility.itemID === (snapshot?.ship?.itemID ?? null);
  if (isOwnShip) {
    return null;
  }
  const distance = facilityDistanceMeters(snapshot, facility);
  if (distance === null) {
    return null;
  }
  const reach = facilityReachMeters(facility);
  if (distance > reach) {
    return "Too far from that support ship — move closer to it.";
  }
  return null;
}
