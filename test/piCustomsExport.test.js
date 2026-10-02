"use strict";

// The customs-office export hop: POST /api/pi/customs-export and the module
// under it (src/piCustomsExport.js), which speaks the GAME PORT because the web
// gateway's allowlist does not carry invbroker.ImportExportWithPlanet.
//
// What these pin:
//   • the hop opens NO connection when the ticked launchpads are empty — so a
//     second Haul click does not log the pilot out for nothing;
//   • the office is READ from the system's own item list (map.GetSolarsystemItems,
//     group 1025, the row's orbitID naming its planet), never computed from the
//     planet id: a planet with an anchored POCO has a real item id and the
//     synthesized InterBus id addresses nothing there;
//   • the tax is read per office and sent back verbatim, because the server
//     compares the two to the sixth decimal (TaxChanged);
//   • ONE planet's refusal does not stop the next — a pad a route drained
//     between the snapshot and the call is an ordinary race;
//   • the connection is closed even when the hop throws, because a connection
//     left open keeps the character logged in on it;
//   • the route refuses a pilot a bot or another tab is flying, and hands the
//     CALLER's own pilot back the moment the hop is done.
//
// ⚠ NO REAL IDS. The character is ESI's own documented example id and the
// planets/systems are the fixture ids every other PI test here uses.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");
const {
  listItems,
  rowsetRows,
  officesByPlanetID,
  planCustomsExports,
  unitsOf,
  runCustomsExport,
} = require("../src/piCustomsExport");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
// ESI's own documented example id — deliberately synthetic, never a real pilot.
const FARMER_ID = 90000001;
const OTHER_ID = 90000002;

const PLANET_A = 40000002;
const PLANET_B = 40000004;
const PLANET_NO_COLONY = 40000006;
const SYSTEM_ID = 30000001;
const OFFICE_A = 1_200_000_000_000 + PLANET_A;
// Planet B carries an anchored POCO, so its office is a real item id that bears
// no relation to the planet id — the case a computed id would get wrong.
const OFFICE_B = 1021000000042;
const LAUNCHPAD_TYPE_ID = 2524;
const COMMAND_CENTER_TYPE_ID = 2254;
const WATER_TYPE_ID = 3645;
const AQUEOUS_TYPE_ID = 2268;
const TAX_RATE = 0.05;
const GROUP_CUSTOMS_OFFICES = 1025;
const GROUP_PLANET = 7;

const activeServers = new Set();

// ── the colonies, as coloniesFromSnapshot projects them ─────────────────────

function pin(pinID, kind, contents) {
  return {
    pinID,
    kind,
    typeID: kind === "launchpad" ? LAUNCHPAD_TYPE_ID : COMMAND_CENTER_TYPE_ID,
    contents: Object.entries(contents).map(([typeID, quantity]) => ({
      typeID: Number(typeID),
      typeName: `Type ${typeID}`,
      quantity,
    })),
  };
}

function projectedColony(planetID, planetName, pins) {
  return { planetID, planetName, solarSystemID: SYSTEM_ID, solarSystemName: "Alpha", pins };
}

const COLONIES = [
  projectedColony(PLANET_A, "Alpha I", [
    // A command centre holding something is NOT exported: the server takes only
    // a spaceport pin here.
    pin(1, "command", { [WATER_TYPE_ID]: 11 }),
    pin(5, "launchpad", { [WATER_TYPE_ID]: 300, [AQUEOUS_TYPE_ID]: 70 }),
    pin(6, "launchpad", {}),
  ]),
  projectedColony(PLANET_B, "Alpha II", [pin(9, "launchpad", { [WATER_TYPE_ID]: 42 })]),
];

// ── the wire shapes the game port answers with ──────────────────────────────

const list = (items) => ({ type: "list", items });
const dict = (entries) => ({ type: "dict", entries });

/** A Rowset exactly as the server's buildRowset sends one. */
function rowset(columns, lines) {
  return {
    type: "object",
    name: "eve.common.script.sys.rowset.Rowset",
    args: dict([
      ["header", list(columns)],
      ["columns", list(columns)],
      ["RowClass", { type: "token", value: "util.Row" }],
      ["lines", list(lines)],
    ]),
  };
}

const SOLARSYSTEM_COLUMNS = [
  "groupID", "typeID", "itemID", "itemName", "locationID",
  "orbitID", "connector", "x", "y", "z", "celestialIndex", "orbitIndex",
];

function solarSystemItems() {
  const row = (groupID, itemID, itemName, orbitID) =>
    [groupID, 2233, itemID, itemName, SYSTEM_ID, orbitID, false, 0, 0, 0, null, null];
  return rowset(SOLARSYSTEM_COLUMNS, [
    // The planets themselves come through the same rows; only group 1025 is an
    // office, so a planet row must never be mistaken for one.
    [GROUP_PLANET, 11, PLANET_A, "Alpha I", SYSTEM_ID, SYSTEM_ID, false, 0, 0, 0, 1, null],
    row(GROUP_CUSTOMS_OFFICES, OFFICE_A, "Customs Office (Alpha I)", PLANET_A),
    row(GROUP_CUSTOMS_OFFICES, OFFICE_B, "Customs Office (Alpha II)", PLANET_B),
  ]);
}

/** A game client that records what was asked of it and answers as the server does. */
function fakeClient({ refuse = null, failLogin = false } = {}) {
  const calls = [];
  return {
    calls,
    closed: false,
    async login(accountName) {
      calls.push(["login", accountName]);
      if (failLogin) throw new Error("The game server refused the login.");
    },
    async call(service, method, args) {
      calls.push([`${service}.${method}`, args]);
      if (service === "map" && method === "GetSolarsystemItems") return solarSystemItems();
      if (service === "planetOrbitalRegistryBroker" && method === "GetTaxRate") return TAX_RATE;
      return null;
    },
    async bind(service, bindParams) {
      calls.push([`${service}.MachoBindObject`, bindParams]);
      return `N=${bindParams[0]}`;
    },
    async callBound(objectID, method, args) {
      calls.push([`bound ${objectID}.${method}`, args]);
      if (refuse !== null && refuse(objectID, args)) {
        throw new Error("ImportExportWithPlanet was refused by the server: CannotLaunchCommoditiesNotFound");
      }
      return null;
    },
    close() {
      this.closed = true;
    },
  };
}

// ── the pure half ───────────────────────────────────────────────────────────

test("the plan takes every launchpad that holds something, and nothing else", () => {
  const plan = planCustomsExports(COLONIES, [PLANET_A, PLANET_B, PLANET_NO_COLONY]);
  assert.deepEqual(plan.map((entry) => entry.planetID), [PLANET_A, PLANET_B, PLANET_NO_COLONY]);
  // Pad 5 only: pad 6 is empty and pin 1 is a command centre.
  assert.deepEqual(plan[0].pads, [{ pinID: 5, commodities: { [WATER_TYPE_ID]: 300, [AQUEOUS_TYPE_ID]: 70 } }]);
  assert.equal(unitsOf(plan[0]), 370);
  assert.deepEqual(plan[1].pads, [{ pinID: 9, commodities: { [WATER_TYPE_ID]: 42 } }]);
  // A planet with no colony is SAID, not silently dropped.
  assert.deepEqual(plan[2].pads, []);
  assert.equal(plan[2].reason, "no-colony");
});

test("a colony whose launchpads are all empty says so rather than planning a call", () => {
  const empty = [projectedColony(PLANET_A, "Alpha I", [pin(5, "launchpad", {})])];
  const [entry] = planCustomsExports(empty, [PLANET_A]);
  assert.deepEqual(entry.pads, []);
  assert.equal(entry.reason, "nothing-on-the-pads");
});

test("the office is read off the system's items by group and orbited planet", () => {
  const offices = officesByPlanetID(rowsetRows(solarSystemItems()));
  assert.equal(offices.get(PLANET_A), OFFICE_A);
  // The anchored POCO's real id, which no arithmetic on the planet id yields.
  assert.equal(offices.get(PLANET_B), OFFICE_B);
  assert.equal(offices.has(SYSTEM_ID), false);
  assert.equal(offices.size, 2);
});

test("a rowset with no columns, and a tuple list, decode without throwing", () => {
  assert.deepEqual(rowsetRows(null), []);
  assert.deepEqual(rowsetRows(rowset([], [])), []);
  // Marshal decodes a tuple to a bare array and a list to {type:"list"}; both
  // are rows the same way.
  assert.deepEqual(listItems([1, 2]), [1, 2]);
  assert.deepEqual(listItems(list([3])), [3]);
  assert.deepEqual(listItems("nope"), []);
});

// ── the hop ─────────────────────────────────────────────────────────────────

test("nothing on the pads means NO game connection at all", async () => {
  let created = 0;
  const outcome = await runCustomsExport({
    accountName: ACCOUNT.username,
    characterID: FARMER_ID,
    colonies: [projectedColony(PLANET_A, "Alpha I", [pin(5, "launchpad", {})])],
    planetIDs: [PLANET_A],
    createClient: () => { created += 1; return fakeClient(); },
    settleMs: 0,
  });
  assert.equal(created, 0);
  assert.equal(outcome.connected, false);
  assert.deepEqual(outcome.results.map((entry) => entry.exported), [false]);
  assert.equal(outcome.results[0].reason, "nothing-on-the-pads");
});

test("the hop logs in, selects, resolves the office, reads the tax and exports the pad", async () => {
  const client = fakeClient();
  const outcome = await runCustomsExport({
    accountName: ACCOUNT.username,
    characterID: FARMER_ID,
    colonies: COLONIES,
    planetIDs: [PLANET_A, PLANET_B],
    createClient: () => client,
    settleMs: 0,
  });
  assert.equal(outcome.connected, true);
  assert.deepEqual(outcome.results.map((entry) => entry.exported), [true, true]);
  assert.deepEqual(outcome.results.map((entry) => entry.officeID), [OFFICE_A, OFFICE_B]);
  assert.deepEqual(outcome.results.map((entry) => entry.units), [370, 42]);
  assert.equal(client.closed, true);

  const names = client.calls.map(([name]) => name);
  assert.deepEqual(names.slice(0, 4), [
    "login",
    "charUnboundMgr.SelectCharacterID",
    "map.GetSolarsystemItems",
    "planetOrbitalRegistryBroker.GetTaxRate",
  ]);
  // ONE system read for two colonies in it.
  assert.equal(names.filter((name) => name === "map.GetSolarsystemItems").length, 1);
  // The export: (spaceportPinID, import, export, taxRate). The import dict stays
  // empty — this hop only ever sends goods UP — and the tax goes back verbatim.
  const [, exportArgs] = client.calls.find(([name]) => name === `bound N=${OFFICE_A}.ImportExportWithPlanet`);
  assert.equal(exportArgs[0], 5);
  assert.deepEqual(exportArgs[1], { type: "dict", entries: [] });
  assert.deepEqual(exportArgs[2], {
    type: "dict",
    entries: [[AQUEOUS_TYPE_ID, 70], [WATER_TYPE_ID, 300]],
  });
  assert.equal(exportArgs[3], TAX_RATE);
});

test("⚠ one planet's refusal does not stop the next, and carries the server's words", async () => {
  const client = fakeClient({ refuse: (objectID) => objectID === `N=${OFFICE_A}` });
  const outcome = await runCustomsExport({
    accountName: ACCOUNT.username,
    characterID: FARMER_ID,
    colonies: COLONIES,
    planetIDs: [PLANET_A, PLANET_B],
    createClient: () => client,
    settleMs: 0,
  });
  assert.deepEqual(outcome.results.map((entry) => entry.exported), [false, true]);
  assert.equal(outcome.results[0].reason, "refused");
  assert.match(outcome.results[0].message, /CannotLaunchCommoditiesNotFound/);
  assert.equal(outcome.results[1].units, 42);
});

test("a planet with no office in its system is said, not guessed at", async () => {
  const client = fakeClient();
  const colonies = [projectedColony(PLANET_NO_COLONY, "Alpha III", [pin(7, "launchpad", { [WATER_TYPE_ID]: 5 })])];
  const outcome = await runCustomsExport({
    accountName: ACCOUNT.username,
    characterID: FARMER_ID,
    colonies,
    planetIDs: [PLANET_NO_COLONY],
    createClient: () => client,
    settleMs: 0,
  });
  assert.equal(outcome.results[0].reason, "no-office");
  assert.equal(outcome.results[0].exported, false);
  assert.equal(client.calls.some(([name]) => name.includes("ImportExportWithPlanet")), false);
});

test("⚠ the connection is closed even when the login fails", async () => {
  const client = fakeClient({ failLogin: true });
  await assert.rejects(
    runCustomsExport({
      accountName: ACCOUNT.username,
      characterID: FARMER_ID,
      colonies: COLONIES,
      planetIDs: [PLANET_A],
      createClient: () => client,
      settleMs: 0,
    }),
    /refused the login/,
  );
  assert.equal(client.closed, true);
});

// ── the route ───────────────────────────────────────────────────────────────

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
    async getCharacterForAccount(accountID, characterID) {
      return accountID === ACCOUNT.accountID && (characterID === FARMER_ID || characterID === OTHER_ID)
        ? { characterID, characterName: `Pilot ${characterID}` }
        : null;
    },
  };
}

/** The snapshot the colonies are read out of — the roster-planets shape. */
function snapshotColony(planetID, ownerID, pins) {
  return {
    planetID,
    ownerID,
    solarSystemID: SYSTEM_ID,
    planetTypeID: 11,
    typeID: 11,
    level: 4,
    currentSimTime: "134345346293950000",
    pins,
    links: [],
    routes: [],
  };
}

function fakeGateway({ colonies = null } = {}) {
  const asked = [];
  const selected = [];
  const released = [];
  return {
    asked,
    selected,
    released,
    async getSnapshot(accountID, characterID) {
      asked.push({ accountID, characterID });
      const coloniesByKey = {};
      for (const entry of colonies ?? [
        snapshotColony(PLANET_A, characterID, [
          { pinID: 1, typeID: COMMAND_CENTER_TYPE_ID, contents: { [WATER_TYPE_ID]: 11 } },
          { pinID: 5, typeID: LAUNCHPAD_TYPE_ID, contents: { [WATER_TYPE_ID]: 300 } },
        ]),
      ]) {
        coloniesByKey[`${entry.planetID}:${entry.ownerID}`] = entry;
      }
      return {
        source: "evejs-web-gateway",
        items: [],
        characters: { [String(characterID)]: { corporationID: 98000001 } },
        planetRuntimeState: { schemaVersion: 1, coloniesByKey, launchesByID: {} },
      };
    },
    async selectCharacter(args, kwargs, session) {
      selected.push({ characterID: args[0], userid: session.userid });
      return {
        bridgeSessionID: "bridge-after-handback",
        session: {
          characterID: args[0],
          corporationID: 98000001,
          stationID: 60000004,
          solarSystemID: SYSTEM_ID,
          shipID: 1000000100,
        },
      };
    },
    async releaseBridgeSession(bridgeSessionID) {
      released.push(bridgeSessionID);
      return { released: true };
    },
    async readFlightStatus() {
      // Only ever reached by isCharacterHeld, for a session this test planted.
      return { flight: { docked: true } };
    },
  };
}

async function startTestServer({ gateway, client, botHost, bridgeSessionStore } = {}) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: gateway,
    webAuth: fakeAuth(),
    botHost: botHost ?? { claimedBy: () => null, authorizesClaim: () => false },
    bridgeSessionStore,
    gameClientFactory: () => client,
    staticData: {
      getStation: () => null,
      getTypeName: (id) => `Type ${id}`,
      getType: (id) => ({ [LAUNCHPAD_TYPE_ID]: { groupID: 1030, capacity: 10000 }, [COMMAND_CENTER_TYPE_ID]: { groupID: 1027, capacity: 500 } })[id] || null,
      getPlanetName: (id) => (id === PLANET_A ? "Alpha I" : id === PLANET_B ? "Alpha II" : null),
      getSolarSystemName: () => "Alpha",
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

async function post(baseUrl, path, body, { authenticated = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (authenticated) headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
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

test("the route exports the ticked colonies and answers per planet", async () => {
  const client = fakeClient();
  const gateway = fakeGateway();
  const baseUrl = await startTestServer({ gateway, client });
  const { response, payload } = await post(baseUrl, "/api/pi/customs-export", {
    confirm: true,
    characterID: FARMER_ID,
    planetIDs: [PLANET_A],
  });
  assert.equal(response.status, 200);
  assert.equal(payload.connected, true);
  assert.deepEqual(payload.planets, [{
    planetID: PLANET_A,
    planetName: "Alpha I",
    solarSystemID: SYSTEM_ID,
    solarSystemName: "Alpha",
    officeID: OFFICE_A,
    exported: true,
    units: 300,
    reason: null,
    message: null,
  }]);
  // The CALLER's account, and nobody was selected through the gateway: this
  // pilot was not the tab's, so there is nothing to hand back.
  assert.deepEqual(gateway.asked, [{ accountID: ACCOUNT.accountID, characterID: FARMER_ID }]);
  assert.deepEqual(gateway.selected, []);
  assert.equal(payload.handedBack, null);
});

test("the caller's OWN pilot is handed straight back to the tab", async () => {
  const client = fakeClient();
  const gateway = fakeGateway();
  // The tab holds this pilot on its own web session ("sid", what fakeAuth mints),
  // which is the one case this route evicts — and the one it undoes.
  const bridgeSessionStore = new Map([["sid", {
    bridgeSessionID: "bridge-before",
    characterID: FARMER_ID,
    accountID: ACCOUNT.accountID,
    boundHandles: new Map(),
    streamSubscribers: new Set(),
  }]]);
  const baseUrl = await startTestServer({ gateway, client, bridgeSessionStore });
  const { response, payload } = await post(baseUrl, "/api/pi/customs-export", {
    confirm: true,
    characterID: FARMER_ID,
    planetIDs: [PLANET_A],
  });
  assert.equal(response.status, 200);
  assert.equal(payload.planets[0].exported, true);
  assert.equal(payload.handedBack, true);
  // Re-selected on the SAME web session, for the SAME pilot, on the caller's account.
  assert.deepEqual(gateway.selected, [{ characterID: FARMER_ID, userid: ACCOUNT.accountID }]);
  assert.equal(bridgeSessionStore.get("sid").bridgeSessionID, "bridge-after-handback");
  // Let go first, then take it back: the game port is about to hold this
  // character and one session may.
  assert.deepEqual(gateway.released, ["bridge-before"]);
});

test("⚠ a read landing mid-hop is told to wait, NOT that the pilot is gone", async () => {
  // NO_LIVE_SESSION and SESSION_NOT_FOUND both mean "lost" to the browser,
  // which prunes the cockpit. A pilot coming straight back must not say either.
  const bridgeSessionStore = new Map([["sid", {
    bridgeSessionID: "bridge-before",
    characterID: FARMER_ID,
    accountID: ACCOUNT.accountID,
    boundHandles: new Map(),
    streamSubscribers: new Set(),
  }]]);
  let duringHop = null;
  const client = fakeClient();
  const slow = {
    ...client,
    async call(service, method, args) {
      if (service === "charUnboundMgr") {
        duringHop = await fetch(`${baseUrl}/api/bridge/space/snapshot`, {
          headers: { cookie: `evejs_web_poc=${COOKIE_TOKEN}` },
        }).then(async (response) => ({ status: response.status, payload: await response.json() }));
      }
      return client.call(service, method, args);
    },
  };
  const baseUrl = await startTestServer({ gateway: fakeGateway(), client: slow, bridgeSessionStore });
  const { payload } = await post(baseUrl, "/api/pi/customs-export", {
    confirm: true,
    characterID: FARMER_ID,
    planetIDs: [PLANET_A],
  });
  assert.equal(payload.handedBack, true);
  assert.equal(duringHop.status, 409);
  assert.equal(duringHop.payload.error, "CHARACTER_IN_USE");
});

test("⚠ without confirm the route moves nothing", async () => {
  const client = fakeClient();
  const baseUrl = await startTestServer({ gateway: fakeGateway(), client });
  const { response, payload } = await post(baseUrl, "/api/pi/customs-export", {
    characterID: FARMER_ID,
    planetIDs: [PLANET_A],
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "CONFIRMATION_REQUIRED");
  assert.deepEqual(client.calls, []);
});

test("⚠ a pilot a server bot is flying is refused, and nothing is sent", async () => {
  const client = fakeClient();
  const baseUrl = await startTestServer({
    gateway: fakeGateway(),
    client,
    botHost: { claimedBy: () => "bot-1", authorizesClaim: () => false },
  });
  const { response, payload } = await post(baseUrl, "/api/pi/customs-export", {
    confirm: true,
    characterID: FARMER_ID,
    planetIDs: [PLANET_A],
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "CHARACTER_IN_USE_BY_BOT");
  assert.deepEqual(client.calls, []);
});

test("⚠ a pilot another tab is flying is refused, and nothing is sent", async () => {
  const client = fakeClient();
  // A held session for the same character on a DIFFERENT web session is what
  // isCharacterHeld answers true for.
  const bridgeSessionStore = new Map([["another-tab", {
    bridgeSessionID: "bridge-other",
    characterID: FARMER_ID,
    accountID: ACCOUNT.accountID,
    boundHandles: new Map(),
    streamSubscribers: new Set(),
  }]]);
  const baseUrl = await startTestServer({ gateway: fakeGateway(), client, bridgeSessionStore });
  const { response, payload } = await post(baseUrl, "/api/pi/customs-export", {
    confirm: true,
    characterID: FARMER_ID,
    planetIDs: [PLANET_A],
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "CHARACTER_IN_USE");
  assert.deepEqual(client.calls, []);
});

test("⚠ a pilot with nothing to send is never logged out at all", async () => {
  // The hop is what costs a session. A Haul that has nothing to launch must not
  // blink the tab's pilot out and back for nothing -- which is exactly what the
  // first live run did.
  const client = fakeClient();
  const gateway = fakeGateway({
    colonies: [snapshotColony(PLANET_A, FARMER_ID, [{ pinID: 5, typeID: LAUNCHPAD_TYPE_ID, contents: {} }])],
  });
  const bridgeSessionStore = new Map([["sid", {
    bridgeSessionID: "bridge-before",
    characterID: FARMER_ID,
    accountID: ACCOUNT.accountID,
    boundHandles: new Map(),
    streamSubscribers: new Set(),
  }]]);
  const baseUrl = await startTestServer({ gateway, client, bridgeSessionStore });
  const { payload } = await post(baseUrl, "/api/pi/customs-export", {
    confirm: true,
    characterID: FARMER_ID,
    planetIDs: [PLANET_A],
  });
  assert.equal(payload.connected, false);
  assert.equal(payload.handedBack, null);
  assert.deepEqual(gateway.released, []);
  assert.deepEqual(gateway.selected, []);
  // The session the tab held is untouched.
  assert.equal(bridgeSessionStore.get("sid").bridgeSessionID, "bridge-before");
});

test("a pilot with nothing on its pads is answered without a connection", async () => {
  const client = fakeClient();
  const gateway = fakeGateway({
    colonies: [snapshotColony(PLANET_A, FARMER_ID, [{ pinID: 5, typeID: LAUNCHPAD_TYPE_ID, contents: {} }])],
  });
  const baseUrl = await startTestServer({ gateway, client });
  const { payload } = await post(baseUrl, "/api/pi/customs-export", {
    confirm: true,
    characterID: FARMER_ID,
    planetIDs: [PLANET_A],
  });
  assert.equal(payload.connected, false);
  assert.equal(payload.planets[0].reason, "nothing-on-the-pads");
  assert.deepEqual(client.calls, []);
});

test("a pilot the account does not own is refused", async () => {
  const baseUrl = await startTestServer({ gateway: fakeGateway(), client: fakeClient() });
  const { response, payload } = await post(baseUrl, "/api/pi/customs-export", {
    confirm: true,
    characterID: 90009999,
    planetIDs: [PLANET_A],
  });
  assert.equal(response.status, 404);
  assert.equal(payload.error, "CHARACTER_NOT_FOUND");
});

test("the route is bounded and signed-in only", async () => {
  const baseUrl = await startTestServer({ gateway: fakeGateway(), client: fakeClient() });
  const anonymous = await post(baseUrl, "/api/pi/customs-export",
    { confirm: true, characterID: FARMER_ID, planetIDs: [PLANET_A] }, { authenticated: false });
  assert.equal(anonymous.response.status, 401);
  const tooMany = await post(baseUrl, "/api/pi/customs-export", {
    confirm: true,
    characterID: FARMER_ID,
    planetIDs: Array.from({ length: 25 }, (_, index) => PLANET_A + index * 2),
  });
  assert.equal(tooMany.response.status, 400);
  assert.equal(tooMany.payload.error, "TOO_MANY_PLANETS");
  const noPlanets = await post(baseUrl, "/api/pi/customs-export", { confirm: true, characterID: FARMER_ID, planetIDs: [] });
  assert.equal(noPlanets.response.status, 400);
  assert.equal(noPlanets.payload.error, "INVALID_REQUEST");
});
