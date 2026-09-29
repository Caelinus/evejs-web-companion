import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { continueNewTrainee, readPendingTrainee, pendingTraineeKey, validateTrainee, rememberCreatedAccount } from "./newTrainee.ts";
import { BridgeCallError } from "../bridge/callMethod.ts";
const input = { username: "AccountName", characterName: "Different Pilot", password: "fixture-secret", confirmation: "fixture-secret" };
function fixture() {
  const data = new Map<string, string>(), written: string[] = [], calls: string[] = [];
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem(k: string, v: string) { data.set(k, v); written.push(v); }, removeItem(k: string) { data.delete(k); } };
  const outcome = { status: "ACCOUNT_CONFIRMED" as const, account: { username: input.username, accountID: 9 } };
  const deps = { async create() { calls.push("create"); return outcome; }, async recover() { calls.push("recover"); return outcome; },
    async login(name: string, password: string) { calls.push("login"); assert.equal(name, input.username); assert.equal(password, input.password); return { account: name, token: "memory-token" }; },
    async roster() { calls.push("roster"); return { account: input.username, characters: [] }; } };
  return { data, storage, written, calls, deps, outcome };
}
test("confirmation is required; names can differ; storage contains only recovery names, never password/token", async () => {
  assert.throws(() => validateTrainee({ ...input, confirmation: "wrong" })); assert.throws(() => validateTrainee({ ...input, password: "", confirmation: "" }));
  assert.equal(validateTrainee(input).characterName, "Different Pilot");
  const f = fixture(), result = await continueNewTrainee(input, f.storage, f.deps);
  assert.deepEqual(f.calls, ["create", "login", "roster"]); assert.equal(result.characterName, "Different Pilot");
  assert.equal(f.storage.getItem(pendingTraineeKey), null); assert.doesNotMatch(f.written.join(""), /fixture-secret|memory-token|password|confirmation/);
});
test("lost create response uses authoritative read recovery without a second create", async () => {
  const f = fixture(); f.deps.create = async () => { f.calls.push("create"); throw new Error("lost"); };
  await continueNewTrainee(input, f.storage, f.deps); assert.deepEqual(f.calls, ["create", "recover", "login", "roster"]);
});
test("F5 recovery resumes read only; unknown completion blocks auth and another name", async () => {
  const f = fixture(); f.storage.setItem(pendingTraineeKey, JSON.stringify({ username: input.username, characterName: input.characterName }));
  assert.equal(readPendingTrainee(f.storage)?.username, input.username);
  await continueNewTrainee(input, f.storage, f.deps); assert.deepEqual(f.calls, ["recover", "login", "roster"]);
  const g = fixture(); g.deps.create = async () => { g.calls.push("create"); return { status: "RECOVERY_REQUIRED", account: null } as any; };
  await assert.rejects(continueNewTrainee(input, g.storage, g.deps), /unconfirmed/); assert.deepEqual(g.calls, ["create"]);
  await assert.rejects(continueNewTrainee({ ...input, username: "Alternative" }, g.storage, g.deps), /pending/);
});
test("existing account refusal never silently recreates or authenticates; definitive refusal clears pending marker", async () => {
  const f = fixture(); f.deps.create = async () => { f.calls.push("create"); throw new BridgeCallError("ACCOUNT_EXISTS", "Use existing account", 409); };
  await assert.rejects(continueNewTrainee(input, f.storage, f.deps), /existing/); assert.deepEqual(f.calls, ["create"]); assert.equal(readPendingTrainee(f.storage), null);
});
test("UI clears password on every attempt/cancel; existing creator is reused with a name prefill only", () => {
  const ui = readFileSync(new URL("../ui/NewTrainee.svelte", import.meta.url), "utf8");
  assert.match(ui, /finally \{ password = ""; confirmation = "";/); assert.doesNotMatch(ui, /console\.|localStorage|CreateCharacterWithDoll/);
  const page = readFileSync(new URL("../ui/GoblinFactory.svelte", import.meta.url), "utf8");
  assert.match(page, /<CharacterCreate initialName=\{creatorInitialName\}/); assert.match(page, /Use existing account/); assert.match(page, /\+ New trainee/);
  const creator = readFileSync(new URL("../ui/CharacterCreate.svelte", import.meta.url), "utf8");
  assert.match(creator, /freeSlots > 0/); assert.match(creator, /nameCode === 1/); assert.match(creator, /let name = \$state\(untrack\(\(\) => initialName\)\)/);
});


test("account preference failure cannot prevent authenticated creator handoff", () => {
  const reason = rememberCreatedAccount({ getItem() { throw new Error("corrupt storage"); }, setItem() { throw new Error("quota"); } }, "AccountName");
  assert.match(reason, /authenticated/);
  const page = readFileSync(new URL("../ui/GoblinFactory.svelte", import.meta.url), "utf8");
  const start = page.indexOf("function newAccountReady");
  assert.ok(page.indexOf("credentials.set", start) < page.indexOf("rememberCreatedAccount(localStorage", start));
  assert.match(page, /NewTrainee externalBusy=\{busy\}/);
});
