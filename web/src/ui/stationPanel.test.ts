// THE STATION PANEL as it actually renders (StationPanel.svelte) — the docked
// right-hand dock panel.
//
// It replaced a grid of large tiles with table rows, so this suite guards, in
// the order that getting it wrong does the most damage:
//
//   1. ⚠ ABSENT ≠ EMPTY ≠ UNREADABLE ≠ UNCHECKED. A hull with no ore hold, a
//      hull whose ore hold could not be read, an ore hold that is genuinely
//      empty, and a bay nobody could even check must render four different
//      ways. This is the invariant this codebase has broken before
//      (`worldHasNoContracts`) and the one the row rewrite could most easily
//      flatten.
//   2. ⚠ UNKNOWN VOLUME IS UNKNOWN. Ship-bay rows carry no per-unit m³ at all,
//      so the panel's headline m³ columns are empty for every row in the bays
//      view. That is the NORMAL case. A 0 there would be a number the panel
//      invented.
//   3. NO LOST CAPABILITY. Selection, bulk moves, the confirm, merge, trash,
//      stack-all, the container, the corporation hangar, the ship hangar, the
//      repair two-step and the session controls all worked before the redesign.
//      A prettier table that dropped any of them is a regression.
//   4. The standing invariants: R7d (no visible numeric IDs), R9a (plain player
//      language), R8 (container-driven tiers, real buttons, nothing that can
//      scroll the panel sideways at the frame's minimum width).
//
// ⚠ WHAT A SERVER RENDER CANNOT REACH. `$effect`, `onMount` and event handlers
// never run here, and the panel's `selectionPlace` is component state — so the
// move bar's *behaviour* is not testable from a body string. Those rules live
// in `inventoryModel.ts` and are tested directly in `inventoryModel.test.ts`.
// What this suite checks is that the controls are on screen and wired.

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
const StationPanel = (await import("./StationPanel.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "StationPanel.svelte"), "utf8");
const CSS = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8");

// Real ids from the live reads these fixtures were captured from — so the R7d
// sweep is sweeping for numbers that genuinely pass through this panel.
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
const GUEST_ID = 90000002;
const GUEST_CORP = 1000002;

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

/**
 * ⚠ THE FOUR STATES, IN ONE HULL. A Procurer as the BFF answered it, with a
 * bay of each kind so no test can pass by accident:
 *   cargo  present, read, EMPTY            drone  present, read, one stack
 *   ore    present, read, one stack        gas    present, capacity NOT reported
 *   fleet / shipMaintenance  ABSENT        fuel   nobody could CHECK it
 *   salvage present but its CONTENTS could not be read
 */
const PROCURER_BAYS = [
  { key: "cargo", label: "Cargo hold", present: true, capacity: { capacity: 350, used: 0 }, items: [], error: null },
  {
    key: "drone",
    label: "Drone bay",
    present: true,
    capacity: { capacity: 100, used: 50 },
    items: [{ itemID: DRONE_STACK_ID, typeID: DRONE_TYPE, groupID: 100, categoryID: 18, quantity: 5, singleton: false }],
    error: null,
  },
  {
    key: "ore",
    label: "Ore hold",
    present: true,
    capacity: { capacity: 16000, used: 12375.2 },
    items: [{ itemID: VELDSPAR_ID, typeID: VELDSPAR_TYPE, groupID: 462, categoryID: 25, quantity: 123752, singleton: false }],
    error: null,
  },
  { key: "gas", label: "Gas hold", present: true, capacity: null, items: [], error: null },
  { key: "salvage", label: "Salvage hold", present: true, capacity: { capacity: 50, used: 0 }, items: null, error: "the read timed out" },
  { key: "shipMaintenance", label: "Ship maintenance bay", present: false, capacity: null, items: null, error: null },
  { key: "fleet", label: "Fleet hangar", present: false, capacity: null, items: null, error: null },
  { key: "fuel", label: "Fuel bay", present: null, capacity: null, items: null, error: null },
];

interface Scene {
  readonly docked?: boolean;
  readonly loaded?: boolean;
  readonly bays?: boolean;
  readonly baysError?: string;
  readonly openShipID?: number;
  readonly corp?: boolean;
  readonly corpAvailable?: boolean;
  readonly container?: boolean;
  readonly guests?: boolean;
  readonly names?: boolean;
  readonly actionError?: string;
  readonly hangarError?: string;
}

function panel(options: Scene = {}): string {
  const store = createClientStore();
  store.apply({ type: "session/logged-in", accountID: 1, username: "rrfarmer" } as never);
  store.apply({
    type: "character/online",
    character: {
      characterID: 90000001,
      characterName: "Farmer",
      stationID: options.docked === false ? null : STATION_ID,
      structureID: null,
      solarSystemID: 30000142,
      corporationID: 1000001,
    },
    station: {
      stationID: STATION_ID,
      stationName: "Reprocessing Plant",
      solarSystemName: "Jita",
      regionName: "The Forge",
      stationTypeID: 1531,
      stationTypeName: "Caldari Reprocessing Plant",
      operationID: null,
      security: 0.54,
    },
  } as never);
  store.apply({
    type: "station/bits",
    bits: { ownerID: 1000035, stationID: STATION_ID, operationID: null, stationTypeID: 1531 },
  } as never);
  if (options.guests) {
    store.apply({
      type: "station/guests",
      guests: [
        { characterID: 90000001, corporationID: 1000001, allianceID: null, warFactionID: null },
        { characterID: GUEST_ID, corporationID: GUEST_CORP, allianceID: null, warFactionID: null },
      ],
    } as never);
  }
  if (options.loaded !== false) {
    store.apply({
      type: "inventory/loaded",
      stationID: STATION_ID,
      activeShipID: PROCURER_ID,
      hangar: {
        rows: [
          row({ itemID: PROCURER_ID, typeID: PROCURER_TYPE, categoryID: 6, singleton: true }),
          row({ itemID: RUPTURE_ID, typeID: RUPTURE_TYPE, categoryID: 6, singleton: true }),
          row({ itemID: VELDSPAR_ID, typeID: VELDSPAR_TYPE, categoryID: 25, groupID: 462, quantity: 123752, volume: 0.1 }),
          row({ itemID: TRIT_STACK_ID, typeID: TRIT_TYPE, categoryID: 4, quantity: 88000, volume: 0.01 }),
          row({ itemID: CRATE_ID, typeID: CRATE_TYPE, categoryID: 2, groupID: 12, singleton: true }),
        ],
        capacity: { capacity: 1000000, used: 250000 },
        error: options.hangarError ?? null,
      },
      cargo: { rows: [], capacity: { capacity: 350, used: 0 }, error: null },
    } as never);
  }
  if (options.bays !== false) {
    const shipID = options.openShipID ?? PROCURER_ID;
    store.apply({ type: "inventory/ship-open", itemID: shipID, typeID: PROCURER_TYPE } as never);
    store.apply({
      type: "inventory/ship-bays",
      itemID: shipID,
      bays: decodeShipBays(PROCURER_BAYS as never),
      error: options.baysError ?? null,
    } as never);
  }
  if (options.corp) {
    store.apply({
      type: "inventory/corp-loaded",
      available: options.corpAvailable !== false,
      reason: options.corpAvailable === false ? "NO_CORP_OFFICE" : null,
      divisions: [
        { division: 1, name: "Ore stash", rows: [row({ itemID: 71, typeID: VELDSPAR_TYPE, quantity: 10, volume: 0.1 })], error: null },
        { division: 2, name: null, rows: [], error: null },
      ],
    } as never);
  }
  if (options.container) {
    store.apply({
      type: "inventory/container",
      container: {
        itemID: CRATE_ID,
        typeID: CRATE_TYPE,
        rows: [row({ itemID: 81, typeID: TRIT_TYPE, quantity: 10, volume: 0.01 })],
        capacity: { capacity: 27500, used: 100 },
        error: null,
      },
    } as never);
  }
  if (options.actionError) {
    store.apply({ type: "inventory/action-error", message: options.actionError } as never);
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
        "type:1531": "Caldari Reprocessing Plant",
        "owner:1000035": "Caldari Navy",
        [`character:${GUEST_ID}`]: "Another Pilot",
        [`corporation:${GUEST_CORP}`]: "Some Corporation",
      },
    } as never);
  }
  return render(StationPanel as never, {
    props: { store, flow: fakeFlow(), onCollapse: () => {} },
  } as never).body;
}

/** One location's markup. Every location renders; the inactive ones are hidden. */
function locationView(body: string, id: string): string {
  const start = body.indexOf(`id="stn-view-${id}"`);
  assert.notEqual(start, -1, `there is no "${id}" location`);
  const next = body.indexOf('id="stn-view-', start + 10);
  return body.slice(start, next === -1 ? body.length : next);
}

// --- 1. ⚠ absent / empty / unreadable / unchecked ---------------------------

test("⚠ a bay the hull does NOT have is not drawn at all", () => {
  const bays = locationView(panel(), "ship");
  assert.doesNotMatch(visibleText(bays), /Ship maintenance bay/);
  assert.doesNotMatch(visibleText(bays), /Fleet hangar/);
});

test("⚠ an EMPTY bay says so, and does not look like a bay that is not there", () => {
  const bays = visibleText(locationView(panel(), "ship"));
  assert.match(bays, /Cargo hold/, "the empty bay is still drawn");
  assert.match(bays, /Empty — move things here from the hangar\./);
});

test("⚠ a bay whose CONTENTS could not be read does not read as empty", () => {
  const bays = visibleText(locationView(panel(), "ship"));
  assert.match(bays, /Salvage hold/, "the bay is drawn");
  assert.match(bays, /could not be read: the read timed out/);
});

test("⚠ a bay nobody could CHECK is named out loud, never silently absent", () => {
  const bays = visibleText(locationView(panel(), "ship"));
  assert.match(bays, /These bays could not be checked/);
  assert.match(bays, /Fuel bay/);
});

test("⚠ the four states really are four different strings", () => {
  // Non-vacuous: the tests above could each pass while two states shared one
  // wording. Absent has NO wording at all, which is the fourth.
  const bays = visibleText(locationView(panel(), "ship"));
  const empty = /Empty — move things here/.test(bays);
  const unreadable = /could not be read/.test(bays);
  const unchecked = /could not be checked/.test(bays);
  const absent = !/Fleet hangar/.test(bays);
  assert.deepEqual([empty, unreadable, unchecked, absent], [true, true, true, true]);
});

test("⚠ a hull whose bays failed ENTIRELY says so — not 'this ship has no bays'", () => {
  const bays = visibleText(locationView(panel({ baysError: "the bind was refused" }), "ship"));
  assert.match(bays, /could not be read, so we cannot say what it has/);
  assert.doesNotMatch(bays, /has no bays/);
});

test("⚠ a capacity the ship did not report reads 'not known', never 0", () => {
  const bays = visibleText(locationView(panel(), "ship"));
  // The gas hold is present and its capacity never arrived.
  assert.match(bays, /Gas hold/);
  assert.match(bays, /not known/);
});

test("a bay on a hull the player is NOT flying is read-only, and the panel says why", () => {
  const bays = locationView(panel({ openShipID: RUPTURE_ID }), "ship");
  assert.match(visibleText(bays), /Board this ship to move things in and out of it\./);
  assert.match(bays, /read-only/);
  assert.doesNotMatch(bays, /type="checkbox"/, "a read-only bay offers no selection");
});

test("the station hangar shows room USED, with no invented ceiling and no gauge to fill", () => {
  // eve.js answers a phantom 1,000,000 m³ for the unmapped hangar flag.
  const hangar = locationView(panel(), "hangar");
  assert.doesNotMatch(visibleText(hangar), /1,000,000|1 000 000/);
  assert.match(hangar, /class="stn-bar nolimit"/, "no limit means a flat track, not an empty bar");
});

test("a ship bay with a real capacity keeps its limit and its gauge", () => {
  const bays = locationView(panel(), "ship");
  assert.match(bays, /class="stn-bar-fill"[^>]*style="width: 50%/, "the drone bay is half full");
});

// --- 2. ⚠ volume the panel does not know ------------------------------------

test("⚠ a row with no per-unit volume shows a dash, never 0", () => {
  // Every row in every ship bay is like this: the bay read carries no volume.
  const bays = locationView(panel(), "ship");
  const veldspar = bays.slice(bays.indexOf("Veldspar"));
  assert.match(veldspar, /class="stn-cell-unit">—</, "m³/unit must be unknown, not 0");
  assert.match(veldspar, /class="stn-cell-vol">—</, "total m³ must be unknown, not 0");
});

test("a row that DOES carry a volume shows it", () => {
  // Non-vacuous: the hangar read attaches volume, so the dash above is about
  // the data and not about the column being broken.
  const hangar = locationView(panel(), "hangar");
  const veldspar = hangar.slice(hangar.indexOf("Veldspar"));
  assert.doesNotMatch(veldspar.slice(0, 400), /class="stn-cell-unit">—</);
});

test("with nothing selected the action bar does not claim a volume of zero", () => {
  const body = panel();
  const bar = body.slice(body.indexOf('class="stn-actions'));
  assert.match(bar, /0 selected/);
  assert.doesNotMatch(bar, /class="stn-sel-vol">\s*0 m³/, "an empty selection has no volume to state");
});

// --- 3. no lost capability --------------------------------------------------

test("rows can still be selected, one at a time or a whole group", () => {
  const hangar = locationView(panel(), "hangar");
  assert.match(hangar, /aria-label="Select Veldspar"/);
  assert.match(hangar, /aria-label="Select everything shown in Item hangar"/);
});

test("the move bar still offers every destination, and says where it would go", () => {
  const body = panel();
  const bar = body.slice(body.indexOf('class="stn-actions'));
  assert.match(bar, /Move to/);
  assert.match(visibleText(bar), /Ship cargo/, "the ship's cargo hold is a destination");
  assert.match(visibleText(bar), /Ore hold/, "so are the specialty holds of the hull you fly");
});

test("a row carries its own quick move and a menu of the rest", () => {
  const hangar = locationView(panel(), "hangar");
  assert.match(visibleText(hangar), /to Ship cargo/);
  assert.match(hangar, /aria-label="Where else to send Veldspar"/);
});

test("trash is still offered, and still says it cannot be undone", () => {
  const body = panel();
  assert.match(visibleText(body), /Trash…/);
  assert.match(SOURCE, /This cannot be undone/, "the confirm must say so");
});

test("merging two stacks is still wired to the model's ordering", () => {
  // The button only appears with exactly two mergeable stacks ticked, which a
  // server render cannot reach — the ordering itself is tested in the model.
  assert.match(SOURCE, /mergeOrder\(selectedRows\)/);
  assert.match(SOURCE, /Merge the two stacks/);
});

test("stack-all still exists, beside the two places that can be re-stacked", () => {
  // The bridge's `stackContainer` knows only "hangar" and "cargo", so those are
  // the only two groups that offer it — and it now sits in the group's own
  // header, beside the thing it acts on, rather than in the location row.
  const hangar = locationView(panel(), "hangar");
  assert.match(visibleText(hangar), /Stack all/);
  const bays = locationView(panel(), "ship");
  const ore = bays.slice(bays.indexOf("Ore hold"), bays.indexOf("Gas hold"));
  assert.doesNotMatch(visibleText(ore), /Stack all/, "an ore hold cannot be re-stacked");
});

test("a container can still be opened, and browsed as its own location", () => {
  const hangar = locationView(panel(), "hangar");
  // The crate is an assembled container, so its row offers Open, not a move.
  assert.match(visibleText(hangar), /Open/);
  const body = panel({ container: true });
  assert.match(visibleText(body), /Small Standard Container/);
  assert.match(visibleText(body), /← Back to the item hangar/);
});

test("the corporation hangar still lists its divisions, by name", () => {
  const corp = visibleText(locationView(panel({ corp: true }), "corp"));
  assert.match(corp, /Ore stash/);
  assert.match(corp, /Division 2/, "a division nobody renamed keeps its ordinal");
});

test("a corporation with no office here is an ordinary state, not an error", () => {
  const corp = visibleText(locationView(panel({ corp: true, corpAvailable: false }), "corp"));
  assert.match(corp, /Your corporation has no office at this station\./);
});

test("the ship hangar still lists the hulls, and offers Open and Board", () => {
  const ships = locationView(panel(), "ships");
  assert.match(visibleText(ships), /Procurer/);
  assert.match(visibleText(ships), /Rupture/);
  assert.match(visibleText(ships), /Open/);
  assert.match(visibleText(ships), /Board/);
  assert.match(visibleText(ships), /You are flying this/);
});

test("the hull you are flying is marked and cannot be boarded again", () => {
  const ships = locationView(panel(), "ships");
  const flying = ships.slice(ships.indexOf("stn-ship-row"), ships.indexOf("Rupture"));
  assert.match(flying, /flying/);
  assert.doesNotMatch(flying, />\s*Board\s*</, "you cannot board the ship you are in");
});

test("a hull whose bays have not been read shows no invented bay summary", () => {
  const ships = locationView(panel(), "ships");
  const rupture = ships.slice(ships.indexOf("Rupture"));
  assert.match(rupture, /class="stn-cell-bays">—</, "unknown bays are a dash, never a number");
});

test("the station's services are still here: the facts, the ship actions, the session", () => {
  const services = visibleText(locationView(panel(), "services"));
  assert.match(services, /Owner/);
  assert.match(services, /Caldari Navy/);
  assert.match(services, /Security/);
  assert.match(services, /0\.54/);
  assert.match(services, /Board corvette/);
  assert.match(services, /Leave ship/);
  assert.match(services, /Go offline/);
  assert.match(services, /Log out/);
});

test("the repair shop is not charged until it has been asked for a quote", () => {
  const services = visibleText(locationView(panel(), "services"));
  assert.match(services, /Repair ship/, "the quote press is offered");
  assert.doesNotMatch(services, /and pay/, "the paying press must not appear before a quote");
});

test("the guests are still listed, with the pilot marked as themselves", () => {
  const services = visibleText(locationView(panel({ guests: true }), "services"));
  assert.match(services, /Guests/);
  assert.match(services, /Farmer \(you\)/);
  assert.match(services, /Another Pilot/);
  assert.match(services, /Some Corporation/);
});

test("a refused action's words surface on the panel", () => {
  const body = panel({ actionError: "You are already in your corvette." });
  assert.match(visibleText(body), /You are already in your corvette\./);
});

test("a failed hangar read is reported rather than shown as an empty hangar", () => {
  const hangar = visibleText(locationView(panel({ hangarError: "the list was refused" }), "hangar"));
  assert.match(hangar, /could not be read: the list was refused/);
  assert.doesNotMatch(hangar, /Nothing here but your ships/);
});

test("the panel can still be refreshed and folded away", () => {
  const body = panel();
  assert.match(body, /aria-label="Refresh"/);
  assert.match(body, /aria-label="Collapse"/);
});

test("every location is reachable from a tab row AND from a dropdown", () => {
  // Both controls are always in the DOM; the tier decides which is displayed,
  // and `display: none` keeps the hidden one out of the accessibility tree too.
  const body = panel({ container: true });
  assert.match(body, /role="tablist"/);
  assert.match(body, /class="stn-picker"/);
  for (const id of ["ship", "ships", "hangar", "corp", "container", "services"]) {
    assert.match(body, new RegExp(`id="stn-tab-${id}"`), `no tab for ${id}`);
    assert.match(body, new RegExp(`id="stn-view-${id}"`), `no view for ${id}`);
  }
});

test("every location renders; the inactive ones are HIDDEN, so nothing remounts", () => {
  const body = panel();
  const hiddenViews = body.match(/class="stn-view[^"]*"[^>]*hidden/g) ?? [];
  assert.ok(hiddenViews.length >= 4, `expected the inactive locations to be hidden, saw ${hiddenViews.length}`);
  assert.match(CSS, /\.stn-view\[hidden\]\s*\{\s*display: none;/);
});

test("dragging things between places survives the rewrite", () => {
  const hangar = locationView(panel(), "hangar");
  assert.match(hangar, /draggable="true"/);
  assert.match(SOURCE, /dropOnPlaceVerdict/, "a refused drop must still say so");
});

// --- 4. the standing invariants ---------------------------------------------

test("R7d: no itemID, typeID, stationID or character id is ever visible text", () => {
  const text = visibleText(panel({ corp: true, container: true, guests: true }));
  for (const id of [
    STATION_ID, PROCURER_ID, RUPTURE_ID, PROCURER_TYPE, RUPTURE_TYPE,
    VELDSPAR_ID, VELDSPAR_TYPE, DRONE_STACK_ID, DRONE_TYPE, TRIT_STACK_ID,
    TRIT_TYPE, CRATE_ID, CRATE_TYPE, GUEST_ID, GUEST_CORP, 1531, 1000035,
  ]) {
    assert.equal(text.includes(String(id)), false, `the id ${id} is on screen`);
  }
});

test("R7d: the sweep above is not vacuous — it catches a real leak", () => {
  const text = visibleText(panel());
  assert.equal(text.includes(String(VELDSPAR_ID)), false);
  assert.equal(visibleText(`<p>${VELDSPAR_ID}</p>`).includes(String(VELDSPAR_ID)), true);
});

test("R7d: an inventory FLAG never reaches the panel, only a bay's label", () => {
  // 4 hangar, 5 cargo, 115-121 the corporation divisions, 134 the ore hold.
  const script = SOURCE.split("</script>")[0] ?? "";
  for (const flag of ["134", "115", "121"]) {
    assert.equal(script.includes(flag), false, `flag ${flag} leaked into the panel`);
  }
});

test("R9a: the panel speaks to a player, not to a developer", () => {
  const text = visibleText(panel({ corp: true, guests: true }));
  for (const jargon of ["flagID", "typeID", "itemID", "invbroker", "packedrow", "OID", "bind"]) {
    assert.equal(text.includes(jargon), false, `"${jargon}" is on screen`);
  }
});

test("R8: the width tiers are CONTAINER queries, never the viewport", () => {
  // The panel lives in a column the player drags, so "is there room for the m³
  // columns" is a question about this panel. Asking the viewport is the bug
  // R85 fixed, and it would crush this table in a narrow dock on a wide screen.
  assert.match(CSS, /container-name: station;/);
  for (const width of ["330px", "560px", "900px"]) {
    assert.match(CSS, new RegExp(`@container station \\(min-width: ${width}\\)`), `no ${width} tier`);
  }
  // And no media query may creep in beside them — two would fire at different
  // times and neither would be the rule.
  assert.equal(
    /@media[^{]*\{[\s\S]{0,400}\.stn-(row|colhead|tabs)\b/.test(CSS),
    false,
    "a viewport-driven tier has appeared",
  );
});

test("R8: nothing in the panel can scroll the dock frame sideways", () => {
  // The frame's floor is MIN_W = 240 (dockPanelStates.test.ts pins it), so the
  // narrowest tier's fixed tracks plus its gaps and padding must fit inside it.
  const at = /\.stn-colhead,\s*\.stn-row \{/.exec(CSS);
  assert.ok(at, "the row grid has moved");
  const template = /grid-template-columns: ([^;]+);/.exec(CSS.slice(at.index))?.[1] ?? "";
  assert.match(template, /minmax\(0, 1fr\)/, "the name column must be the one that gives");
  const fixed = [...template.matchAll(/(\d+)px/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  const gaps = 8 * 2; // three tracks, two gaps
  const padding = 22;
  assert.ok(fixed + gaps + padding <= 240, `the narrowest row needs ${fixed + gaps + padding}px of 240`);
});

test("R8: the guests table keeps the reflow contract", () => {
  const body = panel({ guests: true });
  for (const table of body.match(/<table[^>]*>/g) ?? []) {
    assert.match(table, /reflow/, `a table without the reflow contract: ${table}`);
  }
  assert.match(body, /class="table-wrap overflow-x-auto"/);
});

test("R8: every control is a real button, never a fake link", () => {
  assert.equal(/<a\s+href="#/.test(SOURCE), false);
  assert.match(panel(), /<button/);
});

test("R53: the panel adds no rounded corners", () => {
  const section = CSS.slice(CSS.indexOf("6. THE STATION PANEL"));
  for (const [, value] of section.matchAll(/border-radius\s*:\s*([^;]+);/g)) {
    assert.match((value ?? "").trim(), /^0$/, `a rounded corner came back: ${value}`);
  }
});

test("the panel invents no capacity: every number on screen came from the server", () => {
  const script = SOURCE.split("</script>")[0] ?? "";
  const code = script.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const forbidden of ["estimate", "predict", "guess"]) {
    assert.equal(new RegExp(forbidden, "i").test(code), false, `must not ${forbidden}`);
  }
});

test("⚠ the panel is mounted from docked branches only", () => {
  // The whole reason this component exists rather than a rewrite of
  // InventoryShip: a pilot in space must not be able to reach it. Grep, so the
  // claim is checked and not merely asserted in a comment.
  for (const file of ["DockPanel.svelte", "MobileWorkspace.svelte", "PanelHost.svelte"]) {
    const source = readFileSync(path.join(UI_DIR, file), "utf8");
    if (!source.includes("StationPanel")) continue;
    assert.match(source, /isDocked/, `${file} mounts the panel without an isDocked guard`);
  }
  const host = readFileSync(path.join(UI_DIR, "PanelHost.svelte"), "utf8");
  assert.equal(
    host.includes("StationPanel"),
    false,
    "PanelHost opens floating windows in space — the station panel must not be one",
  );
});

test("⚠ the panel claims no class name the app already styles globally", () => {
  // `button.active` is a FILLED ACCENT control in the components layer, and it
  // outranks a plain `.stn-tab` — the first build of this panel came out with a
  // solid blue tab where an underline belonged. The panel's own state classes
  // must not collide with a bare name the stylesheet claims.
  const globals = [...CSS.matchAll(/(?:^|[\s,])([a-z]+)?\.(active|primary|minor|danger|open|selected)\b/gm)]
    .map((m) => m[2])
    .filter((name, index, all) => all.indexOf(name) === index);
  assert.ok(globals.length > 0, "expected the stylesheet to claim some bare state names");
  for (const name of globals) {
    assert.equal(
      new RegExp(`class:${name}[=\s]`).test(SOURCE),
      false,
      `the panel uses class:${name}, which the app already styles`,
    );
  }
});
