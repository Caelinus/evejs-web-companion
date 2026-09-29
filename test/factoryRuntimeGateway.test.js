"use strict";
// Exercise the deployed gateway methods with in-memory boundaries, without
// importing gameStore or booting the world. Set FACTORY_RUNTIME_ROOT explicitly.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = process.env.FACTORY_RUNTIME_ROOT;
const source = root && fs.readFileSync(path.join(root,"server/src/_secondary/express/evejsWebGatewayRuntime.js"),"utf8");
function harness({ online=false, closing=false, accountID=4, ceoID=30 }={}) {
  const calls=[], sessions=new Map(); let snapshot={online,controlState:online?"retail_client":"offline"};
  const begin=source.indexOf("    selectFactoryCharacter(request) {");
  const end=source.indexOf("    // R5a flight status",begin);
  assert.ok(begin>0 && end>begin);
  const ctx={
    WEB_SELECT_CHARACTER_CALL:{service:"charUnboundMgr",method:"SelectCharacterID"},
    normalizeWebCallRequest:r=>({...r,sessionFields:r.session}),isAllowlistedWebCall:()=>true,
    serviceManager:{lookup:()=>({callMethod(method,args,session){calls.push("select");session.characterID=args[0];snapshot={online:true,controlState:"retail_client"};return null;}})},
    getCharacter:()=>({accountID,value:{corporationID:98}}), require:()=>({getCorporationRecord:()=>({ceoID})}), characterControlRuntime:{getCharacterControlSnapshot:()=>snapshot},
    sessionRegistry:{findSessionByCharacterID:()=>closing?{}:null,register:()=>calls.push("register")},
    createNotificationSink:()=>({bind(){}}), materializePersistentBrowserSession:()=>({}),
    browserSessionClientIDCounter:0,BROWSER_SESSION_CLIENT_ID_BASE:100,nowMs:Date.now,
    crypto:require("node:crypto"),browserSessions:sessions,sessionEvents:{publish(){}},
    encodeJsonSafeCallValue:x=>x,startBrowserSessionSweep(){},log:{info(){}},
    webCallError:(code,message)=>Object.assign(new Error(message),{code}),
    discardMintedSession(){calls.push("discard");},toWebCallDispatchError:e=>e,
    normalizeBridgeSessionID:x=>x,isPlainObject:x=>!!x,
    getBrowserSessionEntry:(id,user)=>{const e=sessions.get(id);if(!e||user!==e.userid)throw new Error("SESSION_NOT_FOUND");return e;},
    teardownBrowserSession:entry=>{calls.push("release");sessions.delete(entry.bridgeSessionID);snapshot={online:false,controlState:"offline"};return entry.session.characterID;},
  };
  return {api:vm.runInNewContext(`({${source.slice(begin,end)}})`,ctx),calls,sessions};
}
test("Factory gateway patch places lifecycle guards and methods at their owning seams", { skip: !root }, () => {
  const expiry = source.slice(source.indexOf("  function expireIdleBrowserSessions()"),
    source.indexOf("  function getBrowserSessionEntry("));
  assert.match(expiry, /for \(const entry of \[\.\.\.browserSessions\.values\(\)\]\) \{\s*if \(entry\.session\._factoryMutationPending\) continue;/);
  const factory = source.indexOf("    selectFactoryCharacter(request) {");
  const select = source.indexOf("    async selectCharacter(request) {");
  assert.ok(factory > 0 && select > factory, "Factory methods must be gateway methods before SelectCharacter");
  const release = source.slice(source.indexOf("    releaseBrowserSession(request) {"), source.indexOf("    // R5a flight status"));
  assert.match(release, /_factoryMutationPending[\s\S]*teardownBrowserSession[\s\S]*getCharacterControlSnapshot[\s\S]*offline:/);
});
test("runtime free-only selection blocks online, closing, and wrong-account pilots before dispatch",{skip:!root},async()=>{
  for(const options of [{online:true},{closing:true},{accountID:5},{ceoID:7},{ceoID:null}]) {
    const h=harness(options);await assert.rejects(h.api.selectFactoryCharacter({args:[7,null,true],session:{userid:4}}));assert.deepEqual(h.calls,[]);
  }
});
test("runtime marks Factory-owned live handle and refuses release during financial mutation",{skip:!root},async()=>{
  const h=harness();const result=await h.api.selectFactoryCharacter({args:[7,null,true],session:{userid:4}});
  assert.equal(result.session.characterID,7);const entry=h.sessions.get(result.bridgeSessionID);assert.equal(entry.factoryOwned,true);
  entry.session._factoryMutationPending=true;
  assert.throws(()=>h.api.releaseBrowserSession({bridgeSessionID:result.bridgeSessionID,session:{userid:4}}),/FACTORY_BUSY/);
  assert.equal(h.sessions.size,1);entry.session._factoryMutationPending=false;
  const released=h.api.releaseBrowserSession({bridgeSessionID:result.bridgeSessionID,session:{userid:4}});
  assert.equal(released.offline,true);assert.deepEqual(h.calls,["register","select","release"]);
});
