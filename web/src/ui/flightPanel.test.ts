// The Flight panel after the raw-ID fields went — and the three lines the
// cockpit's flight strip used to carry.
//
// ⚠ WHAT THIS FILE IS REALLY GUARDING. `Flight.svelte` had NO component-level
// test at all, which is how it kept three number fields asking a player to type
// a "stargate / celestial ID", a "source stargate ID" and a "destination
// station ID" — ids the client is forbidden to show them (R7d). The controls
// were unusable by anyone not reading the server's own database, and nothing
// went red about it for as long as they existed.
//
// So the claims here are the ones that would let that back in:
//
//   1. No number field asks for an id, ever again.
//   2. Everything pickable is named, and picked off the grid the ship is on.
//   3. Jump takes ONE gate. The link carries its own far side; asking for two
//      let a player pair unrelated gates into a command the server can only
//      refuse.
//   4. The narration is never synthesized — hand-flying says nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const Flight = (await import("./Flight.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "Flight.svelte"), "utf8");

const SHIP_ID = 9001;
const SHIP_TYPE_ID = 622;
const SYSTEM_ID = 30000142;
const GATE_ID = 50000001;
const FAR_GATE_ID = 50000002;
const LONE_GATE_ID = 50000003;
const STATION_ID = 60000358;
const ROCK_ID = 7100001;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function entity(over: Record<string, unknown>): unknown {
  return {
    kind: "celestial",
    itemID: 1,
    typeID: 1,
    groupID: null,
    categoryID: null,
    name: null,
    ownerID: null,
    radius: 10,
    position: { x: 1000, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isSelf: false,
    shieldRatio: null,
    armorRatio: null,
    hullRatio: null,
    characterID: null,
    corporationID: null,
    allianceID: null,
    securityStatus: null,
    maxVelocity: null,
    mode: null,
    capacitorRatio: null,
    remainingQuantity: null,
    miningYieldTypeID: null,
    beltID: null,
    oreGrade: null,
    isNpc: false,
    npcEntityType: null,
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
    ...over,
  };
}

interface SceneOptions {
  readonly inSpace?: boolean;
  readonly gateLinks?: readonly unknown[];
  readonly bot?: Record<string, unknown>;
  readonly travel?: Record<string, unknown>;
}

function scene(options: SceneOptions = {}) {
  const inSpace = options.inSpace !== false;
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace,
      docked: !inSpace,
      solarSystemID: SYSTEM_ID,
      stationID: inSpace ? null : STATION_ID,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: inSpace ? "STOP" : null,
      shipSpeedFraction: inSpace ? 0 : null,
    },
  } as never);
  store.apply({
    type: "flight/location",
    forSolarSystemID: SYSTEM_ID,
    forStationID: inSpace ? null : STATION_ID,
    forStructureID: null,
    solarSystemName: "Jita",
    stationName: inSpace ? null : "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    structureName: null,
  } as never);
  if (inSpace) {
    store.apply({
      type: "space/snapshot",
      // ⚠ The links ride WITH the snapshot — there is no separate event. They
      // are carried forward between snapshots because the graph loads once,
      // asynchronously, and the first snapshots arrive before it is ready.
      gateLinks: options.gateLinks ?? [
        { gateID: GATE_ID, toSystemID: 30000144, toSystemName: "Perimeter", destinationGateID: FAR_GATE_ID },
        // ⚠ A gate the star map has no far side for. It is still LISTED.
        { gateID: LONE_GATE_ID, toSystemID: 30000145, toSystemName: null, destinationGateID: 0 },
      ],
      snapshot: {
        inSpace: true,
        solarSystemID: SYSTEM_ID,
        shipID: SHIP_ID,
        sampledAtMs: 1,
        entities: [
          entity({ itemID: GATE_ID, name: "Jita Stargate (Perimeter)", position: { x: 5000, y: 0, z: 0 } }),
          entity({ itemID: LONE_GATE_ID, name: "Jita Stargate (Nowhere)", position: { x: 9000, y: 0, z: 0 } }),
          entity({ kind: "station", itemID: STATION_ID, name: "Caldari Navy Assembly Plant", position: { x: 20000, y: 0, z: 0 } }),
          entity({ kind: "asteroid", itemID: ROCK_ID, name: null, typeID: 1230, position: { x: 3000, y: 0, z: 0 } }),
        ],
        ship: {
          itemID: SHIP_ID,
          typeID: SHIP_TYPE_ID,
          name: null,
          mode: "STOP",
          shieldRatio: 1,
          armorRatio: 1,
          hullRatio: 1,
          capacitorRatio: 1,
          shieldCapacity: 400,
          armorCapacity: 300,
          hullCapacity: 600,
          radius: 100,
          maxVelocity: 300,
          activeModuleIDs: [],
          overloadedModuleIDs: [],
          moduleDamage: {},
          weaponBanks: {},
          position: { x: 0, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        },
      },
    } as never);
  }
  store.apply({ type: "names/resolved", entries: { [`type:${SHIP_TYPE_ID}`]: "Venture" } } as never);
  if (options.bot) {
    store.apply({ type: "bot/progress", ...options.bot } as never);
  }
  if (options.travel) {
    store.apply({ type: "travel/progress", ...options.travel } as never);
  }
  return store;
}

function renderFlight(options: SceneOptions = {}): string {
  return render(Flight as never, { props: { store: scene(options), flow: fakeFlow() } } as never)
    .body;
}

// --- the raw ids are gone ----------------------------------------------------

test("⚠ NO NUMBER FIELD ASKS A PLAYER FOR AN ID, ANYWHERE ON THIS PANEL", () => {
  // The regression this whole file exists for. `type="number"` was the shape of
  // all three fields; a player could only fill them from the server's database.
  const body = renderFlight();
  assert.equal(
    /<input[^>]*type="number"/.test(body),
    false,
    "a number field came back — pick things by name off the grid instead",
  );
  for (const placeholder of [
    "stargate / celestial ID",
    "source stargate ID",
    "destination station ID",
    "Station ID",
    "Target ID",
  ]) {
    assert.equal(
      body.includes(placeholder),
      false,
      `"${placeholder}" is an id prompt and must not exist`,
    );
  }
});

test("R7d: no bare numeric ID is visible text anywhere on the panel", () => {
  const text = visibleText(renderFlight());
  for (const id of [SHIP_ID, SHIP_TYPE_ID, SYSTEM_ID, GATE_ID, FAR_GATE_ID, STATION_ID, ROCK_ID]) {
    assert.equal(new RegExp(`\\b${id}\\b`).test(text), false, `${id} is on screen`);
  }
});

test("parseID is gone — there is nothing left to parse", () => {
  assert.equal(
    /function parseID/.test(SOURCE),
    false,
    "the id parser survived, which means something still takes typed ids",
  );
});

// --- picking off the grid ----------------------------------------------------

test("warp offers everything on the grid, by name and with its range", () => {
  const body = renderFlight();
  assert.match(body, /aria-label="Warp to"/, "there is no warp picker");
  const text = visibleText(body);
  assert.match(text, /Jita Stargate \(Perimeter\)/);
  assert.match(text, /Caldari Navy Assembly Plant/);
  // The range is the hint, so two things with the same name are still telling.
  assert.match(text, /km/);
});

test("dock offers only what you could dock at — decided by the row's KIND", () => {
  const body = renderFlight();
  const select = body.slice(body.indexOf('aria-label="Station"'));
  const options = select.slice(0, select.indexOf("</select>"));
  assert.match(options, /Caldari Navy Assembly Plant/);
  assert.equal(
    /Stargate/.test(options),
    false,
    "a stargate is not something you dock at",
  );
});

test("⚠ JUMP TAKES ONE GATE — the link carries its own far side", () => {
  // Two independent fields let a player pair unrelated gates into a command the
  // server can only refuse. There is exactly one picker now.
  const body = renderFlight();
  assert.match(body, /aria-label="Gate"/);
  assert.equal(/From gate/.test(body), false, "the two-field jump came back");
  assert.equal(/To gate/.test(body), false, "the two-field jump came back");
  // And the option names where it goes.
  assert.match(visibleText(body), /to Perimeter/);
});

test("⚠ a gate with no far side in the star map is LISTED, wearing its reason", () => {
  // R30's rule: a control that cannot work is drawn with the reason on it, never
  // hidden and never silently greyed.
  const text = visibleText(renderFlight());
  assert.match(text, /Jita Stargate \(Nowhere\)/, "the gate was hidden instead of explained");
  assert.match(text, /No gate on the far side in the star map/);
});

test("an empty grid is a sentence, not an empty box", () => {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: true,
      docked: false,
      solarSystemID: SYSTEM_ID,
      stationID: null,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: "STOP",
      shipSpeedFraction: 0,
    },
  } as never);
  const text = visibleText(
    render(Flight as never, { props: { store, flow: fakeFlow() } } as never).body,
  );
  assert.match(text, /Nothing on the grid to warp to yet/);
  assert.match(text, /Nothing on this grid you could dock at/);
});

// --- one place, two verbs ----------------------------------------------------

test("the picked station drives BOTH dock verbs — one choice, two buttons", () => {
  // "Dock" is the raw single command and only works alongside; "Take me there
  // and dock" closes the distance first. They are different acts on the same
  // place, so they must not need picking twice.
  assert.match(SOURCE, /flow\.dockAt\(dockStationID\)/);
  assert.match(SOURCE, /flow\.dock\(dockStationID\)/);
  const text = visibleText(renderFlight());
  assert.match(text, /Take me there and dock/);
});

// --- the narration -----------------------------------------------------------

test("the panel says WHERE you are, by name", () => {
  assert.match(visibleText(renderFlight()), /In space · Jita/);
  assert.match(visibleText(renderFlight({ inSpace: false })), /Docked at Jita IV/);
});

test("⚠ HAND-FLYING PRODUCES NO NARRATION — nothing is synthesized", () => {
  // An invented "Approaching…" is indistinguishable, to a player, from a
  // sentence the autopilot really wrote.
  const body = renderFlight();
  assert.equal(/class="strip-doing"/.test(body), false, "a doing line appeared with nothing flying");
});

test("a running bot's OWN words are passed through", () => {
  const body = renderFlight({
    bot: { status: "running", phase: "Mining", action: "Locking a rock", why: null },
  });
  assert.match(body, /class="strip-doing"/, "the bot's narration is missing");
  assert.match(visibleText(body), /Mining · Locking a rock/);
});
