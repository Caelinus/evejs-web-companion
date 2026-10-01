import test from "node:test";
import assert from "node:assert/strict";
import { settleHostedMiningSupport, settleParkingMiningModules } from "./supportStopFlow.ts";
import { decodeFlightStatus } from "../bridge/flight.ts";
import { decodeSpaceSnapshot } from "../bridge/space.ts";

test("parking reconciles a deactivate refusal only from fresh exact own module settlement", async () => {
  const scene = (activeModuleIDs: number[] | null, characterID = 7, shipID = 1001) => decodeSpaceSnapshot({ inSpace: true, shipID,
    ship: { itemID: shipID, characterID, activeModuleIDs } });
  const refusal = new Error("Module is not active");
  for (const after of [scene([]), scene([201]), scene([202]), scene(null), scene([], 8), scene([], 7, 1002)]) {
    let read = 0, calls = 0;
    const deps = { shipID: 1001, characterID: 7, miningModuleIDs: [201, 202],
      readScene: async () => ++read === 1 ? scene([201, 202]) : after,
      deactivate: async () => { calls++; throw refusal; } };
    if (after.ship?.activeModuleIDs?.length === 0 && after.ship.characterID === 7 && after.shipID === 1001)
      await settleParkingMiningModules(deps);
    else await assert.rejects(settleParkingMiningModules(deps));
    assert.equal(read, 2); assert.equal(calls, 1, "no new writes after an uncertain refusal");
  }
  let calls = 0;
  await assert.rejects(settleParkingMiningModules({ shipID: 1001, characterID: 7, miningModuleIDs: [201],
    readScene: async () => scene([201]), deactivate: async () => { calls++; } }), /not confirmed stopped/);
  assert.equal(calls, 1, "ACK cannot prove module stop");
  calls = 0;
  await assert.rejects(settleParkingMiningModules({ shipID: 1001, characterID: 7, miningModuleIDs: [201],
    readScene: async () => scene(null), deactivate: async () => { calls++; } }), /unreadable/);
  assert.equal(calls, 0);
});

function fixture(docked = false) {
  let time = 0, ticks = 0, released = 0, ready = false, custody = false;
  const deps = { readFlight: async () => decodeFlightStatus({ shipID: 1001, docked, inSpace: !docked, stationID: docked ? 6001 : null }),
    unresolvedCustody: () => custody, tick: async () => { ticks++; }, ready: () => ready, reason: () => "pending effect",
    releaseAnchor: async () => { released++; }, now: () => time, sleep: async (ms: number) => { time += ms; }, deadlineMs: 6000 };
  return { deps, setReady: () => { ready = true; }, setCustody: () => { custody = true; }, counts: () => ({ ticks, released }) };
}
test("Stop before first undock uses fresh docked hull authority without in-space support actions", async () => {
  const f = fixture(true); await settleHostedMiningSupport(f.deps);
  assert.deepEqual(f.counts(), { ticks: 0, released: 1 });
});
test("docked Stop cannot discard pending collection or container custody", async () => {
  const f = fixture(true); f.setCustody();
  await assert.rejects(settleHostedMiningSupport(f.deps), /unresolved container custody/);
  assert.deepEqual(f.counts(), { ticks: 0, released: 0 });
});
test("in-space Stop requires another stop tick and proof; timeout retains anchor", async () => {
  const f = fixture(); await assert.rejects(settleHostedMiningSupport(f.deps), /SUPPORT_CLEANUP_UNCONFIRMED/);
  assert.deepEqual(f.counts(), { ticks: 3, released: 0 });
  const settled = fixture(); settled.setReady(); await settleHostedMiningSupport(settled.deps);
  assert.deepEqual(settled.counts(), { ticks: 1, released: 1 });
});
