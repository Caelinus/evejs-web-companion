"use strict";

// The saved Industry Manager plan routes (R109 slice 3): signed-in only, the
// store's refusals mapped to a status with the store's own sentence, the
// revision carried through. The store is real, over an in-memory database
// (src/industryPlanStore.test.js covers it on its own). Shaped after
// test/piPlans.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

process.env.EVEJS_WEB_POC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-industry-plans-"));

const webAuth = require("../src/webAuth");
const { createApp } = require("../src/server");
const { lazyCompanionDb } = require("../src/companionDb");
const { createIndustryPlanStore } = require("../src/industryPlanStore");

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
    industryPlanStore: createIndustryPlanStore({ db: lazyCompanionDb({ filename: ":memory:" }) }),
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

test("the industry plan routes refuse a caller who is not signed in", async () => {
  const baseUrl = await startTestServer();
  assert.equal((await request(baseUrl, "/api/industry/plans")).response.status, 401);
  assert.equal(
    (await request(baseUrl, "/api/industry/plans", { method: "POST", body: { productTypeID: 1, runs: 1 } })).response.status,
    401,
  );
});

test("create, list, update with choices, and delete a plan", async () => {
  const baseUrl = await startTestServer();
  const token = await signIn(baseUrl);

  const created = await request(baseUrl, "/api/industry/plans", {
    method: "POST",
    token,
    body: { productTypeID: 2456, runs: 10, note: "drones" },
  });
  assert.equal(created.response.status, 200);
  const plan = created.payload.plan;
  assert.equal(plan.productTypeID, 2456);
  assert.equal(plan.runs, 10);
  assert.deepEqual(plan.choices, { buy: [], jobs: {}, blueprints: {} });
  assert.equal(plan.rev, 1);

  const updated = await request(baseUrl, `/api/industry/plans/${plan.planID}`, {
    method: "POST",
    token,
    body: { baseRev: 1, runs: 20, choices: { buy: [11399, 11399], jobs: { 11688: 2 } } },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.plan.runs, 20);
  assert.deepEqual(updated.payload.plan.choices, { buy: [11399], jobs: { 11688: 2 }, blueprints: {} });
  assert.equal(updated.payload.plan.rev, 2);

  const listed = await request(baseUrl, "/api/industry/plans", { token });
  assert.deepEqual(listed.payload.plans.map((row) => row.planID), [plan.planID]);

  const removed = await request(baseUrl, `/api/industry/plans/${plan.planID}/delete`, { method: "POST", token, body: {} });
  assert.equal(removed.payload.removed, true);
  assert.deepEqual((await request(baseUrl, "/api/industry/plans", { token })).payload.plans, []);
});

test("refusals keep the store's code and sentence, with the right status", async () => {
  const baseUrl = await startTestServer();
  const token = await signIn(baseUrl);

  const invalid = await request(baseUrl, "/api/industry/plans", { method: "POST", token, body: { runs: 1 } });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.error, "INDUSTRY_PLAN_INVALID");
  assert.equal(invalid.payload.message, "Choose something to build.");

  const plan = (await request(baseUrl, "/api/industry/plans", {
    method: "POST",
    token,
    body: { productTypeID: 1, runs: 1 },
  })).payload.plan;
  await request(baseUrl, `/api/industry/plans/${plan.planID}`, { method: "POST", token, body: { baseRev: 1, runs: 2 } });
  const stale = await request(baseUrl, `/api/industry/plans/${plan.planID}`, {
    method: "POST",
    token,
    body: { baseRev: 1, runs: 3 },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.error, "INDUSTRY_PLAN_REV_CONFLICT");

  const missing = await request(baseUrl, "/api/industry/plans/nope", { method: "POST", token, body: { baseRev: 1 } });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.error, "INDUSTRY_PLAN_NOT_FOUND");
});
