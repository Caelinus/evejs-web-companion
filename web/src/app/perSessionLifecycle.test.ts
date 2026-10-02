import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { BridgeCallError } from "../bridge/callMethod.ts";
import { fittingBody, flightBody, holdsBody, namesBody, spaceBody } from "./botFixtures.ts";
import { clearSessionToken, getSessionToken, setSessionToken } from "./sessionToken.ts";
import { logout } from "./api.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const miningRequest = {
  beltID: 40000123, beltName: "Belt", stationID: 60003760, stationName: "Station",
  miningModuleIDs: [7001], healthFloor: 0.5, useDrones: false,
};

function harness(override: (path: string, body: Record<string, unknown>) => Promise<Response> | Response | undefined) {
  const store = createClientStore();
  const character = (characterID: number) => ({ characterID, characterName: "Pilot", stationID: null, structureID: null,
    solarSystemID: 30000142, corporationID: 98000000 });
  store.apply({ type: "session/logged-in", accountID: 4001, username: "pilot", accountCreated: false });
  store.apply({ type: "character/online", character: character(42), station: null });
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const overridden = override(path, body);
    if (overridden) return overridden;
    if (path === "/api/bridge/select") return response({ ok: true, character: character(body.characterID), station: null });
    if (path === "/api/bridge/flight/status") return response(flightBody(false));
    if (path === "/api/bridge/space/snapshot") return response(spaceBody());
    if (path === "/api/bridge/fitting") return response(fittingBody());
    if (path === "/api/bridge/ship/ore-hold") return response(holdsBody(0, []));
    if (path === "/api/names") return response(namesBody(body));
    if (path === "/api/bridge/call") return response({ ok: true, service: body.service, method: body.method,
      result: body.method === "GetStationItemBits" ? [1, 60003760, 26, 1529]
        : body.method === "GetGuests" ? { type: "list", items: [] } : null });
    return response({ ok: true });
  }) as typeof fetch;
  const flow = createAppFlow(store, { fetch: fetcher, perSessionToken: true, initialSessionToken: "token-pilot", livePush: false });
  return { flow, store };
}

for (const outcome of ["refused", "ambiguous"] as const) {
  test(`${outcome} logout stops automation before release and retains pilot ownership`, async () => {
    const close = deferred<Response>();
    let closeSawStopped = false;
    const { flow, store } = harness(path => {
      if (path !== "/api/logout") return;
      closeSawStopped = store.bot.get().status === "stopped";
      if (outcome === "ambiguous") return Promise.reject(new Error("connection reset"));
      return close.promise;
    });
    await flow.startMiningBot(miningRequest);
    assert.equal(store.bot.get().status, "running");
    const logout = flow.logout();
    const rejected = assert.rejects(logout, outcome === "refused" ? /HTTP 409/ : /connection reset/);
    assert.equal(closeSawStopped, true);
    assert.throws(() => flow.resumeMiningBot(), /released/);
    if (outcome === "refused") close.resolve(response({ ok: false, error: "RELEASE_REFUSED" }, 409));
    await rejected;
    assert.equal(flow.sessionToken(), "token-pilot");
    assert.equal(store.station.get().online?.characterID, 42);
    assert.equal(store.bot.get().status, "stopped");
    flow.stopMiningBot();
  });
}

test("logout cancels a pending mining preflight before it can start a controller", async () => {
  const flight = deferred<Response>();
  const { flow, store } = harness(path => path === "/api/bridge/flight/status" ? flight.promise : undefined);
  const start = flow.startMiningBot(miningRequest);
  await flow.logout();
  flight.resolve(response(flightBody(false)));
  await start;
  assert.equal(flow.sessionToken(), null);
  assert.notEqual(store.bot.get().status, "running");
});

test("cancelling a pending login cleans up only its returned token and never selects a pilot", async () => {
  const login = deferred<Response>();
  const releasedTokens: string[] = [];
  const store = createClientStore();
  const flow = createAppFlow(store, { perSessionToken: true, livePush: false, fetch: (async (input, init) => {
    if (String(input) === "/api/login") return login.promise;
    if (String(input) === "/api/logout") {
      releasedTokens.push((init?.headers as Record<string, string>).authorization ?? "");
      return response({ ok: true });
    }
    assert.fail(`Cancelled login continued to ${String(input)}`);
  }) as typeof fetch });
  const signingIn = flow.login("pilot", "password");
  const cancelled = assert.rejects(signingIn, /cancelled/);
  await flow.logout();
  login.resolve(response({ ok: true, sessionToken: "token-new", account: { accountID: 4001, username: "pilot" } }));
  await cancelled;
  assert.deepEqual(releasedTokens, ["Bearer token-new"]);
  assert.equal(flow.sessionToken(), null);
  assert.equal(store.session.get().phase, "logged-out");
});

for (const replacement of [null, "another-current-login"]) {
  test(`cancelled legacy login preserves the global identity ${replacement ?? "signed out"}`, async () => {
    clearSessionToken();
    const login = deferred<Response>();
    const cleanup: Array<{ auth: string | undefined; credentials: RequestCredentials | undefined }> = [];
    const store = createClientStore();
    const flow = createAppFlow(store, { livePush: false, fetch: (async (input, init) => {
      if (String(input) === "/api/login") {
        assert.equal(init?.credentials, "omit");
        return login.promise;
      }
      assert.equal(String(input), "/api/logout");
      cleanup.push({ auth: (init?.headers as Record<string, string>).authorization, credentials: init?.credentials });
      return response({ ok: true });
    }) as typeof fetch });
    const cancelled = assert.rejects(flow.login("pilot", "password"), /cancelled/);
    await flow.logout();
    if (replacement) setSessionToken(replacement);
    login.resolve(response({ ok: true, sessionToken: "cancelled-login", account: { accountID: 4001, username: "pilot" } }));
    await cancelled;
    assert.equal(getSessionToken(), replacement);
    assert.equal(store.session.get().phase, "logged-out");
    assert.deepEqual(cleanup.at(-1), { auth: "Bearer cancelled-login", credentials: "omit" });
    clearSessionToken();
  });
}

test("a current legacy flow login publishes its returned token for subsequent calls", async () => {
  clearSessionToken();
  const store = createClientStore();
  const flow = createAppFlow(store, { livePush: false, fetch: (async (input, init) => {
    if (String(input) === "/api/login") return response({ ok: true, sessionToken: "current-login",
      account: { accountID: 4001, username: "pilot" } });
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer current-login");
    return response({ ok: true, service: "charUnboundMgr", method: "GetCharacterSelectionData",
      result: [null, null, { type: "list", items: [] }, null] });
  }) as typeof fetch });
  await flow.login("pilot", "password");
  assert.equal(getSessionToken(), "current-login");
  assert.equal(store.session.get().phase, "logged-in");
  clearSessionToken();
});

for (const outcome of ["refused", "ambiguous"] as const) {
  test(`${outcome} cancelled login cleanup retains its exact credential without replacing a current login`, async () => {
    clearSessionToken();
    const login = deferred<Response>();
    let unverified = true;
    const cleanupTokens: string[] = [];
    const flow = createAppFlow(createClientStore(), { livePush: false, fetch: (async (input, init) => {
      if (String(input) === "/api/login") return login.promise;
      const auth = (init?.headers as Record<string, string>).authorization;
      if (!auth) return response({ ok: true }); // Initial local cancellation.
      cleanupTokens.push(auth);
      assert.equal(init?.credentials, "omit");
      if (unverified) {
        if (outcome === "ambiguous") throw new Error("connection reset");
        return response({ ok: false, error: "PILOT_RELEASE_UNVERIFIED" }, 409);
      }
      return response({ ok: true });
    }) as typeof fetch });
    const pending = flow.login("pilot", "password").catch(error => error);
    await flow.logout();
    setSessionToken("another-current-login");
    login.resolve(response({ ok: true, sessionToken: "cleanup-needed", account: { accountID: 4001, username: "pilot" } }));
    const error = await pending;
    assert.ok(error instanceof BridgeCallError);
    assert.equal(error.code, "CANCELLED_LOGIN_RELEASE_UNVERIFIED");
    assert.equal(error.cancelledSessionToken, "cleanup-needed");
    assert.match(error.message, /Retry releasing/);
    assert.equal(error.status, outcome === "refused" ? 409 : 0);
    assert.equal(getSessionToken(), "another-current-login");
    unverified = false;
    await logout({ ...flow.requestOptions(), token: error.cancelledSessionToken });
    assert.deepEqual(cleanupTokens, ["Bearer cleanup-needed", "Bearer cleanup-needed"]);
    assert.equal(getSessionToken(), "another-current-login");
    clearSessionToken();
  });
}

test("a replaced pilot's late refusal cannot blank the new pilot's corp panel or mark it offline", async () => {
  const corp = deferred<Response>();
  const { flow, store } = harness(path => path === "/api/bridge/inventory/corp" ? corp.promise : undefined);
  const loading = flow.loadCorpHangar();
  const retired = assert.rejects(loading, error => error instanceof BridgeCallError && error.code === "SESSION_REQUEST_RETIRED");
  await flow.selectCharacter(43);
  store.apply({ type: "inventory/corp-loaded", available: true, reason: null, divisions: [] });
  corp.resolve(response({ ok: false, error: "SESSION_NOT_FOUND" }, 404));
  await retired;
  assert.equal(store.station.get().online?.characterID, 43);
  assert.equal(store.inventory.get().corp.available, true);
  assert.equal(store.inventory.get().corp.reason, null);
});

test("a refused pilot switch keeps the previous pilot's pending reads valid", async () => {
  const corp = deferred<Response>();
  const { flow, store } = harness(path => path === "/api/bridge/inventory/corp" ? corp.promise
    : path === "/api/bridge/select" ? response({ ok: false, error: "SELECT_REFUSED" }, 409) : undefined);
  const loading = flow.loadCorpHangar();
  await assert.rejects(flow.selectCharacter(43), /HTTP 409/);
  corp.resolve(response({ ok: true, available: true, reason: null, divisions: [] }));
  await loading;
  assert.equal(store.station.get().online?.characterID, 42);
  assert.equal(store.inventory.get().corp.available, true);
});
