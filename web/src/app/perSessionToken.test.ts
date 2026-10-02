// Goal R107 (multibox in ONE tab): several live characters share a single
// browser tab, so a per-tab global token is no longer enough — each flow must
// carry its OWN session token on every call. The contract is opt-in and keyed
// on the PRESENCE of the `token` option, so the single-session path (main.ts,
// every pre-R107 test) is untouched; sessionToken.test.ts still covers that.
//
// What these cover: per-session login captures its token WITHOUT writing the
// per-tab global; per-session calls carry that token and never leak onto the
// global/cookie even when a different global is set; a per-session `token:null`
// sends no header (no fallback); the SSE URL carries the per-session token;
// logout leaves the global alone; and — the actual feature — two flows in one
// realm reach the BFF as two different identities.

import test from "node:test";
import assert from "node:assert/strict";

import { login, logout, subscribeBridgeEvents } from "./api.ts";
import * as api from "./api.ts";
import { callMethod } from "../bridge/callMethod.ts";
import { BridgeCallError } from "../bridge/callMethod.ts";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { bridgeLane } from "./transport.ts";
import {
  clearSessionToken,
  getSessionToken,
  setSessionToken,
  setSessionTokenStorage,
  type SessionTokenStorage,
} from "./sessionToken.ts";

function makeStorage(): SessionTokenStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly credentials: RequestCredentials | undefined;
}

/** A stub fetch that answers per URL and records the headers each call carried. */
function stubFetch(
  respond: (url: string) => unknown,
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers as Record<string, string> | undefined) ?? {},
    )) {
      headers[key.toLowerCase()] = value;
    }
    const url = String(input);
    requests.push({ url, headers, credentials: init?.credentials });
    return new Response(JSON.stringify(respond(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchStub, requests };
}

/** The bodies the BFF returns for a flow whose login mints `token`. */
function bffResponses(token: string) {
  return (url: string): unknown => {
    if (url.endsWith("/api/login")) {
      return {
        ok: true,
        sessionToken: token,
        account: { accountID: 4001, username: "farmer" },
        characters: [],
      };
    }
    if (url.endsWith("/api/bridge/call")) {
      // A valid, empty GetCharacterSelectionData 4-tuple so flow.login resolves.
      return {
        ok: true,
        service: "charUnboundMgr",
        method: "GetCharacterSelectionData",
        result: [null, null, { type: "list", items: [] }, null],
        notifications: [],
      };
    }
    return { ok: true };
  };
}

test.beforeEach(() => {
  setSessionTokenStorage(makeStorage());
});

test.after(() => {
  setSessionTokenStorage(null);
  clearSessionToken();
});

test("per-session login captures its token and does NOT write the per-tab global", async () => {
  const { fetch } = stubFetch(() => ({
    ok: true,
    sessionToken: "signed.per-session",
    account: { accountID: 4001, username: "farmer" },
  }));

  // The `token` key present (even as null) selects per-session mode.
  const result = await login("farmer", "anything", { token: null, fetch });

  assert.equal(result.sessionToken, "signed.per-session", "login returns the token to the caller");
  assert.equal(result.username, "farmer");
  assert.equal(getSessionToken(), null, "the per-tab global must stay empty in per-session mode");
});

test("a per-session call carries ITS token and never the global, even when a global is set", async () => {
  // A different account owns the global; a per-session call must ignore it.
  setSessionToken("global.someone-else");
  const { fetch, requests } = stubFetch(() => ({ ok: true, character: null, station: null }));

  await api.selectCharacter(7001, { token: "signed.mine", fetch });
  await api.loadCorpHangar({ token: "signed.mine", fetch });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.headers.authorization, "Bearer signed.mine", `${request.url}`);
    assert.equal(request.credentials, "omit", "explicit sessions must also omit the shared browser cookie");
  }
});

test("a per-session token:null sends NO header — it does not fall back to the global", async () => {
  setSessionToken("global.someone-else");
  const { fetch, requests } = stubFetch(() => ({ ok: true }));

  await api.loadCorpHangar({ token: null, fetch });
  await callMethod("map", "GetStationInfo", [], null, { token: null, fetch }).catch(() => {});

  for (const request of requests) {
    assert.equal(request.credentials, "omit");
    assert.equal(
      "authorization" in request.headers,
      false,
      `${request.url} must send no auth header, not the global`,
    );
  }
});

test("legacy calls retain same-origin cookies while explicit bridge calls omit them", async () => {
  const { fetch, requests } = stubFetch(() => ({ ok: true, service: "map", method: "GetStationInfo", result: null }));
  await api.loadCorpHangar({ fetch });
  await callMethod("map", "GetStationInfo", [], null, { fetch, token: "signed.mine" });
  assert.equal(requests[0]?.credentials, "same-origin");
  assert.equal(requests[1]?.credentials, "omit");
});

test("a queued request keeps the identity it had when it was made", async () => {
  const release: Array<() => void> = [];
  const blockers = Array.from({ length: 4 }, () => bridgeLane.run("read", "block", () =>
    new Promise<void>(resolve => release.push(resolve))));
  const { fetch, requests } = stubFetch(() => ({ ok: true }));
  const options = { fetch, token: "signed.mine" };
  const queued = api.loadCorpHangar(options);
  options.token = "signed.other";
  release.forEach(resolve => resolve());
  await Promise.all([...blockers, queued]);
  assert.equal(requests[0]?.headers.authorization, "Bearer signed.mine");
});

test("retiring a session rejects queued dispatch and late bridge replies", async () => {
  let generation = 0;
  const captureRequestGuard = () => {
    const current = generation;
    return () => { if (current !== generation) throw new BridgeCallError("SESSION_REQUEST_RETIRED", "retired", 0); };
  };
  const release: Array<() => void> = [];
  const blockers = Array.from({ length: 4 }, () => bridgeLane.run("read", "block", () =>
    new Promise<void>(resolve => release.push(resolve))));
  const { fetch, requests } = stubFetch(() => ({ ok: true }));
  const queued = api.loadCorpHangar({ fetch, token: "signed.mine", captureRequestGuard });
  const rejected = assert.rejects(queued, error => error instanceof BridgeCallError && error.code === "SESSION_REQUEST_RETIRED");
  const queuedCall = callMethod("map", "GetStationInfo", [], null, { fetch, token: "signed.mine", captureRequestGuard });
  const rejectedCall = assert.rejects(queuedCall, error => error instanceof BridgeCallError && error.code === "SESSION_REQUEST_RETIRED");
  generation++;
  release.forEach(resolve => resolve());
  await Promise.all([...blockers, rejected, rejectedCall]);
  assert.equal(requests.length, 0, "a retired request must never dispatch");

  let finish!: (response: Response) => void;
  const pending = callMethod("map", "GetStationInfo", [], null, {
    token: "signed.mine", captureRequestGuard,
    fetch: (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof globalThis.fetch,
  });
  const late = assert.rejects(pending, /retired/);
  generation++;
  finish(new Response(JSON.stringify({ ok: true, service: "map", method: "GetStationInfo", result: null })));
  await late;
});

test("a tokenless per-session stream never opens through the browser cookie", () => {
  let opened = false;
  subscribeBridgeEvents({ onFrame() {} }, { token: null, eventSource: () => {
    opened = true;
    return { onmessage: null, onopen: null, onerror: null, close() {} };
  } }).close();
  assert.equal(opened, false);
});

test("the SSE stream URL carries the per-session token, not the global", () => {
  setSessionToken("global.someone-else");
  const opened: string[] = [];
  subscribeBridgeEvents(
    { onFrame() {} },
    {
      token: "signed.mine",
      eventSource: (url) => {
        opened.push(url);
        return { onmessage: null, onopen: null, onerror: null, close() {} };
      },
    },
  ).close();

  const url = new URL(opened[0] as string, "http://bff.test");
  assert.equal(url.searchParams.get("access_token"), "signed.mine");
});

test("per-session logout leaves the per-tab global untouched", async () => {
  setSessionToken("global.someone-else");
  const { fetch } = stubFetch(() => ({ ok: true }));

  await logout({ token: "signed.mine", fetch });

  assert.equal(getSessionToken(), "global.someone-else", "per-session logout must not clear the global");
});

test("two per-session flows in one realm reach the BFF as two DIFFERENT identities", async () => {
  // The actual feature, at the flow level: two flows built with
  // perSessionToken, two logins minting two tokens, one shared module global
  // that STAYS EMPTY — and each flow's bridge call carrying its own token.
  const farmer = stubFetch(bffResponses("token-farmer"));
  const second = stubFetch(bffResponses("token-second"));

  const farmerFlow = createAppFlow(createClientStore(), { perSessionToken: true, fetch: farmer.fetch });
  const secondFlow = createAppFlow(createClientStore(), { perSessionToken: true, fetch: second.fetch });

  await farmerFlow.login("farmer", "x");
  await secondFlow.login("second", "y");

  // Each flow authenticates as its own token; the shared global was never written.
  assert.equal(farmerFlow.sessionToken(), "token-farmer");
  assert.equal(secondFlow.sessionToken(), "token-second");
  assert.equal(getSessionToken(), null, "no per-session flow may write the per-tab global");

  // The bridge call each login made (GetCharacterSelectionData) carried the
  // flow's OWN Bearer token — the proof they don't collide.
  const farmerCall = farmer.requests.find((r) => r.url.endsWith("/api/bridge/call"));
  const secondCall = second.requests.find((r) => r.url.endsWith("/api/bridge/call"));
  assert.equal(farmerCall?.headers.authorization, "Bearer token-farmer");
  assert.equal(secondCall?.headers.authorization, "Bearer token-second");
});

test("a flow exposes the complete request options owned by that session", async () => {
  const pilot = stubFetch(bffResponses("token-pilot"));
  const flow = createAppFlow(createClientStore(), {
    baseUrl: "https://pilot.example",
    perSessionToken: true,
    fetch: pilot.fetch,
  });

  assert.equal(flow.requestOptions().baseUrl, "https://pilot.example");
  assert.equal(flow.requestOptions().fetch, pilot.fetch);
  assert.equal(flow.requestOptions().token, null, "the per-flow token starts explicitly empty");

  await flow.login("pilot", "x");

  assert.equal(
    flow.requestOptions().token,
    "token-pilot",
    "component-owned API calls see the same token captured by the flow",
  );
});
