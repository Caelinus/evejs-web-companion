"use strict";

// The caller requests an emergency; only a new own-scene read can authorize it.
// Health and service receipts supplied by the runner are never proof here.
function createMiningSupportStopHandler({ requireClaim, assignment, readSpace, stop, now = Date.now }) {
  return async (req, res, next) => {
    try {
      const claim = requireClaim(req, res);
      if (!claim) return;
      const operationID = claim.association.operationID;
      const initial = assignment(operationID, claim.held.characterID);
      if (req.body?.reason === "emergency-health-floor") {
        if (initial?.role !== "COMMAND" || initial.support?.characterID !== claim.held.characterID)
          return res.status(409).json({ ok: false, error: "SUPPORT_EMERGENCY_NOT_APPLICABLE" });
        const held = claim.held;
        const identity = [held.bridgeSessionID, held.accountID, held.characterID, held.activeShipID, held.solarSystemID];
        const { decodeSpaceSnapshot } = await import("../web/src/bridge/space.ts");
        const startedAtMs = now();
        const raw = await readSpace(held);
        const current = requireClaim(req, res);
        if (!current) return;
        const selected = assignment(operationID, held.characterID);
        if (current.held !== held || current.association.operationID !== operationID ||
            identity.some((value, i) => value !== [held.bridgeSessionID, held.accountID, held.characterID, held.activeShipID, held.solarSystemID][i]) ||
            selected?.role !== "COMMAND" || selected.support?.characterID !== held.characterID)
          return res.status(409).json({ ok: false, error: "OPERATION_CLAIM_CHANGED" });
        const space = decodeSpaceSnapshot(raw);
        // Missing/invalid health stays null; a genuine zero remains known.
        const health = [space.ship?.shieldRatio, space.ship?.armorRatio, space.ship?.hullRatio]
          .filter(value => typeof value === "number" && Number.isFinite(value));
        const at = now();
        // This is a newly requested own-scene read. Bound its wall duration;
        // the scene's simulation sample is an identity, not a wall receipt.
        if (!space.inSpace || !space.ship || space.ship.characterID !== held.characterID ||
            !Number.isSafeInteger(held.activeShipID) || held.activeShipID <= 0 ||
            space.shipID !== held.activeShipID || space.ship.itemID !== held.activeShipID ||
            !Number.isSafeInteger(held.solarSystemID) || held.solarSystemID <= 0 || space.solarSystemID !== held.solarSystemID ||
            space.sampledAtMs === null || space.sampledAtMs < 0 ||
            !Number.isFinite(startedAtMs) || !Number.isFinite(at) || at < startedAtMs || at - startedAtMs >= 10000 ||
            health.length === 0 || Math.min(...health) >= 0.25)
          return res.status(409).json({ ok: false, error: "SUPPORT_EMERGENCY_UNCONFIRMED" });
      } else if (initial?.supportPolicy?.mode !== "STOP") {
        return res.status(409).json({ ok: false, error: "SUPPORT_STOP_POLICY_NOT_APPLICABLE" });
      }
      // Existing Stop owns deduplication, settlement and configured Parking.
      // Never await that cleanup from the runner being stopped.
      stop(operationID);
      res.status(202).json({ ok: true });
    } catch (error) { next(error); }
  };
}
module.exports = { createMiningSupportStopHandler };
