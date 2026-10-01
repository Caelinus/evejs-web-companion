import test from "node:test";
import assert from "node:assert/strict";
import { decodeFleetCenter, decodeFleetInviteNotification } from "../bridge/fleetCenter.ts";
import type { JsonValue } from "../bridge/wire.ts";
import { FLEET_JOIN_ACCEPT_ATTEMPTS } from "./fleetJoinWatch.ts";
import {
  decideMiningSupportFleet, decideMiningSupportFleetMember, freshMiningSupportFleetMemory, miningSupportRecoveryInviter, miningSupportFleetDiagnostic,
  SUPPORT_FLEET_PENDING_MS, SUPPORT_FLEET_INVITE_ATTEMPTS,
  type MiningSupportFleetObservation, type MiningSupportFleetMemory, type MiningSupportFleetFeedback,
} from "./miningSupportFleet.ts";

const S = 140000005, A = 140000002, B = 140000003, F = 999000001;
const managed = { mode: "MANAGED" } as const;
const reads = ["GetInitState", "GetWings", "GetMotd", "GetJoinRequests", "GetFleetComposition"];
const kv = (entries: [string, JsonValue][]): JsonValue => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
// Compact builder-shaped wire values; every membership fact passes the real decoder.
function observation(char: number, fleet: number | null | "unknown", at: number,
  roster = [char], join: Partial<MiningSupportFleetObservation["join"]> = {}, epoch = "run-1"): MiningSupportFleetObservation {
  const cells = fleet === null || fleet === "unknown"
    ? Object.fromEntries(reads.map(name => [name, { error: "CALL_REFUSED", message: fleet === null ? "FleetNotInFleet" : "Gateway unavailable" }]))
    : { GetInitState: { result: kv([["fleetID", fleet], ["members", { type: "dict", entries: roster.map(id => [id, kv([["charID", id], ["role", 0], ["job", 0]])]) }]]) },
      GetWings: { result: { type: "dict", entries: [] } }, GetMotd: { result: "" }, GetJoinRequests: { result: { type: "dict", entries: [] } }, GetFleetComposition: { result: [] } };
  return { scope: { characterID: char, sessionEpoch: epoch }, receivedAtMs: at,
    snapshot: decodeFleetCenter({ ok: true, characterID: char, fleetID: 123, reads: cells } as JsonValue),
    join: { inviteKnown: true, invite: null, ads: [], ...join } };
}
const invite = (fleet: number, at: number) => decodeFleetInviteNotification("OnFleetInvite", [fleet, S, "AskJoinFleet", {}], at);
const support = (own: MiningSupportFleetObservation | null, members: MiningSupportFleetObservation[] = [],
  memory = freshMiningSupportFleetMemory(), ids = members.map(row => row.scope.characterID), feedback?: MiningSupportFleetFeedback, now = own?.receivedAtMs ?? 100) =>
  decideMiningSupportFleet({ own, memberObservations: members, intendedCharacterIDs: ids, policy: managed, nowMs: now, feedback }, memory);
const member = (own: MiningSupportFleetObservation, target = observation(S, F, own.receivedAtMs),
  memory = freshMiningSupportFleetMemory(), feedback?: MiningSupportFleetFeedback) =>
  decideMiningSupportFleetMember({ own, support: target, supportCharacterID: S, policy: managed, nowMs: own.receivedAtMs, feedback }, memory);
const ack = (actionID: number | null, characterID = S, sessionEpoch = "run-1"): MiningSupportFleetFeedback => ({ scope: { characterID, sessionEpoch }, actionID: actionID!, outcome: "acknowledged" });
test("passive fleet evidence distinguishes an attempted invite from ACK and excludes private scope/error text", () => {
  const out = support(observation(S, F, 100), [observation(A, null, 100)]);
  const failed = { actionID: out.actionID!, action: out.action!, finishedAtMs: 101,
    outcome: "unknown" as const, code: "CALL_REFUSED", httpStatus: 409 };
  const evidence = miningSupportFleetDiagnostic(out, 102, failed);
  assert.equal(evidence.state, "inviting");
  assert.equal(evidence.issues[0]?.reason, "member-missing");
  assert.equal(evidence.lastCall?.outcome, "unknown");
  assert.equal(evidence.lastCall?.httpStatus, 409);
  assert.equal(evidence.invites[0]?.outcome, "pending");
  assert.equal(JSON.stringify(evidence).includes("run-1"), false);
  assert.notEqual(evidence.action, out.action);
  assert.notEqual(evidence.lastCall?.action, failed.action);
  const unsafe = miningSupportFleetDiagnostic({ ...out, issues: [{ ...out.issues[0]!, code: "secret URL / session-token" }] }, 103,
    { ...failed, code: "secret URL / session-token" });
  assert.equal(JSON.stringify(unsafe).includes("secret"), false);
  const many = miningSupportFleetDiagnostic({ ...out, memory: { ...out.memory,
    invites: Array.from({ length: 40 }, (_, i) => ({ ...out.memory.invites[0]!, characterID: A + i })) } }, 104, null);
  assert.equal(many.invites.length, 32);
  assert.equal(many.invitesTruncated, true);
  assert.equal(miningSupportFleetDiagnostic(out, 104, { ...failed, outcome: "acknowledged", code: null, httpStatus: null }).lastCall?.outcome, "acknowledged");
});
function reason(result: ReturnType<typeof support>, expected: string) {
  assert.ok(result.issues.some(issue => issue.reason === expected), JSON.stringify(result));
  assert.equal(result.action, null);
}

test("support recovery selects one real surviving member and refuses missing, stale or split authority", () => {
  const own = observation(S, null, 100), a = observation(A, F, 100, [A, B]), b = observation(B, F, 100, [A, B]);
  const select = (rows: MiningSupportFleetObservation[], self = own, now = 100) => miningSupportRecoveryInviter({ own: self,
    intendedCharacterIDs: [B, A], memberObservations: rows, nowMs: now });
  assert.deepEqual(select([b, a]), { state: "ready", characterID: A, fleetID: F });
  assert.equal(select([a, observation(B, null, 100)]).state, "ready");
  assert.equal(select([observation(A, null, 100), observation(B, null, 100)]).state, "not-needed");
  assert.equal(select([a, b], observation(S, F, 100, [S, A, B])).state, "not-needed");
  for (const rows of [[a], [a, b, b], [a, observation(B, "unknown", 100)], [a, observation(B, F, 100, [A])]])
    assert.equal(select(rows).state, "unknown");
  assert.equal(select([a, b], own, 10_100).state, "unknown");
  assert.equal(select([a, observation(B, F + 1, 100)]).state, "conflict");
  const chosen = select([a, b]);
  const out = support(a, [own], freshMiningSupportFleetMemory(), [S]);
  assert.equal(chosen.characterID, A); assert.deepEqual(out.action, { kind: "inviteToFleet", charID: S });
});

test("default/manual policy never creates, invites or joins", () => {
  for (const mode of [undefined, { mode: "EXISTING_ONLY" } as const]) {
    for (const fleet of [null, F]) {
      const out = decideMiningSupportFleet({ own: observation(S, fleet, 100), intendedCharacterIDs: [A], memberObservations: [observation(A, null, 100)], policy: mode, nowMs: 100 }, freshMiningSupportFleetMemory());
      assert.equal(out.action, null);
    }
    const out = decideMiningSupportFleetMember({ own: observation(A, null, 100, [A], { invite: invite(F, 100) }), support: observation(S, F, 100), supportCharacterID: S, policy: mode, nowMs: 100 }, freshMiningSupportFleetMemory());
    assert.equal(out.action, null);
  }
});

test("managed creation requires known absence; ACK waits for authoritative reread", () => {
  const created = support(observation(S, null, 100), [observation(A, null, 100)]);
  assert.deepEqual(created.action, { kind: "createFleet" });
  assert.equal(created.anchorReady, false);
  const waiting = support(observation(S, null, 101), [observation(A, null, 101)], created.memory, [A], ack(created.actionID));
  assert.equal(waiting.state, "waiting"); assert.equal(waiting.action, null); assert.equal(waiting.anchorReady, false);
  const reread = support(observation(S, F, 102), [observation(A, null, 102)], waiting.memory);
  assert.deepEqual(reread.action, { kind: "inviteToFleet", charID: A });
  assert.equal(reread.fleetID, F); assert.equal(reread.anchorReady, true);
  for (const own of [null, observation(S, "unknown", 100), observation(S, null, 0)]) reason(support(own, [], freshMiningSupportFleetMemory(), [], undefined, 10_000), "fleet-state-unknown");
  reason(support(observation(S, null, 100), [], freshMiningSupportFleetMemory(), [A]), "fleet-state-unknown");
  reason(support(observation(S, null, 30_101), [observation(A, null, 30_101)], created.memory, [A], ack(created.actionID)), "create-unconfirmed");
  reason(support(observation(S, null, 101), [observation(A, null, 101)], created.memory, [A], { ...ack(created.actionID), outcome: "refused" }), "create-refused");
});

test("ordinary roster member may invite; own roster gate and deterministic single invite", () => {
  const out = support(observation(S, F, 100, [S, B]), [observation(A, null, 100)], freshMiningSupportFleetMemory(), [B, A, A, S]);
  assert.deepEqual(out.action, { kind: "inviteToFleet", charID: A });
  assert.equal(out.memory.invites.length, 1);
  assert.equal(support(observation(S, F, 100, [S, A, B]), [], freshMiningSupportFleetMemory(), [B, A]).state, "ready");
  reason(support(observation(S, F, 100, [A]), [observation(A, null, 100)]), "invite-authority-missing");
  const sorted = support(observation(S, F, 100), [observation(B, null, 100), observation(A, null, 100)], freshMiningSupportFleetMemory(), [B, A]);
  assert.deepEqual(sorted.action, { kind: "inviteToFleet", charID: A });
  const next = support(observation(S, F, 101), [observation(B, null, 101), observation(A, null, 101)], sorted.memory);
  assert.deepEqual(next.action, { kind: "inviteToFleet", charID: B });
  reason(support(observation(S, F, 100), [observation(B, null, 100), observation(A, null, 100)], sorted.memory), "new-observation-required");
});

test("invite pending, unknown, refused and fresh authoritative notification suppress retries", () => {
  const first = support(observation(S, F, 100), [observation(A, null, 100)]);
  for (const outcome of [undefined, "unknown", "refused"] as const) {
    const out = support(observation(S, F, 40_000), [observation(A, null, 40_000)], first.memory, [A], outcome && { ...ack(first.actionID), outcome });
    reason(out, outcome === "refused" ? "invite-refused" : "invite-unconfirmed");
  }
  reason(support(observation(S, F, 101), [observation(A, null, 101)], first.memory, [A], ack(first.actionID)), "invite-pending");
  reason(support(observation(S, F, 40_000), [observation(A, null, 40_000, [A], { invite: invite(F, 39_999) })], first.memory, [A], ack(first.actionID)), "invite-pending");
  reason(support(observation(S, F, 40_000), [observation(A, null, 40_000, [A], { inviteKnown: false })], first.memory, [A], ack(first.actionID)), "invite-pending");
});

test("acknowledged invite retries require cooldown and fresh reads and stop at the bound", () => {
  let out = support(observation(S, F, 100), [observation(A, null, 100)]);
  for (let attempt = 2; attempt <= SUPPORT_FLEET_INVITE_ATTEMPTS; attempt++) {
    const at = 100 + (attempt - 1) * SUPPORT_FLEET_PENDING_MS;
    out = support(observation(S, F, at), [observation(A, null, at)], out.memory, [A], ack(out.actionID));
    assert.deepEqual(out.action, { kind: "inviteToFleet", charID: A });
    assert.equal(out.memory.invites[0]!.attempts, attempt);
  }
  reason(support(observation(S, F, 100_000), [observation(A, null, 100_000)], out.memory, [A], ack(out.actionID)), "invite-retry-exhausted");
  const joined = support(observation(S, F, 100_001, [S, A]), [], out.memory, [A]);
  assert.equal(joined.state, "ready"); assert.equal(joined.memory.invites.length, 0);
});

test("an expired matching invitation cannot strand the support/member handshake", () => {
  const first = support(observation(S, F, 100), [observation(A, null, 100)]);
  const old = invite(F, 100);
  const beforeExpiry = observation(A, null, 60_099, [A], { invite: old });
  reason(support(observation(S, F, 60_099), [beforeExpiry], first.memory, [A], ack(first.actionID)), "invite-pending");
  assert.deepEqual(member(beforeExpiry).action, { kind: "acceptFleetInvite", fleetID: F });
  const expired = observation(A, null, 60_100, [A], { invite: old });
  assert.equal(member(expired).action, null, "the member requires a fresh invitation");
  const renewed = support(observation(S, F, 60_100), [expired], first.memory, [A], ack(first.actionID));
  assert.deepEqual(renewed.action, { kind: "inviteToFleet", charID: A });
  assert.equal(renewed.memory.invites[0]!.attempts, 2);
  const freshInvite = observation(A, null, 60_101, [A], { invite: invite(F, 60_101) });
  assert.deepEqual(member(freshInvite).action, { kind: "acceptFleetInvite", fleetID: F });
  reason(support(observation(S, F, 60_101), [freshInvite], renewed.memory, [A], ack(renewed.actionID)), "invite-pending");
  assert.equal(support(observation(S, F, 60_102, [S, A]), [], renewed.memory, [A]).state, "ready");
  const unknown = observation(A, null, 60_100, [A], { inviteKnown: false, invite: old });
  reason(support(observation(S, F, 60_100), [unknown], first.memory, [A], ack(first.actionID)), "invite-pending");
});

test("member readiness requires exact fleet and own roster; other fleet is never left", () => {
  assert.equal(member(observation(A, F, 100)).state, "ready");
  reason(member(observation(A, F + 1, 100)), "member-in-other-fleet");
  reason(member(observation(A, F, 100, [S])), "fleet-state-unknown");
  reason(support(observation(S, F, 100), [observation(A, F + 1, 100)]), "member-in-other-fleet");
  reason(member(observation(A, null, 100, [A], { inviteKnown: false })), "invite-state-unknown");
});

test("invitation accept ACK requires membership reread; same read never emits again", () => {
  const first = member(observation(A, null, 100, [A], { invite: invite(F, 100) }));
  assert.deepEqual(first.action, { kind: "acceptFleetInvite", fleetID: F });
  const pending = member(observation(A, null, 101), observation(S, F, 101), first.memory, ack(first.actionID, A));
  reason(pending, "join-pending"); assert.notEqual(pending.state, "ready");
  assert.equal(member(observation(A, F, 102), observation(S, F, 102), pending.memory).state, "ready");
});

test("accept retry needs a renewed invitation and cooldown, then exhausts its bound", () => {
  let out = member(observation(A, null, 100, [A], { invite: invite(F, 100) }));
  reason(member(observation(A, null, 40_000, [A], { invite: invite(F, 100) }), observation(S, F, 40_000), out.memory, ack(out.actionID, A)), "join-unconfirmed");
  reason(member(observation(A, null, 101, [A], { invite: invite(F, 101) }), observation(S, F, 101), out.memory, ack(out.actionID, A)), "join-pending");
  for (let attempt = 2; attempt <= FLEET_JOIN_ACCEPT_ATTEMPTS; attempt++) {
    const at = 100 + (attempt - 1) * SUPPORT_FLEET_PENDING_MS;
    out = member(observation(A, null, at, [A], { invite: invite(F, at) }), observation(S, F, at), out.memory, ack(out.actionID, A));
    assert.deepEqual(out.action, { kind: "acceptFleetInvite", fleetID: F });
  }
  const at = 100 + FLEET_JOIN_ACCEPT_ATTEMPTS * SUPPORT_FLEET_PENDING_MS;
  reason(member(observation(A, null, at, [A], { invite: invite(F, at) }), observation(S, F, at), out.memory, ack(out.actionID, A)), "join-unconfirmed");
});

test("advertised exact ID follows apply -> invited -> accept -> authoritative ready", () => {
  const ad = { fleetID: F, fleetName: "Arbitrary operation", numMembers: 1 };
  const first = member(observation(A, null, 100, [A], { ads: [ad] }));
  assert.deepEqual(first.action, { kind: "applyToJoinFleet", fleetID: F });
  const feedback = { ...ack(first.actionID, A), applicationOutcome: "invited" as const };
  reason(member(observation(A, null, 100), observation(S, F, 100), first.memory, feedback), "new-observation-required");
  const accept = member(observation(A, null, 101), observation(S, F, 101), first.memory, feedback);
  assert.deepEqual(accept.action, { kind: "acceptFleetInvite", fleetID: F });
  reason(member(observation(A, null, 102), observation(S, F, 102), accept.memory, ack(accept.actionID, A)), "join-pending");
  assert.equal(member(observation(A, F, 103), observation(S, F, 103), accept.memory).state, "ready");
  for (const applicationOutcome of [undefined, "unknown", "needs-approval"] as const) {
    const out = member(observation(A, null, 40_000), observation(S, F, 40_000), first.memory, { ...ack(first.actionID, A), applicationOutcome });
    reason(out, applicationOutcome === "needs-approval" ? "join-approval-required" : "invite-state-unknown");
  }
  reason(member(observation(A, null, 101), observation(S, F, 101), first.memory, { ...ack(first.actionID, A), outcome: "refused" }), "join-refused");
  assert.equal(member(observation(A, null, 100, [A], { ads: [{ ...ad, fleetID: F + 1 }] })).action, null);
});

test("disconnect does not restore membership: surviving fleet protects against split creation", () => {
  const before = support(observation(S, F, 100, [S, A]), [], freshMiningSupportFleetMemory(), [A]);
  const returned = support(observation(S, null, 101), [observation(A, F, 101)], before.memory);
  reason(returned, "surviving-fleet-conflict"); assert.equal(returned.state, "recovery-required"); assert.equal(returned.anchorReady, false);
  const safe = support(observation(S, null, 102, [S], { invite: invite(F, 102) }), [observation(A, F, 102)], before.memory);
  assert.deepEqual(safe.action, { kind: "acceptFleetInvite", fleetID: F });
  reason(support(observation(S, null, 103), [observation(A, F, 103)], safe.memory, [A], ack(safe.actionID)), "join-pending");
  reason(support(observation(S, null, 101), [observation(A, F, 101), observation(B, F + 1, 101)], before.memory, [A, B]), "surviving-fleet-conflict");
  reason(support(observation(S, null, 101), [observation(A, F + 1, 101)], before.memory), "surviving-fleet-conflict");
  const advertised = support(observation(S, null, 102, [S], { ads: [{ fleetID: F, fleetName: "Recovery", numMembers: 1 }] }), [observation(A, F, 102)], before.memory);
  assert.deepEqual(advertised.action, { kind: "applyToJoinFleet", fleetID: F });
  reason(support(observation(S, null, 101), [observation(A, "unknown", 101)], before.memory), "fleet-state-unknown");
  reason(support(observation(S, null, 101), [observation(A, null, 101), observation(A, null, 101)], before.memory), "fleet-state-unknown");
  const recreated = support(observation(S, null, 102), [observation(A, null, 102)], before.memory);
  assert.deepEqual(recreated.action, { kind: "createFleet" });
  const confirmed = support(observation(S, F + 1, 103, [S, A]), [observation(A, F + 1, 103)], recreated.memory);
  assert.equal(confirmed.state, "ready"); assert.equal(confirmed.fleetID, F + 1); assert.equal(confirmed.memory.lastFleetID, F + 1);
});

test("run/session scope resets pending history and identities cannot be spoofed", () => {
  const first = support(observation(S, F, 100), [observation(A, null, 100)]);
  const memory: MiningSupportFleetMemory = { ...first.memory, lastFleetID: F };
  const newSession = support(observation(S, null, 101, [S], {}, "run-2"), [observation(A, null, 101)], memory);
  assert.deepEqual(newSession.action, { kind: "createFleet" });
  assert.equal(newSession.actionID, 1); assert.equal(newSession.memory.lastFleetID, null); assert.equal(newSession.memory.invites.length, 0);
  reason(support({ ...observation(S, F, 100), scope: { characterID: A, sessionEpoch: "run-1" } }), "fleet-state-unknown");
  reason(member(observation(A, null, 100), observation(B, F, 100)), "fleet-state-unknown");
  reason(support(observation(S, F, 100), [], freshMiningSupportFleetMemory(), [NaN]), "invalid-intended-member");
});

test("mutation vocabulary contains only source-proven non-destructive actions and needs no hull or coordinator", () => {
  const outputs = [support(observation(S, null, 100)), support(observation(S, F, 100), [observation(A, null, 100)]),
    member(observation(A, null, 100, [A], { invite: invite(F, 100) })),
    member(observation(A, null, 100, [A], { ads: [{ fleetID: F, fleetName: "Any name", numMembers: 1 }] }))];
  assert.deepEqual(outputs.map(out => out.action?.kind), ["createFleet", "inviteToFleet", "acceptFleetInvite", "applyToJoinFleet"]);
  for (const out of outputs) { assert.ok(out.action && !Array.isArray(out.action)); assert.equal(typeof out.actionID, "number"); }
});

test("feedback correlates both pilot and epoch when action IDs restart", () => {
  const old = support(observation(S, null, 100));
  const restarted = support(observation(S, null, 101, [S], {}, "run-2"), [], old.memory);
  assert.equal(old.actionID, 1); assert.equal(restarted.actionID, 1);
  for (const feedback of [ack(1), { ...ack(1), outcome: "refused" as const }, ack(1, A, "run-2"), ack(999, S, "run-2")]) {
    const out = support(observation(S, null, 102, [S], {}, "run-2"), [], restarted.memory, [], feedback);
    assert.equal(out.memory.order?.outcome, "pending"); assert.equal(out.action, null);
  }
  const matching = support(observation(S, null, 102, [S], {}, "run-2"), [], restarted.memory, [], ack(1, S, "run-2"));
  assert.equal(matching.memory.order?.outcome, "acknowledged"); assert.equal(matching.action, null);

  const ads = [{ fleetID: F, fleetName: "Any operation", numMembers: 1 }];
  const oldApply = member(observation(A, null, 100, [A], { ads }));
  const newApply = member(observation(A, null, 101, [A], { ads }, "run-2"), observation(S, F, 101), oldApply.memory);
  assert.equal(oldApply.actionID, 1); assert.equal(newApply.actionID, 1);
  const late = member(observation(A, null, 102, [A], { ads }, "run-2"), observation(S, F, 102), newApply.memory,
    { ...ack(1, A), applicationOutcome: "invited" });
  reason(late, "invite-state-unknown"); assert.equal(late.memory.order?.outcome, "pending");
  const current = member(observation(A, null, 103, [A], { ads }, "run-2"), observation(S, F, 103), late.memory,
    { ...ack(1, A, "run-2"), applicationOutcome: "invited" });
  assert.deepEqual(current.action, { kind: "acceptFleetInvite", fleetID: F });
});
