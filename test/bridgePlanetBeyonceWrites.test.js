"use strict";

// Goal R103 (Phase-4 BOUND WRITES): the BFF planet colony-op + beyonce nav/bookmark
// write routes — WB-PI (4 planetMgr writes: UserUpdateNetwork / UserLaunchCommodities
// / UserTransferCommodities / UserAbandonPlanet) and WB-BEYONCE (7 beyonce nav/bookmark
// writes: CmdGotoPoint / CmdGotoBookmark / CmdAbandonLoot / CmdFleetTagTarget /
// CmdJumpThroughFleet / BookmarkLocation / BookmarkScanResult). PLUMBING ONLY — no UI.
//
// WB-PI rides the planetMgr.MachoBindObject(planetID) bind (planetBindSpec — the SAME
// handle the R77 colony READS use); WB-BEYONCE rides the beyonce remote-park bind
// (parkBindSpec(solarSystemID) — the SAME handle the R5a/R13 movement verbs use). Each
// dispatches as a BOUND method (boundCall → callBoundMethod), NOT the top-level /call
// seam. Every route is CONFIRM-GATED: without `confirm: true` it answers 400
// CONFIRMATION_REQUIRED and NOTHING dispatches (no bind, no bound call). This suite
// proves the gate (all 11 refuse without confirm), that representative writes forward
// their args as a bound call ONCE confirmed against a FAKE recording gateway, and that
// no route dispatches without a held bridge session. NO write was ever fired against
// the live world (operator owns EveJS; no server restart).

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
const PLANET_ID = 40009077;

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

// `inSpace` toggles the flight snapshot: the beyonce nav/bookmark writes require the
// ship in space (dispatchBoundBeyonceWrite calls requireInSpace); the planet writes
// never read flight (colony ops are docked-safe).
function fakeGateway(options = {}) {
  const state = { inSpace: options.inSpace === true, solarSystemID: SOLAR_SYSTEM_ID };
  const calls = { bind: [], boundCall: [] };
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
        flight: {
          docked: !state.inSpace,
          inSpace: state.inSpace,
          stationID: state.inSpace ? 0 : STATION_ID,
          solarSystemID: state.solarSystemID,
          shipID: SHIP_ID,
        },
        notifications: [],
      };
    },
    async readSpaceSnapshot() {
      return { space: { inSpace: state.inSpace, shipID: SHIP_ID, solarSystemID: state.solarSystemID,
        ship: { itemID: SHIP_ID, characterID: CHARACTER_ID }, entities: [] }, notifications: [] };
    },
    async callMethod(service, method) {
      throw new Error(`R103 planet/beyonce writes are BOUND — unexpected top-level ${service}.${method}`);
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, bridgeSessionID });
      return { boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`, service, method, notifications: [] };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, bridgeSessionID, boundHandle });
      if (method === "CmdJumpThroughFleet") {
        state.solarSystemID = Number(args[3]) || state.solarSystemID;
      }
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
  const { payload } = await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: CHARACTER_ID } });
  const ready = await apiRequest(baseUrl, "/api/bridge/drone-recovery/ready", {
    method: "POST", body: { checkID: payload.droneRecoveryCheckID } });
  assert.equal(ready.response.status, 200, JSON.stringify(ready.payload));
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

// --- the 11 R103 planet + beyonce write routes -------------------------------

const R103_WRITE_ROUTES = [
  // WB-PI (4)
  ["/api/bridge/planet/network/update", { planetID: PLANET_ID, changes: [] }],
  ["/api/bridge/planet/commodities/launch", { planetID: PLANET_ID, commandPinID: 1017962292558, commodities: {} }],
  ["/api/bridge/planet/commodities/transfer", { planetID: PLANET_ID, path: [1017962292558], commodities: {} }],
  ["/api/bridge/planet/abandon", { planetID: PLANET_ID }],
  // WB-BEYONCE (7)
  ["/api/bridge/flight/goto-point", { x: 1, y: 2, z: 3 }],
  ["/api/bridge/flight/goto-bookmark", { bookmarkID: 1000000012345 }],
  ["/api/bridge/flight/abandon-loot", { itemIDs: [5000000009] }],
  ["/api/bridge/flight/fleet-tag-target", { itemID: 5000000009, tag: "A" }],
  ["/api/bridge/flight/jump-through-fleet", { otherCharID: 140000002, otherShipID: 9002, beaconID: 6001, solarSystemID: 30000144 }],
  ["/api/bridge/flight/bookmark-location", { itemID: 5000000009, folderID: 0, name: "Spot", comment: "", expiryMode: 0 }],
  ["/api/bridge/flight/bookmark-scan-result", { locationID: 30000142, name: "Sig", comment: "", resultID: 42, folderID: 0, expiryMode: 0 }],
];

test("⚠ every R103 planet/beyonce write REFUSES without confirm — no bind, no dispatch (nothing fired)", async () => {
  const gateway = fakeGateway({ inSpace: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  assert.equal(R103_WRITE_ROUTES.length, 11, "all 11 R103 write routes are covered");
  for (const [path, body] of R103_WRITE_ROUTES) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 400, `${path} must refuse without confirm`);
    assert.equal(payload.error, "CONFIRMATION_REQUIRED", `${path} must answer CONFIRMATION_REQUIRED`);
  }
  assert.equal(gateway.calls.boundCall.length, 0, "a refused write must not dispatch a bound call");
  assert.equal(gateway.calls.bind.length, 0, "a refused write must not even bind the object");
});

// --- WB-PI: bound off the planetMgr planetID bind ----------------------------

test("R103 UserUpdateNetwork binds the planetID and forwards [changes] as a BOUND planetMgr call once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/planet/network/update", {
    method: "POST",
    body: { planetID: PLANET_ID, changes: [{ pinID: 1, typeID: 2 }], confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, true);
  // Bound, not top-level: the planetMgr planet handle is bound (MachoBindObject with
  // the caller-sent planetID) and the call rides callBoundMethod.
  const bind = gateway.calls.bind.find((c) => c.service === "planetMgr");
  assert.ok(bind, "the planetMgr planet is bound");
  assert.equal(bind.method, "MachoBindObject");
  assert.deepEqual(bind.args, [PLANET_ID], "bound on the caller-sent planetID");
  const call = gateway.calls.boundCall.find((c) => c.method === "UserUpdateNetwork");
  assert.ok(call, "UserUpdateNetwork must reach the gateway as a bound call once confirmed");
  assert.equal(call.service, "planetMgr");
  assert.deepEqual(call.args, [[{ pinID: 1, typeID: 2 }]]);
});

test("R103 UserTransferCommodities forwards [path, commodities] as a bound planetMgr call once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/planet/commodities/transfer", {
    method: "POST",
    body: { planetID: PLANET_ID, path: [11, 22], commodities: { "2393": 100 }, confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "UserTransferCommodities");
  assert.ok(call, "UserTransferCommodities must reach the gateway once confirmed");
  assert.equal(call.service, "planetMgr");
  assert.deepEqual(call.args, [[11, 22], { "2393": 100 }]);
});

test("⚠ R103 UserAbandonPlanet binds the planetID and dispatches with no args once confirmed (DESTRUCTIVE)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/planet/abandon", {
    method: "POST",
    body: { planetID: PLANET_ID, confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  const bind = gateway.calls.bind.find((c) => c.service === "planetMgr");
  assert.ok(bind && bind.args[0] === PLANET_ID, "abandon binds the caller-sent planetID");
  const call = gateway.calls.boundCall.find((c) => c.method === "UserAbandonPlanet");
  assert.ok(call, "UserAbandonPlanet must reach the gateway once confirmed");
  assert.equal(call.service, "planetMgr");
  assert.deepEqual(call.args, []);
});

test("R103 a planet write refuses a non-positive planetID before dispatch", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/planet/abandon", {
    method: "POST",
    body: { planetID: 0, confirm: true },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_PLANET");
  assert.equal(gateway.calls.boundCall.length, 0, "an invalid planetID must not dispatch");
});

// --- WB-BEYONCE: bound off the beyonce solar-system park bind -----------------

test("R103 CmdGotoPoint binds the park (solarSystemID) and forwards [x,y,z] as a BOUND beyonce call once confirmed", async () => {
  const gateway = fakeGateway({ inSpace: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/goto-point", {
    method: "POST",
    body: { x: 10, y: -20, z: 30, confirm: true },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.applied, true);
  // Bound on the beyonce remote park: MachoBindObject with the [[solarSystemID, 5]] moniker.
  const bind = gateway.calls.bind.find((c) => c.service === "beyonce");
  assert.ok(bind, "the beyonce remote park is bound");
  assert.equal(bind.method, "MachoBindObject");
  assert.equal(Array.isArray(bind.args) && Array.isArray(bind.args[0]), true, "bound on the [[solarSystemID, group]] moniker");
  assert.equal(bind.args[0][0], SOLAR_SYSTEM_ID);
  const call = gateway.calls.boundCall.find((c) => c.method === "CmdGotoPoint");
  assert.ok(call, "CmdGotoPoint must reach the gateway once confirmed");
  assert.equal(call.service, "beyonce");
  assert.deepEqual(call.args, [10, -20, 30]);
});

test("R103 CmdAbandonLoot forwards [[itemIDs]] as a bound beyonce call once confirmed", async () => {
  const gateway = fakeGateway({ inSpace: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/flight/abandon-loot", {
    method: "POST",
    body: { itemIDs: [5000000009, 5000000010], confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "CmdAbandonLoot");
  assert.ok(call, "CmdAbandonLoot must reach the gateway once confirmed");
  assert.equal(call.service, "beyonce");
  assert.deepEqual(call.args, [[5000000009, 5000000010]]);
});

test("R103 fleet-bridge jump waits for the destination scene and dispatches once", async () => {
  const gateway = fakeGateway({ inSpace: true });
  const destinationSystemID = 30000144;
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/jump-through-fleet", {
    method: "POST",
    body: {
      otherCharID: 140000002,
      otherShipID: 9002,
      beaconID: 6001,
      solarSystemID: destinationSystemID,
      confirm: true,
    },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.flight.solarSystemID, destinationSystemID);
  assert.equal(payload.transition.phase, "ready");
  assert.equal(payload.transition.sceneReady, true);
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdJumpThroughFleet").length,
    1,
    "the bridge jump must never be replayed while the session handoff settles",
  );
});

test("R103 BookmarkLocation forwards positional args + optional subfolder kwarg once confirmed", async () => {
  const gateway = fakeGateway({ inSpace: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/flight/bookmark-location", {
    method: "POST",
    body: { itemID: 5000000009, folderID: 0, name: "Spot", comment: "note", expiryMode: 0, subfolderID: 77, confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "BookmarkLocation");
  assert.ok(call, "BookmarkLocation must reach the gateway once confirmed");
  assert.equal(call.service, "beyonce");
  assert.deepEqual(call.args, [5000000009, 0, "Spot", "note", 0]);
  assert.deepEqual(call.kwargs, { subfolderID: 77 });
});

test("⚠ R103 a beyonce nav write refuses when the ship is NOT in space (409, no dispatch)", async () => {
  const gateway = fakeGateway({ inSpace: false });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/goto-point", {
    method: "POST",
    body: { x: 1, y: 2, z: 3, confirm: true },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NOT_IN_SPACE");
  assert.equal(gateway.calls.boundCall.length, 0, "a docked ship must not dispatch a beyonce nav write");
});

test("R103 write routes refuse without a held bridge session", async () => {
  const gateway = fakeGateway({ inSpace: true });
  const { baseUrl } = await startTestServer({ gateway });
  // No selectOnServer — no held session.
  for (const [path, body] of R103_WRITE_ROUTES) {
    const { response } = await apiRequest(baseUrl, path, { method: "POST", body: { ...body, confirm: true } });
    assert.notEqual(response.status, 200, `${path} must refuse without a held session`);
  }
  assert.equal(gateway.calls.boundCall.length, 0, "no dispatch without a held session");
});
