"use strict";
const { createOperationJournal } = require("./operationJournal");
const { hash, fail } = require("./provisioningContracts");
const { offlineProvisioning } = require("./stockCompatibility");
const terminal = new Set(["COMPLETE", "ALREADY_SATISFIED", "REFUSED"]);
const states = new Set([...terminal, "PREPARED", "ACQUIRING_CONTROL", "REVALIDATING", "PROVISIONING", "VERIFYING", "RELEASING", "BLOCKED"]);
const positive = n => Number.isSafeInteger(n) && n > 0;
// Preserve historical invocation evidence and exact recovery reservations.
// Stock status can prove release; it cannot authorize another offline Apply.
function createProvisioningCenterApply({ gateway, engine, operations, sessions, filePath = null, now = Date.now }) {
  const journal = createOperationJournal({ filePath });
  for (const r of journal.list()) {
    if (r.kind !== "CENTER_APPLY" || !positive(r.accountID) || !positive(r.characterID) || !states.has(r.state) ||
        !r.pin || r.pin.accountID !== r.accountID || r.pin.characterID !== r.characterID || hash(r.pin) !== r.reviewHash ||
        !r.input || r.release?.state === undefined || Object.hasOwn(r, "bridgeSessionID")) fail("CENTER_CONTROL_JOURNAL_INVALID");
    if (!terminal.has(r.state) && r.release.state !== "VERIFIED_OFFLINE" && !operations.has(r.characterID))
      operations.set(r.characterID, { kind: "temporary-provisioning-recovery", id: r.key });
  }
  const pending = pilot => journal.list().filter(r => r.characterID === pilot && !terminal.has(r.state)).map(r => ({...r,active:false}));
  const publicResult = r => ({ operationID:r.key,state:r.state,reason:r.reason||null,control:r.control||null,
    revalidation:r.revalidation||null,provisioning:r.provisioning||null,release:r.release,finalReview:r.finalReview||null });
  const owned = (account,key) => {const r=journal.get(key);if(!r||r.accountID!==account.accountID)fail("OPERATION_NOT_OWNED");return {...r,key};};
  const save = row => { const {key,...record}=row;journal.put(key,{...record,updatedAt:now()}); };
  async function recover(account, operationID) {
    const row=owned(account,operationID);
    if(terminal.has(row.state))return publicResult(row);
    const s=await gateway.getCharacterStatus(account.accountID,row.characterID);
    if(s?.characterID!==row.characterID||s.online!==false||s.controlState!=="offline") {
      row.state="BLOCKED";row.reason="CONTROL_RELEASE_UNPROVEN";save(row);return publicResult(row);
    }
    row.release={...row.release,state:"VERIFIED_OFFLINE",checkedAt:now(),evidence:"AUTHORITATIVE_CHARACTER_STATUS"};
    const active=operations.get(row.characterID);
    if(["temporary-provisioning","temporary-provisioning-recovery"].includes(active?.kind)&&active.id===operationID)operations.delete(row.characterID);
    await sessions?.status(account,row.characterID);
    if(engine.unresolved(row.characterID).length){row.state="BLOCKED";row.reason="PROVISIONING_RECOVERY_REQUIRED";}
    else {row.state=row.completion||"REFUSED";row.reason=row.completion?null:"INTERRUPTED_REVIEW_REQUIRED";}
    save(row);return publicResult(row);
  }
  return { pending, status:(account,key)=>publicResult(owned(account,key)), recover, journal,
    prepare:offlineProvisioning,apply:async()=>offlineProvisioning() };
}
module.exports={createProvisioningCenterApply};
