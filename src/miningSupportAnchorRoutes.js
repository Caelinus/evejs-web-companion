"use strict";

let models;
function loadModels() {
  return models ||= Promise.all([
    import("../web/src/bridge/boundFleet.ts"),
    import("../web/src/bridge/space.ts"),
    import("../web/src/nav/miningSupportAnchor.ts"),
  ]);
}
const positiveID = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const exactID = value => typeof value === "string" && /^[1-9]\d*$/.test(value) ? value
  : positiveID(value) === null ? null : String(value);

// Only own-fleet GetInitState and own-space reads. There is no fleet write,
// role/commander gate, runtime action, or client-supplied service projection.
function registerMiningSupportAnchorRoutes({ app, requireAuth, requireHeld, currentSession,
  readFleet, readSpace, board, sessionLost }) {
  const path = "/api/bots/mining-support-anchors";
  app.post(`${path}/release`, requireAuth, (req, res) => {
    const held = requireHeld(req, res);
    if (!held) return;
    if (currentSession(req.webSessionID) !== held) return res.status(409).json({ ok: false, error: "SESSION_CHANGED" });
    board.release(held);
    res.json({ ok: true });
  });
  const fail = (res, error, status = 409) => res.status(status).json({ ok: false, error });
  async function fleetFor(held, sessionID) {
    const [{ decodeFleetInitState }] = await loadModels();
    // Never use the old held.fleetID as evidence, including after failed reads.
    held.fleetID = null;
    const observedAtMs = board.now();
    const init = decodeFleetInitState(await readFleet(held, sessionID));
    const fleetID = exactID(init.fleetID);
    const members = init.members.map(row => ({ characterID: positiveID(Number(row.charID)), solarSystemID: positiveID(Number(row.solarSystemID)) }));
    if (!fleetID || members.some(row => row.characterID === null)
        || !members.some(row => row.characterID === held.characterID)) return null;
    held.fleetID = fleetID;
    return { fleetID, readerCharacterID: held.characterID, members, observedAtMs, expiresAtMs: observedAtMs + board.freshMs };
  }
  function stillHeld(held, sessionID, bridgeSessionID) { return currentSession(sessionID) === held && held.bridgeSessionID === bridgeSessionID; }
  app.get(path, requireAuth, async (req, res, next) => {
    const held = requireHeld(req, res);
    if (!held) return;
    const bridgeSessionID = held.bridgeSessionID;
    try {
      const fleet = await fleetFor(held, req.webSessionID);
      if (!stillHeld(held, req.webSessionID, bridgeSessionID)) return fail(res, "SESSION_CHANGED");
      if (!fleet || board.now() >= fleet.expiresAtMs) return res.json({ ok: true, availability: "unknown", reason: "FLEET_UNKNOWN", readAtMs: board.now(), fleet: null, anchors: [] });
      res.json({ ok: true, ...board.read(fleet, owner => [...currentSession().values()].includes(owner)) });
    } catch (error) {
      if (error?.code === "SESSION_NOT_FOUND") { sessionLost(req.webSessionID); next(error); }
      else res.json({ ok: true, availability: "unknown", reason: error?.code || "READ_FAILED", readAtMs: board.now(), fleet: null, anchors: [] });
    }
  });
  app.post(path, requireAuth, async (req, res, next) => {
    const held = requireHeld(req, res);
    if (!held) return;
    const bridgeSessionID = held.bridgeSessionID;
    const { observedShipID, observedAtMs: sampledAtMs, expectedCharacterID, expectedFleetID } = req.body || {};
    if ((expectedCharacterID !== undefined && positiveID(expectedCharacterID) === null)
        || (expectedFleetID !== undefined && exactID(expectedFleetID) === null)) return fail(res, "SUPPORT_AUTHORITY_UNKNOWN", 400);
    if (expectedCharacterID !== undefined && expectedCharacterID !== held.characterID) return fail(res, "SUPPORT_CHARACTER_CHANGED");
    if (positiveID(observedShipID) === null || typeof sampledAtMs !== "number" || !Number.isFinite(sampledAtMs) || sampledAtMs < 0) return fail(res, "SUPPORT_OBSERVATION_UNKNOWN", 400);
    try {
      const [, { decodeSpaceSnapshot }, { observedSupportAnchorServices }] = await loadModels();
      const before = await fleetFor(held, req.webSessionID);
      if (!stillHeld(held, req.webSessionID, bridgeSessionID)) return fail(res, "SESSION_CHANGED");
      if (!before) return fail(res, "FLEET_UNKNOWN");
      if (expectedFleetID !== undefined && before.fleetID !== exactID(expectedFleetID)) return fail(res, "SUPPORT_FLEET_CHANGED");
      const observedAtMs = board.now();
      const space = decodeSpaceSnapshot(await readSpace(held));
      if (!stillHeld(held, req.webSessionID, bridgeSessionID)) return fail(res, "SESSION_CHANGED");
      const fleet = await fleetFor(held, req.webSessionID);
      if (!stillHeld(held, req.webSessionID, bridgeSessionID)) return fail(res, "SESSION_CHANGED");
      if (!fleet || fleet.fleetID !== before.fleetID || board.now() >= before.expiresAtMs || board.now() >= observedAtMs + board.freshMs) return fail(res, "FLEET_UNKNOWN");
      if (expectedCharacterID !== undefined && held.characterID !== expectedCharacterID) return fail(res, "SUPPORT_CHARACTER_CHANGED");
      if (expectedFleetID !== undefined && fleet.fleetID !== exactID(expectedFleetID)) return fail(res, "SUPPORT_FLEET_CHANGED");
      if (!space.inSpace || space.ship?.characterID !== held.characterID || space.shipID !== observedShipID
        || space.ship.itemID !== observedShipID || held.activeShipID !== observedShipID) return fail(res, "SUPPORT_SHIP_CHANGED");
      const memberSystemID = fleet.members.find(row => row.characterID === held.characterID).solarSystemID;
      if (memberSystemID !== null && space.solarSystemID !== null && memberSystemID !== space.solarSystemID) return fail(res, "SUPPORT_SYSTEM_CHANGED");
      if (space.sampledAtMs === null || space.sampledAtMs < sampledAtMs) return fail(res, "SUPPORT_OBSERVATION_UNKNOWN");
      const anchor = board.publish(held, { fleetID: fleet.fleetID, shipID: space.shipID,
        solarSystemID: space.solarSystemID, sampledAtMs: space.sampledAtMs, observedAtMs,
        services: observedSupportAnchorServices(space) });
      if (!anchor) return fail(res, "SUPPORT_OBSERVATION_SUPERSEDED");
      res.json({ ok: true, anchor });
    } catch (error) {
      if (error?.code === "SESSION_NOT_FOUND") sessionLost(req.webSessionID);
      if (error?.code === "CALL_REFUSED") return fail(res, "FLEET_UNKNOWN");
      next(error);
    }
  });
}

module.exports = { registerMiningSupportAnchorRoutes };
