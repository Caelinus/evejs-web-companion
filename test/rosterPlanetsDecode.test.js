"use strict";

// THE SEAM: a CAPTURED colony, through the REAL route, through the REAL decoder,
// into the REAL attention rules.
//
// test/rosterPlanets.test.js proves the route's shape with colonies shaped for
// it. web/src/bridge/piRoster.test.ts proves the decoder reads that shape.
//
// ⚠ BOTH CAN PASS WHILE THE BOARD IS BROKEN. Each describes the wire in its own
// words, and two descriptions of one contract are exactly how a field gets
// renamed on one side only. Nor has either seen a colony the gateway really
// sends: every fixture before this one was built from eve.js's normalizers, not
// read off the wire — and the wire carries fields they never had
// (`commandCenterLevel`, `networkRevision`, `createdAt`).
//
// The colony here was read off the live gateway's /snapshot with its owner
// logged out and nothing selected (test/fixtures/snapshotColonyCaptured.json
// says what was substituted). This file hands it to the BFF as the gateway
// would, fetches /api/roster/planets, and feeds the bytes that come back to
// `decodeRosterColonies` and on into `colonyFindings`.
//
// (The client modules are TypeScript; node runs them under `require` directly,
// which is why a CommonJS test can hold both halves at once.)

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");
const staticData = require("../src/staticData");

const { decodeRosterColonies, unansweredPilots } = require("../web/src/bridge/piRoster.ts");
const { colonyFindings } = require("../web/src/bridge/colonyAttention.ts");

const CAPTURED = require("./fixtures/snapshotColonyCaptured.json").colony;

// The ECU in the capture is typeID 2848; the static table names its group only
// when the game data is present (EVEJS_ROOT). Without it every structure is
// "other", so the half of this file that needs kinds skips rather than lies.
const SKIP_REAL = staticData.getType(2848)
  ? false
  : "game static data not present (set EVEJS_ROOT)";

const COOKIE_TOKEN = "raw-signed-login-cookie";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const FARMER_ID = CAPTURED.ownerID;
const NOT_YET_BUILT_ID = 90000002;
const REFUSED_ID = 90000009;

// FILETIME is 100ns ticks since 1601; computed here, independently of the route.
const FILETIME_EPOCH_OFFSET_MS = 11644473600000;
function fileTimeMs(text) {
  return Number(BigInt(text) / 10000n) - FILETIME_EPOCH_OFFSET_MS;
}

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

function fakeAuth() {
  return {
    createSessionToken: () => COOKIE_TOKEN,
    verifySessionToken: (token) =>
      token === COOKIE_TOKEN
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: "session" }
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

/**
 * The gateway, answering as it did live: the colony table filtered to the
 * requested owner, present-and-empty for a pilot with none, a refusal for a
 * pilot of another account. No callMethod — a bridge call here would throw.
 */
function capturedGateway() {
  return {
    async getSnapshot(accountID, characterID) {
      if (characterID === REFUSED_ID) {
        const error = new Error("Character does not belong to the supplied account.");
        error.code = "CHARACTER_ACCOUNT_MISMATCH";
        throw error;
      }
      const coloniesByKey = characterID === FARMER_ID
        ? { [`${CAPTURED.planetID}:${CAPTURED.ownerID}`]: CAPTURED }
        : {};
      return {
        source: "evejs-web-gateway",
        items: [],
        planetRuntimeState: { schemaVersion: 1, coloniesByKey, launchesByID: {}, nextIDs: {} },
      };
    },
  };
}

async function readRoster(characterIDs) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: capturedGateway(),
    webAuth: fakeAuth(),
    staticData,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  const response = await ORIGINAL_FETCH(
    `http://127.0.0.1:${port}/api/roster/planets?characterIDs=${characterIDs.join(",")}`,
    { headers: { cookie: `evejs_web_poc=${COOKIE_TOKEN}` } },
  );
  assert.equal(response.status, 200);
  // Through text, exactly as a browser receives it: no object survives the trip.
  const bytes = await response.text();
  return decodeRosterColonies(JSON.parse(bytes), Date.now());
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

test("a captured colony survives the route and the decoder whole", async () => {
  const asked = [FARMER_ID, REFUSED_ID, NOT_YET_BUILT_ID];
  const pilots = await readRoster(asked);

  // Who answered, who did not, and "has not built" kept apart from both.
  assert.deepEqual(pilots.map((pilot) => pilot.characterID), [FARMER_ID, NOT_YET_BUILT_ID]);
  assert.deepEqual(unansweredPilots(asked, pilots), [REFUSED_ID]);
  const [farmer, notYetBuilt] = pilots;
  assert.equal(notYetBuilt.report.coloniesReadable, true);
  assert.deepEqual(notYetBuilt.report.colonies, []);

  // Every pilot keeps an instant of its own.
  for (const pilot of pilots) {
    assert.equal(typeof pilot.readAtMs, "number");
  }

  assert.equal(farmer.report.coloniesReadable, true);
  assert.equal(farmer.report.colonies.length, 1);
  const [colony] = farmer.report.colonies;
  assert.equal(colony.planetID, CAPTURED.planetID);
  assert.equal(colony.commandCenterLevel, CAPTURED.level);
  assert.equal(colony.pins.length, CAPTURED.pins.length);
  assert.equal(colony.links.length, CAPTURED.links.length);
  assert.equal(colony.linkCount, CAPTURED.links.length);
  assert.equal(colony.routes.length, CAPTURED.routes.length);
  assert.equal(colony.lastSimulatedAtMs, fileTimeMs(CAPTURED.currentSimTime));

  // Contents: string-keyed on the wire, typed rows after the trip.
  const heldBefore = CAPTURED.pins.flatMap((pin) =>
    Object.entries(pin.contents).map(([typeID, quantity]) => [Number(typeID), quantity]));
  const heldAfter = colony.pins.flatMap((pin) =>
    pin.contents.map((item) => [item.typeID, item.quantity]));
  assert.deepEqual(heldAfter.sort(), heldBefore.sort());

  // A pad that never launched carries "0": that is NEVER, not the year 1601.
  const neverLaunched = CAPTURED.pins.filter((pin) => pin.lastLaunchTime === "0").map((pin) => pin.pinID);
  assert.ok(neverLaunched.length > 0);
  for (const pinID of neverLaunched) {
    assert.equal(colony.pins.find((pin) => pin.pinID === pinID).lastLaunchAtMs, null);
  }

  // The processor flags keep all three states: true, false, and unstated.
  for (const raw of CAPTURED.pins) {
    const decoded = colony.pins.find((pin) => pin.pinID === raw.pinID);
    const expected = raw.receivedInputsLastCycle === undefined ? null : raw.receivedInputsLastCycle;
    assert.equal(decoded.receivedInputsLastCycle, expected, `pin ${raw.pinID}`);
  }
});

test("with the game data: structures are classified, programs read, and the attention rules fire", { skip: SKIP_REAL }, async () => {
  const [farmer] = await readRoster([FARMER_ID]);
  const [colony] = farmer.report.colonies;

  const kinds = {};
  for (const pin of colony.pins) {
    kinds[pin.kind] = (kinds[pin.kind] || 0) + 1;
  }
  assert.deepEqual(kinds, { "extractor-control": 2, factory: 4, launchpad: 1, storage: 1, command: 1 });
  assert.equal(colony.planetName !== null && !/\d{5,}/.test(colony.planetName), true, "named, never numbered");

  // Extraction programs: ticks became seconds and FILETIMEs became epoch ms.
  const rawExtractors = CAPTURED.pins.filter((pin) => pin.programType);
  assert.equal(rawExtractors.length, 2);
  for (const raw of rawExtractors) {
    const { program } = colony.pins.find((pin) => pin.pinID === raw.pinID);
    assert.equal(program.cycleTimeSeconds, raw.cycleTime / 10000000);
    assert.equal(program.quantityPerCycle, raw.qtyPerCycle);
    assert.equal(program.expiresAtMs, fileTimeMs(raw.expiryTime));
    assert.equal(program.installedAtMs, fileTimeMs(raw.installTime));
    assert.equal(program.headCount, raw.heads.length);
    assert.equal(typeof program.resourceTypeName, "string");
  }

  // Judged at the colony's own simulated instant, so the answer does not drift
  // with the day this test runs: the factories the capture says went unfed are
  // exactly the ones reported starved, and each is named by what it makes.
  const findings = colonyFindings(colony, colony.lastSimulatedAtMs);
  const starved = findings.filter((finding) => finding.kind === "factory-starved");
  const unfed = CAPTURED.pins.filter((pin) => pin.receivedInputsLastCycle === false).map((pin) => pin.pinID);
  assert.equal(unfed.length, 3);
  assert.deepEqual(starved.map((finding) => finding.pinID).sort(), unfed.sort());
  for (const finding of starved) {
    assert.match(finding.words, /^The factory making \S/);
    assert.doesNotMatch(finding.words, /\d{3,}/);
  }
});
