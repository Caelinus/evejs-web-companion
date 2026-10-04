"use strict";
const { hash, fail, inspectContract } = require("./provisioningContracts");
const { readProvisioningDefinitions } = require("./provisioningRoutes");
// Account-scoped intent only. Physical facts belong to the bounded selected
// owner created by explicit Apply, never to opening or refreshing this page.
function registerProvisioningCenter(d) {
  const { app, requireAuth, store, gateway, data, heldSessions, operations, botHost, engine } = d;
  const service = require("./provisioningCenterApply").createProvisioningCenterApply(d);
  app.locals.provisioningCenterApply = service;
  const characters = async accountID => {
    const rows = await store.listCharactersForAccount(accountID);
    if (!Array.isArray(rows) || rows.some(p => p.accountID !== accountID)) fail("PILOT_AUTHORITY_CHANGED");
    return rows;
  };
  async function pilot(accountID, characterID, rows) {
    const p = rows.find(p => p.characterID === characterID);
    if (!p) fail("CHARACTER_NOT_FOUND");
    let control = { state: "UNKNOWN", owner: "UNKNOWN", online: null };
    try {
      const status = await gateway.getCharacterStatus(accountID, characterID);
      if (status?.characterID === characterID && typeof status.online === "boolean")
        control = { state: status.controlState, online: status.online,
          owner: operations.has(characterID) || engine.unresolved(characterID).length ? "RECOVERY_OR_OPERATION" :
            botHost.claimedBy(characterID) !== null ? "BOT" : [...heldSessions.values()].some(h => h.characterID === characterID) ? "BROWSER" :
              status.online === false && status.controlState === "offline" ? "OFF" : "OTHER_SESSION" };
    } catch { /* Unknown is not free. Apply checks again under its reservation. */ }
    return { accountID, characterID, name: p.characterName, corporationID: p.corporationID || null,
      locationID: null, stationID: null, dockState: "UNKNOWN", shipID: null, shipTypeID: null, shipName: null, hullName: null,
      quality: "PENDING_SELECTED", reasons: ["Physical equipment and inventory require selected maintenance authority."],
      observation: { complete: false, rows: null }, control,
      status: { equipment: "UNKNOWN", supplies: "UNKNOWN", targets: [] }, matches: { state: "UNKNOWN", alternatives: [] } };
  }
  const evidence = value => ({ boundary: "ACCOUNT_PREFLIGHT_ONLY", digest: hash(value), startedAt: Date.now(), completedAt: Date.now(),
    stable: false, unsupported: ["Selected equipment, location, source stock and Take permission remain pending until Apply."] });
  async function roster(accountID) {
    const rows = await characters(accountID), pilots = [];
    for (const p of rows) pilots.push(await pilot(accountID, p.characterID, rows));
    return { quality: "ACCOUNT_PREFLIGHT", completeRoster: true, reasons: ["Equipment UNKNOWN until selected maintenance Review."],
      pilots, providers: rows.map(p => ({ characterID: p.characterID, name: p.characterName, corporationID: p.corporationID || null })), evidence: evidence(pilots) };
  }
  async function readReview(accountID, input) {
    const rows = await characters(accountID), p = await pilot(accountID, input.characterID, rows);
    const definitions = await readProvisioningDefinitions({ store, gateway, data, accountID, providerCharacterID: input.providerCharacterID });
    const selected = definitions.contracts.find(c => c.definition.fittingID === input.fittingID) || null;
    if (input.fittingID && !selected) fail("INVALID_FIT");
    const source = input.source || (input.sourceKind === "corp" ? { kind: "corp", corporationID: p.corporationID, division: input.division } : { kind: "hangar" });
    if (!source || !["hangar", "corp"].includes(source.kind) || source.kind === "corp" &&
        (source.corporationID !== p.corporationID || !Number.isInteger(source.division) || source.division < 1 || source.division > 7)) fail("SOURCE_UNSUPPORTED");
    const status = selected ? inspectContract(selected, p.observation, data) : p.status;
    const detail = { pilot: { ...p, status }, selected, status, matches: p.matches, definitions, equipment: [],
      requirements: selected?.equipment.map(([flagID,typeID,quantity]) => ({ flagID,typeID,quantity,name:data.getTypeName(typeID),kind:"EQUIPMENT" })) || [],
      candidateSource: { ...source, quality: "PENDING_SELECTED", query: "UNKNOWN", take: "UNKNOWN", rows: [], corporationID: source.corporationID || null,
        division: source.division || null, officeID: null, contentsLocationID: null, flag: source.kind === "hangar" ? 4 : 0,
        reasons: ["Authoritative source and permission checks run after selection."], revalidateOnApply: true },
      evidence: evidence(input), pendingApply: service.pending(input.characterID) };
    detail.applyReview = service.prepare(detail, { characterID: input.characterID, providerCharacterID: input.providerCharacterID,
      corporationID: definitions.corporationID, fittingID: input.fittingID, source });
    return detail;
  }
  app.get("/api/ship-provisioning/roster", requireAuth, async (req,res,next) => {
    try { res.json({ ok:true, ...await roster(req.account.accountID) }); } catch (error) { next(error); }
  });
  app.get("/api/ship-provisioning/review", requireAuth, async (req,res,next) => {
    try { res.json({ ok:true, ...await readReview(req.account.accountID, { ...req.query, characterID:Number(req.query.characterID),
      providerCharacterID:Number(req.query.providerCharacterID), fittingID:Number(req.query.fittingID) || 0, division:Number(req.query.division) }) }); } catch (error) { next(error); }
  });
  for (const action of ["apply", "recover"]) app.post(`/api/ship-provisioning/${action}`, requireAuth, async (req,res,next) => {
    try { res.json({ ok:true, outcome:await (action === "apply" ? service.apply(req.account, req.body, "CENTER", req.webSessionID) :
      service.recover(req.account, req.body?.operationID)) }); } catch (error) { next(error); }
  });
  app.get("/api/ship-provisioning/operation", requireAuth, (req, res, next) => {
    try { res.json({ ok: true, outcome: service.status(req.account, req.query.operationID) }); } catch (error) { next(error); }
  });
  return { roster, readReview, applyService:service };
}
module.exports = { registerProvisioningCenter };
