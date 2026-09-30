"use strict";

// Goal R12: the BFF ship-fitting routes.
//
// Fitting is the SAME bound-object two-step the R3 inventory routes drive,
// with a SLOT flag instead of hangar (4) / cargo (5) — so these routes reuse
// the existing bind + handle cache, and the interesting parts are:
//
//  - the browser addresses a slot by FAMILY + INDEX; the BFF is the only place
//    that knows slot flagIDs, so none ever reaches browser JS;
//  - the three reads are independent, so one failure never blanks the rest;
//  - a mutating route RE-READS the slots and reports what actually happened,
//    because the server can decline a fit silently;
//  - destroying a rig (irreversible) refuses without an explicit confirmation.
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
const STATION_ID = 60003760;
const ACTIVE_SHIP_ID = 9001;

// Seeded fit: a turret in high slot 1 (flag 27) and a rig in rig slot 1 (92).
const TURRET_ITEM_ID = 5001;
const RIG_ITEM_ID = 5004;
const HANGAR_MODULE_ITEM_ID = 7100;

const SELECT_SESSION_ECHO = {
  userid: 4,
  characterID: 7,
  characterName: "Test Pilot",
  stationID: STATION_ID,
  structureID: null,
  solarSystemID: 30000142,
  corporationID: 98000000,
  shipID: ACTIVE_SHIP_ID,
};

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
  return {
    getStation() { return null; },
    getTypeName(id) { return `Type ${id}`; },
    // Charge fitment, read from static dogma by the fitting route. Only the
    // turret in these fixtures takes charges; everything else reads as "we
    // cannot say", which is what an empty group list means.
    getModuleChargeFitment(typeID) {
      return Number(typeID) === 485
        ? { size: 1, groups: [83] }
        : { size: null, groups: [] };
    },
  };
}

function packedRow(fields) {
  return { type: "packedrow", fields };
}

function shipInfoResult() {
  const attributes = { 48: 168, 49: 3.6, 11: 88.44, 15: 6, 482: null, 18: 460, 1132: 400, 1152: 100, 14: 4, 13: 2, 12: 5, 1137: 3 };
  return {
    type: "dict",
    entries: [[
      ACTIVE_SHIP_ID,
      {
        type: "object",
        name: "util.KeyVal",
        args: {
          type: "dict",
          entries: [
            ["itemID", ACTIVE_SHIP_ID],
            ["attributes", { type: "dict", entries: Object.entries(attributes).map(([id, v]) => [Number(id), v]) }],
          ],
        },
      },
    ]],
  };
}

/**
 * A fake gateway holding a mutable "what is fitted" map, so a fit/unfit/
 * destroy really changes what a follow-up ListByFlags answers — which is what
 * the routes' `applied` verification reads.
 */
function fakeGateway(overrides = {}) {
  const calls = { bind: [], boundCall: [], topLevel: [] };
  // itemID -> flagID
  const fitted = new Map([
    [TURRET_ITEM_ID, 27],
    [RIG_ITEM_ID, 92],
  ]);
  const gateway = {
    calls,
    fitted,
    /** Set false to make Add a no-op — the server's SILENT decline. */
    addApplies: true,
    async selectCharacter(args, kwargs, sessionFields) {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: { ...SELECT_SESSION_ECHO },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: 7 };
    },
    async readFlightStatus() {
      return {
        flight: {
          docked: true,
          inSpace: false,
          stationID: STATION_ID,
          solarSystemID: 30000142,
          shipID: ACTIVE_SHIP_ID,
        },
        notifications: [],
      };
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, bridgeSessionID });
      return {
        boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`,
        service,
        method,
        notifications: [],
      };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.topLevel.push({ service, method, args, kwargs, bridgeSessionID });
      if (method === "ShipGetInfo") {
        return { service, method, result: shipInfoResult(), notifications: [] };
      }
      if (method === "ShipOnlineModules") {
        return { service, method, result: { type: "list", items: [TURRET_ITEM_ID] }, notifications: [] };
      }
      return { service, method, result: null, notifications: [] };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, bridgeSessionID, boundHandle });
      if (method === "ListByFlags") {
        return {
          service,
          method,
          result: {
            type: "list",
            items: [...fitted.entries()].map(([itemID, flagID]) =>
              packedRow({ itemID, typeID: itemID === RIG_ITEM_ID ? 31358 : 3634, flagID })),
          },
          notifications: [],
        };
      }
      if (method === "Add" && gateway.addApplies) {
        const itemID = args[0];
        const flag = kwargs && kwargs.flag;
        if (flag === 4 || flag === 5) {
          fitted.delete(itemID);
        } else {
          fitted.set(itemID, flag);
        }
      }
      if (method === "DestroyFitting") {
        fitted.delete(args[0]);
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

// --- the read ---------------------------------------------------------------

test("GET /api/bridge/fitting reads the slots, the ship's resources and its online modules", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fitting");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.activeShipID, ACTIVE_SHIP_ID);
  assert.ok(payload.slots, "the slot rows are returned raw for browser decoding");
  assert.ok(payload.shipInfo, "the ship attribute dict is returned");
  assert.ok(payload.online, "the online-module list is returned");
  assert.deepEqual(payload.errors, { slots: null, shipInfo: null, online: null });

  // No bound handle ever crosses to the browser.
  assert.equal(JSON.stringify(payload).includes("handle:"), false);

  // The slots come off the SHIP binding (invbroker.GetInventoryFromId), which
  // is the same bind the R3 cargo read uses — one cached handle, not two.
  assert.ok(
    gateway.calls.bind.some((b) => b.service === "invbroker" && b.method === "GetInventoryFromId" && b.args[0] === ACTIVE_SHIP_ID),
  );
  const listByFlags = gateway.calls.boundCall.find((c) => c.method === "ListByFlags");
  assert.ok(listByFlags, "ListByFlags was dispatched on the ship binding");
  // Every slot family is read in one call, using the SERVER's wider ranges.
  for (const flag of [11, 19, 27, 92, 125, 132]) {
    assert.ok(listByFlags.args[0].includes(flag), `slot flag ${flag} is read`);
  }

  // The dogmaIM reads are TOP-LEVEL (no bind): the handler resolves the ship
  // from the session itself.
  const dogmaMethods = gateway.calls.topLevel
    .filter((c) => c.service === "dogmaIM")
    .map((c) => c.method);
  assert.ok(dogmaMethods.includes("ShipGetInfo"));
  assert.ok(dogmaMethods.includes("ShipOnlineModules"));
  assert.equal(
    dogmaMethods.includes("GetAllInfo"),
    false,
    "the session bootstrap call is never used for a panel refresh",
  );
});

test("one failed read does not blank the others (each carries its own error)", async () => {
  const gateway = fakeGateway({
    async callMethod(service, method) {
      if (method === "ShipGetInfo") {
        throw Object.assign(new Error("nope"), { code: "CALL_FAILED" });
      }
      return { service, method, result: { type: "list", items: [] }, notifications: [] };
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/fitting");
  assert.equal(payload.ok, true);
  assert.equal(payload.errors.shipInfo, "CALL_FAILED");
  assert.equal(payload.errors.slots, null);
  assert.ok(payload.slots, "the fit still comes back");
});

test("a fitting read with no active ship answers cleanly rather than failing", async () => {
  // A character with no ship (in a capsule): the select echo carries no shipID,
  // so there is nothing to read a fitting off. Every read reports that reason
  // and the panel says so, instead of the route erroring out.
  const gateway = fakeGateway({
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: { ...SELECT_SESSION_ECHO, shipID: null },
      };
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fitting");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.activeShipID, null);
  assert.deepEqual(payload.errors, {
    slots: "NO_ACTIVE_SHIP",
    shipInfo: "NO_ACTIVE_SHIP",
    online: "NO_ACTIVE_SHIP",
  });
});

// --- fit / unfit ------------------------------------------------------------

test("manual fit at a structure requires fitting service and uses its real hangar location", async () => {
  const structureID = 1_030_000_000_031;
  let fittingOnline = true;
  const gateway = fakeGateway();
  const oldSelect = gateway.selectCharacter.bind(gateway);
  gateway.selectCharacter = async (...args) => {
    const result = await oldSelect(...args);
    return { ...result, session: { ...result.session, stationID: null, structureID } };
  };
  gateway.readFlightStatus = async () => ({ flight: { docked: true, inSpace: false, stationID: null,
    structureID, solarSystemID: 30000142, shipID: ACTIVE_SHIP_ID }, notifications: [] });
  const oldCall = gateway.callMethod.bind(gateway);
  gateway.callMethod = async (service, method, ...rest) => {
    if (method === "CheckMyDockingAccessToStructures") return { result: { type: "list", items: [structureID] }, notifications: [] };
    if (method === "GetMyAccessibleStructureServices") return { result: { type: "list", items: fittingOnline ? [1, 2] : [1] }, notifications: [] };
    return oldCall(service, method, ...rest);
  };
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const fit = await apiRequest(baseUrl, "/api/bridge/fitting/fit", { method: "POST",
    body: { itemID: HANGAR_MODULE_ITEM_ID, source: "hangar", family: "high", index: 1 } });
  assert.equal(fit.response.status, 200, JSON.stringify(fit.payload));
  const add = gateway.calls.boundCall.find((call) => call.method === "Add");
  assert.deepEqual(add.args, [HANGAR_MODULE_ITEM_ID, structureID]);
  fittingOnline = false;
  const blocked = await apiRequest(baseUrl, "/api/bridge/fitting/unfit", { method: "POST",
    body: { itemID: HANGAR_MODULE_ITEM_ID, destination: "hangar" } });
  assert.equal(blocked.response.status, 409);
  assert.equal(gateway.calls.boundCall.filter((call) => call.method === "Add").length, 1);
});

test("fit resolves the browser's (family, index) to a slot flag on the SERVER side", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fitting/fit", {
    method: "POST",
    body: { itemID: HANGAR_MODULE_ITEM_ID, source: "hangar", family: "high", index: 1 },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);

  const add = gateway.calls.boundCall.find((c) => c.method === "Add");
  assert.ok(add, "the fit is invbroker.Add — the same call an inventory move makes");
  // high index 1 -> flag 28. The browser never sent 28.
  assert.equal(add.kwargs.flag, 28);
  assert.deepEqual(add.args, [HANGAR_MODULE_ITEM_ID, STATION_ID], "source is the station hangar");
  // The destination is the SHIP binding, addressed by handle, not repeated in args.
  assert.match(add.boundHandle, /GetInventoryFromId/);
});

test("fitting from the ship's own cargo makes the SHIP the source location", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/fitting/fit", {
    method: "POST",
    body: { itemID: HANGAR_MODULE_ITEM_ID, source: "cargo", family: "low", index: 0 },
  });

  const add = gateway.calls.boundCall.find((c) => c.method === "Add");
  assert.deepEqual(add.args, [HANGAR_MODULE_ITEM_ID, ACTIVE_SHIP_ID]);
  assert.equal(add.kwargs.flag, 11, "low index 0 -> flag 11");
});

test("family 'auto' lets the SERVER choose the slot (the auto-fit flag)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/fitting/fit", {
    method: "POST",
    body: { itemID: HANGAR_MODULE_ITEM_ID, source: "hangar", family: "auto" },
  });

  const add = gateway.calls.boundCall.find((c) => c.method === "Add");
  assert.equal(add.kwargs.flag, 0, "flag 0 is flagAutoFit");
});

test("a slot the ship cannot have is refused before any call is made", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  for (const body of [
    { itemID: HANGAR_MODULE_ITEM_ID, source: "hangar", family: "high", index: 99 },
    { itemID: HANGAR_MODULE_ITEM_ID, source: "hangar", family: "nonsense", index: 0 },
    { itemID: HANGAR_MODULE_ITEM_ID, source: "elsewhere", family: "high", index: 0 },
    { itemID: 0, source: "hangar", family: "high", index: 0 },
  ]) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fitting/fit", {
      method: "POST",
      body,
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(payload.error, "INVALID_FIT");
  }
  assert.equal(
    gateway.calls.boundCall.some((c) => c.method === "Add"),
    false,
    "nothing was dispatched",
  );
});

test("a SILENT decline is reported as applied:false, not as success", async () => {
  // invbroker's skill-gated fit branch returns null without raising, so the
  // call seam looks like success. The route re-reads the slots and reports
  // what actually happened.
  const gateway = fakeGateway();
  gateway.addApplies = false;
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fitting/fit", {
    method: "POST",
    body: { itemID: HANGAR_MODULE_ITEM_ID, source: "hangar", family: "low", index: 0 },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, false, "the BFF re-read and found nothing fitted");
  // And it re-read: a ListByFlags followed the Add.
  const methods = gateway.calls.boundCall.map((c) => c.method);
  assert.ok(methods.indexOf("Add") < methods.lastIndexOf("ListByFlags"));
});

test("unfit is the same Add reversed: the destination container is the bound object", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/fitting/unfit", {
    method: "POST",
    body: { itemID: TURRET_ITEM_ID, destination: "hangar" },
  });
  assert.equal(payload.applied, true);

  const add = gateway.calls.boundCall.find((c) => c.method === "Add");
  assert.deepEqual(add.args, [TURRET_ITEM_ID, ACTIVE_SHIP_ID], "the SHIP is the source now");
  assert.equal(add.kwargs.flag, 4, "into the station hangar");
  assert.match(add.boundHandle, /GetInventory:/, "bound to the station hangar");
});

test("unfitting to the ship's cargo binds the ship and uses the cargo flag", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/fitting/unfit", {
    method: "POST",
    body: { itemID: TURRET_ITEM_ID, destination: "cargo" },
  });

  const add = gateway.calls.boundCall.find((c) => c.method === "Add");
  assert.equal(add.kwargs.flag, 5);
  assert.match(add.boundHandle, /GetInventoryFromId/);
});

// --- online / offline -------------------------------------------------------

test("online / offline are TOP-LEVEL dogmaIM calls carrying the ship and the module", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/fitting/state", {
    method: "POST",
    body: { itemID: TURRET_ITEM_ID, online: true },
  });
  await apiRequest(baseUrl, "/api/bridge/fitting/state", {
    method: "POST",
    body: { itemID: TURRET_ITEM_ID, online: false },
  });

  const dogma = gateway.calls.topLevel.filter(
    (c) => c.service === "dogmaIM" && /ModuleO/.test(c.method),
  );
  assert.deepEqual(
    dogma.map((c) => c.method),
    ["SetModuleOnline", "TakeModuleOffline"],
  );
  assert.deepEqual(dogma[0].args, [ACTIVE_SHIP_ID, TURRET_ITEM_ID]);
});

test("a refusal keeps the HANDLER'S OWN reason all the way to the browser", async () => {
  const gateway = fakeGateway({
    async callMethod(service, method) {
      if (method === "SetModuleOnline") {
        throw Object.assign(new Error("You do not have enough CPU to online that module."), {
          code: "CALL_REFUSED",
          statusCode: 409,
        });
      }
      return { service, method, result: null, notifications: [] };
    },
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fitting/state", {
    method: "POST",
    body: { itemID: TURRET_ITEM_ID, online: true },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "CALL_REFUSED");
  assert.equal(
    payload.message,
    "You do not have enough CPU to online that module.",
    "verbatim — the BFF never rewrites or guesses the reason",
  );
});

// --- the destructive rig path ----------------------------------------------

test("destroying a rig REFUSES without an explicit confirmation", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  for (const body of [{ itemID: RIG_ITEM_ID }, { itemID: RIG_ITEM_ID, confirm: false }, { itemID: RIG_ITEM_ID, confirm: "yes" }]) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fitting/destroy-rig", {
      method: "POST",
      body,
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(payload.error, "CONFIRMATION_REQUIRED");
  }
  assert.equal(
    gateway.calls.boundCall.some((c) => c.method === "DestroyFitting"),
    false,
    "nothing was destroyed",
  );
  assert.equal(gateway.fitted.has(RIG_ITEM_ID), true, "the rig is still fitted");
});

test("a confirmed rig destruction goes through DestroyFitting and is verified", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fitting/destroy-rig", {
    method: "POST",
    body: { itemID: RIG_ITEM_ID, confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);

  const destroy = gateway.calls.boundCall.find((c) => c.method === "DestroyFitting");
  assert.deepEqual(destroy.args, [RIG_ITEM_ID]);
  assert.match(destroy.boundHandle, /GetInventoryFromId/, "on the ship binding");
  assert.equal(gateway.fitted.has(RIG_ITEM_ID), false);
});

test("the destroy route refuses anything that is not a rig on the active ship", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  // A fitted module that is NOT in a rig slot: unfit it instead.
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fitting/destroy-rig", {
    method: "POST",
    body: { itemID: TURRET_ITEM_ID, confirm: true },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "NOT_A_RIG");
  assert.equal(gateway.fitted.has(TURRET_ITEM_ID), true, "the turret survived");

  // And something that is not fitted at all.
  const stranger = await apiRequest(baseUrl, "/api/bridge/fitting/destroy-rig", {
    method: "POST",
    body: { itemID: 999999, confirm: true },
  });
  assert.equal(stranger.response.status, 400);
  assert.equal(stranger.payload.error, "NOT_A_RIG");
});

// --- session guards ---------------------------------------------------------

test("every fitting route needs a live session, and authentication", async () => {
  const { baseUrl } = await startTestServer({ gateway: fakeGateway() });

  const routes = [
    ["GET", "/api/bridge/fitting", undefined],
    ["POST", "/api/bridge/fitting/fit", { itemID: 1, source: "hangar", family: "high", index: 0 }],
    ["POST", "/api/bridge/fitting/unfit", { itemID: 1, destination: "hangar" }],
    ["POST", "/api/bridge/fitting/state", { itemID: 1, online: true }],
    ["POST", "/api/bridge/fitting/destroy-rig", { itemID: 1, confirm: true }],
  ];

  // No character online yet: every route says so rather than half-working.
  for (const [method, path, body] of routes) {
    const { response, payload } = await apiRequest(baseUrl, path, { method, body });
    assert.equal(response.status, 409, `${method} ${path}`);
    assert.equal(payload.error, "NO_LIVE_SESSION");
  }

  // And unauthenticated callers never reach them at all.
  for (const [method, path, body] of routes) {
    const { response } = await apiRequest(baseUrl, path, {
      method,
      body,
      authenticated: false,
    });
    assert.equal(response.status, 401, `${method} ${path} unauthenticated`);
  }
});

// --- R91 fitting-library WRITES (confirm-gated) -----------------------------
//
// SaveManyFittings / DeleteFitting / DeleteManyFittings / UpdateNameAndDescription
// on charFittingMgr and SaveManyFittings on corpFittingMgr. Every route REFUSES
// (400 CONFIRMATION_REQUIRED, no dispatch) unless the browser passes
// `confirm: true`; the two destructive deletes carry the same gate. These tests
// prove the gate, then prove one gated save dispatches on the right service.

const R91_FITTING_WRITE_ROUTES = [
  ["/api/bridge/fittings/save-many", { fittings: [] }, "charFittingMgr", "SaveManyFittings"],
  ["/api/bridge/fittings/delete", { fittingID: 1 }, "charFittingMgr", "DeleteFitting"],
  ["/api/bridge/fittings/delete-many", { fittingIDs: [1] }, "charFittingMgr", "DeleteManyFittings"],
  ["/api/bridge/fittings/update-name", { fittingID: 1, name: "x" }, "charFittingMgr", "UpdateNameAndDescription"],
  ["/api/bridge/corp-fittings/save-many", { fittings: [] }, "corpFittingMgr", "SaveManyFittings"],
];

test("⚠ every R91 fitting write REFUSES without confirm — no dispatch", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  for (const [path, body] of R91_FITTING_WRITE_ROUTES) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 400, `${path} must refuse without confirm`);
    assert.equal(payload.error, "CONFIRMATION_REQUIRED", `${path} must answer CONFIRMATION_REQUIRED`);
  }
  const writeCalls = gateway.calls.topLevel.filter(
    (c) => c.service === "charFittingMgr" || c.service === "corpFittingMgr",
  );
  assert.equal(writeCalls.length, 0, "a refused fitting write must not dispatch");
});

test("a confirmed fitting save dispatches on the right service and method", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fittings/save-many", {
    method: "POST",
    body: { fittings: [], confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  const call = gateway.calls.topLevel.find((c) => c.method === "SaveManyFittings");
  assert.ok(call, "SaveManyFittings must reach the gateway once confirmed");
  assert.equal(call.service, "charFittingMgr");
  // ownerID defaults to 0 → the SESSION owner resolves it server-side.
  assert.equal(Number(call.args[0]), 0);
});
