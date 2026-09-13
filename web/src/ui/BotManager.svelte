<script lang="ts">
  // BOT MANAGER — regions A, B and C (docs/bot-manager-brainstorm.md §4).
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
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
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
  import { requestBuilderEdit } from "../bots/builderHandoff.ts";
  import {
    serverBotFor,
    serverOnlyBots,
    mergeServerRosters,
    type RosterRead,
    endedRuns,
    runOutcomePhrase,
    lastAlertPhrase,
    RECENT_RUNS_ARE_NOT_DURABLE,
  } from "../bots/pilotRoster.ts";
  import BotManagerPilotRow from "./BotManagerPilotRow.svelte";
  import ActionButton from "./ActionButton.svelte";

  let {
    store: _store,
    flow,
    onOpen,
    sessions,
  }: {
    store: ClientStore;
    flow: AppFlow;
    onOpen?: (tab: TabID, sessionID?: string) => void;
    sessions?: readonly Session[];
  } = $props();

  /**
   * How often the server roster is re-read.
   *
   * ⚠ THE SERVER ROSTER IS THE ONE LIST HERE THAT CHANGES BY ITSELF. Every other
   * list in this panel only moves when somebody acts — in this tab or another —
   * so an onMount read is enough for them. A server bot is running on a machine
   * nobody in this browser is driving: it changes phase, raises an alert and hits
   * its runtime cap with no local event to notice. Without this the roster would
   * be frozen at whenever the panel was opened, which is worse than showing
   * nothing — a stale "Running" is a lie a player will act on. 3s matches what
   * the standalone Server Bots panel polled at.
   */
  const SERVER_ROSTER_POLL_MS = 3000;

  /** Direct api.ts calls must ride THIS pilot's full flow options. */
  const botOpts = () => flow.requestOptions();

  // --- region A: pilots -------------------------------------------------
  // Three honest states, same as region B below: loading, empty ("no pilots
  // online"), and a read error — a failed read of the server roster must
  // never collapse into "nothing running" (a player could act on that lie).
  let pilotsLoaded = $state(false);
  let pilotsError = $state<string | null>(null);
  let pilotsWarning = $state<string | null>(null);
  let serverBots = $state<readonly ServerBot[]>([]);
  /** botID -> the pilot flow whose account listed it, and so may stop it. */
  let botOwners = $state<ReadonlyMap<string, AppFlow>>(new Map());

  const heldSessions = $derived(sessions ?? []);

  // The server lists (and stops) bots PER ACCOUNT, and pilots here may be on
  // different accounts — so ask once per pilot, each with its own login, and
  // merge (see mergeServerRosters). With no roster threaded in, the panel's
  // own flow is the only pilot there is.
  async function refreshPilots(): Promise<void> {
    const flows = [...new Set(heldSessions.length > 0 ? heldSessions.map((s) => s.flow) : [flow])];
    try {
      const reads = await Promise.all(
        flows.map(async (source): Promise<RosterRead<AppFlow>> => {
          try {
            return { source, ok: true, bots: await listServerBots(source.requestOptions()) };
          } catch {
            return { source, ok: false };
          }
        }),
      );
      const merged = mergeServerRosters(reads);
      if (merged.failed === reads.length) {
        pilotsError = "Could not load the server's bot roster - are you still logged in?";
        return;
      }
      serverBots = merged.bots;
      botOwners = merged.ownerOf;
      pilotsError = null;
      pilotsWarning =
        merged.failed === 0
          ? null
          : `Could not read the server bots for ${merged.failed} of your pilots, so a bot one of them started may be missing below.`;
    } finally {
      pilotsLoaded = true;
    }
  }
  // Characters a held session already covers, so a server-only row is never
  // shown twice for a pilot whose tab happens to be open right here.
  const heldCharacterIDs = $derived(
    heldSessions
      .map((session) => session.store.station.get().online?.characterID ?? null)
      .filter((id): id is number => id !== null),
  );
  const extraServerBots = $derived(serverOnlyBots(serverBots, heldCharacterIDs));

  // --- region C: recent runs ---------------------------------------------
  // Same fetch as region A (`serverBots`), just the ended slice of it — no
  // second call. 20 matches MAX_ENDED_RUNS in src/botHost.js, the server's
  // own memory bound, so asking for more can never return more.
  const recentRuns = $derived(endedRuns(serverBots, 20));

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
    // Guarded, like every other periodic read — see app/skipWhileBusy.ts. Only
    // the roster repeats; the library is not a self-changing list.
    const beat = skipWhileBusy(refreshPilots);
    void beat();
    const timer = setInterval(() => void beat(), SERVER_ROSTER_POLL_MS);
    return () => clearInterval(timer);
  });

  // Which of the honest states we are in, decided by the pure module so the
  // "a failed read is never 'no bots saved'" rule is stated and tested once.
  const view = $derived(libraryView(loaded, error, scripts, query));
  const filtered = $derived(view.kind === "rows" ? view.rows : []);

  // --- the window strip ---------------------------------------------------
  //
  // Every window names itself once, in its title bar; a panel underneath
  // never repeats it. Region A used to sit right under the title bar with its
  // own `<header class="panel-head"><h2>Pilots</h2></header>`, which is styled
  // exactly like a window strip and, sitting first, READ as one — a band that
  // looked like it was answering for the whole window while it was really
  // just region A's own band, the same idiom Recent runs and Saved bots use
  // below it. This gives the window a strip of its own, in FleetCompanions.svelte's
  // shape, so the band directly under the title bar is honestly the window's.
  //
  // ⚠ TWO INDEPENDENT READS, ONE LINE, GATED ON BOTH. Region A/C's roster
  // (`serverBots`, fetched by `refreshPilots`) and region B's library
  // (`scripts`, fetched by `refresh`) are two unrelated calls, each still able
  // to be in flight or failed on its own schedule. Printing whatever answered
  // first would make the strip flicker between an honest partial and a
  // wrong-looking whole on every render, so it says nothing until BOTH have
  // settled — `pilotsLoaded` is set true in `refreshPilots`'s `finally`
  // regardless of outcome, and `view.kind === "loading"` is `libraryView`'s
  // own word for "the fetch has not answered yet" (see its doc). Nothing
  // rendered during loading is the CSS's cue too: a `.panel-head` holding
  // only the clipped `.panel-title` collapses its band rather than drawing an
  // empty strip (styles.css, the rule beside `.panel-title` itself).
  //
  // ⚠ A FAILED READ IS NEVER "0". `scripts.length` only appears once `view`
  // says the library actually loaded (`view.kind !== "error"`, `!== "loading"`);
  // `pilotsPart` reads `pilotsError` the same way region A's own rows do. Two
  // more places drawing that line, not a looser copy of it.
  //
  // `scripts.length`, not `filtered.length` — the strip is the LIBRARY's size,
  // and a search query narrowing `filtered` to zero rows must not read here as
  // "no bots saved" (that lie is exactly what the "no-matches" state below
  // exists to tell apart from "empty").
  function pilotsStatWords(online: number, recentCount: number): string {
    const recentWords =
      recentCount === 0 ? "" : `, ${recentCount} recent run${recentCount === 1 ? "" : "s"}`;
    return online === 0 ? `No pilots online${recentWords}` : `${online} pilot${online === 1 ? "" : "s"} online${recentWords}`;
  }

  const summary = $derived.by(() => {
    if (!pilotsLoaded || view.kind === "loading") {
      return null; // neither read has answered — say nothing rather than guess
    }
    const pilotsPart =
      pilotsError !== null
        ? "pilots: could not read"
        : pilotsStatWords(heldSessions.length + extraServerBots.length, recentRuns.length);
    const libraryPart =
      view.kind === "error" ? "bot library: could not read" : `${scripts.length} bot${scripts.length === 1 ? "" : "s"} saved`;
    return `${pilotsPart} · ${libraryPart}`;
  });

  function edit(scriptID: string): void {
    // The tab switch carries no payload, so the script rides this pilot's
    // one-shot mailbox; the Builder loads it on open (or at once, if its
    // window is already up).
    requestBuilderEdit(flow, scriptID);
    onOpen?.("botBuilder");
  }

  /**
   * Open the Bot Builder with nothing selected — "I want a bot that does not
   * exist yet".
   *
   * ⚠ THIS IS THE ONLY WAY TO REACH THE BUILDER WITH AN EMPTY LIBRARY, and that
   * is why it exists. The Builder has no launcher entry of its own any more (it
   * is reached through this panel, which is the one door onto bots); before this
   * button the only route here was the Edit action on a saved row, so a player
   * with no saved bots had no way to write their first one.
   */
  function newBot(): void {
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
    <h2 class="panel-title">Bot Manager</h2>
    {#if summary !== null}
      <p class="stat-line">{summary}</p>
    {/if}
  </header>
</section>

<section class="panel">
  <header class="panel-head">
    <h2>Pilots</h2>
  </header>

  {#if pilotsError}
    <p class="note error">{pilotsError}</p>
  {:else if !pilotsLoaded}
    <p class="note">Loading pilots…</p>
  {:else if heldSessions.length === 0 && extraServerBots.length === 0}
    <p class="empty">No pilots online.</p>
  {:else}
    {#if pilotsWarning}<p class="note error">{pilotsWarning}</p>{/if}
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
            <!-- ⚠ `onSetUpBuiltIn` NAMES THIS ROW'S PILOT, never the active one.
                 The panel it opens reads the MOUNTED pilot's ship, so an
                 unaddressed open would show one pilot's hull under another's
                 name — a requirement checklist about the wrong ship. -->
            <BotManagerPilotRow
              {session}
              serverBot={characterID === null ? null : serverBotFor(serverBots, characterID)}
              {scripts}
              onChanged={refreshPilots}
              onSetUpBuiltIn={() => onOpen?.("bots", session.id)}
            />
          {/each}
          {#each extraServerBots as bot (bot.botID)}
            <BotManagerPilotRow
              serverBot={bot}
              ownerFlow={botOwners.get(bot.botID)}
              {scripts}
              onChanged={refreshPilots}
            />
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<section class="panel">
  <header class="panel-head">
    <h2>Recent runs</h2>
  </header>
  <p class="note">{RECENT_RUNS_ARE_NOT_DURABLE}</p>

  {#if pilotsError}
    <p class="note error">{pilotsError}</p>
  {:else if !pilotsLoaded}
    <p class="note">Loading recent runs…</p>
  {:else if recentRuns.length === 0}
    <p class="empty">Nothing has finished yet.</p>
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Bot</th>
            <th>Pilot</th>
            <th>Outcome</th>
            <th>Last alert</th>
          </tr>
        </thead>
        <tbody>
          {#each recentRuns as bot (bot.botID)}
            <tr>
              <td data-label="Bot">{bot.scriptName}</td>
              <td data-label="Pilot">{bot.characterName ?? "Unknown pilot"}</td>
              <td data-label="Outcome">
                {runOutcomePhrase(bot)}{#if bot.why}<br />{bot.why}{/if}
              </td>
              <td data-label="Last alert">{lastAlertPhrase(bot, Date.now()) ?? "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<section class="panel">
  <header class="panel-head">
    <!-- ⚠ NOT "BOT MANAGER" — that is the WINDOW's name, and this is the third
         block inside it, beside Pilots and Recent runs. A section headed with
         the window's own title reads as the start of the panel rather than as
         one part of it, and leaves the part it actually labels unnamed. What
         this block is, is the library of saved bots. -->
    <h2>Saved bots</h2>
  </header>

  <div class="controls">
    <label>
      Search
      <input
        type="search"
        placeholder="Search by name or who saved it"
        bind:value={query}
      />
    </label>
    <button type="button" class="primary" onclick={newBot}>New bot</button>
  </div>

  <!-- One switch over the pure view, so "a failed read is never 'no bots
       saved'" is decided in libraryView.ts and merely rendered here. -->
  {#if view.kind === "error"}
    <p class="note error">{view.message}</p>
  {:else if view.kind === "loading"}
    <p class="note">Loading the bot library…</p>
  {:else if view.kind === "empty"}
    <!-- ⚠ IT NAMES THE BUTTON, NOT A LAUNCHER ENTRY. This used to read "Build
         one in the Bot Builder", which was a direction to a rail entry that no
         longer exists — the worst kind of empty state, one that sends a player
         somewhere they cannot go. -->
    <p class="empty">No bots saved yet. Choose <strong>New bot</strong> above to write your first one.</p>
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
                  <ActionButton
                    action="edit"
                    primary
                    disabled={busyID !== null}
                    onclick={() => edit(script.scriptID)}
                  />
                  <ActionButton
                    action="export"
                    disabled={busyID !== null && busyID !== script.scriptID}
                    expanded={exportID === script.scriptID}
                    label={exportID === script.scriptID
                      ? "Hide export"
                      : busyID === script.scriptID
                        ? "Loading…"
                        : undefined}
                    onclick={() => toggleExport(script.scriptID)}
                  />
                  <ActionButton
                    action="delete"
                    danger
                    disabled={busyID !== null}
                    label={busyID === script.scriptID ? "Deleting…" : undefined}
                    onclick={() => remove(script)}
                  />
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
