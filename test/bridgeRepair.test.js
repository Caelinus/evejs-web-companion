"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "repair-test-cookie";
const WEB_SESSION_ID = "repair-test-web-session";
const BRIDGE_SESSION_ID = "repair-test-bridge-session";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTER_ID = 7;
const STATION_ID = 60003760;
const SHIP_ID = 9001;
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
    async getCharacterForAccount(accountID, characterID) {
      return Number(accountID) === ACCOUNT.accountID && Number(characterID) === CHARACTER_ID
        ? { characterID: CHARACTER_ID, accountID: ACCOUNT.accountID, characterName: "Test Pilot" }
        : null;
    },
  };
}

function fakeStaticData() {
  return {
    getStation() {
      return null;
    },
    getTypeName(typeID) {
      return `Type ${typeID}`;
    },
    resolveNames() {
      return { names: {}, capped: false, limit: 500 };
    },
  };
}

function fakeGateway() {
  const calls = [];
  return {
    calls,
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        notifications: [],
        session: {
          userid: ACCOUNT.accountID,
          characterID: CHARACTER_ID,
          characterName: "Test Pilot",
          stationID: STATION_ID,
          structureID: null,
          solarSystemID: 30000142,
          corporationID: 98000000,
          shipID: SHIP_ID,
        },
      };
    },
    async readFlightStatus() {
      return { flight: { inSpace: false, docked: true, stationID: STATION_ID,
        structureID: null, solarSystemID: 30000142, shipID: SHIP_ID }, notifications: [] };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      return {
        service,
        method,
        result: method === "GetRepairQuotes"
          ? [{ itemID: Number(args[0][0]), cost: 1250 }]
          : { repaired: args[0] },
        notifications: [],
      };
    },
  };
}

async function startTestServer(gateway) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: gateway,
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
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
      server.close((error) => error ? reject(error) : resolve());
    }));
  }
  await Promise.all(closing);
});

test("repair quotes forward as a held repairSvc.GetRepairQuotes read", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: CHARACTER_ID },
  });

  const { response, payload } = await apiRequest(
    baseUrl,
    `/api/bridge/station/repair-quotes?itemIDs=${SHIP_ID},9002,invalid,-1`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(payload.quotes, [{ itemID: SHIP_ID, cost: 1250 }]);
  assert.deepEqual(gateway.calls, [{
    service: "repairSvc",
    method: "GetRepairQuotes",
    args: [[SHIP_ID, 9002]],
    kwargs: null,
    sessionFields: { userid: ACCOUNT.accountID },
    bridgeSessionID: BRIDGE_SESSION_ID,
  }]);
});

test("repair commit refuses without confirmation and forwards RepairItems once confirmed", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: CHARACTER_ID },
  });

  const refused = await apiRequest(baseUrl, "/api/bridge/station/repair", {
    method: "POST",
    body: { itemIDs: [SHIP_ID] },
  });
  assert.equal(refused.response.status, 400);
  assert.equal(refused.payload.error, "CONFIRMATION_REQUIRED");
  assert.equal(gateway.calls.length, 0, "an unconfirmed repair must not dispatch");

  const committed = await apiRequest(baseUrl, "/api/bridge/station/repair", {
    method: "POST",
    body: { itemIDs: [SHIP_ID, "9002", -1, "bad"], confirm: true },
  });
  assert.equal(committed.response.status, 200);
  assert.deepEqual(committed.payload.result, { repaired: [SHIP_ID, 9002] });
  assert.deepEqual(gateway.calls, [{
    service: "repairSvc",
    method: "RepairItems",
    args: [[SHIP_ID, 9002], null],
    kwargs: null,
    sessionFields: { userid: ACCOUNT.accountID },
    bridgeSessionID: BRIDGE_SESSION_ID,
  }]);
});
