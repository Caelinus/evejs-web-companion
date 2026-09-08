// Stopping a server bot from a screen with no session of its own
// (app/stopBotFor.ts).
//
// ⚠ THE BUG THIS EXISTS FOR. A server bot outlives the tab that started it, so
// the screen the player comes back to is the Pilot Hangar — and the BFF refuses
// to select a character a bot is flying. Until the hangar carried a Stop, a
// browser whose pilots were all bot-flown had no reachable way to stop any of
// them: every row refused, and the only Stop in the app was behind an "Add
// character" overlay.
//
// What these pin is the shape of the fix, because it is the shape that can go
// wrong quietly: the session it mints must be THROWAWAY (never the tab's
// global), it must be signed out even when the stop fails, and an ended run
// must not be reported as a bot it stopped.

import test from "node:test";
import assert from "node:assert/strict";

import { stopServerBotFor } from "./stopBotFor.ts";
import {
  clearSessionToken,
  getSessionToken,
  setSessionTokenStorage,
  type SessionTokenStorage,
} from "./sessionToken.ts";

function makeStorage(): SessionTokenStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly auth: string | undefined;
  readonly body: unknown;
}

/** One bot row as GET /api/bots serves it; only the fields this module reads. */
function botRow(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    botID: "bot-1",
    characterID: 90000001,
    scriptName: "Miner",
    status: "running",
    endedAt: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    ...fields,
  };
}

/**
 * A stub BFF. `bots` is what GET /api/bots answers with; `fail` names a path
 * that should 500 so the sign-out path can be checked against a failure.
 */
function stubBff(bots: readonly Record<string, unknown>[], fail: string | null = null) {
  const requests: Recorded[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers as Record<string, string> | undefined) ?? {},
    )) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({
      url,
      method: init?.method ?? "GET",
      auth: headers.authorization,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if (fail !== null && url.endsWith(fail)) {
      return new Response(JSON.stringify({ ok: false, error: "BOT_NOT_FOUND" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const body = url.endsWith("/api/login")
      ? { ok: true, sessionToken: "throwaway.token", account: { accountID: 7, username: "miner" } }
      : url.endsWith("/api/bots")
        ? { ok: true, bots }
        : { ok: true, bot: botRow({ status: "stopped", endedAt: "2026-01-01T01:00:00.000Z" }) };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchStub, requests };
}

const paths = (requests: readonly Recorded[]): string[] =>
  requests.map((request) => new URL(request.url, "http://bff").pathname);

test.beforeEach(() => {
  setSessionTokenStorage(makeStorage());
});

test.after(() => {
  setSessionTokenStorage(null);
  clearSessionToken();
});

test("signs in, stops the pilot's bot, and signs the throwaway token out again", async () => {
  const { fetch, requests } = stubBff([botRow({ botID: "bot-7", characterID: 90000001 })]);

  const stopped = await stopServerBotFor("miner", 90000001, { fetch });

  assert.equal(stopped, true);
  assert.deepEqual(paths(requests), [
    "/api/login",
    "/api/bots",
    "/api/bots/bot-7/stop",
    "/api/logout",
  ]);
});

test("the session it mints NEVER lands in the tab's global storage", async () => {
  // A hangar Stop must not sign the whole tab in as that account: the player
  // may have five other pilots up, each carrying its own token.
  const { fetch, requests } = stubBff([botRow({})]);

  await stopServerBotFor("miner", 90000001, { fetch });

  assert.equal(getSessionToken(), null, "the per-tab global must stay empty");
  for (const request of requests.slice(1)) {
    assert.equal(request.auth, "Bearer throwaway.token", `${request.url} rides the minted token`);
  }
});

test("a pilot whose run already ended is reported as nothing stopped, not as a stop", async () => {
  // listServerBots keeps ended runs so their last readout stays on screen. The
  // poll that drew the button is seconds old, so this is the ordinary race —
  // and stopping an ended run would be a no-op reported as success.
  const { fetch, requests } = stubBff([
    botRow({ characterID: 90000001, status: "stopped", endedAt: "2026-01-01T00:30:00.000Z" }),
  ]);

  const stopped = await stopServerBotFor("miner", 90000001, { fetch });

  assert.equal(stopped, false);
  assert.deepEqual(paths(requests), ["/api/login", "/api/bots", "/api/logout"]);
});

test("another pilot's bot is left alone", async () => {
  const { fetch, requests } = stubBff([botRow({ botID: "bot-9", characterID: 90000002 })]);

  assert.equal(await stopServerBotFor("miner", 90000001, { fetch }), false);
  assert.equal(paths(requests).includes("/api/bots/bot-9/stop"), false);
});

test("a stop that fails still signs the throwaway token out", async () => {
  // Otherwise every failed Stop would leave a live BFF session behind, and a
  // player mashing the button would strand one per press.
  const { fetch, requests } = stubBff([botRow({ botID: "bot-7" })], "/stop");

  await assert.rejects(() => stopServerBotFor("miner", 90000001, { fetch }));

  assert.equal(paths(requests).at(-1), "/api/logout", "the sign-out is in a finally");
});

test("a login that returns no token stops before it can act", async () => {
  const fetchStub = (async () =>
    new Response(JSON.stringify({ ok: true, account: { accountID: 7, username: "miner" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  await assert.rejects(() => stopServerBotFor("miner", 90000001, { fetch: fetchStub }));
});
