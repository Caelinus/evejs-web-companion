"use strict";

// Public MCC routes and their real private ownership probe. Gateway and host
// are fixtures; failure occurs only after the caller's confirmed release.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { once } = require("node:events");
process.env.EVEJS_WEB_POC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mcc-handoff-"));
const { createApp } = require("../src/server");
const { createMiningOperations } = require("../src/miningOperations");
const { createMiningTargetBoard } = require("../src/miningTargetBoard");
const { createBeltMemory } = require("../src/beltMemory");

const account = { username: "fixture-miner", accountID: 44, role: "0", banned: false };
const characterID = 140000045, sessionID = "mcc-browser-fixture", token = "mcc-fixture-token";
const script = { scriptID: "fixture-miner", name: "Fixture miner", rev: 1, doc: {
  program: [
    { id: "mine", kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "nearest" } } } },
    { id: "deliver", kind: "macro", macro: "deliver-ore", args: {} },
  ],
} };

async function fixture(t, ownershipChange = null) {
  const calls = [], errors = [], heldSessions = new Map([[sessionID, {
    characterID, accountID: account.accountID, bridgeSessionID: "before-handoff", activeShipID: 9001,
    stationID: 60000004, droneRecoveryReady: true, boundHandles: new Map(), streamSubscribers: new Set(),
  }]]);
  let retailBusy = false;
  const gateway = {
    async readFlightStatus() { return { flight: { docked: true, shipID: 9001, stationID: 60000004 } }; },
    async releaseBridgeSession(id) { calls.push(["release", id]); return { released: true }; },
    async getCharacterStatus(accountID, id) {
      calls.push(["status", accountID, id]);
      const status = { characterID: id, online: retailBusy, controlState: retailBusy ? "retail_client" : "offline" };
      if (ownershipChange === "after-offline-proof") retailBusy = true;
      return status;
    },
    async selectFactoryCharacter(accountID, id) {
      calls.push(["free-select", accountID, id]);
      if (retailBusy) throw Object.assign(new Error("A retail client acquired the pilot."), { code: "PILOT_BUSY" });
      return { bridgeSessionID: "restored-free", session: { characterID: id, characterName: "Fixture miner",
        shipID: 9001, stationID: 60000004, solarSystemID: 30000001 }, notifications: [] };
    },
    async selectCharacter() { calls.push(["takeover-select"]); throw new Error("Rollback must use free-only selection."); },
    async callMethod() { return { result: {}, notifications: [] }; },
  };
  const host = {
    listAll: () => [], claimedBy: () => null, authorizesClaim: () => false,
    async start(input) {
      assert.equal(input.callerSessionID, sessionID);
      await input.beforeStart();
      assert.equal(heldSessions.has(sessionID), false, "the host fails after actual caller release");
      calls.push(["host-failed"]);
      if (ownershipChange === "after-release") retailBusy = true;
      return { ok: false, code: "BOT_START_FAILED", message: "Injected host failure after release." };
    },
  };
  const definition = { operationID: "handoff-operation", name: "Fixture operation", unloadPolicy: "SELF_UNLOAD",
    area: { anchorSystemID: 30000001, anchorSystemName: "Fixture system", reach: "CURRENT_SYSTEM", targetClasses: ["BELT"] },
    members: [{ characterID, accountName: account.username, characterName: "Fixture miner", role: "MINER",
      routineMode: "CUSTOM", automationID: script.scriptID }],
  };
  const operationStore = { get: id => id === definition.operationID ? definition : null, list: () => [definition] };
  const targetBoard = createMiningTargetBoard();
  const operations = createMiningOperations({ store: operationStore, targetBoard, beltMemory: createBeltMemory() });
  const app = createApp({
    eveStore: { getAccount: async name => name === account.username ? account : null,
      getCharacterForAccount: async (id, pilot) => id === account.accountID && pilot === characterID ? { characterID } : null },
    webAuth: { verifySessionToken: value => value === token ? { username: account.username, accountID: account.accountID, sessionID } : null },
    eveGatewayClient: gateway, botHost: host, bridgeSessionStore: heldSessions,
    botScriptStore: { get: id => id === script.scriptID ? script : null, list: () => [script] },
    miningOperationStore: operationStore, miningOperations: operations, miningTargetBoard: targetBoard,
    staticData: { getSolarSystem: id => id === 30000001 ? { solarSystemID: id, solarSystemName: "Fixture system" } : null },
    miningPreparation: { ready: value => value?.state === "VERIFIED", unresolved: () => false,
      plan: async () => ({ state: "READY", planHash: "fixture-equipment-plan",
        members: [{ characterID, state: "PENDING", intent: { operationID: definition.operationID, characterID } }] }) },
    errorLogger: error => errors.push(error),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(route, body) {
    const response = await fetch(baseUrl + route, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const publicState = await request("/api/mining-operations");
  assert.equal(publicState.status, 200);
  assert.equal(publicState.body.capabilities.defender.executable, true);
  assert.match(publicState.body.capabilities.defender.note, /Standard Defender only/);
  assert.match(publicState.body.capabilities.defender.note, /Custom defender routines are unsupported/);
  const plan = await request(`/api/mining-operations/${definition.operationID}/launch-plan`);
  assert.equal(plan.status, 200);
  const started = await request(`/api/mining-operations/${definition.operationID}/start`, {
    planHash: plan.body.planHash, grants: { [characterID]: { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 10 } },
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.results[0].error, "BOT_START_FAILED");
  assert.deepEqual(calls.slice(0, 2), [["release", "before-handoff"], ["host-failed"]]);
  return { calls, errors, heldSessions, started };
}

test("failed MCC handoff restores its released offline caller through free-only selection", async t => {
  const f = await fixture(t);
  assert.equal(f.heldSessions.get(sessionID)?.bridgeSessionID, "restored-free");
  assert.deepEqual(f.calls.filter(c => c[0] === "free-select"), [["free-select", account.accountID, characterID]]);
  assert.equal(f.calls.some(c => c[0] === "takeover-select"), false);
});

test("failed MCC handoff preserves a retail owner that acquired the released pilot", async t => {
  const f = await fixture(t, "after-release");
  assert.equal(f.heldSessions.has(sessionID), false);
  assert.equal(f.calls.some(c => c[0] === "status"), true, "rollback checks real control status despite its own reservation");
  assert.equal(f.calls.some(c => c[0] === "free-select" || c[0] === "takeover-select"), false);
});

test("MCC rollback cannot take over a retail login after the offline proof", async t => {
  const f = await fixture(t, "after-offline-proof");
  assert.equal(f.heldSessions.has(sessionID), false);
  assert.equal(f.calls.filter(c => c[0] === "free-select").length, 1, "atomic free-only selection refuses the late owner");
  assert.equal(f.calls.some(c => c[0] === "takeover-select"), false);
});
