<script lang="ts">
  // Travel panel (goal R5b): the browser autopilot decide-loop's controls +
  // live readout. Start a route to a destination (station or system ID), then
  // Pause / Resume / Abort. The loop runs in the browser (app/flow.ts owns the
  // controller); this component is a pure reader of the store's travel slice.
  // No map / rendered scene — just current/next system, target, travel state,
  // remaining jumps, elapsed time, and an actionable failure reason.
  //
  // Closing the tab is closing the client: this JS dies and the loop stops
  // issuing (no "stop" is sent) — the ship completes its last server-side
  // command and sits. We deliberately register NO unload handler that would
  // send anything.
  import { onDestroy, onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { DestinationMatch } from "../store/types.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const travel = store.travel;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  // R7a — set a destination anywhere by NAME (primary), with the raw-ID input
  // kept as a fallback. The search box hits the static /api/map/find route; a
  // chosen result reuses flow.startRoute (the R5b route solver + autopilot).
  let searchQuery = $state("");
  let searchResults = $state<DestinationMatch[]>([]);
  let searched = $state(false);
  let searchTotal = $state(0);

  let destinationInput = $state("");
  let busy = $state(false);
  let error = $state("");
  let now = $state(Date.now());

  // R7c — the travel readout already resolves most names (from the route graph /
  // startRoute), but a bare ID can still leak through as a fallback. Request the
  // current/next/destination IDs (and any search-result system that lacks a name)
  // so those fallbacks attempt a name first.
  $effect(() => {
    const refs: NameRef[] = [];
    const t = $travel;
    for (const systemID of [t.currentSystemID, t.nextSystemID, t.destinationSystemID]) {
      if (systemID) {
        refs.push({ kind: "system", id: systemID });
      }
    }
    if (t.destinationStationID) {
      refs.push({ kind: "station", id: t.destinationStationID });
    }
    for (const match of searchResults) {
      if (match.solarSystemName === null && match.solarSystemID) {
        refs.push({ kind: "system", id: match.solarSystemID });
      }
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const running = $travel.status === "running";
    if (running && timer === null) {
      timer = setInterval(() => {
        now = Date.now();
      }, 1000);
    } else if (!running && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });
  onDestroy(() => {
    if (timer) {
      clearInterval(timer);
    }
  });

  // R30 slice B — claim the space feed while the Travel tab is open.
  //
  // This is the tab the operator's complaint was actually about: you fly out,
  // come here to set a destination, and go back. Before the claim, that round
  // trip STOPPED the snapshot — distances, gauges and locks all froze while the
  // ship kept moving, then jumped when you returned. The autopilot's own reads
  // papered over it only while a route was actually running.
  onMount(() => {
    flow.startSpacePolling();
    return () => flow.stopSpacePolling();
  });

  const elapsed = $derived.by(() => {
    const started = $travel.startedAt;
    if (started === null) {
      return "—";
    }
    const totalSeconds = Math.max(0, Math.floor((now - started) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  });

  function parseID(value: string): number {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  function jumpsText(jumps: number | null): string {
    if (jumps === null) {
      return "—";
    }
    if (jumps === 0) {
      return "here";
    }
    return jumps === 1 ? "1 jump" : `${jumps} jumps`;
  }

  // Search the static map by name; results go into local state (a transient
  // search, not a store slice). A too-short query clears the list.
  async function search(): Promise<void> {
    const query = searchQuery.trim();
    if (query.length < 2) {
      searchResults = [];
      searched = false;
      return;
    }
    await run(async () => {
      searchResults = await flow.searchDestinations(query);
      searchTotal = searchResults.length;
      searched = true;
    });
  }

  // Set the autopilot to a chosen match — reuse startRoute (resolves the ID to a
  // system, solves the route, runs the decide-loop). This flips the travel state
  // to running, so the panel switches to the route readout below.
  async function setDestination(match: DestinationMatch): Promise<void> {
    await run(() => flow.startRoute(match.id));
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error = panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  function systemText(id: number | null, name: string | null): string {
    if (id === null) {
      return "—";
    }
    // The graph name if the loop supplied one, else the name cache (R7c); the
    // raw system ID is never rendered.
    return name ?? resolvedName($names.resolved, "system", id, "—");
  }

  const destinationText = $derived.by(() => {
    const t = $travel;
    if (t.destinationName) {
      return t.destinationName;
    }
    // R7c/R7d — no destinationName recorded: resolve to a name, never a bare ID.
    if (t.destinationStationID) {
      return resolvedName($names.resolved, "station", t.destinationStationID, "—");
    }
    return t.destinationSystemID
      ? resolvedName($names.resolved, "system", t.destinationSystemID, "—")
      : "—";
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Travel (autopilot)</h2>
  </header>
  <!-- ⚠ THE FIRST SENTENCE IS GONE, THE SECOND IS NOT. "Set a destination and
       the autopilot flies you there" is this window telling you what a window
       called Travel is for — read once, looked past forever after. What stays
       is the half a player cannot see and would not guess. -->
  <p class="note">
    Closing this tab stops the autopilot — the ship finishes its last move and
    waits.
  </p>
</section>

{#if $travel.status === "idle" || $travel.status === "arrived" || $travel.status === "aborted" || $travel.status === "error"}
  <section>
    <h2>Set destination</h2>
    <p class="note">
      Search any solar system or station by name, then Set destination to fly
      there. The route is planned from where you are now.
    </p>
    <p class="controls">
      <label>
        Search
        <input
          type="search"
          bind:value={searchQuery}
          placeholder="e.g. Jita"
          onkeydown={(event) => {
            if (event.key === "Enter") {
              void search();
            }
          }}
        />
      </label>
      <button type="button" disabled={busy || searchQuery.trim().length < 2} onclick={() => void search()}>
        Search
      </button>
    </p>
    {#if searched}
      {#if searchResults.length === 0}
        <p class="empty">No systems or stations match “{searchQuery.trim()}”.</p>
      {:else}
        <p class="note">Showing {searchResults.length} match{searchTotal === 1 ? "" : "es"}, nearest first where known.</p>
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>System</th>
                <th class="num">Jumps</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {#each searchResults as match (match.kind + ":" + match.id)}
                <tr>
                  <td data-label="Name">{match.name}</td>
                  <td data-label="Kind">{match.kind}</td>
                  <td data-label="System">{match.solarSystemName ?? resolvedName($names.resolved, "system", match.solarSystemID, "—")}</td>
                  <td class="num" data-label="Jumps">{jumpsText(match.jumps)}</td>
                  <td data-label="">
                    <button type="button" disabled={busy} onclick={() => setDestination(match)}>
                      Set destination
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
    {#if $travel.failureReason}
      <p class="error">{$travel.failureReason}</p>
    {/if}
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </section>

  <section>
    <h2>Start route by ID</h2>
    <p class="note">Advanced: enter a station or solar system ID directly.</p>
    <p class="controls">
      <label>
        Destination
        <input
          type="number"
          min="1"
          bind:value={destinationInput}
          placeholder="station or system ID"
        />
      </label>
      <button
        type="button"
        disabled={busy || parseID(destinationInput) === 0}
        onclick={() => run(() => flow.startRoute(parseID(destinationInput)))}
      >
        Start route
      </button>
    </p>
  </section>
{:else}
  <section>
    <h2>Route to {destinationText}</h2>
    <p class="controls">
      {#if $travel.status === "running"}
        <button type="button" disabled={busy} onclick={() => run(async () => flow.pauseRoute())}>Pause</button>
      {:else if $travel.status === "paused"}
        <button type="button" disabled={busy} onclick={() => run(async () => flow.resumeRoute())}>Resume</button>
      {/if}
      <button type="button" disabled={busy} onclick={() => run(async () => flow.abortRoute())}>Abort</button>
    </p>
  </section>
{/if}

{#if $travel.status !== "idle"}
  <section>
    <h2>Status</h2>
    <table class="guests">
      <tbody>
        <tr><th>State</th><td>{$travel.status}{$travel.phase ? ` · ${$travel.phase}` : ""}</td></tr>
        <tr><th>Action</th><td>{$travel.action ?? "—"}</td></tr>
        <tr><th>Current system</th><td>{systemText($travel.currentSystemID, $travel.currentSystemName)}</td></tr>
        <tr><th>Next system</th><td>{systemText($travel.nextSystemID, $travel.nextSystemName)}</td></tr>
        <tr><th>Destination</th><td>{destinationText}</td></tr>
        <tr><th>Remaining jumps</th><td class="num">{$travel.remainingJumps} / {$travel.totalJumps}</td></tr>
        <tr><th>Elapsed</th><td>{elapsed}</td></tr>
        <tr>
          <th>Failure</th>
          <td>{#if $travel.failureReason}<span class="error">{$travel.failureReason}</span>{:else}—{/if}</td>
        </tr>
      </tbody>
    </table>
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </section>

  {#if $travel.route.length > 0}
    <section>
      <h2>Planned route ({$travel.totalJumps} jumps)</h2>
      <ol class="route">
        {#each $travel.route as hop (hop.fromSystemID + "-" + hop.toSystemID)}
          <li>
            {hop.fromSystemName ?? resolvedName($names.resolved, "system", hop.fromSystemID, "—")}
            → {hop.toSystemName ?? resolvedName($names.resolved, "system", hop.toSystemID, "—")}
          </li>
        {/each}
      </ol>
    </section>
  {/if}
{/if}
