<script lang="ts">
  // Inventory & Ship (goals R3 + R14, recast by R40, retabbed by R60): the
  // docked station hangar, the ships the player owns and what is inside each of
  // their bays, any container they have opened, and the corporation hangar's
  // divisions — all driven through the bound-object bridge. A pure reader of the
  // store's inventory slice; every bind / List / Add / MultiAdd / MultiMerge /
  // TrashItems call lives on the BFF (which holds the bound-object handles) and
  // in app/flow.ts.
  //
  // R60 SORTS THE SAME CONTENT INTO TABS, the way EVE's docked inventory
  // does, so the panel can live in the right-hand dock window without becoming a
  // long scroll:
  //
  //   SHIP INVENTORY   the OPENED ship's bays (defaults to the hull you are
  //                    flying) — Cargo hold, Ship maintenance bay, Fuel bay,
  //                    Fleet hangar, the mining holds, each shown only if the
  //                    hull HAS it, with how full it is and what is inside.
  //   SHIP HANGAR      every hull the player owns. "Open" a ship to see its bays
  //                    in the Ship Inventory tab; "Board" to fly it.
  //   ITEM HANGAR      everything in the station hangar that is not a ship, as a
  //                    grid of pictures captioned with the name and the amount,
  //                    plus any open container.
  //   CORPORATE HANGAR the corporation's divisions at this station.
  //   STATION SERVICES (docked only) the station's owner/type/security, the
  //                    docked ship actions (Board your corvette / Leave ship),
  //                    and the guest list — folded in here so the station never
  //                    duplicates itself into a separate panel (the dock frame
  //                    and workspace header already carry its name/system).
  //
  // The panels are ALL rendered and the inactive ones carry `hidden`, so a
  // selection made in one is never lost by switching tabs and nothing remounts.
  //
  // A BAY IS AN INVENTORY FLAG, the same mechanism R12's fitting window uses for
  // slots. The flag numbers never reach this file — the BFF enumerates the bays
  // and hands over a label per bay (R7d/R9a). This file has no idea 134 exists,
  // exactly as it has no idea 4, 5 or 115-121 do.
  //
  // ABSENT IS NOT EMPTY. A hull that has no ore hold, a hull whose ore hold we
  // could not read, and an ore hold that is genuinely empty are three different
  // states and are drawn three different ways. Collapsing them is the mistake
  // `worldHasNoContracts` exists to prevent.
  import { onMount } from "svelte";
  import {
    canMergeStacks,
    divisionLabel,
    isBoardableShip,
    isOpenableContainer,
  } from "../bridge/inventoryShip.ts";
  import { presentBays, unreadableBays } from "../bridge/shipBays.ts";
  import { holdFreeM3, unitsThatFit } from "../bridge/holdFit.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  // R27 — the shared item icon: one cached picture per thing, falling back
  // to a name-derived tile whenever the icon cache has no entry (or no cache).
  import TypeIcon from "./TypeIcon.svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type {
    CapacityInfo,
    InventoryItemRow,
    InventoryPlace,
    ShipBay,
  } from "../store/types.ts";
  // R78 — drag and drop between containers. The RULES live in a pure module: a
  // target that decides what it accepts inside `dragover` can only be checked by
  // dragging onto it, and `dragover` is also what tells the cursor whether a drop
  // is allowed — so a rule written there can promise a drop that is then refused.
  import {
    DRAG_MIME,
    carriesOurPayload,
    decodeDrag,
    dropOnPlaceVerdict,
    encodeDrag,
    type DragPayload,
  } from "./dragDrop.ts";
  import { resolvedName, nameKey, type NameKind, type NameRef } from "../store/names.ts";
  import { deriveDocked } from "./tabs.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { repairQuoteTotal, type RepairQuoteRow } from "../bridge/repairQuotes.ts";
  import { formatIsk } from "./isk.ts";

  let {
    store,
    flow,
    dock = false,
    ping = 0,
  }: {
    store: ClientStore;
    flow: AppFlow;
    /**
     * Rendered inside the right-hand dock window (R60): the dock frame supplies
     * the title (the station name), so the panel drops its own big header and
     * lays its controls out compactly.
     */
    dock?: boolean;
    /**
     * Bumped by the workspace when the Neocom's "Inventory & Ship" is picked
     * while docked — snap to the Ship Inventory tab so the pick visibly
     * responds even when this panel was already on screen (e.g. sitting on
     * the Station Services tab). 0 = never picked; never fires on mount.
     */
    ping?: number;
  } = $props();

  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // The Station Services tab reads the station slice (services bits + guests);
  // the flight slice tells us whether we are docked at all.
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // The repair shop quotes the ACTIVE HULL and everything fitted to it, so a
  // quoted module's type comes from the fit (the hull's from its hangar row).
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;

  let busy = $state(false);
  let error = $state("");
  let moveQty = $state("");
  // Which place the current tick-selection was made in. A selection only ever
  // means something inside one place, so ticking a row somewhere else starts a
  // fresh selection rather than mixing two.
  let selectionPlace = $state<InventoryPlace | null>(null);
  // The two-step confirm in front of the destroy. Trashing is irreversible, so
  // the first press only arms it; the BFF then demands its own explicit
  // confirmation flag behind that.
  let trashArmed = $state(false);

  // --- R60 the tabs ---------------------------------------------------------

  type InvTab = "shipInventory" | "shipHangar" | "itemHangar" | "corp" | "station";
  let activeTab = $state<InvTab>("shipInventory");
  const TABS: readonly { readonly id: InvTab; readonly label: string }[] = [
    { id: "shipInventory", label: "Ship Inventory" },
    { id: "shipHangar", label: "Ship Hangar" },
    { id: "itemHangar", label: "Item Hangar" },
    { id: "corp", label: "Corporate Hangar" },
    { id: "station", label: "Station Services" },
  ];

  // Station Services only means something while docked; in space the tab is
  // dropped from the strip (and an active selection of it falls back).
  const isDockedNow = $derived(deriveDocked($flight.status, $station.online));
  const visibleTabs = $derived(isDockedNow ? TABS : TABS.filter((tab) => tab.id !== "station"));
  $effect(() => {
    if (!isDockedNow && activeTab === "station") {
      activeTab = "shipInventory";
    }
  });

  // The Neocom pick's visible response (see the `ping` prop).
  $effect(() => {
    if (ping > 0) {
      activeTab = "shipInventory";
    }
  });

  /**
   * The order the Ship Inventory tab lists a hull's bays in — the ones a player
   * reaches for most (cargo, then the specialised holds the user asked to see
   * first), then the rest. A bay not in this list simply sorts to the end; the
   * list decides ORDER, never which bays exist (that is the hull's own truth).
   */
  const BAY_ORDER: readonly string[] = [
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

  function bayRank(key: string): number {
    const index = BAY_ORDER.indexOf(key);
    return index === -1 ? BAY_ORDER.length : index;
  }

  const CATEGORY_SHIP = 6;

  function isShip(row: InventoryItemRow): boolean {
    return row.categoryID === CATEGORY_SHIP;
  }

  // R7c — resolve every row's typeID -> type name and categoryID -> category
  // name (batched + cached by the flow's name cache). Fire-and-forget in an
  // effect so rows render immediately and swap to names as they arrive.
  $effect(() => {
    const refs: NameRef[] = [];
    const openShip = $inventory.openShip;
    const everyRow = [
      ...$inventory.hangar.rows,
      ...$inventory.cargo.rows,
      ...($inventory.container ? $inventory.container.rows : []),
      ...$inventory.corp.divisions.flatMap((division) => division.rows),
      // R40 — the things inside the open ship's bays need names too, or the
      // grid captions them all "—".
      ...(openShip ? openShip.bays.flatMap((bay) => bay.items ?? []) : []),
    ];
    for (const row of everyRow) {
      refs.push({ kind: "type", id: row.typeID });
      if (row.categoryID) {
        refs.push({ kind: "category", id: row.categoryID });
      }
    }
    if ($inventory.container) {
      refs.push({ kind: "type", id: $inventory.container.typeID });
    }
    if (openShip && openShip.typeID > 0) {
      refs.push({ kind: "type", id: openShip.typeID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // R7c for the Station Services tab — the station owner (corp/faction), the
  // services-row station type, and each guest's character/corp/alliance.
  // Batched + cached by the flow; fire-and-forget like the row names above.
  $effect(() => {
    if (!isDockedNow) {
      return;
    }
    const refs: NameRef[] = [];
    const bits = $station.bits;
    if (bits) {
      if (bits.ownerID) {
        refs.push({ kind: "owner", id: bits.ownerID });
      }
      if (bits.stationTypeID) {
        refs.push({ kind: "type", id: bits.stationTypeID });
      }
    }
    for (const guest of $station.guests) {
      refs.push({ kind: "character", id: guest.characterID });
      if (guest.corporationID) {
        refs.push({ kind: "corporation", id: guest.corporationID });
      }
      if (guest.allianceID) {
        refs.push({ kind: "alliance", id: guest.allianceID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // A name-only cell (R7d): the resolved name, or "—" while it resolves / when
  // it has no static name. The raw ID is never rendered.
  function nameOnly(id: number | null, kind: NameKind): string {
    return resolvedName($names.resolved, kind, id, "—");
  }

  // The active ship's typeID (it sits in the hangar/cargo rows as the row whose
  // itemID is the active ship), so its header can show the SHIP TYPE name.
  const activeShipTypeID = $derived.by<number | null>(() => {
    const id = $inventory.activeShipID;
    if (id === null) {
      return null;
    }
    const row =
      $inventory.hangar.rows.find((r) => r.itemID === id) ??
      $inventory.cargo.rows.find((r) => r.itemID === id);
    return row ? row.typeID : null;
  });

  function typeName(typeID: number | null): string {
    if (typeID === null || typeID <= 0) {
      return "your ship";
    }
    return $names.resolved[nameKey("type", typeID)] ?? "your ship";
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error =
          panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  // --- The station repair shop (R2 station services) ------------------------
  //
  // Unlike the two ship swaps beside it, a repair COSTS ISK, so it is two
  // presses: "Repair ship" only asks the shop for a quote, and the charge waits
  // for a second press that names the price. The shop decides what is damaged —
  // this panel never judges a hitpoint total — and only the items it quoted can
  // be paid for.
  //
  // `repairQuote` is null until the shop has been asked; `repairNote` carries
  // the answers that are not a list of damage.
  let repairQuote = $state<readonly RepairQuoteRow[] | null>(null);
  let repairNote = $state("");
  /** The hull the standing quote was raised against — see the effect below. */
  let quotedShipID = $state<number | null>(null);

  // A quote names ITEM IDS on one hull. Board another ship (or leave into the
  // capsule) and those ids are no longer what is in front of the player, so the
  // standing quote is dropped rather than left there to be paid for.
  $effect(() => {
    if (repairQuote !== null && $inventory.activeShipID !== quotedShipID) {
      repairQuote = null;
      repairNote = "";
    }
  });

  const repairTotal = $derived(repairQuote === null ? null : repairQuoteTotal(repairQuote));

  /** A quoted item's typeID: a fitted module from the fit, the hull from its row. */
  function quotedTypeID(itemID: number): number | null {
    for (const slot of $fitting.slots) {
      if (slot.module !== null && slot.module.itemID === itemID) {
        return slot.module.typeID;
      }
    }
    const row =
      $inventory.hangar.rows.find((r) => r.itemID === itemID) ??
      $inventory.cargo.rows.find((r) => r.itemID === itemID);
    return row ? row.typeID : null;
  }

  // R7d — a quoted item renders as its type NAME; its item id is never shown.
  $effect(() => {
    const refs: NameRef[] = [];
    for (const row of repairQuote ?? []) {
      const typeID = quotedTypeID(row.itemID);
      if (typeID !== null) {
        refs.push({ kind: "type", id: typeID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  function quotedName(itemID: number): string {
    const typeID = quotedTypeID(itemID);
    return typeID === null ? "Something on your ship" : nameOnly(typeID, "type");
  }

  /** Ask the shop what is damaged. Null = there is no hull to quote yet. */
  async function askRepairQuote(): Promise<void> {
    const rows = await flow.quoteShipRepair();
    quotedShipID = store.inventory.get().activeShipID;
    repairQuote = rows;
    repairNote =
      rows === null
        ? "There is no ship to repair — board one first."
        : rows.length === 0
          ? "The repair shop finds nothing damaged."
          : "";
  }

  /** Pay for exactly the quoted items, then re-ask so the answer is the shop's. */
  async function payRepairQuote(rows: readonly RepairQuoteRow[]): Promise<void> {
    await flow.repairShip(rows.map((row) => row.itemID));
    await askRepairQuote();
  }

  function qtyArg(): number | null {
    const parsed = Number(moveQty);
    return moveQty.trim() !== "" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }

  onMount(() => {
    void run(async () => {
      await flow.loadInventory();
      await flow.loadCorpHangar();
      // Open the ACTIVE ship's holds up front, so the Ship Inventory tab shows
      // what you are flying without the player having to pick a ship by hand.
      const activeID = store.inventory.get().activeShipID;
      if (activeID !== null) {
        await flow.openShipBays(activeID).catch(() => {});
      }
    });
  });

  function amount(value: number): string {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  /**
   * How full a bay is, in words. A capacity the ship did not report reads "not
   * known" and NEVER 0 — a confident "0 of 0 m³" would tell the player the bay
   * is unusable when in truth we simply failed to ask.
   */
  function capacityText(capacity: CapacityInfo | null): string {
    if (!capacity) {
      return "not known";
    }
    return `${amount(capacity.used)} of ${amount(capacity.capacity)} m³`;
  }

  /**
   * Room used in the STATION HANGAR, which has no meaningful limit. eve.js
   * returns a 1,000,000 m³ default for the unmapped hangar flag (R40) — a
   * phantom ceiling, not a real one — so the hangar shows only how much room is
   * used, with no "of {capacity}" and no gauge to fill toward. This is chosen by
   * WHERE it is rendered (the station-hangar card), never by sniffing the
   * 1,000,000 value, which is fragile and could legitimately appear elsewhere.
   * Ship bays with a real finite capacity keep `capacityText` and their gauge.
   */
  function roomUsedText(capacity: CapacityInfo | null): string {
    if (!capacity) {
      return "not known";
    }
    return `${amount(capacity.used)} m³`;
  }

  /** The gauge's fill, clamped. Zero capacity means no meaningful bar. */
  function fillPercent(capacity: CapacityInfo | null): number {
    if (!capacity || !(capacity.capacity > 0)) {
      return 0;
    }
    return Math.max(0, Math.min(100, (capacity.used / capacity.capacity) * 100));
  }

  /** What a tile says under the name: an amount, or that the thing is one object. */
  function amountText(row: InventoryItemRow): string {
    return row.singleton ? "assembled" : amount(row.quantity);
  }

  // --- selection ------------------------------------------------------------

  function samePlace(left: InventoryPlace | null, right: InventoryPlace): boolean {
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
      // A tick made in the ore hold must not be treated as a tick in the drone
      // bay: each bay is its own place.
      return left.bay === right.bay;
    }
    return true;
  }

  function toggle(row: InventoryItemRow, place: InventoryPlace): void {
    if (!samePlace(selectionPlace, place)) {
      // Ticking in a new place starts over — a tick made in the hangar must
      // never be applied to a corporation division.
      flow.clearSelection();
      selectionPlace = place;
      flow.toggleSelection(row.itemID);
      trashArmed = false;
      return;
    }
    flow.toggleSelection(row.itemID);
    trashArmed = false;
  }

  function isPicked(row: InventoryItemRow, place: InventoryPlace): boolean {
    return samePlace(selectionPlace, place) && selection.includes(row.itemID);
  }

  const selection = $derived($inventory.selection);
  const selectedCount = $derived(selection.length);

  // Every row currently ticked, resolved back to its row so the bulk bar can
  // reason about types (for the merge offer).
  const selectedRows = $derived.by<InventoryItemRow[]>(() => {
    const place = selectionPlace;
    if (!place) {
      return [];
    }
    return rowsOf(place).filter((row) => selection.includes(row.itemID));
  });

  function rowsOf(place: InventoryPlace): readonly InventoryItemRow[] {
    if (place.kind === "hangar") {
      return $inventory.hangar.rows;
    }
    if (place.kind === "cargo") {
      return $inventory.cargo.rows;
    }
    if (place.kind === "shipBay") {
      const bay = $inventory.openShip?.bays.find((entry) => entry.key === place.bay);
      return bay?.items ?? [];
    }
    if (place.kind === "container") {
      return $inventory.container && $inventory.container.itemID === place.itemID
        ? $inventory.container.rows
        : [];
    }
    const division = $inventory.corp.divisions.find((entry) => entry.division === place.division);
    return division ? division.rows : [];
  }

  // Exactly two same-type loose stacks in one place can be re-merged.
  const mergeable = $derived.by<boolean>(
    () =>
      selectedRows.length === 2 && canMergeStacks(selectedRows[0]!, selectedRows[1]!),
  );

  function placeName(place: InventoryPlace | null): string {
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
      const bay = $inventory.openShip?.bays.find((entry) => entry.key === place.bay);
      return bay ? bay.label : "Ship bay";
    }
    if (place.kind === "container") {
      return containerName();
    }
    const division = $inventory.corp.divisions.find((entry) => entry.division === place.division);
    return `Corporation hangar — ${divisionLabel(place.division, division ? division.name : null)}`;
  }

  function containerName(): string {
    const container = $inventory.container;
    if (!container) {
      return "Container";
    }
    return resolvedName($names.resolved, "type", container.typeID) || "Container";
  }

  // --- bulk destinations ----------------------------------------------------

  // Where a selection may be sent. The current place is excluded (moving items
  // to where they already are is a no-op), and the corporation divisions only
  // appear when the corporation actually has an office here.
  const destinations = $derived.by<{ label: string; place: InventoryPlace }[]>(() => {
    const options: { label: string; place: InventoryPlace }[] = [];
    const current = selectionPlace;
    if (!samePlace(current, { kind: "hangar" })) {
      options.push({ label: "Station hangar", place: { kind: "hangar" } });
    }
    if ($inventory.activeShipID && !samePlace(current, { kind: "cargo" })) {
      options.push({ label: "Ship cargo", place: { kind: "cargo" } });
    }
    // The ACTIVE ship's specialty holds (Ore hold, etc.) — a valid move target
    // only for the ship you are flying, and only once its bays have been read.
    // Cargo is already offered above, so it is skipped here. The server still
    // judges whether a given type belongs in a given hold; this only offers the
    // destination and (below) sends the amount that fits.
    const active = $inventory.openShip;
    if (active && active.itemID === $inventory.activeShipID) {
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
    const container = $inventory.container;
    if (container && !samePlace(current, { kind: "container", itemID: container.itemID })) {
      options.push({
        label: containerName(),
        place: { kind: "container", itemID: container.itemID },
      });
    }
    if ($inventory.corp.available) {
      for (const division of $inventory.corp.divisions) {
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
  });

  /** The active ship's bay by key, or null (only the ship you're flying counts). */
  function activeBayByKey(key: string): ShipBay | null {
    const active = $inventory.openShip;
    if (!active || active.itemID !== $inventory.activeShipID) {
      return null;
    }
    return active.bays.find((bay) => bay.key === key) ?? null;
  }

  // --- R78: dragging items between containers -------------------------------
  //
  // ⚠ AN ACCELERATOR, NOT A REPLACEMENT. Tick-then-"Move to" is untouched and
  // remains the keyboard path; dragging is what a player from the retail client
  // reaches for first.
  //
  // A drag reuses the SELECTION rather than carrying its own item list, so the
  // drop goes through `moveSelectionTo` — which already works out how much of a
  // stack fits a ship hold from its free space and the item's per-unit volume.
  // A drag that moved items by its own path would quietly lose that.

  /** The container the pointer is over, so it can light up mid-drag. */
  let dropPlaceKey = $state<string | null>(null);
  function placeKey(place: InventoryPlace): string {
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

  function startTileDrag(event: DragEvent, row: InventoryItemRow, place: InventoryPlace): void {
    // Dragging something that is not ticked makes it the selection, so what you
    // drag is what moves. Dragging one of several ticked rows keeps them all —
    // which is the behaviour a player expects from a multi-selection anywhere.
    if (!isPicked(row, place)) {
      flow.clearSelection();
      selectionPlace = place;
      flow.toggleSelection(row.itemID);
      trashArmed = false;
    }
    const payload: DragPayload = {
      kind: "inventoryItem",
      itemID: row.itemID,
      typeID: row.typeID,
      from: place,
    };
    event.dataTransfer?.setData(DRAG_MIME, encodeDrag(payload));
    event.dataTransfer?.setData("text/plain", resolvedName($names.resolved, "type", row.typeID));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  }

  function overPlace(event: DragEvent, place: InventoryPlace): void {
    if (!carriesOurPayload(event.dataTransfer?.types as string[] | undefined)) {
      return;
    }
    // preventDefault is what MAKES an element a drop target; without it the
    // browser refuses the drop and shows the "no entry" cursor.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    dropPlaceKey = placeKey(place);
  }

  function dropOnPlace(event: DragEvent, place: InventoryPlace): void {
    dropPlaceKey = null;
    event.preventDefault();
    const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? null);
    const verdict = dropOnPlaceVerdict(payload, place);
    if (verdict !== null) {
      // Refused, and SAID — through the panel's own error line, so a rejected
      // drop reads the same way a rejected click does.
      error = verdict;
      return;
    }
    void moveSelectionTo(place);
  }

  async function moveSelectionTo(destination: InventoryPlace): Promise<void> {
    const from = selectionPlace;
    if (!from || selection.length === 0) {
      return;
    }
    let qty = selection.length === 1 ? qtyArg() : null;
    // Moving a SINGLE stack into a ship hold: send only what fits, so the server
    // is never asked to overflow the hold (which it refuses outright rather than
    // partially filling). A quantity the player TYPED still wins — they asked for
    // a specific amount; otherwise we compute the fit from the hold's free space
    // and the item's per-unit volume. Unknown volume/capacity → whole stack, and
    // the server draws the line.
    if (destination.kind === "shipBay" && selection.length === 1 && qty === null) {
      const row = selectedRows[0];
      const bay = activeBayByKey(destination.bay);
      if (row) {
        const fit = unitsThatFit(row.quantity, row.volume, holdFreeM3(bay?.capacity));
        if (fit <= 0) {
          error = `The ${bay?.label ?? "hold"} has no room for that.`;
          return;
        }
        // Only send a quantity for a PARTIAL move; the whole stack keeps qty null.
        qty = fit < row.quantity ? fit : null;
      }
    }
    await run(async () => {
      await flow.transferItems([...selection], from, destination, qty);
      selectionPlace = null;
    });
  }

  async function mergeSelection(): Promise<void> {
    const place = selectionPlace;
    if (!place || selectedRows.length !== 2) {
      return;
    }
    // Merge the SMALLER stack into the larger one, which is what dragging one
    // onto the other does in practice.
    const [first, second] = selectedRows;
    const source = first!.quantity <= second!.quantity ? first! : second!;
    const destination = source === first! ? second! : first!;
    await run(async () => {
      await flow.mergeStacks(source.itemID, destination.itemID, place);
      selectionPlace = null;
    });
  }

  async function trashSelection(): Promise<void> {
    const place = selectionPlace;
    if (!place || selection.length === 0) {
      return;
    }
    await run(async () => {
      await flow.trashItems([...selection], place);
      selectionPlace = null;
      trashArmed = false;
    });
  }

  // --- R40 the ships --------------------------------------------------------

  /**
   * Every hull the player owns HERE, plus the one they are flying.
   *
   * The active ship is normally a hangar row while docked, but a player in
   * space has no station hangar to read — so when the active ship is not among
   * the hangar rows it is added from what the slice does know. Otherwise the
   * one ship they are definitely in would be the one ship they could not open.
   */
  const ships = $derived.by<InventoryItemRow[]>(() => {
    const rows = $inventory.hangar.rows.filter(isShip);
    const activeID = $inventory.activeShipID;
    if (activeID !== null && !rows.some((row) => row.itemID === activeID)) {
      rows.unshift({
        itemID: activeID,
        typeID: activeShipTypeID ?? 0,
        groupID: null,
        categoryID: CATEGORY_SHIP,
        flagID: null,
        quantity: 1,
        singleton: true,
      });
    }
    return rows;
  });

  /** Everything in the hangar that is NOT a ship — the Item Hangar tab. */
  const hangarThings = $derived($inventory.hangar.rows.filter((row) => !isShip(row)));

  const openShip = $derived($inventory.openShip);

  /** The bays this hull actually has, in the tab's reading order. Only these are drawn. */
  const shownBays = $derived.by<readonly ShipBay[]>(() =>
    openShip
      ? [...presentBays(openShip.bays)].sort((a, b) => bayRank(a.key) - bayRank(b.key))
      : [],
  );

  /**
   * Bays we could not READ. These are named out loud: without them, a hull
   * whose ore hold failed to read would look exactly like a hull that has no
   * ore hold, and the player would believe a bay does not exist when in fact
   * nobody managed to look.
   */
  const uncheckedBays = $derived.by<readonly ShipBay[]>(() =>
    openShip ? unreadableBays(openShip.bays) : [],
  );

  /**
   * Open a hull's bays and jump to the Ship Inventory tab. This is how the Ship
   * Hangar tab hands a ship over to Ship Inventory, which keeps "the bays I am
   * looking at" as ONE piece of state (`openShip`) rather than two tabs fighting
   * over it.
   */
  function openInInventory(row: InventoryItemRow): void {
    activeTab = "shipInventory";
    void run(() => flow.openShipBays(row.itemID));
  }

  /**
   * Can the player act on what is in this bay from here?
   *
   * ANY bay of the ACTIVE ship (R51). The BFF can now address a bay by its key
   * as a transfer source — the ore hold, the drone bay and the cargo hold are
   * all valid sources — so a stack in any of them can be moved into the station
   * hangar. There is still no addressing for "the ore hold of the ship I am not
   * flying" (it has no source location), so a bay on an inactive hull stays
   * read-only and the card says to board instead.
   */
  function bayIsActionable(shipItemID: number, bay: ShipBay): boolean {
    return shipItemID === $inventory.activeShipID && bay.present === true;
  }

  /**
   * The place descriptor that addresses this bay as a transfer source. The
   * cargo hold keeps its own long-standing "cargo" place; every other bay is a
   * "shipBay" named by its key. The flag behind the key never leaves the BFF.
   */
  function bayPlace(bay: ShipBay): InventoryPlace {
    return bay.key === "cargo" ? { kind: "cargo" } : { kind: "shipBay", bay: bay.key };
  }

  // --- corporation hangar ---------------------------------------------------

  const selectedDivision = $derived(
    $inventory.corp.divisions.find(
      (entry) => entry.division === $inventory.corp.selectedDivision,
    ) ?? null,
  );

  /**
   * Whether the character can see anything in a division. The server filters a
   * division the character lacks the role for down to nothing, so an empty
   * read is indistinguishable here from a genuinely empty division — which is
   * why this only ever DIMS the label and never gates the action. If the player
   * tries anyway, the server's own refusal is what they are shown.
   */
  function divisionLooksAccessible(division: { rows: readonly InventoryItemRow[] }): boolean {
    return division.rows.length > 0;
  }
</script>

<!--
  ONE tile grid, used by every bay, an open container, a corporation division
  and the item hangar. Every place shows the same thing — a picture, the NAME,
  and the AMOUNT underneath (the operator's ask) — so they are one snippet
  rather than copies that drift apart.

  `actions` decides which buttons a tile offers, because what you can do with a
  thing depends on where it is sitting. `readOnly` drops selection and actions
  entirely: that is a bay the bridge gives us no way to act on, and a button
  that cannot work must not be drawn.
-->
{#snippet itemGrid(
  rows: readonly InventoryItemRow[],
  place: InventoryPlace,
  actions: "toCargo" | "toHangar" | "none",
  readOnly: boolean = false,
)}
  <!-- The grid is the drop target for its own container: drag a tile from one
       hangar onto another's grid to move it. `readOnly` grids (a container you
       are only looking into) do not accept drops. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <ul
    class="item-grid"
    class:drop-target={dropPlaceKey === placeKey(place)}
    ondragover={(event) => !readOnly && overPlace(event, place)}
    ondragleave={() => (dropPlaceKey = null)}
    ondrop={(event) => !readOnly && dropOnPlace(event, place)}
  >
    {#each rows as row (row.itemID)}
      <li
        class="item-tile {isPicked(row, place) ? 'picked' : ''}"
        draggable={readOnly ? "false" : "true"}
        ondragstart={(event) => startTileDrag(event, row, place)}
      >
        <TypeIcon
          typeID={row.typeID}
          name={resolvedName($names.resolved, "type", row.typeID)}
          size="lg"
        />
        <span class="item-tile-name">{resolvedName($names.resolved, "type", row.typeID)}</span>
        <span class="item-tile-amount">{amountText(row)}</span>
        {#if !readOnly}
          <label class="item-tile-pick">
            <input
              type="checkbox"
              aria-label="Select {resolvedName($names.resolved, 'type', row.typeID)}"
              checked={isPicked(row, place)}
              disabled={busy}
              onchange={() => toggle(row, place)}
            />
            Select
          </label>
          <span class="item-tile-actions">
            {#if isOpenableContainer(row)}
              <button
                type="button"
                disabled={busy}
                onclick={() => run(() => flow.openContainer(row.itemID))}
              >
                Open
              </button>
            {:else if actions === "toCargo"}
              <button
                type="button"
                disabled={busy}
                onclick={() =>
                  run(() =>
                    flow.transferItems([row.itemID], place, { kind: "cargo" }, qtyArg()),
                  )}
              >
                → Cargo
              </button>
            {:else if actions === "toHangar"}
              <button
                type="button"
                disabled={busy}
                onclick={() =>
                  run(() =>
                    flow.transferItems([row.itemID], place, { kind: "hangar" }, qtyArg()),
                  )}
              >
                → Hangar
              </button>
            {/if}
          </span>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<!-- The bays of the OPENED ship — the Ship Inventory tab's body, also reused
     nowhere else. Split out so the tab reads cleanly. -->
{#snippet shipBaysBody()}
  {#if !openShip}
    <p class="note">
      {$inventory.activeShipID
        ? "Opening your ship…"
        : "Pick a ship in the Ship Hangar tab to see its bays."}
    </p>
  {:else}
    <h3>{typeName(openShip.typeID)} — its bays</h3>
    {#if openShip.error}
      <!-- The read failed outright, so NOTHING is known about this hull's bays.
           That is emphatically not "this ship has no bays". -->
      <p class="error">
        This ship's bays could not be read, so we cannot say what it has: {openShip.error}
      </p>
    {:else if !openShip.loaded}
      <p class="empty">Looking inside this ship…</p>
    {:else if shownBays.length === 0}
      <p class="note">
        {uncheckedBays.length > 0
          ? "None of this ship's bays could be read, so we cannot say what it has."
          : "This ship has no bays that can hold anything."}
      </p>
    {:else}
      {#each shownBays as bay (bay.key)}
        <div class="bay">
          <div class="bay-head">
            <strong>{bay.label}</strong>
            <span class={bay.capacity ? "hud-value" : "stat-unavailable"}>
              {capacityText(bay.capacity)}
            </span>
          </div>
          {#if bay.capacity && bay.capacity.capacity > 0}
            <!-- The bar is a summary; the numbers above it are the real reading,
                 so the bar is never the only way to tell how full a bay is. -->
            <div class="hud-track">
              <span class="hud-fill" style="width: {fillPercent(bay.capacity)}%"></span>
            </div>
          {/if}
          {#if bay.error}
            <p class="error">What is in here could not be read: {bay.error}</p>
          {:else if bay.items === null}
            <p class="error">What is in here could not be read.</p>
          {:else if bay.items.length === 0}
            <p class="empty">Nothing in here yet.</p>
          {:else if bayIsActionable(openShip.itemID, bay)}
            {@render itemGrid(bay.items, bayPlace(bay), "toHangar")}
          {:else}
            {@render itemGrid(bay.items, bayPlace(bay), "none", true)}
          {/if}
          {#if bay.key === "cargo" && bayIsActionable(openShip.itemID, bay) && bay.items && bay.items.length > 0}
            <!-- Stack-all is a cargo-hold convenience (`stackContainer` only
                 knows "cargo" and "hangar"); it is not offered for other bays. -->
            <p>
              <button
                type="button"
                class="minor"
                disabled={busy}
                onclick={() => run(() => flow.stackContainer("cargo"))}
              >
                Stack all (cargo)
              </button>
            </p>
          {/if}
        </div>
      {/each}
      {#if openShip.itemID !== $inventory.activeShipID}
        <p class="note">Board this ship to move things in and out of it.</p>
      {/if}
    {/if}
    {#if uncheckedBays.length > 0 && !openShip.error}
      <!-- Named out loud, so a bay we failed to check is never mistaken for a
           bay the hull does not have. -->
      <p class="note">
        These bays could not be checked, so we cannot say whether this ship has them:
        {uncheckedBays.map((bay) => bay.label).join(", ")}.
      </p>
    {/if}
  {/if}
{/snippet}

<div class="inventory-panel" class:dock>
  {#if !dock}
    <section class="panel">
      <header class="panel-head">
        <h2>Inventory &amp; Ship</h2>
      </header>
    </section>
  {/if}

  <div class="inv-controls">
    <label class="inv-qty">
      Move quantity (blank = whole stack):
      <input type="number" min="1" bind:value={moveQty} disabled={busy} />
    </label>
    <button
      type="button"
      class="primary"
      disabled={busy}
      onclick={() =>
        run(async () => {
          await flow.loadInventory();
          await flow.loadCorpHangar();
          if ($inventory.openShip) {
            await flow.openShipBays($inventory.openShip.itemID);
          }
        })}
    >
      Refresh
    </button>
  </div>

  {#if $inventory.lastOutcome}
    <!-- What the server actually did, re-read after the call — not an echo of
         the request. A refusal with no reason says so plainly. -->
    <p class={$inventory.lastOutcome.applied ? "note" : "error"}>
      {$inventory.lastOutcome.message}
    </p>
  {/if}
  {#if $inventory.actionError}
    <p class="error">Last action failed: {$inventory.actionError}</p>
  {/if}
  {#if error}
    <p class="error">{error}</p>
  {/if}

  <!-- The tab bar. Real buttons, so the whole panel is keyboard-reachable. -->
  <div class="inv-tabs" role="tablist" aria-label="Inventory sections">
    {#each visibleTabs as tab (tab.id)}
      <button
        type="button"
        role="tab"
        id="inv-tab-{tab.id}"
        class="inv-tab"
        class:active={activeTab === tab.id}
        aria-selected={activeTab === tab.id}
        aria-controls="inv-panel-{tab.id}"
        onclick={() => (activeTab = tab.id)}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <!-- ===================================================== SHIP INVENTORY -->
  <section
    class="inv-tabpanel"
    role="tabpanel"
    id="inv-panel-shipInventory"
    aria-labelledby="inv-tab-shipInventory"
    hidden={activeTab !== "shipInventory"}
  >
    {@render shipBaysBody()}
  </section>

  <!-- ======================================================== SHIP HANGAR -->
  <section
    class="inv-tabpanel"
    role="tabpanel"
    id="inv-panel-shipHangar"
    aria-labelledby="inv-tab-shipHangar"
    hidden={activeTab !== "shipHangar"}
  >
    <h3>Your ships</h3>
    {#if $inventory.hangar.error}
      <p class="error">Your ships could not be listed: {$inventory.hangar.error}</p>
    {/if}
    {#if ships.length === 0}
      <p class="empty">
        {$inventory.loaded ? "You have no ships here." : "Looking for your ships…"}
      </p>
    {:else}
      <p class="note">Pick a ship to see its bays and what is in them.</p>
      <ul class="item-grid">
        {#each ships as ship (ship.itemID)}
          <li
            class="item-tile {ship.itemID === $inventory.activeShipID ? 'self' : ''} {openShip &&
            openShip.itemID === ship.itemID
              ? 'picked'
              : ''}"
          >
            <TypeIcon
              typeID={ship.typeID}
              name={resolvedName($names.resolved, "type", ship.typeID)}
              size="lg"
            />
            <span class="item-tile-name">{resolvedName($names.resolved, "type", ship.typeID)}</span>
            <span class="item-tile-amount">
              {ship.itemID === $inventory.activeShipID ? "you are flying this" : "docked here"}
            </span>
            <span class="item-tile-actions">
              <button type="button" disabled={busy} onclick={() => openInInventory(ship)}>
                Open
              </button>
              {#if isBoardableShip(ship, $inventory.activeShipID)}
                <button
                  type="button"
                  class="minor"
                  disabled={busy}
                  onclick={() => run(() => flow.boardShip(ship.itemID))}
                >
                  Board
                </button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- ======================================================== ITEM HANGAR -->
  <section
    class="inv-tabpanel"
    role="tabpanel"
    id="inv-panel-itemHangar"
    aria-labelledby="inv-tab-itemHangar"
    hidden={activeTab !== "itemHangar"}
  >
    <h3>
      Hangar inventory
      <!-- A station has no capacity limit: only room USED, never "of {capacity}"
           and never a gauge (R51). -->
      <small class="note">Room used: {roomUsedText($inventory.hangar.capacity)}</small>
    </h3>
    <p>
      <button
        type="button"
        class="minor"
        disabled={busy}
        onclick={() => run(() => flow.stackContainer("hangar"))}
      >
        Stack all (hangar)
      </button>
    </p>
    {#if $inventory.hangar.error}
      <p class="error">The hangar could not be loaded: {$inventory.hangar.error}</p>
    {:else if hangarThings.length === 0}
      <p class="empty">
        {$inventory.loaded ? "Nothing here but your ships." : "Looking through your hangar…"}
      </p>
    {:else}
      {@render itemGrid(hangarThings, { kind: "hangar" }, "toCargo")}
    {/if}

    {#if $inventory.container}
      <div class="inv-container">
        <h3>
          {containerName()}
          <small class="note">room used {capacityText($inventory.container.capacity)}</small>
        </h3>
        <p>
          <button
            type="button"
            class="minor"
            disabled={busy}
            onclick={() => run(() => flow.openContainer(null))}
          >
            ← Back to the hangar
          </button>
        </p>
        {#if $inventory.container.error}
          <p class="error">This container could not be opened: {$inventory.container.error}</p>
        {:else if $inventory.container.rows.length === 0}
          <p class="empty">This container is empty.</p>
        {:else}
          {@render itemGrid(
            $inventory.container.rows,
            { kind: "container", itemID: $inventory.container.itemID },
            "toHangar",
          )}
        {/if}
      </div>
    {/if}
  </section>

  <!-- =================================================== CORPORATE HANGAR -->
  <section
    class="inv-tabpanel"
    role="tabpanel"
    id="inv-panel-corp"
    aria-labelledby="inv-tab-corp"
    hidden={activeTab !== "corp"}
  >
    <h3>Corporation hangar</h3>
    {#if !$inventory.corp.loaded}
      <p class="note">Loading the corporation hangar…</p>
    {:else if !$inventory.corp.available}
      <p class="note">
        {#if $inventory.corp.reason === "NO_CORP_OFFICE"}
          Your corporation has no office at this station.
        {:else}
          The corporation hangar could not be read: {$inventory.corp.reason ?? "unknown reason"}
        {/if}
      </p>
    {:else}
      <p class="controls">
        <label>
          Division:
          <select
            disabled={busy}
            value={$inventory.corp.selectedDivision}
            onchange={(event) =>
              flow.selectCorpDivision(Number((event.currentTarget as HTMLSelectElement).value))}
          >
            {#each $inventory.corp.divisions as division (division.division)}
              <option value={division.division}>
                {divisionLabel(division.division, division.name)}{divisionLooksAccessible(division)
                  ? ""
                  : " (empty or not visible to you)"}
              </option>
            {/each}
          </select>
        </label>
      </p>
      {#if selectedDivision}
        {#if selectedDivision.error}
          <p class="error">This division could not be read: {selectedDivision.error}</p>
        {:else if selectedDivision.rows.length === 0}
          <p class="note">
            Nothing here. This division is either empty or your corporation roles do not let
            you see it — the server decides, and it does not say which.
          </p>
        {:else}
          {@render itemGrid(
            selectedDivision.rows,
            { kind: "corp", division: selectedDivision.division },
            "toHangar",
          )}
        {/if}
      {/if}
    {/if}
  </section>

  <!-- ==================================================== STATION SERVICES -->
  <!-- Docked only. The station's name/system live in the dock frame title and
       the workspace header, so this tab carries only what is shown NOWHERE
       else: owner, type, security, the docked ship actions, and the guests. -->
  <section
    class="inv-tabpanel"
    role="tabpanel"
    id="inv-panel-station"
    aria-labelledby="inv-tab-station"
    hidden={activeTab !== "station"}
  >
    <h3>Station services</h3>
    {#if !isDockedNow}
      <p class="note">Dock at a station to use its services.</p>
    {:else}
      {#if $station.bits}
        <dl class="kv">
          <dt>Owner</dt>
          <dd>{nameOnly($station.bits.ownerID, "owner")}</dd>
          <dt>Station type</dt>
          <dd>{nameOnly($station.bits.stationTypeID, "type")}</dd>
          <dt>Security</dt>
          <dd>{$station.station?.security?.toFixed(2) ?? "—"}</dd>
        </dl>
      {:else}
        <p class="note">Loading station services…</p>
      {/if}
      <!-- Ship actions the retail station-services strip offers while docked.
           Both are reversible (the previous hull stays in the hangar), so a
           single busy-guarded press acts; refusals surface in the shared
           "Last action failed" line above the tabs, in the handler's words. -->
      <p class="controls">
        <button type="button" class="minor" disabled={busy} onclick={() => run(() => flow.boardCorvette())}>
          Board your corvette
        </button>
        <button type="button" class="minor" disabled={busy} onclick={() => run(() => flow.leaveShip())}>
          Leave ship — board your capsule
        </button>
        <button type="button" class="minor" disabled={busy} onclick={() => run(() => flow.refreshStationPanel())}>
          Refresh guests
        </button>
      </p>
      <!-- The repair shop. This press only ASKS for the quote; the wallet is
           charged by the priced press that appears with the answer. -->
      <p class="controls">
        <button type="button" class="minor" disabled={busy} onclick={() => run(askRepairQuote)}>
          Repair ship
        </button>
      </p>
      {#if repairQuote !== null && repairQuote.length > 0}
        <div class="table-wrap overflow-x-auto">
          <table class="reflow">
            <thead>
              <tr><th>Damaged</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {#each repairQuote as row (row.itemID)}
                <tr>
                  <td data-label="Damaged">{quotedName(row.itemID)}</td>
                  <td data-label="Cost">{row.cost === null ? "—" : formatIsk(row.cost.toFixed(2))}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="note">
          {#if repairTotal === null}
            The shop did not quote a price; repairing still charges your wallet.
          {:else}
            The station will charge {formatIsk(repairTotal.toFixed(2))}.
          {/if}
        </p>
        <p class="controls">
          <button
            type="button"
            class="primary"
            disabled={busy}
            onclick={() => run(() => payRepairQuote(repairQuote ?? []))}
          >
            Repair {repairQuote.length === 1 ? "it" : `all ${repairQuote.length}`} and pay
          </button>
          <button
            type="button"
            class="minor"
            disabled={busy}
            onclick={() => { repairQuote = null; repairNote = ""; }}
          >
            Cancel
          </button>
        </p>
      {:else if repairNote}
        <p class="note">{repairNote}</p>
      {/if}
      <!-- The session controls moved here with the rest of the old Station
           panel — this tab is the only docked home they had. -->
      <p class="controls">
        <button type="button" class="minor" disabled={busy} onclick={() => run(() => flow.releaseSession())}>
          Go offline
        </button>
        <button type="button" class="minor" disabled={busy} onclick={() => run(() => flow.logout())}>
          Log out
        </button>
      </p>
      {#if $station.readError}
        <p class="error">Some station details could not be loaded: {$station.readError}</p>
      {/if}
      <h3>Guests</h3>
      {#if $station.guests.length === 0}
        <p class="empty">No guests reported yet.</p>
      {:else}
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr><th>Character</th><th>Corporation</th><th>Alliance</th></tr>
            </thead>
            <tbody>
              {#each $station.guests as guest (guest.characterID)}
                <tr class={guest.characterID === $station.online?.characterID ? "self" : ""}>
                  <td data-label="Character">
                    {guest.characterID === $station.online?.characterID
                      ? `${$station.online?.characterName} (you)`
                      : nameOnly(guest.characterID, "character")}
                  </td>
                  <td data-label="Corporation">{nameOnly(guest.corporationID, "corporation")}</td>
                  <td data-label="Alliance">{nameOnly(guest.allianceID, "alliance")}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </section>

  <!-- The move bar sits below the tabs, where a selection made in any of them
       can act on it without scrolling. It shows only when something is ticked. -->
  {#if selectedCount > 0 && selectionPlace}
    <section class="bulk">
      <h2>{selectedCount} selected in {placeName(selectionPlace)}</h2>
      <p class="row-actions">
        {#each destinations as destination (destination.label)}
          <button type="button" disabled={busy} onclick={() => moveSelectionTo(destination.place)}>
            Move to {destination.label}
          </button>
        {/each}
        {#if mergeable}
          <button type="button" class="minor" disabled={busy} onclick={() => mergeSelection()}>
            Merge the two stacks
          </button>
        {/if}
        <button
          type="button"
          class="minor"
          disabled={busy}
          onclick={() => {
            flow.clearSelection();
            selectionPlace = null;
            trashArmed = false;
          }}
        >
          Clear selection
        </button>
      </p>
      <p class="row-actions">
        <!-- Two-step destroy: the first press only arms it. -->
        {#if trashArmed}
          <button type="button" class="danger" disabled={busy} onclick={() => trashSelection()}>
            Destroy {selectedCount} permanently — confirm
          </button>
          <button type="button" class="minor" disabled={busy} onclick={() => (trashArmed = false)}>
            Cancel
          </button>
        {:else}
          <button type="button" class="minor" disabled={busy} onclick={() => (trashArmed = true)}>
            Trash…
          </button>
        {/if}
      </p>
      {#if trashArmed}
        <p class="error">
          Trashing destroys these items permanently. There is no way to get them back.
        </p>
      {/if}
    </section>
  {/if}
</div>
