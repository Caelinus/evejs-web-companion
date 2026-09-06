<script lang="ts">
  // The persistent flying HUD — the bottom-left cell of the in-space workspace
  // (direction 1C): the ship's gauges and its module rack, under a header that
  // names the hull and over a footer that says what the ship is doing and offers
  // the one control a pilot reaches for when it is going wrong.
  //
  // ⚠ WHAT LEFT THIS COMPONENT, AND WHERE IT WENT. Two things used to be here
  // and are not any more. Neither was DELETED — a HUD that quietly drops
  // capability is a worse HUD:
  //
  //   • "Shots fired" — the combat log. It is a scrolling list of text, which is
  //     the one shape that cannot share a cell with two instruments; it now
  //     lives in the transitional `Overview` window (and gets its own panel in
  //     Phase 4). The HUD kept the things you read at a glance.
  //   • The Flight / Mining nav buttons — every one of them is a rail entry in
  //     the Neocom, which is on screen at the same time. Two ways to open the
  //     same window, one of them costing a row of the HUD, is not a feature.
  //
  // ⚠ AND WHAT ARRIVED. Stop moved IN, out of the transitional window's flight
  // strip. It is the control a pilot needs without hunting, so it belongs on the
  // surface that is always on screen — and it must never be disabled; see below.
  import ModuleRack from "./ModuleRack.svelte";
  import ShipHud from "./ShipHud.svelte";
  import { shipStateSentence } from "./shipHud.ts";
  import { resolvedName } from "../store/names.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  // The module rack needs the ship's fit; Fitting is a docked-only tab, so pull
  // it once here. Fire-and-forget; $effect never runs under SSR.
  $effect(() => {
    if (!$fitting.loaded) void flow.loadFitting().catch(() => {});
  });

  const ship = $derived($space.snapshot?.ship ?? null);

  /** The hull's TYPE name — what kind of ship this is. Never an id (R7d). */
  const hullText = $derived(
    ship ? resolvedName($names.resolved, "type", ship.typeID, "Your ship") : "Your ship",
  );
  /**
   * What the pilot called this particular ship, when they called it anything.
   *
   * ⚠ NULL IS NOT "UNNAMED". A ship with no name in the snapshot is a ship the
   * server did not name for us, so the header simply shows the hull — it does
   * not print a placeholder where a name would be.
   */
  const shipNameText = $derived(
    ship?.name && ship.name.trim().length > 0 ? ship.name.trim() : null,
  );
  const stateText = $derived(shipStateSentence(ship));

  /**
   * The refusal from the LAST press of Stop — "" when nothing went wrong.
   *
   * It renders next to Stop rather than anywhere else, for the same reason the
   * overview keeps its errors per control: a failure a screen away from the
   * button that caused it is a failure the player will not connect to it.
   */
  let stopError = $state("");

  /**
   * ⚠ STOP HAS NO BUSY GUARD, AND MUST NEVER GET ONE. DO NOT CLEAN THIS UP.
   *
   * It is the control a player reaches for when something is going wrong, which
   * is exactly the moment other requests are in flight — so any busy flag, even
   * its own, would grey it out at the only time it matters. Dropping the click
   * because a previous one had not answered yet would be the same failure
   * wearing a friendlier face: the ship keeps going and nothing says why.
   * Issuing Stop twice is harmless; it means the same thing every time.
   */
  async function stopShip(): Promise<void> {
    stopError = "";
    try {
      await flow.stopShip();
    } catch (cause) {
      stopError = String(cause);
    }
  }
</script>

<div class="hud-bar">
  <!-- The header: which ship this instrument is about. 32px, so it costs the
       gauges almost nothing, and it is what makes the cell self-describing when
       three windows are floating over the radar. -->
  <header class="hud-head">
    <span class="hud-head-tag">Ship</span>
    {#if shipNameText}
      <span class="hud-head-name">{shipNameText}</span>
    {/if}
    <span class="hud-head-hull">{hullText}</span>
  </header>

  <div class="hud-body">
    <section class="hud-cluster ship-gauges" aria-label="Ship status">
      <ShipHud {store} />
    </section>

    <section class="hud-cluster module-rack" aria-labelledby="hud-modules-h">
      <div class="panel-head"><h3 id="hud-modules-h">Modules</h3></div>
      <ModuleRack {store} {flow} />
    </section>
  </div>

  <footer class="hud-foot">
    <span class="hud-foot-state">{stateText}</span>
    <!-- No `disabled`, ever. See stopShip above. -->
    <button type="button" class="primary hud-stop" onclick={() => stopShip()}>Stop the ship</button>
    {#if stopError}
      <span class="hud-foot-error error" role="alert">{stopError}</span>
    {/if}
  </footer>
</div>
