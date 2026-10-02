"use strict";

// Character CREATION at the BFF: the picker read and the confirm-gated write.
//
// The thing this suite exists to hold down is that BOTH routes work with NO
// CHARACTER ONLINE. Creation necessarily precedes selection, and on a fresh
// account there is nothing to select at all — a held-session gate on these two
// is not a safety rail, it is a locked door with the key inside. Every other
// write route in server.js goes through requireHeldBridgeSession and SHOULD;
// these two go through accountLevelCall instead, and the first two tests below
// fail the moment someone "fixes" that back.
//
// The second thing it holds down is that the browser does not compose the retail
// tuple. The route takes named fields, validates the bloodline against the
// world's OWN tables (charUnboundMgr.GetCharCreationInfo — the authority, since
// CreateCharacterWithDoll derives race / corp / station / rookie ship from the
// bloodline) and the ancestry against the SDE, then builds the 7-arg legacy
// signature itself with hard-null doll payloads.
//
// The GetCharCreationInfo fixture is the shape charService.Handle_GetCharCreation
// Info builds (buildKeyVal rows inside a {type:"dict"}), carrying this world's
// REAL race and bloodline rows; the ancestry rows are the real SDE bloodline
// groupings. No character was created against the live world by this suite.

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
const NEW_CHARACTER_ID = 140000042;

// This world's real characterCreationRaces / characterCreationBloodlines rows.
const RACES = [
  { raceID: 1, raceName: "Caldari", shipTypeID: 601, shipName: "Ibis" },
  { raceID: 2, raceName: "Minmatar", shipTypeID: 588, shipName: "Reaper" },
  { raceID: 4, raceName: "Amarr", shipTypeID: 596, shipName: "Impairor" },
  { raceID: 8, raceName: "Gallente", shipTypeID: 606, shipName: "Velator" },
];
const BLOODLINES = [
  { bloodlineID: 1, bloodlineName: "Deteis", raceID: 1, corporationID: 1000006 },
  { bloodlineID: 2, bloodlineName: "Civire", raceID: 1, corporationID: 1000009 },
  { bloodlineID: 11, bloodlineName: "Achura", raceID: 1, corporationID: 1000014 },
  { bloodlineID: 3, bloodlineName: "Sebiestor", raceID: 2, corporationID: 1000046 },
  { bloodlineID: 4, bloodlineName: "Brutor", raceID: 2, corporationID: 1000049 },
  { bloodlineID: 14, bloodlineName: "Vherokior", raceID: 2, corporationID: 1000060 },
  { bloodlineID: 5, bloodlineName: "Amarr", raceID: 4, corporationID: 1000066 },
  { bloodlineID: 7, bloodlineName: "Gallente", raceID: 8, corporationID: 1000107 },
];
// The real SDE bloodline groupings (three ancestries per bloodline).
const ANCESTRIES = [
  { ancestryID: 10, bloodlineID: 1, name: "Merchandisers" },
  { ancestryID: 11, bloodlineID: 1, name: "Scientists" },
  { ancestryID: 12, bloodlineID: 1, name: "Tube Child" },
  { ancestryID: 7, bloodlineID: 2, name: "Entrepreneurs" },
  { ancestryID: 8, bloodlineID: 2, name: "Mercs" },
  { ancestryID: 9, bloodlineID: 2, name: "Dissenters" },
  { ancestryID: 31, bloodlineID: 11, name: "Inventors" },
  { ancestryID: 32, bloodlineID: 11, name: "Monks" },
  { ancestryID: 33, bloodlineID: 11, name: "Stargazers" },
  { ancestryID: 19, bloodlineID: 3, name: "Rebels" },
  { ancestryID: 1, bloodlineID: 5, name: "Liberal Holders" },
  { ancestryID: 13, bloodlineID: 7, name: "Activists" },
  // A bloodline this world does NOT have (Jove) — the SDE carries it, the
  // route must never roll it, and the browser filters it out of the picker.
  { ancestryID: 25, bloodlineID: 9, name: "Rogue Drone Hunters" },
];
const CALDARI_BLOODLINE_IDS = new Set([1, 2, 11]);
const CALDARI_ANCESTRY_IDS = new Set([10, 11, 12, 7, 8, 9, 31, 32, 33]);

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

function keyVal(entries) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

// The shape Handle_GetCharCreationInfo builds: a {type:"dict"} of two
// {type:"list"}s of util.KeyVal rows.
function creationInfoResult() {
  return {
    type: "dict",
    entries: [
      [
        "races",
        {
          type: "list",
          items: RACES.map((race) =>
            keyVal([
              ["raceID", race.raceID],
              ["raceName", race.raceName],
              ["shipTypeID", race.shipTypeID],
              ["shipName", race.shipName],
            ]),
          ),
        },
      ],
      [
        "bloodlines",
        {
          type: "list",
          items: BLOODLINES.map((bloodline) =>
            keyVal([
              ["bloodlineID", bloodline.bloodlineID],
              ["bloodlineName", bloodline.bloodlineName],
              ["raceID", bloodline.raceID],
              ["corporationID", bloodline.corporationID],
            ]),
          ),
        },
      ],
    ],
  };
}

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
    listAncestries() {
      return ANCESTRIES.map((row) => ({ ...row }));
    },
  };
}

function fakeGateway() {
  const calls = { callMethod: [] };
  const created = [];
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
          corporationID: CORPORATION_ID,
          shipID: 9001,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: CHARACTER_ID };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.callMethod.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      if (method === "GetCharCreationInfo") {
        return { service, method, result: creationInfoResult(), notifications: [] };
      }
      if (method === "ValidateNameEx") {
        return { service, method, result: 1, notifications: [] };
      }
      if (method === "GetCharacterSelectionData") {
        return { service, method, result: [
          { type: "list", items: [keyVal([["userName", ACCOUNT.username], ["characterSlots", 3]])] },
          null,
          { type: "list", items: created.map((row) => keyVal([
            ["characterID", row.characterID], ["characterName", row.name],
          ])) },
        ], notifications: [] };
      }
      if (method === "CreateCharacterWithDoll") {
        created.push({ characterID: NEW_CHARACTER_ID, name: args[0] });
        return { service, method, result: NEW_CHARACTER_ID, notifications: [] };
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
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: CHARACTER_ID } });
}

function createCalls(gateway) {
  return gateway.calls.callMethod.filter((call) => call.method === "CreateCharacterWithDoll");
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

// --- the two routes must work with NO character online ------------------------

test("the picker read answers with NO character selected, on a userid-only session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // Deliberately NO select: this is the screen a fresh account lands on.
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/char-creation-info");

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  const [call] = gateway.calls.callMethod;
  assert.equal(call.method, "GetCharCreationInfo");
  assert.equal(call.bridgeSessionID, undefined, "no held session means no bridgeSessionID");
  assert.deepEqual(call.sessionFields, { userid: ACCOUNT.accountID });
  // The retail dict ships out raw; ancestries ride alongside from the SDE.
  assert.deepEqual(payload.creationInfo, creationInfoResult());
  assert.equal(payload.ancestries.length, ANCESTRIES.length);
});

test("a character can be created with NO character selected", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "Zaphod Beeblebrox", raceID: 1, genderID: 1, bloodlineID: 2, ancestryID: 8, confirm: true },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, true);
  assert.equal(payload.characterID, NEW_CHARACTER_ID);
  const [call] = createCalls(gateway);
  assert.equal(call.bridgeSessionID, undefined, "creation must not need a held session");
  assert.deepEqual(call.sessionFields, { userid: ACCOUNT.accountID });
});

// --- the confirm gate ---------------------------------------------------------

test("⚠ create REFUSES without confirm — nothing dispatches at all", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "Zaphod Beeblebrox", raceID: 1, genderID: 1 },
  });

  assert.equal(response.status, 400);
  assert.equal(payload.error, "CONFIRMATION_REQUIRED");
  assert.equal(gateway.calls.callMethod.length, 0, "a refused create must not even read the tables");
});

// --- the tuple the BFF builds -------------------------------------------------

test("a confirmed create forwards the 7-arg legacy tuple with hard-null doll payloads", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "Zaphod Beeblebrox", raceID: 1, genderID: 0, bloodlineID: 11, ancestryID: 32, confirm: true },
  });

  const [call] = createCalls(gateway);
  assert.equal(call.service, "charUnboundMgr");
  // (name, bloodlineID, genderID, ancestryID, charInfo, portraitInfo, schoolID).
  // SEVEN args: the 8-arg container signatures are only recognised when BOTH
  // doll payloads are present, so an 8th raceID element would never be read.
  assert.deepEqual(call.args, ["Zaphod Beeblebrox", 11, 0, 32, null, null, 0]);
});

test("the name is trimmed and inner runs of whitespace collapse, as the handler would", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "  Zaphod   Beeblebrox  ", raceID: 1, genderID: 1, confirm: true },
  });

  assert.equal(createCalls(gateway)[0].args[0], "Zaphod Beeblebrox");
});

test("gender 0 (female) survives — it is a real choice, not an absent field", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "Zaphod Beeblebrox", raceID: 1, genderID: 0, confirm: true },
  });

  assert.equal(createCalls(gateway)[0].args[2], 0);
});

// --- validation against the world's own tables --------------------------------

test("a bloodline from ANOTHER race is refused, not quietly corrected", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    // 5 = Amarr bloodline, asked for on a Caldari character.
    body: { name: "Zaphod Beeblebrox", raceID: 1, genderID: 1, bloodlineID: 5, confirm: true },
  });

  assert.equal(response.status, 400);
  assert.equal(payload.error, "BLOODLINE_INVALID");
  assert.equal(createCalls(gateway).length, 0, "an invalid bloodline must not create anything");
});

test("an ancestry from another bloodline is refused", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    // 10 is a Deteis ancestry; the bloodline asked for is Civire.
    body: { name: "Zaphod Beeblebrox", raceID: 1, genderID: 1, bloodlineID: 2, ancestryID: 10, confirm: true },
  });

  assert.equal(response.status, 400);
  assert.equal(payload.error, "ANCESTRY_INVALID");
  assert.equal(createCalls(gateway).length, 0);
});

test("a race the world does not have is refused", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "Zaphod Beeblebrox", raceID: 16, genderID: 1, confirm: true },
  });

  assert.equal(response.status, 400);
  assert.equal(payload.error, "RACE_UNKNOWN");
  assert.equal(createCalls(gateway).length, 0);
});

test("name and race are required before anything is read or written", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });

  const missingName = await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "   ", raceID: 1, genderID: 1, confirm: true },
  });
  assert.equal(missingName.response.status, 400);
  assert.equal(missingName.payload.error, "NAME_REQUIRED");

  const missingRace = await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "Zaphod Beeblebrox", genderID: 1, confirm: true },
  });
  assert.equal(missingRace.response.status, 400);
  // An ABSENT race is a different answer from a race that does not exist: the
  // first is the screen not having asked yet, the second is a bad id.
  assert.equal(missingRace.payload.error, "RACE_REQUIRED");

  assert.equal(gateway.calls.callMethod.length, 0, "neither refusal needed the tables read at all");
});

// --- what "everything else is random" actually rolls --------------------------

test("an omitted bloodline and ancestry are rolled WITHIN the chosen race", async () => {
  // Every roll, every time: the loop is what makes a bad roll visible rather
  // than a 1-in-3 flake.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const gateway = fakeGateway();
    const { baseUrl } = await startTestServer({ gateway });
    const { payload } = await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
      method: "POST",
      body: { name: "Zaphod Beeblebrox", raceID: 1, genderID: 1, confirm: true },
    });

    const [call] = createCalls(gateway);
    const [, bloodlineID, , ancestryID] = call.args;
    assert.ok(CALDARI_BLOODLINE_IDS.has(bloodlineID), `rolled bloodline ${bloodlineID} is Caldari`);
    assert.ok(CALDARI_ANCESTRY_IDS.has(ancestryID), `rolled ancestry ${ancestryID} is Caldari`);
    // The ancestry must belong to the bloodline that was actually rolled, not
    // merely to the race — this is the pairing the retail chain implies.
    const rolled = ANCESTRIES.find((row) => row.ancestryID === ancestryID);
    assert.equal(rolled.bloodlineID, bloodlineID, "the rolled ancestry belongs to the rolled bloodline");
    // The response says what it rolled, so the screen can report it.
    assert.equal(payload.bloodlineID, bloodlineID);
    assert.equal(payload.ancestryID, ancestryID);
  }
});

test("an omitted ancestry is rolled within an EXPLICIT bloodline", async () => {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const gateway = fakeGateway();
    const { baseUrl } = await startTestServer({ gateway });
    await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
      method: "POST",
      body: { name: "Zaphod Beeblebrox", raceID: 1, genderID: 1, bloodlineID: 11, confirm: true },
    });

    const [, bloodlineID, , ancestryID] = createCalls(gateway)[0].args;
    assert.equal(bloodlineID, 11);
    assert.ok([31, 32, 33].includes(ancestryID), `rolled ancestry ${ancestryID} is Achura`);
  }
});

test("a bloodline with no SDE ancestry rolls ancestry 0 rather than one from elsewhere", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // Bloodline 4 (Brutor) has no ancestry row in this suite's SDE fixture.
  await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "Zaphod Beeblebrox", raceID: 2, genderID: 1, bloodlineID: 4, confirm: true },
  });

  const [, bloodlineID, , ancestryID] = createCalls(gateway)[0].args;
  assert.equal(bloodlineID, 4);
  assert.equal(ancestryID, 0, "no ancestry is better than one belonging to another bloodline");
});

// --- an alt, created while a pilot is already flying --------------------------

test("creating while a character IS online runs on that held session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, "/api/bridge/character/create-with-doll", {
    method: "POST",
    body: { name: "Zaphod Beeblebrox", raceID: 8, genderID: 1, confirm: true },
  });

  const [call] = createCalls(gateway);
  assert.equal(call.bridgeSessionID, BRIDGE_SESSION_ID);
  assert.equal(call.args[1], 7, "the only Gallente bloodline in this world's fixture");
});
