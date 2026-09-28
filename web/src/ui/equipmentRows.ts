// The equipment list's model — the ship's activatable modules as rows, and the
// two questions about each one that must never be collapsed into one.
//
// ⚠ POWERED UP AND RUNNING ARE DIFFERENT QUESTIONS. A module has to be ONLINE
// before it can run at all; a module that is online may be idle or cycling.
// Collapsing them gives you a single "off" that covers both, and a player who
// presses Switch on against an offline module is refused by the server for a
// reason the panel could have told them.
//
// ⚠ AND `null` RUNNING IS "NOT KNOWN", NEVER "IDLE". `activeModuleIDs` absent
// means the server did not tell us what is cycling. Rendering that as Idle
// invites a second activation on a module that is already running.
//
// Pure, so both of those rules are testable without a DOM.

import type { FittingSlot, ModuleCycle } from "../store/types.ts";

export interface EquipmentRow {
  readonly itemID: number;
  /** The module's type — Switch off threads it so a prop mod's effect resolves. */
  readonly typeID: number;
  readonly label: string;
  /**
   * R47 — the game's GROUP name for the module, or null until it resolves.
   * Read by anything that asks "is this a mining laser": the group is the
   * game's own answer. `null` is "cannot tell", never "no".
   */
  readonly group: string | null;
  readonly slotLabel: string;
  /** Whether the module is POWERED UP. See the header. */
  readonly online: boolean;
  /** Whether it is CYCLING. `null` is "the server did not say". */
  readonly running: boolean | null;
  /** How long one cycle takes, and where that figure came from. */
  readonly cycle: ModuleCycle | null;
}

/** How a slot family reads to a player. Never a flag id (R7d). */
export function slotLabelFor(family: FittingSlot["family"]): string {
  return family === "high" ? "High slot" : family === "mid" ? "Mid slot" : "Low slot";
}

/**
 * The ship's activatable modules, in fitting order.
 *
 * Rigs and subsystems are never activated, so they are left out entirely — a
 * row with no control on it is a row that only makes the list longer.
 *
 * ⚠ AN OFFLINE MODULE IS LISTED, and that is the whole point of this list
 * existing in space. It used to be skipped, and the panel told the player to go
 * to the Fitting window for the one click that powers it up — which is a window
 * that does not exist in space.
 */
export function equipmentRows(
  slots: readonly FittingSlot[],
  activeModuleIDs: readonly number[] | null,
  /** The name cache's answer per typeID: `[displayName, groupName | null]`. */
  nameOf: (typeID: number) => readonly [string, string | null],
  cycles: Readonly<Record<number, ModuleCycle>>,
): readonly EquipmentRow[] {
  const rows: EquipmentRow[] = [];
  for (const slot of slots) {
    if (slot.family === "rig" || slot.family === "subsystem" || !slot.module) {
      continue;
    }
    const online = slot.module.online;
    const [label, group] = nameOf(slot.module.typeID);
    rows.push({
      itemID: slot.module.itemID,
      typeID: slot.module.typeID,
      label,
      group,
      slotLabel: slotLabelFor(slot.family),
      online,
      // A module that is not powered up cannot be running. That is a FACT, not
      // a guess, so it does not go through the unknown branch — "Not known"
      // stays reserved for the case where the server genuinely did not say.
      running: !online
        ? false
        : activeModuleIDs === null
          ? null
          : activeModuleIDs.includes(slot.module.itemID),
      cycle: cycles[slot.module.itemID] ?? null,
    });
  }
  return rows;
}

/** How the Running column reads. One of exactly four answers. */
export function runningText(row: EquipmentRow): string {
  if (!row.online) {
    return "Not powered up";
  }
  if (row.running === null) {
    return "Not known";
  }
  return row.running ? "Running" : "Idle";
}

/**
 * A cycle length as a player reads it, or "" when there is none to show.
 *
 * ⚠ NEVER A FABRICATED NUMBER. A module we hold no figure for gets an empty
 * string and the panel prints "Not known" — an invented cycle time is a number
 * a player would plan around.
 */
export function cycleLengthLabel(cycle: ModuleCycle | null): string {
  if (!cycle || !(cycle.durationMs > 0)) {
    return "";
  }
  const seconds = cycle.durationMs / 1000;
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}

/**
 * Whether a cycle figure is the equipment's own starting number rather than
 * this pilot's.
 *
 * The row SAYS "before skills" when it is, rather than quietly passing off a
 * figure that will not match what the ship actually does.
 */
export function cycleIsBaseFigure(cycle: ModuleCycle | null): boolean {
  return cycle?.source === "base";
}

/** The sentinel values the target picker uses. Not ids — see `targetChoice`. */
export const AUTO_TARGET = "";
export const NO_TARGET = "none";

/**
 * Which target a module is switched on AGAINST, resolved from the picker.
 *
 * ⚠ THE DEFAULT IS AUTO, AND THAT IS NOT AN ARBITRARY CHOICE. Locking something
 * MAKES it the thing your equipment acts on — that is what a player expects and
 * what retail does. Defaulting to "no target" meant a player could lock a rock,
 * press Switch on, and be refused "You need an active target" while staring at
 * the rock they had just locked.
 *
 * ⚠ AND A STALE PICK FALLS BACK TO AUTO rather than being sent. An id that is
 * no longer locked is a target the server would refuse, and refusing it here
 * with the player's own lock sitting right there would be the panel inventing
 * a failure.
 *
 * Returns 0 for "no target" — the explicit opt-out, for equipment that acts on
 * the ship itself.
 */
export function targetChoice(pick: string, lockedIDs: readonly number[]): number {
  if (pick === NO_TARGET) {
    return 0;
  }
  if (pick !== AUTO_TARGET) {
    const chosen = Number(pick);
    if (chosen > 0 && lockedIDs.includes(chosen)) {
      return chosen;
    }
  }
  return lockedIDs.length > 0 ? (lockedIDs[0] as number) : 0;
}
