"use strict";

// The static half of the drone-boat block's NPC target priority
// (docs/drone-boat-block-spec.md section 6). Two layers, the same shape
// test/agentFinder.test.js uses:
//   1. src/staticData.js readTypeAttributes against the REAL SDE typeDogma
//      table (skipped when the eve.js SDE is not on this machine).
//   2. POST /api/types/dogma — route shape, auth, caps and rejection, against
//      an injected fake staticData (deterministic, no real data needed).
//
// Read-only static reference data, like /api/names and /api/ore/families: NOT a
// gateway/bridge call, and nothing here needs a character in space.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { once } = require("events");

const { createApp } = require("../src/server");
const staticData = require("../src/staticData");
const config = require("../src/config");

const TYPE_DOGMA_FILE = path.join(config.sdeDir, "typeDogma.jsonl");
const HAS_REAL_DATA = fs.existsSync(TYPE_DOGMA_FILE);
const SKIP_REAL = HAS_REAL_DATA ? false : "SDE typeDogma.jsonl not present";

// The six attributes the classifier asks for, per the spec's table.
const THREAT_ATTRIBUTES = [20, 103, 504, 931, 932, 935];

// Published SDE type ids (reference data, not anybody's assets):
//   16999 Dire Pithi Arrogator  - scrams
//   13032 Arch Angel Rogue      - scrams, same readings, different faction
//   16981 Pithi Arrogator       - the plain hull of the same family: does NOT
//   10284 Serpentis Watchman    - damps, and does not scram
const DIRE_PITHI_ARROGATOR = 16999;
const ARCH_ANGEL_ROGUE = 13032;
const PITHI_ARROGATOR = 16981;
const SERPENTIS_WATCHMAN = 10284;

// --- 1. staticData.readTypeAttributes against the real typeDogma table ------

test("readTypeAttributes reads the scram/web readings off the real SDE", { skip: SKIP_REAL }, () => {
  const { attributes } = staticData.readTypeAttributes({
    typeIDs: [DIRE_PITHI_ARROGATOR, ARCH_ANGEL_ROGUE],
    attributeIDs: THREAT_ATTRIBUTES,
  });
  for (const typeID of [DIRE_PITHI_ARROGATOR, ARCH_ANGEL_ROGUE]) {
    const values = attributes[String(typeID)];
    assert.equal(values[String(504)], 0.25, "entityWarpScrambleChance");
    assert.equal(values[String(103)], 20000, "warpScrambleRange");
    assert.equal(values[String(20)], -50, "speedFactor (a web, negative)");
  }
});

// ⚠ THE WHOLE POINT OF THE FEATURE. Same family, same size, same name stem —
// and only attribute 504 separates the rat that stops you leaving from the one
// that does not. A zero here must arrive as a zero, never as "absent".
test("readTypeAttributes keeps a present-but-ZERO reading (Pithi vs Dire Pithi)", { skip: SKIP_REAL }, () => {
  const { attributes } = staticData.readTypeAttributes({
    typeIDs: [PITHI_ARROGATOR],
    attributeIDs: THREAT_ATTRIBUTES,
  });
  const values = attributes[String(PITHI_ARROGATOR)];
  assert.ok(
    Object.prototype.hasOwnProperty.call(values, String(504)),
    "504 must be PRESENT on the plain hull, carrying 0",
  );
  assert.equal(values[String(504)], 0);
});

test("readTypeAttributes reads ewar readings, and does not invent a scram", { skip: SKIP_REAL }, () => {
  const { attributes } = staticData.readTypeAttributes({
    // 938 is not in the classifier's set; asked for here only to prove an
    // attribute outside THREAT_ATTRIBUTES still comes back when requested.
    typeIDs: [SERPENTIS_WATCHMAN],
    attributeIDs: [...THREAT_ATTRIBUTES, 938],
  });
  const values = attributes[String(SERPENTIS_WATCHMAN)];
  assert.equal(values[String(932)], 0.05, "entitySensorDampenDurationChance");
  assert.equal(values[String(938)], 25000);
  assert.equal(values[String(504)], 0, "a damper is not a scram");
});

test("readTypeAttributes omits an attribute the type does not carry", { skip: SKIP_REAL }, () => {
  const { attributes } = staticData.readTypeAttributes({
    typeIDs: [ARCH_ANGEL_ROGUE],
    attributeIDs: THREAT_ATTRIBUTES,
  });
  const values = attributes[String(ARCH_ANGEL_ROGUE)];
  // A scrambling rat carries no neut/damp/paint chance at all — absent, and NOT
  // forged into a 0 by Number(null).
  for (const attributeID of [931, 932, 935]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(values, String(attributeID)),
      false,
      `${attributeID} must be absent, not 0`,
    );
  }
});

test("readTypeAttributes echoes an UNKNOWN type as an empty object", { skip: SKIP_REAL }, () => {
  const unknown = 999999999;
  const { attributes } = staticData.readTypeAttributes({
    typeIDs: [unknown, DIRE_PITHI_ARROGATOR],
    attributeIDs: THREAT_ATTRIBUTES,
  });
  assert.ok(
    Object.prototype.hasOwnProperty.call(attributes, String(unknown)),
    "the key must exist so the caller can cache 'asked, got nothing'",
  );
  assert.deepEqual(attributes[String(unknown)], {});
  // The known type in the same batch is unaffected.
  assert.equal(attributes[String(DIRE_PITHI_ARROGATOR)][String(504)], 0.25);
});

test("readTypeAttributes reads duplicates once and slices at its caps", { skip: SKIP_REAL }, () => {
  const duplicated = staticData.readTypeAttributes({
    typeIDs: [DIRE_PITHI_ARROGATOR, DIRE_PITHI_ARROGATOR, PITHI_ARROGATOR],
    attributeIDs: [504, 504, 20],
  });
  assert.equal(Object.keys(duplicated.attributes).length, 2);
  assert.equal(duplicated.capped, false);
  assert.equal(duplicated.typeLimit, staticData.TYPE_ATTRIBUTES_MAX_TYPES);
  assert.equal(duplicated.attributeLimit, staticData.TYPE_ATTRIBUTES_MAX_ATTRIBUTES);

  const over = staticData.readTypeAttributes({
    typeIDs: new Array(staticData.TYPE_ATTRIBUTES_MAX_TYPES + 5).fill(DIRE_PITHI_ARROGATOR),
    attributeIDs: [504],
  });
  assert.equal(over.capped, true, "a direct call past the cap says so");
});

test("readTypeAttributes tolerates junk input without throwing", { skip: SKIP_REAL }, () => {
  assert.deepEqual(staticData.readTypeAttributes().attributes, {});
  assert.deepEqual(staticData.readTypeAttributes({ typeIDs: "nope" }).attributes, {});
  const mixed = staticData.readTypeAttributes({
    typeIDs: [0, -1, null, "16999"],
    attributeIDs: [0, null, "504"],
  });
  assert.deepEqual(Object.keys(mixed.attributes), [String(DIRE_PITHI_ARROGATOR)]);
  assert.equal(mixed.attributes[String(DIRE_PITHI_ARROGATOR)][String(504)], 0.25);
});

// --- 2. POST /api/types/dogma (injected fake staticData) --------------------

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

// A two-type fixture with the one distinction that matters: 7001 scrams, 7002
// is the same family and carries a ZERO scramble chance. 7003 is unknown.
const FIXTURE_DOGMA = {
  7001: { 20: -50, 103: 20000, 504: 0.25 },
  7002: { 20: 0, 103: 0, 504: 0 },
};

function fakeStaticData() {
  return {
    readTypeAttributes(input = {}) {
      const typeIDs = Array.isArray(input.typeIDs) ? input.typeIDs : [];
      const attributeIDs = Array.isArray(input.attributeIDs) ? input.attributeIDs : [];
      const attributes = {};
      for (const rawTypeID of typeIDs) {
        const typeID = Number(rawTypeID) || 0;
        if (typeID <= 0) {
          continue;
        }
        const row = FIXTURE_DOGMA[typeID] || {};
        const values = {};
        for (const rawAttributeID of attributeIDs) {
          const attributeID = Number(rawAttributeID) || 0;
          if (attributeID > 0 && row[attributeID] !== undefined) {
            values[String(attributeID)] = row[attributeID];
          }
        }
        attributes[String(typeID)] = values;
      }
      return {
        attributes,
        capped: false,
        typeLimit: staticData.TYPE_ATTRIBUTES_MAX_TYPES,
        attributeLimit: staticData.TYPE_ATTRIBUTES_MAX_ATTRIBUTES,
      };
    },
  };
}

async function startTestServer() {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: {},
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

async function postDogma(baseUrl, body, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}/api/types/dogma`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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

test("POST /api/types/dogma answers raw values, zeroes included, unknowns empty", async () => {
  const { baseUrl } = await startTestServer();
  const { response, payload } = await postDogma(baseUrl, {
    typeIDs: [7001, 7002, 7003],
    attributeIDs: THREAT_ATTRIBUTES,
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.source, "static-data");
  assert.equal(payload.count, 3);
  assert.deepEqual(payload.attributes["7001"], { 20: -50, 103: 20000, 504: 0.25 });
  assert.deepEqual(payload.attributes["7002"], { 20: 0, 103: 0, 504: 0 });
  // Present, empty, and NOT null — the caller caches this outcome per id.
  assert.ok(Object.prototype.hasOwnProperty.call(payload.attributes, "7003"));
  assert.deepEqual(payload.attributes["7003"], {});
  // ⚠ The route hands back numbers only: no class, no verdict field anywhere.
  for (const key of ["classes", "threats", "isTackle", "tackle", "ewar"]) {
    assert.equal(key in payload, false, `${key} must not be on the wire`);
  }
});

test("POST /api/types/dogma rejects a non-array body cleanly", async () => {
  const { baseUrl } = await startTestServer();
  for (const body of [{}, { typeIDs: 7001, attributeIDs: [504] }, { typeIDs: [7001], attributeIDs: 504 }]) {
    const { response, payload } = await postDogma(baseUrl, body);
    assert.equal(response.status, 400);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "INVALID_REQUEST");
  }
});

// ⚠ REJECTED, not truncated: a type silently dropped past the cap comes back
// looking exactly like a type with no threat attributes, which reads as
// "harmless". A short answer must never be sent.
test("POST /api/types/dogma rejects an oversized body rather than truncating", async () => {
  const { baseUrl } = await startTestServer();
  const tooManyTypes = await postDogma(baseUrl, {
    typeIDs: new Array(staticData.TYPE_ATTRIBUTES_MAX_TYPES + 1).fill(7001),
    attributeIDs: [504],
  });
  assert.equal(tooManyTypes.response.status, 400);
  assert.equal(tooManyTypes.payload.error, "TOO_MANY_IDS");

  const tooManyAttributes = await postDogma(baseUrl, {
    typeIDs: [7001],
    attributeIDs: new Array(staticData.TYPE_ATTRIBUTES_MAX_ATTRIBUTES + 1).fill(504),
  });
  assert.equal(tooManyAttributes.response.status, 400);
  assert.equal(tooManyAttributes.payload.error, "TOO_MANY_IDS");

  // Exactly at the cap is fine.
  const atCap = await postDogma(baseUrl, {
    typeIDs: new Array(staticData.TYPE_ATTRIBUTES_MAX_TYPES).fill(7001),
    attributeIDs: [504],
  });
  assert.equal(atCap.response.status, 200);
  assert.equal(atCap.payload.limit, staticData.TYPE_ATTRIBUTES_MAX_TYPES);
  assert.equal(atCap.payload.attributeLimit, staticData.TYPE_ATTRIBUTES_MAX_ATTRIBUTES);
});

test("POST /api/types/dogma requires the web login session", async () => {
  const { baseUrl } = await startTestServer();
  const { response, payload } = await postDogma(
    baseUrl,
    { typeIDs: [7001], attributeIDs: [504] },
    { authenticated: false },
  );
  assert.equal(response.status, 401);
  assert.equal(payload.error, "AUTH_REQUIRED");
});
