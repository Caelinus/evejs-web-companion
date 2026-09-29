<script lang="ts">
  import type { MiningOperationRuntime } from "../app/api.ts";
  import { miningOperationRunView, operationTime, operationRemaining, operationMemberRecovery } from "../app/miningOperationRunView.ts";
  import { hostedDurationLabel, type HostedRunPolicy } from "../bots/hostedRunPolicy.ts";
  let { runtime, policy, parking = false, stale = false, busy = false, onExtend }: {
    runtime: MiningOperationRuntime; policy: HostedRunPolicy | null; parking?: boolean; stale?: boolean; busy?: boolean;
    onExtend: (minutes: number) => void;
  } = $props();
  const view = $derived(miningOperationRunView(runtime, policy, parking));
</script>

{#if runtime.recoveryRequired}
  <aside class="notice">
    <strong>Recovered after WC restart — RECOVERED_UNKNOWN</strong>
    <p>Current target was intentionally discarded for safety. Miners are not automatically resumed.</p>
    <p>Stop recovered operation → wait for STOPPED → review configuration and run limit → Start operation again. Fresh Start acquires a target through the shared board; the old target is not restored.</p>
    {#if parking}<p>Configured Parking still applies. Unavailable members can block completion; resolve the listed per-member failures before a fresh Start. No arrival or cleanup is assumed.</p>{/if}
  </aside>
{/if}
{#if runtime.startedAt || view.hosted.length || runtime.recoveryRequired || runtime.members.some(member => member.lastHostReason)}
  <section aria-label="Hosted operation timing">
    <p><strong>Started:</strong> {operationTime(runtime.startedAt)} · <strong>Expires:</strong> {operationTime(view.expiresAt)} · <strong>Remaining:</strong> {operationRemaining(view.remainingMs)} · <strong>Hosted:</strong> {view.hosted.length} / {runtime.members.length}</p>
    <p class="muted">{stale ? "Last known server state — disconnected/stale" : "Server state"} as of {operationTime(runtime.observedAt)}. Earliest currently hosted required-member expiry, including haulers. Times shown in your local timezone.</p>
    {#if runtime.recoveryRequired}<p class="muted">Started reflects the recovered hosted run; the original pre-crash operation start is unavailable.</p>{/if}
    {#if !view.hosted.length}<p>No active hosted member grants.</p>{/if}
    {#if view.grantMismatch}<p class="notice"><strong>Grant mismatch:</strong> Earliest {operationTime(view.expiresAt)} · Latest {operationTime(view.latestExpiresAt)}. Details below.</p>{/if}
    {#each view.warnings as warning}<p class="notice">{warning}</p>{/each}
    {#if view.maximumReached}<p class="notice">Maximum hosted runtime reached: {hostedDurationLabel(policy!.maxRuntimeMinutes)}.</p>
    {:else if view.canExtend && view.hosted.length && !view.choices.length}<p>No offered extension fits a currently running, unexpired member grant under the server policy.</p>{/if}
    {#if view.choices.length}
      <div class="extend"><strong>Extend:</strong>{#each view.choices as choice}<button type="button" disabled={busy || stale} onclick={() => onExtend(choice.minutes)}>+{hostedDurationLabel(choice.minutes)} ({choice.count}/{runtime.members.length})</button>{/each}</div>
      <p class="muted">Counts show eligible members. Failed/unavailable or capped members are not extended; results are reported individually.</p>
    {/if}
    <details open={runtime.recoveryRequired}><summary>Member grants / recovery</summary><ul>
      {#each runtime.members as member}<li><strong>{member.characterName} · {member.role}</strong>: {operationMemberRecovery(member, !!runtime.recoveryRequired, runtime.observedAt)}
        {#if member.hosted}<br />Started {operationTime(member.hostStartedAt)} · Expires {operationTime(member.expiresAt)}{#if member.hostResumedAt} · Recovered {operationTime(member.hostResumedAt)}{/if}{/if}
        {#if member.lastHostReason}<br />{member.lastHostReason}{/if}
      </li>{/each}
    </ul></details>
  </section>
{/if}

<style>
  p { margin: .35rem 0; } .muted { color: #93a9b5; font-size: .9em; }
  .notice { border-left: 3px solid #d4a84d; padding: .3rem .6rem; margin: .5rem 0; }
  .extend { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin-top: .5rem; }
  button { border: 1px solid #395362; border-radius: 4px; background: #101b22; color: inherit; padding: .35rem .55rem; cursor: pointer; }
  button:disabled { opacity: .5; cursor: not-allowed; } li { margin: .3rem 0; }
</style>
