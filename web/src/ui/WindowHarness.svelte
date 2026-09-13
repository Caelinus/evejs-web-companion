<script lang="ts">
  // DEV-ONLY VISUAL HARNESS: every window the app can open, laid out at once.
  //
  // WHY IT EXISTS. A change to window chrome — the title bar, the head strip,
  // what a panel is allowed to say about itself — is a change to THIRTY
  // windows, and the only way to judge it is to see them side by side. The
  // alternative is opening them one at a time in the live app, which needs the
  // BFF, the gateway and a signed-in pilot, and which shows one window per
  // click; a strip that reads well on Market and badly on Skills would not be
  // noticed until the sixth window in.
  //
  // It mounts the REAL panels through the REAL `PanelHost` inside the REAL
  // `DesktopWindow`, so it cannot drift from what ships: if a panel changes,
  // this page changes with it.
  //
  // WHAT IT CANNOT SHOW. The store is COLD — no pilot, no station, no reads
  // answered — so every table is empty and every panel shows its first-frame
  // paint. That is the right subject for chrome work (a head, a title, a
  // standing paragraph all render on a cold store) and the wrong one for
  // anything about rows. Panels that need a signed-in pilot to say anything at
  // all say so here, which is itself worth seeing.
  //
  // Not part of the build: `vite.config.ts` builds `web/index.html` only. Open
  // it with `npm run dev:web` at /window-harness.html.
  import DesktopWindow from "./DesktopWindow.svelte";
  import PanelHost from "./PanelHost.svelte";
  import MobileWorkspace from "./MobileWorkspace.svelte";
  import { TABS, tabLabel, type TabID } from "./tabs.ts";
  import { createClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  /**
   * A flow that answers nothing.
   *
   * ⚠ `requestOptions` IS REAL, the rest are no-ops. Panels call it
   * SYNCHRONOUSLY and hand the result to `fetch`, so a proxy that returned an
   * async function for it would put a Promise where an options object goes and
   * throw during the panel's first mount — which would look exactly like the
   * panel being broken.
   *
   * ⚠ AND A FEW READS MUST ANSWER IN THEIR OWN SHAPE. A panel that does
   * `groups = await flow.loadMarketGroups(0)` and then renders `groups.length`
   * does not fail at the call — it fails in the TEMPLATE, one tick later, and
   * takes its whole window down with a script error. `undefined` is not a
   * neutral answer to a read whose result is indexed; an empty one is.
   */
  const EMPTY_READS: Record<string, unknown> = {
    loadMarketGroups: [],
    loadMarketGroupTypes: { types: [], capped: false },
  };
  const flow = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "requestOptions") return () => ({});
        const canned = EMPTY_READS[key as string];
        return async () => canned;
      },
    },
  ) as unknown as AppFlow;

  const store = createClientStore();

  // Both states, because `where` decides which panels exist at all: a docked
  // pilot has no Flight window and a flying one has no Fitting.
  let docked = $state(true);
  const shown = $derived(
    TABS.filter((tab) => tab.where === "both" || tab.where === (docked ? "docked" : "in-space")),
  );

  // The desktop lays windows out absolutely, so the harness does the same
  // arithmetic rather than a grid: same component, same positioning, no
  // second layout path that could flatter the design.
  const COL_W = 560;
  const ROW_H = 420;
  const GAP = 24;
  let columns = $state(3);

  function place(index: number): { x: number; y: number } {
    return {
      x: GAP + (index % columns) * (COL_W + GAP),
      y: GAP + Math.floor(index / columns) * (ROW_H + GAP),
    };
  }

  const deskHeight = $derived(
    GAP + Math.ceil(shown.length / columns) * (ROW_H + GAP),
  );

  /**
   * The phone layout, which is the same panels with NO window chrome at all.
   *
   * ⚠ IT FILLS THE VIEWPORT RATHER THAN SITTING IN A PHONE-SIZED BOX, and that
   * is the whole point of having it here. The mobile rules are `@media
   * (max-width: 640px)` — they ask how wide the VIEWPORT is, not how wide this
   * component is. Rendering the mobile workspace inside a 390px frame on a
   * desktop-width window would lay it out at 390px with every phone rule
   * switched OFF, which is a picture of something that does not exist. To look
   * at the phone, the browser has to BE phone-width.
   *
   * So this replaces the desktop grid instead of sitting beside it, and the
   * thing to do with it is narrow the window.
   */
  let phone = $state(false);
</script>

<!-- ⚠ IN PHONE MODE THESE CONTROLS GO WHERE THE CHARACTER BAR WOULD BE. The
     mobile workspace is `position: fixed; inset: var(--char-bar-h) 0 0 0` — it
     pins itself under the app's character bar and ignores page flow entirely.
     A harness bar that WRAPS at phone width therefore does not push it down, it
     covers it. Fixed, one row, exactly the bar's height: the harness occupies
     the slot the real chrome would, and hides nothing it is here to show. -->
<div class="harness-controls" class:phone>
  <span class="harness-count">{phone ? "phone" : `${shown.length} windows`}</span>
  <button type="button" class:on={docked} onclick={() => (docked = true)}>Docked</button>
  <button type="button" class:on={!docked} onclick={() => (docked = false)}>In space</button>
  <span class="harness-sep"></span>
  <button type="button" class:on={!phone} onclick={() => (phone = false)}>Windows</button>
  <button type="button" class:on={phone} onclick={() => (phone = true)}>Phone</button>
  {#if !phone}
    <span class="harness-sep"></span>
    {#each [1, 2, 3] as n (n)}
      <button type="button" class:on={columns === n} onclick={() => (columns = n)}>
        {n} wide
      </button>
    {/each}
  {:else}
    <span class="harness-hint">narrow the window to 640px or less</span>
  {/if}
</div>

{#if phone}
  <MobileWorkspace {store} {flow} isDocked={docked} sessions={[]} />
{:else}
<div class="desktop harness-desktop" style="height:{deskHeight}px">
  {#each shown as tab, index (tab.id)}
    {@const at = place(index)}
    <DesktopWindow
      win={{ id: tab.id as TabID, x: at.x, y: at.y, w: COL_W, h: ROW_H, z: 1, minimized: false }}
      title={tabLabel(tab.id)}
      focused={index === 0}
      onFocus={() => {}}
      onClose={() => {}}
      onToggleMinimize={() => {}}
      onMove={() => {}}
      onResize={() => {}}
    >
      <PanelHost {store} {flow} tab={tab.id} sessions={[]} />
    </DesktopWindow>
  {/each}
</div>
{/if}

<style>
  .harness-hint {
    margin-left: 0.4rem;
    color: #8fa3b8;
    font-size: 0.75rem;
  }
  .harness-controls.phone {
    position: fixed;
    inset: 0 0 auto 0;
    z-index: 60;
    height: 2.75rem;
    padding: 0 0.4rem;
    flex-wrap: nowrap;
    overflow-x: auto;
    white-space: nowrap;
  }
  .harness-controls.phone button {
    min-height: 1.6rem;
    padding: 0.1rem 0.4rem;
    font-size: 0.7rem;
  }
  .harness-controls.phone .harness-hint { display: none; }
  .harness-controls {
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    gap: 0.4rem;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background: #05080d;
    border-bottom: 1px solid #1b2836;
  }
  .harness-count {
    margin-right: 0.5rem;
    color: #8fa3b8;
    font-size: 0.8rem;
  }
  .harness-sep {
    width: 1px;
    height: 1.2rem;
    margin: 0 0.4rem;
    background: #1b2836;
  }
  .harness-controls button.on {
    border-color: #3d6f96;
    color: #a9d3f0;
  }
  /* The desktop is normally `inset: 0` inside the app shell; here it scrolls
     with the page so every window can be reached by scrolling rather than by
     shrinking them to fit. */
  .harness-desktop {
    position: relative;
    width: 100%;
  }
</style>
