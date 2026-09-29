<script lang="ts">
  import { onMount } from "svelte";
  import { continueNewTrainee, readPendingTrainee } from "../training/newTrainee.ts";
  import { factoryError } from "../training/factory.ts";
  let { onContinue, onCancel, onBusy, externalBusy = false }: {
    onContinue: (result: Awaited<ReturnType<typeof continueNewTrainee>>) => void;
    onCancel: () => void; onBusy: (value: boolean) => void; externalBusy?: boolean;
  } = $props();
  let username = $state(""), password = $state(""), confirmation = $state(""), characterName = $state("");
  let sameName = $state(true), busy = $state(false), recovery = $state(false), error = $state(""), recoveryUnreadable = $state(false);
  const proposedName = $derived(sameName ? username : characterName);
  const locked = $derived(busy || externalBusy);
  onMount(() => {
    try { const pending = readPendingTrainee(sessionStorage); if (pending) {
      username = pending.username; characterName = pending.characterName; sameName = false; recovery = true;
    } } catch (cause) { recoveryUnreadable = true; error = String(cause); }
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (locked || recoveryUnreadable) return;
    busy = true; onBusy(true); error = "";
    try {
      const result = await continueNewTrainee({ username, password, confirmation, characterName: proposedName }, sessionStorage);
      password = ""; confirmation = ""; onContinue(result);
    } catch (cause) {
      error = factoryError(cause);
      try { recovery = !!readPendingTrainee(sessionStorage); } catch { recoveryUnreadable = true; }
    } finally { password = ""; confirmation = ""; busy = false; onBusy(false); }
  }
</script>
<section class="new-trainee"><h2>Create trainee</h2>
  <p>First create the EveJS account, then continue to the existing character creator. No character is created by this form.</p>
  <form onsubmit={submit}>
    <label>Account name <input bind:value={username} required maxlength="64" autocomplete="off" disabled={locked || recovery} /></label>
    <label>Password <input type="password" bind:value={password} required autocomplete="new-password" disabled={locked} /></label>
    <label>Confirm password <input type="password" bind:value={confirmation} required autocomplete="new-password" disabled={locked} /></label>
    <label class="check"><input type="checkbox" bind:checked={sameName} disabled={locked || recovery} /> Use account name as initial character name</label>
    <label>Character name <input value={proposedName} oninput={(event) => characterName = event.currentTarget.value} required disabled={locked || sameName || recovery} /></label>
    <p>Current EveJS account creation uses its development account policy and does not store a login password. Normal WC authentication is reused. These password fields are cleared after every attempt and are never saved in Pilot Training preferences.</p>
    {#if recovery}<p role="status">A previous creation needs confirmation. This action only checks its result and authenticates; it will not create again.</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <button disabled={locked || recoveryUnreadable || !username.trim() || !password || password !== confirmation || !proposedName.trim()}>{busy ? "Checking account…" : recovery ? "Check creation status and continue" : "Create account and continue"}</button>
    <button type="button" class="minor" disabled={locked} onclick={() => { password = ""; confirmation = ""; onCancel(); }}>Cancel</button>
  </form>
</section>
<style>.new-trainee { border:1px solid #455569; padding:1rem; margin:1rem 0; max-width:48rem; } form { display:grid; gap:.8rem; } label { display:grid; gap:.3rem; } input { background:#16202e; color:#e4edf7; padding:.5rem; border:1px solid #455569; } .check { display:flex; gap:.5rem; } p { margin:.3rem 0; } [role="alert"] { color:#fda4af; }</style>
