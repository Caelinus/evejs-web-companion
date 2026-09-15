// PILOT GROUPS — what the Bot Manager launches a bot FOR, when the thing being
// launched is not one pilot.
//
// ⚠ A GROUP IS A HANGAR SQUAD. There is no second grouping model: the player
// already makes, names, colours and fills squads on the landing screen
// (app/hangarPrefs.ts, docs/pilot-hangar.md), and a Bot Manager that invented
// its own "bot groups" beside them would ask the same player to arrange the
// same pilots twice and then keep the two arrangements in step by hand. This
// module is a VIEW over those prefs, plus the one group that is not a squad.
//
// ⚠ COMPANIONS IS THAT ONE, AND IT IS SPECIAL IN EXACTLY ONE WAY: it has no bot
// picker. Every other group launches whatever saved bot the player chooses;
// this one always launches the fleet companion, because that is what its
// membership MEANS -- a pilot is in it precisely because somebody ticked
// "companion" for it in a squad, and the setup that tick wrote is what it
// flies. Giving it a picker would offer to run a mining script on a list of
// pilots that was assembled to answer a fleet's orders.
//
// Everything here is PURE over a prefs snapshot and a few readings the panel
// already has. No storage, no fetch, no clock, no component.

import type { ServerBot } from "../app/api.ts";
import { companionSquadRoster, type HangarPrefs } from "../app/hangarPrefs.ts";
import { serverBotFor } from "./pilotRoster.ts";
import type { CompanionSetup } from "../nav/fleetCompanionLoop.ts";

/**
 * The built-in group's id.
 *
 * ⚠ IT MUST NOT COLLIDE WITH A SQUAD ID. `nextSquadId()` mints `squad-<uuid>`,
 * so a bare word cannot be one; the prefix is kept anyway so a stored value
 * that somehow reaches this namespace is still obviously not a squad.
 */
export const COMPANIONS_GROUP_ID = "group-companions";

/** What kind of thing a group is, which is the same as what it can launch. */
export type GroupKind = "companions" | "squad";

export interface PilotGroup {
  readonly id: string;
  readonly name: string;
  /**
   * The squad's chip colour, so a group reads as the same thing here as on the
   * hangar. Null for Companions, which is not a squad and has no colour of the
   * player's choosing -- the row draws its own accent rather than borrowing a
   * palette entry that would make it look like one more squad.
   */
  readonly color: string | null;
  readonly kind: GroupKind;
  /** characterIDs, in the order the player arranged them. */
  readonly members: readonly number[];
}

/** One pilot in the Companions group, with the setup its tick wrote. */
export interface CompanionMember {
  readonly characterID: number;
  readonly setup: CompanionSetup;
}

/**
 * Every pilot set up to fly a companion, across every squad, deduplicated.
 *
 * ⚠ A PILOT IN TWO SQUADS APPEARS ONCE, FLYING THE FIRST SETUP FOUND. It is one
 * hull: it cannot fly two companions, so listing it twice would put the same
 * character in a start queue twice and the second start would refuse with
 * CHARACTER_IN_USE against the first. First-found is squad order, which is the
 * order the player made the squads in -- stable across renders, which is what
 * matters, since the two setups can only differ in limits and both were chosen
 * by the same person.
 */
export function companionGroupRoster(prefs: HangarPrefs): readonly CompanionMember[] {
  const seen = new Set<number>();
  const out: CompanionMember[] = [];
  for (const squad of prefs.squads) {
    for (const member of companionSquadRoster(prefs, squad.id)) {
      if (seen.has(member.characterID)) continue;
      seen.add(member.characterID);
      out.push(member);
    }
  }
  return out;
}

/**
 * Every group the Bot Manager offers, Companions first.
 *
 * ⚠ COMPANIONS IS ALWAYS PRESENT, EVEN EMPTY, and that is deliberate. It is the
 * group a player cannot make for themselves, so a row that vanishes when it has
 * no members is a feature that disappears exactly when somebody is looking for
 * where to switch it on. Its empty state can say where the tick is; an absent
 * row cannot say anything.
 */
export function pilotGroups(prefs: HangarPrefs): readonly PilotGroup[] {
  const companions: PilotGroup = {
    id: COMPANIONS_GROUP_ID,
    name: "Companions",
    color: null,
    kind: "companions",
    members: companionGroupRoster(prefs).map((member) => member.characterID),
  };
  const squads = prefs.squads.map<PilotGroup>((squad) => ({
    id: squad.id,
    name: squad.name,
    color: squad.color,
    kind: "squad",
    members: prefs.members[squad.id] ?? [],
  }));
  return [companions, ...squads];
}

// --- what each member is doing right now ------------------------------------

/**
 * Where one member of a group stands, from the launcher's point of view.
 *
 * ⚠ FOUR STATES, BECAUSE TWO WOULD LOSE THE ONE THAT DECIDES THE BUTTONS.
 * "Running" and "not running" is not enough: a pilot a tab here HOLDS but is
 * not flying is the only kind that both buttons can act on, and a pilot with no
 * tab here is the only kind "Run here" cannot touch at all. Collapsing them
 * would make one of the two buttons silently do nothing for some members.
 *
 *  • `running-server` — a live server bot has the hull. Nothing can start.
 *  • `running-here`   — a tab in this browser is flying it. Nothing can start.
 *  • `held`           — a tab here holds it, idle. Either button can start it.
 *  • `free`           — nothing here holds it. Only the server can start it.
 */
export type MemberWhere = "running-server" | "running-here" | "held" | "free";

export interface GroupMemberState {
  readonly characterID: number;
  /** The pilot's name, or a plain stand-in -- never a raw id (R7d). */
  readonly name: string;
  readonly where: MemberWhere;
  /** What is flying it, when something is. */
  readonly botName: string | null;
}

export interface GroupRosterInputs {
  /** The server's roster, as the panel already polls it. Ended runs ignored. */
  readonly serverBots: readonly ServerBot[];
  /** characterIDs a tab in THIS browser tab holds, whatever they are doing. */
  readonly heldCharacterIDs: readonly number[];
  /** Of those, the ones whose tab is already flying a bot of its own. */
  readonly busyHereCharacterIDs: readonly number[];
  /** A pilot's name, or null when this browser has never seen it. */
  readonly nameOf: (characterID: number) => string | null;
}

/** What the group's roster looks like right now, one row per member. */
export function groupMemberStates(
  members: readonly number[],
  inputs: GroupRosterInputs,
): readonly GroupMemberState[] {
  const held = new Set(inputs.heldCharacterIDs);
  const busyHere = new Set(inputs.busyHereCharacterIDs);
  return members.map((characterID) => {
    const name = inputs.nameOf(characterID) ?? "Unknown pilot";
    // ⚠ THE SERVER'S CLAIM WINS, the same rule `pilotRunState` states for one
    // pilot: a tab can hold a character's LOGIN while the host flies the hull.
    const serverBot = serverBotFor(inputs.serverBots, characterID);
    if (serverBot !== null) {
      return {
        characterID,
        name,
        where: "running-server" as const,
        // `kind`, not `scriptName`, for a companion -- same reason
        // `serverRunState` gives: the host's own name for the run is not what
        // the run IS.
        botName: serverBot.kind === "companion" ? "Fleet companion" : serverBot.scriptName,
      };
    }
    if (busyHere.has(characterID)) {
      return { characterID, name, where: "running-here" as const, botName: null };
    }
    return {
      characterID,
      name,
      where: held.has(characterID) ? ("held" as const) : ("free" as const),
      botName: null,
    };
  });
}

// --- what a start would actually do -----------------------------------------

export interface GroupLaunchPlan {
  /** Who "Run on server" would start, in member order. */
  readonly onServer: readonly number[];
  /** Who "Run here" would start. A subset of the above. */
  readonly here: readonly number[];
  /** Who neither button touches, because something already has the hull. */
  readonly busy: readonly number[];
}

/**
 * Who each button would start.
 *
 * ⚠ A PILOT ALREADY FLYING IS SKIPPED, NOT FAILED. Starting a group when two of
 * it are already up must bring the other four -- exactly the rule the hangar's
 * `targetsFor` states for bringing pilots online. Queueing the busy ones so
 * they can refuse would turn a normal state of affairs into two red rows.
 *
 * ⚠ AND `here` IS A SUBSET OF `onServer`, NOT A DISJOINT HALF. A pilot this tab
 * holds can go either way: run it in the tab, or hand its hull to the host
 * (which releases that tab session as part of the start). The difference
 * between the two buttons is what happens when the tab closes, and that is a
 * choice, not a property of the pilot.
 */
export function planGroupLaunch(states: readonly GroupMemberState[]): GroupLaunchPlan {
  return {
    onServer: states
      .filter((s) => s.where === "held" || s.where === "free")
      .map((s) => s.characterID),
    here: states.filter((s) => s.where === "held").map((s) => s.characterID),
    busy: states
      .filter((s) => s.where === "running-server" || s.where === "running-here")
      .map((s) => s.characterID),
  };
}

function pilotWords(count: number): string {
  return count === 1 ? "1 pilot" : `${count} pilots`;
}

/** The group's one-line readout: how many, how many are up, how many are free. */
export function groupStatusWords(states: readonly GroupMemberState[]): string {
  if (states.length === 0) {
    return "No pilots";
  }
  const plan = planGroupLaunch(states);
  const parts = [pilotWords(states.length)];
  if (plan.busy.length > 0) {
    parts.push(`${plan.busy.length} already flying`);
  }
  parts.push(plan.onServer.length === 0 ? "none free" : `${plan.onServer.length} free`);
  return parts.join(" - ");
}

/**
 * What "Run here" can reach, said out loud when it is less than the whole group.
 *
 * ⚠ THIS IS THE HALF OF THE TWO-BUTTON CHOICE A PLAYER CANNOT SEE. "Run on
 * server" starts every free member; "Run here" can only start the ones this tab
 * already holds, and with none held it does nothing at all. A disabled button
 * with no sentence beside it reads as broken.
 */
export function runHereReachWords(plan: GroupLaunchPlan): string | null {
  if (plan.onServer.length === 0) {
    return null; // nothing to start either way; the status line already says so
  }
  if (plan.here.length === 0) {
    return "No pilot in this group has a tab open here.";
  }
  if (plan.here.length === plan.onServer.length) {
    return null; // both buttons reach the same pilots; nothing to warn about
  }
  return `Only ${pilotWords(plan.here.length)} of the ${plan.onServer.length} free have a tab open here.`;
}

/**
 * The sentence a start prints when it turns out there was nobody to start.
 *
 * ⚠ IT NAMES THE KIND, because the two empty groups mean different things and
 * only one of them is fixable in the Bot Manager. An empty squad wants pilots;
 * an empty Companions group wants a tick on the landing screen.
 */
export function groupStartEmptyWords(kind: GroupKind, memberCount: number): string {
  if (memberCount === 0) {
    return kind === "companions"
      ? "No pilot is set up as a companion yet. Tick one in a squad on the Pilot Hangar."
      : "This group has no pilots yet. Add some to the squad on the Pilot Hangar.";
  }
  return "Every pilot in this group is already flying something.";
}
