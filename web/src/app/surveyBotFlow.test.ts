// The WIRING of the mining surveyor into a bot's tick — the half that
// nav/surveyScan.test.ts cannot see, because that one pins the rules and this
// one pins whether the runner actually presses the button, and for which block.
//
// Two facts, and they are the whole of it: a block that works a rock runs the
// scanner when the grid has rocks nobody has measured, and a block that does not
// work a rock never pays for the call.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript } from "../bots/botScript.ts";
import { fittingBody, flightBody, holdsBody, namesBody } from "./botFixtures.ts";

const CHARACTER_ID = 140000005;
const STATION_ID = 60000358;
const SOLAR_SYSTEM_ID = 30000144;
const SHIP_ID = 9988400023309;
const ROCK_ID = 5001;
const BELT_ID = 40000123;

interface Recorded {
  readonly path: string;
  readonly method: string;
}

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => { status: number; body: unknown },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method });
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

/**
 * A belt with one rock the SERVER has no quantity for — the ordinary case, and
 * the one the surveyor exists for. `remainingQuantity` is absent rather than 0:
 * the scene's mining state simply has nothing to say about this rock yet.
 */
function beltSpaceBody(): unknown {
  return {
    ok: true,
    space: {
      inSpace: true,
      solarSystemID: SOLAR_SYSTEM_ID,
      shipID: SHIP_ID,
      sampledAtMs: 0,
      ship: {
        itemID: SHIP_ID,
        typeID: 17480,
        name: "Procurer",
        mode: "STOP",
        radius: 60,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        activeModuleIDs: [],
      },
      entities: [
        {
          itemID: ROCK_ID,
          kind: "asteroid",
          name: "Veldspar",
          typeID: 1230,
          radius: 100,
          position: { x: 6000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
          miningYieldTypeID: 1230,
          beltID: BELT_ID,
          oreGrade: 1,
        },
        {
          itemID: BELT_ID,
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

function script(step: BotScript["program"][number]): BotScript {
  return {
    format: "evejs-bot-script",
    version: 1,
    name: "t",
    notes: "",
    home: { entity: "station", id: STATION_ID, name: "Home", systemName: null },
    interrupts: [],
    program: [step],
  };
}

function onlineStore(): ReturnType<typeof createClientStore> {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });
  return store;
}

function responder(path: string, body: Record<string, unknown>): { status: number; body: unknown } {
  if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
  if (path === "/api/bridge/space/snapshot") return { status: 200, body: beltSpaceBody() };
  if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
  if (path === "/api/names") return { status: 200, body: namesBody(body) };
  if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
  if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
  if (path === "/api/bridge/mining/scan") {
    return {
      status: 200,
      body: { ok: true, results: [[ROCK_ID, 1230, 4200]], notifications: [] },
    };
  }
  return { status: 200, body: { ok: true } };
}

test("a mine-at-belt block runs the surveyor, and what it saw reaches the rock rows", async () => {
  const store = onlineStore();
  const { fetch, requests } = makeFakeFetch((path, _method, body) => responder(path, body));

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(
    script({
      id: "mine",
      kind: "macro",
      macro: "mine-at-belt",
      args: {},
      until: { kind: "ore-hold-at-least", fraction: 0.9 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const scans = requests.filter((request) => request.path === "/api/bridge/mining/scan");
  assert.equal(scans.length, 1, "the block that works a rock pressed the surveyor once");
  assert.equal(scans[0]?.method, "GET", "a survey scan is a read, and needs no confirmation");

  // It landed in the mining slice, exactly where the button's own scan lands…
  assert.equal(store.get().mining.survey[0]?.remainingQuantity, 4200);
  // …and it filled the blank on the rock row itself, which is what every
  // rock-choosing decision downstream actually reads.
  const rock = store.get().space.snapshot?.entities.find((row) => row.itemID === ROCK_ID);
  assert.equal(rock?.remainingQuantity, 4200);
});

test("a block that works no rock never pays for a scan", async () => {
  const store = onlineStore();
  const { fetch, requests } = makeFakeFetch((path, _method, body) => responder(path, body));

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(
    script({ id: "wait", kind: "macro", macro: "wait", args: {} }),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  assert.equal(
    requests.filter((request) => request.path === "/api/bridge/mining/scan").length,
    0,
    "the same grid, the same rocks — but nothing in this block reads them",
  );
  const rock = store.get().space.snapshot?.entities.find((row) => row.itemID === ROCK_ID);
  assert.equal(rock?.remainingQuantity, null, "an unmeasured rock stays unmeasured, never 0");
});
