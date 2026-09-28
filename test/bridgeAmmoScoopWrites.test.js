"use strict";

// Dedicated routes for the three earlier allowlisted writes which cannot safely
// be exposed with their raw RPC argument surface:
//
//   dogmaIM.LoadAmmo(shipID, moduleIDs, chargeItemIDs, ammoLocationID)
//   dogmaIM.UnloadAmmo(shipID, moduleIDs, destination, quantity?)
//   ship.ScoopDrone([droneIDs])
//
// The ammo methods accept arbitrary ship/location ids at the RPC layer. These
// tests pin the BFF contract instead: active ship and concrete inventory ids
// come only from the held/live session, while the browser may name only cargo
// or the current dock/structure hangar. Every route is confirmation-gated and
// every malformed id/quantity fails before a target method is dispatched.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const CHARACTER_ID = 7;
const CORPORATION_ID = 98_000_000;
const STATION_ID = 60_003_760;
const STRUCTURE_ID = 1_030_000_000_001;
const SOLAR_SYSTEM_ID = 30_000_142;
const SHIP_ID = 9_988_400_091_900;
const OTHER_SHIP_ID = 9_988_400_091_901;
const FOREIGN_LOCATION_ID = 60_000_001;
const MODULE_ID = 7_400_000_030;
const SECOND_MODULE_ID = 7_400_000_031;
const CHARGE_ITEM_ID = 7_500_000_001;
const SECOND_CHARGE_ITEM_ID = 7_500_000_002;
const DRONE_ID = 7_800_001;
const SECOND_DRONE_ID = 7_800_002;

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
        ? { characterID: CHARACTER_ID, accountID: ACCOUNT.accountID, characterName: "Test Pilot" }
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

function fakeGateway(overrides = {}) {
  const calls = { call: [], flight: [], bind: [], boundCall: [], space: [] };
  const state = {
    // What is left in space when the snapshot is re-read after a scoop. The
    // scoop is judged by this list and by nothing else, so the case says what
    // the server did by saying which drones survive it.
    droneIDsInSpace: overrides.droneIDsInSpace === undefined ? [] : overrides.droneIDsInSpace,
    selectedShipID: overrides.selectedShipID === undefined ? SHIP_ID : overrides.selectedShipID,
    flight: {
      docked: true,
      inSpace: false,
      stationID: STATION_ID,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      shipID: SHIP_ID,
      ...(overrides.flight || {}),
    },
  };
  return {
    calls,
    state,
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: ACCOUNT.accountID,
          characterID: CHARACTER_ID,
          characterName: "Test Pilot",
          stationID: STATION_ID,
          structureID: null,
          solarSystemID: SOLAR_SYSTEM_ID,
          corporationID: CORPORATION_ID,
          shipID: state.selectedShipID,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: CHARACTER_ID };
    },
    async readFlightStatus(bridgeSessionID, sessionFields) {
      calls.flight.push({ bridgeSessionID, sessionFields });
      return { flight: { ...state.flight }, notifications: [] };
    },
    async readSpaceSnapshot(bridgeSessionID, sessionFields) {
      calls.space.push({ bridgeSessionID, sessionFields });
      return {
        space: {
          entities: state.droneIDsInSpace.map((itemID) => ({
            kind: "drone",
            itemID,
            typeID: 2488,
            name: "Warrior II",
            ownerID: CHARACTER_ID,
            controllerID: SHIP_ID,
            droneActivity: "idle",
          })),
        },
        notifications: [],
      };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      return {
        service,
        method,
        result: method === "ScoopDrone" ? { type: "dict", entries: [] } : null,
        notifications: [],
      };
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      throw new Error(`unexpected bound-object dispatch: ${service}.${method}`);
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.boundCall.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      throw new Error(`unexpected bound method: ${service}.${method}`);
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
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function apiRequest(baseUrl, path, options = {}) {
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      cookie: `evejs_web_poc=${COOKIE_TOKEN}`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

async function selectOnServer(baseUrl) {
  const { response } = await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: CHARACTER_ID },
  });
  assert.equal(response.status, 200);
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  }
  await Promise.all(closing);
});

const ROUTES = [
  [
    "/api/bridge/dogma/ammo/load",
    { moduleIDs: [MODULE_ID], chargeItemIDs: [CHARGE_ITEM_ID], source: "cargo" },
  ],
  [
    "/api/bridge/dogma/ammo/unload",
    { moduleIDs: [MODULE_ID], destination: "cargo" },
  ],
  ["/api/bridge/drones/scoop", { droneIDs: [DRONE_ID] }],
];

test("all three dedicated writes refuse without explicit confirmation before reading or dispatching", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  for (const [path, body] of ROUTES) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 400, `${path} must refuse without confirm:true`);
    assert.equal(payload.error, "CONFIRMATION_REQUIRED");
  }

  assert.equal(gateway.calls.flight.length, 0, "confirmation refusal must happen before a live-context read");
  assert.equal(gateway.calls.call.length, 0, "confirmation refusal must not dispatch a target method");
});

test("invalid IDs, quantities, and semantic locations fail before any live read or method dispatch", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const invalid = [
    [
      "/api/bridge/dogma/ammo/load",
      { moduleIDs: [true], chargeItemIDs: [CHARGE_ITEM_ID], source: "cargo", confirm: true },
      "INVALID_MODULE_IDS",
    ],
    [
      "/api/bridge/dogma/ammo/load",
      { moduleIDs: [MODULE_ID], chargeItemIDs: [0], source: "cargo", confirm: true },
      "INVALID_CHARGE_IDS",
    ],
    [
      "/api/bridge/dogma/ammo/load",
      { moduleIDs: [MODULE_ID], chargeItemIDs: [CHARGE_ITEM_ID], source: ["cargo"], confirm: true },
      "INVALID_AMMO_LOCATION",
    ],
    [
      "/api/bridge/dogma/ammo/unload",
      { moduleIDs: [1.5], destination: "cargo", confirm: true },
      "INVALID_MODULE_IDS",
    ],
    [
      "/api/bridge/dogma/ammo/unload",
      { moduleIDs: [MODULE_ID], destination: "cargo", quantity: 0, confirm: true },
      "INVALID_QUANTITY",
    ],
    [
      "/api/bridge/dogma/ammo/unload",
      { moduleIDs: [MODULE_ID], destination: "foreign", confirm: true },
      "INVALID_AMMO_LOCATION",
    ],
    ["/api/bridge/drones/scoop", { droneIDs: [DRONE_ID, -1], confirm: true }, "INVALID_DRONE_IDS"],
  ];

  for (const [path, body, expectedError] of invalid) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 400, `${path} should reject ${expectedError}`);
    assert.equal(payload.error, expectedError);
  }

  assert.equal(gateway.calls.flight.length, 0, "malformed input must fail before resolving live state");
  assert.equal(gateway.calls.call.length, 0, "malformed input must fail before dispatch");
});

test("LoadAmmo pins the active ship and cargo source instead of forwarding injected ids", async () => {
  const gateway = fakeGateway({
    flight: { inSpace: true, docked: false, stationID: null, structureID: null },
  });
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/dogma/ammo/load", {
    method: "POST",
    body: {
      moduleIDs: [MODULE_ID, SECOND_MODULE_ID],
      chargeItemIDs: [CHARGE_ITEM_ID, SECOND_CHARGE_ITEM_ID],
      source: "cargo",
      // These fields are deliberately outside the route contract. Their values
      // must never influence the concrete RPC arguments.
      shipID: OTHER_SHIP_ID,
      ammoLocationID: FOREIGN_LOCATION_ID,
      sourceLocationID: FOREIGN_LOCATION_ID,
      confirm: true,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  assert.equal(gateway.calls.call.length, 1);
  const call = gateway.calls.call[0];
  assert.equal(call.service, "dogmaIM");
  assert.equal(call.method, "LoadAmmo");
  assert.deepEqual(call.args, [
    SHIP_ID,
    [MODULE_ID, SECOND_MODULE_ID],
    [CHARGE_ITEM_ID, SECOND_CHARGE_ITEM_ID],
    SHIP_ID,
  ]);
  assert.equal(gateway.calls.bind.length, 0, "LoadAmmo is the existing top-level dogma pair");
});

test("current station hangar is server-resolved instead of accepting a location id", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const { response } = await apiRequest(baseUrl, "/api/bridge/dogma/ammo/load", {
    method: "POST",
    body: {
      moduleIDs: [MODULE_ID],
      chargeItemIDs: [CHARGE_ITEM_ID],
      source: "hangar",
      ammoLocationID: FOREIGN_LOCATION_ID,
      confirm: true,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(gateway.calls.call.length, 1);
  assert.deepEqual(gateway.calls.call[0].args, [
    SHIP_ID,
    [MODULE_ID],
    [CHARGE_ITEM_ID],
    STATION_ID,
  ]);
});

test("current structure hangar is server-resolved for both load and unload", async () => {
  const gateway = fakeGateway({
    flight: {
      inSpace: false,
      docked: true,
      stationID: null,
      structureID: STRUCTURE_ID,
    },
  });
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const load = await apiRequest(baseUrl, "/api/bridge/dogma/ammo/load", {
    method: "POST",
    body: {
      moduleIDs: [MODULE_ID],
      chargeItemIDs: [CHARGE_ITEM_ID],
      source: "hangar",
      ammoLocationID: FOREIGN_LOCATION_ID,
      confirm: true,
    },
  });
  assert.equal(load.response.status, 200);

  const unload = await apiRequest(baseUrl, "/api/bridge/dogma/ammo/unload", {
    method: "POST",
    body: {
      moduleIDs: [MODULE_ID],
      destination: "hangar",
      destinationLocationID: FOREIGN_LOCATION_ID,
      confirm: true,
    },
  });
  assert.equal(unload.response.status, 200);

  assert.deepEqual(gateway.calls.call.map((call) => [call.service, call.method, call.args]), [
    ["dogmaIM", "LoadAmmo", [SHIP_ID, [MODULE_ID], [CHARGE_ITEM_ID], STRUCTURE_ID]],
    ["dogmaIM", "UnloadAmmo", [SHIP_ID, [MODULE_ID], [STRUCTURE_ID, CHARACTER_ID, 4]]],
  ]);
});

test("UnloadAmmo pins cargo destination and validates a positive partial quantity", async () => {
  const gateway = fakeGateway({
    flight: { inSpace: true, docked: false, stationID: null, structureID: null },
  });
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const { response } = await apiRequest(baseUrl, "/api/bridge/dogma/ammo/unload", {
    method: "POST",
    body: {
      moduleIDs: [MODULE_ID],
      destination: "cargo",
      quantity: 12,
      shipID: OTHER_SHIP_ID,
      destinationLocationID: FOREIGN_LOCATION_ID,
      confirm: true,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(gateway.calls.call.length, 1);
  assert.equal(gateway.calls.call[0].service, "dogmaIM");
  assert.equal(gateway.calls.call[0].method, "UnloadAmmo");
  assert.deepEqual(gateway.calls.call[0].args, [
    SHIP_ID,
    [MODULE_ID],
    [SHIP_ID, CHARACTER_ID, 5],
    12,
  ]);
});

test("ScoopDrone is top-level, in-space, active-ship-pinned, and preserves per-drone result data", async () => {
  const gateway = fakeGateway({
    flight: { inSpace: true, docked: false, stationID: null, structureID: null },
  });
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones/scoop", {
    method: "POST",
    body: {
      droneIDs: [DRONE_ID, SECOND_DRONE_ID],
      shipID: OTHER_SHIP_ID,
      confirm: true,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(payload.result, { type: "dict", entries: [] });
  assert.equal(gateway.calls.call.length, 1);
  assert.equal(gateway.calls.call[0].service, "ship");
  assert.equal(gateway.calls.call[0].method, "ScoopDrone");
  assert.deepEqual(gateway.calls.call[0].args, [[DRONE_ID, SECOND_DRONE_ID]]);
  assert.equal(gateway.calls.bind.length, 0);
  // ⚠ THE REGRESSION THIS PINS. ScoopDrone's own dict is empty on success just
  // like the entity orders, so the page judges a scoop by whether the drone
  // LEFT space. While this route answered the bare ack, `inSpace` arrived
  // undefined and every scoop — the ones that worked included — reported "The
  // scoop was accepted, but space could not be re-read."
  assert.equal(gateway.calls.space.length, 1, "space is re-read AFTER the scoop");
  assert.ok(Array.isArray(payload.inSpace), "inSpace must be a list, not undefined");
  assert.deepEqual(payload.inSpace, [], "both drones left space — the scoop landed");
});

test("a scoop that moved only one of them leaves the other in the answer's inSpace", async () => {
  const gateway = fakeGateway({
    flight: { inSpace: true, docked: false, stationID: null, structureID: null },
    droneIDsInSpace: [SECOND_DRONE_ID],
  });
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones/scoop", {
    method: "POST",
    body: { droneIDs: [DRONE_ID, SECOND_DRONE_ID], confirm: true },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.inSpace.length, 1);
  assert.equal(payload.inSpace[0].itemID, SECOND_DRONE_ID);
});

test("a scoop whose snapshot read fails answers inSpace:null — NOT an empty space", async () => {
  const gateway = fakeGateway({
    flight: { inSpace: true, docked: false, stationID: null, structureID: null },
  });
  gateway.readSpaceSnapshot = async () => {
    throw new Error("snapshot unavailable");
  };
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/drones/scoop", {
    method: "POST",
    body: { droneIDs: [DRONE_ID], confirm: true },
  });

  assert.equal(response.status, 200, "the scoop itself still happened");
  assert.equal(payload.inSpace, null, "null is 'we could not look', which the page reports as such");
});

test("location and active-ship preconditions fail without dispatch", async () => {
  const gateway = fakeGateway({
    flight: { inSpace: true, docked: false, stationID: null, structureID: null },
  });
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const hangarInSpace = await apiRequest(baseUrl, "/api/bridge/dogma/ammo/load", {
    method: "POST",
    body: {
      moduleIDs: [MODULE_ID],
      chargeItemIDs: [CHARGE_ITEM_ID],
      source: "hangar",
      confirm: true,
    },
  });
  assert.equal(hangarInSpace.response.status, 409);
  assert.equal(hangarInSpace.payload.error, "NOT_DOCKED");
  assert.equal(gateway.calls.call.length, 0);

  gateway.state.flight = {
    ...gateway.state.flight,
    inSpace: false,
    docked: true,
    stationID: STATION_ID,
  };
  const scoopWhileDocked = await apiRequest(baseUrl, "/api/bridge/drones/scoop", {
    method: "POST",
    body: { droneIDs: [DRONE_ID], confirm: true },
  });
  assert.equal(scoopWhileDocked.response.status, 409);
  assert.equal(scoopWhileDocked.payload.error, "NOT_IN_SPACE");
  assert.equal(gateway.calls.call.length, 0);

  gateway.state.flight = {
    ...gateway.state.flight,
    inSpace: true,
    docked: false,
    stationID: null,
    shipID: OTHER_SHIP_ID,
  };
  const staleShip = await apiRequest(baseUrl, "/api/bridge/dogma/ammo/unload", {
    method: "POST",
    body: { moduleIDs: [MODULE_ID], destination: "cargo", confirm: true },
  });
  assert.equal(staleShip.response.status, 409);
  assert.equal(staleShip.payload.error, "ACTIVE_SHIP_CHANGED");
  assert.equal(gateway.calls.call.length, 0);
});

test("confirmed routes still refuse without a held bridge session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);

  for (const [path, body] of ROUTES) {
    const { response, payload } = await apiRequest(baseUrl, path, {
      method: "POST",
      body: { ...body, confirm: true },
    });
    assert.equal(response.status, 409);
    assert.equal(payload.error, "NO_LIVE_SESSION");
  }
  assert.equal(gateway.calls.flight.length, 0);
  assert.equal(gateway.calls.call.length, 0);
});
