"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMiningSupportStopHandler } = require("./miningSupportStopRoute");
function fixture() {
  const held = { bridgeSessionID: "own", accountID: 4, characterID: 4, activeShipID: 40, solarSystemID: 3001 };
  const claim = { held, association: { operationID: "op" } };
  const state = { claim, assignment: { role: "COMMAND", support: { characterID: 4 }, supportPolicy: { mode: "PAUSE" } },
    scene: { inSpace: true, shipID: 40, solarSystemID: 3001, sampledAtMs: 1000,
      ship: { itemID: 40, characterID: 4, shieldRatio: 0.2, armorRatio: 1, hullRatio: 1 } }, stops: [], reads: 0, now: 2000 };
  const handler = createMiningSupportStopHandler({ requireClaim: () => state.claim, assignment: () => state.assignment,
    readSpace: async () => { state.reads++; if (state.duringRead) state.duringRead(); return state.scene; },
    stop: op => state.stops.push(op), now: () => state.now });
  const invoke = async (reason = "emergency-health-floor") => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ body: reason ? { reason } : {} }, res, error => { throw error; });
    return res;
  };
  return { state, held, invoke };
}
test("fresh own low health authorizes normal operation Stop with PAUSE configured", async () => {
  const { state, invoke } = fixture();
  assert.equal((await invoke()).statusCode, 202);
  assert.deepEqual(state.stops, ["op"]);
  assert.equal(state.reads, 1);
});
test("unknown, healthy, invalid sample, docked, other pilot/ship/system cannot authorize emergency", async () => {
  for (const mutate of [
    s => { s.ship.shieldRatio = null; s.ship.armorRatio = null; s.ship.hullRatio = null; },
    s => { s.ship.shieldRatio = false; s.ship.armorRatio = ""; s.ship.hullRatio = null; },
    s => { s.ship.shieldRatio = 0.25; }, s => { s.sampledAtMs = -8000; }, s => { s.sampledAtMs = null; },
    s => { s.inSpace = false; }, s => { s.ship.characterID = 5; }, s => { s.shipID = 41; },
    s => { s.ship.itemID = 41; }, s => { s.solarSystemID = 3002; },
  ]) {
    const { state, invoke } = fixture(); mutate(state.scene);
    assert.equal((await invoke()).body.error, "SUPPORT_EMERGENCY_UNCONFIRMED");
    assert.deepEqual(state.stops, []);
  }
});
test("fresh own gateway read supports an offset scene clock; slow/invalid wall receipt is refused", async () => {
  const f = fixture(); f.state.scene.sampledAtMs = 0;
  assert.equal((await f.invoke()).statusCode, 202);
  for (const at of [12000, 1999, NaN]) {
    const f = fixture(); f.state.duringRead = () => { f.state.now = at; };
    assert.equal((await f.invoke()).body.error, "SUPPORT_EMERGENCY_UNCONFIRMED");
    assert.deepEqual(f.state.stops, []);
  }
});
test("a genuine zero health layer is a valid emergency, missing is not zero", async () => {
  const { state, invoke } = fixture(); state.scene.ship.shieldRatio = 0;
  assert.equal((await invoke()).statusCode, 202);
});
test("configured COMMAND and unchanged held identity/operation are required after the read", async () => {
  for (const mutation of [
    f => { f.state.claim = { ...f.state.claim, held: { ...f.held } }; },
    f => { f.held.bridgeSessionID = "replacement"; }, f => { f.held.activeShipID = 41; },
    f => { f.held.accountID = 5; },
    f => { f.held.characterID = 5; }, f => { f.held.solarSystemID = 3002; },
    f => { f.state.claim = { ...f.state.claim, association: { operationID: "other" } }; },
    f => { f.state.assignment = { role: "MINER", support: { characterID: 4 } }; },
  ]) {
    const f = fixture(); f.state.duringRead = () => mutation(f);
    assert.equal((await f.invoke()).body.error, "OPERATION_CLAIM_CHANGED");
    assert.deepEqual(f.state.stops, []);
  }
  const f = fixture(); f.state.assignment.role = "MINER";
  assert.equal((await f.invoke()).body.error, "SUPPORT_EMERGENCY_NOT_APPLICABLE"); assert.equal(f.state.reads, 0);
});
test("existing support loss STOP remains applicable without an emergency health read", async () => {
  const { state, invoke } = fixture();
  assert.equal((await invoke(null)).body.error, "SUPPORT_STOP_POLICY_NOT_APPLICABLE");
  state.assignment.supportPolicy.mode = "STOP";
  assert.equal((await invoke(null)).statusCode, 202);
  assert.equal(state.reads, 0); assert.deepEqual(state.stops, ["op"]);
});
