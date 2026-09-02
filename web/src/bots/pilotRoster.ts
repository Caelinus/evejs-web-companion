// The Bot Manager's "pilots" region PURE VIEW LAYER — one row per pilot,
// showing what each is running. No component, no fetch, no clock of its own,
// exactly as bots/libraryView.ts (its sibling in the same slice).
//
// A pilot can be running a bot two structurally different ways, and this
// module's whole job is to tell them apart honestly rather than collapse
// them into one "running" flag:
//
//   • IN THIS TAB — `store.bots.runningBotID` (a `ShipControllerID`) plus
//     `store.customBot` for a player-built script. Dies when the tab closes.
//   • ON THE SERVER — a `ServerBot` from `listServerBots()`. Keeps flying
//     with the tab shut (src/botHost.js).
//
// ⚠ A SERVER BOT ALWAYS WINS OVER A TAB READING FOR THE SAME CHARACTER.
// botHost's claim model means starting a bot on the server releases any tab
// session flying that same character first (see Bots.svelte's
// `startSavedOnServer`, which calls `flow.releaseSession()` right after the
// server accepts the start). So if a tab reading AND a server bot both name
// one character, the tab reading is simply stale — it has not caught up with
// its own release yet — and the server bot is the truth. `pilotRunState`
// encodes this by taking the server bot as an explicit, checked-first input
// rather than leaving callers to reconcile the two themselves.

import type { ServerBot } from "../app/api.ts";
import { BOTS } from "../nav/botRegistry.ts";
import type { BotsState, CustomBotState } from "../store/types.ts";

/** How a pilot is currently being flown by a bot, or that nothing is. */
export type RunMode = "tab" | "server" | "none";

/** One pilot row's run state, ready to render. */
export interface PilotRunState {
  readonly mode: RunMode;
  /** What is flying: a saved script's name, or a built-in bot's name. */
  readonly botName: string | null;
  /** Plain player language (R9a) — never a raw state token like "error". */
  readonly statusWords: string;
  /** One line: why it is paused, what phase it is in, or why it last acted. Null if there is nothing to add. */
  readonly detail: string | null;
}

// --- status wording ----------------------------------------------------------
//
// Two separate mappings, not one, because a server bot's status carries a
// value ("starting") the in-tab runner never reports (CustomBotReadout has no
// equivalent — a tab bot is either running by the time the store learns about
// it, or it never started). Collapsing them into one function would either
// invent a "starting" state for tab bots or silently drop it for server ones.

function customStatusWords(status: CustomBotState["status"]): string {
  if (status === "running") {
    return "Running";
  }
  if (status === "paused") {
    return "Paused";
  }
  if (status === "error") {
    return "Stopped after a problem";
  }
  // "idle" / "stopped" here means the store's runningBotID and the custom-bot
  // slice have drifted — reachable only as a defensive fallback, since a
  // caller only reaches this path when runningBotID === "custom". Still an
  // honest sentence rather than a raw token.
  return "Not running";
}

function serverStatusWords(status: string): string {
  if (status === "starting") {
    return "Starting";
  }
  if (status === "running") {
    return "Running";
  }
  if (status === "paused") {
    return "Paused";
  }
  if (status === "error") {
    return "Stopped after a problem";
  }
  // Anything else (a clean stop, a runtime cap) reads as "Finished" — the same
  // wording ServerBots.svelte already uses for the same case.
  return "Finished";
}

/**
 * One line worth showing under the status word, picked from whichever of
 * phase / why / pause-reason is present. Pause reason wins when several are
 * set, because it is the most actionable of the three: it is the thing
 * stopping the bot from doing anything else right now, and a player reading
 * one line wants that before a stage name or a rung's own reasoning.
 */
function oneLineDetail(fields: {
  readonly phase: string | null;
  readonly why: string | null;
  readonly pauseReason: string | null;
}): string | null {
  return fields.pauseReason ?? fields.phase ?? fields.why ?? null;
}

// --- tab reading ---------------------------------------------------------

/**
 * The IN-THIS-TAB reading for one pilot: what `bots.runningBotID` and
 * `customBot` say, with no knowledge of any server bot. Callers that need the
 * honest combined answer should use `pilotRunState` instead — this exists on
 * its own because a caller may already know no server bot applies (or is
 * itself the thing computing whether one does).
 */
export function tabRunState(bots: BotsState, customBot: CustomBotState): PilotRunState {
  const running = bots.runningBotID;
  if (running === null) {
    // ⚠ "none" MUST NOT INVENT A STATUS LIKE "stopped". A released customBot
    // slice can still carry a finished run's leftover phase/why text, but
    // `runningBotID` is the store's own claim ledger (`syncBotClaim` in
    // clientStore.ts) and is the thing to trust — when it says nobody holds
    // the ship, the row says exactly that and nothing more.
    return { mode: "none", botName: null, statusWords: "Nothing is running", detail: null };
  }
  if (running === "custom") {
    return {
      mode: "tab",
      botName: customBot.name ?? "Your bot",
      statusWords: customStatusWords(customBot.status),
      detail: oneLineDetail(customBot),
    };
  }
  // A built-in bot (mining/mission). Its player-facing name comes from the
  // registry — never retyped here as a string literal — so a renamed bot in
  // botRegistry.ts is renamed everywhere at once.
  //
  // No phase/why/detail: those live in MiningBotState/MissionBotState, which
  // this function deliberately does not take (see the module doc). A built-in
  // bot's pilot row is name + "Running" only; a caller wanting the fuller
  // readout already has the real component for that (MiningBot.svelte /
  // MissionBot.svelte), and this module does not duplicate it.
  const descriptor = BOTS.find((entry) => entry.id === running);
  return {
    mode: "tab",
    botName: descriptor?.name ?? null,
    statusWords: "Running",
    detail: null,
  };
}

// --- server reading --------------------------------------------------------

/** The ON-THE-SERVER reading for one pilot, from its `ServerBot` row. */
export function serverRunState(bot: ServerBot): PilotRunState {
  return {
    mode: "server",
    botName: bot.scriptName,
    statusWords: serverStatusWords(bot.status),
    detail: oneLineDetail(bot),
  };
}

/**
 * The server bot currently flying `characterID`, or null when there is none.
 *
 * ⚠ ENDED BOTS DO NOT COUNT. `listServerBots` keeps returning a bot after it
 * stops (so its final readout/alert stays visible); `endedAt !== null` is a
 * finished run, not a claim on the character, and must not be read as one —
 * otherwise a character that finished a server run an hour ago would forever
 * shadow its own tab reading.
 */
export function serverBotFor(serverBots: readonly ServerBot[], characterID: number): ServerBot | null {
  return serverBots.find((bot) => bot.characterID === characterID && bot.endedAt === null) ?? null;
}

// --- the combined, honest answer -------------------------------------------

/**
 * The pilot row for one held session: the server's claim if it has one,
 * otherwise the tab's own reading. This is the one rule the module exists to
 * state once — see the "A SERVER BOT ALWAYS WINS" note at the top.
 */
export function pilotRunState(
  bots: BotsState,
  customBot: CustomBotState,
  serverBot: ServerBot | null,
): PilotRunState {
  if (serverBot !== null) {
    return serverRunState(serverBot);
  }
  return tabRunState(bots, customBot);
}

// --- pilots with no tab open -------------------------------------------------

/**
 * Server bots flying characters for which no tab session is held — the
 * pilots a player can see running but has no tab open for right now. Ended
 * bots are excluded (they are history, not a running pilot); see
 * `serverBotFor` for why `endedAt` is the signal rather than `status`.
 */
export function serverOnlyBots(
  serverBots: readonly ServerBot[],
  heldCharacterIDs: readonly number[],
): readonly ServerBot[] {
  const held = new Set(heldCharacterIDs);
  return serverBots.filter((bot) => bot.endedAt === null && !held.has(bot.characterID));
}
