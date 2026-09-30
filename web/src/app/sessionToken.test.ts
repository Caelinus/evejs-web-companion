// Goal R42: the browser end of per-tab sessions. The tab keeps its own signed
// login token in sessionStorage and sends it as `Authorization: Bearer` on
// every BFF request; the SSE stream, whose EventSource cannot set headers,
// carries it in the query string instead.
//
// What these cover: login stores the token and every request helper picks it
// up; the bridge callMethod route picks it up too (it is the client's second
// fetch site); confirmed logout clears it while a rejected release retains it; a signed
// out tab sends no header at all so the legacy cookie can still carry it; and
// two tokens in flight reach the BFF as two different identities.

import test from "node:test";
import assert from "node:assert/strict";

import { login, logout, subscribeBridgeEvents } from "./api.ts";
import * as api from "./api.ts";
import { callMethod } from "../bridge/callMethod.ts";
import {
  clearSessionToken,
  getSessionToken,
  sessionAuthHeaders,
  setSessionToken,
  setSessionTokenStorage,
  withSessionTokenQuery,
  type SessionTokenStorage,
} from "./sessionToken.ts";

/** A stand-in for one tab's sessionStorage. */
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
}

function stubFetch(
  respond: (recorded: Recorded) => unknown,
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers as Record<string, string> | undefined) ?? {},
    )) {
      headers[key.toLowerCase()] = value;
    }
    const recorded: Recorded = { url: String(input), headers };
    requests.push(recorded);
    const body = respond(recorded);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchStub, requests };
}

test.beforeEach(() => {
  setSessionTokenStorage(makeStorage());
});

test.after(() => {
  setSessionTokenStorage(null);
  clearSessionToken();
});

test("login stores the token the BFF handed back", async () => {
  const { fetch } = stubFetch(() => ({
    ok: true,
    sessionToken: "signed.token-for-farmer",
    account: { accountID: 4001, username: "farmer" },
  }));

  const result = await login("farmer", "anything", { fetch });

  assert.equal(result.username, "farmer");
  assert.equal(getSessionToken(), "signed.token-for-farmer");
});

test("every request helper carries the tab's token as a Bearer header", async () => {
  setSessionToken("signed.token-for-farmer");
  const { fetch, requests } = stubFetch(() => ({ ok: true, character: null, station: null }));

  await api.selectCharacter(7001, { fetch });
  await api.loadCorpHangar({ fetch });

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(
      request.headers.authorization,
      "Bearer signed.token-for-farmer",
      `${request.url} must carry this tab's token`,
    );
  }
  // The content-type the POST helper sets must survive the merge.
  assert.equal(requests[0]?.headers["content-type"], "application/json");
});

test("the bridge callMethod route carries it too — it is the second fetch site", async () => {
  setSessionToken("signed.token-for-second");
  const { fetch, requests } = stubFetch(() => ({
    ok: true,
    service: "map",
    method: "GetStationInfo",
    result: null,
    notifications: [],
  }));

  await callMethod("map", "GetStationInfo", [], null, { fetch });

  assert.equal(requests[0]?.headers.authorization, "Bearer signed.token-for-second");
  assert.equal(requests[0]?.headers["content-type"], "application/json");
});

test("a signed-out tab sends NO Authorization header, so the cookie can still carry it", async () => {
  clearSessionToken();
  const { fetch, requests } = stubFetch(() => ({ ok: true }));

  await api.loadCorpHangar({ fetch });
  await callMethod("map", "GetStationInfo", [], null, { fetch }).catch(() => {});

  for (const request of requests) {
    assert.equal(
      "authorization" in request.headers,
      false,
      `${request.url} must omit the header entirely, not send an empty one`,
    );
  }
  assert.deepEqual(sessionAuthHeaders(), {});
});

test("rejected logout retains its token for recovery; confirmed logout clears it", async () => {
  setSessionToken("signed.token-for-farmer");
  const failing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  await assert.rejects(logout({ fetch: failing }));
  assert.equal(getSessionToken(), "signed.token-for-farmer", "the held owner can finish cleanup after a refused logout");

  setSessionToken("signed.token-for-farmer");
  const { fetch } = stubFetch(() => ({ ok: true }));
  await logout({ fetch });
  assert.equal(getSessionToken(), null);
});

test("the SSE stream URL carries the token, because EventSource cannot set headers", () => {
  setSessionToken("signed.token+needs/escaping");
  const opened: string[] = [];
  const subscription = subscribeBridgeEvents(
    { onFrame() {} },
    {
      eventSource: (url) => {
        opened.push(url);
        return { onmessage: null, onopen: null, onerror: null, close() {} };
      },
    },
  );
  subscription.close();

  assert.equal(opened.length, 1);
  const url = new URL(opened[0] as string, "http://bff.test");
  assert.equal(url.pathname, "/api/bridge/events");
  // Decoded by URL parsing, so this also proves the token was escaped on the
  // way in — an unescaped "+" would come back as a space.
  assert.equal(url.searchParams.get("access_token"), "signed.token+needs/escaping");
});

test("a signed-out tab opens the stream with no token in the URL", () => {
  clearSessionToken();
  const opened: string[] = [];
  subscribeBridgeEvents(
    { onFrame() {} },
    {
      eventSource: (url) => {
        opened.push(url);
        return { onmessage: null, onopen: null, onerror: null, close() {} };
      },
    },
  ).close();

  assert.equal(opened[0], "/api/bridge/events");
});

test("two tokens in flight reach the BFF as two different identities", () => {
  // A browser gives each tab its own realm, so in real life these are two
  // copies of this module. Here they are two storages swapped in turn — what is
  // being proved is that the header follows the STORAGE, not a baked-in value.
  const tabOne = makeStorage();
  const tabTwo = makeStorage();

  setSessionTokenStorage(tabOne);
  setSessionToken("token-farmer");
  const headersOne = sessionAuthHeaders();
  const streamOne = withSessionTokenQuery("/api/bridge/events");

  setSessionTokenStorage(tabTwo);
  setSessionToken("token-second");
  const headersTwo = sessionAuthHeaders();
  const streamTwo = withSessionTokenQuery("/api/bridge/events");

  assert.equal(headersOne.authorization, "Bearer token-farmer");
  assert.equal(headersTwo.authorization, "Bearer token-second");
  assert.notEqual(headersOne.authorization, headersTwo.authorization);
  assert.equal(streamOne, "/api/bridge/events?access_token=token-farmer");
  assert.equal(streamTwo, "/api/bridge/events?access_token=token-second");

  // And neither tab's storage was touched by the other.
  assert.equal(tabOne.map.size, 1);
  assert.equal(tabTwo.map.size, 1);
  assert.notDeepEqual([...tabOne.map.values()], [...tabTwo.map.values()]);
});

test("a tab reloading finds its token again; a signed-out one finds nothing", () => {
  const storage = makeStorage();
  setSessionTokenStorage(storage);
  setSessionToken("token-farmer");

  // A reload is a fresh module against the SAME per-tab storage.
  setSessionTokenStorage(storage);
  assert.equal(getSessionToken(), "token-farmer");

  clearSessionToken();
  setSessionTokenStorage(storage);
  assert.equal(getSessionToken(), null);
  assert.equal(storage.map.size, 0);
});

test("a store that throws costs persistence, never the session", () => {
  setSessionTokenStorage({
    getItem() {
      throw new Error("blocked by privacy mode");
    },
    setItem() {
      throw new Error("blocked by privacy mode");
    },
    removeItem() {
      throw new Error("blocked by privacy mode");
    },
  });

  setSessionToken("token-farmer");
  assert.equal(getSessionToken(), "token-farmer", "the in-memory copy carries the page");
  assert.equal(sessionAuthHeaders().authorization, "Bearer token-farmer");
  clearSessionToken();
  assert.equal(getSessionToken(), null);
});
