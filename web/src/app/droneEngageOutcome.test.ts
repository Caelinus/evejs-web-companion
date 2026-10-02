import test from "node:test";
import assert from "node:assert/strict";
import { DroneEngageOutcomeError, engageDrones, engageDronesConfirmed } from "./api.ts";

const TARGET = 300001;
const result = (refused: number[]) => ({ type: "dict", entries: refused.map((id) => [
  id, ["CustomNotify", { type: "dict", entries: [["notify", "That target is out of drone control range."]] }],
]) });
const flight = (ids: number[]) => ids.map((itemID) => ({ itemID, controlled: true, targetID: TARGET }));
function options(body: unknown) {
  return { fetch: (async (input: unknown, init?: RequestInit) => {
    assert.equal(String(input), "/api/bridge/drones/engage");
    assert.deepEqual(JSON.parse(String(init?.body)), { droneIDs: [601, 602], targetID: TARGET });
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch };
}

test("the automation Engage API resolves only a confirmed assignment for every requested drone", async () => {
  await engageDronesConfirmed([601, 602], TARGET, options({ ok: true, result: result([]), inSpace: flight([601, 602]) }));
});

test("the automation Engage API exposes partial refusal ids without replaying the accepted subset", async () => {
  await assert.rejects(engageDronesConfirmed([601, 602], TARGET, options({
    ok: true, result: result([602]), inSpace: flight([601]),
  })), (error: unknown) => {
    assert.ok(error instanceof DroneEngageOutcomeError);
    assert.equal(error.code, "CALL_REFUSED");
    assert.deepEqual(error.acceptedDroneIDs, [601]);
    assert.deepEqual(error.refusedDroneIDs, [602]);
    assert.deepEqual(error.uncertainDroneIDs, []);
    assert.match(error.message, /out of drone control range/);
    assert.deepEqual(error.refusals, [{ droneID: 602, errorKey: "CustomNotify", raw: "That target is out of drone control range." }]);
    return true;
  });
});

test("the automation Engage API preserves refused ids when the rest of the post-state cannot be read", async () => {
  await assert.rejects(engageDronesConfirmed([601, 602], TARGET, options({
    ok: true, result: result([602]), inSpace: null,
  })), (error: unknown) => {
    assert.ok(error instanceof DroneEngageOutcomeError);
    assert.equal(error.code, "BRIDGE_BAD_RESPONSE");
    assert.deepEqual(error.acceptedDroneIDs, []);
    assert.deepEqual(error.refusedDroneIDs, [602]);
    assert.deepEqual(error.uncertainDroneIDs, [601]);
    return true;
  });
});

test("the manual Engage API retains the per-drone response for the panel", async () => {
  const body = { ok: true, result: result([602]), inSpace: flight([601]), notifications: [] };
  assert.deepEqual((await engageDrones([601, 602], TARGET, options(body))).result, body.result);
});
