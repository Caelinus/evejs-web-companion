"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../src/server");
const gatewayClient = require("../src/eveGatewayClient");

test("HTTP review/apply are ownership scoped, confirmation gated and use no selected-session or bot-host path", async (t) => {
  const account = { username: "BMiner9", accountID: 4, banned: false };
  const corp = 98000001; const characterID = 7;
  let version = "epoch.0"; const calls = [];
  const sheet = { characterID, serverNowMs: 1_800_000_000_000, characterName: "Miner",
    skills: [{ typeID: 3386, level: 1, skillPoints: 250 }, { typeID: 11, level: 0, skillPoints: 0 }],
    queue: { active: false, maxEntries: 150, entries: [{ typeID: 11, toLevel: 1 }] } };
  const fit = { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
    ["fittingID", 7], ["ownerID", corp], ["shipTypeID", 32880], ["name", "Venture"],
    ["savedDate", { type: "long", value: "134285151537020000" }],
    ["fitData", { type: "list", items: [{ type: "tuple", items: [483, 27, 2] }] }],
  ] } };
  const library = { type: "dict", entries: [[7, fit]] };
  const instance = createApp({
    webAuth: { verifySessionToken: (token) => ["owner", "other"].includes(token) ? { username: token === "owner" ? "BMiner9" : "Other", accountID: token === "owner" ? 4 : 5 } : null },
    eveStore: { async getAccount(name) { return { ...account, username: name, accountID: name === "BMiner9" ? 4 : 5 }; },
      async listCharactersForAccount(id) { return id === 4 ? [{ accountID: 4, characterID, corporationID: corp, characterName: "Miner" }] : []; },
      async getCharacterForAccount() { assert.fail("No broad snapshot"); } },
    eveGatewayClient: {
      async getCharacterStatus(id, charID) {
        calls.push("status");
        if (id !== 4 || charID !== characterID) throw Object.assign(new Error("Not owned"), { code: "CHARACTER_ACCOUNT_MISMATCH", statusCode: 403 });
        return { characterID, controlState: "offline", online: false, stateVersion: version };
      },
      async getSkills(id, charID) { assert.equal(id, 4); assert.equal(charID, characterID); calls.push("skills"); return structuredClone(sheet); },
      async callMethod(service, method, args, kwargs, session, bridgeSessionID) {
        assert.equal(service, "corpFittingMgr"); assert.equal(method, "GetFittings");
        assert.equal(session.corpid, corp); assert.equal(bridgeSessionID, undefined);
        return { result: library };
      },
      async saveOfflineSkillQueue(id, charID, command) {
        calls.push("write"); assert.equal(id, 4); assert.equal(charID, characterID);
        assert.equal(command.expectedStateVersion, version);
        assert.deepEqual(command.payload.entries, [{ typeID: 11, toLevel: 1 }, { typeID: 3386, toLevel: 2 }, { typeID: 3386, toLevel: 3 }]);
        assert.equal(command.payload.activate, false, "paused prefix remains paused");
        assert.equal(command.type, "offline.skill_queue.save");
        version = "epoch.1"; sheet.queue.entries = command.payload.entries;
      },
      async selectCharacter() { assert.fail("No pilot selection"); },
      async readSpaceSnapshot() { assert.fail("No space snapshot"); },
    },
    botHost: { claimedBy() { assert.fail("No bot claim"); }, launch() { assert.fail("No bot launch"); } },
    staticData: { getType: id => ({ typeID: id }), getSkillType: id => ({ typeID: id, name: `Skill ${id}` }),
      getTypeDogma: id => ({ attributes: id === 32880 ? { 182: 3386, 277: 3 } : {} }) }, errorLogger() {},
  });
  const server = instance.listen(0, "127.0.0.1"); t.after(() => server.close()); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, token = "owner") => fetch(`${base}/api/pilot-training/queue/${route}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const read = async (selections = {}) => (await fetch(`${base}/api/pilot-training/miner?characterID=7&selections=${encodeURIComponent(JSON.stringify(selections))}`,
    { headers: { authorization: "Bearer owner" } })).json();
  const first = await read(); assert.equal(first.ok, true);
  const saved = first.fittings[0];
  const selections = { VENTURE: { scope: "CORPORATION", ownerID: corp, fittingID: 7, acceptedSavedDate: saved.savedDate, acceptedFingerprint: saved.fingerprint } };
  const pilot = await read(selections); const preview = pilot.report.previews.FAST;
  const request = { role: "MINER", characterID, mode: "FAST", stage: preview.stage, displayedTargets: preview.targets, selections };
  assert.equal((await post("review", request, "other")).status, 403);
  assert.equal((await post("review", request, "invalid")).status, 401);
  const response = await post("review", request); assert.equal(response.status, 200);
  const { review } = await response.json(); assert.equal(review.canApply, true, JSON.stringify(review.blockers));
  assert.equal((await post("apply", { reviewID: review.reviewID, confirm: true }, "other")).status, 409);
  assert.equal((await post("apply", { reviewID: review.reviewID })).status, 400);
  assert.equal(calls.includes("write"), false);
  const applied = await post("apply", { reviewID: review.reviewID, confirm: true });
  assert.equal(applied.status, 200); const outcome = (await applied.json()).outcome;
  assert.equal(outcome.status, "APPLIED"); assert.equal(outcome.verified, true); assert.equal(outcome.added, 2);
  assert.ok(calls.slice(calls.indexOf("write") + 1).includes("skills"));
  assert.equal((await post("apply", { reviewID: review.reviewID, confirm: true })).status, 409);
  assert.equal(calls.filter((entry) => entry === "write").length, 1);
  assert.equal(instance.locals.bridgeSessions.size, 0);
});

test("gateway adapter uses flat character-status and exact offline command payload once", async (t) => {
  const original = global.fetch; t.after(() => { global.fetch = original; });
  const calls = []; const command = { type: "offline.skill_queue.save", commandID: "review-command", controllerID: "goblin-factory-test-controller",
    expectedStateVersion: "epoch.1", payload: { entries: [{ typeID: 3386, toLevel: 1 }], activate: true } };
  global.fetch = async (input, init) => {
    calls.push([String(input), init]);
    return Response.json({ source: "evejs-web-gateway", apiVersion: 1, ok: true,
      characterID: 7, online: false, controlState: "offline", stateVersion: "epoch.1" });
  };
  const status = await gatewayClient.getCharacterStatus(4, 7);
  assert.equal(status.stateVersion, "epoch.1"); assert.equal(status.control, undefined);
  await gatewayClient.saveOfflineSkillQueue(4, 7, command);
  assert.match(calls[0][0], /\/character-status\?accountID=4&characterID=7$/);
  assert.match(calls[1][0], /\/skill-queue$/); assert.equal(calls[1][1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1][1].body), { accountID: 4, characterID: 7, command }); assert.equal(calls.length, 2);
});
