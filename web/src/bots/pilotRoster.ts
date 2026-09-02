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

// --- recent runs (region C) --------------------------------------------------
//
// The same subject as everything above, seen after the fact: a run that used
// to be "on the server" and now isn't. `listServerBots()` keeps an ended
// record around (see `serverBotFor`'s note) purely so this strip has
// something to show — this section is what turns that leftover record into
// plain words for a history line rather than a live status line.

/**
 * Recent-runs strips must say this, not imply a durable log: botHost.js keeps
 * ended runs in memory only, as a deliberate choice — `data/server-bots.json`
 * stays "what to resume", nothing more — so a restart empties this strip.
 * Exported once here so no caller re-derives (or forgets) the caveat.
 */
export const RECENT_RUNS_ARE_NOT_DURABLE =
  "Recent runs are remembered only until the server restarts — nothing here is saved.";

/**
 * `endedAt` parsed to a sortable instant. A malformed or unparseable value
 * must not throw, and must not be mistaken for "just ended" (which would
 * float garbage to the top of a newest-first list) — so it sorts as the
 * oldest possible run instead.
 */
function endedAtMs(endedAt: string): number {
  const parsed = Date.parse(endedAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** Ended runs, newest first, capped. Running bots are not history. */
export function endedRuns(serverBots: readonly ServerBot[], limit: number): readonly ServerBot[] {
  const cap = Math.max(0, limit);
  return serverBots
    .filter((bot): bot is ServerBot & { endedAt: string } => bot.endedAt !== null)
    .slice()
    .sort((a, b) => endedAtMs(b.endedAt) - endedAtMs(a.endedAt))
    .slice(0, cap);
}

/**
 * How a run ended, in plain words. Reuses `serverStatusWords`' vocabulary for
 * "error" rather than inventing a second one, but — unlike that function,
 * which is written for a bot that might still be running — assumes `bot` has
 * already ended, so it distinguishes the three ways an ended run got there
 * instead of collapsing them into one "Finished" word.
 *
 * `status` is "idle" when the bot's own run loop reached its natural end,
 * "error" when it stopped after a problem, and "stopped" for every
 * server-initiated stop — a player's Stop click and the run-time-cap timeout
 * both set the same status (see botHost.js's `stop()` and its deadline
 * timer), and `ServerBot` carries no field that tells them apart. So this says
 * only "Stopped" — the bare fact both cases share. Naming a cause we cannot
 * read would be a plain false statement in the common-enough case where the
 * server's run-time cap ended it, and history is exactly where a player goes to
 * find out what actually happened. `bot.why` carries the real reason ("The
 * approved run time ended, so the server stopped this bot.") and the strip
 * shows it alongside; that is where the distinction belongs, because the server
 * writes it rather than the UI guessing it.
 */
export function runOutcomePhrase(bot: ServerBot): string {
  const outcome =
    bot.status === "error"
      ? "Stopped after a problem"
      : bot.status === "idle"
        ? "Finished on its own"
        : bot.status === "stopped"
          ? "Stopped"
          : // Not reachable for a genuinely ended run (see ENDED_STATUSES in
            // botHost.js), but an honest sentence beats a raw token if one
            // ever gets here.
            "Finished";
  if (bot.resumedAt !== null) {
    // "It ran twice" is exactly the kind of thing a player needs to know
    // when reading history — the server restarted mid-run and picked this
    // bot back up before it reached the outcome above.
    return `${outcome} (resumed after a server restart)`;
  }
  return outcome;
}

/**
 * The last alert a server bot raised, worded for the history strip's "last
 * alert" column — null when it never alerted. A server bot has no browser to
 * notify, so `bot.lastAlert` is the only notification it ever gives; this
 * keeps the wording in one place rather than each caller re-deciding how to
 * phrase "how long ago". `nowMs` is a parameter, not `Date.now()`, matching
 * this module's rule of owning no clock of its own.
 */
export function lastAlertPhrase(bot: ServerBot, nowMs: number): string | null {
  if (bot.lastAlert === null) {
    return null;
  }
  const ageMs = Math.max(0, nowMs - bot.lastAlert.atMs);
  const ageWords = ageWordsFor(ageMs);
  return `${bot.lastAlert.message} (${ageWords})`;
}

/** "just now" / "N minutes ago" / "N hours ago" — same buckets ServerBots.svelte uses for the same fact, minus the direct clock read. */
function ageWordsFor(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}
