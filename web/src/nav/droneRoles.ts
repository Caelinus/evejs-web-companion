// Which JOB a drone can do, from the game's own group name. The bot blocks read
// this so a Hobgoblin is never sent to salvage and a Salvage Drone never sent to
// fight — the live failure was "Salvage the wrecks" launching the whole bay and
// ordering every drone to salvage: the combat drones refused, the block waited
// on them forever, and a mixed bay put the wrong drones in the slots the
// salvage drones needed.
//
// The group is resolved through /api/names (`typeGroup`), the same
// resolve-then-judge pass the fitted-module classifiers make (R47): the game
// says what a type IS and this file only reads the answer. Anchored on purpose,
// like the tackle groups — a loose /drone/i would also take "Rogue Drone" rats
// and "Drone Damage Modules". Verified against the local SDE (`groups.jsonl`):
//
//   100  "Combat Drone"    — Hobgoblin, Warrior, Acolyte … (the `targetattack` drones)
//   1159 "Salvage Drone"   — Salvage Drone I/II (the `salvagedroneeffect` drones)
//   101  "Mining Drone"
//   640  "Logistic Drone"  — the repair drones, see below
//
// The remaining drone-category groups — 639 "Electronic Warfare Drone", 641
// "Stasis Webifying Drone", 544 "Energy Neutralizer Drone" — stay "other" on
// purpose, not by omission. Checked against the server on 2026-09-11:
// `D:\evet\server\src\services\drone\droneDogma.js` defines no effect at all
// for the webifier or neutralizer groups, so `commandEngage` refuses them with
// "That drone has no supported engage profile" (`droneRuntime.js:5009`). There
// is nothing here to route to — do not "fix" this by giving them a role and
// launching them, the server has no job for them to do.
//
// ⚠ Logistic drones DO have a server-side job — `assignDroneRepairTask` /
// `tickDroneRepair` in `droneRuntime.js`, reached through the same engage call
// as combat, just aimed at a friendly ship instead of a hostile one. But the
// friendliness gate, `isFriendlyRepairTarget` (`droneRuntime.js:3895`), tests
// character / owner / corporation / alliance and NEVER fleet membership. So a
// logistic drone can repair a same-corp or same-alliance ship, but it cannot
// repair an out-of-corp fleet-mate — that is a server limit, not a bug in this
// file, and a caller must not try to route around it here.

export type DroneRole = "combat" | "salvage" | "mining" | "logistic" | "other";

/**
 * The role for a resolved group name. `null` = the group has not resolved (or
 * could not be read) — cannot tell, so NO role: the caller must not launch it.
 */
export function droneRoleForGroup(groupName: string | null | undefined): DroneRole | null {
  if (groupName === null || groupName === undefined) {
    return null;
  }
  if (/^combat drone$/i.test(groupName)) {
    return "combat";
  }
  if (/^salvage drone$/i.test(groupName)) {
    return "salvage";
  }
  if (/^mining drone$/i.test(groupName)) {
    return "mining";
  }
  if (/^logistic drone$/i.test(groupName)) {
    return "logistic";
  }
  return "other";
}

/** Drone ids by the roles the blocks act on — the shape the observation carries. */
export interface DroneRoleIDs {
  readonly combat: readonly number[];
  readonly salvage: readonly number[];
  /**
   * ⚠ "Reachable" does not mean "unconditionally usable" — see the header
   * comment: `isFriendlyRepairTarget` never checks fleet membership, so these
   * drones cannot repair an out-of-corp fleet-mate even though the server
   * accepts the engage call. This list is still correct to hand a block that
   * only ever repairs same-corp ships; a fleet-repair block needs the server
   * fix first, not a workaround here.
   */
  readonly logistic: readonly number[];
  /**
   * Rows whose type or group could NOT be read — in no role, and worth naming
   * when a block reports "no salvage drones", so a name lookup that failed does
   * not read as an empty bay.
   */
  readonly unknown: readonly number[];
}

/**
 * Split rows (bay stacks or drones in space) into the roles the blocks act on.
 * A row whose type is unknown or whose group has not resolved lands in neither
 * list — never in a role it might not be able to do. Order is preserved.
 */
export function splitDroneRoles<T>(
  rows: readonly T[],
  typeIDOf: (row: T) => number | null,
  itemIDOf: (row: T) => number,
  groupOf: (typeID: number) => string | null,
): DroneRoleIDs {
  const combat: number[] = [];
  const salvage: number[] = [];
  const logistic: number[] = [];
  const unknown: number[] = [];
  for (const row of rows) {
    const typeID = typeIDOf(row);
    const role = droneRoleForGroup(typeID === null ? null : groupOf(typeID));
    if (role === "combat") {
      combat.push(itemIDOf(row));
    } else if (role === "salvage") {
      salvage.push(itemIDOf(row));
    } else if (role === "logistic") {
      logistic.push(itemIDOf(row));
    } else if (role === null) {
      unknown.push(itemIDOf(row));
    }
  }
  return { combat, salvage, logistic, unknown };
}
