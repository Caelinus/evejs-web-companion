<script lang="ts">
  // "All squads ▼" — the squad picker popover on the chip row.
  //
  // Split out of PilotHangar.svelte for the reason HangarPilotRow was: it is
  // four controls per row inside a search-filtered popover, and inlining it put
  // the chip row's own layout out of reach in the middle of the template. It
  // also makes the popover renderable on its own, which is the only way an
  // SSR test can see inside something the screen keeps closed.
  //
  // Every squad is a chip above this, so the picker is not how a squad is
  // REACHED any more. It is what the row needs once there are a dozen: search,
  // the pin that decides which lead, and the "edit" that is the only door to
  // Delete.
  //
  // The popover owns its search box and nothing else. Open/closed belongs to the
  // screen, which closes every popover at once when manage mode flips.
  import { squadMemberCount, type HangarPrefs, type Squad } from "../app/hangarPrefs.ts";
  import { pilotCountLabel } from "../app/hangar.ts";

  let {
    squads,
    prefs,
    knownIDs,
    open,
    onToggleOpen,
    onSelect,
    onTogglePin,
    onLaunch,
    onEdit,
    onNew,
  }: {
    squads: readonly Squad[];
    /** For each row's pin state and member count. */
    prefs: HangarPrefs;
    knownIDs: ReadonlySet<number>;
    open: boolean;
    onToggleOpen: () => void;
    /** Scope the hangar to this squad. The screen closes the popover. */
    onSelect: (squadID: string) => void;
    onTogglePin: (squadID: string) => void;
    onLaunch: (squadID: string) => void;
    /** Open the editor — rename, recolour, delete. */
    onEdit: (squad: Squad) => void;
    onNew: () => void;
  } = $props();

  let query = $state("");
  // A search left behind must not be what the next open shows.
  $effect(() => {
    if (!open) query = "";
  });

  const matches = $derived(
    squads.filter(
      (s) =>
        query.trim().length === 0 || s.name.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
</script>

<div class="hangar-picker">
  <div class="hangar-chip" class:is-on={open}>
    <button
      type="button"
      class="hangar-chip-select"
      aria-expanded={open}
      onclick={onToggleOpen}
    >
      <span class="hangar-chip-name">All squads ({squads.length})</span>
      <span aria-hidden="true">▼</span>
    </button>
  </div>
  {#if open}
    <div class="hangar-picker-panel">
      <div class="hangar-picker-search">
        <input
          class="hangar-input"
          type="search"
          aria-label="Search squads"
          placeholder="Search squads"
          bind:value={query}
        />
      </div>
      <div class="hangar-picker-list">
        {#each matches as squad (squad.id)}
          {@const isPinned = prefs.pinnedSquads.includes(squad.id)}
          <div class="hangar-picker-row">
            <button
              type="button"
              class="hangar-picker-select"
              onclick={() => onSelect(squad.id)}
            >
              <span class="hangar-swatch" style:background={squad.color}></span>
              <span class="hangar-picker-name">{squad.name}</span>
              <span class="hangar-picker-count">
                {pilotCountLabel(squadMemberCount(prefs, squad.id, knownIDs))}
              </span>
            </button>
            <button
              type="button"
              class="hangar-star"
              class:is-on={isPinned}
              aria-pressed={isPinned}
              title={isPinned
                ? "Stop keeping this squad at the front of the chip row"
                : "Keep this squad at the front of the chip row"}
              onclick={() => onTogglePin(squad.id)}
            >★</button>
            <!-- The one route to Delete that does not go through manage mode.
                 Without it a squad could be made from three places and unmade
                 from none, unless the player pressed Manage and noticed that the
                 chips' "▶ ALL" had quietly become an "edit". -->
            <button
              type="button"
              class="hangar-chip-edit is-picker"
              title={`Rename, recolour or delete ${squad.name}`}
              onclick={() => onEdit(squad)}
            >edit</button>
            <button
              type="button"
              class="hangar-launch is-picker"
              title={`Bring all of ${squad.name} online`}
              onclick={() => onLaunch(squad.id)}
            >▶ ALL</button>
          </div>
        {/each}
        {#if matches.length === 0}
          <div class="hangar-picker-empty">
            {squads.length === 0 ? "No squads yet." : "No squad matches that."}
          </div>
        {/if}
      </div>
      <button type="button" class="hangar-picker-new" onclick={onNew}>
        + New squad
      </button>
    </div>
  {/if}
</div>
