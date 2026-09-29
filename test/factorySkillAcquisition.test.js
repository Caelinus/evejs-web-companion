"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactorySkillAcquisition } = require("../runtime-patches/factorySkillAcquisition");

function harness() {
  const entries = new Map([["trainee", { factoryOwned: true, session: { characterID: 9, corporationID: 98 }, userid: 1 }],
    ["officer", { factoryOwned: true, session: { characterID: 10, corporationID: 98 }, userid: 2 }]]);
  const records = { 9: { accountID: 1, value: { corporationID: 98 } }, 10: { accountID: 2, value: { corporationID: 98 } } };
  const funds = { personal: 12_000_000, corp: 100_000_000 };
  const prices = { 11: 450_000, 12: 1_050_000, 13: 30_000_000 };
  const injected = new Set(); const calls = [], journal = [], corpJournal = [];
  let permitted = true, divisionExists = true, failure = "", time = 0, afterTransfer = () => {};
  const d = {
    now: () => time, donationType: 10,
    getEntry(id, userid) { const e = entries.get(id); if (!e || e.userid !== userid) throw Object.assign(new Error("SESSION_NOT_FOUND"), { code: "SESSION_NOT_FOUND" }); return e; },
    getCorporationCEOID: () => 30,
    getCharacter(id) { return records[id]; },
    purchaseEnabled: () => true, injected: (char, id) => { assert.equal(char, 9); return injected.has(id); },
    wallet: () => ({ balance: funds.personal }), journal: () => journal, corpJournal: () => corpJournal,
    division: () => divisionExists ? { balance: funds.corp } : null,
    canTake: () => permitted,
    call(service, method, args, session) {
      calls.push({ service, method, args, char: session.characterID });
      if (method === "IsSkillAvailableForPurchase") return Boolean(prices[args[0]]);
      if (method === "GetDirectPurchasePrice") return prices[args[0]];
      assert.equal(session._factoryMutationPending, true);
      if (method === "GiveCashFromCorpAccount") {
        const [id, amount, key, reason] = args; assert.equal(id, 9); assert.ok([9,10].includes(session.characterID));
        if (failure === "silent-transfer") return null;
        funds.corp -= amount; funds.personal += amount;
        const entry = { description: reason, ownerID1: 98, ownerID2: 9, entryTypeID: 10, accountKey: key };
        corpJournal.push({ ...entry, amount: -amount }); journal.push({ ...entry, amount });
        afterTransfer(); return Promise.resolve(null);
      }
      assert.equal(method, "PurchaseSkills", "only pure direct purchase can mutate skills"); assert.equal(service, "skillHandler"); assert.equal(session.characterID, 9);
      if (failure === "buy") throw new Error("purchase rejected");
      funds.personal -= args[0].reduce((total, id) => total + prices[id], 0);
      if (failure === "after-debit") throw new Error("grant failure");
      args[0].slice(0, failure === "partial" ? 1 : undefined).forEach((id) => injected.add(id));
      return Promise.resolve(args[0]);
    },
  };
  const service = createFactorySkillAcquisition(d);
  const trainee = { bridgeSessionID: "trainee", userid: 1, characterID: 9 }, officer = { bridgeSessionID: "officer", userid: 2, characterID: 10 };
  const input = { trainee, officer, skillTypeIDs: [13, 11, 12], policy: "CHARACTER_PLUS_CORPORATION_SHORTFALL", division: 1000, trainingWallet: {corporationID:98,accountKey:1000} };
  return { service, d, input, funds, prices, injected, calls, records, entries,
    apply(q, extra = {}) { return service.acquire({ trainee, officer, reviewID: q.reviewID, confirm: true, ...extra }); },
    permission(value) { permitted = value; }, division(value) { divisionExists = value; }, fail(value) { failure = value; },
    afterTransfer(fn) { afterTransfer = fn; }, expire() { time += 180001; },
    mutations() { return calls.filter((c) => ["PurchaseSkills", "GiveCashFromCorpAccount"].includes(c.method)); } };
}
test("direct price authority, sorted missing skills and exact 19.5m shortfall; no money on review", () => {
  const h = harness(); const q = h.service.quote(h.input);
  assert.deepEqual(q.skills, [{ typeID: 11, price: "450000.00" }, { typeID: 12, price: "1050000.00" }, { typeID: 13, price: "30000000.00" }]);
  assert.equal(q.shortfall, "19500000.00"); assert.equal(q.total, "31500000.00"); assert.equal(q.canAcquire, true);
  assert.equal(h.mutations().length, 0);
});
test("funding through officer, direct buy through trainee, reread skills, no queue/book/market path", async () => {
  const h = harness(); const q = h.service.quote(h.input); const out = await h.apply(q);
  assert.equal(out.status, "SKILLS_ACQUIRED"); assert.equal(out.verified, true); assert.equal(out.funded, "19500000.00");
  assert.deepEqual(h.mutations().map((c) => [c.method, c.char]), [["GiveCashFromCorpAccount", 10], ["PurchaseSkills", 9]]);
  assert.equal(h.mutations()[0].args[1], 19_500_000); assert.equal(h.funds.personal, 0);
  assert.equal(h.entries.get("trainee").session._factoryMutationPending, false);
});
test("sufficient personal wallet does not access a corporation wallet or require officer", async () => {
  const h = harness(); h.funds.personal = 40_000_000; const q = h.service.quote({ ...h.input, policy: "CHARACTER_WALLET_ONLY", officer: null });
  const out = await h.apply(q, { officer: null }); assert.equal(out.verified, true); assert.equal(out.funded, "0.00");
  assert.equal(h.mutations().length, 1); assert.equal(h.funds.personal, 8_500_000);
});
test("insufficient personal-only review cannot spend", async () => {
  const h = harness(); const q = h.service.quote({ ...h.input, policy: "CHARACTER_WALLET_ONLY" });
  assert.deepEqual(q.blockers, ["INSUFFICIENT_PERSONAL_ISK"]); await assert.rejects(h.apply(q), /ACQUISITION_BLOCKED/); assert.equal(h.mutations().length, 0);
});
test("already injected skills excluded and repeat acquisition adds nothing", async () => {
  const h = harness(); h.injected.add(11); const q = h.service.quote(h.input); assert.deepEqual(q.skills.map((r) => r.typeID), [12,13]);
  await h.apply(q); const again = h.service.quote(h.input); assert.equal(again.canAcquire, false); assert.deepEqual(again.skills, []);
  await assert.rejects(h.apply(q), /REVIEW_REQUIRED/);
});
for (const [name, alter] of [
  ["price", h => h.prices[11]++], ["personal balance", h => h.funds.personal++], ["corp balance", h => h.funds.corp++],
  ["missing set", h => h.injected.add(11)], ["permission", h => h.permission(false)], ["membership", h => h.records[9].value.corporationID = 99],
  ["expiry", h => h.expire()],
]) test(`${name} change refuses before any transfer/purchase`, async () => {
  const h = harness(); const q = h.service.quote(h.input); alter(h); await assert.rejects(h.apply(q)); assert.equal(h.mutations().length, 0);
});
for (const [name, alter] of [
  ["foreign trainee account", h => h.input.trainee.userid = 2], ["character substitution", h => h.input.trainee.characterID = 10],
  ["missing officer", h => h.input.officer = null], ["foreign corporation", h => { h.records[10].value.corporationID = 99; h.entries.get("officer").session.corporationID = 99; }],
  ["invalid division", h => h.input.division = 999], ["absent division", h => h.division(false)], ["no Account Take", h => h.permission(false)],
]) test(`${name} fails closed`, () => { const h = harness(); alter(h); assert.throws(() => h.service.quote(h.input)); assert.equal(h.mutations().length, 0); });
test("insufficient corporation wallet blocks complete operation", async () => { const h = harness(); h.funds.corp = 1;
  const q = h.service.quote(h.input); assert.deepEqual(q.blockers, ["INSUFFICIENT_CORPORATION_ISK"]); await assert.rejects(h.apply(q)); assert.equal(h.mutations().length, 0); });
test("crafted amount/price/payer/skill list cannot alter the stored review", async () => {
  const h = harness(); const q = h.service.quote(h.input);
  await h.apply(q, { amount: 500_000_000, total: 1, payerID: 99, characterID: 99, skillTypeIDs: [999], division: 1006 });
  assert.equal(h.mutations()[0].args[1], 19_500_000); assert.equal(h.mutations()[0].args[2], 1000); assert.deepEqual(h.mutations()[1].args, [[11,12,13]]);
});
test("confirmation required and another account cannot consume review", async () => {
  const h = harness(); const q = h.service.quote(h.input); await assert.rejects(h.apply(q, { confirm: false }));
  await assert.rejects(h.apply(q, { trainee: { ...h.input.trainee, userid: 2 } })); assert.equal((await h.apply(q)).verified, true);
});
for (const [failure, status] of [["buy","FUNDING_TRANSFERRED_PURCHASE_FAILED"], ["partial","PARTIAL_SKILL_ACQUISITION"], ["after-debit","FUNDING_TRANSFERRED_PURCHASE_FAILED"], ["silent-transfer","FUNDING_UNVERIFIED"]])
  test(`${failure}: honest outcome, no retry or synthetic rollback`, async () => {
    const h = harness(); h.fail(failure); const out = await h.apply(h.service.quote(h.input));
    assert.equal(out.status, status); assert.equal(out.verified, false); assert.ok(h.mutations().length <= 2);
    if (failure !== "silent-transfer") assert.equal(out.funded, "19500000.00");
    if (failure === "buy") assert.equal(out.wallet, "31500000.00");
    if (failure === "partial") { assert.deepEqual(out.purchased, [11]); assert.deepEqual(h.service.quote(h.input).skills.map((r) => r.typeID), [12,13]); }
  });
test("balance change after funded transfer retains funds and refuses purchase", async () => {
  const h = harness(); h.afterTransfer(() => h.funds.personal++); const out = await h.apply(h.service.quote(h.input));
  assert.equal(out.status, "FUNDING_TRANSFERRED_PURCHASE_FAILED"); assert.equal(h.mutations().length, 1);
});
test("overlapping Factory operations rejected during asynchronous financial command", async () => {
  const h = harness(); const q1 = h.service.quote(h.input), q2 = h.service.quote(h.input);
  const call = h.d.call; let finish; h.d.call = (...args) => args[1] === "GiveCashFromCorpAccount" ? new Promise(resolve => { finish = () => resolve(call(...args)); }) : call(...args);
  const first = h.apply(q1); await assert.rejects(h.apply(q2), /FACTORY_BUSY/); finish(); assert.equal((await first).verified, true);
});


test("self funding uses one trainee authority, exact shortfall and both journal sides", async()=>{
 const h=harness(); const q=h.service.quote({...h.input,officer:null,fundingMode:"SELF"});
 const out=await h.apply(q,{officer:null}); assert.equal(out.verified,true);assert.equal(out.funded,"19500000.00");
 assert.deepEqual(h.mutations().map(c=>[c.method,c.char]),[["GiveCashFromCorpAccount",9],["PurchaseSkills",9]]);
 assert.equal(h.mutations()[0].args[1],19500000);assert.equal(h.entries.get("trainee").session._factoryMutationPending,false);
});
test("self funding requires configured matching wallet and Account Take",()=>{
 for(const wallet of [null,{corporationID:99,accountKey:1000},{corporationID:98,accountKey:1001}]) {
  const h=harness();assert.throws(()=>h.service.quote({...h.input,officer:null,fundingMode:"SELF",trainingWallet:wallet}),/TRAINING_WALLET_UNCONFIGURED/);assert.equal(h.mutations().length,0);
 }
 const h=harness();h.permission(false);assert.throws(()=>h.service.quote({...h.input,officer:null,fundingMode:"SELF"}),/UNAUTHORIZED/);
});
test("reviewed self mode cannot be replaced by crafted funding or amounts",async()=>{
 const h=harness();const q=h.service.quote({...h.input,officer:null,fundingMode:"SELF"});
 const out=await h.apply(q,{fundingMode:"AUTHORITY",trainingWallet:{corporationID:99,accountKey:1006},amount:999999999});
 assert.equal(out.verified,true);assert.equal(h.mutations()[0].char,9);assert.equal(h.mutations()[0].args[2],1000);
});

test("promoted CEO cannot use a pending financial review",async()=>{const h=harness();const q=h.service.quote(h.input);h.d.getCorporationCEOID=()=>9;await assert.rejects(h.apply(q),/CEO_AUTHORITY_NOT_ALLOWED/);assert.equal(h.mutations().length,0);});
