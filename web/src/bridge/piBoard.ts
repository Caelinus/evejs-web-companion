// The PI Manager's board (R108 slice 3), as a pure function of what was read.
//
// Several pilots' colonies in one list. Everything a player reads here is a
// sentence built from a server-stated fact; NOTHING HERE SIMULATES A COLONY
// (planets.ts), and nothing here fetches — the window hands this the readings it
// holds and renders what comes back.
//
// ---------------------------------------------------------------------------
// A MERGED VIEW IS NOT ONE MOMENT.
//
// Each pilot was read on its own, at its own instant. So every colony row
// carries the age of ITS pilot's reading, and the board says when the rows it
// merged were read far apart. Nothing here presents several readings as if they
// were one snapshot.
//
// ---------------------------------------------------------------------------
// FOUR OUTCOMES, PER PILOT.
//
// Being read, could not be read, has not built, and "the server reported no
// colony table" are four facts, and on a board spanning pilots each is said
// about the pilot it is true of. A failed read never erases the last good one:
// that reading stays, aged, beside the sentence saying the new one failed.

import type { Colony } from "../store/types.ts";
import type { PilotColonyReading } from "./piRoster.ts";
import type { PiRecipeBook } from "./piRecipes.ts";
import {
  attentionByColony,
  bySeverityThenTime,
  colonyAttentionWords,
  colonyLineWords,
  type ColonyAttention,
  type ColonyFindingUrgency,
} from "./colonyAttention.ts";
import { colonyPlaceWords, formatDuration, serverNow } from "./planets.ts";

/**
 * What the latest attempt to read a pilot did.
 *
 * - `none`        nobody has tried this session
 * - `reading`     a read is in flight
 * - `read`        the latest read answered for this pilot
 * - `failed`      the sign-in or the read itself failed
 * - `unanswered`  the read came back without this pilot (refused or failed)
 * - `no-account`  the hangar no longer knows which account this pilot is on
 */
export type PilotAttempt = "none" | "reading" | "read" | "failed" | "unanswered" | "no-account";

export interface PiBoardInput {
  /** The assigned pilots, in the player's order. */
  readonly members: readonly number[];
  /** Pilot names from the hangar. A pilot missing here is no longer in it. */
  readonly names: ReadonlyMap<number, string>;
  /** The last good reading per pilot — possibly from an earlier session. */
  readonly readings: ReadonlyMap<number, PilotColonyReading>;
  readonly attempts: ReadonlyMap<number, PilotAttempt>;
  /** The browser's clock now; each reading corrects it by its own offset. */
  readonly browserNowMs: number;
  /**
   * The recipe table, when it has been read: a starved factory is judged
   * against what its recipe needs. Without it, against what its routes bring.
   */
  readonly recipes?: PiRecipeBook | null;
}

export interface PiPilotRow {
  readonly characterID: number;
  readonly pilotName: string;
  /** The sentence about this pilot when there is one to say; null otherwise. */
  readonly noteWords: string | null;
  readonly colonyCount: number;
  /** How old this pilot's reading is, or null when there is none. */
  readonly readAgeWords: string | null;
  readonly busy: boolean;
}

export interface PiColonyRow {
  /** For a keyed each only — never printed. */
  readonly key: string;
  readonly characterID: number;
  readonly pilotName: string;
  readonly placeWords: string;
  readonly stateWords: string;
  readonly needsYouNow: boolean;
  readonly readAgeWords: string;
}

export interface PiNeedsYou {
  /** For a keyed each only — never printed. */
  readonly key: string;
  readonly characterID: number;
  readonly pilotName: string;
  readonly placeWords: string;
  readonly words: string;
  readonly urgency: ColonyFindingUrgency;
  readonly readAgeWords: string;
}

export interface PiBoard {
  readonly pilots: readonly PiPilotRow[];
  /** Every colony of every pilot, worst first, quiet ones after. */
  readonly colonies: readonly PiColonyRow[];
  /** Only what has something to say, worst first. Empty is the quiet answer. */
  readonly needsYou: readonly PiNeedsYou[];
  /** Said when the merged readings are far apart; null when they are not. */
  readonly staleWords: string | null;
  /** A sentence about the whole board, when one is true; null otherwise. */
  readonly emptyWords: string | null;
}

const NO_LONGER_IN_HANGAR = "A pilot no longer in the hangar";

/** Readings closer together than this are one moment for the player's purposes. */
const SAME_MOMENT_MS = 60_000;

function ageWords(reading: PilotColonyReading, browserNowMs: number): string {
  if (reading.readAtMs === null) {
    return "Read at an unknown time";
  }
  const nowMs = serverNow(reading.report.clockOffsetMs, browserNowMs);
  return `Read ${formatDuration(nowMs - reading.readAtMs)} ago`;
}

function pilotNote(
  name: string,
  known: boolean,
  attempt: PilotAttempt,
  reading: PilotColonyReading | null,
): string | null {
  if (!known || attempt === "no-account") {
    return "This pilot is no longer in the hangar, so there is no account to read with.";
  }
  if (attempt === "failed" || attempt === "unanswered") {
    return `${name}'s colonies could not be read just now.`;
  }
  if (reading === null) {
    return attempt === "reading" ? `Looking at ${name}'s colonies...` : "Not looked at yet.";
  }
  if (!reading.report.coloniesReadable) {
    return `The server did not report colony information for ${name}. That is not the same as having none.`;
  }
  if (reading.report.colonies.length === 0) {
    return `${name} has not built on a planet yet.`;
  }
  return null;
}

interface Placed {
  readonly characterID: number;
  readonly pilotName: string;
  readonly memberIndex: number;
  readonly reading: PilotColonyReading;
  readonly colony: Colony;
  readonly attention: ColonyAttention | null;
  readonly nowMs: number;
}

/** Noisy before quiet; among noisy, the one colony list's own rule; then roster order. */
function byWorst(left: Placed, right: Placed): number {
  const a = left.attention;
  const b = right.attention;
  if ((a === null) !== (b === null)) {
    return a === null ? 1 : -1;
  }
  if (a !== null && b !== null) {
    if (a.needsYouNow !== b.needsYouNow) {
      return a.needsYouNow ? -1 : 1;
    }
    const worst = bySeverityThenTime(a.findings[0]!, b.findings[0]!);
    if (worst !== 0) {
      return worst;
    }
  }
  return left.memberIndex - right.memberIndex;
}

export function buildPiBoard(input: PiBoardInput): PiBoard {
  const pilots: PiPilotRow[] = [];
  const placed: Placed[] = [];

  input.members.forEach((characterID, memberIndex) => {
    const knownName = input.names.get(characterID);
    const pilotName = knownName ?? NO_LONGER_IN_HANGAR;
    const reading = input.readings.get(characterID) ?? null;
    const attempt = input.attempts.get(characterID) ?? "none";
    pilots.push({
      characterID,
      pilotName,
      noteWords: pilotNote(pilotName, knownName !== undefined, attempt, reading),
      colonyCount: reading?.report.colonies.length ?? 0,
      readAgeWords: reading === null ? null : ageWords(reading, input.browserNowMs),
      busy: attempt === "reading",
    });
    if (reading === null) {
      return;
    }
    const nowMs = serverNow(reading.report.clockOffsetMs, input.browserNowMs);
    const attention = new Map(
      attentionByColony(reading.report.colonies, nowMs, undefined, input.recipes ?? null).map((entry) => [entry.colony.planetID, entry]),
    );
    for (const colony of reading.report.colonies) {
      placed.push({
        characterID,
        pilotName,
        memberIndex,
        reading,
        colony,
        attention: attention.get(colony.planetID) ?? null,
        nowMs,
      });
    }
  });

  const ordered = [...placed].sort(byWorst);
  const colonies = ordered.map((entry): PiColonyRow => ({
    key: `${entry.characterID}:${entry.colony.planetID}`,
    characterID: entry.characterID,
    pilotName: entry.pilotName,
    placeWords: colonyPlaceWords(entry.colony),
    stateWords: colonyLineWords(entry.colony, entry.attention?.findings ?? [], entry.nowMs),
    needsYouNow: entry.attention?.needsYouNow ?? false,
    readAgeWords: ageWords(entry.reading, input.browserNowMs),
  }));
  const needsYou = ordered
    .filter((entry) => entry.attention !== null)
    .map((entry): PiNeedsYou => {
      const findings = entry.attention!.findings;
      return {
        key: `${entry.characterID}:${entry.colony.planetID}`,
        characterID: entry.characterID,
        pilotName: entry.pilotName,
        placeWords: colonyPlaceWords(entry.colony),
        words: colonyAttentionWords(findings) ?? findings[0]!.words,
        urgency: entry.attention!.needsYouNow ? "now" : "soon",
        readAgeWords: ageWords(entry.reading, input.browserNowMs),
      };
    });

  return {
    pilots,
    colonies,
    needsYou,
    staleWords: staleWords(input),
    emptyWords: emptyWords(input),
  };
}

/** "Read at different times" — only when the readings shown really are apart. */
function staleWords(input: PiBoardInput): string | null {
  const ages: number[] = [];
  for (const characterID of input.members) {
    const reading = input.readings.get(characterID);
    if (!reading || reading.readAtMs === null) {
      continue;
    }
    ages.push(serverNow(reading.report.clockOffsetMs, input.browserNowMs) - reading.readAtMs);
  }
  if (ages.length < 2) {
    return null;
  }
  const oldest = Math.max(...ages);
  if (oldest - Math.min(...ages) < SAME_MOMENT_MS) {
    return null;
  }
  return `Read at different times; the oldest is ${formatDuration(oldest)} old.`;
}

function emptyWords(input: PiBoardInput): string | null {
  if (input.members.length === 0) {
    return "No pilots are on planetary industry yet. Add one below.";
  }
  // Only a positive statement about EVERY pilot: one we have not read, or whose
  // server reported no colony table, means we do not know that nobody built.
  const everyoneEmpty = input.members.every((characterID) => {
    const reading = input.readings.get(characterID);
    return reading !== undefined
      && reading.report.coloniesReadable
      && reading.report.colonies.length === 0;
  });
  return everyoneEmpty ? "None of your pilots has built on a planet yet." : null;
}
