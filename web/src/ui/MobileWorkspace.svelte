<script lang="ts">
  // The simplified MOBILE workspace — a floating-window desktop is wrong for a
  // small touch screen, so on narrow viewports the UI collapses to one panel at a
  // time with a scrollable bottom tab bar (classic mobile navigation). "Home" is
  // your situational awareness: the Station panel when docked, or the ship gauges
  // + module rack over the Overview in space. Same panels as the desktop (via
  // PanelHost) — just one at a time, no windows, no drag.
  import WorkspaceHeader from "./WorkspaceHeader.svelte";
  import PanelHost from "./PanelHost.svelte";
  import Overview from "./Overview.svelte";
  import InventoryShip from "./InventoryShip.svelte";
  import ShipHud from "./ShipHud.svelte";
  import ModuleRack from "./ModuleRack.svelte";
  import TargetBracket from "./TargetBracket.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { visibleTabsFor, type TabID } from "./tabs.ts";
  import { isWindowTab } from "./desktop.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { Session } from "../app/sessions.ts";

  let {
    store,
    flow,
    isDocked,
    sessions,
  }: {
    store: ClientStore;
    flow: AppFlow;
    isDocked: boolean;
    // R107 — the full pilot roster, threaded down only so the Bot Manager panel
    // can show every held pilot, not just this session's active one. Optional:
    // every other caller/panel is unaffected. See PanelHost.svelte.
    sessions?: readonly Session[];
  } = $props();

  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // The module rack needs the ship's fit (Fitting is docked-only) — pull once.
  $effect(() => {
    if (!$fitting.loaded) void flow.loadFitting().catch(() => {});
  });

  // The openable panels for the current state (chrome tabs excluded); "home" is
  // the null selection. While docked, "Inventory & Ship" is dropped from the
  // bar — the docked home IS that content, so the tab would be a duplicate.
  const tabs = $derived(
    visibleTabsFor(isDocked).filter(
      (tab) => isWindowTab(tab.id) && !(isDocked && tab.id === "inventory"),
    ),
  );
  let selected = $state<TabID | null>(null);
  // Drop a selection the current state no longer offers (docked-only after undock).
  const effective = $derived(selected !== null && tabs.some((t) => t.id === selected) ? selected : null);
</script>

<div class="mobile-ws">
  <ErrorBoundary name="Workspace header">
    <WorkspaceHeader {store} {flow} {isDocked} />
  </ErrorBoundary>

  <main class="mobile-main">
    {#if effective !== null}
      <PanelHost {store} {flow} tab={effective} onOpen={(id) => (selected = id)} {sessions} />
    {:else if isDocked}
      <!-- Docked home = the same tabbed dock content as the desktop's right
           panel (hangars + Station Services); the header above already names
           the station, so the dock variant's compact layout fits here too. -->
      <ErrorBoundary name="Inventory &amp; Ship">
        <InventoryShip {store} {flow} dock />
      </ErrorBoundary>
    {:else}
      <ErrorBoundary name="Ship HUD">
        <section class="mobile-hud">
          <ShipHud {store} />
          <ModuleRack {store} {flow} />
        </section>
        <TargetBracket {store} />
      </ErrorBoundary>
      <ErrorBoundary name="Overview">
        <Overview {store} {flow} />
      </ErrorBoundary>
    {/if}
  </main>

  <nav class="mobile-nav" aria-label="Panels">
    <button
      type="button"
      class="mobile-nav-item mobile-nav-home"
      class:active={effective === null}
      onclick={() => (selected = null)}
    >{isDocked ? "Station" : "Ship"}</button>
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        class="mobile-nav-item"
        class:active={effective === tab.id}
        onclick={() => (selected = tab.id)}
      >{tab.label}</button>
    {/each}
  </nav>
</div>
