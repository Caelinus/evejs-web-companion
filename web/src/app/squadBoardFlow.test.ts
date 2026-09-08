// The client half of the shared squad board: reading the fleet's called primary
// and calling one. Both sides of the wire matter here — the route keys on the
// fleet the BFF resolved, so there is nothing to send but the target, and a
// session with no fleet must read as "nobody has called anything" rather than as
// a failure that could stop a bot.

import test from "node:test";
import assert from "node:assert/strict";

import { callSquadPrimary, readSquadPrimary } from "./api.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recordingFetch(reply: (path: string, method: string, body: unknown) => Response) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    return reply(path, method, body);
  }) as unknown as typeof fetch;
  return { fetch: fake, requests };
}

test("the fleet's call is read with no arguments — the fleet is the server's answer", async () => {
  const { fetch, requests } = recordingFetch(() =>
    json({ ok: true, fleetID: "654500010000", primary: { targetID: 1001, calledByCharacterID: 90000001 } }),
  );

  const primary = await readSquadPrimary({ fetch, token: "t" });
  assert.deepEqual(primary, { targetID: 1001, calledByCharacterID: 90000001 });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.path, /\/api\/bots\/squad-board$/, "no fleet id is ever sent");
  assert.equal(requests[0]!.method, "GET");
});

test("nobody has called anything reads as null, not as a failure", async () => {
  const { fetch } = recordingFetch(() => json({ ok: true, fleetID: "654500010000", primary: null }));
  assert.equal(await readSquadPrimary({ fetch, token: "t" }), null);
});

test("a call with no target id in it is null rather than a half-read row", async () => {
  const { fetch } = recordingFetch(() => json({ ok: true, fleetID: "1", primary: { calledByCharacterID: 90000001 } }));
  assert.equal(await readSquadPrimary({ fetch, token: "t" }), null);
});

test("an unknown caller is carried as unknown", async () => {
  const { fetch } = recordingFetch(() =>
    json({ ok: true, fleetID: "1", primary: { targetID: 1001, calledByCharacterID: null } }),
  );
  assert.deepEqual(await readSquadPrimary({ fetch, token: "t" }), { targetID: 1001, calledByCharacterID: null });
});

test("a fleetless session is refused, and the caller is the one that decides that is fine", async () => {
  // The route answers 409 FLEET_UNKNOWN; api surfaces it as a throw, and the
  // bot's observe turns it into "no call" — proven here as a throw so nobody
  // mistakes a silent null for a successful read.
  const { fetch } = recordingFetch(() =>
    json({ ok: false, error: "FLEET_UNKNOWN", message: "This character is not in a fleet." }, 409),
  );
  await assert.rejects(() => readSquadPrimary({ fetch, token: "t" }));
});

test("calling a primary posts just the target, and clearing posts null", async () => {
  const { fetch, requests } = recordingFetch(() => json({ ok: true, fleetID: "1", primary: null }));

  await callSquadPrimary(1001, { fetch, token: "t" });
  await callSquadPrimary(null, { fetch, token: "t" });

  assert.deepEqual(
    requests.map((r) => ({ method: r.method, body: r.body })),
    [
      { method: "POST", body: { targetID: 1001 } },
      { method: "POST", body: { targetID: null } },
    ],
  );
  assert.match(requests[0]!.path, /\/api\/bots\/squad-board$/);
});
