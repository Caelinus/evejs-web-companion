// Fleet Center's small interpretation layer over the authoritative bound-fleet
// read and the existing live notification channel. It deliberately keeps the
// three player-relevant states separate:
//   • ready          — GetInitState named a real fleet;
//   • not-in-fleet   — every bound read explicitly answered FleetNotFound;
//   • unavailable    — the read failed or was partial in any other way.
// A null fleetID alone is not enough to call somebody fleetless: the cached
// session field is allowed to be stale, and a transport failure also decodes to
// empty values.

import { decodeBoundFleet, type BoundFleet, type BoundFleetResult } from "./boundFleet.ts";
import { unwrapLong, type JsonValue } from "./wire.ts";
// ⚠ A VALUE IMPORT INTO A MODULE THAT IMPORTS US BACK, and it is safe because
// the edge going the other way is TYPE-ONLY (`import type { FleetCenterSnapshot }`)
// and is erased before it can become a runtime cycle. Kept this way round
// because `isFleetCommander` is the single mirrored copy of the server's own
// commander gate, and a second copy here is precisely what must not happen.
import { isFleetCommander } from "./fleetCommand.ts";

export type FleetAvailability = "ready" | "not-in-fleet" | "unavailable";

export interface FleetCenterSnapshot {
  readonly availability: FleetAvailability;
  readonly fleet: BoundFleet;
}

export interface FleetPendingInvite {
  readonly fleetID: number;
  readonly inviterID: number | null;
  readonly receivedAtMs: number;
}

function readCells(fleet: BoundFleet): readonly BoundFleetResult<unknown>[] {
  return [fleet.initState, fleet.wings, fleet.motd, fleet.joinRequests, fleet.composition];
}

function positiveFleetID(value: number | string | null): boolean {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
  }
  return false;
}

/** Classify one decoded read without turning an error-shaped empty into fleetless. */
export function fleetAvailability(fleet: BoundFleet): FleetAvailability {
  if (
    fleet.initState.error === null &&
    positiveFleetID(fleet.initState.value.fleetID)
  ) {
    return "ready";
  }
  if (
    !positiveFleetID(fleet.initState.value.fleetID) &&
    readCells(fleet).every(
      (read) => read.error === "CALL_REFUSED" && read.message === "FleetNotFound",
    )
  ) {
    return "not-in-fleet";
  }
  return "unavailable";
}

/** Decode and classify GET /api/bridge/bound-fleet. */
export function decodeFleetCenter(
  raw: JsonValue | null | undefined,
): FleetCenterSnapshot {
  const fleet = decodeBoundFleet(raw);
  return { availability: fleetAvailability(fleet), fleet };
}

/**
 * Character IDs that a bot may treat as fleet-mates for remote assistance.
 * `null` means the roster could not be established and callers must wait; an
 * empty array is the authoritative not-in-fleet answer. Never fall back to the
 * cached session fleet id or to "every player ship on grid".
 */
export function authoritativeFleetMemberCharacterIDs(
  snapshot: FleetCenterSnapshot,
): readonly number[] | null {
  if (snapshot.availability === "unavailable") {
    return null;
  }
  if (snapshot.availability === "not-in-fleet") {
    return Object.freeze([]);
  }
  const ids = new Set<number>();
  for (const member of snapshot.fleet.initState.value.members) {
    const characterID = positiveSafeID(member.charID);
    if (characterID !== null) {
      ids.add(characterID);
    }
  }
  return Object.freeze([...ids]);
}

/**
 * The character ids the roster says are COMMANDERS — fleet creator, boss, wing
 * commander or squad commander.
 *
 * ⚠ THE SAME TEST `canTagInFleet` APPLIES TO ONE ROW, APPLIED TO ALL OF THEM.
 * `isFleetCommander` is the single definition of "commander" in this client, and
 * it is mirrored from the server's own gate. Two questions are answered from it:
 * "may I tag" (one row, this pilot) and "whose chat orders do I obey" (every
 * row). Inventing a second idea of authority for the second question is exactly
 * how the two would drift.
 *
 * ⚠ `null` IS "COULD NOT READ THE ROSTER" AND MUST NOT COLLAPSE TO EMPTY. A
 * companion takes chat orders from this list and from nobody else, so an
 * unreadable roster has to mean "obey nobody" rather than "obey anybody" — and
 * an empty array is a real, different answer: a fleet with no commander in it.
 *
 * Ids that do not decode to a safe positive integer are dropped, the same rule
 * `authoritativeFleetMemberCharacterIDs` above applies, because an id we cannot
 * represent exactly is one we cannot compare a chat sender against.
 */
export function fleetCommanderCharacterIDs(
  snapshot: FleetCenterSnapshot,
): readonly number[] | null {
  if (snapshot.availability === "unavailable") {
    return null;
  }
  if (snapshot.availability === "not-in-fleet") {
    return Object.freeze([]);
  }
  const ids = new Set<number>();
  for (const member of snapshot.fleet.initState.value.members) {
    if (!isFleetCommander(member)) {
      continue;
    }
    const characterID = positiveSafeID(member.charID);
    if (characterID !== null) {
      ids.add(characterID);
    }
  }
  return Object.freeze([...ids]);
}

function positiveSafeID(value: unknown): number | null {
  const unwrapped = unwrapLong(value);
  if (
    unwrapped !== null &&
    unwrapped > 0n &&
    unwrapped <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(unwrapped);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  }
  return null;
}

/**
 * Read the existing OnFleetInvite popup payload:
 *   [fleetID, inviterCharacterID, "AskJoinFleet", inviteData]
 * Only the two IDs needed for the dedicated accept route and a resolved display
 * name are retained. No popup internals reach the Fleet Center UI.
 */
export function decodeFleetInviteNotification(
  method: string | null,
  args: readonly unknown[],
  receivedAtMs: number,
): FleetPendingInvite | null {
  if (method !== "OnFleetInvite") {
    return null;
  }
  const fleetID = positiveSafeID(args[0]);
  if (fleetID === null) {
    return null;
  }
  return {
    fleetID,
    inviterID: positiveSafeID(args[1]),
    receivedAtMs: Number.isFinite(receivedAtMs) && receivedAtMs > 0 ? receivedAtMs : Date.now(),
  };
}
