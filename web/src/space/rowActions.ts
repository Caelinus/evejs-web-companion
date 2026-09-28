// What you can do to the thing you picked (goal R30 slice D) — pure,
// framework-free, fully testable.
//
// WHY THIS EXISTS. Every verb in the overview used to live in a `.row-actions`
// block rendered once per row: up to nine buttons times up to 200 rows,
// re-rendered every poll. That is where the operator's complaint actually bites
// — the grid was so wide with controls that the names and distances a player is
// reading got squeezed, and on a phone each row became a stack of nine
// full-width buttons you had to scroll past to reach the next row.
//
// So the row went back to being a row, and the verbs moved to ONE bar that acts
// on the thing you selected. The set of verbs is decided HERE rather than in
// markup, for the reason `space/overview.ts` and `space/gateLinks.ts` already
// established: a decision written as an `{#if}` in a template can only be
// checked by a regex over that template, and a regex over markup proves nothing
// about the decision. This returns DATA, so the claim "a station offers Dock and
// a rock does not" is a thing a test can read directly.
//
// Three rules it does not bend:
//   - Nothing here produces a numeric game ID for display (R7d).
//   - An action that cannot be used right now is still RETURNED, carrying the
//     sentence that says why (R9a). The bar renders it disabled with that
//     sentence on it. Dropping it silently would leave a player wondering where
//     a button went; leaving it enabled would promise something we cannot do.
//   - It is GENERIC by construction. There is no branch on "is this a rock" for
//     the flight verbs — a rock, a wreck, a station and another player's ship
//     all get Warp to / Approach / Orbit / Keep at range / Align to / Lock,
//     because the server treats them the same way and so should this.

import type { GateLink } from "./gateLinks.ts";
import { jumpBlockedReason, jumpLabel } from "./gateLinks.ts";

/**
 * The per-concern busy channel an action belongs to.
 *
 * ⚠ This is the type the panel's busy SET is keyed on, and it is a set for one
 * reason: a single shared busy flag greys out Stop in the middle of a fight
 * because a lock request happened to be pending. An action may only ever be
 * disabled by its OWN concern being in flight.
 */
export type ActionConcern = "move" | "lock" | "module" | "drone" | "hold" | "route";

export type RowActionID =
  | "warp"
  | "approach"
  | "orbit"
  | "keepAtRange"
  | "align"
  | "dock"
  | "jump"
  | "lock"
  | "unlock"
  | "mine"
  | "loot"
  | "haul";

/** One verb offered for the selected thing. */
export interface RowAction {
  readonly id: RowActionID;
  /** What the button says. Never contains an id (R7d). */
  readonly label: string;
  readonly concern: ActionConcern;
  /**
   * null = usable. A sentence = the honest reason it is not, rendered ON the
   * disabled control rather than left as a silent grey rectangle.
   */
  readonly unavailable: string | null;
}

/** Everything the decision needs, and nothing it does not. */
export interface RowActionContext {
  /** The server's own runtime kind for the ball ("asteroid", "station", …). */
  readonly kind: string | null;
  readonly locked: boolean;
  readonly acquiring: boolean;
  /** The gate link for this row, or null when it is not a stargate. */
  readonly gateLink: GateLink | null;
  /**
   * R30 slice E — how many switched-on modules the player's own equipment list
   * reads as mining gear. 0 does not remove "Mine this"; it gives it a reason.
   */
  readonly minerCount?: number;
}

/**
 * Is this something you can dock at?
 *
 * Decided from the server's own runtime kind for the ball — never guessed from
 * its name, its distance or its category number.
 */
export function isDockableKind(kind: string | null): boolean {
  return kind === "station" || kind === "structure";
}

/**
 * Is this something you can reach into and take out of?
 *
 * ⚠ THE SERVER'S OWN RUNTIME KIND, exactly as `isDockableKind` reads it and
 * for the same reason. A wreck and a jettisoned can are the two things the
 * runtime models as an inventory sitting in space, and it says which is which
 * itself. The loot BLOCKS already filter on precisely these two strings
 * (`nav/scriptMacros.ts` — `wrecksOnGrid`, `containersOnGrid`), so the verb a
 * player presses and the bot that does it unattended agree about what can be
 * opened, without either of them guessing from a name or a group number.
 *
 * ⚠ AND RANGE IS NOT PART OF IT. Retail will not open a can past 2,500 m, but
 * that rule is the gateway's and the gateway states its own refusal — which is
 * exactly what the loot blocks learned ("the gateway's own range check beats our
 * arithmetic", `scriptMacros.ts`). A distance test here would put a rule this
 * side guessed at on screen beside the real one, so the verb is offered from any
 * distance and the server answers for itself.
 */
export function isLootableKind(kind: string | null): boolean {
  return kind === "wreck" || kind === "container";
}

/**
 * The verbs for the selected row, in the order they are drawn.
 *
 * Movement first (it is what a player reaches for most), then the verbs that
 * are specific to what the thing IS, then locking. A gate's Jump and a
 * station's Dock sit next to each other because from the player's side they are
 * the same idea: leave here, using that.
 */
export function actionsForRow(ctx: RowActionContext): readonly RowAction[] {
  const actions: RowAction[] = [
    { id: "warp", label: "Warp to", concern: "move", unavailable: null },
    { id: "approach", label: "Approach", concern: "move", unavailable: null },
    { id: "orbit", label: "Orbit", concern: "move", unavailable: null },
    { id: "keepAtRange", label: "Keep at range", concern: "move", unavailable: null },
    { id: "align", label: "Align to", concern: "move", unavailable: null },
  ];

  // R24 slice B — Dock, and mean it: the ladder that closes the distance itself
  // rather than the raw single command that fails unless you are already there.
  if (isDockableKind(ctx.kind)) {
    actions.push({ id: "dock", label: "Dock", concern: "move", unavailable: null });
  }

  // R30 slice A — Jump, on the gate, naming where it goes. Offered from ANY
  // distance on purpose: the server owns the range rule and states its own
  // refusal, and inventing a distance test here would put a guessed rule on
  // screen beside the real one. The one case genuinely blocked is a graph edge
  // with no gate on the far side — there is nothing honest to send.
  if (ctx.gateLink) {
    actions.push({
      id: "jump",
      label: jumpLabel(ctx.gateLink),
      concern: "move",
      unavailable: jumpBlockedReason(ctx.gateLink),
    });
  }

  // TAKE EVERYTHING — the verb this bar simply did not have.
  //
  // A wreck could be warped to, approached, locked and salvaged from here, and
  // the one thing a player could not do with it was take what was INSIDE. The
  // only route to a wreck's or a can's contents was writing a custom bot with a
  // loot-wrecks / loot-containers block, because `StationPanel.svelte`'s "open
  // this crate" is docked-only and nothing in space offered it at all.
  //
  // Offered on the two kinds the runtime models as an inventory in space, and
  // never carrying a reason this side invented — see `isLootableKind`.
  if (isLootableKind(ctx.kind)) {
    actions.push({ id: "loot", label: "Take everything", concern: "hold", unavailable: null });
  }

  // R30 slice E — "Mine this", the verb that made the Mining tab's own
  // instructions to go somewhere else untrue.
  //
  // Deliberately NOT restricted to `kind === "asteroid"`. What can be mined is
  // the server's call, and a browser that pre-filtered on the runtime kind
  // would refuse ice and gas it has never been told about. Both reasons it can
  // be unusable are the SERVER'S OWN rules restated, not invented ones: a
  // module needs a lock before it will run on something, and there has to be
  // mining equipment switched on for there to be anything to run.
  //
  // R49 — NO DEPLETION GATE. Whether a rock is empty is the server's to decide,
  // and it decides it by REMOVING the rock from the grid when it is mined out. A
  // rock the client can still see is a rock to mine, so the verb never carries a
  // "no ore left" reason the client guessed at (the "Ore left" column still shows
  // the survey scan for the player to read; that is a readout, not a gate). The
  // two reasons that remain are the SERVER's own rules restated: a module needs a
  // lock before it runs, and there must be mining equipment switched on to run.
  actions.push({
    id: "mine",
    label: "Mine this",
    concern: "module",
    unavailable:
      (ctx.minerCount ?? 0) <= 0
        ? "No mining equipment is switched on — power some up under Your equipment"
        : !ctx.locked
          ? "Lock it first — your equipment needs a fix on it before it will run"
          : null,
  });

  // R23 — lock / release. GENERIC: the same button a combat goal uses, for the
  // same reason. Locking is not instant, so the middle state is shown honestly
  // rather than pretending the lock has landed.
  if (ctx.locked) {
    actions.push({ id: "unlock", label: "Release lock", concern: "lock", unavailable: null });
  } else if (ctx.acquiring) {
    actions.push({ id: "unlock", label: "Locking… stop", concern: "lock", unavailable: null });
  } else {
    actions.push({ id: "lock", label: "Lock", concern: "lock", unavailable: null });
  }

  return actions;
}

/**
 * What the bar says it is acting on, or why it is not acting on anything.
 *
 * ⚠ SELECTION NEVER SILENTLY RETARGETS. When the thing you picked leaves the
 * snapshot — it was mined out, it warped off, you jumped — the bar must not
 * quietly slide its verbs onto whatever row happens to be first now. The player
 * would press Warp to expecting one destination and get another. So a selection
 * that is no longer in the snapshot is CLEARED, and the bar says so in words.
 */
export const SELECTION_GONE = "That is no longer around your ship.";

// --- R30 slice E: the ship's own verbs ---------------------------------------

/** What "Haul now" needs to know, and nothing more. */
export interface ShipActionContext {
  /** The nearest station or structure on this grid, by NAME, or null. */
  readonly nearestStationName: string | null;
  /** Docked? Then hauling is just the unload, with nowhere to fly first. */
  readonly docked: boolean;
  /** Is there anything in the holds to move? */
  readonly hasCargo: boolean;
}

/**
 * "Haul now": take what you have mined to a station and unload it.
 *
 * ⚠ IT IS ALWAYS RETURNED, and every reason it cannot run right now is a
 * SENTENCE on the disabled control — never a missing button and never a silent
 * grey rectangle. A player who has just filled a hold and cannot find the haul
 * verb has no way to tell whether the app forgot it or decided against it, and
 * "there is no station on this grid" and "your holds are empty" are different
 * facts that a player acts on differently.
 *
 * It names the station it would fly to, so pressing it is never a surprise.
 */
export function shipActions(ctx: ShipActionContext): readonly RowAction[] {
  let label = "Haul now";
  let unavailable: string | null = null;
  if (!ctx.hasCargo) {
    unavailable = "There is nothing in your holds to take anywhere";
  } else if (ctx.docked) {
    label = "Unload the hold here";
  } else if (ctx.nearestStationName === null) {
    unavailable = "There is no station on this grid to take it to";
  } else {
    label = `Haul to ${ctx.nearestStationName}`;
  }
  return [{ id: "haul", label, concern: "hold", unavailable }];
}

/**
 * The groups the GAME itself files a mining module under (goal R47).
 *
 * ⚠ THIS REPLACES A GUESS ABOUT A NAME WITH THE GAME'S OWN ANSWER. The old test
 * pattern-matched the English display name (`/miner|mining|strip|harvest/…`),
 * which is a guess dressed as a fact: it says TRUE for a "Mining Foreman Burst"
 * (a command burst, not a laser) and had to keep a hand-tuned list of negatives
 * (`upgrade|rig|processor`) to fend off the passives. A module's GROUP is what
 * the server records it as, resolved through `/api/names` (`typeGroup`) with no
 * new route — `typeGroup:17482` is "Strip Miner".
 *
 * ⚠ THIS SET IS DERIVED FROM STATIC DATA, NOT INVENTED. It is every category-7
 * (Module) group in the SDE whose types carry the `miningLaser` (effect 67) or
 * `miningClouds` (effect 2726) dogma effect — the exact two effect names eve.js
 * keys a mining module on (`server/.../mining/miningDogma.js`, MINING_EFFECT_
 * NAMES). Enumerating those groups yields precisely these six and no others; a
 * hand-written list would be the old failure in a new costume. Ice harvesters
 * live in "Strip Miner"; deep-core lasers in "Mining Laser"/"Frequency Mining
 * Laser"; gas harvesters in the two Gas Cloud groups.
 */
export const MINING_GROUP_NAMES: ReadonlySet<string> = Object.freeze(
  new Set([
    "Mining Laser", // groupID 54 — Miner I/II, Deep Core Mining Laser I, …
    "Strip Miner", // groupID 464 — Strip Miner I, Ice Harvester I/II, …
    "Frequency Mining Laser", // groupID 483 — Modulated Strip/Deep Core Miner II
    "Gas Cloud Scoops", // groupID 737 — Gas Cloud Scoop I/II, …
    "Citizen Mining Laser", // groupID 2004 — Citizen Miner
    "Gas Cloud Harvesters", // groupID 4138 — Gas Cloud Harvester I/II, …
  ]),
) as ReadonlySet<string>;

/**
 * Is this the name of a group the game files mining modules under?
 *
 * ⚠ IT IS ONLY EVER ASKED OF A RESOLVED GROUP. A group that has not resolved
 * yet is null at the call site and is "cannot tell", never a confident "no" —
 * the same discipline the name test needed and for the same reason: a wrong
 * "not a miner" about a Strip Miner nobody has looked up starts a bot that
 * immediately pauses.
 */
export function isMiningGroup(groupName: string): boolean {
  return MINING_GROUP_NAMES.has(groupName);
}

// --- R43/R47: ONE derivation of "which of these is a miner" -------------------
//
// ⚠ THE GROUP TEST IS ONLY HALF OF IT, and the other half is why this lives
// here instead of being re-written at each call site.
//
// A live R33 run on Farmer's Procurer carried `Medium Ice Harvester
// Accelerator I` — a RIG whose group is "Rig Resource Processing". The group
// test excludes it, but so does the slot filter, and the slot filter is the one
// that must never be dropped: it removes low-slot upgrades ("Mining Upgrade")
// and rigs STRUCTURALLY, before any group is consulted. Group and slot are
// complementary — group removes the language guess, slot removes the passives
// that share a family name with a real laser.
//
// So a second, independently written "does this ship have a miner?" check that
// reached for the group test alone would still have to remember the slot
// filter. The two halves have to travel together, so they are one function and
// everything shares it.

/** A module the client could switch on: a slot's contents, minus what is never activated. */
export interface ActivatableModule {
  readonly itemID: number;
  readonly typeID: number;
  readonly online: boolean;
  /**
   * The module's display name, or null when it has not resolved yet. FOR
   * RENDERING ONLY — the mining decision reads `group`, not this. Callers that
   * render substitute their own placeholder ("Unknown module") for null.
   */
  readonly label: string | null;
  /**
   * The game's GROUP name for the module, or null when it has not resolved yet.
   *
   * ⚠ NULL IS NOT "not a miner". A placeholder here would answer a confident
   * "not a miner" about a module whose group nobody has looked up yet — a guess
   * wearing the clothes of a fact. Callers that DECIDE must treat null as
   * "cannot tell" (see nav/botRegistry.ts and ungroupedHighSlotModules below).
   */
  readonly group: string | null;
}

/** The shape both the store's `FittingSlot` and any test fixture satisfy. */
export interface ActivatableSlot {
  readonly family: string;
  readonly module: {
    readonly itemID: number;
    readonly typeID: number;
    readonly online: boolean;
  } | null;
}

/**
 * Every module in the fit that can be ACTIVATED, empty slots and the two
 * never-activated families dropped.
 *
 * Rigs and subsystems are excluded here and nowhere else. That exclusion is
 * structural — it does not consult the name — which is exactly what makes it
 * survive a rig whose name reads like a mining laser.
 */
export function activatableModules(
  slots: readonly ActivatableSlot[],
  nameOf: (typeID: number) => string | null,
  groupOf: (typeID: number) => string | null,
): readonly ActivatableModule[] {
  const rows: ActivatableModule[] = [];
  for (const slot of slots) {
    if (slot.family === "rig" || slot.family === "subsystem" || !slot.module) {
      continue;
    }
    rows.push({
      itemID: slot.module.itemID,
      typeID: slot.module.typeID,
      online: slot.module.online,
      label: nameOf(slot.module.typeID),
      group: groupOf(slot.module.typeID),
    });
  }
  return rows;
}

/**
 * The activatable modules that are POWERED UP and whose GROUP the game files as
 * mining gear — the exact set the mining bot reaches for.
 *
 * A module whose group has not resolved yet (group === null) is left out, not
 * read as "not a miner": it is the honest "cannot tell".
 */
export function miningModules(
  modules: readonly ActivatableModule[],
): readonly ActivatableModule[] {
  return modules.filter(
    (row) => row.online && row.group !== null && isMiningGroup(row.group),
  );
}

/**
 * A MINING MODULE LIVES IN A HIGH SLOT and is filed in a MINING GROUP (R43/R47).
 *
 * ⚠ SLOT AND GROUP ARE COMPLEMENTARY, and both are load-bearing. The operator
 * put the slot half plainly: a miner is high-slot only, and rigs do not matter —
 * because once you are looking at high slots they cannot. Farmer's live Procurer
 * confirms it directly: both `Strip Miner I` sit at flags 27 and 28, both high.
 * The group half (R47) is the game's own answer to "is this a laser", replacing
 * the English-name guess this used to end with.
 *
 * Every low-slot / rig decoy disappears by the SLOT filter, before a group is
 * even consulted:
 *   • `Ice Harvester Upgrade II` is a LOW slot module (group "Mining Upgrade").
 *   • `Medium Ice Harvester Accelerator I` is a RIG (group "Rig Resource
 *     Processing").
 * Neither is reachable from a high-slot filter, so nothing has to remember to
 * exclude them; and neither group is in MINING_GROUP_NAMES either.
 *
 * ⚠ IT STILL APPLIES THE BOT'S OWN PREDICATE, and that is deliberate rather
 * than leftover. `isMiningGroup` (over the resolved group) is what the LOOP now
 * reaches for when it decides which modules to switch on; intersecting with it
 * makes this set a strict SUBSET of the bot's own, which is the property that
 * matters: the preflight can never be more optimistic than the bot it is
 * clearing. A requirement that said "yes, you have a miner" about a module the
 * loop would not switch on is precisely the failure this check exists to
 * prevent — the bot starts and immediately pauses with nothing to run.
 */
export function highSlotMiningModules(
  slots: readonly ActivatableSlot[],
  nameOf: (typeID: number) => string | null,
  groupOf: (typeID: number) => string | null,
): readonly ActivatableModule[] {
  return activatableModules(
    slots.filter((slot) => slot.family === "high"),
    nameOf,
    groupOf,
  ).filter((row) => row.group !== null && isMiningGroup(row.group));
}

/**
 * High-slot modules whose GROUP nobody has resolved yet — the R43/R47
 * preflight's cannot-tell.
 *
 * ⚠ THE GROUP ARRIVES ASYNCHRONOUSLY THROUGH `/api/names`, exactly as the label
 * did. A high-slot module whose group has not landed could be a Strip Miner, so
 * a caller that has to DECIDE whether this ship can mine cannot read it as "not
 * a miner". It is the honest "cannot tell" the preflight refuses to start on.
 *
 * ⚠ IT DOES NOT FILTER ON `online`. The question the requirement asks is "is a
 * miner FITTED", which an unpowered module answers just as well as a powered
 * one; an unresolved-group high-slot module could be a Strip Miner either way,
 * so it poisons the count regardless of its power state.
 */
export function ungroupedHighSlotModules(
  slots: readonly ActivatableSlot[],
  nameOf: (typeID: number) => string | null,
  groupOf: (typeID: number) => string | null,
): readonly ActivatableModule[] {
  return activatableModules(
    slots.filter((slot) => slot.family === "high"),
    nameOf,
    groupOf,
  ).filter((row) => row.group === null);
}
