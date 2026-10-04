"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {fixture}=require("../test/helpers/stockHostedMaintenance");
const {createTrainingEquipment}=require("./trainingEquipment");
const {hash,buildContract}=require("./provisioningContracts");
function training({modified=false}={}) {
  let skillsReady=true,at=1000,qualificationReads=0;const f=fixture({modified,now:()=>at});
  const config={configurationID:"frigate",roleID:"HAULER",order:0,corporationOwnerID:20,fittingID:4,hullTypeID:1,
    acceptedSavedDate:f.fit.savedDate,acceptedFingerprint:f.fit.fingerprint};
  const input={characterID:11,role:"HAULER",configurations:[config],configurationID:"frigate",targetStage:"frigate",source:{kind:"hangar"}};
  const center={applyService:f.service,async readReview(accountID,request){assert.equal(accountID,7);assert.equal(request.providerCharacterID,11);
    return{...f.detail,pilot:{...f.detail.pilot,quality:"PENDING_SELECTED",observation:{complete:false},control:{owner:f.state.offlineUnknown?"UNKNOWN":f.state.claim?"BOT":f.state.online?"OTHER_SESSION":"OFF",online:f.state.offlineUnknown?null:f.state.online}},
      selected:f.state.definition,status:{equipment:"UNKNOWN",supplies:"UNKNOWN",targets:[]},candidateSource:{kind:"hangar",quality:"PENDING_SELECTED"}};}};
  const readQualification=async()=>{qualificationReads++;const d=f.state.definition.definition;
    return{report:{role:"HAULER",pilot:{characterID:11},stages:[{id:"frigate",fitting:{status:d.savedDate===config.acceptedSavedDate && d.fingerprint===config.acceptedFingerprint?"READY":"REVIEW_REQUIRED"},skillQualification:skillsReady?"READY":"NOT_READY"}]}};};
  const service=createTrainingEquipment({center,readQualification,now:()=>at});
  return{...f,service,center,input,config,readQualification,skills(value){skillsReady=value;},advance(){at+=60001;},reads:()=>qualificationReads};
}
test("T1/T2/T3/T8/T9/T10 read-only qualification/preflight selects nobody, explicit Training uses shared selected engine",async()=>{
 const f=training({modified:true}),review=await f.service.review(f.account,f.input);
 assert.equal(f.calls.includes("select"),false);assert.equal(review.fresh.report.stages[0].equipmentReadiness,"UNKNOWN");
 const result=await f.service.apply(f.account,{...review.applyReview,confirm:true},"training-caller");
 assert.equal(result.state,"COMPLETE",JSON.stringify(result));assert.equal(result.finalReview.status.equipment,"VERIFIED");assert.equal(result.release.state,"VERIFIED_OFFLINE");
 assert.equal(f.engine.journal.list().length,1);assert.equal(f.engine.journal.list()[0].kind,"SHIP_PROVISION");
 assert.equal(f.operations.size,0);assert.equal(f.sessionOperations.size,0);assert.equal(f.heldSessions.size,0);assert.ok(f.reads()>=3);
 const enriched=await f.service.enrich(f.account,await f.readQualification(),[f.config]);
 assert.equal(enriched.report.stages[0].equipmentReadiness,"VERIFIED");assert.equal(enriched.report.stages[0].dutyReadiness,"READY");
 assert.equal(enriched.report.stages[0].equipment.status.supplies,"MISSING");
 f.advance();assert.equal((await f.service.enrich(f.account,await f.readQualification(),[f.config])).report.stages[0].equipmentReadiness,"UNKNOWN");
});
test("T4 provider/date/fingerprint drift after Review fails selected revalidation and releases",async()=>{
 for(const drift of ["provider","date","fingerprint"]){const f=training(),review=await f.service.review(f.account,f.input);
 const definition={...f.contract.definition,...(drift==="provider"?{characterID:12}:drift==="date"?{savedDate:"101"}:{fingerprint:"b".repeat(64)})};
 f.state.definition={...f.contract,definition,definitionFingerprint:hash(definition)};
 const r=await f.service.apply(f.account,{...review.applyReview,confirm:true});assert.equal(r.reason,"REVIEW_STALE");assert.equal(r.release.state,"VERIFIED_OFFLINE");assert.equal(f.calls.includes("FIT_ITEM"),false);}
});
test("T5 trained hard skills are rechecked under selected owner immediately before mutation",async()=>{
 for(const boundary of ["REVALIDATING","PROVISIONING"]){const f=training({modified:true}),review=await f.service.review(f.account,f.input);
 f.state.faultHook=phase=>{if(phase===boundary)f.skills(false);};
 const r=await f.service.apply(f.account,{...review.applyReview,confirm:true});assert.equal(r.reason,"SKILLS_NOT_READY");assert.equal(r.release.state,"VERIFIED_OFFLINE");assert.equal(f.calls.includes("ASSEMBLE_HULL"),false);}
});
test("T6/T7 changed Training configuration or physical source refuses without acquisition",async()=>{
 for(const change of ["training","source"]){const f=training(),review=await f.service.review(f.account,f.input),body={...review.applyReview,confirm:true};
 body[change]=change==="source"?{kind:"corp",corporationID:20,division:2}:{configurationID:"other"};
 await assert.rejects(f.service.apply(f.account,body),{code:"REVIEW_STALE"});assert.equal(f.calls.includes("select"),false);}
});
test("Training cannot substitute unrelated Center acceptance, and Center cannot use Training acceptance",async()=>{
 const f=training(),review=await f.service.review(f.account,f.input);
 await assert.rejects(f.center.applyService.apply(f.account,{...review.applyReview,confirm:true},"CENTER"),{code:"REVIEW_REQUIRED"});
 const centerReview=f.prepare();await assert.rejects(f.service.apply(f.account,{...centerReview,confirm:true}),{code:"REVIEW_REQUIRED"});assert.equal(f.calls.includes("select"),false);
});
test("verified Training receipt cannot make duty ready after skills, definition, source or control changes",async()=>{
 const f=training(),review=await f.service.review(f.account,f.input);await f.service.apply(f.account,{...review.applyReview,confirm:true});
 f.skills(false);const untrained=await f.service.enrich(f.account,await f.readQualification(),[f.config]);assert.equal(untrained.report.stages[0].dutyReadiness,"NOT_READY");
 const sourceChanged=await f.service.enrich(f.account,await f.readQualification(),[f.config],{kind:"corp",corporationID:20,division:2});assert.equal(sourceChanged.report.stages[0].equipmentReadiness,"UNKNOWN");
 f.state.online=true;assert.equal((await f.service.enrich(f.account,await f.readQualification(),[f.config])).report.stages[0].equipmentReadiness,"UNKNOWN");
});
test("slow release and repeated completed invocation cannot refresh old selected evidence TTL",async()=>{
 const f=training(),review=await f.service.review(f.account,f.input),release=f.gateway.releaseBridgeSession;
 f.gateway.releaseBridgeSession=async(...args)=>{f.advance();return release(...args);};
 const body={...review.applyReview,confirm:true},outcome=await f.service.apply(f.account,body);assert.equal(outcome.finalObservedAt,1000);
 assert.equal((await f.service.enrich(f.account,await f.readQualification(),[f.config])).report.stages[0].equipmentReadiness,"UNKNOWN");
 await f.service.apply(f.account,body);assert.equal(f.calls.filter(c=>c==="select").length,1);
 assert.equal((await f.service.enrich(f.account,await f.readQualification(),[f.config])).report.stages[0].equipmentReadiness,"UNKNOWN");
});

test("an observed retail, bot or unknown owner invalidates the Training receipt after control becomes free again",async()=>{
 for(const owner of ["retail","bot","unknown"]){const f=training(),review=await f.service.review(f.account,f.input);
 await f.service.apply(f.account,{...review.applyReview,confirm:true});
 const readiness=async()=> (await f.service.enrich(f.account,await f.readQualification(),[f.config])).report.stages[0];
 assert.equal((await readiness()).equipmentReadiness,"VERIFIED");
 if(owner==="retail")f.state.online=true;else if(owner==="bot")f.state.claim="hosted-bot";else f.state.offlineUnknown=true;
 assert.equal((await readiness()).equipmentReadiness,"UNKNOWN");
 f.state.equipment.set(f.state.shipID,[]);f.state.online=false;f.state.claim=null;f.state.offlineUnknown=false;
 const after=await readiness();assert.equal(after.equipmentReadiness,"UNKNOWN",owner);assert.equal(after.dutyReadiness,"NOT_READY",owner);}
});

test("a new selected Review proving modified equipment retires the earlier verified Training receipt",async()=>{
 const f=training(),first=await f.service.review(f.account,f.input);
 await f.service.apply(f.account,{...first.applyReview,confirm:true});
 f.state.equipment.set(f.state.shipID,[]);f.state.hangar=[];
 const second=await f.service.review(f.account,f.input),outcome=await f.service.apply(f.account,{...second.applyReview,confirm:true});
 assert.equal(outcome.state,"REFUSED");assert.equal(outcome.selectedReview.status.equipment,"MODIFIED");assert.equal(outcome.release.state,"VERIFIED_OFFLINE");
 const after=(await f.service.enrich(f.account,await f.readQualification(),[f.config])).report.stages[0];
 assert.equal(after.equipmentReadiness,"UNKNOWN");assert.equal(after.dutyReadiness,"NOT_READY");
});

test("changing and restoring a Training source, configuration or accepted definition cannot revive its receipt",async()=>{
 for(const change of ["source","configuration","definition","metadata"]){const f=training(),review=await f.service.review(f.account,f.input);
 await f.service.apply(f.account,{...review.applyReview,confirm:true});
 let read=await f.readQualification(),configs=[f.config],source={kind:"hangar"};
 if(change==="source")source={kind:"corp",corporationID:20,division:2};
 else if(change==="configuration"){
   configs=[{...f.config,configurationID:"renamed"}];
   read={...read,report:{...read.report,stages:read.report.stages.map(s=>({...s,id:"renamed"}))}};
 }else if(change==="metadata"){
   f.state.definition=buildContract({...f.fit,name:"Renamed fitting"},
     {scope:"CORPORATION",accountID:7,characterID:11,corporationID:20},f.data);
 }else{
   f.state.definition={...f.contract,definition:{...f.contract.definition,savedDate:"101"}};
   read=await f.readQualification();
 }
 assert.equal((await f.service.enrich(f.account,read,configs,source)).report.stages[0].equipmentReadiness,"UNKNOWN",change);
 f.state.definition=f.contract;
 const restored=(await f.service.enrich(f.account,await f.readQualification(),[f.config])).report.stages[0];
 assert.equal(restored.equipmentReadiness,"UNKNOWN",change);assert.equal(restored.dutyReadiness,"NOT_READY",change);}
});

test("refreshing unrelated qualification stages preserves the matching selected receipt and original expiry",async()=>{
 const f=training(),review=await f.service.review(f.account,f.input),outcome=await f.service.apply(f.account,{...review.applyReview,confirm:true});
 const read=await f.readQualification(),other={...f.config,configurationID:"other",order:1,fittingID:5};
 read.report.stages.push({id:"other",fitting:{status:"REVIEW_REQUIRED"},skillQualification:"READY"});
 const refreshed=await f.service.enrich(f.account,read,[f.config,other]);
 assert.equal(refreshed.report.stages[0].equipmentReadiness,"VERIFIED");
 assert.equal(refreshed.report.stages[0].equipment.observedAt,outcome.finalObservedAt);
 assert.equal(refreshed.report.stages[1].equipmentReadiness,"UNKNOWN");
 f.advance();assert.equal((await f.service.enrich(f.account,read,[f.config,other])).report.stages[0].equipmentReadiness,"UNKNOWN");
});

test("a receipt expiring during asynchronous preflight cannot certify equipment on return",async()=>{
 const f=training(),review=await f.service.review(f.account,f.input);await f.service.apply(f.account,{...review.applyReview,confirm:true});
 const readReview=f.center.readReview;
 f.center.readReview=async(...args)=>{const detail=await readReview(...args);f.advance();return detail;};
 const after=(await f.service.enrich(f.account,await f.readQualification(),[f.config])).report.stages[0];
 assert.equal(after.equipmentReadiness,"UNKNOWN");assert.equal(after.dutyReadiness,"NOT_READY");
});

for(const change of ["none","control","expiry"])test(`later valid-stage ${change} respects earlier receipt authority in the returned report`,async()=>{
 const f=training(),other={...f.config,configurationID:"other",order:1,fittingID:5};
 const otherContract=buildContract({...f.fit,fittingID:5,name:"Other accepted fitting"},
   {scope:"CORPORATION",accountID:7,characterID:11,corporationID:20},f.data);
 const configurations=[f.config,other],readReview=f.center.readReview;
 let secondHook=null;
 f.center.readReview=async(accountID,input)=>{
   if(input.fittingID===5)await secondHook?.();
   const detail=await readReview(accountID,input);
   return{...detail,selected:input.fittingID===5?otherContract:detail.selected};
 };
 const review=await f.service.review(f.account,{...f.input,configurations}),outcome=await f.service.apply(f.account,{...review.applyReview,confirm:true});
 assert.equal(outcome.state,"ALREADY_SATISFIED");
 secondHook=()=>{if(change==="control")f.state.online=true;else if(change==="expiry")f.advance();};
 const read=await f.readQualification();
 read.report.stages.push({id:"other",fitting:{status:"READY"},skillQualification:"READY"});
 const result=await f.service.enrich(f.account,read,configurations),first=result.report.stages[0];
 assert.equal(first.equipmentReadiness,change==="none"?"VERIFIED":"UNKNOWN");
 assert.equal(first.dutyReadiness,change==="none"?"READY":"NOT_READY");
 if(change==="none")assert.equal(first.equipment.observedAt,outcome.finalObservedAt);
 assert.equal(result.report.stages[1].equipmentReadiness,"UNKNOWN");
});
