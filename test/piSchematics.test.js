"use strict";

// GET /api/pi/schematics — the planetary production recipe table, served as
// pure static reference data: no colony, no gateway call, no live session.
// Same two-layer shape as test/typeDogma.test.js (its own comment names
// test/agentFinder.test.js as the pattern this was copied from):
//   1. The route against the REAL gameStore `planetSchematics` table (skipped
//      when the eve.js data isn't present on this machine) — this is where
//      the output-typeID bijection and the tier anchors are proved against
//      real data, not asserted in a comment.
//   2. The route against an injected fake staticData — deterministic
//      translation-contract, auth and skip-bad-row coverage that does not
//      depend on what happens to be sitting in the real table today.
//
// Read-only static reference data, like /api/types/cycle-times and
// /api/types/dogma: NOT a gateway/bridge call, and nothing here needs a
// character in space.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { once } = require("events");

const { createApp } = require("../src/server");
const staticData = require("../src/staticData");
const config = require("../src/config");

// --- 1. The route against the REAL planetSchematics table -------------------

const PLANET_SCHEMATICS_DATA_FILE = path.join(
  config.eveRoot,
  "_local",
  "gameStore",
  "data",
  "planetSchematics",
  "data.json",
);
const HAS_REAL_DATA = fs.existsSync(PLANET_SCHEMATICS_DATA_FILE);
const SKIP_REAL = HAS_REAL_DATA ? false : "gameStore planetSchematics data.json not present";

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
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
  };
}

// eveGatewayClient is `{}` on purpose, exactly like test/typeDogma.test.js: if
// the route ever reached for a bridge/gateway method this would throw, so a
// 200 back is itself proof that no such call was made.
async function startTestServer(staticDataSource) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: {},
    webAuth: fakeAuth(),
    staticData: staticDataSource,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function getSchematics(baseUrl, options = {}) {
  const headers = {};
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}/api/pi/schematics`, { headers });
  return { response, payload: await response.json() };
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

test("real table: every schematic carries a single positive output and a positive cycleTimeSeconds", { skip: SKIP_REAL }, async () => {
  const { baseUrl } = await startTestServer(staticData);
  const { response, payload } = await getSchematics(baseUrl);
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "static-data");
  assert.ok(Array.isArray(payload.schematics));
  assert.ok(payload.schematics.length >= 60, "close to the documented 68 rows");
  for (const schematic of payload.schematics) {
    assert.ok(schematic.output && typeof schematic.output === "object" && !Array.isArray(schematic.output));
    assert.ok(schematic.output.typeID > 0);
    assert.ok(schematic.output.quantity > 0);
    assert.ok(Number.isFinite(schematic.cycleTimeSeconds));
    assert.ok(schematic.cycleTimeSeconds > 0);
    // The regression this wire name exists to prevent: a duration meant in
    // SECONDS (1800, 3600) must never quietly read as milliseconds.
    assert.ok(schematic.cycleTimeSeconds < 100000, "1800/3600s, not 1800000/3600000ms");
  }
});

test("THE BIJECTION: across the real table, no two schematics make the same thing", { skip: SKIP_REAL }, async () => {
  const { baseUrl } = await startTestServer(staticData);
  const { payload } = await getSchematics(baseUrl);
  const outputTypeIDs = payload.schematics.map((schematic) => schematic.output.typeID);
  assert.equal(new Set(outputTypeIDs).size, outputTypeIDs.length);
});

test("real table: every typeID named in any inputs or output has a commodities entry", { skip: SKIP_REAL }, async () => {
  const { baseUrl } = await startTestServer(staticData);
  const { payload } = await getSchematics(baseUrl);
  for (const schematic of payload.schematics) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(payload.commodities, String(schematic.output.typeID)),
      `output ${schematic.output.typeID} of schematic ${schematic.schematicID}`,
    );
    for (const input of schematic.inputs) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(payload.commodities, String(input.typeID)),
        `input ${input.typeID} of schematic ${schematic.schematicID}`,
      );
    }
  }
});

test("real table: single-input schematics run on a raw (tier 0) resource, and a tier-4 commodity exists", { skip: SKIP_REAL }, async () => {
  const { baseUrl } = await startTestServer(staticData);
  const { payload } = await getSchematics(baseUrl);

  // Derive the anchors from the data itself, not a hardcoded schematicID: a
  // one-input recipe is definitionally refining a single raw material, so
  // every such recipe's input has to classify as tier 0.
  const oneInputSchematics = payload.schematics.filter((schematic) => schematic.inputs.length === 1);
  assert.ok(oneInputSchematics.length > 0, "the real table has single-input (P1) recipes");
  for (const schematic of oneInputSchematics) {
    const inputTier = payload.commodities[String(schematic.inputs[0].typeID)].tier;
    assert.equal(inputTier, 0, `${schematic.name}'s single input should be a raw resource`);
  }

  const tier4Commodities = Object.values(payload.commodities).filter((commodity) => commodity.tier === 4);
  assert.ok(tier4Commodities.length > 0, "the real table manufactures at least one tier-4 (P4) commodity");
});

// --- 2. The route against an injected fake staticData (deterministic) -------

function fakeStaticData({ schematics = [], types = {}, tiers = {} } = {}) {
  return {
    getAllPlanetSchematics() {
      return schematics;
    },
    getType(typeID) {
      return types[Number(typeID)] || null;
    },
    getCommodityTier(typeID) {
      const tier = tiers[Number(typeID)];
      return tier === undefined ? null : tier;
    },
  };
}

test("GET /api/pi/schematics rejects an unauthenticated request", async () => {
  const { baseUrl } = await startTestServer(fakeStaticData());
  const { response, payload } = await getSchematics(baseUrl, { authenticated: false });
  assert.equal(response.status, 401);
  assert.equal(payload.error, "AUTH_REQUIRED");
});

test("GET /api/pi/schematics translates the raw table to the documented wire shape exactly", async () => {
  const { baseUrl } = await startTestServer(fakeStaticData({
    schematics: [
      {
        schematicID: 65,
        name: "Superconductors",
        cycleTime: 3600,
        pinTypeIDs: [2470, 2472],
        inputs: [
          { typeID: 2389, quantity: 40 },
          { typeID: 3645, quantity: 40 },
        ],
        outputs: [{ typeID: 9838, quantity: 5 }],
      },
    ],
    // The fake answers what the real table answers for these ids. It does not
    // have to - nothing here reads the real data - but a fixture that states
    // something false about a real type teaches the next reader a wrong fact,
    // and this one is a faithful miniature of schematic 65.
    types: {
      2389: { name: "Plasmoids" },
      3645: { name: "Water" },
      9838: { name: "Superconductors" },
    },
    tiers: { 2389: 1, 3645: 1, 9838: 2 },
  }));
  const { response, payload } = await getSchematics(baseUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(payload, {
    ok: true,
    source: "static-data",
    schematics: [
      {
        schematicID: 65,
        name: "Superconductors",
        cycleTimeSeconds: 3600,
        factoryTypeIDs: [2470, 2472],
        inputs: [
          { typeID: 2389, typeName: "Plasmoids", quantity: 40 },
          { typeID: 3645, typeName: "Water", quantity: 40 },
        ],
        output: { typeID: 9838, typeName: "Superconductors", quantity: 5 },
      },
    ],
    commodities: {
      9838: { typeName: "Superconductors", tier: 2 },
      2389: { typeName: "Plasmoids", tier: 1 },
      3645: { typeName: "Water", tier: 1 },
    },
  });
});

test("an ingredient of an unknown type gets a null typeName, never a stringified id", async () => {
  const { baseUrl } = await startTestServer(fakeStaticData({
    schematics: [
      {
        schematicID: 900,
        name: "Fixture Recipe",
        cycleTime: 1800,
        pinTypeIDs: [1],
        inputs: [{ typeID: 424242, quantity: 10 }],
        outputs: [{ typeID: 9838, quantity: 1 }],
      },
    ],
    types: { 9838: { name: "Superconductors" } },
    tiers: { 9838: 3 },
  }));
  const { payload } = await getSchematics(baseUrl);
  const schematic = payload.schematics.find((entry) => entry.schematicID === 900);
  assert.equal(schematic.inputs[0].typeName, null);
  assert.equal(payload.commodities["424242"].typeName, null);
  assert.equal(payload.commodities["424242"].tier, null);
});

test("a row without exactly one usable output is skipped rather than served broken", async () => {
  const { baseUrl } = await startTestServer(fakeStaticData({
    schematics: [
      // Good: exactly one output, positive quantity.
      {
        schematicID: 1,
        name: "Good Recipe",
        cycleTime: 1800,
        pinTypeIDs: [1],
        inputs: [],
        outputs: [{ typeID: 100, quantity: 1 }],
      },
      // Bad: no output at all.
      {
        schematicID: 2,
        name: "No Output",
        cycleTime: 1800,
        pinTypeIDs: [1],
        inputs: [],
        outputs: [],
      },
      // Bad: two outputs — not something a planner can reason about as ONE
      // recipe.
      {
        schematicID: 3,
        name: "Two Outputs",
        cycleTime: 1800,
        pinTypeIDs: [1],
        inputs: [],
        outputs: [{ typeID: 100, quantity: 1 }, { typeID: 101, quantity: 1 }],
      },
      // Bad: the one output carries no usable (positive) quantity.
      {
        schematicID: 4,
        name: "Zero Quantity Output",
        cycleTime: 1800,
        pinTypeIDs: [1],
        inputs: [],
        outputs: [{ typeID: 100, quantity: 0 }],
      },
    ],
    types: { 100: { name: "Widget" }, 101: { name: "Gadget" } },
    tiers: { 100: 1, 101: 1 },
  }));
  const { payload } = await getSchematics(baseUrl);
  assert.deepEqual(payload.schematics.map((entry) => entry.schematicID), [1]);
});
