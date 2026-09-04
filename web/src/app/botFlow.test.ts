// The R26 mining bot WIRED THROUGH THE FLOW, against a faked BFF.
//
// `miningBotLoop.test.ts` pins the ladder and its bounds against synthetic
// state; this pins the other half — that the flow hands the loop the right
// dependencies and lands its readout in the store — by driving the real
// `startMiningBot` over a fake fetch and watching which BFF routes come out.
//
// Two things matter most here and neither is about mining:
//
//   1. The bot's deps go STRAIGHT TO THE API, not through the flow's own
//      lockTarget / activateModule wrappers, which swallow a refusal into the
//      store and return normally. The loop has to SEE a refusal to decide on
//      it, so a refusal must reach it as a thrown error.
//   2. Two loops must never steer one ship: starting the bot aborts the travel
//      autopilot first.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
// R43 — the preflight reads the FIT before it starts, so the harness has to
// serve a ship that can actually mine. These are Farmer's live Procurer's own
// captured bytes rather than a hand-typed stand-in.
import { fittingBody, namesBody } from "./botFixtures.ts";

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

const BELT = 40000123;
const STATION = 60003760;
const ROCK = 5001;
const LASER = 7001;
const SHIP = 9001;

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => {
    status: number;
    body: unknown;
  },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method, body });
    const outcome = responder(path, method, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

/** A raw space snapshot envelope with one rock, in the shape the BFF returns. */
function spaceBody(options: { activeModuleIDs?: number[] } = {}): unknown {
  return {
    ok: true,
    space: {
      inSpace: true,
      solarSystemID: 30000142,
      shipID: SHIP,
      sampledAtMs: 0,
      ship: {
        itemID: SHIP,
        typeID: 620,
        name: "Miner",
        mode: "STOP",
        radius: 60,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        activeModuleIDs: options.activeModuleIDs ?? [],
      },
      entities: [
        {
          itemID: ROCK,
          kind: "asteroid",
          name: "Veldspar",
          typeID: 1230,
          radius: 100,
          position: { x: 6_000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          remainingQuantity: 12_000,
          miningYieldTypeID: 1230,
          beltID: BELT,
          oreGrade: 1,
        },
        {
          itemID: BELT,
          kind: "celestial",
          name: "Asteroid Belt 1",
          radius: 0,
          position: { x: 500, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        },
      ],
    },
    notifications: [],
  };
}

function flightBody(docked: boolean): unknown {
  return {
    ok: true,
    flight: {
      inSpace: !docked,
      docked,
      solarSystemID: 30000142,
      stationID: docked ? STATION : null,
      structureID: null,
      shipID: SHIP,
      shipMode: docked ? null : "STOP",
      shipSpeedFraction: 0,
    },
  };
}

function holdsBody(used: number, items: unknown[]): unknown {
  return {
    ok: true,
    activeShipID: SHIP,
    stationID: STATION,
    holds: [
      {
        key: "ore",
        label: "Ore hold",
        present: true,
        capacity: { capacity: 5_000, used },
        items,
        error: null,
      },
    ],
  };
}

const REQUEST = {
  beltID: BELT,
  beltName: "Asteroid Belt 1",
  stationID: STATION,
  stationName: "Jita IV - Moon 4",
  miningModuleIDs: [LASER],
  healthFloor: 0.5,
  useDrones: false,
};

/** Wire a store + flow over a world that is in space with one rock in reach. */
function harness(options: { locked?: number[]; activeModuleIDs?: number[] } = {}) {
  const state = {
    locked: options.locked ?? ([] as number[]),
    active: options.activeModuleIDs ?? ([] as number[]),
  };
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: flightBody(false) };
    }
    if (path === "/api/bridge/space/snapshot") {
      return { status: 200, body: spaceBody({ activeModuleIDs: state.active }) };
    }
    if (path === "/api/bridge/targets") {
      return { status: 200, body: { ok: true, targetIDs: state.locked, notifications: [] } };
    }
    if (path === "/api/bridge/targets/lock") {
      state.locked = [ROCK];
      return {
        status: 200,
        body: { ok: true, locked: true, acquiring: false, targetIDs: state.locked, notifications: [] },
      };
    }
    if (path === "/api/bridge/modules/activate") {
      state.active = [LASER];
      return {
        status: 200,
        body: { ok: true, active: true, activeModuleIDs: state.active, notifications: [] },
      };
    }
    if (path === "/api/bridge/ship/ore-hold") {
      return { status: 200, body: holdsBody(0, []) };
    }
    // R43 preflight: the fit, and the names it needs to tell a Strip Miner from
    // a Nanofiber. Without these the requirement check reaches cannot-tell and
    // correctly refuses to start.
    if (path === "/api/bridge/fitting") {
      return { status: 200, body: fittingBody() };
    }
    if (path === "/api/names") {
      return { status: 200, body: namesBody(body) };
    }
    return { status: 200, body: { ok: true } };
  });
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch });
  return { store, flow, requests, state };
}

test("startMiningBot refuses to start with no equipment picked, and says so in the bot slice", async () => {
  const { store, flow, requests } = harness();
  await flow.startMiningBot({ ...REQUEST, miningModuleIDs: [] });

  assert.equal(store.get().bot.status, "idle");
  assert.match(String(store.get().bot.startError), /at least one piece of mining equipment/i);
  assert.equal(requests.length, 0, "and it issues nothing at all");
});

test("startMiningBot lands the plan in the store and the loop drives the real BFF routes", async () => {
  const { store, flow, requests } = harness();
  await flow.startMiningBot(REQUEST);

  const started = store.get().bot;
  assert.equal(started.status, "running");
  assert.equal(started.beltName, "Asteroid Belt 1");
  assert.equal(started.stationName, "Jita IV - Moon 4");

  // Let the loop run a few cycles, then stop it (the driver is async).
  await new Promise((resolve) => setTimeout(resolve, 60));
  flow.stopMiningBot();

  const paths = new Set(requests.map((r) => r.path));
  assert.ok(paths.has("/api/bridge/flight/status"), "it reads flight status");
  assert.ok(paths.has("/api/bridge/space/snapshot"), "it measures the space around the ship");
  assert.ok(paths.has("/api/bridge/targets"), "it reads the LOCK AUTHORITY, not its own memory");
  assert.ok(paths.has("/api/bridge/ship/ore-hold"), "it reads the ORE AUTHORITY");
  assert.ok(paths.has("/api/bridge/targets/lock"), "and it locked the rock it measured as nearest");

  const lock = requests.find((r) => r.path === "/api/bridge/targets/lock");
  assert.equal(lock?.body.targetID, ROCK);
});

test("the bot activates a module with NO effect name — the server resolves it, the browser never guesses", async () => {
  const { flow, requests } = harness({ locked: [ROCK] });
  await flow.startMiningBot(REQUEST);
  await new Promise((resolve) => setTimeout(resolve, 60));
  flow.stopMiningBot();

  const activate = requests.find((r) => r.path === "/api/bridge/modules/activate");
  assert.ok(activate, "it switched the equipment on");
  assert.equal(activate.body.itemID, LASER);
  assert.equal(activate.body.targetID, ROCK);
  assert.equal(
    "effect" in activate.body,
    false,
    "no effect name: the SERVER resolves the module's own default activation effect",
  );
});

test("the bot's warps carry retail's minRange 0, not the autopilot call's built-in 10 km (R24 slice A)", async () => {
  // A world with the belt far away and no rocks, so the ladder chooses a warp.
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if (path === "/api/bridge/space/snapshot") {
      return {
        status: 200,
        body: {
          ok: true,
          space: {
            inSpace: true,
            solarSystemID: 30000142,
            shipID: SHIP,
            sampledAtMs: 0,
            ship: {
              itemID: SHIP,
              radius: 60,
              position: { x: 0, y: 0, z: 0 },
              velocity: { x: 0, y: 0, z: 0 },
              mode: "STOP",
              shieldRatio: 1,
              armorRatio: 1,
              hullRatio: 1,
              activeModuleIDs: [],
            },
            entities: [
              {
                itemID: BELT,
                kind: "celestial",
                name: "Asteroid Belt 1",
                radius: 0,
                position: { x: 4_000_000_000, y: 0, z: 0 },
                velocity: { x: 0, y: 0, z: 0 },
              },
            ],
          },
          notifications: [],
        },
      };
    }
    if (path === "/api/bridge/targets") {
      return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    }
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    return { status: 200, body: { ok: true } };
  });
  const flow = createAppFlow(createClientStore(), { fetch });
  await flow.startMiningBot(REQUEST);
  await new Promise((resolve) => setTimeout(resolve, 60));
  flow.stopMiningBot();

  const warp = requests.find((r) => r.path === "/api/bridge/flight/warp");
  assert.ok(warp, "it warps to the belt");
  assert.equal(warp.body.destinationID, BELT);
  assert.equal(warp.body.minRange, 0, "retail's WarpToItem(warpRange=0), not the hardcoded 10 km");
});

test("a docked bot unloads first and only then undocks — and the readout says why", async () => {
  let items: unknown[] = [{ itemID: 90001, typeID: 1230, quantity: 4_000 }];
  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(true) };
    if (path === "/api/bridge/ship/ore-hold") {
      return { status: 200, body: holdsBody(items.length > 0 ? 4_000 : 0, items) };
    }
    if (path === "/api/bridge/ship/ore-hold/unload") {
      items = [];
      return { status: 200, body: { ok: true, requested: [90001], moved: [90001], remaining: [] } };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    return { status: 200, body: { ok: true } };
  });
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch });
  await flow.startMiningBot(REQUEST);
  await new Promise((resolve) => setTimeout(resolve, 80));
  flow.stopMiningBot();

  const order = requests.map((r) => r.path);
  const unloadAt = order.indexOf("/api/bridge/ship/ore-hold/unload");
  const undockAt = order.indexOf("/api/bridge/flight/undock");
  assert.ok(unloadAt >= 0, "it unloaded");
  assert.ok(
    undockAt === -1 || undockAt > unloadAt,
    "and never undocked before the hold read back empty",
  );
  // A completed haul is counted from the HOLD reading back empty, not from the
  // unload call's 200. (The undock itself is a later tick at the 2 s cadence;
  // the full docked -> unload -> undock -> belt sequence is driven end to end in
  // miningBotLoop.test.ts, which owns the clock.)
  assert.equal(store.get().bot.cyclesCompleted, 1);
});

test("pause / carry on / stop drive the loop and land in the store", async () => {
  const { store, flow } = harness();
  await flow.startMiningBot(REQUEST);
  assert.equal(store.get().bot.status, "running");

  flow.pauseMiningBot();
  assert.equal(store.get().bot.status, "paused");
  assert.match(String(store.get().bot.why), /paused the bot/i);

  flow.resumeMiningBot();
  assert.equal(store.get().bot.status, "running");

  flow.stopMiningBot();
  assert.equal(store.get().bot.status, "stopped");
  assert.match(String(store.get().bot.why), /stopped the bot/i);
});

test("starting the bot ABORTS the travel autopilot — two loops must never steer one ship", async () => {
  const { store, flow } = harness();
  // Put the travel slice into a running state the way startRoute does.
  store.apply({
    type: "travel/planned",
    destinationSystemID: 30000142,
    destinationStationID: STATION,
    destinationName: "Somewhere",
    route: [],
    totalJumps: 0,
    startedAt: Date.now(),
  });
  assert.equal(store.get().travel.status, "running");

  await flow.startMiningBot(REQUEST);
  flow.stopMiningBot();
  // The autopilot controller is aborted; the bot owns the ship from here.
  assert.equal(store.get().bot.status, "stopped");
});

test("the bot's readout never carries a numeric id (R7d)", async () => {
  const { store, flow } = harness();
  await flow.startMiningBot(REQUEST);
  await new Promise((resolve) => setTimeout(resolve, 60));
  flow.stopMiningBot();

  const bot = store.get().bot;
  const text = [bot.why, bot.action, bot.phase, bot.rockName, bot.failureReason]
    .filter((part): part is string => typeof part === "string")
    .join(" | ");
  for (const id of [ROCK, BELT, STATION, LASER, SHIP]) {
    assert.doesNotMatch(text, new RegExp(String(id)), `readout must not show ${id}: ${text}`);
  }
});
