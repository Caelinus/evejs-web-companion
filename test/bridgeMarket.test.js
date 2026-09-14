"use strict";

// Goal R16 (Slice A): the BFF market READ route and the tradable-item search.
//
// ⚠ THE SERVICE NAME IS THE WHOLE POINT OF THE FIRST TEST. EveJS registers two
// market services: `market` (marketService.js) is a DEAD STUB whose every
// method answers an empty rowset, and `marketProxy` (marketProxyService.js) is
// the real one. Calling the stub gives a market page that renders perfectly and
// is permanently empty — which reads as a bridge bug and would be very hard to
// find. So this suite asserts, by name, that every call the route issues is on
// `marketProxy` and that `market` is never named.
//
// The other properties this pins:
//
//   - INDEPENDENCE. Seven reads run under Promise.allSettled, so a player whose
//     order book fails still sees their own orders, their trades and their ISK.
//   - SCOPE. Not one read takes an owner or a location argument: the region
//     comes from the session, the character comes from the session. The only
//     argument any of them takes is the typeID the player chose.
//   - THE DAEMON. marketProxy is backed by an out-of-process daemon on TCP
//     127.0.0.1:40111. When it is down the reads THROW, and the route reports
//     an OUTAGE rather than an empty market — because "nobody is trading this"
//     and "the market is not answering" are different facts.
//   - THE ITEM SEARCH is pure static data, so it answers with no live session
//     at all, and it is the only way the panel ever obtains a typeID (the
//     player must never be asked for one — R7d).
//
// Wire contract: docs/bridge-wire-contract.md.

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
const ACTIVE_SHIP_ID = 9001;
const TYPE_ID = 34;

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
    findMarketTypes(filters) {
      const q = String((filters && filters.q) || "").trim();
      if (q.length < 2) {
        return { matches: [], total: 0, capped: false, q, limit: 25 };
      }
      return {
        matches: [{ typeID: TYPE_ID, name: "Tritanium", groupName: "Mineral" }],
        total: 1,
        capped: false,
        q,
        limit: 25,
      };
    },
  };
}

// --- marshaled-value builders (the server's own encodings) ------------------

function long(value) {
  return { type: "long", value: String(value) };
}

function list(items) {
  return { type: "list", items };
}

function keyVal(entries) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

/**
 * The retail cached envelope in its INLINE form: the payload rides args[1] as
 * a substream. (map.GetStationInfo uses the other form, a cached-OBJECT
 * reference, which the browser genuinely cannot decode — the market does not.)
 */
function cached(payload) {
  return {
    type: "object",
    name: { value: "carbon.common.script.net.objectCaching.CachedMethodCallResult" },
    args: [null, { type: "substream", value: payload }, null],
  };
}

const ORDER_COLUMNS = [
  "price", "volRemaining", "typeID", "range", "orderID", "volEntered", "minVolume",
  "bid", "issueDate", "duration", "stationID", "regionID", "solarSystemID",
  "constellationID", "jumps",
];

function orderRowset(lines) {
  return {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [
        ["columns", list(ORDER_COLUMNS)],
        ["RowClass", { type: "token", value: "blue.DBRow" }],
        ["lines", list(lines)],
      ],
    },
  };
}

function orderLine(overrides = {}) {
  const fields = {
    price: 5.51,
    volRemaining: 1200,
    typeID: TYPE_ID,
    range: 0,
    orderID: long("8000000001"),
    volEntered: 2000,
    minVolume: 1,
    bid: 0,
    issueDate: long("133000000000000000"),
    duration: 30,
    stationID: STATION_ID,
    regionID: 10000002,
    solarSystemID: SOLAR_SYSTEM_ID,
    constellationID: 20000020,
    jumps: 0,
    ...overrides,
  };
  return ORDER_COLUMNS.map((column) => fields[column]);
}

const OWN_COLUMNS = [
  "orderID", "typeID", "charID", "regionID", "stationID", "range", "bid", "price",
  "volEntered", "volRemaining", "issueDate", "minVolume", "contraband", "duration",
  "isCorp", "solarSystemID", "escrow", "constellationID", "keyID", "orderState",
  "lastStateChange",
];

function ownOrderRowset(rows) {
  return {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [
        ["columns", list(OWN_COLUMNS)],
        ["RowClass", { type: "token", value: "util.Row" }],
        ["lines", list(rows.map((row) => list(OWN_COLUMNS.map((column) => row[column] ?? null))))],
      ],
    },
  };
}

function ownOrder(overrides = {}) {
  return {
    orderID: long("8000000101"),
    typeID: TYPE_ID,
    charID: CHARACTER_ID,
    regionID: 10000002,
    stationID: STATION_ID,
    range: 5,
    bid: 1,
    price: 4.9,
    volEntered: 1000,
    volRemaining: 500,
    issueDate: long("133000000000000000"),
    minVolume: 1,
    contraband: 0,
    duration: 30,
    isCorp: 0,
    solarSystemID: SOLAR_SYSTEM_ID,
    escrow: 2450,
    constellationID: 20000020,
    keyID: 1000,
    orderState: 0,
    lastStateChange: null,
    ...overrides,
  };
}

/**
 * A gateway fake for the market surface. `failures` names (service, method)
 * pairs that should throw, so the independence of the reads can be exercised
 * one at a time; `daemonDown` makes every marketProxy read fail the way a dead
 * daemon on 40111 makes them fail.
 */
function fakeGateway(options = {}) {
  const calls = { topLevel: [] };
  const failures = new Set(options.failures || []);

  return {
    calls,
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
          corporationID: 98000000,
          shipID: ACTIVE_SHIP_ID,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: CHARACTER_ID };
    },
    async readFlightStatus() {
      return {
        flight: {
          docked: true,
          inSpace: false,
          stationID: STATION_ID,
          solarSystemID: SOLAR_SYSTEM_ID,
          shipID: ACTIVE_SHIP_ID,
        },
        notifications: [],
      };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.topLevel.push({ service, method, args, kwargs, bridgeSessionID });
      if (options.daemonDown && service === "marketProxy") {
        throw Object.assign(
          new Error("MarketUnavailable: the market daemon is not reachable"),
          { code: "CALL_FAILED" },
        );
      }
      if (failures.has(`${service}.${method}`)) {
        throw Object.assign(new Error(`${service}.${method} failed`), { code: "CALL_FAILED" });
      }
      if (service === "marketProxy" && method === "GetOrders") {
        return {
          service,
          method,
          // ⚠ A cached envelope around a 2-TUPLE [sells, buys].
          result: cached([
            orderRowset([orderLine({ bid: 0, price: 5.51 })]),
            orderRowset([orderLine({ bid: 1, price: 4.9, orderID: long("8000000002") })]),
          ]),
          notifications: [],
        };
      }
      if (service === "marketProxy" && method === "GetCharOrders") {
        return { service, method, result: cached(ownOrderRowset([ownOrder()])), notifications: [] };
      }
      if (service === "marketProxy" && method === "GetMarketOrderHistory") {
        return {
          service,
          method,
          result: cached(ownOrderRowset([ownOrder({ orderID: long("8000000102"), orderState: 1 })])),
          notifications: [],
        };
      }
      if (service === "marketProxy" && method === "CharGetTransactions") {
        return {
          service,
          method,
          result: list([
            keyVal([
              ["transactionID", 1],
              ["typeID", TYPE_ID],
              ["quantity", 100],
              ["price", 5.5],
              ["stationID", STATION_ID],
              ["buyerID", CHARACTER_ID],
              ["sellerID", 999],
              ["transactionDate", long("133000000000000000")],
            ]),
          ]),
          notifications: [],
        };
      }
      if (service === "marketProxy" && method === "GetCharEscrow") {
        return {
          service,
          method,
          result: keyVal([["iskEscrow", 2450], ["itemsEscrow", 3]]),
          notifications: [],
        };
      }
      if (service === "account" && method === "GetCashBalance") {
        return { service, method, result: long("125000000"), notifications: [] };
      }
      return { service, method, result: null, notifications: [] };
    },
    async bindObject() {
      throw new Error("the market needs no bound objects");
    },
    async callBoundMethod() {
      throw new Error("the market needs no bound objects");
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
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: CHARACTER_ID },
  });
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    );
  }
  await Promise.all(closing);
});

// --- the service name -------------------------------------------------------

test("every market call is on marketProxy — the `market` service is NEVER named", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, `/api/bridge/market?typeID=${TYPE_ID}`);

  const services = new Set(gateway.calls.topLevel.map((call) => call.service));
  // ⚠ marketService.js is a DEAD STUB. Naming it here would answer empty
  // rowsets forever and look exactly like a bug in this bridge.
  assert.equal(
    services.has("market"),
    false,
    'the dead-stub "market" service must never be called',
  );
  assert.ok(services.has("marketProxy"), "the real service is marketProxy");
});

// --- the read route ---------------------------------------------------------

test("GET /api/bridge/market issues the seven top-level reads and NO bind", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, `/api/bridge/market?typeID=${TYPE_ID}`);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  // Every market call is TOP-LEVEL. A bind makes the fake throw, so this is
  // enforced rather than merely asserted.
  const issued = gateway.calls.topLevel.map((call) => `${call.service}.${call.method}`);
  for (const pair of [
    "marketProxy.GetOrders",
    "marketProxy.GetCharOrders",
    "marketProxy.GetMarketOrderHistory",
    "marketProxy.CharGetTransactions",
    "marketProxy.GetCharEscrow",
    "marketProxy.GetNewPriceHistory",
    "account.GetCashBalance",
  ]) {
    assert.ok(issued.includes(pair), `expected ${pair} to be issued`);
  }
  // Each read rides the SAME held bridge session.
  for (const call of gateway.calls.topLevel) {
    assert.equal(call.bridgeSessionID, BRIDGE_SESSION_ID);
  }
});

test("the ONLY argument any read takes is the typeID — no owner, no location", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, `/api/bridge/market?typeID=${TYPE_ID}`);

  const by = (method) =>
    gateway.calls.topLevel.find((call) => call.service === "marketProxy" && call.method === method);

  // ⚠ THE SECURITY PROPERTY. The region GetOrders searches and the character
  // whose orders/trades/escrow are read come from the SESSION the gateway
  // materialized. There is no parameter here a browser could tamper with to
  // reach another character or another region.
  assert.deepEqual(by("GetOrders").args, [TYPE_ID]);
  assert.deepEqual(by("GetCharOrders").args, []);
  assert.deepEqual(by("GetMarketOrderHistory").args, []);
  assert.deepEqual(by("GetCharEscrow").args, []);
  // fromDate 0 = everything the server still keeps.
  assert.deepEqual(by("CharGetTransactions").args, [0]);
  // Positional only, every time.
  for (const call of gateway.calls.topLevel) {
    assert.equal(call.kwargs, null, `${call.service}.${call.method} must be positional`);
  }
});

test("with no item chosen the order book is SKIPPED, and the rest still answers", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/market");
  assert.equal(payload.ok, true);
  assert.equal(payload.typeID, null);
  assert.equal(payload.book.result, null);
  // The player's own market is worth showing before they pick anything.
  const issued = gateway.calls.topLevel.map((call) => `${call.service}.${call.method}`);
  assert.equal(issued.includes("marketProxy.GetOrders"), false);
  assert.ok(issued.includes("marketProxy.GetCharOrders"));
  assert.ok(issued.includes("account.GetCashBalance"));
});

test("the route hands back the RAW retail-shaped results for the browser to decode", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, `/api/bridge/market?typeID=${TYPE_ID}`);
  // The cached envelope survives intact: the BFF does not pre-decode, so the
  // browser's decoder is the single place the shape is understood.
  assert.equal(payload.book.result.type, "object");
  assert.match(String(payload.book.result.name.value), /CachedMethodCallResult$/);
  assert.equal(payload.cashBalance.result.type, "long");
  assert.equal(payload.characterID, CHARACTER_ID);
});

// --- independence -----------------------------------------------------------

test("a failed order book keeps its OWN error and never blanks the other reads", async () => {
  const gateway = fakeGateway({ failures: ["marketProxy.GetOrders"] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, `/api/bridge/market?typeID=${TYPE_ID}`);
  assert.equal(response.status, 200, "one failed read must not fail the route");
  assert.equal(payload.book.error, "CALL_FAILED");
  assert.equal(payload.book.result, null);
  // Everything else came through.
  assert.equal(payload.ownOrders.error, null);
  assert.notEqual(payload.ownOrders.result, null);
  assert.notEqual(payload.cashBalance.result, null);
});

test("a failed WALLET read never blanks the order book", async () => {
  const gateway = fakeGateway({ failures: ["account.GetCashBalance"] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, `/api/bridge/market?typeID=${TYPE_ID}`);
  assert.equal(payload.cashBalance.error, "CALL_FAILED");
  assert.notEqual(payload.book.result, null);
});

// --- the external daemon ----------------------------------------------------

test("a DOWN market daemon is reported as an OUTAGE, not as an empty market", async () => {
  const gateway = fakeGateway({ daemonDown: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, `/api/bridge/market?typeID=${TYPE_ID}`);
  assert.equal(response.status, 200);
  // ⚠ THE POINT. Without this the panel would say "nobody is trading this and
  // you have no orders", which is a lie about the player's own position.
  assert.match(String(payload.marketUnavailable), /not answering/);
  assert.equal(payload.book.error, "CALL_FAILED");
  // The wallet is NOT daemon-backed, so it still answers.
  assert.notEqual(payload.cashBalance.result, null);
});

test("an ordinary read failure is NOT reported as a daemon outage", async () => {
  const gateway = fakeGateway({ failures: ["marketProxy.GetOrders"] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, `/api/bridge/market?typeID=${TYPE_ID}`);
  assert.equal(payload.marketUnavailable, null, "only a real outage says the market is down");
});

// --- the item search --------------------------------------------------------

test("GET /api/market/find searches by NAME and touches the gateway not at all", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // Deliberately NO character selected: this is static reference data, so it
  // must answer even before a session exists (and when the market is down).
  const { response, payload } = await apiRequest(baseUrl, "/api/market/find?q=tritan");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "static-data");
  assert.equal(payload.matches[0].name, "Tritanium");
  assert.equal(gateway.calls.topLevel.length, 0, "the search is not a bridge call");
});

test("a query too short to be useful returns nothing rather than the whole table", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  const { payload } = await apiRequest(baseUrl, "/api/market/find?q=t");
  assert.deepEqual(payload.matches, []);
});

// --- session handling -------------------------------------------------------

test("the market route requires a held bridge session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/market");
  assert.equal(response.status, 409);
  assert.equal(payload.ok, false);
});

// =============================================================================
// Slice B: the WRITES
// =============================================================================
// THIS IS THE FIRST FEATURE THAT SPENDS THE PLAYER'S ISK, so these tests are
// about three things and nothing else:
//
//   1. THE CONFIRM GATE. No route acts without an explicit `confirm: true`, and
//      the refusal must happen BEFORE anything reaches the gateway.
//   2. THE EXACT POSITIONAL PAYLOAD. Every market write reads its arguments by
//      INDEX, so a mis-ordered list is a silently different order rather than
//      an error. Each signature is pinned position by position.
//   3. THE ACTUAL CHARGE. `applied` and `charged` come from RE-READS - the
//      wallet before and after, and the player's own orders after - never from
//      the 200. The estimated broker fee the UI showed never appears here.

/** A gateway fake with a mutable wallet, so a charge is a real consequence. */
function fakeWriteGateway(options = {}) {
  const state = {
    balance: options.balance === undefined ? 1000000 : options.balance,
    orders: options.orders === undefined ? [] : options.orders.slice(),
  };
  const calls = { topLevel: [] };
  const base = fakeGateway();

  return {
    calls,
    state,
    selectCharacter: base.selectCharacter,
    releaseBridgeSession: base.releaseBridgeSession,
    readFlightStatus: base.readFlightStatus,
    async bindObject() {
      throw new Error("the market needs no bound objects");
    },
    async callBoundMethod() {
      throw new Error("the market needs no bound objects");
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.topLevel.push({ service, method, args, kwargs, bridgeSessionID });
      if (service === "account" && method === "GetCashBalance") {
        const result = options.realBalance
          ? { type: "real", value: state.balance }
          : String(state.balance.toFixed(2));
        return { service, method, result, notifications: [] };
      }
      if (service === "marketProxy" && method === "GetCharOrders") {
        return { service, method, result: cached(ownOrderRowset(state.orders)), notifications: [] };
      }
      if (service === "marketProxy" && method === "PlaceBuyOrder") {
        if (options.refuse) {
          throw Object.assign(new Error(options.refuse), { code: "CALL_REFUSED" });
        }
        if (!options.silentDecline) {
          // The REAL consequence: escrow plus a broker's fee the server chose.
          const price = Number(args[2]);
          const quantity = Number(args[3]);
          state.balance -= price * quantity + 137.5;
          state.orders.push(ownOrder({ orderID: long("8000000901"), price, bid: 1 }));
        }
        return { service, method, result: null, notifications: [] };
      }
      if (service === "marketProxy" && method === "PlaceMultiSellOrder") {
        if (!options.silentDecline) {
          state.balance -= 137.5;
          state.orders.push(ownOrder({ orderID: long("8000000902"), bid: 0 }));
          return { service, method, result: true, notifications: [] };
        }
        return { service, method, result: false, notifications: [] };
      }
      if (service === "marketProxy" && method === "CancelCharOrder") {
        if (!options.silentDecline) {
          state.orders = state.orders.slice(0, -1);
          // Cancelling a buy order RETURNS the escrow.
          state.balance += 2450;
        }
        return { service, method, result: null, notifications: [] };
      }
      if (service === "marketProxy" && method === "ModifyCharOrder") {
        if (!options.silentDecline) {
          const price = Number(args[1]);
          state.orders = state.orders.map((row) => ({ ...row, price }));
          state.balance -= 55.25;
        }
        return { service, method, result: null, notifications: [] };
      }
      return { service, method, result: null, notifications: [] };
    },
  };
}

async function postMarket(baseUrl, path, body) {
  return apiRequest(baseUrl, path, { method: "POST", body });
}

// --- the confirm gate -------------------------------------------------------

test("EVERY market write is refused without an explicit confirm, before the gateway", async () => {
  const cases = [
    ["/api/bridge/market/buy", { typeID: TYPE_ID, price: 10, quantity: 5, durationDays: 30 }],
    [
      "/api/bridge/market/sell",
      { itemID: 500, typeID: TYPE_ID, price: 10, quantity: 5, durationDays: 30 },
    ],
    ["/api/bridge/market/cancel", { orderID: "8000000101" }],
    ["/api/bridge/market/modify", { orderID: "8000000101", price: 12 }],
  ];
  for (const [path, body] of cases) {
    const gateway = fakeWriteGateway();
    const { baseUrl } = await startTestServer({ gateway });
    await selectOnServer(baseUrl);
    const writesBefore = gateway.calls.topLevel.length;

    const { response, payload } = await postMarket(baseUrl, path, body);
    assert.equal(response.status, 400, `${path} must refuse without confirm`);
    assert.equal(payload.error, "CONFIRMATION_REQUIRED");
    // Nothing reached the gateway - the gate is BEFORE the call, not after.
    assert.equal(
      gateway.calls.topLevel.length,
      writesBefore,
      `${path} must not touch the gateway when unconfirmed`,
    );
  }
});

// --- the exact positional payloads -----------------------------------------

test("PlaceBuyOrder is sent with its NINE arguments in order, and NO kwargs", async () => {
  const gateway = fakeWriteGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await postMarket(baseUrl, "/api/bridge/market/buy", {
    typeID: TYPE_ID,
    price: 10,
    quantity: 5,
    durationDays: 30,
    confirm: true,
  });

  const call = gateway.calls.topLevel.find(
    (entry) => entry.service === "marketProxy" && entry.method === "PlaceBuyOrder",
  );
  assert.ok(call, "the buy must reach marketProxy.PlaceBuyOrder");
  // [stationID, typeID, price, quantity, orderRange, minVolume, duration,
  //  useCorp, expectedBrokersFee]
  assert.deepEqual(call.args, [
    STATION_ID,
    TYPE_ID,
    10,
    5,
    -1, // station-only range: a wider one is skill-gated
    1,
    30,
    false, // personal market only
    // THE BROKER-FEE RATE IS NOT ASSERTED. It is a CHECK the server runs
    // against the character's real rate, and a mismatch refuses the whole
    // order. The browser cannot know that rate (Broker Relations level and
    // standings are unreadable), so null - the documented "do not check" value
    // - is sent, and honesty is delivered by reporting the ACTUAL charge.
    null,
  ]);
  assert.equal(call.kwargs, null, "the market surface has no kwargs anywhere");
});

test("a price is ROUNDED to 2dp before dispatch — what is confirmed is what is sent", async () => {
  const gateway = fakeWriteGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await postMarket(baseUrl, "/api/bridge/market/buy", {
    typeID: TYPE_ID,
    price: 5.555,
    quantity: 1,
    durationDays: 30,
    confirm: true,
  });

  const call = gateway.calls.topLevel.find(
    (entry) => entry.service === "marketProxy" && entry.method === "PlaceBuyOrder",
  );
  // The server rounds whatever it is sent, so an unrounded price is not
  // rejected - it is silently CHANGED. Rounding here means the number in the
  // confirm dialog is the number that gets used.
  assert.equal(call.args[2], 5.56);
});

test("a price above the market ceiling is rejected BEFORE dispatch", async () => {
  const gateway = fakeWriteGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await postMarket(baseUrl, "/api/bridge/market/buy", {
    typeID: TYPE_ID,
    // MARKET_MAX_ORDER_PRICE = 9223372036854.
    price: 9223372036855,
    quantity: 1,
    durationDays: 30,
    confirm: true,
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "PRICE_TOO_HIGH");
  assert.equal(
    gateway.calls.topLevel.some((entry) => entry.method === "PlaceBuyOrder"),
    false,
    "an over-ceiling price must never be sent",
  );
});

test("a duration the market does not accept is rejected BEFORE dispatch", async () => {
  const gateway = fakeWriteGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await postMarket(baseUrl, "/api/bridge/market/buy", {
    typeID: TYPE_ID,
    price: 10,
    quantity: 1,
    // The server accepts 0/1/3/7/14/30/90 and nothing else.
    durationDays: 45,
    confirm: true,
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_DURATION");
});

test("PlaceMultiSellOrder is sent as an ITEM LIST — selling names a STACK", async () => {
  const gateway = fakeWriteGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await postMarket(baseUrl, "/api/bridge/market/sell", {
    itemID: 7000000001,
    typeID: TYPE_ID,
    price: 12.5,
    quantity: 10,
    durationDays: 90,
    confirm: true,
  });

  const call = gateway.calls.topLevel.find(
    (entry) => entry.service === "marketProxy" && entry.method === "PlaceMultiSellOrder",
  );
  assert.ok(call, "the sell must reach marketProxy.PlaceMultiSellOrder");
  // [itemList, useCorp, duration, expectedBrokersFee], and the entry carries
  // the itemID because the handler moves that STACK into escrow.
  assert.deepEqual(call.args, [
    [{ itemID: 7000000001, typeID: TYPE_ID, stationID: STATION_ID, price: 12.5, quantity: 10 }],
    false,
    90,
    null,
  ]);
  assert.equal(call.kwargs, null);
});

test("a sell without a stack to hand over is rejected — selling is not type-based", async () => {
  const gateway = fakeWriteGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await postMarket(baseUrl, "/api/bridge/market/sell", {
    typeID: TYPE_ID,
    price: 12.5,
    quantity: 10,
    durationDays: 30,
    confirm: true,
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_ITEM");
});

test("CancelCharOrder is sent as [orderID, regionID] — the regionID the server ignores", async () => {
  const gateway = fakeWriteGateway({ orders: [ownOrder()] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await postMarket(baseUrl, "/api/bridge/market/cancel", {
    orderID: "8000000101",
    confirm: true,
  });

  const call = gateway.calls.topLevel.find(
    (entry) => entry.service === "marketProxy" && entry.method === "CancelCharOrder",
  );
  // The trailing argument is sent because the shape is retail's; the server
  // reads only args[0] and re-derives the region from the order it loads.
  assert.deepEqual(call.args, ["8000000101", 0]);
  assert.equal(call.kwargs, null);
});

test("ModifyCharOrder is sent with all NINE arguments, though only two are read", async () => {
  const gateway = fakeWriteGateway({ orders: [ownOrder()] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await postMarket(baseUrl, "/api/bridge/market/modify", {
    orderID: "8000000101",
    price: 12,
    confirm: true,
  });

  const call = gateway.calls.topLevel.find(
    (entry) => entry.service === "marketProxy" && entry.method === "ModifyCharOrder",
  );
  assert.equal(call.args.length, 9, "the retail shape is nine positional arguments");
  // The two the server actually reads.
  assert.equal(call.args[0], "8000000101");
  assert.equal(call.args[1], 12);
  assert.equal(call.kwargs, null);
});

// --- the ACTUAL charge ------------------------------------------------------

test("a buy reports what the WALLET actually lost — not the estimate, not the order value", async () => {
  const gateway = fakeWriteGateway({ balance: 1000000 });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await postMarket(baseUrl, "/api/bridge/market/buy", {
    typeID: TYPE_ID,
    price: 10,
    quantity: 100,
    durationDays: 30,
    confirm: true,
  });

  assert.equal(payload.applied, true);
  assert.equal(payload.declinedSilently, false);
  // The fake charges escrow (10 x 100 = 1000) PLUS a 137.50 fee the server
  // chose. A client that reported its own 3% estimate (30.00) would be wrong.
  assert.equal(payload.charged, "1137.50");
  assert.equal(payload.balanceBefore, "1000000.00");
  assert.equal(payload.balanceAfter, "998862.50");
  // And the own-orders re-read came back, so the panel can show server truth.
  assert.notEqual(payload.ownOrders, null);
});

test("the wallet delta is EXACT at magnitudes where a float would drift", async () => {
  // 2^53 + 1 hundredths apart: a float subtraction here loses the difference.
  const gateway = fakeWriteGateway({ balance: 90071992547409.93 });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await postMarket(baseUrl, "/api/bridge/market/buy", {
    typeID: TYPE_ID,
    price: 10,
    quantity: 1,
    durationDays: 30,
    confirm: true,
  });
  // 10 + 137.50 = 147.50, computed through BigInt hundredths.
  assert.equal(payload.charged, "147.50");
});

test("the charge stays exact when eve.js sends the wallet as a marshalled real", async () => {
  // eve.js sends GetCashBalance as {type:"real", value}. Reading only strings
  // and longs would leave `charged` null after every write.
  const gateway = fakeWriteGateway({ balance: 1000000, realBalance: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await postMarket(baseUrl, "/api/bridge/market/buy", {
    typeID: TYPE_ID,
    price: 10,
    quantity: 100,
    durationDays: 30,
    confirm: true,
  });

  assert.equal(payload.charged, "1137.50");
  assert.equal(payload.balanceBefore, "1000000.00");
  assert.equal(payload.balanceAfter, "998862.50");
});

test("a CANCEL reports the refund as a NEGATIVE charge — ISK came back", async () => {
  const gateway = fakeWriteGateway({ orders: [ownOrder()] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await postMarket(baseUrl, "/api/bridge/market/cancel", {
    orderID: "8000000101",
    confirm: true,
  });
  assert.equal(payload.applied, true);
  // before - after is negative when the wallet GREW.
  assert.equal(payload.charged, "-2450.00");
});

test("a MODIFY is judged by the RE-READ: the order now carries the new price", async () => {
  const gateway = fakeWriteGateway({ orders: [ownOrder()] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await postMarket(baseUrl, "/api/bridge/market/modify", {
    orderID: "8000000101",
    price: 12,
    confirm: true,
  });
  assert.equal(payload.applied, true, "the re-read shows the order at 12");
  assert.equal(payload.charged, "55.25");
});

// --- silent declines --------------------------------------------------------

test("a buy that changed NOTHING is reported as a silent decline, with no invented cause", async () => {
  // ⚠ PlaceBuyOrder answers None whether it created an order, filled one, or did
  // nothing at all - so the response alone cannot tell them apart. The wallet
  // can: an unchanged balance means nothing happened.
  const gateway = fakeWriteGateway({ silentDecline: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await postMarket(baseUrl, "/api/bridge/market/buy", {
    typeID: TYPE_ID,
    price: 10,
    quantity: 1,
    durationDays: 30,
    confirm: true,
  });
  assert.equal(response.status, 200, "a silent decline is still a 200 from the handler");
  assert.equal(payload.applied, false);
  assert.equal(payload.declinedSilently, true);
  assert.equal(payload.charged, "0.00");
});

test("a CANCEL that removed nothing is a silent decline, judged by the order count", async () => {
  const gateway = fakeWriteGateway({ orders: [ownOrder()], silentDecline: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await postMarket(baseUrl, "/api/bridge/market/cancel", {
    orderID: "8000000101",
    confirm: true,
  });
  assert.equal(payload.applied, false);
  assert.equal(payload.declinedSilently, true);
});

test("a MODIFY that left the price alone is a silent decline", async () => {
  const gateway = fakeWriteGateway({ orders: [ownOrder()], silentDecline: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await postMarket(baseUrl, "/api/bridge/market/modify", {
    orderID: "8000000101",
    price: 12,
    confirm: true,
  });
  assert.equal(payload.applied, false);
  assert.equal(payload.declinedSilently, true);
});

test("a THROWN refusal keeps the server's own words and takes nothing", async () => {
  const gateway = fakeWriteGateway({
    refuse: "No matching sell orders were available at the requested price.",
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await postMarket(baseUrl, "/api/bridge/market/buy", {
    typeID: TYPE_ID,
    price: 10,
    quantity: 1,
    durationDays: 30,
    confirm: true,
  });
  assert.equal(response.status >= 400, true);
  assert.equal(payload.ok, false);
  assert.equal(gateway.state.balance, 1000000, "a refused order must cost nothing");
});
