"use strict";

// Goal R2: persistent browser-backed sessions through the BFF. The gateway
// mints an opaque bridgeSessionID on select-character; the BFF keeps it
// server-side keyed by the signed web session and forwards it on bridge
// calls — it must never reach browser JS. Wire contract:
// docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const gatewayClient = require("../src/eveGatewayClient");
const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = {
  username: "pilot",
  accountID: 4,
  role: "0",
  banned: false,
};
const CHARACTERS = [
  { characterID: 7, accountID: 4, characterName: "Test Pilot" },
];
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const SELECT_SESSION_ECHO = {
  userid: 4,
  shipID: 9001,
  characterID: 7,
  characterName: "Test Pilot",
  stationID: 60003760,
  structureID: null,
  solarSystemID: 30000142,
  corporationID: 98000000,
};
const STATION_STATIC = {
  stationID: 60003760,
  stationName: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
  solarSystemName: "Jita",
  regionName: "The Forge",
  stationTypeID: 1529,
  operationID: 26,
  security: 0.9,
};

const ORIGINAL_FETCH = global.fetch;
const ENV_NAMES = ["EVEJS_GATEWAY_URL", "EVEJS_WEB_GATEWAY_TOKEN"];
const ORIGINAL_ENV = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
);

const activeServers = new Set();

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type"
          ? "application/json"
          : null;
      },
    },
    async json() {
      return body;
    },
  };
}

function gatewayResponse(body = {}) {
  return {
    ok: true,
    source: "evejs-web-gateway",
    apiVersion: 1,
    ...body,
  };
}

function fakeAuth() {
  return {
    createSessionToken() {
      return COOKIE_TOKEN;
    },
    verifySessionToken(token) {
      return token === COOKIE_TOKEN
        ? {
          username: ACCOUNT.username,
          accountID: ACCOUNT.accountID,
          sessionID: SESSION_ID,
        }
        : null;
    },
    countConfiguredUsers() {
      return 1;
    },
  };
}

function fakeStore(overrides = {}) {
  return {
    async getAccount(username) {
      return username === ACCOUNT.username ? { ...ACCOUNT } : null;
    },
    async listCharactersForAccount(accountID) {
      return Number(accountID) === ACCOUNT.accountID
        ? CHARACTERS.map((character) => ({ ...character }))
        : [];
    },
    async getCharacterForAccount(accountID, characterID) {
      return Number(accountID) === ACCOUNT.accountID &&
        CHARACTERS.some((character) => character.characterID === Number(characterID))
        ? { ...CHARACTERS[0] }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
    ...overrides,
  };
}

function fakeStaticData() {
  return {
    getStation(stationID) {
      return Number(stationID) === STATION_STATIC.stationID
        ? { ...STATION_STATIC }
        : null;
    },
    getTypeName(typeID) {
      return Number(typeID) === STATION_STATIC.stationTypeID
        ? "Caldari Administrative Station"
        : `Type ${typeID}`;
    },
  };
}

async function acknowledgeRecovery(baseUrl) {
  const selected = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST", body: { characterID: 7 },
  });
  assert.equal(selected.response.status, 200);
  const ready = await apiRequest(baseUrl, "/api/bridge/drone-recovery/ready", {
    method: "POST", body: { checkID: selected.payload.droneRecoveryCheckID },
  });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.payload));
}

function fakeGateway(overrides = {}) {
  const calls = { select: [], release: [], call: [] };
  const gateway = {
    calls,
    async readFlightStatus() {
      return { flight: { docked: true, inSpace: false, stationID: 60003760, shipID: 9001 }, notifications: [] };
    },
    async selectCharacter(args, kwargs, sessionFields) {
      calls.select.push({ args, kwargs, sessionFields });
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: { ...SELECT_SESSION_ECHO },
      };
    },
    async releaseBridgeSession(bridgeSessionID, sessionFields) {
      calls.release.push({ bridgeSessionID, sessionFields });
      return { released: true, characterID: 7 };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
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
    staticData: options.staticData || fakeStaticData(),
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

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  for (const name of ENV_NAMES) {
    if (ORIGINAL_ENV[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = ORIGINAL_ENV[name];
    }
  }
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }));
  }
  await Promise.all(closing);
});

test("gateway client selectCharacter posts the retail tuple to /session/select", async () => {
  process.env.EVEJS_GATEWAY_URL = "http://gateway.test/_evejs-web/v1";
  process.env.EVEJS_WEB_GATEWAY_TOKEN = "server-secret";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, gatewayResponse({
      bridgeSessionID: BRIDGE_SESSION_ID,
      service: "charUnboundMgr",
      method: "SelectCharacterID",
      result: null,
      notifications: [],
      session: SELECT_SESSION_ECHO,
    }));
  };

  const outcome = await gatewayClient.selectCharacter(
    [7, null, true],
    null,
    { userid: 4, userName: "pilot" },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gateway.test/_evejs-web/v1/session/select");
  assert.equal(calls[0].options.headers["x-evejs-web-token"], "server-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    args: [7, null, true],
    kwargs: null,
    session: { userid: 4, userName: "pilot" },
  });
  assert.equal(outcome.bridgeSessionID, BRIDGE_SESSION_ID);
  assert.deepEqual(outcome.session, SELECT_SESSION_ECHO);
});

test("gateway client releaseBridgeSession posts the handle to /session/release", async () => {
  process.env.EVEJS_GATEWAY_URL = "http://gateway.test/_evejs-web/v1";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, gatewayResponse({ released: true, characterID: 7 }));
  };

  const outcome = await gatewayClient.releaseBridgeSession(BRIDGE_SESSION_ID, { userid: 4 });

  assert.equal(calls[0].url, "http://gateway.test/_evejs-web/v1/session/release");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    bridgeSessionID: BRIDGE_SESSION_ID,
    session: { userid: 4 },
  });
  assert.deepEqual(outcome, { released: true, offline: false, characterID: 7 });
});

test("gateway client callMethod forwards a bridgeSessionID only when supplied", async () => {
  process.env.EVEJS_GATEWAY_URL = "http://gateway.test/_evejs-web/v1";
  const bodies = [];
  global.fetch = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return jsonResponse(200, gatewayResponse({
      service: "station",
      method: "GetGuests",
      result: { type: "list", items: [] },
      notifications: [],
    }));
  };

  await gatewayClient.callMethod("station", "GetGuests", [], null, { userid: 4 });
  await gatewayClient.callMethod(
    "station",
    "GetGuests",
    [],
    null,
    { userid: 4 },
    BRIDGE_SESSION_ID,
  );

  assert.equal("bridgeSessionID" in bodies[0], false);
  assert.equal(bodies[1].bridgeSessionID, BRIDGE_SESSION_ID);
});

test("select pins identity, keeps the bridgeSessionID server-side, and returns character + static station", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  // The opaque gateway handle must never reach browser JS.
  assert.equal(JSON.stringify(payload).includes(BRIDGE_SESSION_ID), false);
  assert.deepEqual(payload.character, {
    characterID: 7,
    characterName: "Test Pilot",
    stationID: 60003760,
    structureID: null,
    solarSystemID: 30000142,
    corporationID: 98000000,
  });
  assert.equal(payload.station.stationName, STATION_STATIC.stationName);
  assert.equal(payload.station.stationTypeName, "Caldari Administrative Station");
  assert.deepEqual(payload.notifications, []);
  // Identity is pinned to the signed login session.
  assert.deepEqual(gateway.calls.select, [{
    args: [7, null, true],
    kwargs: null,
    sessionFields: { userid: 4, userName: "pilot" },
  }]);
});

test("after select, bridge calls ride the held persistent session; browser-supplied handles are ignored", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });

  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });
  const { response } = await apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST",
    body: {
      service: "station",
      method: "GetGuests",
      args: [],
      kwargs: null,
      // Spoofed handle from the browser must not survive.
      bridgeSessionID: "spoofed-browser-handle",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(gateway.calls.call.length, 1);
  assert.equal(gateway.calls.call[0].bridgeSessionID, BRIDGE_SESSION_ID);
});

test("selecting again releases the previously held bridge session first", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });

  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });
  await acknowledgeRecovery(baseUrl);
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });

  assert.equal(gateway.calls.select.length, 2);
  assert.deepEqual(gateway.calls.release, [{
    bridgeSessionID: BRIDGE_SESSION_ID,
    sessionFields: { userid: 4 },
  }]);
});

test("release ends the held session and later calls go back to stateless", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });

  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });
  await acknowledgeRecovery(baseUrl);
  const { payload: releasePayload } = await apiRequest(baseUrl, "/api/bridge/release", {
    method: "POST",
    body: {},
  });
  assert.deepEqual(releasePayload, { ok: true, released: true });
  assert.equal(gateway.calls.release.length, 1);

  const again = await apiRequest(baseUrl, "/api/bridge/release", {
    method: "POST",
    body: {},
  });
  assert.deepEqual(again.payload, { ok: true, released: false });

  await apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST",
    body: { service: "map", method: "GetStationInfo" },
  });
  assert.equal(gateway.calls.call[0].bridgeSessionID, undefined);
});

test("SESSION_NOT_FOUND from the gateway drops the stale handle and surfaces the typed error", async () => {
  const gateway = fakeGateway({
    async callMethod() {
      throw new gatewayClient.EveGatewayError("Unknown, expired, or released bridge session.", {
        code: "SESSION_NOT_FOUND",
        statusCode: 404,
      });
    },
  });
  const { baseUrl } = await startTestServer({ gateway });

  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST",
    body: { service: "station", method: "GetGuests" },
  });
  assert.equal(response.status, 404);
  assert.equal(payload.error, "SESSION_NOT_FOUND");

  // The stale handle is gone: releasing now reports nothing held.
  const { payload: releasePayload } = await apiRequest(baseUrl, "/api/bridge/release", {
    method: "POST",
    body: {},
  });
  assert.deepEqual(releasePayload, { ok: true, released: false });
});

test("a release the gateway never answered retains the held owner for reconciliation", async () => {
  const gateway = fakeGateway({
    async releaseBridgeSession() {
      throw new gatewayClient.EveGatewayError("EveJS gateway timed out.", {
        code: "EVE_GATEWAY_TIMEOUT",
      });
    },
  });
  const { baseUrl } = await startTestServer({ gateway });

  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });
  await acknowledgeRecovery(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/release", {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 502, JSON.stringify(payload));
  assert.equal(payload.error, "EVE_GATEWAY_TIMEOUT");

  // The handle remains owned: a second unanswered release must not claim it
  // was already forgotten.
  const again = await apiRequest(baseUrl, "/api/bridge/release", {
    method: "POST",
    body: {},
  });
  assert.equal(again.response.status, 502);
  assert.equal(again.payload.error, "EVE_GATEWAY_TIMEOUT");
  await apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST", body: { service: "map", method: "GetStationInfo" },
  });
  assert.equal(gateway.calls.call[0].bridgeSessionID, BRIDGE_SESSION_ID);
});

test("an unconfirmed release preserves the held session instead of reporting success", async () => {
  const gateway = fakeGateway({ releaseBridgeSession: async () => ({ released: false }) });
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
  await acknowledgeRecovery(baseUrl);
  const refused = await apiRequest(baseUrl, "/api/bridge/release", { method: "POST", body: {} });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.payload.error, "PILOT_RELEASE_UNVERIFIED");
  await apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST", body: { service: "map", method: "GetStationInfo" },
  });
  assert.equal(gateway.calls.call[0].bridgeSessionID, BRIDGE_SESSION_ID);
});

test("select refusals pass through with the handler's own message", async () => {
  const gateway = fakeGateway({
    async selectCharacter() {
      throw new gatewayClient.EveGatewayError("Test Pilot is already online.", {
        code: "CALL_REFUSED",
        statusCode: 409,
      });
    },
  });
  const { baseUrl } = await startTestServer({ gateway });

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "CALL_REFUSED");
  assert.match(payload.message, /already online/i);
});

test("select validates ownership and requires auth", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });

  const unknown = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 999 },
  });
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.payload.error, "CHARACTER_NOT_FOUND");

  const invalid = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: -1 },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.payload.error, "INVALID_CHARACTER");

  const unauthenticated = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    authenticated: false,
    body: { characterID: 7 },
  });
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.payload.error, "AUTH_REQUIRED");
  assert.equal(gateway.calls.select.length, 0);
});

test("logout releases the held bridge session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });

  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });
  await acknowledgeRecovery(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/logout", {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 200);
  assert.equal(gateway.calls.release.length, 1);
  assert.equal(gateway.calls.release[0].bridgeSessionID, BRIDGE_SESSION_ID);
});
