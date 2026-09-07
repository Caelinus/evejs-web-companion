// The three lines the flight strip answered — where you are, what is happening,
// and what went wrong — as pure functions.
//
// ⚠ WHY THIS IS A MODULE. The strip lived in `Overview.svelte`, and its rules
// are the kind that get quietly softened when markup is moved: "nothing is ever
// synthesized" survives a copy-paste only if something is holding it. It is
// pure so `flightStrip.test.ts` can keep asserting the rules against the rules
// themselves, wherever they happen to be rendered.

import { resolvedName } from "../store/names.ts";
import type { FlightState, SpaceSnapshot } from "../store/types.ts";

/** The resolved-name map, as the store keeps it. */
type NameCache = Readonly<Record<string, string | null>>;

/**
 * WHERE.
 *
 * ⚠ ASSEMBLED ONLY FROM WHAT THE FLIGHT SLICE ACTUALLY REPORTED. Every part that
 * is unknown is left OUT rather than filled with a guess or a placeholder — a
 * strip reading "Docked at —" is worse than one reading "Docked", because the
 * dash looks like a name that failed to load rather than a fact we never had.
 *
 * Names only, never an id (R7d).
 */
export function whereText(
  flight: Pick<FlightState, "status" | "solarSystemName" | "stationName" | "structureName">,
  snapshot: SpaceSnapshot | null,
  resolved: NameCache,
): string {
  const status = flight.status;
  if (!status) {
    return "Finding out where you are…";
  }
  const parts: string[] = [];
  if (status.inSpace) {
    parts.push(`In space${flight.solarSystemName ? ` · ${flight.solarSystemName}` : ""}`);
  } else if (status.stationID !== null) {
    parts.push(`Docked at ${flight.stationName ?? "the station"}`);
  } else if (status.structureID !== null) {
    parts.push(`Docked at ${flight.structureName ?? "a structure"}`);
  } else {
    parts.push("Docked");
  }
  // The active ship, by TYPE name, from the snapshot. Docked there is no
  // snapshot, so the ship is simply not named rather than named badly.
  const shipTypeID = snapshot?.ship?.typeID ?? null;
  if (shipTypeID !== null) {
    const name = resolvedName(resolved, "type", shipTypeID, "");
    if (name.length > 0) {
      parts.push(name);
    }
  }
  return parts.join(" · ");
}

/** What a running loop says about itself: its own `{phase, action, why}`. */
export interface LoopVoice {
  readonly status: string | null;
  readonly phase?: string | null;
  readonly action?: string | null;
  readonly why?: string | null;
}

/**
 * DOING — and ONLY when something is genuinely driving the ship.
 *
 * ⚠ THIS IS NEVER SYNTHESIZED. It is passed straight through from the bot's or
 * the autopilot's own words. Hand-flying produces no narration at all, because
 * there is no authority to quote: inventing one ("Approaching…", "Idle") would
 * make a sentence the browser guessed indistinguishable from a sentence the
 * loop actually reported, and the player has no way to tell them apart.
 *
 * `null` means "say nothing", which is a real answer and the common one.
 */
export function doingText(bot: LoopVoice, travel: LoopVoice): string | null {
  // The mining bot first: when it is running it is the thing flying the ship.
  if (bot.status === "running" || bot.status === "paused") {
    return joinSaid([bot.phase, bot.action, bot.why]);
  }
  if (travel.status === "running") {
    return joinSaid([travel.phase, travel.action]);
  }
  return null;
}

function joinSaid(parts: readonly (string | null | undefined)[]): string | null {
  const said = parts.filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return said.length > 0 ? said.join(" · ") : null;
}

/**
 * WRONG — the FIRST reason any source is currently carrying.
 *
 * ⚠ ONE REASON, NOT A PILE. Each source keeps rendering its own error where it
 * happened; this is a summary so a refusal is visible without hunting the tab
 * that owns it. Showing all four would turn one failure into a wall and make a
 * stale reason look like a fresh one.
 *
 * The ORDER is the documented one: the flight step, then the autopilot, then
 * the bot, then targeting.
 */
export function wrongText(sources: {
  readonly flightActionError?: string | null;
  readonly travelFailureReason?: string | null;
  readonly botFailureReason?: string | null;
  readonly targetingActionError?: string | null;
}): string | null {
  return (
    sources.flightActionError ??
    sources.travelFailureReason ??
    sources.botFailureReason ??
    sources.targetingActionError ??
    null
  );
}
