<script lang="ts">
  // The simplified MOBILE workspace — a floating-window desktop is wrong for a
  // small touch screen, so on narrow viewports the UI collapses to one panel at a
  // time with a scrollable bottom tab bar (classic mobile navigation). "Home" is
  // your situational awareness: the Station panel when docked, or the ship gauges
  // + module rack over the Overview in space. Same panels as the desktop (via
  // PanelHost) — just one at a time, no windows, no drag.
  import WorkspaceHeader from "./WorkspaceHeader.svelte";
  import PanelHost from "./PanelHost.svelte";
  import SpaceOverview from "./SpaceOverview.svelte";
  import StationPanel from "./StationPanel.svelte";
  import ShipHud from "./ShipHud.svelte";
  import ModuleRack from "./ModuleRack.svelte";
  import MobileCard from "./MobileCard.svelte";
  import DronesPanel from "./DronesPanel.svelte";
  import ShotsPanel from "./ShotsPanel.svelte";
  import Flight from "./Flight.svelte";
  import Mining from "./Mining.svelte";
  import {
    MOBILE_CARDS,
    isCollapsed,
    readCollapsed,
    tabsShownInStack,
    toggleCollapsed,
    writeCollapsed,
  } from "./mobileCards.ts";
  import TargetBracket from "./TargetBracket.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { isLaunchable, visibleTabsFor, type TabID } from "./tabs.ts";
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

  /**
   * Which cards of the in-space stack are folded away.
   *
   * ⚠ READ ONCE, ON MOUNT, NOT IN A `$derived`. `localStorage` is not reactive
   * and throws outright in some private-window configurations, so it is touched
   * exactly where a failure can be caught and turned into "nothing folded" —
   * which is the safe direction: a card a pilot cannot see they are missing is
   * the failure this whole screen is built to avoid.
   */
  let collapsed = $state(readCollapsed(typeof localStorage === "undefined" ? null : localStorage));
  function toggleCard(id: string): void {
    collapsed = toggleCollapsed(collapsed, id);
    writeCollapsed(typeof localStorage === "undefined" ? null : localStorage, collapsed);
  }

  // The openable panels for the current state (chrome tabs excluded); "home" is
  // the null selection. While docked, "Inventory & Ship" is dropped from the
  // bar — the docked home IS that content, so the tab would be a duplicate.
  //
  // ⚠ AND IN SPACE, EVERYTHING THE STACK ALREADY SHOWS IS DROPPED TOO. Those
  // six panels are the home screen; offering each of them again in the bar
  // costs a tap target and teaches nothing — the same call the HUD's nav
  // buttons lost on the desktop.
  const tabs = $derived(
    visibleTabsFor(isDocked).filter(
      (tab) =>
        isWindowTab(tab.id) &&
        // ⚠ AND NOT A CONTEXTUAL PANEL. `Show Info` only ever opens because
        // something was clicked, so a bar entry for it could only open onto
        // nothing. The desktop rail has always filtered these out; this bar
        // never did, and offered it on every phone.
        isLaunchable(tab) &&
        !(isDocked && tab.id === "inventory") &&
        !(!isDocked && tabsShownInStack().has(tab.id)),
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

  <!-- The docked home is the Station panel, which sizes itself and pins its own
       action bar — so for that ONE case the host stops padding and scrolling and
       hands it the whole box. Every other panel, in space included, keeps the
       scrolling padded column it has always had. -->
  <main class="mobile-main" class:mobile-main-station={effective === null && isDocked}>
    {#if effective !== null}
      <PanelHost {store} {flow} tab={effective} onOpen={(id) => (selected = id)} {sessions} />
    {:else if isDocked}
      <!-- Docked home = the same Station panel as the desktop's right-hand dock,
           at its narrowest tier. There is no strip to fold into on a phone, so
           it is given no collapse control. -->
      <ErrorBoundary name="Station">
        <StationPanel {store} {flow} />
      </ErrorBoundary>
    {:else}
      <!--
        ============================================ the in-space stack (1D) ==

        ⚠ ONE COLUMN OF COLLAPSIBLE CARDS, AND NO RADAR. The radar is a picture
        that needs room to mean anything and there is none on a phone; once it
        goes, the desktop's three-cell grid is three things fighting over 380px.
        So the order is fixed, the page scrolls, and the pilot decides what they
        are doing by folding away what they are not: a miner folds Shots, someone
        in a fight folds Mining.

        Every card is the SAME COMPONENT the desktop uses. There is no mobile
        variant of any of these panels — a second implementation is a second
        thing to keep honest, and the honesty is the whole product.
      -->
      <TargetBracket {store} />
      {#each MOBILE_CARDS as card (card.id)}
        <MobileCard
          title={card.title}
          collapsed={isCollapsed(collapsed, card.id)}
          scrolls={card.scrolls}
          onToggle={() => toggleCard(card.id)}
        >
          <ErrorBoundary name={card.title}>
            {#if card.id === "ship"}
              <div class="mobile-hud">
                <ShipHud {store} />
                <ModuleRack {store} {flow} />
              </div>
            {:else if card.id === "overview"}
              <SpaceOverview {store} {flow} />
            {:else if card.id === "drones"}
              <DronesPanel {store} {flow} />
            {:else if card.id === "shots"}
              <ShotsPanel {store} {flow} />
            {:else if card.id === "flight"}
              <Flight {store} {flow} />
            {:else if card.id === "mining"}
              <Mining {store} {flow} />
            {/if}
          </ErrorBoundary>
        </MobileCard>
      {/each}
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
