<script lang="ts">
  import { onMount } from "svelte";
  import { login, loadMiningOperations } from "../app/api.ts";
  import { getSessionToken } from "../app/sessionToken.ts";
  import MiningOperations from "./MiningOperations.svelte";

  let ready = $state(false);
  let authenticated = $state(false);
  let accountName = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);
  let sessionExpired = $state(false);
  let reconnectVersion = $state(0);

  onMount(() => {
    const token = getSessionToken();
    if (!token) { ready = true; return; }
    void loadMiningOperations({ token }).then(() => {
      authenticated = true;
    }).catch(() => {
      error = "Sign in to supervise Mining Operations.";
    }).finally(() => { ready = true; });
  });

  async function signIn(): Promise<void> {
    busy = true;
    error = null;
    try {
      // Existing web account login only; selecting a pilot workspace is not
      // involved. Each bot later gets its own server-side account session.
      await login(accountName.trim(), "");
      authenticated = true;
      sessionExpired = false;
      reconnectVersion++;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Sign-in failed.";
    } finally { busy = false; }
  }
</script>

<svelte:head><title>Mining Command Center · EveJS Web Companion</title></svelte:head>
<div class="command-shell">
  <header class="command-header">
    <div><h1>Mining Command Center</h1><p>Server-hosted industrial fleets · shared target authority</p></div>
    <a href="/">Pilot workspace</a>
  </header>
  {#if !ready}
    <p>Connecting to the control plane…</p>
  {/if}
  {#if ready && (!authenticated || sessionExpired)}
    <form class="sign-in" onsubmit={(event) => { event.preventDefault(); void signIn(); }}>
      <h2>{sessionExpired ? "Control plane disconnected — sign in to reconnect" : "Sign in"}</h2>
      <p>Use an existing EveJS account. No pilot workspace will be opened.</p>
      {#if sessionExpired}<p>Hosted operations are unaffected. The fleet display below is last known state, not a Stop result.</p>{/if}
      <label>Account name <input required bind:value={accountName} autocomplete="username" /></label>
      <button type="submit" disabled={busy}>Open Command Center</button>
      {#if error}<p role="alert">{error}</p>{/if}
    </form>
  {/if}
  {#if ready && authenticated}
    <MiningOperations {reconnectVersion} onAuthExpired={() => { sessionExpired = true; }} />
  {/if}
</div>

<style>
  .command-shell { min-height: 100vh; background: #091319; color: #dce8ef; font: 15px system-ui, sans-serif; }
  .command-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.5rem; border-bottom: 1px solid #304754; }
  h1, p { margin: .2rem 0; }
  .command-header p { color: #93a9b5; }
  a { color: #8fd9ff; }
  .sign-in { max-width: 25rem; margin: 3rem auto; border: 1px solid #304754; padding: 1.5rem; background: #0d171d; }
  .sign-in label { display: grid; gap: .5rem; margin: 1rem 0; }
  .sign-in input, .sign-in button { padding: .55rem; background: #101b22; color: inherit; border: 1px solid #395362; }
  [role="alert"] { color: #ff9e9e; }
</style>
