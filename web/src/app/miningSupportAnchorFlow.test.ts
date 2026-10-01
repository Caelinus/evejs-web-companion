import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { deriveMiningSupportCapabilities } from "../nav/miningSupportCapabilities.ts";
import { deriveMiningSupportServices } from "../nav/miningSupportServices.ts";
import { decideMiningSupport, freshMiningSupportMemory } from "../nav/miningSupportController.ts";
import { decodeSpaceSnapshot } from "../bridge/space.ts";

function fixture() {
  const requests: { path: string; method: string; body: unknown; authorization: string | null }[] = [];
  const anchor = { characterID: 1, shipID: 1001, fleetID: "654500010000", solarSystemID: 30000142,
    sampledAtMs: 400, observedAtMs: 100_000, publishedAtMs: 100_000, expiresAtMs: 110_000,
    sessionEpoch: "opaque-epoch", freshness: "fresh", ageMs: 0, reason: null,
    services: { bursts: null, compression: { state: "unknown", typeListRanges: null, compressors: null }, supportEffects: null } };
  const flow = createAppFlow(createClientStore(), { perSessionToken: true, initialSessionToken: "pilot-token",
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";
      requests.push({ path: String(input), method, body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(method === "POST" ? { ok: true, anchor } : {
        ok: true, availability: "available", reason: null, readAtMs: 100_000,
        fleet: { fleetID: anchor.fleetID, readerCharacterID: 1, members: [{ characterID: 1, solarSystemID: 30000142 }], observedAtMs: 100_000, expiresAtMs: 110_000 }, anchors: [anchor],
      }), { headers: { "content-type": "application/json" } });
    } });
  const capabilities = deriveMiningSupportCapabilities({ scope: { shipID: 1001, fittingSignature: "fit" }, slots: [], dogma: null, bays: null, groupOf: () => null, typeNameOf: () => null });
  const observation = deriveMiningSupportServices(capabilities, decodeSpaceSnapshot({ inSpace: true, shipID: 1001, sampledAtMs: 400, ship: { itemID: 1001, characterID: 1 } }));
  return { flow, requests, observation };
}
test("Phase 2A consumer publishes only observation guards through its own normal flow token", async () => {
  const f = fixture();
  const result = decideMiningSupport(f.observation, freshMiningSupportMemory(), {
    maintainBursts: false, useIndustrialCore: false, enableCompression: false, coreRequirement: "continueWithoutCore",
  }, false);
  assert.equal(result.action, null);
  assert.equal(f.requests.length, 0, "deciding never publishes or calls the network");
  const anchor = await f.flow.publishMiningSupportAnchor(f.observation);
  assert.equal(anchor.characterID, 1);
  assert.deepEqual(f.requests, [{ path: "/api/bots/mining-support-anchors", method: "POST",
    body: { observedShipID: 1001, observedAtMs: 400 }, authorization: "Bearer pilot-token" }]);
  const read = await f.flow.readMiningSupportAnchors();
  assert.equal(read.availability, "available");
  assert.equal(read.anchors.length, 1);
  assert.equal(f.requests[1]?.method, "GET");
  assert.equal(f.requests[1]?.body, null);
});
test("unknown controller observation is refused before publication IO", async () => {
  const f = fixture();
  await assert.rejects(() => f.flow.publishMiningSupportAnchor({ ...f.observation, sampledAtMs: null }));
  assert.equal(f.requests.length, 0);
});
