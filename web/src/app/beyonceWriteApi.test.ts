// R103 Phase-4 client wrappers for two of the bound-beyonce writes:
// setFleetTargetTag (CmdFleetTagTarget) and jumpThroughFleet
// (CmdJumpThroughFleet). Both routes are requireWriteConfirmation-gated at the
// BFF, so the point of these tests is the body each wrapper sends — confirm
// missing means a 400 CONFIRMATION_REQUIRED in the real server — plus that the
// uniform ack decodes through bridge/boundBeyonceWrites.ts unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { setFleetTargetTag, jumpThroughFleet } from "./api.ts";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const API = readFileSync(path.join(APP_DIR, "api.ts"), "utf8");

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

test("setFleetTargetTag posts itemID + tag + confirm:true", async () => {
  const { fetch, requests } = recordingFetch(() =>
    json({ ok: true, applied: true, result: null, flight: { solarSystemID: 30000142 }, notifications: [] }),
  );

  await setFleetTargetTag(1001, "X", { fetch, token: "t" });

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.path, /\/api\/bridge\/flight\/fleet-tag-target$/);
  assert.equal(requests[0]!.method, "POST");
  assert.deepEqual(requests[0]!.body, { itemID: 1001, tag: "X", confirm: true });
});

test("setFleetTargetTag(itemID, null) clears the tag — confirm:true still rides along", async () => {
  const { fetch, requests } = recordingFetch(() => json({ ok: true, applied: true, result: null, flight: null, notifications: [] }));

  await setFleetTargetTag(1001, null, { fetch, token: "t" });

  assert.deepEqual(requests[0]!.body, { itemID: 1001, tag: null, confirm: true });
});

test("setFleetTargetTag decodes the uniform ack", async () => {
  const { fetch } = recordingFetch(() =>
    json({ ok: true, applied: true, result: null, flight: { solarSystemID: 30000142 }, notifications: [] }),
  );

  const ack = await setFleetTargetTag(1001, "X", { fetch, token: "t" });

  assert.deepEqual(ack, {
    ok: true,
    applied: true,
    result: null,
    flight: { solarSystemID: 30000142 },
  });
});

test("⚠ setFleetTargetTag documents that its own ack is not proof of anything", () => {
  // The BFF's only caller of CmdFleetTagTarget discards the server's boolean
  // and returns null unconditionally, so a refused (non-commander) tag and an
  // applied one produce the identical {ok:true, applied:true} envelope. Pinned
  // here so the warning cannot be quietly dropped from the wrapper's doc
  // comment by a future edit.
  const start = API.indexOf("export async function setFleetTargetTag");
  assert.notEqual(start, -1, "api.ts has no setFleetTargetTag");
  const commentStart = API.lastIndexOf("/**", start);
  const doc = API.slice(commentStart, start);
  assert.match(doc, /NOT PROOF/i);
  assert.match(doc, /targetTags/, "must point the caller at the re-read that actually proves it");
});

test("jumpThroughFleet posts otherCharID/otherShipID/beaconID/solarSystemID + confirm:true", async () => {
  const { fetch, requests } = recordingFetch(() =>
    json({ ok: true, applied: true, result: null, flight: { solarSystemID: 30000143 }, notifications: [] }),
  );

  await jumpThroughFleet(90000001, 2002, 3003, 30000143, { fetch, token: "t" });

  assert.equal(requests.length, 1);
  assert.match(requests[0]!.path, /\/api\/bridge\/flight\/jump-through-fleet$/);
  assert.equal(requests[0]!.method, "POST");
  assert.deepEqual(requests[0]!.body, {
    otherCharID: 90000001,
    otherShipID: 2002,
    beaconID: 3003,
    solarSystemID: 30000143,
    confirm: true,
  });
});

test("jumpThroughFleet decodes the uniform ack", async () => {
  const { fetch } = recordingFetch(() =>
    json({ ok: true, applied: true, result: null, flight: { solarSystemID: 30000143 }, notifications: [] }),
  );

  const ack = await jumpThroughFleet(90000001, 2002, 3003, 30000143, { fetch, token: "t" });

  assert.deepEqual(ack, {
    ok: true,
    applied: true,
    result: null,
    flight: { solarSystemID: 30000143 },
  });
});
