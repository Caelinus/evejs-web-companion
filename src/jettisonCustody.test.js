"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("./jettisonCustody");
const { createJettisonCustodyHandler } = require("./jettisonCustodyRoutes");
const scope = { botID: "bot", runGeneration: "generation", pilotID: 1, shipID: 2, systemID: 3,
  operationID: "op", targetKey: "belt", targetClaimedAt: 100 };
const invocation = { runID: "run", invocationID: 1, stepPath: "loop/jettison" };
const ore = { itemID: 10, typeID: 1230, ownerID: 1, locationID: 2, flagID: 134, quantity: 100, categoryID: 25 };
const crystal = { ...ore, itemID: 11, typeID: 10, quantity: 2, categoryID: 8 };
const scene = (canIDs = []) => ({ inSpace: true, shipID: 2, solarSystemID: 3, sampledAtMs: 100,
  ship: { itemID: 2, characterID: 1 }, entities: canIDs.map(itemID => ({ kind: "container", itemID, ownerID: 1 })) });
const prepared = (existing = []) => model.prepare({ scope, invocation, scene: scene(existing), rows: [ore, crystal], itemIDs: [10], nowMs: 101 });
const pending = (existing = []) => model.issued(prepared(existing), 102);
const can = id => ({ itemID: id, ownerID: 1, items: [{ ...ore, locationID: id, flagID: 0 }] });
const observed = (extra = {}) => ({ scope, scene: scene([99]), rows: [crystal], containers: [can(99)], result: [[10], []], nowMs: 103, ...extra });

test("disconnect before issue preserves a recoverable unissued invocation", () => {
  const proof = model.reconcile(prepared(), observed({ rows: [ore, crystal], scene: scene(), containers: [] }));
  assert.equal(proof.state, "not-issued"); assert.equal(proof.issuedAtMs, null);
});
test("pre-dispatch authority refusal cannot manufacture mutation evidence", () => {
  assert.throws(() => model.prepare({ scope, invocation, scene: scene(), rows: null, itemIDs: [10], nowMs: 101 }), /unreadable/);
  assert.throws(() => model.prepare({ scope, invocation, scene: scene(), rows: [crystal], itemIDs: [11], nowMs: 101 }), /whole ore/);
});
test("issue records original manifest before result and cannot be issued twice", () => {
  const value = pending(); assert.equal(value.state, "issued-pending"); assert.equal(value.resultMovedIDs, null);
  assert.deepEqual(value.items, [ore]); assert.equal(value.issuedAtMs, 102);
  assert.throws(() => model.issued(value, 103), /already issued/);
});
test("exact source identity and quantities prove the resulting owned can", () => {
  const proof = model.reconcile(pending(), observed());
  assert.equal(proof.state, "confirmed-created"); assert.equal(proof.containerID, 99);
  assert.deepEqual(proof.sourceBefore, [ore, crystal]); assert.deepEqual(proof.sourceAfter, [crystal]);
  assert.deepEqual(proof.resultMovedIDs, [10]);
});
test("fresh exact source and can evidence can reconcile a lost action reply", () => {
  assert.equal(model.reconcile(pending(), observed({ result: undefined })).state, "confirmed-created");
});
test("a preexisting unrelated can is never adopted even with matching contents", () => {
  assert.equal(model.reconcile(pending([99]), observed()).state, "ambiguous");
});
test("two newly owned plausible cans block adoption", () => {
  const value = model.reconcile(pending(), observed({ scene: scene([99, 100]), containers: [can(99), can(100)] }));
  assert.equal(value.state, "ambiguous"); assert.equal(value.reason, "JETTISON_MULTIPLE_CANDIDATES");
});
test("unknown source reread cannot prove mutation or an empty source", () => {
  assert.equal(model.reconcile(pending(), observed({ rows: null })).state, "ambiguous");
  assert.equal(model.inventoryRows({ type: "list", items: [{ itemID: 10 }] }), null);
  assert.equal(model.inventoryRows(null), null);
});
test("changed ship, pilot, system, target or operation generation fail closed", () => {
  for (const key of ["shipID", "pilotID", "systemID", "targetKey", "targetClaimedAt", "runGeneration", "botID"])
    assert.equal(model.reconcile(pending(), observed({ scope: { ...scope, [key]: "changed" } })).state, "ambiguous", key);
  assert.equal(model.reconcile(pending(), observed({ scene: { ...scene([99]), solarSystemID: 4 } })).state, "ambiguous");
});
test("partial source loss, changed quantity and foreign can ownership retain custody", () => {
  for (const input of [
    { rows: [{ ...ore, quantity: 50 }, crystal] },
    { containers: [{ ...can(99), items: [{ ...can(99).items[0], quantity: 50 }] }] },
    { containers: [{ ...can(99), ownerID: 4 }] },
    { containers: [{ ...can(99), items: null }] },
    { result: [[], []] },
  ]) assert.equal(model.reconcile(pending(), observed(input)).state, "ambiguous");
});
test("confirmed can disappearance follows ordinary settlement without an emptied mark", () => {
  const proof = model.reconcile(pending(), observed());
  const later = model.reconcile(proof, observed({ scene: scene(), containers: [], rows: [crystal] }));
  assert.equal(later.state, "confirmed-created"); assert.equal(later.containerID, 99);
  assert.equal(Object.hasOwn(later, "emptied"), false);
});
test("a complete unchanged source plus empty action result confirms no ore mutation", () => {
  const input = observed({ rows: [ore, crystal], scene: scene(), containers: [], result: [[], []] });
  assert.equal(model.reconcile(pending(), input).state, "confirmed-no-ore-mutation");
  const proof = model.reconcile(pending(), input);
  assert.equal(model.reconcile(proof, { ...input, rows: [{ ...ore, quantity: 120 }, crystal] }).state, "confirmed-no-ore-mutation", "later ordinary mining cannot erase the confirmed historical result");
  assert.equal(model.reconcile(pending(), { ...input, result: undefined }).state, "ambiguous");
});
test("unknown, duplicate and contradictory action IDs cannot supply a receipt", () => {
  assert.equal(model.resultIDs([[10, 10], []]), null);
  assert.equal(model.resultIDs([null, []]), null);
  assert.equal(model.resultIDs({ items: [[10], []] }), null);
  assert.deepEqual(model.resultIDs({ type: "tuple", items: [{ type: "list", items: [10] }, []] }), { moved: [10], launched: [] });
});

function harness(overrides = {}) {
  let custody = null, calls = 0, registered = [], reads = 0;
  const owner = { read: () => model.copy(custody), begin: value => {
    if (custody?.state === "not-issued" || model.unresolved(custody)) throw Object.assign(new Error("pending"), { code: "JETTISON_PENDING" });
    custody = model.copy(value);
  },
    markIssued: value => { assert.equal(custody.state, "not-issued"); custody = model.copy(value); },
    settle: value => { custody = model.copy(value); } };
  const deps = { now: () => 105, readScope: async () => scope,
    readEvidence: async () => ++reads === 1 ? { scene: scene(), rows: [ore, crystal], containers: [] } : observed(),
    assertDispatch: async () => {}, dispatch: async () => { calls++; assert.equal(custody.state, "issued-pending"); return { result: [[10], []], notifications: ["mutation"] }; },
    register: value => { registered.push(value.containerID); return true; }, ...overrides };
  const handle = createJettisonCustodyHandler(deps);
  const request = { body: { itemIDs: [10], invocation } };
  const invoke = async (reconcileOnly = false) => { let body; const response = { status: () => response, json: value => { body = value; } };
    await handle(request, response, owner, reconcileOnly); return body; };
  return { invoke, owner, get custody() { return custody; }, get calls() { return calls; }, get registered() { return registered; } };
}
test("dispatcher records issue before result, restores exact operation custody and drains notifications", async () => {
  const h = harness(); const body = await h.invoke();
  assert.equal(body.accepted, true); assert.equal(h.calls, 1); assert.deepEqual(h.registered, [99]);
  assert.deepEqual(body.notifications, ["mutation"]);
  await h.invoke(); assert.equal(h.calls, 1); assert.deepEqual(h.registered, [99]);
});
test("definite pre-dispatch refusal keeps original unissued evidence and issues nothing", async () => {
  const h = harness({ assertDispatch: async () => { throw Object.assign(new Error("refused"), { code: "REFUSED" }); } });
  const body = await h.invoke(); assert.equal(h.calls, 0); assert.equal(body.accepted, false);
  assert.equal(h.custody.state, "refused-before-dispatch"); assert.equal(h.custody.issuedAtMs, null);
});
test("dispatch/confirmation race retains control and refuses a duplicate invocation", async () => {
  let done; const gate = new Promise(resolve => { done = resolve; });
  const h = harness({ dispatch: async () => { await gate; throw new Error("lost reply"); } });
  const first = h.invoke();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.custody.state, "issued-pending");
  const second = await h.invoke(); assert.equal(second.accepted, false);
  done(); const body = await first; assert.equal(body.accepted, false); assert.equal(h.custody.state, "ambiguous");
  assert.equal((await h.invoke()).accepted, false);
});
test("target change prevents registration and leaves exact pending can custody blocked", async () => {
  const h = harness({ register: () => false }); const body = await h.invoke();
  assert.equal(body.accepted, false); assert.equal(h.custody.containerID, 99); assert.equal(h.custody.state, "ambiguous");
});
test("a confirmed invocation cannot ACK duplicate IDs as its original manifest", async () => {
  const custody = { ...pending(), state: "confirmed-created", items: [ore, { ...ore, itemID: 12 }], containerID: 99 };
  let body;
  const response = { status: () => response, json: value => { body = value; } };
  await createJettisonCustodyHandler({})({ body: { invocation, itemIDs: [10, 10] } }, response, { read: () => custody });
  assert.equal(body.accepted, false);
  assert.equal(body.error, "JETTISON_INVOCATION_CHANGED");
});
test("concurrent same-invocation preparation cannot erase another request's issued custody", async () => {
  let releaseDispatch, dispatchStarted;
  const dispatchGate = new Promise(resolve => { releaseDispatch = resolve; });
  const started = new Promise(resolve => { dispatchStarted = resolve; });
  let reads = 0, issues = 0;
  const h = harness({ readEvidence: async () => {
    if (++reads <= 2) return { scene: scene(), rows: [ore, crystal], containers: [] };
    return observed();
  }, dispatch: async () => { issues++; dispatchStarted(); await dispatchGate; return { result: [[10], []] }; } });
  const first = h.invoke();
  const duplicate = h.invoke(); // Both read null before either asynchronous preflight ends.
  await started;
  const rejected = await duplicate;
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.notIssued, false);
  assert.equal(h.custody.state, "issued-pending");
  assert.equal(issues, 1);
  releaseDispatch();
  assert.equal((await first).accepted, true);
  assert.equal(h.custody.state, "confirmed-created");
});
test("custody copies cannot mutate retained host evidence or invent a grant extension", () => {
  const retained = pending(); const publicCopy = model.copy(retained); publicCopy.items[0].quantity = 1;
  assert.equal(retained.items[0].quantity, 100); assert.equal(Object.hasOwn(retained, "expiresAt"), false);
});
test("a proven can uses ordinary BFF claims so a recovered second hauler cannot double service it", () => {
  const { createLootMemory } = require("./lootMemory");
  const claims = createLootMemory(); const proof = model.reconcile(pending(), observed());
  assert.equal(claims.claimContainer("hauler-session", "run", scope.systemID, proof.containerID), true);
  assert.equal(claims.beginTransfer("hauler-session", "run", scope.systemID, proof.containerID), true);
  assert.equal(claims.claimContainer("recovered-hauler-session", "another", scope.systemID, proof.containerID), false);
  assert.deepEqual(claims.emptiedItemIDs(scope.systemID), []);
});
