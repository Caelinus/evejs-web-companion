"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createTrainingOnboarding, RIGHTS } = require("../src/trainingOnboarding");
function harness() {
  const chars = [{accountID:1,characterID:10,corporationID:1},{accountID:2,characterID:20,corporationID:98}];
  const ctx={account:{accountID:1},sessionID:"trainee-web"}, authority={account:{accountID:2},characterID:20,sessionID:"authority-web"};
  const request={enabled:true,characterID:10,corporationID:98,rights:"FULL_ACCESS_EXCEPT_CEO"};
  let ceoID=30, sourceCEO=50, director=true, failAt="", online=false, changedAt="", app=null;
  const roles={roles:"0",blockRoles:0}, writes=[], leases=[];
  const wrap=(fields)=>({result:{type:"packedrow",fields}});
  const service=createTrainingOnboarding({store:{listCharactersForAccount:async(id)=>chars.filter(c=>c.accountID===id)},
    sessions:{status:async()=>({owner:online?"OTHER_SESSION":"OFF"}),withSessions:async(refs,fn)=>{
      leases.push(refs.map(r=>r.characterID));const value=await fn(refs.map(r=>({userid:r.account.accountID,characterID:r.characterID,bridgeSessionID:`held-${r.characterID}`})));
      return {value,cleanup:refs.map(r=>({characterID:r.characterID,released:true}))};}},
    gateway:{callMethod:async(service,method,args,kw,session,bridge)=>{
      assert.equal(service,"corpRegistry");
      if(method==="GetCorporation")return wrap({corporationID:session.corpid,ceoID:session.corpid===1?sourceCEO:ceoID,corporationName:"Test corp"});
      if(method==="GetMember")return wrap({characterID:args[0],corporationID:98,...(args[0]===20?{roles:director?"1":"0"}:roles)});
      if(method==="GetMyApplications")return {result:{type:"dict",entries:app?[[98,{type:"list",items:[{type:"packedrow",fields:{...app}}]}]]:[]}};
      assert.ok(bridge,"mutations must use actual live leases");writes.push({method,args,characterID:session.characterID});
      if(method===failAt)throw Object.assign(new Error("ambiguous"),{code:"TRANSPORT_UNKNOWN"});
      if(method==="InsertApplication") {app={applicationID:5,corporationID:98,characterID:10,status:0};return {result:5};}
      if(method==="UpdateApplicationOffer"){app.status=args[4];if(args[4]===2)chars[0].corporationID=98;}
      if(method==="UpdateMember")Object.assign(roles,RIGHTS);
      if(method===changedAt)ceoID=77;
      return {result:null};
    }}});
  return {service,ctx,authority,request,writes,leases,chars,roles,ceo:()=>ceoID,setCEO:x=>ceoID=x,setSourceCEO:x=>sourceCEO=x,director:x=>director=x,fail:x=>failAt=x,busy:()=>online=true,changeAfter:x=>changedAt=x};
}
test("disabled, unconfigured, foreign trainee, wrong corp and CEO authority refuse before selection",async()=>{
  for(const change of [h=>h.request.enabled=false,h=>h.request.corporationID=null,h=>h.request.characterID=99,h=>h.request.corporationID=99,h=>h.setCEO(20),h=>h.setCEO(10),h=>h.director(false),h=>h.busy()]){
    const h=harness();change(h);await assert.rejects(h.service.review(h.ctx,h.request,h.authority));assert.deepEqual(h.leases,[]);assert.deepEqual(h.writes,[]);
  }
});
test("authoritative application/offer/accept/full ordinary roles, reread and unchanged CEO",async()=>{
  const h=harness();const review=await h.service.review(h.ctx,h.request,h.authority);assert.deepEqual(h.writes,[]);
  const out=await h.service.apply(h.ctx,{reviewID:review.reviewID,confirm:true},h.authority);
  assert.equal(out.verified,true);assert.equal(out.ceoID,30);assert.equal(h.ceo(),30);assert.equal(h.chars[0].corporationID,98);
  assert.deepEqual(h.writes.map(w=>w.method),["InsertApplication","UpdateApplicationOffer","UpdateApplicationOffer","UpdateMember"]);
  assert.deepEqual(h.writes.map(w=>w.characterID),[10,20,10,20]);assert.deepEqual(h.leases,[[10,20]]);
  assert.equal(BigInt(h.roles.roles)&1n,0n);assert.equal(out.cleanup.every(c=>c.released),true);
  await assert.rejects(h.service.apply(h.ctx,{reviewID:review.reviewID,confirm:true},h.authority));
});
test("NONE policy joins without assigning roles; already-member skips join",async()=>{
  const h=harness();h.request.rights="NONE";h.chars[0].corporationID=98;
  const q=await h.service.review(h.ctx,h.request,h.authority);const o=await h.service.apply(h.ctx,{reviewID:q.reviewID,confirm:true},h.authority);
  assert.equal(o.verified,true);assert.deepEqual(h.writes,[]);
});
test("cross-account/cross-session/crafted authority or corporation cannot change reviewed target",async()=>{
  const h=harness(),q=await h.service.review(h.ctx,h.request,h.authority);
  await assert.rejects(h.service.apply({...h.ctx,sessionID:"other"},{reviewID:q.reviewID,confirm:true},h.authority));
  await assert.rejects(h.service.apply(h.ctx,{reviewID:q.reviewID,confirm:true},{...h.authority,characterID:99}));
  const out=await h.service.apply(h.ctx,{reviewID:q.reviewID,confirm:true,corporationID:999,characterID:999},h.authority);
  assert.equal(out.corporationID,98);assert.equal(h.chars[0].corporationID,98);
});
test("CEO promotion or membership change after review refuses without acquisition",async()=>{
  const h=harness(),q=await h.service.review(h.ctx,h.request,h.authority);h.setCEO(20);
  await assert.rejects(h.service.apply(h.ctx,{reviewID:q.reviewID,confirm:true},h.authority));assert.deepEqual(h.leases,[]);
});
test("source corporation CEO cannot be acquired or moved, including promotion after review",async()=>{
  for(const afterReview of [false,true]) {
    const h=harness();
    const q=afterReview ? await h.service.review(h.ctx,h.request,h.authority) : null;
    h.setSourceCEO(10);
    await assert.rejects(q ? h.service.apply(h.ctx,{reviewID:q.reviewID,confirm:true},h.authority) : h.service.review(h.ctx,h.request,h.authority),{code:"CEO_AUTHORITY_NOT_ALLOWED"});
    assert.deepEqual(h.leases,[]); assert.deepEqual(h.writes,[]);
  }
});
test("partial acceptance/grant failure is honest, never retries or synthetic rollback",async()=>{
  const h=harness(),q=await h.service.review(h.ctx,h.request,h.authority);h.fail("UpdateMember");
  const o=await h.service.apply(h.ctx,{reviewID:q.reviewID,confirm:true},h.authority);
  assert.equal(o.verified,false);assert.equal(o.status,"ONBOARDING_INCOMPLETE");assert.equal(o.corporationID,98);
  assert.ok(o.steps.includes("MEMBERSHIP_VERIFIED"));assert.equal(h.writes.filter(w=>w.method==="UpdateMember").length,1);
  assert.equal(o.cleanup.every(c=>c.released),true);
});
test("ambiguous application creation stops at that boundary",async()=>{
  const h=harness(),q=await h.service.review(h.ctx,h.request,h.authority);h.fail("InsertApplication");
  const o=await h.service.apply(h.ctx,{reviewID:q.reviewID,confirm:true},h.authority);assert.equal(o.verified,false);
  assert.deepEqual(h.writes.map(w=>w.method),["InsertApplication"]);assert.equal(h.chars[0].corporationID,1);
});
