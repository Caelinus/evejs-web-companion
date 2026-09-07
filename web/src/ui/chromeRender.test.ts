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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const HudBar = (await import("./HudBar.svelte")).default;
const WorkspaceHeader = (await import("./WorkspaceHeader.svelte")).default;
const Neocom = (await import("./Neocom.svelte")).default;
const PanelHost = (await import("./PanelHost.svelte")).default;
const TargetBracket = (await import("./TargetBracket.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const HUD_SOURCE = readFileSync(path.join(UI_DIR, "HudBar.svelte"), "utf8");

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

/** The in-space snapshot, hoisted so a test can clone and vary one field. */
const SHIP_SNAPSHOT = {
  inSpace: true,
  solarSystemID: SYSTEM_ID,
  shipID: SHIP_ID,
  sampledAtMs: 1_700_000_000_000,
  entities: [],
  ship: {
    itemID: SHIP_ID,
    typeID: SHIP_TYPE_ID,
    name: null as string | null,
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
    activeModuleIDs: [] as number[],
    overloadedModuleIDs: [] as number[],
    moduleDamage: {},
    weaponBanks: {},
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  },
};

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
  store.apply({ type: "space/snapshot", snapshot: SHIP_SNAPSHOT });
  return store;
}

function renderHud(store: unknown): string {
  return render(HudBar as never, {
    props: { store, flow: fakeFlow() },
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

test("the HUD offers the module rack", () => {
  const body = renderHud(inSpaceStore());
  // ⚠ THE HEADING, not the word. `/Modules/` against the visible text also
  // matches the rack's own empty hint ("Modules appear once your ship's fitting
  // has loaded"), so it went on passing with the heading renamed to nonsense.
  assert.match(body, /id="hud-modules-h"[^>]*>Modules</, "no module rack heading");
});

test("the HUD no longer duplicates the rail's own launchers", () => {
  // ⚠ THIS ANCHOR MOVED DELIBERATELY. It used to assert /Mining/ — a nav button
  // for the Mining window. Every one of those buttons was also a Neocom rail
  // entry, on screen at the same time; two ways to open one window, one of them
  // costing a row of a fixed-height HUD, is not a feature. `neocomRail.test.ts`
  // and the neocom test below are what now hold the promise that the panels are
  // reachable, so nothing here is unprotected.
  const text = visibleText(renderHud(inSpaceStore()));
  for (const gone of ["Mining", "Flight"]) {
    assert.equal(new RegExp(gone).test(text), false, `${gone} is a rail entry, not a HUD button`);
  }
});

test("the HUD header names the ship once, not the same word twice", () => {
  // ⚠ FOUND LIVE. A ship nobody renamed carries its hull's own name, so a header
  // that prints name AND hull unconditionally says "Sunchaser Sunchaser" — one fact
  // rendered as two, which reads as a bug rather than as detail.
  const store = inSpaceStore() as { apply: (event: unknown) => void; space: { get: () => never } };
  store.apply({
    type: "names/resolved",
    entries: { [`type:${SHIP_TYPE_ID}`]: "Sunchaser" },
  });
  // The ship carries the hull's own name — the live case this was found in.
  const snapshot = JSON.parse(JSON.stringify(SHIP_SNAPSHOT));
  snapshot.ship.name = "Sunchaser";
  store.apply({ type: "space/snapshot", snapshot });
  const head = renderHud(store);
  const from = head.indexOf("hud-head");
  const header = visibleText(head.slice(from, head.indexOf("</header>", from)));
  assert.match(header, /Sunchaser/, "the hull is not named at all");
  assert.equal(
    (header.match(/Sunchaser/g) ?? []).length,
    1,
    "the hull was printed twice — the ship carries its hull's name",
  );
});

// --- Stop, and the rule that travels with it ---------------------------------
//
// These three moved here from `flightStrip.test.ts` when Stop moved from the
// overview window's flight strip to the HUD footer. The rule did not soften in
// the move: it is the control a pilot reaches for when things are going wrong,
// which is exactly the moment other requests are in flight.

test("in space, the HUD carries Stop", () => {
  assert.match(visibleText(renderHud(inSpaceStore())), /Stop the ship/);
});

test("STOP IS NEVER DISABLED — not by a shared flag, not by its own", () => {
  const body = renderHud(inSpaceStore());
  const index = body.indexOf("Stop the ship");
  assert.ok(index > 0, "the Stop control is rendered");
  const openTag = body.lastIndexOf("<button", index);
  const buttonTag = body.slice(openTag, index);
  assert.equal(
    /disabled/.test(buttonTag),
    false,
    "Stop must never render a disabled attribute — see the comment in HudBar.svelte",
  );
});

test("Stop is not silently swallowed by a busy guard either", () => {
  // The other half of the same rule: an enabled button that drops the click
  // because something else is in flight is the same failure wearing a
  // friendlier face. So the handler must not be gated on anything at all.
  const handler = HUD_SOURCE.slice(
    HUD_SOURCE.indexOf("async function stopShip("),
    HUD_SOURCE.indexOf("</script>"),
  );
  assert.ok(handler.length > 0, "the Stop handler is not where this test looks");
  assert.equal(
    /if\s*\(/.test(handler),
    false,
    "Stop's handler grew a guard — any early return is the disabled button again",
  );
  assert.match(handler, /await flow\.stopShip\(\)/, "Stop must actually call stopShip");
  assert.match(HUD_SOURCE, /MUST NEVER GET ONE/, "the rule is not written down for the next reader");
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
  // ⚠ "Around Your Ship" IS GONE, and this assertion is its headstone.
  //
  // It was fixed chrome, then briefly a window while the cockpit was taken
  // apart section by section, and now the file behind it does not exist. The
  // overview is `SpaceOverview` in the dock panel — always on screen, never
  // something to launch — and every section that used to sit under that tab has
  // its own home: Drones, Shots Fired and Equipment are rail entries of their
  // own, the gauges and racks are the HUD, and the flight narration is on
  // Flight.
  assert.doesNotMatch(space, /Around Your Ship/, "the deleted cockpit tab came back");
  for (const moved of ["Drones", "Shots Fired", "Equipment"]) {
    assert.match(space, new RegExp(moved), `${moved} must be reachable in space`);
    assert.doesNotMatch(docked, new RegExp(moved), `${moved} leaked into the docked rail`);
  }
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
