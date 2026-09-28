"use strict";

// Goal R7: the BFF Local + Corp chat routes. GET /api/bridge/chat/:channel
// returns the held session's member roster + recent backlog; POST
// /api/bridge/chat/:channel/send broadcasts a message. Chat delivery bypasses
// the notification drain, so READ is a backlog poll (the panel polls while
// open). The BFF holds the bridgeSessionID server-side; the browser addresses
// channels by name. Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTERS = [{ characterID: 7, accountID: 4, characterName: "Test Pilot" }];
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

const LOCAL_CHAT = {
  channel: "local",
  roomName: "local_30000142",
  solarSystemID: 30000142,
  corporationID: null,
  roster: [
    { characterID: 7, corporationID: 98000000, name: "Test Pilot", solarSystemID: 30000142 },
    { characterID: 8, corporationID: 98000001, name: "Neighbor", solarSystemID: 30000142 },
  ],
  messages: [
    { characterID: 8, characterName: "Neighbor", message: "o7", createdAtMs: 1 },
  ],
};
const CORP_CHAT = {
  channel: "corp",
  roomName: "corp_98000000",
  solarSystemID: 30000142,
  corporationID: 98000000,
  roster: [{ characterID: 7, corporationID: 98000000, name: "Test Pilot" }],
  messages: [],
};

function fakeAuth() {
  return {
    createSessionToken() {
      return COOKIE_TOKEN;
    },
    verifySessionToken(token) {
      return token === COOKIE_TOKEN
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: SESSION_ID }
        : null;
    },
    countConfiguredUsers() {
      return 1;
    },
  };
}

function fakeStore() {
  return {
    async getAccount(username) {
      return username === ACCOUNT.username ? { ...ACCOUNT } : null;
    },
    async getCharacterForAccount(accountID, characterID) {
      return Number(accountID) === ACCOUNT.accountID &&
        CHARACTERS.some((c) => c.characterID === Number(characterID))
        ? { ...CHARACTERS[0] }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
  };
}

function fakeStaticData() {
  return { getStation() { return null; }, getTypeName(id) { return `Type ${id}`; } };
}

function fakeGateway(overrides = {}) {
  const calls = { select: [], read: [], send: [] };
  const gateway = {
    calls,
    async selectCharacter(args, kwargs, sessionFields) {
      calls.select.push({ args, kwargs, sessionFields });
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: 4,
          characterID: 7,
          characterName: "Test Pilot",
          stationID: 60003760,
          structureID: null,
          solarSystemID: 30000142,
          corporationID: 98000000,
          shipID: 9001,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: 7 };
    },
    async readChat(bridgeSessionID, channel, sessionFields, options) {
      calls.read.push({ bridgeSessionID, channel, sessionFields, options });
      return {
        chat: channel === "corp" ? CORP_CHAT : LOCAL_CHAT,
        notifications: [],
      };
    },
    async sendChat(bridgeSessionID, channel, message, sessionFields) {
      calls.send.push({ bridgeSessionID, channel, message, sessionFields });
      return {
        chat: {
          channel,
          roomName: channel === "corp" ? "corp_98000000" : "local_30000142",
          sent: true,
          entry: { characterID: 7, characterName: "Test Pilot", message, createdAtMs: 2 },
        },
        notifications: [],
      };
    },
    ...overrides,
  };
  return gateway;
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway || fakeGateway(),
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

async function selectOnServer(baseUrl) {
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
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

test("GET /api/bridge/chat/local returns the Local roster + backlog on the held session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.chat, LOCAL_CHAT);

  const read = gateway.calls.read.at(-1);
  assert.equal(read.channel, "local");
  assert.equal(read.bridgeSessionID, BRIDGE_SESSION_ID);
  assert.deepEqual(read.sessionFields, { userid: 4 });
});

test("GET /api/bridge/chat/corp returns the Corp roster + backlog on the held session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/corp");
  assert.equal(response.status, 200);
  assert.deepEqual(payload.chat, CORP_CHAT);
  assert.equal(gateway.calls.read.at(-1).channel, "corp");
});

test("POST /api/bridge/chat/local/send broadcasts the message on the held session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/local/send", {
    method: "POST",
    body: { message: "hello local" },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.chat.sent, true);
  assert.equal(payload.chat.entry.message, "hello local");

  const sent = gateway.calls.send.at(-1);
  assert.equal(sent.channel, "local");
  assert.equal(sent.message, "hello local");
  assert.equal(sent.bridgeSessionID, BRIDGE_SESSION_ID);
});

test("POST /api/bridge/chat/corp/send broadcasts to Corp", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/corp/send", {
    method: "POST",
    body: { message: "corp broadcast" },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.chat.channel, "corp");
  assert.equal(gateway.calls.send.at(-1).channel, "corp");
});

test("an unknown channel is rejected (400 INVALID_CHANNEL)", async () => {
  const { baseUrl } = await startTestServer();
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/alliance");
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_CHANNEL");
});

test("an empty message is rejected (400 EMPTY_MESSAGE)", async () => {
  const { baseUrl } = await startTestServer();
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/local/send", {
    method: "POST",
    body: { message: "   " },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "EMPTY_MESSAGE");
});

test("chat routes require a live session (409 NO_LIVE_SESSION with no character online)", async () => {
  const { baseUrl } = await startTestServer();
  const read = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(read.response.status, 409);
  assert.equal(read.payload.error, "NO_LIVE_SESSION");

  const send = await apiRequest(baseUrl, "/api/bridge/chat/local/send", {
    method: "POST",
    body: { message: "hi" },
  });
  assert.equal(send.response.status, 409);
  assert.equal(send.payload.error, "NO_LIVE_SESSION");
});

test("a lost live session unwinds (404 SESSION_NOT_FOUND) and drops the held session", async () => {
  const gateway = fakeGateway({
    async readChat() {
      const error = new Error("gone");
      error.code = "SESSION_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(response.status, 404);
  assert.equal(payload.error, "SESSION_NOT_FOUND");

  // Held session dropped: the next read reports no live session.
  const after = await apiRequest(baseUrl, "/api/bridge/chat/local");
  assert.equal(after.response.status, 409);
  assert.equal(after.payload.error, "NO_LIVE_SESSION");
});
