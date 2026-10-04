"use strict";
const assert=require("node:assert/strict");
const {createProvisioningCenterApply}=require("../../src/provisioningCenterApply");
const {createReplenishment}=require("../../src/replenishment");
const {buildContract,hash}=require("../../src/provisioningContracts");
const {fittingFingerprint}=require("../../src/pilotTrainingFittings");
function fixture({modified=false,filePath=null,custodyPath=null,now=Date.now}={}) {
  const operations=new Map(),sessionOperations=new Map(),heldSessions=new Map();
  const account={accountID:7,username:"Test01"},calls=[],states=[];
  const data={getType:id=>({1:{categoryID:6,groupID:25},2:{categoryID:7,groupID:54},3:{categoryID:8,groupID:83,volume:.01}})[id],getTypeName:id=>`Type ${id}`};
  const fit={fittingID:4,ownerID:20,shipTypeID:1,name:"Exact frigate",savedDate:"100",items:[{typeID:2,flagID:27,quantity:1},{typeID:3,flagID:5,quantity:100}]};
  fit.fingerprint=fittingFingerprint(fit.shipTypeID,fit.items);
  const contract=buildContract(fit,{scope:"CORPORATION",accountID:7,characterID:11,corporationID:20},data);
  const row=(itemID,typeID,locationID,flagID,quantity=1,singleton=false)=>({itemID,identity:String(itemID),typeID,ownerID:11,locationID,flagID,quantity,singleton,loaded:false});
  const state={online:false,claim:null,shipID:50,generation:"selected-generation",releaseFails:false,offlineUnknown:false,
    ambiguous:false,selectionHook:null,readHook:null,faultHook:null,definition:contract,
    hangar:[row(50,1,60,4,1,true),row(70,1,60,4),row(80,2,60,4)],equipment:new Map([[50,modified?[]:[row(90,2,50,27,1,true)]]])};
  const gateway={
    async getCharacterStatus(accountID,characterID){assert.equal(accountID,7);calls.push("status");return state.offlineUnknown?{characterID,online:true,controlState:"retail_client"}:{characterID,online:state.online,controlState:state.online?"retail_client":"offline"};},
    async selectCharacter(args,kwargs,fields){assert.deepEqual(args,[11,null,true]);assert.equal(fields.userid,7);calls.push("select");state.online=true;
      await state.selectionHook?.();return{bridgeSessionID:"stock-handle",session:{characterID:11,corporationID:20,stationID:60,shipID:state.shipID}};},
    async releaseBridgeSession(handle,fields){assert.equal(handle,"stock-handle");assert.equal(fields.userid,7);calls.push("release");if(state.releaseFails)throw Object.assign(new Error("timeout"),{code:"EVE_GATEWAY_TIMEOUT"});state.online=false;return{released:true,characterID:11};}
  };
  const store={async listCharactersForAccount(id){assert.equal(id,7);return[{accountID:7,characterID:11,corporationID:20,characterName:"Test01"}];}};
  const engine=createReplenishment({operations,data,filePath:custodyPath,now});
  const context=()=>({accountID:7,characterID:11,corporationID:20,shipID:state.shipID,shipTypeID:1,locationID:60,recoveryReady:true,sessionGeneration:state.generation});
  const readShip=async(input,targetHullID=null)=>{
    calls.push("readShip");await state.readHook?.();
    return {context:context(),contract:state.definition,contracts:[state.definition],
      observation:{complete:true,shipTypeID:1,rows:state.equipment.get(state.shipID)||[]},
      source:{rows:state.hangar.slice(),access:{query:true,take:true},pin:{descriptor:input.source,ownerID:11,locationID:60,flag:4,office:null,dockedLocationID:60}},
      hangar:state.hangar.slice(),target:{complete:true,shipID:targetHullID,shipTypeID:1,rows:state.equipment.get(targetHullID)||[]}};
  };
  const adapter={context:async()=>context(),readShip,plan:async()=>null,
    async dispatchShip(action){calls.push(action.kind);if(state.ambiguous)throw Object.assign(new Error("lost outcome"),{code:"EVE_GATEWAY_TIMEOUT"});
      if(action.kind==="ASSEMBLE_HULL") {state.hangar=state.hangar.filter(r=>r.itemID!==70).concat(row(77,1,60,4,1,true));state.equipment.set(77,[]);}
      else if(action.kind==="BOARD_HULL")state.shipID=77;
      else if(action.kind==="FIT_ITEM"){state.hangar=state.hangar.filter(r=>r.itemID!==80);state.equipment.set(77,[row(80,2,77,27,1,true)]);}
      else assert.fail(`Unexpected ${action.kind}`);
    }};
  const service=createProvisioningCenterApply({operations,sessionOperations,heldSessions,gateway,engine,store,data,filePath,now,
    botHost:{claimedBy:()=>state.claim},selectedAdapter:()=>adapter,
    attach(account,pilot,selected,key){const held={characterID:pilot,bridgeSessionID:selected.bridgeSessionID},webSessionID=`provisioning-center:${key}`;heldSessions.set(webSessionID,held);return{held,req:{account,webSessionID}};},
    detach(binding){if(heldSessions.get(binding.req.webSessionID)===binding.held)heldSessions.delete(binding.req.webSessionID);},
    fault:async(phase,record)=>{states.push(phase);await state.faultHook?.(phase,record);}});
  const input={characterID:11,providerCharacterID:11,corporationID:20,fittingID:4,source:{kind:"hangar"}};
  const detail={pilot:{accountID:7,characterID:11,corporationID:20,control:{owner:"OFF",online:false}},selected:contract};
  const prepare=(value=input,options)=>service.prepare(detail,value,options);
  const apply=async(review=prepare(),extra={})=>service.apply(account,{reviewID:review.reviewID,reviewHash:review.reviewHash,confirm:true,...extra},"CENTER","caller");
  return{account,calls,states,state,operations,sessionOperations,heldSessions,engine,service,input,detail,prepare,apply,data,fit,contract,gateway,store,adapter,hash};
}
module.exports={fixture};
