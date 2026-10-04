"use strict";
const { hash, fail, inspectContract } = require("./provisioningContracts");
const { selectedIntent, assertSelected } = require("./provisioningIntent");
const { defenderReadiness } = require("./standardDefenderReadiness");
const positive = n => Number.isSafeInteger(n) && n > 0;
const ready = value => ["VERIFIED", "DEGRADED"].includes(value?.state);
const stockRows = rows => rows.map(r => [r.itemID,r.typeID,r.ownerID,r.locationID,r.flagID,r.quantity,!!r.singleton])
  .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
// The offline projection also observes ore/specialized holds. Selected Review
// authoritatively reads this shared equipment/supply scope. Compare equivalent
// read sets; a loaded charge's virtual ID is not a physical stack identity.
function selectedRows(rows, data) {
  const slot=f=>[[11,34],[92,99],[125,132],[164,171]].some(([lo,hi])=>f>=lo&&f<=hi);
  return rows.filter(r=>slot(r.flagID)||[5,87,158,133,143].includes(r.flagID)).map(r=>
    slot(r.flagID)&&Number(data.getType(r.typeID)?.categoryID)===8 ? {...r,itemID:null,singleton:false} : r);
}
function comparablePin(pin, data) {
  const value=structuredClone(pin);
  value.observed=stockRows(selectedRows(value.observed.map(([itemID,typeID,ownerID,locationID,flagID,quantity,singleton])=>
    ({itemID,typeID,ownerID,locationID,flagID,quantity,singleton})),data));
  return value;
}

// Configuration is intent only. The shared engines validate inventory/bay and
// Take authority; MCC decides whether a proven shortage prevents this run.
function normalizePreparation(value = {}, member = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MINING_OPERATION_INVALID", "Invalid preparation options.");
  const result = {};
  for (const key of ["fittingID", "providerCharacterID"]) if (value[key] != null) {
    if (!positive(value[key])) fail("MINING_OPERATION_INVALID", `Invalid preparation ${key}.`);
    result[key] = value[key];
  }
  if (member) return result;
  const source = value.source || { kind: "hangar" };
  if (source.kind === "hangar") result.source = { kind: "hangar" };
  else if (source.kind === "corp" && positive(source.corporationID) && Number.isInteger(source.division) && source.division >= 1 && source.division <= 7)
    result.source = { kind: "corp", corporationID: source.corporationID, division: source.division };
  else fail("MINING_OPERATION_INVALID", "Preparation requires personal hangar or an exact local corporation division.");
  if (value.suppliesRequired != null && typeof value.suppliesRequired !== "boolean") fail("MINING_OPERATION_INVALID");
  result.suppliesRequired = value.suppliesRequired === true;
  if (value.supplies != null) {
    if (!Array.isArray(value.supplies) || value.supplies.length > 30) fail("MINING_OPERATION_INVALID");
    result.supplies = value.supplies.map(t => {
      if (!positive(t.typeID) || !positive(t.target) || !["CARRIED_SPARES", "TOTAL_ABOARD"].includes(t.mode) ||
          !Array.isArray(t.eligibleFlags) || !t.eligibleFlags.length || t.eligibleFlags.some(f => ![5,133,143].includes(f)) ||
          (t.required != null && typeof t.required !== "boolean")) fail("MINING_OPERATION_INVALID", "Invalid supply policy.");
      return { typeID: t.typeID, target: t.target, mode: t.mode, eligibleFlags: [...new Set(t.eligibleFlags)].sort((a,b)=>a-b), required: t.required === true };
    });
  }
  return result;
}
function requiredTarget(target, policy, support = null) {
  return support?.useIndustrialCore && target.typeID === 16272
    ? support.coreRequirement === "requireCore" : policy.suppliesRequired || target.required === true;
}
function readiness(status, policy, support = null) {
  if (status?.equipment !== "VERIFIED") return { state: "BLOCKED", reason: `Equipment ${status?.equipment || "UNKNOWN"}; MCC does not refit or build ships.` };
  if (status.supplies === "UNKNOWN") return { state: "BLOCKED", reason: "Supply observation UNKNOWN." };
  const core = support?.useIndustrialCore;
  if (core && !status.targets.some(t => t.typeID === 16272)) return { state: "BLOCKED", reason: "Configure an explicit Heavy Water target for Industrial Core preparation." };
  const short = status.targets.filter(t => t.state !== "FULL");
  if (short.some(t => requiredTarget(t,policy,support))) return { state: "BLOCKED", reason: "Required supply target is not FULL." };
  return short.length ? { state: "DEGRADED", reason: core && short.some(t=>t.typeID===16272) ? "Heavy Water short; Core optional." : "Optional supplies below target." } : { state: "VERIFIED", reason: null };
}
function createMiningPreparation({ store, readDefinitions, readSkills, engine, adapterFor, bots, currentRun, data, fault = null, now = Date.now }) {
  const sourceLabel = s => s.kind === "corp" ? `Corporation ${s.corporationID} / division ${s.division}` : "Personal local hangar";
  function view(member, status, policy, support, extra = {}) {
    return { characterID: member.characterID, role: member.role, ...readiness(status,policy,support), equipment: status.equipment,
      supplies: status.supplies, targets: status.targets.map(t=>({...t,required:requiredTarget(t,policy,support)})),
      sourceLabel: sourceLabel(policy.source), observedAt: new Date(now()).toISOString(), ...extra };
  }
  async function plan(definition, caller = null) {
    const policy = normalizePreparation(definition.preparation), members = [];
    for (const member of definition.members) {
      let detail;
      const support = definition.support?.characterID === member.characterID ? definition.support : null;
      try {
        const account = await store.getAccount(member.accountName);
        if (!account || account.banned || !await store.getCharacterForAccount(account.accountID,member.characterID)) fail("CHARACTER_NOT_FOUND");
        const override = normalizePreparation(member.preparation || {},true);
        const input = { characterID: member.characterID, providerCharacterID: override.providerCharacterID || policy.providerCharacterID || member.characterID,
          fittingID: override.fittingID || policy.fittingID || 0, source: policy.source, supplyPolicy: { supplies: policy.supplies || [] } };
        detail = await readDefinitions(account.accountID,input);
        if (detail.status !== "READY") fail("FITTING_SOURCE_CHANGED");
        const contracts = detail.contracts.filter(c=>!input.fittingID || c.definition.fittingID===input.fittingID);
        if (!contracts.length) fail("INVALID_FIT");
        input.corporationID = detail.corporationID;
        const selected = contracts.length === 1 ? contracts[0] : null;
        const status = selected ? inspectContract(selected,{complete:false},data) : {equipment:"UNKNOWN",supplies:"UNKNOWN",targets:[]};
        members.push({ ...view(member,status,policy,support), state: "PENDING",
          reason: "Configuration accepted; the final hosted owner must verify exact equipment and supplies before productive work.",
          fittingName: selected?.name || null,
          intent: JSON.parse(JSON.stringify({ version: 2, authority: "SELECTED_SESSION", operationID: definition.operationID,
            accountID: account.accountID, characterID: member.characterID, input, policy, support, role: member.role,
            definitionPins: contracts.map(c=>({fittingID:c.definition.fittingID,definitionFingerprint:c.definitionFingerprint,
              equipmentFingerprint:c.equipmentFingerprint,supplyPolicyFingerprint:c.supplyPolicyFingerprint})) })) });
      } catch (error) {
        members.push(view(member,{equipment:"UNKNOWN",supplies:"UNKNOWN",targets:[]},policy,support,
          { state:"BLOCKED", reason: error.message || error.code }));
      }
    }
    return { state: members.some(m=>m.state==="BLOCKED") ? "BLOCKED" : "READY", members,
      planHash: hash(members.map(m=>m.intent || { characterID:m.characterID, reason:m.reason })) };
  }
  const boundary = async (name,record) => { if (fault) await fault(name,{ operationID:record.operationID, operationRunID:record.operationRunID,
    logicalRunID:record.logicalRunID, characterID:record.characterID, preparation:record.preparationCheckpoint.snapshot() }); };
  function adjustedPin(record, base, includeSelf = false) {
    const pin = structuredClone(base), ids = new Set();
    const included = new Set(record.preparationCheckpoint.snapshot()?.evidence?.selectedBaseline?.includedCustodyIDs || []);
    // EveJS offline roots include the boarded hull; selected hangar List may
    // omit it. MCC never withdraws a hull, so it is outside its supply stock.
    pin.source.stock=pin.source.stock.filter(r=>r[0]!==base.shipID);
    for (const b of bots()) if (b.operationID===record.operationID && b.operationRunID===record.operationRunID &&
        (includeSelf || b.characterID!==record.characterID) && (b.preparation?.custodyOperationID || b.preparation?.evidence?.custodyOperationID)) ids.add(b.preparation.custodyOperationID || b.preparation.evidence.custodyOperationID);
    if (includeSelf && record.preparationCheckpoint.snapshot()?.evidence?.custodyOperationID) ids.add(record.preparationCheckpoint.snapshot().evidence.custodyOperationID);
    for (const row of engine.journal.list().filter(r=>ids.has(r.key) && !included.has(r.key)).sort((a,b)=>a.createdAt-b.createdAt)) {
      const source=row.sourcePin, expected=base.source;
      if (hash(source.descriptor)!==hash(pinSource(base)) || source.ownerID!==(expected.kind==="corp" ? expected.corporationID : base.characterID) ||
          source.locationID!==expected.contentsLocationID || source.dockedLocationID!==expected.dockedLocationID || source.flag!==expected.flag ||
          source.office!==(expected.kind==="corp" ? `corpOffice:${expected.officeID}` : null)) continue;
      for (const move of row.moves) {
        if (move.state!=="VERIFIED") fail("REPLENISHMENT_CUSTODY");
        if (hash(pin.source.stock)!==hash(stockRows(move.before.source).filter(r=>r[0]!==base.shipID))) fail("SOURCE_CHANGED");
        pin.source.stock=stockRows(move.after.source).filter(r=>r[0]!==base.shipID);
        if (row.characterID===record.characterID) {
          const flags=new Set(move.before.destination.concat(move.after.destination).map(r=>r.flagID));
          pin.observed=pin.observed.filter(r=>!flags.has(r[4])).concat(stockRows(move.after.destination))
            .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
        }
      }
    }
    return pin;
  }
  function pinSource(pin) { return pin.source.kind==="corp" ? {kind:"corp",corporationID:pin.source.corporationID,division:pin.source.division} : {kind:"hangar"}; }
  async function prepare(record) {
    let accepted=record.operationPreparation;
    const cp=record.preparationCheckpoint;
    const current=()=>{ record.assertPreparationCurrent(); if (currentRun(record.operationID)!==record.operationRunID) fail("OPERATION_RUN_CHANGED"); };
    current();
    const old=cp.snapshot();
    if (ready(old)) return old;
    if (old?.state === "BLOCKED" && old.invocation > 0) cp.recover({ operationRunID:record.operationRunID });
    else if (!["PREPARING","RECOVERY_REQUIRED"].includes(old?.state)) cp.begin({ operationRunID:record.operationRunID });
    try {
      if (![1,2].includes(accepted?.version) || accepted.accountID!==record.accountID || accepted.characterID!==record.characterID || accepted.operationID!==record.operationID) fail("REVIEW_REQUIRED");
      const adapter=adapterFor(record), baseRead=adapter.read;
      let baselineGeneration = null;
      if (accepted.version === 2) {
        if (accepted.authority !== "SELECTED_SESSION" || !Array.isArray(accepted.definitionPins)) fail("REVIEW_REQUIRED");
        let baseline = cp.snapshot()?.evidence?.selectedBaseline;
        if (!baseline) {
          // Capture only settled same-run custody. A sibling finishing during
          // the read can already be reflected in stock; retry once instead of
          // applying its movement to that baseline a second time. This fences
          // WC journal evidence, not external inventory changes.
          const representedCustody = () => {
            const ids = new Set(bots().filter(b=>b.operationID===record.operationID && b.operationRunID===record.operationRunID)
              .map(b=>b.preparation?.custodyOperationID || b.preparation?.evidence?.custodyOperationID).filter(Boolean));
            const rows = engine.journal.list();
            return [...ids].sort().map(key=>({key,row:rows.find(r=>r.key===key)||null}));
          };
          let read, includedCustodyIDs;
          for (let attempt=0;attempt<2;attempt++) {
            const before=representedCustody();
            if(before.some(({row})=>!row || !["COMPLETE","RECONCILED"].includes(row.state) || row.moves.some(m=>m.state!=="VERIFIED")))
              fail("REPLENISHMENT_CUSTODY");
            read=await adapter.readPreparation(accepted.input);current();
            if(hash(before)===hash(representedCustody())) {includedCustodyIDs=before.map(r=>r.key);break;}
          }
          if(!includedCustodyIDs)fail("SOURCE_CHANGED");
          const c=read.contract;
          if (!accepted.definitionPins.some(p=>p.fittingID===c.definition.fittingID && p.definitionFingerprint===c.definitionFingerprint &&
            p.equipmentFingerprint===c.equipmentFingerprint && p.supplyPolicyFingerprint===c.supplyPolicyFingerprint)) fail("REVIEW_STALE");
          const status=inspectContract(c,read.observation,data);
          if (status.equipment!=="VERIFIED" || status.supplies==="UNKNOWN") fail("EQUIPMENT_NOT_READY");
          if (accepted.role === "DEFENDER") {
            const combat=defenderReadiness(c,read.observation,await readSkills?.(record.accountID,record.characterID),data,true);current();
            if (combat.state!=="VERIFIED") fail("DEFENDER_NOT_READY",combat.reason);
          }
          baseline={ pin:selectedIntent(read), input:{...accepted.input,fittingID:c.definition.fittingID},
            fittingName:c.name, includedCustodyIDs };
          baselineGeneration=read.context.sessionGeneration;
          cp.update({selectedBaseline:baseline});
        }
        accepted={...accepted,...baseline};
      }
      const sourcePin={descriptor:pinSource(accepted.pin),ownerID:accepted.pin.source.kind==="corp" ? accepted.pin.source.corporationID : accepted.characterID,
        locationID:accepted.pin.source.contentsLocationID,flag:accepted.pin.source.flag,dockedLocationID:accepted.pin.source.dockedLocationID,
        office:accepted.pin.source.kind==="corp" ? `corpOffice:${accepted.pin.source.officeID}` : null};
      const pending=old?.custodyOperationID || old?.evidence?.custodyOperationID;
      const assertAcceptedRead = read => assertSelected(comparablePin(adjustedPin(record,accepted.pin,!!pending),data),
        {...read,source:{...read.source,rows:read.source.rows.filter(r=>r.itemID!==read.context.shipID)},
          observation:{...read.observation,rows:selectedRows(read.observation.rows,data)},target:{complete:true}});
      let generation=baselineGeneration, preMutation=false;
      const guarded={...adapter, context:async()=>{current();const c=await adapter.context();current();if(generation && c.sessionGeneration!==generation)fail("PROVISIONING_GENERATION_CHANGED");return c;},
        dispatch:async (...args)=>{current();preMutation=false;const result=await adapter.dispatch(...args);current();return result;},
        read:async input=>{current();const r=await baseRead(input,sourcePin);current();if(generation && r.context.sessionGeneration!==generation)fail("PROVISIONING_GENERATION_CHANGED");
          if(r.contract.definitionFingerprint!==accepted.pin.definitionFingerprint)fail("REVIEW_STALE");if(preMutation)assertAcceptedRead(r);return r;}};
      if (pending && engine.unresolved(record.characterID).some(r=>r.key===pending)) {
        const reconciled=await engine.reconcile(guarded,pending);current();
        if (!['RECONCILED','COMPLETE'].includes(reconciled.state)) fail("REPLENISHMENT_CUSTODY");
      }
      const fresh=await guarded.read(accepted.input);generation=fresh.context.sessionGeneration;
      cp.update({ selectedRead:{context:fresh.context,definitionFingerprint:fresh.contract.definitionFingerprint,
        observed:stockRows(fresh.observation.rows),sourcePin:fresh.source.pin,sourceStock:stockRows(fresh.source.rows)} });
      assertAcceptedRead(fresh);
      // Keep accepted intent strict across Review and all Apply reads until
      // dispatch. After that the shared journal proves its own movement states.
      preMutation=true;
      const verified=await engine.review(guarded,accepted.input);current();
      if(verified.status.equipment!=="VERIFIED" || verified.status.supplies==="UNKNOWN")fail("EQUIPMENT_NOT_READY");
      cp.update({ ownerGeneration:generation, context:verified.context, revalidatedAt:now() });
      await boundary("REVALIDATED",record);current();
      let custodyOperationID=pending || null;
      // A recovered invocation is never dispatched again. A proven remaining
      // shortage is evaluated as facts; a new run may choose a new deficit.
      if (!pending && verified.status.targets.some(t=>t.deficit>0)) {
        custodyOperationID=verified.reviewID;
        cp.update({ custodyOperationID, reviewHash:verified.reviewHash, before:verified.status, source:verified.source });
        await boundary("BEFORE_REPLENISH",record);current();
        const result=await engine.apply(guarded,{reviewID:verified.reviewID,reviewHash:verified.reviewHash});current();
        if(!['COMPLETE','RECONCILED'].includes(result.state))fail("REPLENISHMENT_CUSTODY");
      }
      let final=await engine.review(guarded,accepted.input);current();
      if (accepted.role === "DEFENDER") {
        const capabilityRead = await guarded.read(accepted.input); current();
        final = { ...final, context: capabilityRead.context,
          status: inspectContract(capabilityRead.contract, capabilityRead.observation, data) };
        const combat = defenderReadiness(capabilityRead.contract, capabilityRead.observation,
          await readSkills?.(record.accountID, record.characterID), data);
        current();
        if (combat.state !== "VERIFIED") fail("DEFENDER_NOT_READY", combat.reason);
      }
      const result=view(accepted,final.status,accepted.policy,accepted.support,{ custodyOperationID, ownerGeneration:generation,
        fittingName:accepted.fittingName, context:final.context, before:verified.status, finalReview:final.status, completedAt:now() });
      if(ready(result)) cp.complete(result);else cp.block(result);
      await boundary("VERIFIED",record);current();return result;
    } catch(error) {
      const result={...cp.snapshot(),state:engine.unresolved(record.characterID).length?"RECOVERY_REQUIRED":"BLOCKED",
        reason:error.code === "DEFENDER_NOT_READY" ? error.message : error.code||error.message};
      cp.block(result);return result;
    }
  }
  return { plan, prepare, ready, unresolved:record=>engine.unresolved(record.characterID).length>0 };
}
module.exports={normalizePreparation,readiness,createMiningPreparation,stockRows,selectedRows};
