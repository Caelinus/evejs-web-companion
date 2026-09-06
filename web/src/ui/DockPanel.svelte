<script lang="ts">
  // The fixed top-right dock panel — your always-on situational awareness.
  //
  //   DOCKED   the Station panel: the open hull's bays, the ship hangar, the
  //            item hangar, the corporation's divisions, any open container and
  //            the station's own services and guests.
  //   IN SPACE the compact Overview — what is around your ship.
  //
  // Ship condition, the module rack and the locked-target brackets are
  // deliberately NOT here: they live in the persistent bottom HUD and the
  // floating TargetsPanel. Collapsible to a thin strip, and expandable by
  // dragging its left edge; both the collapse state and the width are
  // remembered per character.
  //
  // ⚠ BOTH ARMS NOW BRING THEIR OWN CHROME. Each panel carries its own header
  // and its own pinned strips, so each takes the whole frame: no
  // `.dock-panel-head` above it and no `.dock-panel-body` padding or scrolling
  // around it. `.dock-host` is the shared mount — it gives a panel the whole box
  // and nothing else, which is the only thing either of them wants from the
  // frame. What the frame still owns is the border, the width, the collapse
  // strip and the resize handle.
  import SpaceOverview from "./SpaceOverview.svelte";
  import StationPanel from "./StationPanel.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let {
    store,
    flow,
    isDocked,
    collapsed,
    width,
    onToggle,
    onResize,
    inventoryPing = 0,
    expanded = false,
    onToggleExpand = null,
  }: {
    store: ClientStore;
    flow: AppFlow;
    isDocked: boolean;
    collapsed: boolean;
    width: number;
    onToggle: () => void;
    onResize: (w: number) => void;
    /**
     * The docked panel has been asked to take the whole work area. ⚠ Comes from
     * Workspace ALREADY ANDed with `isDocked`, so it is false in space however
     * the player left the preference — the Overview must never hide the desktop.
     */
    expanded?: boolean;
    /** Null when the shell offers no expansion (the mobile home has none). */
    onToggleExpand?: (() => void) | null;
    /**
     * Bumped when the Neocom's "Inventory & Ship" is picked while docked:
     * the panel snaps to the Ship Inventory tab so the pick has a visible
     * response even when the dock was already expanded.
     */
    inventoryPing?: number;
  } = $props();

  // The docked title is a static word: the workspace header directly above
  // already spells out the full station name + system, so repeating it here
  // (where it wrapped over two lines) was pure duplication. In space the
  // panel is the Overview and keeps its descriptive name.
  const title = $derived(isDocked ? "Station" : "Around Your Ship");
  const MIN_W = 240;
  const MAX_W = 900;

  // Drag the left edge to widen/narrow. Dragging LEFT (negative dx) widens it.
  function startResize(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = width;
    const target = ev.currentTarget as HTMLElement;
    target.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent): void => {
      const next = startW - (e.clientX - startX);
      onResize(Math.max(MIN_W, Math.min(MAX_W, Math.round(next))));
    };
    const up = (): void => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }
</script>

<!-- Expanded, the panel takes the column, so it must NOT carry a pixel width:
     an inline style outranks any rule that would stretch it. -->
<aside
  class="dock-panel"
  class:collapsed
  class:expanded={expanded && !collapsed}
  style={collapsed || expanded ? "" : `width:${width}px`}
  aria-label={title}
>
  {#if collapsed}
    <button type="button" class="dock-expand" title={`Show ${title}`} aria-label={`Show ${title}`} onclick={onToggle}>
      <span class="dock-expand-label">{title}</span>
    </button>
  {:else}
    {#if !expanded}
      <!-- Nothing to drag while the panel owns the whole column; the width it
           was dragged to is remembered and comes back when it is docked again. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="dock-resize" title="Drag to resize" onpointerdown={startResize}></span>
    {/if}
    {#if isDocked}
      <div class="dock-host">
        <ErrorBoundary name="Station">
          <StationPanel
            {store}
            {flow}
            {expanded}
            {onToggleExpand}
            ping={inventoryPing}
            onCollapse={onToggle}
          />
        </ErrorBoundary>
      </div>
    {:else}
      <div class="dock-host">
        <ErrorBoundary name="Overview">
          <SpaceOverview {store} {flow} onCollapse={onToggle} />
        </ErrorBoundary>
      </div>
    {/if}
  {/if}
</aside>
