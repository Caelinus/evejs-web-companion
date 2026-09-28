// R108 slice 1: the recipe table is fetched ALONGSIDE the colony read, wired
// into `loadPlanets` via `ensurePiRecipes` (flow.ts) and stored under
// `planets.recipes` (clientStore.ts, `planets/recipes`).
//
// This file pins the WIRING, not the decode (piRecipes.test.ts already pins
// `decodeRecipeBook` against the wire shape). The claims under test:
//
//   1. reading the colonies also lands a decoded, `readable` recipe book;
//   2. the recipe table is fetched ONCE per session, never re-read;
//   3. a failed recipe fetch is swallowed and never becomes a colony error;
//   4. a failed colony read does not stop a concurrent recipe fetch landing;
//   5. loadPlanets does not resolve until the recipe fetch has settled;
//   6. the book survives a character change; the colonies do not (both of the
//      two store sites that clear planets: `session/logged-out` and
//      `planets/cleared`);
//   7. a session-lost colony read still throws and flips the character
//      offline, with the recipe fetch settled rather than left dangling.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

interface Recorded {
  readonly path: string;
  readonly method: string;
}

const PLANET_ID = 40000002;
const SCHEMATIC_ID = 2300;
const OUTPUT_TYPE_ID = 2288;
const INPUT_TYPE_ID = 1230;
const SERVER_NOW = Date.UTC(2026, 6, 21, 12, 0, 0);

type Responder = (path: string, method: string) => { status: number; body: unknown };

function makeFakeFetch(
  responder: Responder,
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
    pins: [],
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

// A small, hand-built recipe table in the wire shape `decodeRecipeBook`
// expects (see bridge/piRecipes.ts) — not the real table, this is a wiring
// test.
function recipesBody(): unknown {
  return {
    ok: true,
    schematics: [
      {
        schematicID: SCHEMATIC_ID,
        name: "Test Plastics",
        cycleTimeSeconds: 1800,
        factoryTypeIDs: [2256],
        inputs: [{ typeID: INPUT_TYPE_ID, typeName: "Base Metals", quantity: 3000 }],
        output: { typeID: OUTPUT_TYPE_ID, typeName: "Test Plastics", quantity: 20 },
      },
    ],
    commodities: {
      [String(OUTPUT_TYPE_ID)]: { typeName: "Test Plastics", tier: 2 },
      [String(INPUT_TYPE_ID)]: { typeName: "Base Metals", tier: 1 },
    },
  };
}

function okResponder(colonies: unknown[] = [colony(PLANET_ID, "Tanoo I")]): Responder {
  return (path) => {
    if (path === "/api/pi/schematics") {
      return { status: 200, body: recipesBody() };
    }
    return { status: 200, body: planetsBody(colonies) };
  };
}

test("reading the colonies also lands a decoded, readable recipe book", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(okResponder());
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();

  const { recipes } = store.get().planets;
  assert.equal(recipes.readable, true);
  assert.equal(recipes.schematics.length, 1);
  const schematic = recipes.bySchematicID.get(SCHEMATIC_ID);
  assert.ok(schematic);
  assert.equal(schematic!.name, "Test Plastics");
  assert.equal(recipes.byOutputTypeID.get(OUTPUT_TYPE_ID)?.schematicID, SCHEMATIC_ID);
});

test("the recipe table is fetched exactly once, even across repeated loads", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch(okResponder());
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();
  await flow.loadPlanets();
  await flow.loadPlanets();

  const recipeCalls = requests.filter((r) => r.path === "/api/pi/schematics");
  assert.equal(recipeCalls.length, 1, "the recipe table must not be re-read on a later refresh");
  assert.equal(store.get().planets.recipes.readable, true);
});

test("a failing recipe fetch is not a failed colony read", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/pi/schematics") {
      return { status: 500, body: { ok: false, error: "SCHEMATICS_UNAVAILABLE" } };
    }
    return { status: 200, body: planetsBody([colony(PLANET_ID, "Tanoo I")]) };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();

  const planets = store.get().planets;
  assert.equal(planets.loaded, true, "the colony read must still succeed");
  assert.equal(planets.error, null, "no confusing second failure on a panel that read fine");
  assert.equal(planets.colonies?.length, 1);
  assert.equal(planets.recipes.readable, false, "the book stays unreadable, not partially filled");
});

test("a failing colony read does not stop a concurrent recipe fetch landing", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/pi/schematics") {
      return { status: 200, body: recipesBody() };
    }
    return { status: 500, body: { ok: false, error: "GATEWAY_UNREACHABLE", message: "down" } };
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();

  const planets = store.get().planets;
  assert.ok(planets.error, "the colony read still reports its own failure, as it always did");
  assert.equal(planets.recipes.readable, true, "the recipe fetch succeeded and must still land");
});

test("loadPlanets does not resolve until the recipe fetch has settled", async () => {
  const store = createClientStore();
  let releaseRecipes: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseRecipes = resolve;
  });
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/pi/schematics") {
      throw new Error("unused: recipes path is handled by the async fetch below");
    }
    return { status: 200, body: planetsBody([colony(PLANET_ID, "Tanoo I")]) };
  });
  // Wrap the fake fetch so the recipes call blocks on `gate` before resolving,
  // proving loadPlanets truly awaits it rather than happening to win a race.
  const gatedFetch = (async (input: unknown, init?: { method?: string }) => {
    const path = String(input);
    if (path === "/api/pi/schematics") {
      await gate;
      return {
        ok: true,
        status: 200,
        async json() {
          return recipesBody();
        },
      };
    }
    return fetch(input as never, init as never);
  }) as unknown as typeof fetch;
  const flow = createAppFlow(store, { fetch: gatedFetch });

  const loaded = flow.loadPlanets();
  let resolved = false;
  loaded.then(() => {
    resolved = true;
  });

  // Give the colony read (which has no gate) every chance to resolve first.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false, "loadPlanets must not resolve while the recipe fetch is pending");
  assert.equal(store.get().planets.recipes.readable, false, "not landed yet either");

  releaseRecipes!();
  await loaded;
  assert.equal(resolved, true);
  assert.equal(store.get().planets.recipes.readable, true);
});

test("the book survives session/logged-out, but the colonies do not", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(okResponder());
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();
  assert.equal(store.get().planets.recipes.readable, true);

  store.apply({ type: "session/logged-out" });

  const planets = store.get().planets;
  assert.equal(planets.colonies, null);
  assert.equal(planets.hasNoColonies, false);
  assert.equal(planets.loaded, false);
  assert.equal(planets.recipes.readable, true, "recipes are the same for everyone on the server");
  assert.equal(planets.recipes.bySchematicID.get(SCHEMATIC_ID)?.name, "Test Plastics");
});

test("the book survives planets/cleared too, but the colonies do not", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(okResponder());
  const flow = createAppFlow(store, { fetch });

  await flow.loadPlanets();
  assert.equal(store.get().planets.recipes.readable, true);

  store.apply({ type: "planets/cleared" });

  const planets = store.get().planets;
  assert.equal(planets.colonies, null);
  assert.equal(planets.hasNoColonies, false);
  assert.equal(planets.loaded, false);
  assert.equal(planets.recipes.readable, true);
  assert.equal(planets.recipes.bySchematicID.get(SCHEMATIC_ID)?.name, "Test Plastics");
});

test("a session-lost colony read still throws and flips offline, recipes settled not dangling", async () => {
  const store = createClientStore();
  const { fetch, requests } = makeFakeFetch((path) => {
    if (path === "/api/pi/schematics") {
      return { status: 200, body: recipesBody() };
    }
    return { status: 404, body: { ok: false, error: "SESSION_NOT_FOUND", message: "gone" } };
  });
  const flow = createAppFlow(store, { fetch });

  await assert.rejects(flow.loadPlanets(), (error: unknown) => {
    return (error as { code?: string }).code === "SESSION_NOT_FOUND";
  });

  assert.equal(store.station.get().online, null, "a lost session flips the character offline");
  const recipeCalls = requests.filter((r) => r.path === "/api/pi/schematics");
  assert.equal(recipeCalls.length, 1, "the recipe fetch was still issued alongside the colony read");
  assert.equal(
    store.get().planets.recipes.readable,
    true,
    "the recipe fetch settled before loadPlanets rejected, not left dangling",
  );
});
