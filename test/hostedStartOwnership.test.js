"use strict";

// Real public routes + real botHost + its production ownership probe. Only the
// gameplay/browser stack and gateway are fake. Older route tests fake the host
// and therefore never probe the reservation created by the route itself.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { once } = require("node:events");
process.env.EVEJS_WEB_POC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-start-ownership-"));
const replenishment = require("../src/replenishment");
const makeReplenishment = replenishment.createReplenishment;
let operations;
// Capture the EXISTING private map at its constructor seam, never a replacement
// ownership registry. This permits fault-injected stale/foreign reservations.
replenishment.createReplenishment = options => {
  operations = options.operations;
  return makeReplenishment(options);
};
const { createApp } = require("../src/server");
replenishment.createReplenishment = makeReplenishment;
const hostModule = require("../src/botHost"), webAuth = require("../src/webAuth");
const account = { username: "Test05", accountID: 44, role: "0", banned: false };
const characterID = 140000045;
const doc = { format: "evejs-bot-script", version: 1, program: [] };
const script = { scriptID: "test-patrol", name: "Test patrol", rev: 1, doc };
const grant = { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 10 };
const idle = { status: "idle", phase: null, why: null, startError: null };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function harness(t, { factory = "forbidden" } = {}) {
  const calls = [], sessions = new Map(), probes = [], starts = [];
  const hosted = { token: null, secret: null };
  const startupRuns = require("../src/startupRuns").createStartupRuns();
  let baseUrl, serial = 0, ownershipProbe, probeHook = null;
  const behavior = { selectFailure: false, releaseUncertain: false, startFailure: false, retailBusy: false, loginTakeoverEnabled: true };
  const gateway = {
    async getCharacterStatus(_accountID, id) {
      if (behavior.statusHook) await behavior.statusHook();
      const status = { characterID: id, online: behavior.retailBusy || sessions.size > 0,
        controlState: behavior.retailBusy ? "retail_client" : sessions.size ? "browser_pilot" : "offline" };
      if (behavior.afterStatusHook) await behavior.afterStatusHook();
      return status;
    },
    async readFlightStatus() { return { flight: { docked: true, inSpace: false, shipID: 9001, stationID: 60000004 } }; },
    async selectCharacter(args) {
      calls.push(["select", args[0]]);
      if (behavior.selectFailure) throw Object.assign(new Error("Selection refused."), { code: "CALL_REFUSED" });
      // Stock SelectCharacterID applies the server's configured retail policy.
      // This fixture deliberately permits the external-owner race when enabled.
      if (behavior.retailBusy) {
        if (!behavior.loginTakeoverEnabled) throw Object.assign(new Error("Already online."), { code: "CALL_REFUSED" });
        calls.push(["retail-takeover"]); behavior.retailBusy = false;
      }
      const bridgeSessionID = `test-bridge-${++serial}`;
      const outcome = { bridgeSessionID, session: { characterID: args[0], shipID: 9001, stationID: 60000004, solarSystemID: 30000001 }, notifications: [] };
      sessions.set(bridgeSessionID, outcome);
      if (behavior.selectOutcomeHook) await behavior.selectOutcomeHook(outcome);
      return outcome;
    },
    async selectFactoryCharacter(_accountID, id) {
      calls.push(["free-select", id]);
      if (behavior.retailBusy || sessions.size) throw Object.assign(new Error("PILOT_BUSY"), { code: "CALL_REFUSED" });
      return this.selectCharacter([id]);
    },
    async releaseBridgeSession(id, actor) {
      calls.push(["release", id, actor?.userid]);
      if (behavior.releaseUncertain) return { released: false };
      if (behavior.releaseGone) { sessions.delete(id); throw Object.assign(new Error("Already released."), { code: "SESSION_NOT_FOUND" }); }
      sessions.delete(id); return { released: true, offline: sessions.size === 0 };
    },
    async callMethod() { return { result: {}, notifications: [] }; },
    openSessionEventStream() { return { close() {} }; },
  };
  if (factory === "absent") delete gateway.selectFactoryCharacter;
  if (factory === "forbidden") gateway.selectFactoryCharacter = async () => {
    calls.push(["forbidden-factory"]);
    throw new Error("FACTORY ENDPOINT MUST NOT BE USED BY GENERIC HOSTED START");
  };
  const loadStack = async () => ({
    decodeScriptValue: value => ({ ok: true, doc: value }),
    analyzeBotRunPolicy: () => ({ riskClasses: [], restartSafe: true }),
    decodeCompanionSetupValue: value => ({ ok: true, setup: value }),
    analyzeCompanionRunPolicy: () => ({ riskClasses: [], restartSafe: true }),
    COMPANION_GRANT_SCRIPT_REV: 1,
    validateBotLaunchGrant: value => ({ ok: true, grant: value }),
    createClientStore() {
      const listeners = new Set(), state = { station: { online: null }, flight: { status: null }, space: { snapshot: null },
        mining: { holds: [] }, customBot: { ...idle }, companion: { ...idle } };
      return { ...Object.fromEntries(Object.keys(state).map(key => [key, { get: () => state[key] }])),
        set(key, value) { state[key] = value; for (const listener of listeners) listener(state); },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
    },
    createAppFlow(store, options) {
      hosted.token = options.initialSessionToken;
      async function request(route, body) {
        const response = await options.fetch(`${baseUrl}${route}`, { method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.initialSessionToken}` }, body: JSON.stringify(body || {}) });
        const value = await response.json();
        if (!response.ok) throw Object.assign(new Error(value.message || value.error), { code: value.error });
        return value;
      }
      return {
        async selectCharacter(id) { const selected = await request("/api/bridge/select", { characterID: id }); store.set("station", { online: selected.character }); },
        async startCustomBot() {
          if (behavior.startFailure) throw new Error("Injected start failure.");
          calls.push(["run"]); store.set("customBot", { ...idle, status: "running" });
        },
        stopCustomBot() { calls.push(["cancel"]); },
        async startFleetCompanion() { store.set("companion", { ...idle, status: "running" }); },
        stopFleetCompanion() {},
        async prepareHostedBotStop() {},
        async logout() { await request("/api/logout"); store.set("station", { online: null }); },
        async loadFlightStatus() { store.set("flight", { status: { docked: true } }); },
        async loadSpaceSnapshot() {}, async loadMiningHolds() {},
        async suspendHostedSession() {},
      };
    },
  });
  const makeHost = hostModule.createBotHost;
  hostModule.createBotHost = options => {
    ownershipProbe = options.isCharacterHeld;
    return makeHost({ ...options, persistPath: null, loadStack, startupRuns,
      prepareOperation: record => behavior.prepareOperation ? behavior.prepareOperation(record) : options.prepareOperation(record),
      isCharacterHeld: async (...args) => { probes.push(args); if (probeHook) await probeHook(args); return ownershipProbe(...args); } });
  };
  let app;
  try {
    app = createApp({ webAuth, eveGatewayClient: gateway, errorLogger() {},
      eveStore: { getAccount: async name => name === account.username ? account : null,
        getCharacterForAccount: async (id, pilot) => {
          if (behavior.characterLookupHook) await behavior.characterLookupHook();
          return id === account.accountID && pilot === characterID ? { characterID, characterName: "Test Pilot" } : null;
        },
        listCharactersForAccount: async () => [{ characterID, characterName: "Test Pilot" }] },
      botScriptStore: { get: id => id === script.scriptID ? script : null, list: () => [script] } });
  } finally { hostModule.createBotHost = makeHost; }
  const reservationMap = operations;
  const originalStart = app.locals.botHost.start;
  app.locals.botHost.start = input => { starts.push(input); return originalStart({ ...input, beforeStart: owner => {
    hosted.secret = owner.claimSecret; return input.beforeStart?.(owner);
  } }); };
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = webAuth.createSessionToken(account), caller = webAuth.verifySessionToken(token).sessionID;
  async function post(route, body, credential = token, headers = {}) {
    const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, ...headers }, body: JSON.stringify(body || {}) });
    return { status: response.status, body: await response.json() };
  }
  t.after(async () => {
    behavior.releaseUncertain = false; behavior.retailBusy = false; probeHook = null;
    await app.locals.botHost.stopAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  return { app, calls, sessions, probes, starts, behavior, hosted, startupRuns, reservations: reservationMap, caller, token,
    async browser(credential = token) {
      const selected = await post("/api/bridge/select", { characterID }, credential);
      assert.equal(selected.status, 200);
      const ready = await post("/api/bridge/drone-recovery/ready", { checkID: selected.body.droneRecoveryCheckID }, credential);
      assert.equal(ready.status, 200);
    },
    probe: (...args) => ownershipProbe(...args), hook: fn => { probeHook = fn; }, post,
    start: credential => post("/api/bots/start", { characterID, scriptID: script.scriptID, grant }, credential),
    stop: botID => post(`/api/bots/${botID}/stop`) };
}

for (const factory of ["absent", "forbidden"])
  test(`stock compatibility: public hosted Start and Stop with Factory ${factory}`, async t => {
    const h = await harness(t, { factory }), result = await h.start();
    assert.equal(h.probes.length, 1, "the production host probed its exact private reservation");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.bot.status, "running");
    assert.equal(h.app.locals.botHost.claimedBy(characterID), result.body.bot.botID);
    assert.equal(h.reservations.size, 0);
    assert.equal(h.app.locals.bridgeSessions.size, 1);
    assert.equal(h.calls.some(([name]) => name === "forbidden-factory" || name === "free-select"), false);
    assert.equal((await h.stop(result.body.bot.botID)).status, 200);
    assert.equal(h.sessions.size, 0);
    assert.equal(h.app.locals.bridgeSessions.size, 0);
    assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
    assert.equal(h.reservations.size, 0);
  });

for (const delayed of [false, true]) test(`publication fence: retired hosted header cannot select after lookup delay=${delayed}`, async t => {
  const h = await harness(t, { factory: "absent" }), running = await h.start();
  assert.equal(running.status, 200);
  const entered = deferred(), proceed = deferred();
  if (delayed) h.behavior.characterLookupHook = async () => { entered.resolve(); await proceed.promise; };
  const select = () => h.post("/api/bridge/select", { characterID }, h.hosted.token,
    { [hostModule.BOT_HEADER]: h.hosted.secret });
  let pending;
  if (delayed) { pending = select(); await entered.promise; }
  assert.equal((await h.stop(running.body.bot.botID)).status, 200);
  const before = h.calls.length;
  h.behavior.characterLookupHook = null; proceed.resolve();
  const result = await (pending || select());
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "HOSTED_GENERATION_CHANGED");
  assert.equal(h.calls.slice(before).some(([name]) => name === "select"), false);
  assert.equal(h.app.locals.bridgeSessions.size, 0); assert.equal(h.sessions.size, 0);
  assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

for (const cleanup of ["released", "uncertain", "gone"]) test(`publication fence: retired acquired outcome keeps exact cleanup=${cleanup}`, async t => {
  const uncertain = cleanup === "uncertain";
  const h = await harness(t, { factory: "absent" }), original = h.app.locals.botHost.start;
  h.app.locals.botHost.start = input => original({ ...input, operationID: "publication-run", operationRunID: "run-1", operationRole: "MINER" });
  const running = await h.start(); assert.equal(running.status, 200);
  const oldSecret = h.hosted.secret, entered = deferred(), proceed = deferred();
  let acquired;
  h.behavior.selectOutcomeHook = async outcome => { acquired = outcome; entered.resolve(); await proceed.promise; };
  const pending = h.post("/api/bridge/select", { characterID }, h.hosted.token, { [hostModule.BOT_HEADER]: oldSecret });
  await entered.promise;
  assert.equal(h.app.locals.botHost.reconnect(running.body.bot.botID, account.accountID).ok, true,
    "the production host rotates its private generation");
  assert.equal(h.app.locals.botHost.authorizesClaim(characterID, oldSecret), false);
  h.behavior.releaseUncertain = uncertain; h.behavior.releaseGone = cleanup === "gone"; proceed.resolve();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.error, uncertain ? "PILOT_RELEASE_UNVERIFIED" : "HOSTED_GENERATION_CHANGED");
  const heldID = webAuth.verifySessionToken(h.hosted.token).sessionID;
  if (uncertain) {
    const held = h.app.locals.bridgeSessions.get(heldID);
    assert.equal(held.bridgeSessionID, acquired.bridgeSessionID);
    assert.equal(held.botClaimSecret, oldSecret);
    assert.equal(held.selectionReleaseUnverified, true);
    assert.equal((await h.post("/api/bridge/select", { characterID }, h.hosted.token)).status, 409);
  } else {
    assert.equal(h.app.locals.bridgeSessions.has(heldID), false);
    assert.equal(h.sessions.size, 0);
  }
  assert.ok(h.calls.some(([name, id, userid]) => name === "release" && id === acquired.bridgeSessionID && userid === account.accountID));
  h.behavior.releaseUncertain = false; h.behavior.releaseGone = false; h.behavior.selectOutcomeHook = null;
  assert.equal((await h.stop(running.body.bot.botID)).status, 200);
  assert.equal(h.sessions.size, 0); assert.equal(h.app.locals.bridgeSessions.size, 0);
});

for (const kind of ["reservation", "held"]) test(`publication fence: restoration acquired outcome preserves newer ${kind}`, async t => {
  const h = await harness(t, { factory: "absent" }); await h.browser(); h.behavior.startFailure = true;
  const foreign = kind === "reservation" ? Symbol("newer-restoration-owner") :
    { characterID, accountID: account.accountID, bridgeSessionID: "foreign-restore-held" };
  let acquired;
  h.behavior.selectOutcomeHook = async outcome => {
    if (h.calls.filter(([name]) => name === "select").length < 3) return;
    acquired = outcome;
    if (kind === "reservation") h.reservations.set(characterID, foreign);
    else h.app.locals.bridgeSessions.set(h.caller, foreign);
  };
  const result = await h.start(); assert.notEqual(result.status, 200);
  if (kind === "reservation") {
    assert.equal(h.reservations.get(characterID), foreign);
    assert.equal(h.app.locals.bridgeSessions.has(h.caller), false);
    h.reservations.delete(characterID);
  } else {
    assert.equal(h.app.locals.bridgeSessions.get(h.caller), foreign);
    assert.equal(h.calls.some(([name, id]) => name === "release" && id === foreign.bridgeSessionID), false);
    h.app.locals.bridgeSessions.delete(h.caller);
  }
  assert.ok(h.calls.some(([name, id]) => name === "release" && id === acquired.bridgeSessionID));
  assert.equal(h.sessions.size, 0);
});

test("public Start permits its exact private reservation through the real host ownership probe", async t => {
  const h = await harness(t), result = await h.start();
  assert.equal(h.probes.length, 1, "the production host probed ownership");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.bot.status, "running");
  assert.equal(h.app.locals.botHost.claimedBy(characterID), result.body.bot.botID);
  assert.equal(h.reservations.size, 0, "the temporary reservation transferred into one hosted claim");
  assert.equal(h.app.locals.bridgeSessions.size, 1);
  assert.equal(h.calls.filter(([name]) => name === "select").length, 1);
  assert.equal(h.calls.some(([name]) => name === "forbidden-factory" || name === "free-select"), false);
  assert.equal("probeReservation" in result.body.bot, false);
  assert.equal((await h.stop(result.body.bot.botID)).status, 200);
  assert.equal(h.sessions.size, 0); assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

for (const changed of [false, true]) test(`Factory custody contract: exact same-run resume, custody changed after probe=${changed}`, async t => {
  const h = await harness(t, { factory: "allowed" }), operationID = "custody-operation", operationRunID = "custody-run", logicalRunID = "custody-logical";
  const operationPreparation = { version: 1, operationID, accountID: account.accountID, characterID, input: { source: { kind: "hangar" } } };
  const scriptHash = require("node:crypto").createHash("sha256")
    .update(JSON.stringify({ format: doc.format, program: doc.program, version: doc.version })).digest("hex");
  const cp = h.startupRuns.openPreparation({ logicalRunID, operationID, operationRunID, intent: operationPreparation,
    accountID: account.accountID, characterID, scriptHash, scriptRev: 1 });
  cp.begin({ custodyOperationID: "owned-custody" });
  let pending = [{ key: "owned-custody", accountID: account.accountID }], prepared = 0;
  h.app.locals.replenishment.unresolved = () => pending;
  h.behavior.prepareOperation = record => {
    prepared++; record.preparationCheckpoint.recover(); pending = [];
    return { state: "VERIFIED", evidence: { reconciled: true } };
  };
  const result = await h.app.locals.botHost.start({ account, characterID, kind: "script", scriptID: script.scriptID,
    scriptName: script.name, scriptRev: 1, doc, grant, resumed: true, logicalRunID, operationID, operationRunID,
    operationRole: "MINER", operationPreparation, deferMain: true,
    beforeStart: () => { if (changed) pending = [{ key: "foreign-custody", accountID: account.accountID }]; } });
  if (changed) {
    assert.equal(result.ok, false); assert.equal(prepared, 0);
    assert.equal(h.calls.some(([name]) => name === "free-select" || name === "select"), false);
    assert.equal(pending[0].key, "foreign-custody");
    pending = []; await h.app.locals.botHost.stopAll();
  } else {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(prepared, 1); assert.equal(h.calls.filter(([name]) => name === "free-select").length, 1);
    assert.equal(h.calls.some(([name]) => name === "run"), false, "MAIN remains behind its aggregate barrier");
    assert.equal((await h.stop(result.bot.botID)).status, 200);
    assert.equal(h.sessions.size, 0); assert.equal(h.app.locals.bridgeSessions.size, 0);
  }
});

test("hosted Defender retains exact MCC role/run metadata through public ownership and release", async t => {
  const h = await harness(t), start = h.app.locals.botHost.start;
  h.app.locals.botHost.start = input => start({ ...input, operationID: "operation", operationRole: "DEFENDER", operationRunID: "run-1" });
  const result = await h.start();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.bot.operationRole, "DEFENDER");
  assert.equal(result.body.bot.operationID, "operation");
  assert.equal(h.probes[0][2].operationRunID, "run-1");
  assert.equal((await h.stop(result.body.bot.botID)).status, 200);
  assert.equal(h.sessions.size, 0);
  assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

test("exact identity in both maps is required, never a name, character or session alone", async t => {
  const h = await harness(t), entered = deferred(), release = deferred();
  h.hook(async args => { entered.resolve(args); await release.promise; });
  const pending = h.start(), args = await entered.promise, own = h.reservations.get(characterID);
  try {
    assert.equal(typeof own, "symbol");
    assert.equal(args[3], own);
    assert.equal(await h.probe(characterID, h.caller, null, own), false);
    for (const impostor of [Symbol("bot-handoff"), "bot-handoff", characterID, { kind: "bot-handoff" }])
      assert.equal(await h.probe(characterID, h.caller, null, impostor), true);
    assert.equal(await h.probe(characterID, "different-session", null, own), true);
    assert.equal(await h.probe(characterID + 1, h.caller, null, own), true);
  } finally { release.resolve(); }
  const result = await pending; assert.equal(result.status, 200);
  assert.equal(await h.probe(characterID, h.caller, null, own), true, "a retired reservation is not authority even on a free map");
});

test("fresh restart uses a new reservation, bot and logical generation; stale callbacks cannot steal it", async t => {
  const h = await harness(t), first = await h.start(), previous = h.starts[0];
  assert.equal(first.status, 200); assert.equal((await h.stop(first.body.bot.botID)).status, 200);
  const second = await h.start(); assert.equal(second.status, 200);
  assert.notEqual(h.starts[1].probeReservation, previous.probeReservation);
  assert.notEqual(second.body.bot.botID, first.body.bot.botID);
  assert.notEqual(second.body.bot.logicalRunID, first.body.bot.logicalRunID);
  const before = h.calls.length;
  await assert.rejects(previous.beforeStart(), error => error.code === "CHARACTER_IN_USE");
  assert.equal(await h.probe(characterID, h.caller, null, previous.probeReservation), true);
  assert.equal(h.calls.length, before);
  assert.equal(h.app.locals.botHost.claimedBy(characterID), second.body.bot.botID);
  assert.equal(h.sessions.size, 1);
});

for (const kind of ["factory", "temporary-provisioning", "hosted-other", "mining-operation-handoff"])
  test(`public Start cannot replace or clean another ${kind} reservation`, async t => {
    const h = await harness(t), foreign = { kind, operationID: "other", operationRunID: "other-generation" };
    h.reservations.set(characterID, foreign);
    try {
      const result = await h.start(); assert.equal(result.status, 409);
      assert.equal(h.reservations.get(characterID), foreign); assert.equal(h.calls.length, 0);
    } finally { h.reservations.delete(characterID); }
  });

test("another browser owner is never released by a refused Start", async t => {
  const h = await harness(t), other = webAuth.createSessionToken(account);
  await h.browser(other); const owner = [...h.app.locals.bridgeSessions.values()][0], before = h.calls.length;
  const result = await h.start(); assert.equal(result.status, 409); assert.equal(result.body.error, "CHARACTER_IN_USE");
  assert.equal([...h.app.locals.bridgeSessions.values()][0], owner); assert.equal(h.calls.length, before);
  await h.post("/api/logout", {}, other);
});

test("retail owner is refused before a hosted claim or selection", async t => {
  const h = await harness(t); h.behavior.retailBusy = true;
  const result = await h.start(); assert.equal(result.status, 409);
  assert.equal(h.calls.length, 0); assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
  assert.equal(h.reservations.size, 0); assert.equal(h.behavior.retailBusy, true);
});

for (const takeover of [true, false]) test(`external owner after probe follows stock loginTakeoverEnabled=${takeover}`, async t => {
  const h = await harness(t), makeFlowGate = deferred(), release = deferred();
  h.behavior.loginTakeoverEnabled = takeover;
  // WC's offline observation cannot fence a subsequent external retail login.
  const original = h.app.locals.botHost.start;
  h.app.locals.botHost.start = input => original({ ...input, beforeStart: async owner => {
    makeFlowGate.resolve(); await release.promise; return input.beforeStart(owner);
  } });
  const pending = h.start(); await makeFlowGate.promise; h.behavior.retailBusy = true; release.resolve();
  const result = await pending;
  assert.equal(h.calls.filter(([name]) => name === "select").length, 1);
  assert.equal(h.calls.some(([name]) => name === "forbidden-factory" || name === "free-select"), false);
  if (takeover) {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(h.calls.some(([name]) => name === "retail-takeover"), true);
    assert.equal(h.behavior.retailBusy, false, "stock server policy replaced the external owner");
    assert.equal((await h.stop(result.body.bot.botID)).status, 200);
  } else {
    assert.notEqual(result.status, 200);
    assert.equal(h.behavior.retailBusy, true, "stock server policy refused selection");
  }
  assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

test("caller-held stock pilot hands off to exactly one productive hosted owner and stops", async t => {
  const h = await harness(t, { factory: "absent" }); await h.browser();
  const caller = h.app.locals.bridgeSessions.get(h.caller), result = await h.start();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(h.app.locals.bridgeSessions.has(h.caller), false);
  assert.equal(h.sessions.size, 1); assert.equal(h.app.locals.bridgeSessions.size, 1);
  assert.equal(h.calls.filter(([name]) => name === "run").length, 1);
  assert.ok(h.calls.find(([name, id]) => name === "release" && id === caller.bridgeSessionID));
  assert.equal((await h.stop(result.body.bot.botID)).status, 200);
  assert.equal(h.sessions.size, 0); assert.equal(h.app.locals.bridgeSessions.size, 0);
  assert.equal(h.app.locals.botHost.claimedBy(characterID), null); assert.equal(h.reservations.size, 0);
});

for (const kind of ["browser", "reservation"]) test(`a newer WC ${kind} after the probe blocks hosted selection intact`, async t => {
  const h = await harness(t), entered = deferred(), release = deferred();
  const foreign = kind === "browser" ? { characterID, accountID: account.accountID, bridgeSessionID: "foreign-held" } : Symbol("foreign-current");
  const original = h.app.locals.botHost.start;
  h.app.locals.botHost.start = input => original({ ...input, beforeStart: async owner => {
    await input.beforeStart(owner); entered.resolve(); await release.promise;
  } });
  const pending = h.start(); await entered.promise;
  if (kind === "browser") h.app.locals.bridgeSessions.set("foreign-session", foreign);
  else h.reservations.set(characterID, foreign);
  release.resolve();
  try {
    assert.notEqual((await pending).status, 200);
    assert.equal(h.calls.some(([name]) => name === "select"), false);
    if (kind === "browser") assert.equal(h.app.locals.bridgeSessions.get("foreign-session"), foreign);
    else assert.equal(h.reservations.get(characterID), foreign);
  } finally {
    if (kind === "browser") h.app.locals.bridgeSessions.delete("foreign-session");
    else h.reservations.delete(characterID);
  }
});

test("another running hosted bot remains the sole owner after a second Start", async t => {
  const h = await harness(t), first = await h.start(); assert.equal(first.status, 200);
  const before = h.calls.length, refused = await h.start();
  assert.equal(refused.status, 409); assert.equal(refused.body.error, "BOT_ALREADY_RUNNING");
  assert.equal(h.calls.length, before); assert.equal(h.app.locals.botHost.claimedBy(characterID), first.body.bot.botID);
  assert.equal(h.reservations.size, 0); assert.equal(h.sessions.size, 1);
});

test("unresolved custody still blocks an exact self-reservation", async t => {
  const h = await harness(t); h.app.locals.replenishment.unresolved = () => [{ key: "unresolved-write" }];
  const result = await h.start(); assert.equal(result.status, 409);
  assert.equal(h.calls.length, 0); assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

test("existing MCC same-run handoff exception is unchanged and excludes other generations", async t => {
  const h = await harness(t), own = { kind: "mining-operation-handoff", operationID: "operation", operationRunID: "generation-1" };
  h.reservations.set(characterID, own);
  try {
    const intent = { operationRunID: "generation-1", operationPreparation: { operationID: "operation" } };
    assert.equal(await h.probe(characterID, null, intent), false);
    assert.equal(await h.probe(characterID, null, { ...intent, operationRunID: "generation-2" }), true);
    assert.equal(await h.probe(characterID, null, { ...intent, operationPreparation: { operationID: "other" } }), true);
    assert.equal((await h.start()).status, 409);
  } finally { h.reservations.delete(characterID); }
});

for (const failure of ["selectFailure", "startFailure"])
  test(`${failure} retires only this Start and allows a fresh attempt`, async t => {
    const h = await harness(t); h.behavior[failure] = true;
    assert.notEqual((await h.start()).status, 200);
    assert.equal(h.sessions.size, 0); assert.equal(h.reservations.size, 0);
    assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
    assert.equal(h.app.locals.botHost.list(account.accountID).some(row => row.status === "running"), false);
    h.behavior[failure] = false; assert.equal((await h.start()).status, 200);
  });

test("a failure after caller handoff restores only the released caller", async t => {
  const h = await harness(t); await h.browser(); h.behavior.startFailure = true;
  const old = h.app.locals.bridgeSessions.get(h.caller), result = await h.start();
  assert.notEqual(result.status, 200);
  const restored = h.app.locals.bridgeSessions.get(h.caller);
  assert.equal(restored?.characterID, characterID); assert.notEqual(restored, old);
  assert.equal(h.sessions.size, 1); assert.equal(h.reservations.size, 0);
  assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
  await h.post("/api/logout");
});

for (const kind of ["browser", "reservation", "custody"]) test(`failed handoff cannot restore over newer WC ${kind}`, async t => {
  const h = await harness(t); await h.browser(); h.behavior.startFailure = true;
  const foreign = kind === "browser" ? { characterID, accountID: account.accountID, bridgeSessionID: "new-browser" } : Symbol("new-reservation");
  h.behavior.afterStatusHook = async () => {
    if (h.calls.filter(([name]) => name === "select").length < 2 || h.sessions.size) return;
    if (kind === "browser") h.app.locals.bridgeSessions.set("new-session", foreign);
    if (kind === "reservation") h.reservations.set(characterID, foreign);
    if (kind === "custody") h.app.locals.replenishment.unresolved = () => [{ key: "new-custody" }];
  };
  try {
    const result = await h.start(); assert.notEqual(result.status, 200);
    assert.equal(h.app.locals.bridgeSessions.has(h.caller), false);
    assert.equal(h.calls.filter(([name]) => name === "select").length, 2, "restoration did not dispatch");
    if (kind === "browser") assert.equal(h.app.locals.bridgeSessions.get("new-session"), foreign);
    if (kind === "reservation") assert.equal(h.reservations.get(characterID), foreign);
    assert.match(result.body.message, /not restored/);
  } finally {
    h.behavior.afterStatusHook = null;
    if (kind === "browser") h.app.locals.bridgeSessions.delete("new-session");
    if (kind === "reservation") h.reservations.delete(characterID);
  }
});

for (const takeover of [true, false]) test(`failed handoff restoration inherits stock loginTakeoverEnabled=${takeover}`, async t => {
  const h = await harness(t); await h.browser(); h.behavior.startFailure = true;
  h.behavior.loginTakeoverEnabled = takeover;
  h.behavior.afterStatusHook = async () => {
    if (h.calls.filter(([name]) => name === "select").length >= 2 && !h.sessions.size) h.behavior.retailBusy = true;
  };
  const result = await h.start(); assert.notEqual(result.status, 200);
  h.behavior.afterStatusHook = null;
  assert.equal(h.calls.filter(([name]) => name === "select").length, 3);
  assert.equal(h.app.locals.bridgeSessions.has(h.caller), takeover);
  assert.equal(h.behavior.retailBusy, !takeover);
  assert.equal(h.reservations.size, 0); assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
  if (takeover) await h.post("/api/logout");
});

test("a caller identity mismatch cannot release or hand off its held row", async t => {
  const h = await harness(t); await h.browser();
  const held = h.app.locals.bridgeSessions.get(h.caller), before = h.calls.length;
  held.accountID = account.accountID + 1;
  try {
    assert.equal((await h.start()).status, 409);
    assert.equal(h.app.locals.bridgeSessions.get(h.caller), held);
    assert.equal(h.calls.slice(before).some(([name]) => ["select", "release", "run"].includes(name)), false);
    assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
  } finally { held.accountID = account.accountID; await h.post("/api/logout"); }
});

test("unconfirmed browser release preserves the original owner and does not run the bot", async t => {
  const h = await harness(t); await h.browser(); h.behavior.releaseUncertain = true;
  const owner = h.app.locals.bridgeSessions.get(h.caller), result = await h.start();
  assert.equal(result.status, 409); assert.equal(result.body.error, "PILOT_RELEASE_UNVERIFIED");
  assert.equal(h.app.locals.bridgeSessions.get(h.caller), owner); assert.equal(h.sessions.size, 1);
  assert.equal(h.calls.some(([name]) => name === "run"), false); assert.equal(h.reservations.size, 0);
  h.behavior.releaseUncertain = false; await h.post("/api/logout");
});

test("unconfirmed acquired-session cleanup retains hosted ownership until a proven Stop", async t => {
  const h = await harness(t); h.behavior.startFailure = true; h.behavior.releaseUncertain = true;
  assert.notEqual((await h.start()).status, 200);
  const botID = h.app.locals.botHost.claimedBy(characterID); assert.ok(botID);
  assert.equal(h.app.locals.botHost.list(account.accountID)[0].status, "paused");
  assert.equal((await h.start()).status, 409); assert.equal(h.sessions.size, 1);
  h.behavior.releaseUncertain = false;
  assert.equal((await h.stop(botID)).status, 200); assert.equal(h.sessions.size, 0);
  assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
});

test("two concurrent Starts have one winner and no duplicate ownership", async t => {
  const h = await harness(t), entered = deferred(), release = deferred();
  h.hook(async () => { entered.resolve(); await release.promise; });
  const first = h.start(); await entered.promise;
  const second = await h.start(webAuth.createSessionToken(account)); assert.equal(second.status, 409);
  release.resolve(); assert.equal((await first).status, 200);
  assert.equal(h.starts.length, 1); assert.equal(h.sessions.size, 1); assert.equal(h.reservations.size, 0);
  assert.equal(h.calls.filter(([name]) => name === "run").length, 1);
});

test("a stale late probe cannot claim or remove a replacement reservation", async t => {
  const h = await harness(t), entered = deferred(), release = deferred(), foreign = Symbol("replacement-owner");
  h.behavior.statusHook = async () => { entered.resolve(); await release.promise; };
  const pending = h.start(); await entered.promise; h.reservations.set(characterID, foreign); release.resolve();
  try {
    const result = await pending; assert.equal(result.status, 409);
    assert.equal(h.reservations.get(characterID), foreign); assert.equal(h.calls.length, 0);
    assert.equal(h.app.locals.botHost.claimedBy(characterID), null);
  } finally { h.reservations.delete(characterID); }
});

test("public companion Start passes the same exact reservation contract", async t => {
  const h = await harness(t), result = await h.post("/api/bots/start", { characterID, kind: "companion", request: {}, grant });
  assert.equal(result.status, 200); assert.equal(result.body.bot.kind, "companion");
  assert.equal(typeof h.starts[0].probeReservation, "symbol");
  assert.equal(h.reservations.size, 0); assert.equal((await h.stop(result.body.bot.botID)).status, 200);
});
