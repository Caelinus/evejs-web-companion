"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../src/server");
const { createMiningSupportAnchorBoard } = require("../src/miningSupportAnchorBoard");

const FLEET = "9007199254740993123";
const OTHER = "654500019999";
const keyVal = entries => ({ type: "object", args: { type: "dict", entries } });

test("anchor release is scoped to the exact current held owner", () => {
  const board = createMiningSupportAnchorBoard({ now: () => 1000 });
  const owner = { accountID: 1, characterID: 11, bridgeSessionID: "one", activeShipID: 101, fleetID: "7" };
  const other = { accountID: 2, characterID: 12, bridgeSessionID: "two", activeShipID: 102, fleetID: "7" };
  const facts = pilot => ({ shipID: pilot.activeShipID, fleetID: "7", solarSystemID: 3001, observedAtMs: 1000, sampledAtMs: 10, services: {} });
  board.publish(owner, facts(owner)); board.publish(other, facts(other));
  const roster = { fleetID: "7", members: [owner, other].map(row => ({ characterID: row.characterID, solarSystemID: 3001 })) };
  board.release({ ...owner }); assert.equal(board.read(roster, () => true).anchors.length, 2);
  board.release(owner); assert.deepEqual(board.read(roster, () => true).anchors.map(row => row.characterID), [12]);
});

test("guarded recreation publishes new authority and new readers cannot consume prior fleet anchor", async () => {
  const f = await fixture();
  assert.equal((await f.publish(1, { expectedCharacterID: 90000001, expectedFleetID: FLEET })).anchor.fleetID, FLEET);
  f.sessions.get("1").actualFleet = OTHER;
  f.sessions.get("2").actualFleet = OTHER;
  assert.deepEqual((await f.request(2)).anchors, []);
  assert.equal((await f.publish(1, { expectedCharacterID: 90000001, expectedFleetID: FLEET })).error, "SUPPORT_FLEET_CHANGED");
  assert.equal((await f.publish(1, { expectedCharacterID: 90000002, expectedFleetID: OTHER })).error, "SUPPORT_CHARACTER_CHANGED");
  const next = await f.publish(1, { expectedCharacterID: 90000001, expectedFleetID: OTHER });
  assert.equal(next.anchor.fleetID, OTHER);
  assert.equal((await f.request(2)).anchors[0].fleetID, OTHER);
});

test("guarded publication refuses unknown authority and fleet or character changes during reads", async () => {
  const f = await fixture();
  assert.equal((await f.publish(1, { expectedFleetID: null })).status, 400);
  assert.equal((await f.publish(1, { expectedCharacterID: null })).status, 400);
  f.setHook(() => { f.sessions.get("1").actualFleet = OTHER; });
  assert.equal((await f.publish(1, { expectedCharacterID: 90000001, expectedFleetID: FLEET })).error, "FLEET_UNKNOWN");
  f.sessions.get("1").actualFleet = FLEET;
  f.setHook(() => { f.sessions.get("1").characterID = 90000004; });
  assert.equal((await f.publish(1, { expectedCharacterID: 90000001, expectedFleetID: FLEET })).error, "SUPPORT_CHARACTER_CHANGED");
});
const servers = new Set();
test.afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
  servers.clear();
});

async function fixture() {
  let stamp = 100_000;
  const sessions = new Map([1, 2, 3].map(n => [String(n), { accountID: n, characterID: 90000000 + n,
    bridgeSessionID: `bridge:${n}`, activeShipID: 1000 + n, fleetID: OTHER,
    actualFleet: n === 3 ? OTHER : FLEET, boundHandles: new Map(), transition: null, streamSubscribers: new Set() }]));
  let hook = () => {};
  let spaceOverride = null;
  let rosterOverride = null;
  let fleetFailure = null;
  const calls = [];
  function ship(held) {
    return { inSpace: true, shipID: held.activeShipID, solarSystemID: 30000142, sampledAtMs: 400,
      ship: { itemID: held.activeShipID, characterID: held.characterID, radius: 100,
        position: { x: 0, y: 0, z: 0 }, miningBurstServices: {
          activeModuleIDs: [42], bursts: [{ moduleID: 42, typeID: 99, rangeMeters: 90_000 }] },
        compressionService: { state: "active", typeListRanges: [{ typeListID: 10, rangeMeters: 60_000 }, { typeListID: 11, rangeMeters: 30_000 }], compressors: [{ moduleID: 43, typeID: 100 }] } },
      entities: [{ kind: "ship", itemID: 9999, compressionService: { state: "active", typeListRanges: [{ typeListID: 12, rangeMeters: 1_000_000 }] } }] };
  }
  const gateway = {
    async bindObject(service, method, args, kwargs, fields, sessionID) {
      calls.push({ service, method, args, sessionID });
      assert.equal(service, "fleetObjectHandler");
      assert.equal(method, "MachoBindObject");
      assert.deepEqual(args, [], "only session-owned fleet binding");
      return { boundHandle: sessionID };
    },
    async callBoundMethod(service, method, args, kwargs, fields, sessionID) {
      assert.equal(method, "GetInitState");
      assert.deepEqual(args, []);
      if (fleetFailure) throw Object.assign(new Error(fleetFailure), { code: fleetFailure });
      const held = [...sessions.values()].find(row => row.bridgeSessionID === sessionID);
      const members = rosterOverride ?? [...sessions.values()].filter(row => row.actualFleet === held.actualFleet);
      return { result: keyVal([["fleetID", held.actualFleet === null ? null : { type: "long", value: held.actualFleet }],
        ["members", { type: "dict", entries: members.map(row => [row.characterID, keyVal([["charID", row.characterID], ["solarSystemID", row.actualSolarSystemID ?? 30000142]])]) }]]) };
    },
    async readSpaceSnapshot(sessionID) {
      const held = [...sessions.values()].find(row => row.bridgeSessionID === sessionID);
      const space = spaceOverride ?? ship(held);
      await hook();
      return { space };
    },
  };
  const app = createApp({ eveStore: { async getAccount(username) { return { username, accountID: Number(username), role: "0", banned: false }; } },
    webAuth: { verifySessionToken(token) { return ["1", "2", "3"].includes(token) ? { username: token, accountID: Number(token), sessionID: token } : null; }, countConfiguredUsers() { return 3; } },
    eveGatewayClient: gateway, bridgeSessionStore: sessions, staticData: {}, errorLogger() {},
    miningSupportAnchorBoard: createMiningSupportAnchorBoard({ now: () => stamp }) });
  const server = app.listen(0, "127.0.0.1");
  servers.add(server);
  await once(server, "listening");
  async function request(pilot = 1, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bots/mining-support-anchors`, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", cookie: `evejs_web_poc=${pilot}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  }
  return { sessions, calls, request, publish: (pilot = 1, extra = {}) => request(pilot, { observedShipID: 1000 + pilot, observedAtMs: 400, ...extra }),
    advance(ms) { stamp += ms; }, setHook(fn) { hook = fn; }, setSpace(value) { spaceOverride = value; },
    setRoster(value) { rosterOverride = value; }, setFleetFailure(value) { fleetFailure = value; } };
}

test("publication binds held character and freshly proven exact fleet; spoofed facts are ignored", async () => {
  const f = await fixture();
  const result = await f.publish(1, { characterID: 90000002, fleetID: OTHER, shipID: 9999,
    position: { x: 999, y: 999, z: 999 }, services: { bursts: { rangeMeters: 1_000_000 } } });
  assert.equal(result.status, 200);
  assert.equal(result.anchor.characterID, 90000001);
  assert.equal(result.anchor.shipID, 1001);
  assert.equal(result.anchor.fleetID, FLEET);
  assert.deepEqual(result.anchor.services.compression.typeListRanges, [{ typeListID: 10, rangeMeters: 60_000 }, { typeListID: 11, rangeMeters: 30_000 }]);
  assert.equal(result.anchor.services.bursts.bursts[0].rangeMeters, 90_000);
  assert.equal(result.anchor.position, undefined);
  assert.equal(result.anchor.bridgeSessionID, undefined);
  assert.equal(f.calls.length, 2, "membership rechecked around observation");
});
test("two publishers remain separate and another fleet reads no anchors", async () => {
  const f = await fixture();
  await f.publish(1); await f.publish(2);
  const read = await f.request(2);
  assert.deepEqual(read.anchors.map(row => row.characterID), [90000001, 90000002]);
  assert.equal(read.fleet.readerCharacterID, 90000002);
  assert.deepEqual((await f.request(3)).anchors, []);
});
test("no live/authenticated session, unproved fleet or absent roster membership cannot publish", async () => {
  const f = await fixture();
  assert.equal((await f.request(9)).status, 401);
  f.sessions.delete("2");
  assert.equal((await f.publish(2)).error, "NO_LIVE_SESSION");
  f.sessions.get("1").actualFleet = null;
  assert.equal((await f.publish()).error, "FLEET_UNKNOWN");
  assert.equal((await f.request()).availability, "unknown");
  assert.equal(f.sessions.get("1").fleetID, null, "cached membership is cleared");
  f.sessions.get("1").actualFleet = FLEET;
  f.setRoster([]);
  assert.equal((await f.publish()).error, "FLEET_UNKNOWN");
});
test("read failures are unknown, never an empty successful fleet board", async () => {
  const f = await fixture(); await f.publish();
  f.setFleetFailure("READ_FAILED");
  const read = await f.request(2);
  assert.equal(read.availability, "unknown");
  assert.deepEqual(read.anchors, []);
  f.setFleetFailure("CALL_REFUSED");
  assert.equal((await f.publish()).error, "FLEET_UNKNOWN");
});
test("10s boundary expires; reading never renews; 30s retention removes stale diagnostics", async () => {
  const f = await fixture(); const { anchor } = await f.publish();
  f.advance(9999);
  assert.equal((await f.request(2)).anchors[0].freshness, "fresh");
  f.advance(1);
  const stale = (await f.request(2)).anchors[0];
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.ageMs, 10_000);
  assert.equal(stale.expiresAtMs, anchor.expiresAtMs);
  f.advance(20_000);
  assert.deepEqual((await f.request(2)).anchors, []);
});
test("ship/session replacement and fleet departure invalidate retained publications", async () => {
  const f = await fixture(); await f.publish();
  const held = f.sessions.get("1");
  held.activeShipID = 2001;
  assert.equal((await f.request(2)).anchors[0].reason, "ship-changed");
  assert.equal((await f.publish()).error, "SUPPORT_SHIP_CHANGED");
  held.activeShipID = 1001;
  f.sessions.set("1", { ...held, bridgeSessionID: "new-session" });
  assert.equal((await f.request(2)).anchors[0].reason, "session-changed");
  await f.publish();
  f.sessions.get("1").actualFleet = OTHER;
  assert.equal((await f.request(2)).anchors[0].reason, "fleet-changed");
});
test("in-flight session/fleet changes and slow observations do not publish", async () => {
  const f = await fixture();
  f.setHook(() => f.sessions.set("1", { ...f.sessions.get("1"), bridgeSessionID: "replacement" }));
  assert.equal((await f.publish()).error, "SESSION_CHANGED");
  f.setHook(() => { f.sessions.get("1").actualFleet = OTHER; });
  assert.equal((await f.publish()).error, "FLEET_UNKNOWN");
  f.setHook(() => f.advance(10_000));
  assert.equal((await f.publish()).error, "FLEET_UNKNOWN");
  f.setHook(() => {});
  assert.deepEqual((await f.request(3)).anchors, []);
});
test("unknown guards/foreign ship/future sample refuse; missing runtime fields stay unknown", async () => {
  const f = await fixture();
  assert.equal((await f.publish(1, { observedAtMs: null })).status, 400);
  assert.equal((await f.publish(1, { observedAtMs: 401 })).error, "SUPPORT_OBSERVATION_UNKNOWN");
  assert.equal((await f.publish(1, { observedShipID: 1002 })).error, "SUPPORT_SHIP_CHANGED");
  f.setSpace({ inSpace: true, sampledAtMs: 400, shipID: 1001, solarSystemID: 30000142, ship: { itemID: 1001, characterID: 90000001 }, entities: [] });
  const { anchor } = await f.publish();
  assert.equal(anchor.services.bursts, null);
  assert.equal(anchor.services.compression.state, "unknown");
  assert.equal(anchor.services.supportEffects, null);
});

test("a late older concurrent observation cannot replace the newer service publication", async () => {
  const f = await fixture();
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.setHook(async () => { f.setHook(() => {}); entered(); await pending; });
  const older = f.publish();
  await started;
  f.setSpace({ inSpace: true, sampledAtMs: 500, shipID: 1001, solarSystemID: 30000142, ship: { itemID: 1001, characterID: 90000001 }, entities: [] });
  assert.equal((await f.publish()).anchor.sampledAtMs, 500);
  release();
  assert.equal((await older).error, "SUPPORT_OBSERVATION_SUPERSEDED");
  assert.equal((await f.request(2)).anchors[0].sampledAtMs, 500);
});
test("same-object session changes are guarded and get a new public epoch", async () => {
  const f = await fixture(); const previous = (await f.publish()).anchor;
  f.setHook(() => { f.sessions.get("1").bridgeSessionID = "changed-in-flight"; });
  assert.equal((await f.publish()).error, "SESSION_CHANGED");
  f.setHook(() => {});
  const next = (await f.publish()).anchor;
  assert.notEqual(next.sessionEpoch, previous.sessionEpoch);
});
test("fresh roster and space system disagreement cannot publish a current anchor", async () => {
  const f = await fixture();
  f.setRoster([{ ...f.sessions.get("1"), actualSolarSystemID: 30000143 }]);
  assert.equal((await f.publish()).error, "SUPPORT_SYSTEM_CHANGED");
  assert.deepEqual((await f.request()).anchors, []);
});
