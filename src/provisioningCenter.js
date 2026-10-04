"use strict";
const { offlineProvisioning } = require("./stockCompatibility");
// Retain existing invocation evidence and recovery reservations. Its offline
// acquisition authority has been retired; no new invocation may select a pilot.
function registerProvisioningCenter(d) {
  const { app, requireAuth } = d;
  const legacy = require("./provisioningCenterApply").createProvisioningCenterApply({ ...d, readReview: offlineProvisioning });
  const applyService = { pending: legacy.pending, status: legacy.status,
    prepare: offlineProvisioning, apply: async () => offlineProvisioning(), recover: legacy.recover };
  app.locals.provisioningCenterApply = applyService;
  const unsupported = (_req, _res, next) => { try { offlineProvisioning(); } catch (error) { next(error); } };
  for (const action of ["roster", "review"]) app.get(`/api/ship-provisioning/${action}`, requireAuth, unsupported);
  app.post("/api/ship-provisioning/apply", requireAuth, unsupported);
  app.post("/api/ship-provisioning/recover", requireAuth, async (req,res,next) => {
    try { res.json({ok:true,outcome:await legacy.recover(req.account,req.body?.operationID)}); } catch(error) { next(error); }
  });
  app.get("/api/ship-provisioning/operation", requireAuth, (req, res, next) => {
    try { res.json({ ok: true, outcome: legacy.status(req.account, req.query.operationID) }); } catch (error) { next(error); }
  });
  return { roster: async () => offlineProvisioning(), readReview: async () => offlineProvisioning(), applyService };
}
module.exports = { registerProvisioningCenter };
