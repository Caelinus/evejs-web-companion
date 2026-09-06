"use strict";

// Goal R14: the BFF inventory-depth and corporation-hangar routes. These drive
// the SAME R3 bound-object bridge (bind, then bound method) with arguments R3
// hardcoded away — split is a partial-qty Add, multi-move is MultiAdd,
// re-merge is MultiMerge, a container is the ship-cargo bind listed with NO
// flag, and a corp hangar is the office bind listed with a division flag.
//
// The fake gateway below holds a real little WORLD (items with a location and a
// flag) and mutates it, rather than echoing canned results. That matters
// because the thing under test is the R12 lesson: invbroker declines silently —
// it returns null WITHOUT raising — so a 200 is not proof a move happened. Every
// mutating route re-reads and reports what ACTUALLY applied, and these tests
// exercise both the applied and the silently-declined path.
//
// Wire contract: docs/bridge-wire-contract.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("events");

const { createApp } = require("../src/server");

const COOKIE_TOKEN = "raw-signed-login-cookie";
const SESSION_ID = "signed-random-session-id";
const ACCOUNT = { username: "pilot", accountID: 4, role: "0", banned: false };
const BRIDGE_SESSION_ID = "opaque-gateway-minted-bridge-session-id";
const STATION_ID = 60003760;
const ACTIVE_SHIP_ID = 9001;

// Retail flags. The BROWSER never sends these — it names a place — but the
// fixtures below are the server's view, so they appear here.
const FLAG_HANGAR = 4;
const FLAG_CARGO = 5;
const FLAG_NONE = 0; // container contents
const FLAG_DIVISION_1 = 115; // flagCorpSAG1
const FLAG_DIVISION_2 = 116;

// Office identity: what GetMyCorporationsOffices publishes is the office's ITEM
// id, while the hangar CONTENTS sit at a different id. The fake keeps them
// distinct so a route that conflates them fails here.
const OFFICE_PUBLISHED_ID = 555_000_111; // the rowset's `officeID` column
const OFFICE_CONTENT_LOCATION_ID = 555_000_999; // where corp items really are

const CONTAINER_ID = 8100;

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
      return Number(accountID) === ACCOUNT.accountID && Number(characterID) === 7
        ? { characterID: 7, accountID: 4, characterName: "Test Pilot" }
        : null;
    },
    async releaseCharacterControl() {
      return { controlState: "offline" };
    },
  };
}

function fakeStaticData() {
  return {
    getStation() { return null; },
    getTypeName(id) { return `Type ${id}`; },
    // Per-type m³, so the container read can publish volumes the way the
    // inventory and asset reads do.
    getType(id) { return { volume: id === 34 ? 0.01 : 1 }; },
  };
}

function packedRow(fields) {
  return { type: "packedrow", fields };
}

function keyVal(entries) {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

// util.Row — a header list of column NAMES paired with a line of values. This
// is the shape corpRegistry.GetCorporation really answers with.
function utilRow(fieldMap) {
  const names = Object.keys(fieldMap);
  return {
    type: "object",
    name: "util.Row",
    args: {
      type: "dict",
      entries: [
        ["header", { type: "list", items: names }],
        ["line", { type: "list", items: names.map((name) => fieldMap[name]) }],
      ],
    },
  };
}

// CRowset — an objectex2 whose `list` holds packedrows. The shape
// officeManager.GetMyCorporationsOffices really answers with.
function cRowset(rows) {
  return { type: "objectex2", header: [], list: rows.map(packedRow), dict: [] };
}

const DEFAULT_DIVISION_NAMES = {
  division1: "Ore Bay",
  division2: "Ammo Locker",
  division3: "",
  division4: "",
  division5: "",
  division6: "",
  division7: "",
};

/**
 * A gateway fake with a real, mutable item world.
 *
 * Items are {itemID, typeID, locationID, flagID, quantity}. Binds are resolved
 * to a location, and List/Add/MultiAdd/MultiMerge/TrashItems read and write the
 * world, so a route's RE-READ sees the real consequence of its own call.
 *
 * `declineAll` makes every mutation a silent no-op — the handler answers 200
 * and nothing moves, which is exactly invbroker's silent-decline branch.
 */
function fakeGateway(options = {}) {
  const calls = { bind: [], boundCall: [], topLevel: [] };
  const world = new Map();
  for (const item of options.items || []) {
    world.set(item.itemID, { ...item });
  }
  let nextSplitItemID = 990_000;
  const declineAll = options.declineAll === true;
  const officeRows =
    options.officeRows === undefined
      ? [{ officeID: OFFICE_PUBLISHED_ID, stationID: STATION_ID }]
      : options.officeRows;

  // A bound handle encodes the location it was bound to, so bound calls can
  // resolve their target the way the real server does.
  function handleFor(service, method, args) {
    if (method === "GetInventory") {
      return `handle:${service}:hangar:${args[0]}`;
    }
    if (method === "GetInventoryFromId") {
      const id = Number(args[0]);
      // Binding the office by its PUBLISHED id resolves to the location the
      // contents actually sit at — the server's own identity normalization.
      const location = id === OFFICE_PUBLISHED_ID ? OFFICE_CONTENT_LOCATION_ID : id;
      return `handle:${service}:inv:${location}`;
    }
    return `handle:${service}:manager:${JSON.stringify(args)}`;
  }

  function locationOfHandle(boundHandle) {
    const match = /^handle:invbroker:(?:hangar|inv):(\d+)$/.exec(String(boundHandle || ""));
    return match ? Number(match[1]) : 0;
  }

  function listAt(locationID, flag) {
    const rows = [];
    for (const item of world.values()) {
      if (item.locationID !== locationID) {
        continue;
      }
      if (flag !== null && flag !== undefined && item.flagID !== flag) {
        continue;
      }
      rows.push(packedRow({ ...item, singleton: 0 }));
    }
    return { type: "list", items: rows };
  }

  const gateway = {
    calls,
    world,
    async selectCharacter(args, kwargs, sessionFields) {
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
          stationID: STATION_ID,
          structureID: null,
          solarSystemID: 30000142,
          corporationID: 98000000,
          shipID: ACTIVE_SHIP_ID,
        },
      };
    },
    async releaseBridgeSession() {
      return { released: true, characterID: 7 };
    },
    async readFlightStatus() {
      return {
        flight: {
          docked: true,
          inSpace: false,
          stationID: STATION_ID,
          solarSystemID: 30000142,
          shipID: ACTIVE_SHIP_ID,
        },
        notifications: [],
      };
    },
    async callMethod(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.topLevel.push({ service, method, args, kwargs, bridgeSessionID });
      if (service === "officeManager" && method === "GetMyCorporationsOffices") {
        if (options.officeReadFails) {
          throw Object.assign(new Error("office read failed"), { code: "CALL_FAILED" });
        }
        return { service, method, result: cRowset(officeRows), notifications: [] };
      }
      if (service === "corpRegistry" && method === "GetCorporation") {
        return {
          service,
          method,
          result: utilRow({
            corporationID: 98000000,
            ...(options.divisionNames || DEFAULT_DIVISION_NAMES),
          }),
          notifications: [],
        };
      }
      return { service, method, result: null, notifications: [] };
    },
    async bindObject(service, method, args, kwargs, sessionFields, bridgeSessionID) {
      calls.bind.push({ service, method, args, kwargs, bridgeSessionID });
      return { boundHandle: handleFor(service, method, args), service, method, notifications: [] };
    },
    async callBoundMethod(service, method, args, kwargs, sessionFields, bridgeSessionID, boundHandle) {
      calls.boundCall.push({ service, method, args, kwargs, bridgeSessionID, boundHandle });
      const destination = locationOfHandle(boundHandle);
      const flag = kwargs && kwargs.flag !== undefined ? kwargs.flag : null;

      if (method === "List") {
        // No flag argument at all -> list everything at this location. This is
        // the container rule.
        const listFlag = args.length > 0 ? args[0] : null;
        return { service, method, result: listAt(destination, listFlag), notifications: [] };
      }
      if (method === "GetCapacity") {
        return { service, method, result: keyVal([["capacity", 1000], ["used", 12.5]]), notifications: [] };
      }
      if (declineAll) {
        // The silent decline: 200, null result, nothing moved.
        return { service, method, result: null, notifications: [] };
      }
      if (method === "Add") {
        // A dispatch failure with NOTHING applied — the ordinary error case,
        // which must still surface as an error.
        if (options.throwOnAdd === true) {
          throw new Error("invbroker.Add failed: connection reset");
        }
        const [itemID, sourceLocationID] = args;
        const item = world.get(Number(itemID));
        // The server matches the quoted source location against the item's real
        // one and declines silently when they differ.
        if (!item || item.locationID !== Number(sourceLocationID)) {
          return { service, method, result: null, notifications: [] };
        }
        // LOOT. Taking from an NPC wreck DESTROYS the wreck's row and MINTS a
        // fresh one at the destination, so the id the caller asked for never
        // appears there. Measured against the live emulator: five items, five
        // new itemIDs, and the wreck emptied. `mintOnAdd` reproduces exactly
        // that, and `throwAfterAdd` reproduces eve.js raising AFTER the move
        // has already happened (nativeNpcWreckService.js calls a scene method
        // that does not exist, but only once the transfer is done).
        if (options.mintOnAdd === true) {
          world.delete(item.itemID);
          const mintedID = (nextSplitItemID += 1);
          world.set(mintedID, {
            itemID: mintedID,
            typeID: item.typeID,
            locationID: destination,
            flagID: flag === null ? FLAG_HANGAR : flag,
            quantity: item.quantity,
          });
          if (options.throwAfterAdd === true) {
            throw new Error("invbroker.Add failed: scene.sendSlimItemChangesToAllSessions is not a function");
          }
          return { service, method, result: null, notifications: [] };
        }
        const qty = kwargs && Number(kwargs.qty) > 0 ? Number(kwargs.qty) : null;
        if (qty !== null && qty < item.quantity) {
          // A SPLIT mints a new stack and shrinks the source.
          item.quantity -= qty;
          const splitID = (nextSplitItemID += 1);
          world.set(splitID, {
            itemID: splitID,
            typeID: item.typeID,
            locationID: destination,
            flagID: flag === null ? FLAG_HANGAR : flag,
            quantity: qty,
          });
        } else {
          item.locationID = destination;
          item.flagID = flag === null ? FLAG_HANGAR : flag;
        }
        return { service, method, result: null, notifications: [] };
      }
      if (method === "MultiAdd") {
        const [itemIDs, sourceLocationID] = args;
        for (const rawID of itemIDs) {
          const item = world.get(Number(rawID));
          if (!item || item.locationID !== Number(sourceLocationID)) {
            continue;
          }
          item.locationID = destination;
          item.flagID = flag === null ? FLAG_HANGAR : flag;
        }
        return { service, method, result: null, notifications: [] };
      }
      if (method === "MultiMerge") {
        const [ops] = args;
        for (const [sourceItemID, destinationItemID, quantity] of ops) {
          const source = world.get(Number(sourceItemID));
          const target = world.get(Number(destinationItemID));
          if (!source || !target || source.typeID !== target.typeID) {
            continue;
          }
          const moved = Math.min(Number(quantity) || source.quantity, source.quantity);
          target.quantity += moved;
          source.quantity -= moved;
          if (source.quantity <= 0) {
            world.delete(source.itemID);
          }
        }
        return { service, method, result: null, notifications: [] };
      }
      if (method === "TrashItems") {
        const [itemIDs] = args;
        for (const rawID of itemIDs) {
          const item = world.get(Number(rawID));
          // The active ship cannot be trashed — the handler declines without
          // raising, exactly like the real one.
          if (!item || item.itemID === ACTIVE_SHIP_ID) {
            continue;
          }
          world.delete(item.itemID);
        }
        return { service, method, result: null, notifications: [] };
      }
      return { service, method, result: null, notifications: [] };
    },
  };
  return gateway;
}

async function startTestServer(options = {}) {
  const app = createApp({
    eveStore: options.store || fakeStore(),
    eveGatewayClient: options.gateway,
    webAuth: fakeAuth(),
    staticData: fakeStaticData(),
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
  await apiRequest(baseUrl, "/api/bridge/select", { method: "POST", body: { characterID: 7 } });
}

// The standard fixture world: two mineral stacks and a container (holding one
// stack) in the hangar, one stack in the ship's cargo, and two corp-owned
// stacks in two divisions.
function fixtureItems() {
  return [
    { itemID: ACTIVE_SHIP_ID, typeID: 597, locationID: STATION_ID, flagID: FLAG_HANGAR, quantity: 1 },
    { itemID: 100, typeID: 34, locationID: STATION_ID, flagID: FLAG_HANGAR, quantity: 1000 },
    { itemID: 101, typeID: 35, locationID: STATION_ID, flagID: FLAG_HANGAR, quantity: 500 },
    { itemID: 102, typeID: 34, locationID: STATION_ID, flagID: FLAG_HANGAR, quantity: 250 },
    { itemID: CONTAINER_ID, typeID: 3297, locationID: STATION_ID, flagID: FLAG_HANGAR, quantity: 1 },
    { itemID: 200, typeID: 34, locationID: CONTAINER_ID, flagID: FLAG_NONE, quantity: 40 },
    { itemID: 300, typeID: 34, locationID: ACTIVE_SHIP_ID, flagID: FLAG_CARGO, quantity: 60 },
    { itemID: 400, typeID: 34, locationID: OFFICE_CONTENT_LOCATION_ID, flagID: FLAG_DIVISION_1, quantity: 900 },
    { itemID: 401, typeID: 35, locationID: OFFICE_CONTENT_LOCATION_ID, flagID: FLAG_DIVISION_2, quantity: 400 },
  ];
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

// --- containers -------------------------------------------------------------

test("GET container binds with GetInventoryFromId and lists with NO FLAG", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(
    baseUrl,
    `/api/bridge/inventory/container/${CONTAINER_ID}`,
  );
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.containerID, CONTAINER_ID);

  // The bind is the IDENTICAL call ship cargo uses — no container-specific bind.
  assert.ok(
    gateway.calls.bind.some(
      (bind) =>
        bind.service === "invbroker" &&
        bind.method === "GetInventoryFromId" &&
        bind.args[0] === CONTAINER_ID,
    ),
  );
  // THE RULE: the container List carries NO flag argument. Passing 4 or 5 would
  // answer empty, because container contents carry flagID 0.
  const containerLists = gateway.calls.boundCall.filter(
    (call) => call.method === "List" && call.boundHandle.endsWith(`:${CONTAINER_ID}`),
  );
  assert.ok(containerLists.length > 0, "the container was listed");
  for (const call of containerLists) {
    assert.deepEqual(call.args, [], "a container List must pass no flag at all");
  }
  // And the contents came back.
  assert.equal(payload.list.items.length, 1);
  assert.equal(payload.list.items[0].fields.itemID, 200);

  // No bound handle ever crosses to the browser.
  assert.equal(JSON.stringify(payload).includes("handle:"), false);
});

test("transfer moves an item OUT of a container using the container as the source", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: {
      itemIDs: [200],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "hangar" },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  assert.deepEqual(payload.moved, [200]);
  assert.equal(gateway.world.get(200).locationID, STATION_ID);
});

// --- ship bays as a transfer SOURCE (goal R51) ------------------------------
//
// The operator had ore in the Ore Hold and no way to move it into the station
// hangar: resolvePlace could address the ship's CARGO but none of its
// specialised bays. R51 teaches it to address any bay the hull exposes by its
// bay KEY (the SAME R40 enumeration the /bays route uses) — the browser never
// learns the ore hold is flag 134. The move is judged exactly like every other
// transfer: by the SOURCE giving something up, never by the 200.

const FLAG_ORE_HOLD = 134; // R40's ore-hold flag; the browser never sends it.

function oreInHold(itemID = 500, quantity = 100) {
  return { itemID, typeID: 1230, locationID: ACTIVE_SHIP_ID, flagID: FLAG_ORE_HOLD, quantity };
}

test("an ore-hold stack is a valid transfer SOURCE and lands in the hangar", async () => {
  const gateway = fakeGateway({ items: [...fixtureItems(), oreInHold()] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [500], from: { kind: "shipBay", bay: "ore" }, to: { kind: "hangar" } },
  });
  assert.equal(response.status, 200);
  // Judged by the SOURCE giving something up, exactly as the R29 lesson demands.
  assert.equal(payload.applied, true);
  assert.deepEqual(payload.moved, [500]);
  assert.equal(payload.declinedSilently, false);

  // The world agrees: the ore left the hold and now sits in the station hangar.
  assert.equal(gateway.world.get(500).locationID, STATION_ID);
  assert.equal(gateway.world.get(500).flagID, FLAG_HANGAR);

  // The bay KEY was resolved to the ore-hold flag from R40's enumeration: the
  // source was LISTED by that flag, and the source location quoted for the move
  // is the SHIP itself — the same shape as ore-hold/unload.
  const sourceList = gateway.calls.boundCall.find(
    (call) => call.method === "List" && call.args[0] === FLAG_ORE_HOLD,
  );
  assert.ok(sourceList, "the ore hold was listed by its flag as the source");
  const add = gateway.calls.boundCall.find((call) => call.method === "Add");
  assert.deepEqual(add.args, [500, ACTIVE_SHIP_ID], "the ship is the source location");
  assert.equal(add.kwargs.flag, FLAG_HANGAR, "and the hangar flag is the destination");

  // No flag number and no bound handle ever crosses back to the browser.
  assert.equal(JSON.stringify(payload).includes(String(FLAG_ORE_HOLD)), false);
  assert.equal(JSON.stringify(payload).includes("handle:"), false);
});

test("an ore-hold move the server declines silently is reported applied:false", async () => {
  // The new source path is held to the SAME discipline: a 200 with nothing moved
  // is a silent decline, not a success.
  const gateway = fakeGateway({ items: [...fixtureItems(), oreInHold()], declineAll: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [500], from: { kind: "shipBay", bay: "ore" }, to: { kind: "hangar" } },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, false, "the re-read says nothing left the hold");
  assert.deepEqual(payload.declined, [500]);
  assert.equal(payload.declinedSilently, true);
  assert.equal(gateway.world.get(500).locationID, ACTIVE_SHIP_ID, "the ore stayed put");
});

test("transfer rejects an unknown ship bay key", async () => {
  const gateway = fakeGateway({ items: [...fixtureItems(), oreInHold()] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [500], from: { kind: "shipBay", bay: "nonsense" }, to: { kind: "hangar" } },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_BAY");
});

// --- split ------------------------------------------------------------------

test("transfer with a qty SPLITS the stack and reports it applied via the source shrinking", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [100], qty: 300, from: { kind: "hangar" }, to: { kind: "cargo" } },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);

  // The retail call is a partial-qty Add — a KWARG, on the DESTINATION binding.
  const add = gateway.calls.boundCall.find((call) => call.method === "Add");
  assert.ok(add, "a split is an Add");
  assert.equal(add.kwargs.qty, 300);
  assert.equal(add.kwargs.flag, FLAG_CARGO);
  assert.deepEqual(add.args, [100, STATION_ID]);

  // The source shrank; a NEW stack landed in cargo. `applied` cannot be judged
  // by itemID here, which is exactly why the route checks the quantity.
  assert.equal(gateway.world.get(100).quantity, 700);
  const inCargo = [...gateway.world.values()].filter(
    (item) => item.locationID === ACTIVE_SHIP_ID && item.quantity === 300,
  );
  assert.equal(inCargo.length, 1);
});

// --- loot: the destination MINTS a new row (goal R29 slice 0, probe 3) -------
//
// These two pin the R29 finding. Looting an NPC wreck is a transfer whose
// destination row is BRAND NEW: the wreck's row is destroyed and a fresh id is
// minted in the cargo hold. Judging `applied` by destination membership — "is
// the id I asked for now at the destination?" — is therefore false on a
// COMPLETED loot, and the player would be told their loot vanished. The route
// judges the SOURCE giving something up instead.

test("loot reports applied even though the destination row is a NEW itemID", async () => {
  const gateway = fakeGateway({ items: fixtureItems(), mintOnAdd: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: {
      itemIDs: [200],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(payload.applied, true, "the loot landed and must be reported as landed");
  // The id the caller named is NOT at the destination and never will be.
  assert.deepEqual(payload.moved, [], "a minted row cannot appear in `moved`");
  assert.deepEqual(payload.reminted, [200], "so it is named as reminted instead");
  assert.deepEqual(payload.declined, [], "nothing was declined");
  assert.equal(payload.declinedSilently, false);

  // The world agrees: the wreck row is gone, and a new row holds the goods.
  assert.equal(gateway.world.has(200), false, "the source row was destroyed");
  const inCargo = [...gateway.world.values()].filter(
    (item) => item.locationID === ACTIVE_SHIP_ID && item.quantity === 40,
  );
  assert.equal(inCargo.length, 1, "the loot is in the cargo hold under a new id");
  assert.notEqual(inCargo[0].itemID, 200);
});

test("a throw AFTER the move has applied is not reported as a failure", async () => {
  // eve.js raises on the loot path once the transfer is already done. A 500 is
  // no more proof of failure than a 200 is proof of success: the re-read wins.
  const gateway = fakeGateway({
    items: fixtureItems(),
    mintOnAdd: true,
    throwAfterAdd: true,
  });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: {
      itemIDs: [200],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    },
  });

  assert.equal(response.status, 200, "the move applied, so the route answers 200");
  assert.equal(payload.applied, true);
  assert.deepEqual(payload.reminted, [200]);
  assert.equal(gateway.world.has(200), false);
});

test("a throw with NOTHING moved is still a real failure", async () => {
  // The guard must not swallow genuine dispatch errors: when the re-read shows
  // the source gave up nothing, the original error is raised unchanged.
  const gateway = fakeGateway({ items: fixtureItems(), throwOnAdd: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: {
      itemIDs: [200],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    },
  });

  assert.equal(response.status >= 400, true, "a move that truly failed must not answer 200");
  assert.equal(gateway.world.get(200).locationID, CONTAINER_ID, "nothing moved");
});

test("transfer rejects a qty with more than one item", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [100, 101], qty: 50, from: { kind: "hangar" }, to: { kind: "cargo" } },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_SPLIT");
});

// --- multi-select move ------------------------------------------------------

test("transfer of several items uses ONE MultiAdd, not N Adds", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [100, 101], from: { kind: "hangar" }, to: { kind: "cargo" } },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  assert.deepEqual(payload.moved.sort(), [100, 101]);

  const multiAdds = gateway.calls.boundCall.filter((call) => call.method === "MultiAdd");
  assert.equal(multiAdds.length, 1, "one batch call carries the whole selection");
  assert.deepEqual(multiAdds[0].args, [[100, 101], STATION_ID]);
  assert.equal(multiAdds[0].kwargs.flag, FLAG_CARGO);
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "Add").length,
    0,
    "and no per-item Add is issued",
  );
});

// --- the silent-decline discipline -----------------------------------------

test("a declined move answers ok but applied:false — a 200 is never treated as proof", async () => {
  // Every mutation is a silent no-op, exactly like invbroker's decline branches.
  const gateway = fakeGateway({ items: fixtureItems(), declineAll: true });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [100], from: { kind: "hangar" }, to: { kind: "cargo" } },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, false, "the re-read says nothing moved");
  assert.deepEqual(payload.declined, [100]);
  // The server gave no reason. The route says exactly that rather than
  // inventing one.
  assert.equal(payload.declinedSilently, true);
  assert.equal(gateway.world.get(100).locationID, STATION_ID);
});

test("transfer refuses when the items are no longer at the source", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [777], from: { kind: "hangar" }, to: { kind: "cargo" } },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "ITEMS_NOT_AT_SOURCE");
});

// --- merge ------------------------------------------------------------------

test("merge folds one stack into another and reports the quantity that really moved", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/merge", {
    method: "POST",
    body: { sourceItemID: 102, destinationItemID: 100, place: { kind: "hangar" } },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  assert.equal(payload.merged, 250);

  const merge = gateway.calls.boundCall.find((call) => call.method === "MultiMerge");
  assert.ok(merge, "re-merge is MultiMerge");
  assert.deepEqual(merge.args, [[[102, 100, 250]], STATION_ID]);
  assert.equal(gateway.world.get(100).quantity, 1250);
  assert.equal(gateway.world.has(102), false, "the source stack was consumed");
});

test("merge of two different types is declined silently and says so", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  // 101 is a different type from 100; the server declines without raising.
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/merge", {
    method: "POST",
    body: { sourceItemID: 101, destinationItemID: 100, place: { kind: "hangar" } },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, false);
  assert.equal(payload.merged, 0);
  assert.equal(payload.declinedSilently, true);
});

// --- trash ------------------------------------------------------------------

test("trash REFUSES without an explicit confirm", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/trash", {
    method: "POST",
    body: { itemIDs: [100], place: { kind: "hangar" } },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "CONFIRMATION_REQUIRED");
  // Nothing was dispatched at all.
  assert.equal(
    gateway.calls.boundCall.filter((call) => call.method === "TrashItems").length,
    0,
  );
  assert.ok(gateway.world.has(100), "and nothing was destroyed");
});

test("trash with confirm destroys the items on the inventory-MANAGER moniker", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/trash", {
    method: "POST",
    body: { itemIDs: [100], place: { kind: "hangar" }, confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  assert.deepEqual(payload.destroyed, [100]);
  assert.deepEqual(payload.survived, []);
  assert.equal(gateway.world.has(100), false);

  // TrashItems dispatches on Moniker('invbroker',(stationID,groupStation)) —
  // the manager bind, not a per-container binding.
  assert.ok(
    gateway.calls.bind.some(
      (bind) => bind.service === "invbroker" && bind.method === "MachoBindObject",
    ),
    "the inventory manager moniker was bound",
  );
  const trash = gateway.calls.boundCall.find((call) => call.method === "TrashItems");
  assert.deepEqual(trash.args, [[100], STATION_ID]);
  assert.match(trash.boundHandle, /manager/);
});

test("trash reports an item that SURVIVED a declined destroy", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  // The active ship cannot be trashed; the handler declines without raising.
  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/trash", {
    method: "POST",
    body: { itemIDs: [ACTIVE_SHIP_ID], place: { kind: "hangar" }, confirm: true },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, false);
  assert.deepEqual(payload.survived, [ACTIVE_SHIP_ID]);
  assert.equal(payload.declinedSilently, true);
  assert.ok(gateway.world.has(ACTIVE_SHIP_ID));
});

// --- corporation hangars ----------------------------------------------------

test("GET corp reads the office, the division NAMES, and every division's contents", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/corp");
  assert.equal(response.status, 200);
  assert.equal(payload.available, true);
  assert.equal(payload.divisions.length, 7, "all seven divisions are reported");

  // The office lookup and the division-name read are the two new top-level
  // calls; everything else reuses the invbroker pairs.
  assert.ok(
    gateway.calls.topLevel.some(
      (call) => call.service === "officeManager" && call.method === "GetMyCorporationsOffices",
    ),
  );
  assert.ok(
    gateway.calls.topLevel.some(
      (call) => call.service === "corpRegistry" && call.method === "GetCorporation",
    ),
  );

  // Divisions are labelled by NAME. The division DESCRIPTOR the BFF builds
  // carries an ordinal and a name and no flag: the browser never learns that
  // "Ore Bay" is flag 115, so it cannot leak one into the UI. (The retail rows
  // nested under `list` still carry their own flagID, exactly as the hangar and
  // cargo rows already do — those are the raw reads the browser decodes.)
  assert.equal(payload.divisions[0].name, "Ore Bay");
  assert.equal(payload.divisions[1].name, "Ammo Locker");
  assert.equal(payload.divisions[2].name, null, "an unnamed division has no name to show");
  for (const division of payload.divisions) {
    assert.deepEqual(
      Object.keys(division).sort(),
      ["division", "error", "list", "name"],
      "a division descriptor exposes an ordinal and a name — never a flag",
    );
    assert.ok(division.division >= 1 && division.division <= 7);
  }

  // Each division was listed with its own flag, on the office binding.
  const divisionLists = gateway.calls.boundCall.filter((call) => call.method === "List");
  assert.deepEqual(
    divisionLists.map((call) => call.args[0]).sort((a, b) => a - b),
    [115, 116, 117, 118, 119, 120, 121],
  );
  assert.equal(payload.divisions[0].list.items[0].fields.itemID, 400);
  assert.equal(payload.divisions[1].list.items[0].fields.itemID, 401);
});

test("GET corp binds the PUBLISHED officeID — never a guessed content location", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);
  await apiRequest(baseUrl, "/api/bridge/inventory/corp");

  const officeBind = gateway.calls.bind.find(
    (bind) => bind.method === "GetInventoryFromId" && bind.args[0] === OFFICE_PUBLISHED_ID,
  );
  assert.ok(officeBind, "the office is bound by the id the rowset published");
  assert.equal(
    gateway.calls.bind.some((bind) => bind.args[0] === OFFICE_CONTENT_LOCATION_ID),
    false,
    "the bridge never invents the content location as a bind argument",
  );
});

test("corp move OUT takes the source location from the ROW, not the published officeID", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [400], from: { kind: "corp", division: 1 }, to: { kind: "hangar" } },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);
  assert.deepEqual(payload.moved, [400]);

  const add = gateway.calls.boundCall.find((call) => call.method === "Add");
  // THE PIN: the source location quoted is the item's OWN location, which is
  // NOT the published officeID. Quoting the published id would have been
  // declined silently — a 200 with nothing moved.
  assert.deepEqual(add.args, [400, OFFICE_CONTENT_LOCATION_ID]);
  assert.notEqual(add.args[1], OFFICE_PUBLISHED_ID);
  assert.equal(gateway.world.get(400).locationID, STATION_ID);
});

test("corp move IN files a personal item under the chosen division's flag", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [100], from: { kind: "hangar" }, to: { kind: "corp", division: 2 } },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.applied, true);

  const add = gateway.calls.boundCall.find((call) => call.method === "Add");
  // The browser sent the division ORDINAL; the BFF turned it into flag 116.
  assert.equal(add.kwargs.flag, FLAG_DIVISION_2);
  assert.equal(gateway.world.get(100).locationID, OFFICE_CONTENT_LOCATION_ID);
  assert.equal(gateway.world.get(100).flagID, FLAG_DIVISION_2);
});

test("transfer rejects a division outside 1-7", async () => {
  const gateway = fakeGateway({ items: fixtureItems() });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [100], from: { kind: "hangar" }, to: { kind: "corp", division: 9 } },
  });
  assert.equal(response.status, 400);
  assert.equal(payload.error, "INVALID_DIVISION");
});

test("GET corp reports 'no office' as a plain unavailable state, not an error", async () => {
  const gateway = fakeGateway({ items: fixtureItems(), officeRows: [] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/corp");
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.available, false);
  assert.equal(payload.reason, "NO_CORP_OFFICE");
  assert.deepEqual(payload.divisions, []);
});

test("a corp move with no office at this station is refused with a clear reason", async () => {
  const gateway = fakeGateway({ items: fixtureItems(), officeRows: [] });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { response, payload } = await apiRequest(baseUrl, "/api/bridge/inventory/transfer", {
    method: "POST",
    body: { itemIDs: [100], from: { kind: "hangar" }, to: { kind: "corp", division: 1 } },
  });
  assert.equal(response.status, 409);
  assert.equal(payload.error, "NO_CORP_OFFICE");
});

test("a division the character cannot query reads EMPTY without blanking the others", async () => {
  // The server filters a division the character lacks the query role for down
  // to nothing; the panel must still show every other division.
  const items = fixtureItems().filter((item) => item.flagID !== FLAG_DIVISION_1);
  const gateway = fakeGateway({ items });
  const { baseUrl } = await startTestServer({ gateway });
  await selectOnServer(baseUrl);

  const { payload } = await apiRequest(baseUrl, "/api/bridge/inventory/corp");
  assert.equal(payload.available, true);
  assert.equal(payload.divisions[0].list.items.length, 0, "the role-gated division is empty");
  assert.equal(payload.divisions[0].error, null, "an empty read is not an error");
  assert.equal(payload.divisions[1].list.items.length, 1, "and the rest still show");
});
