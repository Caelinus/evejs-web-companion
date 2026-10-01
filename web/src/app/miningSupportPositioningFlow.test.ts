import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { freshSupportPositionMemory } from "../nav/miningSupportPositioning.ts";
import { gotoPoint } from "./api.ts";
const request = { sessionEpoch: "run", intendedCharacterIDs: [2], requirements: { requireMiningBurst: true },
  policy: { deadbandMeters: 100, arrivalMeters: 10, settledSpeedMetersPerSecond: 0.1,
    service: { maintainBursts: true, useIndustrialCore: false, enableCompression: false, coreRequirement: "continueWithoutCore" as const } } };
test("normal positioning refuses offline or another controller before authority/action IO", async () => {
  const store = createClientStore();
  let calls = 0;
  const flow = createAppFlow(store, { perSessionToken: true, initialSessionToken: "pilot", fetch: async () => { calls++; throw new Error("unexpected IO"); } });
  await assert.rejects(flow.tickMiningSupportPositioning(freshSupportPositionMemory(), request), /online pilot/);
  store.apply({ type: "character/online", character: { characterID: 1, characterName: "Support", stationID: null, structureID: null, solarSystemID: 3001, corporationID: null }, station: null });
  store.apply({ type: "bot/started", beltName: "Belt", stationName: "Station", startedAt: 100 });
  await assert.rejects(flow.tickMiningSupportPositioning(freshSupportPositionMemory(), request), /Another controller/);
  assert.equal(calls, 0);
});
test("point action carries measured ship/system and own token; invalid geometry never leaves the client", async () => {
  const calls: { body: unknown; token: string | null }[] = [];
  const options = { token: "pilot", fetch: async (_input: unknown, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)), token: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ ok: true, flight: { inSpace: true, shipID: 1001, solarSystemID: 3001 } }));
  } };
  await assert.rejects(gotoPoint({ x: NaN, y: 0, z: 0 }, 1001, 3001, options));
  assert.equal(calls.length, 0);
  await gotoPoint({ x: 0, y: -20, z: 30 }, 1001, 3001, options);
  assert.deepEqual(calls, [{ body: { x: 0, y: -20, z: 30, expectedShipID: 1001, expectedSolarSystemID: 3001, confirm: true }, token: "Bearer pilot" }]);
});
