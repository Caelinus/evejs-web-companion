"use strict";

// Goal R60 (PLUMBING ONLY — no UI): the three lookup/presence/social READ routes
// wired for later UI. Each dispatches allowlisted TOP-LEVEL reads on the held
// session:
//   • GET /api/bridge/lookup — the nine lookupSvc SEARCH reads. ⚠ THESE TAKE A
//     QUERY: the eight name/owner/faction searches get [q, exact]; Lookup-
//     KnownLocationsByGroup gets [groupID, q, exact]. Nine INDEPENDENT reads;
//     empty ≠ failed.
//   • GET /api/bridge/presence — onlineStatus.GetOnlineStatus([targetID]) +
//     GetInitialState (arg-less) + Prime (arg-less).
//   • GET /api/bridge/social — LSC.GetChannels (arg-less) + account.GetDefault-
//     ContactCost (arg-less).
// The fixtures are the real retail shapes captured live from Farmer on
// 2026-07-22. Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTERS = [{ characterID: 7, accountID: 4, characterName: "Test Pilot" }];
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

function keyVal(entries) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}
function list(items) {
  return { type: "list", items };
}
function rowset(name, header, lines) {
  return {
    type: "object",
    name,
    args: {
      type: "dict",
      entries: [
        ["header", list(header)],
        ["columns", list(header)],
        ["RowClass", { type: "token", value: "util.Row" }],
        ["lines", list(lines)],
      ],
    },
  };
}

// The real captured lookup shapes (Farmer, q="Farmer"/"Caldari"/location).
const CHARACTERS_RESULT = list([
  keyVal([
    ["characterID", 140000005],
    ["characterName", "Farmer"],
    ["ownerID", 140000005],
    ["ownerName", "Farmer"],
    ["typeID", 1386],
    ["groupID", 1],
    ["corporationID", 98000001],
    ["allianceID", 0],
  ]),
]);
const CORPORATIONS_RESULT = list([
  keyVal([
    ["corporationID", 98000001],
    ["corporationName", "Farmer Corporation"],
    ["ownerID", 98000001],
    ["ownerName", "Farmer Corporation"],
    ["typeID", 2],
    ["groupID", 2],
    ["tickerName", "TRAV"],
    ["factionID", 0],
    ["isNPC", false],
  ]),
]);
const FACTIONS_RESULT = list([
  keyVal([
    ["factionID", 500001],
    ["factionName", "Caldari State"],
    ["ownerID", 500001],
    ["ownerName", "Caldari State"],
    ["typeID", 30],
    ["groupID", 19],
  ]),
]);
const OWNERS_RESULT = list([
  keyVal([
    ["ownerID", 140000005],
    ["ownerName", "Farmer"],
    ["typeID", 1386],
    ["groupID", 1],
    ["gender", 1],
    ["characterID", 140000005],
    ["corporationID", 98000001],
    ["allianceID", 0],
  ]),
]);
const LOCATIONS_RESULT = list([
  keyVal([
    ["itemID", 30000502],
    ["itemName", "E-1XVP"],
    ["typeID", 5],
    ["groupID", 5],
    ["solarSystemID", 30000502],
    ["constellationID", 20000073],
    ["regionID", 10000005],
  ]),
]);
const WARABLE_RESULT = list([
  keyVal([["ownerID", 98000001], ["ownerName", "Farmer Corporation"], ["typeID", 2], ["warPermit", 1]]),
]);
// presence: onlineStatus a bare boolean; initialState/prime an empty Rowset.
const ONLINE_STATUS_RESULT = false;
const INITIAL_STATE_RESULT = rowset(
  "eve.common.script.sys.rowset.Rowset",
  ["contactID", "online"],
  [],
);
// social: one Local channel; null contact cost.
const CHANNELS_RESULT = rowset(
  "util.Rowset",
  [
    "channelID",
    "ownerID",
    "displayName",
    "motd",
    "comparisonKey",
    "memberless",
    "password",
    "mailingList",
    "cspa",
    "temporary",
    "languageRestriction",
    "groupMessageID",
    "channelMessageID",
    "mode",
    "subscribed",
    "estimatedMemberCount",
  ],
  [list([30000144, 1, "Local", "motd", "local_30000144", false, null, false, 0, false, false, 0, 0, 3, true, 1])],
);
const DEFAULT_CONTACT_COST_RESULT = null;

const RESULTS = {
  "lookupSvc.LookupCharacters": CHARACTERS_RESULT,
  "lookupSvc.LookupEvePlayerCharacters": CHARACTERS_RESULT,
  "lookupSvc.LookupCorporations": CORPORATIONS_RESULT,
  "lookupSvc.LookupFactions": FACTIONS_RESULT,
  "lookupSvc.LookupOwners": OWNERS_RESULT,
  "lookupSvc.LookupPCOwners": OWNERS_RESULT,
  "lookupSvc.LookupNoneNPCAccountOwners": OWNERS_RESULT,
  "lookupSvc.LookupKnownLocationsByGroup": LOCATIONS_RESULT,
  "lookupSvc.LookupWarableCorporationsOrAlliances": WARABLE_RESULT,
  "onlineStatus.GetOnlineStatus": ONLINE_STATUS_RESULT,
  "onlineStatus.GetInitialState": INITIAL_STATE_RESULT,
  "onlineStatus.Prime": INITIAL_STATE_RESULT,
  "LSC.GetChannels": CHANNELS_RESULT,
  "account.GetDefaultContactCost": DEFAULT_CONTACT_COST_RESULT,
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
  return { getStation() { return null; }, getTypeName(id) { return `Type ${id}`; } };
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
          stationID: 60003760,
          structureID: null,
          solarSystemID: 30000142,
          corporationID: 98000000,
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

test("GET /api/bridge/lookup dispatches the nine lookupSvc searches with [q, exact] (and groupID for locations)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/lookup?q=Farmer&exact=1&groupID=15");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.requested, { q: "Farmer", exact: 1, groupID: 15 });
  assert.deepEqual(payload.characters, CHARACTERS_RESULT);
  assert.deepEqual(payload.corporations, CORPORATIONS_RESULT);
  assert.deepEqual(payload.factions, FACTIONS_RESULT);
  assert.deepEqual(payload.owners, OWNERS_RESULT);
  assert.deepEqual(payload.knownLocationsByGroup, LOCATIONS_RESULT);
  assert.deepEqual(payload.warableOwners, WARABLE_RESULT);
  assert.deepEqual(payload.errors, {
    characters: null,
    evePlayerCharacters: null,
    corporations: null,
    factions: null,
    owners: null,
    pcOwners: null,
    nonNPCAccountOwners: null,
    knownLocationsByGroup: null,
    warableOwners: null,
  });

  // The eight name/owner/faction searches carry [q, exact]; the location search
  // carries [groupID, q, exact].
  for (const method of [
    "LookupCharacters",
    "LookupEvePlayerCharacters",
    "LookupCorporations",
    "LookupFactions",
    "LookupOwners",
    "LookupPCOwners",
    "LookupNoneNPCAccountOwners",
    "LookupWarableCorporationsOrAlliances",
  ]) {
    const read = callFor(gateway, method);
    assert.equal(read.service, "lookupSvc", method);
    assert.deepEqual(read.args, ["Farmer", 1], `${method} carries [q, exact]`);
    assert.equal(read.bridgeSessionID, BRIDGE_SESSION_ID);
  }
  const location = callFor(gateway, "LookupKnownLocationsByGroup");
  assert.equal(location.service, "lookupSvc");
  assert.deepEqual(location.args, [15, "Farmer", 1], "LookupKnownLocationsByGroup carries [groupID, q, exact]");
});

test("lookup defaults q to '', exact to 0, groupID to 5 when the query omits them", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/lookup");
  assert.deepEqual(payload.requested, { q: "", exact: 0, groupID: 5 });
  assert.deepEqual(callFor(gateway, "LookupCharacters").args, ["", 0]);
  assert.deepEqual(callFor(gateway, "LookupKnownLocationsByGroup").args, [5, "", 0]);
});

test("GET /api/bridge/presence dispatches GetOnlineStatus([targetID]) + GetInitialState + Prime", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/presence?targetID=140000178");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.requested, { targetID: 140000178 });
  assert.equal(payload.onlineStatus, false);
  assert.deepEqual(payload.initialState, INITIAL_STATE_RESULT);
  assert.deepEqual(payload.prime, INITIAL_STATE_RESULT);
  assert.deepEqual(payload.errors, { onlineStatus: null, initialState: null, prime: null });

  assert.equal(callFor(gateway, "GetOnlineStatus").service, "onlineStatus");
  assert.deepEqual(callFor(gateway, "GetOnlineStatus").args, [140000178]);
  assert.deepEqual(callFor(gateway, "GetInitialState").args, []);
  assert.deepEqual(callFor(gateway, "Prime").args, []);
  for (const method of ["GetOnlineStatus", "GetInitialState", "Prime"]) {
    assert.equal(callFor(gateway, method).bridgeSessionID, BRIDGE_SESSION_ID);
  }
});

test("presence defaults targetID to 0 when the query omits it", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/presence");
  assert.deepEqual(payload.requested, { targetID: 0 });
  assert.deepEqual(callFor(gateway, "GetOnlineStatus").args, [0]);
});

test("GET /api/bridge/social dispatches LSC.GetChannels + account.GetDefaultContactCost (arg-less)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/social");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.channels, CHANNELS_RESULT);
  assert.equal(payload.defaultContactCost, null);
  assert.deepEqual(payload.errors, { channels: null, defaultContactCost: null });

  assert.equal(callFor(gateway, "GetChannels").service, "LSC");
  assert.deepEqual(callFor(gateway, "GetChannels").args, []);
  assert.equal(callFor(gateway, "GetDefaultContactCost").service, "account");
  assert.deepEqual(callFor(gateway, "GetDefaultContactCost").args, []);
});

test("one failed lookup read carries its own error code; the rest still return (empty ≠ failed)", async () => {
  const gateway = fakeGateway({
    async callMethod(service, method) {
      if (method === "LookupFactions") {
        const error = new Error("factions unavailable");
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

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/lookup?q=Farmer");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.characters, CHARACTERS_RESULT, "the other reads still return");
  assert.equal(payload.factions, null, "the failed read has no value");
  assert.equal(payload.errors.factions, "CALL_FAILED", "the failed read carries its code");
  assert.equal(payload.errors.characters, null);
});

test("a lost live session unwinds each R60 route (404 SESSION_NOT_FOUND)", async () => {
  const gateway = fakeGateway({
    async callMethod() {
      const error = new Error("gone");
      error.code = "SESSION_NOT_FOUND";
      error.statusCode = 404;
      throw error;
    },
  });
  for (const path of ["/api/bridge/lookup", "/api/bridge/presence", "/api/bridge/social"]) {
    const { baseUrl } = await startTestServer({ gateway });
    await selectOnServer(baseUrl);
    const { response, payload } = await apiRequest(baseUrl, path);
    assert.equal(response.status, 404, path);
    assert.equal(payload.error, "SESSION_NOT_FOUND", path);
  }
});

test("each R60 route requires a live session (409 NO_LIVE_SESSION with no character online)", async () => {
  for (const path of ["/api/bridge/lookup", "/api/bridge/presence", "/api/bridge/social"]) {
    const { baseUrl } = await startTestServer();
    const { response, payload } = await apiRequest(baseUrl, path);
    assert.equal(response.status, 409, path);
    assert.equal(payload.error, "NO_LIVE_SESSION", path);
  }
});
