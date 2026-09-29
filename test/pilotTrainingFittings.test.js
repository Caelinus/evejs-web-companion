"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fittingFingerprint, decodeCorpFittingsStrict, resolveStageFittings, readAccountCorpFittings,
} = require("../src/pilotTrainingFittings");
const { STAGES, buildMinerReport } = require("../src/pilotTraining");

const CORP = 98000001;
const ACCOUNT = 4;
const PILOT = 90000001;
const DATE = "134285151537020000";
const ITEMS = [[483, 27, 2], [2464, 87, 2], [31370, 92, 1], [89, 5, 100]];
const data = {
  getType(id) { return Number.isSafeInteger(id) && id > 0 && id !== 999 ? { typeID: id } : null; },
  getSkillType(id) { return Number.isSafeInteger(id) && id > 0 ? { typeID: id, name: `Skill ${id}` } : null; },
  getTypeDogma(id) { return { attributes: id === 32880 ? { 182: 11, 277: 1 } : id === 483 ? { 182: 12, 277: 2 } : id === 2464 ? { 182: 13, 277: 1 } : {} }; },
};

function row({ id = 7, owner = CORP, hull = 32880, items = ITEMS, name = "Start Venture", date = DATE } = {}) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
    ["fittingID", id], ["ownerID", owner], ["shipTypeID", hull], ["name", name],
    ["savedDate", { type: "long", value: date }],
    ["fitData", { type: "list", items: items.map((tuple) => ({ type: "tuple", items: tuple })) }],
  ] } };
}
function library(value = row()) {
  return { type: "object", name: { type: "rawstr", value: "carbon.common.script.net.objectCaching.CachedMethodCallResult" },
    args: [{}, { type: "substream", value: { type: "dict", entries: [[7, value]] } }] };
}
function selection(fit) {
  return { VENTURE: { scope: "CORPORATION", ownerID: CORP, fittingID: fit.fittingID,
    acceptedSavedDate: fit.savedDate, acceptedFingerprint: fit.fingerprint } };
}

test("strict read preserves hull, slot/rig/charge/drone flags and quantities", () => {
  const [fit] = decodeCorpFittingsStrict(library(), CORP, data);
  assert.equal(fit.shipTypeID, 32880);
  assert.deepEqual(fit.items, ITEMS.map(([typeID, flagID, quantity]) => ({ typeID, flagID, quantity })));
  assert.equal(fit.fittingID, 7);
});

test("malformed tuple, unknown type, invalid flag and quantity never yield a partial manifest", () => {
  for (const items of [
    [[483, 27]], [[999, 27, 1]], [[483, 42, 1]], [[483, 27, 0]],
  ]) {
    const [fit] = decodeCorpFittingsStrict(library(row({ items })), CORP, data);
    assert.equal(fit.invalid, true);
    assert.equal(fit.items, undefined);
    assert.equal(resolveStageFittings(STAGES, [fit], { VENTURE: { scope: "CORPORATION", ownerID: CORP, fittingID: 7 } }, CORP).VENTURE.status, "INVALID_FIT");
  }
});

test("wrong owner denies library; wrong hull cannot qualify a stage", () => {
  assert.throws(() => decodeCorpFittingsStrict(library(row({ owner: 99 })), CORP, data), /owner differs/);
  const [fit] = decodeCorpFittingsStrict(library(row({ hull: 89240 })), CORP, data);
  assert.equal(resolveStageFittings(STAGES, [fit], selection(fit), CORP).VENTURE.status, "INVALID_FIT");
});

test("fitting ID is identity and tuple order does not change content fingerprint", () => {
  const [fit] = decodeCorpFittingsStrict(library(), CORP, data);
  assert.equal(fittingFingerprint(32880, [...fit.items].reverse()), fit.fingerprint);
  assert.equal(resolveStageFittings(STAGES, [{ ...fit, name: "Renamed" }], selection(fit), CORP).VENTURE.status, "READY");
  assert.equal(resolveStageFittings(STAGES, [{ ...fit, fittingID: 8, name: fit.name }], selection(fit), CORP).VENTURE.status, "UNKNOWN");
});

test("same ID with changed content or saved date requires explicit review", () => {
  const [fit] = decodeCorpFittingsStrict(library(), CORP, data);
  const altered = { ...fit, fingerprint: fittingFingerprint(fit.shipTypeID, fit.items.slice(1)) };
  const outcome = resolveStageFittings(STAGES, [altered], selection(fit), CORP).VENTURE;
  assert.equal(outcome.status, "REVIEW_REQUIRED");
  assert.equal(outcome.acceptedFingerprint, fit.fingerprint);
  assert.equal(outcome.currentSavedDate, fit.savedDate);
  assert.equal(resolveStageFittings(STAGES, [{ ...fit, savedDate: "134285151537020001" }], selection(fit), CORP).VENTURE.status, "REVIEW_REQUIRED");
});

test("accepted fitting drives hard closure; support remains independent; missing fit is UNKNOWN", () => {
  const [fit] = decodeCorpFittingsStrict(library(), CORP, data);
  const resolved = resolveStageFittings(STAGES, [fit], selection(fit), CORP);
  const skills = { characterName: "Miner", serverNowMs: 1_800_000_000_000,
    skills: [11, 12, 13].map((typeID) => ({ typeID, level: 5, skillPoints: 0 })),
    queue: { active: false, entries: [] } };
  const report = buildMinerReport(data, skills, {}, resolved);
  assert.equal(report.stages[0].skillQualification, "READY");
  assert.deepEqual(report.stages[0].hard.map((entry) => entry.typeID), [11, 12, 13]);
  assert.ok(report.stages[0].support.length > 0);
  assert.equal(report.stages[0].equipmentReadiness, "UNKNOWN");
  const absent = buildMinerReport(data, skills, {}, resolveStageFittings(STAGES, [], selection(fit), CORP));
  assert.equal(absent.stages[0].skillQualification, "UNKNOWN");
  assert.equal(absent.previews.FAST.eta.kind, "UNKNOWN");
});

test("cargo remains fingerprinted but never creates a hard fitted-skill requirement", () => {
  const skillfulCargo = 7777;
  const cargoData = { ...data, getTypeDogma(typeID) {
    return typeID === skillfulCargo ? { attributes: { 182: 99, 277: 5 } } : data.getTypeDogma(typeID);
  } };
  const [fit] = decodeCorpFittingsStrict(library(row({ items: [...ITEMS, [skillfulCargo, 5, 1]] })), CORP, cargoData);
  const accepted = resolveStageFittings(STAGES, [fit], selection(fit), CORP).VENTURE;
  assert.equal(accepted.status, "READY");
  assert.ok(fit.items.some((item) => item.typeID === skillfulCargo && item.flagID === 5));
  assert.ok(!accepted.typeIDs.includes(skillfulCargo));
  const skills = { characterName: "Miner", serverNowMs: 1_800_000_000_000,
    skills: [11, 12, 13].map((typeID) => ({ typeID, level: 5, skillPoints: 0 })),
    queue: { active: false, entries: [] } };
  const report = buildMinerReport(cargoData, skills, {}, { VENTURE: accepted });
  assert.ok(!report.stages[0].hard.some((entry) => entry.typeID === 99));
  const changed = { ...fit, fingerprint: fittingFingerprint(fit.shipTypeID, fit.items.filter((item) => item.typeID !== skillfulCargo)) };
  assert.equal(resolveStageFittings(STAGES, [changed], selection(fit), CORP).VENTURE.status, "REVIEW_REQUIRED");
});

test("session-free corporation read verifies ownership and never selects pilot", async () => {
  const calls = [];
  const store = { async listCharactersForAccount(accountID) {
    calls.push(["owner", accountID]);
    return accountID === ACCOUNT ? [{ accountID, characterID: PILOT, corporationID: CORP }] : [];
  } };
  const gateway = { async callMethod(service, method, args, kwargs, session, bridgeSessionID) {
    calls.push([service, method, args, session, bridgeSessionID]);
    return { result: library() };
  } };
  const denied = await readAccountCorpFittings({ store, gateway, accountID: ACCOUNT, characterID: 2, data });
  assert.equal(denied.status, "NOT_OWNED");
  assert.equal(calls.length, 1);
  const result = await readAccountCorpFittings({ store, gateway, accountID: ACCOUNT, characterID: PILOT, data });
  assert.equal(result.status, "READY");
  assert.equal(result.fittings[0].fittingID, 7);
  assert.deepEqual(calls[2].slice(0, 3), ["corpFittingMgr", "GetFittings", []]);
  assert.equal(calls[2][3].corpid, CORP);
  assert.equal(calls[2][4], undefined);
});

test("corporation change or denied service read fails closed", async () => {
  let reads = 0;
  const store = { async listCharactersForAccount() { return [{ accountID: ACCOUNT, characterID: PILOT, corporationID: reads++ ? 99 : CORP }]; } };
  const gateway = { async callMethod() { return { result: library() }; } };
  assert.equal((await readAccountCorpFittings({ store, gateway, accountID: ACCOUNT, characterID: PILOT, data })).status, "CORP_UNAVAILABLE");
  const denied = { async callMethod() { throw new Error("OWNER_SCOPE_DENIED"); } };
  assert.equal((await readAccountCorpFittings({ store: { async listCharactersForAccount() { return [{ accountID: ACCOUNT, characterID: PILOT, corporationID: CORP }]; } },
    gateway: denied, accountID: ACCOUNT, characterID: PILOT, data })).status, "CORP_UNAVAILABLE");
});
