// The R5b Travel flow against a faked BFF: startRoute loads the client-side
// route graph, reads the origin from flight-status, resolves the destination,
// solves the route, applies travel/planned, and launches the decide-loop.
// Unreachable/unknown destinations surface a plan error (not a throw). Abort
// stops the loop. The decide-loop's own atomic sequencing is covered
// exhaustively in nav/autopilotLoop.test.ts; here we cover the flow wiring.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

// A 3-system line: Alpha(1) <-> Bravo(2) <-> Charlie(3). The origin is Alpha
// (from flight-status), the destination station 60000003 is in Charlie.
const GRAPH = {
  ok: true,
  systems: { "1": "Alpha", "2": "Bravo", "3": "Charlie" },
  edges: [
    [1, 2, 112, 211],
    [2, 1, 211, 112],
    [2, 3, 223, 322],
    [3, 2, 322, 223],
  ],
};
const DOCKED_ALPHA = {
  inSpace: false,
  docked: true,
  solarSystemID: 1,
  stationID: 60000001,
  structureID: null,
  shipID: 9001,
  shipMode: null,
  shipSpeedFraction: null,
};

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => { status: number; body: unknown },
): typeof fetch {
  return (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const outcome = responder(path, method, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;
}

// A permissive responder: the graph, resolve, flight-status, and movement
// endpoints all answer so the background loop's ticks are harmless.
function defaultResponder(path: string): { status: number; body: unknown } {
  if (path === "/api/map/graph") {
    return { status: 200, body: GRAPH };
  }
  if (path.startsWith("/api/map/resolve/")) {
    const id = Number(path.split("/").pop());
    if (id === 60000001) {
      return { status: 200, body: { ok: true, id, kind: "station", stationID: id,
        stationName: "Alpha Station", solarSystemID: 1, systemName: "Alpha" } };
    }
    if (id === 60000003) {
      return { status: 200, body: { ok: true, id, kind: "station", stationID: id, stationName: "Charlie Station", solarSystemID: 3, systemName: "Charlie" } };
    }
    if (id === 99999999) {
      return { status: 200, body: { ok: true, id, kind: "unknown", solarSystemID: null } };
    }
    return { status: 200, body: { ok: true, id, kind: "system", solarSystemID: id, systemName: `System ${id}` } };
  }
  if (path === "/api/bridge/flight/status") {
    return { status: 200, body: { ok: true, flight: DOCKED_ALPHA, notifications: [] } };
  }
  if (path.startsWith("/api/dockable-structures/find?")) {
    return { status: 200, body: { ok: true, matches: [] } };
  }
  if (path.startsWith("/api/bridge/flight/")) {
    return { status: 200, body: { ok: true, result: null, flight: DOCKED_ALPHA, notifications: [] } };
  }
  throw new Error(`unexpected ${path}`);
}

test("startRoute solves a multi-hop route and applies travel/planned", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  const outcome = await flow.startRoute(60000003); // station in Charlie(3)
  flow.abortRoute(); // stop the background loop

  assert.equal(outcome.started, true, "a plan that reached the autopilot reports started");
  const travel = store.travel.get();
  assert.equal(travel.destinationSystemID, 3);
  assert.equal(travel.destinationStationID, 60000003);
  assert.equal(travel.destinationName, "Charlie Station");
  assert.equal(travel.totalJumps, 2);
  assert.deepEqual(
    travel.route.map((h) => [h.fromSystemID, h.toSystemID, h.gateToWarpID, h.jumpToGateID]),
    [
      [1, 2, 112, 211],
      [2, 3, 223, 322],
    ],
  );
  assert.equal(travel.route[0]?.fromSystemName, "Alpha");
  assert.equal(travel.route[1]?.toSystemName, "Charlie");
});

test("accessible structure routes through its authoritative system and access loss blocks departure", async () => {
  const structureID = 1030000000002;
  const paths: string[] = [];
  let access = true;
  const responder = (path: string) => {
    paths.push(path);
    if (path === `/api/map/resolve/${structureID}`) {
      return { status: 200, body: { ok: true, id: structureID, kind: "structure", structureID,
        solarSystemID: 3, systemName: "Charlie", structureName: "QA Astrahus" } };
    }
    if (path === `/api/dockable-structures/${structureID}`) {
      return access
        ? { status: 200, body: { ok: true, location: { kind: "structure", id: structureID,
          name: "QA Astrahus", solarSystemID: 3, solarSystemName: "Charlie" } } }
        : { status: 409, body: { ok: false, error: "STRUCTURE_DOCK_ACCESS_DENIED" } };
    }
    return defaultResponder(path);
  };
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(responder) });
  const first = await flow.startRoute(structureID);
  flow.abortRoute();
  assert.equal(first.started, true);
  assert.equal(store.travel.get().destinationStationID, structureID);
  assert.equal(store.travel.get().destinationSystemID, 3);
  assert.equal(store.travel.get().destinationName, "QA Astrahus");
  access = false;
  const second = await flow.startRoute(structureID);
  assert.equal(second.started, false);
  assert.match(second.started === false ? second.reason : "", /access/i);
  assert.equal(paths.filter((path) => path === `/api/dockable-structures/${structureID}`).length, 2);
});

test("startRoute to a same-system destination plans zero jumps", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  await flow.startRoute(1); // Alpha, our current system
  flow.abortRoute();

  const travel = store.travel.get();
  assert.equal(travel.totalJumps, 0);
  assert.equal(travel.destinationSystemID, 1);
  assert.equal(travel.route.length, 0);
});

test("startRoute surfaces an unreachable destination as a plan error", async () => {
  const store = createClientStore();
  const responder = (path: string) => {
    if (path === "/api/map/resolve/50") {
      return { status: 200, body: { ok: true, id: 50, kind: "system", solarSystemID: 50, systemName: "Island" } };
    }
    return defaultResponder(path);
  };
  const flow = createAppFlow(store, { fetch: makeFakeFetch(responder) });

  const outcome = await flow.startRoute(50); // system not in the graph

  const travel = store.travel.get();
  assert.equal(travel.status, "idle");
  assert.match(travel.failureReason ?? "", /No gate route/i);
  // The failure is ALSO the return value — that is what the mission bot's
  // startTravel dep throws on, so a flight that never started is never booked.
  assert.equal(outcome.started, false);
  assert.match(outcome.started === false ? outcome.reason : "", /No gate route/i);
});

test("startRoute surfaces an unknown destination as a plan error", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  const outcome = await flow.startRoute(99999999);

  const travel = store.travel.get();
  assert.equal(travel.status, "idle");
  assert.match(travel.failureReason ?? "", /Unknown destination/i);
  assert.equal(outcome.started, false);
});

test("searchDestinations finds systems/stations by name, annotated with jumps (R7a)", async () => {
  const store = createClientStore();
  // The player is docked in Alpha(1), so jumps are measured from system 1.
  store.apply({
    type: "character/online",
    character: { characterID: 140000003, characterName: "Test", stationID: 60000001, structureID: null, solarSystemID: 1, corporationID: 98000000 },
    station: null,
  });
  const responder = (path: string) => {
    if (path.startsWith("/api/map/find")) {
      return {
        status: 200,
        body: {
          ok: true,
          source: "static-data",
          q: "char",
          kind: null,
          total: 2,
          capped: false,
          matches: [
            { id: 3, name: "Charlie", kind: "system", solarSystemID: 3, solarSystemName: "Charlie" },
            { id: 60000003, name: "Charlie Station", kind: "station", solarSystemID: 3, solarSystemName: "Charlie" },
          ],
        },
      };
    }
    return defaultResponder(path);
  };
  const flow = createAppFlow(store, { fetch: makeFakeFetch(responder) });

  const results = await flow.searchDestinations("char");

  assert.equal(results.length, 2);
  const system = results.find((r) => r.kind === "system");
  const station = results.find((r) => r.kind === "station");
  assert.equal(system?.id, 3);
  assert.equal(system?.solarSystemName, "Charlie");
  // Charlie is 2 jumps from Alpha over the 3-system line; both are in Charlie(3).
  assert.equal(system?.jumps, 2);
  assert.equal(station?.jumps, 2);
});

test("searchDestinations ignores a too-short query without a request", async () => {
  const store = createClientStore();
  const responder = (path: string) => {
    throw new Error(`unexpected ${path}`);
  };
  const flow = createAppFlow(store, { fetch: makeFakeFetch(responder) });

  const results = await flow.searchDestinations("J");
  assert.equal(results.length, 0);
});

test("a searched destination Set via startRoute plans the route (R7a)", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  // Picking a result hands its id to startRoute (the search box → Set destination
  // wiring). The station in Charlie(3) plans a 2-hop route from Alpha(1).
  await flow.startRoute(60000003);
  flow.abortRoute();

  const travel = store.travel.get();
  assert.equal(travel.destinationStationID, 60000003);
  assert.equal(travel.totalJumps, 2);
});

test("abortRoute after start marks the travel state aborted", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  await flow.startRoute(60000003);
  flow.abortRoute();

  assert.equal(store.travel.get().status, "aborted");
});

// --- R24 slice B: the smart Dock command ------------------------------------

const IN_SPACE_ALPHA = {
  inSpace: true,
  docked: false,
  solarSystemID: 1,
  stationID: null,
  structureID: null,
  shipID: 9001,
  shipMode: "STOP",
  shipSpeedFraction: 0,
};

/** The default responder, but with the ship in space rather than docked. */
function inSpaceResponder(path: string): { status: number; body: unknown } {
  if (path === "/api/bridge/flight/status") {
    return { status: 200, body: { ok: true, flight: IN_SPACE_ALPHA, notifications: [] } };
  }
  if (path === "/api/bridge/space/snapshot") {
    return { status: 200, body: { ok: true, space: null, notifications: [] } };
  }
  if (path.startsWith("/api/bridge/flight/")) {
    return { status: 200, body: { ok: true, result: null, flight: IN_SPACE_ALPHA, notifications: [] } };
  }
  return defaultResponder(path);
}

test("dockAt hands the SAME decide-loop a zero-hop plan for the station (no second autopilot)", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(inSpaceResponder) });

  await flow.dockAt(60000001); // a station in Alpha, our current system
  flow.abortRoute();

  const travel = store.travel.get();
  assert.equal(travel.destinationStationID, 60000001, "the station is the destination");
  assert.equal(travel.destinationSystemID, 1, "in the system we are already in");
  assert.equal(travel.totalJumps, 0);
  assert.equal(travel.route.length, 0, "no hops: Dock never routes between systems");
  // R7d — the readout carries a NAME, never the id.
  assert.equal(typeof travel.destinationName, "string");
});

test("dockAt never treats the Dock call's 200 as docked — arrival comes from flight status", async () => {
  // The confirmed hazard: `Handle_CmdDock` can return 200/null WITHOUT docking
  // (beyonceService.js:3031-3042 — WARP_LANDING_PENDING, STATION_NOT_FOUND,
  // SHIP_IMMOBILE, DOCKING_APPROACH_REQUIRED all reach the browser as ok:true).
  // Here EVERY movement call answers 200, and flight status keeps saying the
  // ship is in space. The loop must not reach "arrived".
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(inSpaceResponder) });

  await flow.dockAt(60000001);
  // Let the background loop take a few ticks against the lying server.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = store.travel.get().status;
  flow.abortRoute();

  assert.notEqual(status, "arrived", "a 200 from Dock is not proof the ship docked");
});

test("dockAt at the station you are already in says so instead of starting a loop", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) }); // docked at 60000001

  await flow.dockAt(60000001);

  assert.match(String(store.travel.get().failureReason), /already docked/i);
  assert.equal(store.travel.get().destinationStationID, null, "no plan was started");
});

test("dockAt refuses a non-station id with a reason, not a request", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, {
    fetch: makeFakeFetch(() => {
      throw new Error("no request should be made");
    }),
  });

  await flow.dockAt(0);
  assert.match(String(store.travel.get().failureReason), /not a station/i);
});

// --- R30 slice A: nearbyGates ------------------------------------------------

test("nearbyGates reads the SAME cached graph the autopilot uses — no new server surface", async () => {
  const store = createClientStore();
  const paths: string[] = [];
  const flow = createAppFlow(store, {
    fetch: makeFakeFetch((path) => {
      paths.push(path);
      return defaultResponder(path);
    }),
  });

  const fromBravo = await flow.nearbyGates(2);
  assert.deepEqual(fromBravo, [
    { gateID: 211, toSystemID: 1, toSystemName: "Alpha", destinationGateID: 112 },
    { gateID: 223, toSystemID: 3, toSystemName: "Charlie", destinationGateID: 322 },
  ]);

  // The ONLY route it touches is the static map graph the route solver already
  // fetches. Nothing here is a game call, so it starts nothing.
  assert.deepEqual(paths, ["/api/map/graph"]);

  // Cached: a second system's gates cost no second fetch.
  const fromAlpha = await flow.nearbyGates(1);
  assert.equal(fromAlpha.length, 1);
  assert.equal(fromAlpha[0]?.toSystemName, "Bravo");
  assert.deepEqual(paths, ["/api/map/graph"], "the graph is fetched once, then cached");
});

test("nearbyGates answers a system with no gates, and an invalid one, without a request", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, { fetch: makeFakeFetch(defaultResponder) });

  assert.deepEqual(await flow.nearbyGates(0), [], "an unknown system asks nothing");
  assert.deepEqual(await flow.nearbyGates(-7), []);
  // A system the graph does not reach is empty, not an error.
  assert.deepEqual(await flow.nearbyGates(4242), []);
});

test("nearbyGates surfaces a failed graph read instead of pretending there are no gates", async () => {
  const store = createClientStore();
  const flow = createAppFlow(store, {
    fetch: makeFakeFetch((path) => {
      if (path === "/api/map/graph") {
        return { status: 500, body: { ok: false, error: "map unavailable" } };
      }
      throw new Error(`unexpected ${path}`);
    }),
  });

  // "No gates here" and "I could not read the star map" are different facts and
  // the panel renders them differently — so this must reject, not return [].
  await assert.rejects(() => flow.nearbyGates(2));
});
