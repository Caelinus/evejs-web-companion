<script lang="ts">
  // Personal Assets page (goal R37): where this character's stuff is, and a
  // course set to any of it.
  //
  // A pure reader of the store's assets slice. Nothing here shows a stationID,
  // a systemID, a typeID or an itemID (R7d) — a place is its NAME and a thing
  // is its NAME, resolved through the shared name cache. Raw ids appear only in
  // `{#each}` keys and in onclick arguments, which is where the R7d note in
  // store/names.ts says they belong.
  //
  // ⚠ THE STATION LIST IS THE SERVER'S OWN AGGREGATION. charMgr.ListStations
  // resolves every item up its container chain and groups by dockable location;
  // this panel renders that answer and never rebuilds it by walking containers.
  //
  // ⚠ THREE OUTCOMES, THREE DIFFERENT SENTENCES. "Still loading", "that read
  // failed" and "you genuinely own nothing anywhere" are distinct facts, and
  // the last one is claimed ONLY from a successful empty read (`ownsNothing`).
  // Conflating them is the defect this codebase keeps producing.
  //
  // READS ONLY, plus one already-built action: setting a destination is
  // flow.startRoute, the same call Travel and the cockpit make.
  import { onMount } from "svelte";
  import {
    formatAssetVolume,
    formatUnits,
    totalVolume,
  } from "../bridge/personalAssets.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { AssetStationRow } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const assets = store.assets;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const travel = store.travel;

  let busy = $state(false);
  let error = $state("");

  /** Always a NAME, never an id — and never an id-shaped fallback either. */
  function stationName(stationID: number): string {
    return resolvedName($names.resolved, "station", stationID, "an unnamed place");
  }

  function systemName(systemID: number): string {
    return resolvedName($names.resolved, "system", systemID, "an unnamed system");
  }

  function itemName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID, "an unnamed item");
  }

  /** How many stacks this station holds, in words rather than a bare number. */
  function stackText(count: number): string {
    return count === 1 ? "1 item" : `${count.toLocaleString()} items`;
  }

  const stationCount = $derived($assets.stations.length);

  const openStation = $derived(
    $assets.expandedStationID === null
      ? null
      : ($assets.contents[$assets.expandedStationID] ?? null),
  );

  const openStationVolume = $derived(
    openStation === null ? null : totalVolume(openStation.items),
  );

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "Your session ended. Pick your character again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      busy = false;
    }
  }

  function toggle(row: AssetStationRow): void {
    const next = $assets.expandedStationID === row.stationID ? null : row.stationID;
    void run(() => flow.openAssetStation(next));
  }

  function setDestination(row: AssetStationRow): void {
    void run(() => flow.setDestinationToAssetStation(row.stationID));
  }

  onMount(() => {
    void run(() => flow.loadPersonalAssets());
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Personal Assets</h2>
    <p class="controls">
      <button
        type="button"
        class="primary"
        disabled={busy}
        onclick={() => void run(() => flow.loadPersonalAssets())}
      >
        Refresh
      </button>
    </p>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  <!-- A course that was set from this page (or anywhere else) reports itself
       here, because startRoute reports plan failures through travel state
       rather than by throwing — without this, an unreachable destination would
       look like a button that did nothing. -->
  {#if $travel.destinationName}
    <p class="note">
      Course set for {$travel.destinationName}{$travel.totalJumps > 0
        ? ` — ${$travel.remainingJumps} of ${$travel.totalJumps} jumps to go`
        : ""}.
    </p>
  {/if}
  {#if $travel.failureReason}
    <p class="error">{$travel.failureReason}</p>
  {/if}

  {#if !$assets.loaded}
    <p class="note">Looking for your things…</p>
  {:else if $assets.error}
    <!-- A FAILED read. Worded deliberately unlike the empty case below: "you
         own nothing" is a claim only a SUCCESSFUL read may make. -->
    <p class="error">
      Your assets could not be read just now, so there may be things you cannot
      see here. Try again in a moment.
    </p>
  {:else if $assets.ownsNothing}
    <!-- ⚠ A FACT FROM A SUCCESSFUL EMPTY READ, not an inference from absence. -->
    <p class="note">
      You have nothing stored anywhere right now. Anything you leave in a
      station hangar will show up here.
    </p>
  {:else}
    <p class="note">
      Your things are spread across {stationCount === 1
        ? "one place"
        : `${stationCount} places`}.
    </p>

    <!-- R8: a wide record table scrolls inside its OWN box and reflows to
         labelled cards below 640px, so the page body never scrolls sideways. -->
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Place</th>
            <th>System</th>
            <th class="num">Holding</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each $assets.stations as row (row.stationID)}
            <tr>
              <td data-label="Place">
                <span class="asset-place">
                  <TypeIcon typeID={row.typeID} name={stationName(row.stationID)} />
                  {stationName(row.stationID)}
                </span>
              </td>
              <td data-label="System">{systemName(row.solarSystemID)}</td>
              <td class="num" data-label="Holding">{stackText(row.itemCount)}</td>
              <td data-label="">
                <div class="row-actions">
                  <button type="button" disabled={busy} onclick={() => toggle(row)}>
                    {$assets.expandedStationID === row.stationID
                      ? "Hide what's here"
                      : "See what's here"}
                  </button>
                  <button type="button" disabled={busy} onclick={() => setDestination(row)}>
                    Set destination
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if $assets.expandedStationID !== null}
      <section class="panel">
        <header class="panel-head">
          <h2>At {stationName($assets.expandedStationID)}</h2>
        </header>

        {#if openStation === null}
          <p class="note">Looking inside…</p>
        {:else if openStation.error}
          <p class="error">
            What's stored here could not be read just now. Try again in a
            moment.
          </p>
        {:else if openStation.hasNoItems}
          <p class="note">Nothing is stored here any more.</p>
        {:else}
          {#if openStationVolume !== null}
            <p class="note">
              {formatAssetVolume(openStationVolume)} in total.
            </p>
          {/if}
          <div class="table-wrap overflow-x-auto">
            <table class="guests reflow">
              <thead>
                <tr>
                  <th>Item</th>
                  <th class="num">How many</th>
                  <th class="num">Each</th>
                  <th class="num">Together</th>
                </tr>
              </thead>
              <tbody>
                {#each openStation.items as item (item.itemID)}
                  <tr>
                    <td data-label="Item">
                      <span class="asset-place">
                        <TypeIcon typeID={item.typeID} name={itemName(item.typeID)} />
                        {itemName(item.typeID)}
                      </span>
                    </td>
                    <!-- ⚠ `units`, not the row's raw quantity: an assembled
                         item reports -1 there. -->
                    <td class="num" data-label="How many">{formatUnits(item.units)}</td>
                    <td class="num" data-label="Each">{formatAssetVolume(item.volume)}</td>
                    <td class="num" data-label="Together">
                      {formatAssetVolume(item.volume === null ? null : item.volume * item.units)}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</section>

<style>
  /* Icon and name read as one thing, and wrap together rather than letting the
     name run away from its picture on a narrow screen (R8). */
  .asset-place {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
</style>
