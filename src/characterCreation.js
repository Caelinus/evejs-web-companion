"use strict";
const { trainingError } = require("./pilotTrainingRead");
const nameKey = (name) => String(name).trim().replace(/\s+/g, " ").toLowerCase();
function field(row, key) {
  if (row?.name !== "util.KeyVal" || row.args?.type !== "dict" || !Array.isArray(row.args.entries)) return undefined;
  return row.args.entries.find((pair) => Array.isArray(pair) && pair[0] === key)?.[1];
}
function decodeCreationRoster(raw, account) {
  const user = raw?.[0]?.items?.[0];
  const slots = field(user, "characterSlots");
  const rows = raw?.[2]?.type === "list" ? raw[2].items : null;
  if (!Number.isSafeInteger(slots) || slots < 1 || !Array.isArray(rows) ||
      nameKey(field(user, "userName")) !== nameKey(account.username)) throw trainingError("CREATION_STATE_UNKNOWN", "Account roster and slot authority are unreadable.");
  const characters = rows.map((row) => ({ characterID: field(row, "characterID"), name: field(row, "characterName") }));
  if (characters.some((row) => !Number.isSafeInteger(row.characterID) || row.characterID <= 0 || typeof row.name !== "string") ||
      new Set(characters.map((row) => row.characterID)).size !== characters.length) throw trainingError("CREATION_STATE_UNKNOWN");
  return { slots, characters, freeSlots: Math.max(0, slots - characters.length) };
}

/** One WC account lane. Unknown completion remains latched; never replay a create. */
function createCharacterCreation({ call, attempts = null }) {
  const lanes = new Map();
  const attemptKey = (accountID) => `character:${accountID}`;
  async function read(req) {
    const raw = await call(req, "charUnboundMgr", "GetCharacterSelectionData", []);
    return decodeCreationRoster(raw.result, req.account);
  }
  async function state(req) {
    const roster = await read(req);
    const pending = lanes.get(req.account.accountID) || attempts?.get(attemptKey(req.account.accountID));
    const recovered = pending && roster.characters.find((row) => nameKey(row.name) === nameKey(pending.name));
    if (recovered && !pending.busy) {
      attempts?.clear(attemptKey(req.account.accountID));
      lanes.delete(req.account.accountID);
    }
    return { ...roster, pendingName: recovered ? null : pending?.name || null, recoveredCharacterID: recovered?.characterID || null };
  }
  async function create(req, name, dispatch) {
    const id = req.account.accountID;
    const prior = lanes.get(id) || attempts?.get(attemptKey(id));
    if (prior?.busy) throw trainingError("CREATION_PENDING", "A creation is already in progress for this account.");
    const lane = { name: prior?.name || name, busy: true };
    lanes.set(id, lane);
    let dispatched = false;
    try {
      const before = await read(req);
      const found = before.characters.find((row) => nameKey(row.name) === nameKey(lane.name));
      if (prior && !found) throw trainingError("CREATION_UNVERIFIED", "Previous creation is unresolved. Inspect the account; do not retry.");
      if (prior && nameKey(name) !== nameKey(lane.name)) throw trainingError("CREATION_REVIEW_REQUIRED", "Previous character was created; refresh the roster before another action.");
      const existing = before.characters.find((row) => nameKey(row.name) === nameKey(name));
      if (existing) {
        attempts?.clear(attemptKey(id));
        lanes.delete(id);
        return { result: existing.characterID, recovered: true, notifications: [] };
      }
      if (!before.freeSlots) throw trainingError("NO_CHARACTER_SLOT", "This account has no free character slot.");
      const validation = await call(req, "charUnboundMgr", "ValidateNameEx", [name]);
      if (validation.result !== 1) throw trainingError("CharNameInvalid", "The server refused this character name.");
      // Even a rejected/timeout response may follow partial runtime creation.
      // Persist the account/name fence before the dispatch; after restart a
      // still-absent roster is a recovery problem, never retry authority.
      if (attempts && !attempts.mark(attemptKey(id), { name }))
        throw trainingError("CREATION_UNVERIFIED", "Previous creation is unresolved. Inspect the account; do not retry.");
      dispatched = true;
      let outcome = null;
      try { outcome = await dispatch(); } catch { /* authoritative recovery below, never resend */ }
      const after = await read(req);
      const created = after.characters.filter((row) => nameKey(row.name) === nameKey(name));
      if (created.length !== 1 || (outcome?.result > 0 && outcome.result !== created[0].characterID))
        throw trainingError("CREATION_UNVERIFIED", "Creation could not be confirmed. No retry was made; inspect the account roster.");
      attempts?.clear(attemptKey(id));
      lanes.delete(id);
      return { ...outcome, result: created[0].characterID, recovered: !outcome, notifications: outcome?.notifications || [] };
    } catch (error) {
      if (!dispatched && !prior) lanes.delete(id);
      if (dispatched && error.code !== "CREATION_UNVERIFIED") throw trainingError("CREATION_UNVERIFIED", "Creation response/roster is unreadable. No retry was made.");
      throw error;
    } finally { lane.busy = false; }
  }
  return { state, create };
}
module.exports = { decodeCreationRoster, createCharacterCreation };
