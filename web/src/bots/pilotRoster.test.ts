import test from "node:test";
import assert from "node:assert/strict";

import {
  endedRuns,
  lastAlertPhrase,
  pilotRunState,
  RECENT_RUNS_ARE_NOT_DURABLE,
  runOutcomePhrase,
  serverBotFor,
  serverOnlyBots,
  serverRunState,
  tabRunState,
} from "./pilotRoster.ts";
import type { ServerBot } from "../app/api.ts";
import type { BotsState, CustomBotState } from "../store/types.ts";

// Synthetic identities only — no real EVE character name or id (per repo
// policy). 90000001 is ESI's own published example CharacterID.
const PILOT_ONE_ID = 90000001;
const PILOT_TWO_ID = 90000002;

function bots(over: Partial<BotsState> = {}): BotsState {
  return { runningBotID: null, ...over };
}

function customBot(over: Partial<CustomBotState> = {}): CustomBotState {
  return {
    status: "idle",
    name: null,
    phase: null,
    why: null,
    stepPath: null,
    interruptID: null,
    pauseReason: null,
    note: null,
    startError: null,
    lastAlert: null,
    ...over,
  };
}

function serverBot(over: Partial<ServerBot> = {}): ServerBot {
  return {
    botID: "bot-1",
    characterID: PILOT_ONE_ID,
    characterName: "Sample Pilot One",
    scriptID: "script-1",
    scriptName: "Belt loop",
    scriptRev: 1,
    scriptHash: "hash-1",
    restartSafe: true,
    riskClasses: [],
    maxRuntimeMinutes: 60,
    expiresAt: null,
    status: "running",
    phase: null,
    why: null,
    stepPath: null,
    pauseReason: null,
    note: null,
    startedAt: "2026-09-02T11:00:00.000Z",
    endedAt: null,
    resumedAt: null,
    lastAlert: null,
    ...over,
  };
}

// ─── the "none" case ─────────────────────────────────────────────────────────

test("no runningBotID and an idle customBot is honestly 'none', not a stopped bot", () => {
  const state = tabRunState(bots({ runningBotID: null }), customBot());
  assert.deepEqual(state, {
    mode: "none",
    botName: null,
    statusWords: "Nothing is running",
    detail: null,
  });
});

test("a released customBot slice with leftover phase/why text still reads as 'none'", () => {
  // runningBotID is the store's own claim ledger; a stale customBot slice
  // (from a run that already ended) must not resurrect a status.
  const state = tabRunState(
    bots({ runningBotID: null }),
    customBot({ status: "error", phase: "Docking", why: "ran out of fuel" }),
  );
  assert.equal(state.mode, "none");
  assert.equal(state.statusWords, "Nothing is running");
  assert.equal(state.detail, null);
});

// ─── the "tab" case: custom bot ──────────────────────────────────────────────

test("a running custom bot takes its name from customBot.name", () => {
  const state = tabRunState(
    bots({ runningBotID: "custom" }),
    customBot({ status: "running", name: "Ore run", phase: "Mining" }),
  );
  assert.equal(state.mode, "tab");
  assert.equal(state.botName, "Ore run");
  assert.equal(state.statusWords, "Running");
  assert.equal(state.detail, "Mining");
});

test("an unnamed custom bot falls back to 'Your bot'", () => {
  const state = tabRunState(bots({ runningBotID: "custom" }), customBot({ status: "running", name: null }));
  assert.equal(state.botName, "Your bot");
});

test("custom bot status words are plain language, never the raw token", () => {
  assert.equal(tabRunState(bots({ runningBotID: "custom" }), customBot({ status: "paused" })).statusWords, "Paused");
  assert.equal(
    tabRunState(bots({ runningBotID: "custom" }), customBot({ status: "error" })).statusWords,
    "Stopped after a problem",
  );
  const running = tabRunState(bots({ runningBotID: "custom" }), customBot({ status: "running" }));
  assert.equal(running.statusWords, "Running");
  // Never a raw token like "error" or "paused" reaching the caller directly.
  assert.notEqual(running.statusWords, "running");
});

test("custom bot detail prefers pause reason over phase over why", () => {
  const all = tabRunState(
    bots({ runningBotID: "custom" }),
    customBot({ status: "paused", phase: "Hauling", why: "hold is full", pauseReason: "waiting on your say-so" }),
  );
  assert.equal(all.detail, "waiting on your say-so");

  const phaseOnly = tabRunState(
    bots({ runningBotID: "custom" }),
    customBot({ status: "running", phase: "Hauling", why: "hold is full", pauseReason: null }),
  );
  assert.equal(phaseOnly.detail, "Hauling");

  const whyOnly = tabRunState(
    bots({ runningBotID: "custom" }),
    customBot({ status: "running", phase: null, why: "hold is full", pauseReason: null }),
  );
  assert.equal(whyOnly.detail, "hold is full");

  const none = tabRunState(
    bots({ runningBotID: "custom" }),
    customBot({ status: "running", phase: null, why: null, pauseReason: null }),
  );
  assert.equal(none.detail, null);
});

// ─── the "tab" case: built-in bots ───────────────────────────────────────────

test("the mining bot takes its name from botRegistry, never a hardcoded literal", () => {
  const state = tabRunState(bots({ runningBotID: "mining" }), customBot());
  assert.equal(state.mode, "tab");
  assert.equal(state.botName, "Mining bot");
  assert.equal(state.statusWords, "Running");
  // Built-in bots' phase/why live in slices this function does not take.
  assert.equal(state.detail, null);
});

test("the mission bot takes its name from botRegistry", () => {
  const state = tabRunState(bots({ runningBotID: "mission" }), customBot());
  assert.equal(state.botName, "Mission bot");
});

// ─── server reading ──────────────────────────────────────────────────────────

test("a server bot's name is its script name", () => {
  const state = serverRunState(serverBot({ scriptName: "Night shift mining" }));
  assert.equal(state.mode, "server");
  assert.equal(state.botName, "Night shift mining");
});

test("server bot status words cover every status, plainly", () => {
  assert.equal(serverRunState(serverBot({ status: "starting" })).statusWords, "Starting");
  assert.equal(serverRunState(serverBot({ status: "running" })).statusWords, "Running");
  assert.equal(serverRunState(serverBot({ status: "paused" })).statusWords, "Paused");
  assert.equal(serverRunState(serverBot({ status: "error" })).statusWords, "Stopped after a problem");
  assert.equal(serverRunState(serverBot({ status: "stopped" })).statusWords, "Finished");
});

test("server bot detail follows the same pause > phase > why precedence", () => {
  const state = serverRunState(
    serverBot({ phase: "Mining", why: "belt is clear", pauseReason: "dock-and-pause" }),
  );
  assert.equal(state.detail, "dock-and-pause");
});

// ─── serverBotFor ────────────────────────────────────────────────────────────

test("serverBotFor finds the still-running bot for a character", () => {
  const rows = [serverBot({ characterID: PILOT_ONE_ID }), serverBot({ botID: "bot-2", characterID: PILOT_TWO_ID })];
  const found = serverBotFor(rows, PILOT_ONE_ID);
  assert.equal(found?.botID, "bot-1");
});

test("serverBotFor returns null for a character with no server bot", () => {
  assert.equal(serverBotFor([serverBot({ characterID: PILOT_ONE_ID })], PILOT_TWO_ID), null);
});

test("serverBotFor ignores an ended bot — it is history, not a live claim", () => {
  const rows = [serverBot({ characterID: PILOT_ONE_ID, endedAt: "2026-09-02T10:00:00.000Z", status: "stopped" })];
  assert.equal(serverBotFor(rows, PILOT_ONE_ID), null);
});

// ─── pilotRunState: the server-wins precedence ───────────────────────────────

test("a server bot wins over a tab reading for the same character", () => {
  const tabSaysCustomIsRunning = bots({ runningBotID: "custom" });
  const staleCustomBot = customBot({ status: "running", name: "Old tab run", phase: "Mining" });
  const winner = serverBot({ characterID: PILOT_ONE_ID, scriptName: "Server-side run", status: "running" });

  const state = pilotRunState(tabSaysCustomIsRunning, staleCustomBot, winner);

  assert.equal(state.mode, "server");
  assert.equal(state.botName, "Server-side run");
});

test("with no server bot for the character, the tab reading is used", () => {
  const state = pilotRunState(
    bots({ runningBotID: "mining" }),
    customBot(),
    null,
  );
  assert.equal(state.mode, "tab");
  assert.equal(state.botName, "Mining bot");
});

test("server-wins holds even when the tab shows nothing running (release already landed)", () => {
  const winner = serverBot({ characterID: PILOT_ONE_ID, scriptName: "Server-side run" });
  const state = pilotRunState(bots({ runningBotID: null }), customBot(), winner);
  assert.equal(state.mode, "server");
  assert.equal(state.botName, "Server-side run");
});

// ─── serverOnlyBots ──────────────────────────────────────────────────────────

test("serverOnlyBots returns bots for characters with no tab session held", () => {
  const rows = [
    serverBot({ botID: "bot-1", characterID: PILOT_ONE_ID }),
    serverBot({ botID: "bot-2", characterID: PILOT_TWO_ID }),
  ];
  const result = serverOnlyBots(rows, [PILOT_ONE_ID]);
  assert.deepEqual(
    result.map((row) => row.botID),
    ["bot-2"],
  );
});

test("serverOnlyBots excludes an ended bot even for an un-held character", () => {
  const rows = [serverBot({ botID: "bot-1", characterID: PILOT_ONE_ID, endedAt: "2026-09-02T10:00:00.000Z" })];
  assert.deepEqual(serverOnlyBots(rows, []), []);
});

test("serverOnlyBots returns nothing when every server bot's character has a held tab", () => {
  const rows = [serverBot({ botID: "bot-1", characterID: PILOT_ONE_ID })];
  assert.deepEqual(serverOnlyBots(rows, [PILOT_ONE_ID]), []);
});

// ─── endedRuns ───────────────────────────────────────────────────────────────

test("endedRuns keeps only bots with an endedAt — a running bot is not history", () => {
  const rows = [
    serverBot({ botID: "bot-1", status: "running", endedAt: null }),
    serverBot({ botID: "bot-2", status: "stopped", endedAt: "2026-09-02T10:00:00.000Z" }),
  ];
  const result = endedRuns(rows, 10);
  assert.deepEqual(result.map((row) => row.botID), ["bot-2"]);
});

test("endedRuns sorts newest-ended first", () => {
  const rows = [
    serverBot({ botID: "older", endedAt: "2026-09-02T09:00:00.000Z" }),
    serverBot({ botID: "newest", endedAt: "2026-09-02T11:00:00.000Z" }),
    serverBot({ botID: "middle", endedAt: "2026-09-02T10:00:00.000Z" }),
  ];
  const result = endedRuns(rows, 10);
  assert.deepEqual(
    result.map((row) => row.botID),
    ["newest", "middle", "older"],
  );
});

test("endedRuns caps to the given limit after sorting", () => {
  const rows = [
    serverBot({ botID: "a", endedAt: "2026-09-02T09:00:00.000Z" }),
    serverBot({ botID: "b", endedAt: "2026-09-02T11:00:00.000Z" }),
    serverBot({ botID: "c", endedAt: "2026-09-02T10:00:00.000Z" }),
  ];
  const result = endedRuns(rows, 2);
  assert.deepEqual(
    result.map((row) => row.botID),
    ["b", "c"],
  );
});

test("endedRuns does not throw on a malformed endedAt, and does not let it sort to the top", () => {
  const rows = [
    serverBot({ botID: "good", endedAt: "2026-09-02T10:00:00.000Z" }),
    serverBot({ botID: "garbled", endedAt: "not-a-real-timestamp" }),
  ];
  const result = endedRuns(rows, 10);
  assert.deepEqual(
    result.map((row) => row.botID),
    ["good", "garbled"],
  );
});

// ─── runOutcomePhrase ────────────────────────────────────────────────────────

test("runOutcomePhrase distinguishes finished-on-its-own, stopped, and stopped-after-a-problem", () => {
  assert.equal(runOutcomePhrase(serverBot({ status: "idle" })), "Finished on its own");
  assert.equal(runOutcomePhrase(serverBot({ status: "stopped" })), "Stopped");
  assert.equal(runOutcomePhrase(serverBot({ status: "error" })), "Stopped after a problem");
});

test("a stopped run never claims WHO stopped it", () => {
  // botHost sets status "stopped" both for a player's Stop and for its own
  // run-time cap (it writes the reason into `why`, not the status), so naming a
  // cause here would be a false statement in the cap case. History is the last
  // place to guess: the strip shows `why` alongside, and the server writes that.
  const phrase = runOutcomePhrase(serverBot({ status: "stopped" }));
  assert.doesNotMatch(phrase, /player|you|cap|time/i);
});

test("runOutcomePhrase never surfaces a raw status token", () => {
  const phrase = runOutcomePhrase(serverBot({ status: "idle" }));
  assert.notEqual(phrase, "idle");
  assert.notEqual(phrase, "stopped");
});

test("runOutcomePhrase says so when the server resumed the run after a restart", () => {
  const phrase = runOutcomePhrase(
    serverBot({ status: "error", resumedAt: "2026-09-02T09:30:00.000Z" }),
  );
  assert.equal(phrase, "Stopped after a problem (resumed after a server restart)");
});

test("runOutcomePhrase without a resumedAt carries no restart mention", () => {
  const phrase = runOutcomePhrase(serverBot({ status: "idle", resumedAt: null }));
  assert.equal(phrase, "Finished on its own");
});

// ─── lastAlertPhrase ─────────────────────────────────────────────────────────

test("lastAlertPhrase is null when the bot never alerted", () => {
  assert.equal(lastAlertPhrase(serverBot({ lastAlert: null }), 1_000_000), null);
});

test("lastAlertPhrase includes the message and a relative age", () => {
  const nowMs = 1_000_000;
  const bot = serverBot({ lastAlert: { message: "Cargo hold is full", atMs: nowMs - 5 * 60_000 } });
  assert.equal(lastAlertPhrase(bot, nowMs), "Cargo hold is full (5 minutes ago)");
});

test("lastAlertPhrase says 'just now' for a very recent alert", () => {
  const nowMs = 1_000_000;
  const bot = serverBot({ lastAlert: { message: "Low on ammo", atMs: nowMs - 2_000 } });
  assert.equal(lastAlertPhrase(bot, nowMs), "Low on ammo (just now)");
});

// ─── the not-durable caveat ──────────────────────────────────────────────────

test("the recent-runs caveat is exported once, and says the history is not durable", () => {
  assert.match(RECENT_RUNS_ARE_NOT_DURABLE, /restart/i);
});
