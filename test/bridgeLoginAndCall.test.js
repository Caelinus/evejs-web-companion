"use strict";

// Goal R1: who-cares web login + the BFF bridge client/route for the
// whitelisted EveJS callMethod path. Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const gatewayClient = require("../src/eveGatewayClient");
const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = {
  username: "pilot",
  accountID: 4,
  role: "0",
  banned: false,
};
const CHARACTERS = [
  { characterID: 7, accountID: 4, characterName: "Test Pilot" },
];
// The retail-shaped 4-tuple GetCharacterSelectionData returns.
const SELECTION_TUPLE = [
  { type: "list", items: [] },
  [null, null],
  {
    type: "list",
    items: [
      {
        type: "object",
        name: "util.KeyVal",
        args: {
          type: "dict",
          entries: [["characterID", 7], ["characterName", "Test Pilot"]],
        },
      },
    ],
  },
  { type: "list", items: [] },
];

const ORIGINAL_FETCH = global.fetch;
const ENV_NAMES = ["EVEJS_GATEWAY_URL", "EVEJS_WEB_GATEWAY_TOKEN"];
const ORIGINAL_ENV = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
);

const activeServers = new Set();

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type"
          ? "application/json"
          : null;
      },
    },
    async json() {
      return body;
    },
  };
}

function gatewayResponse(body = {}) {
  return {
    ok: true,
    source: "evejs-web-gateway",
    apiVersion: 1,
    ...body,
  };
}

function fakeAuth() {
  return {
    createSessionToken() {
      return COOKIE_TOKEN;
    },
    verifySessionToken(token) {
      return token === COOKIE_TOKEN
        ? {
          username: ACCOUNT.username,
          accountID: ACCOUNT.accountID,
          sessionID: SESSION_ID,
        }
        : null;
    },
    countConfiguredUsers() {
      return 1;
    },
  };
}

function fakeStore(overrides = {}) {
  return {
    async getAccount(username) {
      return username === ACCOUNT.username ? { ...ACCOUNT } : null;
    },
    // Default: the gateway refuses auto-create (devAutoCreateAccounts off), so
    // unknown usernames keep their clear 401. Tests that want the R2
    // auto-create behavior override this with a creating store.
    async createAccount() {
      throw Object.assign(new gatewayClient.EveGatewayError(
        "Account auto-create is disabled (devAutoCreateAccounts is off).",
        { code: "ACCOUNT_CREATE_DISABLED", statusCode: 403 },
      ));
    },
    async listCharactersForAccount(accountID) {
      return Number(accountID) === ACCOUNT.accountID
        ? CHARACTERS.map((character) => ({ ...character }))
        : [];
    },
    ...overrides,
  };
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway || {},
    webAuth: fakeAuth(),
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
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  for (const name of ENV_NAMES) {
    if (ORIGINAL_ENV[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = ORIGINAL_ENV[name];
    }
  }
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }));
  }
  await Promise.all(closing);
});

test("gateway callMethod posts the retail call tuple and session fields to /call", async () => {
  process.env.EVEJS_GATEWAY_URL = "http://gateway.test/_evejs-web/v1";
  process.env.EVEJS_WEB_GATEWAY_TOKEN = "server-secret";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, gatewayResponse({
      service: "charUnboundMgr",
      method: "GetCharacterSelectionData",
      result: SELECTION_TUPLE,
      notifications: [],
    }));
  };

  const outcome = await gatewayClient.callMethod(
    "charUnboundMgr",
    "GetCharacterSelectionData",
    [],
    null,
    { userid: 4 },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gateway.test/_evejs-web/v1/call");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-evejs-web-token"], "server-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    service: "charUnboundMgr",
    method: "GetCharacterSelectionData",
    args: [],
    kwargs: null,
    session: { userid: 4 },
  });
  assert.deepEqual(outcome, {
    service: "charUnboundMgr",
    method: "GetCharacterSelectionData",
    result: SELECTION_TUPLE,
    notifications: [],
  });
});

test("gateway callMethod surfaces bridge refusals as typed gateway errors", async () => {
  process.env.EVEJS_GATEWAY_URL = "http://gateway.test/_evejs-web/v1";
  global.fetch = async () => jsonResponse(403, {
    ok: false,
    source: "evejs-web-gateway",
    apiVersion: 1,
    error: "CALL_NOT_ALLOWED",
    message: "charUnboundMgr.DeleteCharacter is not on the web-call allowlist.",
  });

  await assert.rejects(
    gatewayClient.callMethod("charUnboundMgr", "DeleteCharacter", [], null, { userid: 4 }),
    (error) => {
      assert.equal(error.name, "EveGatewayError");
      assert.equal(error.code, "CALL_NOT_ALLOWED");
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
});

test("gateway createAccount posts the username to /account/create", async () => {
  process.env.EVEJS_GATEWAY_URL = "http://gateway.test/_evejs-web/v1";
  process.env.EVEJS_WEB_GATEWAY_TOKEN = "server-secret";
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(200, gatewayResponse({
      account: { username: "fresh-capsuleer", accountID: 9, role: "0", banned: false },
      created: true,
    }));
  };

  const outcome = await gatewayClient.createAccount("  fresh-capsuleer  ");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gateway.test/_evejs-web/v1/account/create");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["x-evejs-web-token"], "server-secret");
  assert.deepEqual(JSON.parse(calls[0].options.body), { username: "fresh-capsuleer" });
  assert.equal(outcome.created, true);
  assert.equal(outcome.account.accountID, 9);
});

test("gateway createAccount surfaces the disabled refusal as a typed error", async () => {
  process.env.EVEJS_GATEWAY_URL = "http://gateway.test/_evejs-web/v1";
  global.fetch = async () => jsonResponse(403, {
    ok: false,
    source: "evejs-web-gateway",
    apiVersion: 1,
    error: "ACCOUNT_CREATE_DISABLED",
    message: "Account auto-create is disabled (devAutoCreateAccounts is off).",
  });

  await assert.rejects(
    gatewayClient.createAccount("someone"),
    (error) => {
      assert.equal(error.name, "EveGatewayError");
      assert.equal(error.code, "ACCOUNT_CREATE_DISABLED");
      assert.equal(error.statusCode, 403);
      return true;
    },
  );
});

test("login accepts an existing account with a wrong or empty password", async () => {
  const { baseUrl } = await startTestServer();
  for (const password of ["definitely-not-the-web-password", ""]) {
    const { response, payload } = await apiRequest(baseUrl, "/api/login", {
      method: "POST",
      authenticated: false,
      body: { username: ACCOUNT.username, password },
    });
    assert.equal(response.status, 200, `password=${JSON.stringify(password)}`);
    assert.equal(payload.ok, true);
    assert.equal(payload.account.username, "pilot");
    assert.equal(payload.account.accountID, 4);
    // R2: an existing account's login never claims to have minted it.
    assert.equal(payload.accountCreated, false);
    assert.equal(payload.characters.length, 1);
    assert.equal(payload.characters[0].characterName, "Test Pilot");
    const setCookie = response.headers.get("set-cookie") || "";
    assert.match(setCookie, /evejs_web_poc=/);
  }
});

test("login without any password field still signs in", async () => {
  const { baseUrl } = await startTestServer();
  const { response, payload } = await apiRequest(baseUrl, "/api/login", {
    method: "POST",
    authenticated: false,
    body: { username: ACCOUNT.username },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
});

test("unknown usernames keep their 401 while the gateway refuses auto-create", async () => {
  const notFoundError = Object.assign(
    new gatewayClient.EveGatewayError("Account was not found.", {
      code: "ACCOUNT_NOT_FOUND",
      statusCode: 404,
    }),
  );
  // Both miss shapes (null and a 404 throw), and in both cases the default
  // fake store's createAccount refuses with ACCOUNT_CREATE_DISABLED — the
  // pre-R2 unknown-account behavior survives when the server flag is off.
  const stores = [
    fakeStore(),
    fakeStore({
      async getAccount() {
        throw notFoundError;
      },
    }),
  ];
  for (const store of stores) {
    const { baseUrl } = await startTestServer({ store });
    const { response, payload } = await apiRequest(baseUrl, "/api/login", {
      method: "POST",
      authenticated: false,
      body: { username: "no-such-account", password: "anything" },
    });
    assert.equal(response.status, 401);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, "UNKNOWN_EVEJS_ACCOUNT");
    assert.equal(payload.message, "Unknown EveJS account.");
  }
});

test("an unknown username auto-creates an account and signs straight in (R2)", async () => {
  const created = {
    username: "fresh-capsuleer",
    accountID: 9,
    role: "0",
    banned: false,
  };
  const calls = [];
  const store = fakeStore({
    async createAccount(username) {
      calls.push(username);
      return { account: { ...created }, created: true };
    },
  });
  const { baseUrl } = await startTestServer({ store });
  const { response, payload } = await apiRequest(baseUrl, "/api/login", {
    method: "POST",
    authenticated: false,
    body: { username: "fresh-capsuleer", password: "" },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.accountCreated, true);
  assert.equal(payload.account.username, "fresh-capsuleer");
  assert.equal(payload.account.accountID, 9);
  // A minted account has no characters yet — the client lands on the
  // create-character flow.
  assert.deepEqual(payload.characters, []);
  assert.match(response.headers.get("set-cookie") || "", /evejs_web_poc=/);
  assert.deepEqual(calls, ["fresh-capsuleer"]);
});

test("a login that loses the create race still signs in without claiming creation", async () => {
  // The gateway answers an existing username with created:false; the login
  // proceeds as an ordinary sign-in.
  const store = fakeStore({
    async getAccount() {
      return null;
    },
    async createAccount() {
      return { account: { ...ACCOUNT }, created: false };
    },
  });
  const { baseUrl } = await startTestServer({ store });
  const { response, payload } = await apiRequest(baseUrl, "/api/login", {
    method: "POST",
    authenticated: false,
    body: { username: ACCOUNT.username, password: "" },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.accountCreated, false);
  assert.equal(payload.account.accountID, ACCOUNT.accountID);
});

test("login surfaces gateway-invalid usernames as a 400, not an unknown-account 401", async () => {
  const store = fakeStore({
    async createAccount() {
      throw Object.assign(new gatewayClient.EveGatewayError(
        "Account username must be 1-64 characters of letters, digits, _ . @ or -.",
        { code: "ACCOUNT_INVALID", statusCode: 400 },
      ));
    },
  });
  const { baseUrl } = await startTestServer({ store });
  const { response, payload } = await apiRequest(baseUrl, "/api/login", {
    method: "POST",
    authenticated: false,
    body: { username: "bad/name", password: "" },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "ACCOUNT_INVALID");
});

test("an empty username is refused without consulting the store", async () => {
  const store = fakeStore({
    async getAccount() {
      throw new Error("getAccount must not be called for an empty username");
    },
    async createAccount() {
      throw new Error("createAccount must not be called for an empty username");
    },
  });
  const { baseUrl } = await startTestServer({ store });
  const { response, payload } = await apiRequest(baseUrl, "/api/login", {
    method: "POST",
    authenticated: false,
    body: { username: "   ", password: "x" },
  });
  assert.equal(response.status, 401);
  assert.equal(payload.error, "UNKNOWN_EVEJS_ACCOUNT");
});

test("banned accounts cannot use the who-cares login", async () => {
  const store = fakeStore({
    async getAccount() {
      return { ...ACCOUNT, banned: true };
    },
  });
  const { baseUrl } = await startTestServer({ store });
  const { response, payload } = await apiRequest(baseUrl, "/api/login", {
    method: "POST",
    authenticated: false,
    body: { username: ACCOUNT.username, password: "" },
  });
  assert.equal(response.status, 403);
  assert.equal(payload.error, "ACCOUNT_BANNED");
});

test("the bridge route forwards the call tuple and pins userid to the signed session", async () => {
  const calls = [];
  const gateway = {
    async callMethod(service, method, args, kwargs, sessionFields) {
      calls.push({ service, method, args, kwargs, sessionFields });
      return {
        service,
        method,
        result: SELECTION_TUPLE,
        notifications: [],
      };
    },
  };
  const { baseUrl } = await startTestServer({ gateway });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST",
    body: {
      service: "charUnboundMgr",
      method: "GetCharacterSelectionData",
      args: [],
      kwargs: null,
      // Only presentation preferences survive. Identity, authority and
      // gameplay-location fields are either pinned or held server-side.
      session: {
        userid: 999999,
        userName: "spoofed-admin",
        charid: 123,
        stationid: 60003760,
        roles: Number.MAX_SAFE_INTEGER,
        languageID: "EN",
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "charUnboundMgr");
  assert.equal(payload.method, "GetCharacterSelectionData");
  assert.deepEqual(payload.result, SELECTION_TUPLE);
  assert.deepEqual(payload.notifications, []);
  assert.deepEqual(calls, [{
    service: "charUnboundMgr",
    method: "GetCharacterSelectionData",
    args: [],
    kwargs: null,
    sessionFields: { languageID: "EN", userid: ACCOUNT.accountID },
  }]);
});

test("the generic bridge route refuses write pairs even when the browser supplies confirm", async () => {
  const gateway = {
    async callMethod() {
      assert.fail("write-classified calls must be refused before gateway dispatch");
    },
  };
  const { baseUrl } = await startTestServer({ gateway });
  const writes = [
    ["marketProxy", "PlaceBuyOrder"],
    ["mailMgr", "DeleteMail"],
    ["repairSvc", "RepairItems"],
    ["officeManager", "RentOffice"],
  ];

  for (const [service, method] of writes) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", {
      method: "POST",
      body: { service, method, args: [], kwargs: null, confirm: true },
    });
    assert.equal(response.status, 403, `${service}.${method}`);
    assert.equal(payload.error, "BRIDGE_WRITE_REQUIRES_DEDICATED_ROUTE");
  }
});

test("the bridge route requires an authenticated web session", async () => {
  const { baseUrl } = await startTestServer({
    gateway: {
      async callMethod() {
        assert.fail("unauthenticated requests must not reach the gateway client");
      },
    },
  });
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST",
    authenticated: false,
    body: { service: "charUnboundMgr", method: "GetCharacterSelectionData" },
  });
  assert.equal(response.status, 401);
  assert.equal(payload.error, "AUTH_REQUIRED");
});

test("bridge refusals and gateway errors pass through with their stable codes", async () => {
  const cases = [
    ["CALL_NOT_ALLOWED", 403],
    ["CALL_INVALID", 400],
    ["CALL_SERVICE_UNAVAILABLE", 503],
    ["CALL_FAILED", 502],
    ["EVE_GATEWAY_UNREACHABLE", 502],
  ];
  for (const [code, statusCode] of cases) {
    const gateway = {
      async callMethod() {
        throw new gatewayClient.EveGatewayError(`failed: ${code}`, {
          code,
          statusCode,
        });
      },
    };
    const { baseUrl } = await startTestServer({ gateway });
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/call", {
      method: "POST",
      body: { service: "charUnboundMgr", method: "GetCharacterSelectionData" },
    });
    assert.equal(response.status, statusCode, code);
    assert.equal(payload.ok, false, code);
    assert.equal(payload.error, code, code);
  }
});
