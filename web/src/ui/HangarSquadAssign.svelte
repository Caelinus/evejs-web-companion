<script lang="ts">
  // "Save as squad" — where the selection on the hangar's selection bar becomes
  // squad membership.
  //
  // WHY THIS EXISTS AT ALL. The button used to create a squad the moment it was
  // pressed and then open the editor on it, so "Save as squad" → Cancel still
  // left a "New squad 3" behind, and there was no way to put the selection into
  // a squad that already existed — every op made another squad. This dialog is
  // the fix for both: it CHOOSES first and COMMITS on confirm. Nothing is
  // written while it is open, so Cancel and the backdrop are genuinely nothing.
  import { SQUAD_PALETTE, type HangarPrefs, type Squad } from "../app/hangarPrefs.ts";
  import { squadMemberCount } from "../app/hangarPrefs.ts";

  let {
    pilotCount,
    squads,
    prefs,
    knownIDs,
    suggestedName,
    suggestedColor,
    onConfirm,
    onCancel,
  }: {
    /** How many pilots are selected — the dialog never sees the pilots themselves. */
    pilotCount: number;
    squads: readonly Squad[];
    /** For the "n pilots" count beside each existing squad. */
    prefs: HangarPrefs;
    knownIDs: ReadonlySet<number>;
    suggestedName: string;
    suggestedColor: string;
    /**
     * The one write. `{ kind: "existing" }` adds the selection to that squad;
     * `{ kind: "new" }` creates one holding exactly the selection.
     */
    onConfirm: (
      choice:
        | { kind: "existing"; squadID: string }
        | { kind: "new"; name: string; color: string },
    ) => void;
    onCancel: () => void;
  } = $props();

  // With no squads yet there is nothing to choose between, so the form starts on
  // "new" and the (empty) list is not offered at all.
  let mode = $state<"existing" | "new">(squads.length > 0 ? "existing" : "new");
  // svelte-ignore state_referenced_locally
  let chosen = $state<string | null>(squads[0]?.id ?? null);
  // svelte-ignore state_referenced_locally
  let name = $state(suggestedName);
  // svelte-ignore state_referenced_locally
  let color = $state(suggestedColor);

  const canConfirm = $derived(
    mode === "new" ? name.trim().length > 0 : chosen !== null,
  );

  function confirm(): void {
    if (!canConfirm) return;
    if (mode === "new") onConfirm({ kind: "new", name: name.trim(), color });
    else if (chosen) onConfirm({ kind: "existing", squadID: chosen });
  }

  const countWords = $derived(pilotCount === 1 ? "1 pilot" : `${pilotCount} pilots`);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="hangar-overlay hangar-chrome" onclick={onCancel}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="hangar-dialog is-narrow"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Save as squad"
    onclick={(event) => event.stopPropagation()}
  >
    <div class="hangar-dialog-head">
      <span class="hangar-dialog-title">Save as squad</span>
      <span class="hangar-dialog-progress">{countWords} selected</span>
    </div>
    <div class="hangar-dialog-body">
      {#if squads.length > 0}
        <span class="hangar-field-label">Add to an existing squad</span>
        <div class="hangar-picker-list is-choices">
          {#each squads as squad (squad.id)}
            <button
              type="button"
              class="hangar-choice"
              class:is-on={mode === "existing" && chosen === squad.id}
              aria-pressed={mode === "existing" && chosen === squad.id}
              onclick={() => {
                mode = "existing";
                chosen = squad.id;
              }}
            >
              <span class="hangar-choice-mark" aria-hidden="true">●</span>
              <span class="hangar-swatch" style:background={squad.color}></span>
              <span class="hangar-picker-name">{squad.name}</span>
              <span class="hangar-picker-count">
                {squadMemberCount(prefs, squad.id, knownIDs)}
              </span>
            </button>
          {/each}
        </div>

        <button
          type="button"
          class="hangar-choice is-new"
          class:is-on={mode === "new"}
          aria-pressed={mode === "new"}
          onclick={() => (mode = "new")}
        >
          <span class="hangar-choice-mark" aria-hidden="true">●</span>
          <span class="hangar-picker-name">Create a new squad</span>
        </button>
      {/if}

      {#if mode === "new"}
        <label class="hangar-field-label" for="hangar-assign-name">Squad name</label>
        <input
          id="hangar-assign-name"
          class="hangar-input"
          type="text"
          placeholder="e.g. Mining Op"
          bind:value={name}
        />
        <span class="hangar-field-label">Colour</span>
        <div class="hangar-swatches">
          {#each SQUAD_PALETTE as swatch (swatch)}
            <button
              type="button"
              class="hangar-swatch-btn"
              class:is-on={color === swatch}
              style:background={swatch}
              aria-pressed={color === swatch}
              aria-label={`Colour ${SQUAD_PALETTE.indexOf(swatch) + 1} of ${SQUAD_PALETTE.length}`}
              onclick={() => (color = swatch)}
            ></button>
          {/each}
        </div>
      {/if}

      <div class="hangar-dialog-actions is-inline">
        <button
          type="button"
          class="hangar-dialog-primary"
          disabled={!canConfirm}
          onclick={confirm}
        >{mode === "new" ? `Create squad with ${countWords}` : `Add ${countWords}`}</button>
        <button type="button" class="hangar-dialog-ghost" onclick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>
</div>
