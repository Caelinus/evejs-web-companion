"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { normalizeSupport, supportPolicy } = require("../src/miningOperationSupport");
const { buildStandardProfile } = require("../src/miningOperationProfiles");
const { auditMiningScript, operationRoutineCompatibility, createMiningOperations } = require("../src/miningOperations");
const { createMiningTargetBoard } = require("../src/miningTargetBoard");
const { createBeltMemory } = require("../src/beltMemory");
const members = [{ characterID: 1, characterName: "Miner", role: "MINER", routineMode: "STANDARD" },
  { characterID: 2, characterName: "Support", role: "COMMAND", routineMode: "STANDARD" }];
const config = extra => normalizeSupport({ version: 1, characterID: 2, ...extra }, members);
const definition = support => ({ operationID: "op", name: "Support", area: { anchorSystemID: 30000142, targetClasses: ["BELT"] },
  unloadPolicy: "SELF_UNLOAD", unloadDestination: { stationID: 60003760, stationName: "Home", systemName: "Jita" }, members, ...(support ? { support } : {}) });
test("legacy absence, selected identity and exactly one Standard COMMAND", () => {
  assert.equal(normalizeSupport(undefined, [members[0]]), null);
  for (const [value, roster] of [[undefined, members], [{ version: 1, characterID: 1 }, members], [{ version: 2, characterID: 2 }, members],
    [{ version: 1, characterID: 2 }, [...members, { ...members[1], characterID: 3 }]],
    [{ version: 1, characterID: 2 }, [members[0], { ...members[1], routineMode: "CUSTOM" }]]])
    assert.throws(() => normalizeSupport(value, roster), { code: "MINING_OPERATION_INVALID" });
});
test("contradictory capability policies fail", () => {
  for (const value of [{ useIndustrialCore: false, coreRequirement: "requireCore" }, { tractor: false, collection: "TRACTOR_AND_COLLECT" },
    { compressCollectedOre: true }, { fleetPolicy: "invent" }, { selfMining: "yes" }, { supportLoss: "invent" }])
    assert.throws(() => config(value), { code: "MINING_OPERATION_INVALID" });
  assert.equal(config({}).fleetPolicy, "EXISTING_ONLY");
});
test("transient recovery precedes explicit loss policies; fresh authority resets loss", () => {
  for (const [supportLoss, mode] of [["PAUSE", "PAUSE"], ["CONTINUE_UNSUPPORTED", "FALLBACK"], ["STOP", "STOP"]]) {
    const cfg = config({ supportLoss });
    assert.equal(supportPolicy(cfg, null, null, 1000).mode, "PAUSE");
    assert.equal(supportPolicy(cfg, null, 1000, 30999).mode, "PAUSE");
    assert.equal(supportPolicy(cfg, null, 1000, 31000).mode, mode);
    assert.equal(supportPolicy(cfg, { state: "READY", core: "inactive", observedAtMs: 31000 }, 1000, 31001).lostSinceMs, null);
  }
});
test("required Core and future/stale observations cannot grant productive readiness", () => {
  const cfg = config({ useIndustrialCore: true, coreRequirement: "requireCore" });
  for (const core of ["inactive", "unknown"]) assert.equal(supportPolicy(cfg, { state: "READY", core, observedAtMs: 1000 }, null, 1001).mode, "PAUSE");
  assert.equal(supportPolicy(cfg, { state: "DEGRADED", core: "active", reason: "full", observedAtMs: 1000 }, null, 1001).mode, "NORMAL");
  for (const observedAtMs of [1002, -8999]) assert.equal(supportPolicy(cfg, { state: "READY", core: "active", observedAtMs }, null, 1001).mode, "PAUSE");
});
test("Standard COMMAND uses shared runner; bound miner distinct; legacy document unchanged", async () => {
  const { decodeScriptText } = await import("../web/src/bots/scriptCodec.ts");
  const legacy = buildStandardProfile(definition(), members[0]), def = definition(config({ fleetPolicy: "MANAGED" }));
  const command = buildStandardProfile(def, members[1]), miner = buildStandardProfile(def, members[0]);
  for (const profile of [command, miner]) assert.equal(decodeScriptText(JSON.stringify(profile.doc)).ok, true);
  for (const [role, doc] of [["COMMAND", command.doc], ["MINER", miner.doc]]) assert.equal(operationRoutineCompatibility(def, role, auditMiningScript(doc), ["BELT"]), null);
  assert.match(miner.scriptID, /support-bound$/);
  assert.deepEqual(buildStandardProfile(definition(), members[0]), legacy);
  assert.equal(auditMiningScript(legacy.doc).macros.includes("fleet-mine"), false);
  assert.notEqual(operationRoutineCompatibility(def, "MINER", auditMiningScript(legacy.doc), ["BELT"]), null);
});
test("support-bound site and ice miners request the ordinary scanner observation", async () => {
  const { activeStepToursOreSites, initialMemory } = await import("../web/src/nav/scriptDecide.ts");
  for (const family of ["BELT", "ORE_ANOMALY", "ICE"]) {
    const def = definition(config({})); def.area.targetClasses = [family];
    const profile = buildStandardProfile(def, members[0]);
    const step = profile.doc.program[0].body.find(row => row.kind === "macro" && row.macro === "fleet-mine");
    const doc = { ...profile.doc, program: [step] };
    assert.equal(activeStepToursOreSites(doc, initialMemory(doc)), family !== "BELT");
  }
});
test("only selected COMMAND reports; Core policy agrees with public degraded reason", () => {
  let now = 1000;
  const def = definition(config({ useIndustrialCore: true, coreRequirement: "requireCore" }));
  const op = createMiningOperations({ store: { get: () => def, list: () => [def] }, targetBoard: createMiningTargetBoard({ now: () => now }), beltMemory: createBeltMemory(), now: () => now });
  op.begin("op"); for (const member of members) op.memberStarted("op", member.characterID, `bot-${member.characterID}`); op.finishLaunch("op");
  const report = { state: "READY", core: "inactive", reason: "required-core-inactive" };
  assert.equal(op.observeSupport("op", 1, report), false); assert.equal(op.observeSupport("op", 2, report), true);
  const bots = members.map(row => ({ ...row, operationID: "op", botID: `bot-${row.characterID}`, status: "running", endedAt: null }));
  const result = op.list(bots)[0];
  assert.equal(result.runtime.state, "DEGRADED"); assert.equal(result.runtime.supportPolicy.mode, "PAUSE");
  assert.equal(result.runtime.statusReason, "required-core-inactive");
  now += 10001; assert.equal(op.assignment("op", 1).supportPolicy.mode, "PAUSE");
});
