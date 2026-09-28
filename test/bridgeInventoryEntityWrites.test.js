"use strict";

// Goal R102 (Phase-4 BOUND WRITES): the BFF inventory + drone-command write routes —
// WB-INV (7 invbroker writes: SetLabel / StripFitting / FitFitting /
// AssembleCargoContainer / BreakPlasticWrap / DeliverToCorpHangar /
// DeliverToCorpMember) and WB-ENTITY (4 entity drone commands: CmdReturnHome /
// CmdSalvage / CmdAbandonDrone / CmdReconnectToDrones). PLUMBING ONLY — no UI.
//
// WB-INV rides the invbroker inventory-MANAGER moniker (inventoryManagerBindSpec —
// the SAME handle the R75 inventory READS use); WB-ENTITY rides the R72
// entity.MachoBindObject bind. Each dispatches as a BOUND method (boundCall →
// callBoundMethod), NOT the top-level /call seam. Every route is CONFIRM-GATED:
// without `confirm: true` it answers 400 CONFIRMATION_REQUIRED and NOTHING
// dispatches (no bind, no bound call). This suite proves the gate (all 11 refuse
// without confirm), that representative writes forward their args as a bound call
// ONCE confirmed against a FAKE recording gateway, and that no route dispatches
// without a held bridge session. NO write was ever fired against the live world.

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
const DRONE_ID = 9500001;

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

function fakeGateway(options = {}) {
  const calls = { bind: [], boundCall: [], space: [] };
  return {
    calls,
    // The snapshot the drone verbs are judged by. Reconnect asks for it; the
    // three plumbing-only entity writes must not.
    async readSpaceSnapshot(bridgeSessionID, sessionFields) {
      calls.space.push({ bridgeSessionID, sessionFields });
      return {
        space: {
          entities: [
            {
              kind: "drone",
              itemID: DRONE_ID,
              typeID: 2488,
              name: "Warrior II",
              ownerID: CHARACTER_ID,
              // Controlled AFTER the reconnect, unless the case says otherwise.
              controllerID: options.controllerID === undefined ? SHIP_ID : options.controllerID,
              droneActivity: "idle",
            },
          ],
        },
        notifications: [],
      };
    },
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
      throw new Error(`R102 inventory/entity writes are BOUND — unexpected top-level ${service}.${method}`);
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, bridgeSessionID });
      return { boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`, service, method, notifications: [] };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, bridgeSessionID, boundHandle });
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

// --- the 11 R102 inventory + drone-command write routes ----------------------

const R102_WRITE_ROUTES = [
  // WB-INV (7)
  ["/api/bridge/inventory/set-label", { itemID: 7400000020, label: "My Rifter" }],
  ["/api/bridge/inventory/strip-fitting", {}],
  ["/api/bridge/inventory/fit-fitting", { shipID: SHIP_ID, sourceLocationID: STATION_ID }],
  ["/api/bridge/inventory/assemble-container", { itemID: 7400000030 }],
  ["/api/bridge/inventory/break-plastic-wrap", { itemID: 7400000031 }],
  ["/api/bridge/inventory/deliver-to-corp-hangar", { itemIDs: [7400000020, 7400000021], officeID: 9500001, flag: 116 }],
  ["/api/bridge/inventory/deliver-to-corp-member", { itemIDs: [7400000020], memberID: CHARACTER_ID }],
  // WB-ENTITY (4)
  ["/api/bridge/entity/drones/return-home", { droneIDs: [9000000001] }],
  ["/api/bridge/entity/drones/salvage", { droneIDs: [9000000001], targetID: 5000000009 }],
  ["/api/bridge/entity/drones/abandon", { droneIDs: [9000000001, 9000000002] }],
  ["/api/bridge/entity/drones/reconnect", { droneIDs: [9000000001] }],
];

test("⚠ every R102 inventory/entity write REFUSES without confirm — no bind, no dispatch (nothing fired)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  assert.equal(R102_WRITE_ROUTES.length, 11, "all 11 R102 write routes are covered");
  for (const [path, body] of R102_WRITE_ROUTES) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 400, `${path} must refuse without confirm`);
    assert.equal(payload.error, "CONFIRMATION_REQUIRED", `${path} must answer CONFIRMATION_REQUIRED`);
  }
  assert.equal(gateway.calls.boundCall.length, 0, "a refused write must not dispatch a bound call");
  assert.equal(gateway.calls.bind.length, 0, "a refused write must not even bind the object");
});

test("R102 SetLabel forwards [itemID, label] as a BOUND invbroker manager call once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/set-label", {
    method: "POST",
    body: { itemID: 7400000020, label: "My Rifter", confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, true);
  // Bound, not top-level: the inventory MANAGER moniker is bound (invbroker.MachoBindObject
  // with the [[stationID, groupStation]] args) and the call rides callBoundMethod.
  const bind = gateway.calls.bind.find((c) => c.service === "invbroker");
  assert.ok(bind, "the invbroker inventory manager is bound");
  assert.equal(bind.method, "MachoBindObject");
  assert.equal(Array.isArray(bind.args) && Array.isArray(bind.args[0]), true, "bound on the [[stationID, group]] moniker");
  assert.equal(bind.args[0][0], STATION_ID);
  const call = gateway.calls.boundCall.find((c) => c.method === "SetLabel");
  assert.ok(call, "SetLabel must reach the gateway as a bound call once confirmed");
  assert.equal(call.service, "invbroker");
  assert.deepEqual(call.args, [7400000020, "My Rifter"]);
});

test("⚠ R102 StripFitting dispatches with no args as a bound invbroker call once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/inventory/strip-fitting", {
    method: "POST",
    body: { confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "StripFitting");
  assert.ok(call, "StripFitting must reach the gateway once confirmed");
  assert.equal(call.service, "invbroker");
  assert.deepEqual(call.args, []);
});

test("R102 DeliverToCorpHangar forwards itemIDs/officeID/flag as bound kwargs once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/inventory/deliver-to-corp-hangar", {
    method: "POST",
    body: { itemIDs: [7400000020, 7400000021], officeID: 9500001, flag: 116, confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "DeliverToCorpHangar");
  assert.ok(call, "DeliverToCorpHangar must reach the gateway once confirmed");
  assert.equal(call.service, "invbroker");
  assert.deepEqual(call.kwargs, { itemIDs: [7400000020, 7400000021], officeID: 9500001, flag: 116, qty: null });
});

test("⚠ R102 CmdAbandonDrone forwards [[droneIDs]] as a BOUND entity call once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/entity/drones/abandon", {
    method: "POST",
    body: { droneIDs: [9000000001, 9000000002], confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  const bind = gateway.calls.bind.find((c) => c.service === "entity");
  assert.ok(bind, "the entity object is bound");
  assert.equal(bind.method, "MachoBindObject");
  const call = gateway.calls.boundCall.find((c) => c.method === "CmdAbandonDrone");
  assert.ok(call, "CmdAbandonDrone must reach the gateway once confirmed");
  assert.equal(call.service, "entity");
  assert.deepEqual(call.args, [[9000000001, 9000000002]]);
});

test("R102 CmdSalvage forwards [[droneIDs], targetID] as a bound entity call once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/entity/drones/salvage", {
    method: "POST",
    body: { droneIDs: [9000000001], targetID: 5000000009, confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "CmdSalvage");
  assert.ok(call, "CmdSalvage must reach the gateway once confirmed");
  assert.equal(call.service, "entity");
  assert.deepEqual(call.args, [[9000000001], 5000000009]);
});

// ⚠ THE REGRESSION THIS PINS. Reconnect is the one entity write the Drones
// panel actually calls, and the page judges it by the snapshot — success is the
// drone becoming CONTROLLED, which the call's own empty dict cannot say. While
// this route answered the bare ack, `inSpace` arrived undefined and EVERY
// reconnect, the ones that worked included, reported "The reconnect was
// accepted, but space could not be re-read."
test("⚠ CmdReconnectToDrones answers with the SPACE RE-READ, not the bare ack", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/entity/drones/reconnect", {
    method: "POST",
    body: { droneIDs: [DRONE_ID], confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "CmdReconnectToDrones");
  assert.ok(call, "CmdReconnectToDrones must reach the gateway once confirmed");
  assert.deepEqual(call.args, [[DRONE_ID]]);
  assert.equal(gateway.calls.space.length, 1, "space is re-read AFTER the command");
  assert.ok(Array.isArray(payload.inSpace), "inSpace must be a list, not undefined");
  assert.equal(payload.inSpace.length, 1);
  assert.equal(payload.inSpace[0].itemID, DRONE_ID);
  assert.equal(payload.inSpace[0].controlled, true, "control is what the page reads to say it worked");
  // The per-drone refusal dict still rides along untouched (R34).
  assert.equal(payload.result, null);
});

test("a reconnect the server ignored answers inSpace with the drone STILL uncontrolled", async () => {
  // Same drone, still flown by nobody this hull owns.
  const gateway = fakeGateway({ controllerID: 0 });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload } = await apiRequest(baseUrl, "/api/bridge/entity/drones/reconnect", {
    method: "POST",
    body: { droneIDs: [DRONE_ID], confirm: true },
  });
  assert.equal(payload.inSpace[0].controlled, false);
});

test("the three plumbing-only entity writes keep the bare ack — no snapshot read", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  for (const [path, body] of [
    ["/api/bridge/entity/drones/return-home", { droneIDs: [DRONE_ID] }],
    ["/api/bridge/entity/drones/salvage", { droneIDs: [DRONE_ID], targetID: 5000000009 }],
    ["/api/bridge/entity/drones/abandon", { droneIDs: [DRONE_ID] }],
  ]) {
    const { response, payload } = await apiRequest(baseUrl, path, {
      method: "POST",
      body: { ...body, confirm: true },
    });
    assert.equal(response.status, 200);
    assert.equal(payload.applied, true);
    assert.equal(payload.inSpace, undefined, `${path} is not a panel route and must not re-read space`);
  }
  assert.equal(gateway.calls.space.length, 0, "no snapshot read for the plumbing-only writes");
});

test("R102 write routes refuse without a held bridge session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // No selectOnServer — no held session.
  for (const [path, body] of R102_WRITE_ROUTES) {
    const { response } = await apiRequest(baseUrl, path, { method: "POST", body: { ...body, confirm: true } });
    assert.notEqual(response.status, 200, `${path} must refuse without a held session`);
  }
  assert.equal(gateway.calls.boundCall.length, 0, "no dispatch without a held session");
});
