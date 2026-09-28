// Fleet companion — the WORDS a readout uses, in one place.
//
// Two surfaces now describe one running companion: the pilot's own panel
// (`ui/FleetCompanion.svelte`) and the per-pilot row in the Bot Manager
// (`ui/BotManagerPilotRow.svelte`, phase 9). They must not tell different
// stories about the same run — `src/botHost.js` states the same principle
// where it folds a bot's progress onto its roster row ("same words the in-tab
// readout shows, so the phone and a tab never tell different stories").
//
// ⚠ ROLE AND ORDER-SOURCE LABELS ARE GONE, AND THAT IS NOT A TRIM OF THIS
// MODULE — IT IS THE CONFIGURATION SURFACE THEY DESCRIBED DISAPPEARING.
// `docs/fleet-companion-simplification.md` deleted `FleetCompanionRole` and
// `FleetCompanionOrderSource` from `nav/fleetCompanionLoop.ts` entirely: a role
// picked exactly one field (`fleeHealthFloor`, in the now-deleted
// `companionRolePresets.ts`) that no decision rung ever read, and the order
// sources were checkboxes in front of channels that are simply always on now.
// There is nothing left keyed by either, so there is nothing left to keep two
// copies of in agreement — the duplication risk this module used to exist to
// close (`COMPANION_ROLE_LABELS` in `src/botHost.js` and `roleLabels` in
// FleetCompanion.svelte, nothing to fail if they drifted) is moot because both
// sides of that duplication are gone. What remains below (`inFleetWords`,
// `canTagWords`, `orderFromWords`) still serves both surfaces from one place,
// for the same reason.
//
// PURE, AND DELIBERATELY SO. No store, no I/O, no Svelte. A phrase is a fact
// about the run, so it is testable without a DOM.

import type { CompanionOrderAuthority } from "../nav/fleetCompanionLoop.ts";

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
 *
 * ⚠ `squad-board` IS GONE, AND IT WAS NEVER REAL. It used to be a case here,
 * naming an order source a player could tick on the settings screen — but
 * `obeys` was read at four places in the loop (`fleetCompanionLoop.ts:2466`,
 * `:2479`, `:3337`, `:3346`, before the simplification) and not one of them
 * was squad-board, so this readout could name an authority no decision could
 * ever emit. The BFF's squad board itself (`src/squadBoard.js`) is untouched
 * and still serves the scripted bots; only the companion's readout lost the
 * member. Do not restore it on the strength of this comment being about a
 * deletion — there is still nothing that produces it.
 *
 * ⚠ THIS SWITCH IS EXHAUSTIVE OVER `CompanionOrderAuthority` ON PURPOSE.
 * `null` (never decided yet) is handled before the switch so the switch itself
 * only has to cover the authority union, and the `default` arm assigns to a
 * `never` rather than returning a fallback string — so a fifth authority added
 * to the union without a case here fails the BUILD instead of quietly reading
 * as "nothing yet".
 *
 * ⚠ `chat` IS LOCAL CHAT, AND SAYING "FLEET" HERE WOULD BE A LIE THE UI ONCE
 * TOLD. `makeFleetCompanionDeps` in `app/flow.ts` reads LOCAL deliberately —
 * the gateway's chat service hardcodes its channels to local and corp, so a
 * fleet room is never delivered, and `companionFlow.test.ts` pins that the
 * companion must ask local and nothing else. The operator accepted that trade
 * knowingly (docs/fleet-companion-handoff.md, "Fleet chat is not happening");
 * this used to be said on `COMPANION_ORDER_SOURCE_LABELS`, the settings
 * screen's own label for the channel, before that whole export went with the
 * checkboxes it named (docs/fleet-companion-simplification.md, "What it
 * listens to" — chat is always on now, nothing left to label). The word
 * "local" still has to survive here because a channel a player cannot toggle
 * off is exactly the one whose reach they most need named correctly.
 */
export function orderFromWords(value: CompanionOrderAuthority | null): string {
  if (value === null) {
    return "nothing yet";
  }
  switch (value) {
    case "broadcast":
      return "a fleet broadcast";
    case "tag":
      return "a target tag";
    case "chat":
      return "a local chat command";
    case "own-ladder":
      return "its own judgement";
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
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
