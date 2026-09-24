// Dispatch from the PI board (R108 slice 4): restart a pilot's ended extractors
// by starting a SERVER bot for that pilot.
//
// ⚠ THROUGH THE BOT HOST, NEVER A SELECT HERE. Acting on a colony needs the
// character online, and the only thing in this system that arbitrates who is
// flying a hull is the server bot host: it refuses a pilot a web session holds
// (CHARACTER_IN_USE) or another bot is flying (BOT_ALREADY_RUNNING), in its own
// words, and those words are what the board shows. So this signs the pilot's
// account in on a THROWAWAY token — the hangar's pattern (startCompanionFor.ts)
// — asks the host to start the run, and signs out. It never selects.
//
// ⚠ AN ORDINARY SAVED BOT. The host starts only saved bots, so the board keeps
// one in the (platform-wide) library, named PI_RESTART_BOT_NAME: found by name,
// saved once if missing, visible and editable in the Bot Manager like any
// other. A copy someone CHANGED is no longer the board's — it is neither
// started blind nor quietly overwritten; the board says so and stops.
//
// ⚠ THE RISK IS DERIVED FROM THE SAVED DOCUMENT, by the same policy analysis
// every other start uses, and the board states it on the row before the button
// rather than in a dialog after the click.
//
// The macro walks EVERY colony the pilot owns (scriptMacros.ts): it cannot be
// aimed at one planet, so dispatch is per pilot, and the row says "all".

import {
  createBotScript as apiCreateBotScript,
  getBotScript as apiGetBotScript,
  listBotScripts as apiListBotScripts,
  login as apiLogin,
  logout as apiLogout,
  startServerBot as apiStartServerBot,
} from "./api.ts";
import { BridgeCallError } from "../bridge/callMethod.ts";
import { SCRIPT_FORMAT, SCRIPT_VERSION, startingStation, type BotScript } from "../bots/botScript.ts";
import { decodeScriptValue } from "../bots/scriptCodec.ts";
import {
  analyzeBotRunPolicy,
  createBotLaunchGrant,
  type BotLaunchGrant,
} from "../bots/runPolicy.ts";

/** The library name the board's bot goes by. */
export const PI_RESTART_BOT_NAME = "Planetary: restart extractors";

/**
 * How long the run may last. The macro stops by itself once every extractor is
 * running ("Every extractor is running"), so this is only a ceiling for a run
 * whose restarts keep not landing.
 */
export const PI_RESTART_RUNTIME_MINUTES = 60;

/** The board's bot: one Restart extractors step, no watches, the usual home. */
export function piRestartBotDoc(): BotScript {
  return {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: PI_RESTART_BOT_NAME,
    notes:
      "Saved by the Planetary Industry window. Restarts every extractor whose program has ended, " +
      "on every colony of the pilot it runs for, each on the resource it last extracted, then stops.",
    home: startingStation(),
    interrupts: [],
    program: [{ id: "restart-extractors", kind: "macro", macro: "restart-extractors", args: {} }],
  };
}

/** Is this still the board's bot, exactly — one step, nothing watching? */
export function isPiRestartBot(doc: BotScript): boolean {
  const [only] = doc.program;
  return doc.program.length === 1
    && only !== undefined
    && only.kind === "macro"
    && only.macro === "restart-extractors"
    && doc.interrupts.length === 0;
}

export type PiDispatchOutcome =
  | { readonly kind: "started" }
  | { readonly kind: "refused"; readonly sentence: string };

/** What dispatch needs from the outside world; tests supply their own. */
export interface PiDispatchDeps {
  signIn(accountName: string): Promise<string>;
  signOut(token: string): Promise<void>;
  listScripts(token: string): Promise<readonly { scriptID: string; name: string; rev: number }[]>;
  getScript(scriptID: string, token: string): Promise<{ scriptID: string; rev: number; doc: unknown } | null>;
  createScript(doc: BotScript, token: string): Promise<{ scriptID: string; rev: number }>;
  startServerBot(characterID: number, scriptID: string, grant: BotLaunchGrant, token: string): Promise<void>;
}

export const DEFAULT_PI_DISPATCH_DEPS: PiDispatchDeps = {
  async signIn(accountName) {
    const result = await apiLogin(accountName, "", { token: null, priority: "user" });
    if (result.sessionToken === null) throw new Error("The server did not return a session token.");
    return result.sessionToken;
  },
  async signOut(token) {
    await apiLogout({ token });
  },
  listScripts: (token) => apiListBotScripts({ token, priority: "user" }),
  getScript: (scriptID, token) => apiGetBotScript(scriptID, { token, priority: "user" }),
  createScript: (doc, token) => apiCreateBotScript(doc, { token, priority: "user" }),
  async startServerBot(characterID, scriptID, grant, token) {
    await apiStartServerBot(characterID, scriptID, grant, { token, priority: "user" });
  },
};

const refused = (sentence: string): PiDispatchOutcome => ({ kind: "refused", sentence });

/** The board's saved bot, saved now if it is missing. */
async function boardBot(
  deps: PiDispatchDeps,
  token: string,
): Promise<{ scriptID: string; rev: number; doc: BotScript } | PiDispatchOutcome> {
  const named = (await deps.listScripts(token)).filter((row) => row.name === PI_RESTART_BOT_NAME);
  if (named.length === 0) {
    const doc = piRestartBotDoc();
    const created = await deps.createScript(doc, token);
    return { scriptID: created.scriptID, rev: created.rev, doc };
  }
  for (const row of named) {
    const record = await deps.getScript(row.scriptID, token);
    const decoded = record ? decodeScriptValue(record.doc) : null;
    if (record && decoded?.ok && isPiRestartBot(decoded.doc)) {
      return { scriptID: record.scriptID, rev: record.rev, doc: decoded.doc };
    }
  }
  return refused(
    `The saved bot "${PI_RESTART_BOT_NAME}" has been changed, so this window will not start it. ` +
      "Put it back to a single Restart extractors step, or rename it and this window will save a fresh one.",
  );
}

/** Restart every ended extractor of this pilot's colonies, as a server run. */
export async function restartExtractorsFor(
  accountName: string,
  characterID: number,
  deps: PiDispatchDeps = DEFAULT_PI_DISPATCH_DEPS,
): Promise<PiDispatchOutcome> {
  let token: string;
  try {
    token = await deps.signIn(accountName);
  } catch {
    return refused("Could not sign in to this pilot's account just now.");
  }
  try {
    const bot = await boardBot(deps, token);
    if ("kind" in bot) return bot;
    const grant = createBotLaunchGrant(bot.rev, analyzeBotRunPolicy(bot.doc), PI_RESTART_RUNTIME_MINUTES);
    await deps.startServerBot(characterID, bot.scriptID, grant, token);
    return { kind: "started" };
  } catch (error) {
    // The server's own sentence when it answered; ours when it never did.
    if (error instanceof BridgeCallError && error.status > 0 && error.message) {
      return refused(error.message);
    }
    return refused("The server could not be reached just now.");
  } finally {
    await deps.signOut(token).catch(() => {});
  }
}
