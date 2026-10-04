"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createProvisioningCenterApply}=require("./provisioningCenterApply"),{hash}=require("./provisioningContracts");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
function fixture(){
 const operations=new Map();let online=true,unresolved=false;
 const service=createProvisioningCenterApply({operations,engine:{unresolved:()=>unresolved?[{}]:[]},gateway:{getCharacterStatus:async()=>({characterID:11,online,controlState:online?"retail_client":"offline"})}});
 const pin={accountID:7,characterID:11};service.journal.put("old-invocation",{kind:"CENTER_APPLY",accountID:7,characterID:11,state:"BLOCKED",pin,reviewHash:hash(pin),input:{},release:{state:"UNVERIFIED"}});
 const account={accountID:7};operations.set(11,{kind:"temporary-provisioning-recovery",id:"old-invocation"});
 return{service,operations,account,offline(){online=false;},custody(){unresolved=true;}};
}
test("retired offline Apply cannot create new invocation evidence",async()=>{
 const f=fixture();assert.throws(()=>f.service.prepare({}),{code:"PROVISIONING_OFFLINE_AUTHORITY_UNAVAILABLE"});
 await assert.rejects(f.service.apply(f.account,{confirm:true}),{code:"PROVISIONING_OFFLINE_AUTHORITY_UNAVAILABLE"});assert.equal(f.service.journal.list().length,1);
});
test("historical recovery requires positive offline status and removes only its exact reservation",async()=>{
 const f=fixture(),before=f.operations.get(11);assert.equal((await f.service.recover(f.account,"old-invocation")).reason,"CONTROL_RELEASE_UNPROVEN");assert.equal(f.operations.get(11),before);
 f.offline();assert.equal((await f.service.recover(f.account,"old-invocation")).state,"REFUSED");assert.equal(f.operations.size,0);
 assert.equal(f.service.status(f.account,"old-invocation").release.state,"VERIFIED_OFFLINE");
});
test("historical offline recovery preserves foreign reservations and unresolved transfer custody",async()=>{
 const f=fixture(),foreign=Symbol("foreign");f.operations.set(11,foreign);f.offline();f.custody();
 const result=await f.service.recover(f.account,"old-invocation");assert.equal(result.state,"BLOCKED");assert.equal(result.reason,"PROVISIONING_RECOVERY_REQUIRED");assert.equal(f.operations.get(11),foreign);
 assert.equal(f.service.pending(11).length,1);await assert.rejects(f.service.recover({accountID:8},"old-invocation"),{code:"OPERATION_NOT_OWNED"});
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
