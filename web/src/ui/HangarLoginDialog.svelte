<script lang="ts">
  // The Pilot Hangar's login. Reached from "+ Add account", from an empty
  // character slot, and automatically on first load when the roster is empty.
  //
  // It does NOT bring anybody online. It signs in on a throwaway token, records
  // the account's pilots in the roster and signs out again (app/rosterRefresh.ts)
  // — so adding an account fills a group on the hangar rather than dropping the
  // player into a cockpit they did not ask for. Selecting a pilot is the next,
  // separate decision, and it is one click away on the row that just appeared.
  import { addAccount } from "../app/rosterRefresh.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { onClose, onAdded }: { onClose: () => void; onAdded: (accountName: string) => void } =
    $props();

  let account = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = account.trim();
    if (busy || !name) return;
    busy = true;
    error = "";
    try {
      await addAccount(name, password);
      onAdded(name);
    } catch (cause) {
      error =
        cause instanceof BridgeCallError
          ? cause.code === "UNKNOWN_EVEJS_ACCOUNT"
            ? "Unknown EveJS account."
            : panelErrorWords(cause)
          : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="hangar-overlay hangar-chrome" onclick={onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="hangar-dialog is-narrow"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Log in"
    onclick={(event) => event.stopPropagation()}
  >
    <div class="hangar-dialog-head">
      <span class="hangar-dialog-title">Log in</span>
      <button type="button" class="hangar-dialog-close" aria-label="Close" onclick={onClose}>✕</button>
    </div>
    <div class="hangar-dialog-body">
      <!-- R2: the login is also account creation — an unknown name is minted
           server-side, so say so here rather than surprising the player. -->
      <p class="hangar-dialog-note">
        Sign in with your EveJS account name — any password works. A new name
        creates a new account, and its pilots get their own group here.
      </p>
      <form onsubmit={submit}>
        <label class="hangar-field-label" for="hangar-login-account">Account</label>
        <input
          id="hangar-login-account"
          class="hangar-input"
          type="text"
          autocomplete="username"
          placeholder="EveJS account"
          bind:value={account}
          disabled={busy}
        />
        <label class="hangar-field-label" for="hangar-login-password">Password</label>
        <input
          id="hangar-login-password"
          class="hangar-input"
          type="password"
          autocomplete="current-password"
          placeholder="anything"
          bind:value={password}
          disabled={busy}
        />
        <div class="hangar-dialog-actions is-inline">
          <button
            type="submit"
            class="hangar-dialog-primary is-wide"
            disabled={busy || account.trim().length === 0}
          >
            {busy ? "Signing in…" : "Log in"}
          </button>
        </div>
      </form>
      {#if error}
        <p class="hangar-dialog-error" role="alert">{error}</p>
      {/if}
    </div>
  </div>
</div>
