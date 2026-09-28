<script lang="ts">
  // WHERE A DELIVERY LANDS: the pilot's own hangar, or one of their
  // corporation's seven hangar divisions at the station the block is hauling to.
  //
  // ⚠ IT IS OFFERED ONLY WHERE THERE IS AN OFFICE, WHICH IS WHY IT NEEDS A
  // READ AT ALL. A corporation hangar exists at a station only while the
  // corporation rents an office there, so a picker that always listed seven
  // divisions would be listing seven places the ore cannot go. The offices read
  // is corporation-wide and station-independent (GET /api/bridge/corp-offices),
  // so this can answer for a station on the far side of the map that the ship
  // has never docked at — which is the only thing that makes the question
  // answerable while a script is being WRITTEN rather than flown.
  //
  // ⚠ THE ANSWER IS ADVICE, NOT A GUARANTEE, and nothing here pretends
  // otherwise. Between saving a script and flying it, an office can be let go,
  // a division renamed, a role taken away — and a station slot can be a runtime
  // binding ("your starting station") that names no station until the run picks
  // one. So the real check happens at the office, on arrival, every lap; the
  // run puts the load in the pilot's own hangar when it fails and says so. This
  // picker exists to stop a player choosing something that is already wrong, not
  // to promise it will still be right.
  //
  // Its own component for the reason `BotInspector.svelte` is one: Svelte
  // templates are not type-checked here (docs/svelte-typecheck-gap.md), and an
  // SSR render is the only net a template has. Everything arrives as a prop.

  import type { AppFlow } from "../app/flow.ts";
  import type { CorpOfficeDivision } from "../app/api.ts";
  import type { WorldRef } from "../bots/botScript.ts";

  let {
    flow,
    value,
    station,
    onPick,
  }: {
    flow: AppFlow;
    /** The chosen division, or null for the pilot's own hangar. */
    value: { division: number; name: string | null } | null;
    /**
     * The station this block hauls to, as the step holds it. A ref with no `id`
     * — a board slot, "your starting station", an unfilled slot — names no
     * station YET, and is a reason to keep the choice open rather than to hide
     * it: the office check for those happens on arrival.
     */
    station: WorldRef | null;
    onPick: (division: { division: number; name: string | null } | null) => void;
  } = $props();

  let divisions = $state<readonly CorpOfficeDivision[]>([]);
  let officeStations = $state<readonly number[]>([]);
  let readError = $state<string | null>(null);
  let loading = $state(true);
  let loaded = false;

  // One read for the life of the inspector. Offices change on the timescale of
  // a corporation renting one, not of a player editing a step, and re-reading
  // per keystroke would put a bridge call behind every click in the builder.
  $effect(() => {
    if (loaded) {
      return;
    }
    loaded = true;
    void (async () => {
      try {
        const result = await flow.loadCorpOffices();
        divisions = result.divisions;
        officeStations = result.stationIDs;
        readError = result.error;
      } catch {
        readError = "READ_FAILED";
      } finally {
        loading = false;
      }
    })();
  });

  /** A station that is pinned now — as opposed to one a runtime binding decides. */
  const pinnedStationID = $derived(
    station !== null && station.slot === undefined && station.starting !== true && station.id !== null
      ? station.id
      : null,
  );
  const officeHere = $derived(pinnedStationID !== null && officeStations.includes(pinnedStationID));
  /** Offer the choice where it can be used, and where it cannot yet be ruled out. */
  const offering = $derived(divisions.length > 0 && (officeHere || pinnedStationID === null));

  function label(entry: CorpOfficeDivision): string {
    return entry.name ?? `Division ${entry.division}`;
  }

  function choose(raw: string): void {
    const division = Number(raw);
    if (!Number.isSafeInteger(division) || division <= 0) {
      onPick(null);
      return;
    }
    // The NAME is saved with the ordinal so the block's sentence still reads in
    // words on a machine that has never opened this office. The ordinal is what
    // the run delivers by.
    const entry = divisions.find((candidate) => candidate.division === division) ?? null;
    onPick({ division, name: entry?.name ?? null });
  }
</script>

<span class="corp-hangar-picker">
  {#if loading}
    <span class="hint">Checking your corporation's offices…</span>
  {:else if offering}
    <select value={value === null ? "" : String(value.division)} onchange={(e) => choose(e.currentTarget.value)}>
      <option value="">your own hangar</option>
      {#each divisions as entry (entry.division)}
        <option value={String(entry.division)}>{label(entry)}</option>
      {/each}
    </select>
    {#if pinnedStationID === null}
      <span class="hint">
        This step picks its station when it runs, so the office is checked on arrival.
      </span>
    {/if}
    {#if value !== null}
      <span class="hint">
        Ore put in a corporation hangar belongs to the corporation. If the office
        or your role is gone when the ship docks, the load goes into your own
        hangar instead.
      </span>
    {/if}
  {:else if readError !== null}
    <!-- "We could not check" is not "there is no office", and saying the second
         when the first happened is how a working feature looks broken. -->
    <span class="hint">Your corporation's offices could not be checked just now, so this stays your own hangar.</span>
  {:else if divisions.length === 0}
    <span class="hint">You are in no corporation with hangar divisions, so ore goes to your own hangar.</span>
  {:else}
    <span class="hint">Your corporation has no office there, so ore goes to your own hangar.</span>
  {/if}
</span>

<style>
  .corp-hangar-picker {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem;
  }
  .hint {
    opacity: 0.75;
    font-size: 0.85em;
  }
</style>
