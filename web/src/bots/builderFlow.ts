// WHAT THE BOT BUILDER NEEDS FROM A FLOW — and the stand-in for when no pilot
// is in the client.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// The Builder used to take a whole `AppFlow`, which only a pilot's session has,
// so it could only open on a pilot's desktop. The Bot Manager opens from the
// Pilot Hangar with nobody in the client, and its New and Edit buttons were
// greyed out there: a player who had signed every pilot out, or had not signed
// one in yet, could list their bots but not write or change one.
//
// Writing a bot does not need a pilot. The library is platform-wide and any
// signed-in ACCOUNT reads and writes the same rows (the Manager already reaches
// it that way, app/pilotReach.ts), and the station search and ore families are
// static data behind the same account-level auth. What a pilot adds is only
// help with the pickers: their saved fittings, their bookmarks, their corp's
// hangars, what is in their cargo. Without one those come back empty, and every
// picker already has an honest empty state for that.

import * as api from "../app/api.ts";
import type { ApiOptions } from "../app/api.ts";
import type { AppFlow } from "../app/flow.ts";

/**
 * The slice of `AppFlow` the Builder and its pickers call.
 *
 * `requestOptions` may answer late: a pilot's session has its options to hand,
 * an account sign-in has to be minted first. `AppFlow` satisfies this as it is.
 */
export type BuilderFlow = Pick<
  AppFlow,
  "listSavedFittings" | "listBookmarks" | "listOreFamilies" | "searchDestinations" | "loadCorpOffices"
> & {
  requestOptions(): ApiOptions | Promise<ApiOptions>;
};

/** Why the corporation picker has nothing to offer here. */
export const NO_PILOT_FOR_CORP_OFFICES = "No pilot is in the client to read a corporation's offices.";

/**
 * A `BuilderFlow` that rides an ACCOUNT, not a pilot.
 *
 * `accountOptions` is the Manager's own `libraryOptions` (app/pilotReach.ts):
 * the first account this browser can sign in. It throws when there is none,
 * and the Builder's library read already says so on screen.
 */
export function createPilotlessBuilderFlow(accountOptions: () => Promise<ApiOptions>): BuilderFlow {
  return {
    requestOptions: accountOptions,
    // Both belong to a character, and an account sign-in has none selected.
    listSavedFittings: async () => [],
    listBookmarks: async () => [],
    listOreFamilies: async () => api.listOreFamilies(await accountOptions()),
    async searchDestinations(query, kind = null) {
      const trimmed = query.trim();
      if (trimmed.length < 2) return [];
      // Stations only for "dockable": which Upwell structures a pilot may dock
      // at is that pilot's access list, and there is no pilot to ask about.
      const result = await api.findMapLocations(trimmed, kind === "dockable" ? "station" : kind, await accountOptions());
      // Jumps are counted from where a pilot is, and nobody is anywhere.
      return result.matches.map((match) => ({ ...match, jumps: null }));
    },
    // A read that did not happen, told apart from "no offices" — the picker
    // keeps the step on the pilot's own hangar and says it could not check.
    loadCorpOffices: async () => ({ stationIDs: [], divisions: [], error: NO_PILOT_FOR_CORP_OFFICES }),
  };
}
