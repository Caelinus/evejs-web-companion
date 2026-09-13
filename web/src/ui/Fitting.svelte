<script lang="ts">
  // The fitting window, modelled on EVE's own (goals R12 + R21): the active ship
  // inside a circular ring with its slots as SOCKETS on arcs around it, a slim
  // toolbar down the left, the ship's readings in a COLLAPSIBLE panel down the
  // right, and CPU / powergrid / bay / value read-outs along the bottom — the
  // same shape a capsuleer already knows. A list view stays behind the R8
  // breakpoint for a phone.
  //
  // A pure reader of the store's fitting + inventory + dogma slices. All bind /
  // ListByFlags / Add / SetModuleOnline logic lives on the BFF (which holds the
  // bound-object handles) and in app/flow.ts. Slots are addressed by FAMILY and
  // INDEX — no slot flagID, typeID or itemID is ever rendered.
  //
  // THE IRON RULE: every number here is one the SERVER produced (or pure
  // arithmetic over server numbers). A statistic we cannot honestly source
  // renders the word "Unavailable" with its reason on hover — never a 0 and
  // never an empty cell, because a wrong 0 in a fitting window is a claim we are
  // not entitled to make. Clicking a module shows its EFFECTIVE stats — skills,
  // hull bonuses and in-space effects already applied — taken straight from the
  // server's post-dogma map and never recomputed in the browser.
  import { onMount } from "svelte";
  import {
    SLOT_FAMILY_LABELS,
    SLOT_FAMILY_ORDER,
    chargeLooksCompatible,
    isChargeRow,
    isFittableRow,
    slotsOfFamily,
  } from "../bridge/fitting.ts";
  import { OUTER_RADIUS_PERCENT, countByFamily, placeFamily } from "./fittingGeometry.ts";
  import { abbreviate } from "./fittingIcons.ts";
  // R78 — drag and drop. The RULES (what may be dropped where, and why not) live
  // in a pure module, because a target that decides inside `dragover` can only be
  // checked by dragging onto it — and `dragover` is also what tells the cursor
  // whether a drop is allowed, so a rule written there can promise a drop that
  // the drop handler then refuses.
  import {
    DRAG_MIME,
    carriesOurPayload,
    decodeDrag,
    dropOnSocketVerdict,
    encodeDrag,
    type DragPayload,
  } from "./dragDrop.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type {
    FittingResource,
    FittingSlot,
    InventoryItemRow,
    SlotFamily,
  } from "../store/types.ts";
  import { resolvedName, nameKey, type NameRef } from "../store/names.ts";
  import { LAYERS, type LayerName, type Stat, unavailable } from "../bridge/shipStats.ts";
  import { moduleEffectiveStats, type ModuleStat } from "../bridge/moduleAttributes.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let {
    store,
    flow,
    showInventory,
  }: {
    store: ClientStore;
    flow: AppFlow;
    /** Opens the Inventory & Ship panel (where the drone bay lives while docked). */
    showInventory?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;
  // svelte-ignore state_referenced_locally
  const dogma = store.dogma;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  let busy = $state(false);
  let error = $state("");
  /** Which module the player picked to fit, and where it is coming from. */
  let pickedItemID = $state<number | null>(null);
  let pickedSource = $state<"hangar" | "cargo">("hangar");
  /** The rig awaiting an explicit "yes, destroy it" — never a one-click loss. */
  let confirmingRigID = $state<number | null>(null);

  // --- R21 the radial window ------------------------------------------------

  /**
   * Which layout the player is looking at. The default is decided on mount
   * from the viewport (list on a phone, radial above the R8 breakpoint) and
   * then REMEMBERED, so an explicit choice always beats the guess.
   *
   * It starts as "radial" rather than reading the viewport here because this
   * component also renders under the server generator (panelFirstMount), where
   * there is no `window` at all.
   */
  let view = $state<"radial" | "list">("radial");
  const VIEW_STORAGE_KEY = "evejs.fitting.view";

  /** Which socket the player has selected; its actions show beneath the ring. */
  let selected = $state<{ family: SlotFamily; index: number } | null>(null);

  function chooseView(next: "radial" | "list"): void {
    view = next;
    selected = null;
    try {
      globalThis.localStorage?.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // A browser with storage blocked still gets the toggle, just not the
      // memory of it. Never let that break the panel.
    }
  }

  /** The sockets to draw, with each one's placement and what is in it. */
  const sockets = $derived.by(() => {
    const counts = countByFamily($fitting.slots);
    const placed: {
      slot: FittingSlot;
      xPercent: number;
      yPercent: number;
    }[] = [];
    for (const family of SLOT_FAMILY_ORDER) {
      const placements = placeFamily(family, counts[family], OUTER_RADIUS_PERCENT);
      const familySlots = slotsOfFamily($fitting.slots, family);
      for (const placement of placements) {
        const slot = familySlots[placement.index];
        if (slot) {
          placed.push({
            slot,
            xPercent: placement.xPercent,
            yPercent: placement.yPercent,
          });
        }
      }
    }
    return placed;
  });

  /** A key per family for the legend: label, how many, how many filled. */
  const legend = $derived.by(() =>
    SLOT_FAMILY_ORDER.map((family) => {
      const familySlots = slotsOfFamily($fitting.slots, family);
      return {
        family,
        label: SLOT_FAMILY_LABELS[family],
        total: familySlots.length,
        filled: familySlots.filter((slot) => slot.module !== null).length,
      };
    }).filter((entry) => entry.total > 0),
  );

  const selectedSlot = $derived.by<FittingSlot | null>(() => {
    if (selected === null) {
      return null;
    }
    return (
      $fitting.slots.find(
        (slot) => slot.family === selected!.family && slot.index === selected!.index,
      ) ?? null
    );
  });

  function isSelected(slot: FittingSlot): boolean {
    return selected !== null && selected.family === slot.family && selected.index === slot.index;
  }

  /**
   * Clicking a socket. Holding a module and tapping an EMPTY socket fits it
   * straight in — that is the gesture the layout exists for. Anything else
   * selects the socket and shows its actions underneath.
   */
  function clickSocket(slot: FittingSlot): void {
    if (slot.module === null && pickedItemID !== null) {
      fitInto(slot);
      return;
    }
    selected = isSelected(slot) ? null : { family: slot.family, index: slot.index };
    confirmingRigID = null;
  }

  /** What an EMPTY socket shows: its number within its family. */
  function socketText(slot: FittingSlot): string {
    return String(slot.index + 1);
  }

  /** The full spoken/hover description of a socket — never an abbreviation. */
  function socketDescription(slot: FittingSlot): string {
    if (!slot.module) {
      return `${slotName(slot)}, empty`;
    }
    const name = moduleName(slot.module.typeID);
    if (slot.family === "rig" || slot.family === "subsystem") {
      return `${slotName(slot)}, ${name}`;
    }
    // What is loaded belongs in the socket's own description: the tile is a
    // picture of the MODULE, so this is the only place a player learns the gun
    // has ammunition in it without opening something else.
    const loaded = slot.module.charge
      ? `, loaded with ${chargeCount(slot.module.charge.quantity)} ${moduleName(slot.module.charge.typeID)}`
      : "";
    return `${slotName(slot)}, ${name}, ${slot.module.online ? "online" : "offline"}${loaded}`;
  }

  /** "160" — a stack count, grouped. A singleton charge reports -1; call it 1. */
  function chargeCount(quantity: number): string {
    return (quantity > 0 ? quantity : 1).toLocaleString();
  }

  // R7c — resolve the ACTIVE SHIP's typeID, every fitted module's typeID and
  // every fittable inventory row's typeID to a display NAME. Fire-and-forget so
  // the panel renders immediately and swaps in names as they arrive.
  $effect(() => {
    const refs: NameRef[] = [];
    if (activeShipTypeID !== null) {
      refs.push({ kind: "type", id: activeShipTypeID });
      refs.push({ kind: "typeGroup", id: activeShipTypeID });
    }
    for (const slot of $fitting.slots) {
      if (slot.module) {
        refs.push({ kind: "type", id: slot.module.typeID });
        // The loaded charge needs a name too, or the socket description would
        // have to fall back to a number (R7d).
        if (slot.module.charge) {
          refs.push({ kind: "type", id: slot.module.charge.typeID });
        }
      }
    }
    for (const row of fittableRows()) {
      refs.push({ kind: "type", id: row.row.typeID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  /** Modules sitting in the hangar or the ship's cargo that could be fitted. */
  function fittableRows(): { row: InventoryItemRow; source: "hangar" | "cargo" }[] {
    const rows: { row: InventoryItemRow; source: "hangar" | "cargo" }[] = [];
    for (const row of $inventory.hangar.rows) {
      if (isFittableRow(row.categoryID)) {
        rows.push({ row, source: "hangar" });
      }
    }
    for (const row of $inventory.cargo.rows) {
      if (isFittableRow(row.categoryID)) {
        rows.push({ row, source: "cargo" });
      }
    }
    return rows;
  }

  const fittable = $derived.by(() => fittableRows());

  /**
   * Every CHARGE stack in the hangar or the ship's cargo — what "Load" can act
   * on. Not filtered by compatibility (see isChargeRow): the panel would have to
   * guess, and a wrong guess hides ammunition that would have worked.
   */
  const chargeRows = $derived.by(() => {
    const rows: { row: InventoryItemRow; source: "hangar" | "cargo" }[] = [];
    for (const row of $inventory.hangar.rows) {
      if (isChargeRow(row.categoryID)) {
        rows.push({ row, source: "hangar" });
      }
    }
    for (const row of $inventory.cargo.rows) {
      if (isChargeRow(row.categoryID)) {
        rows.push({ row, source: "cargo" });
      }
    }
    return rows;
  });

  /**
   * The charge list for the SELECTED module, likely-compatible first.
   *
   * ⚠ SORTED, NEVER FILTERED. The static tables cannot know every case and the
   * server is the authority on what loads, so hiding a charge that would have
   * worked is worse than showing one that will not. A charge we cannot judge
   * sorts between the two — ahead of a known mismatch, behind a known fit.
   */
  const sortedChargeRows = $derived.by(() => {
    const fitment = selectedSlot?.module
      ? $fitting.chargeFits[selectedSlot.module.typeID]
      : undefined;
    const rank = (row: InventoryItemRow): number => {
      const verdict = chargeLooksCompatible(fitment, row.groupID, chargeSizeOf(row));
      return verdict === true ? 0 : verdict === null ? 1 : 2;
    };
    return [...chargeRows].sort((left, right) => rank(left.row) - rank(right.row));
  });

  /**
   * A charge's own size. The inventory rows do not carry it, so this reads the
   * fitment table's entry for the charge TYPE when the BFF happened to include
   * one; otherwise null, which `chargeLooksCompatible` treats as "cannot say".
   */
  function chargeSizeOf(row: InventoryItemRow): number | null {
    return $fitting.chargeFits[row.typeID]?.size ?? null;
  }

  /** Whether this charge looks like it fits the selected module. */
  function chargeVerdict(row: InventoryItemRow): boolean | null {
    const fitment = selectedSlot?.module
      ? $fitting.chargeFits[selectedSlot.module.typeID]
      : undefined;
    return chargeLooksCompatible(fitment, row.groupID, chargeSizeOf(row));
  }

  function loadInto(moduleItemID: number, chargeItemID: number, source: "hangar" | "cargo"): void {
    void run(async () => {
      await flow.loadAmmo([moduleItemID], [chargeItemID], source);
      // The stack the charges came out of shrank, so the list has to re-read.
      await flow.loadInventory();
    });
  }

  function unloadFrom(moduleItemID: number, destination: "hangar" | "cargo"): void {
    void run(async () => {
      await flow.unloadAmmo([moduleItemID], destination);
      await flow.loadInventory();
    });
  }

  function moduleName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID);
  }

  const pickedName = $derived.by<string | null>(() => {
    if (pickedItemID === null) {
      return null;
    }
    const match = fittable.find((entry) => entry.row.itemID === pickedItemID);
    return match ? moduleName(match.row.typeID) : null;
  });

  /** The active ship's TYPE (what names it) — never its item ID. */
  const activeShipTypeID = $derived.by<number | null>(() => {
    const shipID = $fitting.activeShipID;
    if (shipID === null) {
      return null;
    }
    const row =
      $inventory.hangar.rows.find((entry) => entry.itemID === shipID) ??
      $inventory.cargo.rows.find((entry) => entry.itemID === shipID);
    return row ? row.typeID : null;
  });

  const activeShipName = $derived.by<string>(() => {
    if (activeShipTypeID === null) {
      return "your ship";
    }
    const typeName = $names.resolved[nameKey("type", activeShipTypeID)];
    return typeName ?? "your ship";
  });

  /** The hull's class ("Battlecruiser") — its type GROUP, resolved to a name. */
  const activeShipClass = $derived.by<string | null>(() => {
    if (activeShipTypeID === null) {
      return null;
    }
    return $names.resolved[nameKey("typeGroup", activeShipTypeID)] ?? null;
  });

  /** A slot's position in plain language: "High slot 3", never "flag 29". */
  function slotName(slot: FittingSlot): string {
    const family = SLOT_FAMILY_LABELS[slot.family];
    // "High slots" -> "High slot 3"; "Rigs" -> "Rig 1".
    const singular = family.endsWith("slots")
      ? family.replace(/slots$/, "slot")
      : family.replace(/s$/, "");
    return `${singular} ${slot.index + 1}`;
  }

  function resourceText(resource: FittingResource, unit: string): string {
    if (!resource.known) {
      return "—";
    }
    return `${round(resource.used)} / ${round(resource.total)} ${unit}`;
  }

  function round(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  function percent(resource: FittingResource): number | null {
    if (!resource.known || resource.total <= 0) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round((resource.used / resource.total) * 100)));
  }

  // --- R21 formatting for the statistic panels ------------------------------
  //
  // Every one of these takes a number the SERVER produced (or pure arithmetic
  // over server numbers) and makes it readable. None of them invents a value.

  const NUMBER = new Intl.NumberFormat("en-GB");

  function whole(value: number): string {
    return NUMBER.format(Math.round(value));
  }

  function toFixed(value: number, digits: number): string {
    return NUMBER.format(Number(value.toFixed(digits)));
  }

  function asPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
  }

  /** Metres, shown as km once the number gets long — the way EVE reads them. */
  function asDistance(value: number): string {
    return value >= 1000 ? `${toFixed(value / 1000, 1)} km` : `${whole(value)} m`;
  }

  function asSeconds(value: number): string {
    return `${toFixed(value, 2)} s`;
  }

  function asVolume(value: number): string {
    return `${toFixed(value, 1)} m³`;
  }

  /** Seconds as a clock the way EVE writes a capacitor time: "2m 26s". */
  function asDuration(seconds: number): string {
    const total = Math.round(seconds);
    if (total < 60) {
      return `${total}s`;
    }
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }

  const layerLabels: Readonly<Record<LayerName, string>> = {
    shield: "Shield",
    armor: "Armor",
    hull: "Structure",
  };

  /** The four damage types, in the order every EVE UI lists them. */
  const DAMAGE_TYPES = [
    { key: "em", label: "EM", cls: "dmg-em" },
    { key: "thermal", label: "Therm", cls: "dmg-therm" },
    { key: "kinetic", label: "Kin", cls: "dmg-kin" },
    { key: "explosive", label: "Exp", cls: "dmg-exp" },
  ] as const;

  const stats = $derived.by(() => $fitting.stats);

  /** The resistance grid: one row per layer, four damage types across. */
  const defenceRows = $derived.by(() =>
    LAYERS.map((layer) => ({
      layer,
      label: layerLabels[layer],
      tank: stats.tank[layer],
    })),
  );

  const damageProfileText = $derived.by(() => {
    const profile = stats.damageProfile;
    const parts = [profile.em, profile.thermal, profile.kinetic, profile.explosive].map((share) =>
      Math.round(share * 100),
    );
    return parts.join("/");
  });

  /** Grade a resistance by strength, so a strong tank reads green at a glance —
   * always alongside the number, so colour is reinforcement, never the signal. */
  function resistClass(stat: Stat): string {
    if (!stat.known) {
      return "";
    }
    if (stat.value >= 0.55) return "resist-hi";
    if (stat.value >= 0.35) return "resist-med";
    if (stat.value >= 0.15) return "resist-lo";
    return "resist-none";
  }

  // --- the bottom read-outs -------------------------------------------------

  /** The cargo hold's used / total, from the inventory slice's own capacity read. */
  const cargoBayText = $derived.by<string>(() => {
    const cap = $inventory.cargo.capacity;
    if (cap) {
      return `${toFixed(cap.used, 1)} / ${toFixed(cap.capacity, 1)} m³`;
    }
    // No capacity read yet — fall back to the hull's total from ShipGetInfo,
    // with the used side honestly unknown rather than a fabricated 0.
    return stats.bays.cargoCapacity.known
      ? `— / ${asVolume(stats.bays.cargoCapacity.value)}`
      : "Unavailable";
  });

  /**
   * A fit's total ISK value needs a market price for the hull and every fitted
   * module — prices this window does not read. Stated as unavailable rather than
   * guessed, exactly like every other unsourced number here.
   */
  const fitValue = unavailable(
    "a fit's total value needs a market price for the hull and every module, which this window does not read",
  );

  // --- R21 slice B — a clicked module's EFFECTIVE stats ---------------------
  //
  // The server's post-dogma attributes for one fitted module: its skills, hull
  // bonuses and in-space effects are ALREADY baked in before we see them (see
  // bridge/boundDogma.ts / moduleAttributes.ts). We only label and format; the
  // numbers are the server's. An itemID can exceed 2^53 on the wire, so the
  // lookup compares string forms rather than trusting `===` on two numbers.

  function moduleStatsFor(itemID: number): readonly ModuleStat[] {
    const snapshot = $dogma.allInfo;
    if (!snapshot) {
      return [];
    }
    const key = String(itemID);
    const item = snapshot.ships.find((entry) => String(entry.itemID) === key);
    return moduleEffectiveStats(item?.attributes);
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

  async function refresh(): Promise<void> {
    // The hangar / cargo rows feed the "what can I fit" list, so the fitting
    // panel refreshes both reads together. loadFitting also pulls the dogma
    // snapshot for the module stats on the same beat.
    await flow.loadInventory();
    await flow.loadFitting();
  }

  // --- R78: dragging a module onto a socket ---------------------------------
  //
  // ⚠ AN ACCELERATOR, NOT A REPLACEMENT. Pick-then-Fit still works exactly as it
  // did: every button below is untouched, and a player who cannot drag loses
  // nothing. Dragging is simply what someone arriving from the retail client
  // reaches for first.

  /** The socket the pointer is over, so it can light up while dragging. */
  let dropSlot = $state<string | null>(null);
  /** Why the last attempted drop was refused, in the panel's own error line. */
  function slotKey(slot: FittingSlot): string {
    return `${slot.family}:${slot.index}`;
  }

  function startItemDrag(event: DragEvent, itemID: number, typeID: number, source: "hangar" | "cargo"): void {
    const payload: DragPayload = {
      kind: "inventoryItem",
      itemID,
      typeID,
      from: source === "hangar" ? { kind: "hangar" } : { kind: "cargo" },
    };
    event.dataTransfer?.setData(DRAG_MIME, encodeDrag(payload));
    // A plain-text copy so dragging into a text field or another app produces
    // something legible rather than nothing.
    event.dataTransfer?.setData("text/plain", moduleName(typeID));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  }

  function overSocket(event: DragEvent, slot: FittingSlot): void {
    if (!carriesOurPayload(event.dataTransfer?.types as string[] | undefined)) {
      return;
    }
    // preventDefault is what MAKES an element a drop target; without it the
    // browser refuses the drop and shows the "no entry" cursor.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    dropSlot = slotKey(slot);
  }

  function dropOnSocket(event: DragEvent, slot: FittingSlot): void {
    dropSlot = null;
    const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME) ?? null);
    const verdict = dropOnSocketVerdict(payload);
    event.preventDefault();
    if (verdict !== null) {
      // Refused, and SAID — the panel's existing error line, so a rejected drop
      // reads the same way a rejected click does.
      error = verdict;
      return;
    }
    // Narrowed by the verdict above: only an inventory item can reach here.
    const item = payload as Extract<DragPayload, { kind: "inventoryItem" }>;
    // ⚠ IT GOES THROUGH `fitInto`, NOT ITS OWN `flow.fitModule` CALL. A drop is
    // the same act as picking an item and pressing Fit, so it makes the drop the
    // current pick and then runs the existing handler. Writing the call again
    // here would be a second path to the same server call — which is precisely
    // what `fittingWindow.test.ts` counts call sites to prevent, and it caught
    // this on the first run.
    pickedItemID = item.itemID;
    pickedSource = item.from.kind === "cargo" ? "cargo" : "hangar";
    fitInto(slot);
  }

  function fitInto(slot: FittingSlot): void {
    const itemID = pickedItemID;
    if (itemID === null) {
      return;
    }
    const source = pickedSource;
    void run(async () => {
      await flow.fitModule(itemID, source, { family: slot.family, index: slot.index });
      pickedItemID = null;
      await flow.loadInventory();
    });
  }

  function fitAnywhere(): void {
    const itemID = pickedItemID;
    if (itemID === null) {
      return;
    }
    const source = pickedSource;
    void run(async () => {
      await flow.fitModule(itemID, source, "auto");
      pickedItemID = null;
      await flow.loadInventory();
    });
  }

  function pick(itemID: number, source: "hangar" | "cargo"): void {
    pickedItemID = pickedItemID === itemID ? null : itemID;
    pickedSource = source;
  }

  function unfit(itemID: number): void {
    void run(async () => {
      await flow.unfitModule(itemID, "hangar");
      selected = null;
      await flow.loadInventory();
    });
  }

  function toggleOnline(itemID: number, online: boolean): void {
    void run(() => flow.setModuleOnline(itemID, online));
  }

  function destroyRig(itemID: number): void {
    confirmingRigID = null;
    void run(async () => {
      await flow.destroyRig(itemID);
      selected = null;
      await flow.loadInventory();
    });
  }

  onMount(() => {
    // The remembered choice wins; with none, the viewport decides. This is the
    // R8 contract — list on a phone, radial above the breakpoint — but the
    // player can always override it, in either direction.
    let remembered: string | null = null;
    try {
      remembered = globalThis.localStorage?.getItem(VIEW_STORAGE_KEY) ?? null;
    } catch {
      remembered = null;
    }
    if (remembered === "radial" || remembered === "list") {
      view = remembered;
    } else if (globalThis.matchMedia?.("(max-width: 640px)").matches) {
      view = "list";
    }
    void run(refresh);
  });
</script>

<!-- ============================ shared snippets ========================== -->

{#snippet statValue(stat: Stat, format: (value: number) => string)}
  {#if stat.known}
    {format(stat.value)}
  {:else}
    <span class="stat-unavailable" title={stat.why}>Unavailable</span>
  {/if}
{/snippet}

{#snippet statRow(label: string, stat: Stat, format: (value: number) => string)}
  <tr>
    <th scope="row">{label}</th>
    <td class="num">{@render statValue(stat, format)}</td>
  </tr>
{/snippet}

<!-- A fitted module's EFFECTIVE stats — with the pilot's skills and this hull,
     straight from the server. Reused by the ring detail and the list view. -->
{#snippet moduleStatsBlock(itemID: number)}
  {@const rows = moduleStatsFor(itemID)}
  <div class="module-stats">
    <p class="module-stats-title">Stats — with your skills and this hull</p>
    {#if rows.length > 0}
      <table class="guests module-stats-table">
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <th scope="row">{row.label}</th>
              <td class="num">{row.value}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if !$dogma.loaded}
      <p class="note">Reading this module's effective stats…</p>
    {:else if $dogma.error}
      <p class="note">
        This module's effective stats could not be read: {$dogma.error}
      </p>
    {:else}
      <p class="note">This module reports no detailed stats.</p>
    {/if}
  </div>
{/snippet}

<!-- The right-hand statistics panel — EVE's collapsible sections, each a
     ▸/▾ header carrying its headline value. Everything is derived from the SAME
     ShipGetInfo attribute map the resource bars read; anything module-summed
     (offense, repairs, drone dps, cap stability) has no allowed read yet and
     says "Unavailable" rather than guessing. -->
{#snippet statsPanel()}
  <div class="fit-stats">
    <details class="fit-sec" open>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Capacitor</span>
        <span class="fit-sec-headline">
          {@render statValue(stats.capacitor.stability, (v) => (v > 0 ? "Stable" : "Unstable"))}
        </span>
      </summary>
      <div class="fit-sec-body">
        <table class="guests">
          <tbody>
            {@render statRow("Capacity", stats.capacitor.capacity, (v) => `${whole(v)} GJ`)}
            {@render statRow("Recharge time", stats.capacitor.rechargeSeconds, asSeconds)}
            {@render statRow("Net change per second", stats.capacitor.deltaPerSecond, whole)}
            {@render statRow("Lasts for", stats.capacitor.lastsForSeconds, asSeconds)}
          </tbody>
        </table>
        <p class="note">
          Whether a fit runs its capacitor dry needs each module's drain, which
          this window cannot read yet — so it is left unsaid, not guessed.
        </p>
      </div>
    </details>

    <details class="fit-sec" open>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Offense</span>
        <span class="fit-sec-headline">{@render statValue(stats.firepower.dps, (v) => `${whole(v)} dps`)}</span>
      </summary>
      <div class="fit-sec-body">
        <table class="guests">
          <tbody>
            {@render statRow("Damage per second", stats.firepower.dps, whole)}
            {@render statRow("Drone damage per second", stats.firepower.droneDps, whole)}
            {@render statRow("Volley damage", stats.firepower.volley, whole)}
            {@render statRow("Mining yield", stats.mining.cubicMetresPerSecond, asVolume)}
          </tbody>
        </table>
        <p class="note">
          Damage summed across your guns, drones or miners needs each module's
          own stats — click a weapon below to read its effective figures.
        </p>
      </div>
    </details>

    <details class="fit-sec" open>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Defense</span>
        <span class="fit-sec-headline">{@render statValue(stats.totalEhp, (v) => `${whole(v)} ehp`)}</span>
      </summary>
      <div class="fit-sec-body">
        <p class="note">
          Effective hit points are worked out against an even {damageProfileText}
          spread of the four damage types.
        </p>
        <div class="table-wrap overflow-x-auto">
          <table class="guests defence-grid">
            <thead>
              <tr>
                <th>Layer</th>
                <th class="num">HP</th>
                {#each DAMAGE_TYPES as dt (dt.key)}
                  <th class="num"><span class="dmg-chip {dt.cls}">{dt.label}</span></th>
                {/each}
                <th class="num">EHP</th>
              </tr>
            </thead>
            <tbody>
              {#each defenceRows as row (row.layer)}
                <tr>
                  <td data-label="Layer">
                    <span class="layer-{row.layer}">{row.label}</span>
                    {#if row.layer === "shield" && stats.shieldRechargeSeconds.known}
                      <span class="fit-subnote">↻ {asDuration(stats.shieldRechargeSeconds.value)}</span>
                    {/if}
                  </td>
                  <td class="num" data-label="HP">{@render statValue(row.tank.hp, whole)}</td>
                  <td class="num {resistClass(row.tank.resistances.em)}" data-label="EM">
                    {@render statValue(row.tank.resistances.em, asPercent)}
                  </td>
                  <td class="num {resistClass(row.tank.resistances.thermal)}" data-label="Thermal">
                    {@render statValue(row.tank.resistances.thermal, asPercent)}
                  </td>
                  <td class="num {resistClass(row.tank.resistances.kinetic)}" data-label="Kinetic">
                    {@render statValue(row.tank.resistances.kinetic, asPercent)}
                  </td>
                  <td class="num {resistClass(row.tank.resistances.explosive)}" data-label="Explosive">
                    {@render statValue(row.tank.resistances.explosive, asPercent)}
                  </td>
                  <td class="num" data-label="EHP">{@render statValue(row.tank.ehp, whole)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <table class="guests">
          <tbody>
            {@render statRow("Shield repaired per second", stats.repairs.shield, whole)}
            {@render statRow("Armor repaired per second", stats.repairs.armor, whole)}
            {@render statRow("Structure repaired per second", stats.repairs.hull, whole)}
          </tbody>
        </table>
        <p class="note">
          Active repair rates need each repairer's own numbers — click one below
          to read its effective boost or repair amount.
        </p>
      </div>
    </details>

    <details class="fit-sec" open>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Targeting</span>
        <span class="fit-sec-headline">{@render statValue(stats.targeting.maxTargetRange, asDistance)}</span>
      </summary>
      <div class="fit-sec-body">
        <table class="guests">
          <tbody>
            {@render statRow("Targeting range", stats.targeting.maxTargetRange, asDistance)}
            {@render statRow("Targets at once", stats.targeting.maxLockedTargets, whole)}
            {@render statRow("Scan resolution", stats.targeting.scanResolution, (v) => `${toFixed(v, 1)} mm`)}
            {@render statRow(
              stats.targeting.sensorName
                ? `${stats.targeting.sensorName} sensor strength`
                : "Sensor strength",
              stats.targeting.sensorStrength,
              (v) => toFixed(v, 1),
            )}
          </tbody>
        </table>
      </div>
    </details>

    <details class="fit-sec" open>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Navigation</span>
        <span class="fit-sec-headline">{@render statValue(stats.navigation.maxVelocity, (v) => `${toFixed(v, 1)} m/s`)}</span>
      </summary>
      <div class="fit-sec-body">
        <table class="guests">
          <tbody>
            {@render statRow("Top speed", stats.navigation.maxVelocity, (v) => `${toFixed(v, 1)} m/s`)}
            {@render statRow("Time to align", stats.navigation.alignTimeSeconds, asSeconds)}
            {@render statRow("Warp speed", stats.navigation.warpSpeedAuPerSecond, (v) => `${toFixed(v, 2)} AU/s`)}
            {@render statRow("Signature radius", stats.navigation.signatureRadius, (v) => `${whole(v)} m`)}
            {@render statRow("Mass", stats.navigation.mass, (v) => `${whole(v)} kg`)}
          </tbody>
        </table>
      </div>
    </details>

    <details class="fit-sec" open>
      <summary class="fit-sec-head">
        <span class="fit-sec-name">Drones</span>
        <span class="fit-sec-headline">{@render statValue(stats.firepower.droneDps, (v) => `${whole(v)} dps`)}</span>
      </summary>
      <div class="fit-sec-body">
        <table class="guests">
          <tbody>
            {@render statRow("Bandwidth", stats.bays.droneBandwidth, (v) => `${toFixed(v, 0)} Mbit/s`)}
            {@render statRow("Control range", stats.bays.droneControlRange, asDistance)}
            {@render statRow("Drone bay", stats.bays.droneCapacity, asVolume)}
          </tbody>
        </table>
        {#if showInventory}
          <p class="controls">
            <button type="button" class="minor" onclick={() => showInventory?.()}>
              Manage drones
            </button>
          </p>
        {/if}
        <p class="note">
          Drones are launched and flown from the Overview in space; the bay
          itself is on the Inventory &amp; Ship page.
        </p>
      </div>
    </details>
  </div>
{/snippet}

<!-- The bottom read-out strip: CPU + powergrid bars, calibration, the bays and
     the fit's value. Every number is the server's; the ones with no allowed
     read say "Unavailable". -->
{#snippet fitFooter()}
  <div class="fit-footer">
    <div class="fit-bars">
      <div class="hud-gauge cpu">
        <div class="hud-head">
          <span class="hud-label">CPU</span>
          <span class="hud-value">{resourceText($fitting.resources.cpu, "tf")}</span>
        </div>
        <div
          class="hud-track"
          role="meter"
          aria-label="CPU"
          aria-valuenow={percent($fitting.resources.cpu) ?? 0}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span class="hud-fill" style={`width: ${percent($fitting.resources.cpu) ?? 0}%`}></span>
        </div>
      </div>
      <div class="hud-gauge powergrid">
        <div class="hud-head">
          <span class="hud-label">Power grid</span>
          <span class="hud-value">{resourceText($fitting.resources.powergrid, "MW")}</span>
        </div>
        <div
          class="hud-track"
          role="meter"
          aria-label="Power grid"
          aria-valuenow={percent($fitting.resources.powergrid) ?? 0}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span class="hud-fill" style={`width: ${percent($fitting.resources.powergrid) ?? 0}%`}></span>
        </div>
      </div>
    </div>
    <dl class="fit-readouts">
      <div>
        <dt>Calibration</dt>
        <dd>{resourceText($fitting.resources.calibration, "")}</dd>
      </div>
      <div>
        <dt>Cargo hold</dt>
        <dd>{cargoBayText}</dd>
      </div>
      <div>
        <dt>Drone bay</dt>
        <dd>{@render statValue(stats.bays.droneCapacity, asVolume)}</dd>
      </div>
      <div class="fit-readout-value">
        <dt>Fit value</dt>
        <dd>{@render statValue(fitValue, whole)}</dd>
      </div>
    </dl>
  </div>
{/snippet}

<!-- ============================ the window ============================== -->

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Fitting</h2>
    <!-- ⚠ THE SHIP LEAVES THE TITLE RATHER THAN GOING WITH IT. It used to be a
         `<small>` inside the heading, and a host that already says FITTING
         clips the heading — which would have taken the name of the hull you are
         actually looking at with it. Which ship this is, is the one thing on
         this strip worth reading. -->
    <p class="stat-line">
      {activeShipName}{activeShipClass ? ` · ${activeShipClass}` : ""}
    </p>
    <p class="controls">
      <span class="fit-views">
        <button
          type="button"
          class={view === "radial" ? "active" : "minor"}
          aria-pressed={view === "radial"}
          onclick={() => chooseView("radial")}
        >
          Ship view
        </button>
        <button
          type="button"
          class={view === "list" ? "active" : "minor"}
          aria-pressed={view === "list"}
          onclick={() => chooseView("list")}
        >
          List view
        </button>
      </span>
      <button type="button" class="primary" disabled={busy} onclick={() => run(refresh)}>
        Refresh
      </button>
    </p>
  </header>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $fitting.actionError}
    <p class="error">Last change failed: {$fitting.actionError}</p>
  {/if}
  {#if $fitting.resourcesError}
    <p class="error">The ship's readings could not be loaded: {$fitting.resourcesError}</p>
  {/if}
  {#if !$fitting.activeShipID}
    <p class="note">
      No active ship — board a ship on the Inventory &amp; Ship page to fit it.
    </p>
  {/if}
</section>

{#if $fitting.activeShipID}
  {#if $fitting.slotsError}
    <section>
      <p class="error">The ship's slots could not be loaded: {$fitting.slotsError}</p>
    </section>
  {/if}

  {#if view === "radial"}
    <!-- ===================== EVE's fitting stage ======================= -->
    <section class="panel fit-window">
      <div class="fit-stage">
        <!-- The slim left toolbar: Fitting (current) and Cargo. -->
        <nav class="fit-toolbar" aria-label="Fitting window views">
          <button type="button" class="fit-tool active" aria-pressed="true" title="Fitting"
            onclick={() => chooseView("radial")} aria-label="Fitting">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.2-2.2 2.6-2.4z" />
            </svg>
          </button>
          <button type="button" class="fit-tool" title="Cargo — open the Inventory & Ship page"
            aria-label="Cargo"
            disabled={!showInventory}
            onclick={() => showInventory?.()}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 8l9-5 9 5v8l-9 5-9-5V8z" /><path d="M3 8l9 5 9-5" /><path d="M12 13v8" />
            </svg>
          </button>
        </nav>

        <!-- The ring, its detail, and the bottom read-outs. -->
        <div class="fit-center">
          <div class="fit-topline">
            <TypeIcon typeID={activeShipTypeID} name={activeShipName} size="sm" />
            <span class="fit-ship-name">{activeShipName}</span>
            {#if activeShipClass}<span class="fit-ship-class">{activeShipClass}</span>{/if}
            <span class="fit-info" title={`${activeShipName}${activeShipClass ? ` · ${activeShipClass}` : ""}`}
              aria-label={`Ship: ${activeShipName}${activeShipClass ? `, ${activeShipClass}` : ""}`}>ⓘ</span>
          </div>

          <p class="note fit-hint">
            {#if pickedItemID}
              Choose an empty slot to fit {pickedName} there.
            {:else}
              Choose a slot to see what is in it and what you can do with it.
            {/if}
          </p>

          <div class="fit-ring-wrap overflow-x-auto">
            <div class="fit-ring">
              <div class="fit-ring-guide" aria-hidden="true"></div>
              <div class="fit-hull">
                <TypeIcon typeID={activeShipTypeID} name={activeShipName} size="lg" />
              </div>

              {#each sockets as socket (`${socket.slot.family}:${socket.slot.index}`)}
                {@const slot = socket.slot}
                <button
                  type="button"
                  class="fit-socket family-{slot.family}"
                  class:empty={slot.module === null}
                  class:offline={slot.module !== null &&
                    !slot.module.online &&
                    slot.family !== "rig" &&
                    slot.family !== "subsystem"}
                  class:armed={isSelected(slot)}
                  style={`left: ${socket.xPercent}%; top: ${socket.yPercent}%`}
                  title={socketDescription(slot)}
                  aria-label={socketDescription(slot)}
                  aria-pressed={isSelected(slot)}
                  disabled={busy}
                  onclick={() => clickSocket(slot)}
                  ondragover={(event) => overSocket(event, slot)}
                  ondragleave={() => (dropSlot = null)}
                  ondrop={(event) => dropOnSocket(event, slot)}
                  class:drop-target={dropSlot === slotKey(slot)}
                >
                  {#if slot.module}
                    {@const moduleLabel = moduleName(slot.module.typeID)}
                    <TypeIcon
                      typeID={slot.module.typeID}
                      name={moduleLabel}
                      size="socket"
                      fallbackText={abbreviate(moduleLabel)}
                    />
                  {:else}
                    <span class="fit-socket-text">{socketText(slot)}</span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>

          <ul class="fit-legend">
            {#each legend as entry (entry.family)}
              <li>
                <span class="badge">{entry.label}: {entry.filled} of {entry.total} filled</span>
              </li>
            {/each}
          </ul>

          {#if selectedSlot}
            <div class="fit-detail">
              <div class="fit-detail-head">
                <span class="fit-detail-slot">{slotName(selectedSlot)}</span>
                <span class="fit-detail-name">
                  {selectedSlot.module ? moduleName(selectedSlot.module.typeID) : "Empty"}
                </span>
                {#if selectedSlot.module && selectedSlot.family !== "rig" && selectedSlot.family !== "subsystem"}
                  <span class="badge {selectedSlot.module.online ? 'good' : 'warn'}">
                    {selectedSlot.module.online ? "Online" : "Offline"}
                  </span>
                {/if}
              </div>
              <div class="row-actions">
                {#if !selectedSlot.module}
                  <button
                    type="button"
                    disabled={busy || pickedItemID === null}
                    onclick={() => fitInto(selectedSlot!)}
                  >
                    Fit here
                  </button>
                  {#if pickedItemID === null}
                    <span class="note">Pick a module below first.</span>
                  {/if}
                {:else if selectedSlot.family === "rig"}
                  {#if confirmingRigID === selectedSlot.module.itemID}
                    <button
                      type="button"
                      class="danger"
                      disabled={busy}
                      onclick={() => destroyRig(selectedSlot!.module!.itemID)}
                    >
                      Yes, destroy it
                    </button>
                    <button
                      type="button"
                      class="minor"
                      disabled={busy}
                      onclick={() => (confirmingRigID = null)}
                    >
                      Keep it
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="minor"
                      disabled={busy}
                      onclick={() => (confirmingRigID = selectedSlot!.module!.itemID)}
                    >
                      Destroy rig…
                    </button>
                  {/if}
                {:else if selectedSlot.family === "subsystem"}
                  <span class="note">Subsystems stay fitted.</span>
                {:else}
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() =>
                      toggleOnline(selectedSlot!.module!.itemID, !selectedSlot!.module!.online)}
                  >
                    {selectedSlot.module.online ? "Take offline" : "Bring online"}
                  </button>
                  <button
                    type="button"
                    class="minor"
                    disabled={busy}
                    onclick={() => unfit(selectedSlot!.module!.itemID)}
                  >
                    Unfit
                  </button>
                {/if}
              </div>
              {#if selectedSlot.family === "rig" && confirmingRigID !== null}
                <p class="error">
                  Destroying a rig is permanent — it is not returned to your hangar.
                </p>
              {/if}
              {#if selectedSlot.module && selectedSlot.family !== "rig" && selectedSlot.family !== "subsystem"}
                <!--
                  AMMUNITION. Every charge in the chosen inventory is offered,
                  not a filtered "compatible" subset: which charges a module
                  accepts lives in dogma attributes the browser has no
                  allowlisted read for, so narrowing the list would mean hiding
                  ammunition that would have loaded. The SERVER refuses the wrong
                  ones, in its own words, and that refusal is what shows.
                -->
                <div class="fit-ammo">
                  <h4 class="fit-ammo-head">Ammunition</h4>
                  {#if selectedSlot.module.charge}
                    {@const loaded = selectedSlot.module.charge}
                    <p class="fit-ammo-loaded">
                      Loaded: <strong>{chargeCount(loaded.quantity)} {moduleName(loaded.typeID)}</strong>
                    </p>
                    <div class="row-actions">
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => unloadFrom(selectedSlot!.module!.itemID, "hangar")}
                      >Unload to hangar</button>
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => unloadFrom(selectedSlot!.module!.itemID, "cargo")}
                      >Unload to cargo</button>
                    </div>
                  {:else}
                    <p class="note">Nothing loaded.</p>
                  {/if}

                  {#if chargeRows.length === 0}
                    <p class="note">
                      No ammunition in your hangar or cargo to load.
                    </p>
                  {:else}
                    <ul class="fit-ammo-list">
                      {#each sortedChargeRows as entry (`${entry.source}:${entry.row.itemID}`)}
                        <li>
                          <button
                            type="button"
                            class="minor"
                            disabled={busy}
                            onclick={() =>
                              loadInto(selectedSlot!.module!.itemID, entry.row.itemID, entry.source)}
                          >
                            Load {moduleName(entry.row.typeID)}
                          </button>
                          <span class="muted">
                            {chargeCount(entry.row.quantity)} in {entry.source === "cargo" ? "cargo" : "the hangar"}
                            {#if chargeVerdict(entry.row) === false}
                              <!-- A HINT, not a block: the button stays live and
                                   the server has the last word. -->
                              — probably will not fit
                            {/if}
                          </span>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              {/if}
              {#if selectedSlot.module}
                {@render moduleStatsBlock(selectedSlot.module.itemID)}
              {/if}
            </div>
          {/if}

          {@render fitFooter()}
        </div>

        <!-- The right-hand collapsible stats panel. -->
        {@render statsPanel()}
      </div>
    </section>
  {:else}
    <!-- ===================== list view (narrow widths) ================= -->
    {#each SLOT_FAMILY_ORDER as family (family)}
      {@const slots = slotsOfFamily($fitting.slots, family as SlotFamily)}
      {#if slots.length > 0}
        <section>
          <h2>{SLOT_FAMILY_LABELS[family as SlotFamily]}</h2>
          {#if family === "rig"}
            <p class="note">
              Rigs cannot be taken off a ship. Removing one destroys it for good.
            </p>
          {/if}
          <div class="table-wrap overflow-x-auto">
            <table class="guests reflow">
              <thead>
                <tr><th>Slot</th><th>Fitted</th><th>State</th><th>Action</th></tr>
              </thead>
              <tbody>
                {#each slots as slot (`${slot.family}:${slot.index}`)}
                  <tr>
                    <td data-label="Slot">{slotName(slot)}</td>
                    <td data-label="Fitted">
                      {#if slot.module}
                        {moduleName(slot.module.typeID)}
                        <details class="module-stats-disclose">
                          <summary>Effective stats</summary>
                          {@render moduleStatsBlock(slot.module.itemID)}
                        </details>
                      {:else}
                        Empty
                      {/if}
                    </td>
                    <td data-label="State">
                      {#if !slot.module}
                        <span class="note">—</span>
                      {:else if family === "rig" || family === "subsystem"}
                        <span class="note">Always on</span>
                      {:else}
                        {slot.module.online ? "Online" : "Offline"}
                      {/if}
                    </td>
                    <td data-label="Action">
                      <div class="row-actions">
                        {#if !slot.module}
                          <button
                            type="button"
                            disabled={busy || pickedItemID === null}
                            onclick={() => fitInto(slot)}
                          >
                            Fit here
                          </button>
                        {:else if family === "rig"}
                          {#if confirmingRigID === slot.module.itemID}
                            <button
                              type="button"
                              class="danger"
                              disabled={busy}
                              onclick={() => destroyRig(slot.module!.itemID)}
                            >
                              Yes, destroy it
                            </button>
                            <button
                              type="button"
                              class="minor"
                              disabled={busy}
                              onclick={() => (confirmingRigID = null)}
                            >
                              Keep it
                            </button>
                          {:else}
                            <button
                              type="button"
                              class="minor"
                              disabled={busy}
                              onclick={() => (confirmingRigID = slot.module!.itemID)}
                            >
                              Destroy rig…
                            </button>
                          {/if}
                        {:else if family === "subsystem"}
                          <span class="note">Subsystems stay fitted</span>
                        {:else}
                          <button
                            type="button"
                            disabled={busy}
                            onclick={() => toggleOnline(slot.module!.itemID, !slot.module!.online)}
                          >
                            {slot.module.online ? "Take offline" : "Bring online"}
                          </button>
                          <button
                            type="button"
                            class="minor"
                            disabled={busy}
                            onclick={() => unfit(slot.module!.itemID)}
                          >
                            Unfit
                          </button>
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if family === "rig" && confirmingRigID !== null && slots.some((s) => s.module?.itemID === confirmingRigID)}
            <p class="error">
              Destroying a rig is permanent — it is not returned to your hangar.
            </p>
          {/if}
        </section>
      {/if}
    {/each}

    <section class="panel">
      {@render fitFooter()}
    </section>
    <section class="panel">
      {@render statsPanel()}
    </section>
  {/if}

  <!-- ===================== modules you can fit ======================== -->
  <section>
    <h2>
      Modules you can fit
      {#if pickedName}
        <small class="note">holding {pickedName}</small>
      {/if}
    </h2>
    {#if pickedItemID !== null}
      <p class="controls">
        <button type="button" disabled={busy} onclick={fitAnywhere}>
          Fit {pickedName} in the first free slot
        </button>
        <button type="button" class="minor" disabled={busy} onclick={() => (pickedItemID = null)}>
          Put it back down
        </button>
      </p>
    {:else}
      <p class="note">Pick a module below, then choose an empty slot to put it in.</p>
    {/if}
    {#if fittable.length === 0}
      <p class="note">
        {$inventory.loaded
          ? "No modules in your hangar or cargo hold to fit."
          : "Loading your hangar…"}
      </p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr><th>Module</th><th>Where it is</th><th>Action</th></tr>
          </thead>
          <tbody>
            {#each fittable as entry (entry.row.itemID)}
              <!-- Draggable onto a socket. The Fit button in the last cell is
                   unchanged and remains the keyboard path. -->
              <tr
                class={entry.row.itemID === pickedItemID ? "self" : ""}
                draggable="true"
                ondragstart={(event) =>
                  startItemDrag(event, entry.row.itemID, entry.row.typeID, entry.source)}
              >
                <td data-label="Module">{moduleName(entry.row.typeID)}</td>
                <td data-label="Where it is">
                  {entry.source === "hangar" ? "Station hangar" : "Cargo hold"}
                </td>
                <td data-label="Action">
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() => pick(entry.row.itemID, entry.source)}
                  >
                    {entry.row.itemID === pickedItemID ? "Put down" : "Pick up"}
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}
