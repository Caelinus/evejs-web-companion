"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { configurationStages, configurationSelections, validateConfigurations } = require("../src/trainingConfigurations");
const { resolveStageFittings } = require("../src/pilotTrainingFittings");
const { buildQualificationReport, buildMinerReport } = require("../src/pilotTraining");
const { planFingerprint, createTrainingQueueService } = require("../src/pilotTrainingQueue");
const fingerprint = "a".repeat(64), date = "134320560863130000";
const config = (id = "transport", fittingID = 11, hullTypeID = 9999, roleID = "HAULER", order = 0) => ({ configurationID: id, roleID, order, corporationOwnerID: 98, fittingID, hullTypeID, acceptedSavedDate: date, acceptedFingerprint: fingerprint });
const data = { getType: (id) => ({ typeID: id, name: `Type ${id}` }), getSkillType: (id) => ({ typeID: id, name: `Skill ${id}` }),
  getTypeDogma: (id) => ({ attributes: ({ 9999: {182:1,277:3}, 77: {182:2,277:2}, 88:{182:3,277:1}, 1:{182:2,277:1} })[id] || {} }) };
const sheet = { serverNowMs: 100, skills: [], queue: { active:false,entries:[],maxEntries:150 } };
function report(role, configs, items = [77], target = null, pilotSheet = sheet) {
  const defs = configurationStages(role, configs);
  const fits = configs.map((c) => ({ ownerID:98, fittingID:c.fittingID, shipTypeID:c.hullTypeID, name:"Same display name", savedDate:date, fingerprint, items:items.map(typeID=>({typeID,flagID:27,quantity:1})) }));
  const resolved = resolveStageFittings(defs, fits, configurationSelections(configs), 98);
  return buildQualificationReport(data,pilotSheet,{},resolved,target,defs,role);
}
test("fresh arbitrary role has zero configurations, no implied ready qualification",()=>{
  const r=report("EXPLORER",[]); assert.deepEqual(r.stages,[]); assert.equal(r.previews.FAST.eta.kind,"UNKNOWN"); assert.equal(r.currentStageStatus,"UNKNOWN");
});
test("completed arbitrary role still disables unsupported support modes",()=>{
  const trained={...sheet,skills:[{typeID:1,level:5,skillPoints:1000},{typeID:2,level:5,skillPoints:1000}]};
  const r=report("HAULER",[config()],[77],null,trained);
  assert.equal(r.currentStage,"transport");assert.equal(r.previews.FAST.eta.kind,"READY");
  for(const mode of ["BALANCED","MASTERY"]) assert.equal(r.previews[mode].disabled,true);
});
test("authoritative fitting with no prerequisites is valid, unreadable skill state still fails closed",()=>{
  const cs=[config("no-skill-hull",11,2222)];
  const r=report("HAULER",cs,[]);assert.equal(r.stages[0].skillQualification,"READY");assert.deepEqual(r.stages[0].hard,[]);
  const bad=report("HAULER",cs,[],null,{...sheet,skills:null});assert.equal(bad.stages[0].skillQualification,"UNKNOWN");
  assert.equal(bad.currentStage,null);assert.equal(bad.previews.FAST.eta.kind,"UNKNOWN");
});
test("generic append binds later configuration across review, apply and authoritative readback",async()=>{
  const cs=[config(),config("later-contract",12,9999,"HAULER",1)], seen=[];
  let current={...sheet,skills:[1,2,99].map(typeID=>({typeID,level:0,skillPoints:0})),queue:{active:false,maxEntries:150,entries:[{typeID:99,toLevel:1,startTimeMs:100,endTimeMs:200}]}},writes=0;
  const loadPilot=async(args)=>{seen.push(args);const s=args.sheet||current;return {sheet:s,read:{report:report(args.role,args.configurations,[77],args.targetStage,s)}};};
  const service=createTrainingQueueService({data,loadPilot,gateway:{
    getCharacterStatus:async()=>({characterID:7,online:false,controlState:"offline",stateVersion:`epoch.${writes}`}),
    saveOfflineSkillQueue:async(accountID,id,command)=>{assert.equal(accountID,1);assert.equal(id,7);assert.equal(command.expectedStateVersion,"epoch.0");assert.deepEqual(command.payload.entries[0],{typeID:99,toLevel:1});writes++;current.queue={...current.queue,active:command.payload.activate,entries:command.payload.entries.map((q,i)=>({...q,startTimeMs:100+i*100,endTimeMs:200+i*100}))};},
    getSkills:async()=>current,
  }});
  const account={accountID:1},preview=report("HAULER",cs,[77],"later-contract",current).previews.FAST;
  const request={characterID:7,role:"HAULER",configurations:cs,mode:"FAST",stage:"later-contract",targetStage:"later-contract",displayedTargets:preview.targets};
  const q=await service.review(account,request);assert.equal(q.canApply,true);assert.equal(q.additions.length,5);
  const out=await service.apply(account,{reviewID:q.reviewID,confirm:true,stage:"wrong"});assert.equal(out.verified,true);assert.equal(out.stage,"later-contract");
  assert.ok(seen.every(a=>a.role==="HAULER"&&a.targetStage==="later-contract"&&JSON.stringify(a.configurations)===JSON.stringify(cs)));
  const again=await service.review(account,{...request,displayedTargets:report("HAULER",cs,[77],"later-contract",current).previews.FAST.targets});assert.equal(again.status,"NOTHING_TO_ADD");assert.equal(writes,1);
});
test("three contracts maximum, stable IDs and duplicates validated independently from hull",()=>{
  const cs=[config(),config("ice",12,9999,"HAULER",1),config("t2",13,2222,"HAULER",2)];
  assert.equal(validateConfigurations("HAULER",cs).length,3);
  assert.throws(()=>validateConfigurations("HAULER",[...cs,config("fourth",14,3333,"HAULER",3)]),/three/);
  assert.throws(()=>validateConfigurations("HAULER",[cs[0],config("duplicate",11,9999,"HAULER",1)]),/Duplicate/);
  assert.throws(()=>validateConfigurations("GUARD",cs),/identity/);
});
test("arbitrary hull FAST recursively joins module requirements; drones only when present",()=>{
  const a=report("HAULER",[config()]); assert.deepEqual(a.previews.FAST.requirements.map(r=>[r.typeID,r.level]),[[1,3],[2,2]]);
  assert.ok(!a.stages[0].hard.some(r=>r.typeID===3));
  assert.ok(report("GUARD",[config("combat",11,9999,"GUARD")],[77,88]).stages[0].hard.some(r=>r.typeID===3));
  assert.equal(a.previews.BALANCED.disabled,true); assert.equal(a.previews.MASTERY.disabled,true);
});
test("explicit third config binds directly and fitting content changes fail closed",()=>{
  const cs=[config(),config("second",12,9999,"HAULER",1),config("third",13,9999,"HAULER",2)];
  const r=report("HAULER",cs,[77],"third"); assert.equal(r.currentStage,null);assert.equal(r.previews.FAST.stage,"third");
  assert.notEqual(planFingerprint(r,"FAST"),planFingerprint({...r,role:"GUARD"},"FAST"));
  const defs=configurationStages("HAULER",cs), changed=resolveStageFittings(defs,[{fittingID:13,shipTypeID:9999,fingerprint:"b".repeat(64),savedDate:date}],configurationSelections(cs),98);
  assert.equal(changed.third.status,"REVIEW_REQUIRED");
});
test("legacy Miner selected support package survives irrespective of hull/order",()=>{
  const c={...config("legacy-pioneer",11,9999,"MINER"),supportPolicyKey:"PIONEER",supportPolicyVersion:1};
  const generic=report("MINER",[c]);
  const old=buildMinerReport(data,sheet,{}, {PIONEER:{status:"READY",typeIDs:[9999,77]}},"PIONEER");
  assert.deepEqual(generic.previews.BALANCED.requirements,old.previews.BALANCED.requirements);
  assert.deepEqual(generic.previews.MASTERY.requirements,old.previews.MASTERY.requirements);
});
test("generic reviewed queue keeps role/configuration ID on apply rereads",async()=>{
  const seen=[], cs=[config()]; let saved;
  const s={...sheet,skills:[{typeID:1,level:3,skillPoints:100},{typeID:2,level:2,skillPoints:100}]};
  const r=report("HAULER",cs); r.previews.FAST.targets=[];
  const service=createTrainingQueueService({data,gateway:{getCharacterStatus:async()=>({characterID:7,online:false,controlState:"offline",stateVersion:"v"})},
    loadPilot:async(args)=>{seen.push(args);return {sheet:s,read:{report:r}};}});
  const review=await service.review({accountID:1},{characterID:7,role:"HAULER",configurations:cs,mode:"FAST",stage:"transport",targetStage:"transport",displayedTargets:[],selections:{}});
  assert.equal(review.status,"NOTHING_TO_ADD");assert.deepEqual(seen[0].configurations,cs);assert.equal(seen[0].role,"HAULER");assert.equal(saved,undefined);
});
