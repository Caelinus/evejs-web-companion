// DEV-ONLY VISUAL + INTERACTION HARNESS for the docked Station panel.
//
// WHY IT EXISTS. `inventoryModel.ts` proves where a stack may GO and its tests
// pin every rule; `stationPanel.test.ts` proves what the panel RENDERS. Neither
// can prove the panel WORKS, because both render through `svelte/server`, where
// `$effect`, `onMount` and every event handler are dead — and the panel's whole
// selection story lives in component state that only a pointer can set.
//
// The only other way to press a button in it is to bring up the BFF, bring up
// the gateway, sign a pilot in and dock. That is far too much ceremony to pay
// every time a column moves, so in practice the interactions would simply never
// be driven at all.
//
// This page mounts the REAL `StationPanel.svelte` against a fabricated world and
// a flow stub that actually MOVES things — so a confirmed move visibly empties
// one place and fills another, exactly as it must against the server. Every
// flow call is logged beside the panel, so "Board" can be seen to call
// `boardShip` and nothing else.
//
// It imports the same modules the app does, so it cannot drift from what ships.
//
// It is NOT part of the build: `vite.config.ts` builds `web/index.html` only, so
// nothing here reaches `public/dist`. Open it with `npm run dev:web` at
// /station-panel-harness.html.
import "./styles.css";
import { mount } from "svelte";
import StationPanel from "./ui/StationPanel.svelte";
import { createClientStore } from "./store/clientStore.ts";
import type { AppFlow } from "./app/flow.ts";
import type { InventoryItemRow, InventoryPlace } from "./store/types.ts";

const STATION_ID = 60000004;
const PROCURER = 9988400023309;
const RUPTURE = 9988400091901;
const IBIS = 9988400091999;

/** Every type the fabricated world uses: id, name, m³ per unit. */
const TYPES: readonly (readonly [number, string, number])[] = [
  [17480, "Procurer", 0],
  [629, "Rupture", 0],
  [601, "Ibis", 0],
  [1230, "Veldspar", 0.1],
  [1228, "Scordite", 0.15],
  [34, "Tritanium", 0.01],
  [35, "Pyerite", 0.01],
  [3634, "125mm Gatling AutoCannon II", 5],
  [31358, "Small Anti-Kinetic Screen Reinforcer I", 5],
  [12058, "Miner II", 5],
  [2488, "Hobgoblin I", 5],
  [11317, "1MN Afterburner I", 5],
  [519, "Gyrostabilizer I", 5],
  [3465, "Small Standard Container", 5],
];

let nextItemID = 5_000_000;

function row(typeID: number, quantity: number, over: Partial<InventoryItemRow> = {}): InventoryItemRow {
  const volume = TYPES.find(([id]) => id === typeID)?.[2] ?? null;
  return {
    itemID: (nextItemID += 1),
    typeID,
    groupID: null,
    categoryID: 7,
    flagID: null,
    quantity,
    singleton: quantity === 1 && volume !== 0,
    volume: volume === 0 ? null : volume,
    ...over,
  } as InventoryItemRow;
}

/** One bay of the hull we have open. `items: null` is "we could not look". */
interface Bay {
  key: string;
  label: string;
  present: boolean | null;
  capacity: { capacity: number; used: number } | null;
  items: InventoryItemRow[] | null;
  error: string | null;
}

/**
 * The whole fabricated world, as plain data. Moves mutate THIS and the store is
 * re-derived from it, which is close enough to the real thing — the server is
 * the authority there too, and the panel only ever re-reads.
 */
const world = {
  hangar: [
    row(17480, 1, { itemID: PROCURER, categoryID: 6, singleton: true }),
    row(629, 1, { itemID: RUPTURE, categoryID: 6, singleton: true }),
    row(601, 1, { itemID: IBIS, categoryID: 6, singleton: true }),
    row(1230, 123752),
    row(34, 880000),
    row(35, 42000),
    row(3634, 1),
    row(31358, 1),
    row(12058, 3),
    row(2488, 12),
    row(11317, 1),
    row(519, 2),
    row(3465, 1, { groupID: 12, categoryID: 2, singleton: true }),
  ] as InventoryItemRow[],
  cargo: [] as InventoryItemRow[],
  // ⚠ Bay contents carry NO volume, exactly as the real read does not send it.
  // That is what makes the panel's m³ columns show "—" in here, which is the
  // single easiest thing to get wrong by testing against tidier fixtures.
  bays: [
    { key: "cargo", label: "Cargo hold", present: true, capacity: { capacity: 350, used: 0 }, items: [], error: null },
    {
      key: "ore",
      label: "Ore hold",
      present: true,
      capacity: { capacity: 16000, used: 15200 },
      items: [row(1230, 123752, { volume: null }), row(1228, 8400, { volume: null })],
      error: null,
    },
    {
      key: "drone",
      label: "Drone bay",
      present: true,
      capacity: { capacity: 100, used: 50 },
      items: [row(2488, 5, { volume: null })],
      error: null,
    },
    { key: "gas", label: "Gas hold", present: true, capacity: null, items: [], error: null },
    { key: "salvage", label: "Salvage hold", present: true, capacity: { capacity: 50, used: 0 }, items: null, error: "the read timed out" },
    { key: "fleet", label: "Fleet hangar", present: false, capacity: null, items: null, error: null },
    { key: "shipMaintenance", label: "Ship maintenance bay", present: false, capacity: null, items: null, error: null },
    { key: "fuel", label: "Fuel bay", present: null, capacity: null, items: null, error: null },
  ] as Bay[],
  corp: [
    { division: 1, name: "Industry", rows: [row(34, 4000)] as InventoryItemRow[], error: null },
    { division: 2, name: "Blueprints", rows: [] as InventoryItemRow[], error: null },
    { division: 3, name: "Assets", rows: [] as InventoryItemRow[], error: null },
    { division: 4, name: null, rows: [] as InventoryItemRow[], error: null },
  ],
  container: null as InventoryItemRow[] | null,
  containerItemID: 0,
  openShipID: PROCURER,
  activeShipID: PROCURER,
  selectedDivision: 1,
};

const store = createClientStore();

function log(message: string): void {
  const el = document.getElementById("log");
  if (!el) return;
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  el.prepend(line);
}

/** Push the fabricated world into the store, the way a re-read would. */
function push(): void {
  store.apply({
    type: "inventory/loaded",
    stationID: STATION_ID,
    activeShipID: world.activeShipID,
    hangar: { rows: world.hangar, capacity: { capacity: 1000000, used: 224954.45 }, error: null },
    cargo: { rows: world.cargo, capacity: { capacity: 350, used: 0 }, error: null },
  } as never);
  store.apply({ type: "inventory/ship-open", itemID: world.openShipID, typeID: 17480 } as never);
  store.apply({ type: "inventory/ship-bays", itemID: world.openShipID, bays: world.bays, error: null } as never);
  store.apply({
    type: "inventory/corp-loaded",
    available: true,
    reason: null,
    divisions: world.corp,
  } as never);
}

/**
 * The container, separately. ⚠ `inventory/container` CLEARS THE SELECTION (a
 * tick made in one place must never be applied in another), so it must not ride
 * along on every ordinary re-read the way the rest of the world does.
 */
function pushContainer(): void {
  store.apply({
    type: "inventory/container",
    container:
      world.container === null
        ? null
        : {
            itemID: world.containerItemID,
            typeID: 3465,
            rows: world.container,
            capacity: { capacity: 27500, used: 0 },
            error: null,
          },
  } as never);
}

/** The rows of a place, as a mutable array in `world`. Null = not addressable. */
function bucket(place: InventoryPlace): InventoryItemRow[] | null {
  if (place.kind === "hangar") return world.hangar;
  if (place.kind === "cargo") return world.cargo;
  if (place.kind === "shipBay") {
    const bay = world.bays.find((b) => b.key === place.bay);
    return bay?.items ?? null;
  }
  if (place.kind === "container") return world.container;
  return world.corp.find((d) => d.division === place.division)?.rows ?? null;
}

/** Recompute a bay's `used` from what is in it, so the gauges actually move. */
function reprice(): void {
  for (const bay of world.bays) {
    if (!bay.capacity || bay.items === null) continue;
    const known = bay.items.every((r) => typeof r.volume === "number");
    if (!known) continue;
    bay.capacity = { ...bay.capacity, used: bay.items.reduce((t, r) => t + (r.volume ?? 0) * r.quantity, 0) };
  }
}

function place(name: InventoryPlace): string {
  return name.kind === "shipBay" ? `shipBay:${name.bay}` : name.kind === "corp" ? `corp:${name.division}` : name.kind;
}

// The flow stub. Reads no-op; the calls that MOVE things really move them, so a
// confirmed move can be watched emptying one place and filling another.
const flow = {
  async loadInventory(): Promise<void> { log("loadInventory()"); push(); },
  async loadCorpHangar(): Promise<void> { log("loadCorpHangar()"); push(); },
  async refreshStationPanel(): Promise<void> { log("refreshStationPanel()"); },
  requestNames(): void {},
  toggleSelection(itemID: number): void {
    const current = store.get().inventory.selection;
    store.apply({
      type: "inventory/selection",
      itemIDs: current.includes(itemID) ? current.filter((id) => id !== itemID) : [...current, itemID],
    } as never);
  },
  clearSelection(): void {
    store.apply({ type: "inventory/selection", itemIDs: [] } as never);
  },
  async openShipBays(shipID: number | null): Promise<void> {
    log(`openShipBays(${shipID === world.activeShipID ? "the active hull" : "another hull"})`);
    if (shipID !== null) world.openShipID = shipID;
    push();
  },
  async openContainer(itemID: number | null): Promise<void> {
    log(`openContainer(${itemID === null ? "null — close" : "a crate"})`);
    if (itemID === null) {
      world.container = null;
    } else {
      world.container = [row(34, 250), row(35, 90)];
      world.containerItemID = itemID;
    }
    pushContainer();
  },
  selectCorpDivision(division: number): void {
    log(`selectCorpDivision(${division})`);
    world.selectedDivision = division;
    store.apply({ type: "inventory/corp-division", division } as never);
    push();
  },
  async transferItems(
    itemIDs: readonly number[],
    from: InventoryPlace,
    to: InventoryPlace,
    qty: number | null,
  ): Promise<void> {
    log(`transferItems(${itemIDs.length} × ${place(from)} -> ${place(to)}, qty=${qty ?? "whole stack"})`);
    const source = bucket(from);
    const target = bucket(to);
    if (!source || !target) {
      store.apply({ type: "inventory/action-error", message: "That place cannot be addressed." } as never);
      return;
    }
    for (const itemID of itemIDs) {
      const at = source.findIndex((r) => r.itemID === itemID);
      if (at === -1) continue;
      const moving = source[at]!;
      if (qty !== null && qty < moving.quantity) {
        source[at] = { ...moving, quantity: moving.quantity - qty };
        target.push({ ...moving, itemID: (nextItemID += 1), quantity: qty });
      } else {
        source.splice(at, 1);
        target.push(moving);
      }
    }
    reprice();
    push();
    if (from.kind === "container" || to.kind === "container") pushContainer();
    store.apply({
      type: "inventory/outcome",
      outcome: { applied: true, message: `Moved ${itemIDs.length === 1 ? "1 stack" : `${itemIDs.length} stacks`}.` },
    } as never);
  },
  async trashItems(itemIDs: readonly number[], from: InventoryPlace): Promise<void> {
    log(`trashItems(${itemIDs.length} × ${place(from)})`);
    const source = bucket(from);
    if (source) {
      for (const itemID of itemIDs) {
        const at = source.findIndex((r) => r.itemID === itemID);
        if (at !== -1) source.splice(at, 1);
      }
    }
    reprice();
    push();
  },
  async mergeStacks(sourceID: number, destinationID: number, at: InventoryPlace): Promise<void> {
    log(`mergeStacks(-> ${place(at)})`);
    const rows = bucket(at);
    if (!rows) return;
    const a = rows.findIndex((r) => r.itemID === sourceID);
    const b = rows.findIndex((r) => r.itemID === destinationID);
    if (a === -1 || b === -1) return;
    rows[b] = { ...rows[b]!, quantity: rows[b]!.quantity + rows[a]!.quantity };
    rows.splice(a, 1);
    push();
  },
  async stackContainer(which: string): Promise<void> { log(`stackContainer("${which}")`); },
  async boardShip(itemID: number): Promise<void> {
    log(`boardShip(a hull)`);
    world.activeShipID = itemID;
    world.openShipID = itemID;
    push();
  },
  async boardCorvette(): Promise<void> { log("boardCorvette()"); },
  async leaveShip(): Promise<void> { log("leaveShip()"); },
  async quoteShipRepair(): Promise<readonly { itemID: number; cost: number | null }[]> {
    log("quoteShipRepair()");
    return [{ itemID: PROCURER, cost: 120450.5 }];
  },
  async repairShip(): Promise<void> { log("repairShip() — the wallet is charged"); },
  async releaseSession(): Promise<void> { log("releaseSession()"); },
  async logout(): Promise<void> { log("logout()"); },
} as unknown as AppFlow;

// --- the world, once, before the panel is mounted ---------------------------

store.apply({ type: "session/logged-in", accountID: 1, username: "harness" } as never);
store.apply({
  type: "character/online",
  character: {
    characterID: 90000001,
    characterName: "Test Pilot",
    stationID: STATION_ID,
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
store.apply({
  type: "station/guests",
  guests: [
    { characterID: 90000001, corporationID: 1000001, allianceID: null, warFactionID: null },
    { characterID: 90000002, corporationID: 1000002, allianceID: 99000001, warFactionID: null },
    { characterID: 90000003, corporationID: 1000002, allianceID: 99000001, warFactionID: null },
  ],
} as never);
store.apply({
  type: "names/resolved",
  entries: {
    ...Object.fromEntries(TYPES.map(([id, name]) => [`type:${id}`, name])),
    "type:1531": "Caldari Reprocessing Plant",
    "owner:1000035": "Caldari Navy",
    "character:90000002": "Another Pilot",
    "character:90000003": "Third Pilot",
    "corporation:1000001": "Home Corporation",
    "corporation:1000002": "Some Corporation",
    "alliance:99000001": "An Alliance",
  },
} as never);
push();

// --- mount, and the width control -------------------------------------------

const host = document.getElementById("panel");
let expanded = false;
if (host) {
  mount(StationPanel, {
    target: host,
    props: {
      store,
      flow,
      get expanded() {
        return expanded;
      },
      onCollapse: () => log("onCollapse() — the shell would fold the panel away"),
      onToggleExpand: () => {
        expanded = !expanded;
        log(`onToggleExpand() -> ${expanded ? "expanded" : "docked"}`);
      },
    },
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-width]")) {
  button.addEventListener("click", () => {
    const width = button.dataset.width ?? "380";
    const frame = document.getElementById("frame");
    if (frame) frame.style.width = width === "fill" ? "100%" : `${width}px`;
    for (const other of document.querySelectorAll("[data-width]")) other.classList.remove("on");
    button.classList.add("on");
  });
}
