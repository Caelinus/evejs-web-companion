"use strict";

// Goal R13: the BFF's in-space flight verbs — the moves the retail right-click
// menu offers, on the beyonce remote-park bound object.
//
// What these tests pin down is the WIRE SHAPE of each verb, because that is
// where R5a quietly diverged from retail: approach hardcoded its range to 0.0,
// and there was no way to keep at range, orbit, align, stop, or warp to a
// chosen distance at all. Four of the six verbs need no new server method —
// they are the already-bridged CmdFollowBall / CmdWarpToStuff called with the
// arguments R5a threw away.
//
//   Approach        CmdFollowBall(targetID, 50)             range now a parameter
//   Keep at range   CmdFollowBall(targetID, range)          same method, non-zero
//   Orbit           CmdOrbit(targetID, range)
//   Align to        CmdAlignTo(dstID=…, bookmarkID=null)    KWARGS, never positional
//   Stop            CmdStop()                               no arguments
//   Warp at range   CmdWarpToStuff("item", id, minRange=…)  minRange is a kwarg
//
// Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTERS = [{ characterID: 7, accountID: 4, characterName: "Test Pilot" }];
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const ORIGIN_STATION_ID = 60003760;
const ORIGIN_SYSTEM_ID = 30000142;
const SHIP_ID = 9001;
const TARGET_ID = 50001248;

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
  const calls = { select: [], release: [], call: [], bind: [], boundCall: [], flightStatus: [] };
  const state = {
    inSpace: true,
    solarSystemID: ORIGIN_SYSTEM_ID,
    stationID: ORIGIN_STATION_ID,
    shipMode: "STOP",
  };
  function flightSnapshot() {
    return {
      inSpace: state.inSpace,
      docked: !state.inSpace && state.stationID !== null,
      solarSystemID: state.solarSystemID,
      stationID: state.inSpace ? null : state.stationID,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: state.inSpace ? state.shipMode : null,
      shipSpeedFraction: state.inSpace && state.shipMode === "WARP" ? 1 : 0,
    };
  }
  const gateway = {
    calls,
    state,
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
          stationID: ORIGIN_STATION_ID,
          structureID: null,
          solarSystemID: ORIGIN_SYSTEM_ID,
          corporationID: 98000000,
          shipID: SHIP_ID,
        },
      };
    },
    async releaseBridgeSession(bridgeSessionID, sessionFields) {
      calls.release.push({ bridgeSessionID, sessionFields });
      return { released: true, characterID: 7 };
    },
    async readFlightStatus(bridgeSessionID, sessionFields) {
      calls.flightStatus.push({ bridgeSessionID, sessionFields });
      return { flight: flightSnapshot(), notifications: [] };
    },
    async readSpaceSnapshot() {
      return { space: { inSpace: state.inSpace, solarSystemID: state.solarSystemID,
        ship: { itemID: SHIP_ID }, entities: [] }, notifications: [] };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      return { service, method, result: null, notifications: [] };
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      return {
        boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`,
        service,
        method,
        notifications: [],
      };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle });
      if (method === "CmdWarpToStuff" || method === "CmdWarpToStuffAutopilot") {
        state.shipMode = "WARP";
      } else if (method === "CmdOrbit") {
        state.shipMode = "ORBIT";
      } else if (method === "CmdFollowBall") {
        state.shipMode = "FOLLOW";
      } else if (method === "CmdStop") {
        state.shipMode = "STOP";
      }
      return { service, method, result: null, notifications: [] };
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
  const selected = await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
  assert.equal(selected.response.status, 200);
  const ready = await apiRequest(baseUrl, "/api/bridge/drone-recovery/ready", {
    method: "POST", body: { checkID: selected.payload.droneRecoveryCheckID },
  });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.payload));
}

/** Start a server with a fresh in-space gateway and select the character. */
async function inSpace(overrides) {
  const gateway = fakeGateway(overrides);
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  return { gateway, baseUrl };
}

function boundCallsOf(gateway, method) {
  return gateway.calls.boundCall.filter((c) => c.method === method);
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

// --- Approach: the range stopped being hardcoded ----------------------------

test("approach defaults to the retail MENU range of 50 m, not the autopilot's 0", async () => {
  const { gateway, baseUrl } = await inSpace();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/approach", {
    method: "POST",
    body: { destinationID: TARGET_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  const follow = boundCallsOf(gateway, "CmdFollowBall");
  assert.equal(follow.length, 1, "one CmdFollowBall");
  assert.deepEqual(follow[0].args, [TARGET_ID, 50]);
  // Approach still goes to full speed first, exactly as it always did.
  assert.deepEqual(boundCallsOf(gateway, "CmdSetSpeedFraction")[0].args, [1.0]);
  assert.equal(JSON.stringify(payload).includes("handle:"), false, "no bound handle reaches the browser");
});

test("approach honours an explicit range — 0 is the autopilot's own close-the-gap call", async () => {
  const { gateway, baseUrl } = await inSpace();

  const { response } = await apiRequest(baseUrl, "/api/bridge/flight/approach", {
    method: "POST",
    body: { destinationID: TARGET_ID, range: 0 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(boundCallsOf(gateway, "CmdFollowBall")[0].args, [TARGET_ID, 0]);
});

// --- Keep at range: the SAME method with a non-zero range -------------------

test("keep at range dispatches CmdFollowBall — the same method approach uses", async () => {
  const { gateway, baseUrl } = await inSpace();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/keep-at-range", {
    method: "POST",
    body: { targetID: TARGET_ID, range: 5000 },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(boundCallsOf(gateway, "CmdFollowBall")[0].args, [TARGET_ID, 5000]);
  assert.equal(payload.flight.shipMode, "FOLLOW");
});

test("keep at range defaults to 1000 m and floors at 50 m", async () => {
  const withDefault = await inSpace();
  await apiRequest(withDefault.baseUrl, "/api/bridge/flight/keep-at-range", {
    method: "POST",
    body: { targetID: TARGET_ID },
  });
  assert.deepEqual(boundCallsOf(withDefault.gateway, "CmdFollowBall")[0].args, [TARGET_ID, 1000]);

  const tooClose = await inSpace();
  await apiRequest(tooClose.baseUrl, "/api/bridge/flight/keep-at-range", {
    method: "POST",
    body: { targetID: TARGET_ID, range: 5 },
  });
  assert.deepEqual(
    boundCallsOf(tooClose.gateway, "CmdFollowBall")[0].args,
    [TARGET_ID, 50],
    "a range under the floor is raised to 50 m",
  );
});

// --- Orbit ------------------------------------------------------------------

test("orbit dispatches CmdOrbit(targetID, range), defaulting to 1000 m", async () => {
  const { gateway, baseUrl } = await inSpace();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/orbit", {
    method: "POST",
    body: { targetID: TARGET_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(boundCallsOf(gateway, "CmdOrbit")[0].args, [TARGET_ID, 1000]);
  assert.equal(payload.flight.shipMode, "ORBIT");
});

test("orbit coerces its range the way the retail client does (float under 10, int at or above)", async () => {
  const small = await inSpace();
  await apiRequest(small.baseUrl, "/api/bridge/flight/orbit", {
    method: "POST",
    body: { targetID: TARGET_ID, range: 7.5 },
  });
  assert.deepEqual(boundCallsOf(small.gateway, "CmdOrbit")[0].args, [TARGET_ID, 7.5]);

  const large = await inSpace();
  await apiRequest(large.baseUrl, "/api/bridge/flight/orbit", {
    method: "POST",
    body: { targetID: TARGET_ID, range: 10000.4 },
  });
  assert.deepEqual(boundCallsOf(large.gateway, "CmdOrbit")[0].args, [TARGET_ID, 10000]);
});

// --- Align: KWARGS ONLY -----------------------------------------------------

test("align sends CmdAlignTo as KWARGS (dstID / bookmarkID) with NO positional args", async () => {
  const { gateway, baseUrl } = await inSpace();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/align", {
    method: "POST",
    body: { targetID: TARGET_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  const align = boundCallsOf(gateway, "CmdAlignTo")[0];
  assert.ok(align, "CmdAlignTo dispatched");
  assert.deepEqual(align.args, [], "the target must NEVER travel as a positional arg");
  assert.deepEqual(align.kwargs, { dstID: TARGET_ID, bookmarkID: null });
  // Exactly one of the two is non-null, as the handler requires.
  assert.equal(align.kwargs.bookmarkID, null);
});

// --- Stop -------------------------------------------------------------------

test("stop sends CmdStop with no arguments at all", async () => {
  const { gateway, baseUrl } = await inSpace();
  gateway.state.shipMode = "ORBIT";

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/stop", {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  const stop = boundCallsOf(gateway, "CmdStop")[0];
  assert.ok(stop, "CmdStop dispatched");
  assert.deepEqual(stop.args, []);
  assert.equal(stop.kwargs, null);
  assert.equal(payload.flight.shipMode, "STOP");
});

// --- Warp at range ----------------------------------------------------------

test("warp with no minRange stays the autopilot warp (CmdWarpToStuffAutopilot)", async () => {
  const { gateway, baseUrl } = await inSpace();

  const { response } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: TARGET_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(boundCallsOf(gateway, "CmdWarpToStuffAutopilot").length, 1);
  assert.equal(boundCallsOf(gateway, "CmdWarpToStuff").length, 0);
});

test("warp at range dispatches CmdWarpToStuff('item', id) with minRange as a KWARG", async () => {
  for (const minRange of [0, 10000, 20000, 30000, 50000, 70000, 100000]) {
    const { gateway, baseUrl } = await inSpace();
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
      method: "POST",
      body: { destinationID: TARGET_ID, minRange },
    });
    assert.equal(response.status, 200, `minRange=${minRange}`);
    assert.equal(payload.ok, true);

    const warp = boundCallsOf(gateway, "CmdWarpToStuff")[0];
    assert.ok(warp, `CmdWarpToStuff dispatched for minRange=${minRange}`);
    assert.deepEqual(warp.args, ["item", TARGET_ID], "subject is positional, target follows it");
    assert.deepEqual(warp.kwargs, { minRange }, "the range is a kwarg, never positional");
    assert.equal(
      boundCallsOf(gateway, "CmdWarpToStuffAutopilot").length,
      0,
      "a ranged warp is NOT the autopilot warp",
    );
  }
});

test("a warp range outside the offered ladder is refused", async () => {
  const { gateway, baseUrl } = await inSpace();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: TARGET_ID, minRange: 12345 },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_RANGE");
  assert.equal(gateway.calls.boundCall.length, 0, "nothing dispatched");
});

// --- Guard rails shared with the R5a routes ---------------------------------

test("every verb binds the beyonce park for the CURRENT system and hides the handle", async () => {
  const routes = [
    ["/api/bridge/flight/keep-at-range", { targetID: TARGET_ID }],
    ["/api/bridge/flight/orbit", { targetID: TARGET_ID }],
    ["/api/bridge/flight/align", { targetID: TARGET_ID }],
    ["/api/bridge/flight/stop", {}],
  ];
  for (const [path, body] of routes) {
    const { gateway, baseUrl } = await inSpace();
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 200, path);
    const bind = gateway.calls.bind.find((b) => b.service === "beyonce" && b.method === "MachoBindObject");
    assert.ok(bind, `${path} bound the park`);
    assert.deepEqual(bind.args, [[ORIGIN_SYSTEM_ID, 5]], path);
    assert.equal(JSON.stringify(payload).includes("handle:"), false, `${path} leaked a bound handle`);
    for (const call of gateway.calls.boundCall) {
      assert.equal(call.bridgeSessionID, BRIDGE_SESSION_ID, path);
    }
  }
});

test("every verb is refused when docked (NOT_IN_SPACE) and dispatches nothing", async () => {
  const routes = [
    ["/api/bridge/flight/approach", { destinationID: TARGET_ID }],
    ["/api/bridge/flight/keep-at-range", { targetID: TARGET_ID }],
    ["/api/bridge/flight/orbit", { targetID: TARGET_ID }],
    ["/api/bridge/flight/align", { targetID: TARGET_ID }],
    ["/api/bridge/flight/stop", {}],
  ];
  for (const [path, body] of routes) {
    const { gateway, baseUrl } = await inSpace();
    gateway.state.inSpace = false;
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 409, path);
    assert.equal(payload.error, "NOT_IN_SPACE", path);
    assert.equal(gateway.calls.boundCall.length, 0, `${path} dispatched while docked`);
  }
});

test("a target-less verb is a 400 before anything is dispatched", async () => {
  const routes = [
    ["/api/bridge/flight/keep-at-range", {}],
    ["/api/bridge/flight/orbit", {}],
    ["/api/bridge/flight/align", {}],
  ];
  for (const [path, body] of routes) {
    const { gateway, baseUrl } = await inSpace();
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 400, path);
    assert.equal(payload.error, "INVALID_TARGET", path);
    assert.equal(gateway.calls.boundCall.length, 0, path);
  }
});

test("a verb refusal passes through as the handler's own CALL_REFUSED message", async () => {
  const { baseUrl } = await inSpace({
    async callBoundMethod(service, method) {
      if (method === "CmdOrbit") {
        const error = new Error("You are warp scrambled.");
        error.code = "CALL_REFUSED";
        error.statusCode = 409;
        throw error;
      }
      return { service, method, result: null, notifications: [] };
    },
  });

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/orbit", {
    method: "POST",
    body: { targetID: TARGET_ID },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "CALL_REFUSED");
  assert.match(payload.message, /warp scrambled/i);
});

test("the verbs require a live session (409 NO_LIVE_SESSION with no character online)", async () => {
  const { baseUrl } = await startTestServer();
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/stop", {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_LIVE_SESSION");
});
