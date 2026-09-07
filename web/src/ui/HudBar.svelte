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
  import { shipIsStopped, shipStateSentenceFor } from "./shipHud.ts";
  import { distanceMeters, formatDistance } from "../space/overview.ts";
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

  /**
   * And the hull's own name — see the note in `ModuleRack.svelte`. The header
   * fell back to "Your ship" for the same reason the rack's tooltips fell back
   * to a dash: nothing on screen was asking for the name any more.
   */
  $effect(() => {
    const typeID = ship?.typeID ?? null;
    if (typeID === null || typeID <= 0) {
      return;
    }
    if (resolvedName($names.resolved, "type", typeID, "") === "") {
      flow.requestNames([{ kind: "type", id: typeID }]);
    }
  });

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
  /**
   * Whether the hull is worth printing NEXT TO the name.
   *
   * ⚠ FOUND LIVE, NOT REASONED ABOUT. A ship whose pilot never renamed it is
   * called after its hull, so the header read "Ship Sunchaser Sunchaser" — the same
   * word twice, in two weights, which reads as a rendering fault rather than as
   * two facts. When they are the same word there is only one fact, so only one
   * is shown.
   */
  const showHull = $derived(
    shipNameText === null || shipNameText.toLowerCase() !== hullText.toLowerCase(),
  );
  /**
   * ⚠ THE HEADER USED TO CARRY A ONE-WORD MODE — ORBIT, WARP, STOP — with the
   * full sentence in a footer underneath. Both said the same thing and the
   * short one said less: "ORBIT" does not say what is being orbited or how far
   * away it is, and the sentence does. So the sentence took the header's
   * right-hand slot and the footer went with the duplication.
   *
   * `shipIsStopped` survives the change: it still quiets the line, because
   * "stopped" is the absence of activity and should not read as an event.
   */
  const stopped = $derived(shipIsStopped(ship?.mode ?? null));

  /**
   * What the ship is acting ON, when the server says. Usually it does not.
   *
   * ⚠ NOT GUESSED FROM WHAT THIS PANEL LAST ORDERED. A course set by a bot, by
   * another client or by a previous session is the common case while this app
   * is running, and a sentence assembled from a stale local memory is
   * indistinguishable, to a player, from one the ship reported.
   */
  const actedOn = $derived.by(() => {
    const selfRow = ($space.snapshot?.entities ?? []).find((e) => e.itemID === ship?.itemID) ?? null;
    const targetID = selfRow?.targetEntityID ?? null;
    if (targetID === null) {
      return { name: null as string | null, metres: null as number | null };
    }
    const target = ($space.snapshot?.entities ?? []).find((e) => e.itemID === targetID) ?? null;
    if (!target) {
      return { name: null as string | null, metres: null as number | null };
    }
    const name =
      target.name && target.name.length > 0
        ? target.name
        : resolvedName($names.resolved, "type", target.typeID, "");
    const from = ship?.position ?? null;
    return {
      name: name.length > 0 ? name : null,
      metres: from ? distanceMeters(from, target.position) : null,
    };
  });

  const stateText = $derived(
    shipStateSentenceFor(ship, actedOn.name, actedOn.metres, formatDistance),
  );

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
  <!--
    The header: which ship this instrument is about, what it is doing, and the
    one control a pilot presses without looking.

    ⚠ THE FOOTER IS GONE, AND THIS IS WHERE IT WENT. The cell used to be three
    rows: a header saying ORBIT, the instruments, and a footer carrying the full
    state sentence, a gesture legend and Stop. Two of those three were saying
    something the other already said — "ORBIT" is the sentence with the useful
    half removed — and the third was a legend for a gesture. One row, and the
    instruments get the height back.

    Three columns, `1fr auto 1fr`: Stop is centred against the CELL and not
    against whatever the ship happens to be called, so it does not drift as the
    name and the sentence change length. It is the control reached for when
    things are going wrong; it has to be in the same place every time.
  -->
  <header class="hud-head">
    <span class="hud-head-ship">
      <span class="hud-head-tag">Ship</span>
      {#if shipNameText}
        <span class="hud-head-name">{shipNameText}</span>
      {/if}
      {#if showHull}
        <span class="hud-head-hull">{hullText}</span>
      {/if}
    </span>

    <!-- No `disabled`, ever. See stopShip above. -->
    <button type="button" class="hud-stop" onclick={() => stopShip()}>Stop</button>

    {#if stopError}
      <!-- ⚠ THE REFUSAL TAKES THE STATE'S PLACE, rather than being appended
           beside it. It is the same row and there is one slot; a reason Stop
           did nothing is worth more, right then, than a sentence about what the
           ship is still doing — and it sits next to the button that refused,
           which is where R30 wants it. -->
      <span class="hud-head-state error" role="alert">{stopError}</span>
    {:else}
      <span class="hud-head-state" class:stopped>{stateText}</span>
    {/if}
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

</div>
