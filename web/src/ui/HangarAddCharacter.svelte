<script lang="ts">
  // "+ Add character" on an empty slot — filling a free character slot on an
  // account the hangar already lists.
  //
  // The design has this slot open the login modal, because in the prototype
  // adding a character and adding an account were the same act. In this codebase
  // they are not: the account is already signed into and already on screen, so a
  // login here would be a no-op, while the thing the slot is actually offering —
  // put a pilot in this empty slot — is CharacterCreate, which needs a signed-in
  // flow to run its name validation and its create against.
  //
  // So this signs into that account on a THROWAWAY session (the same pattern as
  // app/rosterRefresh.ts and Onboarding's stop-a-bot button: any password, no
  // character ever selected), hosts the existing create screen on it, and signs
  // out again. Creating a character does not bring it online — the new pilot
  // appears in its account's group, and flying it is the next, separate click.
  import CharacterCreate from "./CharacterCreate.svelte";
  import { createSession, type Session } from "../app/sessions.ts";
  import { refreshAccount } from "../app/rosterRefresh.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let {
    accountName,
    onClose,
    onCreated,
  }: {
    accountName: string;
    onClose: () => void;
    /** A pilot was created; the roster has been re-read. */
    onCreated: () => void;
  } = $props();

  let session = $state<Session | null>(null);
  let error = $state("");

  $effect(() => {
    const pending = createSession();
    let live = true;
    void (async () => {
      try {
        await pending.flow.login(accountName, "");
        if (live) session = pending;
      } catch (cause) {
        if (live) {
          error =
            cause instanceof BridgeCallError
              ? cause.code === "UNKNOWN_EVEJS_ACCOUNT"
                ? `Account "${accountName}" no longer exists.`
                : panelErrorWords(cause)
              : String(cause);
        }
      }
    })();
    return () => {
      live = false;
      session = null;
      void pending.flow.logout().catch(() => {});
    };
  });

  async function created(): Promise<void> {
    // Re-read through the same path the hangar refreshes with, so the new pilot
    // arrives with its location and training filled in rather than half a row.
    await refreshAccount(accountName);
    onCreated();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="hangar-overlay" onclick={onClose}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="hangar-create"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label={`Add a character to ${accountName}`}
    onclick={(event) => event.stopPropagation()}
  >
    {#if session}
      <CharacterCreate flow={session.flow} onCancel={onClose} onCreated={created} />
    {:else if error}
      <div class="hangar-dialog is-narrow hangar-chrome">
        <div class="hangar-dialog-head">
          <span class="hangar-dialog-title">Add character</span>
          <button type="button" class="hangar-dialog-close" aria-label="Close" onclick={onClose}>
            ✕
          </button>
        </div>
        <div class="hangar-dialog-body">
          <p class="hangar-dialog-error" role="alert">{error}</p>
        </div>
      </div>
    {:else}
      <div class="hangar-dialog is-narrow hangar-chrome">
        <div class="hangar-dialog-head">
          <span class="hangar-dialog-title">Add character</span>
        </div>
        <div class="hangar-dialog-body">
          <p class="hangar-dialog-note">Opening {accountName}…</p>
        </div>
      </div>
    {/if}
  </div>
</div>
