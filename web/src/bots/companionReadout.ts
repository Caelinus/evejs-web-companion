// Fleet companion — the WORDS a readout uses, in one place.
//
// Two surfaces now describe one running companion: the pilot's own panel
// (`ui/FleetCompanion.svelte`) and the per-pilot row in the Bot Manager
// (`ui/BotManagerPilotRow.svelte`, phase 9). They must not tell different
// stories about the same run — `src/botHost.js` states the same principle
// where it folds a bot's progress onto its roster row ("same words the in-tab
// readout shows, so the phone and a tab never tell different stories").
//
// ⚠ THE ROLE LABELS WERE ALREADY DUPLICATED IN TWO LANGUAGES, and that is the
// reason this module exists rather than a second copy of the phrases. Until
// this file, `COMPANION_ROLE_LABELS` lived privately in `src/botHost.js` (for
// the roster row's `scriptName`) AND as `roleLabels` in FleetCompanion.svelte,
// with nothing to fail if one drifted — the same shape of bug the
// `COMPANION_GRANT_SCRIPT_REV` comment in `companionRunPolicy.ts` exists to
// prevent. The host imports this off the loaded stack, exactly as it does that
// sentinel.
//
// PURE, AND DELIBERATELY SO. No store, no I/O, no Svelte. A phrase is a fact
// about the run, so it is testable without a DOM.

import type {
  FleetCompanionOrderSource,
  FleetCompanionRole,
} from "../nav/fleetCompanionLoop.ts";

/** What this pilot is FOR, in the player's words. */
export const COMPANION_ROLE_LABELS: Readonly<Record<FleetCompanionRole, string>> = Object.freeze({
  dps: "DPS",
  logi: "Logistics",
  tackle: "Tackle",
  support: "Support",
});

/** The role label, or a dash when a run has not reported one yet. */
export function companionRoleLabel(role: FleetCompanionRole | null): string {
  return role === null ? "-" : COMPANION_ROLE_LABELS[role];
}

/**
 * The order channels, as the settings screen names them.
 *
 * ⚠ `chat` IS LOCAL CHAT, AND SAYING "FLEET" HERE WAS A LIE THE UI TOLD.
 * `makeFleetCompanionDeps` in `app/flow.ts` reads LOCAL deliberately — the
 * gateway's chat service hardcodes its channels to local and corp, so a fleet
 * room is never delivered, and `companionFlow.test.ts` pins that the companion
 * must ask local and nothing else. The operator accepted that trade knowingly
 * (docs/fleet-companion-handoff.md, "Fleet chat is not happening"); a label
 * that called it fleet chat hid the one thing about it the player needs to
 * know, which is that the whole system can read what they type.
 */
export const COMPANION_ORDER_SOURCE_LABELS: Readonly<
  Record<FleetCompanionOrderSource, string>
> = Object.freeze({
  broadcast: "Fleet broadcasts",
  tag: "Target tags",
  chat: "Local chat commands",
  "squad-board": "The squad board",
});

/** Whether this pilot is in a fleet. Three states; null is "not read yet". */
export function inFleetWords(value: boolean | null): string {
  if (value === null) {
    return "not known";
  }
  return value ? "yes" : "no";
}

/**
 * Which authority the last decision came from.
 *
 * ⚠ THIS NAMES A CHANNEL, NEVER A PILOT. `FleetCompanionProgress` carries the
 * KIND of authority and not who exercised it; the broadcast's own
 * `senderCharID` is on the fleet slice if a future readout wants the name, but
 * nothing here invents one out of the channel.
 */
export function orderFromWords(
  value:
    | "broadcast"
    | "tag"
    | "chat"
    | "squad-board"
    | "own-ladder"
    | null,
): string {
  switch (value) {
    case "broadcast":
      return "a fleet broadcast";
    case "tag":
      return "a target tag";
    case "chat":
      return "a local chat command";
    case "squad-board":
      return "the squad board";
    case "own-ladder":
      return "its own judgement";
    default:
      return "nothing yet";
  }
}

/**
 * Whether this pilot's tag write would land.
 *
 * ⚠ THREE STATES, AND THE THIRD IS THE POINT. A pilot silently unable to tag
 * looks exactly like one with nothing to tag — the server drops a
 * non-commander's write while answering ok — so "not known" must never be
 * flattened into "no".
 */
export function canTagWords(value: boolean | null): string {
  if (value === null) {
    return "not known";
  }
  return value ? "yes" : "no - not a fleet commander";
}
