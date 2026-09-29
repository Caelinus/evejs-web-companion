"use strict";

async function extendMiningOperation({ operations, botHost, operationID, controllerAccountID, minutes }) {
  const def = operations.definition(operationID);
  const runtime = operations.runtimeFor(operationID);
  if (!def || !runtime || ["DRAFT", "ASSEMBLING", "STOPPING", "STOPPED", "PARKING", "PARKING_FAILED"].includes(runtime.state)) {
    return { ok: false, code: "OPERATION_GRANT_NOT_ACTIVE", message: "Only an active operation can be extended; Stop/Parking cannot be reversed." };
  }
  const hosted = botHost.listAll();
  const results = [];
  for (const member of def.members) {
    if (["STOPPING", "STOPPED", "PARKING", "PARKING_FAILED"].includes(operations.runtimeFor(operationID)?.state)) {
      results.push({ characterID: member.characterID, ok: false, error: "OPERATION_STOPPING", message: "Stop/Parking began; extension refused." });
      continue;
    }
    const bot = hosted.find(row => row.operationID === operationID && row.characterID === member.characterID && !row.endedAt);
    const result = bot ? await botHost.extendOperationGrant(bot.botID, operationID, controllerAccountID, minutes)
      : { ok: false, code: "MEMBER_NOT_HOSTED", message: "No active operation-owned runner; this member was not started or resumed." };
    results.push({ characterID: member.characterID, ok: result.ok, error: result.code, message: result.message, expiresAt: result.bot?.expiresAt });
  }
  return { ok: results.every(row => row.ok), results };
}
module.exports = { extendMiningOperation };
