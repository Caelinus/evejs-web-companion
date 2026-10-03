"use strict";
const { hash, fail } = require("./provisioningContracts");
const rows = value => value.map(r => [r.itemID, r.typeID, r.ownerID, r.locationID, r.flagID, r.quantity, !!r.singleton])
  .sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function selectedObservation(value, data) {
  const slot = flag => [[11,34],[92,99],[125,132]].some(([lo,hi]) => flag >= lo && flag <= hi);
  // The world projection includes every direct hold and physical charge ID;
  // selected ListByFlags reads these flags and exposes loaded charges by tuple.
  return rows(value.filter(r => slot(r.flagID) || [5,87,158,133,143].includes(r.flagID)).map(r =>
    slot(r.flagID) && Number(data.getType(r.typeID)?.categoryID) === 8 ? { ...r, itemID: null, singleton: false } : r));
}
function intent(detail) {
  const p = detail.pilot, c = detail.selected, s = detail.candidateSource;
  if (!c || p.quality !== "COMPLETE" || !p.observation.complete || p.dockState !== "DOCKED" || s.quality !== "COMPLETE" || s.query !== "ALLOWED")
    fail("REVIEW_REQUIRED");
  return { accountID: p.accountID, characterID: p.characterID, corporationID: p.corporationID,
    locationID: p.locationID, shipID: p.shipID, shipTypeID: p.shipTypeID,
    definition: c.definition, definitionFingerprint: c.definitionFingerprint,
    equipmentFingerprint: c.equipmentFingerprint, supplyPolicyFingerprint: c.supplyPolicyFingerprint,
    observed: rows(p.observation.rows), source: { kind: s.kind, corporationID: s.corporationID, division: s.division,
      officeID: s.officeID, contentsLocationID: s.contentsLocationID, dockedLocationID: s.dockedLocationID, flag: s.flag,
      stock: rows(s.rows) }, suppliesPolicy: "NEW_HULL_ONLY" };
}
function assertSelected(pin, read, data = null) {
  const c = read.context, s = read.source;
  if (!read.observation.complete || !read.target.complete) fail("REVIEW_STALE");
  const observed = data ? selectedObservation(read.observation.rows, data) : rows(read.observation.rows);
  const accepted = data ? selectedObservation(pin.observed.map(([itemID,typeID,ownerID,locationID,flagID,quantity,singleton]) =>
    ({itemID,typeID,ownerID,locationID,flagID,quantity,singleton})), data) : pin.observed;
  if (c.recoveryReady === false ||
      ["accountID","characterID","corporationID","locationID","shipID","shipTypeID"].some(k => c[k] !== pin[k]) ||
      read.contract.definitionFingerprint !== pin.definitionFingerprint || read.contract.equipmentFingerprint !== pin.equipmentFingerprint ||
      read.contract.supplyPolicyFingerprint !== pin.supplyPolicyFingerprint || hash(observed) !== hash(accepted)) fail("REVIEW_STALE");
  const source = pin.source, descriptor = s.pin.descriptor;
  if (descriptor.kind !== source.kind || (source.kind === "corp" && (descriptor.corporationID !== source.corporationID || descriptor.division !== source.division || s.pin.office !== `corpOffice:${source.officeID}`)) ||
      s.pin.ownerID !== (source.kind === "corp" ? source.corporationID : pin.characterID) || s.pin.locationID !== source.contentsLocationID ||
      s.pin.flag !== source.flag || s.pin.dockedLocationID !== source.dockedLocationID || hash(rows(s.rows)) !== hash(source.stock)) fail("SOURCE_CHANGED");
  if (s.access.query !== true) fail("SOURCE_QUERY_DENIED");
  if (s.access.take !== true) fail(s.access.take === false ? "SOURCE_TAKE_DENIED" : "SOURCE_TAKE_UNKNOWN");
}

module.exports = { intent, assertSelected, rows };
