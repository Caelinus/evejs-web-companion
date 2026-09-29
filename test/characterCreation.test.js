"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCharacterCreation, decodeCreationRoster } = require("../src/characterCreation");
const { createCreationAttemptJournal } = require("../src/creationAttemptJournal");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const kv = (obj) => ({ name: "util.KeyVal", args: { type: "dict", entries: Object.entries(obj) } });
const tuple = (names, slots = 3, userName = "BMiner10") => [
  { type: "list", items: [kv({ characterSlots: slots, userName })] }, null,
  { type: "list", items: names.map((name, i) => kv({ characterID: i + 1, characterName: name })) }, null,
];
const req = { account: { accountID: 41, username: "BMiner10" } };
function harness() {
  let names = [], slots = 3, writes = 0, broken = false;
  const calls = [];
  const service = createCharacterCreation({ call: async (who, service, method) => {
    assert.equal(who.account.accountID, 41); calls.push(method);
    if (broken) throw new Error("unreadable");
    return { result: method === "ValidateNameEx" ? 1 : tuple(names, slots) };
  } });
  return { service, calls, get writes() { return writes; }, setNames(v) { names = v; }, setSlots(v) { slots = v; },
    dispatch: async () => { writes++; names.push("BMiner10"); return { result: names.length }; },
    lost: async () => { writes++; names.push("BMiner10"); throw new Error("timeout"); },
    unknown: async () => { writes++; broken = true; throw new Error("timeout"); }, repair() { broken = false; } };
}
test("slot and account identity fail closed", async () => {
  assert.throws(() => decodeCreationRoster(tuple([], 3, "Other"), req.account), /unreadable/);
  assert.throws(() => decodeCreationRoster(tuple([], null), req.account), /unreadable/);
  const h = harness(); h.setSlots(1); h.setNames(["Existing"]);
  await assert.rejects(h.service.create(req, "BMiner10", h.dispatch), { code: "NO_CHARACTER_SLOT" });
  assert.equal(h.writes, 0);
});
test("creation validates name, dispatches once and proves the resulting character through authoritative roster", async () => {
  const h = harness(); const result = await h.service.create(req, "BMiner10", h.dispatch);
  assert.equal(result.result, 1); assert.equal(h.writes, 1);
  assert.deepEqual(h.calls, ["GetCharacterSelectionData", "ValidateNameEx", "GetCharacterSelectionData"]);
  const again = await h.service.create(req, "BMiner10", h.dispatch);
  assert.equal(again.recovered, true); assert.equal(h.writes, 1);
});
test("lost response recovers the created name without resending; unresolved response stays blocked", async () => {
  const h = harness(); assert.equal((await h.service.create(req, "BMiner10", h.lost)).recovered, true); assert.equal(h.writes, 1);
  const u = harness(); await assert.rejects(u.service.create(req, "BMiner10", u.unknown), { code: "CREATION_UNVERIFIED" });
  u.repair();
  await assert.rejects(u.service.create(req, "Other", u.dispatch), { code: "CREATION_UNVERIFIED" });
  assert.equal(u.writes, 1);
  u.setNames(["BMiner10"]);
  assert.equal((await u.service.state(req)).recoveredCharacterID, 1);
  assert.equal((await u.service.create(req, "BMiner10", u.dispatch)).result, 1); assert.equal(u.writes, 1);
});
test("ambiguous character creation remains fenced after WC process restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-training-character-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "attempts.json");
  let names = [], writes = 0;
  const call = async (_req, _service, method) => ({ result: method === "ValidateNameEx" ? 1 : tuple(names) });
  const dispatch = async () => { writes++; throw new Error("lost response"); };
  const first = createCharacterCreation({ call, attempts: createCreationAttemptJournal({ filePath }) });
  await assert.rejects(first.create(req, "BMiner10", dispatch), { code: "CREATION_UNVERIFIED" });
  const restarted = createCharacterCreation({ call, attempts: createCreationAttemptJournal({ filePath }) });
  await assert.rejects(restarted.create(req, "BMiner10", dispatch), { code: "CREATION_UNVERIFIED" });
  assert.equal(writes, 1, "restart cannot send a second character creation");
  names = ["BMiner10"];
  assert.equal((await restarted.state(req)).recoveredCharacterID, 1);
  assert.equal(createCreationAttemptJournal({ filePath }).get("character:41"), null);
});
test("concurrent creation on the same account cannot dispatch twice", async () => {
  const h = harness(); let finish;
  const pending = h.service.create(req, "BMiner10", () => new Promise((resolve) => { finish = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(h.service.create(req, "BMiner10", h.dispatch), { code: "CREATION_PENDING" });
  h.setNames(["BMiner10"]); finish({ result: 1 }); await pending; assert.equal(h.writes, 0);
});
