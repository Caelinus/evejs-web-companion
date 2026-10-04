"use strict";
const { validateConfigurations } = require("./trainingConfigurations");
const { fail, hash } = require("./provisioningContracts");
const CONSUMER = "PILOT_TRAINING";
const EVIDENCE_TTL = 60000;
function physicalSource(value = { kind: "hangar" }) {
  if (value?.kind === "hangar") return { kind: "hangar" };
  if (value?.kind === "corp" && Number.isSafeInteger(value.corporationID) && value.corporationID > 0 &&
      Number.isInteger(value.division) && value.division >= 1 && value.division <= 7)
    return { kind: "corp", corporationID: value.corporationID, division: value.division };
  fail("SOURCE_UNSUPPORTED");
}
function acceptedDefinition(config, detail) {
  const d = detail.selected?.definition;
  return !!d && d.fittingID === config.fittingID && d.corporationID === config.corporationOwnerID &&
    detail.selected.shipTypeID === config.hullTypeID && d.savedDate === config.acceptedSavedDate && d.fingerprint === config.acceptedFingerprint;
}
function dutyReady(skills, equipment) { return skills === "READY" && equipment === "VERIFIED" ? "READY" : "NOT_READY"; }

// Observation and an explicit consumer of the accepted Center lifecycle. There
// is no Training matcher, inventory loader, journal or ownership registry here.
function createTrainingEquipment({ center, readQualification, now = Date.now }) {
  const acceptedReviews=new Map(),selectedEvidence=new Map();
  const evidenceKey=(accountID,characterID,config,source)=>hash([accountID,characterID,config,source]);
  const inputFor = (characterID, config, source) => ({ characterID, providerCharacterID: characterID,
    corporationID: config.corporationOwnerID, fittingID: config.fittingID, source });
  async function inspect(account, characterID, config, source) {
    const detail = await center.readReview(account.accountID, inputFor(characterID, config, source));
    if (!acceptedDefinition(config, detail)) fail("REVIEW_STALE", "Accept the current Training fitting definition before equipment Review.");
    return detail;
  }
  function equipment(detail, reason = null, observedAt = now()) {
    const at = observedAt, p = detail?.pilot;
    const complete = p?.quality === "COMPLETE" && p.observation?.complete === true;
    const status = complete ? detail.status : { equipment: "UNKNOWN", supplies: "UNKNOWN", targets: (detail?.status.targets || []).map(t => ({ ...t, state: "UNKNOWN", current: null, deficit: null })) };
    return { status, reason: reason || (complete ? status.equipment === "VERIFIED" ? "Exact accepted equipment match." : "Current equipment does not match the accepted fitting." : "Authoritative equipment observation is incomplete."),
      observedAt: at, validUntil: at + EVIDENCE_TTL, quality: p?.quality || "UNAVAILABLE", revision: p?.revision || null,
      shipID: p?.shipID || null, hullName: p?.hullName || null, locationID: p?.locationID || null,
      control: p?.control || { state: "UNKNOWN", owner: "UNKNOWN" }, source: detail?.candidateSource || null };
  }
  async function enrich(account, read, configurations, source = { kind: "hangar" }) {
    source = physicalSource(source);
    const configs = validateConfigurations(read.report.role, configurations), stages = [];
    for (const stage of read.report.stages) {
      const config = configs.find(c => c.configurationID === stage.id);
      let observation;
      try {
        if (!config || stage.fitting.status !== "READY") fail("REVIEW_REQUIRED", stage.fitting.reason || "Accept a readable Training fitting first.");
        const detail=await inspect(account, read.report.pilot.characterID, config, source);
        const key=evidenceKey(account.accountID,read.report.pilot.characterID,config,source),receipt=selectedEvidence.get(key);
        if(receipt && receipt.at+EVIDENCE_TTL<=now())selectedEvidence.delete(key);
        observation=receipt && receipt.at+EVIDENCE_TTL>now() && detail.pilot.control.owner==="OFF" && detail.pilot.control.online===false ?
          equipment(receipt.detail,"Verified by the completed selected maintenance operation.",receipt.at):equipment(detail);
      } catch (e) { observation = equipment(null, e.code === "PROVISIONING_OFFLINE_AUTHORITY_UNAVAILABLE" ? e.message : e.code || "OBSERVATION_UNAVAILABLE"); }
      stages.push({ ...stage, equipmentReadiness: observation.status.equipment, equipmentReason: observation.reason,
        equipment: observation, dutyReadiness: dutyReady(stage.skillQualification, observation.status.equipment) });
    }
    return { ...read, report: { ...read.report, stages } };
  }
  async function review(account, request) {
    const characterID = request.characterID, role = request.role;
    const configs = validateConfigurations(role, request.configurations);
    const config = configs.find(c => c.configurationID === request.configurationID);
    if (!config) fail("INVALID_TRAINING_CONFIGURATION");
    const source = physicalSource(request.source), targetStage = request.targetStage ?? null;
    const requireReady = async (owner, detail = null) => {
      const read = await readQualification(owner, { characterID, role, configurations: configs, targetStage });
      const stage = read.report.stages.find(s => s.id === config.configurationID);
      if (stage?.fitting.status !== "READY" || (detail && !acceptedDefinition(config, detail))) fail("REVIEW_STALE");
      if (stage.skillQualification !== "READY") fail("SKILLS_NOT_READY", "Training hard skill requirements must be trained before Provision Equipment.");
      return read;
    };
    const fresh = await requireReady(account);
    const detail = await inspect(account, characterID, config, source);
    const input = { ...inputFor(characterID, config, source), consumer: CONSUMER,
      training: { role, configurations: configs, configurationID: config.configurationID, targetStage } };
    const applyReview = center.applyService.prepare(detail, input, { revalidate: requireReady });
    for(const [key,value] of acceptedReviews)if(value.expiresAt<now())acceptedReviews.delete(key);
    acceptedReviews.set(applyReview.reviewID,{accountID:account.accountID,characterID,config,source,expiresAt:applyReview.expiresAt});
    return { configurationID: config.configurationID, detail, applyReview,
      fresh: await enrich(account, fresh, configs, source) };
  }
  async function apply(account,request,callerSessionID=null) {
    const accepted=acceptedReviews.get(request.reviewID);
    const outcome=await center.applyService.apply(account,request,CONSUMER,callerSessionID);
    if(accepted?.accountID===account.accountID && ["COMPLETE","ALREADY_SATISFIED"].includes(outcome.state) &&
        outcome.release.state==="VERIFIED_OFFLINE" && outcome.finalReview?.status.equipment==="VERIFIED" &&
        Number.isFinite(outcome.finalObservedAt) && outcome.finalObservedAt<=now() && outcome.finalObservedAt+EVIDENCE_TTL>now()) {
      const r=outcome.finalReview;
      selectedEvidence.set(evidenceKey(account.accountID,accepted.characterID,accepted.config,accepted.source),{at:outcome.finalObservedAt,detail:{
        status:r.status,candidateSource:{...r.source.pin.descriptor,quality:"COMPLETE",query:"ALLOWED",take:r.source.access.take?"ALLOWED":"DENIED",
          contentsLocationID:r.source.pin.locationID,rows:r.source.rows},pilot:{quality:"COMPLETE",observation:{complete:true},revision:outcome.control.generation,
          shipID:r.context.shipID,locationID:r.context.locationID,hullName:null,control:{state:"offline",owner:"OFF",online:false}}}});
      acceptedReviews.delete(request.reviewID);
    }
    return outcome;
  }
  return { enrich, review, apply,
    recover: (account, request) => center.applyService.recover(account, request.operationID) };
}
module.exports = { createTrainingEquipment, physicalSource, acceptedDefinition, dutyReady, EVIDENCE_TTL };
