// Stopping a server bot from a screen that has NO session of its own.
//
// The Pilot Hangar and the onboarding picker are both PRE-LOGIN screens. They
// list the pilots this browser remembers and mark the ones a server bot is
// flying, which they read from /api/bots/active — deliberately unauthenticated,
// because that mark has to appear before anybody signs in. STOPPING is not:
// /api/bots and /api/bots/:botID/stop are both behind requireAuth and both are
// scoped to `req.account.accountID`, so the stop has to be made by the pilot's
// OWN account. All the row has is that account's name.
//
// On a server whose login takes any password the account name IS the
// credential, so this does what app/rosterRefresh.ts does for the same reason:
// sign in on a THROWAWAY per-session token ({token: ...} keeps the tab's global
// storage untouched), stop the bot, sign that token out again. No character is
// ever selected, so nothing undocks and no hull is claimed.
//
// ⚠ WITHOUT THIS THE LANDING SCREEN IS A DEAD END. The BFF refuses to select a
// character a server bot is flying (CHARACTER_IN_USE_BY_BOT), so on a browser
// whose pilots are all bot-flown there is nothing clickable that leads to a
// Stop — every row refuses, and the player cannot reach their own bots.
//
// It lives here rather than inside either component because BOTH screens need
// it, and two copies of a sign-in/stop/sign-out sequence is exactly the shape
// that drifts apart.

import {
  listServerBots,
  login as apiLogin,
  logout as apiLogout,
  stopServerBot,
  type ApiOptions,
} from "./api.ts";
import { serverBotFor } from "../bots/pilotRoster.ts";

/** Transport only — the token is this function's to mint, never the caller's. */
export type StopBotOptions = Pick<ApiOptions, "fetch" | "baseUrl">;

/**
 * Stop whichever server bot is flying `characterID`, holding a session only for
 * the length of the call.
 *
 * Resolves true when a bot was stopped and false when nothing was flying that
 * pilot any more — the poll that drew the button is seconds old, so a run
 * ending underneath it is ordinary, not a failure. THROWS on a login or network
 * failure: the caller owns the words for that.
 */
export async function stopServerBotFor(
  accountName: string,
  characterID: number,
  options: StopBotOptions = {},
): Promise<boolean> {
  // "user", not "poll": every call here is behind a click, and a click must
  // never queue behind the roster polls this screen also runs (app/transport.ts).
  const result = await apiLogin(accountName, "", { ...options, token: null, priority: "user" });
  const token = result.sessionToken;
  if (token === null) {
    throw new Error("The server did not return a session token.");
  }
  const asOwner = { ...options, token, priority: "user" as const };
  try {
    // serverBotFor, not a status list: an ENDED run keeps being listed so its
    // last readout stays visible, and stopping one of those would be a no-op
    // reported as success. See bots/pilotRoster.ts.
    const bot = serverBotFor(await listServerBots(asOwner), characterID);
    if (bot === null) {
      return false;
    }
    await stopServerBot(bot.botID, asOwner);
    return true;
  } finally {
    await apiLogout(asOwner).catch(() => {});
  }
}
