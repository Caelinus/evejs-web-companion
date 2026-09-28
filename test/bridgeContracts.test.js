"use strict";

// Goal R17 (Slice B): the BFF contract READ routes.
//
// ⚠ THE SERVICE NAME IS THE POINT OF THE FIRST TEST, and it is the same shape
// as R16's market trap. EveJS registers two contract services: `contractMgr`
// (contractMgrService.js) is 86 lines of DEAD STUBS — GetLoginInfo answers
// three empty rowsets, SearchContracts an empty list, NumOutstandingContracts
// 0 — and the retail client never calls it; `contractProxy` is the real one.
// Naming the stub gives a contracts page that renders perfectly and is
// permanently empty, which is INDISTINGUISHABLE from the genuinely empty world
// below — which is exactly what makes the mistake expensive. So this suite
// asserts by name that every call is on contractProxy.
//
// ⚠ THE EMPTY BROWSE IS EXPECTED, AND THE DISTINCTION IS LOAD-BEARING. There is
// no NPC/seed contract generator anywhere in EveJS, so a public browse
// legitimately finds nothing. The route reports `worldHasNoContracts` — but
// ONLY when the browse SUCCEEDED and returned nothing. A browse that FAILED
// must never set it, because "there is nothing to find" and "we could not look"
// are different facts and the panel words them differently.
//
// The other properties this pins:
//
//   - KWARGS-ONLY. Handle_SearchContracts ignores `args` entirely; filters sent
//     positionally are silently dropped and the browse quietly answers every
//     contract type instead of couriers.
//   - THE PAGE STRIDE IS 100, NOT `maxResults`. The envelope reports 1000
//     (MAX_CONTRACTS_PER_SEARCH) while the server slices by 100
//     (CONTRACTS_PER_PAGE); paging by the field would skip 900 per page.
//   - INDEPENDENCE. Five reads under Promise.allSettled, so a failed public
//     browse never hides the player's own contracts.
//   - READS ONLY. No route here mutates; every mutator is refused at the
//     gateway.
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
const END_STATION_ID = 60008494;
const SOLAR_SYSTEM_ID = 30000142;
const CHARACTER_ID = 7;
const ACTIVE_SHIP_ID = 9001;
const CONTRACT_ID = 8100;

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

function rowset(columns, lines) {
  return {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: {
      type: "dict",
      entries: [["columns", list(columns)], ["lines", list(lines)]],
    },
  };
}

function contractRow(overrides = {}) {
  const fields = {
    contractID: CONTRACT_ID,
    type: 3,
    status: 0,
    availability: 0,
    issuerID: 140000009,
    issuerCorpID: 98000000,
    forCorp: false,
    assigneeID: 0,
    acceptorID: 0,
    dateIssued: long("133000000000000000"),
    dateExpired: long("134000000000000000"),
    dateAccepted: long("0"),
    dateCompleted: long("0"),
    numDays: 7,
    startStationID: STATION_ID,
    endStationID: END_STATION_ID,
    startSolarSystemID: SOLAR_SYSTEM_ID,
    endSolarSystemID: 30002187,
    price: 0,
    reward: 2500000,
    collateral: 10000000,
    volume: 1200,
    title: "Ore run",
    description: "Take the ore to Amarr.",
    ...overrides,
  };
  return keyVal(Object.entries(fields));
}

/** ⚠ A SEARCH ENTRY WRAPS the contract; a list bundle carries rows directly. */
function searchEntry(overrides = {}) {
  return keyVal([
    ["contract", contractRow(overrides)],
    ["items", list([])],
    ["bids", list([])],
  ]);
}

function searchResult(entries, numFound) {
  return keyVal([
    ["contracts", list(entries)],
    ["numFound", numFound === undefined ? entries.length : numFound],
    ["searchTime", 0],
    // ⚠ 1000, NOT the 100-row page stride. Paging by this skips 900 per page.
    ["maxResults", 1000],
  ]);
}

function listBundle(rows) {
  return keyVal([
    ["contracts", list(rows)],
    ["items", { type: "dict", entries: [] }],
  ]);
}

function loginInfo({ needsAttention = [], inProgress = [], assignedToMe = [] } = {}) {
  return keyVal([
    ["needsAttention", rowset(["contractID", "state"], needsAttention)],
    [
      "inProgress",
      rowset(["contractID", "startStationID", "endStationID", "expires"], inProgress),
    ],
    ["assignedToMe", rowset(["contractID", "issuerID"], assignedToMe)],
  ]);
}

function detailBundle(overrides = {}, items = []) {
  return keyVal([
    ["startSolarSystemName", "Jita"],
    ["items", list(items)],
    ["bids", list([])],
    ["contract", contractRow(overrides)],
    ["startSolarSystemID", SOLAR_SYSTEM_ID],
    ["endSolarSystemID", 30002187],
  ]);
}

function itemRow(overrides = {}) {
  return keyVal(
    Object.entries({
      recordID: 1,
      itemID: 5000,
      itemTypeID: 34,
      typeID: 34,
      quantity: 500,
      inCrate: true,
      parentID: 0,
      ...overrides,
    }),
  );
}

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
      if (failures.has(`${service}.${method}`)) {
        throw Object.assign(new Error(`${service}.${method} failed`), { code: "CALL_FAILED" });
      }
      if (service === "contractProxy" && method === "SearchContracts") {
        return {
          service,
          method,
          result: options.browseResult !== undefined
            ? options.browseResult
            : searchResult([]),
          notifications: [],
        };
      }
      if (service === "contractProxy" && method === "GetMyCurrentContractList") {
        const accepted = args[0] === true;
        return {
          service,
          method,
          result: accepted
            ? (options.acceptedResult ?? listBundle([]))
            : (options.outstandingResult ?? listBundle([])),
          notifications: [],
        };
      }
      if (service === "contractProxy" && method === "GetMyExpiredContractList") {
        return { service, method, result: options.expiredResult ?? listBundle([]), notifications: [] };
      }
      if (service === "contractProxy" && method === "GetLoginInfo") {
        return { service, method, result: options.summaryResult ?? loginInfo(), notifications: [] };
      }
      if (service === "contractProxy" && method === "GetContract") {
        if (Number(args[0]) !== CONTRACT_ID) {
          // The server's own answer for a contract that does not exist.
          return { service, method, result: null, notifications: [] };
        }
        return {
          service,
          method,
          result: options.detailResult !== undefined
            ? options.detailResult
            : detailBundle({}, [itemRow()]),
          notifications: [],
        };
      }
      return { service, method, result: null, notifications: [] };
    },
    async bindObject() {
      throw new Error("contracts need no bound objects");
    },
    async callBoundMethod() {
      throw new Error("contracts need no bound objects");
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

test("⚠ every contract call is on contractProxy — `contractMgr` is NEVER named", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, "/api/bridge/contracts");
  await apiRequest(baseUrl, `/api/bridge/contracts/detail?contractID=${CONTRACT_ID}`);

  const services = new Set(gateway.calls.topLevel.map((call) => call.service));
  // ⚠ contractMgrService.js is 86 lines of DEAD STUBS. Naming it would answer
  // hardcoded-empty forever and look exactly like the empty world below.
  assert.equal(
    services.has("contractMgr"),
    false,
    "the dead-stub `contractMgr` service must never be called",
  );
  assert.ok(services.has("contractProxy"), "the real service is contractProxy");
});

// --- the browse -------------------------------------------------------------

test("⚠ SearchContracts is sent KWARGS-ONLY, with NO positional args", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, "/api/bridge/contracts");

  const search = gateway.calls.topLevel.find(
    (call) => call.service === "contractProxy" && call.method === "SearchContracts",
  );
  assert.ok(search);
  // ⚠ Handle_SearchContracts ignores `args` entirely. A filter sent
  // positionally is silently dropped and the browse answers every contract
  // type instead of couriers — with no error at all.
  assert.deepEqual(search.args, [], "no positional args, or the filters vanish");
  assert.equal(search.kwargs.contractType, 3, "3 = courier");
  assert.equal(search.kwargs.availability, 0, "0 = public");
  assert.equal(search.kwargs.startNum, 0);
});

test("⚠ paging advances by 100 — the REAL stride, not the 1000 `maxResults` reports", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, "/api/bridge/contracts?page=2");

  const search = gateway.calls.topLevel.find(
    (call) => call.service === "contractProxy" && call.method === "SearchContracts",
  );
  // searchContracts slices by CONTRACTS_PER_PAGE (100) while the envelope's
  // maxResults carries MAX_CONTRACTS_PER_SEARCH (1000). Paging by the field
  // would advance startNum by 1000 and SKIP 900 CONTRACTS PER PAGE, silently.
  assert.equal(search.kwargs.startNum, 200, "page 2 * 100, not page 2 * 1000");
});

test("⚠ an EMPTY browse is reported as an expected fact, not an error", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/contracts");

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.browse.error, null, "the browse SUCCEEDED");
  // EveJS has no NPC/seed contract generator, so this is expected. The panel
  // says "no public delivery jobs in this world yet" on the strength of it.
  assert.equal(payload.worldHasNoContracts, true);
});

test("⚠ a FAILED browse must NOT claim the world has no contracts", async () => {
  const gateway = fakeGateway({ failures: ["contractProxy.SearchContracts"] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/contracts");

  assert.equal(response.status, 200);
  assert.equal(payload.browse.error, "CALL_FAILED");
  // ⚠ THE DISTINCTION THAT MATTERS. "Nothing was found" and "nothing could be
  // looked up" are different facts; conflating them would tell the player this
  // world has no contracts when in truth the read broke.
  assert.equal(
    payload.worldHasNoContracts,
    false,
    "a failed browse is not evidence of an empty world",
  );
});

test("a browse that FINDS something does not claim the world is empty", async () => {
  const gateway = fakeGateway({ browseResult: searchResult([searchEntry()], 1) });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload } = await apiRequest(baseUrl, "/api/bridge/contracts");
  assert.equal(payload.worldHasNoContracts, false);
});

// --- the player's own contracts ----------------------------------------------

test("the panel load issues the five reads and NO bind", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  gateway.calls.topLevel.length = 0;
  await apiRequest(baseUrl, "/api/bridge/contracts");

  const byMethod = gateway.calls.topLevel
    .filter((call) => call.service === "contractProxy")
    .map((call) => call.method)
    .sort();
  assert.deepEqual(byMethod, [
    "GetLoginInfo",
    "GetMyCurrentContractList",
    "GetMyCurrentContractList",
    "GetMyExpiredContractList",
    "SearchContracts",
  ]);
  // The whole surface is top-level (sm.ProxySvc), so nothing binds.
  for (const call of gateway.calls.topLevel) {
    assert.equal(call.bridgeSessionID, BRIDGE_SESSION_ID);
  }
});

test("the two own-contract reads differ only by isAccepted — neither names an owner", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, "/api/bridge/contracts");

  const current = gateway.calls.topLevel.filter(
    (call) => call.service === "contractProxy" && call.method === "GetMyCurrentContractList",
  );
  assert.deepEqual(current.map((call) => call.args), [[false, false], [true, false]]);
  // (isAccepted, forCorp). No owner argument at all — the character comes from
  // the session, so there is nothing here a browser could point elsewhere.
  const expired = gateway.calls.topLevel.find(
    (call) => call.service === "contractProxy" && call.method === "GetMyExpiredContractList",
  );
  assert.deepEqual(expired.args, [false]);
});

test("⚠ a failed browse never hides the player's OWN contracts", async () => {
  const gateway = fakeGateway({
    failures: ["contractProxy.SearchContracts"],
    outstandingResult: listBundle([contractRow()]),
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload } = await apiRequest(baseUrl, "/api/bridge/contracts");

  // Five INDEPENDENT reads: one failure must not blank the rest.
  assert.equal(payload.browse.error, "CALL_FAILED");
  assert.equal(payload.outstanding.error, null);
  assert.ok(payload.outstanding.result, "the player still sees their own contracts");
});

// --- the contracts OFFERED to this character --------------------------------
//
// ⚠ THE BUG THIS SECTION EXISTS FOR. GetLoginInfo COUNTS the contracts
// assigned to you, and not one of the other four reads can return them:
// GetMyCurrentContractList keys off issuerID and acceptorID, GetMyExpiredContractList
// off contractNeedsAttention, and the browse asks for `availability: PUBLIC`
// while a contract reserved for you is by definition not public. So the panel
// said "1 waiting for you" above four empty lists, with no way to see or take
// the contract. The route fetches the ids the count itself named.

test("⚠ a contract assigned to this character is fetched IN FULL — no other read returns it", async () => {
  const gateway = fakeGateway({
    summaryResult: loginInfo({ assignedToMe: [[CONTRACT_ID, 140000009]] }),
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload } = await apiRequest(baseUrl, "/api/bridge/contracts");

  const fetched = gateway.calls.topLevel.filter(
    (call) => call.service === "contractProxy" && call.method === "GetContract",
  );
  assert.deepEqual(fetched.map((call) => call.args), [[CONTRACT_ID]]);
  assert.equal(payload.assigned.results.length, 1, "the contract the count referred to");
  assert.equal(payload.assigned.numAssigned, 1);
  assert.equal(payload.assigned.error, null);
  // The point: every OTHER list is empty, and before this the panel had
  // nowhere at all to show the contract it was counting.
  assert.equal(payload.worldHasNoContracts, true);
});

test("⚠ the assigned ids come from the SUMMARY, never from the browser", async () => {
  const gateway = fakeGateway({
    summaryResult: loginInfo({ assignedToMe: [[CONTRACT_ID, 140000009]] }),
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, `/api/bridge/contracts?page=0&contractID=999999`);

  const fetched = gateway.calls.topLevel.filter(
    (call) => call.service === "contractProxy" && call.method === "GetContract",
  );
  // A contractID in the query string is not a read the session was told about.
  assert.deepEqual(
    fetched.map((call) => Number(call.args[0])),
    [CONTRACT_ID],
    "only the ids GetLoginInfo itself named are fetched",
  );
});

test("one assigned contract that cannot be fetched does not hide the others", async () => {
  const gateway = fakeGateway({
    // 999999 is not a contract the fake gateway knows, so GetContract answers
    // null for it — the server's own "no such contract".
    summaryResult: loginInfo({
      assignedToMe: [[CONTRACT_ID, 140000009], [999999, 140000009]],
    }),
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload } = await apiRequest(baseUrl, "/api/bridge/contracts");

  assert.equal(payload.assigned.results.length, 1, "the one that answered is kept");
  // The shortfall is its own fact so the panel can say the list is incomplete
  // rather than quietly showing fewer than the count promised.
  assert.equal(payload.assigned.numAssigned, 2);
  assert.equal(payload.assigned.error, "READ_FAILED");
});

test("a failed summary leaves the assigned list empty AND says why", async () => {
  const gateway = fakeGateway({ failures: ["contractProxy.GetLoginInfo"] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload } = await apiRequest(baseUrl, "/api/bridge/contracts");

  assert.equal(payload.summary.error, "CALL_FAILED");
  assert.deepEqual(payload.assigned.results, []);
  // "Nothing is offered to you" and "we could not find out" are different
  // facts; an empty list with no error would assert the first one falsely.
  assert.equal(payload.assigned.error, "CALL_FAILED");
});

test("each read keeps its OWN error", async () => {
  const gateway = fakeGateway({ failures: ["contractProxy.GetLoginInfo"] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload } = await apiRequest(baseUrl, "/api/bridge/contracts");

  assert.equal(payload.summary.error, "CALL_FAILED");
  assert.equal(payload.browse.error, null);
  assert.equal(payload.outstanding.error, null);
});

// --- the detail --------------------------------------------------------------

test("GET /api/bridge/contracts/detail answers the bundle for one contract", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(
    baseUrl,
    `/api/bridge/contracts/detail?contractID=${CONTRACT_ID}`,
  );

  assert.equal(response.status, 200);
  assert.equal(payload.contractID, CONTRACT_ID);
  assert.ok(payload.detail, "the browser gets the RAW bundle and decodes it properly");

  const call = gateway.calls.topLevel.find(
    (entry) => entry.service === "contractProxy" && entry.method === "GetContract",
  );
  assert.deepEqual(call.args, [CONTRACT_ID]);
});

test("GetContract's null (no such contract) is a 404, not an empty detail pane", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(
    baseUrl,
    "/api/bridge/contracts/detail?contractID=999999",
  );

  assert.equal(response.status, 404);
  assert.equal(payload.error, "CONTRACT_NOT_FOUND");
});

test("a detail request naming no contract is refused before the bridge", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  gateway.calls.topLevel.length = 0;
  const { response, payload } = await apiRequest(
    baseUrl,
    "/api/bridge/contracts/detail?contractID=0",
  );

  assert.equal(response.status, 400);
  assert.equal(payload.error, "CONTRACT_INVALID");
  assert.deepEqual(gateway.calls.topLevel, [], "a refused request never reaches the gateway");
});

// --- reads only, and session loss -------------------------------------------

test("⚠ the contract routes issue NO mutator — not one call writes", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, "/api/bridge/contracts");
  await apiRequest(baseUrl, `/api/bridge/contracts/detail?contractID=${CONTRACT_ID}`);

  // Every mutator sits on the SAME service as the reads above, so this is the
  // property that keeps a contracts panel from moving a player's items or ISK.
  const mutators = new Set([
    "AcceptContract",
    "CompleteContract",
    "CreateContract",
    "DeleteContract",
    "DeleteMultipleContracts",
    "SplitStack",
    "SetContractExpired",
    "PlaceBid",
    "FinishAuction",
  ]);
  for (const call of gateway.calls.topLevel) {
    assert.equal(
      mutators.has(call.method),
      false,
      `the contracts panel must never call ${call.method}`,
    );
  }
});

test("both contract routes need a held session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // No selectOnServer: nothing is held.
  for (const path of [
    "/api/bridge/contracts",
    `/api/bridge/contracts/detail?contractID=${CONTRACT_ID}`,
  ]) {
    const { response } = await apiRequest(baseUrl, path);
    assert.notEqual(response.status, 200, `${path} must refuse without a held session`);
  }
});

// --- R91 contract WRITES (confirm-gated) ------------------------------------
//
// Every write route REFUSES (400 CONFIRMATION_REQUIRED, no dispatch) unless the
// browser passes `confirm: true`. The financial/destructive/admin writes carry
// the same gate. These tests prove the gate, then prove one gated dispatch lands
// on contractProxy with the right method — reachability, never a live mutation.

const R91_CONTRACT_WRITE_ROUTES = [
  ["/api/bridge/contracts/create", {}],
  ["/api/bridge/contracts/accept", { contractID: CONTRACT_ID }],
  ["/api/bridge/contracts/complete", { contractID: CONTRACT_ID }],
  ["/api/bridge/contracts/delete", { contractID: CONTRACT_ID }],
  ["/api/bridge/contracts/delete-multiple", { contractIDs: [CONTRACT_ID] }],
  ["/api/bridge/contracts/bid", { contractID: CONTRACT_ID, amount: 1 }],
  ["/api/bridge/contracts/finish-auction", { contractID: CONTRACT_ID }],
  ["/api/bridge/contracts/split-stack", { itemID: 1, quantity: 1 }],
  ["/api/bridge/contracts/notification/delete", { notificationID: 1 }],
  ["/api/bridge/contracts/notification/delete-contract", { contractID: CONTRACT_ID }],
  ["/api/bridge/contracts/gm-expire", { contractID: CONTRACT_ID }],
];

test("⚠ every R91 contract write REFUSES without confirm — no dispatch", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  for (const [path, body] of R91_CONTRACT_WRITE_ROUTES) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 400, `${path} must refuse without confirm`);
    assert.equal(payload.error, "CONFIRMATION_REQUIRED", `${path} must answer CONFIRMATION_REQUIRED`);
  }
  // Not one write reached the gateway.
  const writeCalls = gateway.calls.topLevel.filter(
    (c) => c.service === "contractProxy" && c.method !== "SearchContracts",
  );
  assert.equal(writeCalls.length, 0, "a refused write must not dispatch");
});

test("a confirmed contract write dispatches on contractProxy with the right method", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  // CompleteContract is a non-financial write — safe to exercise against the fake.
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/contracts/complete", {
    method: "POST",
    body: { contractID: CONTRACT_ID, confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, true);
  const call = gateway.calls.topLevel.find((c) => c.method === "CompleteContract");
  assert.ok(call, "CompleteContract must reach the gateway once confirmed");
  assert.equal(call.service, "contractProxy");
  assert.equal(Number(call.args[0]), CONTRACT_ID);
});
