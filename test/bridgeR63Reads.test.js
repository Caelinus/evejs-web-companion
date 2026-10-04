"use strict";

// Goal R63 (PLUMBING ONLY — no UI): the structure-directory READ route wired for
// later UI. GET /api/bridge/structures dispatches allowlisted TOP-LEVEL reads on
// the held session:
//   • EIGHT always-issued session/access-scoped reads: GetMyCorporationStructures,
//     GetCorporationStructures, GetMyDockableStructures([sys]), GetStructureMapData([sys]),
//     GetMyAccessibleOnlineCynoBeaconStructures, GetSolarSystemsWithBeacons,
//     GetValidWarHQs([ownerID]), GetJumpBridgesWithMyAccess.
//   • GetStructureDescription([structureID]) only when ?structureID= is given.
//   • CheckMyDockingAccessToStructures([[ids]]) only when ?structureIDs= is given.
// ⚠ GetStructures and GetMyCharacterStructures are NOT wired (operational-calendar
// leaks) — the route must never dispatch them.
// solarSystemID defaults to the session system; ownerID defaults to the session corp.
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
const SESSION_STATION_ID = 60003760;
const SESSION_SYSTEM_ID = 30000142;
const SESSION_CORP_ID = 98000000;

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

// Sentinel results — the route must pass each through verbatim.
const MY_CORP_RESULT = { tag: "myCorporationStructures" };
const CORP_RESULT = { tag: "corporationStructures" };
const DOCKABLE_RESULT = { tag: "myDockableStructures" };
const MAP_RESULT = { tag: "structureMapData" };
const CYNO_RESULT = { tag: "cynoBeacons" };
const BEACON_SYS_RESULT = { tag: "solarSystemsWithBeacons" };
const WARHQ_RESULT = { tag: "validWarHQs" };
const JUMP_RESULT = { tag: "jumpBridges" };
const DESCRIPTION_RESULT = { tag: "structureDescription" };
const DOCKING_RESULT = { tag: "dockingAccess" };

const RESULTS = {
  "structureDirectory.GetMyCorporationStructures": MY_CORP_RESULT,
  "structureDirectory.GetCorporationStructures": CORP_RESULT,
  "structureDirectory.GetMyDockableStructures": DOCKABLE_RESULT,
  "structureDirectory.GetStructureMapData": MAP_RESULT,
  "structureDirectory.GetMyAccessibleOnlineCynoBeaconStructures": CYNO_RESULT,
  "structureDirectory.GetSolarSystemsWithBeacons": BEACON_SYS_RESULT,
  "structureDirectory.GetValidWarHQs": WARHQ_RESULT,
  "structureDirectory.GetJumpBridgesWithMyAccess": JUMP_RESULT,
  "structureDirectory.GetStructureDescription": DESCRIPTION_RESULT,
  "structureDirectory.CheckMyDockingAccessToStructures": DOCKING_RESULT,
};

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
  return { getStation() { return null; }, getTypeName(id) { return `Type ${id}`; }, getSolarSystemName() { return "Nonni"; } };
}

function fakeGateway(overrides = {}) {
  const calls = { select: [], call: [] };
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
          stationID: SESSION_STATION_ID,
          structureID: null,
          solarSystemID: SESSION_SYSTEM_ID,
          corporationID: SESSION_CORP_ID,
          shipID: 9001,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: 7 };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      const key = `${service}.${method}`;
      return { service, method, result: key in RESULTS ? RESULTS[key] : null, notifications: [] };
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

function callFor(gateway, method) {
  return gateway.calls.call.find((c) => c.method === method);
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

test("access-scoped all-system search returns named structures but not inaccessible IDs", async () => {
  const owned = 1_030_000_000_001, foreign = 1_030_000_000_002;
  const gateway = fakeGateway({
    async callMethod(service, method, args) {
      gateway.calls.call.push({ service, method, args });
      if (method === "GetMyDockableStructures") return { result: { type: "list", items: [owned] } };
      if (method === "GetStructureInfo") {
        assert.equal(args[0], owned, "foreign structure name must not be requested");
        return { result: { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
          ["itemName", "WC QA Astrahus"], ["solarSystemID", 30001300], ["typeID", 35832],
        ] } } };
      }
      if (method === "CheckMyDockingAccessToStructures") return { result: { type: "list", items: args[0].filter((id) => id === owned) } };
      return { result: null };
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const search = await apiRequest(baseUrl, "/api/dockable-structures/find?q=Astrahus");
  assert.equal(search.response.status, 200);
  assert.deepEqual(search.payload.matches.map((row) => row.id), [owned]);
  assert.deepEqual(callFor(gateway, "GetMyDockableStructures").args, [0]);
  const denied = await apiRequest(baseUrl, `/api/dockable-structures/${foreign}`);
  assert.equal(denied.response.status, 409);
  assert.equal(gateway.calls.call.filter((call) => call.method === "GetStructureInfo").length, 1);
});

test("stock docking access does not manufacture unavailable structure service capability", async () => {
  const id = 1_030_000_000_003;
  let access = true;
  const gateway = fakeGateway({
    async callMethod(_service, method) {
      if (method === "CheckMyDockingAccessToStructures") return { result: { type: "list", items: access ? [id] : [] } };
      if (method === "GetMyAccessibleStructureServices") assert.fail("Private service authority must not be called");
      return { result: null };
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const okay = await apiRequest(baseUrl, `/api/dockable-structures/${id}/services`);
  assert.equal(okay.response.status, 409);
  assert.equal(okay.payload.error, "STRUCTURE_SERVICE_AUTHORITY_UNAVAILABLE");
  assert.equal(okay.payload.serviceIDs, undefined);
  access = false;
  const denied = await apiRequest(baseUrl, `/api/dockable-structures/${id}/services`);
  assert.notEqual(denied.response.status, 200);
});

// --- always-on reads --------------------------------------------------------

test("GET /api/bridge/structures dispatches the eight session/access-scoped reads, NOT the leaky ones", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/structures");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.myCorporationStructures, MY_CORP_RESULT);
  assert.deepEqual(payload.corporationStructures, CORP_RESULT);
  assert.deepEqual(payload.myDockableStructures, DOCKABLE_RESULT);
  assert.deepEqual(payload.structureMapData, MAP_RESULT);
  assert.deepEqual(payload.cynoBeacons, CYNO_RESULT);
  assert.deepEqual(payload.solarSystemsWithBeacons, BEACON_SYS_RESULT);
  assert.deepEqual(payload.validWarHQs, WARHQ_RESULT);
  assert.deepEqual(payload.jumpBridges, JUMP_RESULT);
  // The conditional reads are not issued without their ids.
  assert.equal(payload.structureDescription, null);
  assert.equal(payload.dockingAccess, null);

  // Every read is on structureDirectory, on the held session.
  for (const method of [
    "GetMyCorporationStructures",
    "GetCorporationStructures",
    "GetMyDockableStructures",
    "GetStructureMapData",
    "GetMyAccessibleOnlineCynoBeaconStructures",
    "GetSolarSystemsWithBeacons",
    "GetValidWarHQs",
    "GetJumpBridgesWithMyAccess",
  ]) {
    const read = callFor(gateway, method);
    assert.ok(read, `${method} issued`);
    assert.equal(read.service, "structureDirectory", method);
    assert.equal(read.bridgeSessionID, BRIDGE_SESSION_ID, method);
  }

  // ⚠ The two OPERATIONAL-CALENDAR reads are NEVER dispatched by this route.
  assert.equal(callFor(gateway, "GetMyCharacterStructures"), undefined);
  assert.equal(callFor(gateway, "GetStructures"), undefined);
  assert.equal(callFor(gateway, "GetStructureDescription"), undefined);
  assert.equal(callFor(gateway, "CheckMyDockingAccessToStructures"), undefined);
});

test("the always-on read args default off the session (system + corp)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/structures");
  // GetMyDockableStructures + GetStructureMapData take the session system.
  assert.deepEqual(callFor(gateway, "GetMyDockableStructures").args, [SESSION_SYSTEM_ID]);
  assert.deepEqual(callFor(gateway, "GetStructureMapData").args, [SESSION_SYSTEM_ID]);
  // GetValidWarHQs takes the session corp (gated to own corp/alliance server-side).
  assert.deepEqual(callFor(gateway, "GetValidWarHQs").args, [SESSION_CORP_ID]);
  // The corp/cyno/beacon/jump reads are arg-less.
  assert.deepEqual(callFor(gateway, "GetMyCorporationStructures").args, []);
  assert.deepEqual(callFor(gateway, "GetJumpBridgesWithMyAccess").args, []);
  assert.deepEqual(payload.requested, {
    solarSystemID: SESSION_SYSTEM_ID,
    structureID: null,
    structureIDs: null,
    ownerID: SESSION_CORP_ID,
  });
});

test("?solarSystemID= and ?ownerID= override the session defaults", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(
    baseUrl,
    "/api/bridge/structures?solarSystemID=30000144&ownerID=98000001",
  );
  assert.deepEqual(callFor(gateway, "GetMyDockableStructures").args, [30000144]);
  assert.deepEqual(callFor(gateway, "GetStructureMapData").args, [30000144]);
  assert.deepEqual(callFor(gateway, "GetValidWarHQs").args, [98000001]);
  assert.deepEqual(payload.requested, {
    solarSystemID: 30000144,
    structureID: null,
    structureIDs: null,
    ownerID: 98000001,
  });
});

// --- conditional reads ------------------------------------------------------

test("?structureID= issues GetStructureDescription with the forwarded id", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/structures?structureID=1030000000001");
  assert.deepEqual(payload.structureDescription, DESCRIPTION_RESULT);
  assert.deepEqual(callFor(gateway, "GetStructureDescription").args, [1030000000001]);
  assert.equal(callFor(gateway, "CheckMyDockingAccessToStructures"), undefined);
  assert.deepEqual(payload.requested.structureID, 1030000000001);
});

test("?structureIDs= issues CheckMyDockingAccessToStructures with the forwarded id LIST", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(
    baseUrl,
    "/api/bridge/structures?structureIDs=1030000000001,1030000000000,0,-3",
  );
  assert.deepEqual(payload.dockingAccess, DOCKING_RESULT);
  // ⚠ The handler takes a LIST as its single positional arg: [[id, id]].
  assert.deepEqual(callFor(gateway, "CheckMyDockingAccessToStructures").args, [
    [1030000000001, 1030000000000],
  ]);
  // The non-positive ids were dropped before forwarding.
  assert.deepEqual(payload.requested.structureIDs, [1030000000001, 1030000000000]);
  assert.equal(callFor(gateway, "GetStructureDescription"), undefined);
});

// --- error handling ---------------------------------------------------------

test("one failed structures read carries its own error code; the rest still return", async () => {
  const gateway = fakeGateway({
    async callMethod(service, method) {
      if (method === "GetMyCorporationStructures") {
        // e.g. CrpAccessDenied when the character lacks the manager role.
        const error = new Error("CrpAccessDenied");
        error.code = "CALL_FAILED";
        error.statusCode = 502;
        throw error;
      }
      const key = `${service}.${method}`;
      return { service, method, result: key in RESULTS ? RESULTS[key] : null, notifications: [] };
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/structures");
  assert.equal(response.status, 200);
  assert.equal(payload.myCorporationStructures, null, "the failed read has no value");
  assert.equal(payload.errors.myCorporationStructures, "CALL_FAILED", "the failed read carries its code");
  assert.deepEqual(payload.validWarHQs, WARHQ_RESULT, "the other reads still return");
});

test("a lost live session unwinds the R63 route (404 SESSION_NOT_FOUND)", async () => {
  const gateway = fakeGateway({
    async callMethod() {
      const error = new Error("gone");
      error.code = "SESSION_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/structures");
  assert.equal(response.status, 404);
  assert.equal(payload.error, "SESSION_NOT_FOUND");
});

test("the R63 route requires a live session (409 NO_LIVE_SESSION with no character online)", async () => {
  const { baseUrl } = await startTestServer();
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/structures");
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_LIVE_SESSION");
});
