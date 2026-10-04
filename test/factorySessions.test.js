"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactorySessions } = require("../src/factorySessions");
function harness() {
  const calls = [], operations = new Map(), held = new Map(); let owner = "offline", claim = null, badRelease = false;
  const store = { async listCharactersForAccount(id) { return id === 1 ? [{ characterID: 9 }] : [{ characterID: 10 }]; } };
  const gateway = {
    async getCharacterStatus(a, id) { return { characterID: id, online: owner !== "offline", controlState: owner }; },
    async selectCharacter(args, _, fields) { const [id]=args;assert.deepEqual(args,[id,null,true]);assert.equal(fields.userid,1);calls.push(["select", id]); owner = "retail_client"; return { bridgeSessionID: `handle${id}`, session: { characterID: id } }; },
    async releaseBridgeSession(id, fields) { calls.push(["release", id, fields.userid]); if (badRelease) throw new Error("timeout"); owner = "offline"; return { released: true }; },
  };
  const session = createFactorySessions({ store, gateway, operations, heldSessions: held, botHost: { claimedBy: () => claim } });
  return { session, calls, operations, held, gateway, ref: { account: { accountID: 1 }, characterID: 9 },
    owner(v) { owner = v; }, bot(v) { claim = v; }, failRelease() { badRelease = true; } };
}
test("free pilot uses dedicated session and releases exact owned handle after success", async () => {
  const h = harness(); const out = await h.session.withSessions([h.ref], async ([ref]) => { assert.equal(ref.bridgeSessionID, "handle9"); return "done"; });
  assert.equal(out.value, "done"); assert.equal(out.cleanup[0].released, true); assert.deepEqual(h.calls, [["select",9],["release","handle9",1]]); assert.equal(h.operations.size,0);
});
for (const owner of ["retail_client", "browser_pilot", "recovery", "MCC"]) test(`refuses ${owner} without taking/releasing existing session`, async () => {
  const h = harness(); h.owner(owner); await assert.rejects(h.session.withSessions([h.ref], () => assert.fail())); assert.deepEqual(h.calls, []);
});
test("bot and pending recovery refuse before selection", async () => {
  for (const mode of ["bot", "recovery", "browser"]) {
    const h = harness(); if (mode === "bot") h.bot(8); else h.held.set("other", { characterID:9, droneRecoveryReady: mode !== "recovery" });
    await assert.rejects(h.session.withSessions([h.ref], () => assert.fail())); assert.deepEqual(h.calls, []);
  }
});
test("Factory does not borrow even a same-account interactive session", async () => {
  const h = harness(); h.held.set("mine", { characterID:9, accountID:1, droneRecoveryReady:true });
  await assert.rejects(h.session.withSessions([h.ref], () => assert.fail())); assert.equal(h.held.size,1); assert.deepEqual(h.calls,[]);
});
test("action failure releases Factory session; no bot/control claim exists", async () => {
  const h = harness(); await assert.rejects(h.session.withSessions([h.ref], () => { throw new Error("buy failed"); }), /buy failed/);
  assert.equal(h.calls[1][0], "release"); assert.equal(h.operations.size,0);
});
test("release ambiguity retains reservation and reports recovery, never says OFF", async () => {
  const h = harness(); h.failRelease(); const out = await h.session.withSessions([h.ref], () => "done");
  assert.equal(out.cleanup[0].code, "FACTORY_SESSION_RELEASE_FAILED"); assert.equal((await h.session.status(h.ref.account,9)).owner,"RECOVERY");
  await assert.rejects(h.session.withSessions([h.ref], () => assert.fail()));
  h.owner("offline"); assert.equal((await h.session.status(h.ref.account,9)).owner,"OFF"); assert.equal(h.operations.size,0);
});
test("cross-account pilot refused before selection", async () => {
  const h = harness(); await assert.rejects(h.session.withSessions([{...h.ref, account:{accountID:2}}], () => assert.fail())); assert.deepEqual(h.calls,[]);
});
test("released handle with pilot still online never enables offline queue handoff", async () => {
  const h = harness(); h.gateway.releaseBridgeSession = async () => ({ released:true });
  const out = await h.session.withSessions([h.ref], () => "done"); assert.equal(out.cleanup[0].released,false);
  assert.equal((await h.session.status(h.ref.account,9)).owner,"RECOVERY");
});
test("same-character reservation prevents overlap", async () => {
  const h = harness(); let done; const first = h.session.withSessions([h.ref], () => new Promise(r => { done=r; }));
  while (!done) await new Promise(r => setImmediate(r));
  await assert.rejects(h.session.withSessions([h.ref], () => assert.fail())); done("done"); await first; assert.equal(h.calls.length,2);
});

test("offline provisioning is refused before acquisition even if private Factory methods are supplied", async () => {
  const h=harness();h.gateway.selectFactoryCharacter=()=>assert.fail("Retired private authority");
  await assert.rejects(h.session.withSessions([h.ref],()=>assert.fail(),{purpose:"PROVISIONING"}),{code:"PROVISIONING_OFFLINE_AUTHORITY_UNAVAILABLE"});
  assert.deepEqual(h.calls,[]);assert.equal(h.operations.size,0);
});
