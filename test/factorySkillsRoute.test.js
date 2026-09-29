"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../src/server");
const client = require("../src/eveGatewayClient");

test("HTTP acquisition authenticates both actors, owns the trainee, and never exposes handles or queues", async (t) => {
  const calls = [], online = new Set(); let unlocked = false;
  const corp = 98000001;
  const account = (name) => ({ username:name, accountID:name === "owner" ? 4 : name === "officer" ? 5 : 6, banned:false });
  const fitting = { type:"object", name:"util.KeyVal", args:{type:"dict",entries:[
    ["fittingID",7],["ownerID",corp],["shipTypeID",32880],["name","Venture"],
    ["savedDate",{type:"long",value:"134285151537020000"}], ["fitData",{type:"list",items:[{type:"tuple",items:[483,27,2]}]}],
  ]}};
  const app = createApp({
    webAuth:{verifySessionToken:token=>["owner","officer","other"].includes(token) ? {...account(token),sessionID:`web-${token}`} : null},
    eveStore:{getAccount:async name=>account(name),listCharactersForAccount:async id=>id === 4 || id === 5 ? [{accountID:id,characterID:id+3,corporationID:corp,characterName:`Pilot ${id}`}]:[]},
    staticData:{getType:id=>({typeID:id}),getSkillType:id=>({typeID:id,name:`Skill ${id}`}),getTypeDogma:id=>({attributes:id===32880?{182:3386,277:3}:{}})},
    botHost:{claimedBy:()=>null,authorizesClaim:()=>false},errorLogger(){},
    eveGatewayClient:{
      async getCharacterStatus(id,char) { if(char!==id+3) throw Object.assign(new Error("Account does not own pilot"),{code:"CHARACTER_ACCOUNT_MISMATCH",statusCode:403}); return {characterID:char,online:online.has(char),controlState:online.has(char)?"retail_client":"offline",stateVersion:"epoch.0"}; },
      async getSkills(id,char) { assert.equal(id,4); assert.equal(char,7);return {characterID:char,serverNowMs:1800000000000,skills:unlocked?[{typeID:3386,level:0,skillPoints:0}]:[],queue:{active:false,maxEntries:150,entries:[]}}; },
      async callMethod(service,method) { if(service==="corpRegistry") return {result:{type:"packedrow",fields:{corporationID:corp,ceoID:99}}}; assert.equal(service,"corpFittingMgr"); assert.equal(method,"GetFittings");return {result:{type:"dict",entries:[[7,fitting]]}}; },
      async selectFactoryCharacter(id,char) { calls.push(["select",id,char]); assert.equal(char,id+3);online.add(char);return {bridgeSessionID:`private-${char}`,session:{characterID:char}}; },
      async releaseBridgeSession(handle,fields) { calls.push(["release",handle]);online.delete(fields.userid+3);return {released:true,offline:true}; },
      async quoteFactorySkills(input) { calls.push(["quote",input]);assert.equal(input.trainee.userid,4);assert.deepEqual(input.skillTypeIDs,[3386]);return {reviewID:"runtime-private",expiresAt:Date.now()+180000,canAcquire:true,skills:[{typeID:3386,price:"100.00"}],blockers:[]}; },
      async acquireFactorySkills(input) { calls.push(["acquire",input]);assert.equal(input.trainee.characterID,7);assert.equal(input.officer.characterID,8);assert.equal(input.reviewID,"runtime-private");unlocked=true;return {status:"SKILLS_ACQUIRED",verified:true}; },
      selectCharacter(){assert.fail("Not cockpit selection");},saveOfflineSkillQueue(){assert.fail("No automatic queue");},readSpaceSnapshot(){assert.fail("No space read");},
    },
  });
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  async function post(action,body,token="owner") { const r=await fetch(`${base}/api/pilot-training/skills/${action}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});return {status:r.status,...await r.json()}; }
  const read=async(selections={})=>(await fetch(`${base}/api/pilot-training/miner?characterID=7&selections=${encodeURIComponent(JSON.stringify(selections))}`,{headers:{authorization:"Bearer owner"}})).json();
  const first=await read();const fit=first.fittings[0];
  const selections={VENTURE:{scope:"CORPORATION",ownerID:corp,fittingID:7,acceptedSavedDate:fit.savedDate,acceptedFingerprint:fit.fingerprint}};
  const pilot=await read(selections);const preview=pilot.report.previews.FAST;
  const request={characterID:7,role:"MINER",mode:"FAST",stage:preview.stage,displayedTargets:preview.targets,selections,policy:"CHARACTER_PLUS_CORPORATION_SHORTFALL",division:1000,trainingWallet:{corporationID:corp,accountKey:1000},funding:{token:"officer",characterID:8}};
  assert.equal((await post("review",request,"invalid")).status,401);
  assert.equal((await post("review",request,"other")).status,403);
  assert.equal((await post("review",{...request,funding:{token:"invalid",characterID:8}})).status,401);
  assert.equal(calls.length,0);
  const review=await post("review",request);assert.equal(review.status,200,JSON.stringify(review));
  assert.equal(JSON.stringify(review).includes("private"),false);assert.equal(online.size,0);
  assert.equal((await post("acquire",{reviewID:review.outcome.reviewID,confirm:true,funding:request.funding},"other")).status,409);
  assert.equal((await post("acquire",{reviewID:review.outcome.reviewID,funding:request.funding})).status,400);
  const outcome=await post("acquire",{reviewID:review.outcome.reviewID,confirm:true,funding:request.funding,characterID:999,amount:999999});
  assert.equal(outcome.status,200,JSON.stringify(outcome));assert.equal(outcome.outcome.readyForQueueReview,true);assert.equal(online.size,0);
  assert.equal(app.locals.bridgeSessions.size,0);assert.equal(calls.filter(c=>c[0]==="acquire").length,1);
});

test("gateway adapter uses only dedicated Factory routes and carries offline release proof",async(t)=>{
  const original=global.fetch;t.after(()=>{global.fetch=original;});const calls=[];
  global.fetch=async(url,init)=>{calls.push([String(url),JSON.parse(init.body)]);return Response.json({source:"evejs-web-gateway",apiVersion:1,ok:true,outcome:{bridgeSessionID:"private",session:{characterID:7}},released:true,offline:true,characterID:7});};
  await client.selectFactoryCharacter(4,7);await client.quoteFactorySkills({trainee:{bridgeSessionID:"private",userid:4,characterID:7}});
  await client.acquireFactorySkills({reviewID:"review",confirm:true});const release=await client.releaseBridgeSession("private",{userid:4});
  assert.deepEqual(calls.map(c=>new URL(c[0]).pathname.split("/").slice(-2).join("/")),["factory/session","factory/quote","factory/acquire","session/release"]);
  assert.deepEqual(calls[0][1],{args:[7,null,true],session:{userid:4}});assert.equal(release.offline,true);
});
