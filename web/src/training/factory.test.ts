import test from "node:test";
import assert from "node:assert/strict";
import { fittingConfigKey, readSelections, saveSelections, readPilotPreferences, savePilotPreferences,
  readFactoryAccounts, rememberFactoryAccount, factoryStatus, requirementCounts, skillTargetLabel,
  readLastQueueApply, rememberQueueApply } from "./factory.ts";
import { factoryError } from "./factory.ts";
import { BridgeCallError } from "../bridge/callMethod.ts";
import type { MinerReport, RequirementRow, QueueApplyOutcome } from "./types.ts";
import { isGoblinFactoryPath, isPilotTrainingPath } from "../app/pageRoute.ts";

function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
test("unknown technical account is an actionable refusal, never an empty owned account", () => {
  assert.match(factoryError(new BridgeCallError("UNKNOWN_EVEJS_ACCOUNT", "Unknown", 401)), /does not exist.*does not create accounts/);
});
test("existing accepted fitting configuration survives role/mode changes and a fresh read", () => {
  const local = storage();
  const key = "pilot-training:miner:BMiner7:90000001";
  const saved = JSON.stringify({ VENTURE: { scope: "CORPORATION", ownerID: 98000001, fittingID: 7,
    acceptedSavedDate: "134285151537020000", acceptedFingerprint: "accepted-content" } });
  local.setItem(key, saved);
  assert.equal(fittingConfigKey("BMiner7", 90000001), key);
  assert.equal(readPilotPreferences(local, "BMiner7", 90000001).role, "", "account names never assign roles");
  savePilotPreferences(local, "BMiner7", 90000001, { role: "MINER", mode: "MASTERY" });
  assert.equal(local.getItem(key), saved, "preferences never rewrite the accepted stage map");
  assert.deepEqual(readSelections(local, "BMiner7", 90000001), JSON.parse(saved));
  assert.deepEqual(readPilotPreferences(local, "BMiner7", 90000001), { role: "MINER", mode: "MASTERY", targetStage: null });
  assert.deepEqual(readSelections(local, "BMiner7", 90000002), {});
  assert.deepEqual(readSelections(local, "Other", 90000001), {});
  const accepted = readSelections(local, "BMiner7", 90000001);
  saveSelections(local, "BMiner7", 90000001, accepted);
  assert.equal(local.getItem(key), saved);
});
test("malformed stored fitting configuration fails closed and is not overwritten", () => {
  const local = storage();
  const key = fittingConfigKey("A", 1);
  for (const value of ["{", "null", "[]"]) {
    local.setItem(key, value);
    assert.throws(() => readSelections(local, "A", 1));
    assert.equal(local.getItem(key), value);
  }
});
test("remembered accounts are distinct from explicit character roles", () => {
  const local = storage();
  rememberFactoryAccount(local, "BMiner7"); rememberFactoryAccount(local, "BMiner7");
  rememberFactoryAccount(local, "Other");
  assert.deepEqual(readFactoryAccounts(local), ["BMiner7", "Other"]);
  assert.equal(readPilotPreferences(local, "Other", 1).role, "");
});
test("explicit Pioneer target survives F5 without changing accepted fitting storage", () => {
  const local = storage();
  savePilotPreferences(local, "BMiner10", 10, { role: "MINER", mode: "FAST", targetStage: "PIONEER" });
  assert.deepEqual(readPilotPreferences(local, "BMiner10", 10), { role: "MINER", mode: "FAST", targetStage: "PIONEER" });
  assert.deepEqual(readSelections(local, "BMiner10", 10), {});
});
test("factory filters derive from evidence, with review and unknown taking priority", () => {
  const target = { state: "MISSING" } as RequirementRow;
  const report = { stages: [{ fitting: { status: "READY" } }], trainingState: "IDLE",
    previews: { BALANCED: { targets: [target], eta: { kind: "UNKNOWN" } } } } as unknown as MinerReport;
  assert.equal(factoryStatus(report, "BALANCED"), "NOT_READY");
  assert.equal(factoryStatus({ ...report, trainingState: "TRAINING" }, "BALANCED"), "TRAINING");
  assert.equal(factoryStatus(report, "BALANCED", "read failed"), "UNKNOWN");
  assert.equal(factoryStatus(null, "BALANCED"), "UNKNOWN");
  const changed = { ...report, stages: report.stages.map((stage) => ({ ...stage, fitting: { status: "REVIEW_REQUIRED" as const } })) };
  assert.equal(factoryStatus(changed, "BALANCED"), "NEEDS_REVIEW");
  const missing = { ...report, previews: { ...report.previews, BALANCED: { stage: null, targets: [], eta: { kind: "UNKNOWN", reason: "Fit unavailable" } } } } as MinerReport;
  assert.equal(factoryStatus(missing, "BALANCED"), "UNKNOWN");
  const ready = { ...report, previews: { ...report.previews, BALANCED: { stage: null, targets: [], eta: { kind: "READY", remainingMs: 0 } } } } as MinerReport;
  assert.equal(factoryStatus(ready, "BALANCED"), "READY");
  assert.deepEqual(requirementCounts(["TRAINED", "TRAINING", "QUEUED", "MISSING", "UNKNOWN"].map((state) => ({ state }) as RequirementRow)),
    { TRAINED: 1, TRAINING: 1, QUEUED: 1, MISSING: 1, UNKNOWN: 1 });
});
test("standalone route only matches its own direct path", () => {
  assert.equal(isGoblinFactoryPath("/goblin-factory"), true);
  assert.equal(isGoblinFactoryPath("/goblin-factory/"), true);
  assert.equal(isGoblinFactoryPath("/"), false);
  assert.equal(isGoblinFactoryPath("/goblin-factory-other"), false);
});

test("NEEDS TRAINING is display-only and UNKNOWN remains distinct", () => {
  assert.equal(skillTargetLabel("MISSING"), "NEEDS TRAINING");
  for (const state of ["UNKNOWN", "TRAINED", "TRAINING", "QUEUED"] as const) assert.equal(skillTargetLabel(state), state);
});
test("last-apply persistence retains only compact audit metadata, never credentials or review handles", () => {
  const local = storage();
  const outcome = { mode: "FAST", stage: "PROCURER", status: "APPLIED", at: 1_800_000_000_000,
    added: 3, attemptedAdditions: 3, verified: true, code: null, fresh: { token: "not-for-storage" },
    reviewID: "not-for-storage", queue: { entries: [] }, message: "Verified" } as unknown as QueueApplyOutcome;
  const record = rememberQueueApply(local, "BMiner9", 9, outcome);
  assert.deepEqual(readLastQueueApply(local, "BMiner9", 9), record);
  assert.equal(JSON.stringify(record).includes("not-for-storage"), false);
  assert.equal(readLastQueueApply(local, "Other", 9), null);
  assert.deepEqual(readSelections(local, "BMiner9", 9), {});
});

test("canonical Pilot Training route is independent of cockpit and legacy redirect",()=>{assert.equal(isPilotTrainingPath("/pilot-training"),true);assert.equal(isPilotTrainingPath("/pilot-training/"),true);assert.equal(isPilotTrainingPath("/"),false);assert.equal(isPilotTrainingPath("/pilot-training-other"),false);});
