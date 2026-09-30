"use strict";
const { trainingError } = require("./pilotTrainingRead");

// Dedicated normal gateway sessions. Never borrow a cockpit handle or claim a
// bot. The runtime performs the final free-only check adjacent to selection.
function createFactorySessions({ store, gateway, operations, heldSessions, botHost }) {
  const owned = new Map();
  async function status(account, characterID) {
    const chars = await store.listCharactersForAccount(account.accountID);
    if (!chars.some((row) => row.characterID === characterID)) throw trainingError("CHARACTER_NOT_FOUND", "Account does not own pilot.", 404);
    const state = await gateway.getCharacterStatus(account.accountID, characterID);
    if (state?.characterID !== characterID || typeof state.online !== "boolean") throw trainingError("CHARACTER_CONTROL_UNAVAILABLE");
    const own = owned.get(characterID);
    if (own && state.online === false && state.controlState === "offline" && own.failed) {
      owned.delete(characterID);
      if (operations.get(characterID) === own.reservation) operations.delete(characterID);
    }
    const current = owned.get(characterID);
    const held = [...heldSessions.values()].find((row) => row.characterID === characterID);
    const owner = current ? current.failed ? "RECOVERY" : "FACTORY" : botHost.claimedBy(characterID) !== null ? "BOT" :
      held ? "BROWSER" :
      state.controlState === "offline" && state.online === false ? "OFF" : "OTHER_SESSION";
    return { characterID, owner, online: state.online };
  }
  async function withSessions(refs, action) {
    const leases = [];
    let value, failure;
    try {
      for (const ref of refs) {
        if (!Number.isSafeInteger(ref.characterID) || refs.filter((r) => r.characterID === ref.characterID).length !== 1) throw trainingError("INVALID_FACTORY_PILOT");
        const state = await status(ref.account, ref.characterID);
        if (state.owner !== "OFF" || operations.has(ref.characterID)) throw trainingError(
          state.owner === "BOT" ? "PILOT_HELD_BY_BOT" : state.owner === "RECOVERY" ? "RECOVERY_REQUIRED" : "PILOT_BUSY",
          `Pilot ${ref.characterID} is ${state.owner}; release its existing owner first.`);
        const reservation = Symbol("factory");
        const lease = { ...ref, reservation, bridgeSessionID: null, failed: false, attempted: false };
        operations.set(ref.characterID, reservation); owned.set(ref.characterID, lease); leases.push(lease);
      }
      for (const lease of leases) {
        lease.attempted = true;
        const selected = await gateway.selectFactoryCharacter(lease.account.accountID, lease.characterID);
        lease.bridgeSessionID = selected.bridgeSessionID;
        if (!lease.bridgeSessionID || selected.session?.characterID !== lease.characterID) throw trainingError("FACTORY_SESSION_MISMATCH");
      }
      value = await action(leases.map((lease) => ({ userid: lease.account.accountID, characterID: lease.characterID, bridgeSessionID: lease.bridgeSessionID })));
    } catch (error) { failure = error; }
    const cleanup = [];
    for (const lease of [...leases].reverse()) {
      let released = !lease.attempted;
      try {
        if (lease.bridgeSessionID) {
          const result = await gateway.releaseBridgeSession(lease.bridgeSessionID, { userid: lease.account.accountID });
          if (result?.released !== true || result.offline !== true) throw trainingError("FACTORY_SESSION_RELEASE_FAILED");
          released = true;
        } else if (lease.attempted) {
          const state = await gateway.getCharacterStatus(lease.account.accountID, lease.characterID);
          released = state?.characterID === lease.characterID && state.online === false && state.controlState === "offline";
        }
      } catch (error) {
        if (error.code === "SESSION_NOT_FOUND") {
          try {
            const state = await gateway.getCharacterStatus(lease.account.accountID, lease.characterID);
            released = state?.characterID === lease.characterID && state.online === false && state.controlState === "offline";
          } catch { released = false; }
        }
      }
      if (released) {
        owned.delete(lease.characterID);
        if (operations.get(lease.characterID) === lease.reservation) operations.delete(lease.characterID);
      } else { lease.failed = true; }
      cleanup.push({ characterID: lease.characterID, released, code: released ? null : "FACTORY_SESSION_RELEASE_FAILED" });
    }
    if (failure) { failure.cleanup = cleanup; throw failure; }
    return { value, cleanup };
  }
  return { withSessions, status };
}
module.exports = { createFactorySessions };
