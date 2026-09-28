<script lang="ts">
  // SERVER bots — the remote control for bots the BFF flies (src/botHost.js).
  //
  // The whole point of a server bot is that THIS TAB DOES NOT MATTER: it keeps
  // running when the tab closes or a phone locks. So this component owns no
  // bot state at all — it POLLS the server's list and renders it verbatim, the
  // same words the in-tab readout would use (the host projects the same
  // customBot slice).
  //
  // ⚠ IT IS THE OFFLINE SURFACE ONLY NOW. While a pilot is online the Bot
  // Manager owns this subject — its pilots region shows every server bot beside
  // the tab runs and the pilots that could take one — so this panel lost its
  // launcher entry rather than being duplicated in the rail. It stays mounted on
  // character select, which has no session, no roster and no Bot Manager: a
  // player who just handed their hull to a bot lands there and must still be
  // able to see and stop it. Every word it renders comes from
  // bots/pilotRoster.ts, shared with the Manager, so two readouts of one fact
  // cannot drift apart.
  import { onMount } from "svelte";
  import { listServerBots, stopServerBot, type ServerBot } from "../app/api.ts";
  import {
    lastAlertPhrase,
    resumedNote,
    serverBotProvenance,
    serverRunState,
  } from "../bots/pilotRoster.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";

  const POLL_MS = 3000;

  let bots = $state<ServerBot[]>([]);
  let error = $state<string | null>(null);
  let loaded = $state(false);
  let busyBotID = $state<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      bots = await listServerBots({ priority: "poll" });
      error = null;
    } catch {
      // Keep whatever was last known on screen; say the read is failing.
      error = "Could not reach the server's bot list — are you still logged in?";
    } finally {
      loaded = true;
    }
  }

  async function stop(botID: string): Promise<void> {
    if (busyBotID !== null) {
      return;
    }
    busyBotID = botID;
    try {
      await stopServerBot(botID);
      error = null;
    } catch {
      error = "Could not stop that bot — it may have already ended.";
    } finally {
      busyBotID = null;
    }
    await refresh();
  }

  onMount(() => {
    // Guarded, like every other periodic read — see app/skipWhileBusy.ts.
    const beat = skipWhileBusy(refresh);
    void beat();
    const timer = setInterval(() => void beat(), POLL_MS);
    return () => clearInterval(timer);
  });

  /** A bot the server is still flying (Stop applies). */
  function isActive(bot: ServerBot): boolean {
    return bot.status === "starting" || bot.status === "running" || bot.status === "paused";
  }

</script>

<section>
  <h2>On the server</h2>
  <p class="note">
    These bots run on the server itself — closing this tab does not stop them,
    but each run has a time limit. After a restart, only the exact same script
    can start over, and only when every step is safe to re-check; other runs stop
    and ask you to review them again.
    A character a server bot is flying cannot be selected until the bot stops.
  </p>
  {#if error}<p class="note error">{error}</p>{/if}
  {#if loaded && bots.length === 0}
    <p class="note">No server bots.</p>
  {:else if bots.length > 0}
    <ul class="server-bots">
      {#each bots as bot (bot.botID)}
        <li class="server-bot" class:active={isActive(bot)}>
          <div class="row">
            <span class="name">{bot.scriptName}</span>
            <span class="badge">{serverRunState(bot).statusWords}</span>
          </div>
          <div class="row">
            <span class="detail">
              {bot.characterName ?? `Character ${bot.characterID}`}
              {#if bot.phase}
                · {bot.phase}
              {/if}
            </span>
            {#if isActive(bot)}
              <button
                class="danger"
                disabled={busyBotID !== null}
                onclick={() => stop(bot.botID)}
              >
                {busyBotID === bot.botID ? "Stopping…" : "Stop"}
              </button>
            {/if}
          </div>
          <p class="note why">
            {serverBotProvenance(bot)}
          </p>
          {#if resumedNote(bot)}
            <p class="note why">{resumedNote(bot)}</p>
          {/if}
          {#if bot.lastAlert}
            <!-- A server bot has no browser to notify, so this line IS the alert.
                 Above `why` and marked, because it is the thing worth reading. -->
            <p class="alert">⚠ {lastAlertPhrase(bot, Date.now())}</p>
          {/if}
          {#if bot.why}
            <p class="note why">{bot.why}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .server-bots {
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .server-bot {
    border: 1px solid var(--color-row-line);
    border-radius: 4px;
    background: var(--color-panel-3);
    padding: 0.5rem 0.6rem;
  }
  .server-bot.active {
    border-width: 2px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }
  .name {
    color: var(--color-text-bright);
  }
  .badge {
    font-size: 0.85em;
    border: 1px solid currentColor;
    padding: 0.1rem 0.4rem;
    white-space: nowrap;
  }
  .why {
    margin: 0.3rem 0 0;
  }
  /* The alert is the one line here worth interrupting the eye for — accent, not
     the muted note colour the rest of the card uses. */
  .alert {
    margin: 0.3rem 0 0;
    color: var(--color-accent);
    border-left: 2px solid var(--color-accent);
    padding-left: 0.4rem;
  }
  /* R8 — a comfortable target on a phone. */
  .server-bot button {
    min-height: 40px;
  }
</style>
