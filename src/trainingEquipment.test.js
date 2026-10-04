"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {fixture}=require("../test/helpers/stockHostedMaintenance");
const {createTrainingEquipment}=require("./trainingEquipment");
const {hash}=require("./provisioningContracts");
function training({modified=false}={}) {
  let skillsReady=true,at=1000,qualificationReads=0;const f=fixture({modified,now:()=>at});
  const config={configurationID:"frigate",roleID:"HAULER",order:0,corporationOwnerID:20,fittingID:4,hullTypeID:1,
    acceptedSavedDate:f.fit.savedDate,acceptedFingerprint:f.fit.fingerprint};
  const input={characterID:11,role:"HAULER",configurations:[config],configurationID:"frigate",targetStage:"frigate",source:{kind:"hangar"}};
  const center={applyService:f.service,async readReview(accountID,request){assert.equal(accountID,7);assert.equal(request.providerCharacterID,11);
    return{...f.detail,pilot:{...f.detail.pilot,quality:"PENDING_SELECTED",observation:{complete:false},control:{owner:f.state.online?"OTHER_SESSION":"OFF",online:f.state.online}},
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
