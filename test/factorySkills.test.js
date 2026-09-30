"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactorySkills } = require("../src/factorySkills");
function harness() {
  let changed = false, blocked = false, cleanupFailed = false, bought = 0, readbacks = 0;
  const calls = [];
  const report = () => ({ policyVersion:1, stages:[{id:"PROCURER",fitting:{status:changed?"REVIEW_REQUIRED":"READY"}}],
    previews: { FAST:{stage:"PROCURER",requirements:[{typeID:11,level:3}]} } });
  const context = { account:{accountID:1,username:"BMiner9"},sessionID:"login1" };
  const service = createFactorySkills({ store:{listCharactersForAccount:async()=>[{characterID:10,accountID:2,corporationID:98}]}, data:{getSkillType:()=>({name:"Astrogeology"})},
    queues:{async review() { return { stage:"PROCURER", fresh:{report:report(),corporationID:98}, blockers: [{code:blocked?"UNKNOWN":"SKILLBOOK_REQUIRED",typeID:11}] }; }},
    sessions:{async withSessions(refs,fn) { calls.push(["select",refs.map(r=>r.characterID)]); const value=await fn(refs.map(r=>({userid:r.account.accountID,characterID:r.characterID,bridgeSessionID:"held"})));
      calls.push(["release"]); return {value,cleanup:[{characterID:9,released:!cleanupFailed}]}; }},
    gateway:{ async callMethod(){return {result:{type:"packedrow",fields:{corporationID:98,ceoID:99}}};}, async quoteFactorySkills(request) {calls.push(["quote",request]);return {reviewID:"private-runtime-review",canAcquire:true,expiresAt:Date.now()+180000,skills:[{typeID:11,price:"450000.00"}]};},
      async acquireFactorySkills(request) {bought++;calls.push(["buy",request]);return {verified:true,status:"SKILLS_ACQUIRED"};} },
    loadPilot: async()=>{if(bought)readbacks++;return {read:{report:report()}};},
  });
  const request={characterID:9,role:"MINER",mode:"FAST",stage:"PROCURER",selections:{}};
  return { service,context,request,calls,get bought(){return bought;},get readbacks(){return readbacks;},change(){changed=true;},block(){blocked=true;},failCleanup(){cleanupFailed=true;} };
}
test("review creates no purchase; runtime token stays private; apply rereads and releases before queue handoff", async()=>{
  const h=harness(); const q=await h.service.review(h.context,h.request,null); assert.equal(h.bought,0); assert.notEqual(q.reviewID,"private-runtime-review");
  const out=await h.service.acquire(h.context,{reviewID:q.reviewID,confirm:true,characterID:99,amount:1},null);
  assert.equal(out.readyForQueueReview,true); assert.equal(h.readbacks,1); assert.equal(h.calls.find(c=>c[0]==="buy")[1].trainee.characterID,9);
  assert.deepEqual(h.calls.map(c=>c[0]),["select","quote","release","select","buy","release"]);
  await assert.rejects(h.service.acquire(h.context,{reviewID:q.reviewID,confirm:true},null));
});
test("unaccepted/unknown plan blocks session selection and purchase",async()=>{const h=harness();h.block();await assert.rejects(h.service.review(h.context,h.request,null));assert.deepEqual(h.calls,[]);});
test("fitting changes after review block before acquisition",async()=>{const h=harness();const q=await h.service.review(h.context,h.request,null);h.change();await assert.rejects(h.service.acquire(h.context,{reviewID:q.reviewID,confirm:true},null),/changed/);assert.equal(h.bought,0);});
test("review bound to account AND exact authenticated web session",async()=>{const h=harness();const q=await h.service.review(h.context,h.request,null);
  for(const ctx of [{...h.context,sessionID:"other"},{...h.context,account:{accountID:2}}]) await assert.rejects(h.service.acquire(ctx,{reviewID:q.reviewID,confirm:true},null));assert.equal(h.bought,0);
  await assert.rejects(h.service.acquire(h.context,{reviewID:q.reviewID},null),/confirmation/);
});
test("funding authority explicit, bound to review, and not inferred from trainee",async()=>{const h=harness();
  await assert.rejects(h.service.review(h.context,{...h.request,policy:"CHARACTER_PLUS_CORPORATION_SHORTFALL"},null),/FUNDING_AUTHORITY_REQUIRED/);
  const funding={account:{accountID:2},sessionID:"officer-session",characterID:10};
  const q=await h.service.review(h.context,{...h.request,policy:"CHARACTER_PLUS_CORPORATION_SHORTFALL",trainingWallet:{corporationID:98,accountKey:1000}},funding);
  await assert.rejects(h.service.acquire(h.context,{reviewID:q.reviewID,confirm:true},{...funding,characterID:99}),/FUNDING_AUTHORITY_CHANGED/);assert.equal(h.bought,0);
});
test("failed release prevents actionable review or offline queue handoff",async()=>{const h=harness();h.failCleanup();const q=await h.service.review(h.context,h.request,null);assert.equal(q.reviewID,null);assert.equal(q.canAcquire,false);});

test("explicit Pioneer acquisition retains the reviewed target on every reread and never applies queue", async () => {
  const seen = [];
  const report = { targetStage:"PIONEER", policyVersion:1, stages:[{id:"PIONEER",fitting:{status:"READY"}}],
    previews:{FAST:{stage:"PIONEER",requirements:[{typeID:11,level:1}]}} };
  const context = {account:{accountID:1},sessionID:"session"};
  const service = createFactorySkills({data:{getSkillType:()=>({name:"Skill"})},
    queues:{review:async()=>({stage:"PIONEER",fresh:{report},blockers:[{code:"SKILLBOOK_REQUIRED",typeID:11}]})},
    sessions:{withSessions:async(refs, fn)=>({value:await fn([{}]),cleanup:[{released:true}]})},
    gateway:{quoteFactorySkills:async()=>({reviewID:"runtime",canAcquire:true,expiresAt:Date.now()+10000,skills:[]}),
      acquireFactorySkills:async()=>({verified:true,status:"SKILLS_ACQUIRED"})},
    loadPilot:async(args)=>{seen.push(args.targetStage);return {read:{report}};},
  });
  const q = await service.review(context,{characterID:10,mode:"FAST",targetStage:"PIONEER",stage:"PIONEER"},null);
  const out = await service.acquire(context,{reviewID:q.reviewID,confirm:true},null);
  assert.equal(out.stage,"PIONEER"); assert.deepEqual(seen,["PIONEER","PIONEER"]);
});

test("trainee self funding selects only the trainee and passes configured wallet",async()=>{
 const h=harness();const q=await h.service.review(h.context,{...h.request,policy:"CHARACTER_PLUS_CORPORATION_SHORTFALL",fundingMode:"SELF",trainingWallet:{corporationID:98,accountKey:1000}},null);
 assert.deepEqual(h.calls.find(c=>c[0]==="select")[1],[9]);assert.equal(h.calls.find(c=>c[0]==="quote")[1].fundingMode,"SELF");
 await h.service.acquire(h.context,{reviewID:q.reviewID,confirm:true},null);assert.equal(h.bought,1);
});
