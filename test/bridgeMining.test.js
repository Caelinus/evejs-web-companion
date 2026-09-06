"use strict";

// Goal R23 slice B: the BFF's half of the mining loop — mine -> haul -> refine.
//
// Note what is NOT tested here, because it does not exist: there is no "start
// mining" route and no mining cycle. Mining a rock is slice A's GENERIC
// lock-then-activate with a mining laser's itemID (test/bridgeTargeting.test.js),
// flying to the belt is R5a/R13, and selling the minerals is R16. Slice B adds
// only what was missing:
//
//   GET  /api/bridge/ship/ore-hold          the ore/gas/ice hold ladder
//   POST /api/bridge/ship/ore-hold/unload   invbroker.Add, hangar-bound
//   GET  /api/bridge/mining/scan            miningScanMgr.perform_scan
//   GET  /api/bridge/reprocessing/quote     bound GetQuotes — INCLUDING THE TAX
//   POST /api/bridge/reprocessing/reprocess bound Reprocess, behind confirm
//
// Two properties get the most attention.
//
// THE FLAG LADDER NEVER LEAVES THE BFF. The browser is handed a NAME per hold
// ("Ore hold", "Ice hold") and never learns that 134 or 181 exist (R7d / R9a).
//
// REPROCESSING CHARGES ISK AND CONSUMES THE ORE. So it is refused outright
// without an explicit confirmation, the tax is reported before the commit, and
// the result is verified by re-reading rather than trusted.
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
const ORE_STACK_ID = 8800001;
const ICE_STACK_ID = 8800002;

// The retail flagIDs the BFF owns. They appear in THIS file only to prove the
// BFF asks for them — they must never appear in a response body.
const FLAG_ORE_HOLD = 134;
const FLAG_GAS_HOLD = 135;
const FLAG_ICE_HOLD = 181;
const FLAG_ASTEROID_HOLD = 182;
const FLAG_CARGO = 5;
const FLAG_HANGAR = 4;

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

function packedRow(fields) {
  return { type: "packedrow", fields };
}

function keyVal(entries) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

function fakeGateway(overrides = {}) {
  const calls = { call: [], bind: [], boundCall: [], flightStatus: [] };
  const state = {
    docked: true,
    // itemID -> the flag it currently sits under. The whole point of the
    // verification re-reads is that this MOVES.
    placement: new Map([
      [ORE_STACK_ID, FLAG_ORE_HOLD],
      [ICE_STACK_ID, FLAG_ICE_HOLD],
    ]),
    // Flags this hull actually has a hold for.
    capacities: new Map([
      [FLAG_ORE_HOLD, { capacity: 5000, used: 120 }],
      [FLAG_ICE_HOLD, { capacity: 1000, used: 40 }],
      [FLAG_CARGO, { capacity: 300, used: 0 }],
    ]),
    scan: [
      [50001248, 1230, 4200],
      [50001249, 1228, 0],
    ],
    // The retail GetQuotes triple's first element.
    taxRate: 0.05,
    // What CompressItemInSpace answers: the 6-tuple on success, NULL on every
    // refusal (a missing facility, one out of range, a foreign item and an ore
    // with no compressed form are all the same silence).
    compression: [ORE_STACK_ID, 1230, 5000, ORE_STACK_ID, 62516, 5000],
    refuse: new Map(),
    inert: new Set(),
  };
  function flightSnapshot() {
    return {
      inSpace: !state.docked,
      docked: state.docked,
      solarSystemID: ORIGIN_SYSTEM_ID,
      stationID: state.docked ? ORIGIN_STATION_ID : null,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: state.docked ? null : "STOP",
      shipSpeedFraction: 0,
    };
  }
  function listFor(flag) {
    const items = [];
    for (const [itemID, placed] of state.placement.entries()) {
      if (placed === flag) {
        items.push(
          packedRow({
            itemID,
            typeID: itemID === ICE_STACK_ID ? 16262 : 1230,
            groupID: itemID === ICE_STACK_ID ? 423 : 462,
            categoryID: 25,
            locationID: flag === FLAG_HANGAR ? ORIGIN_STATION_ID : SHIP_ID,
            flagID: flag,
            quantity: 500,
          }),
        );
      }
    }
    return { type: "list", items };
  }
  const gateway = {
    calls,
    state,
    async selectCharacter(args, kwargs, sessionFields) {
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
    async releaseBridgeSession() {
      return { released: true, characterID: 7 };
    },
    async readFlightStatus(bridgeSessionID, sessionFields) {
      calls.flightStatus.push({ bridgeSessionID, sessionFields });
      return { flight: flightSnapshot(), notifications: [] };
    },
    async readSpaceSnapshot() {
      return { space: { inSpace: !state.docked, shipID: SHIP_ID, entities: [], ship: null }, notifications: [] };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      if (state.refuse.has(method)) {
        const error = new Error(state.refuse.get(method));
        error.code = "CALL_REFUSED";
        error.statusCode = 409;
        throw error;
      }
      if (service === "miningScanMgr" && method === "perform_scan") {
        return { service, method, result: state.scan, notifications: [] };
      }
      if (service === "inSpaceCompressionMgr" && method === "CompressItemInSpace") {
        return { service, method, result: state.compression, notifications: [] };
      }
      return { service, method, result: null, notifications: [] };
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      return {
        boundHandle: `handle:${service}:${JSON.stringify(args)}`,
        service,
        method,
        notifications: [],
      };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle });
      if (state.refuse.has(method)) {
        const error = new Error(state.refuse.get(method));
        error.code = "CALL_REFUSED";
        error.statusCode = 409;
        throw error;
      }
      const inert = state.inert.has(method);
      if (service === "invbroker" && method === "List") {
        return { service, method, result: listFor(Number(args[0])), notifications: [] };
      }
      if (service === "invbroker" && method === "GetCapacity") {
        const reading = state.capacities.get(Number(args[0]));
        return {
          service,
          method,
          result: reading
            ? keyVal([
                ["capacity", reading.capacity],
                ["used", reading.used],
              ])
            : keyVal([
                ["capacity", 0],
                ["used", 0],
              ]),
          notifications: [],
        };
      }
      if (service === "invbroker" && method === "Add") {
        if (!inert) {
          state.placement.set(Number(args[0]), Number((kwargs && kwargs.flag) || FLAG_HANGAR));
        }
        return { service, method, result: null, notifications: [] };
      }
      if (service === "reprocessingSvc" && method === "GetQuotes") {
        const itemIDs = Array.isArray(args[0]) ? args[0] : [];
        return {
          service,
          method,
          result: [
            state.taxRate,
            { type: "dict", entries: [] },
            {
              type: "dict",
              entries: itemIDs.map((itemID) => [
                itemID,
                keyVal([
                  ["typeID", itemID === ICE_STACK_ID ? 16262 : 1230],
                  ["quantityToProcess", 500],
                  ["leftOvers", 0],
                  ["totalISKCost", 1234.5],
                  // The REAL shape (services/station/reprocessingService.js
                  // buildRecoverableEntry): a LIST of KeyVals, where `client`
                  // is the player's share and `unrecoverable` is the station's.
                  // Reading `unrecoverable` as the yield would put a confidently
                  // wrong mineral count on screen.
                  [
                    "recoverables",
                    {
                      type: "list",
                      items: [
                        keyVal([
                          ["typeID", 34],
                          ["client", 1000],
                          ["unrecoverable", 250],
                          ["iskCost", 900],
                        ]),
                        keyVal([
                          ["typeID", 35],
                          ["client", 200],
                          ["unrecoverable", 50],
                          ["iskCost", 334.5],
                        ]),
                      ],
                    },
                  ],
                ]),
              ]),
            },
          ],
          notifications: [],
        };
      }
      if (service === "reprocessingSvc" && method === "Reprocess") {
        if (!inert) {
          for (const itemID of Array.isArray(args[0]) ? args[0] : []) {
            state.placement.delete(Number(itemID));
          }
        }
        return { service, method, result: null, notifications: [] };
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

async function docked(overrides) {
  const gateway = fakeGateway(overrides);
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
  // Board the fixture ship so the ore-hold read has a ship to bind.
  await apiRequest(baseUrl, "/api/bridge/ship/board", {
    method: "POST",
    body: { shipID: SHIP_ID },
  });
  return { gateway, baseUrl };
}

function boundOf(gateway, service, method) {
  return gateway.calls.boundCall.filter((c) => c.service === service && c.method === method);
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

// --- The ore hold ladder ----------------------------------------------------

test("the hold read asks for the WHOLE ladder, cargo included", async () => {
  const { gateway, baseUrl } = await docked();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/ship/ore-hold");
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);

  // Every specialised mining hold, PLUS the ordinary cargo hold the mining
  // runtime itself falls back to when a hull has no ore bay.
  const askedFlags = boundOf(gateway, "invbroker", "List").map((c) => Number(c.args[0]));
  assert.deepEqual(
    askedFlags,
    [FLAG_ORE_HOLD, FLAG_GAS_HOLD, FLAG_ICE_HOLD, FLAG_ASTEROID_HOLD, FLAG_CARGO],
    "the ladder is read in order, and cargo is the fallback rung",
  );
  // The capacity of each rung is read too, so a fill can be shown.
  assert.deepEqual(
    boundOf(gateway, "invbroker", "GetCapacity").map((c) => Number(c.args[0])),
    [FLAG_ORE_HOLD, FLAG_GAS_HOLD, FLAG_ICE_HOLD, FLAG_ASTEROID_HOLD, FLAG_CARGO],
  );
});

test("GET /bays?keys= reads ONLY the bays asked for", async () => {
  // The full read costs one GetCapacity per candidate flag — twenty-seven of
  // them. That is fine once for a panel and far too much for a bot that wants
  // to know how much room the ore hold has before reaching into a can, so the
  // loot path names the two or three bays it cares about.
  const { gateway, baseUrl } = await docked();
  const { response, payload } = await apiRequest(
    baseUrl,
    `/api/bridge/ship/${SHIP_ID}/bays?keys=ore,cargo`,
  );
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.bays.map((bay) => bay.key), ["cargo", "ore"]);

  const flags = boundOf(gateway, "invbroker", "GetCapacity").map((call) => Number(call.args[0]));
  assert.equal(flags.length, 2, `only the named bays were read, got ${flags.join(",")}`);
  assert.ok(flags.includes(FLAG_ORE_HOLD));
});

test("GET /bays with no keys still reads the whole enumeration", async () => {
  const { gateway, baseUrl } = await docked();
  const { payload } = await apiRequest(baseUrl, `/api/bridge/ship/${SHIP_ID}/bays`);
  assert.ok(payload.bays.length > 20, "every candidate bay is still reported");
  assert.ok(
    boundOf(gateway, "invbroker", "GetCapacity").length > 20,
    "and every one of them was actually read",
  );
});

test("GET /bays?keys= with nothing recognisable is refused, not silently widened", async () => {
  // Answering the FULL enumeration for a typo would quietly cost a bot the
  // twenty-seven calls it was trying to avoid.
  const { baseUrl } = await docked();
  const { response, payload } = await apiRequest(
    baseUrl,
    `/api/bridge/ship/${SHIP_ID}/bays?keys=nosuchbay`,
  );
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_BAY");
});

test("R7d/R9a: the response names each hold and never leaks a flag number", async () => {
  const { baseUrl } = await docked();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/ship/ore-hold");

  const labels = payload.holds.map((hold) => hold.label);
  assert.deepEqual(labels, ["Ore hold", "Gas hold", "Ice hold", "Asteroid hold", "Cargo hold"]);

  // The retail flagIDs must appear NOWHERE in what the browser receives — not
  // as a field, not inside a row, not in a label. "ore hold", never "flag 134".
  const serialized = JSON.stringify(payload);
  for (const flag of [FLAG_ORE_HOLD, FLAG_GAS_HOLD, FLAG_ICE_HOLD, FLAG_ASTEROID_HOLD]) {
    assert.equal(
      new RegExp(`"flagID":\\s*${flag}`).test(serialized),
      false,
      `flagID ${flag} must not reach the browser`,
    );
  }
  assert.equal(/\bflag\b/i.test(serialized), false, "the word 'flag' must not reach the browser");
});

test("a hold row says WHAT it is — group and category ride along, flagID still does not", async () => {
  // A bot delivering out of the CARGO fallback has to tell the ore it mined
  // from the mining crystals stowed beside it, and typeID alone cannot. These
  // are the same two fields /bays already publishes; flagID and locationID
  // remain wire detail and stay behind (R7d).
  const { baseUrl } = await docked();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/ship/ore-hold");

  const ore = payload.holds.find((hold) => hold.key === "ore");
  assert.equal(ore.items.length, 1);
  assert.equal(ore.items[0].groupID, 462);
  assert.equal(ore.items[0].categoryID, 25);
  assert.equal("flagID" in ore.items[0], false, "flagID must not ride along with them");
  assert.equal("locationID" in ore.items[0], false, "nor locationID");
});

test("a hold the hull does not have is marked absent, not shown as empty", async () => {
  const { baseUrl } = await docked();
  const { payload } = await apiRequest(baseUrl, "/api/bridge/ship/ore-hold");

  const byKey = new Map(payload.holds.map((hold) => [hold.key, hold]));
  assert.equal(byKey.get("ore").present, true, "the fixture hull has an ore hold");
  assert.equal(byKey.get("ore").capacity.capacity, 5000);
  assert.equal(byKey.get("ore").items.length, 1);
  // No gas bay on this hull: reported as absent so the page can leave it out
  // rather than drawing a meaningless 0 / 0 bar.
  assert.equal(byKey.get("gas").present, false);
});

test("a hold whose read FAILS reports items as null — 'could not look', not 'empty'", async () => {
  const { baseUrl } = await docked({
    async callBoundMethod(service, method, args) {
      if (service === "invbroker" && method === "List" && Number(args[0]) === FLAG_ORE_HOLD) {
        const error = new Error("nope");
        error.code = "CALL_FAILED";
        throw error;
      }
      return { service, method, result: { type: "list", items: [] }, notifications: [] };
    },
  });
  const { payload } = await apiRequest(baseUrl, "/api/bridge/ship/ore-hold");
  const ore = payload.holds.find((hold) => hold.key === "ore");
  assert.equal(ore.items, null, "null is 'unknown', which is not the same as []");
  assert.ok(ore.error, "and the failure is named");
});

// --- Unloading --------------------------------------------------------------

test("unload is invbroker.Add into the HANGAR, and verifies by re-reading", async () => {
  const { gateway, baseUrl } = await docked();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/ship/ore-hold/unload", {
    method: "POST",
    body: { itemIDs: [ORE_STACK_ID] },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.moved, [ORE_STACK_ID]);
  assert.deepEqual(payload.remaining, []);

  const adds = boundOf(gateway, "invbroker", "Add");
  assert.equal(adds.length, 1);
  // Add(itemID, sourceLocationID) with the hangar flag — the DESTINATION is the
  // bound object, exactly as R3's unfit direction does it.
  assert.deepEqual(adds[0].args, [ORE_STACK_ID, SHIP_ID]);
  assert.equal(adds[0].kwargs.flag, FLAG_HANGAR);
  // The whole ladder is re-read afterwards: a stack still sitting in ANY mining
  // hold did not move, whatever the call answered.
  assert.ok(
    boundOf(gateway, "invbroker", "List").length >= 5,
    "the verification re-reads the holds",
  );
});

test("an unload the server ignores reports the stack as NOT moved", async () => {
  const { gateway, baseUrl } = await docked();
  gateway.state.inert.add("Add");

  const { payload } = await apiRequest(baseUrl, "/api/bridge/ship/ore-hold/unload", {
    method: "POST",
    body: { itemIDs: [ORE_STACK_ID] },
  });
  assert.equal(payload.ok, true, "the call itself succeeded");
  assert.deepEqual(payload.moved, [], "but nothing moved, and the re-read says so");
  assert.deepEqual(payload.remaining, [ORE_STACK_ID]);
});

test("unload refuses in space and refuses an empty selection", async () => {
  const { gateway, baseUrl } = await docked();
  gateway.state.docked = false;
  const inSpace = await apiRequest(baseUrl, "/api/bridge/ship/ore-hold/unload", {
    method: "POST",
    body: { itemIDs: [ORE_STACK_ID] },
  });
  assert.equal(inSpace.response.status, 409);
  assert.equal(inSpace.payload.error, "NOT_DOCKED");

  gateway.state.docked = true;
  const empty = await apiRequest(baseUrl, "/api/bridge/ship/ore-hold/unload", {
    method: "POST",
    body: { itemIDs: [] },
  });
  assert.equal(empty.response.status, 400);
  assert.equal(empty.payload.error, "NOTHING_SELECTED");
});

// --- The survey scanner -----------------------------------------------------

test("the survey scan is perform_scan() with no arguments, in space", async () => {
  const { gateway, baseUrl } = await docked();
  gateway.state.docked = false;

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/mining/scan");
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.results, [
    [50001248, 1230, 4200],
    [50001249, 1228, 0],
  ]);
  const scans = gateway.calls.call.filter((c) => c.service === "miningScanMgr");
  assert.equal(scans.length, 1);
  assert.equal(scans[0].method, "perform_scan");
  assert.deepEqual(scans[0].args, []);
});

test("the survey scan refuses while docked", async () => {
  const { baseUrl } = await docked();
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/mining/scan");
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NOT_IN_SPACE");
});

// --- The refinery -----------------------------------------------------------

test("the quote binds the STATION's refinery and reports the ISK tax separately", async () => {
  const { gateway, baseUrl } = await docked();

  const { response, payload } = await apiRequest(
    baseUrl,
    `/api/bridge/reprocessing/quote?itemIDs=${ORE_STACK_ID}`,
  );
  assert.equal(response.status, 200, JSON.stringify(payload));

  // Moniker('reprocessingSvc', stationID) — the R3 bound-object machinery.
  const binds = gateway.calls.bind.filter((c) => c.service === "reprocessingSvc");
  assert.equal(binds.length, 1);
  assert.equal(binds[0].method, "MachoBindObject");
  assert.deepEqual(binds[0].args, [ORIGIN_STATION_ID]);

  // The TAX is the headline: reprocessing debits it, so the page must be able
  // to show it BEFORE the player commits.
  assert.equal(payload.taxRate, 0.05);
  assert.equal(payload.quotes.length, 1);
  assert.equal(payload.quotes[0].itemID, ORE_STACK_ID);
  assert.equal(payload.quotes[0].quantityToProcess, 500);
  // What it would actually yield: the PLAYER's share (`client`), never the
  // station's (`unrecoverable`). Reading the wrong field here would put a
  // confidently wrong mineral count in front of the player.
  assert.deepEqual(payload.quotes[0].outputs, [
    { typeID: 34, quantity: 1000 },
    { typeID: 35, quantity: 200 },
  ]);
  assert.equal(payload.quotes[0].iskCost, 1234.5, "the station's own ISK cost for this stack");
});

test("a quote is a PURE READ — it never reaches Reprocess", async () => {
  const { gateway, baseUrl } = await docked();
  await apiRequest(baseUrl, `/api/bridge/reprocessing/quote?itemIDs=${ORE_STACK_ID}`);
  assert.equal(
    boundOf(gateway, "reprocessingSvc", "Reprocess").length,
    0,
    "asking what you would get must never consume anything",
  );
  assert.ok(gateway.state.placement.has(ORE_STACK_ID), "the ore is still there");
});

// --- The confirm gate -------------------------------------------------------

test("⚠ reprocess is REFUSED without an explicit confirmation", async () => {
  const { gateway, baseUrl } = await docked();

  for (const body of [
    { itemIDs: [ORE_STACK_ID] },
    { itemIDs: [ORE_STACK_ID], confirm: false },
    { itemIDs: [ORE_STACK_ID], confirm: "true" },
    { itemIDs: [ORE_STACK_ID], confirm: 1 },
  ]) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/reprocessing/reprocess", {
      method: "POST",
      body,
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(payload.error, "CONFIRMATION_REQUIRED", JSON.stringify(body));
    // The message says what it would cost, in plain words.
    assert.match(payload.message, /consumes the ore and charges/i);
  }
  // Nothing was consumed and the refinery was never even reached.
  assert.equal(boundOf(gateway, "reprocessingSvc", "Reprocess").length, 0);
  assert.ok(gateway.state.placement.has(ORE_STACK_ID));
});

test("with confirm:true it reprocesses, and verifies by re-reading the hangar", async () => {
  const { gateway, baseUrl } = await docked();

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/reprocessing/reprocess", {
    method: "POST",
    body: { itemIDs: [ORE_STACK_ID], confirm: true },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.processed, [ORE_STACK_ID], "the stack is gone, so it was processed");
  assert.deepEqual(payload.remaining, []);

  const runs = boundOf(gateway, "reprocessingSvc", "Reprocess");
  assert.equal(runs.length, 1);
  // Reprocess(itemIDs, fromLocationID, ownerID, outputLocationID, outputFlagID)
  assert.deepEqual(runs[0].args[0], [ORE_STACK_ID]);
  assert.equal(runs[0].args[1], ORIGIN_STATION_ID, "the station is the source location");
  assert.equal(runs[0].args[2], 7, "the character owns the output");
});

test("a reprocess the server ignores is reported as NOT processed", async () => {
  const { gateway, baseUrl } = await docked();
  gateway.state.inert.add("Reprocess");
  // The stack must be in the HANGAR for the verification re-read to find it.
  gateway.state.placement.set(ORE_STACK_ID, FLAG_HANGAR);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/reprocessing/reprocess", {
    method: "POST",
    body: { itemIDs: [ORE_STACK_ID], confirm: true },
  });
  assert.equal(payload.ok, true, "the call itself succeeded");
  assert.deepEqual(payload.processed, [], "but the stack is still in the hangar");
  assert.deepEqual(payload.remaining, [ORE_STACK_ID]);
});

test("a refinery refusal carries the SERVER's own reason", async () => {
  const { gateway, baseUrl } = await docked();
  gateway.state.refuse.set("Reprocess", "You do not have enough ISK to pay the reprocessing tax.");

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/reprocessing/reprocess", {
    method: "POST",
    body: { itemIDs: [ORE_STACK_ID], confirm: true },
  });
  assert.equal(response.status, 409);
  assert.match(payload.message, /enough ISK/);
});

test("the refinery routes refuse in space and refuse an empty selection", async () => {
  const { gateway, baseUrl } = await docked();
  gateway.state.docked = false;
  const inSpace = await apiRequest(baseUrl, "/api/bridge/reprocessing/reprocess", {
    method: "POST",
    body: { itemIDs: [ORE_STACK_ID], confirm: true },
  });
  assert.equal(inSpace.response.status, 409);
  assert.equal(inSpace.payload.error, "NOT_DOCKED");

  gateway.state.docked = true;
  const empty = await apiRequest(baseUrl, "/api/bridge/reprocessing/quote?itemIDs=");
  assert.equal(empty.response.status, 400);
  assert.equal(empty.payload.error, "NOTHING_SELECTED");
});

test("every mining route requires the web login session", async () => {
  const { baseUrl } = await docked();
  for (const [path, method] of [
    ["/api/bridge/ship/ore-hold", "GET"],
    ["/api/bridge/ship/ore-hold/unload", "POST"],
    ["/api/bridge/mining/scan", "GET"],
    ["/api/bridge/reprocessing/quote", "GET"],
    ["/api/bridge/reprocessing/reprocess", "POST"],
  ]) {
    const { response } = await apiRequest(baseUrl, path, {
      method,
      body: method === "POST" ? {} : undefined,
      authenticated: false,
    });
    assert.equal(response.status, 401, path);
  }
});

// --- In-space ore compression -----------------------------------------------
//
// The fleet mechanic: a support ship on grid running an industrial core plus
// compression gear is a facility, and ore in your own hull can be squeezed down
// while you sit inside its range. Every guard is the SERVER's — this route sends
// the caller's own itemID and the ball they named and gets out of the way — so
// what there is to pin here is the shape: confirm-gated, in space, one stack per
// request, and a refusal reported as a refusal rather than dressed up as success.

test("compression is confirm-gated, in space, and passes (itemID, facilityID) through", async () => {
  const { gateway, baseUrl } = await docked();
  gateway.state.docked = false;

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/mining/compress", {
    method: "POST",
    body: { itemID: ORE_STACK_ID, facilityID: 7001, confirm: true },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.compressed, true);
  assert.deepEqual(payload.result, [ORE_STACK_ID, 1230, 5000, ORE_STACK_ID, 62516, 5000]);

  const calls = gateway.calls.call.filter((c) => c.service === "inSpaceCompressionMgr");
  assert.equal(calls.length, 1, "one stack per request");
  assert.equal(calls[0].method, "CompressItemInSpace");
  assert.deepEqual(calls[0].args, [ORE_STACK_ID, 7001]);
});

test("compression without confirm changes nothing", async () => {
  const { gateway, baseUrl } = await docked();
  gateway.state.docked = false;

  const { response } = await apiRequest(baseUrl, "/api/bridge/mining/compress", {
    method: "POST",
    body: { itemID: ORE_STACK_ID, facilityID: 7001 },
  });
  assert.notEqual(response.status, 200);
  assert.equal(
    gateway.calls.call.filter((c) => c.service === "inSpaceCompressionMgr").length,
    0,
    "an unconfirmed write must never reach the server",
  );
});

test("compression refuses while docked, and refuses a missing item or facility", async () => {
  const { gateway, baseUrl } = await docked();

  const whileDocked = await apiRequest(baseUrl, "/api/bridge/mining/compress", {
    method: "POST",
    body: { itemID: ORE_STACK_ID, facilityID: 7001, confirm: true },
  });
  assert.equal(whileDocked.response.status, 409);
  assert.equal(whileDocked.payload.error, "NOT_IN_SPACE");

  gateway.state.docked = false;
  for (const body of [
    { facilityID: 7001, confirm: true },
    { itemID: ORE_STACK_ID, confirm: true },
    { itemID: 0, facilityID: 0, confirm: true },
  ]) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/mining/compress", {
      method: "POST",
      body,
    });
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.equal(payload.error, "INVALID_TARGET");
  }
});

test("a server REFUSAL is reported as compressed:false, never as a success", async () => {
  const { gateway, baseUrl } = await docked();
  gateway.state.docked = false;
  // The handler's silence: not a facility / out of range / not compressible.
  gateway.state.compression = null;

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/mining/compress", {
    method: "POST",
    body: { itemID: ORE_STACK_ID, facilityID: 7001, confirm: true },
  });
  assert.equal(response.status, 200, "a refusal is an answer, not a transport failure");
  assert.equal(payload.compressed, false);
  assert.equal(payload.result, null);
});
