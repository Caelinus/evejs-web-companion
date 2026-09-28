"use strict";

// Goal R10: the BFF's live event channel. The BFF holds at most ONE gateway
// push WebSocket per held bridge session and republishes it to the browser as
// Server-Sent Events on GET /api/bridge/events (same-origin, cookie-authed,
// routed to the web session's own held bridge session).
//
// What these cover: the route requires a live session; the stream is opened
// lazily and shared by concurrent subscribers (never one socket per browser);
// frames reach the browser as SSE; the last cursor is remembered so a gateway
// reconnect resumes from it; a dropped gateway socket is announced so the page
// falls back to polling and is then retried; and releasing the session tears
// everything down. The bridgeSessionID never appears in anything the browser
// receives. Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";

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
    async getCharacterForAccount(accountID, characterID) {
      return Number(accountID) === ACCOUNT.accountID && Number(characterID) === 7
        ? { characterID: 7, accountID: 4, characterName: "Test Pilot" }
        : null;
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
  };
}

// A gateway whose push stream is driven by the test: each openSessionEventStream
// records how it was opened and exposes the handlers so the test can emit
// frames and simulate drops.
function fakeGateway() {
  const streams = [];
  return {
    streams,
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: 4,
          characterID: 7,
          characterName: "Test Pilot",
          stationID: 60003760,
          structureID: null,
          solarSystemID: 30000142,
          corporationID: 98000000,
          shipID: 9001,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: 7 };
    },
    openSessionEventStream(options) {
      const stream = {
        options,
        closed: false,
        emit(frame) {
          options.onFrame(frame);
        },
        open() {
          if (typeof options.onOpen === "function") {
            options.onOpen();
          }
        },
        drop(details = {}) {
          options.onClose(details);
        },
        close() {
          stream.closed = true;
        },
      };
      streams.push(stream);
      return stream;
    },
  };
}

async function startTestServer(gateway) {
  const app = createApp({
    eveStore: fakeStore(),
    eveGatewayClient: gateway,
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  return ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
}

async function selectOnServer(baseUrl) {
  await apiRequest(baseUrl, "/api/bridge/select", {
    method: "POST",
    body: { characterID: 7 },
  });
}

/** Open the SSE route and decode `data:` payloads as they arrive. */
async function openEventStream(baseUrl) {
  const controller = new AbortController();
  const response = await apiRequest(baseUrl, "/api/bridge/events", {
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = "";
  let done = false;

  const pump = (async () => {
    try {
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) {
              frames.push(JSON.parse(line.slice(6)));
            }
          }
          index = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborting the request is the normal way this ends.
    }
  })();

  return {
    response,
    frames,
    async waitForFrames(count) {
      const deadline = Date.now() + 2000;
      while (frames.length < count) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${count} SSE frame(s); saw ${JSON.stringify(frames)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return frames;
    },
    async close() {
      done = true;
      // Cancel the reader first: aborting alone leaves the socket lingering,
      // which delays the server's "browser detached" handling.
      try {
        await reader.cancel();
      } catch {
        // Already ended.
      }
      controller.abort();
      await pump;
    },
  };
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    closing.push(new Promise((resolve) => server.close(resolve)));
    // An SSE response deliberately holds its socket open, and server.close()
    // waits for open connections — drop them so teardown is immediate.
    server.closeAllConnections();
  }
  activeServers.clear();
  await Promise.all(closing);
});

test("the event stream requires a live bridge session", async () => {
  const { baseUrl } = await startTestServer(fakeGateway());
  const response = await apiRequest(baseUrl, "/api/bridge/events");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "NO_LIVE_SESSION");
});

test("the event stream requires authentication", async () => {
  const { baseUrl } = await startTestServer(fakeGateway());
  const response = await apiRequest(baseUrl, "/api/bridge/events", {
    authenticated: false,
  });
  assert.equal(response.status, 401);
});

test("attaching opens ONE gateway stream, keyed to the held session, and serves SSE", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const client = await openEventStream(baseUrl);
  assert.match(
    client.response.headers.get("content-type") || "",
    /text\/event-stream/,
  );

  await client.waitForFrames(1);
  assert.equal(gateway.streams.length, 1, "exactly one gateway stream per held session");
  // Keyed to the server-held handle and the signed-in account, not anything the
  // browser supplied.
  assert.equal(gateway.streams[0].options.bridgeSessionID, BRIDGE_SESSION_ID);
  assert.equal(gateway.streams[0].options.userid, ACCOUNT.accountID);
  assert.equal(gateway.streams[0].options.cursor, null);

  gateway.streams[0].open();
  gateway.streams[0].emit({
    source: "evejs-web-gateway",
    type: "event",
    cursor: { epoch: "e1", sequence: 1 },
    event: { kind: "chat", channel: "local", entry: { message: "hi" } },
  });

  const frames = await client.waitForFrames(3);
  const chat = frames.find((f) => f.type === "event");
  assert.ok(chat, `expected a forwarded gateway frame; saw ${JSON.stringify(frames)}`);
  assert.equal(chat.event.event ?? chat.event.kind, "chat");
  assert.equal(chat.event.entry.message, "hi");

  // The opaque handle never reaches the browser.
  assert.ok(
    !JSON.stringify(frames).includes(BRIDGE_SESSION_ID),
    "the bridgeSessionID must never appear in anything the browser receives",
  );
  await client.close();
});

test("two browsers on one web session share a single gateway stream", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const first = await openEventStream(baseUrl);
  await first.waitForFrames(1);
  const second = await openEventStream(baseUrl);
  await second.waitForFrames(1);

  assert.equal(gateway.streams.length, 1, "the gateway socket is shared, not duplicated");

  gateway.streams[0].emit({
    source: "evejs-web-gateway",
    type: "event",
    cursor: { epoch: "e1", sequence: 4 },
    event: { kind: "notification", notification: { kind: "service" } },
  });
  await first.waitForFrames(2);
  await second.waitForFrames(2);

  // Both browsers saw it; closing one leaves the other's stream alive.
  await first.close();
  gateway.streams[0].emit({
    source: "evejs-web-gateway",
    type: "event",
    cursor: { epoch: "e1", sequence: 5 },
    event: { kind: "notification", notification: { kind: "client" } },
  });
  const frames = await second.waitForFrames(3);
  assert.equal(frames.at(-1).cursor.sequence, 5);
  assert.equal(gateway.streams[0].closed, false);

  await second.close();
});

test("the last browser detaching closes the gateway stream", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const client = await openEventStream(baseUrl);
  await client.waitForFrames(1);
  await client.close();

  // The abort has to reach the server before the assertion.
  const deadline = Date.now() + 2000;
  while (!gateway.streams[0].closed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(
    gateway.streams[0].closed,
    true,
    "a held session with nobody watching must not keep a gateway socket open",
  );
});

test("a dropped gateway stream is announced, then retried with the last cursor", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const client = await openEventStream(baseUrl);
  await client.waitForFrames(1);
  gateway.streams[0].emit({
    source: "evejs-web-gateway",
    type: "event",
    cursor: { epoch: "e1", sequence: 9 },
    event: { kind: "notification", notification: { kind: "service" } },
  });
  await client.waitForFrames(2);

  gateway.streams[0].drop({ code: 1006, reason: "socket lost" });

  // The browser is told the channel degraded so it leans on its poll.
  const frames = await client.waitForFrames(3);
  const status = frames.at(-1);
  assert.equal(status.source, "evejs-web-bff");
  assert.equal(status.type, "stream-status");
  assert.equal(status.state, "degraded");

  // ...and the BFF reconnects from the cursor it last saw, so the gateway can
  // replay exactly what was missed during the gap.
  const deadline = Date.now() + 5000;
  while (gateway.streams.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(gateway.streams.length, 2, "the dropped stream must be retried");
  assert.deepEqual(gateway.streams[1].options.cursor, { epoch: "e1", sequence: 9 });

  await client.close();
});

test("a gateway 404 ends the channel instead of retrying forever", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const client = await openEventStream(baseUrl);
  await client.waitForFrames(1);
  // The gateway no longer knows this bridge session; retrying cannot fix that.
  gateway.streams[0].drop({ code: 1006, reason: "refused", refusalStatus: 404 });

  const frames = await client.waitForFrames(2);
  assert.equal(frames.at(-1).state, "ended");
  assert.equal(frames.at(-1).detail, "session_not_found");

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(gateway.streams.length, 1, "an ended channel must not be retried");

  await client.close();
});

test("releasing the session ends the channel and closes the gateway stream", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer(gateway);
  await selectOnServer(baseUrl);

  const client = await openEventStream(baseUrl);
  await client.waitForFrames(1);

  await apiRequest(baseUrl, "/api/bridge/release", { method: "POST", body: {} });

  const frames = await client.waitForFrames(2);
  assert.equal(frames.at(-1).state, "ended");
  assert.equal(gateway.streams[0].closed, true);

  await client.close();
});
