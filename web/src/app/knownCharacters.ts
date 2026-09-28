// R107 — remember the pilots you have signed into, so "Add character" can offer
// one-click quick-adds instead of retyping an account name and re-picking a
// character every time. Persisted in localStorage (per origin, shared across
// tabs), mirroring the per-character desktop-layout store in ui/desktop.ts.
//
// This keeps only NAMES and IDs the login already hands back for any account on
// this local emulator — no secret lives here (unlike the session token, which is
// never persisted in per-session/multibox mode). DO NOT copy this to anything a
// network can reach without revisiting that.

import type { CharacterSummary } from "../store/types.ts";
import { filetimeToUnixMs } from "../bridge/activity.ts";

export interface KnownCharacter {
  /** The account to sign into to bring this pilot online (any password). */
  readonly accountName: string;
  readonly characterID: number;
  readonly characterName: string;
  readonly shipName: string | null;
  readonly skillPoints: number | null;
  readonly balance: number | null;
  /** ms epoch of the last sign-in that refreshed this row (roster ordering). */
  readonly lastSeen: number;
  // --- the Pilot Hangar's columns ------------------------------------------
  // Added for the hangar landing screen, which shows where each pilot is and
  // what it is training WITHOUT bringing it online. All four are optional: a
  // roster written by an older build has none of them, and a row missing them
  // renders "—" (R7d) rather than being thrown away.
  /**
   * Where the pilot is, already resolved to a name. The selection tuple gives
   * only IDs; app/rosterRefresh.ts resolves them while it still holds the
   * account's token, because /api/names needs one and this screen has none.
   */
  readonly locationName?: string | null;
  /** The skill currently training, by name. Null/absent = an empty queue. */
  readonly trainingSkillName?: string | null;
  /** The level it is training to, so the row can print "Mining Barge V". */
  readonly trainingToLevel?: number | null;
  /**
   * When that level completes, in Unix ms. Stored as an instant rather than a
   * duration so the remaining time re-reads correctly on every render without
   * another round trip — and so a queue that finished while the tab was shut
   * shows as idle instead of frozen at its old countdown.
   */
  readonly trainingEndsAtMs?: number | null;
  /**
   * The IDs the two resolved names above came from — the station (or, undocked,
   * the solar system) and the skill type. Never rendered (R7d); they exist so a
   * later sign-in can tell "same place, keep the name I already resolved" from
   * "it moved, the old name is now a lie".
   */
  readonly locationRefID?: number | null;
  readonly trainingSkillTypeID?: number | null;
}

/**
 * What one pilot is training, read from the LIVE queue rather than from the
 * character-selection tuple. See app/rosterRefresh.ts: the tuple's own
 * `skillTypeID` / `toLevel` / `trainingEndTime` are null for every pilot on this
 * emulator, so a roster that trusted them called every pilot idle.
 *
 * `skillTypeID: null` is a POSITIVE finding — the queue really is empty. A pilot
 * nobody could read is left OUT of the map instead, and keeps the row it had.
 */
export interface RosterTraining {
  readonly skillTypeID: number | null;
  readonly skillName: string | null;
  readonly toLevel: number | null;
  readonly endsAtMs: number | null;
}

/**
 * The half of a roster row the sign-in itself cannot fill. Kept apart from
 * `CharacterSummary` because the sign-in hands back IDs and something else
 * entirely has to turn them into words — or, for training, has to ask a
 * different call altogether (app/rosterRefresh.ts).
 */
export interface ResolvedRosterNames {
  readonly locationName: string | null;
  readonly trainingSkillName: string | null;
  /**
   * The live queue for this pilot. ABSENT means nobody could ask, and the
   * selection tuple's own fields are used instead; PRESENT wins outright — an
   * empty queue included — because the whole point of it is that it is true.
   */
  readonly training?: RosterTraining;
}

const STORAGE_VERSION = 1;
const STORAGE_KEY = `evejs-web-known-characters:v${STORAGE_VERSION}`;
// A sane cap so a long-lived roster can never grow without bound.
const MAX_ENTRIES = 60;

/** The slice of `Storage` this module needs; tests supply their own. */
export interface KnownCharacterStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function detectStorage(): KnownCharacterStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: KnownCharacterStorage | null }).localStorage;
    if (
      candidate &&
      typeof candidate.getItem === "function" &&
      typeof candidate.setItem === "function"
    ) {
      return candidate;
    }
  } catch {
    // Some privacy modes throw on touching localStorage — treat as unavailable.
  }
  return null;
}

let storage: KnownCharacterStorage | null = detectStorage();

/** Point this module at a different store (tests). Passing null disables it. */
export function setKnownCharacterStorage(next: KnownCharacterStorage | null): void {
  storage = next;
}

function isKnown(value: unknown): value is KnownCharacter {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.accountName === "string" &&
    o.accountName.length > 0 &&
    typeof o.characterID === "number" &&
    Number.isFinite(o.characterID) &&
    typeof o.characterName === "string" &&
    (o.shipName === null || typeof o.shipName === "string") &&
    (o.skillPoints === null || typeof o.skillPoints === "number") &&
    (o.balance === null || typeof o.balance === "number") &&
    typeof o.lastSeen === "number"
  );
}

/** The saved roster, most-recently-seen first; empty when none/unavailable. */
export function loadKnownCharacters(): KnownCharacter[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isKnown).sort((a, b) => b.lastSeen - a.lastSeen);
  } catch {
    return [];
  }
}

function write(entries: readonly KnownCharacter[]): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // storage full or blocked — the roster is a convenience, never fatal.
  }
}

/**
 * Record the character list a sign-in returned for `accountName`. The account's
 * previous rows are replaced wholesale (a character removed from the account
 * drops off), and every kept row's `lastSeen` is bumped so this account sorts to
 * the top of the roster.
 */
export function rememberCharacters(
  accountName: string,
  characters: readonly CharacterSummary[],
  /**
   * The resolved place/skill names for these pilots, keyed by characterID, when
   * the caller had a token to look them up with. An ordinary sign-in does NOT:
   * it passes nothing here, and each row keeps the name it already had for as
   * long as the ID behind that name is unchanged. Without that carry-over every
   * login through the character-select screen would blank the hangar's location
   * and training columns.
   */
  resolved: ReadonlyMap<number, ResolvedRosterNames> = new Map(),
): void {
  const name = accountName.trim();
  if (!name || characters.length === 0) return;
  const now = Date.now();
  const previous = loadKnownCharacters();
  const others = previous.filter((k) => k.accountName !== name);
  const before = new Map(previous.map((k) => [k.characterID, k]));
  const fresh: KnownCharacter[] = characters.map((c) => {
    const locationRefID = c.stationID ?? c.solarSystemID ?? null;
    const prior = before.get(c.characterID);
    const lookedUp = resolved.get(c.characterID) ?? null;
    const training = resolveTraining(c, lookedUp?.training, prior);
    const trainingSkillTypeID = training.skillTypeID;
    return {
      accountName: name,
      characterID: c.characterID,
      characterName: c.characterName,
      shipName: c.shipName ?? null,
      skillPoints: c.skillPoints ?? null,
      balance: c.balance ?? null,
      lastSeen: now,
      locationName:
        lookedUp?.locationName ??
        (prior && prior.locationRefID === locationRefID ? (prior.locationName ?? null) : null),
      trainingSkillName: training.skillName ?? lookedUp?.trainingSkillName ?? null,
      trainingToLevel: training.toLevel,
      trainingEndsAtMs: training.endsAtMs,
      locationRefID,
      trainingSkillTypeID,
    };
  });
  write([...fresh, ...others].sort((a, b) => b.lastSeen - a.lastSeen));
}

/**
 * What to record in one row's four training fields, in order of authority.
 *
 *  1. THE LIVE QUEUE, when the caller could read it. It wins outright, an empty
 *     queue included — "present and empty" is an observation, and the only thing
 *     that may turn a row IDLE.
 *  2. THE SELECTION TUPLE, when it says anything at all. On this emulator it
 *     never does (every one of its three training fields comes back null for
 *     every pilot), but a server where it works is answering about right now.
 *  3. WHAT THE ROW ALREADY HAD. Neither source spoke, so nothing was learned,
 *     and a caller that could not ask must never be able to blank a column a
 *     caller that could ask filled in. This is the ordinary character-select
 *     sign-in (ui/Onboarding.svelte), which passes no resolved map at all.
 *     Stale entries retire themselves: app/hangar.ts reads a queue whose end
 *     time has passed as not training.
 *
 * The skill NAME carries over across 2 and 3 for as long as it still names the
 * same skill — a name whose type ID has changed is a lie, and is dropped.
 */
function resolveTraining(
  row: CharacterSummary,
  live: RosterTraining | undefined,
  prior: KnownCharacter | undefined,
): RosterTraining {
  if (live) {
    return {
      ...live,
      skillName:
        live.skillName ??
        (live.skillTypeID !== null && prior && prior.trainingSkillTypeID === live.skillTypeID
          ? (prior.trainingSkillName ?? null)
          : null),
    };
  }
  const skillTypeID = row.skillTypeID ?? null;
  const toLevel = row.toLevel ?? null;
  const endsAtMs = filetimeToUnixMs(row.trainingEndTime ?? null);
  if (skillTypeID === null && toLevel === null && endsAtMs === null) {
    return prior
      ? {
          skillTypeID: prior.trainingSkillTypeID ?? null,
          skillName: prior.trainingSkillName ?? null,
          toLevel: prior.trainingToLevel ?? null,
          endsAtMs: prior.trainingEndsAtMs ?? null,
        }
      : { skillTypeID: null, skillName: null, toLevel: null, endsAtMs: null };
  }
  return {
    skillTypeID,
    toLevel,
    endsAtMs,
    skillName:
      skillTypeID !== null && prior && prior.trainingSkillTypeID === skillTypeID
        ? (prior.trainingSkillName ?? null)
        : null,
  };
}

/** Drop one pilot from the roster (the "forget" affordance in the picker). */
export function forgetKnownCharacter(characterID: number): void {
  write(loadKnownCharacters().filter((k) => k.characterID !== characterID));
}

/**
 * Drop a whole account and every pilot under it — the hangar's manage-mode ✕ on
 * an account header. Local only: nothing is deleted on the server, the account
 * comes back the moment it is signed into again. Returns the characterIDs that
 * went, so the caller can strip them out of the squads too.
 */
export function forgetKnownAccount(accountName: string): number[] {
  const roster = loadKnownCharacters();
  const gone = roster.filter((k) => k.accountName === accountName);
  write(roster.filter((k) => k.accountName !== accountName));
  return gone.map((k) => k.characterID);
}
