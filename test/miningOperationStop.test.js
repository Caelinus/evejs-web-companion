"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMiningOperations } = require("../src/miningOperations");
const { createMiningTargetBoard } = require("../src/miningTargetBoard");
const { createBeltMemory } = require("../src/beltMemory");
const { createMiningOperationStopper } = require("../src/miningOperationStop");

function harness(mode = "RETURN_HOME_DOCK") {
  const defs = ["A", "B"].map((operationID, index) => ({ operationID, name: operationID,
    area: { anchorSystemID: 30000142, anchorSystemName: "Jita", reach: "CURRENT_SYSTEM", targetClasses: ["BELT"] },
    unloadPolicy: "HAULER_SERVICE", targetPolicy: "ANY_ELIGIBLE",
    policies: { parking: { mode, destination: { stationID: 60003760, stationName: "Home", systemName: "Jita" }, corporationDivision: 1 } },
    members: [1, 2, 3].map(n => ({ characterID: n + index * 3, role: n === 3 ? "HAULER" : "MINER", characterName: `P${n}`, accountName: "account" })) }));
  const board = createMiningTargetBoard();
  const operations = createMiningOperations({ store: { get: id => defs.find(row => row.operationID === id), list: () => defs }, targetBoard: board, beltMemory: createBeltMemory() });
  const rows = [], events = [], prepareFailures = new Set(), parkFailures = new Set();
  for (const def of defs) {
    assert.equal(operations.begin(def.operationID).ok, true);
    for (const member of def.members) {
      const botID = `bot-${member.characterID}`;
      operations.memberStarted(def.operationID, member.characterID, botID);
      rows.push({ ...member, botID, operationID: def.operationID, accountID: 7, endedAt: null, status: "running" });
    }
    operations.finishLaunch(def.operationID);
    const result = operations.reserveCandidate(def.operationID, def.members[0].characterID, { targetType: "BELT", targetName: `Belt ${def.operationID}`, systemID: 30000142, systemName: "Jita" });
    operations.activateTarget(def.operationID, def.members[0].characterID, result.target.targetKey);
  }
  const botHost = { listAll: () => rows,
    async prepareOperationStop(id) { events.push(["settle", id]); return prepareFailures.has(id) ? { ok: false, message: "Drone recall unconfirmed" } : { ok: true }; },
    async parkOperationMember(id, account, op, policy) {
      events.push(["park", id, policy.mode]);
      if (parkFailures.has(id)) return { ok: false, message: "Docking refused" };
      rows.find(row => row.botID === id).endedAt = "now";
      return { ok: true };
    },
    async stop(id) { events.push(["gracefulStop", id]); rows.find(row => row.botID === id).endedAt = "now"; return { ok: true }; },
  };
  return { defs, board, operations, rows, events, prepareFailures, parkFailures, botHost, stopper: createMiningOperationStopper({ operations, botHost }) };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test("Stay preserves scoped graceful Stop and repeated Stop is idempotent", async () => {
  const h = harness("STAY_IN_PLACE");
  const other = structuredClone(h.operations.runtimeFor("B"));
  await h.stopper.stop(h.defs[0]);
  await h.stopper.stop(h.defs[0]);
  assert.deepEqual(h.events, [1, 2, 3].map(id => ["gracefulStop", `bot-${id}`]));
  assert.equal(h.operations.runtimeFor("A").state, "STOPPED");
  assert.deepEqual(h.operations.runtimeFor("B"), other);
  assert.ok(h.rows.slice(3).every(row => row.endedAt === null));
});

test("recovered Stop with missing members remains blocked without altering another operation", async () => {
  const h = harness("STAY_IN_PLACE");
  // New control-plane process: only A's hauler and B's fleet recovered hosted.
  const rows = h.rows.filter(row => row.operationID === "B" || row.role === "HAULER");
  const board = createMiningTargetBoard();
  const operations = createMiningOperations({ store: { get: id => h.defs.find(def => def.operationID === id), list: () => h.defs },
    targetBoard: board, beltMemory: createBeltMemory() });
  operations.list(rows);
  const other = structuredClone(operations.runtimeFor("B"));
  assert.equal(operations.runtimeFor("A").recoveryAmbiguous, true);
  assert.equal(operations.runtimeFor("A").currentTarget, null);
  const stopped = [];
  const stopper = createMiningOperationStopper({ operations, botHost: { listAll: () => rows,
    async stop(id) { stopped.push(id); rows.find(row => row.botID === id).endedAt = "now"; return { ok: true }; } } });
  await stopper.stop(h.defs[0]);
  assert.deepEqual(stopped, ["bot-3"]);
  assert.equal(operations.runtimeFor("A").state, "STOPPING", "missing recovered members cannot be pronounced safely stopped");
  assert.equal(operations.runtimeFor("A").stopFailures.length, 2);
  assert.deepEqual(operations.runtimeFor("B"), other);
  assert.equal(operations.begin("A").ok, false, "the unresolved stop cannot be silently restarted");
  assert.deepEqual(operations.runtimeFor("B"), other);
});

test("return Stop gates target work immediately, releases only after settlement, and waits for docking completion", async () => {
  const h = harness();
  const target = h.operations.runtimeFor("A").currentTarget;
  let settled, arrived;
  const settlement = new Promise(resolve => { settled = resolve; });
  const arrival = new Promise(resolve => { arrived = resolve; });
  const prepare = h.botHost.prepareOperationStop;
  const park = h.botHost.parkOperationMember;
  let parkingCalls = 0;
  h.botHost.prepareOperationStop = async id => { if (id === "bot-3") await settlement; return prepare(id); };
  h.botHost.parkOperationMember = async (...args) => { parkingCalls++; await arrival; return park(...args); };
  const first = h.stopper.stop(h.defs[0]);
  assert.equal(h.stopper.stop(h.defs[0]), first);
  assert.equal(h.operations.assignment("A", 1).stopRequested, true);
  assert.equal(h.operations.assignment("A", 1).currentTarget, null);
  assert.equal(h.operations.assignment("A", 3).logisticsTarget, null);
  assert.equal(h.operations.reserveCandidate("A", 1, target).acquired, false);
  assert.equal(h.operations.depleteTarget("A", 1, target.targetKey, { empty: true }), false);
  await turn();
  assert.equal(h.board.get(target.targetKey).claimedByOperationID, "A");
  assert.equal(parkingCalls, 0, "settlement boundary precedes the first parking trip");
  assert.notEqual(h.operations.runtimeFor("A").state, "STOPPED");
  settled(); await turn();
  assert.equal(h.board.get(target.targetKey).state, "AVAILABLE");
  assert.equal(h.operations.runtimeFor("A").state, "PARKING");
  arrived(); await first;
  assert.equal(h.operations.runtimeFor("A").state, "STOPPED");
  assert.equal(h.operations.runtimeFor("A").history.filter(row => row.kind === "TARGET_RELEASED_ON_STOP").length, 1);
  assert.equal(h.operations.runtimeFor("B").state, "MINING");
  assert.ok(h.rows.slice(3).every(row => row.endedAt === null));
});

test("failed recall does not strand healthy peers; claim retained and retry only parks remaining member", async () => {
  const h = harness();
  h.prepareFailures.add("bot-2");
  const key = h.operations.runtimeFor("A").currentTarget.targetKey;
  const errors = await h.stopper.stop(h.defs[0]);
  assert.equal(errors.length, 1);
  assert.equal(h.operations.runtimeFor("A").state, "PARKING_FAILED");
  assert.equal(h.board.get(key).claimedByOperationID, "A");
  assert.deepEqual(h.rows.slice(0, 3).map(row => row.endedAt), ["now", null, "now"]);
  h.prepareFailures.clear();
  await h.stopper.stop(h.defs[0]);
  assert.equal(h.operations.runtimeFor("A").state, "STOPPED");
  assert.deepEqual(h.events.filter(row => row[0] === "park").map(row => row[1]), ["bot-1", "bot-3", "bot-2"]);
});

test("travel failure or an offline member cannot be reported PARKED / STOPPED", async () => {
  const h = harness("RETURN_HOME_UNLOAD_DOCK");
  h.parkFailures.add("bot-1");
  h.rows[1].endedAt = "previously failed";
  const failures = await h.stopper.stop(h.defs[0]);
  assert.deepEqual(failures.map(row => row.characterID).sort(), [1, 2]);
  assert.equal(h.operations.runtimeFor("A").state, "PARKING_FAILED");
  assert.equal(h.operations.runtimeFor("A").members.get(3).parkingState, "PARKED");
  assert.equal(h.rows[0].endedAt, null);
});

test("restart projection retains every interrupted member failure without duplicate history or false STOPPED", () => {
  const h = harness();
  // Fresh control-plane runtime after restart, with terminal host recovery
  // records rather than trusted persisted currentTarget / RUNNING state.
  const recovered = createMiningOperations({ store: { get: id => h.defs.find(row => row.operationID === id), list: () => h.defs },
    targetBoard: createMiningTargetBoard(), beltMemory: createBeltMemory() });
  const interrupted = h.rows.slice(0, 3).map(row => ({ ...row, operationStopRequested: true, endedAt: "restart", status: "error",
    parking: { state: "PARKING_FAILED", reason: "Arrival unknown after restart" } }));
  recovered.list(interrupted);
  recovered.list(interrupted);
  assert.equal(recovered.runtimeFor("A").state, "PARKING_FAILED");
  assert.equal(recovered.runtimeFor("A").stopFailures.length, 3);
  assert.equal(recovered.runtimeFor("A").currentTarget, null);
  assert.equal(recovered.runtimeFor("B").state, "DRAFT");
});
