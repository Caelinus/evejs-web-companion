"use strict";

// Goal R42: ten tabs, ten accounts. The signed login token now rides
// `Authorization: Bearer` (fed from the tab's own sessionStorage, which is
// per-tab by specification) as well as the legacy shared cookie, and the SSE
// push channel — whose EventSource cannot send headers — takes it as the
// `access_token` query parameter.
//
// These tests use the REAL src/webAuth, not a fake, because the whole claim is
// that nothing about the authentication changed: same createSessionToken, same
// verifySessionToken, same req.webSessionID. Only the carrier is new.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

const originalDataDir = process.env.EVEJS_WEB_POC_DATA_DIR;
const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-web-r42-"));
process.env.EVEJS_WEB_POC_DATA_DIR = temporaryDataDir;

const webAuth = require("../src/webAuth");
const { createApp } = require("../src/server");

const COOKIE_NAME = "evejs_web_poc";

// Two whole accounts, because one account cannot show a collision.
const FARMER = { username: "farmer", accountID: 4001, role: "0", banned: false };
const SECOND = { username: "second", accountID: 4002, role: "0", banned: false };
const CHARACTERS = new Map([
  [FARMER.accountID, [{ characterID: 7001, accountID: FARMER.accountID, characterName: "Ore Farmer" }]],
  [SECOND.accountID, [{ characterID: 7002, accountID: SECOND.accountID, characterName: "Second Pilot" }]],
]);
const ACCOUNTS = new Map([[FARMER.username, FARMER], [SECOND.username, SECOND]]);

const activeServers = new Set();

function fakeStore() {
  return {
    async getAccount(username) {
      const account = ACCOUNTS.get(String(username));
      return account ? { ...account } : null;
    },
    async listCharactersForAccount(accountID) {
      return (CHARACTERS.get(Number(accountID)) || []).map((row) => ({ ...row }));
    },
    async getCharacterForAccount(accountID, characterID) {
      const row = (CHARACTERS.get(Number(accountID)) || [])
        .find((entry) => entry.characterID === Number(characterID));
      return row ? { ...row } : null;
    },
  };
}

// A gateway that answers with WHICH session asked, so a response can be traced
// back to the account that made the request.
function fakeGateway() {
  const streams = [];
  return {
    streams,
    async readFlightStatus() {
      return { flight: { docked: true, inSpace: false, stationID: 60000004, shipID: 9001 }, notifications: [] };
    },
    async selectCharacter(args, kwargs, session) {
      const characterID = Number(args[0]);
      const row = (CHARACTERS.get(Number(session.userid)) || [])
        .find((entry) => entry.characterID === characterID);
      return {
        bridgeSessionID: `bridge-for-${characterID}`,
        session: {
          characterID,
          characterName: row ? row.characterName : "",
          stationID: 60000004,
          solarSystemID: 30000001,
          corporationID: 1000001,
        },
        notifications: [],
      };
    },
    async releaseBridgeSession() {
      return { released: true };
    },
    async callMethod(service, method, args, kwargs, session, bridgeSessionID) {
      return {
        service,
        method,
        result: {
          userid: Number(session.userid) || 0,
          bridgeSessionID: bridgeSessionID === undefined ? null : bridgeSessionID,
        },
        notifications: [],
      };
    },
    openSessionEventStream(options) {
      const handle = { ...options, closed: false, close() { handle.closed = true; } };
      streams.push(handle);
      return handle;
    },
  };
}

async function startTestServer(overrides = {}) {
  const gateway = overrides.gateway || fakeGateway();
  const app = createApp({
    eveStore: overrides.store || fakeStore(),
    eveGatewayClient: gateway,
    webAuth,
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, gateway, app };
}

// One request helper with every carrier under explicit control, so each test
// says exactly which one it is exercising.
async function request(baseUrl, routePath, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.bearer) {
    headers.authorization = `Bearer ${options.bearer}`;
  }
  if (options.cookie) {
    headers.cookie = `${COOKIE_NAME}=${options.cookie}`;
  }
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

/** Sign in and hand back the token from the body plus the cookie the BFF set. */
async function signIn(baseUrl, username) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "anything" }),
  });
  const payload = await response.json();
  const setCookie = response.headers.getSetCookie
    ? response.headers.getSetCookie().join("; ")
    : String(response.headers.get("set-cookie") || "");
  const match = new RegExp(`${COOKIE_NAME}=([^;]+)`).exec(setCookie);
  return {
    response,
    payload,
    token: payload.sessionToken,
    cookieValue: match ? decodeURIComponent(match[1]) : null,
  };
}

/** Bring a character online on `token`'s web session. */
async function selectCharacter(baseUrl, token, characterID) {
  return request(baseUrl, "/api/bridge/select", {
    method: "POST",
    bearer: token,
    body: { characterID },
  });
}

test.afterEach(async () => {
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  }
  await Promise.all(closing);
});

test.after(() => {
  if (originalDataDir === undefined) {
    delete process.env.EVEJS_WEB_POC_DATA_DIR;
  } else {
    process.env.EVEJS_WEB_POC_DATA_DIR = originalDataDir;
  }
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
});

test("login hands the tab its own session token AND still sets the migration cookie", async () => {
  const { baseUrl } = await startTestServer();

  const { response, payload, token, cookieValue } = await signIn(baseUrl, FARMER.username);

  assert.equal(response.status, 200);
  assert.equal(typeof token, "string");
  assert.ok(token.length > 0, "login must answer a session token the tab can store");
  // Same token on both carriers: this is a change of carrier, not of auth.
  assert.equal(cookieValue, token, "the cookie must carry the very same token");
  const verified = webAuth.verifySessionToken(token);
  assert.ok(verified, "the body token must verify with the unchanged verifySessionToken");
  assert.equal(verified.username, FARMER.username);
  assert.equal(verified.accountID, FARMER.accountID);
  assert.equal(payload.account.username, FARMER.username);
});

test("a request carrying ONLY the Authorization header authenticates — no cookie at all", async () => {
  const { baseUrl } = await startTestServer();
  const { token } = await signIn(baseUrl, FARMER.username);

  const { response, payload } = await request(baseUrl, "/api/bridge/call", {
    method: "POST",
    bearer: token,
    body: { service: "map", method: "GetStationInfo", args: [], kwargs: null },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  // The BFF pins userid from the signed session, so this proves WHICH account
  // the header resolved to — not merely that something answered 200.
  assert.equal(payload.result.userid, FARMER.accountID);
});

test("a request carrying ONLY the legacy cookie still authenticates", async () => {
  const { baseUrl } = await startTestServer();
  const { cookieValue } = await signIn(baseUrl, SECOND.username);

  const { response, payload } = await request(baseUrl, "/api/bridge/call", {
    method: "POST",
    cookie: cookieValue,
    body: { service: "map", method: "GetStationInfo", args: [], kwargs: null },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.result.userid, SECOND.accountID);
});

test("cookie and header carrying the same token agree", async () => {
  const { baseUrl } = await startTestServer();
  const { token, cookieValue } = await signIn(baseUrl, FARMER.username);

  const { response, payload } = await request(baseUrl, "/api/bridge/call", {
    method: "POST",
    bearer: token,
    cookie: cookieValue,
    body: { service: "map", method: "GetStationInfo", args: [], kwargs: null },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.result.userid, FARMER.accountID);
});

test("when the shared cookie names another account, the tab's OWN header wins", async () => {
  // This is the collision the whole goal exists to fix: tab two signed in last,
  // so the profile-wide cookie says SECOND, but tab one is still holding
  // FARMER's token in its own sessionStorage and must keep being FARMER.
  const { baseUrl } = await startTestServer();
  const farmer = await signIn(baseUrl, FARMER.username);
  const second = await signIn(baseUrl, SECOND.username);
  assert.notEqual(farmer.token, second.token);

  const { response, payload } = await request(baseUrl, "/api/bridge/call", {
    method: "POST",
    bearer: farmer.token,
    cookie: second.cookieValue,
    body: { service: "map", method: "GetStationInfo", args: [], kwargs: null },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.result.userid, FARMER.accountID);
  assert.notEqual(payload.result.userid, SECOND.accountID);
});

test("a forged, tampered or empty Bearer token is refused", async () => {
  const { baseUrl } = await startTestServer();
  const { token } = await signIn(baseUrl, FARMER.username);
  const [encodedPayload, signature] = token.split(".");
  const swapped = `${encodedPayload}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  const body = { service: "map", method: "GetStationInfo", args: [], kwargs: null };

  for (const candidate of ["not-a-token", swapped, `${encodedPayload}.`, ""]) {
    const { response, payload } = await request(baseUrl, "/api/bridge/call", {
      method: "POST",
      bearer: candidate || undefined,
      body,
    });
    assert.equal(response.status, 401, `token ${JSON.stringify(candidate)} must be refused`);
    assert.equal(payload.error, "AUTH_REQUIRED");
  }
});

test("two tokens in flight resolve to two DIFFERENT characters", async () => {
  // The actual feature. Two accounts, two tokens, two live characters, reads
  // interleaved on one server — neither tab logs the other out.
  const { baseUrl } = await startTestServer();
  const farmer = await signIn(baseUrl, FARMER.username);
  const second = await signIn(baseUrl, SECOND.username);

  const farmerSelect = await selectCharacter(baseUrl, farmer.token, 7001);
  const secondSelect = await selectCharacter(baseUrl, second.token, 7002);
  assert.equal(farmerSelect.payload.character.characterName, "Ore Farmer");
  assert.equal(secondSelect.payload.character.characterName, "Second Pilot");

  const body = { service: "map", method: "GetStationInfo", args: [], kwargs: null };
  const [farmerRead, secondRead, farmerAgain] = await Promise.all([
    request(baseUrl, "/api/bridge/call", { method: "POST", bearer: farmer.token, body }),
    request(baseUrl, "/api/bridge/call", { method: "POST", bearer: second.token, body }),
    request(baseUrl, "/api/bridge/call", { method: "POST", bearer: farmer.token, body }),
  ]);

  // Each read ran on its OWN held bridge session — the handle the BFF minted
  // for that character — which is what "two characters at once" means here.
  assert.equal(farmerRead.payload.result.bridgeSessionID, "bridge-for-7001");
  assert.equal(secondRead.payload.result.bridgeSessionID, "bridge-for-7002");
  assert.equal(farmerAgain.payload.result.bridgeSessionID, "bridge-for-7001");
  assert.equal(farmerRead.payload.result.userid, FARMER.accountID);
  assert.equal(secondRead.payload.result.userid, SECOND.accountID);
});

test("logout clears both carriers and releases only the calling tab's session", async () => {
  const { baseUrl, app } = await startTestServer();
  const farmer = await signIn(baseUrl, FARMER.username);
  const second = await signIn(baseUrl, SECOND.username);
  await selectCharacter(baseUrl, farmer.token, 7001);
  await selectCharacter(baseUrl, second.token, 7002);
  assert.equal(app.locals.bridgeSessions.size, 2);

  const farmerSessionID = webAuth.verifySessionToken(farmer.token).sessionID;
  const secondSessionID = webAuth.verifySessionToken(second.token).sessionID;
  const ready = await request(baseUrl, "/api/bridge/drone-recovery/ready", {
    method: "POST", bearer: farmer.token,
    body: { checkID: app.locals.bridgeSessions.get(farmerSessionID).droneRecoveryCheckID },
  });
  assert.equal(ready.response.status, 200);

  const response = await fetch(`${baseUrl}/api/logout`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${farmer.token}`,
      // The shared cookie says SECOND. Logging out must follow the HEADER, or
      // one tab signing out would knock a different account offline.
      cookie: `${COOKIE_NAME}=${second.cookieValue}`,
    },
    body: "{}",
  });
  await response.json();

  assert.equal(response.status, 200);
  assert.equal(app.locals.bridgeSessions.has(farmerSessionID), false, "the calling tab is released");
  assert.equal(app.locals.bridgeSessions.has(secondSessionID), true, "the other tab stays live");
  // And the cookie carrier is expired on the way out.
  const setCookie = response.headers.getSetCookie
    ? response.headers.getSetCookie().join("; ")
    : String(response.headers.get("set-cookie") || "");
  assert.match(setCookie, /evejs_web_poc=;/);
});

test("the push channel authenticates per tab from the query parameter", async () => {
  // EventSource cannot send headers, so the stream carries the token in the
  // URL. Two tabs must attach to two DIFFERENT gateway streams, or tab two
  // would watch tab one's account.
  const { baseUrl, gateway } = await startTestServer();
  const farmer = await signIn(baseUrl, FARMER.username);
  const second = await signIn(baseUrl, SECOND.username);
  await selectCharacter(baseUrl, farmer.token, 7001);
  await selectCharacter(baseUrl, second.token, 7002);

  const controllers = [new AbortController(), new AbortController()];
  const streams = await Promise.all([
    fetch(`${baseUrl}/api/bridge/events?access_token=${encodeURIComponent(farmer.token)}`, {
      signal: controllers[0].signal,
    }),
    fetch(`${baseUrl}/api/bridge/events?access_token=${encodeURIComponent(second.token)}`, {
      signal: controllers[1].signal,
    }),
  ]);

  try {
    for (const stream of streams) {
      assert.equal(stream.status, 200);
      assert.match(String(stream.headers.get("content-type")), /text\/event-stream/);
    }

    // Each attached browser opened its own gateway socket, bound to its own
    // account and its own bridge session.
    assert.equal(gateway.streams.length, 2);
    const opened = gateway.streams.map((entry) => ({
      userid: entry.userid,
      bridgeSessionID: entry.bridgeSessionID,
    }));
    assert.deepEqual(opened.slice().sort((a, b) => a.userid - b.userid), [
      { userid: FARMER.accountID, bridgeSessionID: "bridge-for-7001" },
      { userid: SECOND.accountID, bridgeSessionID: "bridge-for-7002" },
    ]);

    // Push a frame down FARMER's gateway socket and read it off FARMER's SSE
    // response: the whole point is that it does not arrive on SECOND's.
    const farmerStream = gateway.streams.find((entry) => entry.userid === FARMER.accountID);
    farmerStream.onFrame({ source: "evejs-web-gateway", marker: "for-ore-farmer" });
    const text = await readSseUntil(streams[0], /for-ore-farmer/);
    assert.match(text, /for-ore-farmer/);
    assert.doesNotMatch(text, /second/i);
  } finally {
    for (const controller of controllers) {
      controller.abort();
    }
  }
});

test("a token in the query string authenticates the stream and NOTHING else", async () => {
  // Containment for the credential-in-a-URL trade: if a stream URL leaks it can
  // be used to watch, never to drive. Every mutating route ignores the query.
  const { baseUrl } = await startTestServer();
  const { token } = await signIn(baseUrl, FARMER.username);
  const query = `access_token=${encodeURIComponent(token)}`;
  await selectCharacter(baseUrl, token, 7001);

  // Same token, same query parameter: it opens the stream...
  for (const path of ["events", "events/", "Events"]) {
    const controller = new AbortController();
    try {
      const stream = await fetch(`${baseUrl}/api/bridge/${path}?${query}`, {
        signal: controller.signal,
      });
      assert.equal(stream.status, 200, "the query carrier must work on every matched stream route");
    } finally { controller.abort(); }
  }

  // ...and is ignored everywhere else.
  const call = await fetch(`${baseUrl}/api/bridge/call?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "map", method: "GetStationInfo", args: [], kwargs: null }),
  });
  assert.equal(call.status, 401);
  assert.equal((await call.json()).error, "AUTH_REQUIRED");

  const select = await fetch(`${baseUrl}/api/bridge/select?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterID: 7001 }),
  });
  assert.equal(select.status, 401);

  const agents = await fetch(`${baseUrl}/api/agents/find?${query}`);
  assert.equal(agents.status, 401);
});

test("the stream still accepts the legacy cookie, so nothing regresses mid-migration", async () => {
  const { baseUrl, gateway } = await startTestServer();
  const farmer = await signIn(baseUrl, FARMER.username);
  await selectCharacter(baseUrl, farmer.token, 7001);

  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/api/bridge/events`, {
    headers: { cookie: `${COOKIE_NAME}=${farmer.cookieValue}` },
    signal: controller.signal,
  });
  try {
    assert.equal(stream.status, 200);
    assert.equal(gateway.streams.length, 1);
    assert.equal(gateway.streams[0].userid, FARMER.accountID);
  } finally {
    controller.abort();
  }
});

/** Read an SSE body until `pattern` shows up (or the stream ends). */
async function readSseUntil(response, pattern) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let reads = 0; reads < 20; reads += 1) {
    const { value, done } = await reader.read();
    if (value) {
      text += decoder.decode(value, { stream: true });
    }
    if (pattern.test(text) || done) {
      break;
    }
  }
  reader.cancel().catch(() => {});
  return text;
}
