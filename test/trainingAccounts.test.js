"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { once } = require("node:events");
const { createTrainingAccounts } = require("../src/trainingAccounts");
const { createCreationAttemptJournal } = require("../src/creationAttemptJournal");
const { createApp } = require("../src/server");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
function fixture({ present = false, fail = false, persist = true } = {}) {
  let account = present ? { username: "NewPilot", accountID: 8 } : null;
  const calls = [];
  const store = {
    async getAccount(name) { calls.push(["read", name]); return account; },
    async createAccount(name) { calls.push(["create", name]); if (persist) account = { username: name, accountID: 8 }; if (fail) throw new Error("lost response"); return { account, created: true }; },
  };
  return { store, calls, service: createTrainingAccounts({ store }) };
}
test("new account uses existing owner create exactly once, with preflight and authoritative reread", async () => {
  const f = fixture();
  const result = await f.service.create({ username: "NewPilot", confirm: true, accountID: 999, role: "admin", password: "never-forward" });
  assert.equal(result.status, "ACCOUNT_CREATED"); assert.equal(result.account.accountID, 8);
  assert.deepEqual(f.calls, [["read", "NewPilot"], ["create", "NewPilot"], ["read", "NewPilot"]]);
  await assert.rejects(f.service.create({ username: "NewPilot", confirm: true }), { code: "ACCOUNT_EXISTS" });
  assert.equal(f.calls.filter(([verb]) => verb === "create").length, 1);
});
test("case-sensitive identities stay distinct; completed attempts do not consume pending capacity", async () => {
  const accounts = new Map(); let writes = 0;
  const service = createTrainingAccounts({ store: {
    async getAccount(name) { return accounts.get(name) ?? null; },
    async createAccount(name) { const account = { username: name, accountID: ++writes }; accounts.set(name, account); return { account, created: true }; },
  } });
  for (const username of ["Pilot", "pilot", ...Array.from({ length: 1001 }, (_, i) => `T${i}`)]) {
    const value = await service.create({ username, confirm: true }); assert.equal(value.account.username, username);
  }
  assert.equal(writes, 1003);
});
test("existing account, malformed name and missing confirmation cannot dispatch creation", async () => {
  for (const request of [{ username: "NewPilot", confirm: true }, { username: "../bad", confirm: true }, { username: "NewPilot" }]) {
    const f = fixture({ present: true }); await assert.rejects(f.service.create(request)); assert.equal(f.calls.some(([v]) => v === "create"), false);
  }
});
test("ambiguous successful create recovers; absent/unknown completion never resends", async () => {
  const good = fixture({ fail: true }); assert.equal((await good.service.create({ username: "NewPilot", confirm: true })).status, "ACCOUNT_RECOVERED");
  const absent = fixture({ fail: true, persist: false });
  for (let i = 0; i < 3; i++) assert.equal((await absent.service.create({ username: "NewPilot", confirm: true })).status, "RECOVERY_REQUIRED");
  assert.equal(absent.calls.filter(([v]) => v === "create").length, 1);
});
test("ambiguous account creation remains fenced after WC process restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-training-account-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "attempts.json");
  let account = null, writes = 0;
  const store = {
    async getAccount() { return account; },
    async createAccount() { writes++; throw new Error("lost response"); },
  };
  const first = createTrainingAccounts({ store, journal: createCreationAttemptJournal({ filePath }) });
  assert.equal((await first.create({ username: "NewPilot", confirm: true })).status, "RECOVERY_REQUIRED");
  const restarted = createTrainingAccounts({ store, journal: createCreationAttemptJournal({ filePath }) });
  assert.equal((await restarted.create({ username: "NewPilot", confirm: true })).status, "RECOVERY_REQUIRED");
  assert.equal(writes, 1, "restart cannot send a second account creation");
  account = { username: "NewPilot", accountID: 8 };
  assert.equal((await restarted.recover({ username: "NewPilot" })).status, "ACCOUNT_CONFIRMED");
  assert.equal(createCreationAttemptJournal({ filePath }).get("account:NewPilot"), null);
});
test("concurrent clicks share name fence and cannot dispatch twice", async () => {
  const f = fixture(); await Promise.all([f.service.create({ username: "NewPilot", confirm: true }), f.service.create({ username: "NewPilot", confirm: true })]);
  assert.equal(f.calls.filter(([v]) => v === "create").length, 1);
});
test("unreadable availability refuses before mutation; disabled gateway is surfaced safely", async () => {
  let writes = 0;
  const unavailable = createTrainingAccounts({ store: { async getAccount() { throw new Error("offline"); }, async createAccount() { writes++; } } });
  await assert.rejects(unavailable.create({ username: "NewPilot", confirm: true }), { code: "ACCOUNT_READ_UNAVAILABLE" }); assert.equal(writes, 0);
  const disabled = createTrainingAccounts({ store: { async getAccount() { return null; }, async createAccount() { throw Object.assign(new Error("internal"), { code: "ACCOUNT_CREATE_DISABLED" }); } } });
  await assert.rejects(disabled.create({ username: "NewPilot", confirm: true }), { code: "ACCOUNT_CREATE_DISABLED" });
});
test("explicit account route is separate from login, sets no cockpit cookie and performs no character/session action", async (t) => {
  const f = fixture(); const errors = [];
  const app = createApp({ eveStore: f.store, eveGatewayClient: new Proxy({}, { get() { throw new Error("No gameplay authority permitted"); } }), errorLogger: (e) => errors.push(e) });
  const server = app.listen(0, "127.0.0.1"); t.after(() => server.close()); await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pilot-training/accounts/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "NewPilot", confirm: true }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get("set-cookie"), null); assert.equal((await response.json()).status, "ACCOUNT_CREATED"); assert.deepEqual(errors, []);
});
