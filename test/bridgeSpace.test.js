"use strict";

// Goal R11: the BFF space-snapshot route. A read-only relay of the gateway's
// projection of what the held session can see — the visible objects around the
// ship and the active ship's shield/armor/hull/capacitor. The browser polls it
// ~1s while in space and does the distance/sorting/filtering itself.
//
// What this asserts: the route requires the web login AND a held bridge session,
// relays the gateway's snapshot untouched (the decoder owns interpretation), and
// unwinds the held session on SESSION_NOT_FOUND like every other bridge read.
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
const GATE_ID = 50001248;

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

// typeID -> dogma attribute 2699 (asteroid meta level), for the ore-grade tests.
const ORE_GRADES = { 1230: 1, 17470: 2 };

function fakeStaticData() {
  return {
    getStation() { return null; },
    getTypeName(id) { return `Type ${id}`; },
    getTypeDogmaAttribute(typeID, attributeID, fallback) {
      if (attributeID !== 2699) {
        return fallback;
      }
      return Object.prototype.hasOwnProperty.call(ORE_GRADES, typeID)
        ? ORE_GRADES[typeID]
        : fallback;
    },
  };
}

// The gateway's snapshot shape: identity + geometry per visible object, plus the
// active ship's condition. Deliberately NOT annotated with distance — that is
// the browser's job, exactly as it is in the retail client.
const SNAPSHOT = {
  inSpace: true,
  solarSystemID: ORIGIN_SYSTEM_ID,
  shipID: SHIP_ID,
  sampledAtMs: 1_700_000_000_000,
  entities: [
    {
      kind: "ship",
      itemID: SHIP_ID,
      typeID: 670,
      groupID: 29,
      categoryID: 6,
      name: "Test Pilot's Capsule",
      ownerID: 7,
      radius: 25,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      isSelf: true,
      shieldRatio: 1,
      armorRatio: 1,
      hullRatio: 1,
      capacitorRatio: 1,
    },
    {
      kind: "celestial",
      itemID: GATE_ID,
      typeID: 16,
      groupID: 10,
      categoryID: 2,
      name: "Stargate (Maurasi)",
      ownerID: 1,
      radius: 1500,
      position: { x: 1_000_000, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      isSelf: false,
      shieldRatio: null,
      armorRatio: null,
      hullRatio: null,
    },
  ],
  ship: {
    itemID: SHIP_ID,
    typeID: 670,
    name: "Test Pilot's Capsule",
    mode: "STOP",
    maxVelocity: 300,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    shieldRatio: 0.5,
    armorRatio: 0.75,
    hullRatio: 1,
    capacitorRatio: 0.25,
    shieldCapacity: 400,
    armorCapacity: 300,
    hullCapacity: 600,
  },
};

function fakeGateway(overrides = {}) {
  const calls = { select: [], release: [], spaceSnapshot: [] };
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
    async readSpaceSnapshot(bridgeSessionID, sessionFields) {
      calls.spaceSnapshot.push({ bridgeSessionID, sessionFields });
      return { space: SNAPSHOT, notifications: [] };
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

test("the space snapshot route relays the gateway projection on the held session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/space/snapshot");

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  // Read on the HELD session (the handle never reaches the browser).
  assert.equal(gateway.calls.spaceSnapshot.length, 1);
  assert.equal(gateway.calls.spaceSnapshot[0].bridgeSessionID, BRIDGE_SESSION_ID);
  assert.deepEqual(gateway.calls.spaceSnapshot[0].sessionFields, { userid: 4 });

  // Relayed untouched: interpretation belongs to the browser's decoder.
  assert.deepEqual(payload.space, SNAPSHOT);
  assert.deepEqual(payload.notifications, []);

  // The projection carries geometry, not distance — the client computes that.
  const gate = payload.space.entities.find((row) => row.itemID === GATE_ID);
  assert.ok(gate, "the visible set includes the gate");
  assert.equal(gate.distance, undefined, "the server must not precompute distance");
  assert.equal(typeof gate.position.x, "number");

  // The ship HUD carries both the live fractions and the capacities behind them.
  assert.equal(payload.space.ship.shieldRatio, 0.5);
  assert.equal(payload.space.ship.armorRatio, 0.75);
  assert.equal(payload.space.ship.hullRatio, 1);
  assert.equal(payload.space.ship.capacitorRatio, 0.25);
  assert.equal(payload.space.ship.hullCapacity, 600);
});

test("the space snapshot route stamps oreGrade onto rock rows from static data", async () => {
  const snapshot = {
    ...SNAPSHOT,
    entities: [
      ...SNAPSHOT.entities,
      {
        kind: "asteroid",
        itemID: 40000001,
        typeID: 1230, // Veldspar -> grade 1
        beltID: 40000000,
        miningYieldTypeID: 1230,
        radius: 100,
        position: { x: 5000, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        isSelf: false,
      },
      {
        kind: "asteroid",
        itemID: 40000002,
        typeID: 17470, // Veldspar II-Grade -> grade 2
        beltID: 40000000,
        miningYieldTypeID: 17470,
        radius: 100,
        position: { x: 6000, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        isSelf: false,
      },
      {
        kind: "asteroid",
        itemID: 40000003,
        typeID: 999999, // no known dogma attribute
        beltID: 40000000,
        miningYieldTypeID: 999999,
        radius: 100,
        position: { x: 7000, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        isSelf: false,
      },
    ],
  };
  const gateway = fakeGateway({
    async readSpaceSnapshot(bridgeSessionID, sessionFields) {
      this.calls.spaceSnapshot.push({ bridgeSessionID, sessionFields });
      return { space: snapshot, notifications: [] };
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/space/snapshot");

  const byId = (id) => payload.space.entities.find((row) => row.itemID === id);
  assert.equal(byId(40000001).oreGrade, 1);
  assert.equal(byId(40000002).oreGrade, 2);
  assert.equal(byId(40000003).oreGrade, null, "an unresolvable attribute reads as null, not 0");
  // Non-rock rows are untouched — they must not gain the field at all.
  assert.equal(Object.prototype.hasOwnProperty.call(byId(GATE_ID), "oreGrade"), false);
});

test("the space snapshot route requires a login and a held session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });

  // No login cookie at all.
  const anonymous = await apiRequest(baseUrl, "/api/bridge/space/snapshot", {
    authenticated: false,
  });
  assert.equal(anonymous.response.status, 401);

  // Logged in, but no character selected onto a bridge session yet.
  const unheld = await apiRequest(baseUrl, "/api/bridge/space/snapshot");
  assert.equal(unheld.response.status, 409);
  assert.equal(unheld.payload.ok, false);
  assert.equal(gateway.calls.spaceSnapshot.length, 0, "no bridge read without a held session");
});

test("a lost persistent session drops the held session (back to character select)", async () => {
  const lost = Object.assign(new Error("bridge session not found"), {
    code: "SESSION_NOT_FOUND",
    status: 404,
  });
  const gateway = fakeGateway({
    async readSpaceSnapshot(bridgeSessionID, sessionFields) {
      this.calls.spaceSnapshot.push({ bridgeSessionID, sessionFields });
      throw lost;
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const first = await apiRequest(baseUrl, "/api/bridge/space/snapshot");
  assert.equal(first.payload.ok, false);
  assert.equal(gateway.calls.spaceSnapshot.length, 1);

  // The held session was forgotten, so the next read never reaches the gateway.
  const second = await apiRequest(baseUrl, "/api/bridge/space/snapshot");
  assert.equal(second.response.status, 409);
  assert.equal(
    gateway.calls.spaceSnapshot.length,
    1,
    "the dropped session must not be reused for another bridge read",
  );
});
