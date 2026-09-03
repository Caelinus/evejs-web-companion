<script lang="ts">
  // One pilot in the Pilot Hangar.
  //
  // Split out of PilotHangar.svelte for the same reason BotManagerPilotRow was
  // split out of BotManager: the row carries four independent controls (select,
  // launch, pin, and — in manage mode — remove and a squad checklist) over three
  // lines of data, and inlining all of that put the screen's actual layout out
  // of reach in the middle of a 200-line template.
  //
  // The row renders and reports; it owns no state but the open/closed squad
  // menu, which is passed in so only one menu is open across the whole screen.
  import type { HangarPilot } from "../app/hangar.ts";
  import type { Squad } from "../app/hangarPrefs.ts";
  import { formatIskCompact, formatSpCompact } from "../app/hangar.ts";

  let {
    pilot,
    selected,
    manage,
    /** Below 760px a tap SELECTS instead of launching — mis-tap protection. */
    tapSelects,
    squads,
    squadMenuOpen,
    onActivate,
    onToggleSelect,
    onTogglePin,
    onRemove,
    onToggleSquadMenu,
    onToggleSquad,
  }: {
    pilot: HangarPilot;
    selected: boolean;
    manage: boolean;
    tapSelects: boolean;
    /** Every squad, for the manage-mode checklist. */
    squads: readonly Squad[];
    squadMenuOpen: boolean;
    onActivate: () => void;
    onToggleSelect: () => void;
    onTogglePin: () => void;
    onRemove: () => void;
    onToggleSquadMenu: () => void;
    onToggleSquad: (squadID: string) => void;
  } = $props();

  // Manage mode deliberately makes the row inert: it is the mode where you
  // remove pilots and shuffle squads, and a stray click that put six pilots in
  // the client would be the worst possible surprise there.
  const clickable = $derived(!manage);
  const memberOf = $derived(new Set(pilot.squads.map((s) => s.id)));

  function activate(): void {
    if (manage) return;
    if (tapSelects) onToggleSelect();
    else onActivate();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  }

  // Groundwork for dragging a pilot into a squad; no drop targets exist yet, so
  // this only makes the row grabbable and names what is being dragged.
  function onDragStart(event: DragEvent): void {
    event.dataTransfer?.setData("text/plain", pilot.name);
  }
</script>

<!-- The row is the target: a click (desktop) brings the pilot online, and a
     keyboard player gets the same through Enter/Space. In manage mode it is
     deliberately inert, so the role and the tab stop go away with the
     behaviour — which is what the two ignores below are about: the linter reads
     the conditional role as "a plain div with a tabindex". -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="hangar-row"
  class:is-selected={selected}
  class:is-clickable={clickable}
  draggable="true"
  role={clickable ? "button" : undefined}
  tabindex={clickable ? 0 : undefined}
  onclick={activate}
  onkeydown={clickable ? onKey : undefined}
  ondragstart={onDragStart}
>
  {#if !manage}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <input
      type="checkbox"
      checked={selected}
      aria-label={`Select ${pilot.name}`}
      onclick={(event) => event.stopPropagation()}
      onchange={onToggleSelect}
    />
  {/if}

  <div class="hangar-row-main">
    <div class="hangar-row-title">
      <span class="hangar-name">{pilot.name}</span>
      {#if pilot.online}
        <!-- Words with the mark, never the mark alone (R9a). -->
        <span class="hangar-badge is-online" title="Already in the client">ON</span>
      {/if}
      {#if pilot.training === null}
        <span class="hangar-badge is-idle" title="No skill in training">IDLE</span>
      {/if}
    </div>

    <div class="hangar-meta">
      <span>{pilot.shipName ?? "—"}</span>
      <span class="hangar-meta-sep">·</span>
      <span class="hangar-meta-loc">{pilot.locationName ?? "—"}</span>
    </div>

    <div class="hangar-stats">
      <span class="hangar-isk">{formatIskCompact(pilot.balance)} ISK</span>
      <span class="hangar-sp">{formatSpCompact(pilot.skillPoints)}</span>
      <span class="hangar-train" class:is-idle={pilot.training === null}>
        {pilot.training ?? "not training"}
      </span>
    </div>

    {#if manage}
      <!-- A checklist rather than a row of chips: at eleven squads a flat chip
           grid made every row about 230px tall and the grid unreadable. -->
      <div class="hangar-squadbtn-wrap">
        <button
          type="button"
          class="hangar-squadbtn"
          class:is-open={squadMenuOpen}
          aria-expanded={squadMenuOpen}
          onclick={(event) => {
            event.stopPropagation();
            onToggleSquadMenu();
          }}
        >
          <span>Squads ({pilot.squads.length})</span>
          <span aria-hidden="true">▼</span>
        </button>
        {#if squadMenuOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div class="hangar-squadmenu" onclick={(event) => event.stopPropagation()}>
            <div class="hangar-squadmenu-list">
              {#each squads as squad (squad.id)}
                {@const member = memberOf.has(squad.id)}
                <button
                  type="button"
                  class="hangar-squadmenu-row"
                  class:is-member={member}
                  aria-pressed={member}
                  onclick={() => onToggleSquad(squad.id)}
                >
                  <span class="hangar-squadmenu-mark" aria-hidden="true">✓</span>
                  <span class="hangar-swatch" style:background={squad.color}></span>
                  <span class="hangar-squadmenu-name">{squad.name}</span>
                </button>
              {/each}
              {#if squads.length === 0}
                <div class="hangar-picker-empty">No squads yet.</div>
              {/if}
            </div>
            <button type="button" class="hangar-squadmenu-done" onclick={onToggleSquadMenu}>
              Done
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="hangar-rail">
    <button
      type="button"
      class="hangar-star is-row"
      class:is-on={pilot.pinned}
      aria-pressed={pilot.pinned}
      title={pilot.pinned ? "Unpin from the top of the account" : "Pin to the top of the account"}
      onclick={(event) => {
        event.stopPropagation();
        onTogglePin();
      }}
    >★</button>
    {#if manage}
      <button
        type="button"
        class="hangar-remove is-pilot"
        title={`Remove ${pilot.name} from this list`}
        onclick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
      >✕</button>
    {/if}
    {#if pilot.squads.length > 0}
      <div class="hangar-tags">
        {#each pilot.squads as squad (squad.id)}
          <span class="hangar-tag" style:background={squad.color} title={squad.name}></span>
        {/each}
      </div>
    {/if}
  </div>
</div>
