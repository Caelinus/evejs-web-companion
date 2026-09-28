<script lang="ts">
  // Chat panel (goal R7): Local + Corp sub-channels, each with a member roster,
  // a message list, and a send box. A pure reader of the store's chat slice; all
  // read/send logic runs on the BFF (which holds the bridgeSessionID) and in
  // app/flow.ts. Chat delivery bypasses the notification drain, so READ is a
  // backlog poll: the panel polls the active channel on a modest interval while
  // it is open and stops when it closes (onDestroy). The browser never sees a
  // bridge session.
  import { onDestroy, onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { createChatPoller } from "../app/chatPoll.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ChatChannel } from "../store/types.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const chat = store.chat;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const live = store.live;

  // R7d — resolve each channel's identity to a NAME: Local → its solar system,
  // Corp → the corporation. Batched + cached by the flow; the raw room string
  // (local_<systemID> / corp_<corpID>) is never rendered.
  $effect(() => {
    const refs: NameRef[] = [];
    if ($chat.local.solarSystemID) {
      refs.push({ kind: "system", id: $chat.local.solarSystemID });
    }
    if ($chat.corp.corporationID) {
      refs.push({ kind: "corporation", id: $chat.corp.corporationID });
    }
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });

  // R10 — messages now arrive live over the push channel, so the backlog poll
  // drops to a slow safety net while the channel is delivering and snaps back
  // to the old fast cadence whenever it is not. The poll still covers roster
  // changes (which the channel does not carry) and keeps the held session warm.
  // ⚠ GUARDED. `createChatPoller` arms a plain interval, so without this a slow
  // chat read stacks up beat on beat and the requests it displaces from the
  // browser's connection pool are the ones that visibly fail. See
  // app/skipWhileBusy.ts.
  const chatBeat = skipWhileBusy(refresh);
  const poller = createChatPoller({
    status: () => store.get().live.status,
    refresh: () => void chatBeat(),
  });
  let busy = $state(false);
  let error = $state("");
  let draft = $state("");

  const CHANNELS: readonly { id: ChatChannel; label: string }[] = [
    { id: "local", label: "Local" },
    { id: "corp", label: "Corp" },
  ];

  function currentChannel(): ChatChannel {
    return store.get().chat.activeChannel;
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error =
          panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  async function refresh(): Promise<void> {
    await run(() => flow.loadChat(currentChannel()));
  }

  async function switchChannel(channel: ChatChannel): Promise<void> {
    if (channel === currentChannel()) {
      return;
    }
    flow.setChatChannel(channel);
    await refresh();
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text) {
      return;
    }
    const channel = currentChannel();
    await run(async () => {
      await flow.sendChatMessage(channel, text);
      draft = "";
    });
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void send();
  }

  onMount(() => {
    void refresh();
    poller.start();
  });

  // Re-arm the poll cadence when the live channel connects or drops.
  $effect(() => {
    void $live.status;
    poller.sync();
  });

  onDestroy(() => {
    // Closing the tab stops polling.
    poller.stop();
  });

  // The active channel's decoded state (roster + backlog).
  const active = $derived($chat[$chat.activeChannel]);

  // The active channel's resolved name (Local → system, Corp → corporation), or
  // "" while it resolves — the header then shows just "Local" / "Corp", never the
  // raw room string.
  const channelName = $derived(
    $chat.activeChannel === "corp"
      ? resolvedName($names.resolved, "corporation", active.corporationID, "")
      : resolvedName($names.resolved, "system", active.solarSystemID, ""),
  );
</script>

<section class="panel">
  <header class="panel-head">
    <h2>Chat</h2>
  </header>
  <nav class="tabs">
    {#each CHANNELS as channel (channel.id)}
      <button
        type="button"
        class:active={$chat.activeChannel === channel.id}
        disabled={busy}
        onclick={() => switchChannel(channel.id)}
      >
        {channel.label}
      </button>
    {/each}
    <button type="button" disabled={busy} onclick={() => refresh()}>Refresh</button>
  </nav>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $chat.error}
    <p class="error">{$chat.error}</p>
  {/if}
</section>

<section>
  <h2>
    {$chat.activeChannel === "corp" ? "Corp" : "Local"}
    {#if channelName}<span class="note">· {channelName}</span>{/if}
  </h2>
  {#if !active.loaded}
    <p class="note">Loading…</p>
  {:else if $chat.activeChannel === "corp" && active.corporationID === null}
    <p class="note">This character is not in a corporation.</p>
  {:else}
    <div class="chat-grid">
      <div class="messages">
        <h3>Messages</h3>
        {#if active.messages.length === 0}
          <p class="empty">No recent messages.</p>
        {:else}
          <ul class="message-list">
            {#each active.messages as message, index (index)}
              <li>
                <span class="author">{message.characterName}</span>:
                <span class="body">{message.message}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
      <div class="roster">
        <h3>Members ({active.roster.length})</h3>
        {#if active.roster.length === 0}
          <p class="empty">No members visible.</p>
        {:else}
          <ul class="roster-list">
            {#each active.roster as member (member.characterID)}
              <li>{member.name}</li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>

    <form class="send-box" onsubmit={onSubmit}>
      <input
        type="text"
        bind:value={draft}
        maxlength="4096"
        placeholder={`Message ${$chat.activeChannel === "corp" ? "Corp" : "Local"}…`}
        disabled={busy}
      />
      <button type="submit" disabled={busy || draft.trim().length === 0}>Send</button>
    </form>
  {/if}
</section>

<style>
  .chat-grid {
    display: grid;
    grid-template-columns: 1fr minmax(140px, 220px);
    gap: 1rem;
    align-items: start;
  }
  .message-list,
  .roster-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 20rem;
    overflow-y: auto;
  }
  .message-list li {
    padding: 0.15rem 0;
  }
  .message-list .author {
    font-weight: 600;
  }
  .roster-list li {
    padding: 0.1rem 0;
  }
  .send-box {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .send-box input {
    flex: 1;
  }
  @media (max-width: 640px) {
    .chat-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
