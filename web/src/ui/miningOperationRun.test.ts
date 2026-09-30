import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import type { MiningOperationRuntime } from "../app/api.ts";
import { miningOperationRunView, operationMemberRecovery } from "../app/miningOperationRunView.ts";
import { hostedRunPolicy } from "../bots/hostedRunPolicy.ts";
import { createControlPlanePoll } from "../app/controlPlanePoll.ts";
register("./svelteSsrHook.ts", import.meta.url);
const { render } = await import("svelte/server");
const Run = (await import("./MiningOperationRun.svelte")).default;
const policy = hostedRunPolicy();
const start = "2026-09-27T00:00:00.000Z";
function runtime(): MiningOperationRuntime {
  return { operationID: "A", state: "MINING", observedAt: "2026-09-27T12:00:00.000Z", recoveryRequired: false,
    startedAt: start, stoppedAt: null, currentTarget: null, history: [], logisticsTail: [], rendezvous: null, stopFailures: [],
    members: [1, 2, 3].map(characterID => ({ characterID, characterName: `P${characterID}`, accountName: "test", role: characterID === 3 ? "HAULER" : "MINER", automationID: "",
      botID: `b${characterID}`, runtimeState: "running", phase: "Working", reason: null, hosted: true, hostStartedAt: start,
      expiresAt: "2026-09-28T00:00:00.000Z", maxRuntimeMinutes: 1440 })) };
}
function markup(value = runtime(), over = {}): string {
  return render(Run as never, { props: { runtime: value, policy, onExtend: () => {}, ...over } } as never).body;
}

test("server timing survives reload and ignores a skewed browser clock", t => {
  const value = runtime(), before = JSON.stringify(value);
  t.mock.method(Date, "now", () => 0);
  const first = miningOperationRunView(value, policy, false);
  t.mock.method(Date, "now", () => 9e12);
  assert.deepEqual(miningOperationRunView(JSON.parse(before), policy, false), first);
  assert.equal(first.remainingMs, 12 * 3_600_000);
  assert.equal(JSON.stringify(value), before);
  for (const words of ["Started:", "Expires:", "Remaining:", "12h 0m", "Server state"]) assert.ok(markup(value).includes(words));
});

test("earliest hosted required member includes hauler; mixed expiries and unavailable timing are honest", () => {
  const value = runtime(); const members = value.members.map(member => member.characterID === 3 ? { ...member, expiresAt: "2026-09-27T18:00:00.000Z" } : member);
  const view = miningOperationRunView({ ...value, members }, policy, false);
  assert.equal(view.remainingMs, 6 * 3_600_000); assert.equal(view.groups.length, 2);
  assert.deepEqual(view.groups[0]?.names, ["P3"]);
  const mixed = { ...value, members: members.map(member => member.characterID === 1 ? { ...member, expiresAt: null } : member) };
  assert.match(miningOperationRunView(mixed, policy, false).warnings.join(), /incomplete/);
  assert.equal(miningOperationRunView({ ...value, observedAt: undefined }, policy, false).remainingMs, null);
});

test("healthy sequential grants stay compact; meaningful mismatch and partial grants stay visible", () => {
  const value = runtime();
  const staggered = { ...value, members: value.members.map((member, i) => ({ ...member,
    expiresAt: new Date(Date.parse(member.expiresAt!) + i * 60_000).toISOString() })) };
  assert.equal(miningOperationRunView(staggered, policy, false).expiresAt, value.members[0]!.expiresAt);
  const html = markup(staggered);
  assert.match(html, /Hosted:/); assert.match(html, /3 \/ 3/);
  assert.doesNotMatch(html, /Grant mismatch|member\(s\) expire|<details open/);
  assert.match(html, /Member grants \/ recovery/);
  const mismatch = { ...value, members: value.members.map((member, i) => i ? member : { ...member, expiresAt: "2026-09-29T00:00:00.000Z" }) };
  assert.match(markup(mismatch), /Grant mismatch:.*Earliest.*Latest/);
  const partial = { ...value, state: "DEGRADED", members: value.members.map((member, i) => i ? member : { ...member, hosted: false, runtimeState: "FAILED" }) };
  assert.match(markup(partial), /1 member\(s\) not hosted/);
  const capped = { ...value, members: value.members.map((member, i) => i ? member : { ...member, maxRuntimeMinutes: policy.maxRuntimeMinutes }) };
  assert.match(markup(capped), /extension can only be partial/);
});

test("extension choices use configured cap, only eligible members count, and maximum is explicit", () => {
  const value = runtime();
  assert.ok(miningOperationRunView(value, policy, false).choices.some(choice => choice.minutes === 1440));
  assert.deepEqual(miningOperationRunView(value, hostedRunPolicy(24), false).choices, []);
  assert.match(markup(value, { policy: hostedRunPolicy(24) }), /Maximum hosted runtime reached: 24 hours/);
  const mixed = { ...value, state: "DEGRADED", members: value.members.map((member, i) => i === 0 ? member : { ...member, hosted: false, runtimeState: "FAILED" }) };
  assert.equal(miningOperationRunView(mixed, policy, false).choices.find(choice => choice.minutes === 1440)?.count, 1);
  for (const state of ["STOPPING", "PARKING", "PARKING_FAILED", "STOPPED"]) assert.deepEqual(miningOperationRunView({ ...value, state }, policy, false).choices, []);
  assert.doesNotMatch(markup(value), /Until stopped/);
});

test("near-expiry and Parking warn without a travel-time promise; stale view is labeled", () => {
  const value = { ...runtime(), observedAt: "2026-09-27T23:52:00.000Z" };
  const html = markup(value, { parking: true, stale: true });
  assert.match(html, /0h 8m/); assert.match(html, /Grant expires soon/); assert.match(html, /Parking must complete/);
  assert.match(html, /Last known server state/); assert.match(html, /does not guarantee arrival/);
  const expired = { ...value, observedAt: "2026-09-28T00:01:00.000Z" };
  assert.match(markup(expired), /deadline reached/);
  assert.deepEqual(miningOperationRunView(expired, policy, false).choices, []);
});

test("recovered projection explains DRAFT miners, hosted waiting hauler and explicit scoped Stop then Start", () => {
  const value = { ...runtime(), state: "DEGRADED", recoveryRequired: true,
    members: runtime().members.map(member => member.role === "MINER" ? { ...member, hosted: false, runtimeState: "DRAFT", lastHostReason: "Could not restart safely" } : member) };
  const html = markup(value, { parking: true });
  for (const text of ["RECOVERED_UNKNOWN", "intentionally discarded", "not automatically resumed", "requires fresh Start", "Recovered hosted member", "waiting for a trusted target", "Unavailable members can block"]) assert.ok(html.includes(text), text);
  assert.match(operationMemberRecovery({ ...value.members[0]!, runtimeState: "FAILED" }, true), /Unavailable/);
  const component = readFileSync(new URL("./MiningOperationRun.svelte", import.meta.url), "utf8");
  assert.doesNotMatch(component, /startMiningOperation|stopMiningOperation|setInterval|setTimeout|readSpaceSnapshot/);
  const parent = readFileSync(new URL("./MiningOperations.svelte", import.meta.url), "utf8");
  assert.match(parent, /Stop recovered operation/);
  assert.match(parent, /Extension incomplete:/); assert.match(parent, /extensionResults\[row.definition.operationID\]/);
});

test("401 preserves timing; normal reconnect replaces it with server state without hosted mutation", async () => {
  let value = runtime(), expired = false, last = value;
  const poll = createControlPlanePoll({ read: async () => { if (expired) throw { status: 401 }; return structuredClone(value); },
    received: next => { last = next; }, failed: () => {}, schedule: () => 1, cancel: () => {} });
  await poll.refresh(); expired = true; await poll.refresh();
  assert.equal(last.state, "MINING"); assert.equal(last.startedAt, start);
  value = { ...value, observedAt: "2026-09-27T13:00:00.000Z" }; expired = false;
  await poll.reconnect(); poll.stop();
  assert.equal(last.startedAt, start); assert.equal(last.members[0]?.botID, "b1");
  assert.equal(miningOperationRunView(last, policy, false).remainingMs, 11 * 3_600_000);
});
