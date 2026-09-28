"use strict";

// The saved-PI-plan routes: signed-in only, the store's refusals mapped to a
// status with the store's own sentence, and the revision carried through.
// The store is real, over an in-memory database (src/piPlanStore.test.js
// covers it on its own).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

process.env.EVEJS_WEB_POC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-pi-plans-"));

const webAuth = require("../src/webAuth");
const { createApp } = require("../src/server");
const { lazyCompanionDb } = require("../src/companionDb");
const { createPiPlanStore } = require("../src/piPlanStore");

const FARMER = { username: "farmer", accountID: 4001, role: "0", banned: false };

const activeServers = new Set();
test.after(() => {
  for (const server of activeServers) server.close();
});

async function startTestServer() {
  const app = createApp({
    eveStore: {
      async getAccount(username) {
        return String(username) === FARMER.username ? { ...FARMER } : null;
      },
      async listCharactersForAccount() {
        return [];
      },
      async getCharacterForAccount() {
        return null;
      },
    },
    eveGatewayClient: {},
    webAuth,
    botHost: {
      list: () => [],
      claimedBy: () => null,
      authorizesClaim: () => false,
      activeCharacterIDs: () => [],
      activeBots: () => [],
      sampleAllVitals: async () => {},
      resume: async () => {},
      stopAll: async () => {},
    },
    piPlanStore: createPiPlanStore({ db: lazyCompanionDb({ filename: ":memory:" }) }),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(baseUrl, routePath, { method = "GET", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function signIn(baseUrl) {
  const login = await request(baseUrl, "/api/login", {
    method: "POST",
    body: { username: FARMER.username, password: "x" },
  });
  return login.payload.sessionToken;
}

test("the plan routes refuse a caller who is not signed in", async () => {
  const baseUrl = await startTestServer();
  const { response } = await request(baseUrl, "/api/pi/plans");
  assert.equal(response.status, 401);
});

test("create, list, update and delete a plan", async () => {
  const baseUrl = await startTestServer();
  const token = await signIn(baseUrl);

  const created = await request(baseUrl, "/api/pi/plans", {
    method: "POST",
    token,
    body: { typeID: 2867, quantity: 20, note: "for fuel" },
  });
  assert.equal(created.response.status, 200);
  const plan = created.payload.plan;
  assert.equal(plan.typeID, 2867);
  assert.equal(plan.rev, 1);

  const listed = await request(baseUrl, "/api/pi/plans", { token });
  assert.deepEqual(listed.payload.plans.map((row) => row.planID), [plan.planID]);

  const updated = await request(baseUrl, `/api/pi/plans/${plan.planID}`, {
    method: "POST",
    token,
    body: { quantity: 40, baseRev: 1 },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.plan.quantity, 40);
  assert.equal(updated.payload.plan.rev, 2);

  const removed = await request(baseUrl, `/api/pi/plans/${plan.planID}/delete`, { method: "POST", token, body: {} });
  assert.equal(removed.payload.removed, true);
  const after = await request(baseUrl, "/api/pi/plans", { token });
  assert.deepEqual(after.payload.plans, []);
});

test("refusals keep the store's code and sentence", async () => {
  const baseUrl = await startTestServer();
  const token = await signIn(baseUrl);

  const invalid = await request(baseUrl, "/api/pi/plans", { method: "POST", token, body: { typeID: 2867 } });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.error, "PI_PLAN_INVALID");
  assert.equal(invalid.payload.message, "Enter how many, as a whole number.");

  const missing = await request(baseUrl, "/api/pi/plans/nope", { method: "POST", token, body: { quantity: 1, baseRev: 1 } });
  assert.equal(missing.response.status, 404);

  const { payload } = await request(baseUrl, "/api/pi/plans", { method: "POST", token, body: { typeID: 2867, quantity: 1 } });
  await request(baseUrl, `/api/pi/plans/${payload.plan.planID}`, { method: "POST", token, body: { quantity: 2, baseRev: 1 } });
  const stale = await request(baseUrl, `/api/pi/plans/${payload.plan.planID}`, {
    method: "POST",
    token,
    body: { quantity: 3, baseRev: 1 },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.error, "PI_PLAN_REV_CONFLICT");
});
