// Client-side gate: "may THIS pilot set a fleet target tag?"
//
// WHY THIS HAS TO LIVE HERE: the server's own gate
// (fleetRuntime.js:setFleetTargetTag, read at fleetRuntime.js:1310-1326) DOES
// check commander-ness and returns a plain `false` when the writer is not
// allowed. But its only caller, beyonceService.js's
// Handle_CmdFleetTagTarget (beyonceService.js:3314-3322), throws that boolean
// away and unconditionally `return null`s. The HTTP/RPC response a client
// sees is therefore byte-identical whether the tag landed or was silently
// dropped — nothing downstream of the call can ever tell the two apart. The
// only place left to ask "will this write actually do anything" is before
// the call, off the roster the client already has. That is this module.
//
// The constants below are mirrored from fleetConstants.js (verified there,
// not taken on trust — see the ⚠ on FLEET_JOB_CREATOR) and the gate itself
// mirrors fleetRuntime.js's `setFleetTargetTag`, De Morgan'd from its
// early-return-false form into an early-return-allow form. Kept in its own
// module, pure, no `flow.ts`/store/I-O — same shape as fleetBroadcasts.ts.

import type { FleetCenterSnapshot } from "./fleetCenter.ts";
import type { FleetMember } from "./boundFleet.ts";

// --- constants, mirrored from the server --------------------------------

/**
 * fleetConstants.js:4 — `FLEET_JOB_CREATOR: 2`.
 *
 * ⚠ THE TRAP: `FLEET_JOB_SCOUT` is ALSO 1 (fleetConstants.js:3), and
 * `FLEET_ROLE_LEADER` is ALSO 1 (fleetConstants.js:5) — two different enums
 * that both happen to start at 1. `job` and `role` are unrelated fields on a
 * member record (see FleetMember in boundFleet.ts): `job` is a bitmask of
 * fleet-administrative capabilities (none/scout/creator), `role` is the
 * fleet-hierarchy seat (leader/wing-cmdr/squad-cmdr/member). If
 * FLEET_JOB_CREATOR were ever "simplified" to 1, scouts (job=1) would gain
 * tagging and the actual fleet creator (job=2) would lose it. A previous
 * draft of this module got exactly this wrong, twice. Do not touch this
 * value without re-reading fleetConstants.js:1-9.
 */
export const FLEET_JOB_CREATOR = 2;

/**
 * fleetConstants.js:9 — `FLEET_CMDR_ROLES: Object.freeze([1, 2, 3])`, i.e.
 * FLEET_ROLE_LEADER, FLEET_ROLE_WING_COMMANDER, FLEET_ROLE_SQUAD_COMMANDER
 * (fleetConstants.js:5-7). FLEET_ROLE_MEMBER (4, fleetConstants.js:8) is
 * deliberately absent — a plain member is not a commander.
 */
export const FLEET_CMDR_ROLES: readonly number[] = [1, 2, 3];

// --- the gate itself, mirrored from the server ---------------------------

/**
 * Whether one fleet member row is allowed to set a fleet target tag, per
 * the server's own gate (fleetRuntime.js:1317-1326):
 *
 *   const member = getMemberRecord(fleet, characterID);
 *   if (
 *     !member ||
 *     (
 *       (member.job & FLEET.FLEET_JOB_CREATOR) === 0 &&
 *       !FLEET.FLEET_CMDR_ROLES.includes(toInteger(member.role, 0))
 *     )
 *   ) {
 *     return false;
 *   }
 *
 * De Morgan'd into an ALLOW condition (the member-exists check is handled
 * by the caller, which has a whole snapshot to reason about — see
 * `canTagInFleet` below):
 *
 *   (member.job & FLEET_JOB_CREATOR) !== 0 || FLEET_CMDR_ROLES.includes(member.role)
 *
 * ⚠ `job` is a BITMASK, tested with `&`, never with `===`. A member can
 * hold multiple job bits at once (FLEET_JOB_NONE=0, FLEET_JOB_SCOUT=1,
 * FLEET_JOB_CREATOR=2 — bit 0 and bit 1), so `member.job === FLEET_JOB_CREATOR`
 * would silently miss a creator who also carries the scout bit.
 */
export function isFleetCommander(member: FleetMember): boolean {
  return (member.job & FLEET_JOB_CREATOR) !== 0 || FLEET_CMDR_ROLES.includes(member.role);
}

// --- the three-state snapshot-level answer --------------------------------

/**
 * Whether THIS character may set a fleet target tag right now — three
 * states, not two, because "do not write" is answered for two entirely
 * different reasons that a caller must not conflate:
 *
 *   - roster UNREADABLE (`availability === "unavailable"`, or no snapshot
 *     at all) -> `null`. The client could not look. This is not evidence of
 *     anything; guessing "no" here would be exactly the kind of silent,
 *     unaccountable failure this module exists to prevent (see the header).
 *   - `availability === "not-in-fleet"` -> `false`. A looked-at, settled
 *     answer: you cannot tag a fleet you are not in, full stop.
 *   - in a fleet, but this character's own row is NOT in the roster ->
 *     `null`. That is an inconsistent read (a member should always see
 *     itself in its own fleet's roster), not evidence of non-command —
 *     treating it as `false` would be guessing again.
 *   - own row found -> `isFleetCommander(row)`, i.e. `true`/`false`.
 *
 * ⚠ `null` and `false` both mean "do not write" to an immediate caller, but
 * only `false` is a PERMANENT, safe-to-remember answer — `null` means "ask
 * again once the roster is readable". A caller that collapses the two (for
 * example caching `!!canTagInFleet(...)` across reads) would freeze a
 * transient outage into a standing "not a commander". That collapse is
 * exactly the bug class this module's three-state return exists to rule
 * out.
 */
export function canTagInFleet(
  snapshot: FleetCenterSnapshot | null | undefined,
  characterID: number,
): boolean | null {
  if (!snapshot || snapshot.availability === "unavailable") {
    return null;
  }
  if (snapshot.availability === "not-in-fleet") {
    return false;
  }
  const member = snapshot.fleet.initState.value.members.find((row) =>
    charIDMatches(row.charID, characterID),
  );
  if (!member) {
    return null;
  }
  return isFleetCommander(member);
}

/**
 * Compares a roster row's `charID` (boundFleet.ts's `idData`: a Number when
 * safe, else an exact decimal string — R7d, ids are data and are never
 * silently truncated) against a plain `characterID` Number, the shape the
 * rest of this codebase already passes an own/target character id in (see
 * `flow.ts`'s `inviteFleetMember(characterID: number)` and
 * `fleetCenter.ts`'s `BoundFleet.characterID: number | null`). Compared as
 * decimal strings rather than with `===` so a `charID` that decoded to its
 * string form (only possible above Number.MAX_SAFE_INTEGER, never observed
 * for a real character id, but boundFleet.ts does not rule it out) still
 * matches instead of silently failing to find the caller's own row.
 */
function charIDMatches(charID: number | string | null, characterID: number): boolean {
  return charID !== null && String(charID) === String(characterID);
}
