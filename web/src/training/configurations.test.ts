import test from "node:test";
import assert from "node:assert/strict";
import { readTrainingPreferences, saveTrainingPreferences, setRole, configurationFromFit, putConfiguration, removeConfiguration, hullChoices, configurationKey } from "./configurations.ts";
import { defaultTrainingSettings, readTrainingSettings, saveTrainingSettings } from "./settings.ts";
import { fittingsForHull } from "./fittingSelection.ts";
import type { CorporationSavedFitting } from "./types.ts";
const hash="af4bc51ab0bf86c293b7aaf030083b6c062b9c4ceeb07adbb8310ba80b216a7b";
const storage=()=>{const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);}};};
const fit=(id=11,hull=89240):CorporationSavedFitting=>({ownerID:98000002,fittingID:id,shipTypeID:hull,hullName:"Pioneer",name:"Simulated Pioneer Fitting",savedDate:"134320560863130000",fingerprint:hash,items:[],invalid:false,reason:null});
test("fresh public role starts empty and never inferred from account prefix",()=>{
  const local=storage();const p=readTrainingPreferences(local,"BMiner10",140000042);assert.equal(p.role,"");assert.deepEqual(p.roles,{});assert.equal(p.mode,"FAST");
  for(const role of ["MINER","HAULER","GUARD","FUTURE_ROLE"])assert.deepEqual(setRole(p,role).roles[role],[]);
});
test("BMiner10 exact legacy fitting and target migrate atomically and idempotently",()=>{
  const local=storage();local.setItem("goblin-factory:pilot:v1:BMiner10:140000042",JSON.stringify({role:"MINER",mode:"FAST",targetStage:"PIONEER"}));
  const old=JSON.stringify({PIONEER:{scope:"CORPORATION",ownerID:98000002,fittingID:11,acceptedSavedDate:fit().savedDate,acceptedFingerprint:hash}});
  local.setItem("pilot-training:miner:BMiner10:140000042",old);
  const first=readTrainingPreferences(local,"BMiner10",140000042);
  assert.equal(first.roles.MINER!.length,1);const c=first.roles.MINER![0]!;
  assert.equal(c.fittingID,11);assert.equal(c.hullTypeID,89240);assert.equal(c.acceptedFingerprint,hash);assert.equal(first.targetStage,c.configurationID);assert.equal(first.mode,"FAST");assert.equal(c.supportPolicyKey,"PIONEER");
  assert.deepEqual(readTrainingPreferences(local,"BMiner10",140000042),first);
  const empty=removeConfiguration(first,c.configurationID);saveTrainingPreferences(local,"BMiner10",140000042,empty);
  assert.deepEqual(readTrainingPreferences(local,"BMiner10",140000042),empty,"removed contract never resurrects from legacy backup");assert.equal(local.getItem("pilot-training:miner:BMiner10:140000042"),old);
});
test("malformed migration never overwrites original or commits partial conversion",()=>{
  const local=storage();local.setItem("pilot-training:miner:A:1",'{"PIONEER":{"scope":"CORPORATION","fittingID":11}}');
  assert.throws(()=>readTrainingPreferences(local,"A",1));assert.equal(local.getItem(configurationKey("A",1)),null);
});
test("add edit remove max-three, same hull different fits and stable IDs",()=>{
  let p=setRole(readTrainingPreferences(storage(),"A",1),"HAULER");
  for(let i=0;i<3;i++)p=putConfiguration(p,configurationFromFit("HAULER",fit(i+11),i,`c${i}`));
  assert.equal(p.roles.HAULER!.length,3);
  assert.throws(()=>putConfiguration(p,configurationFromFit("HAULER",fit(20),3,"fourth")));
  assert.throws(()=>putConfiguration({...p,roles:{HAULER:p.roles.HAULER!.slice(0,1)}},configurationFromFit("HAULER",fit(11),1,"duplicate")));
  p=putConfiguration(p,configurationFromFit("HAULER",fit(33),1,"c1"));assert.equal(p.roles.HAULER![1]!.configurationID,"c1");assert.equal(p.roles.HAULER![1]!.fittingID,33);
  p={...p,targetStage:"c2"};const local=storage();saveTrainingPreferences(local,"A",1,p);assert.equal(readTrainingPreferences(local,"A",1).targetStage,"c2");
  p=removeConfiguration(p,"c0");assert.equal(p.roles.HAULER![0]!.configurationID,"c1");assert.equal(p.roles.HAULER![0]!.order,0);assert.equal(p.targetStage,"c2");
});
test("hull options come only from valid saved fitting library, exact hull filtering",()=>{
  const fs=[fit(11),fit(12),fit(13,999),{...fit(14,888),invalid:true}];
  assert.deepEqual(hullChoices(fs).map(h=>h.typeID),[89240,999]);assert.deepEqual(fittingsForHull(fs,89240).map(f=>f.fittingID),[11,12]);
});
test("settings default disabled with no corporation, wallet or home; explicit values persist",()=>{
  const local=storage();assert.deepEqual(readTrainingSettings(local),defaultTrainingSettings());
  const settings={...defaultTrainingSettings(),trainingWallet:{corporationID:98000002,accountKey:1000},home:{locationID:60010825,name:"Resolved home",systemID:30004504,kind:"NPC_STATION",relocation:"MANUAL_GM_ONLY",capability:"DOCKABLE_STATION"}};
  saveTrainingSettings(local,settings);assert.deepEqual(readTrainingSettings(local),settings);
  assert.throws(()=>saveTrainingSettings(local,{...settings,onboarding:{enabled:true,corporationID:98,authorityKey:"",rights:"FULL_ACCESS_EXCEPT_CEO"}}));
});
test("resolved structure Home persists under the existing key without moving a pilot",()=>{
  const local=storage();
  const home={locationID:1030000000001,name:"My Astrahus",systemID:30000142,kind:"PLAYER_STRUCTURE" as const,
    relocation:"CONFIG_ONLY" as const,capability:"DOCKABLE_STRUCTURE" as const};
  const settings={...defaultTrainingSettings(),home};
  saveTrainingSettings(local,settings);
  assert.deepEqual(readTrainingSettings(local),settings);
  assert.throws(()=>saveTrainingSettings(local,{...settings,home:{...home,relocation:"MANUAL_GM_ONLY" as const}}));
});
