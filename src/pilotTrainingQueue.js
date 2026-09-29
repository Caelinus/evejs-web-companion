"use strict";

const { createHash, randomUUID } = require("node:crypto");
const { readSkillState, dogmaEdges } = require("./pilotTraining");
const { readMinerPilot, trainingError } = require("./pilotTrainingRead");
const MODES = ["FAST", "BALANCED", "MASTERY"];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pairs = (rows) => rows.map(({ typeID, toLevel }) => ({ typeID, toLevel }));
const targets = (rows) => rows.map(({ typeID, level }) => [typeID, level]).sort((a, b) => a[0] - b[0]);

function queueFingerprint(sheet) {
  if (!readSkillState(sheet)) throw trainingError("SKILL_STATE_UNKNOWN");
  // Ignore ticking SP, but include trained levels, queue order, activation and
  // training instants: completion, restart or a rate change requires new review.
  return hash({ levels: sheet.skills.map(({ typeID, level }) => [typeID, level]).sort((a, b) => a[0] - b[0]),
    queue: sheet.queue, warning: sheet.queueWarning || null });
}

function planFingerprint(report, mode) {
  const preview = report.previews[mode];
  const stage = report.stages.find((entry) => entry.id === preview.stage);
  return hash({ role: report.role, mode, targetStage: report.targetStage || null, stage: preview.stage, policy: report.policyVersion,
    supportPolicyKey: stage?.supportPolicyKey, requirements: targets(preview.requirements || []), fitting: stage?.fitting });
}

/** Pure append planner. Existing rows are never removed, normalized away or reordered. */
function buildQueueDelta(sheet, requirements, data) {
  const skills = readSkillState(sheet);
  const blockers = [];
  const block = (code, message, typeID = null) => blockers.push({ code, message, typeID });
  const maxEntries = sheet?.queue?.maxEntries;
  const head = sheet?.queue?.entries?.[0];
  const unreadableActiveHead = sheet?.queue?.active && (!head || !Number.isFinite(head.startTimeMs) ||
    head.startTimeMs <= 0 || !Number.isFinite(head.endTimeMs) || head.endTimeMs <= sheet.serverNowMs);
  if (!skills || sheet.queueWarning || unreadableActiveHead || !Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    return { existing: [], additions: [], requirements: [], blockers: [{ code: "SKILL_STATE_UNKNOWN", message: "Complete skills, queue and authoritative capacity are required.", typeID: null }], maxEntries: null, activate: false };
  }
  const existing = pairs(sheet.queue.entries);
  const projected = new Map([...skills].map(([id, skill]) => [id, skill.level]));
  const requested = new Map(requirements.map((row) => [row.typeID, row.level]));
  try {
    // Refuse malformed existing queues; repairing them is outside append-only scope.
    for (const entry of existing) {
      if (!skills.has(entry.typeID) || entry.toLevel !== (projected.get(entry.typeID) || 0) + 1 ||
          dogmaEdges(entry.typeID, data).some(([id, level]) => (projected.get(id) || 0) < level)) {
        throw trainingError("EXISTING_QUEUE_INVALID", "Existing queue cannot be preserved as a valid prefix.");
      }
      projected.set(entry.typeID, entry.toLevel);
    }
  } catch (error) { block(error.code || "STATIC_SKILL_DATA_UNAVAILABLE", error.message); }
  const reviewRows = requirements.map((row) => {
    let state;
    if (row.state === "UNKNOWN") { state = "UNKNOWN"; block("SKILL_STATE_UNKNOWN", `Unknown target: ${row.name}`, row.typeID); }
    else if ((skills.get(row.typeID)?.level || 0) >= row.level) state = "ALREADY_TRAINED";
    else if ((projected.get(row.typeID) || 0) >= row.level) state = "ALREADY_QUEUED";
    else if (!skills.has(row.typeID)) { state = "BLOCKED"; block("SKILLBOOK_REQUIRED", `${row.name} is not injected (QueueSkillNotUploaded).`, row.typeID); }
    else state = "WILL_APPEND";
    return { ...row, reviewState: state };
  });
  const additions = [];
  const visiting = new Set();
  function append(id, level) {
    if ((projected.get(id) || 0) >= level) return;
    if (!skills.has(id)) throw trainingError("SKILLBOOK_REQUIRED", `Skill ${id} is not injected (QueueSkillNotUploaded).`);
    if ((requested.get(id) || 0) < level) throw trainingError("PLAN_INCOMPLETE", "A prerequisite lies outside the reviewed plan.");
    if (visiting.has(id)) throw trainingError("STATIC_SKILL_DATA_UNAVAILABLE", "Cyclic skill requirements.");
    visiting.add(id);
    for (const [requiredID, requiredLevel] of dogmaEdges(id, data)) append(requiredID, requiredLevel);
    for (let next = (projected.get(id) || 0) + 1; next <= level; next++) {
      additions.push({ typeID: id, toLevel: next, name: data.getSkillType(id)?.name || `Skill ${id}` });
      projected.set(id, next);
    }
    visiting.delete(id);
  }
  if (blockers.length === 0) {
    try { for (const [id, level] of [...requested].sort((a, b) => a[0] - b[0])) append(id, level); }
    catch (error) { block(error.code || "STATIC_SKILL_DATA_UNAVAILABLE", error.message); }
  }
  if (existing.length + additions.length > maxEntries) block("QUEUE_CAPACITY_EXCEEDED",
    `${existing.length} existing + ${additions.length} additions exceeds ${maxEntries}; ${Math.max(0, maxEntries - existing.length)} slots available.`);
  return { existing, additions, requirements: reviewRows, blockers, maxEntries,
    // Preserve paused/nonempty queues; an empty queue explicitly starts on Apply.
    activate: existing.length ? sheet.queue.active : true };
}

function verifyMergedQueue(sheet, merged, activate, before) {
  const skills = readSkillState(sheet);
  if (!skills || sheet.queueWarning) return false;
  let completed = 0;
  while (completed < merged.length && (skills.get(merged[completed].typeID)?.level || 0) >= merged[completed].toLevel) completed++;
  const expected = merged.slice(completed);
  if (hash(pairs(sheet.queue.entries)) !== hash(expected) || sheet.queue.active !== (expected.length > 0 && activate)) return false;
  if (completed === 0 && before.queue.active && before.queue.entries.length) {
    if (sheet.queue.entries[0]?.startTimeMs !== before.queue.entries[0].startTimeMs) return false;
  }
  return true;
}

function createTrainingQueueService({ store, gateway, data, now = Date.now, uuid = randomUUID, loadPilot = readMinerPilot }) {
  const reviews = new Map();
  const ttl = 5 * 60_000;
  async function status(account, id) {
    const state = await gateway.getCharacterStatus(account.accountID, id);
    if (state?.characterID !== id || typeof state.stateVersion !== "string" || !state.stateVersion || state.stateVersion.length > 512)
      throw trainingError("CHARACTER_CONTROL_UNAVAILABLE", "Authoritative control/version is unavailable.");
    if (state.controlState !== "offline" || state.online !== false)
      throw trainingError("PILOT_MUST_BE_OFFLINE", "Pilot is controlled/online. Factory will not release or take over its session.");
    return state;
  }
  async function fresh(account, characterID, selections, targetStage, configurations, role) {
    const before = await status(account, characterID);
    const pilot = await loadPilot({ store, gateway, data, account, characterID, selections, targetStage, configurations, role });
    const after = await status(account, characterID);
    if (before.stateVersion !== after.stateVersion) throw trainingError("QUEUE_CHANGED", "Character state changed while reading; review again.");
    return { ...pilot, version: after.stateVersion };
  }
  function prune() {
    for (const [key, value] of reviews) if (value.expiresAt <= now()) reviews.delete(key);
    while (reviews.size >= 100) reviews.delete(reviews.keys().next().value);
  }
  async function review(account, request) {
    const { characterID, selections = {}, mode, stage, displayedTargets, role, targetStage = null, configurations } = request;
    if (!Number.isSafeInteger(characterID) || characterID <= 0 || !(typeof role === "string" && /^[A-Z][A-Z0-9_-]{0,39}$/.test(role)) || !MODES.includes(mode) ||
        !Array.isArray(displayedTargets) || displayedTargets.length > 1000 || displayedTargets.some((row) => !row ||
          !Number.isSafeInteger(row.typeID) || row.typeID <= 0 || !Number.isInteger(row.level) || row.level < 1 || row.level > 5) ||
        !selections || typeof selections !== "object" ||
        Array.isArray(selections) || JSON.stringify(selections).length > 4096) throw trainingError("INVALID_TRAINING_PLAN", "An explicit qualification plan is required.", 400);
    const current = await fresh(account, characterID, selections, targetStage, configurations, role);
    const report = current.read.report;
    const preview = report.previews[mode];
    if (preview.disabled) throw trainingError("SUPPORT_POLICY_UNAVAILABLE", preview.eta.reason);
    if (stage !== preview.stage || hash(targets(displayedTargets)) !== hash(targets(preview.targets)))
      throw trainingError("PLAN_CHANGED", "The displayed plan changed; refresh and review again.");
    const stageReport = report.stages.find((entry) => entry.id === stage);
    const delta = buildQueueDelta(current.sheet, preview.requirements || [], data);
    if (!stageReport || stageReport.fitting.status !== "READY") delta.blockers.push({ code: "FITTING_REVIEW_REQUIRED", message: "The target stage fitting must be accepted and readable.", typeID: null });
    const canApply = delta.blockers.length === 0 && delta.additions.length > 0;
    const expiresAt = now() + ttl;
    let reviewID = null;
    if (canApply) {
      prune(); reviewID = uuid();
      reviews.set(reviewID, { accountID: account.accountID, characterID, selections: structuredClone(selections), mode, stage, targetStage, role, configurations: configurations === undefined ? undefined : structuredClone(configurations),
        delta, expiresAt, version: current.version, queueHash: queueFingerprint(current.sheet), planHash: planFingerprint(report, mode),
        commandID: uuid(), controllerID: `goblin-factory-${uuid()}` });
    }
    return { ...delta, reviewID, expiresAt, mode, stage, canApply, fresh: current.read,
      queue: current.sheet.queue, status: delta.blockers.length ? "BLOCKED" : canApply ? "REVIEW_READY" : "NOTHING_TO_ADD" };
  }
  async function apply(account, { reviewID, confirm }) {
    if (confirm !== true) throw trainingError("CONFIRMATION_REQUIRED", "Explicit Apply confirmation is required.", 400);
    const reviewed = reviews.get(reviewID);
    if (!reviewed || reviewed.accountID !== account.accountID) throw trainingError("REVIEW_REQUIRED", "No review for this account; review again.");
    // One shot, including failures/timeouts; no automatic replay or blind rollback.
    reviews.delete(reviewID);
    if (reviewed.expiresAt <= now()) throw trainingError("REVIEW_REQUIRED", "Review expired; review again.");
    const current = await fresh(account, reviewed.characterID, reviewed.selections, reviewed.targetStage, reviewed.configurations, reviewed.role);
    if (current.version !== reviewed.version || queueFingerprint(current.sheet) !== reviewed.queueHash)
      throw trainingError("QUEUE_CHANGED", "Skills or queue changed since review; nothing was submitted. Refresh and review again.");
    if (planFingerprint(current.read.report, reviewed.mode) !== reviewed.planHash)
      throw trainingError("PLAN_CHANGED", "Stage, fitting or policy changed since review; nothing was submitted.");
    const merged = [...reviewed.delta.existing, ...pairs(reviewed.delta.additions)];
    let writeError = null;
    try {
      await gateway.saveOfflineSkillQueue(account.accountID, reviewed.characterID, {
        type: "offline.skill_queue.save", commandID: reviewed.commandID, controllerID: reviewed.controllerID,
        expectedStateVersion: reviewed.version, payload: { entries: merged, activate: reviewed.delta.activate },
      });
    } catch (error) { writeError = error; }
    // A POST acknowledgement is not confirmation. Always read, including on
    // transport failures (which may have happened after the command committed).
    let after = null;
    let afterSheet = null;
    try {
      afterSheet = await gateway.getSkills(account.accountID, reviewed.characterID);
      after = await loadPilot({ store, gateway, data, account, characterID: reviewed.characterID, selections: reviewed.selections, targetStage: reviewed.targetStage, configurations: reviewed.configurations, role: reviewed.role, sheet: afterSheet });
    }
    catch { /* report unverified, never infer success or retry */ }
    const verified = !writeError && afterSheet && verifyMergedQueue(afterSheet, merged, reviewed.delta.activate, current.sheet);
    const definiteRefusal = writeError && writeError.statusCode >= 400 && writeError.statusCode < 500;
    const result = verified ? "APPLIED" : definiteRefusal ? "REFUSED" : "APPLY_UNVERIFIED";
    return { status: result, verified: Boolean(verified), mode: reviewed.mode, stage: reviewed.stage, at: now(),
      added: verified ? reviewed.delta.additions.length : null, attemptedAdditions: reviewed.delta.additions.length,
      code: writeError?.code || (verified ? null : "APPLY_UNVERIFIED"),
      message: writeError ? "Queue submission was not confirmed. Inspect the authoritative queue and review again; no retry was made." : verified ? "Authoritative queue verified." : "Write acknowledged, but authoritative queue could not be verified. No rollback was attempted.",
      fresh: after?.read || null, queue: afterSheet?.queue || null };
  }
  return { review, apply };
}

module.exports = { buildQueueDelta, queueFingerprint, planFingerprint, verifyMergedQueue, createTrainingQueueService };
