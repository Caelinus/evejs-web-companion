// The in-space HUD module rack: the ship's high / mid / low slots, EVE's three
// activation racks. Pure model, kept out of the .svelte file so the grouping +
// activation logic is unit-testable. It reads the SAME fitting slots the Fitting
// window uses (bridge/fitting.ts) and overlays which modules are currently
// cycling from the live space snapshot's activeModuleIDs — so a module the
// server reports active glows, and one the fit says is offline reads dimmed.
//
// Only high/mid/low: EVE's HUD activation rack never holds rigs or subsystems
// (they are passive), so they stay in the Fitting window, not the rack.

import { slotsOfFamily } from "../bridge/fitting.ts";
import type { FittingSlot, ModuleCycle } from "../store/types.ts";

export type RackFamily = "high" | "mid" | "low";
export const RACK_FAMILIES: readonly RackFamily[] = ["high", "mid", "low"];
export const RACK_LABELS: Readonly<Record<RackFamily, string>> = {
  high: "High",
  mid: "Mid",
  low: "Low",
};

export interface RackModule {
  /** The module's own itemID — what every activation verb addresses. */
  readonly itemID: number;
  readonly typeID: number;
  /** The fit reports it online (vs. fitted-but-offline). */
  readonly online: boolean;
  /** The live snapshot reports it currently cycling. */
  readonly active: boolean;
  /** The charge loaded in it, or null. A weapon with none cannot fire. */
  readonly charge: { readonly typeID: number; readonly quantity: number } | null;
  /**
   * The server reports it OVERLOADED — running hot, and taking damage for it.
   * `null` is "we could not tell", which the rack shows as no marker rather
   * than as a cool module.
   */
  readonly overloaded: boolean | null;
  /**
   * How damaged it is, 0..1 — 1 being burnt out and unusable. `null` is "we
   * could not read the fit", NOT "undamaged"; 0 is the real "intact".
   */
  readonly damage: number | null;
  /**
   * The BANK MASTER this module fires through, or null when it is not banked.
   *
   * ⚠ A BANKED SLAVE NEVER LIGHTS ON ITS OWN. The server redirects a slave's
   * activation to its master and then reports only the MASTER as cycling, so a
   * rack that ignored banks would show a tile that stays dark however many
   * times it is clicked. `active` below already accounts for this: a slave is
   * shown as active when its master is.
   */
  readonly bankMasterID: number | null;
  /** True when this module IS a master with at least one slave banked to it. */
  readonly bankMaster: boolean;
  /** How many weapons fire together when this one does (1 when unbanked). */
  readonly bankSize: number;
}

export interface RackSlotVM {
  readonly module: RackModule | null;
}

export interface RackRow {
  readonly family: RackFamily;
  readonly label: string;
  readonly slots: readonly RackSlotVM[];
  /**
   * ⚠ HOW HOT THIS RACK IS RUNNING, 0..1 — AND IT IS ALWAYS `null` TODAY.
   *
   * There is no heat model anywhere in this client: not in the store, not in
   * the bridge, not on the BFF. Greps for heatState / heatLevel / rackHeat /
   * heatCapacity / heatAttenuation across web/src and src/server.js find
   * nothing. The in-space handoff draws a per-rack heat bar, so the bar is
   * built and wired — to this, which reads UNKNOWN until a real reading
   * arrives (a separate piece of work).
   *
   * ⚠ IT MUST NEVER BE FILLED IN FROM MODULE DAMAGE. Damage is what heat DID;
   * it is not how hot the rack is now, and averaging it into this field would
   * put a fabricated reading on a gauge a pilot uses to decide whether to keep
   * overloading. Unknown renders as "not known" over a flat track — never 0,
   * because an empty bar reads as "cold".
   */
  readonly heat: number | null;
}

/**
 * Build the three racks from the fitting slots + the snapshot's active module
 * itemIDs. A null/absent activeModuleIDs (no snapshot yet) means nothing glows —
 * never a guess.
 */
export function buildModuleRack(
  slots: readonly FittingSlot[],
  activeModuleIDs: readonly number[] | null | undefined,
  overloadedModuleIDs: readonly number[] | null | undefined = null,
  moduleDamage: Readonly<Record<number, number>> | null | undefined = null,
  weaponBanks: Readonly<Record<number, readonly number[]>> | null | undefined = null,
  /**
   * ⚠ HOW HOT EACH RACK IS RUNNING, and nothing passes it yet — see RackRow.heat.
   * It is a parameter rather than a hardcoded null so the day a heat reading
   * exists, wiring it up is one call site and no UI change at all.
   */
  rackHeat: Readonly<Partial<Record<RackFamily, number>>> | null | undefined = null,
): readonly RackRow[] {
  const active = new Set(activeModuleIDs ?? []);
  // null/absent stays UNKNOWN rather than collapsing to "nothing is hot".
  const overloadKnown = Array.isArray(overloadedModuleIDs);
  const overloaded = new Set(overloadedModuleIDs ?? []);
  // Same rule for damage: a missing map is unknown, not "everything is intact".
  const damageKnown = typeof moduleDamage === "object" && moduleDamage !== null;
  // slaveID -> masterID, and masterID -> how many guns fire together.
  const masterOf = new Map<number, number>();
  const bankSizeOf = new Map<number, number>();
  if (typeof weaponBanks === "object" && weaponBanks !== null) {
    for (const [masterKey, slaves] of Object.entries(weaponBanks)) {
      const masterID = Number(masterKey);
      const members = Array.isArray(slaves) ? slaves : [];
      bankSizeOf.set(masterID, members.length + 1);
      for (const slaveID of members) {
        masterOf.set(slaveID, masterID);
      }
    }
  }
  return RACK_FAMILIES.map((family) => ({
    family,
    label: RACK_LABELS[family],
    heat: rackHeat?.[family] ?? null,
    slots: slotsOfFamily(slots, family).map((slot) => ({
      module: slot.module
        ? {
            itemID: slot.module.itemID,
            typeID: slot.module.typeID,
            online: slot.module.online,
            // A BANKED SLAVE IS ACTIVE WHEN ITS MASTER IS: the server fires
            // the group through the master and reports only the master, so
            // reading the slave's own id would leave the tile permanently dark.
            active:
              active.has(slot.module.itemID) ||
              (masterOf.has(slot.module.itemID) &&
                active.has(masterOf.get(slot.module.itemID)!)),
            charge: slot.module.charge
              ? { typeID: slot.module.charge.typeID, quantity: slot.module.charge.quantity }
              : null,
            overloaded: overloadKnown ? overloaded.has(slot.module.itemID) : null,
            // Absent from the map means intact (0), because only damaged
            // modules are listed; an absent MAP means unknown (null).
            damage: damageKnown ? moduleDamage[slot.module.itemID] ?? 0 : null,
            bankMasterID: masterOf.get(slot.module.itemID) ?? null,
            bankMaster: bankSizeOf.has(slot.module.itemID),
            bankSize:
              bankSizeOf.get(slot.module.itemID) ??
              (masterOf.has(slot.module.itemID)
                ? bankSizeOf.get(masterOf.get(slot.module.itemID)!) ?? 1
                : 1),
          }
        : null,
    })),
  }));
}

/** What one click on a rack module means right now. */
export type RackClickAction = "activate" | "deactivate" | null;

/**
 * How long a press has to be held before it overloads, in milliseconds.
 *
 * ⚠ OVERLOADING IS BEHIND A DELIBERATE SECOND GESTURE, and always has been —
 * it was shift-click before this. Overloading damages the module, so it must
 * not share the plain click that fires it. A hold is the better guard of the
 * two because it works on a touch screen, which shift-click never did, and
 * because the ring that fills during it says what is about to happen.
 */
export const OVERLOAD_HOLD_MS = 600;

export type RackHoldAction = "overload" | "stopOverload" | null;

/**
 * What holding a slot down would do, or null when it would do nothing.
 *
 * ⚠ AN UNKNOWN OVERLOAD STATE IS NOT "COOL". `overloaded: null` means the
 * server did not tell us, so there is no honest toggle to offer: the hold does
 * nothing rather than guessing which way to flip it. An OFFLINE module is inert
 * here for the same reason it is inert to a click.
 */
export function rackHoldAction(module: RackModule | null): RackHoldAction {
  if (!module || !module.online || module.overloaded === null) {
    return null;
  }
  return module.overloaded ? "stopOverload" : "overload";
}

/**
 * The size of a slot's heat-damage wedge, in the 42-unit slot box — or 0 when
 * there is no damage to draw.
 *
 * ⚠ `null` DAMAGE DRAWS NOTHING, and that is not the same as 0. "We could not
 * read the fit" and "this module is intact" must not look alike, so an unread
 * fit gets no wedge rather than an empty one.
 */
export function rackDamageWedge(module: RackModule | null): number {
  if (!module || module.damage === null || module.damage <= 0) {
    return 0;
  }
  return 6 + Math.min(1, module.damage) * 10;
}

/** Which of the three damage bands a wedge is in. Null when there is no wedge. */
export function rackDamageBand(module: RackModule | null): "warm" | "hot" | "burning" | null {
  if (!module || module.damage === null || module.damage <= 0) {
    return null;
  }
  if (module.damage < 0.3) return "warm";
  if (module.damage < 0.6) return "hot";
  return "burning";
}

/**
 * The click decision, kept out of the component so it is testable: an ACTIVE
 * module deactivates, an idle one activates, an OFFLINE one does nothing at all
 * — onlining is a fitting decision (it needs cap and CPU headroom the rack
 * cannot show), so the rack refuses to bury it under a misclick.
 */
export function rackClickAction(module: RackModule | null): RackClickAction {
  if (!module || !module.online) {
    return null;
  }
  return module.active ? "deactivate" : "activate";
}

/**
 * Whether a module is BURNT OUT — damaged to the point the server will not run
 * it (runtime.js isModuleIncapacitated: damage >= 1).
 *
 * Only a definite 1 counts. `null` damage is unknown and must not be reported
 * as a burnt-out module, which would be a scarier lie than saying nothing.
 */
export function rackModuleBurntOut(module: RackModule | null): boolean {
  return module !== null && module.damage !== null && module.damage >= 1;
}

/** A damage ratio as a whole-percent string, or null when there is none to show. */
export function rackDamageText(module: RackModule | null): string | null {
  if (!module || module.damage === null || module.damage <= 0) {
    return null;
  }
  return `${Math.round(module.damage * 100)}%`;
}

/**
 * The hover/readout line for a rack slot — also the accessible label. Always
 * the module's NAME plus what a click would do (or why it would do nothing),
 * never a bare state word: the rack tiles are pictures, so this line is the
 * only place the module says what it is.
 */
export function rackSlotTitle(
  name: string,
  module: RackModule | null,
  /** The loaded charge's NAME, when the module has one. Never an id (R7d). */
  chargeName: string | null = null,
): string {
  if (!module) {
    return "Empty slot";
  }
  // What is loaded, appended to whatever the module's own state is: a gun that
  // is out of ammunition looks identical to a loaded one on a picture tile.
  const loaded =
    module.charge && chargeName
      ? ` Loaded: ${(module.charge.quantity > 0 ? module.charge.quantity : 1).toLocaleString()} ${chargeName}.`
      : "";
  // Damage first when it is total: a burnt-out module cannot be switched on at
  // all, so leading with "click to switch on" would be an invitation to fail.
  const damageText = rackDamageText(module);
  if (rackModuleBurntOut(module)) {
    return `${name} — BURNT OUT. Repair it with nanite paste before it will run again.${loaded}`;
  }
  const wear = damageText ? ` Damaged: ${damageText}.` : "";
  // Banked guns fire together, so a click on ANY of them fires all of them —
  // the tile has to say so or the group firing reads as a bug.
  const banked =
    module.bankSize > 1
      ? ` Banked: fires with ${module.bankSize - 1} other${module.bankSize === 2 ? "" : "s"}.`
      : "";
  if (!module.online) {
    return `${name} — offline (bring it online from the Fitting window)${loaded}${wear}`;
  }
  // Overloading is destructive, so the tile SAYS it is running hot rather than
  // relying on a colour, and names the gesture that toggles it.
  //
  // ⚠ "HOLD", NOT "SHIFT-CLICK". The gesture changed with the in-space
  // redesign because shift-click does not exist on a touch screen, and this
  // panel has a touch tier — see OVERLOAD_HOLD_MS. The words have to move with
  // it: a tooltip naming a modifier the player cannot press is worse than none.
  const heat =
    module.overloaded === true
      ? " Overloaded — running hot and taking damage. Hold to stop."
      : module.overloaded === false
        ? " Hold to overload."
        : "";
  return module.active
    ? `${name} — active. Click to switch off.${loaded}${banked}${wear}${heat}`
    : `${name} — click to switch on.${loaded}${banked}${wear}${heat}`;
}

/** True when there are no slots at all — the fit is not known yet. */
export function rackIsEmpty(rows: readonly RackRow[]): boolean {
  return rows.every((row) => row.slots.length === 0);
}

/**
 * How far through its current cycle a module is, 0-100 — or null when we cannot
 * honestly say.
 *
 * ⚠ NULL IS NOT ZERO. It covers both "no cycle event has ever told us when this
 * started" and "the module is not running", and neither may render as an empty
 * bar: an empty bar reads as "just started", which is a claim we do not have.
 *
 * A repeating module runs cycle after cycle off its one start event, which is
 * what the retail client does with it too. The clock is the BROWSER's, matched
 * to the start stamp the cycle carries — see ModuleCycle, which is deliberately
 * local-clock for exactly this reason.
 */
export function cycleProgressPercent(
  cycle: ModuleCycle | null | undefined,
  nowMs: number,
): number | null {
  if (!cycle || cycle.startedAtMs === null || !(cycle.durationMs > 0)) {
    return null;
  }
  const elapsed = nowMs - cycle.startedAtMs;
  if (elapsed < 0) {
    return null;
  }
  const within = cycle.repeating
    ? elapsed % cycle.durationMs
    : Math.min(elapsed, cycle.durationMs);
  return Math.max(0, Math.min(100, Math.round((within / cycle.durationMs) * 100)));
}

/**
 * Which band a RACK HEAT reading is in — the colour the bar and its number take.
 *
 * ⚠ THE THRESHOLDS ARE THE HANDOFF'S: cool below 30%, warm below 60%, hot above.
 * They are not `rackDamageBand`'s, and the two must not be merged: damage is the
 * scar heat leaves behind and heat is what is in the rack now, so a module can
 * be badly scarred in a cold rack and an undamaged one can be about to burn.
 *
 * `null` is "not known" and has no band — the bar draws its track and nothing
 * else. It must never fall through to the cool colour, which would read as a
 * cold rack.
 */
export function rackHeatBand(heat: number | null): "cool" | "warm" | "hot" | null {
  if (heat === null) {
    return null;
  }
  if (heat < 0.3) return "cool";
  if (heat < 0.6) return "warm";
  return "hot";
}

/**
 * The words under a rack's heat bar.
 *
 * ⚠ IT ALWAYS CONTAINS THE WORD "heat", because in the design the bar has no
 * other label — the rack's NAME is above it and the reading is below, and
 * nothing else says what the bar measures. So the unknown case is "heat not
 * known" rather than a bare dash, which would leave a nameless empty bar.
 */
export function rackHeatText(heat: number | null): string {
  return heat === null ? "heat not known" : `${Math.round(heat * 100)}% heat`;
}
