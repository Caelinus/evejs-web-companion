"use strict";

// R107 — GET /api/roster/training, the Pilot Hangar's training column for pilots
// who are NOT signed in.
//
// ⚠ THE ROUTE EXISTS BECAUSE A FIELD LIES. The hangar used to take training out
// of charUnboundMgr.GetCharacterSelectionData, which carries skillTypeID /
// toLevel / trainingEndTime per character. Measured against a live emulator on
// 2026-09-09: all three come back null for EVERY pilot on EVERY account,
// including pilots whose stored queue was active with fifty-odd skills on it. So
// the hangar printed IDLE for a roster that was training flat out. This route
// asks the gateway's own queue snapshot instead.
//
// What these pin is the SHAPE OF NOT KNOWING, which is the whole reason the
// route is worth a suite: a pilot the read could not answer for is left OUT of
// the answer, so the browser keeps the row it had, while a pilot answered with
// skillTypeID null is the positive finding "this queue is empty".

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
// ESI's own documented example id — deliberately synthetic, never a real pilot.
const TRAINING_ID = 90000001;
const IDLE_ID = 90000002;
const UNREADABLE_ID = 90000003;
const NOT_OURS_ID = 90000009;
const MINING_BARGE = 17940;
const ENDS_AT_MS = 1_800_000_000_000;

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

function fakeGateway() {
  const asked = [];
  return {
    asked,
    async getSkills(accountID, characterID) {
      asked.push({ accountID, characterID });
      if (characterID === NOT_OURS_ID) {
        // What the gateway's own validateOwnedCharacter does with a character
        // this account does not own.
        const error = new Error("Character does not belong to this account.");
        error.code = "CHARACTER_NOT_OWNED";
        throw error;
      }
      if (characterID === UNREADABLE_ID) {
        const error = new Error("EveJS gateway is unreachable.");
        error.code = "EVE_GATEWAY_UNREACHABLE";
        throw error;
      }
      if (characterID === IDLE_ID) {
        return {
          characterID,
          skills: [{ typeID: MINING_BARGE, name: "Mining Barge" }],
          queue: { active: false, entries: [], endTimeMs: null, maxEntries: 50 },
        };
      }
      return {
        characterID,
        skills: [
          { typeID: 3300, name: "Gunnery" },
          { typeID: MINING_BARGE, name: "Mining Barge" },
        ],
        queue: {
          active: true,
          entries: [
            { queuePosition: 0, typeID: MINING_BARGE, toLevel: 5, endTimeMs: ENDS_AT_MS },
            { queuePosition: 1, typeID: 3300, toLevel: 4, endTimeMs: ENDS_AT_MS + 1000 },
          ],
          endTimeMs: ENDS_AT_MS + 1000,
          maxEntries: 50,
        },
      };
    },
  };
}

async function startTestServer(gateway) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: gateway,
    webAuth: fakeAuth(),
    staticData: {
      getStation: () => null,
      getTypeName: (id) => `Type ${id}`,
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

test("a training pilot answers with the queue head, named and dated", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const { response, payload } = await get(
    baseUrl,
    `/api/roster/training?characterIDs=${TRAINING_ID}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(payload.training, [
    {
      characterID: TRAINING_ID,
      skillTypeID: MINING_BARGE,
      skillName: "Mining Barge",
      toLevel: 5,
      endsAtMs: ENDS_AT_MS,
    },
  ]);
  // The CALLER's account, never one named in the request.
  assert.deepEqual(gateway.asked, [{ accountID: ACCOUNT.accountID, characterID: TRAINING_ID }]);
});

test("an empty queue is ANSWERED as empty, not left out", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const { payload } = await get(baseUrl, `/api/roster/training?characterIDs=${IDLE_ID}`);
  assert.deepEqual(payload.training, [
    { characterID: IDLE_ID, skillTypeID: null, skillName: null, toLevel: null, endsAtMs: null },
  ]);
});

test("⚠ a pilot the read could not answer for is OMITTED, never reported idle", async () => {
  // The difference matters: an omitted row leaves the hangar's column alone,
  // while an idle row would repaint a training pilot as IDLE off a failed read.
  const baseUrl = await startTestServer(fakeGateway());
  const { payload } = await get(
    baseUrl,
    `/api/roster/training?characterIDs=${TRAINING_ID},${UNREADABLE_ID},${NOT_OURS_ID},${IDLE_ID}`,
  );
  assert.deepEqual(
    payload.training.map((row) => row.characterID),
    [TRAINING_ID, IDLE_ID],
  );
});

test("one pilot's failure does not fail the request", async () => {
  const baseUrl = await startTestServer(fakeGateway());
  const { response, payload } = await get(
    baseUrl,
    `/api/roster/training?characterIDs=${UNREADABLE_ID}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(payload.training, []);
});

test("ids are cleaned up: blanks, junk and duplicates cost nothing", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const { payload } = await get(
    baseUrl,
    `/api/roster/training?characterIDs=${TRAINING_ID},,nope,-1,0,${TRAINING_ID}`,
  );
  assert.equal(gateway.asked.length, 1);
  assert.equal(payload.training.length, 1);
});

test("no ids is an empty answer, not a gateway call", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const { response, payload } = await get(baseUrl, "/api/roster/training");
  assert.equal(response.status, 200);
  assert.deepEqual(payload.training, []);
  assert.equal(gateway.asked.length, 0);
});

test("more pilots than an account can hold is refused, and asks nothing", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const ids = Array.from({ length: 13 }, (_, index) => TRAINING_ID + index).join(",");
  const { response, payload } = await get(baseUrl, `/api/roster/training?characterIDs=${ids}`);
  assert.equal(response.status, 400);
  assert.equal(payload.error, "TOO_MANY_CHARACTERS");
  assert.equal(gateway.asked.length, 0);
});

test("the route needs a session", async () => {
  const gateway = fakeGateway();
  const baseUrl = await startTestServer(gateway);
  const { response, payload } = await get(
    baseUrl,
    `/api/roster/training?characterIDs=${TRAINING_ID}`,
    { authenticated: false },
  );
  assert.equal(response.status, 401);
  assert.equal(payload.error, "AUTH_REQUIRED");
  assert.equal(gateway.asked.length, 0);
});
