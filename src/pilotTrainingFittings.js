"use strict";

const crypto = require("node:crypto");

const SLOT_RANGES = [[11, 34], [92, 99], [125, 132], [164, 171]];
const BAY_FLAGS = new Set([5, 87, 158]);

function positive(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function fail(message) {
  const error = new Error(message);
  error.code = "INVALID_FIT";
  throw error;
}

function entries(value) {
  if (!value || value.type !== "dict" || !Array.isArray(value.entries)) fail("Fitting dictionary is unreadable.");
  return value.entries;
}

function field(row, key) {
  if (!row || row.type !== "object" || !row.args) fail("Fitting row is unreadable.");
  const match = entries(row.args).find((entry) => Array.isArray(entry) && entry[0] === key);
  return match && match[1];
}

function filetime(value) {
  const raw = value && value.type === "long" ? value.value : value;
  return typeof raw === "string" && /^\d+$/.test(raw) && BigInt(raw) > 0n ? raw : null;
}

function fittingFingerprint(shipTypeID, items) {
  const canonical = items.map(({ typeID, flagID, quantity }) => [typeID, flagID, quantity])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return crypto.createHash("sha256").update(JSON.stringify([shipTypeID, canonical])).digest("hex");
}

function strictFitting(key, row, expectedOwnerID, data) {
  const fittingID = Number(field(row, "fittingID"));
  const ownerID = Number(field(row, "ownerID"));
  const shipTypeID = Number(field(row, "shipTypeID"));
  const name = field(row, "name");
  const savedDate = filetime(field(row, "savedDate"));
  const fitData = field(row, "fitData");
  if (!positive(fittingID) || Number(key) !== fittingID || ownerID !== expectedOwnerID ||
      !positive(shipTypeID) || !data.getType(shipTypeID) || typeof name !== "string" ||
      !savedDate || !fitData || fitData.type !== "list" || !Array.isArray(fitData.items) || !fitData.items.length) {
    fail("Fitting identity, hull, date, or item list is invalid.");
  }
  const items = fitData.items.map((entry) => {
    const tuple = entry && entry.type === "tuple" ? entry.items : null;
    if (!Array.isArray(tuple) || tuple.length !== 3) fail("Malformed fitting item tuple.");
    const [typeID, flagID, quantity] = tuple;
    if (!positive(typeID) || !data.getType(typeID) || !positive(flagID) || !positive(quantity) ||
        !(BAY_FLAGS.has(flagID) || SLOT_RANGES.some(([lo, hi]) => flagID >= lo && flagID <= hi))) {
      fail("Fitting item has an invalid type, flag, or quantity.");
    }
    return { typeID, flagID, quantity };
  });
  return { fittingID, ownerID, shipTypeID, name, savedDate, items,
    fingerprint: fittingFingerprint(shipTypeID, items) };
}

function decodeCorpFittingsStrict(result, expectedOwnerID, data) {
  if (!positive(expectedOwnerID)) fail("Corporation identity is unavailable.");
  let payload = result;
  if (payload && payload.type === "object" &&
      String(payload.name?.value || payload.name || "").endsWith("objectCaching.CachedMethodCallResult")) {
    const carrier = Array.isArray(payload.args) ? payload.args[1] : null;
    if (!carrier || carrier.type !== "substream") fail("Corporation fitting cache payload is unreadable.");
    payload = carrier.value;
  }
  const fittings = [];
  for (const entry of entries(payload)) {
    if (!Array.isArray(entry) || entry.length !== 2 || !positive(Number(entry[0]))) fail("Malformed fitting dictionary entry.");
    if (Number(field(entry[1], "ownerID")) !== expectedOwnerID) fail("Fitting owner differs from the selected corporation.");
    try {
      fittings.push(strictFitting(entry[0], entry[1], expectedOwnerID, data));
    } catch (error) {
      fittings.push({ fittingID: Number(entry[0]), invalid: true, reason: error.message });
    }
  }
  if (new Set(fittings.map((fitting) => fitting.fittingID)).size !== fittings.length) fail("Duplicate fitting IDs.");
  return fittings;
}

function resolveStageFittings(stages, fittings, selections, corporationID) {
  return Object.fromEntries(stages.map((stage) => {
    const selection = selections && selections[stage.id];
    if (!selection) return [stage.id, { status: "UNCONFIGURED" }];
    if (selection.scope !== "CORPORATION" || selection.ownerID !== corporationID || !positive(selection.fittingID)) {
      return [stage.id, { status: "INVALID_FIT", reason: "Fitting selection does not match this corporation." }];
    }
    const fit = fittings.find((item) => item.fittingID === selection.fittingID);
    if (!fit) return [stage.id, { status: "UNKNOWN", reason: "Saved fitting was not found." }];
    if (fit.invalid) return [stage.id, { status: "INVALID_FIT", reason: fit.reason, fittingID: fit.fittingID }];
    if (fit.shipTypeID !== stage.expectedHullTypeID) {
      return [stage.id, { status: "INVALID_FIT", reason: "Saved fitting hull differs from stage hull.", fittingID: fit.fittingID }];
    }
    if (selection.acceptedFingerprint !== fit.fingerprint || selection.acceptedSavedDate !== fit.savedDate) {
      return [stage.id, { status: "REVIEW_REQUIRED", reason: "Saved fitting changed since acceptance.",
        fittingID: fit.fittingID, name: fit.name, acceptedFingerprint: selection.acceptedFingerprint || null,
        acceptedSavedDate: selection.acceptedSavedDate || null, currentFingerprint: fit.fingerprint,
        currentSavedDate: fit.savedDate }];
    }
    return [stage.id, { status: "READY", fittingID: fit.fittingID, name: fit.name,
      savedDate: fit.savedDate, fingerprint: fit.fingerprint,
      // Cargo belongs in the accepted fitting fingerprint, but cargo/charges
      // are not fitted equipment and cannot impose hard qualification skills.
      typeIDs: [fit.shipTypeID, ...fit.items.filter((item) => item.flagID !== 5).map((item) => item.typeID)] }];
  }));
}

async function readAccountCorpFittings({ store, gateway, accountID, characterID, data }) {
  // The account-filtered gateway roster carries identity and corporation. Avoid
  // getCharacterForAccount here: that older seam also reads a broad /snapshot.
  const ownedCharacter = async () => (await store.listCharactersForAccount(accountID))
    .find((entry) => entry.characterID === characterID && entry.accountID === accountID) || null;
  const character = await ownedCharacter();
  if (!character) return { status: "NOT_OWNED" };
  const corporationID = character.corporationID;
  if (!positive(corporationID)) return { status: "CORP_UNAVAILABLE", character };
  let result;
  try {
    // No bridgeSessionID: the gateway materializes a per-call service session.
    // The selected pilot is never logged in or claimed.
    result = await gateway.callMethod("corpFittingMgr", "GetFittings", [], null,
      { userid: accountID, characterID, corpid: corporationID, corporationID });
  } catch (error) {
    return { status: "CORP_UNAVAILABLE", character, corporationID };
  }
  const current = await ownedCharacter();
  if (!current || current.corporationID !== corporationID) {
    return { status: "CORP_UNAVAILABLE", character, corporationID };
  }
  try {
    return { status: "READY", character: current, corporationID,
      fittings: decodeCorpFittingsStrict(result.result, corporationID, data) };
  } catch (error) {
    return { status: "CORP_UNAVAILABLE", character: current, corporationID };
  }
}

module.exports = { fittingFingerprint, strictFitting, decodeCorpFittingsStrict,
  resolveStageFittings, readAccountCorpFittings };
