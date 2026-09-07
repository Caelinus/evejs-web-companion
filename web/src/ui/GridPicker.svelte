<script lang="ts">
  // Pick something that is on the grid, BY NAME.
  //
  // ⚠ THIS REPLACED THE LAST PLACE IN THE CLIENT WHERE A PLAYER TYPED A RAW ID
  // BY HAND. `Flight.svelte` asked for a "stargate / celestial ID", a "source
  // stargate ID" and a "destination station ID" — three number fields a player
  // could only fill by finding the number somewhere else, which the client
  // never showed them (R7d forbids it). The controls were therefore unusable by
  // anyone who was not reading the server's own database.
  //
  // ⚠ A FILTER PLUS A NATIVE `<select>`, DELIBERATELY. A busy grid carries
  // hundreds of balls, so a bare select is a scroll; a bare text box is the id
  // field again with extra steps. The select stays native because it is
  // keyboard-operable, type-ahead searchable and screen-reader announced for
  // free — none of which a div-and-listbox reimplementation gets right by
  // accident, and all of which R8 requires.
  //
  // ⚠ AND AN EMPTY GRID IS A SENTENCE, NOT AN EMPTY BOX. "Nothing here to warp
  // to" is a fact about the grid; a select with no options is a control that
  // looks broken.

  import { filterOptions, keepPick } from "./gridPicker.ts";
  import type { PickOption } from "./gridPicker.ts";

  let {
    label,
    options,
    value,
    onPick,
    emptyText,
    filterPlaceholder = "Filter by name",
  }: {
    /** What the control is called, e.g. "Warp to". */
    label: string;
    options: readonly PickOption[];
    /**
     * The picked id, or 0 for none.
     *
     * ⚠ ONE-WAY, WITH `onPick` BACK — deliberately not `$bindable`. A caller may
     * want a DEFAULT (the Mining panel defaults to your own hull, which is the
     * candidate with no range problem to solve), and a two-way binding forces
     * that default to be written in by an effect, which never runs under SSR
     * and leaves one frame where the control and the button disagree about what
     * is selected.
     */
    value: number;
    onPick: (id: number) => void;
    /** What to say when there is nothing on the grid to pick. */
    emptyText: string;
    filterPlaceholder?: string;
  } = $props();

  let filter = $state("");

  const shown = $derived(filterOptions(options, filter));

  /**
   * ⚠ A PICK THAT IS NO LONGER ON THE LIST IS DROPPED.
   *
   * The grid changes under the player every poll — a rock is mined out, a ship
   * warps off, a filter is typed. Holding on to an id that is no longer offered
   * would leave a control armed with something the server cannot act on, and
   * the failure would arrive as a refusal for a thing the player can no longer
   * see. Better to tell the caller and make them pick again.
   */
  $effect(() => {
    const kept = keepPick(value, shown);
    if (kept !== value) {
      onPick(kept);
    }
  });
</script>

<span class="grid-picker">
  <label class="grid-picker-filter">
    <span class="grid-picker-label">{label}</span>
    {#if options.length > 0}
      <input
        type="search"
        bind:value={filter}
        placeholder={filterPlaceholder}
        aria-label={`Filter ${label.toLowerCase()} by name`}
      />
    {/if}
  </label>
  {#if options.length === 0}
    <span class="note grid-picker-empty">{emptyText}</span>
  {:else}
    <select
      {value}
      onchange={(event) => onPick(Number((event.currentTarget as HTMLSelectElement).value))}
      aria-label={label}
    >
      <option value={0}>Pick one…</option>
      {#each shown as option (option.id)}
        <option value={option.id}>
          {option.label}{option.hint ? ` — ${option.hint}` : ""}
        </option>
      {/each}
    </select>
    {#if shown.length === 0}
      <!-- The filter, not the grid, is what emptied the list. Say which. -->
      <span class="note grid-picker-empty">Nothing on the grid matches that.</span>
    {/if}
  {/if}
</span>
