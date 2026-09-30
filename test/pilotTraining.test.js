"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  STAGES, mergeTargets, prerequisiteClosure, closeSkillTargets,
  targetState, qualification, etaFor, buildMinerReport,
} = require("../src/pilotTraining");

const NOW = 1_800_000_000_000;
const REQ = [[182, 277], [183, 278], [184, 279], [1285, 1286], [1289, 1287], [1290, 1288]];
const TYPES = { VENTURE: [32880, 483, 2464], PIONEER: [89240, 483, 10246], PROCURER: [17480, 17482, 15508] };
const accepted = Object.fromEntries(Object.entries(TYPES).map(([id, typeIDs]) => [id, { status: "READY", typeIDs, name: `${id} test fitting` }]));

function fixture(edges = {}) {
  edges = { 32880: [[11, 1]], 89240: [[11, 2]], 17480: [[11, 3]], ...edges };
  const skillIDs = new Set([11, 12, 13, 14, 3436, 3386, 22578, 3438, 3418, 3449, 3419, 3426, 3413, 3417, 24241, 3416, 3429, 3450, 3431, 3410, 33699, 3425, 3327, 3453]);
  for (const pairs of Object.values(edges)) for (const [id] of pairs) skillIDs.add(id);
  const equipmentIDs = new Set(Object.values(TYPES).flat());
  return {
    getType(id) { return skillIDs.has(id) || equipmentIDs.has(id) ? { typeID: id } : null; },
    getSkillType(id) { return skillIDs.has(id) ? { typeID: id, name: `Skill ${id}` } : null; },
    getTypeDogma(id) {
      if (!skillIDs.has(id) && !equipmentIDs.has(id)) return null;
      const attributes = {};
      for (const [index, [skillID, level]] of (edges[id] || []).entries()) {
        const [skillAttribute, levelAttribute] = REQ[index];
        attributes[skillAttribute] = skillID;
        attributes[levelAttribute] = level;
      }
      return { attributes };
    },
  };
}

function sheet(trained = {}, entries = [], overrides = {}) {
  return {
    characterName: "Miner", serverNowMs: NOW,
    skills: Object.entries(trained).map(([id, level]) => ({ typeID: Number(id), level, skillPoints: 0 })),
    queue: { active: true, entries }, ...overrides,
  };
}

test("recursive closure and graph joins take the highest prerequisite level", () => {
  const data = fixture({ 100: [[11, 1], [12, 2]], 101: [[11, 3]], 11: [[13, 1]], 12: [[13, 4]] });
  data.getType = (id => (value) => [100, 101].includes(value) ? { typeID: value } : id(value))(data.getType);
  data.getTypeDogma = (get => (id) => [100, 101].includes(id)
    ? { attributes: Object.fromEntries(([[100, [[11, 1], [12, 2]]], [101, [[11, 3]]]].find(([key]) => key === id)[1]).flatMap(([skill, level], index) => [[REQ[index][0], skill], [REQ[index][1], level]])) }
    : get(id))(data.getTypeDogma);
  assert.deepEqual([...prerequisiteClosure([100, 101], data)].sort((a, b) => a[0] - b[0]), [[11, 3], [12, 2], [13, 4]]);
});

test("hard floor wins over support; support can raise a hard minimum; support prerequisites close", () => {
  const data = fixture({ 11: [[13, 2]] });
  assert.deepEqual([...mergeTargets(new Map([[11, 4]]), new Map([[11, 2]]))], [[11, 4]]);
  assert.deepEqual([...mergeTargets(new Map([[11, 1]]), new Map([[11, 5]]))], [[11, 5]]);
  assert.deepEqual([...closeSkillTargets(new Map([[11, 2]]), data)].sort((a, b) => a[0] - b[0]), [[11, 2], [13, 2]]);
});

test("trained, training, queued, missing and unknown are distinct", () => {
  const state = sheet({ 11: 2, 12: 1 }, [
    { typeID: 12, toLevel: 3, endTimeMs: NOW + 1000 },
    { typeID: 13, toLevel: 4, endTimeMs: NOW + 2000 },
  ]);
  const rows = new Map(state.skills.map((row) => [row.typeID, row]));
  assert.equal(targetState(11, 2, state, rows), "TRAINED");
  assert.equal(targetState(12, 3, state, rows), "TRAINING");
  assert.equal(targetState(13, 4, state, rows), "QUEUED");
  assert.equal(targetState(14, 1, state, rows), "MISSING");
  assert.equal(targetState(11, 2, state, null), "UNKNOWN");
  assert.equal(qualification([{ state: "QUEUED" }]), "NOT_READY");
  assert.equal(qualification([{ state: "MISSING" }]), "NOT_READY");
  assert.equal(qualification([{ state: "UNKNOWN" }]), "UNKNOWN");
});

test("Venture to Pioneer FAST delta differs from BALANCED and intentional V MASTERY", () => {
  const data = fixture({ 32880: [[11, 1]], 89240: [[11, 2], [12, 1]], 17480: [[11, 3]] });
  const report = buildMinerReport(data, sheet({ 11: 1 }), { characterID: 7, account: "BMiner4" }, accepted);
  assert.equal(report.currentStage, "VENTURE");
  assert.equal(report.stages[0].skillQualification, "READY");
  assert.equal(report.stages[1].skillQualification, "NOT_READY");
  assert.equal(report.stages[0].equipmentReadiness, "UNKNOWN");
  assert.deepEqual(report.previews.FAST.targets.map((row) => row.typeID).sort((a, b) => a - b), [11, 12]);
  assert.ok(report.previews.BALANCED.targets.length > report.previews.FAST.targets.length);
  assert.ok(report.previews.MASTERY.targets.some((row) => row.level === 5));
});

test("a queued or training hull prerequisite never qualifies its stage", () => {
  const data = fixture();
  const queued = buildMinerReport(data, sheet({}, [{ typeID: 11, toLevel: 1, endTimeMs: NOW + 1000 }]), {}, accepted);
  assert.equal(queued.stages[0].hard.find((row) => row.typeID === 11).state, "TRAINING");
  assert.equal(queued.stages[0].skillQualification, "NOT_READY");
  const later = buildMinerReport(data, sheet({}, [
    { typeID: 12, toLevel: 1, endTimeMs: NOW + 1000 },
    { typeID: 11, toLevel: 1, endTimeMs: NOW + 2000 },
  ]), {}, accepted);
  assert.equal(later.stages[0].hard.find((row) => row.typeID === 11).state, "QUEUED");
  assert.equal(later.stages[0].skillQualification, "NOT_READY");
  const alreadyQualified = buildMinerReport(data, sheet({ 11: 1 }, [
    { typeID: 11, toLevel: 2, endTimeMs: NOW + 1000 },
  ]), {}, accepted);
  assert.equal(alreadyQualified.stages[0].hard.find((row) => row.typeID === 11).state, "TRAINED");
  assert.equal(alreadyQualified.stages[0].hard.find((row) => row.typeID === 11).queuePosition, -1);
});

test("unreadable queue fails qualification closed without confusing equipment", () => {
  const report = buildMinerReport(fixture({ 32880: [[11, 1]] }), sheet({ 11: 1 }, [], { queue: null }), {}, accepted);
  assert.equal(report.stages[0].skillQualification, "UNKNOWN");
  assert.equal(report.stages[0].equipmentReadiness, "UNKNOWN");
  const malformed = buildMinerReport(fixture({ 32880: [[11, 1]] }), sheet({ 11: 1 }, [], { skills: [{ typeID: 11, level: null }] }), {}, accepted);
  assert.equal(malformed.stages[0].skillQualification, "UNKNOWN");
});

test("missing static dogma cannot produce a false READY verdict", () => {
  const data = fixture();
  const get = data.getTypeDogma;
  data.getTypeDogma = (id) => id === 32880 ? null : get(id);
  assert.throws(() => buildMinerReport(data, sheet({ 11: 5 }), {}, accepted), /Static dogma unavailable/);
});

test("ETA consumes effective server queue timestamps and never inserts retail or x50 constants", () => {
  const input = sheet({}, [{ typeID: 11, toLevel: 2, endTimeMs: NOW + 90_000 }]);
  const eta = etaFor(new Map([[11, 2]]), input, new Map());
  assert.deepEqual(eta, { kind: "SERVER_QUEUE", completionMs: NOW + 90_000, remainingMs: 90_000 });
  assert.equal(etaFor(new Map([[12, 2]]), input, new Map()).kind, "UNKNOWN");
});

const runtime = process.env.EVEJS_ROOT;
const realDogma = runtime && fs.existsSync(path.join(runtime, "_local", "gameStore", "data", "typeDogma", "data.json"));
test("current EveJS dogma closes selected fitting types without a drone-count floor", { skip: !realDogma }, () => {
  const data = require("../src/staticData");
  assert.deepEqual(STAGES.map((stage) => stage.id), ["VENTURE", "PIONEER", "PROCURER"]);
  for (const stage of STAGES) {
    const closure = prerequisiteClosure(accepted[stage.id].typeIDs, data);
    assert.ok(closure.size > 0);
    assert.ok((closure.get(3436) || 0) < 4, `${stage.id} must not invent Drones IV/V for active count`);
  }
  const ventureSkills = prerequisiteClosure(accepted.VENTURE.typeIDs, data);
  const trained = Object.fromEntries(ventureSkills);
  const report = buildMinerReport(data, sheet(trained), {}, accepted);
  assert.equal(report.currentStage, "VENTURE");
  assert.equal(report.nextStage, "PIONEER");
  assert.ok(report.previews.FAST.targets.length > 0);
  assert.equal(report.stages[0].equipmentReadiness, "UNKNOWN");
});

test("highest proven stage is retained when an earlier fitting is unavailable", () => {
  const report = buildMinerReport(fixture(), sheet({ 11: 3 }), {}, {
    ...accepted, VENTURE: { status: "UNKNOWN" },
  });
  assert.equal(report.stages[0].skillQualification, "UNKNOWN");
  assert.equal(report.currentStage, "PROCURER");
  assert.equal(report.nextStage, null);
  assert.equal(report.currentStageStatus, "READY");
});

test("Mining Drone Operation trained I satisfies I but not a higher support target", () => {
  const state = sheet({ 3438: 1 });
  const rows = new Map(state.skills.map((row) => [row.typeID, row]));
  assert.equal(targetState(3438, 1, state, rows), "TRAINED");
  assert.equal(targetState(3438, 2, state, rows), "MISSING");
  assert.equal(targetState(3438, 1, state, null), "UNKNOWN");
});

test("report queue state distinguishes active, paused, empty and unreadable", () => {
  const entries = [{ typeID: 11, toLevel: 1, endTimeMs: NOW + 1000 }];
  const read = (input) => buildMinerReport(fixture(), input, {}, accepted).trainingState;
  assert.equal(read(sheet({}, entries)), "TRAINING");
  assert.equal(read(sheet({}, [], { queue: { active: false, entries } })), "QUEUED");
  assert.equal(read(sheet()), "IDLE");
  assert.equal(read(sheet({}, [], { skills: null })), "UNKNOWN");
});
