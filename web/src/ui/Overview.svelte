<script lang="ts">
  // Overview + ship condition (goal R11). What is around the ship, by name,
  // with a distance you can sort and filter on, and Warp to / Approach on every
  // row — so a player can finally fly to anything they can see.
  //
  // A pure reader of the store's space slice. The snapshot comes from the flow
  // (~1s poll while in space); the distance, ordering and filtering are computed
  // here in the browser from the reported positions, exactly the way the real
  // client does it. Movement always goes through the existing atomic moves.
  import { onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { egoPosition } from "../bridge/space.ts";
  import {
    buildOverviewRows,
    canMyShipOrderDrone,
    formatDistance,
    healthIsDropping,
    hostileLabel,
    hostileRows,
    isHostile,
    newlyArrivedHostiles,
    overviewFilterIDs,
    ratioPercent,
    type OverviewRow,
    type OverviewSort,
  } from "../space/overview.ts";
  // R33 — the two sentences a drone control wears when this ship cannot order
  // it. They live with every other refusal's wording, not here.
  import {
    DRONE_NOT_UNDER_YOUR_CONTROL,
    NO_DRONE_UNDER_YOUR_CONTROL,
    panelErrorWords,
  } from "../bridge/refusals.ts";
  import { droneActivityLabel, droneIsBusy } from "../bridge/drones.ts";
  // R30 slice A — what a stargate row could never say: which system is through
  // it. Read from the route graph the autopilot already caches.
  import { gateLinkFor } from "../space/gateLinks.ts";
  // R30 slice D — the verbs for the thing you picked, decided as DATA in a pure
  // module rather than as a wall of {#if} blocks inside the grid's last column.
  import {
    actionsForRow,
    isMiningGroup,
    SELECTION_GONE,
    shipActions,
    type RowAction,
  } from "../space/rowActions.ts";
  // R70 — the picked object is SHARED with the tactical viewport. Clicking a
  // bracket in the picture and clicking Select in this list are the same act, so
  // they are the same piece of state; see space/selection.ts.
  import { spaceSelection, SOMEWHERE_ELSE, selectionHasVanished } from "../space/selection.ts";
  // R76 — Show Info. The opener pushes a subject into a shared target and the
  // workspace raises the window; this panel needs no window plumbing of its own.
  import { showInfo } from "./showInfo.ts";
  // R77 — the one place a single-call verb becomes a server call, shared with
  // the radial menu so the two can never dispatch differently.
  import { dispatchRowAction } from "../space/rowActionRunner.ts";
  // R79 — the overview tabs. The preset is SHARED with the tactical viewport so
  // the picture and the list always show the same slice of the grid.
  // R80 — events worth telling the player about even when this panel is closed.
  import { notify } from "./notices.ts";
  import { overviewPreset } from "../space/overviewPreset.ts";
  import { OVERVIEW_PRESETS, applyPreset } from "../space/overviewPresets.ts";
  import RadialMenu from "./RadialMenu.svelte";
  import type { RadialItem } from "./RadialMenu.svelte";
  // R27 — the shared item icon: one cached picture per thing, falling back
  // to a name-derived tile whenever the icon cache has no entry (or no cache).
  import TypeIcon from "./TypeIcon.svelte";
  // Flying-distance preferences, shared with the Settings panel (where they are
  // now picked). This panel only READS them to fly what you have selected.
  import { flyingDistances, WARP_RANGES, HOLD_RANGES, rangeLabel } from "./flyingDistances.ts";
  import { resolvedName, nameKey, type NameRef } from "../store/names.ts";
  // One cycle-progress implementation, shared with the HUD rack.
  import { cycleProgressPercent as rackCycleProgress } from "./moduleRack.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { DestinationMatch, ModuleCycle, SpaceEntity } from "../store/types.ts";

  // `compact` (the top-right dock panel) trims this full cockpit down to just the
  // overview list + its command bar: the ship-condition gauges, locked-targets
  // table and "Your equipment" rack are hidden because they already live in the
  // persistent bottom HUD / a separate targets panel. Everything still computes;
  // it is only hidden (see .overview-compact in styles.css).
  let { store, flow, compact = false }: { store: ClientStore; flow: AppFlow; compact?: boolean } = $props();

  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // R23 slice A — the GENERIC in-space action layer: what is locked, and which
  // modules are running. Nothing here is mining-specific; the same two sections
  // serve a turret exactly as they serve a mining laser.
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // R23 slice B — the survey scanner. The scan is the only read that says how
  // much ore a rock has left when the snapshot could not; it is MERGED into the
  // rows here, never used to compute anything.
  // svelte-ignore state_referenced_locally
  const mining = store.mining;
  // R25 slice A — drones. The bay, what is in space, and the two limits the
  // server enforces on a launch.
  // svelte-ignore state_referenced_locally
  const drones = store.drones;
  // R30 slice C — the two things that fly the ship for you. Read ONLY so the
  // flight strip can quote what they say about themselves; this panel never
  // writes to either and never invents narration on their behalf.
  // svelte-ignore state_referenced_locally
  const bot = store.bot;
  // svelte-ignore state_referenced_locally
  const travel = store.travel;

  // How many rows we render. A busy grid can hold hundreds of objects and the
  // list re-renders every second, so the nearest few hundred is the useful set.
  const ROW_CAP = 200;

  // R13 flight ranges. Every one of these is a DISTANCE the player picks once
  // and then applies to any row, which is how the retail right-click submenus
  // work — putting a set of range pickers on all 200 rows would be unusable.
  // Labels are written out rather than formatted so a fixed menu reads as
  // "10 km", never "10.0 km" and never a raw metre count.
  let busy = $state(false);
  let error = $state("");
  let search = $state("");
  let sort = $state<OverviewSort>("distance");
  let categoryFilter = $state("");
  let groupFilter = $state("");
  const warpLabel = $derived(rangeLabel(WARP_RANGES, $flyingDistances.warp));
  const orbitLabel = $derived(rangeLabel(HOLD_RANGES, $flyingDistances.orbit));
  const holdLabel = $derived(rangeLabel(HOLD_RANGES, $flyingDistances.hold));

  const snapshot = $derived($space.snapshot);
  const inSpace = $derived(snapshot?.inSpace === true || $flight.status?.inSpace === true);
  const origin = $derived(egoPosition(snapshot));

  // R30 slice A — the stargates on this grid and where they lead.
  //
  // WHY THIS EXISTS: a gate was a row like any other. You could warp to it and
  // approach it, but the moment your destination was in the next system the
  // panel had nothing more to offer and you had to leave for the Flight tab and
  // type two raw gate IDs by hand. The graph that answers "which system is
  // through this gate" was already in the browser, cached by the autopilot.
  //
  // The links arrive WITH the snapshot, through the space slice, and this panel
  // stays what it has always been: a pure reader.
  //
  // It was originally a component-local `$state` filled by an `$effect` that
  // awaited `flow.nearbyGates`, and that DID NOT WORK — the write landed (the
  // effect could read all seven links back immediately afterwards) but the
  // template never saw it, on the same component instance. A synchronous write
  // in the same effect rendered fine; every asynchronous one was invisible.
  // Rather than keep guessing at the framework, the links now travel the exact
  // path the rest of this panel's data travels — the store, re-rendered every
  // second — which is the mechanism the whole app already depends on.
  //
  // It is also the better design: the links are computed from the SAME snapshot
  // that produced the rows, so a gate can never be labelled with a destination
  // worked out for a different system than the grid it is sitting on.
  const gateLinks = $derived($space.gateLinks);
  const gateLinksError = $derived($space.gateLinksError);

  // --- R30 slice C: the flight strip ---------------------------------------
  //
  // Three lines, and each answers a question the player previously had to leave
  // this tab to ask: WHERE am I, what is happening, and what went wrong. The
  // "where" line in particular did not exist anywhere on this page — Overview
  // never showed location at all, which is a large part of why setting a
  // destination meant a trip to another tab and back.

  /**
   * WHERE. Assembled only from what the flight slice actually reported; every
   * part that is unknown is simply left out rather than filled with a guess or
   * a placeholder. Names only, never an id (R7d).
   */
  const whereText = $derived.by(() => {
    const status = $flight.status;
    if (!status) {
      return "Finding out where you are…";
    }
    const parts: string[] = [];
    if (status.inSpace) {
      parts.push(`In space${$flight.solarSystemName ? ` · ${$flight.solarSystemName}` : ""}`);
    } else if (status.stationID !== null) {
      parts.push(`Docked at ${$flight.stationName ?? "the station"}`);
    } else if (status.structureID !== null) {
      parts.push(`Docked at ${$flight.structureName ?? "a structure"}`);
    } else {
      parts.push("Docked");
    }
    // The active ship, by TYPE name, from the snapshot that is already on
    // screen. Docked there is no snapshot, so the ship is simply not named.
    const shipTypeID = snapshot?.ship?.typeID ?? null;
    if (shipTypeID !== null) {
      const name = resolvedName($names.resolved, "type", shipTypeID, "");
      if (name.length > 0) {
        parts.push(name);
      }
    }
    return parts.join(" · ");
  });

  /**
   * DOING — and ONLY when something is genuinely driving the ship.
   *
   * ⚠ This is passed straight through from the bot's or the autopilot's own
   * `{phase, action, why}`. It is NEVER synthesized. Hand-flying produces no
   * narration at all, because there is no authority to quote: inventing one
   * ("Approaching…", "Idle") would make a sentence the browser guessed
   * indistinguishable from a sentence the loop actually reported, which is
   * exactly the line `cycleProgressPercent` already refuses to cross.
   */
  const doingText = $derived.by(() => {
    // The mining bot first: when it is running it is the thing flying the ship.
    if ($bot.status === "running" || $bot.status === "paused") {
      const said = [$bot.phase, $bot.action, $bot.why].filter(
        (part): part is string => typeof part === "string" && part.length > 0,
      );
      return said.length > 0 ? said.join(" · ") : null;
    }
    if ($travel.status === "running") {
      const said = [$travel.phase, $travel.action].filter(
        (part): part is string => typeof part === "string" && part.length > 0,
      );
      return said.length > 0 ? said.join(" · ") : null;
    }
    return null;
  });

  /**
   * WRONG. The first reason any of the four sources is currently carrying, so a
   * refusal is visible from the cockpit instead of only on the tab that owns it.
   * Each source keeps rendering its own error where it happens; this is a
   * summary, not a replacement.
   */
  const wrongText = $derived(
    $flight.actionError ?? $travel.failureReason ?? $bot.failureReason ?? $targeting.actionError ?? null,
  );

  const docked = $derived($flight.status !== null && !$flight.status.inSpace);

  /**
   * Per-concern busy tracking.
   *
   * ⚠ DO NOT CLEAN THIS UP INTO A SINGLE `busy` FLAG. The whole reason it is a
   * SET is that one shared flag greys out every control whenever any one of
   * them is in flight — including Stop, in the middle of a fight, because a
   * lock request happened to be pending. A control may only be disabled by its
   * OWN concern being busy.
   */
  type Concern = "move" | "lock" | "module" | "drone" | "hold" | "route";
  let busyConcerns = $state<readonly Concern[]>([]);
  /**
   * And the other half of the same rule: a failure is remembered PER CONCERN so
   * it can be drawn next to the control that caused it. One shared error string
   * at the top of the panel makes a refused lock and a refused warp look like
   * the same event, and puts both of them a screen away from the button that
   * was pressed.
   */
  let concernErrors = $state<Partial<Record<Concern, string>>>({});
  function concernBusy(concern: Concern): boolean {
    return busyConcerns.includes(concern);
  }
  async function runFor(concern: Concern, action: () => Promise<void>): Promise<void> {
    if (concernBusy(concern)) {
      return;
    }
    busyConcerns = [...busyConcerns, concern];
    const message = await carry(action);
    concernErrors = { ...concernErrors, [concern]: message };
    busyConcerns = busyConcerns.filter((entry) => entry !== concern);
  }

  /** Runs it, and hands back the words to show — "" when nothing went wrong. */
  async function carry(action: () => Promise<void>): Promise<string> {
    error = "";
    try {
      await action();
      return "";
    } catch (cause) {
      if (isSessionLost(cause)) {
        return "The live session ended (idle timeout or another client took over).";
      }
      return panelErrorWords(cause);
    }
  }

  // Every name this panel shows resolves through the shared name cache: a TYPE
  // name and its GROUP / CATEGORY names, all keyed off the object's typeID.
  // Nothing numeric is ever rendered (R7d).
  function typeName(entity: { typeID: number | null }): string {
    return resolvedName($names.resolved, "type", entity.typeID, "—");
  }
  function groupName(entity: { typeID: number | null }): string {
    return resolvedName($names.resolved, "typeGroup", entity.typeID, "—");
  }
  function categoryName(typeID: number | null): string {
    return resolvedName($names.resolved, "typeCategory", typeID, "—");
  }

  // An object's display name: its own name where it has one (celestials and
  // stations are named), otherwise what kind of thing it is.
  function displayLabel(entity: SpaceEntity): string {
    if (entity.name && entity.name.length > 0) {
      return entity.name;
    }
    const type = resolvedName($names.resolved, "type", entity.typeID, "");
    return type.length > 0 ? type : "Unknown object";
  }

  // Ask the cache for every name the current snapshot needs, in one batch.
  $effect(() => {
    const refs: NameRef[] = [];
    for (const entity of snapshot?.entities ?? []) {
      if (entity.typeID !== null) {
        refs.push({ kind: "type", id: entity.typeID });
        refs.push({ kind: "typeGroup", id: entity.typeID });
        refs.push({ kind: "typeCategory", id: entity.typeID });
      }
    }
    const shipTypeID = snapshot?.ship?.typeID ?? null;
    if (shipTypeID !== null) {
      refs.push({ kind: "type", id: shipTypeID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // The category / group choices actually present around the ship. Each is
  // offered by NAME, using a representative object's typeID to resolve it; a
  // choice whose name has not resolved yet is simply not offered yet.
  interface FilterChoice {
    readonly id: number;
    readonly label: string;
  }

  const filterChoices = $derived.by<{
    categories: FilterChoice[];
    groups: FilterChoice[];
  }>(() => {
    const { categoryIDs, groupIDs } = overviewFilterIDs(snapshot);
    const categoryType = new Map<number, number>();
    const groupType = new Map<number, number>();
    for (const entity of snapshot?.entities ?? []) {
      if (entity.isSelf || entity.typeID === null) {
        continue;
      }
      if (entity.categoryID !== null && !categoryType.has(entity.categoryID)) {
        categoryType.set(entity.categoryID, entity.typeID);
      }
      if (entity.groupID !== null && !groupType.has(entity.groupID)) {
        groupType.set(entity.groupID, entity.typeID);
      }
    }
    const build = (ids: readonly number[], source: Map<number, number>, kind: "typeCategory" | "typeGroup"): FilterChoice[] =>
      ids
        .map((id) => ({
          id,
          label: resolvedName($names.resolved, kind, source.get(id) ?? null, ""),
        }))
        .filter((choice) => choice.label.length > 0)
        .sort((left, right) => left.label.localeCompare(right.label));
    return {
      categories: build(categoryIDs, categoryType, "typeCategory"),
      groups: build(groupIDs, groupType, "typeGroup"),
    };
  });

  // The rendered list: filtered, distance-sorted and capped, all client-side.
  const presetSignal = overviewPreset.preset;
  const presetIDSignal = overviewPreset.id;
  const activePreset = $derived($presetSignal);

  /**
   * The snapshot as the chosen tab sees it.
   *
   * ⚠ THE PRESET IS APPLIED BEFORE THE CAP, NOT AFTER. `buildOverviewRows` keeps
   * the nearest `ROW_CAP` matches; filtering afterwards would let 200 gates crowd
   * every rock off the Mining tab while the tab claimed to be showing rocks.
   */
  const presetSnapshot = $derived.by(() => {
    if (!snapshot) {
      return snapshot;
    }
    if (activePreset.roles === null) {
      return snapshot;
    }
    return { ...snapshot, entities: applyPreset(snapshot.entities, activePreset) };
  });

  const overview = $derived.by(() =>
    buildOverviewRows(presetSnapshot, origin, {
      sort,
      cap: ROW_CAP,
      filter: {
        text: search,
        categoryID: categoryFilter === "" ? null : Number(categoryFilter),
        groupID: groupFilter === "" ? null : Number(groupFilter),
      },
      // Text search matches what the player sees, so it searches the resolved
      // type and group names too — not just the object's own name.
      names: (entity) => ({
        typeName: $names.resolved[nameKey("type", entity.typeID ?? 0)] ?? null,
        groupName: $names.resolved[nameKey("typeGroup", entity.typeID ?? 0)] ?? null,
      }),
    }),
  );

  /**
   * R30 slice A — the rows the table iterates, each carrying its own gate link
   * (null for everything that is not a stargate).
   *
   * The link is folded into the ROW rather than looked up inside the loop. That
   * is not a style choice: a `{@const}` at the top of the keyed `{#each}`, and
   * even a lookup in an `{#if}` condition, both kept the `null` they were first
   * rendered with when the gate links arrived asynchronously a moment later —
   * the store held all seven correct links and not one button appeared. Folding
   * them in here means the links are part of the item identity, so the rows the
   * each block receives are genuinely new and cannot render a stale answer.
   * Cost is one shallow copy per visible row per poll, which is nothing.
   */
  const gateRows = $derived(
    overview.rows.map((row) => ({
      ...row,
      gateLink: gateLinkFor(gateLinks, row.itemID),
    })),
  );

  // --- R30 slice D: one selection, one bar of verbs ------------------------
  //
  // The grid's last column used to hold up to nine buttons on every one of up
  // to 200 rows. It is now a single Select, and the verbs act on what you
  // picked — which is both how the retail client works and the only version of
  // this that fits on a phone.

  // R70 — the picked id is no longer this panel's own `$state`. It lives in the
  // shared selection so the tactical viewport highlights the same object, and
  // `$`-reading the signal here is what makes a click on a bracket repaint this
  // list. The signals satisfy the Svelte store contract, so no adapter is needed.
  const selectedSignal = spaceSelection.selected;
  const noticeSignal = spaceSelection.notice;
  const selectedID = $derived($selectedSignal);
  const selectionNotice = $derived($noticeSignal);

  /**
   * ⚠ SELECTION NEVER SILENTLY RETARGETS.
   *
   * `selectedRow` is looked up in the CURRENT rows every time. It deliberately
   * does not keep a copy of the row it was given when the player clicked: a
   * rock gets mined out, a ship warps off, and a bar still holding the old row
   * would keep offering verbs for something that is not there — or, worse, a
   * bar that fell back to "the first row" would quietly point Warp to at a
   * different destination than the one the player is looking at.
   */
  const selectedRow = $derived(
    selectedID === null ? null : (gateRows.find((row) => row.itemID === selectedID) ?? null),
  );

  function selectRow(itemID: number): void {
    spaceSelection.toggle(itemID);
    // A fresh pick starts with a clean slate: the refusal from the last thing
    // you acted on is not a fact about this one.
    concernErrors = {};
  }

  /**
   * The moment the selection stops existing, say so and let it go.
   *
   * Guarded on being in space with a LOADED snapshot: docking legitimately
   * empties the grid, and a poll that has not answered yet is not evidence that
   * anything vanished. Announcing on either would cry wolf.
   */
  $effect(() => {
    if (!inSpace || !$space.loaded) {
      return;
    }
    // `selectionHasVanished` knows SOMEWHERE_ELSE is not a ball in space and so
    // can never leave one — checking it would announce it as vanished on every
    // single poll.
    const present = new Set((snapshot?.entities ?? []).map((entity) => entity.itemID));
    if (selectionHasVanished(selectedID, present)) {
      spaceSelection.dropWithNotice(SELECTION_GONE);
    }
  });

  // --- R30 slice F: "Somewhere else…" ---------------------------------------
  //
  // THE LAST FORCED TAB SWITCH IN THE GRID. Slice A put Jump on a gate, so a
  // destination one system away no longer pushes the player out. A destination
  // that is not on this grid and not through a gate you can see still did:
  // there was nothing in the overview that could express "anywhere that is not
  // one of these 200 rows", so the answer was always the Travel tab — and
  // before slice B, leaving actively froze the cockpit's own data feed.
  //
  // So the list grows one row that is not a ball in space. It sits at the
  // bottom, it has no distance because it does not have one, and its verb is
  // Set destination.

  // The sentinel id for that row now lives beside the selection it is a possible
  // value of (space/selection.ts), so the viewport recognises it too and never
  // tries to draw a bracket for a destination that is not on this grid.
  const somewhereElseSelected = $derived(selectedID === SOMEWHERE_ELSE);

  // ⚠ Search results live in COMPONENT-LOCAL $state, never the store. They are
  // a transient answer to a question this panel asked; the store holds what the
  // SHIP reports. Travel.svelte made the same call for the same reason, and two
  // panels holding the same search in two places would be two things to keep
  // in sync for no gain.
  let destinationQuery = $state("");
  let destinationResults = $state<DestinationMatch[]>([]);
  let destinationSearched = $state(false);

  async function searchDestinations(): Promise<void> {
    const query = destinationQuery.trim();
    if (query.length < 2) {
      destinationResults = [];
      destinationSearched = false;
      return;
    }
    await runFor("route", async () => {
      destinationResults = await flow.searchDestinations(query);
      destinationSearched = true;
    });
  }

  /**
   * Hand the chosen match to the same autopilot the Travel tab uses. `startRoute`
   * resolves a station or a system id, solves the route and runs the decide
   * loop — so this is one more caller of an existing path, not a second one.
   */
  async function setDestination(match: DestinationMatch): Promise<void> {
    await runFor("route", () => flow.startRoute(match.id));
  }

  function jumpsText(jumps: number | null): string {
    if (jumps === null) {
      return "—";
    }
    if (jumps === 0) {
      return "here";
    }
    return jumps === 1 ? "1 jump" : `${jumps} jumps`;
  }

  /** The verbs on offer for the current selection. Empty when nothing is picked. */
  const selectionActions = $derived.by<readonly RowAction[]>(() => {
    const row = selectedRow;
    if (!row) {
      return [];
    }
    return actionsForRow({
      kind: row.kind,
      locked: isLocked(row.itemID),
      acquiring: isAcquiring(row.itemID),
      gateLink: row.gateLink,
      minerCount: minerRows.length,
      // R49 — no ore count is passed. Depletion is the server's: it removes a
      // mined-out rock from the grid, so a rock still shown here is mineable. The
      // "Ore left" column (`remainingOre` / `remainingLabel`) still renders the
      // survey scan as a readout for the player, but it no longer gates the verb.
    });
  });

  /**
   * The ONE place a selection-bar verb turns into a server call.
   *
   * Every branch goes through `runFor`, so each verb is disabled only by its
   * own concern and its failure lands on its own control. An action carrying an
   * `unavailable` reason is never dispatched — the button is already disabled
   * and wearing that sentence, and this is the belt to that pair of braces.
   */
  async function runRowAction(action: RowAction): Promise<void> {
    const row = selectedRow;
    if (!row || action.unavailable !== null) {
      return;
    }
    // R30 slice E — the two verbs that are not a single server call. Each runs
    // its OWN loop and does its own per-step reporting, so neither is folded
    // into the one-call-per-branch switch below.
    if (action.id === "mine") {
      await mineThis(row.itemID);
      return;
    }
    if (action.id === "haul") {
      await haulNow();
      return;
    }
    // R77 — the switch this used to hold now lives in `space/rowActionRunner.ts`,
    // because the radial menu dispatches the same verbs from a different
    // component. Two copies would not diverge loudly: they would diverge in ONE
    // branch, so Orbit from the bar would hold the configured range and Orbit
    // from the radial would hold the default, and nothing would look broken.
    //
    // This surface keeps what is its own: the per-concern busy gate, and landing
    // each failure on the control that caused it.
    await runFor(action.concern, async () => {
      await dispatchRowAction(
        flow,
        action.id,
        { itemID: row.itemID, gateLink: row.gateLink ?? null },
        {
          warp: Number($flyingDistances.warp),
          orbit: Number($flyingDistances.orbit),
          hold: Number($flyingDistances.hold),
        },
      );
    });
  }

  // --- R77: the radial menu -------------------------------------------------
  //
  // Right-click (or press-and-hold on a touch screen) a row: it SELECTS that row
  // and opens the ring of verbs around the pointer.
  //
  // ⚠ IT SELECTS FIRST, DELIBERATELY. The ring is built from `selectionActions`
  // and picks dispatch through `runRowAction`, which both act on the selection —
  // so the radial and the verb bar are guaranteed to offer the same verbs for the
  // same thing and to run them identically. A radial that carried its own row
  // would be a second source of truth about what you are acting on.
  let radial = $state<{ readonly x: number; readonly y: number } | null>(null);

  function openRadial(event: MouseEvent, itemID: number): void {
    event.preventDefault();
    if (selectedID !== itemID) {
      selectRow(itemID);
    }
    radial = { x: event.clientX, y: event.clientY };
  }

  /**
   * Press-and-hold, for touch. Only for touch/pen: a MOUSE already has
   * right-click, and arming a long-press on it would make an ordinary slow click
   * on a row pop a menu the player never asked for.
   */
  const LONG_PRESS_MS = 450;
  let longPress: ReturnType<typeof setTimeout> | null = null;
  function startLongPress(event: PointerEvent, itemID: number): void {
    if (event.pointerType === "mouse") {
      return;
    }
    cancelLongPress();
    const { clientX, clientY } = event;
    longPress = setTimeout(() => {
      if (selectedID !== itemID) {
        selectRow(itemID);
      }
      radial = { x: clientX, y: clientY };
    }, LONG_PRESS_MS);
  }
  function cancelLongPress(): void {
    if (longPress !== null) {
      clearTimeout(longPress);
      longPress = null;
    }
  }

  /**
   * The ring's contents: Show info first (it never touches the ship), then every
   * verb the bar is offering. A verb that cannot be used keeps its honest reason
   * and is drawn disabled, exactly as in the bar — dropping it would leave a
   * player wondering where a button went.
   */
  const radialItems = $derived.by<readonly RadialItem[]>(() => {
    if (!selectedRow) {
      return [];
    }
    return [
      { id: "showInfo", label: "Show info", disabledReason: null },
      ...selectionActions.map((action) => ({
        id: action.id,
        label: action.label,
        disabledReason: action.unavailable,
      })),
    ];
  });

  function pickRadial(id: string): void {
    const row = selectedRow;
    if (!row) {
      return;
    }
    if (id === "showInfo") {
      showInfo({ kind: "spaceObject", itemID: row.itemID, typeID: row.typeID });
      return;
    }
    const action = selectionActions.find((candidate) => candidate.id === id);
    if (action) {
      void runRowAction(action);
    }
  }

  const ship = $derived(snapshot?.ship ?? null);

  interface Gauge {
    readonly key: string;
    readonly label: string;
    readonly percent: number | null;
  }

  const gauges = $derived.by<Gauge[]>(() => [
    { key: "shield", label: "Shield", percent: ratioPercent(ship?.shieldRatio) },
    { key: "armor", label: "Armor", percent: ratioPercent(ship?.armorRatio) },
    { key: "hull", label: "Hull", percent: ratioPercent(ship?.hullRatio) },
    { key: "capacitor", label: "Capacitor", percent: ratioPercent(ship?.capacitorRatio) },
  ]);

  function shipLabel(): string {
    if (!ship) {
      return "—";
    }
    const type = resolvedName($names.resolved, "type", ship.typeID, "");
    if (type.length > 0) {
      return type;
    }
    return ship.name && ship.name.length > 0 ? ship.name : "your ship";
  }

  // --- R23 slice A: targeting + module activation --------------------------
  //
  // GENERIC BY CONSTRUCTION. A target is a target and a module is a module; the
  // only thing that differs between mining and combat is WHICH module the
  // player switches on, which is their choice, not this panel's.

  const lockedIDs = $derived($targeting.lockedTargetIDs);
  const acquiringIDs = $derived($targeting.acquiringTargetIDs);

  function isLocked(itemID: number): boolean {
    return lockedIDs.includes(itemID);
  }
  function isAcquiring(itemID: number): boolean {
    return acquiringIDs.includes(itemID);
  }

  /**
   * The locked list, each entry named from the CURRENT snapshot. A target the
   * snapshot no longer carries has no name to show — so it says so plainly
   * rather than falling back to its itemID (R7d).
   */
  interface LockedRow {
    readonly itemID: number;
    readonly label: string;
    /** R27 — for the row's icon only; never rendered as a number. */
    readonly typeID: number | null;
    readonly typeLabel: string;
    readonly distance: string;
    readonly acquiring: boolean;
    /**
     * R29 — how battered the thing you locked is, as whole percentages. The
     * server has been sending these on every snapshot row since R11 and the
     * page has never drawn them.
     *
     * PERCENTAGES ONLY, and deliberately so: the wire carries a RATIO for other
     * ships, and the capacities needed to turn that into "412 of 500" exist for
     * your own ship alone. There is no honest way to show a rat's hit points or
     * a time-to-kill, so neither is shown.
     */
    readonly shield: number | null;
    readonly armor: number | null;
    readonly hull: number | null;
  }
  const lockedRows = $derived.by<LockedRow[]>(() => {
    const byID = new Map<number, SpaceEntity>();
    for (const entity of snapshot?.entities ?? []) {
      byID.set(entity.itemID, entity);
    }
    const rowDistance = new Map<number, number>();
    for (const row of overview.rows) {
      rowDistance.set(row.itemID, row.distance);
    }
    const ids = [...lockedIDs, ...acquiringIDs.filter((id) => !lockedIDs.includes(id))];
    return ids.map((itemID) => {
      const entity = byID.get(itemID) ?? null;
      const distance = rowDistance.get(itemID);
      return {
        itemID,
        label: entity ? displayLabel(entity) : "No longer in view",
        typeID: entity ? entity.typeID : null,
        typeLabel: entity ? typeName(entity) : "—",
        distance: distance === undefined ? "—" : formatDistance(distance),
        acquiring: !lockedIDs.includes(itemID),
        shield: ratioPercent(entity?.shieldRatio),
        armor: ratioPercent(entity?.armorRatio),
        hull: ratioPercent(entity?.hullRatio),
      };
    });
  });

  /**
   * R29 — the shots, newest FIRST for reading (the store keeps them in arrival
   * order). Everything here is named: the other party through the snapshot's
   * own rows, the weapon through the name cache. No id is ever rendered.
   *
   * Damage is shown to one decimal because the server sends fractions and
   * rounding 0.4 to "0" would make a landed hit look like a miss. A genuine
   * zero is labelled as a miss in words rather than shown as a bare number.
   */
  interface DamageRow {
    readonly id: number;
    readonly summary: string;
    readonly weaponLabel: string;
    readonly amountLabel: string;
  }
  const damageRows = $derived.by<DamageRow[]>(() => {
    const byID = new Map<number, SpaceEntity>();
    for (const entity of snapshot?.entities ?? []) {
      byID.set(entity.itemID, entity);
    }
    return [...$targeting.damageLog].reverse().map((shot) => {
      const other = shot.otherPartyID === null ? null : (byID.get(shot.otherPartyID) ?? null);
      const otherLabel = other ? displayLabel(other) : "something no longer in view";
      const missed = shot.amount <= 0;
      return {
        id: shot.id,
        summary: shot.direction === "dealt"
          ? missed
            ? `You shot at ${otherLabel} and missed`
            : `You hit ${otherLabel}`
          : missed
            ? `${otherLabel} shot at you and missed`
            : `${otherLabel} hit you`,
        weaponLabel:
          shot.weaponTypeID === null
            ? "—"
            : resolvedName($names.resolved, "type", shot.weaponTypeID, "—"),
        amountLabel: missed ? "—" : shot.amount.toFixed(1),
      };
    });
  });

  /**
   * The modules the player can switch on: everything ONLINE in the ship's
   * slots. Rigs and subsystems are never activated, so they are left out.
   * Whether a module is RUNNING comes from the snapshot's activeModuleIDs —
   * the server's own state — never from what this page remembers clicking.
   */
  interface ModuleRow {
    readonly itemID: number;
    /** The module's type — Switch off threads it so a prop mod's effect resolves. */
    readonly typeID: number;
    readonly label: string;
    /**
     * R47 — the game's GROUP name for the module, or null until it resolves.
     * "Mine this" reads this, not the display name: the group is the game's own
     * answer to "is this a mining laser". null is "cannot tell", never "no".
     */
    readonly group: string | null;
    readonly slotLabel: string;
    /**
     * R30 slice E — whether the module is POWERED UP. Offline modules are now
     * listed too, with a control to power them up, which is what made the
     * panel's own "turn equipment on in the Fitting tab first" untrue.
     * Online-vs-offline and running-vs-idle are two different questions and are
     * never collapsed into one column.
     */
    readonly online: boolean;
    readonly running: boolean | null;
    // R24 slice C — how long one cycle takes, and whether that figure is the
    // pilot's real one or the type's starting point. null = we have neither.
    readonly cycle: ModuleCycle | null;
  }
  const activeModuleIDs = $derived(snapshot?.ship?.activeModuleIDs ?? null);
  const moduleRows = $derived.by<ModuleRow[]>(() => {
    const rows: ModuleRow[] = [];
    for (const slot of $fitting.slots) {
      if (slot.family === "rig" || slot.family === "subsystem" || !slot.module) {
        continue;
      }
      // R30 slice E — an OFFLINE module is no longer skipped. It is listed with
      // a Power up control, because sending the player to another tab for that
      // one click is exactly the complaint this goal exists to answer.
      const online = slot.module.online;
      rows.push({
        itemID: slot.module.itemID,
        typeID: slot.module.typeID,
        label: resolvedName($names.resolved, "type", slot.module.typeID, "Unknown module"),
        // Raw read, null-aware: an unresolved group must stay null so "Mine
        // this" reads it as "cannot tell" rather than a definitive "not a miner".
        group: $names.resolved[nameKey("typeGroup", slot.module.typeID)] ?? null,
        slotLabel:
          slot.family === "high" ? "High slot" : slot.family === "mid" ? "Mid slot" : "Low slot",
        online,
        // null = the server could not tell us. Rendered as "unknown", never
        // as "off" — a wrong "off" would invite a double activation. A module
        // that is not powered up cannot be running, and that is a fact rather
        // than a guess, so it does not go through the unknown branch.
        running: !online
          ? false
          : activeModuleIDs === null
            ? null
            : activeModuleIDs.includes(slot.module.itemID),
        cycle: $targeting.moduleCycles[slot.module.itemID] ?? null,
      });
    }
    return rows;
  });

  // --- R24 slice C: cycle times --------------------------------------------
  //
  // Two things are shown and they are NOT the same claim:
  //   * how long one cycle takes — from the server's own cycle event where one
  //     has arrived (that duration already has the pilot's skills and bonuses
  //     in it), otherwise from the module type's base duration;
  //   * how far through the current cycle the module is — only ever animated
  //     from a cycle event, because that is the only thing that tells us when
  //     a cycle actually began.
  // A module we have no figure for says so. It never gets a made-up one.

  /** A cycle length as a player reads it. */
  function cycleLengthLabel(cycle: ModuleCycle | null): string {
    if (!cycle || !(cycle.durationMs > 0)) {
      return "";
    }
    const seconds = cycle.durationMs / 1000;
    return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
  }

  // A ticking clock, so a running cycle's bar actually moves. Only while
  // something is running — an idle panel does not need a 10 Hz timer.
  let clockMs = $state(Date.now());
  $effect(() => {
    const anyRunning = moduleRows.some((row) => row.cycle?.startedAtMs !== null && row.cycle);
    if (!anyRunning) {
      return;
    }
    const timer = setInterval(() => {
      clockMs = Date.now();
    }, 200);
    return () => clearInterval(timer);
  });

  /**
   * How far through the current cycle, 0-100 — or null when we cannot honestly
   * say. `null` covers both "no cycle event has ever told us when this started"
   * and "the module is not running", and the panel shows neither as 0%: an
   * empty bar reads as "just started", which would be a claim we cannot make.
   */
  function cycleProgressPercent(cycle: ModuleCycle | null): number | null {
    // One implementation, shared with the HUD rack (ui/moduleRack.ts).
    return rackCycleProgress(cycle, clockMs);
  }

  // --- R24 slice D: the live hold on the in-space screen --------------------
  //
  // A ship HAS a hold iff its capacity attribute is populated — the BFF turns
  // each specialty hold into a named reading and says `present`, so nothing
  // here knows or cares which flag is behind "Ore hold" (R7d/R9a). A hull with
  // no specialty hold simply shows its cargo.
  const shipHolds = $derived(
    $mining.holds.filter((hold) => hold.present || (hold.items?.length ?? 0) > 0),
  );

  /** How full a hold is, or an honest "not known" when the ship did not say. */
  function holdFillText(hold: { readonly capacity: { capacity: number | null; used: number | null } | null }): string {
    const reading = hold.capacity;
    if (!reading || reading.capacity === null || reading.used === null) {
      return "not known";
    }
    // Whole cubic metres: the fractional part of an ore hold is noise a player
    // watching a laser run does not need.
    return `${Math.round(reading.used).toLocaleString()} / ${Math.round(reading.capacity).toLocaleString()} m³`;
  }

  // --- R30 slice E: Mine this, and Haul now ---------------------------------

  /**
   * The equipment "Mine this" will reach for: everything POWERED UP whose GROUP
   * the game files as mining gear (R47). The derivation lives in
   * `space/rowActions.ts`; what makes it safe is that every module it reaches
   * for REPORTS BACK BY NAME below, so a wrong reach is visible in one glance.
   * A module whose group has not resolved yet is left out — "cannot tell", not
   * a claim it is idle — and joins as the group lands.
   */
  const minerRows = $derived(
    moduleRows.filter((row) => row.online && row.group !== null && isMiningGroup(row.group)),
  );

  /**
   * What each module did when "Mine this" reached for it.
   *
   * ⚠ THIS IS WHY "MINE THIS" IS NOT A FAN-OUT-AND-FORGET. Every one of these
   * calls lands its outcome in the SAME store slot, so a loop that just fired
   * them all would leave only the last module's answer on screen and quietly
   * lose the other refusals. Each module is therefore read back individually,
   * right after its own call, and a module that was accepted-then-not-run (a
   * silent decline) is reported as distinctly as one that was refused outright.
   */
  interface MineReport {
    readonly itemID: number;
    readonly label: string;
    readonly outcome: string;
    readonly ok: boolean;
  }
  let mineReports = $state<readonly MineReport[]>([]);

  async function mineThis(targetID: number): Promise<void> {
    await runFor("module", async () => {
      const reports: MineReport[] = [];
      for (const module of minerRows) {
        // repeat: -1 is what mining MEANS — cycle after cycle until something
        // stops it. It is the same argument the mining bot uses.
        await flow.activateModule(module.itemID, { targetID, repeat: -1 });
        // Read the AUTHORITY, not the return value. A successful action clears
        // both slots, so whatever is in them now belongs to THIS module.
        const refused = $targeting.actionError;
        const declined = $targeting.silentDecline;
        // And confirm against the ship's own list of what is running, which is
        // the only thing that actually knows.
        const running = snapshot?.ship?.activeModuleIDs ?? null;
        if (refused) {
          reports.push({ ...module, outcome: refused, ok: false });
        } else if (declined) {
          reports.push({ ...module, outcome: declined, ok: false });
        } else if (running !== null && !running.includes(module.itemID)) {
          reports.push({
            ...module,
            outcome: "Started, and your ship does not show it running.",
            ok: false,
          });
        } else {
          reports.push({ ...module, outcome: "Running on it.", ok: true });
        }
      }
      mineReports = reports;
    });
  }

  /**
   * Everything on this grid you could dock at, nearest first — where "Haul now"
   * would take the ore. By NAME (R7d); the id never reaches the screen.
   */
  const stationsOnGrid = $derived(
    overview.rows
      .filter((row) => row.kind === "station" || row.kind === "structure")
      .map((row) => ({ itemID: row.itemID, label: displayLabel(row) })),
  );

  /** Every stack sitting in a hold, which is what an unload actually moves. */
  const holdItemIDs = $derived(
    shipHolds.flatMap((hold) => (hold.items ?? []).map((item) => item.itemID)),
  );

  const haulActions = $derived(
    shipActions({
      nearestStationName: stationsOnGrid[0]?.label ?? null,
      docked,
      hasCargo: holdItemIDs.length > 0,
    }),
  );

  /**
   * Take the ore somewhere and put it down.
   *
   * Docked, that is one call. In space it is the R24 ladder (which closes the
   * distance itself and narrates each phase) followed by a RE-READ of the holds
   * — because the stack ids a station hangar will accept are read after the
   * dock, not before it, and a 200 on the dock is not proof it happened.
   */
  async function haulNow(): Promise<void> {
    await runFor("hold", async () => {
      if (!docked) {
        const station = stationsOnGrid[0];
        if (!station) {
          return;
        }
        await flow.dockAt(station.itemID);
      }
      await flow.loadMiningHolds();
      const ids = shipHolds.flatMap((hold) => (hold.items ?? []).map((item) => item.itemID));
      if (ids.length === 0) {
        return;
      }
      await flow.unloadMiningHolds(ids);
      // And read them again, so what the panel shows is what the ship has —
      // not what the call said it would have.
      await flow.loadMiningHolds();
    });
  }

  /**
   * Power a module up or down, without a trip to the Fitting tab.
   *
   * `setModuleOnline` re-reads the fitting itself, so the check below is
   * against freshly-read authoritative state: if the module's own `online` flag
   * did not move, the server declined and said nothing, and that is reported
   * as exactly that rather than as a success.
   */
  let moduleNotice = $state("");
  async function setModulePower(module: ModuleRow, online: boolean): Promise<void> {
    moduleNotice = "";
    await runFor("module", async () => {
      await flow.setModuleOnline(module.itemID, online);
      const after = $fitting.slots.find((slot) => slot.module?.itemID === module.itemID);
      const now = after?.module?.online ?? null;
      if (now !== null && now !== online) {
        moduleNotice = online
          ? `${module.label} did not power up, and your ship gave no reason.`
          : `${module.label} did not power down, and your ship gave no reason.`;
      }
    });
  }

  // --- R23 slice B: rocks in the overview ----------------------------------

  /**
   * How much ore a rock has left, as ONE number from two sources that agree by
   * construction: the snapshot's own reading, and the survey scanner's (which
   * reaches rocks the snapshot may not have a mining record for). The scan wins
   * when both exist, because the player asked for it and it is the fresher read.
   *
   * null is "not known" and renders as a dash. A rock with a real 0 is a
   * mined-out rock and says so — the two must never be shown the same way.
   */
  const surveyByID = $derived.by<Map<number, number | null>>(() => {
    const map = new Map<number, number | null>();
    for (const result of $mining.survey) {
      map.set(result.itemID, result.remainingQuantity);
    }
    return map;
  });
  function remainingOre(row: SpaceEntity): number | null {
    const scanned = surveyByID.get(row.itemID);
    if (scanned !== undefined) {
      return scanned;
    }
    return row.remainingQuantity;
  }
  function remainingLabel(row: SpaceEntity): string {
    if (row.kind !== "asteroid") {
      return "";
    }
    const remaining = remainingOre(row);
    if (remaining === null) {
      // Never a fabricated number, and never a 0 standing in for "unknown".
      return "—";
    }
    return remaining === 0 ? "Mined out" : `${remaining.toLocaleString()} units`;
  }
  const rockCount = $derived(
    (snapshot?.entities ?? []).filter((entity) => entity.kind === "asteroid").length,
  );

  // R24 slice B — "a row you can DOCK at" moved to `space/rowActions.ts` as
  // `isDockableKind`, which is where the whole verb set now lives. It is still
  // the server's own runtime kind for the ball that decides it — never the
  // name, the distance or the category number.

  // Which locked target a module is switched on AGAINST.
  //
  // Locking something MAKES it the thing your equipment acts on — that is what
  // a player expects, and it is what retail does. So the default ("") is AUTO:
  // whatever is locked. Defaulting to "no target" instead meant a player could
  // lock a rock, hit Switch on, and be refused "You need an active target"
  // while staring at the rock they had just locked.
  //
  // "none" is the explicit opt-out, for equipment that acts on the ship itself.
  // An id that is no longer locked falls back to auto rather than sending a
  // stale target the server would refuse.
  const AUTO_TARGET = "";
  const NO_TARGET = "none";
  let actionTargetID = $state(AUTO_TARGET);
  /** Locked (not still-acquiring) targets, in the order they were locked. */
  const selectableTargets = $derived(lockedRows.filter((entry) => !entry.acquiring));
  const effectiveTargetID = $derived.by(() => {
    if (actionTargetID === NO_TARGET) {
      return 0;
    }
    if (actionTargetID !== AUTO_TARGET) {
      const chosen = Number(actionTargetID);
      if (chosen > 0 && isLocked(chosen)) {
        return chosen;
      }
    }
    // Auto (or a stale pick): use what is locked.
    return selectableTargets.length > 0 ? selectableTargets[0].itemID : 0;
  });

  // Module names come from the same cache as everything else (R7d). The weapons
  // in the damage log go through the same cache: a shot arrives carrying only
  // the weapon's typeID, and an id must never reach the screen.
  $effect(() => {
    const refs: NameRef[] = [];
    for (const slot of $fitting.slots) {
      if (slot.module) {
        refs.push({ kind: "type", id: slot.module.typeID });
        // R47 — the module's GROUP too, so "Mine this" can ask the game whether
        // it is a mining laser instead of guessing from the display name.
        refs.push({ kind: "typeGroup", id: slot.module.typeID });
        // What is LOADED in it, so the HUD rack can name the ammunition in its
        // tile title rather than falling back to a number (R7d). The rack has
        // no name-request effect of its own; it reads this shared cache.
        if (slot.module.charge) {
          refs.push({ kind: "type", id: slot.module.charge.typeID });
        }
      }
    }
    for (const shot of $targeting.damageLog) {
      if (shot.weaponTypeID !== null) {
        refs.push({ kind: "type", id: shot.weaponTypeID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // --- R25 slice A: drones -------------------------------------------------
  //
  // ⚠ LAUNCHING IS THE DEFENCE. An idle combat drone auto-engages whatever
  // shoots the ship it came from — the server's own behaviour, on by default —
  // so a miner who launches is defended without another click. Engage below is
  // for CHOOSING a victim, and the panel says so in as many words rather than
  // leaving a player to think they have to babysit it.

  const droneBay = $derived($drones.bay);
  const dronesInSpace = $derived($drones.inSpace);
  const droneLimits = $derived($drones.limits);

  /** The bay's stacks, by NAME. The bay's flagID never reaches this file. */
  const bayRows = $derived.by(() =>
    (droneBay ?? []).map((stack) => ({
      itemID: stack.itemID,
      label: resolvedName($names.resolved, "type", stack.typeID, "Unknown drone"),
      quantity: stack.quantity,
    })),
  );

  /** Drones in space, the ones with a job first so a busy flight reads at a glance. */
  const spaceRows = $derived.by(() => {
    const byID = new Map<number, SpaceEntity>();
    for (const entity of snapshot?.entities ?? []) {
      byID.set(entity.itemID, entity);
    }
    return (dronesInSpace ?? [])
      .map((drone) => {
        const target = drone.targetID === null ? null : byID.get(drone.targetID) ?? null;
        // R33 — can this ship actually ORDER it? The panel lists a drone when
        // it is owned by me OR flown by my hull; the server only obeys the
        // second. `null` is "we cannot tell", and it is NOT the same as false.
        const orderable = canMyShipOrderDrone(byID.get(drone.itemID) ?? null, ship?.itemID ?? null);
        return {
          itemID: drone.itemID,
          label:
            drone.name && drone.name.length > 0
              ? drone.name
              : resolvedName($names.resolved, "type", drone.typeID, "Drone"),
          activity: droneActivityLabel(drone.activity),
          busy: droneIsBusy(drone.activity),
          // The ball it is busy with, by NAME. A target the snapshot no longer
          // carries simply has no name to show, so it shows none (R7d).
          targetLabel: target === null ? "" : displayLabel(target),
          // The R30 shape: a reason, or null. Only a HARD false earns one —
          // a `null` orderable leaves the control live to get a real answer.
          //
          // TWO SOURCES, THE HARDER ONE FIRST. `controlled` is the BFF's own
          // answer and is always present; `canMyShipOrderDrone` reads the
          // SNAPSHOT, which may simply not carry the drone's row and then
          // honestly answers "cannot tell". Preferring the flag also keeps the
          // panel self-consistent: a drone offered Reconnect must never sit
          // beside a live Bring home, which is what a null snapshot answer
          // would have produced.
          unavailable:
            drone.controlled === false || orderable === false
              ? DRONE_NOT_UNDER_YOUR_CONTROL
              : null,
          // ⚠ NOT ORDERABLE USED TO BE A DEAD END. A drone this character owns
          // that this hull does not fly could be seen and nothing else — no
          // recall, no engage, and no way back. Recovery is offered on the
          // BFF's definite answer only: a drone we merely could not check is
          // left alone, exactly as R33 left its order buttons alone.
          recoverable: drone.controlled === false,
        };
      })
      .sort((left, right) => Number(right.busy) - Number(left.busy));
  });

  /**
   * Every drone the group buttons may act on (goal R33).
   *
   * ⚠ THIS INCLUDES THE ONES WE CANNOT JUDGE, and that is the point. Only a
   * drone we have POSITIVELY established is not ours to fly is dropped; a drone
   * the snapshot does not carry stays in, because "we could not check" must
   * never quietly narrow what a group order does.
   *
   * ⚠ AND IT NEVER EMPTIES THE GROUP FOR THE REST. One un-orderable drone
   * removes itself from the list and nothing else — the other drones are still
   * recalled, still attack, still mine. Capability is only ever removed from
   * the drone that provably does not have it.
   */
  const allDroneIDs = $derived(
    spaceRows.filter((row) => row.unavailable === null).map((row) => row.itemID),
  );

  /**
   * The reason a GROUP order cannot run, or null.
   *
   * It is only ever set when there are drones out and NOT ONE of them is ours
   * to fly — the whole-flight version of the per-row sentence. With a mixed
   * flight the button stays live and quietly acts on the ones it can.
   */
  const groupOrderUnavailable = $derived(
    spaceRows.length > 0 && allDroneIDs.length === 0 ? NO_DRONE_UNDER_YOUR_CONTROL : null,
  );

  /**
   * R30 slice F — what a COLLAPSED drone panel still has to say.
   *
   * The panel folds away below the grid, so the one fact it may never hide is
   * that you have drones in space: they are out, they are defending you, and
   * they do not come home on their own. Everything else can wait for a click.
   * `null` stays "we could not look", never "none out".
   */
  const droneSummary = $derived.by(() => {
    if (dronesInSpace === null) {
      return $drones.loaded ? "Could not be read" : "Looking…";
    }
    if (spaceRows.length === 0) {
      return (droneBay ?? []).length > 0 ? "None out" : "None";
    }
    return spaceRows.length === 1 ? "1 out" : `${spaceRows.length} out`;
  });

  const droneLimitText = $derived.by(() => {
    const parts: string[] = [];
    // null is "not known", never 0 — a hull with no drone bay and a read that
    // failed look identical from here, and neither may be shown as a hard zero.
    parts.push(
      droneLimits.maxActiveDrones === null
        ? "Drones at once: not known"
        : `Drones at once: ${spaceRows.length} of ${droneLimits.maxActiveDrones}`,
    );
    parts.push(
      droneLimits.droneBandwidth === null
        ? "Bandwidth: not known"
        : `Bandwidth: ${droneLimits.droneBandwidth} Mbit/sec`,
    );
    return parts.join(" · ");
  });

  // Which bay stacks the player has picked to launch.
  let launchPicks = $state<Record<number, boolean>>({});
  const pickedForLaunch = $derived(
    bayRows.filter((row) => launchPicks[row.itemID] === true).map((row) => row.itemID),
  );
  function toggleLaunchPick(itemID: number): void {
    launchPicks = { ...launchPicks, [itemID]: launchPicks[itemID] !== true };
  }

  // Drone names come from the same cache as everything else (R7d).
  $effect(() => {
    const refs: NameRef[] = [];
    for (const stack of droneBay ?? []) {
      refs.push({ kind: "type", id: stack.typeID });
    }
    for (const drone of dronesInSpace ?? []) {
      if (drone.typeID !== null) {
        refs.push({ kind: "type", id: drone.typeID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // --- R25 slice B: hostile awareness --------------------------------------
  //
  // ⚠ THE FINDING THAT SHAPES ALL OF THIS: a belt rat is `kind: "ship"`, built
  // through the same server path as the player parked next to you. Nothing in
  // the snapshot separated them before R25, which is why `isNpc` /
  // `npcEntityType` exist and why every threat decision on this page reads them
  // and nothing else.
  //
  // Threats are deliberately NOT just rows in the overview. The overview is
  // searchable, filterable and capped at 200 — a player who filtered to
  // "Veldspar" while mining would have filtered away the thing shooting them.
  // The threat list below reads the WHOLE snapshot, ignores every filter, and
  // is never capped.

  const threats = $derived(hostileRows(snapshot, origin));

  /** Warn ONLY about arrivals. A rat that was already here when you landed is
   * not news; the one that just warped in is. The seen-set is primed from the
   * FIRST snapshot for exactly that reason — otherwise landing in an occupied
   * belt would announce every rat in it as an arrival. */
  let seenHostileIDs = $state<ReadonlySet<number>>(new Set<number>());
  let primedHostiles = $state(false);
  /**
   * The last arrival announcement, kept as STRUCTURED data — never a frozen
   * string. The distance is looked up LIVE when the banner renders (see the
   * `arrivalNotice` derived below), so the headline tracks the named hostile as
   * it closes in instead of freezing at the range it first arrived at while the
   * threat rows beneath it update every poll.
   */
  let arrival = $state<{
    readonly count: number;
    readonly label: string;
    readonly name: string;
    readonly itemID: number;
    /** The range at arrival — the fallback shown once the hostile is out of sight. */
    readonly lastDistance: number;
  } | null>(null);
  /** Does the set already hold exactly these ids? Compared by VALUE (no-op if so). */
  function sameIDSet(set: ReadonlySet<number>, ids: readonly number[]): boolean {
    if (set.size !== ids.length) {
      return false;
    }
    for (const id of ids) {
      if (!set.has(id)) {
        return false;
      }
    }
    return true;
  }
  $effect(() => {
    if (!inSpace) {
      // A dock (or a system change) resets the whole idea of "who was here".
      if (seenHostileIDs.size > 0) {
        seenHostileIDs = new Set<number>();
      }
      primedHostiles = false;
      arrival = null;
      return;
    }
    if (!$space.loaded) {
      return;
    }
    const current = threats;
    const currentIDs = current.map((row) => row.itemID);
    if (!primedHostiles) {
      seenHostileIDs = new Set(currentIDs);
      primedHostiles = true;
      return;
    }
    const arrived = newlyArrivedHostiles(current, seenHostileIDs);
    if (arrived.length > 0) {
      // Capture only what an arrival FIXES — who arrived, how many, and which
      // one to point at. The distance is deliberately NOT frozen here; the
      // `arrivalNotice` derived reads it live so the headline keeps pace with
      // the hostile as it approaches.
      arrival = {
        count: arrived.length,
        label: hostileLabel(arrived[0]) ?? "hostile",
        name: displayLabel(arrived[0]),
        itemID: arrived[0].itemID,
        lastDistance: arrived[0].distance,
      };
      // R80 — and tell the player wherever they are looking. The banner below
      // only exists while this panel is on screen; a miner watching a bot run
      // with the overview closed would otherwise never learn a rat had landed.
      //
      // Keyed by the hostile's own id, so the once-per-second poll that keeps
      // re-observing it cannot re-announce it (see notices.ts).
      for (const row of arrived) {
        notify({
          kind: "danger",
          key: `hostile-arrived:${row.itemID}`,
          title: `${hostileLabel(row) ?? "A hostile"} has arrived`,
          detail: `${displayLabel(row)} · ${formatDistance(row.distance)}`,
        });
      }
    }
    // Forget the ones that are gone, so a rat that leaves and comes back warns
    // again. ⚠ WRITE ONLY WHEN THE ID SET ACTUALLY CHANGED: this effect READS
    // `seenHostileIDs` (via newlyArrivedHostiles) and WRITES it, so a fresh Set
    // with the same ids every run would re-trigger forever
    // (`effect_update_depth_exceeded`) — the freeze this guard fixes.
    if (!sameIDSet(seenHostileIDs, currentIDs)) {
      seenHostileIDs = new Set(currentIDs);
    }
  });

  /**
   * The arrival banner text, with the named hostile's CURRENT distance. Reading
   * the range here — rather than baking it into `arrival` — is the whole fix:
   * while the hostile is still on the field we show where it is NOW, falling
   * back to the range we last saw it at only once it leaves.
   */
  const arrivalNotice = $derived.by(() => {
    const a = arrival;
    if (!a) {
      return "";
    }
    const live = threats.find((row) => row.itemID === a.itemID);
    const distance = formatDistance(live ? live.distance : a.lastDistance);
    return a.count === 1
      ? `A ${a.label.toLowerCase()} has arrived — ${a.name}, ${distance} away.`
      : `${a.count} hostiles have arrived. The nearest is ${a.name}, ${distance} away.`;
  });

  /**
   * ARE YOU BEING SHOT? The honest version.
   *
   * What two consecutive HUD readings show: a health layer that went down. That
   * is a fact, and it is enough to make a dropping shield legible at a glance.
   *
   * ⚠ R29 found there IS a damage log after all — `OnDamageMessage` is pushed
   * for shots in both directions, and "Shots fired" below renders it. This
   * indicator is deliberately NOT rebuilt on it. The push channel may drop
   * frames, so silence there is not proof nobody is shooting; the ship's own
   * two readings cannot lie about having gone down. The log names the attacker,
   * this proves the damage.
   */
  interface HealthReading {
    shieldRatio: number | null;
    armorRatio: number | null;
    hullRatio: number | null;
  }
  /** Same three ratios? Compared by VALUE so an unchanged reading is a no-op. */
  function sameReading(a: HealthReading | null, b: HealthReading | null): boolean {
    if (a === null || b === null) {
      return a === b;
    }
    return a.shieldRatio === b.shieldRatio && a.armorRatio === b.armorRatio && a.hullRatio === b.hullRatio;
  }
  let previousHealth = $state<HealthReading | null>(null);
  let takingDamageUntilMs = $state(0);
  let damageClock = $state(Date.now());
  $effect(() => {
    const current: HealthReading | null = ship
      ? { shieldRatio: ship.shieldRatio, armorRatio: ship.armorRatio, hullRatio: ship.hullRatio }
      : null;
    if (healthIsDropping(previousHealth, current)) {
      // Held briefly so a warning does not blink out between two polls that
      // happen to read the same value.
      takingDamageUntilMs = Date.now() + 6000;
    }
    // ⚠ WRITE ONLY WHEN THE READING ACTUALLY CHANGED. This effect READS
    // `previousHealth` and WRITES it; assigning a fresh object with identical
    // values every run would re-trigger the effect forever
    // (`effect_update_depth_exceeded`) the whole time the ship is in space with a
    // health reading. Guarding the write lets it settle after one update.
    if (!sameReading(previousHealth, current)) {
      previousHealth = current;
    }
  });
  $effect(() => {
    if (takingDamageUntilMs <= 0) {
      return;
    }
    const timer = setInterval(() => {
      damageClock = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
  const takingDamage = $derived(takingDamageUntilMs > damageClock);

  /** Overview rows get a hostile marker so the list itself is readable too. */
  function rowIsHostile(row: OverviewRow): boolean {
    return isHostile(row);
  }
  function rowBadge(row: OverviewRow): string {
    return hostileLabel(row) ?? "";
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

  // R30 slice B — this panel CLAIMS the space feed; it no longer owns it.
  // Other panels that show live space data claim it too, so leaving this tab
  // hands the feed over rather than switching it off. The feed still stops on
  // its own when the ship docks or the browser tab is hidden.
  onMount(() => {
    void run(() => flow.loadSpaceSnapshot());
    // R23: the ship's slots (so modules can be offered BY NAME) and the current
    // locks. Both are best-effort — neither may blank the overview if it fails.
    void flow.loadFitting().catch(() => {});
    void flow.loadTargets().catch(() => {});
    // R24 slice D — the ship's holds, so the in-space screen shows what is
    // actually accumulating. One read at open; after that the LIVE push channel
    // drives it (every OnItemsChanged the ore grant emits triggers a re-read),
    // so there is no second poll competing with the snapshot cadence.
    void flow.loadMiningHolds().catch(() => {});
    // R25 — the drone bay and what is already in space. Best-effort like the
    // reads above: a hull with no drone bay must not blank the overview.
    void flow.loadDrones().catch(() => {});
    flow.startSpacePolling();
    return () => flow.stopSpacePolling();
  });
</script>

<section class="panel" class:overview-compact={compact}>
  <header class="panel-head">
    <h2>Around your ship</h2>
  </header>
  <p class="note">
    Everything your ship can see, nearest first. Pick something in the list and
    the bar above it shows everything you can do to it.
  </p>
  {#if error}
    <p class="error">{error}</p>
  {:else if $space.error}
    <p class="error">{$space.error}</p>
  {/if}
</section>

<!--
  R30 slice C — the flight strip. Where you are, what is happening, what went
  wrong, and the one control that matters right now.

  This replaced a line that told a docked player to go to another tab to do the
  single thing they needed. Undock is here now, so that sentence is gone —
  deleted, not reworded, and a test asserts it cannot come back.
-->
<section class="flight-strip">
  <p class="strip-where">{whereText}</p>
  <!--
    Only rendered when a bot or the autopilot is actually running, and it is
    THEIR words. Hand-flying shows nothing here on purpose — see doingText.
  -->
  {#if doingText}
    <p class="strip-doing">{doingText}</p>
  {/if}
  {#if wrongText}
    <p class="strip-wrong error">{wrongText}</p>
  {/if}
  <!--
    ⚠ STOP IS NOT HERE ANY MORE, AND IT WAS NOT DELETED. It moved to the HUD's
    own footer (`HudBar.svelte`), which is always on screen in space — this
    window is one a player has to open, and the control you reach for when
    things are going wrong must not be behind that. The rule it carries went
    with it, comment and tests both: Stop is never disabled and never guarded.

    Undock stays, because this window is only reachable in space today and the
    docked arm is the strip's oldest promise — see the "Flight tab" test.
  -->
  {#if docked}
    <p class="controls">
      <button
        type="button"
        class="primary"
        disabled={concernBusy("move")}
        onclick={() => runFor("move", () => flow.undock())}
      >
        Undock
      </button>
      <!--
        R30 slice D — the refusal, at the control that caused it. Docked, the
        selection bar is not on screen at all, so this is the only place a move
        failure can be read; in space it is the bar's job and this is not drawn.
      -->
      {#if concernErrors.move}
        <span class="error">{concernErrors.move}</span>
      {/if}
    </p>
  {/if}
</section>

{#if !inSpace}
  <section>
    <p class="note">Undock to see what is around your ship.</p>
  </section>
{:else}
  <!--
    R25 slice B — the threat block. Deliberately ABOVE everything a player is
    likely to be reading while mining, and deliberately NOT a row in the
    overview: the overview is searchable, filterable and capped at 200 rows, so
    a miner who filtered to "Veldspar" would have filtered away the thing
    shooting them. This list reads the whole snapshot every poll.
  -->
  {#if takingDamage || threats.length > 0}
    <section class="threat" class:under-attack={takingDamage}>
      <h2>{takingDamage ? "You are taking damage" : "Hostiles nearby"}</h2>
      {#if takingDamage}
        <!--
          The honest version of "you are under attack": this says only what two
          consecutive readings of your own ship showed — a health layer went
          down. See the Ship condition bars above for which one, and "Shots
          fired" below for who has been shooting. This banner is NOT driven by
          that log: the live channel can drop frames, and a dropping shield is
          the fact that cannot be missed.
        -->
        <p class="note">
          Your ship's shield, armour or hull dropped in the last few seconds.
        </p>
      {/if}
      {#if arrivalNotice}
        <p class="arrival">{arrivalNotice}</p>
      {/if}
      {#if threats.length === 0}
        <p class="note">Nothing hostile is in range right now.</p>
      {:else}
        <ul class="threat-list">
          {#each threats as threat (threat.itemID)}
            <li>
              <span class="threat-badge">{rowBadge(threat)}</span>
              <span class="threat-name">{displayLabel(threat)}</span>
              <span class="threat-distance">{formatDistance(threat.distance)}</span>
              <span class="row-actions">
                {#if isLocked(threat.itemID)}
                  <button
                    type="button"
                    class="active"
                    disabled={busy}
                    onclick={() => run(() => flow.unlockTarget(threat.itemID))}
                  >
                    Release lock
                  </button>
                {:else if isAcquiring(threat.itemID)}
                  <button type="button" disabled>Locking…</button>
                {:else}
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() => run(() => flow.lockTarget(threat.itemID))}
                  >
                    Lock
                  </button>
                {/if}
                {#if allDroneIDs.length > 0}
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() => run(() => flow.engageDrones(allDroneIDs, threat.itemID))}
                  >
                    Send drones
                  </button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}


  <section class="ov-ship-condition">
    <h2>Ship condition</h2>
    {#if !ship}
      <p class="note">Reading your ship's condition…</p>
    {:else}
      <p class="note">{shipLabel()}</p>
      <div class="hud">
        {#each gauges as gauge (gauge.key)}
          <div class="hud-gauge {gauge.key}">
            <div class="hud-head">
              <span class="hud-label">{gauge.label}</span>
              <span class="hud-value">{gauge.percent === null ? "—" : `${gauge.percent}%`}</span>
            </div>
            <div
              class="hud-track"
              role="meter"
              aria-label={gauge.label}
              aria-valuenow={gauge.percent ?? 0}
              aria-valuemin="0"
              aria-valuemax="100"
            >
              <span class="hud-fill" style={`width: ${gauge.percent ?? 0}%`}></span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
    <!--
      R24 slice D — the LIVE hold, on the in-space screen rather than a tab away.
      Only holds this hull actually HAS appear: whether a ship has an ore hold,
      a gas hold, an ice hold or an asteroid hold is decided by whether the
      capacity attribute is populated, so a Venture and a Mammoth differ by DATA
      and nothing here special-cases either of them. What is not known reads as
      not known — an unknown fill is not an empty one.

      It stays fresh off the PUSH channel, not a poll: mining grants ore and
      emits OnItemsChanged, that frame reaches the browser, and the browser
      re-reads the hold from the ship. The notification is the trigger; the ship
      is the authority.
    -->
    {#if shipHolds.length > 0}
      <ul class="hold-strip">
        {#each shipHolds as hold (hold.key)}
          <li>
            <span class="hold-name">{hold.label}</span>
            <span class="hold-fill">{holdFillText(hold)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!--
    R30 slice D — THE SELECTION BAR.

    One bar, acting on one thing, replacing up to nine buttons on every one of
    up to 200 rows. What it offers is not decided here: `space/rowActions.ts`
    returns the verb list as data, and this renders it. That split is the whole
    point — a decision spelled out as {#if} blocks in markup can only be checked
    by a regex over markup, which proves nothing about the decision.

    It is `position: sticky` at desktop width so it stays reachable while you
    scroll a long grid. Sticky, NOT fixed: a sticky element still takes up its
    own space in the flow, so it cannot occlude the last row of the table the
    way a floating bar would — and that occlusion would be invisible at desktop
    width, which is where it would be shipped from. The fixed-bottom phone bar
    is a separate piece of work with its own body padding to compensate.
  -->
  <section class="selection-bar" aria-label="What you have picked">
    {#if selectionNotice}
      <!--
        ⚠ The selection is CLEARED and SAID, never silently moved. A bar that
        fell back to "the first row" would have the player press Warp to
        expecting one destination and get another.
      -->
      <p class="error">{selectionNotice}</p>
    {/if}
    <!--
      R30 slice E — YOUR SHIP's own verb, not the selection's. Taking what you
      have mined somewhere is squarely "what can I do right now", so it lives in
      the same bar, and it is drawn whether or not anything is picked.

      ⚠ It is ALWAYS drawn. Every reason it cannot run is a sentence on the
      control — no station on this grid, or nothing in the holds — because a
      player with a full hold who cannot find the haul verb has no way to tell
      whether the app forgot it or decided against it.
    -->
    <span class="row-actions ship-actions">
      {#each haulActions as action (action.id)}
        <button
          type="button"
          disabled={concernBusy(action.concern) || action.unavailable !== null}
          title={action.unavailable ?? ""}
          onclick={() => runRowAction(action)}
        >
          {action.unavailable ?? action.label}
        </button>
      {/each}
    </span>
    {#if concernErrors.hold}
      <p class="error">{concernErrors.hold}</p>
    {/if}
    {#if somewhereElseSelected}
      <!--
        R30 slice F — the destination search, in the cockpit.

        ⚠ Results are COMPONENT-LOCAL $state, never a store slice. They are a
        transient answer to a question this panel asked; the store holds what
        the SHIP reports. Travel.svelte made the same call for the same reason.

        Setting one hands off to `flow.startRoute` — the same R5b route solver
        and browser autopilot the Travel tab drives. This is one more caller of
        an existing path, not a second path.
      -->
      <p class="selection-name">Somewhere else…</p>
      <p class="controls">
        <label>
          Where to
          <input
            type="search"
            bind:value={destinationQuery}
            placeholder="system or station name"
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void searchDestinations();
              }
            }}
          />
        </label>
        <button
          type="button"
          disabled={concernBusy("route") || destinationQuery.trim().length < 2}
          onclick={() => searchDestinations()}
        >
          Search
        </button>
      </p>
      {#if concernErrors.route}
        <p class="error">{concernErrors.route}</p>
      {/if}
      {#if destinationSearched && destinationResults.length === 0}
        <p class="empty">Nothing on the star map matches that name.</p>
      {:else if destinationResults.length > 0}
        <ul class="destination-results">
          {#each destinationResults as match (match.id)}
            <li>
              <span class="destination-name">{match.name}</span>
              <span class="destination-where">
                {match.kind === "station"
                  ? (match.solarSystemName ?? "an unknown system")
                  : "Solar system"} · {jumpsText(match.jumps)}
              </span>
              <span class="row-actions">
                <button
                  type="button"
                  disabled={concernBusy("route")}
                  onclick={() => setDestination(match)}
                >
                  Set destination
                </button>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if !selectedRow}
      <p class="note">
        Pick anything in the list below to warp to it, fly towards it, orbit it,
        hold a distance from it, line your ship up with it, lock it or mine it.
        The last row sets a course anywhere else.
      </p>
    {:else}
      <p class="selection-name">{displayLabel(selectedRow)}</p>
      <p class="selection-what">
        {typeName(selectedRow)} · {formatDistance(selectedRow.distance)}
      </p>
      <span class="row-actions">
        <!-- R76 — Show Info, first in the bar because it is the one verb that
             never does anything to the ship: it answers "what IS that" before
             you commit to warping at it. It needs no server call and so is never
             disabled. -->
        <button
          type="button"
          class="minor"
          title={`Show info on ${displayLabel(selectedRow)}`}
          onclick={() =>
            selectedRow &&
            showInfo({
              kind: "spaceObject",
              itemID: selectedRow.itemID,
              typeID: selectedRow.typeID,
            })}
        >Show info</button>
        {#each selectionActions as action (action.id + action.label)}
          <!--
            An action that cannot be used right now is still DRAWN, disabled,
            wearing the sentence that says why (as its label and as its
            title/aria-description). Never a silent grey rectangle, and never
            missing entirely — a player cannot tell a forgotten button from a
            deliberate one.
          -->
          <button
            type="button"
            class={action.id === "unlock" ? "active" : ""}
            disabled={concernBusy(action.concern) || action.unavailable !== null}
            title={action.unavailable ?? ""}
            onclick={() => runRowAction(action)}
          >
            {action.unavailable ?? action.label}
          </button>
        {/each}
      </span>
      <!--
        The failure lands HERE, beside the buttons that caused it, and it is
        kept per concern — so a refused lock does not read as a refused warp,
        and neither of them greys out anything else.
      -->
      {#each ["move", "lock", "module", "route"] as const as concern (concern)}
        {#if concernErrors[concern]}
          <p class="error">{concernErrors[concern]}</p>
        {/if}
      {/each}
      <!--
        R30 slice E — ⚠ WHAT EACH MODULE DID, ONE LINE EACH.

        "Mine this" reaches for every powered-up module whose name reads like
        mining gear, and every one of those calls lands its outcome in the SAME
        store slot. Firing them all and showing the last answer would silently
        lose the other refusals — a player with two lasers would be told it
        worked while one of them never started. So each is read back right after
        its own call and named here, including the accepted-then-not-running
        case, which is a different failure from a refusal and reads differently.
      -->
      {#if mineReports.length > 0}
        <ul class="mine-reports">
          {#each mineReports as report (report.itemID)}
            <li class={report.ok ? "" : "error"}>
              <span class="mine-module">{report.label}</span>
              <span class="mine-outcome">{report.outcome}</span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>

  <section>
    <h2>Overview</h2>
    <p class="controls">
      <label>
        Search
        <input type="search" bind:value={search} placeholder="name, type or group" />
      </label>
      <label>
        Category
        <select bind:value={categoryFilter}>
          <option value="">All</option>
          {#each filterChoices.categories as choice (choice.id)}
            <option value={String(choice.id)}>{choice.label}</option>
          {/each}
        </select>
      </label>
      <label>
        Group
        <select bind:value={groupFilter}>
          <option value="">All</option>
          {#each filterChoices.groups as choice (choice.id)}
            <option value={String(choice.id)}>{choice.label}</option>
          {/each}
        </select>
      </label>
      <label>
        Sort by
        <select bind:value={sort}>
          <option value="distance">Distance</option>
          <option value="name">Name</option>
        </select>
      </label>
      <!--
        R23 slice B — the survey scanner. The ship can see the rocks around it
        without this, but not always how much ore is left in them; a scan fills
        the "Ore left" column in. Read-only: it mines nothing and moves nothing.
        Only offered when there are actually rocks on grid to scan.
      -->
      {#if rockCount > 0}
        <button type="button" disabled={busy} onclick={() => run(() => flow.runSurveyScan())}>
          Scan the rocks
        </button>
      {/if}
    </p>
    {#if $mining.surveyError}
      <p class="error">{$mining.surveyError}</p>
    {:else if $mining.surveyAtMs !== null && $mining.survey.length === 0}
      <p class="note">The scan came back empty — there was nothing minable in range.</p>
    {:else if rockCount > 0 && $mining.surveyAtMs === null}
      <p class="note">
        There are rocks here. Scan them to see how much ore each one still has.
      </p>
    {/if}

    <!-- R79 — the overview tabs, the retail client's own way of cutting a
         two-hundred-object grid down to the slice you are working with. The
         chosen tab is SHARED with the tactical viewport, so the picture shows
         the same slice; and no tab can hide something that is shooting at you
         (see space/overviewPresets.ts). -->
    <nav class="tabs overview-presets" aria-label="Overview filter">
      {#each OVERVIEW_PRESETS as preset (preset.id)}
        <button
          type="button"
          class={$presetIDSignal === preset.id ? "active" : ""}
          aria-pressed={$presetIDSignal === preset.id}
          title={preset.hint}
          onclick={() => overviewPreset.choose(preset.id)}
        >{preset.label}</button>
      {/each}
    </nav>
    {#if !$space.loaded}
      <p class="note">Looking around…</p>
    {:else if overview.rows.length === 0}
      <p class="empty">
        {#if activePreset.roles !== null}
          Nothing on this tab — try All, or clear the search and filters.
        {:else}
          Nothing matches — clear the search or filters to see everything.
        {/if}
      </p>
    {:else}
      {#if overview.matched > overview.rows.length}
        <!-- The only line kept: a truncation warning, so the 200-row cap never
             silently hides rows. The plain "showing x of y" count is gone. -->
        <p class="note">Only the nearest {overview.rows.length} are listed — search or filter to see the rest.</p>
      {/if}
      <!--
        R82 — THE GRID IS A LIST, NOT A TABLE.

        It was a six-column record table (name, type, group, distance, ore left,
        a Select button) and the place it is used most is the right-hand dock
        column, which is nowhere near six columns wide — so reading it meant
        scrolling sideways, in the one panel a pilot reads constantly.

        A table was the wrong shape for this data. Every column but the name and
        the distance is secondary, and the reflow contract that made a table
        survive a phone (each cell restated with its own label, stacked) produced
        a five-line block per object — which is worse again when there are two
        hundred of them.

        So each object is ONE ROW that cannot overflow: a picture, a name over a
        muted line of everything else, and the distance pinned right. The middle
        column truncates; nothing scrolls sideways at any width, and the desktop
        and the phone get the same thing rather than two layouts to keep in step.

        ⚠ THE ROW IS THE CONTROL NOW. It used to be a `<tr>` with an onclick and
        a separate Select button in the last column — a click target that was not
        a control, beside a control that did what clicking already did. It is a
        real `<button>` carrying `aria-pressed`, so it is keyboard reachable and
        announces its own selected state, and the column is gone.
      -->
      <ul class="overview-list overview-scroll">
        {#each gateRows as row (row.itemID)}
          <li>
            <button
              type="button"
              class="ov-row"
              class:hostile={rowIsHostile(row)}
              class:selected={selectedID === row.itemID}
              aria-pressed={selectedID === row.itemID}
              onclick={() => selectRow(row.itemID)}
              oncontextmenu={(event) => openRadial(event, row.itemID)}
              onpointerdown={(event) => startLongPress(event, row.itemID)}
              onpointerup={cancelLongPress}
              onpointercancel={cancelLongPress}
              onpointerleave={cancelLongPress}
            >
              <TypeIcon typeID={row.typeID} name={typeName(row)} />
              <span class="ov-main">
                <span class="ov-name">
                  <!--
                    R25 slice B — the badge carries the WORD, so the colour is
                    never the only signal (a player who cannot tell red from grey
                    still reads "Pirate").
                  -->
                  {#if rowIsHostile(row)}<span class="threat-badge">{rowBadge(row)}</span>{/if}
                  {displayLabel(row)}
                </span>
                <!--
                  Everything that used to be its own column, on one muted line.
                  Ore left is only meaningful for a rock and is simply absent
                  otherwise — a dash there means the amount is NOT KNOWN, and a
                  rock that really is empty says "Mined out".
                -->
                <span class="ov-meta">
                  {typeName(row)}{groupName(row) ? ` · ${groupName(row)}` : ""}{remainingLabel(row)
                    ? ` · ${remainingLabel(row)} left`
                    : ""}
                </span>
              </span>
              <span class="ov-range">{formatDistance(row.distance)}</span>
            </button>
          </li>
        {/each}
        <!--
          R30 slice F — the row that is not a thing in space.

          The overview can only ever offer what is on this grid. A destination
          that is neither on it nor through a gate you can see had no expression
          here at all, so the answer was always the Travel tab. This row is where
          "anywhere else" lives, and its verb is Set destination.

          It carries no distance, because it does not have one, and a dash is the
          honest way to say so.
        -->
        <li>
          <button
            type="button"
            class="ov-row synthetic-row"
            class:selected={somewhereElseSelected}
            aria-pressed={somewhereElseSelected}
            onclick={() => selectRow(SOMEWHERE_ELSE)}
          >
            <span class="ov-main">
              <span class="ov-name">Somewhere else…</span>
              <span class="ov-meta">Anywhere not on this grid</span>
            </span>
            <span class="ov-range">—</span>
          </button>
        </li>
      </ul>
      {#if $flight.actionError}
        <p class="error">{$flight.actionError}</p>
      {/if}
      <!--
        R30 slice A — an honest silence. If the star map could not be read we
        say so, because "this gate offers no jump" and "I could not tell where
        this gate goes" are different facts and a player acts differently on
        each. Warp to / Approach still work on the gate row regardless.
      -->
      {#if gateLinksError}
        <p class="note">{gateLinksError}</p>
      {/if}
    {/if}
  </section>

  <!--
    R23 slice A — the generic in-space action layer. Two sections, neither of
    which knows anything about mining: what you have locked, and what you can
    switch on. A later combat goal renders exactly these two sections.
  -->
  <section class="ov-locked-targets">
    <h2>Locked targets</h2>
    <p class="note">
      What your ship has a lock on. You need a lock before you can use most
      equipment on something. Locking takes a moment — your ship has to get a
      fix on it first.
    </p>
    <p class="note">
      Condition is shown as percentages because that is all the server sends for
      anything other than your own ship — there is no way to show a target's
      hit points, or how long it will take to break. A full shield bar on
      something you have not shot yet may just mean it has no shield to speak
      of: it will drop to nothing the moment you land a hit.
    </p>
    {#if lockedRows.length === 0}
      <p class="empty">Nothing is locked. Use Lock on any row below.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Target</th>
              <th>Type</th>
              <th class="num">Distance</th>
              <th>State</th>
              <th>Condition</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each lockedRows as locked (locked.itemID)}
              <tr>
                <td data-label="Target">{locked.label}</td>
                <td data-label="Type">
                  <span class="cell-item">
                    <TypeIcon typeID={locked.typeID} name={locked.typeLabel} />
                    {locked.typeLabel}
                  </span>
                </td>
                <td class="num" data-label="Distance">{locked.distance}</td>
                <td data-label="State">{locked.acquiring ? "Locking…" : "Locked"}</td>
                <td data-label="Condition">
                  {#if locked.shield === null && locked.armor === null && locked.hull === null}
                    <span class="stat-unavailable">Not known</span>
                  {:else}
                    <span class="target-condition">
                      {#each [{ key: "shield", label: "Shield", percent: locked.shield }, { key: "armor", label: "Armour", percent: locked.armor }, { key: "hull", label: "Hull", percent: locked.hull }] as layer (layer.key)}
                        <span class="hud-gauge {layer.key}">
                          <span class="hud-head">
                            <span class="hud-label">{layer.label}</span>
                            <span class="hud-value"
                              >{layer.percent === null ? "—" : `${layer.percent}%`}</span
                            >
                          </span>
                          <span
                            class="hud-track"
                            role="meter"
                            aria-label={`${layer.label} on ${locked.label}`}
                            aria-valuenow={layer.percent ?? 0}
                            aria-valuemin="0"
                            aria-valuemax="100"
                          >
                            <span class="hud-fill" style={`width: ${layer.percent ?? 0}%`}></span>
                          </span>
                        </span>
                      {/each}
                    </span>
                  {/if}
                </td>
                <td data-label="">
                  <span class="row-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onclick={() => run(() => flow.unlockTarget(locked.itemID))}
                    >
                      Release lock
                    </button>
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="ov-equipment">
    <h2>Your equipment</h2>
    <p class="note">
      Everything switched on and ready to run. Pick a locked target first if the
      equipment needs one — your ship will say so if it does.
    </p>
    <!--
      R30 slice E — this line used to send the player to the Fitting tab to
      power equipment up. That instruction is DELETED, not reworded: the table
      below now lists offline equipment alongside online, with Power up on the
      row, so it is no longer true. A test asserts the sentence cannot come
      back — which is why this comment describes it rather than quoting it.
    -->
    {#if moduleRows.length === 0}
      <p class="empty">
        This ship has nothing fitted that can be switched on.
      </p>
    {:else}
      <p class="controls">
        <label>
          Use it on
          <select bind:value={actionTargetID}>
            {#if selectableTargets.length > 0}
              <option value={AUTO_TARGET}>
                What I have locked ({selectableTargets[0].label})
              </option>
              {#each selectableTargets as locked (locked.itemID)}
                <option value={String(locked.itemID)}>{locked.label}</option>
              {/each}
            {:else}
              <option value={AUTO_TARGET}>Nothing locked yet</option>
            {/if}
            <option value={NO_TARGET}>Nothing — just switch it on</option>
          </select>
        </label>
      </p>
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Equipment</th>
              <th>Fitted in</th>
              <th>Running</th>
              <!--
                R24 slice C — one cycle's length. Where the ship has reported a
                cycle it is the pilot's real figure, skills and bonuses already
                counted; otherwise it is the equipment's own starting figure and
                the row SAYS so rather than quietly passing it off as the
                other one.
              -->
              <th>Cycle</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each moduleRows as module (module.itemID)}
              <tr>
                <td data-label="Equipment">{module.label}</td>
                <td data-label="Fitted in">{module.slotLabel}</td>
                <td data-label="Running">
                  <!--
                    R30 slice E — POWERED UP and RUNNING are two different
                    questions and are never collapsed into one word. A module
                    that is not powered up cannot be running, which is a fact
                    rather than a guess, so it does not go through the unknown
                    branch; "Not known" stays reserved for the case where the
                    server genuinely did not tell us.
                  -->
                  {#if !module.online}
                    Not powered up
                  {:else if module.running === null}
                    <span class="stat-unavailable">Not known</span>
                  {:else}
                    {module.running ? "Running" : "Idle"}
                  {/if}
                </td>
                <td data-label="Cycle">
                  {#if !module.cycle}
                    <span class="stat-unavailable">Not known</span>
                  {:else}
                    <span>{cycleLengthLabel(module.cycle)}</span>
                    {#if module.cycle.source === "base"}
                      <!--
                        R9a in one word: "before skills". The player is told
                        plainly that this is the equipment's own figure and not
                        theirs, rather than being handed a number that will not
                        match what their ship does.
                      -->
                      <span class="note"> before skills</span>
                    {/if}
                    {#if cycleProgressPercent(module.cycle) !== null}
                      <progress
                        max="100"
                        value={cycleProgressPercent(module.cycle)}
                        aria-label="Cycle progress"
                      ></progress>
                    {/if}
                  {/if}
                </td>
                <td data-label="">
                  <span class="row-actions">
                    <!--
                      R30 slice E — POWER, on the row. This is the one click the
                      panel used to send the player to the Fitting tab for.
                      Powering up is not the same as switching on: a module has
                      to be online before it can run at all, so both controls
                      are here and they are labelled as the different things
                      they are.
                    -->
                    {#if !module.online}
                      <button
                        type="button"
                        disabled={concernBusy("module")}
                        onclick={() => setModulePower(module, true)}
                      >
                        Power up
                      </button>
                    {:else}
                      <button
                        type="button"
                        class={module.running === true ? "active" : ""}
                        disabled={busy || module.running === true}
                        onclick={() =>
                          run(() =>
                            flow.activateModule(module.itemID, {
                              targetID: effectiveTargetID > 0 ? effectiveTargetID : null,
                            }),
                          )}
                      >
                        Switch on
                      </button>
                      <button
                        type="button"
                        disabled={busy || module.running === false}
                        onclick={() =>
                          run(() => flow.deactivateModule(module.itemID, { typeID: module.typeID }))}
                      >
                        Switch off
                      </button>
                      <button
                        type="button"
                        disabled={concernBusy("module")}
                        onclick={() => setModulePower(module, false)}
                      >
                        Power down
                      </button>
                    {/if}
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <!--
      Two different failures, said differently on purpose. A refusal carries the
      server's OWN words. A silent decline is when the call came back fine, the
      re-read showed nothing changed, and the server gave no reason — the page
      says exactly that rather than inventing a cause.
    -->
    {#if $targeting.actionError}
      <p class="error">{$targeting.actionError}</p>
    {/if}
    {#if $targeting.silentDecline}
      <p class="error">{$targeting.silentDecline}</p>
    {/if}
    <!--
      R30 slice E — a power change that did not take. `setModuleOnline` re-reads
      the fitting itself, so this is checked against freshly-read authoritative
      state: if the module's own online flag did not move, the server declined
      and said nothing, and that is reported as exactly that.
    -->
    {#if moduleNotice}
      <p class="error">{moduleNotice}</p>
    {/if}
    {#if $fitting.actionError}
      <p class="error">{$fitting.actionError}</p>
    {/if}
  </section>

  <!--
    R30 slice F — COLLAPSED, and moved below the grid.

    These are three distances a player picks ONCE and then applies to every row
    for the rest of the session — retail's right-click submenus, flattened. They
    had a full section above the list they modify, which put a settings panel
    between the player and the thing they came to read. Collapsed by default and
    below the grid: still one click away, no longer in the way.

    Native <details>. No JS, no state to get out of sync, keyboard-operable and
    screen-reader-announced for free — and the summary carries the CURRENT
    values, so a collapsed panel never hides what it is set to.
  -->
  <details class="collapsible">
    <summary>
      <span class="collapse-title">Flying distances</span>
      <span class="collapse-hint">
        Warp {warpLabel} · Orbit {orbitLabel} · Hold {holdLabel}
      </span>
    </summary>
    <p class="note">
      Warp to, Orbit and Keep at range use these distances on whatever you have
      picked — change them under <strong>Settings</strong>. Stop cuts the engines
      and switches the autopilot off, so nothing starts flying you somewhere again.
    </p>
    <p class="controls">
      <button type="button" disabled={busy} onclick={() => run(() => flow.stopShip())}>
        Stop the ship
      </button>
    </p>
  </details>

  <!--
    R25 slice A — drones. Two lists, because they are two different things: what
    is sitting in the bay (launchable) and what is already flying (orderable).

    ⚠ LAUNCHING IS THE DEFENCE. The server auto-engages idle combat drones
    against whatever shoots your ship, so a miner who launches is defended
    without touching Engage at all. The note below says that plainly, because a
    player who does not know it will sit there clicking.

    The two limits are SHOWN and never enforced here: the server owns both, and
    a browser that pre-guessed them would either block a legal launch or promise
    an illegal one.

    R30 slice F — COLLAPSED, and moved below the grid. A hull with no drone bay
    still had two empty lists and a paragraph of explanation sitting between the
    player and the overview, on every single poll. The summary carries the count
    that matters — how many are OUT — so a collapsed panel never hides the fact
    that you have drones in space, which is the one thing you must not miss.
  -->
  <details class="collapsible">
    <summary>
      <span class="collapse-title">Drones</span>
      <span class="collapse-hint">{droneSummary}</span>
    </summary>
    <p class="note">
      Drones you launch defend you on their own — they will attack anything that
      shoots your ship, without you doing anything else. Use Attack to pick a
      target yourself, or Bring home to call them back.
    </p>
    <p class="note">{droneLimitText}</p>
    {#if $drones.error}
      <p class="error">{$drones.error}</p>
    {/if}
    {#if $drones.actionError}
      <p class="error">{$drones.actionError}</p>
    {/if}
    {#if $drones.silentDecline}
      <p class="error">{$drones.silentDecline}</p>
    {/if}
    <!--
      R34 — WHAT THE SERVER ITSELF SAID, ONE LINE PER DRONE.

      ⚠ THESE ARE NOT OUR WORDS. `droneRuntime.js` refuses a drone order one
      drone at a time and writes a plain-language sentence for each — thirteen
      of them across engage, mine, salvage, scoop and recall. The BFF used to
      forward only the notifications, so every one of those sentences was
      thrown away and a refused order looked, to the player, exactly like a
      successful one. This is the recovered text, unedited.

      ⚠ AND IT IS A LIST FOR R30'S REASON. An order fans out over the whole
      flight and each drone answers separately; the two error paragraphs above
      are single slots, and R30 measured what a single slot does to a fan-out —
      with two Strip Miner Is, a later success cleared the slot and the earlier
      refusal vanished. One drone, one line, no merging, no deduplication.

      ⚠ NAMES ONLY (R7d). The server keys these by droneID; `flow.ts` spends
      that key on a name lookup and the report type has no id field at all, so
      there is nothing here for this markup to leak. A drone we cannot name
      reads "One of your drones" — never the number.
    -->
    {#if $drones.orderReports.length > 0}
      <ul class="drone-reports">
        {#each $drones.orderReports as report}
          <li class="error">
            <span class="drone-name">{report.label ?? "One of your drones"}</span>
            <span class="drone-outcome">{report.text}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <h3>In space</h3>
    {#if dronesInSpace === null}
      <!-- null is "we could not look", which must never read as "none out". -->
      <p class="note">
        {$drones.loaded ? "Your drones in space could not be read." : "Looking…"}
      </p>
    {:else if spaceRows.length === 0}
      <p class="empty">No drones out.</p>
    {:else}
      <ul class="drone-list">
        {#each spaceRows as drone (drone.itemID)}
          <li>
            <span class="drone-name">{drone.label}</span>
            <span class="drone-activity">
              {drone.activity}{drone.targetLabel ? ` — ${drone.targetLabel}` : ""}
            </span>
            <span class="row-actions">
              <!--
                R33 — the control says what it can do, or why it cannot.

                ⚠ THE REASON IS THE LABEL, exactly as R30's haul verb does it.
                A greyed "Bring home" with the explanation hidden in a tooltip
                is the silent decline again, one layer up: a player on a touch
                screen never sees a `title`, and a player who does see it has
                already pressed. This is the ninth confirmed silent decline on
                this server, and every one of them looked like a live button.
              -->
              <button
                type="button"
                disabled={busy || drone.unavailable !== null}
                title={drone.unavailable ?? ""}
                onclick={() => run(() => flow.recallDrones([drone.itemID]))}
              >
                {drone.unavailable ?? "Bring home"}
              </button>
              {#if drone.recoverable}
                <!--
                  The way back for a drone this hull cannot fly. Two verbs
                  because they fail for different reasons and one covers the
                  other: Reconnect needs the drone to answer, Scoop needs only
                  range. Both are live whenever the drone is out of control, and
                  the SERVER decides which one works — the panel would have to
                  guess at distance to pre-refuse either.
                -->
                <button
                  type="button"
                  disabled={busy}
                  title="Take control of this drone again"
                  onclick={() => run(() => flow.reconnectDrones([drone.itemID]))}
                >
                  Reconnect
                </button>
                <button
                  type="button"
                  disabled={busy}
                  title="Pull this drone straight into your bay"
                  onclick={() => run(() => flow.scoopDrones([drone.itemID]))}
                >
                  Scoop
                </button>
              {/if}
            </span>
          </li>
        {/each}
      </ul>
      <p class="controls">
        <!--
          Acting on the LOCKED target, reusing R23's auto-target default:
          locking something makes it what your equipment acts on, and drones are
          no different. (The server does not actually require a lock for
          CmdEngage — this is a UI choice, so a player only ever sends drones at
          something they deliberately picked.)
        -->
        <!--
          R33 — all three group orders carry the SAME server gate. eve.js
          refuses recall, engage and mine alike unless the drone's controllerID
          is this hull, so all three act on `allDroneIDs`, which has already
          dropped the drones we know are not ours to fly — and kept every drone
          we could not check.
        -->
        <button
          type="button"
          disabled={busy || effectiveTargetID <= 0 || groupOrderUnavailable !== null}
          title={groupOrderUnavailable ?? ""}
          onclick={() => run(() => flow.engageDrones(allDroneIDs, effectiveTargetID))}
        >
          {groupOrderUnavailable ?? "Attack what I have locked"}
        </button>
        <button
          type="button"
          disabled={busy || effectiveTargetID <= 0 || groupOrderUnavailable !== null}
          title={groupOrderUnavailable ?? ""}
          onclick={() => run(() => flow.mineWithDrones(allDroneIDs, effectiveTargetID))}
        >
          {groupOrderUnavailable ?? "Mine what I have locked"}
        </button>
        <button
          type="button"
          disabled={busy || groupOrderUnavailable !== null}
          title={groupOrderUnavailable ?? ""}
          onclick={() => run(() => flow.recallDrones(allDroneIDs))}
        >
          {groupOrderUnavailable ?? "Bring them all home"}
        </button>
      </p>
      {#if effectiveTargetID <= 0}
        <p class="note">Lock something first to give your drones a target.</p>
      {/if}
    {/if}

    <h3>In the bay</h3>
    {#if droneBay === null}
      <p class="note">
        {$drones.loaded ? "Your drone bay could not be read." : "Looking…"}
      </p>
    {:else if bayRows.length === 0}
      <p class="empty">Nothing in the drone bay.</p>
    {:else}
      <ul class="drone-list">
        {#each bayRows as stack (stack.itemID)}
          <li>
            <label class="drone-pick">
              <input
                type="checkbox"
                checked={launchPicks[stack.itemID] === true}
                onchange={() => toggleLaunchPick(stack.itemID)}
              />
              <span class="drone-name">{stack.label}</span>
            </label>
            <span class="drone-activity">In the bay</span>
            <span class="row-actions">
              <button
                type="button"
                disabled={busy}
                onclick={() => run(() => flow.launchDrones([stack.itemID]))}
              >
                Launch
              </button>
            </span>
          </li>
        {/each}
      </ul>
      <p class="controls">
        <button
          type="button"
          disabled={busy || pickedForLaunch.length === 0}
          onclick={() => run(() => flow.launchDrones(pickedForLaunch))}
        >
          Launch the ones I picked
        </button>
      </p>
    {/if}
  </details>

  <section class="ov-shots">
    <h2>Shots fired</h2>
    <p class="note">
      Every hit the server told us about, newest first — both the ones you land
      and the ones you take. This is a running commentary, not a tally: the live
      channel is allowed to drop and pick up again, so shots can be missing from
      this list. The condition bars above are read from your ship and your
      target, and those are the numbers to trust.
    </p>
    {#if damageRows.length === 0}
      <p class="empty">
        Nothing has been shot at, or by, your ship since this page came online.
      </p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>What happened</th>
              <th>Weapon</th>
              <th class="num">Damage</th>
            </tr>
          </thead>
          <tbody>
            {#each damageRows as shot (shot.id)}
              <tr>
                <td data-label="What happened">{shot.summary}</td>
                <td data-label="Weapon">{shot.weaponLabel}</td>
                <td class="num" data-label="Damage">{shot.amountLabel}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

{#if radial && radialItems.length > 0}
  <!-- R77 — the ring. Rendered last so it sits over the grid, and given the
       selected thing's name so a screen reader is told WHAT the menu is for
       rather than just "Actions". -->
  <RadialMenu
    items={radialItems}
    x={radial.x}
    y={radial.y}
    label={selectedRow ? `Actions for ${displayLabel(selectedRow)}` : "Actions"}
    onPick={pickRadial}
    onClose={() => (radial = null)}
  />
{/if}


