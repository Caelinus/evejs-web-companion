"use strict";

const { row } = require("./trainingOnboarding");
const { trainingError } = require("./pilotTrainingRead");

// Picker data only. Every mutation still repeats its existing authority checks.
// No browser corporation/character IDs, selection or live sessions are accepted.
async function readTrainingSettingsContext({ account, store, gateway }) {
  const characters = await store.listCharactersForAccount(account.accountID);
  const corporations = new Map(), authorities = [];
  for (const character of characters) {
    if (character.accountID !== account.accountID) throw trainingError("CHARACTER_NOT_FOUND");
    const corporationID = character.corporationID;
    if (!Number.isSafeInteger(corporationID) || corporationID <= 0) continue;
    const call = async (method, args = []) => row((await gateway.callMethod("corpRegistry", method, args, null,
      { userid: account.accountID, characterID: character.characterID, corpid: corporationID, corporationID })).result);
    let corporation = corporations.get(corporationID);
    if (!corporation) {
      const value = await call("GetCorporation");
      if (Number(value.corporationID) !== corporationID || typeof value.corporationName !== "string" || !value.corporationName.trim() ||
          !Number.isSafeInteger(Number(value.ceoID)) || Number(value.ceoID) <= 0) throw trainingError("CORPORATION_STATE_UNKNOWN");
      corporation = { corporationID, name: value.corporationName, ceoID: Number(value.ceoID), divisions: [] };
      for (let i = 1; i <= 7; i++) {
        const name = value[`walletDivision${i}`];
        if (typeof name === "string" && name.trim()) corporation.divisions.push({ accountKey: 999 + i, name });
      }
      corporations.set(corporationID, corporation);
    }
    let eligible = false;
    try {
      const member = await call("GetMember", [character.characterID]);
      eligible = Number(member.characterID) === character.characterID && Number(member.corporationID) === corporationID &&
        /^\d+$/.test(String(member.roles)) && (BigInt(member.roles) & 1n) !== 0n && character.characterID !== corporation.ceoID;
    } catch { /* An unreadable role never qualifies as an authority. */ }
    authorities.push({ characterID: character.characterID, name: character.characterName, corporationID, eligible });
  }
  const fresh = await store.listCharactersForAccount(account.accountID);
  if (characters.some((c) => !fresh.some((f) => f.accountID === account.accountID && f.characterID === c.characterID && f.corporationID === c.corporationID)))
    throw trainingError("CORPORATION_CHANGED", "Corporation membership changed. Refresh settings.");
  return { corporations: [...corporations.values()].map(({ ceoID, ...c }) => c), authorities };
}

module.exports = { readTrainingSettingsContext };
