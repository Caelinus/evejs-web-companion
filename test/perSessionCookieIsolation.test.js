"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const originalDataDir = process.env.EVEJS_WEB_POC_DATA_DIR;
const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-cookie-isolation-"));
process.env.EVEJS_WEB_POC_DATA_DIR = temporaryDataDir;
const { createApp } = require("../src/server");

test.after(() => {
  if (originalDataDir === undefined) delete process.env.EVEJS_WEB_POC_DATA_DIR;
  else process.env.EVEJS_WEB_POC_DATA_DIR = originalDataDir;
  assert.equal(path.dirname(path.resolve(temporaryDataDir)), path.resolve(os.tmpdir()));
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
});

test("cancelling a tokenless slot cannot release the ready pilot in the browser cookie", async () => {
  const { createClientStore } = await import("../web/src/store/clientStore.ts");
  const { createAppFlow } = await import("../web/src/app/flow.ts");
  const api = await import("../web/src/app/api.ts");
  const { callMethod } = await import("../web/src/bridge/callMethod.ts");
  const released = [];
  const held = new Map([["pilot-a", {
    bridgeSessionID: "bridge-a", characterID: 7001, accountID: 4001,
    droneRecoveryReady: true, stream: null, streamSubscribers: new Set(), streamRetryTimer: null, chat: null,
  }]]);
  const app = createApp({
    eveStore: { async getAccount() { return { username: "pilot-a", accountID: 4001 }; } },
    webAuth: { verifySessionToken(token) {
      return token === "token-a" ? { username: "pilot-a", accountID: 4001, sessionID: "pilot-a" } : null;
    } },
    bridgeSessionStore: held,
    eveGatewayClient: { async releaseBridgeSession(id) { released.push(id); return { released: true }; } },
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Node fetch has no browser cookie jar. Emulate the browser's credentials
  // contract, including the cookie that would be present in an existing tab.
  const browserFetch = (url, init) => fetch(url, {
    ...init,
    headers: { ...init.headers, ...(init.credentials === "omit" ? {} : { cookie: "evejs_web_poc=token-a" }) },
  });
  try {
    const flow = createAppFlow(createClientStore(), { perSessionToken: true, livePush: false, baseUrl, fetch: browserFetch });
    await flow.logout();
    for (const request of [
      () => api.logout({ baseUrl, fetch: browserFetch, token: null }),
      () => api.loadCorpHangar({ baseUrl, fetch: browserFetch, token: null }),
      () => callMethod("map", "GetStationInfo", [], null, { baseUrl, fetch: browserFetch, token: null }),
    ]) await assert.rejects(request(), error => error.status === 401);
    assert.equal(held.has("pilot-a"), true);
    assert.deepEqual(released, []);
    // Prove the fixture still allows A's owner to release A deliberately.
    await api.logout({ baseUrl, fetch: browserFetch, token: "token-a" });
    assert.equal(held.has("pilot-a"), false);
    assert.deepEqual(released, ["bridge-a"]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
