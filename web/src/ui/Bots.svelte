<script lang="ts">
  // THE LAUNCHER (goal R43).
  //
  // One place a player goes to say "run something". Until now each bot was
  // reachable only from inside whichever panel it happened to live in — the
  // mining bot embedded in Around Your Ship, the mission bot in its own tab —
  // so there was no answer to "what can I run?" and no answer to "is anything
  // running?" once you had switched panels.
  //
  // ⚠ IT EMBEDS THE REAL COMPONENTS AND FORKS NOTHING. `MiningBot.svelte` and
  // `MissionBot.svelte` are rendered here exactly as they are rendered where
  // they already live: same props, same controls, same readout. A second copy of
  // a readout drifts, and a drifted readout does not go quiet — it keeps
  // rendering, confidently, about a bot that is doing something else. Everything
  // this panel adds is ABOUT the bots (which exist, which is running, what each
  // needs) and nothing it adds is a re-statement of what one is DOING.
  //
  // ⚠ AND IT IS A LAUNCHER, NOT AN EDITOR. Visual/node-based bot authoring is
  // under separate discovery; nothing here should pre-empt those decisions.
  import { onMount } from "svelte";
  import MiningBot from "./MiningBot.svelte";
  import MissionBot from "./MissionBot.svelte";
  import ServerBots from "./ServerBots.svelte";
  import {
    listBotScripts,
    getBotScript,
    startServerBot,
    type BotScriptSummary,
  } from "../app/api.ts";
  import { DEFAULT_SERVER_BOT_RUNTIME_MINUTES } from "../bots/runPolicy.ts";
  import { startHere, startOnServer } from "../bots/startRun.ts";
  import {
    BOTS,
    MINING_BOT_REQUIREMENTS,
    MISSION_BOT_REQUIREMENTS,
    evaluateRequirements,
    holdsTheShip,
    type BotID,
    type RequirementRow,
  } from "../nav/botRegistry.ts";
  import { destinationHold, holdShouldHaul } from "../nav/miningBotLoop.ts";
  import { highSlotMiningModules, ungroupedHighSlotModules } from "../space/rowActions.ts";
  import { nameKey } from "../store/names.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const bots = store.bots;
  // svelte-ignore state_referenced_locally
  const bot = store.bot;
  // svelte-ignore state_referenced_locally
  const missionBot = store.missionBot;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const mining = store.mining;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const customBot = store.customBot;

  /** Direct api.ts calls must ride THIS pilot's full flow options. */
  const botOpts = () => flow.requestOptions();

  /** Which bot's controls are open. Local view state, never the store's. */
  let opened = $state<BotID | null>(null);

  // The saved bots (from the web server) that can be launched here. The
  // library is shared platform-wide — every account sees every saved bot,
  // not just ones it saved itself.
  let savedBots = $state<BotScriptSummary[]>([]);
  let savedError = $state<string | null>(null);
  async function refreshSavedBots(): Promise<void> {
    try {
      savedBots = await listBotScripts(botOpts());
      savedError = null;
    } catch {
      savedBots = [];
      savedError = "Could not load saved bots — are you still logged in?";
    }
  }
  async function startSaved(scriptID: string): Promise<void> {
    const outcome = await startHere(
      {
        fetchScript: (id) => getBotScript(id, botOpts()),
        confirm: (message) => window.confirm(message),
        startCustomBot: (doc, sourceScriptID) => flow.startCustomBot(doc, sourceScriptID),
      },
      scriptID,
    );
    if (outcome.kind === "refused") {
      savedError = outcome.sentence;
    } else if (outcome.kind === "started") {
      savedError = null;
    }
  }

  /** Which saved bot a server start is in flight for (disables its buttons). */
  let serverStartBusy = $state<string | null>(null);
  let serverRunMinutes = $state(DEFAULT_SERVER_BOT_RUNTIME_MINUTES);

  /**
   * Run a saved bot ON THE SERVER, flying THIS TAB's current character.
   *
   * The handover is the SERVER's, in one request: /api/bots/start releases the
   * caller's own held session and claims the character for the bot atomically.
   * Started-first matters twice over — the login/select screens this tab falls
   * to poll the bot-flying marks, and a bot that already exists is on their
   * FIRST read (release-first left them blank until the next poll); and a
   * refused start changes nothing, so the tab just keeps flying (no take-the-
   * hull-back dance). The releaseSession afterwards only syncs THIS tab's UI —
   * its server-side session is already gone.
   */
  async function startSavedOnServer(scriptID: string): Promise<void> {
    if (serverStartBusy !== null) {
      return;
    }
    const current = store.station.get().online;
    if (current === null) {
      savedError = "Bring a character online first — the server bot flies your current character.";
      return;
    }
    serverStartBusy = scriptID;
    savedError = null;
    try {
      const outcome = await startOnServer(
        {
          fetchScript: (id) => getBotScript(id, botOpts()),
          confirm: (message) => window.confirm(message),
          startServerBot: (characterID, sid, grant) => startServerBot(characterID, sid, grant, botOpts()),
          releaseSession: () => flow.releaseSession(),
        },
        scriptID,
        current.characterID,
        serverRunMinutes,
      );
      if (outcome.kind === "refused") {
        savedError = outcome.sentence;
      } else if (outcome.kind === "started") {
        savedError = null;
      }
    } finally {
      serverStartBusy = null;
    }
  }
  onMount(() => {
    void refreshSavedBots();
  });

  /**
   * The reads BEHIND THE CHECKLIST, and they are deliberately the store's.
   *
   * ⚠ THIS IS THE ADVISORY COPY. The same requirement objects are evaluated a
   * second time inside `flow.startMiningBot` against reads taken fresh from the
   * server immediately before the first call, and only THAT evaluation decides
   * anything. What is on screen here can be a minute old — the player may have
   * docked, or unfitted a laser, since the last poll. Showing it is useful;
   * trusting it would be the stale-read bug this whole mechanism exists to
   * prevent.
   *
   * Null throughout means UNREADABLE, and an unloaded slice is unreadable rather
   * than empty: a fitting nobody has fetched is not a ship with nothing on it.
   */
  const shipIsDocked = $derived($flight.status === null ? null : $flight.status.docked);

  /**
   * The ship's miners, from its HIGH SLOTS — the only place a mining module
   * lives. Two counts, because "none fitted" and "fitted but switched off" are
   * different problems with different fixes.
   */
  const miners = $derived.by<{ fitted: number | null; online: number | null }>(() => {
    if (!$fitting.loaded || $fitting.slotsError !== null) {
      return { fitted: null, online: null };
    }
    const resolved = $names.resolved;
    const nameOf = (typeID: number): string | null => resolved[nameKey("type", typeID)] ?? null;
    const groupOf = (typeID: number): string | null =>
      resolved[nameKey("typeGroup", typeID)] ?? null;
    // A high-slot module whose GROUP has not resolved yet might BE a Strip
    // Miner, so it poisons both counts instead of being quietly read as "not a
    // miner" (R47 — the group is the game's own answer, resolved via /api/names).
    if (ungroupedHighSlotModules($fitting.slots, nameOf, groupOf).length > 0) {
      return { fitted: null, online: null };
    }
    const rows = highSlotMiningModules($fitting.slots, nameOf, groupOf);
    return { fitted: rows.length, online: rows.filter((row) => row.online).length };
  });

  const holdHasRoom = $derived.by<boolean | null>(() => {
    if (!$mining.holdsLoaded) {
      return null;
    }
    // The loop's own pair, not a second idea of "full".
    const shouldHaul = holdShouldHaul(destinationHold($mining.holds));
    return shouldHaul === null ? null : !shouldHaul;
  });

  /**
   * Only the SHIP-sourced requirements are shown here.
   *
   * The plan-sourced ones ("you have picked a belt") are the player's to satisfy
   * in the bot's own controls, which are on this page directly below — telling
   * them they have not picked a belt above the belt picker would be noise, and
   * asserting they HAVE picked one would be a guess. The declaration carries the
   * distinction so this filter is not a hardcoded list of ids.
   */
  const miningRows = $derived(
    evaluateRequirements(MINING_BOT_REQUIREMENTS, {
      inSpace: shipIsDocked === null ? null : !shipIsDocked,
      minersFitted: miners.fitted,
      minersOnline: miners.online,
      beltChosen: true,
      stationChosen: true,
      holdHasRoom,
    }).rows.filter((row) => row.source === "ship"),
  );

  const missionRows = $derived(
    evaluateRequirements(MISSION_BOT_REQUIREMENTS, {
      docked: shipIsDocked,
      agentChosen: true,
      agentStationKnown: true,
    }).rows.filter((row) => row.source === "ship"),
  );

  function rowsFor(id: BotID): readonly RequirementRow[] {
    return id === "mining" ? miningRows : missionRows;
  }

  /** The bot's own run state, straight from its slice. */
  function statusOf(id: BotID): string {
    return id === "mining" ? $bot.status : $missionBot.status;
  }

  /** What the badge says. Plain language, never the raw state word (R9a). */
  function statusWords(id: BotID): string {
    const status = statusOf(id);
    if (status === "running") {
      return "Running";
    }
    if (status === "paused") {
      return "Paused";
    }
    if (status === "error") {
      return "Stopped after a problem";
    }
    // A bot that has not been started, or was stopped cleanly, is simply ready
    // to go — this panel does not re-state a finished run's outcome, because
    // the bot's own readout below already does and does it better.
    return "Not running";
  }

  const running = $derived($bots.runningBotID);
  const runningName = $derived(
    running === "custom"
      ? ($customBot.name ?? "Your bot")
      : (BOTS.find((row) => row.id === running)?.name ?? null),
  );

  /**
   * Open whatever is running, so a player who started a bot and wandered off
   * lands on it. It only ever moves the view to something that IS running, and
   * only while the player has not chosen otherwise.
   */
  $effect(() => {
    if (running !== null && running !== "custom" && opened === null) {
      opened = running;
    }
  });

  /**
   * The checklist needs the fit, the hold and the names behind them. This panel
   * asks in its OWN right rather than assuming another tab has been visited —
   * a player may well open the launcher first. Best-effort: a read that fails
   * leaves the requirement at "could not check", which is the honest answer and
   * is exactly what the cannot-tell verdict is for.
   */
  onMount(() => {
    void Promise.resolve(flow.loadFitting()).catch(() => {});
    void Promise.resolve(flow.loadMiningHolds()).catch(() => {});
  });

  // Names AND groups for whatever is fitted, so "is that a Strip Miner?" is
  // answerable — the group is the game's own answer to that (R47).
  $effect(() => {
    const refs = $fitting.slots
      .filter((slot) => slot.module !== null)
      .flatMap((slot) => [
        { kind: "type" as const, id: slot.module!.typeID },
        { kind: "typeGroup" as const, id: slot.module!.typeID },
      ]);
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2>Bots</h2>
  </header>
  <p class="note">
    Everything this client can run for you. A bot runs in this tab: close it and
    your ship finishes what it was last told to do and sits. Only one bot can fly
    your ship at a time — starting one stops whatever else was running. A saved
    bot can instead run <em>on the server</em>, which keeps flying after this tab
    is gone. Saved bots are shared: anyone with a character here can run any of
    them.
  </p>
  {#if runningName}
    <p class="stat-line">
      <strong>{runningName}</strong>
      <span class="note"> is flying your ship right now.</span>
    </p>
  {:else}
    <p class="note">Nothing is running.</p>
  {/if}
</section>

<section>
  <h2>Saved bots</h2>
  <label class="run-limit">
    Server run limit
    <select bind:value={serverRunMinutes} disabled={serverStartBusy !== null}>
      <option value={60}>1 hour</option>
      <option value={240}>4 hours</option>
      <option value={720}>12 hours</option>
      <option value={1440}>24 hours</option>
    </select>
  </label>
  {#if savedError}<p class="note error">{savedError}</p>{/if}
  {#if savedBots.length === 0}
    <p class="note">No saved bots yet. Build one in the Bot Builder tab, then Save it.</p>
  {:else}
    <ul class="saved-bots">
      {#each savedBots as meta (meta.scriptID)}
        <li class="saved-bot">
          <span class="saved-name">{meta.name}</span>
          <span class="saved-actions">
            <!--
              Two very different promises. "Run here" is the in-tab runner:
              close the tab and the ship sits. "Run on server" hands the hull
              to the BFF: the tab (and the phone it is on) stops mattering.
            -->
            <button
              class="primary"
              disabled={serverStartBusy !== null}
              onclick={() => startSaved(meta.scriptID)}
            >
              Run here
            </button>
            <button
              disabled={serverStartBusy !== null}
              onclick={() => startSavedOnServer(meta.scriptID)}
            >
              {serverStartBusy === meta.scriptID ? "Handing over…" : "Run on server"}
            </button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<ServerBots />

<section>
  <h2>What you can run</h2>
  <div class="bot-list">
    {#each BOTS as entry (entry.id)}
      {@const rows = rowsFor(entry.id)}
      {@const isOpen = opened === entry.id}
      <article class="bot-card" class:running={holdsTheShip(statusOf(entry.id))}>
        <header class="bot-head">
          <h3>{entry.name}</h3>
          <span class="badge">{statusWords(entry.id)}</span>
        </header>
        <p class="note">{entry.summary}</p>

        <h4>What it needs from your ship</h4>
        <ul class="checklist">
          {#each rows as row (row.id)}
            <li class={`check-${row.verdict}`}>
              <span class="mark" aria-hidden="true">
                {row.verdict === "met" ? "✓" : row.verdict === "cannot-tell" ? "?" : "•"}
              </span>
              <span>
                {row.title}
                <!--
                  R30/R33: an unmet requirement STATES ITS REASON rather than
                  going quiet. A checklist line that just fails to tick tells a
                  player nothing they can act on.
                -->
                {#if row.reason}
                  <span class="note"> — {row.reason}</span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>

        <p class="controls">
          <button
            type="button"
            class:primary={!isOpen}
            onclick={() => (opened = isOpen ? null : entry.id)}
            aria-expanded={isOpen}
          >
            {isOpen ? `Hide ${entry.name}` : `Set up and start ${entry.name}`}
          </button>
        </p>
      </article>
    {/each}
  </div>
</section>

<!--
  THE REAL COMPONENT, NOT A COPY. Its Start / Pause / Stop and its live readout
  are the ones that have been live-proven; embedding it is what stops this panel
  ever disagreeing with the bot it is launching.
-->
{#if opened === "mining"}
  <MiningBot {store} {flow} />
{:else if opened === "mission"}
  <MissionBot {store} {flow} />
{/if}

<style>
  .bot-list {
    display: grid;
    gap: 1rem;
    /* R8 — one column on a phone, two where there is room, never a sideways scroll. */
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  }
  .bot-card {
    border: 1px solid currentColor;
    border-radius: 0;
    padding: 0.75rem;
    /* The border is the only thing carrying "this one is live", so it is not
       colour alone — the badge says it in words too. */
    opacity: 0.95;
  }
  .bot-card.running {
    border-width: 2px;
  }
  .bot-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .bot-head h3 {
    margin: 0;
  }
  .badge {
    font-size: 0.85em;
    border: 1px solid currentColor;
    border-radius: 0;
    padding: 0.1rem 0.4rem;
    white-space: nowrap;
  }
  .checklist {
    list-style: none;
    padding: 0;
    margin: 0.25rem 0 0.75rem;
  }
  .checklist li {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    margin: 0.3rem 0;
  }
  .mark {
    flex: 0 0 1rem;
    text-align: center;
  }
  .check-met .mark {
    font-weight: bold;
  }
  .check-cannot-tell {
    opacity: 0.85;
  }
  /* R8 — a comfortable target on a phone. */
  .bot-card button {
    min-height: 40px;
  }
  .saved-bots {
    list-style: none;
    margin: 0.4rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .run-limit {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0.4rem 0 0.7rem;
  }
  .run-limit select {
    min-height: 40px;
  }
  .saved-bot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    border: 1px solid var(--color-row-line);
    border-radius: 4px;
    background: var(--color-panel-3);
    padding: 0.5rem 0.6rem;
  }
  .saved-name {
    color: var(--color-text-bright);
  }
  .saved-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .saved-bot button {
    min-height: 40px;
  }
</style>
