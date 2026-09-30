"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { extendMiningOperation } = require("../src/miningOperationGrant");
test("degraded fleet extends only associated hosted members, with explicit partial results and unchanged target", async () => {
  const runtime = { state: "DEGRADED", currentTarget: { targetKey: "BELT:A", claimedByOperationID: "A" } };
  const before = JSON.stringify(runtime), calls = [];
  const deps = { operationID: "A", controllerAccountID: 9, minutes: 1440,
    operations: { definition: () => ({ members: [1, 2, 3].map(characterID => ({ characterID })) }), runtimeFor: () => runtime },
    botHost: { listAll: () => [{ characterID: 1, botID: "a1", operationID: "A", endedAt: null }, { characterID: 2, botID: "b2", operationID: "B", endedAt: null }],
      extendOperationGrant: async (...args) => { calls.push(args); return { ok: true, bot: { expiresAt: "later" } }; } },
  };
  const result = await extendMiningOperation(deps);
  assert.equal(result.ok, false); assert.deepEqual(result.results.map(row => row.ok), [true, false, false]);
  assert.deepEqual(calls, [["a1", "A", 9, 1440]]); assert.equal(JSON.stringify(runtime), before);
  runtime.state = "STOPPING"; assert.equal((await extendMiningOperation(deps)).ok, false); assert.equal(calls.length, 1);
});
