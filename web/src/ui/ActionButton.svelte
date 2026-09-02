<script lang="ts">
  // ONE row-action button: a glyph, its word, and nothing else.
  //
  // It exists so the six transport/record verbs cannot drift apart across the
  // tables that use them — the same glyph, the same word, the same accessible
  // name, the same touch target, whether the row is a pilot or a saved bot.
  //
  // ⚠ THE WORD IS ALWAYS PRESENT, in three ways: as `aria-label` (so a screen
  // reader names it), as `title` (the pointer tooltip), and as a real
  // `<span>` that `styles.css` reveals wherever the row has room. A tooltip
  // does not exist on a touch screen, so the span is what keeps an icon-only
  // table usable on a phone — the Neocom rail solves this the same way.

  import { ACTION_GLYPHS, ACTION_LABEL, type RowAction } from "./actionIcons.ts";

  let {
    action,
    onclick,
    disabled = false,
    danger = false,
    primary = false,
    label,
    expanded,
  }: {
    action: RowAction;
    onclick: () => void;
    disabled?: boolean;
    /** The armed half of a destructive pair — colour is reinforcement only. */
    danger?: boolean;
    /** The one action the row most expects. */
    primary?: boolean;
    /** Overrides the verb, for a button whose state changes what it will do
     * ("Hide export", "Stopping…"). The glyph stays the same, because the
     * action it performs has not changed. */
    label?: string;
    /** For a button that opens something in place, so the state is announced
     * rather than only drawn. */
    expanded?: boolean;
  } = $props();

  const word = $derived(label ?? ACTION_LABEL[action]);
</script>

<button
  type="button"
  class="icon-btn"
  class:danger
  class:primary
  {disabled}
  {onclick}
  aria-label={word}
  aria-expanded={expanded}
  title={word}
>
  <svg class="icon-btn-glyph" viewBox="0 0 24 24" aria-hidden="true">
    {#each ACTION_GLYPHS[action] as d (d)}
      <path {d} />
    {/each}
  </svg>
  <span class="icon-btn-label">{word}</span>
</button>
