"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{once}=require("node:events");
const {createApp}=require("../src/server"),client=require("../src/eveGatewayClient");
test("real Training acquisition routes report stock unavailability without selecting, funding, or changing the queue",async t=>{
 const gateway=new Proxy({}, {get:()=>()=>assert.fail("Unsupported purchase must not reach gateway")});
 const app=createApp({webAuth:{verifySessionToken:token=>token==="owner"?{username:"owner",accountID:1,sessionID:"web-owner"}:null},
   eveStore:{getAccount:async()=>({username:"owner",accountID:1,banned:false})},eveGatewayClient:gateway,errorLogger(){}});
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 for(const action of ["review","acquire"]){
  const url=`http://127.0.0.1:${server.address().port}/api/pilot-training/skills/${action}`;
  const req=token=>fetch(url,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({characterID:7,confirm:true,funding:{token:"officer",characterID:8}})});
  assert.equal((await req("invalid")).status,401);const response=await req("owner"),body=await response.json();
  assert.equal(response.status,409);assert.equal(body.ok,false);assert.equal(body.error,"SKILL_ACQUISITION_UNAVAILABLE");assert.match(body.message,/stock.*gateway/i);
 }
 assert.equal(app.locals.bridgeSessions.size,0);assert.doesNotThrow(()=>app.locals.replenishment.assertWritable(7));
});
test("stock release acknowledgement does not manufacture offline proof or expose private endpoint methods",async t=>{
 const original=global.fetch;t.after(()=>global.fetch=original);let url;
 global.fetch=async u=>{url=String(u);return Response.json({source:"evejs-web-gateway",apiVersion:1,ok:true,released:true,characterID:7});};
 const release=await client.releaseBridgeSession("own-handle",{userid:1});assert.deepEqual(release,{released:true,characterID:7});assert.match(url,/session\/release$/);
 for(const name of ["selectFactoryCharacter","quoteFactorySkills","acquireFactorySkills","getProvisioningObservation"])assert.equal(client[name],undefined);
});
