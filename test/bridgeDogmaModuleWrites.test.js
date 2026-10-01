"use strict";

// Goal R100 (Phase-4 BOUND WRITES): the BFF dogma module-op write routes — WB-DOGMA
// batch A (11 writes: target-drop / overload / stop-overload / nanite module-repair /
// weapon-bank link/merge). PLUMBING ONLY — no UI.
//
// These ride the SAME dogmaIM.MachoBindObject bind the R74 dogma READS use: each
// dispatches as a BOUND method off dogmaBindSpec() (boundCall → the gateway's
// callBoundMethod), NOT the top-level /call seam. Every route is CONFIRM-GATED:
// without `confirm: true` it answers 400 CONFIRMATION_REQUIRED and NOTHING dispatches
// (no bind, no bound call). This suite proves the gate (all 11 refuse without confirm),
// that a couple of representative writes forward their args as a bound dogma call ONCE
// confirmed against a FAKE recording gateway, and that no route dispatches without a
// held bridge session. NO write was ever fired against the live world.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const STATION_ID = 60003760;
const SOLAR_SYSTEM_ID = 30000142;
const CHARACTER_ID = 7;
const CORPORATION_ID = 98000000;
const SHIP_ID = 9001;

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

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
      return Number(accountID) === ACCOUNT.accountID && Number(characterID) === CHARACTER_ID
        ? { characterID: CHARACTER_ID, accountID: 4, characterName: "Test Pilot" }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
  };
}

function fakeStaticData() {
  return {
    getStation() {
      return null;
    },
    getTypeName(id) {
      return `Type ${id}`;
    },
    resolveNames() {
      return { names: {}, capped: false, limit: 500 };
    },
  };
}

function fakeGateway() {
  const calls = { bind: [], boundCall: [] };
  return {
    calls,
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: 4,
          characterID: CHARACTER_ID,
          characterName: "Test Pilot",
          stationID: STATION_ID,
          structureID: null,
          solarSystemID: SOLAR_SYSTEM_ID,
          corporationID: CORPORATION_ID,
          shipID: SHIP_ID,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: CHARACTER_ID };
    },
    async readFlightStatus() {
      return {
        flight: { docked: true, inSpace: false, stationID: STATION_ID, solarSystemID: SOLAR_SYSTEM_ID, shipID: SHIP_ID },
        notifications: [],
      };
    },
    async callMethod(service, method) {
      throw new Error(`R100 dogma module writes are BOUND — unexpected top-level ${service}.${method}`);
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, bridgeSessionID });
      return { boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`, service, method, notifications: [] };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, bridgeSessionID, boundHandle });
      // FAST-MODE fake: the real handlers return varied shapes; the recorder just
      // acks null so the route folds it into {ok, applied, result:null}.
      return { service, method, result: null, notifications: [] };
    },
  };
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway,
    webAuth: fakeAuth(),
    staticData: options.staticData || fakeStaticData(),
    botHost: options.botHost,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, app };
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

async function selectOnServer(baseUrl) {
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: CHARACTER_ID } });
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  }
  await Promise.all(closing);
});

// --- the 11 R100 dogma module-op write routes --------------------------------

const R100_WRITE_ROUTES = [
  ["/api/bridge/dogma/targets/remove", { targetIDs: [7400000020] }],
  ["/api/bridge/dogma/targets/clear", {}],
  ["/api/bridge/dogma/module/overload", { moduleID: 7400000020, effectID: 16 }],
  ["/api/bridge/dogma/module/overload-rack", { moduleID: 7400000020 }],
  ["/api/bridge/dogma/module/stop-overload", { moduleID: 7400000020, effectID: 16 }],
  ["/api/bridge/dogma/module/stop-overload-rack", { moduleID: 7400000020 }],
  ["/api/bridge/dogma/module/repair/start", { moduleID: 7400000020 }],
  ["/api/bridge/dogma/module/repair/start-many", { moduleIDs: [7400000020, 7400000021] }],
  ["/api/bridge/dogma/module/repair/stop", { moduleID: 7400000020 }],
  ["/api/bridge/dogma/weapons/link", { shipID: SHIP_ID, masterModuleID: 7400000020, slaveModuleID: 7400000021 }],
  ["/api/bridge/dogma/weapons/merge-groups", { shipID: SHIP_ID, targetMasterID: 7400000020, sourceMasterID: 7400000021 }],
];

test("⚠ every R100 dogma module write REFUSES without confirm — no bind, no dispatch (nothing fired)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  assert.equal(R100_WRITE_ROUTES.length, 11, "all 11 R100 write routes are covered");
  for (const [path, body] of R100_WRITE_ROUTES) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 400, `${path} must refuse without confirm`);
    assert.equal(payload.error, "CONFIRMATION_REQUIRED", `${path} must answer CONFIRMATION_REQUIRED`);
  }
  assert.equal(gateway.calls.boundCall.length, 0, "a refused write must not dispatch a bound call");
  assert.equal(gateway.calls.bind.length, 0, "a refused write must not even bind the dogma object");
});

test("R100 RemoveTargets forwards [ [targetIDs] ] as a BOUND dogmaIM call once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/dogma/targets/remove", {
    method: "POST",
    body: { targetIDs: [7400000020, 7400000021], confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, true);
  // Bound, not top-level: the dogma object is bound and the call rides callBoundMethod.
  assert.equal(gateway.calls.bind.length, 1, "the dogma object is bound once");
  assert.equal(gateway.calls.bind[0].service, "dogmaIM");
  assert.equal(gateway.calls.bind[0].method, "MachoBindObject");
  const call = gateway.calls.boundCall.find((c) => c.method === "RemoveTargets");
  assert.ok(call, "RemoveTargets must reach the gateway as a bound call once confirmed");
  assert.equal(call.service, "dogmaIM");
  assert.deepEqual(call.args, [[7400000020, 7400000021]]);
  assert.match(call.boundHandle, /^handle:dogmaIM:MachoBindObject/);
});

test("R100 Overload forwards [moduleID, effectID] as a bound dogmaIM call", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/dogma/module/overload", {
    method: "POST",
    body: { moduleID: 7400000020, effectID: 16, confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "Overload");
  assert.ok(call, "Overload must reach the gateway once confirmed");
  assert.equal(call.service, "dogmaIM");
  assert.deepEqual(call.args, [7400000020, 16]);
});

test("R100 LinkWeapons forwards [shipID, masterModuleID, slaveModuleID] as a bound dogmaIM call", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/dogma/weapons/link", {
    method: "POST",
    body: { shipID: SHIP_ID, masterModuleID: 7400000020, slaveModuleID: 7400000021, confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "LinkWeapons");
  assert.ok(call, "LinkWeapons must reach the gateway once confirmed");
  assert.equal(call.service, "dogmaIM");
  assert.deepEqual(call.args, [SHIP_ID, 7400000020, 7400000021]);
});

test("R100 ClearTargets dispatches with no args once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/dogma/targets/clear", {
    method: "POST",
    body: { confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "ClearTargets");
  assert.ok(call, "ClearTargets must reach the gateway once confirmed");
  assert.deepEqual(call.args, []);
});

test("R100 write routes refuse without a held bridge session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // No selectOnServer — no held session.
  for (const [path, body] of R100_WRITE_ROUTES) {
    const { response } = await apiRequest(baseUrl, path, { method: "POST", body: { ...body, confirm: true } });
    assert.notEqual(response.status, 200, `${path} must refuse without a held session`);
  }
  assert.equal(gateway.calls.boundCall.length, 0, "no dispatch without a held session");
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("replaced held session fences a write awaiting its bind", async () => {
  const gateway = fakeGateway(), entered = deferred(), binding = deferred();
  gateway.bindObject = async () => { entered.resolve(); return binding.promise; };
  const { baseUrl, app } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const pending = apiRequest(baseUrl, "/api/bridge/dogma/targets/clear", { method: "POST", body: { confirm: true } });
  await entered.promise;
  const previous = app.locals.bridgeSessions.get(SESSION_ID);
  const replacement = { ...previous, bridgeSessionID: "new-owned-session", boundHandles: new Map() };
  app.locals.bridgeSessions.set(SESSION_ID, replacement);
  binding.resolve({ boundHandle: "old-bound-handle" });
  const result = await pending;
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error, "NO_LIVE_SESSION");
  assert.equal(gateway.calls.boundCall.length, 0);
  assert.equal(app.locals.bridgeSessions.get(SESSION_ID), replacement);
});

test("retired hosted claim fences a write awaiting its bind", async () => {
  const gateway = fakeGateway(), entered = deferred(), binding = deferred();
  let claimCurrent = true;
  const botHost = { claimedBy: () => null, authorizesClaim: (_id, secret) => claimCurrent && secret === "owned-generation" };
  gateway.bindObject = async () => { entered.resolve(); return binding.promise; };
  const { baseUrl, app } = await startTestServer({ gateway, botHost });
  await selectOnServer(baseUrl);
  app.locals.bridgeSessions.get(SESSION_ID).botClaimSecret = "owned-generation";
  const pending = apiRequest(baseUrl, "/api/bridge/dogma/targets/clear", { method: "POST",
    headers: { "x-evejs-bot-claim": "owned-generation" }, body: { confirm: true } });
  await entered.promise;
  claimCurrent = false;
  binding.resolve({ boundHandle: "old-bound-handle" });
  const result = await pending;
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.error, "HOSTED_GENERATION_CHANGED");
  assert.equal(gateway.calls.boundCall.length, 0);
});

test("a late old-generation request cannot acquire the replacement held session", async () => {
  const gateway = fakeGateway();
  gateway.callMethod = async (service, method) => ({ service, method, result: [], notifications: [] });
  const botHost = { claimedBy: () => null, authorizesClaim: (_id, secret) => secret === "current-generation" };
  const { baseUrl, app } = await startTestServer({ gateway, botHost });
  await selectOnServer(baseUrl);
  const held = app.locals.bridgeSessions.get(SESSION_ID);
  app.locals.bridgeSessions.set(SESSION_ID, { ...held, botClaimSecret: "current-generation", boundHandles: new Map() });
  const attached = await apiRequest(baseUrl, "/api/bridge/call", { method: "POST", body: { service: "dogmaIM", method: "GetAllInfo" } });
  assert.equal(attached.response.status, 200, "attached policy-read-only POST remains readable");
  for (const path of ["/api/bridge/dogma/targets/clear", "/api/bridge/release", "/api/bridge/call"]) {
    const result = await apiRequest(baseUrl, path, { method: "POST",
      headers: { "x-evejs-bot-claim": "retired-generation" }, body: { confirm: true } });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.error, "HOSTED_GENERATION_CHANGED");
  }
  assert.equal(gateway.calls.bind.length, 0);
  assert.equal(gateway.calls.boundCall.length, 0);
  assert.ok(app.locals.bridgeSessions.get(SESSION_ID), "an old release cannot drop the new held session");
});

test("late lost-session result cannot forget its replacement session", async () => {
  const gateway = fakeGateway(), entered = deferred(), issue = deferred();
  gateway.callBoundMethod = async () => { entered.resolve(); return issue.promise; };
  const { baseUrl, app } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const pending = apiRequest(baseUrl, "/api/bridge/dogma/targets/clear", { method: "POST", body: { confirm: true } });
  await entered.promise;
  const previous = app.locals.bridgeSessions.get(SESSION_ID);
  const replacement = { ...previous, bridgeSessionID: "new-owned-session", boundHandles: new Map() };
  app.locals.bridgeSessions.set(SESSION_ID, replacement);
  issue.reject(Object.assign(new Error("Old session is gone"), { code: "SESSION_NOT_FOUND", statusCode: 404 }));
  assert.equal((await pending).response.status, 404);
  assert.equal(app.locals.bridgeSessions.get(SESSION_ID), replacement);
});

test("rebind retry fences a write after held session replacement", async () => {
  const gateway = fakeGateway(), entered = deferred(), binding = deferred();
  const initialBind = gateway.bindObject; let binds = 0, issues = 0;
  gateway.bindObject = async (...args) => {
    if (++binds === 1) return initialBind(...args);
    entered.resolve(); return binding.promise;
  };
  gateway.callBoundMethod = async () => {
    issues++;
    throw Object.assign(new Error("Old bind disappeared"), { code: "BOUND_HANDLE_NOT_FOUND" });
  };
  const { baseUrl, app } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const pending = apiRequest(baseUrl, "/api/bridge/dogma/targets/clear", { method: "POST", body: { confirm: true } });
  await entered.promise;
  const previous = app.locals.bridgeSessions.get(SESSION_ID);
  app.locals.bridgeSessions.set(SESSION_ID, { ...previous, bridgeSessionID: "replacement", boundHandles: new Map() });
  binding.resolve({ boundHandle: "stale-rebound" });
  assert.equal((await pending).payload.error, "NO_LIVE_SESSION");
  assert.equal(issues, 1, "the stale retry must not dispatch");
});
