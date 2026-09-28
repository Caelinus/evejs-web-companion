<script lang="ts">
  // One card in the in-space mobile stack: a 32px header you tap to fold.
  //
  // ⚠ THE HEADER IS A REAL <button> AND THE BODY IS NOT A `<details>`.
  // `<details>` would have been free — keyboard-operable and announced without
  // any code — and it is what this app uses elsewhere. It is wrong here for one
  // reason: the fold has to be REMEMBERED across mounts, and `<details>` owns
  // its own open state in the DOM. Driving it from outside means fighting it on
  // every render. A button plus `aria-expanded` says the same thing to a screen
  // reader and leaves the state where the caller can persist it.
  //
  // ⚠ AND A FOLDED CARD IS NOT RENDERED, not merely hidden. These bodies poll,
  // tick and animate; `display: none` would leave every one of them running
  // behind a closed header on a phone.

  import type { Snippet } from "svelte";

  let {
    title,
    hint = null,
    collapsed,
    scrolls = false,
    onToggle,
    children,
  }: {
    title: string;
    /**
     * The one fact the folded card may not hide — a count, a state.
     *
     * The same rule the drones window's header carries: if a section can be put
     * away, whatever a pilot must not miss has to survive on the header.
     */
    hint?: string | null;
    collapsed: boolean;
    scrolls?: boolean;
    onToggle: () => void;
    children: Snippet;
  } = $props();
</script>

<section class="mob-card" class:collapsed>
  <h2 class="mob-card-head">
    <button
      type="button"
      class="mob-card-toggle"
      aria-expanded={!collapsed}
      onclick={onToggle}
    >
      <!-- The chevron is aria-hidden: `aria-expanded` is what actually says
           which way this card is, and a screen reader reading both would say it
           twice. -->
      <span class="mob-card-chevron" aria-hidden="true">{collapsed ? "▶" : "▼"}</span>
      <span class="mob-card-title">{title}</span>
      {#if hint}
        <span class="mob-card-hint">{hint}</span>
      {/if}
    </button>
  </h2>
  {#if !collapsed}
    <div class="mob-card-body" class:scrolls>
      {@render children()}
    </div>
  {/if}
</section>
