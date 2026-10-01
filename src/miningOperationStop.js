"use strict";

// Control-plane orchestration only. botHost retains every pilot's authority;
// the ordinary flow/runner performs settlement, travel and freight delivery.
function createMiningOperationStopper({ operations, botHost }) {
  const pending = new Map();
  function stop(definition, { cause = "manual" } = {}) {
    const id = definition.operationID;
    if (pending.has(id)) return pending.get(id);
    if (operations.runtimeFor(id)?.state === "STOPPED") return Promise.resolve([]);
    const initial = operations.runtimeFor(id);
    const wasDraft = initial?.state === "DRAFT";
    operations.beginStop(id);
    const task = (async () => {
      const parking = definition.policies?.parking ?? { mode: "STAY_IN_PLACE" };
      const deadline = cause === "deadline";
      const returning = deadline || parking.mode !== "STAY_IN_PLACE";
      const hosted = botHost.listAll().filter(bot => bot.operationID === id && bot.endedAt === null);
      const settled = [];
      const failures = [];
      const fail = (characterID, outcome) => {
        failures.push({ characterID, code: outcome.code, message: outcome.message || "Stop / Parking did not complete." });
        operations.memberParking(id, characterID, returning ? "PARKING_FAILED" : "STOP_BLOCKED", failures.at(-1).message);
      };
      if (!wasDraft) {
        for (const member of definition.members) {
          const previous = operations.runtimeFor(id)?.members.get(member.characterID);
          const knownNeverStarted = !initial?.recoveryAmbiguous && !previous?.botID &&
            (previous?.runtimeState === "FAILED" || previous?.runtimeState === "DRAFT");
          if (!hosted.some(bot => bot.characterID === member.characterID) &&
              !knownNeverStarted && previous?.parkingState !== "PARKED" && previous?.runtimeState !== "STOPPED") {
            fail(member.characterID, { code: returning ? "PARKING_MEMBER_UNAVAILABLE" : "STOP_MEMBER_UNAVAILABLE",
              message: "No active operation-owned pilot control exists; safe settlement cannot be confirmed." });
          }
        }
      }
      // Establish the settlement boundary before issuing any new route. Each
      // preparation has the existing bounded recall/tick-settlement contract;
      // a failed peer does not prevent successfully settled members parking.
      if (returning) await Promise.all(hosted.map(async bot => {
        try {
          operations.memberParking(id, bot.characterID, "SETTLING");
          const ready = await botHost.prepareOperationStop(bot.botID, bot.accountID, id);
          if (!ready.ok) { fail(bot.characterID, ready); return; }
          settled.push(bot);
        } catch (error) {
          fail(bot.characterID, { code: "PARKING_PREPARE_FAILED", message: error.message });
        }
      }));
      if (returning && failures.length === 0 && settled.length === hosted.length) operations.releaseStopTargets(id);
      await Promise.all((returning ? settled : hosted).map(async bot => {
        try {
          if (returning) {
            operations.memberParking(id, bot.characterID, "PARKING");
            const result = deadline && parking.mode === "STAY_IN_PLACE"
              ? await botHost.endOperationDeadline(bot.botID, bot.accountID, id)
              : await botHost.parkOperationMember(bot.botID, bot.accountID, id, parking, cause);
            if (!result.ok) { fail(bot.characterID, result); return; }
            operations.memberParking(id, bot.characterID, "PARKED");
          } else {
            const result = await botHost.stop(bot.botID, bot.accountID);
            if (!result.ok) fail(bot.characterID, result);
          }
        } catch (error) {
          fail(bot.characterID, { code: "PARKING_FAILED", message: error.message });
        }
      }));
      operations.finishStop(id, failures, returning);
      return failures;
    })();
    pending.set(id, task);
    void task.finally(() => { if (pending.get(id) === task) pending.delete(id); }).catch(() => {});
    return task;
  }
  return { stop };
}
module.exports = { createMiningOperationStopper };
