// The HARDENERS-ON block against a fit that carries a DAMAGE CONTROL, driven
// through the REAL custom-bot script runner over a faked BFF.
//
// The bug this suite pins: `resolveScriptModuleCapabilities` (flow.ts) — the
// ONE capability read a bot run makes — classified the fit WITHOUT WAITING FOR
// THE DOGMA SNAPSHOT. `loadFitting` kicks dogma off fire-and-forget on purpose
// (a stumbling dogma read must never hold the fit up), so after awaiting the
// fit alone the dogma slice is still whatever it was — on a fresh session,
// nothing at all. `resolveDefenseModuleIDs` drops passive modules on dogma
// attribute 73 and FAILS OPEN when it cannot say, which is right on its own
// terms (an unread dogma must not quietly disarm a ship) but meant that with no
// snapshot in hand every module passed the test. The passive Damage Control
// almost every fit carries therefore landed in `hardeners`, and the
// Hardeners-on block spent its whole attempt budget switching on a module with
// nothing to switch — then stopped the bot outright with "a hardener kept
// refusing to switch on".
//
// ⚠ THE GROUP NAME CANNOT SETTLE THIS AND NO REGEX EVER COULD, which is why the
// fix is an await rather than a pattern. Checked against the server's own type
// data (`_local/gameStore/data/itemTypes` + `typeDogma`), group 60 "Damage
// Control" holds Damage Control II with NO attribute 73 — passive the moment it
// is online — AND Assault Damage Control II, which cycles and is worth running.
// Both are exercised below, on the same group name, so the suite fails if the
// classifier ever goes back to judging this by name.
//
// The companion's own fit read (`readCompanionFitFacts`) already awaited dogma
// for exactly this reason; this suite is the bot path's copy of that guarantee.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript } from "../bots/botScript.ts";

const CHARACTER_ID = 90000001; // ESI's own documented example CharacterID — synthetic, not a real pilot.
const STATION_ID = 60003760; // Jita IV - Moon 4 (static SDE data).
const SOLAR_SYSTEM_ID = 30000142; // Jita (static SDE data).
const SHIP_ID = 90000010;

/** Dogma attribute 73 — activation time / cycle length. Absent = passive. */
const ATTR_DURATION = 73;

interface TestModule {
  readonly itemID: number;
  readonly typeID: number;
  /** Low slots are flags 11-18; the LOWEST flag is classified first. */
  readonly flagID: number;
  /** The real SDE typeGroup NAME — what `resolved[nameKey("typeGroup", …)]` answers. */
  readonly groupName: string;
  /** Attribute 73 as the SERVER reports it for this fitted item; null = absent (passive). */
  readonly durationMs: number | null;
}

// ⚠ THE TWO DAMAGE CONTROLS SHARE A GROUP NAME ON PURPOSE — that is the whole
// point of the fixture. Durations are the server's own figures for group 60.
const DAMAGE_CONTROL: TestModule = {
  itemID: 62001,
  typeID: 876, // Damage Control II
  flagID: 11, // first in slot order, so a pre-fix run reaches for THIS one first
  groupName: "Damage Control",
  durationMs: null,
};
const ASSAULT_DAMAGE_CONTROL: TestModule = {
  itemID: 62002,
  typeID: 47257, // Assault Damage Control II — same group, and it really does cycle
  flagID: 11,
  groupName: "Damage Control",
  durationMs: 10125,
};
const ARMOR_HARDENER: TestModule = {
  itemID: 62003,
  typeID: 11269, // an Energized Adaptive Nano Membrane's active cousin — group 328
  flagID: 12,
  groupName: "Armor Hardener",
  durationMs: 10000,
};

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/**
 * ⚠ THE DOGMA READ ANSWERS LAST, AND THE SUITE IS WORTHLESS WITHOUT THAT.
 *
 * The defect is a RACE, so a fake BFF whose every endpoint answers in the same
 * microtask cannot see it: the fire-and-forget `void loadDogma()` inside
 * `loadFitting` settles during the very next `await` and the classifier finds a
 * snapshot waiting for it whether or not anybody asked for one. That is not
 * what the real BFF does. `/api/bridge/bound-dogma` is the heaviest read on the
 * fitting path — it binds dogma and issues ELEVEN bound calls against the game
 * server — while `/api/names` is served from static data and frequently from a
 * cache with no round trip at all. So the real ordering is: fit, names,
 * classify … dogma, which is precisely the ordering this delay reproduces.
 */
const DOGMA_LATENCY_MS = 40;

function packedRow(fields: Record<string, unknown>): unknown {
  return { type: "packedrow", fields };
}

function fittingBody(modules: readonly TestModule[]): unknown {
  return {
    ok: true,
    activeShipID: SHIP_ID,
    stationID: STATION_ID,
    slots: {
      type: "list",
      items: modules.map((m) =>
        packedRow({
          itemID: m.itemID,
          typeID: m.typeID,
          ownerID: CHARACTER_ID,
          locationID: SHIP_ID,
          flagID: m.flagID,
          quantity: -1,
          groupID: 0, // unused — the classifier judges the resolved GROUP NAME, not this id
          categoryID: 7,
          customInfo: "",
        }),
      ),
    },
    shipInfo: {
      type: "dict",
      entries: [
        [
          SHIP_ID,
          {
            type: "object",
            name: "util.KeyVal",
            args: { type: "dict", entries: [["itemID", SHIP_ID], ["attributes", { type: "dict", entries: [] }]] },
          },
        ],
      ],
    },
    online: { type: "list", items: modules.map((m) => m.itemID) },
    errors: { slots: null, shipInfo: null, online: null },
  };
}

/** One GET-INFO ENTRY: util.KeyVal{itemID, invItem, activeEffects, time, attributes, wallclockTime}. */
function getInfoEntry(module: TestModule): unknown {
  return {
    type: "object",
    name: "util.KeyVal",
    args: {
      type: "dict",
      entries: [
        ["itemID", module.itemID],
        [
          "invItem",
          packedRow({
            itemID: module.itemID,
            typeID: module.typeID,
            ownerID: CHARACTER_ID,
            locationID: SHIP_ID,
            flagID: module.flagID,
            quantity: -1,
            groupID: 0,
            categoryID: 7,
            customInfo: "",
            stacksize: 1,
          }),
        ],
        ["activeEffects", { type: "dict", entries: [] }],
        ["time", "134292246678390000"],
        [
          "attributes",
          {
            type: "dict",
            // ⚠ A PASSIVE MODULE IS PRESENT AND CARRIES NO 73 — it is not
            // missing from the snapshot. Those are different answers and the
            // classifier is three-state about them: absent-from-snapshot is
            // "cannot say" (fails open), present-without-73 is "passive".
            entries: [
              [9, 1000],
              ...(module.durationMs === null ? [] : [[ATTR_DURATION, module.durationMs]]),
            ],
          },
        ],
        ["wallclockTime", "134292246678389999"],
      ],
    },
  };
}

function boundDogmaBody(modules: readonly TestModule[]): unknown {
  return {
    ok: true,
    reads: {
      GetAllInfo: {
        error: null,
        result: {
          type: "object",
          name: "util.KeyVal",
          args: {
            type: "dict",
            entries: [
              ["activeShipID", SHIP_ID],
              ["shipInfo", { type: "dict", entries: modules.map((m) => [m.itemID, getInfoEntry(m)]) }],
              ["charInfo", [{ type: "dict", entries: [] }, null]],
              ["shipState", []],
              ["systemWideEffectsOnShip", { type: "dict", entries: [] }],
              ["structureInfo", { type: "dict", entries: [] }],
              ["locationInfo", { type: "dict", entries: [] }],
            ],
          },
        },
      },
    },
  };
}

function namesBody(request: Record<string, unknown>, modules: readonly TestModule[]): unknown {
  const groupByType = new Map(modules.map((m) => [m.typeID, m.groupName]));
  const items = Array.isArray(request.items) ? (request.items as { kind?: string; id?: number }[]) : [];
  const names: Record<string, string> = {};
  for (const item of items) {
    if (typeof item.id !== "number" || !groupByType.has(item.id)) {
      continue;
    }
    if (item.kind === "typeGroup") {
      names[`typeGroup:${item.id}`] = groupByType.get(item.id)!;
    } else if (item.kind === "type") {
      names[`type:${item.id}`] = "Test Module";
    }
  }
  return { ok: true, source: "static-data", count: Object.keys(names).length, names, unresolved: [] };
}

function spaceBody(activeModuleIDs: readonly number[]): unknown {
  return {
    ok: true,
    space: {
      inSpace: true,
      solarSystemID: SOLAR_SYSTEM_ID,
      shipID: SHIP_ID,
      sampledAtMs: 0,
      ship: {
        itemID: SHIP_ID,
        typeID: 1,
        name: "Test Ship",
        mode: "STOP",
        radius: 60,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        activeModuleIDs: [...activeModuleIDs],
      },
      entities: [],
    },
    notifications: [],
  };
}

function flightBody(): unknown {
  return {
    ok: true,
    flight: {
      inSpace: true,
      docked: false,
      solarSystemID: SOLAR_SYSTEM_ID,
      stationID: null,
      structureID: null,
      shipID: SHIP_ID,
      shipTypeID: 1,
      shipIsCapsule: false,
      shipMode: "STOP",
      shipSpeedFraction: 0,
    },
    notifications: [],
  };
}

function onlineStore(): ReturnType<typeof createClientStore> {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test Pilot",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });
  return store;
}

/**
 * The fake BFF. A module the runner switches on JOINS `activeModuleIDs`, the
 * way the real server's snapshot would — so the block can genuinely finish
 * rather than being told forever that nothing came on.
 */
function makeFakeFetch(modules: readonly TestModule[]): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const running: number[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method, body });
    if (path === "/api/bridge/bound-dogma") {
      await new Promise((resolve) => setTimeout(resolve, DOGMA_LATENCY_MS));
    }
    const outcome = respond(path, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;

  function respond(path: string, body: Record<string, unknown>): { status: number; body: unknown } {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody() };
    if (path === "/api/bridge/space/snapshot") return { status: 200, body: spaceBody(running) };
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody(modules) };
    if (path === "/api/bridge/bound-dogma") return { status: 200, body: boundDogmaBody(modules) };
    if (path === "/api/names") return { status: 200, body: namesBody(body, modules) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") {
      return { status: 200, body: { ok: true, activeShipID: SHIP_ID, stationID: STATION_ID, holds: [] } };
    }
    if (path === "/api/bridge/modules/activate") {
      const itemID = typeof body.itemID === "number" ? body.itemID : null;
      // Only a module that really cycles comes on. A passive one told to
      // activate is exactly what this suite exists to stop, so the fake
      // refuses to pretend it worked.
      const module = modules.find((m) => m.itemID === itemID);
      if (module && module.durationMs !== null && !running.includes(module.itemID)) {
        running.push(module.itemID);
      }
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: { ok: true } };
  }

  return { fetch: fakeFetch, requests };
}

/** A bot whose whole program is the Hardeners-on block. */
const HARDEN_SCRIPT: BotScript = {
  format: "evejs-bot-script",
  version: 1,
  name: "hardeners-on probe",
  notes: "",
  home: { entity: "station", id: STATION_ID, name: "Home", systemName: "Jita" },
  interrupts: [],
  program: [{ id: "harden", kind: "macro", macro: "hardeners-on", args: {} }],
};

/** Start the real runner, let its first tick land, stop it, and return every
 * `activate` call it issued — the observable proof of what the Hardeners-on
 * block reached for. */
async function activateCalls(modules: readonly TestModule[]): Promise<readonly Recorded[]> {
  const store = onlineStore();
  const { fetch, requests } = makeFakeFetch(modules);
  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(HARDEN_SCRIPT);
  // One tick is all this needs (the runner's cadence is seconds), but the start
  // itself now waits out the dogma read before it classifies anything.
  await new Promise((resolve) => setTimeout(resolve, 300));
  flow.stopCustomBot();
  return requests.filter((r) => r.path === "/api/bridge/modules/activate");
}

test("a passive Damage Control is never switched on by the Hardeners-on block — the fix", async () => {
  const activated = await activateCalls([DAMAGE_CONTROL, ARMOR_HARDENER]);
  assert.equal(activated.length, 1, "one module per tick, and only one of these two can be cycled");
  assert.equal(
    activated[0]?.body.itemID,
    ARMOR_HARDENER.itemID,
    "pre-fix this was the Damage Control: the bot classified its fit before the dogma snapshot arrived, so attribute 73 could not exclude it",
  );
});

test("a fit whose only defense is a passive Damage Control asks the server for nothing", async () => {
  const activated = await activateCalls([DAMAGE_CONTROL]);
  assert.equal(
    activated.length,
    0,
    "a Damage Control is already working the moment it is online — there is nothing to switch",
  );
});

test("an ASSAULT Damage Control — same group name, a real cycle — is still switched on", async () => {
  const activated = await activateCalls([ASSAULT_DAMAGE_CONTROL]);
  assert.equal(activated.length, 1, "this one really does cycle, and the block is what runs it");
  assert.equal(
    activated[0]?.body.itemID,
    ASSAULT_DAMAGE_CONTROL.itemID,
    "the classifier judges the CYCLE, not the group name — both damage controls share the name",
  );
});

test("a genuine hardener is still switched on when the dogma snapshot says it cycles (no regression)", async () => {
  const activated = await activateCalls([ARMOR_HARDENER]);
  assert.equal(activated.length, 1);
  assert.equal(activated[0]?.body.itemID, ARMOR_HARDENER.itemID);
  // targetID: 0 is self/no-target — api.activateModule drops a falsy targetID
  // from the wire body entirely rather than sending a literal 0.
  assert.equal("targetID" in (activated[0]?.body ?? {}), false, "a hardener carries no targetID at all");
});
