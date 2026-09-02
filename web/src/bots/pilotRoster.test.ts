import test from "node:test";
import assert from "node:assert/strict";

import {
  pilotRunState,
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
