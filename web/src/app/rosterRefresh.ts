// Pilot Hangar — refreshing the roster WITHOUT bringing anybody online.
//
// The hangar prints where each pilot is, what it is flying, its wallet and what
// it is training. All of that arrives in one call — the same
// charUnboundMgr.GetCharacterSelectionData the character-select screen has
// always used — but that call needs a signed-in session, and the hangar is the
// screen you see BEFORE you sign in.
//
// So this does what Onboarding's "stop that bot" button already does: signs into
// the account on a THROWAWAY per-session token ({token: ...} keeps the tab's
// global storage untouched), reads, resolves the IDs it got back into names, and
// signs that token out again. On a server whose login takes any password the
// account name IS the credential, and no character is ever selected — nothing
// undocks, nothing is claimed, and the pilot stays available to be brought
// online for real a moment later.
//
// Everything here is best-effort. An account that has been deleted, a gateway
// that is cold, a network that drops: the roster keeps the rows it already had
// and the next refresh tries again. A landing screen must never be a dead end
// because a read failed.

import { login as apiLogin, logout as apiLogout, resolveNames } from "./api.ts";
import { getCharacterSelectionData } from "../bridge/characterSelection.ts";
import { rememberCharacters, type ResolvedRosterNames } from "./knownCharacters.ts";
import type { CharacterSummary } from "../store/types.ts";
import type { NameRef } from "../store/names.ts";

/** What one account's refresh did, for the caller's own logging/telemetry. */
export interface AccountRefresh {
  readonly accountName: string;
  readonly ok: boolean;
  readonly characters: readonly CharacterSummary[];
}

/**
 * The IDs one selection row needs turned into words: where the pilot is, and
 * what it is training. A docked pilot is placed by its station; an undocked one
 * only has a solar system, so the station ID wins when both are present.
 */
function nameRefsFor(row: CharacterSummary): NameRef[] {
  const refs: NameRef[] = [];
  if (row.stationID !== null) {
    refs.push({ kind: "station", id: row.stationID });
  } else if (row.solarSystemID !== null) {
    refs.push({ kind: "system", id: row.solarSystemID });
  }
  if (row.skillTypeID !== null) {
    refs.push({ kind: "type", id: row.skillTypeID });
  }
  return refs;
}

/**
 * Resolve every place and skill in one batch. One round trip for the whole
 * account, not one per pilot — /api/names exists precisely so a screen full of
 * IDs costs a single call. A lookup that fails leaves the name null, and the row
 * renders "—" (R7d) rather than an ID.
 */
async function resolveRosterNames(
  characters: readonly CharacterSummary[],
  token: string,
): Promise<Map<number, ResolvedRosterNames>> {
  const refs = new Map<string, NameRef>();
  for (const row of characters) {
    for (const ref of nameRefsFor(row)) {
      refs.set(`${ref.kind}:${ref.id}`, ref);
    }
  }
  const resolved = new Map<number, ResolvedRosterNames>();
  if (refs.size === 0) {
    return resolved;
  }
  let names: Readonly<Record<string, string | null>> = {};
  try {
    ({ names } = await resolveNames([...refs.values()], { token, priority: "poll" }));
  } catch {
    // Keep going with no names at all: the roster's other columns are still
    // worth refreshing, and the previous names carry over untouched.
    return resolved;
  }
  for (const row of characters) {
    const locationKey =
      row.stationID !== null
        ? `station:${row.stationID}`
        : row.solarSystemID !== null
          ? `system:${row.solarSystemID}`
          : null;
    resolved.set(row.characterID, {
      locationName: locationKey === null ? null : (names[locationKey] ?? null),
      trainingSkillName: row.skillTypeID === null ? null : (names[`type:${row.skillTypeID}`] ?? null),
    });
  }
  return resolved;
}

/**
 * Refresh one account's pilots into the roster. Resolves nothing into the
 * caller's own session: the token is minted, used and signed out inside this
 * function.
 */
export async function refreshAccount(accountName: string): Promise<AccountRefresh> {
  const name = accountName.trim();
  if (!name) {
    return { accountName, ok: false, characters: [] };
  }
  try {
    return { accountName: name, ok: true, characters: await readAccountInto(name, "") };
  } catch {
    return { accountName: name, ok: false, characters: [] };
  }
}

/**
 * Sign in, read the account's pilots into the roster, sign out. THROWS — each
 * caller decides whether a failure is worth telling the player about.
 */
async function readAccountInto(
  accountName: string,
  password: string,
): Promise<readonly CharacterSummary[]> {
  let token: string | null = null;
  try {
    const result = await apiLogin(accountName, password, { token: null });
    token = result.sessionToken;
    if (token === null) {
      throw new Error("The server did not return a session token.");
    }
    const asOwner = { token, priority: "poll" as const };
    const selection = await getCharacterSelectionData(asOwner);
    const resolved = await resolveRosterNames(selection.characters, token);
    rememberCharacters(accountName, selection.characters, resolved);
    return selection.characters;
  } finally {
    if (token !== null) {
      await apiLogout({ token }).catch(() => {});
    }
  }
}

/**
 * Add an account to the hangar — the login modal's whole job. Signs in (any
 * password; an unknown name mints a new account, R2) and records its pilots. NO
 * character is selected: adding an account is not the same decision as bringing
 * a pilot online, and the hangar keeps those two apart.
 *
 * Unlike `refreshAccount` this lets the failure through. The player just typed
 * the name, so a refusal is an answer they need rather than noise.
 */
export async function addAccount(
  accountName: string,
  password: string,
): Promise<readonly CharacterSummary[]> {
  return readAccountInto(accountName.trim(), password);
}

/**
 * Refresh every account in the roster, ONE AT A TIME.
 *
 * Sequential on purpose, and this is the same reasoning as App's restore loop: a
 * browser allows about six connections per origin, and a player with a dozen
 * accounts firing a dozen logins at once fills that pool with sign-ins — so the
 * click they make while it runs queues behind all of them. One at a time also
 * lets the first sign-in warm a cold gateway before the rest arrive.
 *
 * `onAccountDone` fires after each account so the screen can repaint that
 * account's rows as they land rather than staying stale until the last one.
 */
export async function refreshRoster(
  accountNames: readonly string[],
  onAccountDone: (refresh: AccountRefresh) => void = () => {},
): Promise<void> {
  for (const accountName of accountNames) {
    const refresh = await refreshAccount(accountName);
    onAccountDone(refresh);
  }
}
