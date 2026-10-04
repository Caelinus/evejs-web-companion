"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{once}=require("node:events");
const {createApp}=require("./server");
test("P2/P3 stock account preflight selects nobody; explicit HTTP Apply owns selected parser/engine then releases",async t=>{
 let online=false,selections=0,releases=0,selectedReads=0;
 const object=fields=>({type:"object",args:{type:"dict",entries:Object.entries(fields)}}),list=items=>({type:"list",items});
 const row=(itemID,typeID,locationID,flagID,singleton)=>({type:"packedrow",fields:{itemID,typeID,ownerID:11,locationID,flagID,singleton,quantity:1}});
 // Historical private methods deliberately do not exist in this fixture.
 const gateway={
  async getCharacterStatus(accountID,characterID){assert.equal(accountID,7);return{characterID,online,controlState:online?"retail_client":"offline"};},
  async selectCharacter(args,kwargs,fields){assert.deepEqual(args,[11,null,true]);assert.equal(fields.userid,7);selections++;online=true;return{bridgeSessionID:"exact-stock-handle",session:{characterID:11,corporationID:20,stationID:60,shipID:50}};},
  async releaseBridgeSession(handle){assert.equal(handle,"exact-stock-handle");releases++;online=false;return{released:true,characterID:11};},
  async readFlightStatus(handle){assert.equal(handle,"exact-stock-handle");selectedReads++;return{flight:{shipID:50,shipTypeID:1,docked:true,stationID:60},notifications:[]};},
  async callMethod(service,method,args,kwargs,fields,handle){assert.equal(service,"corpFittingMgr");assert.equal(method,"GetFittings");assert.equal(handle,undefined);
   return{result:{type:"dict",entries:[[4,object({fittingID:4,ownerID:20,shipTypeID:1,name:"Exact frigate",savedDate:{type:"long",value:"100"},fitData:list([{type:"tuple",items:[2,27,1]}])})]]}};},
  async bindObject(service,method,args){assert.equal(service,"invbroker");return{boundHandle:args[0],notifications:[]};},
  async callBoundMethod(service,method,args,kwargs,fields,handle,bound){assert.equal(handle,"exact-stock-handle");selectedReads++;
   if(method==="ListByFlags")return{result:list([row(90,2,50,27,1)])};
   assert.equal(method,"List");return{result:list(bound===60?[row(50,1,60,4,1)]:[])};}
 };
 const app=createApp({webAuth:{verifySessionToken:token=>token==="owner"?{username:"owner",accountID:7,sessionID:"web-owner"}:null},
   eveStore:{getAccount:async()=>({username:"owner",accountID:7,banned:false}),listCharactersForAccount:async()=>[{accountID:7,characterID:11,characterName:"Test01",corporationID:20}]},
   staticData:{getType:id=>({1:{categoryID:6,groupID:25},2:{categoryID:7,groupID:54}})[id],getTypeName:id=>`Type ${id}`},eveGatewayClient:gateway,errorLogger(){}});
 const server=app.listen(0,"127.0.0.1");await once(server,"listening");t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const request=async(action,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/ship-provisioning/${action}`,{method:body?"POST":"GET",headers:{authorization:"Bearer owner","content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()};};
 const roster=await request("roster");assert.equal(roster.status,200);assert.equal(roster.body.pilots[0].status.equipment,"UNKNOWN");
 const preflight=await request("review?characterID=11&providerCharacterID=11&fittingID=4&sourceKind=hangar");
 assert.equal(preflight.status,200,JSON.stringify(preflight));assert.equal(preflight.body.status.equipment,"UNKNOWN");assert.equal(preflight.body.candidateSource.take,"UNKNOWN");
 assert.equal(preflight.body.applyReview.canApply,true);assert.equal(selections,0);assert.equal(selectedReads,0);assert.equal(app.locals.bridgeSessions.size,0);
 const accepted=preflight.body.applyReview;
 const outcome=await request("apply",{reviewID:accepted.reviewID,reviewHash:accepted.reviewHash,confirm:true});
 assert.equal(outcome.status,200,JSON.stringify(outcome));assert.equal(outcome.body.outcome.state,"ALREADY_SATISFIED",JSON.stringify(outcome));
 assert.equal(outcome.body.outcome.finalReview.status.equipment,"VERIFIED");assert.equal(outcome.body.outcome.release.state,"VERIFIED_OFFLINE");
 assert.equal(selections,1);assert.equal(releases,1);assert.ok(selectedReads>0);assert.equal(app.locals.bridgeSessions.size,0);
 assert.doesNotMatch(JSON.stringify(outcome),/exact-stock-handle/);
});
