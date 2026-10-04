"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{once}=require("node:events");
const {createApp}=require("./server");
test("real standalone provisioning routes refuse stock-unavailable authority before any acquisition or observation",async t=>{
 const gateway=new Proxy({}, {get:()=>()=>assert.fail("No private authority or pilot selection")});
 const app=createApp({webAuth:{verifySessionToken:token=>token==="owner"?{username:"owner",accountID:1,sessionID:"web-owner"}:null},
   eveStore:{getAccount:async()=>({username:"owner",accountID:1,banned:false})},eveGatewayClient:gateway,errorLogger(){}});
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 for(const [action,method] of [["roster","GET"],["review","GET"],["apply","POST"]]){
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/ship-provisioning/${action}`,{method,headers:{authorization:"Bearer owner","content-type":"application/json"},...(method==="POST"?{body:JSON.stringify({confirm:true})}:{})});
  const body=await response.json();assert.equal(response.status,409);assert.equal(body.ok,false);assert.equal(body.error,"PROVISIONING_OFFLINE_AUTHORITY_UNAVAILABLE");assert.match(body.message,/Ready Fit/);
 }
 assert.equal(app.locals.bridgeSessions.size,0);assert.doesNotThrow(()=>app.locals.replenishment.assertWritable(7));
});
