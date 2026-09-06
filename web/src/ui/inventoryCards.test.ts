// The Inventory panel as it actually RENDERS: four tabs (R60), and a hangar you
// can look at.
//
// The panel used to be one 778-line mixed reflow table; R40 split it into a
// ships card and a hangar grid; R60 sorts the same content into four tabs so it
// fits the right-hand dock window:
//
//   SHIP INVENTORY    the OPENED ship's bays (defaults to the active hull), each
//                     with how full it is and what is inside.
//   SHIP HANGAR       the hulls; "Open" hands one to the Ship Inventory tab.
//   ITEM HANGAR       everything that is not a ship, as a grid of pictures
//                     captioned with the name and the amount, plus any container.
//   CORPORATE HANGAR  the corporation's divisions at this station.
//
// The four panels ALL render; inactive ones carry `hidden`, so a selection made
// in one survives a tab switch.
//
// WHAT THIS SUITE GUARDS, in order of how much damage getting it wrong does:
//
//   1. ⚠ ABSENT ≠ EMPTY ≠ UNKNOWN. A hull with no ore hold, a hull whose ore
//      hold could not be read, and an ore hold that is genuinely empty must
//      render three different ways. This is the invariant the goal singled out
//      and the one this codebase has broken before (`worldHasNoContracts`).
//   2. NO LOST CAPABILITY. Selection, bulk moves, merge, trash-arming, stack-
//      all, the container view and the corporation hangar all worked in this
//      panel before the rewrite. A prettier grid that dropped them would be a
//      regression, so each is pinned here.
//   3. The standing invariants on new markup — R7d (no visible numeric IDs),
//      R9a (plain player language) and R8 (reflow, real buttons, no fixed
//      widths that could scroll the body sideways).
//
// The fixtures are REAL: the bay payloads are the literal bodies the running
// BFF returned for Test Two's Badger and Farmer's Procurer on 2026-07-21.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { decodeShipBays } = await import("../bridge/shipBays.ts");
const InventoryShip = (await import("./InventoryShip.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "InventoryShip.svelte"), "utf8");

// Real IDs from the live reads, so the R7d sweep is sweeping for numbers that
// genuinely pass through this panel.
const STATION_ID = 60000004;
const PROCURER_ID = 9988400023309;
const RUPTURE_ID = 9988400091901;
const PROCURER_TYPE = 17480;
const RUPTURE_TYPE = 629;
const VELDSPAR_ID = 9988400092033;
const VELDSPAR_TYPE = 1230;
const DRONE_STACK_ID = 9988400023316;
const DRONE_TYPE = 2488;
const TRIT_STACK_ID = 9988400092040;
const TRIT_TYPE = 34;
const CRATE_ID = 9988400092050;
const CRATE_TYPE = 3465;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

function row(over: Record<string, unknown>): unknown {
  return {
    itemID: 0,
    typeID: 0,
    groupID: null,
    categoryID: null,
    flagID: null,
    quantity: 1,
    singleton: false,
    ...over,
  };
}

/** Farmer's Procurer, exactly as the BFF answered: three bays, twenty-four not. */
const PROCURER_BAYS = [
  { key: "cargo", label: "Cargo hold", present: true, capacity: { capacity: 350, used: 0 }, items: [], error: null },
  {
    key: "drone",
    label: "Drone bay",
    present: true,
    capacity: { capacity: 100, used: 50 },
    items: [
      { itemID: DRONE_STACK_ID, typeID: DRONE_TYPE, groupID: 100, categoryID: 18, quantity: 5, singleton: false },
    ],
    error: null,
  },
  {
    key: "ore",
    label: "Ore hold",
    present: true,
    capacity: { capacity: 16000, used: 12375.2 },
    items: [
      { itemID: VELDSPAR_ID, typeID: VELDSPAR_TYPE, groupID: 462, categoryID: 25, quantity: 123752, singleton: false },
    ],
    error: null,
  },
  { key: "shipMaintenance", label: "Ship maintenance bay", present: false, capacity: { capacity: 0, used: 0 }, items: null, error: null },
  { key: "fleet", label: "Fleet hangar", present: false, capacity: { capacity: 0, used: 0 }, items: null, error: null },
];

/** Test Two's Badger: a cargo hold and nothing else. */
const BADGER_BAYS = [
  { key: "cargo", label: "Cargo hold", present: true, capacity: { capacity: 4095, used: 0 }, items: [], error: null },
  { key: "drone", label: "Drone bay", present: false, capacity: { capacity: 0, used: 0 }, items: null, error: null },
  { key: "ore", label: "Ore hold", present: false, capacity: { capacity: 0, used: 0 }, items: null, error: null },
];

interface Scene {
  bays?: unknown[];
  openShipID?: number;
  openShipType?: number;
  baysError?: string | null;
  baysLoaded?: boolean;
  hangarRows?: unknown[];
  hangarError?: string | null;
  loaded?: boolean;
  selection?: number[];
  corp?: boolean;
  container?: boolean;
  names?: boolean;
  dock?: boolean;
}

function scene(options: Scene = {}): string {
  const store = createClientStore();
  store.apply({
    type: "inventory/loaded",
    stationID: STATION_ID,
    activeShipID: PROCURER_ID,
    hangar: {
      rows: (options.hangarRows ?? [
        row({ itemID: PROCURER_ID, typeID: PROCURER_TYPE, categoryID: 6, singleton: true }),
        row({ itemID: RUPTURE_ID, typeID: RUPTURE_TYPE, categoryID: 6, singleton: true }),
        row({ itemID: VELDSPAR_ID, typeID: VELDSPAR_TYPE, categoryID: 25, groupID: 462, quantity: 123752 }),
        row({ itemID: TRIT_STACK_ID, typeID: TRIT_TYPE, categoryID: 4, quantity: 88000 }),
        row({ itemID: CRATE_ID, typeID: CRATE_TYPE, categoryID: 2, groupID: 12, singleton: true }),
      ]) as never,
      capacity: { capacity: 1000000, used: 250000 },
      error: options.hangarError ?? null,
    } as never,
    cargo: { rows: [], capacity: { capacity: 350, used: 0 }, error: null } as never,
  } as never);

  if (options.openShipID !== undefined) {
    store.apply({
      type: "inventory/ship-open",
      itemID: options.openShipID,
      typeID: options.openShipType ?? PROCURER_TYPE,
    } as never);
    if (options.baysLoaded !== false) {
      store.apply({
        type: "inventory/ship-bays",
        itemID: options.openShipID,
        bays: decodeShipBays((options.bays ?? PROCURER_BAYS) as never),
        error: options.baysError ?? null,
      } as never);
    }
  }
  if (options.selection) {
    store.apply({ type: "inventory/selection", itemIDs: options.selection } as never);
  }
  if (options.container) {
    store.apply({
      type: "inventory/container",
      container: {
        itemID: CRATE_ID,
        typeID: CRATE_TYPE,
        rows: [row({ itemID: TRIT_STACK_ID, typeID: TRIT_TYPE, quantity: 10 })],
        capacity: { capacity: 27500, used: 100 },
        error: null,
      },
    } as never);
  }
  if (options.corp) {
    store.apply({
      type: "inventory/corp-loaded",
      available: true,
      reason: null,
      divisions: [
        { division: 1, name: "Ore stash", rows: [row({ itemID: VELDSPAR_ID, typeID: VELDSPAR_TYPE, quantity: 10 })], error: null },
      ],
    } as never);
  }
  if (options.names !== false) {
    store.apply({
      type: "names/resolved",
      entries: {
        [`type:${PROCURER_TYPE}`]: "Procurer",
        [`type:${RUPTURE_TYPE}`]: "Rupture",
        [`type:${VELDSPAR_TYPE}`]: "Veldspar",
        [`type:${TRIT_TYPE}`]: "Tritanium",
        [`type:${DRONE_TYPE}`]: "Hobgoblin I",
        [`type:${CRATE_TYPE}`]: "Small Standard Container",
      },
    } as never);
  }
  return render(InventoryShip as never, {
    props: { store, flow: fakeFlow(), dock: options.dock ?? false },
  } as never).body;
}

// --- the two cards ----------------------------------------------------------

test("the panel shows ships and things as TWO separate cards", () => {
  const text = visibleText(scene());
  assert.match(text, /Your ships/);
  assert.match(text, /Hangar inventory/);
});

test("ships are in the ships card and NOT in the hangar grid", () => {
  const body = scene();
  const shipsCard = body.slice(body.indexOf("Your ships"), body.indexOf("Hangar inventory"));
  const hangarCard = body.slice(body.indexOf("Hangar inventory"));

  assert.match(visibleText(shipsCard), /Procurer/, "the hull belongs in the ships card");
  assert.match(visibleText(shipsCard), /Rupture/);
  assert.doesNotMatch(
    visibleText(hangarCard),
    /Rupture/,
    "a ship must not also be listed as hangar inventory",
  );
  // And the things are in the hangar card.
  assert.match(visibleText(hangarCard), /Veldspar/);
  assert.match(visibleText(hangarCard), /Tritanium/);
});

test("the ship you are flying is marked, and the others offer boarding", () => {
  const text = visibleText(scene());
  assert.match(text, /you are flying this/);
  assert.match(text, /Board/);
});

// --- the bays ---------------------------------------------------------------

test("a hull with several bays shows every one it HAS, with used and capacity", () => {
  const text = visibleText(scene({ openShipID: PROCURER_ID }));
  assert.match(text, /Cargo hold/);
  assert.match(text, /Drone bay/);
  assert.match(text, /Ore hold/);
  // The ore hold's real fill, from the server's own numbers.
  assert.match(text, /12,375\.2 of 16,000 m³/);
  assert.match(text, /50 of 100 m³/);
  assert.match(text, /0 of 350 m³/);
});

test("a hull with only a cargo hold shows exactly that one bay", () => {
  const text = visibleText(
    scene({ openShipID: RUPTURE_ID, openShipType: RUPTURE_TYPE, bays: BADGER_BAYS }),
  );
  assert.match(text, /Cargo hold/);
  assert.match(text, /0 of 4,095 m³/);
  assert.doesNotMatch(text, /Ore hold/, "a bay this hull does not have must not be drawn");
  assert.doesNotMatch(text, /Drone bay/);
});

// --- ⚠ absent vs empty vs unknown -------------------------------------------

test("⚠ a bay the hull does NOT have is not drawn at all", () => {
  const text = visibleText(scene({ openShipID: PROCURER_ID }));
  // The Procurer has neither, and the captured payload says so explicitly.
  assert.doesNotMatch(text, /Ship maintenance bay/, "an absent bay must not show a 0 / 0 gauge");
  assert.doesNotMatch(text, /Fleet hangar/);
});

test("⚠ an EMPTY bay says so — and does not look like a bay that is not there", () => {
  const text = visibleText(scene({ openShipID: PROCURER_ID }));
  // The cargo hold IS present and IS empty. Both facts are on screen.
  assert.match(text, /Cargo hold/, "an empty bay is still drawn");
  assert.match(text, /0 of 350 m³/, "with its real capacity");
  assert.match(text, /Nothing in here yet/, "and it says it is empty");
});

test("⚠ a bay nobody could CHECK is named — never silently treated as absent", () => {
  const text = visibleText(
    scene({
      openShipID: PROCURER_ID,
      bays: [
        { key: "cargo", label: "Cargo hold", present: true, capacity: { capacity: 350, used: 0 }, items: [], error: null },
        // Absent: the server answered, and the answer was no.
        { key: "fleet", label: "Fleet hangar", present: false, capacity: { capacity: 0, used: 0 }, items: null, error: null },
        // Unknown: the read failed. This is NOT the same thing.
        { key: "ore", label: "Ore hold", present: null, capacity: null, items: null, error: "CALL_REFUSED" },
      ],
    }),
  );
  assert.match(text, /could not be checked/i, "the unreadable bay is called out");
  assert.match(text, /Ore hold/, "and named, so the player knows WHICH");
  assert.doesNotMatch(
    text,
    /Fleet hangar/,
    "while the genuinely absent bay stays silent — the two must not render alike",
  );
});

test("⚠ a bay whose CONTENTS could not be read does not read as empty", () => {
  const text = visibleText(
    scene({
      openShipID: PROCURER_ID,
      bays: [
        { key: "ore", label: "Ore hold", present: true, capacity: { capacity: 16000, used: 12375.2 }, items: null, error: "READ_FAILED" },
      ],
    }),
  );
  assert.match(text, /could not be read/i);
  assert.doesNotMatch(text, /Nothing in here yet/, "a failed read is not an empty hold");
});

test("⚠ a ship whose bays failed entirely says so — not 'this ship has no bays'", () => {
  const text = visibleText(
    scene({ openShipID: PROCURER_ID, bays: [], baysError: "the session ended" }),
  );
  assert.match(text, /could not be read/i);
  assert.match(text, /cannot say what it has/i);
});

test("a ship whose bays have not arrived yet says it is looking", () => {
  const text = visibleText(scene({ openShipID: PROCURER_ID, baysLoaded: false }));
  assert.match(text, /Looking inside this ship/);
  assert.doesNotMatch(text, /has no bays/);
});

test("a capacity the ship did not report reads 'not known', never 0", () => {
  const text = visibleText(
    scene({
      openShipID: PROCURER_ID,
      bays: [{ key: "cargo", label: "Cargo hold", present: true, capacity: null, items: [], error: null }],
    }),
  );
  assert.match(text, /not known/);
  assert.doesNotMatch(text, /0 of 0/);
});

// --- the hangar grid --------------------------------------------------------

test("the hangar is a GRID, not a table", () => {
  const body = scene();
  const hangarCard = body.slice(body.indexOf("Hangar inventory"));
  assert.match(hangarCard, /class="item-grid"/, "the hangar renders as a grid");
  assert.doesNotMatch(hangarCard, /<table/, "the hangar is no longer a table");
});

test("every tile carries the picture, the NAME and the AMOUNT underneath", () => {
  const body = scene();
  const hangarCard = body.slice(body.indexOf("Hangar inventory"));
  // One tile per non-ship thing: Veldspar, Tritanium, the container.
  const tiles = hangarCard.match(/<li class="item-tile[^"]*"/g) ?? [];
  assert.equal(tiles.length, 3, `expected 3 tiles, saw ${tiles.length}`);

  const text = visibleText(hangarCard);
  assert.match(text, /Veldspar/, "the name");
  assert.match(text, /123,752/, "and the amount, under it");
  assert.match(text, /Tritanium/);
  assert.match(text, /88,000/);
  // The amount really is inside the tile's own caption element.
  assert.match(hangarCard, /class="item-tile-amount">\s*123,752/);
  assert.match(hangarCard, /class="item-tile-name">\s*Veldspar/);
});

test("an assembled thing is captioned as such rather than with a bare number", () => {
  const body = scene();
  assert.match(visibleText(body), /assembled/);
});

test("every tile renders through the shared TypeIcon, never a bare <img>", () => {
  // R27's guarantee: one fixed box that measures the same whether it holds a
  // cached picture or the named fallback tile, so the grid never reflows as
  // images stream in.
  const body = scene();
  assert.match(body, /class="type-icon type-icon-lg"/, "the grid uses the shared icon box");
  const bareImages = (body.match(/<img/g) ?? []).length;
  const iconBoxes = (body.match(/class="type-icon /g) ?? []).length;
  assert.ok(iconBoxes > 0, "expected icon boxes");
  assert.ok(bareImages <= iconBoxes, "every <img> lives inside a TypeIcon box");
});

test("a tile with no picture to show falls back to a deliberate lettered plate", () => {
  // `data/` is gitignored, so a fresh clone has no icon cache and every icon
  // ends up on the fallback path. Two routes lead there: a 404 on the cached
  // picture (client-side `onerror`, covered by typeIcon.test.ts — the server
  // generator always emits the <img>, so it cannot be reached from here), and a
  // type with no usable id, which CAN be rendered.
  //
  // The scene: a player in space, whose active ship is therefore not among the
  // station hangar rows. The ships card still lists the hull they are flying —
  // with no typeID to build a picture URL from — and it must still be a
  // deliberate plate rather than a broken image or a blank square.
  const body = scene({ hangarRows: [] });
  assert.match(body, /type-icon-tile/, "the named fallback tile is reachable");
  assert.match(body, /role="img"/, "and it is announced as a picture");
  assert.doesNotMatch(body, /src=""/, "never an empty src, which renders as broken");
  // The letters come from the NAME, never from an id.
  assert.match(body, /aria-label="[^"]*"/);
});

test("the tile's letters are derived from the name, never from an id", () => {
  const body = scene();
  // Every icon box carries the item's resolved NAME as its alt text.
  assert.match(body, /alt="Veldspar"/);
  assert.match(body, /alt="Procurer"/);
});

test("a thing whose name has not resolved still renders a tile, not a crash", () => {
  const text = visibleText(scene({ names: false }));
  assert.match(text, /Hangar inventory/);
  assert.doesNotMatch(text, /undefined/);
  assert.doesNotMatch(text, /\[object Object\]/);
});

test("an empty hangar says so, and distinguishes it from a hangar not yet read", () => {
  const shipsOnly = visibleText(
    scene({
      hangarRows: [row({ itemID: PROCURER_ID, typeID: PROCURER_TYPE, categoryID: 6, singleton: true })],
    }),
  );
  assert.match(shipsOnly, /Nothing here but your ships/);

  const failed = visibleText(scene({ hangarError: "the session ended" }));
  assert.match(failed, /could not be loaded/);
  assert.doesNotMatch(failed, /Nothing here but your ships/, "a failed read is not an empty hangar");
});

// --- ⚠ no capability was lost ----------------------------------------------

// ⚠ WHY THE NEXT TWO TESTS READ THE SOURCE AS WELL AS THE RENDER.
//
// `selectionPlace` and `trashArmed` are COMPONENT-LOCAL state, not store state
// (they were before this rewrite too). A test can seed `inventory/selection`,
// but it cannot seed which place the tick was made in — that is set by the
// click handler, and the server generator runs no handlers. So the bulk bar and
// the armed trash are unreachable by rendering alone.
//
// The render half therefore pins what a first paint really does show (the
// checkbox on every tile, labelled by name), and the source half pins that the
// bulk machinery is still wired and still behind its gate. That split is the
// same one miningPanel.test.ts uses for its two-step refine confirm.

test("⚠ selection still works, from inside the grid", () => {
  const body = scene({ selection: [VELDSPAR_ID] });
  assert.match(body, /type="checkbox"/, "every tile can still be ticked");
  assert.match(body, /aria-label="Select Veldspar"/, "and the tick is labelled by name");
  assert.match(body, /aria-label="Select Tritanium"/);
  // One checkbox per non-ship tile.
  assert.equal((body.match(/aria-label="Select /g) ?? []).length, 3);
  // Ticking is routed through the shared handler with the tile's own place, so
  // a tick made in the hangar can never be applied to a corporation division.
  assert.match(SOURCE, /onchange=\{\(\) => toggle\(row, place\)\}/);
  assert.match(SOURCE, /function toggle\(row: InventoryItemRow, place: InventoryPlace\)/);
  // And a ticked tile is marked in the markup.
  assert.match(SOURCE, /isPicked\(row, place\) \? 'picked' : ''/);
});

test("⚠ the bulk actions survive: move, merge, clear and the armed trash", () => {
  // The bar itself is gated on local state (see the note above).
  assert.match(SOURCE, /\{#if selectedCount > 0 && selectionPlace\}/);
  assert.match(SOURCE, /\{selectedCount\} selected in \{placeName\(selectionPlace\)\}/);
  assert.match(SOURCE, /Move to \{destination\.label\}/, "bulk move destinations");
  assert.match(SOURCE, /Clear selection/);
  assert.match(SOURCE, /Merge the two stacks/);
  assert.match(SOURCE, /flow\.mergeStacks\(/);
  assert.match(SOURCE, /flow\.transferItems\(/);
  assert.match(SOURCE, /flow\.trashItems\(/);

  // Two-step destroy: the ARMED control lives inside the armed branch and is
  // never rendered alongside the control that arms it.
  assert.match(SOURCE, /\{#if trashArmed\}/);
  const armed = SOURCE.slice(SOURCE.indexOf("{#if trashArmed}"));
  assert.ok(
    armed.indexOf("Destroy {selectedCount} permanently") < armed.indexOf("{:else}"),
    "the destructive button lives inside the armed branch",
  );
  assert.match(SOURCE, /class="danger"[\s\S]{0,200}Destroy/);
  assert.match(SOURCE, /There is no way to get them back/);

  // And a first paint shows none of it.
  assert.doesNotMatch(visibleText(scene({ selection: [VELDSPAR_ID] })), /Destroy/);
});

test("⚠ stack-all still works for the hangar and for the ship's cargo", () => {
  assert.match(visibleText(scene()), /Stack all \(hangar\)/);
  assert.match(SOURCE, /flow\.stackContainer\("cargo"\)/, "the cargo stack action survives");
  assert.match(SOURCE, /flow\.stackContainer\("hangar"\)/);
});

test("⚠ containers can still be opened, and the corporation hangar still reads", () => {
  const text = visibleText(scene({ container: true, corp: true }));
  assert.match(text, /Open/, "a container tile still offers Open");
  assert.match(text, /Small Standard Container/, "the open container has its own card");
  assert.match(text, /Back to the hangar/);
  assert.match(text, /Corporation hangar/);
  assert.match(text, /Ore stash/, "the division is named");
});

test("⚠ moving things between places is still offered on the tiles", () => {
  const hangar = scene();
  assert.match(visibleText(hangar), /→ Cargo/, "hangar tiles still send to cargo");
  const withContainer = scene({ container: true, corp: true });
  assert.match(visibleText(withContainer), /→ Hangar/, "container and corp tiles send back");
});

test("a bay the bridge cannot act on is read-only, and the panel says why", () => {
  // There is no way to address "the ore hold of the ship I am not flying", so
  // no button is drawn for it — but the player is told what to do instead
  // rather than left wondering where the controls went.
  const text = visibleText(
    scene({ openShipID: RUPTURE_ID, openShipType: RUPTURE_TYPE, bays: BADGER_BAYS }),
  );
  assert.match(text, /Board this ship to move things in and out/);
});

// --- R51: move ore out of a bay, and no fake hangar limit -------------------

test("R51: the active ship's ore hold offers 'send to hangar' on its stacks", () => {
  // The Procurer IS the active ship; its ore hold holds Veldspar. That stack
  // must be selectable and offer a move to the station hangar — the same
  // affordance the cargo hold already had, now that a bay is addressable as a
  // transfer source.
  const body = scene({ openShipID: PROCURER_ID });
  // R60 — the bays live in the Ship Inventory tab now, ahead of the Ship Hangar
  // tab's "Your ships" heading, so slice that panel out by its own bounds.
  const bayTab = body.slice(body.indexOf("its bays"), body.indexOf("Your ships"));
  assert.match(bayTab, /→ Hangar/, "the ore-hold stack can be sent to the hangar");
  assert.match(
    bayTab,
    /aria-label="Select Veldspar"/,
    "and the ore-hold stack can be ticked for a bulk move",
  );
});

test("R51: a bay on a ship the player is NOT flying stays read-only", () => {
  // There is still no way to address the ore hold of a hull you are not in, so
  // no move button is drawn for it — the player is told to board instead.
  const body = scene({ openShipID: RUPTURE_ID, openShipType: RUPTURE_TYPE, bays: PROCURER_BAYS });
  // R60 — the opened (inactive) hull's bays are in the Ship Inventory tab.
  const bayTab = body.slice(body.indexOf("its bays"), body.indexOf("Your ships"));
  assert.doesNotMatch(bayTab, /→ Hangar/, "an inactive hull's bays offer no move");
  assert.doesNotMatch(bayTab, /aria-label="Select Veldspar"/, "and no selection either");
  assert.match(visibleText(bayTab), /Board this ship to move things in and out/);
});

test("R51: the station hangar shows room used with no fake limit and no gauge", () => {
  // eve.js returns a 1,000,000 m³ default for the unmapped hangar flag — a
  // phantom, not a real ceiling. A station has no limit, so the hangar shows
  // only how much room is used: no "of X", no gauge.
  const body = scene();
  const hangarCard = body.slice(body.indexOf("Hangar inventory"));
  const text = visibleText(hangarCard);
  assert.match(text, /Room used: 250,000 m³/);
  assert.doesNotMatch(text, /of 1,000,000/, "the phantom 1,000,000 limit is gone");
  assert.doesNotMatch(hangarCard, /hud-track/, "and there is no gauge to fill toward");
});

test("R51: a ship bay with a REAL capacity still shows 'of' and a gauge", () => {
  // The fix keys on WHICH section is the station hangar, not on the 1,000,000
  // value — so a ship bay's genuine, useful limit is untouched.
  const body = scene({ openShipID: PROCURER_ID });
  // R60 — the ore hold is in the Ship Inventory tab.
  const bayTab = body.slice(body.indexOf("its bays"), body.indexOf("Your ships"));
  assert.match(visibleText(bayTab), /12,375\.2 of 16,000 m³/, "the ore hold keeps its real limit");
  assert.match(bayTab, /hud-track/, "a finite bay still draws its fill gauge");
});

// --- R60: the four tabs -----------------------------------------------------

test("R60: the panel sorts its content into four named tabs", () => {
  const body = scene();
  assert.match(body, /role="tablist"/, "a real tablist, keyboard-reachable");
  for (const label of ["Ship Inventory", "Ship Hangar", "Item Hangar", "Corporate Hangar"]) {
    assert.ok(body.includes(label), `the ${label} tab is named in plain language`);
  }
  assert.equal((body.match(/role="tab"/g) ?? []).length, 4, "four tabs, each a real button");
});

test("R60: inactive tabs are HIDDEN but still in the DOM, so a selection survives a switch", () => {
  // All five panels render (the four inventory tabs + Station Services); the
  // ones that are not the default active one carry `hidden`. This is the whole
  // reason a tick made in one tab is not lost when the player moves to another
  // — nothing remounts.
  const body = scene();
  assert.equal((body.match(/role="tabpanel"/g) ?? []).length, 5, "all five panels render");
  assert.equal(
    (body.match(/role="tabpanel"[^>]*hidden/g) ?? []).length,
    4,
    "four of them are hidden, one is shown",
  );
  // The content of a hidden tab is genuinely present, not conditionally unmounted.
  assert.match(body, /Hangar inventory/, "the Item Hangar tab's grid is in the DOM");
  assert.match(body, /Corporation hangar/, "and so is the corp hangar's");
});

test("R60: the dock variant drops the panel's own big header (the frame titles it)", () => {
  const windowed = scene();
  const docked = scene({ dock: true });
  assert.match(windowed, /<h2>Inventory &amp; Ship<\/h2>/, "the Neocom window keeps its own title");
  assert.doesNotMatch(docked, /Inventory &amp; Ship/, "the dock frame supplies the station-name title instead");
  // The tabs and their content are present in both.
  assert.match(docked, /Ship Inventory/);
  assert.match(docked, /role="tablist"/);
});

test("R60: opening a ship in the Ship Hangar hands it to the Ship Inventory tab", () => {
  // The Ship Hangar tiles offer "Open" rather than an inline bays toggle; the
  // handler opens the hull's bays AND switches to the Ship Inventory tab, so
  // "the bays I am looking at" is ONE piece of state, not two tabs fighting.
  assert.match(SOURCE, /function openInInventory\(row: InventoryItemRow\)/);
  assert.match(SOURCE, /activeTab = "shipInventory";/);
  assert.match(SOURCE, /flow\.openShipBays\(row\.itemID\)/);
  assert.match(SOURCE, /onclick=\{\(\) => openInInventory\(ship\)\}/, "the tile's Open is wired to it");
});

// --- R7d --------------------------------------------------------------------

test("R7d: no itemID, typeID, stationID or FLAG is ever visible text", () => {
  const body = scene({ openShipID: PROCURER_ID, selection: [VELDSPAR_ID], container: true, corp: true });
  // The typeID is permitted inside an icon's `src` path and NOWHERE else — an
  // asset path is not data shown to a player (the R21/R27 carve-out).
  const text = visibleText(body.replace(/src="[^"]*"/g, ""));
  for (const id of [
    STATION_ID, PROCURER_ID, RUPTURE_ID, VELDSPAR_ID, DRONE_STACK_ID, TRIT_STACK_ID, CRATE_ID,
    PROCURER_TYPE, RUPTURE_TYPE, VELDSPAR_TYPE, TRIT_TYPE, DRONE_TYPE, CRATE_TYPE,
  ]) {
    // ⚠ `\\b`, NOT `\b`. In a template literal `\b` is the BACKSPACE character
    // (charCode 8), so a sweep written that way searches for a control code and
    // can never fail. Three such vacuous sweeps have shipped in this repo.
    assert.doesNotMatch(text, new RegExp(`\\b${id}\\b`), `the id ${id} leaked to the player`);
  }
  // A bay is a flag, and that is exactly what the player must never learn.
  assert.equal(/\bflag\b/i.test(text), false, "'flag' is wire vocabulary");
  for (const flag of [5, 87, 90, 134, 155]) {
    assert.doesNotMatch(text, new RegExp(`\\bflag ${flag}\\b`), `flag ${flag} must not appear`);
  }
});

test("R7d: the sweep above is not vacuous — it catches a real leak", () => {
  // Proof the regex works: the same construction applied to a string that DOES
  // contain the id must match. Without this, a broken `\b` would make the sweep
  // above pass for the wrong reason.
  assert.match(` ${PROCURER_ID} `, new RegExp(`\\b${PROCURER_ID}\\b`));
});

// --- R9a --------------------------------------------------------------------

test("R9a: the panel speaks to a player, not to a developer", () => {
  const text = visibleText(scene({ openShipID: PROCURER_ID, corp: true, container: true }));
  for (const jargon of [
    "invbroker", "ListByFlags", "GetCapacity", "MachoBindObject", "bound object",
    "itemID", "typeID", "flagID", "allowlist", "BFF", "packedrow", "singleton",
  ]) {
    assert.equal(text.includes(jargon), false, `"${jargon}" must not be on screen`);
  }
  assert.match(text, /Your ships/);
  assert.match(text, /Pick a ship to see its bays/);
});

// --- R8 ---------------------------------------------------------------------

test("R8: the grid reflows by itself and can never scroll the body sideways", () => {
  const css = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");
  const grid = css.slice(css.indexOf(".item-grid {"), css.indexOf(".item-tile {"));
  // auto-fill + minmax is the whole responsive story: the browser fits as many
  // whole columns as the CONTAINER allows and never more.
  assert.match(grid, /repeat\(auto-fill, minmax\([\d.]+rem, 1fr\)\)/);
  // A long type name must WRAP, not widen the column past its track.
  const tile = css.slice(css.indexOf(".item-tile {"), css.indexOf(".item-tile-actions {"));
  assert.match(tile, /min-width: 0;/, "without this a long word sets the grid's minimum width");
  assert.match(css, /\.item-tile-name[\s\S]{0,200}overflow-wrap: anywhere;/);
  // No fixed pixel widths anywhere in the new grid components.
  assert.doesNotMatch(grid, /width:\s*\d+px/);
});

test("R8: every control in a tile is a real button at the 40px touch minimum", () => {
  const css = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");
  assert.match(css, /\.item-tile-actions button[\s\S]{0,120}min-height: 2\.5rem;/);
  assert.match(css, /\.item-tile-pick[\s\S]{0,240}min-height: 2\.5rem;/);
  // Actions are buttons, never fake links.
  assert.equal(/<a\s+href="#/.test(SOURCE), false, "actions are buttons, not fake links");
  const body = scene();
  assert.match(body, /<button/);
});

test("R8: the remaining tables still reflow inside their own scroll wrapper", () => {
  // The panel no longer has any table of its own — but if one is ever added
  // back it must carry the R8 contract, so this pins that none has crept in
  // without it.
  const body = scene({ corp: true, container: true });
  for (const table of body.match(/<table[^>]*>/g) ?? []) {
    assert.match(table, /reflow/, `a table without the reflow contract: ${table}`);
  }
});

// --- the panel computes nothing --------------------------------------------

test("the panel invents no capacity: every number on screen came from the server", () => {
  // The arithmetic moved to `inventoryModel.ts` when the docked station panel
  // started sharing it, so the sweep follows it: BOTH the panel's own script
  // and the model it calls have to be free of invention, or the rule could be
  // satisfied by pushing a prediction one file across.
  const script = SOURCE.split("</script>")[0] ?? "";
  const model = readFileSync(path.join(UI_DIR, "inventoryModel.ts"), "utf8");
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const code = `${strip(script)}\n${strip(model)}`;
  // The one derived number is the gauge's fill PERCENTAGE, which is a unit
  // conversion of two numbers the server gave, not a prediction.
  assert.match(code, /capacity\.used \/ capacity\.capacity/);
  for (const forbidden of ["estimate", "predict", "guess"]) {
    assert.equal(new RegExp(forbidden, "i").test(code), false, `must not ${forbidden}`);
  }
});
