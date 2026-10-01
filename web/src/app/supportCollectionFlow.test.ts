import test from "node:test";
import assert from "node:assert/strict";
import { dispatchSupportCollectionAction } from "./supportCollectionFlow.ts";
import { getMiningCompressionCompatibility } from "./api.ts";
test("split/reminted/merged response is acknowledged through own claimed, scoped one-transfer authority", async () => {
  for (const moved of [[101], []]) {
    const calls: { path: string; body: unknown; token: string | null }[] = [];
    const receipt = await dispatchSupportCollectionAction({ kind: "transfer", containerID: 201, itemID: 101, typeID: 1230, quantity: 20, bay: "ore" }, "run",
      { shipID: 10, solarSystemID: 3001 }, { token: "own", fetch: async (path, init) => {
        calls.push({ path: String(path), body: JSON.parse(String(init?.body)), token: new Headers(init?.headers).get("authorization") });
        return new Response(JSON.stringify({ ok: true, applied: true, moved, reminted: moved.length ? [] : [101], declined: [], notFound: [], transferStatus: "SUCCESS" }));
      } });
    assert.equal(receipt.acknowledged, true);
    assert.deepEqual(calls, [{ path: "/api/bridge/inventory/transfer", body: { itemIDs: [101], from: { kind: "container", itemID: 201 },
      to: { kind: "shipBay", bay: "ore" }, qty: 20, claimRunID: "run", expectedScope: { shipID: 10, solarSystemID: 3001 } }, token: "Bearer own" }]);
  }
});
test("compression carries own ship scope, preserves raw tuple for proof, and never transfers remote ore", async () => {
  const calls: unknown[] = [];
  const receipt = await dispatchSupportCollectionAction({ kind: "compress", itemID: 301, typeID: 1230, quantity: 100, bay: "ore", facilityID: 10, outputTypeID: 62516 }, "run",
    { shipID: 10, solarSystemID: 3001 }, { token: "own", fetch: async (path, init) => {
      calls.push({ path: String(path), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, compressed: true, result: [301, 1230, 100, 301, 62516, 100] }));
    } });
  assert.deepEqual(receipt, { acknowledged: true, compressionTuple: [301, 1230, 100, 301, 62516, 100] });
  assert.deepEqual(calls, [{ path: "/api/bridge/mining/compress", body: { itemID: 301, facilityID: 10, confirm: true, expectedScope: { shipID: 10, solarSystemID: 3001 } } }]);
});
test("static compatibility is bounded read-only and malformed identity/rules fail unknown", async () => {
  let calls = 0;
  const options = { token: "own", fetch: async (_path: unknown, init?: RequestInit) => {
    calls++; assert.equal(init?.method ?? "GET", "GET");
    return new Response(JSON.stringify({ ok: true, compatibility: [{ typeID: 999, compressedTypeID: 62516, matchingTypeListIDs: [334], availability: "available" }] }));
  } };
  assert.equal(await getMiningCompressionCompatibility([1230], [334], options), null);
  assert.equal(await getMiningCompressionCompatibility([], [334], options), null); assert.equal(calls, 1);
});
