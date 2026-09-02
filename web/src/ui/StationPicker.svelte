<script lang="ts">
  // A station picker for the Bot Builder: search the static map by name (any
  // station in the galaxy, not just where you are docked), or one click to use
  // the station you're at. Station ids are GLOBAL in EVE, so a picked station
  // stays valid in a saved script wherever it later runs — unlike belts, which
  // are grid-local and resolve to "nearest" at run time.
  //
  // The search hits flow.searchDestinations (the read-only /api/map/find route
  // the Travel panel uses — login-gated, no live session). Under SSR no handler
  // runs, so this renders as a plain input + buttons.

  import type { AppFlow } from "../app/flow.ts";
  import type { DestinationMatch } from "../store/types.ts";
  import { BOARD_SLOTS, boardSlotStation, startingStation, type BoardSlot, type WorldRef } from "../bots/botScript.ts";
  import { boardSlotPhrase } from "../bots/scriptText.ts";

  let {
    flow,
    value,
    current,
    onPick,
    allowSystems = false,
  }: {
    flow: AppFlow;
    value: WorldRef;
    /** The station the player is docked at, offered as a one-click choice. */
    current: { id: number; name: string } | null;
    onPick: (ref: WorldRef) => void;
    /**
     * Widen the picker to SOLAR SYSTEMS as well as stations — for a destination
     * slot, where the autopilot can be pointed at a system and arrive in space.
     * The picked ref keeps the entity the match REALLY was, so a system id is
     * never stored as a station. With systems allowed the station-only runtime
     * bindings (the starting station, the mission board slots) are not offered:
     * they name stations by definition.
     */
    allowSystems?: boolean;
  } = $props();

  let query = $state("");
  let results = $state<DestinationMatch[]>([]);
  let searching = $state(false);
  let error = $state<string | null>(null);

  async function search(): Promise<void> {
    const q = query.trim();
    if (q.length < 2) {
      results = [];
      return;
    }
    searching = true;
    error = null;
    try {
      results = await flow.searchDestinations(q, allowSystems ? null : "station");
      if (results.length === 0) {
        error = allowSystems ? "No station or system matched that name." : "No stations matched that name.";
      }
    } catch {
      error = "Could not search just now — try again.";
      results = [];
    } finally {
      searching = false;
    }
  }

  function choose(match: DestinationMatch): void {
    // Keep the entity the match REALLY is: a system destination flies to the
    // system (arrive in space), a station destination docks.
    onPick({
      entity: match.kind === "system" ? "system" : "station",
      id: match.id,
      name: match.name,
      systemName: match.solarSystemName,
    });
    results = [];
    query = "";
    error = null;
  }
  function chooseCurrent(): void {
    if (current !== null) {
      onPick({ entity: "station", id: current.id, name: current.name, systemName: null });
    }
  }
  function chooseStarting(): void {
    onPick(startingStation());
  }
  function chooseSlot(slot: BoardSlot): void {
    onPick(boardSlotStation(slot));
  }
  function clearChoice(): void {
    onPick({ entity: "station", id: null, name: null, systemName: null });
  }
</script>

<span class="station-picker">
  {#if value.slot !== undefined}
    <span class="picked">{boardSlotPhrase(value.slot)}</span>
    <button onclick={clearChoice}>Change</button>
  {:else if value.starting === true}
    <span class="picked">Your starting station</span>
    <button onclick={clearChoice}>Change</button>
  {:else if value.id !== null}
    <span class="picked">
      {value.name ?? (value.entity === "system" ? "A system" : "A station")}{#if value.systemName} · {value.systemName}{/if}
      {#if value.entity === "system"}<span class="kindtag">system</span>{/if}
    </span>
    <button onclick={clearChoice}>Change</button>
  {:else}
    {#if !allowSystems}
      <button class="primary" onclick={chooseStarting}>Starting station</button>
    {/if}
    <input
      class="q"
      placeholder={allowSystems ? "search a station or system by name" : "…or search a station by name"}
      bind:value={query}
      onkeydown={(e) => {
        if (e.key === "Enter") search();
      }}
    />
    <button onclick={search} disabled={searching}>{searching ? "Searching…" : "Search"}</button>
    {#if current !== null}
      <button onclick={chooseCurrent}>Use current station</button>
    {/if}
    <!-- Runtime bindings: follow whatever an earlier block found, instead of a
         station pinned now. Station-only, so not offered on a destination slot. -->
    {#if !allowSystems}
      {#each BOARD_SLOTS as slot (slot)}
        <button onclick={() => chooseSlot(slot)}>{boardSlotPhrase(slot)}</button>
      {/each}
    {/if}
    {#if error}<span class="prob">{error}</span>{/if}
    {#if results.length > 0}
      <ul class="results">
        {#each results.slice(0, 8) as match (match.id)}
          <li>
            <button class="result" onclick={() => choose(match)}>
              {match.name}{#if match.solarSystemName} · {match.solarSystemName}{/if}{#if match.jumps !== null}
                ({match.jumps} jump{match.jumps === 1 ? "" : "s"}){/if}{#if allowSystems && match.kind === "system"}
                <span class="kindtag">system</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</span>

<style>
  .station-picker {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem;
  }
  .picked {
    color: var(--color-text-bright);
  }
  /* A system destination lands you in space, a station docks you — worth saying
     so on the row, since the two read almost identically otherwise. */
  .kindtag {
    color: var(--color-muted);
    font-size: 0.85em;
  }
  input.q {
    min-width: 12rem;
  }
  .results {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
    flex-basis: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    max-height: 12rem;
    overflow-y: auto;
  }
  /* ⚠ NO SIZE OVERRIDE ON THESE BUTTONS, DELIBERATELY. They used to carry a
     `.tiny` class that set `min-height: 32px`, which was the ONLY thing on the
     Bot Builder's screen below the 40px touch target the design system makes
     binding at every width (docs/design-system.md, R8) — measured at 360px.
     The global `button` rule already sets 2.5rem; letting it apply is the whole
     fix, so anything added here must not shrink a control again. */
  button.result {
    text-align: left;
    width: 100%;
  }
  .prob {
    color: var(--color-danger);
    font-size: 0.85rem;
  }
</style>
