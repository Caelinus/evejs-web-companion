<script lang="ts">
  // "Bringing pilots online" — one row per pilot, resolving as each one actually
  // lands in the client.
  //
  // This dialog exists because bringing six pilots online is six sign-ins and
  // six character selects against one game server, done one at a time so they do
  // not fight each other for the browser's handful of connections. That takes
  // long enough that silence reads as a hang. Each row flips the moment ITS
  // pilot is up — the progress is real, not a timed animation.
  import type { LaunchEntry } from "../app/hangarLaunch.ts";

  let {
    queue,
    done,
    onGoToFirst,
    onStay,
  }: {
    queue: readonly LaunchEntry[];
    /** Every pilot has finished, one way or the other. */
    done: boolean;
    onGoToFirst: () => void;
    onStay: () => void;
  } = $props();

  const online = $derived(queue.filter((entry) => entry.state === "online").length);
  const anyOnline = $derived(online > 0);

  // Words, not a colour (the accessibility rule in styles.css): every dot has a
  // label beside it saying the same thing.
  function stateWords(entry: LaunchEntry): string {
    switch (entry.state) {
      case "online":
        return "in client";
      case "connecting":
        return "connecting…";
      case "failed":
        return entry.note ?? "could not connect";
      default:
        return "queued";
    }
  }
</script>

<div class="hangar-overlay hangar-chrome">
  <div class="hangar-dialog" role="dialog" aria-modal="true" aria-label="Bringing pilots online">
    <div class="hangar-dialog-head">
      <span class="hangar-dialog-title">Bringing pilots online</span>
      <span class="hangar-dialog-progress">{online}/{queue.length}</span>
    </div>
    <div class="hangar-queue" role="status" aria-live="polite">
      {#each queue as entry (entry.characterID)}
        <div
          class="hangar-queue-row"
          class:is-online={entry.state === "online"}
          class:is-failed={entry.state === "failed"}
        >
          <span class="hangar-queue-dot" aria-hidden="true"></span>
          <span class="hangar-queue-name">{entry.characterName}</span>
          <span class="hangar-queue-state">{stateWords(entry)}</span>
        </div>
      {/each}
    </div>
    <div class="hangar-dialog-actions">
      <button
        type="button"
        class="hangar-dialog-primary"
        disabled={!anyOnline}
        onclick={onGoToFirst}
      >Go to first pilot</button>
      <button type="button" class="hangar-dialog-ghost" onclick={onStay}>
        {done ? "Stay here" : "Run in background"}
      </button>
    </div>
  </div>
</div>
