"use strict";

// Goal R15 (Slice A): the BFF industry READ route and the static recipe route.
//
// Industry is the first panel that needs NO bound-object machinery: the whole
// retail surface is top-level, so /api/bridge/industry is five plain
// callMethod round-trips on the held session. The interesting properties are
// therefore not about binds at all, they are about:
//
//   - INDEPENDENCE. The five reads run under Promise.allSettled, so a player
//     whose facility read fails still sees their blueprints and jobs. Each
//     read carries its own error; one failure never blanks the panel.
//   - ARGUMENTS. GetBlueprintDataByOwner / GetJobsByOwner / GetJobCounts are
//     scoped to the HELD session's own characterID — the browser cannot ask
//     for another character's industry, because it never supplies an ownerID.
//   - THE STATIC SPLIT. Names and recipes never touch the gateway. The recipe
//     route is pure static data, so it answers even with no live session.
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

// The blueprint the fixtures revolve around, and the job it is installed into.
const BLUEPRINT_ITEM_ID = 7_100_000_001;
const BLUEPRINT_TYPE_ID = 681;
const PRODUCT_TYPE_ID = 165;
const MATERIAL_TYPE_ID = 38;
const JOB_ID = 4_200_001;
// Invention from the same blueprint: a datacore per attempt and a decryptor.
const DATACORE_TYPE_ID = 20418;
const INVENTED_TYPE_ID = 1900;
const DECRYPTOR_TYPE_ID = 34204;
const TYPES = {
  [DATACORE_TYPE_ID]: { typeID: DATACORE_TYPE_ID, groupID: 333, categoryID: 17 },
  [INVENTED_TYPE_ID]: { typeID: INVENTED_TYPE_ID, groupID: 176, categoryID: 9 },
  [DECRYPTOR_TYPE_ID]: { typeID: DECRYPTOR_TYPE_ID, groupID: 1304, categoryID: 35 },
};

// Activity + status codes. These appear in FIXTURES (the server's own view) and
// nowhere else — the decoded panel state speaks in names.
const ACTIVITY_MANUFACTURING = 1;
const ACTIVITY_COPYING = 5;
const STATUS_INSTALLED = 1;
const STATUS_DELIVERED = 101;
const STATUS_CANCELLED = 102;
const MONITOR_ID = 90001;

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

// The static-data half: the 5,081-definition table in miniature. Only the one
// blueprint the fixtures use is known; everything else is a definitive miss,
// which the route must echo as null rather than omitting.
function fakeStaticData() {
  return {
    getStation() {
      return null;
    },
    getTypeName(id) {
      return `Type ${id}`;
    },
    getIndustryBlueprint(blueprintTypeID) {
      if (Number(blueprintTypeID) !== BLUEPRINT_TYPE_ID) {
        return null;
      }
      return {
        blueprintTypeID: BLUEPRINT_TYPE_ID,
        blueprintName: "Clone Grade Beta Blueprint",
        productTypeID: PRODUCT_TYPE_ID,
        productName: "Clone Grade Beta",
        maxProductionLimit: 300,
        activities: {
          manufacturing: {
            materials: [{ typeID: MATERIAL_TYPE_ID, quantity: 86 }],
            products: [{ typeID: PRODUCT_TYPE_ID, quantity: 1 }],
            time: 600,
          },
          copying: { time: 480 },
          invention: {
            materials: [{ typeID: DATACORE_TYPE_ID, quantity: 2 }],
            products: [{ typeID: INVENTED_TYPE_ID, quantity: 10 }],
            time: 7800,
          },
        },
      };
    },
    getType(typeID) {
      return TYPES[Number(typeID)] || null;
    },
    resolveNames() {
      return { names: {}, capped: false, limit: 500 };
    },
  };
}

// --- marshaled-value builders (the server's own encodings) ------------------

function keyVal(entries) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

function list(items) {
  return { type: "list", items };
}

function dict(entries) {
  return { type: "dict", entries };
}

function long(value) {
  return { type: "long", value: String(value) };
}

function blueprintRow(overrides = {}) {
  return keyVal(
    Object.entries({
      typeID: BLUEPRINT_TYPE_ID,
      itemID: BLUEPRINT_ITEM_ID,
      timeEfficiency: 20,
      materialEfficiency: 10,
      runs: 40,
      quantity: -1,
      locationID: STATION_ID,
      locationTypeID: 0,
      locationFlagID: 4,
      flagID: 4,
      facilityID: null,
      ownerID: CHARACTER_ID,
      jobID: null,
      isImpounded: false,
      original: false,
      solarSystemID: SOLAR_SYSTEM_ID,
      ...overrides,
    }),
  );
}

function jobRow(overrides = {}) {
  const fields = {
    activityID: ACTIVITY_MANUFACTURING,
    jobID: JOB_ID,
    blueprintID: BLUEPRINT_ITEM_ID,
    blueprintTypeID: BLUEPRINT_TYPE_ID,
    blueprintCopy: true,
    facilityID: STATION_ID,
    ownerID: CHARACTER_ID,
    status: STATUS_INSTALLED,
    installerID: CHARACTER_ID,
    solarSystemID: SOLAR_SYSTEM_ID,
    stationID: STATION_ID,
    runs: 3,
    licensedRuns: 1,
    successfulRuns: 0,
    cost: 1250,
    timeInSeconds: 1800,
    probability: 1,
    productTypeID: PRODUCT_TYPE_ID,
    outputLocationID: STATION_ID,
    outputFlagID: 4,
    ...overrides,
  };
  const entries = Object.entries(fields);
  // The dates are retail FILETIME longs, not plain numbers.
  entries.push(["startDate", long("133000000000000000")]);
  entries.push(["endDate", long("133000000018000000")]);
  return keyVal(entries);
}

/**
 * An industry.Location as facilityManager.GetFacilityLocations really answers
 * it: an objectex1 whose FIELDS live in header[2], with an EMPTY top-level
 * dict. A decoder that reads `value.dict` finds nothing.
 */
function locationObject(overrides = {}) {
  const fields = {
    itemID: STATION_ID,
    typeID: 52678,
    ownerID: CHARACTER_ID,
    flagID: 4,
    solarSystemID: SOLAR_SYSTEM_ID,
    canView: true,
    canTake: true,
    ...overrides,
  };
  return {
    type: "objectex1",
    header: [
      { type: "token", value: "industry.Location" },
      [],
      { type: "dict", entries: Object.entries(fields) },
    ],
    list: [],
    dict: [],
  };
}

function facilityRow(overrides = {}) {
  return keyVal(
    Object.entries({
      facilityID: STATION_ID,
      typeID: 52678,
      ownerID: 1000035,
      tax: 0.01,
      solarSystemID: SOLAR_SYSTEM_ID,
      online: true,
      sccTaxModifier: 1,
      ...overrides,
    }).concat([
      [
        "activities",
        dict([
          [ACTIVITY_MANUFACTURING, { type: "tuple", items: [] }],
          [ACTIVITY_COPYING, { type: "tuple", items: [] }],
        ]),
      ],
    ]),
  );
}

/**
 * A gateway fake for the industry surface. `failures` names the (service,
 * method) pairs that should throw, so the independence of the five reads can be
 * exercised one at a time.
 */
function fakeGateway(options = {}) {
  const calls = { topLevel: [] };
  const failures = new Set(options.failures || []);
  const jobs = options.jobs || [jobRow()];
  const blueprints = options.blueprints || [blueprintRow()];

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
      if (service === "blueprintManager" && method === "GetBlueprintDataByOwner") {
        // ⚠ A 2-TUPLE, not a list: [rows, facilityID -> count].
        return {
          service,
          method,
          result: [list(blueprints), dict([[STATION_ID, blueprints.length]])],
          notifications: [],
        };
      }
      if (service === "industryManager" && method === "GetJobsByOwner") {
        const includeCompleted = args[1] === true;
        return {
          service,
          method,
          result: list(includeCompleted ? jobs : jobs.filter((row) => !isFinishedRow(row))),
          notifications: [],
        };
      }
      if (service === "industryManager" && method === "GetJobCounts") {
        return { service, method, result: dict([[ACTIVITY_MANUFACTURING, 1]]), notifications: [] };
      }
      if (service === "facilityManager" && method === "GetFacilities") {
        return { service, method, result: list([facilityRow()]), notifications: [] };
      }
      if (service === "facilityManager" && method === "GetMaxActivityModifiers") {
        return { service, method, result: dict([[ACTIVITY_MANUFACTURING, 1.0]]), notifications: [] };
      }
      return { service, method, result: null, notifications: [] };
    },
    async bindObject() {
      throw new Error("industry needs no bound objects");
    },
    async callBoundMethod() {
      throw new Error("industry needs no bound objects");
    },
  };
}

function isFinishedRow(row) {
  const entries = row.args.entries;
  const status = (entries.find(([key]) => key === "status") || [])[1];
  return Number(status) >= 100;
}

/** Read one key off a util.KeyVal row (the tests assert on raw results too). */
function readKeyVal(row, key) {
  const entry = (row.args.entries || []).find((candidate) => candidate[0] === key);
  return entry ? entry[1] : undefined;
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

// --- the read route ---------------------------------------------------------

test("GET /api/bridge/industry issues the five top-level reads and NO bind", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  // Every industry call is TOP-LEVEL. If a bind ever appears here the fake
  // throws, so this is enforced rather than merely asserted.
  const issued = gateway.calls.topLevel.map((call) => `${call.service}.${call.method}`);
  for (const pair of [
    "blueprintManager.GetBlueprintDataByOwner",
    "industryManager.GetJobsByOwner",
    "industryManager.GetJobCounts",
    "facilityManager.GetFacilities",
    "facilityManager.GetMaxActivityModifiers",
  ]) {
    assert.ok(issued.includes(pair), `expected ${pair} to be issued`);
  }
  // Each read rides the SAME held bridge session.
  for (const call of gateway.calls.topLevel) {
    assert.equal(call.bridgeSessionID, BRIDGE_SESSION_ID);
  }
});

test("the reads are scoped to the HELD session's own character, not a browser-supplied id", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, "/api/bridge/industry");

  const owned = gateway.calls.topLevel.filter((call) =>
    ["GetBlueprintDataByOwner", "GetJobsByOwner", "GetJobCounts"].includes(call.method),
  );
  assert.equal(owned.length, 3);
  for (const call of owned) {
    assert.equal(
      call.args[0],
      CHARACTER_ID,
      `${call.method} must be scoped to the held character`,
    );
  }
  // The facility read is region-scoped off the SESSION and takes no arguments,
  // so it cannot be pointed at another region either.
  const facilities = gateway.calls.topLevel.find((call) => call.method === "GetFacilities");
  assert.deepEqual(facilities.args, []);
});

test("jobs are read with includeCompleted=true so finished work is shown too", async () => {
  const gateway = fakeGateway({
    jobs: [jobRow(), jobRow({ jobID: JOB_ID + 1, status: STATUS_DELIVERED, successfulRuns: 3 })],
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload } = await apiRequest(baseUrl, "/api/bridge/industry");

  const jobsCall = gateway.calls.topLevel.find((call) => call.method === "GetJobsByOwner");
  assert.equal(jobsCall.args[1], true, "includeCompleted must be true");
  assert.equal(payload.jobs.result.items.length, 2);
});

test("the blueprint read answers a 2-TUPLE, and the route passes it through intact", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload } = await apiRequest(baseUrl, "/api/bridge/industry");

  // ⚠ The shape is [list<instance>, dict<facilityID -> count>]. A route that
  // "helpfully" unwrapped it to the list alone would lose the counts and break
  // the decoder's own tuple handling.
  const result = payload.blueprints.result;
  assert.ok(Array.isArray(result), "GetBlueprintDataByOwner answers an array");
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "list");
  assert.equal(result[1].type, "dict");

  // Material and time efficiency are DISTINCT fields; the fixture makes them
  // differ so a transposition fails here.
  const row = result[0].items[0];
  assert.equal(readKeyVal(row, "materialEfficiency"), 10);
  assert.equal(readKeyVal(row, "timeEfficiency"), 20);
  assert.equal(readKeyVal(row, "runs"), 40);
});

test("a failed facility read never blanks the blueprints or the jobs", async () => {
  const gateway = fakeGateway({ failures: ["facilityManager.GetFacilities"] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry");
  // The ROUTE still succeeds: the five reads are independent.
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.facilities.error, "CALL_FAILED");
  assert.equal(payload.facilities.result, null);
  // ...and the rest came through untouched.
  assert.equal(payload.blueprints.error, null);
  assert.ok(Array.isArray(payload.blueprints.result));
  assert.equal(payload.jobs.error, null);
  assert.equal(payload.jobs.result.items.length, 1);
});

test("a failed blueprint read never blanks the jobs or the facilities", async () => {
  const gateway = fakeGateway({ failures: ["blueprintManager.GetBlueprintDataByOwner"] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/industry");
  assert.equal(payload.blueprints.error, "CALL_FAILED");
  assert.equal(payload.jobs.error, null);
  assert.equal(payload.facilities.error, null);
  assert.equal(payload.facilities.result.items.length, 1);
});

test("the industry read requires a live session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // No select: nothing is held.
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry");
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_LIVE_SESSION");
  assert.equal(gateway.calls.topLevel.length, 0, "no call may reach the gateway");
});

// --- the static recipe route ------------------------------------------------

test("POST /api/industry/blueprints answers recipes from STATIC data, with no gateway call", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // Deliberately NO select — static reference data does not need a live
  // session, which is what keeps the panel's recipes available after one drops.
  const { response, payload } = await apiRequest(baseUrl, "/api/industry/blueprints", {
    method: "POST",
    body: { blueprintTypeIDs: [BLUEPRINT_TYPE_ID] },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "static-data");
  assert.equal(gateway.calls.topLevel.length, 0, "recipes never touch the gateway");

  const definition = payload.definitions[String(BLUEPRINT_TYPE_ID)];
  assert.equal(definition.blueprintName, "Clone Grade Beta Blueprint");
  assert.equal(definition.productName, "Clone Grade Beta");
  assert.equal(definition.activities.manufacturing.time, 600);
  assert.deepEqual(definition.activities.manufacturing.materials, [
    { typeID: MATERIAL_TYPE_ID, quantity: 86 },
  ]);
  // A blueprint's copying activity has a time but no materials — the shape
  // varies per activity and the route must not normalize that away.
  assert.equal(definition.activities.copying.time, 480);
  assert.equal(definition.activities.copying.materials, undefined);
});

test("an unknown blueprint type is echoed as an explicit null, not omitted", async () => {
  const { baseUrl } = await startTestServer({ gateway: fakeGateway() });
  const { payload } = await apiRequest(baseUrl, "/api/industry/blueprints", {
    method: "POST",
    body: { blueprintTypeIDs: [BLUEPRINT_TYPE_ID, 999_999] },
  });
  // Echoing the miss lets the client cache it and never ask again.
  assert.ok("999999" in payload.definitions);
  assert.equal(payload.definitions["999999"], null);
  assert.notEqual(payload.definitions[String(BLUEPRINT_TYPE_ID)], null);
});

test("the recipe route dedupes and caps its input", async () => {
  const { baseUrl } = await startTestServer({ gateway: fakeGateway() });
  const { payload } = await apiRequest(baseUrl, "/api/industry/blueprints", {
    method: "POST",
    body: { blueprintTypeIDs: [BLUEPRINT_TYPE_ID, BLUEPRINT_TYPE_ID, 0, -3, BLUEPRINT_TYPE_ID] },
  });
  assert.equal(payload.count, 1, "duplicates and non-positive ids are dropped");
  assert.equal(payload.capped, false);

  const oversized = [];
  for (let index = 1; index <= payload.limit + 25; index += 1) {
    oversized.push(index);
  }
  const { payload: cappedPayload } = await apiRequest(baseUrl, "/api/industry/blueprints", {
    method: "POST",
    body: { blueprintTypeIDs: oversized },
  });
  assert.equal(cappedPayload.capped, true);
  assert.equal(cappedPayload.count, cappedPayload.limit);
});

// --- Slice B: install / deliver / cancel ------------------------------------
//
// Installing SPENDS things - materials out of a hangar and ISK out of the
// wallet - so the route is fenced twice: it refuses outright without an
// explicit confirmation flag, and the UI puts a two-step confirm in front of
// that. Cancelling is fenced the same way, because it refunds NOTHING.
//
// And the R12/R14 lesson: a 200 is not proof. Every mutating route RE-READS the
// job and reports what actually applied. The gateway fake below therefore holds
// a real little job world and mutates it, so a re-read sees the real
// consequence of its own call.

/** A gateway fake with a mutable job world, for the mutating routes. */
function fakeIndustryGateway(options = {}) {
  const calls = { topLevel: [] };
  const jobs = new Map();
  let nextJobID = JOB_ID;
  const installAnswersNull = options.installAnswersNull === true;
  const deliverDoesNothing = options.deliverDoesNothing === true;
  const failures = new Set(options.failures || []);

  function jobRowFor(job) {
    return jobRow({
      jobID: job.jobID,
      status: job.status,
      runs: job.runs,
      activityID: job.activityID,
      facilityID: job.facilityID,
      cost: job.cost,
      successfulRuns: job.successfulRuns || 0,
    });
  }

  return {
    calls,
    jobs,
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
        // The refusal shape the real gateway client raises: a typed code AND
        // the HTTP status it arrived with, which the BFF re-uses.
        throw Object.assign(new Error("IndustryValidationError: MISSING_MATERIAL"), {
          code: "CALL_REFUSED",
          statusCode: 409,
        });
      }
      if (service === "facilityManager" && method === "GetFacilityLocations") {
        return { service, method, result: list([locationObject(), locationObject({ flagID: 62, canTake: false })]), notifications: [] };
      }
      if (service === "industryMonitor" && method === "ConnectJob") {
        return {
          service,
          method,
          result: [MONITOR_ID, dict([[MATERIAL_TYPE_ID, 500]])],
          notifications: [],
        };
      }
      if (service === "industryMonitor" && method === "DisconnectJob") {
        return { service, method, result: null, notifications: [] };
      }
      if (service === "industryManager" && method === "InstallJob") {
        if (installAnswersNull) {
          // The SILENT decline: 200, a null jobID, nothing started.
          return { service, method, result: null, notifications: [] };
        }
        const request = args[0] || {};
        nextJobID += 1;
        jobs.set(nextJobID, {
          jobID: nextJobID,
          status: STATUS_INSTALLED,
          runs: Number(request.runs) || 0,
          activityID: Number(request.activityID) || 0,
          facilityID: Number(request.facilityID) || 0,
          // The SERVER's cost, not the client's advisory zero.
          cost: 1250,
        });
        return { service, method, result: nextJobID, notifications: [] };
      }
      if (service === "industryManager" && method === "CompleteJob") {
        const job = jobs.get(Number(args[0]));
        if (job && !deliverDoesNothing) {
          job.status = STATUS_DELIVERED;
          job.successfulRuns = job.runs;
        }
        return { service, method, result: null, notifications: [] };
      }
      if (service === "industryManager" && method === "CancelJob") {
        const job = jobs.get(Number(args[0]));
        if (job) {
          job.status = STATUS_CANCELLED;
          job.successfulRuns = 0;
        }
        return { service, method, result: null, notifications: [] };
      }
      if (service === "industryManager" && method === "GetJob") {
        const job = jobs.get(Number(args[0]));
        return { service, method, result: job ? jobRowFor(job) : jobRow({ jobID: 0 }), notifications: [] };
      }
      if (service === "blueprintManager" && method === "GetBlueprintData") {
        // After an install the blueprint is locked into the job.
        const busy = [...jobs.values()].find((job) => job.status === STATUS_INSTALLED);
        return {
          service,
          method,
          result: blueprintRow(busy ? { jobID: busy.jobID } : {}),
          notifications: [],
        };
      }
      if (service === "industryManager" && method === "GetJobsByOwner") {
        return { service, method, result: list([...jobs.values()].map(jobRowFor)), notifications: [] };
      }
      if (service === "blueprintManager" && method === "GetBlueprintDataByOwner") {
        return { service, method, result: [list([blueprintRow()]), dict([])], notifications: [] };
      }
      if (service === "industryManager" && method === "GetJobCounts") {
        return { service, method, result: dict([]), notifications: [] };
      }
      if (service === "facilityManager" && method === "GetFacilities") {
        return { service, method, result: list([facilityRow()]), notifications: [] };
      }
      return { service, method, result: null, notifications: [] };
    },
    async bindObject() {
      throw new Error("industry needs no bound objects");
    },
    async callBoundMethod() {
      throw new Error("industry needs no bound objects");
    },
  };
}

/** A valid install request the way the browser sends it: activity by NAME. */
function installBody(overrides = {}) {
  return {
    blueprintItemID: BLUEPRINT_ITEM_ID,
    blueprintTypeID: BLUEPRINT_TYPE_ID,
    activity: "manufacturing",
    facilityID: STATION_ID,
    runs: 3,
    confirm: true,
    ...overrides,
  };
}

test("install REFUSES without an explicit confirmation, and nothing reaches the gateway", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody({ confirm: false }),
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "CONFIRMATION_REQUIRED");
  assert.match(payload.message, /materials/i, "the refusal must say what would be spent");
  assert.equal(
    gateway.calls.topLevel.some((call) => call.method === "InstallJob"),
    false,
    "an unconfirmed install must never reach InstallJob",
  );
  assert.equal(gateway.jobs.size, 0, "and must not start a job");
});

test("install sends ONE POSITIONAL DICT with the fields the server actually reads", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody(),
  });

  const install = gateway.calls.topLevel.find((call) => call.method === "InstallJob");
  assert.ok(install, "InstallJob must be called");
  assert.equal(install.args.length, 1, "InstallJob takes exactly ONE positional argument");
  assert.equal(install.kwargs, null, "...and no kwargs");

  const payload = install.args[0];
  assert.equal(typeof payload, "object");
  assert.equal(Array.isArray(payload), false, "the argument is a DICT, not a list");

  // The fields that decide the outcome.
  assert.equal(payload.blueprintID, BLUEPRINT_ITEM_ID);
  assert.equal(payload.activityID, ACTIVITY_MANUFACTURING, "the browser named the activity; the BFF maps it");
  assert.equal(payload.facilityID, STATION_ID);
  assert.equal(payload.runs, 3);
  assert.equal(payload.licensedRuns, 1);
  // Scoped to the HELD session, never to a browser-supplied identity.
  assert.equal(payload.characterID, CHARACTER_ID);
  assert.equal(payload.solarSystemID, SOLAR_SYSTEM_ID);

  // The full retail shape is sent, including the advisory fields the server
  // recomputes anyway - a partial dict is a worse contract than a complete one.
  for (const key of [
    "blueprintTypeID",
    "corporationID",
    "account",
    "cost",
    "tax",
    "time",
    "materials",
    "inputLocation",
    "outputLocation",
    "productTypeID",
  ]) {
    assert.ok(key in payload, `the payload must carry ${key}`);
  }
});

test("install resolves the input hangar from GetFacilityLocations, preferring one it may TAKE from", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody(),
  });

  const locations = gateway.calls.topLevel.find((call) => call.method === "GetFacilityLocations");
  assert.ok(locations, "the hangar choices must be read first");
  assert.deepEqual(locations.args, [STATION_ID, CHARACTER_ID]);

  const payload = gateway.calls.topLevel.find((call) => call.method === "InstallJob").args[0];
  // The fixture offers a takeable hangar (flag 4) and a non-takeable one
  // (flag 62). Materials can only come from the one it may take from.
  assert.equal(payload.inputLocation.flagID, 4);
  assert.equal(payload.inputLocation.canTake, true);
});

test("install RE-READS the job and the blueprint - a 200 is not the proof", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody(),
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, true);
  assert.equal(payload.declinedSilently, false);
  assert.ok(payload.jobID > 0);

  // Both re-reads happened, and both are returned.
  assert.ok(gateway.calls.topLevel.some((call) => call.method === "GetJob"));
  assert.ok(gateway.calls.topLevel.some((call) => call.method === "GetBlueprintData"));
  assert.notEqual(payload.job, null);
  assert.notEqual(payload.blueprint, null);

  // The job carries the cost the SERVER charged, not the advisory zero sent.
  assert.equal(readKeyVal(payload.job, "cost"), 1250);
  // ...and the blueprint is now locked into that job.
  assert.equal(readKeyVal(payload.blueprint, "jobID"), payload.jobID);
});

test("a SILENT install decline is reported as a decline, not as success", async () => {
  const gateway = fakeIndustryGateway({ installAnswersNull: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody(),
  });
  // The handler answered WITHOUT raising and without starting anything.
  assert.equal(response.status, 200);
  assert.equal(payload.applied, false);
  assert.equal(payload.declinedSilently, true);
  assert.equal(payload.jobID, null);
  assert.equal(payload.job, null);
  // No re-read is issued for a job that was never created.
  assert.equal(gateway.calls.topLevel.some((call) => call.method === "GetJob"), false);
});

test("a THROWN install refusal passes the server's own reasons through", async () => {
  const gateway = fakeIndustryGateway({ failures: ["industryManager.InstallJob"] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody(),
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "CALL_REFUSED");
  // The SERVER's own error names, unreworded by the BFF.
  assert.match(String(payload.message), /MISSING_MATERIAL/);
});

test("install validates its request before spending anything", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const cases = [
    [{ blueprintItemID: 0 }, "INVALID_BLUEPRINT"],
    [{ activity: "smelting" }, "INVALID_ACTIVITY"],
    [{ facilityID: 0 }, "INVALID_FACILITY"],
    [{ runs: 0 }, "INVALID_RUNS"],
    [{ runs: -5 }, "INVALID_RUNS"],
    [{ runs: 99_999_999 }, "INVALID_RUNS"],
  ];
  for (const [overrides, expected] of cases) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
      method: "POST",
      body: installBody(overrides),
    });
    assert.equal(response.status, 400, JSON.stringify(overrides));
    assert.equal(payload.error, expected, JSON.stringify(overrides));
  }
  assert.equal(gateway.jobs.size, 0, "no invalid request may start a job");
});

test("the preview reads what the player HAS and always RELEASES its monitor", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry/preview", {
    method: "POST",
    body: installBody({ confirm: undefined }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(payload.available, { [String(MATERIAL_TYPE_ID)]: 500 });

  // ConnectJob is NOT a pure read - it persists a monitor row - so the route
  // always releases the monitor it opened.
  const disconnect = gateway.calls.topLevel.find((call) => call.method === "DisconnectJob");
  assert.ok(disconnect, "the monitor must be released");
  assert.deepEqual(disconnect.args, [MONITOR_ID]);

  // The preview starts NOTHING.
  assert.equal(gateway.calls.topLevel.some((call) => call.method === "InstallJob"), false);
  assert.equal(gateway.jobs.size, 0);
});

test("the preview needs no confirmation - it spends nothing", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/industry/preview", {
    method: "POST",
    body: { ...installBody(), confirm: false },
  });
  assert.equal(response.status, 200);
});

test("deliver calls CompleteJob(jobID, solarSystemID) and judges by the RE-READ", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload: installed } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody(),
  });

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry/deliver", {
    method: "POST",
    body: { jobID: installed.jobID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  assert.equal(payload.declinedSilently, false);

  const deliver = gateway.calls.topLevel.find((call) => call.method === "CompleteJob");
  // The solar system comes from the HELD session's live position.
  assert.deepEqual(deliver.args, [installed.jobID, SOLAR_SYSTEM_ID]);
  assert.equal(readKeyVal(payload.job, "status"), STATUS_DELIVERED);
});

test("a deliver that changes nothing is reported as a silent decline", async () => {
  const gateway = fakeIndustryGateway({ deliverDoesNothing: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload: installed } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody(),
  });

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry/deliver", {
    method: "POST",
    body: { jobID: installed.jobID },
  });
  // 200 with the job STILL running: the re-read is what catches this, and it
  // is reported honestly rather than as a success.
  assert.equal(response.status, 200);
  assert.equal(payload.applied, false);
  assert.equal(payload.declinedSilently, true);
  assert.equal(readKeyVal(payload.job, "status"), STATUS_INSTALLED);
});

test("cancel REFUSES without an explicit confirmation, and says what will be lost", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload: installed } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody(),
  });

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry/cancel", {
    method: "POST",
    body: { jobID: installed.jobID },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "CONFIRMATION_REQUIRED");
  // Cancelling refunds NEITHER the materials NOR the fee, and the refusal has
  // to say so - that is the whole reason it is gated.
  assert.match(payload.message, /materials/i);
  assert.match(payload.message, /fee/i);
  assert.equal(gateway.calls.topLevel.some((call) => call.method === "CancelJob"), false);
});

test("a confirmed cancel stops the job, and the RE-READ is what proves it", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { payload: installed } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody(),
  });

  const { payload } = await apiRequest(baseUrl, "/api/bridge/industry/cancel", {
    method: "POST",
    body: { jobID: installed.jobID, confirm: true },
  });
  assert.equal(payload.applied, true);
  const cancel = gateway.calls.topLevel.find((call) => call.method === "CancelJob");
  assert.deepEqual(cancel.args, [installed.jobID, SOLAR_SYSTEM_ID]);
  assert.equal(readKeyVal(payload.job, "status"), STATUS_CANCELLED);
});

test("every mutating industry route requires a live session", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // No select.
  for (const [path, body] of [
    ["/api/bridge/industry/preview", installBody()],
    ["/api/bridge/industry/install", installBody()],
    ["/api/bridge/industry/deliver", { jobID: 1 }],
    ["/api/bridge/industry/cancel", { jobID: 1, confirm: true }],
  ]) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 409, path);
    assert.equal(payload.error, "NO_LIVE_SESSION", path);
  }
  assert.equal(gateway.calls.topLevel.length, 0, "no call may reach the gateway");
});

test("deliver and cancel reject a missing job before calling anything", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  for (const path of ["/api/bridge/industry/deliver", "/api/bridge/industry/cancel"]) {
    const { response, payload } = await apiRequest(baseUrl, path, {
      method: "POST",
      body: { jobID: 0, confirm: true },
    });
    assert.equal(response.status, 400, path);
    assert.equal(payload.error, "INVALID_JOB", path);
  }
  assert.equal(gateway.calls.topLevel.length, 0);
});

// --- invention with a decryptor ---------------------------------------------
//
// The server takes a decryptor from the request's materials only, and then
// compares that map EXACTLY with its own (src/industryInstall.js). Every other
// install keeps sending an empty map, which the server recomputes.

test("an invention with a decryptor sends the exact materials map and names the decryptor", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response } = await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody({ activity: "invention", runs: 3, decryptorTypeID: DECRYPTOR_TYPE_ID }),
  });
  assert.equal(response.status, 200);
  const install = gateway.calls.topLevel.find((call) => call.method === "InstallJob");
  assert.ok(install);
  const payload = install.args[0];
  assert.equal(payload.activityID, 8);
  assert.deepEqual(payload.materials, { [DATACORE_TYPE_ID]: 6, [DECRYPTOR_TYPE_ID]: 3 });
  assert.equal(payload.optionalTypeID, DECRYPTOR_TYPE_ID);
  assert.equal(payload.productTypeID, INVENTED_TYPE_ID, "the invented blueprint, as the server resolves it");
  // The facility's modifiers are read for it, the way the retail client does.
  assert.ok(gateway.calls.topLevel.some((call) => call.method === "GetFacilities"));
});

test("without a decryptor, install keeps sending an empty materials map and reads no facility", async () => {
  const gateway = fakeIndustryGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/industry/install", {
    method: "POST",
    body: installBody({ activity: "invention", runs: 3 }),
  });
  const install = gateway.calls.topLevel.find((call) => call.method === "InstallJob");
  assert.deepEqual(install.args[0].materials, {});
  assert.equal(install.args[0].optionalTypeID, null);
  assert.equal(gateway.calls.topLevel.some((call) => call.method === "GetFacilities"), false);
});

test("a decryptor is refused on anything but invention, and anything but a decryptor is refused as one", async () => {
  for (const body of [
    installBody({ activity: "manufacturing", decryptorTypeID: DECRYPTOR_TYPE_ID }),
    installBody({ activity: "invention", decryptorTypeID: DATACORE_TYPE_ID }),
    installBody({ activity: "invention", decryptorTypeID: 999999 }),
    installBody({ activity: "invention", decryptorTypeID: "parity" }),
  ]) {
    const gateway = fakeIndustryGateway();
    const { baseUrl } = await startTestServer({ gateway });
    await selectOnServer(baseUrl);
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/industry/install", { method: "POST", body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(payload.error, "INVALID_DECRYPTOR");
    assert.equal(gateway.calls.topLevel.some((call) => call.method === "InstallJob"), false);
  }
});
