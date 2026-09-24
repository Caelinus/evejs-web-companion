"use strict";

// R108 slice 3 — GET /api/roster/planets, the PI Manager's read: every assigned
// pilot's colonies, WITHOUT any of them being selected.
//
// ⚠ WHY THIS NEEDS NO HELD SESSION. /api/bridge/planets answers for whichever
// character the tab selected, but that is the BFF route's shape, not the
// gateway's: GET /snapshot is gated by validateOwnedCharacter alone and the
// colonies inside it are filtered by ownerID out of a persisted table. Proved
// live on 2026-09-22 (the gate discriminates: 200 own / 403 foreign / 404
// missing) and on 2026-09-23 with a pilot that had colonies and was logged out:
// they came back, owner-filtered, and a pilot on the same account with none came
// back with a colony table that was present and empty.
//
// So this route is /api/roster/training's shape exactly: plural ids from the
// browser, each asked with the CALLER's accountID, a refused id left OUT.
//
// What these pin, beyond the shape:
//   • a pilot NOT answered is omitted, never reported as "no colonies" — the
//     board keeps the reading it had;
//   • "the table was there and none of it is yours" and "the gateway carried no
//     table" stay two different answers, per pilot;
//   • every pilot carries its OWN read instant, because a board of several
//     pilots read at different moments is not one moment.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
// ESI's own documented example id — deliberately synthetic, never a real pilot.
const FARMER_ID = 90000001;
const NOT_YET_BUILT_ID = 90000002;
const UNREADABLE_ID = 90000003;
const NO_TABLE_ID = 90000004;
const SLOW_ID = 90000005;
const MISSING_ID = 90000008;
const NOT_OURS_ID = 90000009;
const STOCK_ID = 90000010;

const PLANET_A = 40000002;
const PLANET_B = 40000004;
const SYSTEM_ID = 30000001;
const ECU_TYPE_ID = 3068;
const COMMAND_CENTER_TYPE_ID = 2254;
const TEMPERATE_TYPE_ID = 11;
const SLOW_DELAY_MS = 60;
const STATION_ID = 60000004;
const SHIP_ITEM_ID = 1000000100;
const WATER_TYPE_ID = 3645;
const AQUEOUS_TYPE_ID = 2268;
const SHIP_CATEGORY_ID = 6;

const activeServers = new Set();

function fakeAuth() {
  return {
    createSessionToken: () => COOKIE_TOKEN,
    verifySessionToken: (token) =>
      token === COOKIE_TOKEN
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: "sid" }
        : null,
    countConfiguredUsers: () => 1,
  };
}

function fakeStore() {
  return {
    async getAccount(username) {
      return username === ACCOUNT.username ? { ...ACCOUNT } : null;
    },
  };
}

function colony(planetID, ownerID) {
  return {
    planetID,
    ownerID,
    solarSystemID: SYSTEM_ID,
    planetTypeID: TEMPERATE_TYPE_ID,
    typeID: TEMPERATE_TYPE_ID,
    level: 4,
    currentSimTime: "134345346293950000",
    pins: [
      {
        id: 1,
        pinID: 1,
        ownerID,
        typeID: COMMAND_CENTER_TYPE_ID,
        contents: {},
        lastLaunchTime: "0",
      },
      {
        id: 2,
        pinID: 2,
        ownerID,
        typeID: ECU_TYPE_ID,
        contents: {},
        cycleTime: 72000000000,
        programType: 2268,
        qtyPerCycle: 4591,
        expiryTime: "134349666293950000",
        installTime: "134345346293950000",
        heads: [[0, 1, 3]],
      },
    ],
    links: [{ endpoint1: 1, endpoint2: 2, level: 0, typeID: 2280 }],
    routes: [],
  };
}

/** A snapshot as the gateway sends it: the colony table keyed planet:owner. */
function snapshotWith(colonies) {
  const coloniesByKey = {};
  for (const entry of colonies) {
    coloniesByKey[`${entry.planetID}:${entry.ownerID}`] = entry;
  }
  return {
    source: "evejs-web-gateway",
    items: [],
    planetRuntimeState: { schemaVersion: 1, coloniesByKey, launchesByID: {} },
  };
}

/**
 * A pilot with stock, as the gateway carries it: items keyed by itemID (the
 * live shape), and the planet's resource record beside its colony.
 */
function stockSnapshot() {
  const snapshot = snapshotWith([colony(PLANET_A, STOCK_ID)]);
  snapshot.characters = { [String(STOCK_ID)]: { corporationID: 98000001 } };
  const item = (itemID, fields) => [String(itemID), { itemID, ownerID: STOCK_ID, flagID: 4, singleton: 0, ...fields }];
  snapshot.items = Object.fromEntries([
    // Two stacks of one type in one hangar: one line, summed.
    item(1000000001, { typeID: WATER_TYPE_ID, categoryID: 43, locationID: STATION_ID, stacksize: 300, quantity: 300 }),
    item(1000000002, { typeID: WATER_TYPE_ID, categoryID: 43, locationID: STATION_ID, stacksize: 100, quantity: 100 }),
    // Raw resource in a ship's cargo, the ship docked at the same station.
    item(SHIP_ITEM_ID, { typeID: 648, categoryID: SHIP_CATEGORY_ID, locationID: STATION_ID, itemName: "Hauler One", singleton: 1, quantity: -1, stacksize: 1 }),
    item(1000000003, { typeID: AQUEOUS_TYPE_ID, categoryID: 42, locationID: SHIP_ITEM_ID, flagID: 5, stacksize: 5000, quantity: 5000 }),
    // Not planetary: never stock.
    item(1000000004, { typeID: 34, categoryID: 4, locationID: STATION_ID, stacksize: 9, quantity: 9 }),
  ]);
  snapshot.planetRuntimeState.resourcesByPlanetID = {
    [String(PLANET_A)]: {
      planetID: PLANET_A,
      resourceTypeIDs: [AQUEOUS_TYPE_ID, 2073],
      qualitiesByTypeID: { [String(AQUEOUS_TYPE_ID)]: 96, 2073: 140 },
    },
  };
  return snapshot;
}

function fakeGateway() {
  const asked = [];
  return {
    asked,
    async getSnapshot(accountID, characterID) {
      asked.push({ accountID, characterID });
      if (characterID === NOT_OURS_ID) {
        // What the gateway's validateOwnedCharacter answers for a character
        // that exists on another account.
        const error = new Error("Character does not belong to the supplied account.");
        error.code = "CHARACTER_ACCOUNT_MISMATCH";
        throw error;
      }
      if (characterID === UNREADABLE_ID) {
        const error = new Error("EveJS gateway is unreachable.");
        error.code = "EVE_GATEWAY_UNREACHABLE";
        throw error;
      }
      if (characterID === MISSING_ID) {
        return null;
      }
      if (characterID === NOT_YET_BUILT_ID) {
        return snapshotWith([]);
      }
      if (characterID === NO_TABLE_ID) {
        return { source: "evejs-web-gateway", items: [] };
      }
      if (characterID === STOCK_ID) {
        return stockSnapshot();
      }
      if (characterID === SLOW_ID) {
        await new Promise((resolve) => setTimeout(resolve, SLOW_DELAY_MS));
        return snapshotWith([colony(PLANET_A, SLOW_ID)]);
      }
      // Planet B first on the wire: the answer is ordered, not wire-ordered.
      return snapshotWith([colony(PLANET_B, characterID), colony(PLANET_A, characterID)]);
    },
  };
}

async function startTestServer(gateway) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: gateway,
    webAuth: fakeAuth(),
    staticData: {
      getStation: (id) => (id === STATION_ID ? { stationName: "Alpha I - Moon 1 - Station" } : null),
      getTypeName: (id) => `Type ${id}`,
      // Group decides a structure's kind (1063 = extractor control, 1027 = command).
      getType: (id) => ({ [ECU_TYPE_ID]: { groupID: 1063 }, [COMMAND_CENTER_TYPE_ID]: { groupID: 1027 } })[id] || null,
      getPlanetName: (id) => (id === PLANET_A ? "Alpha I" : id === PLANET_B ? "Alpha II" : null),
      getSolarSystemName: (id) => (id === SYSTEM_ID ? "Alpha" : null),
      getPlanetSchematicName: () => null,
      resolveNames: () => ({ names: {}, capped: false, limit: 500 }),
    },
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function get(baseUrl, path, { authenticated = true } = {}) {
  const headers = {};
  if (authenticated) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await fetch(`${baseUrl}${path}`, { headers });
  return { response, payload: await response.json() };
}

test.afterEach(async () => {
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  }
  await Promise.all(closing);
});

test("a pilot's colonies come back projected, named and ordered — with nobody selected", async () => {
  // The fake auth mints no bridge session and the fake gateway has no
  // callMethod: a route that wanted either would 409 or throw here.
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const { response, payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${FARMER_ID}`);
  assert.equal(response.status, 200);
  assert.equal(payload.pilots.length, 1);
  const [pilot] = payload.pilots;
  assert.equal(pilot.characterID, FARMER_ID);
  assert.equal(pilot.coloniesReadable, true);
  assert.deepEqual(pilot.colonies.map((entry) => entry.planetName), ["Alpha I", "Alpha II"]);
  const [first] = pilot.colonies;
  assert.equal(first.solarSystemName, "Alpha");
  assert.equal(first.commandCenterLevel, 4);
  // The same projection /api/bridge/planets uses: FILETIME ticks become seconds
  // and instants become epoch ms, not the raw emulator record.
  const extractor = first.pins.find((pin) => pin.pinID === 2);
  assert.equal(extractor.program.cycleTimeSeconds, 7200);
  assert.equal(typeof extractor.program.expiresAtMs, "number");
  assert.equal("ownerID" in first, false);
  // The CALLER's account, never one named in the request.
  assert.deepEqual(gateway.asked, [{ accountID: ACCOUNT.accountID, characterID: FARMER_ID }]);
});

test("a pilot who has not built is ANSWERED with no colonies, not left out", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const { payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${NOT_YET_BUILT_ID}`);
  assert.equal(payload.pilots.length, 1);
  assert.equal(payload.pilots[0].coloniesReadable, true);
  assert.deepEqual(payload.pilots[0].colonies, []);
});

test("⚠ a snapshot with no colony table says so — it is not 'no colonies'", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const { payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${NO_TABLE_ID}`);
  assert.equal(payload.pilots.length, 1);
  assert.equal(payload.pilots[0].coloniesReadable, false);
  assert.deepEqual(payload.pilots[0].colonies, []);
});

test("⚠ a pilot the read could not answer for is OMITTED, never reported empty", async () => {
  // An omitted pilot leaves the board's last reading alone; an empty one would
  // wipe a farmer's colonies off the board on one refused or failed read.
  const baseUrl = await startTestServer(fakeGateway());
  const { response, payload } = await get(
    baseUrl,
    `/api/roster/planets?characterIDs=${FARMER_ID},${UNREADABLE_ID},${NOT_OURS_ID},${MISSING_ID},${NOT_YET_BUILT_ID}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(payload.pilots.map((pilot) => pilot.characterID), [FARMER_ID, NOT_YET_BUILT_ID]);
});

test("one pilot's failure does not fail the request", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const { response, payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${UNREADABLE_ID}`);
  assert.equal(response.status, 200);
  assert.deepEqual(payload.pilots, []);
});

test("every pilot carries the instant ITS read landed, not one shared stamp", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const before = Date.now();
  const { payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${SLOW_ID},${FARMER_ID}`);
  const after = Date.now();
  const byID = new Map(payload.pilots.map((pilot) => [pilot.characterID, pilot]));
  const fast = byID.get(FARMER_ID).readAtMs;
  const slow = byID.get(SLOW_ID).readAtMs;
  for (const stamp of [fast, slow]) {
    assert.ok(stamp >= before && stamp <= after, `${stamp} lies inside the request`);
  }
  // The clock sample is a different instant: taken as the answer leaves, after
  // every read, so the browser's clock correction is not skewed by the slowest.
  assert.ok(payload.serverNowMs >= slow && payload.serverNowMs <= after);
  // Asked together, answered apart: the slow pilot's stamp is its own.
  assert.ok(slow - fast >= SLOW_DELAY_MS - 15, `slow ${slow} vs fast ${fast}`);
  // Answer order follows the request, whatever order the reads landed in.
  assert.deepEqual(payload.pilots.map((pilot) => pilot.characterID), [SLOW_ID, FARMER_ID]);
});

test("ids are cleaned up: blanks, junk and duplicates cost nothing", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const { payload } = await get(
    baseUrl,
    `/api/roster/planets?characterIDs=${FARMER_ID},,nope,-1,0,${FARMER_ID}`,
  );
  assert.equal(gateway.asked.length, 1);
  assert.equal(payload.pilots.length, 1);
});

test("no ids is an empty answer, not a gateway call", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const { response, payload } = await get(baseUrl, "/api/roster/planets");
  assert.equal(response.status, 200);
  assert.deepEqual(payload.pilots, []);
  assert.equal(gateway.asked.length, 0);
});

test("more pilots than one ask may carry is refused, and asks nothing", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const ids = Array.from({ length: 13 }, (_, index) => FARMER_ID + index).join(",");
  const { response, payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${ids}`);
  assert.equal(response.status, 400);
  assert.equal(payload.error, "TOO_MANY_CHARACTERS");
  assert.equal(gateway.asked.length, 0);
});

test("the route needs a signed-in account", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const { response, payload } = await get(
    baseUrl,
    `/api/roster/planets?characterIDs=${FARMER_ID}`,
    { authenticated: false },
  );
  assert.equal(response.status, 401);
  assert.equal(payload.error, "AUTH_REQUIRED");
  assert.equal(gateway.asked.length, 0);
});

test("a pilot's planetary stock comes back with where each unit sits — still with nobody selected", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const { payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${STOCK_ID}`);
  const [pilot] = payload.pilots;
  assert.equal(pilot.corporationID, 98000001);
  assert.deepEqual(pilot.stock, [
    {
      typeID: AQUEOUS_TYPE_ID,
      typeName: `Type ${AQUEOUS_TYPE_ID}`,
      quantity: 5000,
      locationID: STATION_ID,
      locationName: "Alpha I - Moon 1 - Station",
      holder: "ship",
      holderName: "Hauler One",
    },
    {
      typeID: WATER_TYPE_ID,
      typeName: `Type ${WATER_TYPE_ID}`,
      quantity: 400,
      locationID: STATION_ID,
      locationName: "Alpha I - Moon 1 - Station",
      holder: "hangar",
      holderName: null,
    },
  ]);
});

test("a pilot with nothing planetary answers an empty stock, not a missing one", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const { payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${NOT_YET_BUILT_ID}`);
  assert.deepEqual(payload.pilots[0].stock, []);
  // The snapshot named no corporation: null, never 0.
  assert.equal(payload.pilots[0].corporationID, null);
});

test("a colony carries its planet's resources and their quality, as the server states them", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const { payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${STOCK_ID}`);
  const [colonyA] = payload.pilots[0].colonies;
  assert.deepEqual(colonyA.resources, [
    { typeID: AQUEOUS_TYPE_ID, typeName: `Type ${AQUEOUS_TYPE_ID}`, quality: 96 },
    { typeID: 2073, typeName: "Type 2073", quality: 140 },
  ]);
});

test("⚠ a planet with no resource record is null — unknown, not 'carries nothing'", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const { payload } = await get(baseUrl, `/api/roster/planets?characterIDs=${FARMER_ID}`);
  assert.equal(payload.pilots[0].colonies[0].resources, null);
});
