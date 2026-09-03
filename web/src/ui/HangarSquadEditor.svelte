<script lang="ts">
  // The squad editor: name, colour, save, delete.
  //
  // Reached three ways — a chip's "edit" in manage mode, the picker's
  // "+ New squad", and "Save as squad" on the selection bar, which creates the
  // squad from the selection and opens this on it so the player can name the
  // thing they just made while they still remember what it was for.
  import { SQUAD_PALETTE, type Squad } from "../app/hangarPrefs.ts";

  let {
    squad,
    isNew,
    onSave,
    onDelete,
    onCancel,
  }: {
    /** The squad being edited. A brand-new one arrives already created. */
    squad: Squad;
    isNew: boolean;
    onSave: (patch: { name: string; color: string }) => void;
    onDelete: () => void;
    onCancel: () => void;
  } = $props();

  // The form's starting values, captured once. The parent keys this component
  // on the squad's id, so editing a DIFFERENT squad builds a new instance with
  // new starting values rather than reusing these.
  // svelte-ignore state_referenced_locally
  let name = $state(squad.name);
  // svelte-ignore state_referenced_locally
  let color = $state(squad.color);
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
    aria-label={isNew ? "New squad" : "Edit squad"}
    onclick={(event) => event.stopPropagation()}
  >
    <div class="hangar-dialog-head">
      <span class="hangar-dialog-title">{isNew ? "New squad" : "Edit squad"}</span>
    </div>
    <div class="hangar-dialog-body">
      <label class="hangar-field-label" for="hangar-squad-name">Name</label>
      <input
        id="hangar-squad-name"
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
      <div class="hangar-dialog-actions is-inline">
        <button
          type="button"
          class="hangar-dialog-primary"
          onclick={() => onSave({ name: name.trim() || squad.name, color })}
        >Save squad</button>
        <button type="button" class="hangar-dialog-danger" onclick={onDelete}>Delete</button>
        <button type="button" class="hangar-dialog-ghost" onclick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>
</div>
