"use strict";

// The BFF's shared belt-memory routes (goal: mine-ore-priority). Both routes
// are pure BFF-local bookkeeping — no gateway call either way — so, like
// test/staticAssetsFailClosed.test.js, this fakes just enough to get past
// requireAuth and never touches a gateway or a character selection.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { createApp } = require("../src/server");
const { createBeltMemory } = require("../src/beltMemory");

const COOKIE_TOKEN = "belt-memory-test-cookie";
const WEB_SESSION_ID = "belt-memory-test-web-session";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const activeServers = new Set();

function fakeAuth() {
  return {
    verifySessionToken(token) {
      return token === COOKIE_TOKEN
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: WEB_SESSION_ID }
        : null;
    },
    createSessionToken() {
      return COOKIE_TOKEN;
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
  };
}

async function startTestServer(beltMemory) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: {},
    webAuth: fakeAuth(),
    staticData: {},
    beltMemory,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function apiRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      cookie: `evejs_web_poc=${COOKIE_TOKEN}`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

test.afterEach(async () => {
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  }
  await Promise.all(closing);
});

test("an unauthenticated read is refused", async () => {
  const baseUrl = await startTestServer(createBeltMemory());
  const response = await fetch(`${baseUrl}/api/bots/belt-memory?system=Jita`);
  assert.equal(response.status, 401);
});

test("reading with no system name is a 400", async () => {
  const baseUrl = await startTestServer(createBeltMemory());
  const { response, payload } = await apiRequest(baseUrl, "/api/bots/belt-memory");
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_SYSTEM");
});

test("reading an unknown system answers an empty list", async () => {
  const baseUrl = await startTestServer(createBeltMemory());
  const { response, payload } = await apiRequest(baseUrl, "/api/bots/belt-memory?system=Jita");
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, system: "Jita", belts: [] });
});

test("a mark posted for one system shows up only for that system", async () => {
  const baseUrl = await startTestServer(createBeltMemory());

  const marked = await apiRequest(baseUrl, "/api/bots/belt-memory", {
    method: "POST",
    body: { system: "Jita", beltName: "Belt - 1", groupID: null },
  });
  assert.equal(marked.response.status, 200);
  assert.deepEqual(marked.payload, { ok: true });

  const jita = await apiRequest(baseUrl, "/api/bots/belt-memory?system=Jita");
  assert.deepEqual(jita.payload.belts, [{ beltName: "Belt - 1", all: true, families: [] }]);

  const amarr = await apiRequest(baseUrl, "/api/bots/belt-memory?system=Amarr");
  assert.deepEqual(amarr.payload.belts, []);
});

test("marking one ore family dry records only that family", async () => {
  const baseUrl = await startTestServer(createBeltMemory());

  await apiRequest(baseUrl, "/api/bots/belt-memory", {
    method: "POST",
    body: { system: "Jita", beltName: "Belt - 1", groupID: 465 },
  });

  const { payload } = await apiRequest(baseUrl, "/api/bots/belt-memory?system=Jita");
  assert.deepEqual(payload.belts, [{ beltName: "Belt - 1", all: false, families: [465] }]);
});

test("a write missing system or beltName is a 400 and marks nothing", async () => {
  const baseUrl = await startTestServer(createBeltMemory());

  const noSystem = await apiRequest(baseUrl, "/api/bots/belt-memory", {
    method: "POST",
    body: { beltName: "Belt - 1", groupID: null },
  });
  assert.equal(noSystem.response.status, 400);
  assert.equal(noSystem.payload.error, "INVALID_BELT");

  const noBelt = await apiRequest(baseUrl, "/api/bots/belt-memory", {
    method: "POST",
    body: { system: "Jita", groupID: null },
  });
  assert.equal(noBelt.response.status, 400);
  assert.equal(noBelt.payload.error, "INVALID_BELT");

  const { payload } = await apiRequest(baseUrl, "/api/bots/belt-memory?system=Jita");
  assert.deepEqual(payload.belts, []);
});

test("a non-positive groupID is a 400", async () => {
  const baseUrl = await startTestServer(createBeltMemory());

  const { response, payload } = await apiRequest(baseUrl, "/api/bots/belt-memory", {
    method: "POST",
    body: { system: "Jita", beltName: "Belt - 1", groupID: -1 },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_GROUP");
});
