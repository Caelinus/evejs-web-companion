import type { FleetCenterSnapshot, FleetPendingInvite } from "../bridge/fleetCenter.ts";
import { canBroadcastInFleet } from "../bridge/fleetCommand.ts";
import { FLEET_JOIN_ACCEPT_ATTEMPTS } from "./fleetJoinWatch.ts";
import type { FleetAdRow } from "./scriptConditions.ts";
import type { FleetApplyOutcome } from "../bridge/fleetWrites.ts";
import type { SupportFleetRoster } from "./miningSupportAnchor.ts";

export const SUPPORT_FLEET_READ_MAX_AGE_MS = 10_000;
export const SUPPORT_FLEET_PENDING_MS = 30_000;
export const SUPPORT_FLEET_INVITE_ATTEMPTS = 3;
export interface MiningSupportFleetPolicy { readonly mode: "EXISTING_ONLY" | "MANAGED" }
export const MANUAL_SUPPORT_FLEET_POLICY: MiningSupportFleetPolicy = { mode: "EXISTING_ONLY" };
export interface SupportFleetScope { readonly characterID: number; readonly sessionEpoch: string }
export interface SupportFleetJoinAuthority {
  /** Notification state from THIS pilot's session; unknown is not no invite. */
  readonly inviteKnown: boolean;
  readonly invite: FleetPendingInvite | null;
  /** Existing finder listing filtered for THIS pilot. Names are not identity. */
  readonly ads: readonly FleetAdRow[] | null;
}
export interface MiningSupportFleetObservation {
  readonly scope: SupportFleetScope;
  readonly snapshot: FleetCenterSnapshot;
  readonly receivedAtMs: number;
  readonly join: SupportFleetJoinAuthority;
}
export type MiningSupportFleetAction =
  | { readonly kind: "createFleet" }
  | { readonly kind: "inviteToFleet"; readonly charID: number }
  | { readonly kind: "applyToJoinFleet"; readonly fleetID: number }
  | { readonly kind: "acceptFleetInvite"; readonly fleetID: number };
export interface MiningSupportFleetFeedback {
  readonly scope: SupportFleetScope;
  readonly actionID: number;
  readonly outcome: "acknowledged" | "refused" | "unknown";
  readonly code?: string | null;
  /** Only the apply's source response can supply this; ACK alone cannot. */
  readonly applicationOutcome?: FleetApplyOutcome;
}
interface Pending {
  readonly actionID: number;
  readonly action: MiningSupportFleetAction;
  readonly issuedAtMs: number;
  readonly readAtMs: number;
  readonly outcome: "pending" | MiningSupportFleetFeedback["outcome"];
  readonly code: string | null;
  readonly applicationOutcome: FleetApplyOutcome | null;
  readonly inviteProofMs: number | null;
}
interface InviteMemory { readonly characterID: number; readonly fleetID: number; readonly attempts: number; readonly pending: Pending }
export interface MiningSupportFleetMemory {
  readonly scope: SupportFleetScope | null;
  /** Run-local history, never proof of current membership or fleet survival. */
  readonly lastFleetID: number | null;
  readonly nextActionID: number;
  readonly lastActionReadAtMs: number | null;
  readonly order: Pending | null;
  readonly joinAttempts: number;
  readonly invites: readonly InviteMemory[];
}
export const freshMiningSupportFleetMemory = (): MiningSupportFleetMemory => ({ scope: null, lastFleetID: null,
  nextActionID: 1, lastActionReadAtMs: null, order: null, joinAttempts: 0, invites: [] });
export type MiningSupportFleetReason = "fleet-state-unknown" | "support-not-in-fleet" | "member-missing" |
  "member-in-other-fleet" | "invite-pending" | "join-pending" | "invite-authority-missing" |
  "surviving-fleet-conflict" | "create-refused" | "join-refused" | "invite-refused" |
  "create-unconfirmed" | "invite-unconfirmed" | "join-unconfirmed" | "invite-retry-exhausted" |
  "invite-state-unknown" | "join-approval-required" | "new-observation-required" | "invalid-intended-member";
export interface MiningSupportFleetIssue { readonly reason: MiningSupportFleetReason; readonly characterID: number | null; readonly fleetID: number | null; readonly code: string | null }
export interface MiningSupportFleetResult {
  readonly role: "support" | "member";
  readonly state: "ready" | "waiting" | "creating" | "inviting" | "joining" | "degraded" | "blocked" | "recovery-required";
  readonly issues: readonly MiningSupportFleetIssue[];
  readonly fleetID: number | null;
  readonly anchorReady: boolean;
  readonly observedAtMs: number | null;
  readonly action: MiningSupportFleetAction | null;
  readonly actionID: number | null;
  readonly memory: MiningSupportFleetMemory;
}
export interface MiningSupportFleetCallDiagnostic {
  readonly actionID: number;
  readonly action: MiningSupportFleetAction;
  readonly finishedAtMs: number;
  readonly outcome: MiningSupportFleetFeedback["outcome"];
  readonly code: string | null;
  readonly httpStatus: number | null;
}
/** Passive run-local evidence. ACK is not a membership or delivery receipt. */
export interface MiningSupportFleetDiagnostic {
  readonly atMs: number;
  readonly observedAtMs: number | null;
  readonly state: MiningSupportFleetResult["state"];
  readonly fleetID: number | null;
  readonly anchorReady: boolean;
  readonly issues: readonly MiningSupportFleetIssue[];
  readonly action: MiningSupportFleetAction | null;
  readonly actionID: number | null;
  readonly lastCall: MiningSupportFleetCallDiagnostic | null;
  readonly invites: readonly { characterID: number; fleetID: number; attempts: number; actionID: number;
    issuedAtMs: number; outcome: Pending["outcome"]; code: string | null }[];
  readonly invitesTruncated: boolean;
}
const diagnosticCode = (code: string | null | undefined): string | null =>
  typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
export function miningSupportFleetDiagnostic(result: MiningSupportFleetResult, atMs: number,
  lastCall: MiningSupportFleetCallDiagnostic | null): MiningSupportFleetDiagnostic {
  return structuredClone({ atMs, observedAtMs: result.observedAtMs, state: result.state, fleetID: result.fleetID,
    anchorReady: result.anchorReady, issues: result.issues.map(issue => ({ ...issue, code: diagnosticCode(issue.code) })),
    action: result.action, actionID: result.actionID,
    lastCall: lastCall && { actionID: lastCall.actionID, action: lastCall.action, finishedAtMs: lastCall.finishedAtMs,
      outcome: lastCall.outcome, code: diagnosticCode(lastCall.code), httpStatus: lastCall.httpStatus },
    invites: result.memory.invites.slice(0, 32).map(entry => ({ characterID: entry.characterID, fleetID: entry.fleetID,
      attempts: entry.attempts, actionID: entry.pending.actionID, issuedAtMs: entry.pending.issuedAtMs,
      outcome: entry.pending.outcome, code: diagnosticCode(entry.pending.code) })),
    invitesTruncated: result.memory.invites.length > 32 });
}
const id = (value: number | string | null): number | null => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const sameScope = (a: SupportFleetScope | null, b: SupportFleetScope) => a?.characterID === b.characterID && a.sessionEpoch === b.sessionEpoch;
function matchesFreshInvite(invite: FleetPendingInvite | null, targetID: number, nowMs: number): boolean {
  return invite !== null && invite.fleetID === targetID && invite.receivedAtMs <= nowMs
    && nowMs - invite.receivedAtMs < 60_000;
}
function fresh(observation: MiningSupportFleetObservation | null, nowMs: number): boolean {
  return observation !== null && Number.isFinite(nowMs) && Number.isFinite(observation.receivedAtMs)
    && observation.receivedAtMs <= nowMs && nowMs - observation.receivedAtMs < SUPPORT_FLEET_READ_MAX_AGE_MS
    && id(observation.scope.characterID) !== null && observation.scope.sessionEpoch.length > 0
    && observation.snapshot.fleet.characterID === observation.scope.characterID;
}
function fleetID(observation: MiningSupportFleetObservation | null, nowMs: number): number | null {
  if (!fresh(observation, nowMs) || observation!.snapshot.availability !== "ready" || observation!.snapshot.fleet.initState.error !== null) return null;
  // GetInitState outranks the cached BoundFleet.fleetID, including after recreation.
  return id(observation!.snapshot.fleet.initState.value.fleetID);
}
function members(observation: MiningSupportFleetObservation): readonly number[] {
  return observation.snapshot.fleet.initState.value.members.map(row => id(row.charID)).filter((value): value is number => value !== null);
}
function provenFleet(observation: MiningSupportFleetObservation | null, nowMs: number): number | null {
  const fleet = fleetID(observation, nowMs);
  return fleet !== null && members(observation!).includes(observation!.scope.characterID) ? fleet : null;
}
/** Select an observed surviving member for an owned caller to run the existing
 * invite reducer. This does not create/join a fleet or infer missing members. */
export function miningSupportRecoveryInviter(input: {
  own: MiningSupportFleetObservation | null; intendedCharacterIDs: readonly number[];
  memberObservations: readonly MiningSupportFleetObservation[]; nowMs: number;
}): { state: "not-needed" | "unknown" | "conflict" | "ready"; characterID: number | null; fleetID: number | null } {
  const result = (state: "not-needed" | "unknown" | "conflict" | "ready", characterID: number | null = null, fleetID: number | null = null) => ({ state, characterID, fleetID });
  const { own, nowMs } = input;
  if (!fresh(own, nowMs)) return result("unknown");
  if (provenFleet(own, nowMs) !== null) return result("not-needed");
  if (own!.snapshot.availability !== "not-in-fleet") return result("unknown");
  const intended = [...new Set(input.intendedCharacterIDs)].filter(value => value !== own!.scope.characterID).sort((a, b) => a - b);
  const survivors: MiningSupportFleetObservation[] = [];
  for (const characterID of intended) {
    if (id(characterID) === null) return result("unknown");
    const rows = input.memberObservations.filter(row => row.scope.characterID === characterID);
    if (rows.length !== 1 || !fresh(rows[0]!, nowMs)) return result("unknown");
    if (provenFleet(rows[0]!, nowMs) !== null) survivors.push(rows[0]!);
    else if (rows[0]!.snapshot.availability !== "not-in-fleet") return result("unknown");
  }
  const fleets = [...new Set(survivors.map(row => provenFleet(row, nowMs)!))];
  if (fleets.length > 1) return result("conflict");
  return survivors.length ? result("ready", survivors[0]!.scope.characterID, fleets[0]!) : result("not-needed");
}
function memoryFor(own: MiningSupportFleetObservation | null, previous: MiningSupportFleetMemory, feedback?: MiningSupportFleetFeedback): MiningSupportFleetMemory {
  let memory = own !== null && !sameScope(previous.scope, own.scope) ? { ...freshMiningSupportFleetMemory(), scope: { ...own.scope } } : previous;
  if (feedback && sameScope(memory.scope, feedback.scope)) {
    const update = (pending: Pending): Pending => pending.actionID === feedback.actionID ? { ...pending, outcome: feedback.outcome,
      code: feedback.code ?? null, applicationOutcome: feedback.applicationOutcome ?? null } : pending;
    memory = { ...memory, order: memory.order && update(memory.order), invites: memory.invites.map(entry => ({ ...entry, pending: update(entry.pending) })) };
  }
  return memory;
}
function controller(role: MiningSupportFleetResult["role"], own: MiningSupportFleetObservation | null, initial: MiningSupportFleetMemory, nowMs: number) {
  let memory = initial;
  const currentFleet = provenFleet(own, nowMs);
  const issue = (reason: MiningSupportFleetReason, characterID: number | null = null, fleet: number | null = currentFleet, code: string | null = null): MiningSupportFleetIssue => ({ reason, characterID, fleetID: fleet, code });
  const result = (state: MiningSupportFleetResult["state"], issues: readonly MiningSupportFleetIssue[] = [], action: MiningSupportFleetAction | null = null): MiningSupportFleetResult => ({
    role, state, issues, fleetID: currentFleet, anchorReady: role === "support" && currentFleet !== null,
    observedAtMs: own?.receivedAtMs ?? null, action, actionID: action === null ? null : memory.nextActionID - 1, memory,
  });
  function emit(action: MiningSupportFleetAction, state: "creating" | "inviting" | "joining", reason: MiningSupportFleetReason, inviteProofMs: number | null = null, attempts = 1) {
    if (memory.lastActionReadAtMs !== null && own!.receivedAtMs <= memory.lastActionReadAtMs) return result("waiting", [issue("new-observation-required")]);
    const pending: Pending = { actionID: memory.nextActionID, action, issuedAtMs: nowMs, readAtMs: own!.receivedAtMs,
      outcome: "pending", code: null, applicationOutcome: null, inviteProofMs };
    memory = { ...memory, nextActionID: memory.nextActionID + 1, lastActionReadAtMs: own!.receivedAtMs,
      ...(action.kind === "inviteToFleet" ? { invites: [...memory.invites.filter(entry => entry.characterID !== action.charID),
        { characterID: action.charID, fleetID: currentFleet!, attempts, pending }] } : { order: pending,
        joinAttempts: action.kind === "acceptFleetInvite" ? memory.joinAttempts + 1 : memory.joinAttempts }) };
    return result(state, [issue(reason, action.kind === "inviteToFleet" ? action.charID : null)], action);
  }
  function join(target: MiningSupportFleetObservation, recovery: boolean): MiningSupportFleetResult {
    const targetID = provenFleet(target, nowMs)!;
    if (memory.order && "fleetID" in memory.order.action && memory.order.action.fleetID !== targetID) memory = { ...memory, order: null, joinAttempts: 0 };
    const pending = memory.order;
    const invite = own!.join.inviteKnown ? own!.join.invite : null;
    const matchingInvite = matchesFreshInvite(invite, targetID, nowMs);
    if (pending?.action.kind === "createFleet") return result(pending.outcome === "refused" ? "blocked" : "waiting", [issue(pending.outcome === "refused" ? "create-refused" : "create-unconfirmed", null, targetID, pending.code)]);
    if (pending?.action.kind === "acceptFleetInvite") {
      const renewed = matchingInvite && invite!.receivedAtMs > (pending.inviteProofMs ?? pending.issuedAtMs);
      if (!renewed || nowMs - pending.issuedAtMs < SUPPORT_FLEET_PENDING_MS) return result(pending.outcome === "refused" ? "blocked" : "waiting", [issue(pending.outcome === "refused" ? "join-refused" : nowMs - pending.issuedAtMs >= SUPPORT_FLEET_PENDING_MS ? "join-unconfirmed" : "join-pending", null, targetID, pending.code)]);
    }
    if (matchingInvite || (pending?.action.kind === "applyToJoinFleet" && pending.outcome === "acknowledged" && pending.applicationOutcome === "invited")) {
      if (memory.joinAttempts >= FLEET_JOIN_ACCEPT_ATTEMPTS) return result("blocked", [issue("join-unconfirmed", null, targetID)]);
      return emit({ kind: "acceptFleetInvite", fleetID: targetID }, "joining", "join-pending", matchingInvite ? invite!.receivedAtMs : nowMs);
    }
    if (pending?.action.kind === "applyToJoinFleet") return result(pending.outcome === "refused" || pending.applicationOutcome === "needs-approval" ? "blocked" : "waiting", [issue(pending.outcome === "refused" ? "join-refused" : pending.applicationOutcome === "needs-approval" ? "join-approval-required" : "invite-state-unknown", null, targetID, pending.code)]);
    if (!own!.join.inviteKnown) return result("waiting", [issue("invite-state-unknown", null, targetID)]);
    if (own!.join.ads?.some(ad => ad.fleetID === targetID)) return emit({ kind: "applyToJoinFleet", fleetID: targetID }, "joining", "join-pending");
    return result(recovery ? "recovery-required" : "waiting", [issue(recovery ? "surviving-fleet-conflict" : own!.join.ads === null ? "invite-state-unknown" : "member-missing", null, targetID)]);
  }
  return { issue, result, emit, join, get memory() { return memory; }, set memory(value: MiningSupportFleetMemory) { memory = value; } };
}

/** One support pilot, one refreshed read, at most one existing fleet action.
 * All other pilots' facts are supplied by callers; no session acquisition/IO.
 */
export function decideMiningSupportFleet(input: {
  readonly own: MiningSupportFleetObservation | null;
  readonly intendedCharacterIDs: readonly number[];
  readonly memberObservations: readonly MiningSupportFleetObservation[];
  readonly policy?: MiningSupportFleetPolicy;
  readonly nowMs: number;
  readonly feedback?: MiningSupportFleetFeedback;
}, previous: MiningSupportFleetMemory): MiningSupportFleetResult {
  const { own, nowMs } = input;
  const c = controller("support", own, memoryFor(own, previous, input.feedback), nowMs);
  if (!fresh(own, nowMs) || own!.snapshot.availability === "unavailable") return c.result("waiting", [c.issue("fleet-state-unknown")]);
  const intended = [...new Set(input.intendedCharacterIDs)].filter(value => value !== own!.scope.characterID).sort((a, b) => a - b);
  if (intended.some(value => id(value) === null)) return c.result("blocked", [c.issue("invalid-intended-member")]);
  const managed = (input.policy ?? MANUAL_SUPPORT_FLEET_POLICY).mode === "MANAGED";
  const current = provenFleet(own, nowMs);
  if (own!.snapshot.availability === "ready") {
    // inviteCharacter uses ensureFleetMembership, not boss/commander roles.
    if (current === null || canBroadcastInFleet(own!.snapshot, own!.scope.characterID) !== true) return c.result("blocked", [c.issue("invite-authority-missing")]);
    const roster = members(own!);
    c.memory = { ...c.memory, lastFleetID: current, order: null, joinAttempts: 0,
      invites: c.memory.invites.filter(entry => entry.fleetID === current && intended.includes(entry.characterID) && !roster.includes(entry.characterID)) };
    const missing = intended.filter(value => !roster.includes(value));
    if (missing.length === 0) return c.result("ready");
    if (!managed) return c.result("degraded", missing.map(value => c.issue("member-missing", value)));
    const observations = missing.map(characterID => input.memberObservations.filter(row => row.scope.characterID === characterID));
    const conflicts = observations.flatMap((rows, index) => rows.filter(row => provenFleet(row, nowMs) !== null && provenFleet(row, nowMs) !== current)
      .map(row => c.issue("member-in-other-fleet", missing[index]!, provenFleet(row, nowMs))));
    if (conflicts.length) return c.result("blocked", conflicts);
    const issues: MiningSupportFleetIssue[] = [];
    for (let index = 0; index < missing.length; index++) {
      const characterID = missing[index]!;
      const rows = observations[index]!;
      const member = rows.length === 1 ? rows[0]! : null;
      if (!fresh(member, nowMs) || member!.snapshot.availability !== "not-in-fleet") { issues.push(c.issue("fleet-state-unknown", characterID)); continue; }
      const entry = c.memory.invites.find(row => row.characterID === characterID);
      if (member!.join.inviteKnown && matchesFreshInvite(member!.join.invite, current, nowMs)) { issues.push(c.issue("invite-pending", characterID)); continue; }
      if (entry) {
        if (entry.pending.outcome === "refused") { issues.push(c.issue("invite-refused", characterID, current, entry.pending.code)); continue; }
        if (entry.pending.outcome !== "acknowledged") { issues.push(c.issue(nowMs - entry.pending.issuedAtMs >= SUPPORT_FLEET_PENDING_MS ? "invite-unconfirmed" : "invite-pending", characterID)); continue; }
        if (nowMs - entry.pending.issuedAtMs < SUPPORT_FLEET_PENDING_MS || member!.receivedAtMs <= entry.pending.readAtMs || !member!.join.inviteKnown) { issues.push(c.issue("invite-pending", characterID)); continue; }
        if (entry.attempts >= SUPPORT_FLEET_INVITE_ATTEMPTS) { issues.push(c.issue("invite-retry-exhausted", characterID)); continue; }
      }
      return c.emit({ kind: "inviteToFleet", charID: characterID }, "inviting", "member-missing", null, (entry?.attempts ?? 0) + 1);
    }
    return c.result(issues.some(row => row.reason === "invite-refused" || row.reason === "invite-retry-exhausted" || row.reason === "invite-unconfirmed") ? "blocked" : "waiting", issues);
  }
  if (!managed) return c.result("waiting", [c.issue("support-not-in-fleet")]);
  const observations = intended.map(characterID => input.memberObservations.filter(row => row.scope.characterID === characterID));
  const survivors = observations.flatMap(rows => rows.filter(row => provenFleet(row, nowMs) !== null));
  const fleets = [...new Set(survivors.map(row => provenFleet(row, nowMs)!))];
  if (fleets.length > 1 || (fleets.length === 1 && c.memory.lastFleetID !== null && fleets[0] !== c.memory.lastFleetID)) return c.result("recovery-required", [c.issue("surviving-fleet-conflict", null, fleets[0] ?? null)]);
  if (fleets.length === 1) return c.join(survivors[0]!, true);
  // Unknown/absent member facts cannot prove that the previous fleet vanished.
  if (observations.some(rows => rows.length !== 1 || !fresh(rows[0]!, nowMs) || rows[0]!.snapshot.availability !== "not-in-fleet")) return c.result("waiting", [c.issue("fleet-state-unknown")]);
  if (c.memory.order) {
    const pending = c.memory.order;
    if (pending.action.kind !== "createFleet") return c.result("waiting", [c.issue("join-pending")]);
    return c.result(pending.outcome === "refused" || nowMs - pending.issuedAtMs >= SUPPORT_FLEET_PENDING_MS ? "blocked" : "waiting",
      [c.issue(pending.outcome === "refused" ? "create-refused" : nowMs - pending.issuedAtMs >= SUPPORT_FLEET_PENDING_MS ? "create-unconfirmed" : "support-not-in-fleet", null, null, pending.code)]);
  }
  return c.emit({ kind: "createFleet" }, "creating", "support-not-in-fleet");
}

/** Member decisions share the exact-ID apply -> invited -> accept -> reread
 * protocol with the existing join watcher, but never guess on unknown replies.
 */
export function decideMiningSupportFleetMember(input: {
  readonly own: MiningSupportFleetObservation | null;
  readonly supportCharacterID: number;
  readonly support: MiningSupportFleetObservation | null;
  /** Joined reader's real BFF roster can confirm existing membership. It
   * cannot discover/join a fleet while the reader is fleetless. */
  readonly supportRoster?: SupportFleetRoster | null;
  readonly policy?: MiningSupportFleetPolicy;
  readonly nowMs: number;
  readonly feedback?: MiningSupportFleetFeedback;
}, previous: MiningSupportFleetMemory): MiningSupportFleetResult {
  const { own, nowMs, support } = input;
  const c = controller("member", own, memoryFor(own, previous, input.feedback), nowMs);
  if (!fresh(own, nowMs) || own!.snapshot.availability === "unavailable") return c.result("waiting", [c.issue("fleet-state-unknown")]);
  const roster = input.supportRoster;
  const rosterFleet = roster && roster.readerCharacterID === own!.scope.characterID &&
    roster.observedAtMs <= nowMs && nowMs < roster.expiresAtMs && nowMs - roster.observedAtMs < SUPPORT_FLEET_READ_MAX_AGE_MS &&
    roster.members.some(row => row.characterID === input.supportCharacterID) &&
    roster.members.some(row => row.characterID === own!.scope.characterID) &&
    id(roster.fleetID) === provenFleet(own, nowMs) ? id(roster.fleetID) : null;
  const wanted = support?.scope.characterID === input.supportCharacterID ? provenFleet(support, nowMs) : rosterFleet;
  if (wanted === null) return c.result("waiting", [c.issue("fleet-state-unknown")]);
  const current = provenFleet(own, nowMs);
  if (own!.snapshot.availability === "ready") {
    if (current === null) return c.result("waiting", [c.issue("fleet-state-unknown")]);
    if (current !== wanted) return c.result("blocked", [c.issue("member-in-other-fleet", own!.scope.characterID, current)]);
    c.memory = { ...c.memory, lastFleetID: current, order: null, joinAttempts: 0 };
    return c.result("ready");
  }
  if ((input.policy ?? MANUAL_SUPPORT_FLEET_POLICY).mode !== "MANAGED") return c.result("waiting", [c.issue("member-missing", own!.scope.characterID, wanted)]);
  if (support === null) return c.result("waiting", [c.issue("fleet-state-unknown")]);
  return c.join(support!, false);
}
