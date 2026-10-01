"use strict";

// Goal R105 (Phase-4 BOUND WRITES): the BFF fleet composition / membership / broadcast
// write routes — WB-FLEET (16 fleetObjectHandler writes: CreateWing / CreateSquad /
// MoveMember / KickMember / MakeLeader / LeaveFleet / DisbandFleet / SetOptions /
// SetMotdEx / UpdateMemberInfo / SendBroadcast / Invite / MassInvite / AcceptInvite /
// RejectInvite / Reconnect). These routes now back Fleet Center and bot actions.
//
// WB-FLEET rides the fleetObjectHandler.MachoBindObject bind (fleetBindSpec — the SAME
// handle the R85 bound fleet READS use). ⚠ UNLIKE the scanMgr bind, MachoBindObject
// ACCEPTS a caller fleetID. Most routes pass args:[] and bind the SESSION's OWN fleet;
// invite accept/reject + reconnect bind the invite/saved fleetID because the current
// session has none yet, and the runtime verifies the pending invite/member row. Each write dispatches
// as a BOUND method (boundCall → callBoundMethod), NOT the top-level /call
// seam. Every route is CONFIRM-GATED: without `confirm: true` it answers 400
// CONFIRMATION_REQUIRED and NOTHING dispatches (no bind, no bound call). This suite proves
// the gate (all 16 refuse without confirm), that each write forwards its args as a bound
// call ONCE confirmed against a FAKE recording gateway with either the session-owned bind
// or the explicit invite/saved fleetID, and that no route dispatches without a held bridge
// session. NO write was ever
// fired against the live world (operator owns EveJS; no server restart).

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const STATION_ID = 60003760;
const SOLAR_SYSTEM_ID = 30000142;
const CHARACTER_ID = 7;
const CORPORATION_ID = 98000000;
const SHIP_ID = 9001;
const MEMBER_ID = 140000009;
const TARGET_FLEET_ID = 123456;

const ORIGINAL_FETCH = global.fetch;
const activeServers = new Set();

function fakeAuth() {
  return {
    createSessionToken() {
      return COOKIE_TOKEN;
    },
    verifySessionToken(token) {
      return token === COOKIE_TOKEN
        ? { username: ACCOUNT.username, accountID: ACCOUNT.accountID, sessionID: SESSION_ID }
        : null;
    },
    countConfiguredUsers() {
      return 1;
    },
  };
}

function fakeStore() {
  return {
    async getAccount(username) {
      return username === ACCOUNT.username ? { ...ACCOUNT } : null;
    },
    async getCharacterForAccount(accountID, characterID) {
      return Number(accountID) === ACCOUNT.accountID && Number(characterID) === CHARACTER_ID
        ? { characterID: CHARACTER_ID, accountID: 4, characterName: "Test Pilot" }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
  };
}

function fakeStaticData() {
  return {
    getStation() {
      return null;
    },
    getTypeName(id) {
      return `Type ${id}`;
    },
    resolveNames() {
      return { names: {}, capped: false, limit: 500 };
    },
  };
}

// Most fleet writes bind the session's own fleet server-side. AcceptInvite, RejectInvite,
// and Reconnect explicitly bind their invite/saved fleetID; no inSpace toggle is needed.
function fakeGateway() {
  const calls = { call: [], bind: [], boundCall: [] };
  return {
    calls,
    async selectCharacter() {
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: 4,
          characterID: CHARACTER_ID,
          characterName: "Test Pilot",
          stationID: STATION_ID,
          structureID: null,
          solarSystemID: SOLAR_SYSTEM_ID,
          corporationID: CORPORATION_ID,
          shipID: SHIP_ID,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: CHARACTER_ID };
    },
    async readFlightStatus() {
      return {
        flight: { docked: true, inSpace: false, stationID: STATION_ID, solarSystemID: SOLAR_SYSTEM_ID, shipID: SHIP_ID },
        notifications: [],
      };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      if (service === "fleetMgr" && method === "ForceLeaveFleet") {
        return { service, method, result: true, notifications: [] };
      }
      throw new Error(`R105 fleet writes are BOUND — unexpected top-level ${service}.${method}`);
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, bridgeSessionID });
      return { boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`, service, method, notifications: [] };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, bridgeSessionID, boundHandle });
      return { service, method, result: true, notifications: [] };
    },
  };
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway,
    webAuth: fakeAuth(),
    staticData: options.staticData || fakeStaticData(),
    errorLogger() {},
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

async function selectOnServer(baseUrl) {
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: CHARACTER_ID } });
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  }
  await Promise.all(closing);
});

// --- the 16 R105 fleet write routes (path, body, method, expected bound args) ------

const R105_WRITE_ROUTES = [
  ["/api/bridge/fleet/wing/create", {}, "CreateWing", []],
  ["/api/bridge/fleet/squad/create", { wingID: 100 }, "CreateSquad", [100]],
  [
    "/api/bridge/fleet/member/move",
    { characterID: MEMBER_ID, wingID: 100, squadID: 200, role: 3 },
    "MoveMember",
    [MEMBER_ID, 100, 200, 3],
  ],
  ["/api/bridge/fleet/member/kick", { characterID: MEMBER_ID }, "KickMember", [MEMBER_ID]],
  ["/api/bridge/fleet/member/make-leader", { characterID: MEMBER_ID }, "MakeLeader", [MEMBER_ID]],
  ["/api/bridge/fleet/member/leave", {}, "LeaveFleet", []],
  ["/api/bridge/fleet/disband", {}, "DisbandFleet", []],
  ["/api/bridge/fleet/options", { options: { isFreeMove: true } }, "SetOptions", [{ isFreeMove: true }]],
  ["/api/bridge/fleet/motd", { motd: "Form up on the FC." }, "SetMotdEx", ["Form up on the FC."]],
  ["/api/bridge/fleet/member/update-info", { shipTypeID: 587 }, "UpdateMemberInfo", [587]],
  [
    "/api/bridge/fleet/broadcast",
    { name: "Target", scope: 1, itemID: 1000000, typeID: 587 },
    "SendBroadcast",
    ["Target", 1, 1000000, 587],
  ],
  [
    "/api/bridge/fleet/invite",
    { inviteeCharID: MEMBER_ID, wingID: 100, squadID: 200, role: 0 },
    "Invite",
    [MEMBER_ID, 100, 200, 0],
  ],
  [
    "/api/bridge/fleet/mass-invite",
    { characterIDs: [MEMBER_ID, 140000010], wingID: 100, squadID: 200, role: 0 },
    "MassInvite",
    [[MEMBER_ID, 140000010], 100, 200, 0],
  ],
  [
    "/api/bridge/fleet/invite/accept",
    // shipTypeID is deliberately hostile input: the route must ignore it and
    // let EveJS derive the current hull from the held session.
    { fleetID: TARGET_FLEET_ID, shipTypeID: 587 },
    "AcceptInvite",
    [null],
    [[TARGET_FLEET_ID]],
  ],
  [
    "/api/bridge/fleet/invite/reject",
    { fleetID: TARGET_FLEET_ID, alreadyInFleet: false },
    "RejectInvite",
    [false],
    [[TARGET_FLEET_ID]],
  ],
  [
    "/api/bridge/fleet/reconnect",
    { fleetID: TARGET_FLEET_ID },
    "Reconnect",
    [],
    [[TARGET_FLEET_ID]],
  ],
];

test("⚠ every R105 fleet write REFUSES without confirm — no bind, no dispatch (nothing fired)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  assert.equal(R105_WRITE_ROUTES.length, 16, "all 16 R105 fleet write routes are covered");
  for (const [path, body] of R105_WRITE_ROUTES) {
    const { response, payload } = await apiRequest(baseUrl, path, { method: "POST", body });
    assert.equal(response.status, 400, `${path} must refuse without confirm`);
    assert.equal(payload.error, "CONFIRMATION_REQUIRED", `${path} must answer CONFIRMATION_REQUIRED`);
  }
  assert.equal(gateway.calls.boundCall.length, 0, "a refused write must not dispatch a bound call");
  assert.equal(gateway.calls.bind.length, 0, "a refused write must not even bind the fleet object");
});

test("R105 every fleet write binds the correct fleet object and forwards its args once confirmed", async () => {
  for (const [path, body, method, expectedArgs, expectedBindArgs = []] of R105_WRITE_ROUTES) {
    const gateway = fakeGateway();
    const { baseUrl } = await startTestServer({ gateway });
    await selectOnServer(baseUrl);
    const { response, payload } = await apiRequest(baseUrl, path, {
      method: "POST",
      body: { ...body, confirm: true },
    });
    assert.equal(response.status, 200, `${path} must succeed once confirmed`);
    assert.equal(payload.ok, true, `${path} ok`);
    assert.equal(payload.applied, true, `${path} applied`);
    // Bound, not top-level. Most routes bind the session fleet with [], while
    // reject/reconnect bind the invite/saved fleet explicitly as [[fleetID]].
    const bind = gateway.calls.bind.find((c) => c.service === "fleetObjectHandler");
    assert.ok(bind, `${path} binds the fleet object`);
    assert.equal(bind.method, "MachoBindObject", `${path} bind method`);
    assert.deepEqual(bind.args, expectedBindArgs, `${path} binds the intended fleet`);
    const call = gateway.calls.boundCall.find((c) => c.method === method);
    assert.ok(call, `${method} must reach the gateway as a bound call once confirmed`);
    assert.equal(call.service, "fleetObjectHandler", `${method} service`);
    assert.deepEqual(call.args, expectedArgs, `${method} forwards its educated-guess args`);
  }
});

test("RejectInvite binds the invited fleet and preserves omitted versus explicit boolean args", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const variants = [
    [{ fleetID: TARGET_FLEET_ID }, []],
    [{ fleetID: TARGET_FLEET_ID, alreadyInFleet: false }, [false]],
    [{ fleetID: TARGET_FLEET_ID, alreadyInFleet: true }, [true]],
  ];
  for (const [body, expectedArgs] of variants) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fleet/invite/reject", {
      method: "POST",
      body: { ...body, confirm: true },
    });
    assert.equal(response.status, 200);
    assert.equal(payload.applied, true);
    assert.deepEqual(gateway.calls.boundCall.at(-1).args, expectedArgs);
  }

  const binds = gateway.calls.bind.filter(
    (call) => call.service === "fleetObjectHandler" && call.method === "MachoBindObject",
  );
  assert.equal(binds.length, 3, "success invalidates the targeted handle after each reject");
  assert.deepEqual(binds.map((call) => call.args), [
    [[TARGET_FLEET_ID]],
    [[TARGET_FLEET_ID]],
    [[TARGET_FLEET_ID]],
  ]);
});

test("AcceptInvite, RejectInvite, and Reconnect require a positive fleetID before binding", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  for (const [path, body] of [
    ["/api/bridge/fleet/invite/accept", {}],
    ["/api/bridge/fleet/invite/accept", { fleetID: Number.MAX_SAFE_INTEGER + 1 }],
    ["/api/bridge/fleet/invite/reject", { fleetID: 0 }],
    ["/api/bridge/fleet/invite/reject", { fleetID: -1 }],
    ["/api/bridge/fleet/reconnect", {}],
    ["/api/bridge/fleet/reconnect", { fleetID: Number.MAX_SAFE_INTEGER + 1 }],
  ]) {
    const { response, payload } = await apiRequest(baseUrl, path, {
      method: "POST",
      body: { ...body, confirm: true },
    });
    assert.equal(response.status, 400, `${path} rejects an invalid fleetID`);
    assert.equal(payload.error, "INVALID_FLEET_ID");
  }
  const invalidBoolean = await apiRequest(baseUrl, "/api/bridge/fleet/invite/reject", {
    method: "POST",
    body: { fleetID: TARGET_FLEET_ID, alreadyInFleet: "false", confirm: true },
  });
  assert.equal(invalidBoolean.response.status, 400);
  assert.equal(invalidBoolean.payload.error, "INVALID_ALREADY_IN_FLEET");
  assert.equal(gateway.calls.bind.length, 0);
  assert.equal(gateway.calls.boundCall.length, 0);
});

test("an uncertain targeted-fleet failure invalidates the handle before retry", async () => {
  const gateway = fakeGateway();
  let attempts = 0;
  gateway.callBoundMethod = async (
    service,
    method,
    args,
    kwargs,
    sessionFields,
    bridgeSessionID,
    boundHandle,
  ) => {
    gateway.calls.boundCall.push({ service, method, args, kwargs, bridgeSessionID, boundHandle });
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("uncertain reject outcome");
      error.code = "CALL_FAILED";
      throw error;
    }
    return { service, method, result: true, notifications: [] };
  };
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const body = { fleetID: TARGET_FLEET_ID, confirm: true };
  const first = await apiRequest(baseUrl, "/api/bridge/fleet/invite/reject", {
    method: "POST",
    body,
  });
  assert.notEqual(first.response.status, 200);
  const second = await apiRequest(baseUrl, "/api/bridge/fleet/invite/reject", {
    method: "POST",
    body,
  });
  assert.equal(second.response.status, 200);
  assert.equal(
    gateway.calls.bind.filter((call) => call.method === "MachoBindObject").length,
    2,
    "the retry cannot reuse the handle from an uncertain failure",
  );
});

test("⚠ R105 DisbandFleet (DESTRUCTIVE) binds the session's own fleet, no caller fleetID, once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/fleet/disband", {
    method: "POST",
    body: { confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  const bind = gateway.calls.bind.find((c) => c.service === "fleetObjectHandler");
  assert.ok(bind && bind.method === "MachoBindObject" && bind.args.length === 0, "disband binds the session's own fleet, no caller fleetID");
  const call = gateway.calls.boundCall.find((c) => c.method === "DisbandFleet");
  assert.ok(call, "DisbandFleet must reach the gateway once confirmed");
  assert.deepEqual(call.args, []);
});

test("⚠ R105 KickMember (removes another char) forwards [characterID] once confirmed", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response } = await apiRequest(baseUrl, "/api/bridge/fleet/member/kick", {
    method: "POST",
    body: { characterID: MEMBER_ID, confirm: true },
  });
  assert.equal(response.status, 200);
  const call = gateway.calls.boundCall.find((c) => c.method === "KickMember");
  assert.ok(call, "KickMember must reach the gateway once confirmed");
  assert.equal(call.service, "fleetObjectHandler");
  assert.deepEqual(call.args, [MEMBER_ID]);
});

test("R105 fleet write routes refuse without a held bridge session", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  // No selectOnServer — no held session.
  for (const [path, body] of R105_WRITE_ROUTES) {
    const { response } = await apiRequest(baseUrl, path, { method: "POST", body: { ...body, confirm: true } });
    assert.notEqual(response.status, 200, `${path} must refuse without a held session`);
  }
  assert.equal(gateway.calls.boundCall.length, 0, "no dispatch without a held session");
});

test("own-fleet reads rebind current membership on every refresh while sharing one handle within a batch", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  for (let index = 0; index < 2; index += 1) {
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/bound-fleet");
    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
  }

  const ownFleetBinds = gateway.calls.bind.filter(
    (call) => call.service === "fleetObjectHandler" && call.method === "MachoBindObject",
  );
  assert.equal(ownFleetBinds.length, 2, "each refresh resolves membership again");
  assert.deepEqual(ownFleetBinds.map((call) => call.args), [[], []]);
  assert.equal(
    gateway.calls.boundCall.filter((call) => [
      "GetInitState",
      "GetWings",
      "GetMotd",
      "GetJoinRequests",
      "GetFleetComposition",
    ].includes(call.method)).length,
    10,
    "the five reads still share one bind per refresh",
  );
});

test("own-fleet envelopes retain a bind invitation and successful read drains even when another read is refused", async () => {
  const invite = { method: "OnFleetInvite", args: [700, MEMBER_ID, "AskJoinFleet", {}] };
  const joined = { method: "OnFleetJoin", args: [MEMBER_ID] };
  const gateway = { ...fakeGateway(),
    async bindObject(service, method) { return { boundHandle: "fleet-handle", service, method, notifications: [invite] }; },
    async callBoundMethod(service, method) {
      if (method === "GetWings") throw Object.assign(new Error("Refused"), { code: "CALL_REFUSED" });
      return { service, method, result: true, notifications: method === "GetInitState" ? [joined] : [] };
    },
  };
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/bound-fleet");
  assert.equal(response.status, 200);
  assert.equal(payload.reads.GetWings.error, "CALL_REFUSED");
  assert.deepEqual(payload.notifications, [invite, joined]);
});

test("creating a fleet invalidates a previously fleetless handle before the next bound write", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/bound-fleet");
  const created = await apiRequest(baseUrl, "/api/bridge/fleet/create", {
    method: "POST",
    body: { confirm: true },
  });
  assert.equal(created.response.status, 200);
  const motd = await apiRequest(baseUrl, "/api/bridge/fleet/motd", {
    method: "POST",
    body: { motd: "New fleet", confirm: true },
  });
  assert.equal(motd.response.status, 200);

  assert.equal(
    gateway.calls.bind.filter(
      (call) => call.service === "fleetObjectHandler" && call.method === "MachoBindObject",
    ).length,
    2,
    "the post-create write cannot reuse the pre-create membership handle",
  );
  assert.equal(
    gateway.calls.bind.filter((call) => call.method === "CreateFleet").length,
    1,
    "fleet creation uses its own one-shot bind",
  );
});

test("top-level and bound leave paths invalidate the old roster handle", async () => {
  for (const leavePath of ["/api/bridge/fleet/leave", "/api/bridge/fleet/member/leave"]) {
    const gateway = fakeGateway();
    const { baseUrl } = await startTestServer({ gateway });
    await selectOnServer(baseUrl);
    await apiRequest(baseUrl, "/api/bridge/bound-fleet");

    const left = await apiRequest(baseUrl, leavePath, {
      method: "POST",
      body: { confirm: true },
    });
    assert.equal(left.response.status, 200, `${leavePath} succeeds`);
    const nextWrite = await apiRequest(baseUrl, "/api/bridge/fleet/motd", {
      method: "POST",
      body: { motd: "must rebind", confirm: true },
    });
    assert.equal(nextWrite.response.status, 200);
    assert.equal(
      gateway.calls.bind.filter(
        (call) => call.service === "fleetObjectHandler" && call.method === "MachoBindObject",
      ).length,
      2,
      `${leavePath} drops the old membership-scoped handle`,
    );
  }
});

test("accepting through an invitation-scoped fleet handle never caches that foreign-target bind", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  for (let index = 0; index < 2; index += 1) {
    const accepted = await apiRequest(baseUrl, "/api/bridge/fleet/invite/accept", {
      method: "POST",
      body: { fleetID: 123456, shipTypeID: 587, confirm: true },
    });
    assert.equal(accepted.response.status, 200);
  }
  const inviteBinds = gateway.calls.bind.filter(
    (call) => call.service === "fleetObjectHandler" && call.method === "MachoBindObject",
  );
  assert.equal(inviteBinds.length, 2);
  assert.deepEqual(inviteBinds.map((call) => call.args), [[[123456]], [[123456]]]);
});

test("recovery invitation binds the expected surviving fleet and never follows changed membership", async () => {
  for (const membershipAfterBind of [TARGET_FLEET_ID, null, TARGET_FLEET_ID + 1]) {
    const gateway = fakeGateway(); let boundFleetID, invited = 0;
    const bind = gateway.bindObject, call = gateway.callBoundMethod;
    gateway.bindObject = async (...args) => { boundFleetID = args[2][0][0]; return bind(...args); };
    gateway.callBoundMethod = async (...args) => {
      // Model the runtime's synchronous exact-bound-fleet membership gate,
      // including a member changing fleets after the BFF started binding.
      if (boundFleetID !== membershipAfterBind) throw Object.assign(new Error("FleetNotInFleet"), { code: "CALL_REFUSED", statusCode: 409 });
      invited++; return call(...args);
    };
    const { baseUrl } = await startTestServer({ gateway }); await selectOnServer(baseUrl);
    const result = await apiRequest(baseUrl, "/api/bridge/fleet/invite", { method: "POST",
      body: { inviteeCharID: MEMBER_ID, expectedFleetID: TARGET_FLEET_ID, confirm: true } });
    assert.equal(result.response.status, membershipAfterBind === TARGET_FLEET_ID ? 200 : 409);
    assert.equal(invited, membershipAfterBind === TARGET_FLEET_ID ? 1 : 0);
    assert.deepEqual(gateway.calls.bind.map(row => row.args), [[[TARGET_FLEET_ID]]]);
    assert.equal(gateway.calls.bind.some(row => row.method === "CreateFleet"), false);
  }
});

test("malformed expected fleet identity refuses before any recovery invitation dispatch", async () => {
  const gateway = fakeGateway(); const { baseUrl } = await startTestServer({ gateway }); await selectOnServer(baseUrl);
  for (const expectedFleetID of [null, 0, -1, 1.5, "not-an-id"]) {
    const result = await apiRequest(baseUrl, "/api/bridge/fleet/invite", { method: "POST",
      body: { inviteeCharID: MEMBER_ID, expectedFleetID, confirm: true } });
    assert.equal(result.response.status, 400);
  }
  assert.equal(gateway.calls.bind.length, 0); assert.equal(gateway.calls.boundCall.length, 0);
});
