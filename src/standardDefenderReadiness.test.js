"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { defenderReadiness } = require("./standardDefenderReadiness");
const { createMiningPreparation } = require("./miningPreparation");
const data = {
  getType: id => ({ 1:{categoryID:6,groupID:26}, 2:{categoryID:7,groupID:74,groupName:"Hybrid Weapon"}, 3:{categoryID:18,groupID:100},
    4:{categoryID:8,groupID:85}, 5:{categoryID:8,groupID:85}, 6:{categoryID:8,groupID:83},
    7:{categoryID:7,groupID:379}, 8:{categoryID:7,groupID:60} })[id] || {categoryID:16},
  getTypeDogma: id => ({attributes: id===2 ? {128:1,604:85,182:100,277:2} : id===4 ? {128:1} : id===5 ? {128:2} : id===6 ? {128:1} : {}, effects:id===2 ? [12] : []}),
  getSkillType: id => id===100 ? {name:"Gunnery"} : null, getTypeName: id => `Type ${id}`,
};
const sheet = {serverNowMs:1000,skills:[{typeID:100,level:2,skillPoints:100}],queue:{active:false,entries:[]}};
const contract = {shipTypeID:1,equipment:[[27,2,1],[87,3,5]],supplies:[]};
const row = (typeID,flagID,quantity=1) => ({typeID,flagID,quantity});
const observation = {complete:true,shipTypeID:1,rows:[row(2,27),row(3,87,5),row(4,5,100)]};
const check = (o=observation,c=contract,s=sheet,allow=false) => defenderReadiness(c,o,s,data,allow);
test("Standard Defender accepts proven weapons+drones without optional utilities", () => {
  assert.deepEqual(check().damagePaths,["DRONES","WEAPONS"]); assert.equal(check().state,"VERIFIED");
});
test("drone-only and weapon-only fits are supported damage paths", () => {
  for (const [equipment,rows,path] of [[[ [87,3,5] ],[row(3,87,5)],"DRONES"],[[[27,2,1]],[row(2,27),row(4,27,5)],"WEAPONS"]])
    assert.deepEqual(check({...observation,rows},{...contract,equipment}).damagePaths,[path]);
});
test("passive or utility-only fit is NOT_READY", () => {
  assert.match(check({...observation,rows:[row(7,19),row(8,11)]},{...contract,equipment:[[19,7,1],[11,8,1]]}).reason,/needs combat/);
});

test("a high-slot salvager's fitting effect does not invalidate a combat-drone defender", () => {
  // Real Salvager I carries highPower (12), as do unrelated high-slot modules.
  const utilityData = { ...data,
    getType: id => id === 7 ? { categoryID: 7, groupID: 1122, groupName: "Salvager" } : data.getType(id),
    getTypeDogma: id => id === 7 ? { attributes: {}, effects: [12, 16, 2757] } : data.getTypeDogma(id),
  };
  const result = defenderReadiness({ ...contract, equipment: [[27,7,1],[87,3,5]] },
    { ...observation, rows: [row(7,27),row(3,87,5)] }, sheet, utilityData);
  assert.equal(result.state, "VERIFIED");
  assert.deepEqual(result.damagePaths, ["DRONES"]);
});

test("a mining laser and compatible crystals cannot become a Defender damage path", () => {
  // Modulated Strip Miner II uses highPower (12), not a combat activation.
  const miningData = { ...data,
    getType: id => id === 9 ? { categoryID: 7, groupID: 483, groupName: "Frequency Mining Laser" }
      : id === 10 ? { categoryID: 8, groupID: 482, groupName: "Mining Crystal" } : data.getType(id),
    getTypeDogma: id => id === 9 ? { attributes: {128:1,604:482}, effects: [12,16,67,1212] }
      : id === 10 ? { attributes: {128:1}, effects: [] } : data.getTypeDogma(id),
  };
  const result = defenderReadiness({ ...contract, equipment: [[27,9,1]] },
    { ...observation, rows: [row(9,27),row(10,5,100)] }, sheet, miningData);
  assert.equal(result.state, "BLOCKED");
  assert.match(result.reason, /needs combat/);
});
test("weapon without ammunition is blocked even when combat drones exist", () => {
  assert.match(check({...observation,rows:observation.rows.filter(r=>r.typeID!==4)}).reason,/compatible ammunition/);
});
test("incompatible charge group and size cannot pass readiness", () => {
  for(const typeID of [5,6]) assert.equal(check({...observation,rows:[row(2,27),row(typeID,5,999),row(3,87)]}).state,"BLOCKED");
});
test("shared supply plan may fill known ammo, but final readiness requires it aboard", () => {
  const o={...observation,rows:[row(2,27)]},c={...contract,supplies:[{typeID:4,target:10}]};
  assert.equal(check(o,c,sheet,true).state,"VERIFIED"); assert.equal(check(o,c).state,"BLOCKED");
});
test("skills missing or unreadable fail closed", () => {
  assert.match(check(observation,contract,{...sheet,skills:[]}).reason,/NOT_READY/);
  assert.match(check(observation,contract,null).reason,/UNKNOWN/);
});
test("incomplete fit observation cannot be classified READY", () => {
  assert.equal(check({...observation,complete:false}).state,"BLOCKED");
});
test("Defender configuration alone cannot claim physical readiness or start productive work", async () => {
  const detail={status:"READY",corporationID:20,contracts:[{...contract,definition:{fittingID:4},
    definitionFingerprint:"definition",equipmentFingerprint:"equipment",supplyPolicyFingerprint:"supply"}]};
  const preparation=createMiningPreparation({store:{getAccount:async()=>({accountID:1}),getCharacterForAccount:async()=>true},
    readDefinitions:async()=>detail,readSkills:async()=>{assert.fail("Plan must not fabricate final owner readiness");},data,engine:{unresolved:()=>[{}]}});
  const plan=await preparation.plan({operationID:"op",members:[{role:"DEFENDER",accountName:"owned",characterID:11}]});
  assert.equal(plan.state,"READY");assert.equal(plan.members.length,1);
  assert.equal(plan.members[0].state,"PENDING");assert.equal(plan.members[0].equipment,"UNKNOWN");
  assert.match(plan.members[0].reason,/final hosted owner must verify/);
});
