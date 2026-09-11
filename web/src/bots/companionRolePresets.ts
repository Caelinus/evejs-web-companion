// Fleet companion — what picking a ROLE fills in.
//
// `FleetCompanionRole`'s own header promises the role "picks the defaults a UI
// offers - it does NOT gate behaviour by itself". Until this module that
// promise was unfulfilled: the panel's role picker changed a label and nothing
// else, and no decision rung reads `request.role` at all (grep it — the field
// appears only in type declarations, the default, and the readout).
//
// ⚠ THIS TABLE IS DELIBERATELY NARROW, AND THE EXCLUSIONS ARE THE POINT.
// A preset that filled in everything would look more useful and be worse. Each
// field below was read at its consuming rung before being ruled in or out, and
// the reason is recorded here so a later phase widens the table on purpose
// rather than by eye.
//
// ─── WHAT IS PRESET ─────────────────────────────────────────────────────────
//
// `fleeHealthFloor` ONLY. It is the one field that is genuinely per-pilot, has
// no cross-pilot constraint, costs nothing to set, and plausibly differs by
// what a pilot is for. `decideFlee` compares it against the worst of the three
// layers, and `wellEnoughToReturn` reads it again plus FLEE_RETURN_MARGIN, so
// it sets both when a pilot leaves and how whole it comes back.
//
// ⚠ THE NUMBERS BELOW ARE A JUDGEMENT, NOT A MEASUREMENT, and they are the
// only part of this module that is. Nothing in the repo or on the server
// recommends a per-role threshold — the shipped defaults are role-agnostic and
// say so. They are starting points an operator is expected to tune, which is
// exactly what a "default a UI offers" is meant to be.
//
// ─── WHAT IS NOT PRESET, AND WHY ────────────────────────────────────────────
//
// `attemptsTagging` — ⚠ NEVER. Its own field comment: "ONLY ONE PILOT PER
//   SQUAD SHOULD SET THIS. A tag is unique fleet-wide, so two taggers fight
//   over letters and the fleet stops trusting them." A role cannot know how
//   many of itself are in the squad, so a preset turning this on for `tackle`
//   would manufacture that exact letter-fight the moment a squad held two
//   tacklers. Uniqueness is enforceable at the SQUAD layer, where the other
//   members are visible; it is not enforceable here.
//
// `repairsAtStation` — ⚠ NEVER. It spends the operator's ISK and they decided
//   it is opt-in, default off. A preset turning it on for any role would
//   quietly reverse a decision that was made deliberately.
//
// `capacitorFloor` — NOT role-shaped. It is REPAIR_CAP_FLOOR, reused from
//   `scriptDecide.ts` precisely so there is one answer to "when is a capacitor
//   too empty to repair" rather than two. Overriding it per role would trade a
//   grounded constant for a guess. (It gates the SELF repairers only; it does
//   not gate hardeners, drones, or the remote reps — so raising it for a logi
//   would not buy that logi anything.)
//
// `maxFleeAttempts` — NOT role-shaped. Its default of 3 comes from
//   MAX_RECOVER_TRIPS and MAX_ESCAPE_ATTEMPTS, and MAX_FLEE_ATTEMPTS (10) is
//   explicitly documented as a panel ceiling rather than a recommendation.
//
// `useDrones`, `droneHealthFloor`, `droneRedeployHoldOffSeconds` — NOT preset.
//   The two floors are DEAD unless `useDrones` is true: `decideDrones` returns
//   on `!request.useDrones` as its first line, before either is read. And
//   turning `useDrones` on is not free even for a ship with no drone bay — the
//   drone-bay listing in `makeFleetCompanionDeps` is gated on exactly this
//   flag, so a preset that switched it on would buy a round trip per tick, per
//   pilot, for an answer no rung could use.
//
// `obeys` — NOT preset, and this one is the closest call. A logi's remote reps
//   genuinely REQUIRE "broadcast": `decideFleetOrders` gates the whole Heal
//   family on `request.obeys.includes("broadcast")`, so a pilot whose operator
//   narrowed `obeys` to ["tag"] has remote-rep modules that can never fire.
//   That is worth telling the operator — but the value is IDENTICAL for all
//   four roles, so putting it here would differentiate nothing and could only
//   ever destroy a deliberate narrowing. It is surfaced as a warning in the
//   panel instead, where it can say what is wrong rather than silently undo it.
//
// Every module-id list — NEVER. They are the operator's own pick of a
//   particular hull's fit, and the panel repeats "nothing is ticked for you"
//   over each one because a wrong guess cycles the wrong module.

import {
  DEFAULT_FLEET_COMPANION_REQUEST,
  type FleetCompanionRequest,
  type FleetCompanionRole,
} from "../nav/fleetCompanionLoop.ts";

/**
 * The request fields a role preset is allowed to touch.
 *
 * ⚠ THIS IS A FENCE, NOT A CONVENIENCE. The guard test asserts that no preset
 * carries a key outside this list, so widening the table means widening this
 * constant — a deliberate act with the reasoning above to argue against.
 */
export const COMPANION_PRESET_KEYS = ["fleeHealthFloor"] as const;

export type CompanionPresetKey = (typeof COMPANION_PRESET_KEYS)[number];

/** What picking a role fills in. A partial view of the request, by design. */
export type CompanionRolePreset = Pick<FleetCompanionRequest, CompanionPresetKey>;

/**
 * Per-role starting points.
 *
 * ⚠ `dps` MUST EQUAL THE SHIPPED DEFAULT. `DEFAULT_FLEET_COMPANION_REQUEST.role`
 * is "dps", so any other value here would make the default request disagree
 * with the preset for its own role — a form that changed the moment you touched
 * a picker without choosing anything different. The guard test pins it.
 */
export const COMPANION_ROLE_PRESETS: Readonly<Record<FleetCompanionRole, CompanionRolePreset>> =
  Object.freeze({
    // The shipped default, unchanged. See the note above.
    dps: Object.freeze({ fleeHealthFloor: DEFAULT_FLEET_COMPANION_REQUEST.fleeHealthFloor }),
    // Leaves earlier than it would if it were shooting: a logi that dies stops
    // being worth anything to the fleet, and everything it was repairing loses
    // its reps at once. Judgement, not measurement.
    logi: Object.freeze({ fleeHealthFloor: 0.45 }),
    // Holds on longer than the rest, because leaving is what a tackler is there
    // not to do. Judgement, not measurement.
    tackle: Object.freeze({ fleeHealthFloor: 0.2 }),
    // Between the two: it is not the one being shot at, but it is not replacing
    // its own losses either. Judgement, not measurement.
    support: Object.freeze({ fleeHealthFloor: 0.4 }),
  });

/** The starting point for one role. Total over the role union by construction. */
export function presetForRole(role: FleetCompanionRole): CompanionRolePreset {
  return COMPANION_ROLE_PRESETS[role];
}

/**
 * Whether this pilot's remote-repair modules can ever fire.
 *
 * ⚠ NOT A PRESET, AND THAT IS DELIBERATE — see the `obeys` note in the header.
 * `decideFleetOrders` gates the entire Heal family on `obeys` carrying
 * "broadcast", so remote-rep modules on a pilot that does not listen to
 * broadcasts are equipment that can never be used. The panel warns; nothing
 * here changes the setting under the operator.
 *
 * Answers false ONLY when there is something real to warn about: modules are
 * fitted for the job AND the channel that would ask for them is off.
 */
export function remoteRepairsCanFire(
  request: Pick<
    FleetCompanionRequest,
    "obeys" | "remoteShieldModuleIDs" | "remoteArmorModuleIDs" | "remoteCapacitorModuleIDs"
  >,
): boolean {
  const fitted =
    request.remoteShieldModuleIDs.length > 0 ||
    request.remoteArmorModuleIDs.length > 0 ||
    request.remoteCapacitorModuleIDs.length > 0;
  return !fitted || request.obeys.includes("broadcast");
}
