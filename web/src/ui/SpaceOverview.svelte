<script lang="ts">
  // THE OVERVIEW — the right-hand dock panel while IN SPACE.
  //
  // What is around your ship, what you have picked, and everything you can do
  // to it. The counterpart of `StationPanel.svelte`, which is the same frame
  // while docked, and it is arranged the same way: its own header, a filter
  // row, a sticky column header, rows that earn columns as the panel gets
  // wider, and a pinned strip at the top that cannot be scrolled away.
  //
  // ⚠ IN SPACE ONLY, AND THAT IS LOAD-BEARING. `DockPanel.svelte` branches on
  // `isDocked`: the Station panel on one side, this on the other. Nothing here
  // is reachable by a docked pilot, and `spaceWorkspaceStates.test.ts` fails if
  // that ever stops being true.
  //
  // ⚠ IT OWNS ALMOST NO RULES. Which verbs exist for a thing, whether a preset
  // may hide it, how far away it is and how that reads — all of it already
  // lives in `space/rowActions.ts`, `space/overviewPresets.ts` and
  // `space/overview.ts`, shared with the radar and with `Overview.svelte`. This
  // file is a re-skin of that model, not a second copy of it. The one piece of
  // state it does own is which distance the ranged verbs fly at, and even that
  // is written straight through to `flyingDistances` — see `spaceRanges.ts`.
  //
  // ⚠ AND THE THREAT STRIP IS NOT IN THE HANDOFF. It is kept deliberately: it
  // is the only place the client says you are under attack, it deliberately
  // bypasses the row cap and every filter, and "no preset can hide something
  // that is shooting at you" is a rule the presets exist to keep.
  import { onMount } from "svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { SELECTION_GONE, selectionHasVanished, spaceSelection } from "../space/selection.ts";
  import { overviewPreset } from "../space/overviewPreset.ts";
  import { OVERVIEW_PRESETS, applyPreset } from "../space/overviewPresets.ts";
  import {
    buildOverviewRows,
    formatDistance,
    hostileLabel,
    hostileRows,
    isHostile,
    type OverviewRow,
    type OverviewSort,
  } from "../space/overview.ts";
  import {
    actionsForRow,
    activatableModules,
    isDockableKind,
    miningModules,
    type ActionConcern,
    type RowAction,
    type RowActionID,
  } from "../space/rowActions.ts";
  import { dispatchRowAction, isSingleCallAction } from "../space/rowActionRunner.ts";
  import { gateLinkFor, type GateLink } from "../space/gateLinks.ts";
  import { orderableDroneIDs } from "./droneFlight.ts";
  import { SPACE_ACTION_GLYPHS, RANGED_ACTIONS, SHORT_ACTION_CAPTION } from "./spaceActionIcons.ts";
  import { flyingDistances, setDistance } from "./flyingDistances.ts";
  import {
    RANGE_PRESETS,
    isPresetRange,
    parseCustomRange,
    rangeName,
    rangeStorageKey,
    storedRangeMetres,
    type RangeKind,
  } from "./spaceRanges.ts";
  import { resolvedName, nameKey, type NameRef } from "../store/names.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { SpaceEntity } from "../store/types.ts";

  let {
    store,
    flow,
    onCollapse = null,
  }: {
    store: ClientStore;
    flow: AppFlow;
    /** Fold the panel to the dock's thin strip. The panel carries the control. */
    onCollapse?: (() => void) | null;
  } = $props();

  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const targeting = store.targeting;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const drones = store.drones;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const mining = store.mining;

  /**
   * The nearest N rows the list keeps.
   *
   * ⚠ The preset is applied BEFORE this, never after: filtering afterwards
   * would let 200 gates crowd every rock off the Mining tab while the tab
   * claimed to be showing rocks.
   */
  const ROW_CAP = 200;

  let search = $state("");
  let sortKey = $state<OverviewSort>("distance");
  let sortDir = $state<1 | -1>(1);
  /** Which ranged verb has its distance menu open, or null. */
  let rangeMenu = $state<RangeKind | null>(null);
  let customRange = $state("");
  let customRangeError = $state("");

  /**
   * ⚠ A SET, NOT A FLAG. A single shared busy flag greys out every verb because
   * a lock request happens to be pending — including Stop, in the middle of a
   * fight. A control may only ever be disabled by its OWN concern being in
   * flight. Do not clean this up.
   */
  let busy = $state<ReadonlySet<ActionConcern>>(new Set());
  let concernErrors = $state<Partial<Record<ActionConcern, string>>>({});

  const snapshot = $derived($space.snapshot ?? null);
  const ship = $derived(snapshot?.ship ?? null);
  const origin = $derived(ship?.position ?? { x: 0, y: 0, z: 0 });

  // --- the list ---------------------------------------------------------------

  const presetSignal = overviewPreset.preset;
  const presetIDSignal = overviewPreset.id;
  const activePreset = $derived($presetSignal);
  const activePresetID = $derived($presetIDSignal);

  const presetSnapshot = $derived.by(() => {
    if (!snapshot || activePreset.roles === null) {
      return snapshot;
    }
    return { ...snapshot, entities: applyPreset(snapshot.entities, activePreset) };
  });

  function typeName(entity: SpaceEntity): string {
    return resolvedName($names.resolved, "type", entity.typeID, "—");
  }

  function groupName(entity: SpaceEntity): string {
    return $names.resolved[nameKey("typeGroup", entity.typeID ?? 0)] ?? "—";
  }

  const overview = $derived.by(() =>
    buildOverviewRows(presetSnapshot, origin, {
      sort: sortKey,
      cap: ROW_CAP,
      filter: { text: search },
      // The search matches what the player SEES, so it searches the resolved
      // type and group names too — not only the object's own name.
      names: (entity) => ({
        typeName: $names.resolved[nameKey("type", entity.typeID ?? 0)] ?? null,
        groupName: $names.resolved[nameKey("typeGroup", entity.typeID ?? 0)] ?? null,
      }),
    }),
  );

  // ⚠ Delivered WITH the snapshot, never recomputed here: the links describe
  // the same grid the entities do, so they can never label a gate from a
  // different system's map.
  const gateLinks = $derived($space.gateLinks ?? []);

  /**
   * The rows the list iterates, each carrying its own gate link.
   *
   * ⚠ The link is folded into the ROW rather than looked up inside the loop —
   * a lookup there kept the `null` it first rendered with when the links
   * arrived a moment later, and not one Jump button ever appeared.
   */
  const rows = $derived.by<readonly (OverviewRow & { gateLink: GateLink | null })[]>(() => {
    const built = overview.rows.map((row) => ({
      ...row,
      gateLink: gateLinkFor(gateLinks, row.itemID),
    }));
    // ⚠ Reversed for DISPLAY only. The cap keeps the NEAREST rows, so "farthest
    // first" is the far end of what is on the list, not of what is on the grid —
    // which is why the truncation line below is never hidden.
    return sortDir === 1 ? built : [...built].reverse();
  });

  const truncated = $derived(overview.matched > overview.rows.length);

  // --- what is picked ---------------------------------------------------------

  const selectedSignal = spaceSelection.selected;
  const noticeSignal = spaceSelection.notice;
  const selectedID = $derived($selectedSignal);
  const selectionNotice = $derived($noticeSignal);

  /**
   * ⚠ THE THING YOU PICKED CAN LEAVE THE GRID, AND YOU HAVE TO BE TOLD.
   *
   * A rock is mined out, a ship warps off — and the action bar would go on
   * offering warp and lock against an id the server no longer knows, failing
   * with a refusal about something that is not on screen. The cockpit dropped
   * the selection with a notice; when it was deleted this went with it, and
   * `selectionHasVanished` was left with no caller at all.
   *
   * The check is caller-driven on purpose: the panel owns WHEN to ask, which is
   * once per snapshot, and the sentinel case answers false because a destination
   * that is not a ball in space can never leave one.
   */
  $effect(() => {
    const present = new Set((snapshot?.entities ?? []).map((entity) => entity.itemID));
    if (snapshot !== null && selectionHasVanished(selectedID, present)) {
      spaceSelection.dropWithNotice(SELECTION_GONE);
    }
  });

  /**
   * ⚠ LOOKED UP IN THE CURRENT ROWS EVERY TIME. A rock gets mined out and a ship
   * warps off; a bar holding the row it was handed would keep offering verbs
   * for something that is no longer there, and one that fell back to "the first
   * row" would quietly point Warp to at a different destination than the one on
   * screen.
   */
  const selectedRow = $derived(rows.find((row) => row.itemID === selectedID) ?? null);

  const lockedIDs = $derived(new Set($targeting.lockedTargetIDs ?? []));
  const acquiringIDs = $derived(new Set($targeting.acquiringTargetIDs ?? []));

  const selectedActions = $derived.by<readonly RowAction[]>(() => {
    const row = selectedRow;
    if (!row) {
      return [];
    }
    return actionsForRow({
      kind: row.kind,
      locked: lockedIDs.has(row.itemID),
      acquiring: acquiringIDs.has(row.itemID),
      gateLink: row.gateLink,
      // ⚠ FOUND LIVE: THIS WAS NEVER PASSED, so "Mine this" was permanently
      // disabled reading "No mining equipment is switched on" — on a hull with
      // three powered-up Miner Is. `minerCount ?? 0` defaults to zero, which is
      // the safe direction for a context field but makes an unset one look
      // exactly like an honest refusal. The verb was unreachable from this
      // panel from the day it was written, and no test caught it because the
      // action bar only renders once a row is picked, which SSR never does.
      minerCount: minerRows.length,
    });
  });

  function pick(itemID: number): void {
    rangeMenu = null;
    concernErrors = {};
    spaceSelection.toggle(itemID);
  }

  // --- doing things -----------------------------------------------------------

  async function runFor(concern: ActionConcern, act: () => Promise<void>): Promise<void> {
    if (busy.has(concern)) {
      return;
    }
    busy = new Set([...busy, concern]);
    concernErrors = { ...concernErrors, [concern]: undefined };
    try {
      await act();
    } catch (cause) {
      const words = isSessionLost(cause)
        ? "The live session ended (idle timeout or another client took over)."
        : panelErrorWords(cause);
      concernErrors = { ...concernErrors, [concern]: words };
    } finally {
      const next = new Set(busy);
      next.delete(concern);
      busy = next;
    }
  }

  /** The distances the dispatcher flies at, as the player has them set. */
  const ranges = $derived({
    warp: Number($flyingDistances.warp),
    orbit: storedRangeMetres($flyingDistances.orbit, 1000),
    hold: storedRangeMetres($flyingDistances.hold, 1000),
  });

  function rangeFor(kind: RangeKind): number {
    return kind === "orbit" ? ranges.orbit : ranges.hold;
  }

  // --- the two verbs that are NOT one call -----------------------------------
  //
  // ⚠ `mine` AND `haul` EACH NEED THEIR OWN REPORTING, which is why
  // `rowActionRunner.ts` refuses to run them rather than pretending it can.
  // Mine reaches for every powered-up laser and each answers separately; haul
  // runs a docking ladder and then a move. Both were the last things left in
  // the old cockpit.

  /** Every module the ship could switch on, named and grouped from the cache. */
  const activatable = $derived(
    activatableModules(
      $fitting.slots,
      (typeID) => resolvedName($names.resolved, "type", typeID, "") || null,
      (typeID) => $names.resolved[nameKey("typeGroup", typeID)] ?? null,
    ),
  );
  /**
   * The lasers "Mine this" will reach for — high-slot, powered up, and filed by
   * the GAME under a mining group.
   *
   * ⚠ SLOT AND GROUP TOGETHER, through the shared derivation. A module whose
   * group has not resolved yet is left out — "cannot tell", not a claim it is
   * idle — and joins as the group lands.
   */
  const minerRows = $derived(miningModules(activatable));

  /**
   * ⚠ ASK FOR THE FIT, AND FOR THE GROUP NAMES THAT DECIDE WHAT A MINER IS.
   *
   * FOUND LIVE: "Mine this" sat disabled reading "No mining equipment is
   * switched on" on a hull with three powered-up Miner Is. `miningModules`
   * needs the GAME'S GROUP name for each module — that is the whole point of
   * R47, replacing an English-name guess with the game's own answer — and
   * nothing on screen was asking the cache for `typeGroup`. A `null` group is
   * "cannot tell", so every laser was correctly excluded, and the panel
   * correctly reported a state that was not true.
   *
   * The fit itself is requested for the same reason the rack learned to: relying
   * on another component's mount order is how a panel goes quiet when that
   * component is a window nobody opened, or a HUD that mobile does not draw.
   */
  $effect(() => {
    if (!$fitting.loaded) {
      void flow.loadFitting().catch(() => {});
      return;
    }
    const refs: NameRef[] = [];
    const seen = new Set<number>();
    for (const slot of $fitting.slots) {
      const typeID = slot.module?.typeID;
      if (typeof typeID !== "number" || seen.has(typeID)) {
        continue;
      }
      seen.add(typeID);
      if (($names.resolved[nameKey("typeGroup", typeID)] ?? null) === null) {
        refs.push({ kind: "typeGroup", id: typeID });
      }
      if (resolvedName($names.resolved, "type", typeID, "") === "") {
        refs.push({ kind: "type", id: typeID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  /**
   * What each module did when Mine this reached for it.
   *
   * ⚠ THIS IS WHY MINE IS NOT A FAN-OUT-AND-FORGET. Every one of these calls
   * lands its outcome in the SAME store slot, so a loop that just fired them
   * all would leave only the last module's answer on screen and quietly lose
   * the other refusals. Each module is read back individually right after its
   * own call, and a module that was accepted-then-not-run (a silent decline) is
   * reported as distinctly as one refused outright.
   */
  let mineReports = $state<readonly { label: string; outcome: string; ok: boolean }[]>([]);

  async function mineThis(targetID: number): Promise<void> {
    await runFor("module", async () => {
      const reports: { label: string; outcome: string; ok: boolean }[] = [];
      for (const module of minerRows) {
        const label = module.label ?? "A mining laser";
        // repeat: -1 is what mining MEANS — cycle after cycle until something
        // stops it. The same argument the mining bot uses.
        await flow.activateModule(module.itemID, { targetID, repeat: -1 });
        // Read the AUTHORITY, not the return value. A successful action clears
        // both slots, so whatever is in them now belongs to THIS module.
        const refused = $targeting.actionError;
        const declined = $targeting.silentDecline;
        const running = $space.snapshot?.ship?.activeModuleIDs ?? null;
        if (refused) {
          reports.push({ label, outcome: refused, ok: false });
        } else if (declined) {
          reports.push({ label, outcome: declined, ok: false });
        } else if (running !== null && !running.includes(module.itemID)) {
          reports.push({
            label,
            outcome: "Started, and your ship does not show it running.",
            ok: false,
          });
        } else {
          reports.push({ label, outcome: "Running on it.", ok: true });
        }
      }
      mineReports = reports;
    });
  }

  /** Everything on this grid you could dock at, nearest first. By NAME (R7d). */
  const stationsOnGrid = $derived(
    rows.filter((row) => isDockableKind(row.kind)).map((row) => ({
      itemID: row.itemID,
      label: rowName(row),
    })),
  );
  /** Every stack sitting in a hold — what a haul actually moves. */
  const holdItemIDs = $derived(
    $mining.holds.flatMap((hold) => (hold.items ?? []).map((item) => item.itemID)),
  );

  /**
   * Take the ore somewhere and put it down.
   *
   * Docked, that is one call. In space it is the R24 ladder (which closes the
   * distance itself and narrates each phase) followed by a RE-READ of the holds
   * — because the stack ids a station hangar will accept are read AFTER the
   * dock, not before it, and a 200 on the dock is not proof it happened.
   */
  async function haulNow(): Promise<void> {
    await runFor("hold", async () => {
      if (inSpaceNow) {
        const station = stationsOnGrid[0];
        if (!station) {
          return;
        }
        await flow.dockAt(station.itemID);
      }
      await flow.loadMiningHolds();
      const ids = $mining.holds.flatMap((hold) => (hold.items ?? []).map((item) => item.itemID));
      if (ids.length === 0) {
        return;
      }
      await flow.unloadMiningHolds(ids);
      // And read them again, so what the panel shows is what the ship has —
      // not what the call said it would have.
      await flow.loadMiningHolds();
    });
  }

  function runAction(action: RowAction): void {
    const row = selectedRow;
    if (!row || action.unavailable !== null) {
      return;
    }
    rangeMenu = null;
    mineReports = [];
    // ⚠ THE TWO MULTI-STEP VERBS ARE RUN HERE, NOT DELEGATED. They used to be
    // answered with "…is in the Around Your Ship window for now", which was a
    // pointer to a window that no longer exists. `rowActionRunner.ts` still
    // refuses them, correctly: it is the SINGLE-CALL dispatcher, and these two
    // need reporting it has no way to produce.
    if (!isSingleCallAction(action.id)) {
      if (action.id === "mine") {
        void mineThis(row.itemID);
      } else if (action.id === "haul") {
        void haulNow();
      }
      return;
    }
    void runFor(action.concern, async () => {
      await dispatchRowAction(
        flow as never,
        action.id,
        { itemID: row.itemID, gateLink: row.gateLink },
        ranges,
      );
    });
  }

  /** Pick a distance AND fly it — the menu is a shortcut, not a settings page. */
  function chooseRange(kind: RangeKind, metres: number): void {
    setDistance(rangeStorageKey(kind), String(metres));
    rangeMenu = null;
    customRangeError = "";
    const action = selectedActions.find((a) => a.id === (kind === "orbit" ? "orbit" : "keepAtRange"));
    if (action) {
      runAction(action);
    }
  }

  function useCustomRange(kind: RangeKind): void {
    const metres = parseCustomRange(customRange);
    if (metres === null) {
      // ⚠ Said, not swallowed. A typed value that quietly does nothing is worse
      // than one that is refused, because the player believes it took.
      customRangeError = "Type a distance in kilometres — 7, or 2.5.";
      return;
    }
    customRange = "";
    chooseRange(kind, metres);
  }

  function sortBy(key: OverviewSort): void {
    if (sortKey === key) {
      sortDir = sortDir === 1 ? -1 : 1;
    } else {
      sortKey = key;
      sortDir = 1;
    }
  }

  function sortArrow(key: OverviewSort): string {
    return sortKey === key ? (sortDir === 1 ? "▲" : "▼") : "";
  }

  // --- threats ----------------------------------------------------------------
  //
  // ⚠ READ FROM THE WHOLE SNAPSHOT, uncapped and unfiltered. A preset may not
  // hide something that is shooting at you, and neither may the row cap or the
  // search box. This is the only place the client says you are under attack.
  const threats = $derived(hostileRows(snapshot, origin));

  /**
   * The drones a "Send drones" on a threat row may be issued with.
   *
   * ⚠ THIS CONTROL CAME BACK FROM THE COCKPIT, AND IT HAD TO. `Overview.svelte`
   * put it on every hostile row — the fastest path in the whole client from
   * "something is shooting me" to "my drones are on it", with no locking and no
   * window to open first. Deleting the cockpit without it would have taken that
   * path away and left only the drones window, which is two clicks and a lock.
   *
   * The gate itself is `droneFlight.ts`, shared with that window rather than
   * copied: the branch a second copy gets wrong is the `null` one, where the
   * snapshot did not carry a drone and neither panel can tell.
   */
  const orderableDrones = $derived(
    orderableDroneIDs($drones.inSpace, snapshot?.entities ?? null, snapshot?.ship?.itemID ?? null),
  );
  const takingDamage = $derived(
    ($targeting.damageLog ?? []).some((event) => event.direction === "taken"),
  );

  // --- names ------------------------------------------------------------------

  $effect(() => {
    const refs: NameRef[] = [];
    for (const entity of snapshot?.entities ?? []) {
      if (entity.typeID) {
        refs.push({ kind: "type", id: entity.typeID });
        refs.push({ kind: "typeGroup", id: entity.typeID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  function rowName(entity: SpaceEntity): string {
    return entity.name ?? typeName(entity);
  }

  const inSpaceNow = $derived($flight.status?.docked === false);

  // ⚠ THIS PANEL CLAIMS THE SPACE FEED. It does not own it — every panel that
  // shows live space data claims it, so leaving one hands the feed over rather
  // than switching it off, and it stops on its own when the ship docks or the
  // browser tab is hidden.
  //
  // ⚠ AND CLAIMING IT IS NOT OPTIONAL HERE. This panel replaced the one that
  // used to claim it, and for a few minutes it did not: the radar read NOTHING
  // ON GRID and every gauge read a dash, on a ship that was sitting in a belt.
  // Nothing was broken — nobody had asked for a snapshot.
  onMount(() => {
    void flow.loadSpaceSnapshot().catch(() => {});
    // The locks, so a row can wear its ⌖ and the bar can offer Release lock.
    // Best-effort: a failed read must never blank the list.
    void flow.loadTargets().catch(() => {});
    flow.startSpacePolling();
    return () => flow.stopSpacePolling();
  });
</script>

{#snippet actionButton(action: RowAction)}
  {@const ranged = RANGED_ACTIONS.has(action.id)}
  {@const kind = (action.id === "orbit" ? "orbit" : "keep") as RangeKind}
  <span class="spc-action" class:ranged>
    <button
      type="button"
      class="spc-action-btn"
      class:blocked={action.unavailable !== null}
      disabled={busy.has(action.concern) || action.unavailable !== null}
      title={action.unavailable ?? action.label}
      aria-label={action.unavailable ?? action.label}
      onclick={() => runAction(action)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" class="spc-glyph">
        {#each SPACE_ACTION_GLYPHS[action.id] as d (d)}<path {d} />{/each}
      </svg>
      <!-- The caption may be shortened to fit; the button's own name and title
           above are always the model's full label. -->
      <span class="spc-action-label"
        >{SHORT_ACTION_CAPTION[action.id] ?? action.label}{#if ranged}&nbsp;{rangeName(
            rangeFor(kind),
          )}{/if}</span
      >
    </button>
    {#if ranged}
      <button
        type="button"
        class="spc-action-more"
        aria-label="Choose the {action.label.toLowerCase()} distance"
        aria-expanded={rangeMenu === kind}
        disabled={busy.has(action.concern)}
        onclick={() => {
          rangeMenu = rangeMenu === kind ? null : kind;
          customRangeError = "";
        }}
      >▾</button>
    {/if}
  </span>
{/snippet}

<div class="spc-panel">
  <!-- ================================================================ head -->
  <div class="spc-head">
    <span class="spc-head-title">Overview</span>
    <span class="spc-head-hint">
      {overview.rows.length}
      {overview.rows.length === 1 ? "thing" : "things"} in range
    </span>
    {#if onCollapse}
      <button type="button" class="spc-icon-btn" title="Collapse" aria-label="Collapse" onclick={onCollapse}>
        <span aria-hidden="true">›</span>
      </button>
    {/if}
  </div>

  {#if !inSpaceNow}
    <p class="spc-note">Undock to see what is around your ship.</p>
  {/if}

  <!-- ============================================================= threats -->
  <!-- ⚠ Above the list and outside the scroller on purpose: a warning you have
       to scroll to is a warning you will miss. -->
  {#if threats.length > 0}
    <div class="spc-threats" role="alert">
      <p class="spc-threats-head">
        {#if takingDamage}
          <strong>You are taking damage.</strong>
        {:else}
          <strong>{threats.length} hostile{threats.length === 1 ? "" : "s"} on grid.</strong>
        {/if}
      </p>
      <ul class="spc-threat-list">
        {#each threats.slice(0, 6) as threat (threat.itemID)}
          <li class="spc-threat">
            <button type="button" class="spc-threat-name" onclick={() => pick(threat.itemID)}>
              {rowName(threat)}
            </button>
            <span class="spc-threat-kind">{hostileLabel(threat) ?? "hostile"}</span>
            <span class="spc-threat-range">{formatDistance(threat.distance)}</span>
            <!--
              ⚠ LOCK, ON THE ROW — the other control the cockpit had here and
              this panel had dropped. Locking is what you do FIRST when
              something is shooting you, and routing it through "select the row,
              then find Lock in the action bar" is two presses at the one moment
              a pilot has none to spare. The three states are the target's, not
              a guess: acquiring is not locked, and says so.
            -->
            {#if lockedIDs.has(threat.itemID)}
              <button
                type="button"
                class="spc-threat-lock"
                disabled={busy.has("lock")}
                onclick={() => runFor("lock", () => flow.unlockTarget(threat.itemID))}
              >
                Release lock
              </button>
            {:else if acquiringIDs.has(threat.itemID)}
              <button type="button" class="spc-threat-lock" disabled>Locking…</button>
            {:else}
              <button
                type="button"
                class="spc-threat-lock"
                disabled={busy.has("lock")}
                onclick={() => runFor("lock", () => flow.lockTarget(threat.itemID))}
              >
                Lock
              </button>
            {/if}
            {#if orderableDrones.length > 0}
              <!--
                Only drawn when there is a flight to send. A hull with no drones
                out has nothing to offer here, and a button that could only ever
                refuse is the silent decline wearing a live face.
              -->
              <button
                type="button"
                class="spc-threat-send"
                disabled={busy.has("drone")}
                onclick={() => runFor("drone", () => flow.engageDrones(orderableDrones, threat.itemID))}
              >
                Send drones
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- ============================================================ selected -->
  <div class="spc-selected">
    {#if selectionNotice}
      <p class="spc-note bad">{selectionNotice}</p>
    {/if}
    {#if selectedRow}
      <div class="spc-selected-head">
        <span class="spc-selected-icon">
          <TypeIcon typeID={selectedRow.typeID} name={rowName(selectedRow)} size="sm" />
        </span>
        <span class="spc-selected-name">
          <span class="spc-name" class:hostile={isHostile(selectedRow)}>{rowName(selectedRow)}</span>
          <span class="spc-meta">
            {typeName(selectedRow)} · {groupName(selectedRow)} · {formatDistance(selectedRow.distance)}
          </span>
        </span>
        {#if lockedIDs.has(selectedRow.itemID)}
          <span class="spc-locked-badge">Locked</span>
        {:else if acquiringIDs.has(selectedRow.itemID)}
          <span class="spc-locked-badge acquiring">Locking…</span>
        {/if}
      </div>
      <!-- ⚠ EVERY verb the model returns, including the ones it returns
           DISABLED with the sentence that says why. Dropping one silently
           leaves a player wondering where a button went. -->
      <div class="spc-actions">
        {#each selectedActions as action (action.id)}
          {@render actionButton(action)}
        {/each}
      </div>
      {#each Object.entries(concernErrors) as [concern, words] (concern)}
        {#if words}<p class="spc-note bad">{words}</p>{/if}
      {/each}
      <!--
        ⚠ ONE LINE PER LASER, NEVER ONE SHARED VERDICT. Every activate lands its
        outcome in the same store slot, so a fan-out that reported once would
        show only the last module's answer and quietly lose the other refusals.
        Each module is named, and a module that was accepted-then-not-run is
        called out as distinctly as one refused outright.
      -->
      {#if mineReports.length > 0}
        <ul class="spc-mine-reports">
          {#each mineReports as report (report.label + report.outcome)}
            <li class:bad={!report.ok}>
              <span class="spc-mine-name">{report.label}</span>
              <span class="spc-mine-outcome">{report.outcome}</span>
            </li>
          {/each}
        </ul>
      {/if}
    {:else}
      <p class="spc-note">Nothing selected. Pick a row below, or a marker on the radar.</p>
    {/if}
  </div>

  {#if rangeMenu}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="spc-menu-shade" onclick={() => (rangeMenu = null)}></div>
    <div class="spc-menu">
      <p class="spc-menu-head">{rangeMenu === "orbit" ? "Orbit at" : "Keep at"}</p>
      <div class="spc-menu-chips">
        {#each RANGE_PRESETS as choice (choice.metres)}
          <button
            type="button"
            class="spc-chip"
            class:on={rangeFor(rangeMenu) === choice.metres}
            onclick={() => chooseRange(rangeMenu!, choice.metres)}
          >{choice.label}</button>
        {/each}
      </div>
      <div class="spc-menu-custom">
        <input
          type="number"
          min="0"
          step="0.1"
          placeholder="7"
          aria-label="A distance in kilometres"
          bind:value={customRange}
        />
        <span class="spc-menu-unit">km</span>
        <button type="button" class="spc-btn" onclick={() => useCustomRange(rangeMenu!)}>Use</button>
      </div>
      {#if customRangeError}<p class="spc-note bad">{customRangeError}</p>{/if}
      {#if !isPresetRange(rangeFor(rangeMenu))}
        <p class="spc-note">Now flying at {rangeName(rangeFor(rangeMenu))}.</p>
      {/if}
    </div>
  {/if}

  <!-- ============================================================= filters -->
  <div class="spc-filters">
    <div class="spc-tabs" role="tablist" aria-label="What to show">
      {#each OVERVIEW_PRESETS as preset (preset.id)}
        <button
          type="button"
          role="tab"
          class="spc-tab"
          class:on={activePresetID === preset.id}
          aria-selected={activePresetID === preset.id}
          onclick={() => overviewPreset.choose(preset.id)}
        >{preset.label}</button>
      {/each}
    </div>
    <label class="spc-search">
      <span class="spc-search-glyph" aria-hidden="true">⌕</span>
      <input type="search" placeholder="name, type or group" aria-label="Search what is around you" bind:value={search} />
    </label>
  </div>

  <!-- ============================================================= content -->
  <div class="spc-content" onscroll={() => (rangeMenu = null)}>
    <div class="spc-colhead">
      <span class="spc-cell-icon"></span>
      <button type="button" class="spc-sort spc-cell-name" class:on={sortKey === "name"} onclick={() => sortBy("name")}>
        Name {sortArrow("name")}
      </button>
      <span class="spc-cell-type">Type</span>
      <span class="spc-cell-group">Group</span>
      <button
        type="button"
        class="spc-sort spc-cell-range"
        class:on={sortKey === "distance"}
        onclick={() => sortBy("distance")}
      >
        Distance {sortArrow("distance")}
      </button>
    </div>

    <ul class="spc-rows">
      {#if rows.length === 0}
        <li class="spc-empty">
          {snapshot ? "Nothing here matches." : "Finding out what is around you…"}
        </li>
      {:else}
        {#each rows as row (row.itemID)}
          <li
            class="spc-row"
            class:picked={row.itemID === selectedID}
            class:hostile={isHostile(row)}
          >
            <button type="button" class="spc-row-btn" aria-pressed={row.itemID === selectedID} onclick={() => pick(row.itemID)}>
              <span class="spc-cell-icon">
                <TypeIcon typeID={row.typeID} name={rowName(row)} size="sm" />
              </span>
              <span class="spc-cell-name">
                <span class="spc-name" class:hostile={isHostile(row)}>
                  {rowName(row)}{#if lockedIDs.has(row.itemID)}<span class="spc-lock-mark" title="Locked">⌖</span>{/if}
                </span>
                {#if isHostile(row)}
                  <!--
                    ⚠ FOUND BY THE COCKPIT'S OWN SUITE WHEN IT WAS RE-POINTED
                    HERE. The old list marked a rat in the ROWS as well as in the
                    threat strip, and this panel had dropped that: the strip is
                    capped at six and the list is what a miner is actually
                    reading, so a hostile outside the top six became invisible in
                    the place the player was looking.

                    A WORD, not a colour. Someone who cannot tell the red still
                    reads "Pirate".
                  -->
                  <span class="spc-row-badge">{hostileLabel(row) ?? "hostile"}</span>
                {/if}
                <span class="spc-meta">{typeName(row)} · {groupName(row)}</span>
              </span>
              <span class="spc-cell-type">{typeName(row)}</span>
              <span class="spc-cell-group">{groupName(row)}</span>
              <span class="spc-cell-range" class:far={row.distance >= 100_000}>
                {formatDistance(row.distance)}
              </span>
            </button>
          </li>
        {/each}
      {/if}
    </ul>

    {#if truncated}
      <!-- ⚠ Never hidden. The list keeps the NEAREST rows, so a reversed sort
           shows the far end of the list rather than of the grid. -->
      <p class="spc-note">
        Showing the nearest {overview.rows.length} of {overview.matched}.
      </p>
    {/if}
    {#if $space.error}
      <p class="spc-note bad">{$space.error}</p>
    {/if}
  </div>
</div>
