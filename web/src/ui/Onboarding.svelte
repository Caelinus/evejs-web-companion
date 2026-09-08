<script lang="ts">
  // R107 — one session's login → character-select flow, bound to that session's
  // own store+flow. Used twice: full-screen for the first pilot at boot, and
  // inside an overlay for "Add character" (App supplies the framing). The moment
  // the character comes online it hands the now-live session back to App via
  // `onOnline`, which adds it to the bar and makes it active.
  //
  // To make adding pilots quick it remembers every character list a sign-in
  // returns (knownCharacters.ts) and offers those pilots as one-click quick-adds
  // above the login form.
  import LoginForm from "./LoginForm.svelte";
  import CharacterSelect from "./CharacterSelect.svelte";
  import CharacterCreate from "./CharacterCreate.svelte";
  import KnownCharacterPicker from "./KnownCharacterPicker.svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { listActiveServerBots, type ActiveServerBot } from "../app/api.ts";
  import { stopServerBotFor } from "../app/stopBotFor.ts";
  import {
    loadKnownCharacters,
    rememberCharacters,
    forgetKnownCharacter,
    type KnownCharacter,
  } from "../app/knownCharacters.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow, onOnline, onlineIDs = new Set<number>() }: {
    store: ClientStore;
    flow: AppFlow;
    onOnline: () => void;
    /** Character IDs already online in this tab — quick-adds for them are disabled. */
    onlineIDs?: Set<number>;
  } = $props();

  // Stable store identity for this component's lifetime.
  // svelte-ignore state_referenced_locally
  const session = store.session;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const character = store.character;

  // Fire once, when select brings the character online. App unmounts this
  // component in response, so the guard is belt-and-suspenders.
  let handedOff = false;
  $effect(() => {
    if (!handedOff && $station.online !== null) {
      handedOff = true;
      onOnline();
    }
  });

  // Remember every character list a sign-in returns, so the picker can offer
  // these pilots next time. Upsert is idempotent, so re-recording is free.
  $effect(() => {
    const username = $session.username;
    const characters = $character.characters;
    if (username && characters.length > 0) {
      rememberCharacters(username, characters);
    }
  });

  // Whether this session is on the create-character screen instead of the
  // character list. Signed-in-but-not-online is the only state it can be
  // reached from — creation happens before selection, and the moment a pilot
  // comes online App unmounts this whole component.
  let creating = $state(false);

  // The roster shown before login (a snapshot at mount; reloaded after a forget).
  let known = $state<KnownCharacter[]>(loadKnownCharacters());
  let busyID = $state<number | null>(null);
  let error = $state("");

  // One click = sign in to the pilot's account (any password) + select it. A
  // failed login keeps us on the picker with the reason; a login that succeeds
  // but whose select is refused falls through to the normal character list.
  async function quickAdd(pick: KnownCharacter): Promise<void> {
    if (busyID !== null) return;
    busyID = pick.characterID;
    error = "";
    try {
      await flow.login(pick.accountName, "");
      await flow.selectCharacter(pick.characterID);
    } catch (cause) {
      error =
        cause instanceof BridgeCallError
          ? cause.code === "UNKNOWN_EVEJS_ACCOUNT"
            ? `Account "${pick.accountName}" no longer exists.`
            : cause.code === "CALL_REFUSED"
              ? cause.message
              : panelErrorWords(cause)
          : String(cause);
    } finally {
      busyID = null;
    }
  }

  function forget(characterID: number): void {
    forgetKnownCharacter(characterID);
    known = loadKnownCharacters();
  }

  // Which pilots a SERVER BOT is flying right now — and how each ship is
  // doing — so the picker and the character list can mark them before a click
  // gets refused. Unauthenticated read (this screen exists before any
  // sign-in); a failed poll keeps the last known rows rather than blinking
  // the markers off. The poll is 5s for a snappy badge; the vitals inside
  // only move at the host's own ~15s sample cadence.
  let botStatuses = $state<Map<number, ActiveServerBot>>(new Map());
  const botFlownIDs = $derived(new Set(botStatuses.keys()));
  let botPollAlive = true;
  async function refreshBotFlown(): Promise<void> {
    try {
      const rows = await listActiveServerBots({ priority: "poll" });
      if (botPollAlive) botStatuses = new Map(rows.map((row) => [row.characterID, row]));
    } catch {
      // Keep the last known rows; the next poll retries.
    }
  }
  $effect(() => {
    // Guarded: five seconds is quick enough that a slow server would otherwise
    // stack these up and starve the pool. See app/skipWhileBusy.ts.
    const beat = skipWhileBusy(refreshBotFlown);
    void beat();
    const handle = setInterval(() => void beat(), 5000);
    return () => {
      botPollAlive = false;
      clearInterval(handle);
    };
  });

  // Stop a server bot FROM THE LANDING PAGE. Without this, a roster where
  // every pilot is bot-flown locks the player out of their own bots (nothing
  // clickable leads to a Stop). The sign-in/stop/sign-out itself lives in
  // app/stopBotFor.ts, shared with the Pilot Hangar, which needs the same
  // button for the same reason.
  let stoppingID = $state<number | null>(null);
  async function stopBotFor(pick: KnownCharacter): Promise<void> {
    if (stoppingID !== null) return;
    stoppingID = pick.characterID;
    error = "";
    try {
      await stopServerBotFor(pick.accountName, pick.characterID);
      await refreshBotFlown();
    } catch (cause) {
      error =
        cause instanceof BridgeCallError
          ? cause.code === "UNKNOWN_EVEJS_ACCOUNT"
            ? `Account "${pick.accountName}" no longer exists.`
            : panelErrorWords(cause)
          : String(cause);
    } finally {
      stoppingID = null;
    }
  }
</script>

{#if $session.phase !== "logged-in"}
  <!-- One centred column: pilots first, the login card directly beneath (the
       login screen's own full-height centring is neutralised inside). -->
  <div class="onboarding-screen">
    <KnownCharacterPicker
      {known}
      {onlineIDs}
      {busyID}
      {botFlownIDs}
      {botStatuses}
      {stoppingID}
      onPick={quickAdd}
      onForget={forget}
      onStopBot={stopBotFor}
    />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <LoginForm {store} {flow} />
  </div>
{:else if $station.online === null}
  {#if creating}
    <!-- flow.createCharacter has already re-read the roster by the time this
         fires, so returning to the list shows the new pilot. Selecting is left
         to the player: bringing a character online is its own decision. -->
    <CharacterCreate
      {flow}
      onCancel={() => (creating = false)}
      onCreated={() => (creating = false)}
    />
  {:else}
    <CharacterSelect {store} {flow} {botFlownIDs} onCreate={() => (creating = true)} />
  {/if}
{/if}
