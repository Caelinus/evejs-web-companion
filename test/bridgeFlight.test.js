"use strict";

// Goal R5a: the BFF Flight routes drive manually-stepped space movement.
// ship.Undock is a top-level call on the held session; warp/jump/dock go
// through the beyonce remote-park bound-object two-step (the BFF holds the
// bound park handle server-side, keyed by solar system so a jump rebinds).
// A movement refusal passes through as the handler's own CALL_REFUSED message.
// Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const CHARACTERS = [{ characterID: 7, accountID: 4, characterName: "Test Pilot" }];
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const ORIGIN_STATION_ID = 60003760;
const ORIGIN_SYSTEM_ID = 30000142;
const DEST_SYSTEM_ID = 30000140;
const DEST_STATION_ID = 60003454;
const SHIP_ID = 9001;
const GATE_ID = 50001248;
const DEST_GATE_ID = 50000802;
const STRUCTURE_GATE_ID = 1030000000001;

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
      return Number(accountID) === ACCOUNT.accountID &&
        CHARACTERS.some((c) => c.characterID === Number(characterID))
        ? { ...CHARACTERS[0] }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
  };
}

function fakeStaticData() {
  return { getStation() { return null; }, getTypeName(id) { return `Type ${id}`; } };
}

// A fake gateway whose flight state advances the way the real space handlers do:
// docked -> (undock) in space -> (jump) new system -> (dock) docked. Records the
// select/call/bind/boundCall traffic so the routes' behaviour is asserted.
function fakeGateway(overrides = {}) {
  const calls = { select: [], release: [], call: [], bind: [], boundCall: [], flightStatus: [] };
  const state = {
    inSpace: false,
    solarSystemID: ORIGIN_SYSTEM_ID,
    stationID: ORIGIN_STATION_ID,
    shipMode: null,
  };
  function flightSnapshot() {
    return {
      inSpace: state.inSpace,
      docked: !state.inSpace && state.stationID !== null,
      solarSystemID: state.solarSystemID,
      stationID: state.inSpace ? null : state.stationID,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: state.inSpace ? state.shipMode : null,
      shipSpeedFraction: state.inSpace && state.shipMode === "WARP" ? 1 : 0,
    };
  }
  const gateway = {
    calls,
    state,
    async selectCharacter(args, kwargs, sessionFields) {
      calls.select.push({ args, kwargs, sessionFields });
      return {
        bridgeSessionID: BRIDGE_SESSION_ID,
        service: "charUnboundMgr",
        method: "SelectCharacterID",
        result: null,
        notifications: [],
        session: {
          userid: 4,
          characterID: 7,
          characterName: "Test Pilot",
          stationID: ORIGIN_STATION_ID,
          structureID: null,
          solarSystemID: ORIGIN_SYSTEM_ID,
          corporationID: 98000000,
          shipID: SHIP_ID,
        },
      };
    },
    async releaseBridgeSession(bridgeSessionID, sessionFields) {
      calls.release.push({ bridgeSessionID, sessionFields });
      return { released: true, characterID: 7 };
    },
    async readFlightStatus(bridgeSessionID, sessionFields) {
      calls.flightStatus.push({ bridgeSessionID, sessionFields });
      return { flight: flightSnapshot(), notifications: [] };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.call.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      if (service === "ship" && method === "Undock") {
        state.inSpace = true;
        state.shipMode = "STOP";
      } else if (service === "structureJumpBridgeMgr" && method === "GetJbStructureDestination") {
        return { service, method, result: DEST_SYSTEM_ID, notifications: [] };
      } else if (service === "structureJumpBridgeMgr" && method === "CmdJumpThroughStructureStargate") {
        state.solarSystemID = DEST_SYSTEM_ID;
        state.shipMode = "STOP";
      }
      return { service, method, result: null, notifications: [] };
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, sessionFields, bridgeSessionID });
      return {
        boundHandle: `handle:${service}:${method}:${JSON.stringify(args)}`,
        service,
        method,
        notifications: [],
      };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle });
      if (method === "CmdWarpToStuffAutopilot") {
        state.shipMode = "WARP";
      } else if (method === "CmdStargateJump") {
        state.solarSystemID = DEST_SYSTEM_ID;
        state.shipMode = "STOP";
      } else if (method === "CmdDock") {
        state.inSpace = false;
        state.stationID = Number(args[0]);
        state.shipMode = null;
      }
      return { service, method, result: null, notifications: [] };
    },
    ...overrides,
  };
  return gateway;
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway || fakeGateway(),
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
    errorLogger() {},
    transitionReadyTimeoutMs: options.transitionReadyTimeoutMs,
    transitionPollMs: options.transitionPollMs,
    transitionSleep: options.transitionSleep,
    transitionNow: options.transitionNow,
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}` };
}

async function apiRequest(baseUrl, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (options.authenticated !== false) {
    headers.cookie = `evejs_web_poc=${COOKIE_TOKEN}`;
  }
  const response = await ORIGINAL_FETCH(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, payload: await response.json() };
}

async function selectOnServer(baseUrl) {
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
}

test.afterEach(async () => {
  global.fetch = ORIGINAL_FETCH;
  const closing = [];
  for (const server of activeServers) {
    activeServers.delete(server);
    closing.push(new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }));
  }
  await Promise.all(closing);
});

test("GET /api/bridge/flight/status returns the docked snapshot", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/status");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.flight.docked, true);
  assert.equal(payload.flight.stationID, ORIGIN_STATION_ID);
  assert.equal(gateway.calls.flightStatus[0].bridgeSessionID, BRIDGE_SESSION_ID);
});

test("POST /api/bridge/flight/undock calls ship.Undock and returns the in-space snapshot", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/undock", { method: "POST", body: {} });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.flight.inSpace, true);
  const undock = gateway.calls.call.find((c) => c.service === "ship" && c.method === "Undock");
  assert.ok(undock, "ship.Undock dispatched");
  assert.equal(undock.args[0], SHIP_ID);
  assert.deepEqual(undock.kwargs, { onlineModules: [] });
  assert.equal(undock.bridgeSessionID, BRIDGE_SESSION_ID);
});

test("undock is refused when already in space", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/undock", { method: "POST", body: {} });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "ALREADY_IN_SPACE");
});

test("POST /api/bridge/flight/warp binds the park and dispatches CmdWarpToStuffAutopilot; no handle reaches the browser", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(JSON.stringify(payload).includes("handle:"), false, "bound handle must never reach the browser");

  // The park was bound as beyonce.MachoBindObject([[systemID, 5]]).
  const bind = gateway.calls.bind.find((b) => b.service === "beyonce" && b.method === "MachoBindObject");
  assert.ok(bind, "beyonce park bound");
  assert.deepEqual(bind.args, [[ORIGIN_SYSTEM_ID, 5]]);
  // Warp dispatched on the park handle, riding the held bridge session.
  const warp = gateway.calls.boundCall.find((c) => c.method === "CmdWarpToStuffAutopilot");
  assert.ok(warp, "CmdWarpToStuffAutopilot dispatched");
  assert.deepEqual(warp.args, [GATE_ID]);
  assert.equal(warp.bridgeSessionID, BRIDGE_SESSION_ID);
  assert.match(warp.boundHandle, /^handle:beyonce:MachoBindObject/);
  // The follow-up status shows the ship warping.
  assert.equal(payload.flight.shipMode, "WARP");
});

test("POST /api/bridge/flight/warp-member dispatches CmdWarpToStuff(\"char\", characterID)", async () => {
  // The one warp whose destination need not be on this grid: the server
  // resolves where the fleet member is (resolveFleetMemberWarpTarget) and
  // enforces same-fleet/online itself, which is why this route carries a
  // CHARACTER id and no location at all.
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp-member", {
    method: "POST",
    body: { characterID: 90000001 },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);

  const warp = gateway.calls.boundCall.find((c) => c.method === "CmdWarpToStuff");
  assert.ok(warp, "CmdWarpToStuff dispatched");
  assert.deepEqual(warp.args, ["char", 90000001]);
  assert.equal(warp.bridgeSessionID, BRIDGE_SESSION_ID);
});

test("warp-member refuses a missing character id (INVALID_TARGET)", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp-member", {
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_TARGET");
  assert.equal(gateway.calls.boundCall.length, 0, "nothing dispatched without a target");
});

test("warp is refused when docked (NOT_IN_SPACE)", async () => {
  const gateway = fakeGateway();
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NOT_IN_SPACE");
  assert.equal(gateway.calls.boundCall.length, 0, "no movement dispatched when docked");
});

test("POST /api/bridge/flight/jump dispatches CmdStargateJump; the follow-up status shows the new system", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  const jump = gateway.calls.boundCall.find((c) => c.method === "CmdStargateJump");
  assert.ok(jump, "CmdStargateJump dispatched");
  assert.deepEqual(jump.args, [GATE_ID, DEST_GATE_ID, SHIP_ID]);
  assert.equal(payload.flight.solarSystemID, DEST_SYSTEM_ID);
  assert.equal(payload.transition.phase, "ready");
  assert.equal(payload.transition.locationReady, true);
  assert.equal(payload.transition.sceneReady, true);
  assert.equal(payload.transition.egoReady, true);
});

test("a slow jump waits past the ten-second cooldown for observed readiness and dispatches once", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callBoundMethod = gateway.callBoundMethod.bind(gateway);
  const readFlightStatus = gateway.readFlightStatus.bind(gateway);
  let pendingJump = false;
  let postJumpReads = 0;
  gateway.callBoundMethod = async (...args) => {
    const outcome = await callBoundMethod(...args);
    if (args[1] === "CmdStargateJump") {
      // The command was accepted, but the destination session is deliberately
      // not usable until 12.5 simulated seconds later.
      gateway.state.solarSystemID = ORIGIN_SYSTEM_ID;
      pendingJump = true;
    }
    return outcome;
  };
  gateway.readFlightStatus = async (...args) => {
    if (pendingJump) {
      postJumpReads += 1;
      if (postJumpReads >= 51) {
        gateway.state.solarSystemID = DEST_SYSTEM_ID;
        pendingJump = false;
      }
    }
    return readFlightStatus(...args);
  };

  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionReadyTimeoutMs: 20_000,
    transitionPollMs: 250,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.flight.solarSystemID, DEST_SYSTEM_ID);
  assert.ok(clockMs > 10_000, `readiness took ${clockMs} simulated ms`);
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdStargateJump").length,
    1,
    "the session-changing command is never retried while readiness is pending",
  );
});

test("ordinary writes are blocked before transition readiness and allowed during the remaining cooldown", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callBoundMethod = gateway.callBoundMethod.bind(gateway);
  const readFlightStatus = gateway.readFlightStatus.bind(gateway);
  let jumpPending = false;
  let signalJumpIssued;
  let releaseReadiness;
  const jumpIssued = new Promise((resolve) => { signalJumpIssued = resolve; });
  const readinessGate = new Promise((resolve) => { releaseReadiness = resolve; });

  gateway.callBoundMethod = async (...args) => {
    const outcome = await callBoundMethod(...args);
    if (args[1] === "CmdStargateJump") {
      gateway.state.solarSystemID = ORIGIN_SYSTEM_ID;
      jumpPending = true;
      signalJumpIssued();
    }
    return outcome;
  };
  gateway.readFlightStatus = async (...args) => {
    if (jumpPending) {
      await readinessGate;
    }
    return readFlightStatus(...args);
  };

  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  const jumpRequest = apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });
  await jumpIssued;

  const allowedRead = await apiRequest(baseUrl, "/api/bridge/call", {
    method: "POST",
    body: { service: "charMgr", method: "GetPublicInfo3", args: [], kwargs: null },
  });
  assert.equal(allowedRead.response.status, 200, "read-only bridge calls remain available");

  const blockedWarp = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(blockedWarp.response.status, 409);
  assert.equal(blockedWarp.payload.error, "SESSION_CHANGE_IN_PROGRESS");
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdWarpToStuffAutopilot").length,
    0,
    "the ordinary write must not dispatch before readiness",
  );

  gateway.state.solarSystemID = DEST_SYSTEM_ID;
  jumpPending = false;
  releaseReadiness();
  const completedJump = await jumpRequest;
  assert.equal(completedJump.response.status, 200, JSON.stringify(completedJump.payload));
  assert.equal(completedJump.payload.transition.phase, "ready");

  // Readiness and the next-session-mutation timer are separate. A normal warp
  // is legal immediately after readiness even though another jump/dock/board
  // would still have to wait for the advertised ten-second timer.
  const allowedWarp = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(allowedWarp.response.status, 200, JSON.stringify(allowedWarp.payload));
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdWarpToStuffAutopilot").length,
    1,
  );
});

test("an uncertain jump timeout stays latched and blocks a repeated write", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callBoundMethod = gateway.callBoundMethod.bind(gateway);
  gateway.callBoundMethod = async (...args) => {
    const outcome = await callBoundMethod(...args);
    if (args[1] === "CmdStargateJump") {
      gateway.state.solarSystemID = ORIGIN_SYSTEM_ID;
    }
    return outcome;
  };

  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionReadyTimeoutMs: 1_000,
    transitionPollMs: 250,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);

  const first = await apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });
  assert.equal(first.response.status, 504);
  assert.equal(first.payload.error, "TRANSITION_TIMEOUT");
  assert.equal(first.payload.transition.phase, "failed");

  const second = await apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });
  assert.equal(second.response.status, 409);
  assert.equal(second.payload.error, "SESSION_CHANGE_IN_PROGRESS");
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdStargateJump").length,
    1,
    "an uncertain write is never repeated",
  );
});

test("a warp that succeeded is not reported failed because the after-read timed out", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const readFlightStatus = gateway.readFlightStatus.bind(gateway);
  let warped = false;
  const callBoundMethod = gateway.callBoundMethod.bind(gateway);
  gateway.callBoundMethod = async (...args) => {
    const outcome = await callBoundMethod(...args);
    if (args[1] === "CmdWarpToStuffAutopilot") {
      warped = true;
    }
    return outcome;
  };
  gateway.readFlightStatus = async (...args) => {
    if (warped) {
      // The gateway is busiest right after a movement command: the follow-up
      // snapshot aborts the way a 10 s AbortError surfaces.
      const error = new Error("EveJS gateway timed out.");
      error.code = "EVE_GATEWAY_TIMEOUT";
      throw error;
    }
    return readFlightStatus(...args);
  };

  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  // The flight degrades to the before-snapshot rather than failing the command.
  assert.equal(payload.flight.inSpace, true);
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdWarpToStuffAutopilot").length,
    1,
  );
});

test("a latched transition heals on the next authoritative status read", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callBoundMethod = gateway.callBoundMethod.bind(gateway);
  let jumps = 0;
  gateway.callBoundMethod = async (...args) => {
    const outcome = await callBoundMethod(...args);
    if (args[1] === "CmdStargateJump") {
      jumps += 1;
      if (jumps === 1) {
        // The first jump never lands: the readiness wait must time out.
        gateway.state.solarSystemID = ORIGIN_SYSTEM_ID;
      }
    }
    return outcome;
  };

  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionReadyTimeoutMs: 1_000,
    transitionPollMs: 250,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);

  const first = await apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });
  assert.equal(first.response.status, 504);
  assert.equal(first.payload.transition.phase, "failed");

  // The recovery is NOT a character re-select: the very next authoritative
  // flight read shows the ship stable in the origin system — the write never
  // took — and releases the latch.
  const statusRead = await apiRequest(baseUrl, "/api/bridge/flight/status");
  assert.equal(statusRead.response.status, 200);
  assert.equal(statusRead.payload.flight.transition.phase, "ready");
  assert.equal(statusRead.payload.flight.transition.sessionStable, true);

  const second = await apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.flight.solarSystemID, DEST_SYSTEM_ID);
  assert.equal(second.payload.transition.phase, "ready");
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdStargateJump").length,
    2,
    "the retry dispatches once the read resolved the uncertainty",
  );
});

test("a silently declined dock answers in-space instead of burning the barrier, and the retry is legal", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callBoundMethod = gateway.callBoundMethod.bind(gateway);
  let docks = 0;
  gateway.callBoundMethod = async (...args) => {
    if (args[1] === "CmdDock") {
      docks += 1;
      if (docks === 1) {
        // R24's measured silent decline: 200/null and the ship never seats.
        gateway.calls.boundCall.push({ service: args[0], method: args[1], args: args[2] });
        return { service: args[0], method: args[1], result: null, notifications: [] };
      }
    }
    return callBoundMethod(...args);
  };

  let clockMs = 0;
  const { baseUrl } = await startTestServer({
    gateway,
    transitionReadyTimeoutMs: 1_000,
    transitionPollMs: 250,
    transitionNow: () => clockMs,
    transitionSleep: async (ms) => { clockMs += ms; },
  });
  await selectOnServer(baseUrl);

  const first = await apiRequest(baseUrl, "/api/bridge/flight/dock", {
    method: "POST",
    body: { stationID: ORIGIN_STATION_ID },
  });
  // Not a 504, not a latch: the probe ends with the ship still in space and
  // hands the decision back to the client's silent-dock ladder.
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.ok, true);
  assert.equal(first.payload.flight.inSpace, true);
  assert.equal(first.payload.transition.phase, "ready");

  const second = await apiRequest(baseUrl, "/api/bridge/flight/dock", {
    method: "POST",
    body: { stationID: ORIGIN_STATION_ID },
  });
  assert.equal(second.response.status, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.flight.docked, true);
  assert.equal(second.payload.transition.phase, "ready");
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "CmdDock").length,
    2,
    "the ladder's re-issued dock is not blocked by the declined one",
  );
});

test("structure-gate jump resolves its destination server-side and waits for observed readiness", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/jump-through-structure", {
    method: "POST",
    body: {
      structureID: STRUCTURE_GATE_ID,
      // Deliberately ignored: only EveJS's destination lookup may set the
      // transition postcondition.
      destinationSolarSystemID: 30009999,
      confirm: true,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, true);
  assert.equal(payload.destinationSolarSystemID, DEST_SYSTEM_ID);
  assert.equal(payload.flight.solarSystemID, DEST_SYSTEM_ID);
  assert.equal(payload.transition.phase, "ready");
  assert.equal(payload.transition.toSolarSystemID, DEST_SYSTEM_ID);
  const structureCalls = gateway.calls.call.filter((call) => call.service === "structureJumpBridgeMgr");
  assert.deepEqual(
    structureCalls.map(({ method, args }) => ({ method, args })),
    [
      { method: "GetJbStructureDestination", args: [STRUCTURE_GATE_ID] },
      { method: "CmdJumpThroughStructureStargate", args: [STRUCTURE_GATE_ID] },
    ],
    "the authoritative lookup precedes the one-time command",
  );
});

test("structure-gate jump is confirm-gated and refuses an unavailable destination before dispatch", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const callMethod = gateway.callMethod.bind(gateway);
  gateway.callMethod = async (...args) => {
    if (args[0] === "structureJumpBridgeMgr" && args[1] === "GetJbStructureDestination") {
      gateway.calls.call.push({
        service: args[0],
        method: args[1],
        args: args[2],
        kwargs: args[3],
        sessionFields: args[4],
        bridgeSessionID: args[5],
      });
      return { service: args[0], method: args[1], result: null, notifications: [] };
    }
    return callMethod(...args);
  };
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const refused = await apiRequest(baseUrl, "/api/bridge/flight/jump-through-structure", {
    method: "POST",
    body: { structureID: STRUCTURE_GATE_ID },
  });
  assert.equal(refused.response.status, 400);
  assert.equal(refused.payload.error, "CONFIRMATION_REQUIRED");
  assert.equal(gateway.calls.call.length, 0, "confirmation refusal makes no RPC");

  const unavailable = await apiRequest(baseUrl, "/api/bridge/flight/jump-through-structure", {
    method: "POST",
    body: { structureID: STRUCTURE_GATE_ID, confirm: true },
  });
  assert.equal(unavailable.response.status, 409);
  assert.equal(unavailable.payload.error, "STRUCTURE_JUMP_DESTINATION_UNAVAILABLE");
  assert.equal(
    gateway.calls.call.filter((call) => call.method === "CmdJumpThroughStructureStargate").length,
    0,
    "the consumptive command is not sent without a destination postcondition",
  );
});

test("POST /api/bridge/flight/dock dispatches CmdDock and returns docked", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.solarSystemID = DEST_SYSTEM_ID;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/dock", {
    method: "POST",
    body: { stationID: DEST_STATION_ID },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  const dock = gateway.calls.boundCall.find((c) => c.method === "CmdDock");
  assert.ok(dock, "CmdDock dispatched");
  assert.deepEqual(dock.args, [DEST_STATION_ID, SHIP_ID]);
  assert.equal(payload.flight.docked, true);
  assert.equal(payload.flight.stationID, DEST_STATION_ID);
});

test("a movement refusal passes through as the handler's own CALL_REFUSED message", async () => {
  const gateway = fakeGateway({
    async callBoundMethod(service, method) {
      if (method === "CmdWarpToStuffAutopilot") {
        const error = new Error("You are warp scrambled.");
        error.code = "CALL_REFUSED";
        error.statusCode = 409;
        throw error;
      }
      return { service, method, result: null, notifications: [] };
    },
  });
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/warp", {
    method: "POST",
    body: { destinationID: GATE_ID },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "CALL_REFUSED");
  assert.match(payload.message, /warp scrambled/i);
});

test("flight routes require a live session (409 NO_LIVE_SESSION with no character online)", async () => {
  const { baseUrl } = await startTestServer();
  // No select: no held bridge session.
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/status");
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_LIVE_SESSION");
});

// ── Re-parking beyonce on arrival ────────────────────────────────────────────
//
// THE TESTS THAT WOULD HAVE CAUGHT THE 2026-09-09/10 LOSSES. EveJS clears the
// session's beyonce bind on stargate arrival and will not send the ship destiny
// state until the CLIENT re-binds — roughly twelve seconds, after which it
// force-runs the bootstrap itself. Until then the hull is inert while every
// other call still answers ok, so nothing downstream can notice. The real
// client re-parks on the arrival edge for exactly this reason (michelle.py
// `UpdateBallpark` -> `AddBallpark` -> `Park`, driven by the session change),
// and so does the BFF.

/** Park binds are keyed by system: parkBindSpec puts [[systemID, 5]] in args. */
function parkBindsFor(gateway, systemID) {
  return gateway.calls.bind.filter(
    (c) =>
      c.service === "beyonce" &&
      c.method === "MachoBindObject" &&
      Array.isArray(c.args) &&
      Array.isArray(c.args[0]) &&
      Number(c.args[0][0]) === systemID,
  );
}

test("a jump re-parks beyonce for the system it ARRIVED in, not the one it left", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  // One shared list, so the assertion is about real interleaving rather than
  // the order two separate call logs happen to be concatenated in.
  const order = [];
  const bindObject = gateway.bindObject.bind(gateway);
  const callBoundMethod = gateway.callBoundMethod.bind(gateway);
  gateway.bindObject = async (service, method, args, ...rest) => {
    order.push(`bind:${Number(args?.[0]?.[0])}`);
    return bindObject(service, method, args, ...rest);
  };
  gateway.callBoundMethod = async (service, method, ...rest) => {
    order.push(`call:${method}`);
    return callBoundMethod(service, method, ...rest);
  };
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response } = await apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });

  assert.equal(response.status, 200);
  assert.equal(
    parkBindsFor(gateway, DEST_SYSTEM_ID).length,
    1,
    "the destination park is minted eagerly — waiting for the next flight command is what left ships inert",
  );
  const jumpAt = order.indexOf("call:CmdStargateJump");
  const destBindAt = order.indexOf(`bind:${DEST_SYSTEM_ID}`);
  assert.ok(jumpAt >= 0, "the jump was dispatched");
  assert.ok(
    destBindAt > jumpAt,
    `the destination park is minted AFTER the jump, not before it: ${order.join(" -> ")}`,
  );
});

test("a re-park that is refused is retried rather than abandoned", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const bindObject = gateway.bindObject.bind(gateway);
  let refusals = 0;
  gateway.bindObject = async (service, method, args, ...rest) => {
    if (method === "MachoBindObject" && Number(args?.[0]?.[0]) === DEST_SYSTEM_ID && refusals < 2) {
      refusals += 1;
      gateway.calls.bind.push({ service, method, args });
      throw Object.assign(new Error("FakeItemNotFound"), { code: "CALL_REFUSED" });
    }
    return bindObject(service, method, args, ...rest);
  };
  const { baseUrl } = await startTestServer({ gateway, transitionSleep: async () => {} });
  await selectOnServer(baseUrl);

  const { response } = await apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });

  assert.equal(response.status, 200);
  assert.equal(refusals, 2, "both refusals were taken");
  assert.equal(
    parkBindsFor(gateway, DEST_SYSTEM_ID).length,
    3,
    "and it kept asking until one landed — one attempt silently reverts to the fatal lazy bind",
  );
});

test("a re-park that never lands still lets the jump succeed — an arrival has arrived", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const bindObject = gateway.bindObject.bind(gateway);
  gateway.bindObject = async (service, method, args, ...rest) => {
    if (method === "MachoBindObject" && Number(args?.[0]?.[0]) === DEST_SYSTEM_ID) {
      gateway.calls.bind.push({ service, method, args });
      throw Object.assign(new Error("FakeItemNotFound"), { code: "CALL_REFUSED" });
    }
    return bindObject(service, method, args, ...rest);
  };
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  try {
    const { baseUrl } = await startTestServer({ gateway, transitionSleep: async () => {} });
    await selectOnServer(baseUrl);
    const { response, payload } = await apiRequest(baseUrl, "/api/bridge/flight/jump", {
      method: "POST",
      body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
    });
    assert.equal(response.status, 200, "the re-park is never load-bearing");
    assert.equal(payload.flight.solarSystemID, DEST_SYSTEM_ID);
  } finally {
    console.warn = warn;
  }
  assert.equal(parkBindsFor(gateway, DEST_SYSTEM_ID).length, 4, "bounded — it does not retry forever");
  assert.ok(
    warnings.some((w) => /gave up re-parking/i.test(w)),
    "and it says so: a silent give-up is the fatal behaviour returning unannounced",
  );
});

test("a re-park is not retried into a session that no longer exists", async () => {
  const gateway = fakeGateway();
  gateway.state.inSpace = true;
  gateway.state.shipMode = "STOP";
  const bindObject = gateway.bindObject.bind(gateway);
  gateway.bindObject = async (service, method, args, ...rest) => {
    if (method === "MachoBindObject" && Number(args?.[0]?.[0]) === DEST_SYSTEM_ID) {
      gateway.calls.bind.push({ service, method, args });
      throw Object.assign(new Error("no live session"), { code: "SESSION_NOT_FOUND" });
    }
    return bindObject(service, method, args, ...rest);
  };
  const { baseUrl } = await startTestServer({ gateway, transitionSleep: async () => {} });
  await selectOnServer(baseUrl);

  await apiRequest(baseUrl, "/api/bridge/flight/jump", {
    method: "POST",
    body: { fromGateID: GATE_ID, toGateID: DEST_GATE_ID },
  });

  assert.equal(
    parkBindsFor(gateway, DEST_SYSTEM_ID).length,
    1,
    "there is nothing to re-park into, so it stops at the first answer",
  );
});
