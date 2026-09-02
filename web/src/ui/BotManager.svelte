<script lang="ts">
  // BOT MANAGER — regions A and B (docs/bot-manager-brainstorm.md §4).
  //
  // Region C (recent runs) is a separate slice and is NOT built here — see the
  // brainstorm doc's M3 slice split.
  //
  // Region A (pilots, top): one row per held session in THIS browser tab, plus
  // one row per character with a live server bot and no held session here
  // (§4's "multibox wrinkle", option (a) — the roster is threaded in from
  // App.svelte as `sessions`, an optional prop so every existing caller and
  // the no-props SSR test keep working). All run-state logic — which mode a
  // pilot is in, its status words, its detail line — lives in
  // `bots/pilotRoster.ts`; this panel only fetches the server roster and hands
  // each pilot's inputs to `BotManagerPilotRow.svelte`.
  //
  // Region B (library, below): every saved bot, from every account, in one
  // list (Decision 1). "Saved by" names who wrote it for display only — it
  // confers no rights (Decision 5): any account here can load, edit or delete
  // any row.
  //
  // Both regions follow ServerBots.svelte's shape: poll-free (each list only
  // changes on an action taken here or elsewhere in the app), onMount load,
  // and error/empty/loading kept as three distinguishable states rather than
  // collapsed into one "nothing to show".
  import { onMount } from "svelte";
  import {
    listBotScripts,
    getBotScript,
    deleteBotScript,
    listServerBots,
    type BotScriptSummary,
    type ServerBot,
  } from "../app/api.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { Session } from "../app/sessions.ts";
  import type { TabID } from "./tabs.ts";
  import { lastSavedPhrase, libraryView, savedByLabel } from "../bots/libraryView.ts";
  import { serverBotFor, serverOnlyBots } from "../bots/pilotRoster.ts";
  import BotManagerPilotRow from "./BotManagerPilotRow.svelte";

  let {
    store: _store,
    flow,
    onOpen,
    sessions,
  }: {
    store: ClientStore;
    flow: AppFlow;
    onOpen?: (tab: TabID) => void;
    sessions?: readonly Session[];
  } = $props();

  /** Direct api.ts calls must ride THIS pilot's full flow options. */
  const botOpts = () => flow.requestOptions();

  // --- region A: pilots -------------------------------------------------
  // Three honest states, same as region B below: loading, empty ("no pilots
  // online"), and a read error — a failed read of the server roster must
  // never collapse into "nothing running" (a player could act on that lie).
  let pilotsLoaded = $state(false);
  let pilotsError = $state<string | null>(null);
  let serverBots = $state<ServerBot[]>([]);

  async function refreshPilots(): Promise<void> {
    try {
      serverBots = await listServerBots(botOpts());
      pilotsError = null;
    } catch {
      pilotsError = "Could not load the server's bot roster — are you still logged in?";
    } finally {
      pilotsLoaded = true;
    }
  }

  const heldSessions = $derived(sessions ?? []);
  // Characters a held session already covers, so a server-only row is never
  // shown twice for a pilot whose tab happens to be open right here.
  const heldCharacterIDs = $derived(
    heldSessions
      .map((session) => session.store.station.get().online?.characterID ?? null)
      .filter((id): id is number => id !== null),
  );
  const extraServerBots = $derived(serverOnlyBots(serverBots, heldCharacterIDs));

  let loaded = $state(false);
  let error = $state<string | null>(null);
  let scripts = $state<BotScriptSummary[]>([]);
  let query = $state("");

  /** Which row's buttons are disabled while a call for it is in flight. */
  let busyID = $state<string | null>(null);

  /** The row whose Export box is open, and the JSON text inside it. */
  let exportID = $state<string | null>(null);
  let exportText = $state("");
  let exportError = $state<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      scripts = await listBotScripts(botOpts());
      error = null;
    } catch {
      // Keep whatever was last known on screen; say the read is failing —
      // never let a failed read collapse into "no bots saved" (see below).
      error = "Could not load the bot library — are you still logged in?";
    } finally {
      loaded = true;
    }
  }

  onMount(() => {
    void refresh();
    void refreshPilots();
  });

  // Which of the honest states we are in, decided by the pure module so the
  // "a failed read is never 'no bots saved'" rule is stated and tested once.
  const view = $derived(libraryView(loaded, error, scripts, query));
  const filtered = $derived(view.kind === "rows" ? view.rows : []);

  function edit(_scriptID: string): void {
    onOpen?.("botBuilder");
  }

  async function toggleExport(scriptID: string): Promise<void> {
    if (exportID === scriptID) {
      exportID = null;
      exportText = "";
      exportError = null;
      return;
    }
    if (busyID !== null) {
      return;
    }
    busyID = scriptID;
    exportID = scriptID;
    exportText = "";
    exportError = null;
    try {
      const record = await getBotScript(scriptID, botOpts());
      if (record === null) {
        exportError = "That bot could not be found — it may have just been deleted.";
      } else {
        exportText = JSON.stringify(record.doc, null, 2);
      }
    } catch {
      exportError = "Could not load that bot to export it.";
    } finally {
      busyID = null;
    }
  }

  async function remove(script: BotScriptSummary): Promise<void> {
    if (busyID !== null) {
      return;
    }
    // The library is shared (Decision 5) — say so in the confirm, not just
    // "delete this bot", since the row deleted may not be the caller's own.
    const ok = window.confirm(
      `Delete “${script.name}” from the shared bot library? Anyone who saved, edited or ran it will lose it. This cannot be undone.`,
    );
    if (!ok) {
      return;
    }
    busyID = script.scriptID;
    try {
      await deleteBotScript(script.scriptID, botOpts());
      if (exportID === script.scriptID) {
        exportID = null;
        exportText = "";
        exportError = null;
      }
      error = null;
    } catch {
      error = "Could not delete that bot — it may have already been removed.";
    } finally {
      busyID = null;
    }
    await refresh();
  }

</script>

<section class="panel">
  <header class="panel-head">
    <h2>Pilots</h2>
  </header>
  <p class="note">
    Every pilot you have open in this browser tab, plus every character with a
    bot still running on the server even if it has no tab open here. A bot
    running in a tab stops when that tab closes; a bot running on the server
    keeps flying.
  </p>

  {#if pilotsError}
    <p class="note error">{pilotsError}</p>
  {:else if !pilotsLoaded}
    <p class="note">Loading pilots…</p>
  {:else if heldSessions.length === 0 && extraServerBots.length === 0}
    <p class="empty">No pilots online.</p>
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Pilot</th>
            <th>Where</th>
            <th>Running</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each heldSessions as session (session.id)}
            {@const characterID = session.store.station.get().online?.characterID ?? null}
            <BotManagerPilotRow
              {session}
              serverBot={characterID === null ? null : serverBotFor(serverBots, characterID)}
              {scripts}
              onChanged={refreshPilots}
            />
          {/each}
          {#each extraServerBots as bot (bot.botID)}
            <BotManagerPilotRow serverBot={bot} {scripts} onChanged={refreshPilots} />
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<section class="panel">
  <header class="panel-head">
    <h2>Bot manager</h2>
  </header>
  <p class="note">
    Every bot saved on this server, by any account. Loading, editing or
    deleting a bot here affects everyone who uses it — the library is shared,
    not private to whoever saved it.
  </p>

  <div class="controls">
    <label>
      Search
      <input
        type="search"
        placeholder="Search by name or who saved it"
        bind:value={query}
      />
    </label>
  </div>

  <!-- One switch over the pure view, so "a failed read is never 'no bots
       saved'" is decided in libraryView.ts and merely rendered here. -->
  {#if view.kind === "error"}
    <p class="note error">{view.message}</p>
  {:else if view.kind === "loading"}
    <p class="note">Loading the bot library…</p>
  {:else if view.kind === "empty"}
    <p class="empty">No bots saved yet. Build one in the Bot Builder, then save it here.</p>
  {:else if view.kind === "no-matches"}
    <p class="empty">No saved bots match “{query}”.</p>
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Name</th>
            <th>Saved by</th>
            <th class="num">Revision</th>
            <th>Last saved</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as script (script.scriptID)}
            <tr>
              <td data-label="Name">{script.name}</td>
              <td data-label="Saved by">{savedByLabel(script)}</td>
              <td class="num" data-label="Revision">{script.rev}</td>
              <td data-label="Last saved">{lastSavedPhrase(script.updatedAt, Date.now())}</td>
              <td data-label="Actions">
                <span class="row-actions">
                  <button
                    type="button"
                    class="primary"
                    disabled={busyID !== null}
                    onclick={() => edit(script.scriptID)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busyID !== null && busyID !== script.scriptID}
                    onclick={() => toggleExport(script.scriptID)}
                  >
                    {exportID === script.scriptID
                      ? "Hide export"
                      : busyID === script.scriptID
                        ? "Loading…"
                        : "Export"}
                  </button>
                  <button
                    type="button"
                    class="danger"
                    disabled={busyID !== null}
                    onclick={() => remove(script)}
                  >
                    {busyID === script.scriptID ? "Deleting…" : "Delete"}
                  </button>
                </span>
              </td>
            </tr>
            {#if exportID === script.scriptID}
              <tr>
                <td data-label="Export" colspan="5">
                  {#if exportError}
                    <p class="note error">{exportError}</p>
                  {:else}
                    <label>
                      Copy this bot's saved contents
                      <textarea readonly rows="10" value={exportText}></textarea>
                    </label>
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
