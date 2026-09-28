"use strict";

// The BFF's squad-board routes: one standing primary per FLEET, so pilots on one
// grid concentrate their fire. Pure BFF-local bookkeeping — no gateway call in
// either direction — so most of this fakes just enough to get past requireAuth
// and seeds the held sessions directly, the way test/beltMemoryRoutes.test.js
// does.
//
// The one thing that DOES need a gateway is the fleet id itself: the board keys
// on `held.fleetID`, which only a bound-fleet read can set, and the last block
// here proves that read stamps it (and that a fleetless character leaves it
// unset) rather than trusting anything the browser sent.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { createApp } = require("../src/server");
const { createSquadBoard } = require("../src/squadBoard");

const FC_COOKIE = "squad-board-fc-cookie";
const WING_COOKIE = "squad-board-wing-cookie";
const LONE_COOKIE = "squad-board-lone-cookie";
const FC_SESSION = "squad-board-fc-web-session";
const WING_SESSION = "squad-board-wing-web-session";
const LONE_SESSION = "squad-board-lone-web-session";

// Two ACCOUNTS, because multiboxing is the case this exists for: the pilots
// sharing a call are usually not the same login.
const FC_ACCOUNT = { username: "fc", accountID: 4, role: "0", banned: false };
const WING_ACCOUNT = { username: "wing", accountID: 5, role: "0", banned: false };
const LONE_ACCOUNT = { username: "lone", accountID: 6, role: "0", banned: false };

// ESI's own documented example character ids — obviously synthetic, and nobody's.
const FC_CHARACTER = 90000001;
const WING_CHARACTER = 90000002;
const LONE_CHARACTER = 90000003;

const FLEET_ID = "654500010000"; // twelve digits: the shape a real fleet id has
const OTHER_FLEET_ID = "654500019999";

const SESSIONS = {
  [FC_COOKIE]: { account: FC_ACCOUNT, sessionID: FC_SESSION },
  [WING_COOKIE]: { account: WING_ACCOUNT, sessionID: WING_SESSION },
  [LONE_COOKIE]: { account: LONE_ACCOUNT, sessionID: LONE_SESSION },
};

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

function fakeAuth() {
  return {
    verifySessionToken(token) {
      const row = SESSIONS[token];
      return row ? { username: row.account.username, accountID: row.account.accountID, sessionID: row.sessionID } : null;
    },
    createSessionToken() {
      return FC_COOKIE;
    },
    countConfiguredUsers() {
      return 3;
    },
  };
}

function fakeStore() {
  const accounts = [FC_ACCOUNT, WING_ACCOUNT, LONE_ACCOUNT];
  return {
    async getAccount(username) {
      const found = accounts.find((a) => a.username === username);
      return found ? { ...found } : null;
    },
  };
}

/** A held bridge session, as `/api/bridge/select` would have left it. */
function heldSession(characterID, fleetID) {
  return {
    bridgeSessionID: `bridge:${characterID}`,
    characterID,
    accountID: 4,
    boundHandles: new Map(),
    fleetID,
    transition: null,
    streamSubscribers: new Set(),
  };
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: options.gateway || {},
    webAuth: fakeAuth(),
    staticData: options.staticData || {},
    bridgeSessionStore: options.bridgeSessions,
    squadBoard: options.squadBoard,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function apiRequest(baseUrl, route, options = {}) {
  const response = await ORIGINAL_FETCH(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      cookie: `evejs_web_poc=${options.cookie || FC_COOKIE}`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

/** A fleet with an FC and a wing-mate online, plus one pilot in another fleet. */
function fleetSessions() {
  return new Map([
    [FC_SESSION, heldSession(FC_CHARACTER, FLEET_ID)],
    [WING_SESSION, heldSession(WING_CHARACTER, FLEET_ID)],
    [LONE_SESSION, heldSession(LONE_CHARACTER, OTHER_FLEET_ID)],
  ]);
}

// ─── The routes ──────────────────────────────────────────────────────────────

test("an unauthenticated read is refused", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: fleetSessions() });
  const response = await ORIGINAL_FETCH(`${baseUrl}/api/bots/squad-board`);
  assert.equal(response.status, 401);
});

test("with no character online there is nothing to answer for", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: new Map() });
  const { response, payload } = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_LIVE_SESSION");
});

test("a pilot whose fleet is unknown is told so, not guessed at", async () => {
  const sessions = new Map([[FC_SESSION, heldSession(FC_CHARACTER, null)]]);
  const baseUrl = await startTestServer({ bridgeSessions: sessions });

  const read = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.equal(read.response.status, 409);
  assert.equal(read.payload.error, "FLEET_UNKNOWN");

  const call = await apiRequest(baseUrl, "/api/bots/squad-board", { method: "POST", body: { targetID: 1001 } });
  assert.equal(call.response.status, 409);
  assert.equal(call.payload.error, "FLEET_UNKNOWN");
});

test("nobody has called anything yet", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: fleetSessions() });
  const { response, payload } = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, fleetID: FLEET_ID, primary: null });
});

test("a call by one pilot is read by their FLEET-MATE, on another account", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: fleetSessions() });

  const called = await apiRequest(baseUrl, "/api/bots/squad-board", {
    method: "POST",
    body: { targetID: 1001 },
    cookie: FC_COOKIE,
  });
  assert.equal(called.response.status, 200);
  assert.deepEqual(called.payload.primary, { targetID: 1001, calledByCharacterID: FC_CHARACTER });

  const heard = await apiRequest(baseUrl, "/api/bots/squad-board", { cookie: WING_COOKIE });
  assert.deepEqual(heard.payload.primary, { targetID: 1001, calledByCharacterID: FC_CHARACTER });
});

test("a pilot in ANOTHER fleet hears nothing", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: fleetSessions() });
  await apiRequest(baseUrl, "/api/bots/squad-board", { method: "POST", body: { targetID: 1001 } });

  const outsider = await apiRequest(baseUrl, "/api/bots/squad-board", { cookie: LONE_COOKIE });
  assert.equal(outsider.response.status, 200);
  assert.deepEqual(outsider.payload, { ok: true, fleetID: OTHER_FLEET_ID, primary: null });
});

test("the call is made in the SESSION's name — a body cannot claim to be someone else", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: fleetSessions() });
  const { payload } = await apiRequest(baseUrl, "/api/bots/squad-board", {
    method: "POST",
    body: { targetID: 1001, calledByCharacterID: WING_CHARACTER, fleetID: OTHER_FLEET_ID },
    cookie: FC_COOKIE,
  });
  assert.equal(payload.fleetID, FLEET_ID, "a body fleetID must not choose the board");
  assert.deepEqual(payload.primary, { targetID: 1001, calledByCharacterID: FC_CHARACTER });

  // …and the fleet it tried to name is untouched.
  const outsider = await apiRequest(baseUrl, "/api/bots/squad-board", { cookie: LONE_COOKIE });
  assert.equal(outsider.payload.primary, null);
});

test("the last call wins, and a null target clears the board", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: fleetSessions() });
  await apiRequest(baseUrl, "/api/bots/squad-board", { method: "POST", body: { targetID: 1001 }, cookie: FC_COOKIE });
  await apiRequest(baseUrl, "/api/bots/squad-board", { method: "POST", body: { targetID: 1002 }, cookie: WING_COOKIE });

  const second = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.deepEqual(second.payload.primary, { targetID: 1002, calledByCharacterID: WING_CHARACTER });

  const cleared = await apiRequest(baseUrl, "/api/bots/squad-board", { method: "POST", body: { targetID: null } });
  assert.deepEqual(cleared.payload.primary, null);
  const after = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.equal(after.payload.primary, null);
});

test("a target that is not an id is a 400 and calls nothing", async () => {
  const baseUrl = await startTestServer({ bridgeSessions: fleetSessions() });
  for (const targetID of [0, -1, 1.5, "not-an-id"]) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bots/squad-board", {
      method: "POST",
      body: { targetID },
    });
    assert.equal(response.status, 400, `targetID ${targetID} should be refused`);
    assert.equal(payload.error, "INVALID_TARGET");
  }
  const { payload } = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.equal(payload.primary, null);
});

test("a lapsed call reads as no call at all", async () => {
  let nowMs = 1_000_000;
  const board = createSquadBoard({ ttlMs: 30_000, now: () => nowMs });
  const baseUrl = await startTestServer({ bridgeSessions: fleetSessions(), squadBoard: board });

  await apiRequest(baseUrl, "/api/bots/squad-board", { method: "POST", body: { targetID: 1001 } });
  nowMs += 31_000;

  const { payload } = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.equal(payload.primary, null);
});

// ─── Where the fleet id comes from ───────────────────────────────────────────

const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const CHARACTER_ID = 90000001;
const STATION_ID = 60003760;
const SOLAR_SYSTEM_ID = 30000142;

/**
 * A gateway whose GetInitState answers a marshaled util.KeyVal carrying the
 * fleet id — the {type:"object", args:{type:"dict", entries}} shape, with the id
 * as a {type:"long"} because that is what a twelve-digit id arrives as.
 * `fleetIDValue: null` makes every fleet read refuse the way a fleetless
 * character's does.
 */
function fakeGateway(fleetIDValue) {
  return {
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: FC_ACCOUNT.accountID,
          characterID: CHARACTER_ID,
          characterName: "Test Pilot",
          stationID: STATION_ID,
          structureID: null,
          solarSystemID: SOLAR_SYSTEM_ID,
          corporationID: 98000000,
          shipID: 9001,
        },
      };
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      return { boundHandle: `handle:${service}:${method}`, service, method, notifications: [] };
    },
    async callBoundMethod(service, method) {
      if (fleetIDValue === null) {
        const refusal = new Error("FleetNotFound");
        refusal.code = "CALL_REFUSED";
        throw refusal;
      }
      if (method !== "GetInitState") {
        return { service, method, result: null, notifications: [] };
      }
      return {
        service,
        method,
        result: {
          type: "object",
          args: {
            type: "dict",
            entries: [
              ["motd", "Form up"],
              ["fleetID", { type: "long", value: fleetIDValue }],
            ],
          },
        },
        notifications: [],
      };
    },
  };
}

function selectedSessions() {
  return new Map([[FC_SESSION, { ...heldSession(CHARACTER_ID, null), bridgeSessionID: BRIDGE_SESSION_ID, stationID: STATION_ID, solarSystemID: SOLAR_SYSTEM_ID }]]);
}

test("reading the fleet stamps its id on the session, and the board then works", async () => {
  const sessions = selectedSessions();
  const baseUrl = await startTestServer({ bridgeSessions: sessions, gateway: fakeGateway(FLEET_ID) });

  // Before the read the BFF does not know the fleet, so it refuses to guess.
  const before = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.equal(before.payload.error, "FLEET_UNKNOWN");

  const fleet = await apiRequest(baseUrl, "/api/bridge/bound-fleet");
  assert.equal(fleet.response.status, 200);
  assert.equal(fleet.payload.fleetID, FLEET_ID, "the id is kept EXACT, never through Number");

  const after = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.equal(after.response.status, 200);
  assert.deepEqual(after.payload, { ok: true, fleetID: FLEET_ID, primary: null });
});

test("a fleetless character gets no board, and a fleet left is a fleet forgotten", async () => {
  const sessions = selectedSessions();
  const baseUrl = await startTestServer({ bridgeSessions: sessions, gateway: fakeGateway(null) });

  // Pretend an earlier read had found a fleet; the refused read must clear it,
  // or a character who has LEFT would keep reading that fleet's calls.
  sessions.get(FC_SESSION).fleetID = FLEET_ID;

  const fleet = await apiRequest(baseUrl, "/api/bridge/bound-fleet");
  assert.equal(fleet.response.status, 200);
  assert.equal(fleet.payload.fleetID, null);

  const board = await apiRequest(baseUrl, "/api/bots/squad-board");
  assert.equal(board.response.status, 409);
  assert.equal(board.payload.error, "FLEET_UNKNOWN");
});
