import test from "node:test";
import assert from "node:assert/strict";
import { observeDeferredShutdown } from "./moduleShutdown.ts";
import { requireModuleOutcome } from "../nav/moduleOutcome.ts";
import { deactivateModule } from "../app/api.ts";

const initial = { itemID: 7, shipID: 9, stopped: false, remainingMs: 75680 };
const outcome = (r: Record<string, unknown>) => ({ itemID: Number(r.itemID), active: null,
  stopped: typeof r.stopped === "boolean" ? r.stopped : null });
test("accepted long-cycle OFF survives old 15s budget and confirms the exact module before derived deadline", async () => {
  let now = 15000, reads = 0;
  const result = await observeDeferredShutdown(initial, 7, { current() {}, now: () => now,
    sleep: async ms => { now += ms; }, read: async shipID => {
      assert.equal(shipID, 9); reads++; return { itemID: 7, shipID, stopped: now >= 85680 };
    } });
  assert.ok(now > 15000 && now < 90680 && reads > 1);
  requireModuleOutcome(outcome(result), 7, "deactivate");
});
test("module still active beyond cycle-derived deadline remains UNCERTAIN; remaining budget cannot renew", async () => {
  let now = 15000, reads = 0;
  const result = await observeDeferredShutdown(initial, 7, { current() {}, now: () => now,
    sleep: async ms => { now += ms; }, read: async () => { reads++; return { ...initial, remainingMs: 300000 }; } });
  assert.equal(now, 90680); assert.ok(reads < 80);
  assert.throws(() => requireModuleOutcome(outcome(result), 7, "deactivate"), { code: "MODULE_ACTION_UNCERTAIN" });
});
test("unknown authority, already OFF and invalid pending budgets do not invent extended observation", async () => {
  for (const row of [{ ...initial, stopped: null }, { ...initial, stopped: true },
    { ...initial, remainingMs: 0 }, { ...initial, remainingMs: 305001 }, { ...initial, shipID: null }]) {
    assert.equal(await observeDeferredShutdown(row, 7, { current() {}, read: async () => { throw Error("unexpected read"); } }), row);
  }
});
test("different requested module or ship is never OFF confirmation", async () => {
  for (const fresh of [{ itemID: 8, shipID: 9, stopped: true }, { itemID: 7, shipID: 10, stopped: true }]) {
    let now = 0;
    const result = await observeDeferredShutdown(initial, 7, { current() {}, now: () => now,
      sleep: async ms => { now += ms; }, read: async () => fresh });
    assert.throws(() => requireModuleOutcome(outcome(result), 7, "deactivate"), { code: "MODULE_ACTION_UNCERTAIN" });
  }
});
test("retired authority interrupts pending OFF without another read or mutation", async () => {
  let current = true;
  await assert.rejects(observeDeferredShutdown(initial, 7, {
    current: () => { if (!current) throw Object.assign(Error("retired"), { code: "SESSION_REQUEST_RETIRED" }); },
    sleep: async () => { current = false; }, read: async () => { throw Error("retired generation must not read"); },
  }), { code: "SESSION_REQUEST_RETIRED" });
});
test("production API dispatches exactly one Deactivate then only exact-module reads", async () => {
  const paths: string[] = [];
  const result = await deactivateModule(7, {}, { token: "task-test-token", fetch: async (url, init) => {
    paths.push(String(url));
    const value = init?.method === "POST" ? { ok: true, ...initial, remainingMs: 3000 } : { ok: true, itemID: 7, shipID: 9, stopped: true };
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  } });
  requireModuleOutcome(result, 7, "deactivate");
  assert.deepEqual(paths, ["/api/bridge/modules/deactivate", "/api/bridge/modules/7/state?shipID=9"]);
});
