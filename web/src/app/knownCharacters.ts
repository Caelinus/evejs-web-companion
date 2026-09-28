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
 * The half of a roster row that only a name lookup can fill. Kept apart from
 * `CharacterSummary` because the sign-in hands back the IDs and something else
 * entirely has to turn them into words (app/rosterRefresh.ts).
 */
export interface ResolvedRosterNames {
  readonly locationName: string | null;
  readonly trainingSkillName: string | null;
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
    const trainingSkillTypeID = c.skillTypeID ?? null;
    const prior = before.get(c.characterID);
    const lookedUp = resolved.get(c.characterID) ?? null;
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
      trainingSkillName:
        lookedUp?.trainingSkillName ??
        (prior && prior.trainingSkillTypeID === trainingSkillTypeID
          ? (prior.trainingSkillName ?? null)
          : null),
      trainingToLevel: c.toLevel ?? null,
      trainingEndsAtMs: filetimeToUnixMs(c.trainingEndTime ?? null),
      locationRefID,
      trainingSkillTypeID,
    };
  });
  write([...fresh, ...others].sort((a, b) => b.lastSeen - a.lastSeen));
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
