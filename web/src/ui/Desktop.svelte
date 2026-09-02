<script lang="ts">
  // The always-open desktop: a positioned surface the floating panel windows live
  // on. It renders one DesktopWindow per open window (a pure reader of the window
  // list App owns), wrapping the real panel via PanelHost. Windows whose tab is
  // not openable in the current state (a docked-only panel after undocking) are
  // hidden here but KEPT in the model, so they reappear on the return trip.
  //
  // R70 — IN SPACE, THE DESKTOP HAS A VIEW OUT OF IT. The tactical viewport fills
  // this surface as its backdrop and the windows float over it, which is the
  // retail client's spatial arrangement and the reason the desktop stops reading
  // as a blank grid with dialogs on it. It is a BACKDROP, not a window: it takes
  // no space in the layout, cannot be closed or focused, and paints below
  // everything because it is first in the DOM and every `.win` is positioned.
  //
  // Docked, it is not drawn at all — there is nothing outside to see, and a
  // starfield behind a market window would be a lie about where you are.
  import DesktopWindow from "./DesktopWindow.svelte";
  import PanelHost from "./PanelHost.svelte";
  import Tactical from "./Tactical.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { tabLabel, isTabVisible, type TabID } from "./tabs.ts";
  import { isWindowTab, MIN_W, MIN_H, type WinState } from "./desktop.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { Session } from "../app/sessions.ts";

  let {
    store,
    flow,
    wins,
    focused,
    isDocked,
    onFocus,
    onClose,
    onToggleCollapse,
    onMove,
    onResize,
    onOpen,
    sessions,
  }: {
    store: ClientStore;
    flow: AppFlow;
    wins: WinState[];
    focused: TabID | null;
    isDocked: boolean;
    onFocus: (id: TabID) => void;
    onClose: (id: TabID) => void;
    onToggleCollapse: (id: TabID) => void;
    onMove: (id: TabID, x: number, y: number) => void;
    onResize: (id: TabID, w: number, h: number) => void;
    onOpen: (id: TabID) => void;
    // R107 — the full pilot roster, threaded down only so the Bot Manager panel
    // can show every held pilot, not just this session's active one. Optional:
    // every other caller/panel is unaffected. See PanelHost.svelte.
    sessions?: readonly Session[];
  } = $props();

  // Only real window tabs valid in the current state get rendered.
  const shown = $derived(wins.filter((w) => isWindowTab(w.id) && isTabVisible(w.id, isDocked)));

  let deskEl = $state<HTMLElement | null>(null);

  // A window is absolutely positioned and the desktop clips anything past its
  // own box (the same clip R70's tactical view relies on) — so a window placed
  // or sized for a roomier screen (the default cascade plus whatever it was
  // last dragged to) can end up with its title bar and its own resize handles
  // past the visible edge on a narrower one, with nothing reachable on screen
  // to pull it back: the handles that would do it are exactly what's cut off.
  // Whenever the desktop's own box changes size — including first mount — pull
  // every window fully back inside it.
  $effect(() => {
    if (!deskEl) return;
    const el = deskEl;
    const reconcile = (): void => {
      const areaW = el.clientWidth;
      const areaH = el.clientHeight;
      if (areaW <= 0 || areaH <= 0) return;
      for (const win of wins) {
        const w = Math.min(win.w, Math.max(MIN_W, areaW));
        const h = win.collapsed ? win.h : Math.min(win.h, Math.max(MIN_H, areaH));
        if (w !== win.w || h !== win.h) onResize(win.id, w, h);
        const x = Math.min(Math.max(0, win.x), Math.max(0, areaW - w));
        const y = Math.min(Math.max(0, win.y), Math.max(0, areaH - h));
        if (x !== win.x || y !== win.y) onMove(win.id, x, y);
      }
    };
    reconcile();
    const ro = new ResizeObserver(reconcile);
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div class="desktop" class:has-view={!isDocked} bind:this={deskEl}>
  {#if !isDocked}
    <!-- Its own boundary: a drawing failure must cost the picture, never the
         windows floating on top of it. -->
    <ErrorBoundary name="Tactical view">
      <Tactical {store} {flow} />
    </ErrorBoundary>
  {/if}
  {#if shown.length === 0 && isDocked}
    <!-- Only worth saying when the surface really is empty. In space it is a
         view of the grid, and covering that with a tip about windows would hide
         the most useful thing on screen to explain the least useful. -->
    <p class="desktop-empty">
      Open a panel from the left — it opens here as a window. They stay side by side, so you never
      lose sight of what you were doing.
    </p>
  {/if}
  {#each shown as win (win.id)}
    <DesktopWindow
      {win}
      title={tabLabel(win.id)}
      focused={focused === win.id}
      onFocus={() => onFocus(win.id)}
      onClose={() => onClose(win.id)}
      onToggleCollapse={() => onToggleCollapse(win.id)}
      onMove={(x, y) => onMove(win.id, x, y)}
      onResize={(w, h) => onResize(win.id, w, h)}
    >
      <PanelHost {store} {flow} tab={win.id} onOpen={onOpen} {sessions} />
    </DesktopWindow>
  {/each}
</div>
