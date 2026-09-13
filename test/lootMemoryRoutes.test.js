"use strict";

// The BFF's shared loot-memory routes (goal: stop flying to wrecks with nothing
// in them). Both routes are pure BFF-local bookkeeping — no gateway call either
// way — so, like test/beltMemoryRoutes.test.js, this fakes just enough to get
// past requireAuth and never touches a gateway or a character selection.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { createApp } = require("../src/server");
const { createLootMemory } = require("../src/lootMemory");

const COOKIE_TOKEN = "loot-memory-test-cookie";
const WEB_SESSION_ID = "loot-memory-test-web-session";
const ACCOUNT = { username: "pilot", accountID: 7, role: "0", banned: false };
const SYSTEM = 30000144;
const OTHER_SYSTEM = 30000142;
const WRECK_ID = 80020;
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

async function startTestServer(lootMemory) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: {},
    webAuth: fakeAuth(),
    staticData: {},
    lootMemory,
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
  const baseUrl = await startTestServer(createLootMemory());
  const response = await fetch(`${baseUrl}/api/bots/loot-memory?system=${SYSTEM}`);
  assert.equal(response.status, 401);
});

test("reading with no system is a 400", async () => {
  const baseUrl = await startTestServer(createLootMemory());
  const { response, payload } = await apiRequest(baseUrl, "/api/bots/loot-memory");
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_SYSTEM");
});

test("reading an unknown system answers an empty list", async () => {
  const baseUrl = await startTestServer(createLootMemory());
  const { response, payload } = await apiRequest(baseUrl, `/api/bots/loot-memory?system=${SYSTEM}`);
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, system: SYSTEM, itemIDs: [] });
});

test("a can marked empty in one system shows up only for that system", async () => {
  const baseUrl = await startTestServer(createLootMemory());

  const marked = await apiRequest(baseUrl, "/api/bots/loot-memory", {
    method: "POST",
    body: { system: SYSTEM, itemID: WRECK_ID },
  });
  assert.equal(marked.response.status, 200);
  assert.deepEqual(marked.payload, { ok: true });

  const here = await apiRequest(baseUrl, `/api/bots/loot-memory?system=${SYSTEM}`);
  assert.deepEqual(here.payload.itemIDs, [WRECK_ID]);

  const elsewhere = await apiRequest(baseUrl, `/api/bots/loot-memory?system=${OTHER_SYSTEM}`);
  assert.deepEqual(elsewhere.payload.itemIDs, []);
});

test("a write missing the system or the itemID is a 400 and marks nothing", async () => {
  const baseUrl = await startTestServer(createLootMemory());

  const noSystem = await apiRequest(baseUrl, "/api/bots/loot-memory", {
    method: "POST",
    body: { itemID: WRECK_ID },
  });
  assert.equal(noSystem.response.status, 400);
  assert.equal(noSystem.payload.error, "INVALID_CONTAINER");

  const noItem = await apiRequest(baseUrl, "/api/bots/loot-memory", {
    method: "POST",
    body: { system: SYSTEM },
  });
  assert.equal(noItem.response.status, 400);
  assert.equal(noItem.payload.error, "INVALID_CONTAINER");

  const { payload } = await apiRequest(baseUrl, `/api/bots/loot-memory?system=${SYSTEM}`);
  assert.deepEqual(payload.itemIDs, []);
});

test("a non-positive itemID is refused rather than stored", async () => {
  const baseUrl = await startTestServer(createLootMemory());

  const { response, payload } = await apiRequest(baseUrl, "/api/bots/loot-memory", {
    method: "POST",
    body: { system: SYSTEM, itemID: -1 },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_CONTAINER");
});

test("every pilot on this BFF reads the same board", async () => {
  // One instance, two callers: the point of the module. The second pilot's read
  // carries what the first pilot's trip found out.
  const baseUrl = await startTestServer(createLootMemory());

  await apiRequest(baseUrl, "/api/bots/loot-memory", {
    method: "POST",
    body: { system: SYSTEM, itemID: WRECK_ID },
  });
  await apiRequest(baseUrl, "/api/bots/loot-memory", {
    method: "POST",
    body: { system: SYSTEM, itemID: WRECK_ID + 1 },
  });

  const { payload } = await apiRequest(baseUrl, `/api/bots/loot-memory?system=${SYSTEM}`);
  assert.deepEqual(payload.itemIDs.slice().sort((a, b) => a - b), [WRECK_ID, WRECK_ID + 1]);
});
