"use strict";

// Bounded source experiment: run the unchanged stock handler's selection
// preflight/duplicate-owner section. Deliberately stop before gameplay apply.
// This proves the takeover decision, not full login/gameplay integration.
const baseTest = require("node:test");
const test = (name, fn) => baseTest(name, {skip: !process.env.STOCK_EVEJS_ROOT}, fn);
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = process.env.STOCK_EVEJS_ROOT;
const read = relative => root ? fs.readFileSync(path.join(root, relative), "utf8") : "";
const source = read("server/src/services/character/charService.js");
const begin = source.indexOf("  Handle_SelectCharacterID(args, session, kwargs) {");
const end = source.indexOf("    const tutorialSkipResult =", begin);
if (root) assert.ok(begin > 0 && end > begin);
const selectionAuthority = source.slice(begin, end);

function harness(takeover) {
  const calls = [], state = { owner: null, browserLease: false };
  const ctx = {
    config: { loginTakeoverEnabled: takeover },
    resolveCharacterRequestId: args => args[0], resolveSkipTutorial: () => true,
    log: { info() {}, debug() {}, warn() {} },
    getCharacterRecord: () => ({ accountId: 4, characterName: "Test pilot" }),
    normalizeAccountID: Number, characterBelongsToAccount: (r, id) => r.accountId === id,
    isCharacterQueuedForDeletion: () => false,
    characterControlRuntime: { assertRetailControlAvailable() {
      if (state.browserLease) throw Object.assign(new Error("browser lease"), { code: "CHARACTER_CONTROL_BROWSER_PILOT" });
      return { controlState: state.owner ? "retail_client" : "offline" };
    } },
    sessionRegistry: { findSessionByCharacterID(id, options) {
      calls.push(["lookup", id, options.includeClosing]); return state.owner;
    } },
    evictPriorSession(owner, options) {
      calls.push(["evict", owner, options.lifecycleReason]); state.owner = null;
    },
    throwWrappedUserError(type, payload) {
      throw Object.assign(new Error(payload.info), { name: "MachoWrappedException", type });
    },
  };
  const api = vm.runInNewContext(`({${selectionAuthority}return { retailTakeover }; }})`, ctx);
  return { calls, state, select: kwargs => api.Handle_SelectCharacterID([7, null, true], { userid: 4 }, kwargs) };
}

test("stock default enables retail takeover", () => {
  assert.equal(JSON.parse(read("config/server.json")).network.loginTakeoverEnabled, true);
  assert.match(read("server/src/config/schema/server.js"), /"key": "loginTakeoverEnabled",\s*"defaultValue": true/);
});

test("an owner appearing after offline proof is evicted by stock default selection", () => {
  const h = harness(true);
  assert.equal(h.state.owner, null, "offline proof before request");
  const foreign = { characterID: 7, userName: "foreign", clientID: 123 };
  h.state.owner = foreign;
  assert.equal(h.select({ freeOnly: true, noTakeover: true }).retailTakeover, true);
  assert.equal(h.calls.find(([name]) => name === "evict")[1], foreign);
  assert.equal(h.state.owner, null, "the existing owner was actually evicted");
  assert.equal(h.calls[0][2], true, "closing owners participate in duplicate arbitration");
});

test("stock takeover-disabled configuration refuses the concurrent owner intact", () => {
  const h = harness(false), foreign = { characterID: 7, userName: "foreign", clientID: 123 };
  h.state.owner = foreign;
  assert.throws(() => h.select(), /already online/);
  assert.equal(h.state.owner, foreign);
  assert.equal(h.calls.some(([name]) => name === "evict"), false);
});

test("holding a stock browser lease fences normal selection rather than converting it", () => {
  const h = harness(true); h.state.browserLease = true;
  assert.throws(() => h.select({ leaseID: "own", leaseSecret: "own", controllerID: "own" }), /active browser pilot/);
  assert.equal(h.state.browserLease, true);
  assert.deepEqual(h.calls, []);
});

test("stock gateway has no Factory selector or route", () => {
  for (const file of ["server/src/_secondary/express/evejsWebGateway.js",
    "server/src/_secondary/express/evejsWebGatewayRuntime.js", "server/src/edge/gateway/gatewayRuntimeProtocol.js"])
    assert.doesNotMatch(read(file), /selectFactoryCharacter|factory\/session/);
});
