"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createProvisioningCenterApply}=require("./provisioningCenterApply"),{hash}=require("./provisioningContracts");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
function fixture(t){
 const operations=new Map();let online=true,unresolved=false;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"center-legacy-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const filePath=path.join(dir,"center.json");
 const pin={accountID:7,characterID:11};fs.writeFileSync(filePath,JSON.stringify({version:1,records:{"old-invocation":{kind:"CENTER_APPLY",accountID:7,characterID:11,state:"BLOCKED",pin,reviewHash:hash(pin),input:{},release:{state:"UNVERIFIED"}}}}));
 const service=createProvisioningCenterApply({filePath,operations,engine:{unresolved:()=>unresolved?[{}]:[]},gateway:{getCharacterStatus:async()=>({characterID:11,online,controlState:online?"retail_client":"offline"})}});
 const account={accountID:7};
 return{service,operations,account,offline(){online=false;},custody(){unresolved=true;}};
}
test("historical invocation cannot authorize a new selected maintenance intent",async t=>{
 const f=fixture(t);await assert.rejects(f.service.apply(f.account,{confirm:true,reviewID:"invented"}),{code:"REVIEW_REQUIRED"});assert.equal(f.service.journal.list().length,1);
});

const {fixture:stock}=require("../test/helpers/stockHostedMaintenance");
test("P1/P8/P12/P16 stock-only bounded Apply delegates to shared engine and proves exact release/offline",async()=>{
 const f=stock({modified:true}),review=f.prepare();assert.equal(f.calls.length,0);
 const result=await f.apply(review);assert.equal(result.state,"COMPLETE",JSON.stringify(result));
 assert.equal(result.finalReview.status.equipment,"VERIFIED");assert.equal(result.release.state,"VERIFIED_OFFLINE");
 assert.deepEqual(f.calls.filter(c=>["select","release","ASSEMBLE_HULL","BOARD_HULL","FIT_ITEM"].includes(c)),["select","ASSEMBLE_HULL","BOARD_HULL","FIT_ITEM","release"]);
 assert.equal(f.operations.size,0);assert.equal(f.sessionOperations.size,0);assert.equal(f.heldSessions.size,0);
 assert.ok(f.states.includes("VERIFYING"));assert.equal(f.engine.journal.list().length,1);
 assert.equal(f.engine.journal.list()[0].kind,"SHIP_PROVISION");
 await f.apply(review);assert.equal(f.calls.filter(c=>c==="select").length,1);
});
test("stock verified no-op retains LOW optional supplies and releases without gameplay",async()=>{
 const f=stock(),r=await f.apply();assert.equal(r.state,"ALREADY_SATISFIED",JSON.stringify(r));assert.equal(r.finalReview.status.supplies,"MISSING");
 assert.equal(f.calls.filter(c=>/^[A-Z_]+$/.test(c)).length,0);assert.equal(f.operations.size,0);
});
test("a pilot already online before selection refuses without manufacturing release recovery",async()=>{
 const f=stock(),review=f.prepare();f.state.online=true;
 const r=await f.apply(review);assert.equal(r.state,"REFUSED",JSON.stringify(r));assert.equal(r.reason,"PILOT_BUSY");
 assert.equal(r.release.state,"NOT_ACQUIRED");assert.equal(r.release.exactSessionReleased,false);
 assert.deepEqual(f.calls,["status"]);assert.equal(f.state.online,true);
 assert.equal(f.operations.size,0);assert.equal(f.sessionOperations.size,0);assert.equal(f.heldSessions.size,0);assert.deepEqual(f.service.pending(11),[]);
 f.state.online=false;assert.equal(f.prepare().canApply,true);assert.equal((await f.apply()).state,"ALREADY_SATISFIED");
});
test("failure without selection clears only its own fences while preserving a replacement owner",async()=>{
 const f=stock(),foreign={kind:"hosted-other"};
 f.store.listCharactersForAccount=async()=>{f.operations.set(11,foreign);f.state.online=true;return[{accountID:7,characterID:11,corporationID:20}];};
 const r=await f.apply();assert.equal(r.state,"REFUSED",JSON.stringify(r));assert.equal(r.reason,"PROVISIONING_GENERATION_CHANGED");
 assert.equal(r.release.state,"NOT_ACQUIRED");assert.equal(f.operations.get(11),foreign);assert.equal(f.sessionOperations.size,0);
 assert.deepEqual(f.calls,[]);assert.equal(f.state.online,true);assert.equal(f.heldSessions.size,0);
});
test("no-selection refusal persists before dropping fences and recovery never selects",async()=>{
 const f=stock(),review=f.prepare(),put=f.service.journal.put;f.state.online=true;
 f.service.journal.put=(key,row)=>{if(row.state==="REFUSED")throw new Error("disk failed");return put(key,row);};
 await assert.rejects(f.apply(review),/disk failed/);assert.equal(f.operations.has(11),true);assert.equal(f.sessionOperations.has("caller"),true);
 f.service.journal.put=put;const r=await f.service.recover(f.account,review.reviewID);
 assert.equal(r.state,"REFUSED");assert.equal(r.reason,"PILOT_BUSY");assert.equal(r.release.state,"NOT_ACQUIRED");
 assert.equal(f.operations.size,0);assert.equal(f.sessionOperations.size,0);assert.deepEqual(f.calls,["status"]);assert.equal(f.state.online,true);
});
for(const code of ["EVE_GATEWAY_TIMEOUT","CALL_REFUSED"])test(`a dispatched selection with ${code} still requires offline proof`,async()=>{
 const f=stock();f.gateway.selectCharacter=async()=>{f.calls.push("select");f.state.online=true;throw Object.assign(new Error("uncertain selection"),{code});};
 const r=await f.apply();assert.equal(r.state,"UNCERTAIN");assert.equal(r.reason,"CONTROL_RELEASE_UNPROVEN");
 assert.equal(r.release.state,"UNVERIFIED");assert.equal(r.release.exactSessionReleased,false);assert.equal(f.operations.has(11),true);
 assert.equal(f.sessionOperations.has("caller"),true);assert.equal(f.calls.includes("release"),false);assert.equal(f.calls.includes("readShip"),false);
});
for(const mode of ["browser","hosted","operation","custody","session"])test(`P4-P7 known ${mode} owner refuses before selection`,async()=>{
 const f=stock(),r=f.prepare();
 if(mode==="browser")f.heldSessions.set("other",{characterID:11});
 if(mode==="hosted")f.state.claim="hosted-1";
 if(mode==="operation")f.operations.set(11,{kind:"mining-operation-handoff",operationRunID:"foreign"});
 if(mode==="custody")f.engine.unresolved=()=>[{key:"foreign",accountID:7}];
 if(mode==="session")f.sessionOperations.set("caller",Symbol("foreign"));
 await assert.rejects(f.apply(r),{code:"PILOT_BUSY"});assert.equal(f.calls.includes("select"),false);
});
test("P9 copied/impostor reservation never bypasses exact invocation",async()=>{
 const f=stock();let foreign;
 f.state.faultHook=phase=>{if(phase==="ACQUIRING_CONTROL"){foreign={...f.operations.get(11)};f.operations.set(11,foreign);}};
 const r=await f.apply();assert.equal(r.reason,"PROVISIONING_GENERATION_CHANGED");assert.equal(f.calls.includes("select"),false);assert.equal(f.operations.get(11),foreign);
});
test("P10 late generation after awaited stock select releases only stale handle and never installs it",async()=>{
 const f=stock(),foreign=Symbol("new-generation");f.state.selectionHook=()=>{f.operations.set(11,foreign);};
 const r=await f.apply();assert.equal(r.reason,"PROVISIONING_GENERATION_CHANGED");assert.equal(f.calls.includes("readShip"),false);
 assert.equal(f.heldSessions.size,0);assert.equal(f.operations.get(11),foreign);assert.equal(f.calls.filter(c=>c==="release").length,1);
});
test("awaited account/status read rechecks exact reservation before dispatch",async()=>{
 for(const step of ["account","status"]){const f=stock(),foreign=Symbol(step),r=f.prepare();
 if(step==="account")f.store.listCharactersForAccount=async()=>{f.operations.set(11,foreign);return[{accountID:7,characterID:11,corporationID:20}];};
 else {const read=f.gateway.getCharacterStatus;f.gateway.getCharacterStatus=async(...args)=>{const s=await read(...args);f.operations.set(11,foreign);return s;};}
 const outcome=await f.apply(r);assert.equal(outcome.reason,"PROVISIONING_GENERATION_CHANGED");assert.equal(f.calls.includes("select"),false);assert.equal(f.operations.get(11),foreign);}
});
test("P11 definition/ship/source drift after selected baseline refuses before mutation",async()=>{
 for(const drift of ["definition","ship","source"]){const f=stock({modified:true});
 f.state.faultHook=phase=>{if(phase!=="REVALIDATING")return;if(drift==="definition")f.state.definition={...f.contract,definitionFingerprint:"changed"};
 else if(drift==="ship")f.state.shipID=51;else f.state.hangar=f.state.hangar.slice(0,1);};
 const r=await f.apply();assert.ok(["REVIEW_STALE","SOURCE_CHANGED"].includes(r.reason),JSON.stringify(r));assert.equal(f.calls.includes("ASSEMBLE_HULL"),false);assert.equal(r.release.state,"VERIFIED_OFFLINE");}
});
test("P13 uncertain release remains visible/fenced and exact recovery does not reacquire",async()=>{
 const f=stock();f.state.releaseFails=true;const review=f.prepare(),r=await f.apply(review);
 assert.equal(r.state,"UNCERTAIN");assert.equal(r.release.state,"UNVERIFIED");assert.equal(f.heldSessions.size,1);assert.equal(f.operations.has(11),true);
 await f.apply(review);assert.equal(f.calls.filter(c=>c==="select").length,1);
 f.state.releaseFails=false;const recovered=await f.service.recover(f.account,r.operationID);assert.equal(recovered.state,"ALREADY_SATISFIED");assert.equal(f.operations.size,0);assert.equal(f.heldSessions.size,0);
});
test("acknowledged exact release with global offline status unproven stays fenced",async()=>{
 const f=stock();f.state.faultHook=phase=>{if(phase==="VERIFYING")f.state.offlineUnknown=true;};const r=await f.apply();
 assert.equal(r.state,"UNCERTAIN");assert.equal(r.release.state,"SESSION_RELEASED_OFFLINE_UNPROVEN");assert.equal(f.heldSessions.size,0);assert.equal(f.operations.has(11),true);
});
test("P14 uncertain mutation preserves shared custody, releases, and never blindly resends",async()=>{
 const f=stock({modified:true});f.state.ambiguous=true;const review=f.prepare(),r=await f.apply(review);
 assert.equal(r.state,"BLOCKED");assert.equal(r.release.state,"VERIFIED_OFFLINE");assert.equal(f.engine.unresolved(11).length,1);
 assert.equal(f.engine.journal.list()[0].actions[0].state,"AMBIGUOUS");assert.equal(f.heldSessions.size,0);
 await f.apply(review);await f.service.recover(f.account,r.operationID);assert.equal(f.calls.filter(c=>c==="ASSEMBLE_HULL").length,1);assert.equal(f.calls.filter(c=>c==="select").length,1);
 assert.equal(f.operations.has(11),true);
});
test("failure before mutation and malformed selected outcome settle exact handle",async()=>{
 const f=stock();f.state.faultHook=phase=>{if(phase==="READING")throw Object.assign(new Error("failed read"),{code:"READ_FAILED"});};
 const r=await f.apply();assert.equal(r.state,"REFUSED");assert.equal(r.reason,"READ_FAILED");assert.equal(f.operations.size,0);assert.equal(f.calls.includes("release"),true);
 const bad=stock(),select=bad.gateway.selectCharacter;bad.gateway.selectCharacter=async(...args)=>({...await select(...args),session:{characterID:12}});
 assert.equal((await bad.apply()).reason,"PROVISIONING_SESSION_MISMATCH");assert.equal(bad.heldSessions.size,0);assert.equal(bad.calls.includes("release"),true);
});
test("historical recovery requires positive offline status and removes only its exact reservation",async t=>{
 const f=fixture(t),before=f.operations.get(11);assert.equal((await f.service.recover(f.account,"old-invocation")).reason,"CONTROL_RELEASE_UNPROVEN");assert.equal(f.operations.get(11),before);
 f.offline();assert.equal((await f.service.recover(f.account,"old-invocation")).state,"REFUSED");assert.equal(f.operations.size,0);
 assert.equal(f.service.status(f.account,"old-invocation").release.state,"VERIFIED_OFFLINE");
});
test("historical offline recovery preserves foreign reservations and unresolved transfer custody",async t=>{
 const f=fixture(t),foreign=Symbol("foreign");f.operations.set(11,foreign);f.offline();f.custody();
 const result=await f.service.recover(f.account,"old-invocation");assert.equal(result.state,"BLOCKED");assert.equal(result.reason,"PROVISIONING_RECOVERY_REQUIRED");assert.equal(f.operations.get(11),foreign);
 assert.equal(f.service.pending(11).length,1);await assert.rejects(f.service.recover({accountID:8},"old-invocation"),{code:"OPERATION_NOT_OWNED"});
});

test("P15 restarted maintenance preserves ambiguous custody and never reacquires",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stock-maintenance-restart-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const options={modified:true,filePath:path.join(dir,"control.json"),custodyPath:path.join(dir,"custody.json")};
 const f=stock(options);f.state.ambiguous=true;const review=f.prepare(),outcome=await f.apply(review);
 const restarted=stock(options);assert.equal(restarted.operations.has(11),true);assert.equal(restarted.engine.unresolved(11).length,1);
 const r=await restarted.service.recover(restarted.account,outcome.operationID);assert.equal(r.state,"BLOCKED");
 assert.equal(restarted.calls.includes("select"),false);assert.equal(restarted.engine.journal.list()[0].actions[0].state,"AMBIGUOUS");
});
test("a copied recovery reservation is foreign and survives offline reconciliation",async t=>{
 const f=fixture(t),copy={...f.operations.get(11)};f.operations.set(11,copy);f.offline();await f.service.recover(f.account,"old-invocation");assert.equal(f.operations.get(11),copy);
});
test("persistence failure during release still cleans exact session and leaves recoverable fence",async()=>{
 const f=stock(),put=f.service.journal.put;let failFinal=true;
 f.service.journal.put=(key,row)=>{if(failFinal && row.state==="ALREADY_SATISFIED")throw new Error("disk failed");return put(key,row);};
 const review=f.prepare();await assert.rejects(f.apply(review),/disk failed/);assert.equal(f.calls.includes("release"),true);assert.equal(f.heldSessions.size,0);assert.equal(f.operations.has(11),true);
 failFinal=false;const r=await f.service.recover(f.account,review.reviewID);assert.equal(r.release.state,"VERIFIED_OFFLINE");assert.equal(f.operations.size,0);
});
test("cleanup stays single owner through release; concurrent recovery cannot release twice",async()=>{
 const f=stock();let finish,entered;
 const started=new Promise(r=>entered=r),wait=new Promise(r=>finish=r),release=f.gateway.releaseBridgeSession;
 f.gateway.releaseBridgeSession=async(...args)=>{entered();await wait;return release(...args);};
 const review=f.prepare(),applying=f.apply(review);await started;
 const status=await f.service.recover(f.account,review.reviewID);assert.equal(status.state,"RELEASING");assert.equal(f.operations.has(11),true);
 finish();await applying;assert.equal(f.calls.filter(c=>c==="release").length,1);
});
test("recovery cleanup is singleflight after an uncertain release",async()=>{
 const f=stock();f.state.releaseFails=true;const outcome=await f.apply();f.state.releaseFails=false;
 let finish,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>finish=r),release=f.gateway.releaseBridgeSession;
 f.gateway.releaseBridgeSession=async(...args)=>{entered();await wait;return release(...args);};
 const one=f.service.recover(f.account,outcome.operationID);await started;const two=f.service.recover(f.account,outcome.operationID);
 assert.equal(one,two);finish();assert.equal((await one).state,"ALREADY_SATISFIED");assert.equal(f.calls.filter(c=>c==="release").length,2);
});
test("restarted release recovery persists completion before dropping the exact fence",async t=>{
 const f=fixture(t),reservation=f.operations.get(11),put=f.service.journal.put;f.offline();
 f.service.journal.put=(key,row)=>{if(row.state==="REFUSED")throw new Error("disk failed");return put(key,row);};
 await assert.rejects(f.service.recover(f.account,"old-invocation"),/disk failed/);assert.equal(f.operations.get(11),reservation);
 f.service.journal.put=put;await f.service.recover(f.account,"old-invocation");assert.equal(f.operations.size,0);
});
test("selected Query-only source can prove no-op; denied Take still refuses a mutation",async()=>{
 for(const modified of [false,true]){const f=stock({modified}),read=f.adapter.readShip;
 f.adapter.readShip=async(...args)=>{const result=await read(...args);result.source.access.take=false;return result;};
 const r=await f.apply();assert.equal(r.state,modified?"REFUSED":"ALREADY_SATISFIED",JSON.stringify(r));
 if(modified)assert.equal(r.reason,"SOURCE_TAKE_DENIED");assert.equal(f.calls.includes("ASSEMBLE_HULL"),false);assert.equal(r.release.state,"VERIFIED_OFFLINE");}
});

test("reopening an interrupted historical journal reconstructs only its exact recovery reservation",async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"center-history-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const filePath=path.join(dir,"center.json"),pin={accountID:7,characterID:11};
 fs.writeFileSync(filePath,JSON.stringify({version:1,records:{old:{kind:"CENTER_APPLY",accountID:7,characterID:11,
   state:"RELEASING",pin,reviewHash:hash(pin),input:{},release:{state:"UNVERIFIED"}}}}));
 const foreign=Symbol("foreign"),operations=new Map([[12,foreign]]);
 const service=createProvisioningCenterApply({filePath,operations,engine:{unresolved:()=>[]},
   gateway:{getCharacterStatus:async()=>({characterID:11,online:false,controlState:"offline"})}});
 assert.deepEqual(operations.get(11),{kind:"temporary-provisioning-recovery",id:"old"});
 await service.recover({accountID:7},"old");assert.equal(operations.has(11),false);assert.equal(operations.get(12),foreign);
 const reloaded=createProvisioningCenterApply({filePath,operations,engine:{unresolved:()=>[]},gateway:{}});
 assert.equal(reloaded.status({accountID:7},"old").state,"REFUSED");assert.equal(operations.has(11),false);
});
