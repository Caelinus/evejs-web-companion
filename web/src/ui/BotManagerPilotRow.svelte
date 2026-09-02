<script lang="ts">
  // BOT MANAGER — region A, one row for one pilot (docs/bot-manager-brainstorm.md
  // §4 region A). Sibling to BotManager.svelte, which renders one of these per
  // held session plus one per `serverOnlyBots()` entry.
  //
  // `session` is OPTIONAL: a server bot can be flying a character for which no
  // tab is open in this browser tab at all (the roster in §4's "multibox
  // wrinkle" only sees held sessions, never a bot's own headless run). Rather
  // than fork this into two components, one prop is made optional and every
  // signal read below is guarded — the alternative (a separate "server-only
  // row" component) would duplicate the run-state rendering for no benefit,
  // since `pilotRunState`/`serverRunState` already collapse to the right
  // answer once `bots`/`customBot` are treated as absent.
  //
  // Follows CharacterChip.svelte's pattern for a background pilot staying
  // live: read THAT session's own store signals rather than the active
  // session's. Unlike CharacterChip, `session` here can be undefined and can
  // (in principle) change identity, so the slices are captured explicitly
  // inside `$effect` (App.svelte's station-watch effect is the precedent for
  // subscribing explicitly rather than with `$store` sugar) instead of once
  // at the top level.
  import { stopServerBot, type ServerBot } from "../app/api.ts";
  import type { Session } from "../app/sessions.ts";
  import { pilotRunState, serverRunState, type PilotRunState } from "../bots/pilotRoster.ts";
  import type { StationSlice } from "../store/clientStore.ts";
  import type { BotsState, CustomBotState, FlightState } from "../store/types.ts";

  let {
    session,
    serverBot,
    onStopped,
  }: {
    session?: Session;
    serverBot: ServerBot | null;
    onStopped: () => void;
  } = $props();

  // A tab run with no server claim reads as "nothing running" here — the same
  // fallback tabRunState itself uses for a released ship — so a row never
  // shows stale data before its first store tick lands.
  const FALLBACK_BOTS: BotsState = { runningBotID: null };
  const FALLBACK_CUSTOM_BOT: CustomBotState = {
    status: "idle",
    name: null,
    phase: null,
    why: null,
    stepPath: null,
    interruptID: null,
    pauseReason: null,
    note: null,
    startError: null,
    lastAlert: null,
  };

  let station = $state<StationSlice | null>(null);
  let flight = $state<FlightState | null>(null);
  let bots = $state<BotsState | null>(null);
  let customBot = $state<CustomBotState | null>(null);

  $effect(() => {
    if (!session) {
      station = null;
      flight = null;
      bots = null;
      customBot = null;
      return;
    }
    const unsubs = [
      session.store.station.subscribe((value) => {
        station = value;
      }),
      session.store.flight.subscribe((value) => {
        flight = value;
      }),
      session.store.bots.subscribe((value) => {
        bots = value;
      }),
      session.store.customBot.subscribe((value) => {
        customBot = value;
      }),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });

  const pilotName = $derived(
    session ? (station?.online?.characterName ?? null) : (serverBot?.characterName ?? null),
  );

  // Same station/system fallback chain CharacterChip.svelte reads from these
  // slices. A server-only row (no tab held here) has no station/flight
  // reading to derive a location from at all — said plainly rather than
  // guessed at.
  const where = $derived(
    session
      ? (station?.station?.stationName ??
          station?.station?.solarSystemName ??
          flight?.solarSystemName ??
          "Unknown")
      : "No tab open here",
  );

  const runState = $derived<PilotRunState>(
    session
      ? pilotRunState(bots ?? FALLBACK_BOTS, customBot ?? FALLBACK_CUSTOM_BOT, serverBot)
      : serverBot
        ? serverRunState(serverBot)
        : { mode: "none", botName: null, statusWords: "Nothing is running", detail: null },
  );

  const modeLabel = $derived(
    runState.mode === "server" ? "On the server" : runState.mode === "tab" ? "In this tab" : null,
  );

  // Decision 3's honest lifetime copy, plain enough to sit right under the badge.
  const lifetimeNote = $derived(
    runState.mode === "server"
      ? "Keeps flying if this tab closes."
      : runState.mode === "tab"
        ? "Stops if this tab closes."
        : null,
  );

  // A TAB run only exposes Pause/Resume/Stop when the custom-bot runner is the
  // one holding the ship — the controls this row is given
  // (session.flow.pauseCustomBot / resumeCustomBot / stopCustomBot) are that
  // runner's own remote control, not a generic one. A built-in bot's tab run
  // (mining/mission) is controlled from its own panel, unchanged by this row.
  const isCustomTabRun = $derived(
    session !== undefined && runState.mode === "tab" && bots?.runningBotID === "custom",
  );
  const customStatus = $derived(customBot?.status ?? null);

  function pause(): void {
    session?.flow.pauseCustomBot();
  }
  function resume(): void {
    session?.flow.resumeCustomBot();
  }
  function stop(): void {
    session?.flow.stopCustomBot();
  }

  let busy = $state(false);
  let stopError = $state<string | null>(null);

  async function stopServer(): Promise<void> {
    if (serverBot === null || busy) {
      return;
    }
    busy = true;
    stopError = null;
    try {
      // Direct api.ts calls must ride the owning pilot's flow options; a
      // server-only row (no session held here) has no flow of its own and
      // falls back to the tab's active-pilot token, same as any other legacy
      // call without per-session options (see App.svelte's token mirror).
      await stopServerBot(serverBot.botID, session?.flow.requestOptions() ?? {});
      onStopped();
    } catch {
      stopError = "Could not stop that bot — it may have already ended.";
    } finally {
      busy = false;
    }
  }
</script>

<tr>
  <td data-label="Pilot">{pilotName ?? "Unknown pilot"}</td>
  <td data-label="Where">{where}</td>
  <td data-label="Running">
    {#if runState.botName}
      <div>
        {runState.botName}
        {#if modeLabel}
          <span class="badge" class:accent={runState.mode === "server"}>{modeLabel}</span>
        {/if}
      </div>
      {#if lifetimeNote}
        <p class="note why">{lifetimeNote}</p>
      {/if}
    {:else}
      —
    {/if}
  </td>
  <td data-label="Status">
    {runState.statusWords}
    {#if runState.detail}
      <p class="note why">{runState.detail}</p>
    {/if}
  </td>
  <td data-label="Actions">
    <span class="row-actions">
      {#if isCustomTabRun}
        {#if customStatus === "paused"}
          <button type="button" onclick={resume}>Resume</button>
        {:else}
          <button type="button" disabled={customStatus !== "running"} onclick={pause}>Pause</button>
        {/if}
        <button type="button" class="danger" onclick={stop}>Stop</button>
      {:else if runState.mode === "server"}
        <button type="button" class="danger" disabled={busy} onclick={stopServer}>
          {busy ? "Stopping…" : "Stop"}
        </button>
      {/if}
    </span>
    {#if stopError}
      <p class="note error">{stopError}</p>
    {/if}
  </td>
</tr>
