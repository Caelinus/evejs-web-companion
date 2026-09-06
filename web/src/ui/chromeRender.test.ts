// The always-on chrome as it actually RENDERS (SSR).
//
// ⚠ THIS FILE WAS `shellRender.test.ts`, AND IT WAS TESTING DEAD CODE. It
// rendered `StationShell` and `SpaceShell`, two top-level layouts that the
// windowing workspace superseded and that nothing in the app imported — so a
// green run here proved something about components no player could reach, while
// the live chrome that replaced them (the HUD bar, the workspace header) had no
// render coverage at all.
//
// The shells are gone. The claims that still MATTER were re-pointed at the
// components that actually render them:
//
//   • "in space you can read your ship's condition, reach your modules, and get
//     to the flight panels"     → `HudBar`
//   • "the UI says where you are, in either state"  → `WorkspaceHeader`
//   • the Neocom, PanelHost and target-bracket tests were already about live
//     components and are unchanged.
//
// The one claim deliberately NOT replaced is the docked "station interior":
// there is no such surface any more. Docked, the dock panel and the Neocom are
// the station, and both are covered by `neocomRail.test.ts` and
// `panelFirstMount.test.ts`.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const HudBar = (await import("./HudBar.svelte")).default;
const WorkspaceHeader = (await import("./WorkspaceHeader.svelte")).default;
const Neocom = (await import("./Neocom.svelte")).default;
const PanelHost = (await import("./PanelHost.svelte")).default;
const TargetBracket = (await import("./TargetBracket.svelte")).default;

/** A flow stub — the server generator never runs onMount / handlers. */
function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

const SHIP_ID = 9001;
const SHIP_TYPE_ID = 622;
const STATION_ID = 60000358;
const SYSTEM_ID = 30000142;

/** Everything visible to a player, markup + images stripped. */
function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dockedStore(): unknown {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: false,
      docked: true,
      solarSystemID: SYSTEM_ID,
      stationID: STATION_ID,
      structureID: null,
      shipID: SHIP_ID,
      shipMode: null,
      shipSpeedFraction: null,
    },
  });
  store.apply({
    type: "flight/location",
    forSolarSystemID: SYSTEM_ID,
    forStationID: STATION_ID,
    forStructureID: null,
    solarSystemName: "Jita",
    stationName: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    structureName: null,
  });
  return store;
}

function inSpaceStore(): unknown {
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
  });
  store.apply({
    type: "flight/location",
    forSolarSystemID: SYSTEM_ID,
    forStationID: null,
    forStructureID: null,
    solarSystemName: "Jita",
    stationName: null,
    structureName: null,
  });
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: SYSTEM_ID,
      shipID: SHIP_ID,
      sampledAtMs: 1_700_000_000_000,
      entities: [],
      ship: {
        itemID: SHIP_ID,
        typeID: SHIP_TYPE_ID,
        name: null,
        mode: "STOP",
        shieldRatio: 1,
        armorRatio: 0.5,
        hullRatio: 1,
        capacitorRatio: 0.75,
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
  });
  return store;
}

function renderHud(store: unknown): string {
  return render(HudBar as never, {
    props: { store, flow: fakeFlow(), onOpen: () => {} },
  } as never).body;
}

function renderHeader(store: unknown, isDocked: boolean): string {
  return render(WorkspaceHeader as never, {
    props: { store, flow: fakeFlow(), isDocked },
  } as never).body;
}

// --- where you are -----------------------------------------------------------

test("the header says where you are while docked", () => {
  const text = visibleText(renderHeader(dockedStore(), true));
  assert.match(text, /Jita/, "the system is not named");
  assert.match(text, /Undock/, "no undock control");
});

test("the header says where you are while in space", () => {
  const text = visibleText(renderHeader(inSpaceStore(), false));
  assert.match(text, /Jita/, "the system is not named");
});

// --- the in-space HUD --------------------------------------------------------

test("in space the HUD reads the ship's condition off the live snapshot", () => {
  const body = renderHud(inSpaceStore());
  const text = visibleText(body);
  // ⚠ ANCHORED TO THE READOUT ELEMENT, not just to the words. "Armor" and
  // "Shield" appear in more than one place in this markup, so a bare text match
  // passes even when the readout itself is gone — which is exactly what a
  // mutation run showed.
  assert.match(body, /class="hud-readout"/, "the numeric readout is missing entirely");
  assert.match(text, /Shield/, "no shield reading");
  assert.match(text, /Armor/, "no armor reading");
  assert.match(text, /Cap/, "no capacitor reading");
  // The armor ratio was 0.5 — shown as a percentage, never a raw ratio or id.
  assert.match(text, /50%/, "the armor reading does not report its ratio");
});

test("the HUD offers the module rack and the flight panels", () => {
  const body = renderHud(inSpaceStore());
  // ⚠ THE HEADING, not the word. `/Modules/` against the visible text also
  // matches the rack's own empty hint ("Modules appear once your ship's fitting
  // has loaded"), so it went on passing with the heading renamed to nonsense.
  assert.match(body, /id="hud-modules-h"[^>]*>Modules</, "no module rack heading");
  assert.match(visibleText(body), /Mining/, "no mining nav control");
});

test("the module rack draws its three racks, and invents no module", () => {
  const text = visibleText(renderHud(inSpaceStore()));
  // The three EVE activation racks are always drawn...
  assert.match(text, /High/, "no high rack row");
  assert.match(text, /Mid/, "no mid rack row");
  assert.match(text, /Low/, "no low rack row");
  // ...and with no fit loaded (this store never loaded fitting) the neutral hint
  // shows instead of a fabricated module.
  assert.match(text, /fitting has loaded/, "no empty-rack hint");
  assert.doesNotMatch(text, /placeholder/i, "the rack claims to be a placeholder");
});

test("R7d: no bare numeric ID reaches the HUD or the header", () => {
  for (const [what, text] of [
    ["the HUD", visibleText(renderHud(inSpaceStore()))],
    ["the in-space header", visibleText(renderHeader(inSpaceStore(), false))],
    ["the docked header", visibleText(renderHeader(dockedStore(), true))],
  ] as const) {
    for (const id of [SHIP_ID, SHIP_TYPE_ID, STATION_ID, SYSTEM_ID]) {
      assert.equal(
        new RegExp(`\\b${id}\\b`).test(text),
        false,
        `${id} is visible on ${what}`,
      );
    }
  }
});

// --- the launcher rail and the panel host ------------------------------------

function renderNeocom(isDocked: boolean): string {
  return render(Neocom as never, {
    props: {
      store: createClientStore() as never,
      flow: null,
      isDocked,
      openIds: new Set(),
      focusedId: null,
      onSelect: () => {},
    },
  } as never).body;
}

test("the neocom launches every openable panel for the current state", () => {
  const docked = visibleText(renderNeocom(true));
  const space = visibleText(renderNeocom(false));
  // The static set — reachable docked or in space — is in both.
  for (const label of ["Market", "Wallet", "Mail", "Skills", "Standings", "Planets"]) {
    assert.match(docked, new RegExp(label), `${label} missing from the docked neocom`);
    assert.match(space, new RegExp(label), `${label} missing from the in-space neocom`);
  }
  // No state badge in the rail: the workspace header carries docked/in-space —
  // the rail proves its state through WHICH tabs it offers.
  assert.doesNotMatch(docked, /Docked/);
  assert.doesNotMatch(space, /In Space/);
  // State-specific tabs appear only in their own state.
  assert.match(space, /Flight/, "the in-space Flight tab is missing");
  assert.doesNotMatch(docked, /Flight/, "an in-space-only tab leaked into the docked rail");
  assert.match(docked, /Fitting/, "the docked Fitting tab is missing");
  assert.doesNotMatch(space, /Fitting/, "a docked-only tab leaked into the in-space rail");
  // ⚠ "Around Your Ship" IS a rail entry again, and only for a while.
  //
  // It used to be fixed chrome — it WAS the in-space dock panel, so a rail entry
  // would have opened a second copy of what was already on screen. The dock
  // panel is `SpaceOverview` now, and `Overview.svelte` still holds the sections
  // that have not moved yet: the flight strip with Stop, the drone controls, the
  // equipment list. A pilot in space needs a way to reach those while they are
  // between homes, so it is a window until Phase 4 empties and deletes it — and
  // this assertion goes with it.
  assert.match(space, /Around Your Ship/, "the transitional overview window is unreachable");
  assert.doesNotMatch(docked, /Around Your Ship/, "an in-space-only tab leaked into the docked rail");
});

test("the panel host renders the real panel for a selected tab", () => {
  const wallet = render(PanelHost as never, {
    props: { store: createClientStore(), flow: fakeFlow(), tab: "wallet" },
  } as never).body;
  const market = render(PanelHost as never, {
    props: { store: createClientStore(), flow: fakeFlow(), tab: "market" },
  } as never).body;
  const fitting = render(PanelHost as never, {
    props: { store: createClientStore(), flow: fakeFlow(), tab: "fitting" },
  } as never).body;
  assert.match(visibleText(wallet), /Wallet/);
  assert.match(visibleText(market), /Market/);
  assert.match(visibleText(fitting), /Fitting/);
});

// --- locked targets ----------------------------------------------------------

test("the target bracket names a locked target and shows its condition", () => {
  const store = createClientStore();
  const target = {
    kind: "ship",
    itemID: 7777,
    typeID: 587,
    groupID: null,
    categoryID: null,
    name: "Guristas Wight",
    ownerID: null,
    radius: 30,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    isSelf: false,
    shieldRatio: 0.25,
    armorRatio: 1,
    hullRatio: 1,
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
    isNpc: true,
    npcEntityType: "npc",
    controllerID: null,
    droneActivity: null,
    targetEntityID: null,
  };
  store.apply({
    type: "space/snapshot",
    snapshot: {
      inSpace: true,
      solarSystemID: SYSTEM_ID,
      shipID: SHIP_ID,
      sampledAtMs: 1,
      entities: [target],
      ship: null,
    },
  } as never);
  store.apply({ type: "targeting/targets", targetIDs: [7777] } as never);
  const text = visibleText(render(TargetBracket as never, { props: { store } } as never).body);
  assert.match(text, /Guristas Wight/, "the locked target is not named");
  assert.match(text, /25%/, "its shield reading is missing");
  assert.equal(/\b7777\b/.test(text), false, "the target's itemID must never show");
});
