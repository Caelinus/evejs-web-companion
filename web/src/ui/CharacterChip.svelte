<script lang="ts">
  // R107 — one pilot's button in the character bar: name, a docked/in-space dot,
  // and where they are, read live from that session's OWN store so a background
  // pilot's chip stays current as they fly. Clicking makes this pilot active.
  import { deriveDocked } from "./tabs.ts";
  import type { Session } from "../app/sessions.ts";

  let { session, active, onSelect, compact = false }: {
    session: Session;
    active: boolean;
    onSelect: () => void;
    /**
     * Drop the state line, keeping the dot and the name.
     *
     * ⚠ ONLY FOR THE ACTIVE PILOT ON A NARROW BAR, where the workspace header
     * directly underneath already says where the ship is — in more detail than
     * this line can ("IN SPACE · Jita · ORBIT 100%"). It must NOT be used
     * for the other pilots in the switcher: there, the state is the whole point
     * of the list, because it is how you tell which one you are switching to.
     */
    compact?: boolean;
  } = $props();

  // ⚠ THIS COMPONENT IS BOUND TO ONE SESSION FOR ITS WHOLE LIFE, AND EVERY
  // CALLER MUST KEY IT ON `session.id`.
  //
  // The two slices below are read out of `session.store` ONCE, at init. That is
  // deliberate — they are store-contract signals and `$station` needs a stable
  // top-level binding — but it means changing the `session` PROP on a live
  // instance does nothing at all: the chip goes on rendering the pilot it was
  // created for, silently and convincingly.
  //
  // The desktop strip gets this right for free (`{#each … (session.id)}`). The
  // narrow bar renders a single chip for whichever pilot is active, and without
  // a `{#key}` it showed the previous pilot's name and location after every
  // switch — while the workspace underneath had correctly switched.
  // svelte-ignore state_referenced_locally
  const station = session.store.station;
  // svelte-ignore state_referenced_locally
  const flight = session.store.flight;

  const online = $derived($station.online);
  const isDocked = $derived(deriveDocked($flight.status, $station.online));
  // A SHORT, uniform state word on the chip so every tab is about the same size:
  // a docked station name (e.g. "Jita IV - Moon 4 - Caldari Navy Assembly Plant")
  // blew the widths right out. The full location is kept for the hover title.
  const stateLabel = $derived(isDocked ? "Docked" : "In space");
  const where = $derived(
    $station.station?.stationName ??
      $station.station?.solarSystemName ??
      $flight.solarSystemName ??
      null,
  );
</script>

{#if online}
  <button
    type="button"
    class="char-chip"
    class:active
    class:compact
    onclick={onSelect}
    title={`${online.characterName} — ${stateLabel}${where ? ` · ${where}` : ""}`}
  >
    <span class="char-chip-dot" class:docked={isDocked} class:in-space={!isDocked}></span>
    <span class="char-chip-body">
      <span class="char-chip-name">{online.characterName}</span>
      {#if !compact}
        <span class="char-chip-where">{stateLabel}</span>
      {/if}
    </span>
  </button>
{/if}
