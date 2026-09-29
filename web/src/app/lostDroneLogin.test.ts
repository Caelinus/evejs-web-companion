import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

function browserPilot(config: { docked?: boolean; drones?: unknown; reconnectFails?: boolean;
  holdDroneRead?: Promise<void> } = {}) {
  const paths: string[] = [];
  let drones = config.drones ?? [];
  const fetcher = (async (input: unknown, init?: { body?: string }) => {
    const path = String(input);
    paths.push(path);
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    const answer = (value: unknown, status = 200) => ({ ok: status < 400, status, json: async () => value });
    if (path === "/api/bridge/select" && body.characterID !== 42)
      return answer({ ok: false, error: "DRONE_RECOVERY_PENDING" }, 409);
    if (path === "/api/bridge/select") return answer({ ok: true,
      character: { characterID: 42, characterName: "Pilot", stationID: config.docked ? 6001 : null,
        solarSystemID: 3001, corporationID: 99 }, station: null, droneRecoveryCheckID: "check-42" });
    if (path === "/api/bridge/flight/status") return answer({ ok: true,
      flight: { inSpace: !config.docked, docked: !!config.docked } });
    if (path === "/api/bridge/drones") {
      await config.holdDroneRead;
      return answer({ ok: true, activeShipID: 50, inSpace: drones, bay: [], shipInfo: null, errors: {} });
    }
    if (path === "/api/bridge/entity/drones/reconnect") {
      if (config.reconnectFails) return answer({ ok: false, error: "CALL_REFUSED", message: "Reconnect refused" }, 409);
      const ids = body.droneIDs as number[];
      drones = (drones as Array<Record<string, unknown>>).map(row =>
        ids.includes(row.itemID as number) ? { ...row, controlled: true, reconnectCandidate: false } : row);
      return answer({ ok: true, inSpace: drones });
    }
    if (path === "/api/bridge/drones/recall") {
      drones = [];
      return answer({ ok: true, inSpace: drones });
    }
    if (path === "/api/bridge/drone-recovery/ready") {
      assert.equal(body.checkID, "check-42");
      return answer({ ok: true });
    }
    if (path === "/api/logout") return answer({ ok: false, error: "DRONE_RECOVERY_PENDING" }, 409);
    // The station panel's independent reads are irrelevant to this in-space
    // login test; their ordinary non-session errors are reported in that panel.
    return answer({ ok: false, error: "READ_FAILED" }, 500);
  }) as unknown as typeof fetch;
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: fetcher, browserPilotRecovery: true });
  return { flow, paths, store };
}

const lost = { itemID: 7, controlled: false, reconnectCandidate: true, activity: "idle" };

test("browser pilot selection starts recovery before bot, script and travel work", async () => {
  const { flow, paths } = browserPilot({ drones: [lost] });
  assert.throws(() => flow.requireAutomationReady(), /recovery/i);
  await flow.selectCharacter(42);
  await flow.retryDroneRecovery();
  assert.equal(flow.droneRecovery.get().phase, "ready");
  assert.doesNotThrow(() => flow.requireAutomationReady());
  assert.ok(paths.indexOf("/api/bridge/entity/drones/reconnect") < paths.indexOf("/api/bridge/drones/recall"));
  assert.ok(paths.indexOf("/api/bridge/drones/recall") < paths.indexOf("/api/bridge/drone-recovery/ready"));
  const flightReads = paths.filter(path => path === "/api/bridge/flight/status").length;
  await flow.retryDroneRecovery();
  assert.equal(paths.filter(path => path === "/api/bridge/flight/status").length, flightReads);
});

test("docked pilot skips drone reads; failed reconnect blocks all automation entry points", async () => {
  const docked = browserPilot({ docked: true });
  await docked.flow.selectCharacter(42);
  await docked.flow.retryDroneRecovery();
  assert.equal(docked.flow.droneRecovery.get().phase, "ready");
  assert.equal(docked.paths.includes("/api/bridge/drones"), false);

  const refused = browserPilot({ drones: [lost], reconnectFails: true });
  await refused.flow.selectCharacter(42);
  await refused.flow.retryDroneRecovery();
  assert.equal(refused.flow.droneRecovery.get().phase, "blocked");
  assert.throws(() => refused.flow.requireAutomationReady(), /Reconnect refused/);
  await assert.rejects(refused.flow.startCustomBot({} as never), /Reconnect refused/);
  await assert.rejects(refused.flow.startMiningBot({} as never), /Reconnect refused/);
  await assert.rejects(refused.flow.warpTo(6001), /Reconnect refused/);
  const route = await refused.flow.startRoute(6001);
  assert.equal(route.started, false);
  assert.equal(refused.paths.some(path => path.includes("/warp")), false);
  assert.equal(refused.paths.includes("/api/bridge/drone-recovery/ready"), false);
});

test("repeated recovery initialization shares one pending check", async () => {
  let release!: () => void;
  const holdDroneRead = new Promise<void>(resolve => { release = resolve; });
  const { flow, paths } = browserPilot({ holdDroneRead });
  await flow.selectCharacter(42);
  const first = flow.retryDroneRecovery();
  const second = flow.retryDroneRecovery();
  assert.equal(first, second);
  assert.throws(() => flow.requireAutomationReady(), /recovery/i);
  release();
  await first;
  assert.equal(flow.droneRecovery.get().phase, "ready");
  assert.equal(paths.filter(path => path === "/api/bridge/flight/status").length, 1);
});

test("refused pilot switch and logout preserve the held pilot's recovery proof", async () => {
  let release!: () => void;
  const holdDroneRead = new Promise<void>(resolve => { release = resolve; });
  const { flow, paths, store } = browserPilot({ drones: [lost], holdDroneRead });
  await flow.selectCharacter(42);
  await assert.rejects(flow.selectCharacter(43), /HTTP 409/);
  await assert.rejects(flow.logout(), /HTTP 409/);
  assert.equal(flow.droneRecovery.get().phase, "checking");
  assert.equal(store.station.get().online?.characterID, 42);
  release();
  await flow.retryDroneRecovery();
  assert.equal(flow.droneRecovery.get().phase, "ready");
  assert.equal(paths.filter(path => path === "/api/bridge/drone-recovery/ready").length, 1);
});
