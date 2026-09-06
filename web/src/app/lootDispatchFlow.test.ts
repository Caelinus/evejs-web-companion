// The flow.ts DISPATCH layer for lootWreck / lootContainer, against a faked
// BFF — the layer scriptMacros.test.ts cannot see, because it only pins the
// DECIDER (which action gets chosen), not what that action does once
// `makeScriptRunnerDeps().issue` picks it up and calls the real API.
//
// Drives a real `startCustomBot` script (the general MacroID/BotScript
// runner, NOT the fixed mining ladder `startMiningBot` drives — that one
// never issues lootWreck/lootContainer at all) over a fake fetch, and asserts
// on the actual `openContainer`/`transferItems` request bodies that come out
// the other side.

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

function packedRow(fields: Record<string, unknown>): unknown {
  return { type: "packedrow", fields };
}

function keyVal(entries: [string, unknown][]): unknown {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => { status: number; body: unknown },
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

/** A space snapshot with the ship at the origin and ONE lootable entity in range. */
function spaceBodyWith(entity: Record<string, unknown>): unknown {
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
        name: "Ship",
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
      entities: [entity],
    },
    notifications: [],
  };
}

/**
 * The BFF's `/bays` answer, shaped exactly as the route builds it: EVERY
 * candidate bay is reported, absent ones with `present:false` and `items:null`.
 * Naming a bay here is what makes the router willing to address it — a hull
 * whose bays were never read routes everything to cargo instead.
 */
function baysBody(shipID: number, present: readonly string[]): unknown {
  const keys = ["cargo", "ore", "gas", "ice", "asteroid", "mineral", "salvage", "planetary", "drone", "ammo", "fuel"];
  return {
    ok: true,
    shipID,
    activeShipID: shipID,
    bays: keys.map((key) => {
      const has = present.includes(key);
      return {
        key,
        label: key,
        present: has,
        capacity: has ? { capacity: 16000, used: 0 } : { capacity: 0, used: 0 },
        items: has ? [] : null,
        error: null,
      };
    }),
  };
}

function containerReads(containerID: number, items: unknown[], volumes: Record<string, number> = {}): unknown {
  return {
    ok: true,
    containerID,
    list: { type: "list", items },
    capacity: keyVal([["capacity", 120], ["used", 4]]),
    volumes,
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

test("a custom bot's loot-containers step dispatches openContainer + transferItems for ANY container, no ownership needed", async () => {
  const CONTAINER_ID = 80001;
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

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if (path === "/api/bridge/space/snapshot") {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          // Not owned by us, not owned by anyone knowable — loot-containers
          // does not care, unlike loot-wrecks.
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(CONTAINER_ID, [
          packedRow({ itemID: 90001, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 100, singleton: 0 }),
        ]),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [90001], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const opened = requests.find((r) => r.path === `/api/bridge/inventory/container/${CONTAINER_ID}`);
  assert.ok(opened, "it read the container's contents");
  assert.equal(opened.method, "GET");

  const transfer = requests.find((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfer, "it moved the loot into cargo");
  assert.deepEqual(transfer.body, {
    itemIDs: [90001],
    from: { kind: "container", itemID: CONTAINER_ID },
    to: { kind: "cargo" },
  });
});

test("a custom bot's loot-containers step splits ore-category loot into the ore hold, everything else into cargo", async () => {
  const CONTAINER_ID = 80002;
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

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if (path === "/api/bridge/space/snapshot") {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    // The hull HAS an ore hold. That is now a precondition for addressing it:
    // the router only names a bay the ship was observed to have.
    if (path === `/api/bridge/ship/${SHIP_ID}/bays`) return { status: 200, body: baysBody(SHIP_ID, ["cargo", "ore"]) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(CONTAINER_ID, [
          // Veldspar — category 25 (Asteroid), group 462 — belongs in the ore
          // hold. (This row used to claim group 18, which is Tritanium's; the
          // old router read categoryID only, so the wrong number never showed.)
          packedRow({ itemID: 90010, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 500, singleton: 0 }),
          // Tritanium — a refined mineral. This hull has no mineral hold, so it
          // still goes to cargo, same as before.
          packedRow({ itemID: 90011, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 100, singleton: 0 }),
        ]),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const transfers = requests.filter((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(
    transfers.some((r) => JSON.stringify(r.body) === JSON.stringify({
      itemIDs: [90010],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "shipBay", bay: "ore" },
    })),
    "the ore stack went to the ore hold, not cargo",
  );
  assert.ok(
    transfers.some((r) => JSON.stringify(r.body) === JSON.stringify({
      itemIDs: [90011],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    })),
    "the non-ore stack still went to cargo",
  );
});

// ── The twelve-hour bug, pinned ─────────────────────────────────────────────
//
// A live bot answered 227 consecutive NotEnoughCargoSpace refusals on
// /api/bridge/inventory/transfer over twelve hours. Two defects produced it and
// both are pinned below, because neither was covered before: the ore hold was
// addressed on hulls that do not have one, and a refusal on the ore half
// cancelled the cargo half that would have succeeded.

test("a hull with NO ore hold gets its ore in cargo — the bay is never addressed blind", async () => {
  const CONTAINER_ID = 80003;
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

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if (path === "/api/bridge/space/snapshot") {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    // A combat hull: cargo only. `resolvePlace` would happily resolve
    // {shipBay:"ore"} here anyway — it reads a static table and never checks the
    // hull — and the server would answer NotEnoughCargoSpace against a
    // 0-capacity flag, forever.
    if (path === `/api/bridge/ship/${SHIP_ID}/bays`) return { status: 200, body: baysBody(SHIP_ID, ["cargo"]) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(CONTAINER_ID, [
          packedRow({ itemID: 90020, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 500, singleton: 0 }),
        ]),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [90020], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const transfers = requests.filter((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfers.length > 0, "it tried to move the loot");
  assert.equal(
    transfers.some((r) => JSON.stringify(r.body.to) === JSON.stringify({ kind: "shipBay", bay: "ore" })),
    false,
    "no transfer addressed an ore hold this hull does not have",
  );
  assert.ok(
    transfers.some((r) => JSON.stringify(r.body) === JSON.stringify({
      itemIDs: [90020],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    })),
    "the ore went to cargo instead",
  );
});

test("a REFUSED ore-hold transfer still lands the rest of the loot, and spills the ore into cargo", async () => {
  const CONTAINER_ID = 80004;
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

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if (path === "/api/bridge/space/snapshot") {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    if (path === `/api/bridge/ship/${SHIP_ID}/bays`) return { status: 200, body: baysBody(SHIP_ID, ["cargo", "ore"]) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(CONTAINER_ID, [
          packedRow({ itemID: 90030, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 500, singleton: 0 }),
          packedRow({ itemID: 90031, typeID: 578, groupID: 60, categoryID: 7, flagID: null, quantity: 1, singleton: 1 }),
        ]),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      // The ore hold is FULL. Everything aimed at it is refused; cargo accepts.
      const to = body.to as { kind?: string; bay?: string } | undefined;
      if (to && to.kind === "shipBay") {
        return {
          status: 409,
          body: { ok: false, error: "NotEnoughCargoSpace", message: "There isn't enough room in that hold." },
        };
      }
      return { status: 200, body: { ok: true, applied: true, moved: [], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const transfers = requests.filter((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(
    transfers.some((r) => JSON.stringify(r.body.to) === JSON.stringify({ kind: "shipBay", bay: "ore" })),
    "it did try the ore hold first",
  );
  // THE REGRESSION. Before the fix the refusal above rejected the whole
  // function and this module transfer was never issued at all.
  assert.ok(
    transfers.some((r) => JSON.stringify(r.body) === JSON.stringify({
      itemIDs: [90031],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    })),
    "the non-ore loot still went to cargo despite the ore hold refusing",
  );
  assert.ok(
    transfers.some((r) => JSON.stringify(r.body) === JSON.stringify({
      itemIDs: [90030],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    })),
    "the refused ore spilled into cargo rather than being abandoned",
  );
});

test("a can holding MORE than the hold can take is drained, not refused", async () => {
  // THE SCENARIO THIS EXISTS FOR. 10,000 units of ore at 1 m³ each sitting in a
  // can, and an ore hold with 1,000 m³ free. A transfer is all-or-nothing per
  // stack, so asking for the stack whole is refused outright and NOTHING moves
  // — every tick, for ever. Taking what fits and coming back is the answer.
  const CONTAINER_ID = 80005;
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

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if (path === "/api/bridge/space/snapshot") {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    // Ore hold: 16,000 capacity, 15,000 used -> 1,000 m³ free.
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(15_000, []) };
    if (path === `/api/bridge/ship/${SHIP_ID}/bays`) return { status: 200, body: baysBody(SHIP_ID, ["cargo", "ore"]) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(
          CONTAINER_ID,
          [packedRow({ itemID: 90040, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 10_000, singleton: 0 })],
          { "1230": 1 },
        ),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [90040], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const transfers = requests.filter((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfers.length > 0, "it moved something rather than being refused");
  const split = transfers.find((r) => typeof r.body.qty === "number");
  assert.ok(split, "the oversized stack was SPLIT rather than offered whole");
  assert.deepEqual(split.body.itemIDs, [90040]);
  assert.equal(split.body.qty, 1_000, "exactly what the 1,000 m³ of free space holds");
  assert.deepEqual(split.body.to, { kind: "shipBay", bay: "ore" });
});

test("a hold with no room at all provokes no transfer whatsoever", async () => {
  // Nothing fits, so nothing is asked for — the refusal never happens.
  const CONTAINER_ID = 80006;
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

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if (path === "/api/bridge/space/snapshot") {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(16_000, []) };
    if (path === `/api/bridge/ship/${SHIP_ID}/bays`) return { status: 200, body: baysBody(SHIP_ID, ["cargo", "ore"]) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(
          CONTAINER_ID,
          [packedRow({ itemID: 90050, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 10_000, singleton: 0 })],
          { "1230": 1 },
        ),
      };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  assert.equal(
    requests.some((r) => r.path === "/api/bridge/inventory/transfer"),
    false,
    "a full ship asks for nothing, so there is no refusal to loop on",
  );
});

test("a custom bot's loot-wrecks step dispatches openContainer + transferItems for an owned wreck (closes the pre-existing dispatch-test gap)", async () => {
  const WRECK_ID = 70001;
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

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if (path === "/api/bridge/space/snapshot") {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: WRECK_ID,
          kind: "wreck",
          name: "Wreck",
          ownerID: CHARACTER_ID, // must be OURS — loot-wrecks refuses anything else
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(WRECK_ID, [
          packedRow({ itemID: 90002, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 50, singleton: 0 }),
        ]),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [90002], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-wrecks", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const opened = requests.find((r) => r.path === `/api/bridge/inventory/container/${WRECK_ID}`);
  assert.ok(opened, "it read the wreck's contents");
  assert.equal(opened.method, "GET");

  const transfer = requests.find((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfer, "it moved the loot into cargo");
  assert.deepEqual(transfer.body, {
    itemIDs: [90002],
    from: { kind: "container", itemID: WRECK_ID },
    to: { kind: "cargo" },
  });
});
