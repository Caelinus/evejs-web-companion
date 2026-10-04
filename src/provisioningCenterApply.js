"use strict";
const { createOperationJournal } = require("./operationJournal");
const { hash, fail, inspectContract } = require("./provisioningContracts");
const { randomUUID } = require("node:crypto");
const { selectedIntent, assertSelected } = require("./provisioningIntent");
const terminal = new Set(["COMPLETE", "ALREADY_SATISFIED", "REFUSED"]);
const states = new Set([...terminal, "PREPARED", "ACQUIRING_CONTROL", "READING", "REVALIDATING", "PROVISIONING", "VERIFYING", "RELEASING", "BLOCKED", "UNCERTAIN"]);
const positive = n => Number.isSafeInteger(n) && n > 0;
// One bounded consumer of the existing selected provisioning engine. The outer
// journal records control/invocation evidence; inventory custody stays in engine.
function createProvisioningCenterApply({ gateway, engine, operations, data, sessionOperations = new Map(), heldSessions = new Map(),
  botHost, store, selectedAdapter, attach, detach, releaseSession = (...args) => gateway.releaseBridgeSession(...args),
  withLease = (_lease, action) => action(), fault = null, filePath = null, now = Date.now }) {
  const journal = createOperationJournal({ filePath });
  const reviews = new Map(), active = new Map(), recoveryReservations = new Map(), recovering = new Map();
  for (const r of journal.list()) {
    if (r.kind !== "CENTER_APPLY" || !positive(r.accountID) || !positive(r.characterID) || !states.has(r.state) ||
        !r.pin || r.pin.accountID !== r.accountID || r.pin.characterID !== r.characterID || hash(r.pin) !== r.reviewHash ||
        !r.input || r.release?.state === undefined || Object.hasOwn(r, "bridgeSessionID")) fail("CENTER_CONTROL_JOURNAL_INVALID");
    if (!terminal.has(r.state) && !operations.has(r.characterID)) {
      const reservation={kind:"temporary-provisioning-recovery",id:r.key};
      operations.set(r.characterID,reservation);recoveryReservations.set(r.key,reservation);
    }
  }
  const pending = pilot => journal.list().filter(r => r.characterID === pilot && !terminal.has(r.state))
    .map(r => ({ operationID:r.key,state:r.state,reason:r.reason||null,active:active.get(r.key)?.running === true }));
  const publicResult = r => ({ operationID:r.key,state:r.state,reason:r.reason||null,control:r.control||null,
    revalidation:r.revalidation||null,provisioning:r.provisioning||null,release:r.release,finalReview:r.finalReview||null,
    selectedReview:r.selectedReview||null,custodyOperationID:r.custodyOperationID||null,finalObservedAt:r.finalObservedAt||null });
  const owned = (account,key) => {const r=journal.get(key);if(!r||r.accountID!==account.accountID)fail("OPERATION_NOT_OWNED");return {...r,key};};
  const save = row => { const {key,...record}=row;journal.put(key,{...record,updatedAt:now()}); };
  function prepare(detail, input, { revalidate = null } = {}) {
    const p=detail.pilot,c=detail.selected,source=input.source,consumer=input.consumer||"CENTER";
    const reasons=[];
    if (!c) reasons.push("Choose an explicit saved fitting; physical matching is pending.");
    if (p.control?.owner!=="OFF" || p.control?.online!==false) reasons.push("Pilot must be offline and free of known owners.");
    if (pending(p.characterID).length || engine.unresolved(p.characterID).length) reasons.push("Recovery required before a new invocation.");
    if (!positive(p.accountID) || !positive(p.characterID) || !["hangar","corp"].includes(source?.kind)) fail("REVIEW_REQUIRED");
    const pin={version:2,authority:"SELECTED_MAINTENANCE",accountID:p.accountID,characterID:p.characterID,corporationID:p.corporationID,
      definition:c?.definition||null,definitionFingerprint:c?.definitionFingerprint||null,source,
      consumer,training:input.training||null,suppliesPolicy:"NEW_HULL_ONLY"};
    const cleanInput={characterID:p.characterID,providerCharacterID:input.providerCharacterID,corporationID:c?.definition.corporationID||input.corporationID,
      fittingID:input.fittingID,source,consumer,...(input.training?{training:input.training}:{})};
    const reviewID=randomUUID(),expiresAt=now()+300000;
    for(const [key,value] of reviews) if(value.expiresAt<now()) reviews.delete(key);
    // Clone accepted intent so neither caller mutation nor subsequent Center
    // reads can substitute another Training configuration/source.
    reviews.set(reviewID,{pin:JSON.parse(JSON.stringify(pin)),input:JSON.parse(JSON.stringify(cleanInput)),revalidate,expiresAt,canApply:!reasons.length});
    return {reviewID,reviewHash:hash(pin),expiresAt,canApply:!reasons.length,reasons,suppliesPolicy:"NEW_HULL_ONLY",
      plan:c?{mode:"PENDING_SELECTED_REVIEW",hullQuantity:null,targetHullName:c.name,steps:["Acquire maintenance control","Authoritative selected Review","Apply supported plan","Verify and release"],
        unsupported:[],shortages:[],destructiveActions:[]}:null};
  }
  const isOffline = (s,pilot) => s?.characterID===pilot && s.online===false && s.controlState==="offline";
  function clearReservation(run) {
    if(operations.get(run.row.characterID)===run.reservation) operations.delete(run.row.characterID);
    for(const key of run.sessionKeys) if(sessionOperations.get(key)===run.reservation) sessionOperations.delete(key);
  }
  async function cleanup(run) {
    const row=run.row;
    row.state="RELEASING";
    let persistenceError=null;
    try { save(row);persistenceError=null; } catch(error) { persistenceError=error; }
    // A refusal before the selection call acquired no control to release.
    // Persist that fact before removing only this invocation's exact fences.
    if(!run.selectionRequested) {
      row.release={state:"NOT_ACQUIRED",checkedAt:now(),exactSessionReleased:false,evidence:"NO_SELECTION_DISPATCH"};
      row.state="REFUSED";save(row);
      clearReservation(run);active.delete(row.key);return;
    }
    let acknowledged=false;
    if(run.selected?.bridgeSessionID) {
      try {
        // Administrative cleanup targets ONLY the returned opaque handle. It
        // must remain possible while the inventory journal fences all writes.
        const r=await releaseSession(run.selected.bridgeSessionID,{userid:row.accountID});
        acknowledged=r?.released===true && (r.characterID==null || r.characterID===row.characterID);
      } catch(error) { acknowledged=error.code==="SESSION_NOT_FOUND"; }
    }
    let offline=false;
    try { offline=isOffline(await gateway.getCharacterStatus(row.accountID,row.characterID),row.characterID); } catch { /* Preserve uncertainty. */ }
    row.release={state:offline?"VERIFIED_OFFLINE":acknowledged?"SESSION_RELEASED_OFFLINE_UNPROVEN":"UNVERIFIED",checkedAt:now(),
      exactSessionReleased:acknowledged,evidence:offline?"AUTHORITATIVE_CHARACTER_STATUS":null};
    if(acknowledged||offline) { if(run.binding) detach(run.binding); }
    else if(run.binding) run.binding.held.selectionReleaseUnverified=true;
    const custody=engine.unresolved(row.characterID).length>0;
    row.state=!offline?"UNCERTAIN":custody?"BLOCKED":row.completion||"REFUSED";
    if(!offline) row.reason="CONTROL_RELEASE_UNPROVEN";
    else if(custody) row.reason="PROVISIONING_RECOVERY_REQUIRED";
    // A journal failure cannot strand the session. Keep the original durable
    // invocation/recovery fence if the final evidence cannot be persisted.
    try { save(row);persistenceError=null; } catch(error) { persistenceError=error; }
    if(offline&&!custody&&!persistenceError) { clearReservation(run);active.delete(row.key); }
    else if(acknowledged) { for(const key of run.sessionKeys) if(sessionOperations.get(key)===run.reservation) sessionOperations.delete(key); }
    if(persistenceError) throw persistenceError;
  }
  async function apply(account, request, consumer="CENTER", callerSessionID=null) {
    if(request?.confirm!==true) fail("CONFIRMATION_REQUIRED");
    const prior=journal.get(request.reviewID);
    if(prior) {
      const row=owned(account,request.reviewID);
      if(row.reviewHash!==request.reviewHash || (row.pin.version===2 && row.pin.consumer!==consumer)) fail("REVIEW_REQUIRED");
      return publicResult(row); // Never reacquire or replay a persisted invocation.
    }
    const accepted=reviews.get(request.reviewID);
    if(!accepted || !accepted.canApply || accepted.expiresAt<now() || hash(accepted.pin)!==request.reviewHash ||
        accepted.pin.accountID!==account.accountID || accepted.pin.consumer!==consumer) fail("REVIEW_REQUIRED");
    if(request.source && hash(request.source)!==hash(accepted.input.source) ||
        request.training && hash(request.training)!==hash(accepted.input.training)) fail("REVIEW_STALE");
    const pilot=accepted.pin.characterID,sessionID=`provisioning-center:${request.reviewID}`;
    const sessionKeys=[...new Set([sessionID,...(callerSessionID?[callerSessionID]:[])])];
    if(operations.has(pilot) || sessionKeys.some(k=>sessionOperations.has(k)) || engine.unresolved(pilot).length ||
        botHost.claimedBy(pilot)!==null || [...heldSessions.values()].some(h=>h.characterID===pilot)) fail("PILOT_BUSY");
    const row={key:request.reviewID,kind:"CENTER_APPLY",accountID:account.accountID,characterID:pilot,
      pin:accepted.pin,input:accepted.input,reviewHash:request.reviewHash,runID:randomUUID(),state:"ACQUIRING_CONTROL",
      release:{state:"NOT_ACQUIRED"},createdAt:now()};
    const reservation={kind:"temporary-provisioning",id:row.key,characterID:pilot,runID:row.runID};
    const run={row,reservation,sessionKeys,running:true,selectionRequested:false,selected:null,binding:null};
    // Persist before acquiring. If persistence fails, no reservation or session
    // is installed and no mutation is sent.
    save(row);operations.set(pilot,reservation);for(const key of sessionKeys) sessionOperations.set(key,reservation);active.set(row.key,run);
    function current() {
      const owner=operations.get(pilot);
      if(active.get(row.key)!==run || !(owner===reservation || owner?.kind==="replenishment" && owner.parent===reservation && owner.id===row.custodyOperationID) ||
          sessionKeys.some(k=>sessionOperations.get(k)!==reservation) || botHost.claimedBy(pilot)!==null ||
          [...heldSessions.values()].some(h=>h.characterID===pilot && h!==run.binding?.held) ||
          run.binding && heldSessions.get(sessionID)!==run.binding.held ||
          engine.unresolved(pilot).some(r=>r.key!==row.custodyOperationID || r.accountID!==row.accountID)) fail("PROVISIONING_GENERATION_CHANGED");
    }
    async function boundary(state) { row.state=state;save(row);if(fault)await fault(state,row);current(); }
    try {
      current();
      const chars=await store.listCharactersForAccount(account.accountID);current();
      if(!chars.some(p=>p.characterID===pilot && p.accountID===account.accountID && p.corporationID===row.pin.corporationID)) fail("PILOT_AUTHORITY_CHANGED");
      const status=await gateway.getCharacterStatus(account.accountID,pilot);current();
      if(!isOffline(status,pilot)) fail("PILOT_BUSY");
      await boundary("ACQUIRING_CONTROL");
      row.release={state:"UNVERIFIED"};save(row);
      run.selected=await withLease(reservation,()=>{
        run.selectionRequested=true;
        return gateway.selectCharacter([pilot,null,true],null,{userid:account.accountID,userName:String(account.username||"")});
      });
      current();
      if(typeof run.selected?.bridgeSessionID!=="string" || !run.selected.bridgeSessionID || run.selected.session?.characterID!==pilot) fail("PROVISIONING_SESSION_MISMATCH");
      run.binding=attach(account,pilot,run.selected,row.key);current();
      run.binding.held.maintenanceCurrent=current;
      const adapter=selectedAdapter(run.binding.req,run.binding.held);
      let generation=null,baseline=null,preMutation=true,requireTake=true;
      const guarded=new Proxy(adapter,{get(target,key) {
        const fn=target[key];if(typeof fn!=="function")return fn;
        return async(...args)=>{
          current();if(key==="dispatch"||key==="dispatchShip")preMutation=false;
          const result=await fn.apply(target,args);current();
          const context=key==="context"?result:result?.context;
          if(context && generation && context.sessionGeneration!==generation) fail("PROVISIONING_GENERATION_CHANGED");
          if(key==="readShip") {
            if(result.contract.definitionFingerprint!==row.pin.definitionFingerprint)fail("REVIEW_STALE");
            if(baseline&&preMutation)assertSelected(baseline,result,data,{requireTake});
          }
          return result;
        };
      }});
      await boundary("READING");
      const first=await guarded.readShip(row.input);current();generation=first.context.sessionGeneration;
      if(["accountID","characterID","corporationID"].some(k=>first.context[k]!==row.pin[k]) ||
          hash(first.source.pin.descriptor)!==hash(row.pin.source))fail("PILOT_AUTHORITY_CHANGED");
      // Query-only source authority is enough for a proven zero-mutation
      // result. Shared shipPlan still requires Take before any new hull action.
      requireTake=inspectContract(first.contract,first.observation,data).equipment!=="VERIFIED";
      baseline=selectedIntent(first,{requireTake});row.selectedBaseline=baseline;
      row.control={state:"MAINTENANCE",generation,characterID:pilot};save(row);
      await boundary("REVALIDATING");
      if(accepted.revalidate) { await accepted.revalidate(account,{selected:first.contract,pilot:{quality:"COMPLETE",observation:first.observation}});current(); }
      const review=await engine.reviewShip(guarded,row.input);current();
      row.selectedReview=review;row.revalidation={state:"VERIFIED_SELECTED",generation};save(row);
      if(!review.canApply) fail("PROVISIONING_PLAN_BLOCKED",review.plan.unsupported.concat(review.plan.shortages).join("; "));
      await boundary("PROVISIONING");
      if(accepted.revalidate) { await accepted.revalidate(account,{selected:first.contract,pilot:{quality:"COMPLETE",observation:first.observation}});current(); }
      // Persist the exact child ID before engine can dispatch. Retrying the
      // outer invocation returns evidence, never creates another child.
      row.custodyOperationID=review.reviewID;save(row);
      row.provisioning=await engine.withTemporaryControl(reservation,()=>engine.applyShip(guarded,{reviewID:review.reviewID,reviewHash:review.reviewHash}));current();save(row);
      if(row.provisioning.state!=="COMPLETE")fail("PROVISIONING_RECOVERY_REQUIRED");
      await boundary("VERIFYING");
      row.finalReview=await engine.reviewShip(guarded,row.input);current();
      row.finalObservedAt=now();
      if(row.finalReview.status.equipment!=="VERIFIED")fail("FINAL_EQUIPMENT_NOT_VERIFIED");
      row.completion=row.provisioning.result?.alreadySatisfied?"ALREADY_SATISFIED":"COMPLETE";row.reason=null;save(row);
    } catch(error) {
      row.reason=String(error.code||"MAINTENANCE_FAILED");row.completion="REFUSED";
      // Reconciliation is observation only and uses the original selected
      // owner. Ownership loss never authorizes reacquisition or another send.
      if(row.custodyOperationID && engine.unresolved(pilot).some(r=>r.key===row.custodyOperationID) && run.binding) {
        try { current();const adapter=selectedAdapter(run.binding.req,run.binding.held);
          await engine.withTemporaryControl(reservation,()=>engine.reconcile(adapter,row.custodyOperationID));current();
        } catch { /* Durable custody remains blocked. */ }
      }
      save(row);
    } finally {
      try { await cleanup(run); } finally { run.running=false; }
    }
    return publicResult(row);
  }
  async function recoverOnce(account, operationID) {
    const row=owned(account,operationID);
    if(terminal.has(row.state))return publicResult(row);
    const run=active.get(operationID);
    if(run?.running) return publicResult(row);
    if(run) { run.running=true;try { await cleanup(run);return publicResult(run.row); } finally { run.running=false; } }
    const expectedReservation=recoveryReservations.get(operationID);
    const s=await gateway.getCharacterStatus(account.accountID,row.characterID);
    if(s?.characterID!==row.characterID||s.online!==false||s.controlState!=="offline") {
      row.state="BLOCKED";row.reason="CONTROL_RELEASE_UNPROVEN";save(row);return publicResult(row);
    }
    row.release={...row.release,state:"VERIFIED_OFFLINE",checkedAt:now(),evidence:"AUTHORITATIVE_CHARACTER_STATUS"};
    if(engine.unresolved(row.characterID).length){row.state="BLOCKED";row.reason="PROVISIONING_RECOVERY_REQUIRED";}
    else {row.state=row.completion||"REFUSED";row.reason=["COMPLETE","ALREADY_SATISFIED"].includes(row.completion)?null:row.reason||"INTERRUPTED_REVIEW_REQUIRED";}
    save(row); // Persist terminal evidence before removing its exact fence.
    const reservation=operations.get(row.characterID);
    if(terminal.has(row.state)&&expectedReservation && reservation===expectedReservation) {
      operations.delete(row.characterID);recoveryReservations.delete(operationID);
    }
    return publicResult(row);
  }
  function recover(account,operationID) {
    try { owned(account,operationID); } catch(error) { return Promise.reject(error); }
    if(recovering.has(operationID))return recovering.get(operationID);
    const promise=recoverOnce(account,operationID).finally(()=>{if(recovering.get(operationID)===promise)recovering.delete(operationID);});
    recovering.set(operationID,promise);return promise;
  }
  return { pending, status:(account,key)=>publicResult(owned(account,key)), recover, journal,
    prepare,apply };
}
module.exports={createProvisioningCenterApply};
