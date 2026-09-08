"use strict";

// The bot log's two routes. Pure BFF-local bookkeeping like the belt memory and
// the squad board — no gateway call either way — so this fakes just enough to
// get past requireAuth and seeds the held sessions directly.
//
// The rule under test is the same one the squad board keeps: the character is
// the SESSION's, never the body's. A body-supplied characterID would let any
// signed-in account write lines into another pilot's log, or read one.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { createApp } = require("../src/server");
const { createBotLogStore } = require("../src/botLogStore");

const COOKIE_A = "bot-log-a-cookie";
const COOKIE_B = "bot-log-b-cookie";
const SESSION_A = "bot-log-a-session";
const SESSION_B = "bot-log-b-session";
const ACCOUNT_A = { username: "a", accountID: 4, role: "0", banned: false };
const ACCOUNT_B = { username: "b", accountID: 5, role: "0", banned: false };
// ESI's own documented example character ids.
const CHAR_A = 90000001;
const CHAR_B = 90000002;

const SESSIONS = {
  [COOKIE_A]: { account: ACCOUNT_A, sessionID: SESSION_A },
  [COOKIE_B]: { account: ACCOUNT_B, sessionID: SESSION_B },
};

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

function fakeAuth() {
  return {
    verifySessionToken(token) {
      const row = SESSIONS[token];
      return row ? { username: row.account.username, accountID: row.account.accountID, sessionID: row.sessionID } : null;
    },
    createSessionToken() {
      return COOKIE_A;
    },
    countConfiguredUsers() {
      return 2;
    },
  };
}

function fakeStore() {
  return {
    async getAccount(username) {
      const found = [ACCOUNT_A, ACCOUNT_B].find((a) => a.username === username);
      return found ? { ...found } : null;
    },
  };
}

function heldSession(characterID) {
  return {
    bridgeSessionID: `bridge:${characterID}`,
    characterID,
    accountID: 4,
    boundHandles: new Map(),
    transition: null,
    streamSubscribers: new Set(),
  };
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: {},
    webAuth: fakeAuth(),
    staticData: {},
    bridgeSessionStore: options.bridgeSessions,
    botLogStore: options.botLogStore,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function apiRequest(baseUrl, route, options = {}) {
  const response = await ORIGINAL_FETCH(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers: { "content-type": "application/json", cookie: `evejs_web_poc=${options.cookie || COOKIE_A}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  }
  await Promise.all(closing);
});

/** A store that records what it was asked to do, so the routes can be checked alone. */
function recordingStore() {
  const appended = [];
  const byCharacter = new Map();
  return {
    appended,
    append(characterID, entries) {
      appended.push({ characterID, entries });
      byCharacter.set(characterID, [...(byCharacter.get(characterID) ?? []), ...entries]);
      return entries.length;
    },
    read(characterID, which) {
      return which === "previous" ? [] : (byCharacter.get(characterID) ?? []);
    },
    stats() {
      return { dropped: 0 };
    },
  };
}

function sessions() {
  return new Map([
    [SESSION_A, heldSession(CHAR_A)],
    [SESSION_B, heldSession(CHAR_B)],
  ]);
}

test("an unauthenticated write is refused", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: sessions(), botLogStore: recordingStore() });
  const response = await ORIGINAL_FETCH(`${baseUrl}/api/bots/bot-log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: [] }),
  });
  assert.equal(response.status, 401);
});

test("with no character online there is no log to write to", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: new Map(), botLogStore: recordingStore() });
  const { response, payload } = await apiRequest(baseUrl, "/api/bots/bot-log", { method: "POST", body: { entries: [] } });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_LIVE_SESSION");
});

test("lines are filed under the SESSION's character, whatever the body says", async () => {
  const store = recordingStore();
  const baseUrl = await startTestServer({ bridgeSessions: sessions(), botLogStore: store });

  const { response, payload } = await apiRequest(baseUrl, "/api/bots/bot-log", {
    method: "POST",
    cookie: COOKIE_A,
    body: { characterID: CHAR_B, entries: [{ kind: "start", run: "r1" }] },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.written, 1);
  assert.deepEqual(store.appended.map((a) => a.characterID), [CHAR_A], "a body characterID must not choose the log");
});

test("a pilot reads their own log, and only their own", async () => {
  const store = recordingStore();
  const baseUrl = await startTestServer({ bridgeSessions: sessions(), botLogStore: store });
  await apiRequest(baseUrl, "/api/bots/bot-log", {
    method: "POST", cookie: COOKIE_A, body: { entries: [{ kind: "start", run: "r1", script: "Miner" }] },
  });

  const mine = await apiRequest(baseUrl, "/api/bots/bot-log", { cookie: COOKIE_A });
  assert.equal(mine.payload.characterID, CHAR_A);
  assert.deepEqual(mine.payload.lines.map((l) => l.script), ["Miner"]);

  const theirs = await apiRequest(baseUrl, "/api/bots/bot-log", { cookie: COOKIE_B });
  assert.equal(theirs.payload.characterID, CHAR_B);
  assert.deepEqual(theirs.payload.lines, [], "another account's log is not readable from here");
});

test("the previous run is asked for by name", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: sessions(), botLogStore: recordingStore() });
  const { payload } = await apiRequest(baseUrl, "/api/bots/bot-log?which=previous");
  assert.equal(payload.which, "previous");
  assert.deepEqual(payload.lines, []);
});

test("entries that are not a list are refused, and nothing is written", async () => {
  const store = recordingStore();
  const baseUrl = await startTestServer({ bridgeSessions: sessions(), botLogStore: store });
  const { response, payload } = await apiRequest(baseUrl, "/api/bots/bot-log", { method: "POST", body: { entries: "nope" } });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_ENTRIES");
  assert.deepEqual(store.appended, []);
});

test("a giant batch is capped rather than accepted whole", async () => {
  const store = recordingStore();
  const baseUrl = await startTestServer({ bridgeSessions: sessions(), botLogStore: store });
  const entries = Array.from({ length: 900 }, (_, i) => ({ kind: "decide", run: "r1", why: `line ${i}` }));
  const { response } = await apiRequest(baseUrl, "/api/bots/bot-log", { method: "POST", body: { entries } });
  assert.equal(response.status, 200);
  assert.equal(store.appended[0].entries.length, 500);
});
