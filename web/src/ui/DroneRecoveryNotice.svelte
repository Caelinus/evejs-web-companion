<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  let { flow }: { flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const recovery = flow.droneRecovery;
</script>

{#if $recovery.phase !== "ready"}
  <div class="recovery" role="status">
    <strong>{$recovery.phase === "blocked" ? "DRONE RECOVERY BLOCKED" : "Drone recovery"}</strong>
    <span>{$recovery.reason ?? ($recovery.phase === "recovering"
      ? "Reconnecting lost drones and waiting for their return. Automation is paused."
      : "Checking nearby lost drones before automation starts.")}</span>
    {#if $recovery.phase === "blocked"}
      <button type="button" onclick={() => void flow.retryDroneRecovery()}>Retry Recovery</button>
    {/if}
  </div>
{/if}

<style>
  .recovery { display: flex; gap: 0.65rem; align-items: center; flex-wrap: wrap;
    padding: 0.5rem 0.75rem; background: #332711; color: #fbe7b8; border: 1px solid #a5792e; }
  button { border: 1px solid #c5943b; background: #433014; color: inherit; padding: 0.2rem 0.55rem; cursor: pointer; }
</style>
