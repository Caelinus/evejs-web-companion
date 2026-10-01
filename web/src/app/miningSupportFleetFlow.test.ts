import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { decodeFleetCenter } from "../bridge/fleetCenter.ts";
import type { JsonValue } from "../bridge/wire.ts";
import { decodeSpaceSnapshot } from "../bridge/space.ts";
import { deriveMiningSupportCapabilities } from "../nav/miningSupportCapabilities.ts";
import { deriveMiningSupportServices } from "../nav/miningSupportServices.ts";
import { decideMiningSupportFleet, freshMiningSupportFleetMemory } from "../nav/miningSupportFleet.ts";

function fixture() {
  const store = createClientStore();
  const requests: { body: unknown; token: string | null }[] = [];
  const flow = createAppFlow(store, { perSessionToken: true, initialSessionToken: "own-token", fetch: async (_input, init) => {
    requests.push({ body: JSON.parse(String(init?.body)), token: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ ok: false, error: "fixture-stop" }), { status: 409 });
  } });
  store.apply({ type: "character/online", character: { characterID: 1, characterName: "Support", stationID: null,
    structureID: null, solarSystemID: 30000142, corporationID: null }, station: null });
  const capabilities = deriveMiningSupportCapabilities({ scope: { shipID: 1001, fittingSignature: "fit" }, slots: [], dogma: null, bays: null, groupOf: () => null, typeNameOf: () => null });
  const space = decodeSpaceSnapshot({ inSpace: true, shipID: 1001, sampledAtMs: 400, ship: { itemID: 1001, characterID: 1 } });
  store.apply({ type: "space/snapshot", snapshot: space });
  const service = deriveMiningSupportServices(capabilities, space);
  function load(fleetID = 700, refreshedAtMs = Date.now()) {
    const keyVal = (entries: JsonValue[][]) => ({ type: "object", args: { type: "dict", entries } });
    const snapshot = decodeFleetCenter({ characterID: 1, fleetID: 999,
      reads: { GetInitState: { result: keyVal([["fleetID", fleetID], ["members", { type: "dict", entries: [[1, keyVal([["charID", 1]])]] }]]) } } });
    store.apply({ type: "fleet/loaded", ...snapshot, readError: null, refreshedAtMs });
  }
  return { store, flow, service, requests, load };
}

test("normal loaded fleet seam uses own identity, receipt time, supplied scope and fresh join facts", () => {
  const f = fixture();
  assert.equal(f.flow.readMiningSupportFleet("run-A"), null);
  f.load(700, 123);
  const first = f.flow.readMiningSupportFleet("run-A")!;
  assert.equal(first.scope.characterID, 1);
  assert.equal(first.scope.sessionEpoch, "run-A");
  assert.equal(first.receivedAtMs, 123);
  assert.equal(first.snapshot.fleet.initState.value.fleetID, 700);
  assert.deepEqual(first.join, { inviteKnown: false, invite: null, ads: null });
  const join = { inviteKnown: true, invite: null, ads: [] };
  assert.equal(f.flow.readMiningSupportFleet("run-B", join)?.join, join);
  assert.equal(f.flow.readMiningSupportFleet("") , null);
  f.store.apply({ type: "character/offline" });
  assert.equal(f.flow.readMiningSupportFleet("run-A"), null);
});

test("reconciled anchor uses freshly reread recreation fleet and own token; invalid results never publish", async () => {
  const f = fixture(); f.load();
  const result = decideMiningSupportFleet({ own: f.flow.readMiningSupportFleet("run"),
    policy: { mode: "EXISTING_ONLY" }, intendedCharacterIDs: [], memberObservations: [], nowMs: Date.now() }, freshMiningSupportFleetMemory());
  assert.equal(result.anchorReady, true);
  const variants = [{ ...result, role: "member" as const }, { ...result, anchorReady: false }, { ...result, fleetID: null },
    { ...result, observedAtMs: Date.now() - 10_000 }, { ...result, observedAtMs: Date.now() + 10_000 },
    { ...result, memory: { ...result.memory, scope: { characterID: 2, sessionEpoch: "run" } } }];
  for (const invalid of variants) await assert.rejects(() => f.flow.publishReconciledMiningSupportAnchor(invalid, f.service));
  await assert.rejects(() => f.flow.publishReconciledMiningSupportAnchor(result, { ...f.service, sampledAtMs: null }));
  await assert.rejects(() => f.flow.publishReconciledMiningSupportAnchor(result, { ...f.service, sampledAtMs: 399 }));
  assert.equal(f.requests.length, 0);
  f.load(701);
  const next = decideMiningSupportFleet({ own: f.flow.readMiningSupportFleet("run"),
    policy: { mode: "EXISTING_ONLY" }, intendedCharacterIDs: [], memberObservations: [], nowMs: Date.now() }, result.memory);
  await assert.rejects(() => f.flow.publishReconciledMiningSupportAnchor(next, f.service));
  assert.deepEqual(f.requests, [{ body: { observedShipID: 1001, observedAtMs: 400, expectedCharacterID: 1, expectedFleetID: 701 }, token: "Bearer own-token" }]);
});
