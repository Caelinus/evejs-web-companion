"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMinerReport } = require("../src/pilotTraining");
const { buildQueueDelta, createTrainingQueueService, verifyMergedQueue } = require("../src/pilotTrainingQueue");

const NOW = 1_800_000_000_000;
const data = {
  getType: (id) => ({ typeID: id }),
  getSkillType: (id) => ({ typeID: id, name: `Skill ${id}` }),
  getTypeDogma(id) { return { attributes: id === 20 ? { 182: 10, 277: 2 }
    : id === 32880 ? { 182: 10, 277: 1 } : id === 89240 ? { 182: 20, 277: 2 }
    : id === 17480 ? { 182: 20, 277: 3 } : {} }; },
};
const req = (id, level, state = "MISSING") => ({ typeID: id, name: `Skill ${id}`, level, state });
const q = (id, level) => ({ typeID: id, toLevel: level });
function sheet(levels = { 10: 0, 20: 0, 30: 0 }, entries = [], active = entries.length > 0) {
  return { characterID: 7, characterName: "Miner", serverNowMs: NOW,
    skills: Object.entries(levels).map(([typeID, level]) => ({ typeID: Number(typeID), level, skillPoints: level * 250 + 12 })),
    queue: { active, maxEntries: 150, entries: entries.map((entry, i) => ({ ...entry, startTimeMs: NOW + i * 1000, endTimeMs: NOW + (i + 1) * 1000 })) } };
}
test("trained targets and already queued coverage add nothing", () => {
  assert.deepEqual(buildQueueDelta(sheet({ 10: 3 }), [req(10, 3, "TRAINED")], data).additions, []);
  const delta = buildQueueDelta(sheet({ 10: 1 }, [q(10, 2), q(10, 3)]), [req(10, 3, "QUEUED")], data);
  assert.equal(delta.requirements[0].reviewState, "ALREADY_QUEUED");
  assert.deepEqual(delta.additions, []);
});
test("partial trained and partial queued levels append only missing consecutive levels", () => {
  const trained = buildQueueDelta(sheet({ 10: 1 }), [req(10, 3)], data);
  assert.deepEqual(trained.additions.map(({ typeID, toLevel }) => ({ typeID, toLevel })), [q(10, 2), q(10, 3)]);
  const queued = buildQueueDelta(sheet({ 10: 1 }, [q(10, 2)]), [req(10, 3)], data);
  assert.deepEqual(queued.additions.map(({ typeID, toLevel }) => ({ typeID, toLevel })), [q(10, 3)]);
});
test("dependency ordering expands levels after unrelated existing queue without reordering it", () => {
  const input = sheet(undefined, [q(30, 1), q(30, 2)]);
  const original = structuredClone(input);
  const delta = buildQueueDelta(input, [req(20, 2), req(10, 2)], data);
  assert.deepEqual(delta.blockers, []);
  assert.deepEqual(delta.existing, [q(30, 1), q(30, 2)]);
  assert.deepEqual(delta.additions.map(({ typeID, toLevel }) => ({ typeID, toLevel })), [q(10, 1), q(10, 2), q(20, 1), q(20, 2)]);
  assert.deepEqual(input, original);
});
test("unknown, missing injection, invalid old prefix and capacity block complete application", () => {
  for (const [input, requirements, code] of [
    [sheet(), [req(20, 2, "UNKNOWN")], "SKILL_STATE_UNKNOWN"],
    [sheet({ 10: 2 }), [req(20, 1)], "SKILLBOOK_REQUIRED"],
    [sheet({ 10: 0 }, [q(10, 2)]), [req(10, 3)], "EXISTING_QUEUE_INVALID"],
    [{ ...sheet(), queue: { ...sheet().queue, maxEntries: 1 } }, [req(10, 2)], "QUEUE_CAPACITY_EXCEEDED"],
    [{ ...sheet(), skills: null }, [req(10, 1)], "SKILL_STATE_UNKNOWN"],
  ]) assert.ok(buildQueueDelta(input, requirements, data).blockers.some((entry) => entry.code === code), code);
});
test("append preserves paused queue; empty queue explicitly starts", () => {
  assert.equal(buildQueueDelta(sheet({ 10: 0 }, [q(10, 1)], false), [req(10, 2)], data).activate, false);
  assert.equal(buildQueueDelta(sheet({ 10: 0 }), [req(10, 1)], data).activate, true);
});
test("an unreadable unrelated active head cannot be passed through a mutation", () => {
  const input = sheet(undefined, [q(30, 1)]);
  input.queue.entries[0].endTimeMs = null;
  assert.equal(buildQueueDelta(input, [req(10, 1)], data).blockers[0].code, "SKILL_STATE_UNKNOWN");
});

function harness() {
  const account = { accountID: 4, username: "Miner" };
  const levels = Object.fromEntries([10, 20, 30, 3327, 3426, 3413, 3418, 3417, 22578, 3438, 24241, 3416, 3449, 3450, 3429, 3386, 3419, 3431, 3410, 33699, 3425, 3453].map((id) => [id, 0]));
  levels[10] = 1;
  let currentSheet = sheet(levels, [q(30, 1)]);
  let version = "epoch.1";
  let time = NOW;
  let online = false;
  let mismatch = false;
  let reject = null;
  let readFails = false;
  let fittingStatus = "READY";
  let writes = 0;
  let readsAfterWrite = 0;
  const commands = [];
  const fits = () => Object.fromEntries([["VENTURE", 32880], ["PIONEER", 89240], ["PROCURER", 17480]].map(([id, hull]) => [id,
    { status: fittingStatus, typeIDs: [hull], name: id, currentFingerprint: "fit-one" }]));
  const gateway = {
    async getCharacterStatus(accountID, characterID) {
      if (accountID !== account.accountID || characterID !== 7) throw Object.assign(new Error("Not owned"), { code: "CHARACTER_ACCOUNT_MISMATCH", statusCode: 403 });
      return { characterID, stateVersion: version, online, controlState: online ? "retail_client" : "offline" };
    },
    async getSkills() {
      if (writes) readsAfterWrite++;
      if (readFails && writes) throw new Error("unreadable");
      return structuredClone(currentSheet);
    },
    async saveOfflineSkillQueue(accountID, characterID, command) {
      writes++; commands.push(structuredClone(command));
      assert.equal(accountID, 4); assert.equal(characterID, 7);
      if (reject) throw reject;
      if (command.expectedStateVersion !== version) throw Object.assign(new Error("Concurrent command"), { code: "CHARACTER_STATE_VERSION_MISMATCH", statusCode: 409 });
      version = "epoch.2";
      if (!mismatch) currentSheet.queue = { ...currentSheet.queue, active: command.payload.activate,
        entries: command.payload.entries.map((entry, i) => ({ ...entry, startTimeMs: NOW + i * 1000, endTimeMs: NOW + (i + 1) * 1000 })) };
    },
  };
  const loadPilot = async ({ account: who, characterID, sheet: supplied, targetStage }) => {
    assert.equal(who.accountID, 4); assert.equal(characterID, 7);
    const input = supplied === undefined ? await gateway.getSkills() : supplied;
    return { sheet: input, read: { corporationID: 99, fittings: [], queue: input.queue,
      report: buildMinerReport(data, input, { characterID: 7, account: "Miner" }, fits(), targetStage) } };
  };
  const service = createTrainingQueueService({ gateway, data, loadPilot, now: () => time });
  async function request(mode = "FAST") {
    const pilot = await loadPilot({ account, characterID: 7 });
    const preview = pilot.read.report.previews[mode];
    return { role: "MINER", characterID: 7, mode, stage: preview.stage, displayedTargets: preview.targets, selections: {} };
  }
  return { service, account, request, commands, gateway, get writes() { return writes; }, get readsAfterWrite() { return readsAfterWrite; },
    get sheet() { return currentSheet; }, setVersion(value) { version = value; }, setOnline() { online = true; },
    changeFit() { fittingStatus = "REVIEW_REQUIRED"; }, mismatch() { mismatch = true; }, reject(error) { reject = error; },
    expire() { time += 300001; }, failRead() { readFails = true; } };
}

for (const mode of ["FAST", "BALANCED", "MASTERY"]) test(`${mode} applies exactly the displayed stage/targets and verifies authoritative readback`, async () => {
  const h = harness();
  const request = await h.request(mode);
  const review = await h.service.review(h.account, request);
  assert.equal(review.canApply, true);
  assert.equal(review.stage, mode === "MASTERY" ? "VENTURE" : "PIONEER");
  assert.deepEqual(review.fresh.report.previews[mode].targets, request.displayedTargets);
  const result = await h.service.apply(h.account, { reviewID: review.reviewID, confirm: true });
  assert.equal(result.status, "APPLIED"); assert.equal(result.verified, true);
  assert.ok(h.readsAfterWrite > 0);
  assert.deepEqual(h.commands[0].payload.entries, [...review.existing, ...review.additions.map(({ typeID, toLevel }) => ({ typeID, toLevel }))]);
  const again = await h.service.review(h.account, await h.request(mode));
  assert.equal(again.status, "NOTHING_TO_ADD"); assert.equal(again.reviewID, null);
  assert.equal(h.writes, 1);
});
test("MASTERY on proven Pioneer remains Pioneer, not next Procurer", async () => {
  const h = harness();
  h.sheet.skills.find((entry) => entry.typeID === 10).level = 2;
  h.sheet.skills.find((entry) => entry.typeID === 20).level = 2;
  const review = await h.service.review(h.account, await h.request("MASTERY"));
  assert.equal(review.stage, "PIONEER");
  assert.equal((await h.service.apply(h.account, { reviewID: review.reviewID, confirm: true })).stage, "PIONEER");
});

test("new trainee explicitly targets Pioneer; review/apply/readback retain target and become idempotent", async () => {
  const h = harness(); h.sheet.skills.find((row) => row.typeID === 10).level = 0;
  const preview = buildMinerReport(data, h.sheet, {}, { PIONEER: { status: "READY", typeIDs: [89240] } }, "PIONEER").previews.FAST;
  const request = { ...(await h.request()), targetStage: "PIONEER", stage: "PIONEER", displayedTargets: preview.targets };
  const review = await h.service.review(h.account, request);
  assert.equal(review.fresh.report.currentStage, null);
  assert.equal(review.fresh.report.targetStage, "PIONEER");
  assert.deepEqual(review.additions.map(({ typeID, toLevel }) => [typeID, toLevel]), [[10, 1], [10, 2], [20, 1], [20, 2]]);
  const outcome = await h.service.apply(h.account, { reviewID: review.reviewID, confirm: true });
  assert.equal(outcome.verified, true); assert.equal(outcome.fresh.report.previews.FAST.stage, "PIONEER");
  assert.equal((await h.service.review(h.account, request)).status, "NOTHING_TO_ADD");
  await assert.rejects(h.service.review(h.account, { ...request, targetStage: null }), { code: "PLAN_CHANGED" });
});

test("explicit target is fingerprinted independently from an identical automatic preview", () => {
  const { planFingerprint } = require("../src/pilotTrainingQueue");
  const report = buildMinerReport(data, sheet({ 10: 1 }), {}, { PIONEER: { status: "READY", typeIDs: [89240] } }, "PIONEER");
  assert.notEqual(planFingerprint(report, "FAST"), planFingerprint({ ...report, targetStage: null }, "FAST"));
  assert.throws(() => buildMinerReport(data, sheet(), {}, {}, "HAULER"), /Unknown explicit/);
});
test("queue version, queue content, trained-level or fitting changes refuse without any write", async () => {
  for (const alter of [h => h.setVersion("epoch.other"), h => h.sheet.queue.entries.push(q(30, 2)),
    h => h.sheet.skills.find((entry) => entry.typeID === 10).level++, h => h.changeFit()]) {
    const h = harness(); const review = await h.service.review(h.account, await h.request());
    alter(h); const before = structuredClone(h.sheet.queue);
    await assert.rejects(h.service.apply(h.account, { reviewID: review.reviewID, confirm: true }), /changed/i);
    assert.equal(h.writes, 0); assert.deepEqual(h.sheet.queue, before);
  }
});
test("unknown/injection/capacity/fitting blockers cannot mint an applicable review", async () => {
  for (const alter of [h => h.sheet.skills.splice(h.sheet.skills.findIndex((row) => row.typeID === 20), 1),
    h => h.sheet.queue.maxEntries = 1, h => h.sheet.skills.find((row) => row.typeID === 20).level = null,
    h => h.changeFit()]) {
    const h = harness(); alter(h);
    const review = await h.service.review(h.account, await h.request());
    assert.equal(review.canApply, false); assert.equal(review.reviewID, null); assert.ok(review.blockers.length > 0);
    assert.equal(h.writes, 0);
  }
});
test("cross-account, absent confirmation, expired and reused reviews cannot write", async () => {
  const h = harness(); const review = await h.service.review(h.account, await h.request());
  await assert.rejects(h.service.apply({ accountID: 99 }, { reviewID: review.reviewID, confirm: true }));
  await assert.rejects(h.service.apply(h.account, { reviewID: review.reviewID, confirm: false }));
  assert.equal(h.writes, 0);
  await h.service.apply(h.account, { reviewID: review.reviewID, confirm: true });
  await assert.rejects(h.service.apply(h.account, { reviewID: review.reviewID, confirm: true }));
  assert.equal(h.writes, 1);
  const other = harness(); const expiring = await other.service.review(other.account, await other.request()); other.expire();
  await assert.rejects(other.service.apply(other.account, { reviewID: expiring.reviewID, confirm: true })); assert.equal(other.writes, 0);
});
test("online/control acquisition between review and apply blocks without selecting/releasing pilot", async () => {
  const h = harness(); const review = await h.service.review(h.account, await h.request()); h.setOnline();
  await assert.rejects(h.service.apply(h.account, { reviewID: review.reviewID, confirm: true }), /controlled\/online/);
  assert.equal(h.writes, 0);
});
test("POST success with mismatched reread is APPLY_UNVERIFIED; no retry or rollback", async () => {
  const h = harness(); const review = await h.service.review(h.account, await h.request()); h.mismatch();
  const outcome = await h.service.apply(h.account, { reviewID: review.reviewID, confirm: true });
  assert.equal(outcome.status, "APPLY_UNVERIFIED"); assert.equal(outcome.verified, false);
  assert.deepEqual(outcome.queue, h.sheet.queue); assert.equal(h.writes, 1);
});
test("authoritative refusal keeps original queue and is reread; transport failure stays unverified", async () => {
  for (const statusCode of [409, 502]) {
    const h = harness(); const review = await h.service.review(h.account, await h.request());
    const before = structuredClone(h.sheet.queue);
    h.reject(Object.assign(new Error("refused"), { code: "TEST_REFUSAL", statusCode }));
    const outcome = await h.service.apply(h.account, { reviewID: review.reviewID, confirm: true });
    assert.equal(outcome.status, statusCode === 409 ? "REFUSED" : "APPLY_UNVERIFIED");
    assert.deepEqual(h.sheet.queue, before); assert.equal(h.writes, 1); assert.ok(h.readsAfterWrite > 0);
  }
});
test("verification accepts naturally completed prefix only when remaining order is exact", () => {
  const before = sheet({ 10: 0 }, [q(10, 1)]);
  const after = sheet({ 10: 1 }, [q(10, 2)]);
  assert.equal(verifyMergedQueue(after, [q(10, 1), q(10, 2)], true, before), true);
  assert.equal(verifyMergedQueue(after, [q(10, 1), q(10, 3)], true, before), false);
});

test("failed post-write readback stays unverified without retry", async () => {
  const h = harness(); const review = await h.service.review(h.account, await h.request()); h.failRead();
  const outcome = await h.service.apply(h.account, { reviewID: review.reviewID, confirm: true });
  assert.equal(outcome.status, "APPLY_UNVERIFIED"); assert.equal(outcome.queue, null); assert.equal(h.writes, 1);
});
test("command version protects concurrent reviewed submissions inside the authoritative write lane", async () => {
  const h = harness(); const first = await h.service.review(h.account, await h.request());
  const second = await h.service.review(h.account, await h.request());
  const outcomes = await Promise.all([first, second].map((review) => h.service.apply(h.account, { reviewID: review.reviewID, confirm: true })));
  assert.deepEqual(outcomes.map((entry) => entry.status).sort(), ["APPLIED", "REFUSED"]);
  assert.equal(outcomes.find((entry) => entry.status === "REFUSED").code, "CHARACTER_STATE_VERSION_MISMATCH");
  assert.equal(h.sheet.queue.entries.filter((entry) => entry.typeID === 20 && entry.toLevel === 2).length, 1);
});
test("preflight refuses a changed displayed target or stage without silently substituting another plan", async () => {
  const h = harness(); const request = await h.request("MASTERY");
  await assert.rejects(h.service.review(h.account, { ...request, stage: "PROCURER" }), /displayed plan changed/);
  await assert.rejects(h.service.review(h.account, { ...request, displayedTargets: [] }), /displayed plan changed/);
  assert.equal(h.writes, 0);
});
