// The inventory panel's MODEL: where a thing may be moved, what a bay is called,
// how full it is in words, and how much of a stack may actually be sent.
//
// ⚠ WHY THIS IS A MODULE AND NOT PRIVATE HELPERS.
//
// `InventoryShip.svelte` is mounted in TWO different situations: as the docked
// right-hand dock panel, and — the part that is easy to miss — as the Neocom's
// floating "Inventory & Ship" window and mobile panel WHILE IN SPACE. The
// station-panel redesign gives the DOCKED case its own component, which leaves
// two panels that must agree about the things below or a stack would move one
// way from one panel and another way from the other.
//
// Everything here is pure: it takes the inventory slice (and, where a name has
// to be resolved, the already-resolved string) and returns data. No store, no
// flow, no DOM — so both panels share one set of rules and the rules are
// testable on their own (`inventoryModel.test.ts`).
//
// THE THREE INVARIANTS THIS MODULE CARRIES, all of which predate it:
//
//   1. ⚠ ABSENT ≠ EMPTY ≠ UNKNOWN. `orderedPresentBays` draws only the bays a
//      hull HAS; `uncheckedShipBays` names the ones nobody could look at. A bay
//      whose contents are `null` is not an empty bay. See ShipBay in
//      store/types.ts — the three-valued `present` is the whole point of it.
//   2. A capacity the ship did not report reads "not known", NEVER 0. A
//      confident "0 of 0 m³" tells the player a bay is unusable when in truth
//      we simply failed to ask.
//   3. THE SERVER JUDGES VALIDITY; this module only ever decides a QUANTITY,
//      and only from numbers the server gave. With an unknown volume or an
//      unread capacity it hands the whole stack over (see bridge/holdFit.ts).

import { divisionLabel } from "../bridge/inventoryShip.ts";
import { presentBays, unreadableBays } from "../bridge/shipBays.ts";
import { holdFreeM3, unitsThatFit } from "../bridge/holdFit.ts";
import type {
  CapacityInfo,
  InventoryItemRow,
  InventoryPlace,
  InventoryState,
  OpenShipState,
  ShipBay,
} from "../store/types.ts";

// --- places -----------------------------------------------------------------

/**
 * Are these the same place? A selection only ever means something inside ONE
 * place, so ticking a row somewhere else has to start a fresh selection — a
 * tick made in the ore hold must never be applied to the drone bay, and one
 * made in the station hangar must never be applied to a corporation division.
 */
export function samePlace(left: InventoryPlace | null, right: InventoryPlace): boolean {
  if (!left || left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "container" && right.kind === "container") {
    return left.itemID === right.itemID;
  }
  if (left.kind === "corp" && right.kind === "corp") {
    return left.division === right.division;
  }
  if (left.kind === "shipBay" && right.kind === "shipBay") {
    return left.bay === right.bay;
  }
  return true;
}

/** A stable string identity for a place — a drop-target highlight key, never shown. */
export function placeKey(place: InventoryPlace): string {
  switch (place.kind) {
    case "shipBay":
      return `shipBay:${place.bay}`;
    case "container":
      return `container:${place.itemID}`;
    case "corp":
      return `corp:${place.division}`;
    default:
      return place.kind;
  }
}

/** The rows currently in a place. An unknown/closed place answers with none. */
export function rowsIn(
  inventory: InventoryState,
  place: InventoryPlace,
): readonly InventoryItemRow[] {
  if (place.kind === "hangar") {
    return inventory.hangar.rows;
  }
  if (place.kind === "cargo") {
    return inventory.cargo.rows;
  }
  if (place.kind === "shipBay") {
    const bay = inventory.openShip?.bays.find((entry) => entry.key === place.bay);
    return bay?.items ?? [];
  }
  if (place.kind === "container") {
    return inventory.container && inventory.container.itemID === place.itemID
      ? inventory.container.rows
      : [];
  }
  const division = inventory.corp.divisions.find((entry) => entry.division === place.division);
  return division ? division.rows : [];
}

/**
 * What a place is CALLED, in the player's words. `containerName` is passed in
 * already resolved because resolving a type name needs the names cache, which
 * is a store concern and not this module's.
 */
export function placeName(
  inventory: InventoryState,
  place: InventoryPlace | null,
  containerName: string,
): string {
  if (!place) {
    return "";
  }
  if (place.kind === "hangar") {
    return "Station hangar";
  }
  if (place.kind === "cargo") {
    return "Ship cargo";
  }
  if (place.kind === "shipBay") {
    const bay = inventory.openShip?.bays.find((entry) => entry.key === place.bay);
    return bay ? bay.label : "Ship bay";
  }
  if (place.kind === "container") {
    return containerName;
  }
  const division = inventory.corp.divisions.find((entry) => entry.division === place.division);
  return `Corporation hangar — ${divisionLabel(place.division, division ? division.name : null)}`;
}

export interface MoveDestination {
  readonly label: string;
  readonly place: InventoryPlace;
}

/**
 * Where a selection made in `current` may be sent.
 *
 * The current place is excluded (moving things to where they already are is a
 * no-op). The ACTIVE ship's specialty holds are offered only once its bays have
 * been read, and cargo is offered on its own, so the bay loop skips it. The
 * corporation divisions appear only when the corporation actually has an office
 * here. The server still judges whether a given type belongs in a given hold;
 * this only offers the destination.
 */
export function moveDestinations(
  inventory: InventoryState,
  current: InventoryPlace | null,
  containerName: string,
  /**
   * Whether the pilot is DOCKED.
   *
   * ⚠ IN SPACE THERE IS NO HANGAR AND NO CORP OFFICE TO MOVE INTO. Both are
   * station storage: reachable only from inside one, and the server refuses
   * either from out on the grid. Offering them would be the silent decline
   * again — a live destination that can only ever bounce the stack back.
   *
   * ⚠ AND THE DEFAULT IS `true` ON PURPOSE. Every caller that existed before
   * this argument was a docked one, so the default has to be the one that
   * leaves them alone; only the in-space caller writes it down.
   */
  docked = true,
): readonly MoveDestination[] {
  const options: MoveDestination[] = [];
  if (docked && !samePlace(current, { kind: "hangar" })) {
    options.push({ label: "Station hangar", place: { kind: "hangar" } });
  }
  if (inventory.activeShipID && !samePlace(current, { kind: "cargo" })) {
    options.push({ label: "Ship cargo", place: { kind: "cargo" } });
  }
  const active = inventory.openShip;
  if (active && active.itemID === inventory.activeShipID) {
    for (const bay of active.bays) {
      if (bay.present !== true || bay.key === "cargo") {
        continue;
      }
      const place: InventoryPlace = { kind: "shipBay", bay: bay.key };
      if (!samePlace(current, place)) {
        options.push({ label: bay.label, place });
      }
    }
  }
  const container = inventory.container;
  if (container && !samePlace(current, { kind: "container", itemID: container.itemID })) {
    options.push({
      label: containerName,
      place: { kind: "container", itemID: container.itemID },
    });
  }
  if (docked && inventory.corp.available) {
    for (const division of inventory.corp.divisions) {
      if (samePlace(current, { kind: "corp", division: division.division })) {
        continue;
      }
      options.push({
        label: divisionLabel(division.division, division.name),
        place: { kind: "corp", division: division.division },
      });
    }
  }
  return options;
}

// --- bays -------------------------------------------------------------------

/**
 * The order a hull's bays are listed in — the ones a player reaches for most
 * (cargo, then the specialised holds), then the rest. A bay not in this list
 * simply sorts to the end; the list decides ORDER, never which bays exist
 * (that is the hull's own truth).
 */
export const BAY_ORDER: readonly string[] = [
  "cargo",
  "shipMaintenance",
  "fuel",
  "fleet",
  "ore",
  "gas",
  "ice",
  "mineral",
  "asteroid",
  "drone",
  "fighter",
  "ammo",
  "salvage",
];

export function bayRank(key: string): number {
  const index = BAY_ORDER.indexOf(key);
  return index === -1 ? BAY_ORDER.length : index;
}

/** The bays this hull actually HAS, in reading order. Only these are drawn. */
export function orderedPresentBays(openShip: OpenShipState | null): readonly ShipBay[] {
  return openShip
    ? [...presentBays(openShip.bays)].sort((a, b) => bayRank(a.key) - bayRank(b.key))
    : [];
}

/**
 * Bays nobody could CHECK. ⚠ These must be named out loud: without them, a hull
 * whose ore hold failed to read looks exactly like a hull that HAS no ore hold,
 * and the player believes a bay does not exist when in truth nobody looked.
 */
export function uncheckedShipBays(openShip: OpenShipState | null): readonly ShipBay[] {
  return openShip ? unreadableBays(openShip.bays) : [];
}

/**
 * The place descriptor that addresses a bay as a transfer source. The cargo
 * hold keeps its own long-standing "cargo" place; every other bay is a
 * "shipBay" named by its key. The flag behind the key never leaves the BFF.
 */
export function bayPlace(bay: ShipBay): InventoryPlace {
  return bay.key === "cargo" ? { kind: "cargo" } : { kind: "shipBay", bay: bay.key };
}

/**
 * Can the player act on what is in this bay?
 *
 * ANY bay of the ACTIVE ship (R51) — the BFF can address a bay by key as a
 * transfer source. There is no addressing for "the ore hold of the ship I am
 * not flying", so a bay on an inactive hull stays read-only and the panel says
 * to board instead.
 */
export function bayIsActionable(
  shipItemID: number,
  bay: ShipBay,
  activeShipID: number | null,
): boolean {
  return shipItemID === activeShipID && bay.present === true;
}

/** The ACTIVE ship's bay by key, or null. Only the ship you are flying counts. */
export function activeBay(inventory: InventoryState, key: string): ShipBay | null {
  const active = inventory.openShip;
  if (!active || active.itemID !== inventory.activeShipID) {
    return null;
  }
  return active.bays.find((bay) => bay.key === key) ?? null;
}

// --- rows -------------------------------------------------------------------

export const CATEGORY_SHIP = 6;

export function isShipRow(row: InventoryItemRow): boolean {
  return row.categoryID === CATEGORY_SHIP;
}

/**
 * The active ship's TYPE, so its header can name the hull. The active ship sits
 * in the hangar (docked) or cargo rows as the row whose itemID is the active
 * ship; null when it is in neither.
 */
export function activeShipTypeID(inventory: InventoryState): number | null {
  const id = inventory.activeShipID;
  if (id === null) {
    return null;
  }
  const row =
    inventory.hangar.rows.find((r) => r.itemID === id) ??
    inventory.cargo.rows.find((r) => r.itemID === id);
  return row ? row.typeID : null;
}

/**
 * Every hull the player owns HERE, plus the one they are flying.
 *
 * The active ship is normally a hangar row while docked, but a player IN SPACE
 * has no station hangar to read — so when the active ship is not among the
 * hangar rows it is added from what the slice does know. Otherwise the one ship
 * they are definitely in would be the one ship they could not open.
 */
export function shipRows(inventory: InventoryState): readonly InventoryItemRow[] {
  const rows = inventory.hangar.rows.filter(isShipRow);
  const activeID = inventory.activeShipID;
  if (activeID !== null && !rows.some((row) => row.itemID === activeID)) {
    rows.unshift({
      itemID: activeID,
      typeID: activeShipTypeID(inventory) ?? 0,
      groupID: null,
      categoryID: CATEGORY_SHIP,
      flagID: null,
      quantity: 1,
      singleton: true,
    });
  }
  return rows;
}

/** Everything in the station hangar that is NOT a ship. */
export function hangarThings(inventory: InventoryState): readonly InventoryItemRow[] {
  return inventory.hangar.rows.filter((row) => !isShipRow(row));
}

// --- numbers, in words ------------------------------------------------------

export function amount(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * How full a bay is, in words. ⚠ A capacity the ship did not report reads "not
 * known" and NEVER 0 — a confident "0 of 0 m³" would tell the player the bay is
 * unusable when in truth we simply failed to ask.
 */
export function capacityText(capacity: CapacityInfo | null): string {
  if (!capacity) {
    return "not known";
  }
  return `${amount(capacity.used)} of ${amount(capacity.capacity)} m³`;
}

/**
 * Room used in the STATION HANGAR, which has no meaningful limit. eve.js
 * returns a 1,000,000 m³ default for the unmapped hangar flag (R40) — a phantom
 * ceiling, not a real one — so the hangar shows only how much room is USED,
 * with no "of {capacity}" and no gauge to fill toward. This is chosen by WHERE
 * it is rendered, never by sniffing the 1,000,000 value, which is fragile and
 * could legitimately appear elsewhere.
 */
export function roomUsedText(capacity: CapacityInfo | null): string {
  if (!capacity) {
    return "not known";
  }
  return `${amount(capacity.used)} m³`;
}

/** A gauge's fill, clamped. Zero (or unread) capacity means no meaningful bar. */
export function fillPercent(capacity: CapacityInfo | null): number {
  if (!capacity || !(capacity.capacity > 0)) {
    return 0;
  }
  return Math.max(0, Math.min(100, (capacity.used / capacity.capacity) * 100));
}

/** What a row says under its name: an amount, or that the thing is one object. */
export function amountText(row: InventoryItemRow): string {
  return row.singleton ? "assembled" : amount(row.quantity);
}

/**
 * A stack's state, for the column of that name: one assembled object, or a
 * quantity of loose units. There is no third answer — `singleton` is always
 * known, because it comes off the row the server sent.
 */
export function stateText(row: InventoryItemRow): string {
  return row.singleton ? "assembled" : "stack";
}

// --- volume, which is very often NOT KNOWN ----------------------------------
//
// ⚠ READ THIS BEFORE ADDING A VOLUME COLUMN. `InventoryItemRow.volume` is m³
// PER UNIT from the static tables, attached to the hangar and cargo reads —
// and it is ABSENT on ship-bay contents, because that read does not carry it.
// So the panel's m³ columns are empty for every row in every bay, and that is
// the normal case, not an error. Unknown must render as unknown; a 0 there
// would be a number the panel made up.

/** A stack's total m³, or null when the per-unit volume is not known. */
export function totalVolume(row: InventoryItemRow): number | null {
  const unit = row.volume;
  if (unit === null || unit === undefined || !Number.isFinite(unit)) {
    return null;
  }
  return unit * row.quantity;
}

/**
 * The m³ of a whole selection — or null if ANY row's volume is unknown.
 *
 * ⚠ Deliberately all-or-nothing. Summing only the rows we happen to know would
 * put a confident, too-small number in front of a player about to fill a hold.
 */
export function sumVolume(rows: readonly InventoryItemRow[]): number | null {
  let total = 0;
  for (const row of rows) {
    const volume = totalVolume(row);
    if (volume === null) {
      return null;
    }
    total += volume;
  }
  return total;
}

/** An m³ reading in words; "not known" rather than a made-up 0. */
export function volumeText(m3: number | null): string {
  return m3 === null ? "not known" : `${amount(m3)} m³`;
}

/**
 * The words a place's name is generic in: every hull has a "hold" and a "bay",
 * so those are never the distinguishing half of a two-word label.
 */
const GENERIC_PLACE_WORDS = new Set(["hold", "bay"]);

/**
 * A destination's name shortened to ONE word, for the per-row move button on a
 * narrow panel: the distinguishing word, which is the last one unless the last
 * one is generic.
 *
 *   "Ship cargo"    -> "Cargo"      "Ore hold"   -> "Ore"
 *   "Station hangar"-> "Hangar"     "Drone bay"  -> "Drone"
 *
 * ⚠ It is only ever an ABBREVIATION of a name shown in full elsewhere — the
 * button's own `title`, the "▾" menu and the move bar all spell it out. Two
 * places can abbreviate alike; the alternative was "to Station hangar" pushing
 * the quantity column into "123 75", which is a WRONG number rather than a
 * short name.
 */
export function shortLabel(label: string): string {
  const words = label.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length < 2) {
    return label.trim();
  }
  const last = words[words.length - 1]!;
  const pick = GENERIC_PLACE_WORDS.has(last.toLowerCase()) ? words[0]! : last;
  return pick.charAt(0).toUpperCase() + pick.slice(1);
}

/** The same, for a table cell where "not known" is too long: an em dash. */
export function volumeCell(m3: number | null): string {
  return m3 === null ? "—" : amount(m3);
}

/** How much room is left in a hold, in words. "" when there is no known limit. */
export function roomFreeText(capacity: CapacityInfo | null): string {
  const free = holdFreeM3(capacity);
  if (free === null || !capacity || !(capacity.capacity > 0)) {
    return "";
  }
  return `${amount(free)} m³ free of ${amount(capacity.capacity)}`;
}

// --- filtering and sorting --------------------------------------------------

/** Case-insensitive substring on the NAME. A blank filter matches everything. */
export function matchesFilter(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || name.toLowerCase().includes(q);
}

export type SortKey = "name" | "qty" | "vol";

export interface SortOrder {
  readonly key: SortKey;
  /** 1 ascending, -1 descending. */
  readonly dir: 1 | -1;
}

/** Clicking a column: pick it ascending, or flip it if it is already the one. */
export function nextSort(current: SortOrder, key: SortKey): SortOrder {
  return current.key === key ? { key, dir: (current.dir === 1 ? -1 : 1) } : { key, dir: 1 };
}

/**
 * Rows in the order the header asks for. `nameOf` resolves a row's displayed
 * name, which is the store's job, not this module's.
 *
 * ⚠ A row whose volume is UNKNOWN always sorts last, in both directions. It has
 * no place on a scale it is not on, and floating it to the top under "smallest
 * first" would read as "this is the smallest", which is a claim we cannot make.
 */
export function sortInventoryRows(
  rows: readonly InventoryItemRow[],
  order: SortOrder,
  nameOf: (row: InventoryItemRow) => string,
): readonly InventoryItemRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (order.key === "name") {
      return nameOf(a).localeCompare(nameOf(b)) * order.dir;
    }
    if (order.key === "qty") {
      return (a.quantity - b.quantity) * order.dir;
    }
    const left = totalVolume(a);
    const right = totalVolume(b);
    if (left === null || right === null) {
      if (left === right) return 0;
      return left === null ? 1 : -1;
    }
    return (left - right) * order.dir;
  });
  return sorted;
}

// --- moving -----------------------------------------------------------------

/**
 * The typed move quantity, or null for "the whole stack". Blank, zero, negative
 * and nonsense all mean the whole stack — never a silent 0-unit move.
 */
export function parseMoveQuantity(text: string): number | null {
  const parsed = Number(text);
  return text.trim() !== "" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export type MoveQuantity =
  | { readonly kind: "move"; readonly quantity: number | null }
  | { readonly kind: "refused"; readonly message: string };

/**
 * How much of the selection to actually send, and whether to send it at all.
 *
 * Moving a SINGLE stack into a ship hold sends only what fits, so the server is
 * never asked to overflow the hold — which it refuses outright rather than
 * partially filling. A quantity the player TYPED still wins: they asked for a
 * specific amount. Otherwise the fit is computed from the hold's free space and
 * the item's per-unit volume; an unknown volume or an unread capacity yields the
 * whole stack and the server draws the line.
 *
 * `quantity: null` means "the whole stack" — only a PARTIAL move names a number.
 */
export function moveQuantityFor(options: {
  readonly inventory: InventoryState;
  readonly destination: InventoryPlace;
  /** The ticked itemIDs. Its LENGTH is what decides "a single stack". */
  readonly selection: readonly number[];
  /** Those ids resolved back to rows, in the place the tick was made. */
  readonly selectedRows: readonly InventoryItemRow[];
  /** Whatever is in the quantity box, verbatim. */
  readonly typedQuantity: string;
}): MoveQuantity {
  const { inventory, destination, selection, selectedRows, typedQuantity } = options;
  const typed = selection.length === 1 ? parseMoveQuantity(typedQuantity) : null;
  if (destination.kind !== "shipBay" || selection.length !== 1 || typed !== null) {
    return { kind: "move", quantity: typed };
  }
  const row = selectedRows[0];
  if (!row) {
    return { kind: "move", quantity: null };
  }
  const bay = activeBay(inventory, destination.bay);
  const fit = unitsThatFit(row.quantity, row.volume, holdFreeM3(bay?.capacity));
  if (fit <= 0) {
    return { kind: "refused", message: `The ${bay?.label ?? "hold"} has no room for that.` };
  }
  return { kind: "move", quantity: fit < row.quantity ? fit : null };
}

/**
 * Which of two mergeable stacks pours into which: the SMALLER into the larger,
 * which is what dragging one onto the other does in practice. Null unless there
 * are exactly two.
 */
export function mergeOrder(
  rows: readonly InventoryItemRow[],
): { readonly source: InventoryItemRow; readonly destination: InventoryItemRow } | null {
  if (rows.length !== 2) {
    return null;
  }
  const [first, second] = rows as readonly [InventoryItemRow, InventoryItemRow];
  const source = first.quantity <= second.quantity ? first : second;
  return { source, destination: source === first ? second : first };
}

// --- corporation hangar -----------------------------------------------------

/**
 * Whether the character can see anything in a division. The server filters a
 * division the character lacks the role for down to nothing, so an empty read is
 * indistinguishable here from a genuinely empty division — which is why this
 * only ever DIMS the label and never gates the action. If the player tries
 * anyway, the server's own refusal is what they are shown.
 */
export function divisionLooksAccessible(division: {
  readonly rows: readonly InventoryItemRow[];
}): boolean {
  return division.rows.length > 0;
}
