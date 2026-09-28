<script lang="ts">
  // R107 — ONE pilot's workspace, a pure reader of that pilot's store. Extracted
  // from App.svelte so the multibox App can mount exactly one of these (the
  // ACTIVE pilot) above the character bar while every other pilot's store+flow
  // stay live in memory. The workspace is an always-open desktop:
  //   • the Neocom launcher rail down the left (opens panels as windows),
  //   • a context header (where you are + Dock/Undock),
  //   • the desktop itself — floating, self-contained panel windows,
  //   • a fixed, collapsible top-right dock panel (Overview in space / Station
  //     services when docked), and
  //   • a persistent bottom HUD bar while in space.
  // The open windows + dock-collapse state are remembered per character. Below
  // 720px it swaps to the single-panel MobileWorkspace. All fetch/decode lives
  // in app/flow.ts; the store slices are store-contract signals.
  import Neocom from "./Neocom.svelte";
  import Desktop from "./Desktop.svelte";
  import DockPanel from "./DockPanel.svelte";
  import HudBar from "./HudBar.svelte";
  import WorkspaceHeader from "./WorkspaceHeader.svelte";
  import MobileWorkspace from "./MobileWorkspace.svelte";
  import DockWipe from "./DockWipe.svelte";
  import Toasts from "./Toasts.svelte";
  import NoticeBridge from "./NoticeBridge.svelte";
  import { showInfoTarget } from "./showInfo.ts";
  import TargetsPanel from "./TargetsPanel.svelte";
  import CustomBotReadout from "./CustomBotReadout.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { deriveDocked, type TabID } from "./tabs.ts";
  import { isGlobalTab } from "./globalWindow.ts";
  import {
    openWindow,
    focusWindow,
    closeWindow,
    moveWindow,
    resizeWindow,
    toggleMinimize,
    focusedId as computeFocusedId,
    loadLayout,
    saveLayout,
    DEFAULT_DOCK_WIDTH,
    DEFAULT_TARGETS_POS,
    type WinState,
  } from "./desktop.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { Session } from "../app/sessions.ts";

  let {
    store,
    flow,
    sessions,
    globalOpenIds,
    onOpenGlobal,
    openRequest,
    onOpenRequestServed,
    sessionID,
  }: {
    store: ClientStore;
    flow: AppFlow;
    /**
     * EVERY held pilot, not just this workspace's own. A Workspace is otherwise
     * a pure reader of ONE pilot's store (see the R107 note above), and this is
     * the deliberate exception: the Bot Manager has to show what all of them are
     * flying. It is passed straight through to PanelHost, which hands it to that
     * one panel and no other.
     */
    sessions?: readonly Session[];
    /**
     * The global-layer tabs currently on screen, so the rail can light their
     * entries like any other open window. App owns that layer (globalWindow.ts);
     * a workspace only reads it.
     */
    globalOpenIds?: ReadonlySet<TabID>;
    /** Hand a global tab up to App, which owns the layer it opens on. */
    onOpenGlobal?: (id: TabID) => void;
    /**
     * A panel App wants opened HERE, as a counter that App bumps.
     *
     * ⚠ A COUNTER, NOT AN ID, for the reason the Show Info effect below spells
     * out: the global Bot Manager's Edit button asks for the Bot Builder, and
     * asking a second time for the panel already open must still raise it. This
     * is the one path INTO a workspace from above it, and it is deliberately a
     * prop rather than a registered callback — data flows down, the same shape
     * `dockInventoryPing` already uses.
     */
    openRequest?: { readonly id: TabID; readonly n: number; readonly sessionID: string } | null;
    /** Tell App this workspace has served the request, so it can drop it. */
    onOpenRequestServed?: () => void;
    /** This workspace's own session id, so it can tell whose request is whose. */
    sessionID?: string;
  } = $props();

  // The store's identity is stable for this component's lifetime (App keys each
  // Workspace by session id, so store/flow never change under a mounted one);
  // capturing the slice signals once is intended.
  // svelte-ignore state_referenced_locally
  const session = store.session;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;

  // Docked vs in space, from the authoritative flag (rule lives in tabs.ts).
  const isDocked = $derived(deriveDocked($flight.status, $station.online));

  // Narrow viewport -> the simplified single-panel mobile UI instead of the
  // floating-window desktop. matchMedia so it flips live at the breakpoint.
  let isMobile = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const update = (): void => { isMobile = mq.matches; };
    update();
    mq.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  });

  // ── the desktop: open windows + the collapsible dock panel ──────────────
  let wins = $state<WinState[]>([]);
  let dockCollapsed = $state(false);
  let dockWidth = $state(DEFAULT_DOCK_WIDTH);
  /**
   * ⚠ THE PREFERENCE, NOT THE FLAG. The player can ask the docked Station panel
   * to take the whole work area, which HIDES the desktop. That must be
   * impossible in space — a pilot who undocked into a hidden desktop, no HUD
   * and no locked-target panel would have no way back to any of them.
   *
   * So the real flag is DERIVED (`stationExpanded`, below) rather than reset by
   * an effect: undocking cannot leave it stale, because there is no stored
   * state to be stale. The preference itself is remembered, so docking again
   * brings the expanded panel back.
   */
  let expandPreferred = $state(false);
  let targetsX = $state(DEFAULT_TARGETS_POS.x);
  let targetsY = $state(DEFAULT_TARGETS_POS.y);
  const stationExpanded = $derived(isDocked && expandPreferred);
  const openIds = $derived(new Set(wins.map((w) => w.id)));
  const focused = $derived(computeFocusedId(wins));

  // Opening a window GIVES THE WORK AREA BACK. While the Station panel has the
  // whole column the desktop is hidden, so a window opened into it would appear
  // nowhere at all and the rail would look broken. Asking for a panel is asking
  // for the canvas it lives on.
  //
  // ⚠ Deliberately not in `openFromNeocom`: while docked, picking "Inventory &
  // Ship" there folds into the dock panel instead of opening a window, and that
  // pick must not throw the expansion away.
  const open = (id: TabID): void => {
    // ⚠ A GLOBAL TAB NEVER LANDS ON THIS DESKTOP. It opens on App's layer above
    // every workspace, because it outlives the pilot switch that tears this one
    // down (globalWindow.ts). It also must not clear the station expansion:
    // nothing was added to the hidden desktop, so there is nothing to give the
    // work area back for.
    if (isGlobalTab(id)) {
      onOpenGlobal?.(id);
      return;
    }
    expandPreferred = false;
    wins = openWindow(wins, id);
  };
  // The Neocom pick, with one de-dupe: while docked, Inventory & Ship IS the
  // permanent dock panel — expand it, snap it to the Ship Inventory tab (the
  // visible response when it was already expanded, e.g. sitting on Station
  // Services), and fold any open inventory window in, instead of putting a
  // second identical copy on screen. In space, and for every other tab, it
  // opens/focuses a window as always.
  let dockInventoryPing = $state(0);
  const openFromNeocom = (id: TabID): void => {
    if (id === "inventory" && isDocked) {
      dockCollapsed = false;
      dockInventoryPing += 1;
      wins = closeWindow(wins, "inventory");
      return;
    }
    open(id);
  };
  // The rail highlights what is on screen. While docked, the expanded dock
  // panel IS the Inventory & Ship content, so its entry lights up like an
  // open window's would (openIds itself only tracks floating windows).
  // The global layer's windows are on screen too, so they light up in the rail
  // exactly like a workspace window — from here the distinction is invisible,
  // which is the point.
  const neocomOpenIds = $derived(
    new Set<TabID>([
      ...openIds,
      ...(globalOpenIds ?? []),
      ...(isDocked && !dockCollapsed ? (["inventory"] as TabID[]) : []),
    ]),
  );
  const focus = (id: TabID): void => { wins = focusWindow(wins, id); };
  const close = (id: TabID): void => { wins = closeWindow(wins, id); };
  const move = (id: TabID, x: number, y: number): void => { wins = moveWindow(wins, id, x, y); };
  const resize = (id: TabID, w: number, h: number): void => { wins = resizeWindow(wins, id, w, h); };
  const minimize = (id: TabID): void => { wins = toggleMinimize(wins, id); };
  const toggleDock = (): void => { dockCollapsed = !dockCollapsed; };

  // Restore the saved layout when a character comes online (keyed by characterID)
  // and clear it on logout, so a different pilot gets their own desktop. Guarded
  // on the loaded id so it runs once per character.
  let loadedFor = $state<number | null>(null);
  $effect(() => {
    const online = $station.online;
    if (online && loadedFor !== online.characterID) {
      const saved = loadLayout(online.characterID);
      wins = saved ? saved.wins.slice() : [];
      dockCollapsed = saved ? saved.dockCollapsed : false;
      dockWidth = saved ? saved.dockWidth : DEFAULT_DOCK_WIDTH;
      targetsX = saved ? saved.targetsX : DEFAULT_TARGETS_POS.x;
      targetsY = saved ? saved.targetsY : DEFAULT_TARGETS_POS.y;
      expandPreferred = saved ? saved.stationExpanded : false;
      loadedFor = online.characterID;
    } else if (!online && loadedFor !== null) {
      wins = [];
      dockCollapsed = false;
      dockWidth = DEFAULT_DOCK_WIDTH;
      targetsX = DEFAULT_TARGETS_POS.x;
      targetsY = DEFAULT_TARGETS_POS.y;
      expandPreferred = false;
      loadedFor = null;
    }
  });

  // Persist on any layout change, debounced so a drag doesn't hammer storage.
  $effect(() => {
    const id = loadedFor;
    const layout = {
      wins: wins.map((w) => ({ ...w })),
      dockCollapsed,
      dockWidth,
      targetsX,
      targetsY,
      stationExpanded: expandPreferred,
    };
    if (id === null) return;
    const handle = setTimeout(() => saveLayout(id, layout), 300);
    return () => clearTimeout(handle);
  });

  // R76 — Show Info raises its window from ANYWHERE.
  //
  // The openers (an overview row, a tactical bracket, a fitting socket) live in
  // different subtrees, some of them inside floating windows, so threading an
  // `onShowInfo` callback to each would touch a dozen components to add one
  // button. Instead they push a subject into the shared target and this raises
  // the window — one place that knows about windows at all.
  //
  // ⚠ IT WATCHES THE REQUEST COUNTER, NOT THE SUBJECT. Asking for info on the
  // thing already displayed must still bring the window back to the front, and
  // it may well have been closed or buried since. Watching the subject alone
  // would make the second Show Info on the same object do nothing at all.
  let servedInfoRequests = 0;
  const infoRequests = showInfoTarget.requests;
  $effect(() => {
    const count = $infoRequests;
    if (count === servedInfoRequests) return;
    servedInfoRequests = count;
    // Skip the initial reading: a restored session must not pop an info window
    // nobody asked for.
    if (count > 0) open("showInfo");
  });

  // A panel App asked to be opened on THIS desktop — today, the Bot Builder,
  // requested by the Edit button in the global Bot Manager. Watches the counter
  // and not the id, for the same reason the Show Info effect above does: asking
  // twice for the same panel must still raise it, and it may have been closed or
  // buried in between.
  let mobileOpenRequest = $state<{ id: TabID; n: number } | null>(null);
  // A panel App wants opened on THIS workspace — the Bot Manager asking for the
  // Bot Builder, or for the built-in bots panel on a particular pilot.
  //
  // ⚠ IT IS ADDRESSED, NOT MERELY TIMED, and two bugs are the reason why.
  //
  // The request lives in App, above the `{#key active.id}` that remounts a
  // workspace per pilot, so a bare counter is ambiguous in both directions:
  //
  //  • Serving any request whose number we had not seen replayed OLD ones. A
  //    workspace mounted later started at zero, read a counter bumped for some
  //    earlier pilot, and opened that panel too — so opening the Bot Builder and
  //    then switching pilots opened it again on the pilot switched TO, and on
  //    every pilot after that.
  //
  //  • Seeding the mark from the counter AS IT STANDS AT MOUNT fixed that and
  //    broke the opposite case. "Set up this built-in on that pilot" switches
  //    pilots and asks for the panel in ONE tick, so by the time the new
  //    workspace mounts the counter already includes the request meant for it —
  //    which it then read as ancient history and ignored. The pilot switched and
  //    no panel opened.
  //
  // Neither is a timing problem, so neither has a timing fix. The request names
  // the pilot it is for; a workspace serves only its own and says so, and App
  // drops it once served, which is what stops a later remount finding it again.
  let servedOpenRequest = 0;
  $effect(() => {
    const request = openRequest;
    if (!request || request.sessionID !== sessionID) return;
    if (request.n === servedOpenRequest) return;
    servedOpenRequest = request.n;
    // ⚠ THE MOBILE WORKSPACE HAS NO WINDOWS TO OPEN INTO. `open()` puts a window
    // on the desktop, which on a phone nothing renders — the request would be
    // silently swallowed. There the panel is a SELECTION, so the request is
    // handed down for MobileWorkspace to apply to its own.
    if (isMobile) {
      mobileOpenRequest = { id: request.id, n: request.n };
    } else {
      open(request.id);
    }
    onOpenRequestServed?.();
  });
  // Read flight status once online so the docked/in-space flag is authoritative
  // (character select does not read it). Subsequent flight steps keep it fresh.
  $effect(() => {
    if ($session.phase === "logged-in" && $station.online !== null && $flight.status === null) {
      void flow.loadFlightStatus().catch(() => {});
    }
  });
</script>

<!-- Guard: App prunes a pilot the instant its store goes offline, but this
     component can outlive that store update by a tick; render nothing rather
     than let a child dereference a null $station.online. -->
{#if $station.online === null}
  <div class="workspace-shell-empty"></div>
{:else if isMobile}
  <!-- The same transition in both workspaces: the state change is identical, so
       it would be strange for only one of them to acknowledge it. -->
  <DockWipe {isDocked} />
  <NoticeBridge {store} />
  <Toasts />
  <MobileWorkspace {store} {flow} {isDocked} {sessions} openRequest={mobileOpenRequest} />
{:else}
  <DockWipe {isDocked} />
  <!-- Mounted once for the whole workspace, and once each: the bridge is what
       RAISES a notice (it watches every store slice that records a refusal) and
       the flash is where one APPEARS. Both have to outlive the panel the event
       came from — that is the entire point — so neither can live in a panel. -->
  <NoticeBridge {store} />
  <Toasts />
  <div class="workspace" class:in-space={!isDocked}>
    <!-- Every piece of always-on chrome gets its own boundary. These are mounted
         for the whole session and refresh on every poll, so before this an error
         in any one of them froze the entire tab (see ErrorBoundary.svelte). -->
    <ErrorBoundary name="Launcher rail">
      <Neocom {store} {flow} {isDocked} openIds={neocomOpenIds} focusedId={focused} onSelect={openFromNeocom} />
    </ErrorBoundary>
    <div class="work">
      <ErrorBoundary name="Workspace header">
        <WorkspaceHeader {store} {flow} {isDocked} />
      </ErrorBoundary>
      <!-- A running bot's readout, always visible while it runs, nothing when idle. -->
      <ErrorBoundary name="Bot readout">
        <CustomBotReadout {store} {flow} />
      </ErrorBoundary>
      <!-- `station-expanded` hides the desktop, so it is bound to the DERIVED
           flag and never to the preference: in space the class cannot be set
           however the preference was left. -->
      <div class="work-main" class:station-expanded={stationExpanded}>
        <ErrorBoundary name="Desktop">
          <Desktop
            {store}
            {flow}
            {sessions}
            {wins}
            {focused}
            {isDocked}
            onFocus={focus}
            onClose={close}
            onToggleMinimize={minimize}
            onMove={move}
            onResize={resize}
            onOpen={open}
          />
        </ErrorBoundary>
        <DockPanel
          {store}
          {flow}
          {isDocked}
          inventoryPing={dockInventoryPing}
          collapsed={dockCollapsed}
          width={dockWidth}
          expanded={stationExpanded}
          onToggle={toggleDock}
          onToggleExpand={() => (expandPreferred = !expandPreferred)}
          onResize={(w) => (dockWidth = w)}
        />
        {#if !isDocked}
          <!-- The ship HUD is a CELL of the work area now, not a strip under it:
               the radar takes the top-left, the HUD the bottom-left, and the
               dock column spans both. Docked there is neither a radar nor a
               HUD, so the same grid collapses to one row and the desktop keeps
               the whole left side. -->
          <ErrorBoundary name="HUD bar">
            <!-- No `onOpen`: the HUD's nav buttons went, because every one
                 of them is a Neocom rail entry that is on screen anyway. -->
            <HudBar {store} {flow} />
          </ErrorBoundary>
          <ErrorBoundary name="Locked targets">
            <TargetsPanel {store} x={targetsX} y={targetsY} onMove={(nx, ny) => { targetsX = nx; targetsY = ny; }} />
          </ErrorBoundary>
        {/if}
      </div>
    </div>
  </div>
{/if}
