"use strict";

// The server-side bot routes' HANDOVER contract: POST /api/bots/start moves
// the hull in ONE request. When the CALLER's own web session is flying the
// requested character, the route releases that session BEFORE the bot host
// starts — so the instant the request answers, the bot exists and the
// login/select screens' bot-flying marks are right on their first read. Any
// other session's hull is never touched here (the host's own CHARACTER_IN_USE
// check still refuses those).
//
// The bot HOST itself is faked (its engine is covered by src/botHost.test.js
// and live drills); these tests pin the ROUTE's behavior around it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

process.env.EVEJS_WEB_POC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-bots-"));

const webAuth = require("../src/webAuth");
const { createApp } = require("../src/server");

const FARMER = { username: "farmer", accountID: 4001, role: "0", banned: false };
const CHARACTERS = [
  { characterID: 7001, accountID: 4001, characterName: "Ore Farmer" },
  { characterID: 7002, accountID: 4001, characterName: "Second Pilot" },
];
const GRANT = { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 720 };

const activeServers = new Set();

function fakeStore() {
  return {
    async getAccount(username) {
      return String(username) === FARMER.username ? { ...FARMER } : null;
    },
    async listCharactersForAccount(accountID) {
      return Number(accountID) === FARMER.accountID ? CHARACTERS.map((row) => ({ ...row })) : [];
    },
    async getCharacterForAccount(accountID, characterID) {
      if (Number(accountID) !== FARMER.accountID) {
        return null;
      }
      const row = CHARACTERS.find((entry) => entry.characterID === Number(characterID));
      return row ? { ...row } : null;
    },
  };
}

function fakeGateway(log) {
  return {
    async selectCharacter(args) {
      const characterID = Number(args[0]);
      return {
        bridgeSessionID: `bridge-for-${characterID}`,
        session: { characterID, characterName: "x", stationID: 60000004, solarSystemID: 30000001, corporationID: 1000001 },
        notifications: [],
      };
    },
    async releaseBridgeSession(bridgeSessionID) {
      log.push(["release", bridgeSessionID]);
      return { released: true };
    },
    async callMethod(service, method) {
      return { service, method, result: {}, notifications: [] };
    },
    openSessionEventStream(options) {
      return { ...options, close() {} };
    },
  };
}

function fakeBotHost(log) {
  return {
    async start(input) {
      log.push(["start", input.characterID]);
      return {
        ok: true,
        bot: { botID: "bot-1", characterID: input.characterID, status: "running", startedAt: "now" },
      };
    },
    async stop() {
      return { ok: false, code: "BOT_NOT_FOUND" };
    },
    list: () => [],
    claimedBy: () => null,
    authorizesClaim: () => false,
    activeCharacterIDs: () => [7001],
    activeBots: () => [
      { characterID: 7001, status: "running", phase: "Mining", why: null, note: null, vitals: null },
    ],
    sampleAllVitals: async () => {},
    resume: async () => {},
    stopAll: async () => {},
  };
}

async function startTestServer(log, suppliedBotHost = null) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: fakeGateway(log),
    webAuth,
    botHost: suppliedBotHost || fakeBotHost(log),
    // The script library is platform-wide, so get() looks up by scriptID alone
    // and every account sees the same record; `authorAccountID` is display-only
    // and grants nothing. AUTHORITY over the hull is still per-account, and the
    // route proves it through getCharacterForAccount above, not through here.
    botScriptStore: {
      get: (scriptID) =>
        scriptID === "s1"
          ? {
              scriptID: "s1",
              authorAccountID: FARMER.accountID,
              authorName: FARMER.username,
              name: "Miner",
              rev: 1,
              doc: { format: "evejs-bot-script" },
            }
          : null,
      list: () => [],
    },
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, app };
}

test.after(() => {
  for (const server of activeServers) {
    server.close();
  }
});

async function request(baseUrl, routePath, { method = "GET", token, body, headers: suppliedHeaders = {} } = {}) {
  const headers = { "content-type": "application/json", ...suppliedHeaders };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function signInAndSelect(baseUrl, characterID) {
  const login = await request(baseUrl, "/api/login", {
    method: "POST",
    body: { username: FARMER.username, password: "x" },
  });
  const token = login.payload.sessionToken;
  await request(baseUrl, "/api/bridge/select", { method: "POST", token, body: { characterID } });
  return token;
}

test("run-on-server releases the CALLER's held hull before the bot starts", async () => {
  const log = [];
  const { baseUrl, app } = await startTestServer(log);
  const token = await signInAndSelect(baseUrl, 7001);
  assert.equal(app.locals.bridgeSessions.size, 1);

  const { response, payload } = await request(baseUrl, "/api/bots/start", {
    method: "POST",
    token,
    body: { characterID: 7001, scriptID: "s1", grant: GRANT },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.bot.characterID, 7001);
  // The caller's session is gone, and it was gone BEFORE the host started.
  assert.equal(app.locals.bridgeSessions.size, 0);
  assert.deepEqual(
    log.filter((row) => row[0] !== "start" || true).map((row) => row[0]),
    ["release", "start"],
  );
});

test("a caller flying a DIFFERENT character keeps their hull", async () => {
  const log = [];
  const { baseUrl, app } = await startTestServer(log);
  const token = await signInAndSelect(baseUrl, 7001);

  const { response } = await request(baseUrl, "/api/bots/start", {
    method: "POST",
    token,
    body: { characterID: 7002, scriptID: "s1", grant: GRANT },
  });
  assert.equal(response.status, 200);
  // No release happened; the caller still flies 7001.
  assert.equal(app.locals.bridgeSessions.size, 1);
  assert.deepEqual(log.map((row) => row[0]), ["start"]);
});

test("/api/bots/active answers WITHOUT auth: ids + game-state rows, nothing controllable", async () => {
  const { baseUrl } = await startTestServer([]);
  const { response, payload } = await request(baseUrl, "/api/bots/active");
  assert.equal(response.status, 200);
  assert.deepEqual(payload.characterIDs, [7001]);
  assert.equal(payload.bots.length, 1);
  assert.equal(payload.bots[0].characterID, 7001);
  assert.equal(payload.bots[0].phase, "Mining");
  // No handle a caller could act on, and no account/script identity.
  assert.equal("botID" in payload.bots[0], false);
  assert.equal("scriptID" in payload.bots[0], false);
  assert.equal("accountID" in payload.bots[0], false);
});

test("a public bot ID cannot bypass the claimed-character select guard", async () => {
  const log = [];
  const host = {
    ...fakeBotHost(log),
    claimedBy: (characterID) => (Number(characterID) === 7001 ? "public-bot-id" : null),
    authorizesClaim: (characterID, secret) => Number(characterID) === 7001 && secret === "private-capability",
  };
  const { baseUrl } = await startTestServer(log, host);
  const login = await request(baseUrl, "/api/login", {
    method: "POST",
    body: { username: FARMER.username, password: "x" },
  });
  const token = login.payload.sessionToken;

  const refused = await request(baseUrl, "/api/bridge/select", {
    method: "POST",
    token,
    headers: { "x-evejs-bot-claim": "public-bot-id" },
    body: { characterID: 7001 },
  });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.payload.error, "CHARACTER_IN_USE_BY_BOT");

  const authorized = await request(baseUrl, "/api/bridge/select", {
    method: "POST",
    token,
    headers: { "x-evejs-bot-claim": "private-capability" },
    body: { characterID: 7001 },
  });
  assert.equal(authorized.response.status, 200);
});
