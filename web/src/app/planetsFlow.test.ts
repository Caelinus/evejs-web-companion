// R41 planets WIRED THROUGH THE FLOW, against a faked BFF.
//
// `bridge/planets.test.ts` pins the decoding against the raw payload; this pins
// the other half — that the panel's state ends up saying the RIGHT ONE of three
// different things, and that the read is exactly one GET with no write anywhere
// near it.
//
// The claim that is easiest to get wrong, and the one this file exists for:
//
//   `hasNoColonies` MUST be false when the read failed, and false when the
//   gateway reported no colony table at all. Only a successful read that
//   carried a table and found nothing of ours may set it. Get that wrong and
//   the panel tells a player with six colonies that they have never built
//   anything — which is exactly the class of defect the worldHasNoContracts
//   rule exists to prevent.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

interface Recorded {
  readonly path: string;
  readonly method: string;
}

const PLANET_ID = 40000002;
const OTHER_PLANET_ID = 40000005;
const SERVER_NOW = Date.UTC(2026, 6, 21, 12, 0, 0);
const HOUR = 3_600_000;

function makeFakeFetch(
  responder: (path: string, method: string) => { status: number; body: unknown },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    requests.push({ path, method });
    const outcome = responder(path, method);
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

function colony(planetID: number, planetName: string): unknown {
  return {
    planetID,
    planetName,
    solarSystemID: 30000001,
    solarSystemName: "Tanoo",
    planetTypeID: 11,
    planetTypeName: "Planet (Temperate)",
    commandCenterLevel: 3,
    lastSimulatedAtMs: SERVER_NOW - 60_000,
    linkCount: 4,
    pins: [
      {
        pinID: 1,
        typeID: 2254,
        typeName: "Temperate Command Center",
        kind: "command",
        contents: [],
        program: null,
      },
      {
        pinID: 2,
        typeID: 3068,
        typeName: "Temperate Extractor Control Unit",
        kind: "extractor-control",
        contents: [],
        program: {
          resourceTypeID: 2268,
          resourceTypeName: "Aqueous Liquids",
          cycleTimeSeconds: 3600,
          quantityPerCycle: 2841,
          installedAtMs: SERVER_NOW - 3 * HOUR,
          expiresAtMs: SERVER_NOW + 21 * HOUR,
          headCount: 3,
        },
      },
    ],
    routes: [],
  };
}

function planetsBody(colonies: unknown[], coloniesReadable = true): unknown {
  return {
    ok: true,
    characterID: 7,
    serverNowMs: SERVER_NOW,
    coloniesReadable,
    colonies,
  };
}

// Two GETs since R108: the colonies, and beside them the static recipe table
// the panel names a factory's ingredients from. The count is not the point and
// never was - what this test guards is that LOOKING AT A COLONY WRITES
// NOTHING, which is now asserted directly rather than implied by there being
// exactly one request.
test("the colonies land by GET alone, and nothing is written anywhere", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(() => ({
    status: 200,
    body: planetsBody([colony(PLANET_ID, "Tanoo I")]),
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();

  assert.deepEqual(
    requests.filter((request) => request.path === "/api/bridge/planets"),
    [{ path: "/api/bridge/planets", method: "GET" }],
    "the colonies are read exactly once",
  );
  assert.deepEqual(
    requests.filter((request) => request.method !== "GET"),
    [],
    "nothing about looking at a colony writes anything",
  );
  const planets = store.get().planets;
  assert.equal(planets.loaded, true);
  assert.equal(planets.error, null);
  assert.equal(planets.colonies?.length, 1);
  assert.equal(planets.colonies?.[0]?.planetName, "Tanoo I");
  assert.equal(planets.hasNoColonies, false);
});

test("the server's clock arrives with the colonies, not after them", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    body: planetsBody([colony(PLANET_ID, "Tanoo I")]),
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();

  // The offset is however far this machine's clock is from the server's; the
  // exact value depends on when the test ran, but it must have been computed
  // (a dropped offset is exactly 0, and SERVER_NOW is not now).
  const { clockOffsetMs } = store.get().planets;
  assert.notEqual(clockOffsetMs, 0);
  assert.ok(Math.abs(SERVER_NOW - (Date.now() + clockOffsetMs)) < 5000);
});

test("a SUCCESSFUL empty read is the only thing that says \"you have none\"", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    body: planetsBody([], true),
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();

  const planets = store.get().planets;
  assert.equal(planets.loaded, true);
  assert.equal(planets.error, null);
  assert.deepEqual(planets.colonies, []);
  assert.equal(planets.hasNoColonies, true);
});

test("a gateway that reports NO colony table has not said the character has none", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    // coloniesReadable false: the snapshot carried no colony table at all.
    body: planetsBody([], false),
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();

  const planets = store.get().planets;
  assert.equal(planets.loaded, true);
  assert.deepEqual(planets.colonies, []);
  // ⚠ THE WHOLE POINT. Empty list, but NOT a claim about the character.
  assert.equal(planets.hasNoColonies, false);
});

test("a FAILED read says so, and never claims the character has no colonies", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 500,
    body: { ok: false, error: "GATEWAY_UNREACHABLE", message: "the gateway is down" },
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();

  const planets = store.get().planets;
  assert.equal(planets.hasNoColonies, false);
  // Never [] for "unknown": an empty list would render as a page saying the
  // player owns nothing.
  assert.equal(planets.colonies, null);
  assert.ok(planets.error);
  assert.match(planets.error!, /could not be read/i);
});

test("a failed read AFTER a good one does not erase what we last saw as \"none\"", async () => {
  const store = createClientStore();
  let fail = false;
  const { fetch } = makeFakeFetch(() => (fail
    ? { status: 500, body: { ok: false, error: "GATEWAY_UNREACHABLE", message: "down" } }
    : { status: 200, body: planetsBody([], true) }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();
  assert.equal(store.get().planets.hasNoColonies, true);

  fail = true;
  await flow.loadPlanets();

  // The last thing we KNEW was "none", but the newest read told us nothing at
  // all — so the claim is withdrawn rather than left standing on stale evidence.
  const planets = store.get().planets;
  assert.equal(planets.hasNoColonies, false);
  assert.ok(planets.error);
});

test("opening a colony is view state, and costs no read", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(() => ({
    status: 200,
    body: planetsBody([colony(PLANET_ID, "Tanoo I"), colony(OTHER_PLANET_ID, "Tanoo II")]),
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();
  const readsAfterLoad = requests.length;

  flow.selectColony(OTHER_PLANET_ID);
  assert.equal(store.get().planets.selectedPlanetID, OTHER_PLANET_ID);
  assert.equal(requests.length, readsAfterLoad, "opening a colony must not re-read");

  flow.selectColony(null);
  assert.equal(store.get().planets.selectedPlanetID, null);
  assert.equal(requests.length, readsAfterLoad);
});

test("a refresh keeps the open colony open — unless it is gone", async () => {
  const store = createClientStore();
  let both = true;
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    body: planetsBody(both
      ? [colony(PLANET_ID, "Tanoo I"), colony(OTHER_PLANET_ID, "Tanoo II")]
      : [colony(PLANET_ID, "Tanoo I")]),
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();
  flow.selectColony(OTHER_PLANET_ID);

  await flow.loadPlanets();
  assert.equal(store.get().planets.selectedPlanetID, OTHER_PLANET_ID);

  // The colony was abandoned between reads. Leaving it selected would leave the
  // detail pane pointing at nothing.
  both = false;
  await flow.loadPlanets();
  assert.equal(store.get().planets.selectedPlanetID, null);
});

test("logging out takes the colonies with it", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    body: planetsBody([colony(PLANET_ID, "Tanoo I")]),
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();
  flow.selectColony(PLANET_ID);
  assert.equal(store.get().planets.colonies?.length, 1);

  store.apply({ type: "session/logged-out" });

  const planets = store.get().planets;
  assert.equal(planets.colonies, null);
  assert.equal(planets.selectedPlanetID, null);
  assert.equal(planets.loaded, false);
  assert.equal(planets.hasNoColonies, false);
});
