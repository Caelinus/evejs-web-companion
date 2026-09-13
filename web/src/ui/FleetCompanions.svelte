<script lang="ts">
  // FLEET COMPANIONS — the global window, and the one place companions live.
  //
  // ⚠ WHY IT IS NOT A PANEL IN A PILOT'S DESKTOP. A companion takes its orders
  // from a fleet, and a fleet is a thing several of your pilots are in at once.
  // The questions this window exists to answer — who is following whom, who has
  // stopped, who is not in the fleet yet — are questions about the SQUAD, and a
  // per-pilot panel can only ever answer them one pilot at a time, by switching
  // to each pilot in turn and destroying the view you were reading. So it is
  // hoisted onto App's global layer (globalWindow.ts) and opened from the
  // character bar, which is the only chrome that outlives a pilot switch.
  //
  // ⚠ AND WHY IT IS NOT IN THE BOT MANAGER, where it used to be. A companion is
  // not a bot: it has no script, no library row, no work it picks for itself,
  // nothing to export or share. It was built as the third instance of the
  // mining/mission bot pattern and inherited that furniture; `BotID` no longer
  // lists it (nav/botRegistry.ts) and neither does the Manager.
  //
  // TWO KINDS OF ROW, both listed here because both are companions:
  //   • a TAB run — a pilot signed into this browser, flown by this tab's own
  //     loop, and stopped when the tab closes;
  //   • a SERVER run — started from the Pilot Hangar, flown headless by the BFF,
  //     and still flying when every tab is shut. The Manager used to be the only
  //     screen that could stop one of those; now that it no longer shows
  //     companions, this window has to, or a headless companion would have no
  //     door at all.
  //
  // ⚠ IT EMBEDS THE REAL PANEL AND FORKS NOTHING. The selected pilot's controls
  // and readout are `FleetCompanion.svelte` itself, bound to THAT pilot's store
  // and flow — the same component, the same Start/Pause/Stop, the same setup
  // form that has been live-proven. A second copy of a readout drifts, and a
  // drifted readout does not go quiet: it keeps rendering, confidently, about a
  // companion doing something else.
  import { onMount } from "svelte";
  import FleetCompanion from "./FleetCompanion.svelte";
  import { listServerBots, stopServerBot, type ServerBot } from "../app/api.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { holdsTheShip, type ShipControllerID } from "../nav/botRegistry.ts";
  import { canTagWords, inFleetWords, orderFromWords } from "../bots/companionReadout.ts";
  import {
    companionStatusWords,
    companionSummaryWords,
    inFleetFrom,
    runFactsFor,
    serverCompanions,
    tallyCompanions,
  } from "../nav/companionRoster.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { Session } from "../app/sessions.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { FleetCompanionState } from "../store/types.ts";

  let {
    flow,
    sessions,
    onGoToPilot,
  }: {
    /**
     * The ACTIVE pilot's flow, used for one thing only: the account-scoped read
     * of the server's bot roster. Every per-pilot action below goes through
     * that pilot's OWN flow, off its own session — this window is never allowed
     * to drive one pilot with another's.
     */
    flow?: AppFlow;
    sessions?: readonly Session[];
    /** Make a pilot the active cockpit. Absent in tests and harnesses. */
    onGoToPilot?: (sessionID: string) => void;
  } = $props();

  const pilots = $derived(sessions ?? []);

  /**
   * One pilot's live readings, rebuilt from every session on each store tick.
   *
   * ⚠ REBUILT WHOLE, NEVER PATCHED. Writing `live = { ...live, [id]: … }` would
   * READ `live` inside the effect that writes it, and a Svelte effect that reads
   * what it writes re-runs itself forever. There are a handful of pilots; the
   * rebuild is free and the loop it avoids is not.
   *
   * ⚠ AND IT SUBSCRIBES TO EACH SESSION'S OWN SLICES rather than the active
   * pilot's store, which is the same thing BotManagerPilotRow does and for the
   * same reason: a backgrounded pilot is still live on the BFF, and the whole
   * point of this window is to show what it is doing while you are looking at
   * somebody else.
   */
  interface LivePilot {
    readonly name: string;
    readonly where: string;
    readonly characterID: number | null;
    readonly companion: FleetCompanionState;
    readonly holder: ShipControllerID | null;
    /**
     * The Fleet Center's own answer for this pilot.
     *
     * ⚠ WITHOUT IT THE IN-FLEET COLUMN IS DEAD UNTIL SOMETHING RUNS. A
     * companion's slice only carries a fleet reading while it is flying, so a
     * roster that asked only the slice would print "not known" against every
     * idle pilot — and "who is not in the fleet yet" is half of what this
     * window is for. `inFleetFrom` owns which of the two wins.
     */
    readonly fleetAvailability: string | null;
  }
  let live = $state<Record<string, LivePilot>>({});
  $effect(() => {
    const refresh = (): void => {
      const next: Record<string, LivePilot> = {};
      for (const session of pilots) {
        const state = session.store.get();
        next[session.id] = {
          name: state.station.online?.characterName ?? "This pilot",
          where:
            state.station.station?.stationName ??
            state.station.station?.solarSystemName ??
            state.flight.solarSystemName ??
            "Unknown",
          characterID: state.station.online?.characterID ?? null,
          companion: state.companion,
          holder: state.bots.runningBotID,
          fleetAvailability: state.fleet.availability,
        };
      }
      live = next;
    };
    const unsubs: Array<() => void> = [];
    for (const session of pilots) {
      unsubs.push(session.store.station.subscribe(refresh));
      unsubs.push(session.store.flight.subscribe(refresh));
      unsubs.push(session.store.companion.subscribe(refresh));
      unsubs.push(session.store.bots.subscribe(refresh));
      unsubs.push(session.store.fleet.subscribe(refresh));
    }
    refresh();
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });

  /**
   * Ask each pilot for its fleet, once.
   *
   * ⚠ THIS WINDOW HAS TO ASK IN ITS OWN RIGHT. The per-pilot panel loads the
   * fleet for the pilot it is mounted on, which is exactly the one pilot the
   * roster did not need help with; nothing else in the app fetches a
   * BACKGROUNDED pilot's fleet, so every other row would sit at "not known"
   * forever. Best-effort: a read that fails leaves the column at "not known",
   * which is the honest answer and what that verdict is for.
   *
   * ⚠ ONCE PER PILOT, tracked in a set rather than by a mount. The effect
   * re-runs whenever the roster changes — a pilot coming online, a store tick —
   * and a fetch per re-run would be a poll nobody asked for.
   */
  const fleetAsked = new Set<string>();
  $effect(() => {
    for (const session of pilots) {
      if (fleetAsked.has(session.id)) continue;
      fleetAsked.add(session.id);
      void Promise.resolve(session.flow.loadFleet()).catch(() => {});
    }
  });

  // --- the server's own companions -----------------------------------------
  //
  // Polled, for BotManager.svelte's reason: a headless companion changes phase,
  // joins a fleet and hits its runtime cap with no local event to notice, so an
  // onMount read alone would freeze this half of the roster at whenever the
  // window was opened — and a stale "Running" is a lie a player acts on.
  const SERVER_ROSTER_POLL_MS = 3000;
  let serverBots = $state<ServerBot[]>([]);
  let serverError = $state<string | null>(null);
  let serverLoaded = $state(false);

  async function refreshServer(): Promise<void> {
    if (!flow) return;
    try {
      serverBots = await listServerBots(flow.requestOptions());
      serverError = null;
    } catch {
      serverError = "Could not read the server's companions — are you still signed in?";
    } finally {
      serverLoaded = true;
    }
  }

  onMount(() => {
    if (!flow) return;
    void refreshServer();
    const beat = skipWhileBusy(refreshServer);
    const handle = setInterval(() => void beat(), SERVER_ROSTER_POLL_MS);
    return () => clearInterval(handle);
  });

  const serverRows = $derived(serverCompanions(serverBots));
  // A server companion flying a pilot whose tab is ALSO open here would
  // otherwise be two rows for one hull. The server holds the ship in that case
  // (bots/pilotRoster.ts's rule), so the tab row defers to it.
  const serverHeldCharacterIDs = $derived(new Set(serverRows.map((bot) => bot.characterID)));

  const tabRows = $derived(
    pilots.map((session) => {
      const state = live[session.id];
      const holding = holdsTheShip(state?.companion?.status ?? "idle");
      return {
        session,
        name: state?.name ?? "This pilot",
        where: state?.where ?? "Unknown",
        companion: state?.companion ?? null,
        holder: state?.holder ?? null,
        inFleet: inFleetFrom(
          state?.fleetAvailability ?? null,
          state?.companion?.inFleet ?? null,
          holding,
        ),
        // The run-only columns, silent when no run holds this ship.
        facts: runFactsFor(holding, state?.companion ?? null),
        onServer:
          state?.characterID !== null && state?.characterID !== undefined
            ? serverHeldCharacterIDs.has(state.characterID)
            : false,
      };
    }),
  );

  const tally = $derived(
    tallyCompanions([
      ...tabRows.filter((row) => !row.onServer).map((row) => row.companion?.status ?? null),
      ...serverRows.map((bot) => bot.status),
    ]),
  );
  const summary = $derived(companionSummaryWords(tally));

  /** Which row's detail is open: a session id, or `server:<botID>`. */
  let selected = $state<string | null>(null);
  const selectedSession = $derived(pilots.find((session) => session.id === selected) ?? null);
  const selectedServerBot = $derived(
    serverRows.find((bot) => `server:${bot.botID}` === selected) ?? null,
  );

  /**
   * Land on whatever is flying, so a player opening this window sees the run
   * they came to check rather than an arbitrary first pilot. It only ever moves
   * the view to something that IS holding a ship, and only while the player has
   * not chosen otherwise.
   */
  $effect(() => {
    if (selected !== null) return;
    const flying = tabRows.find((row) => holdsTheShip(row.companion?.status ?? "idle"));
    if (flying) {
      selected = flying.session.id;
      return;
    }
    const headless = serverRows[0];
    if (headless) {
      selected = `server:${headless.botID}`;
      return;
    }
    const first = pilots[0];
    if (first) selected = first.id;
  });

  let busy = $state(false);
  let error = $state("");

  async function run(action: () => Promise<unknown> | unknown): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }

  /**
   * Stop every companion this window can reach — the tab runs through each
   * pilot's own flow, the headless ones through the server.
   *
   * ⚠ NO CONFIRMATION DIALOG. A stopped companion sits where it is and can be
   * started again from this same window; the reversible act does not get to
   * interrupt the player, and a dialog in front of a fleet that is currently
   * being shot at is worse than either outcome it was guarding.
   */
  async function stopAll(): Promise<void> {
    await run(async () => {
      for (const row of tabRows) {
        if (row.companion !== null && holdsTheShip(row.companion.status)) {
          await row.session.flow.stopFleetCompanion();
        }
      }
      for (const bot of serverRows) {
        await stopServerBot(bot.botID, flow?.requestOptions() ?? {});
      }
      await refreshServer();
    });
  }

  const anyFlying = $derived(
    tabRows.some((row) => holdsTheShip(row.companion?.status ?? "idle")) || serverRows.length > 0,
  );
</script>

<section class="panel">
  <header class="panel-head">
    <h2>Fleet companions</h2>
    <span class="controls">
      <button type="button" class="danger" disabled={busy || !anyFlying} onclick={stopAll}>
        Stop all
      </button>
    </span>
  </header>
  <!-- ⚠ NO DESCRIPTION OF WHAT A COMPANION IS. The title says it, the table
       shows it, and a paragraph restating it is a paragraph the player reads
       once and then has to look past every time afterwards. What stays on this
       panel is the one line that CHANGES: how many are flying. -->
  <p class="stat-line">{summary}</p>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if serverError}
    <p class="error">{serverError}</p>
  {/if}
</section>

<section>
  <h2>Pilots</h2>
  {#if tabRows.length === 0 && serverRows.length === 0}
    <p class="note">
      No pilot is signed in here. Bring one online from the Pilot hangar, then a
      companion can be started on it.
    </p>
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Pilot</th>
            <th>Companion</th>
            <th>In fleet</th>
            <th>Following orders from</th>
            <th>Last order heard</th>
            <th>Can tag</th>
          </tr>
        </thead>
        <tbody>
          {#each tabRows as row (row.session.id)}
            {@const state = row.companion}
            <!-- A pilot whose hull the SERVER is flying is listed by the server
                 row below instead: that side owns the run, and this tab's
                 companion slice is a stale copy of a run it is not driving. -->
            {#if !row.onServer}
              <tr class:selected={selected === row.session.id}>
                <td data-label="Pilot">
                  <button
                    type="button"
                    class="link-button"
                    aria-pressed={selected === row.session.id}
                    onclick={() => (selected = row.session.id)}
                  >
                    {row.name}
                  </button>
                  <span class="note">{row.where}</span>
                </td>
                <td data-label="Companion">
                  {companionStatusWords(state?.status ?? null)}
                  <!-- ⚠ SAID OUT LOUD, THOUGH A BOT IS NOT THIS WINDOW'S
                       BUSINESS. Starting a companion on a hull a bot is flying
                       takes the ship off that bot; a roster that showed only
                       companions would make that look like it came from
                       nowhere. -->
                  {#if state !== null && !holdsTheShip(state.status) && row.holder !== null && row.holder !== "companion"}
                    <span class="note"> — a bot is flying this ship</span>
                  {/if}
                </td>
                <td data-label="In fleet">{inFleetWords(row.inFleet)}</td>
                <!-- ⚠ `row.facts`, NOT THE SLICE. The companion slice keeps its
                     last readout after a run ends, so reading it directly left a
                     stopped pilot still claiming to be following orders and
                     still reporting whether it could tag — three confident
                     sentences about a pilot doing nothing. -->
                <td data-label="Following orders from"
                  >{orderFromWords(row.facts.followingOrderFrom)}</td
                >
                <td data-label="Last order heard">{row.facts.lastOrderHeard ?? "-"}</td>
                <td data-label="Can tag">{canTagWords(row.facts.canTag)}</td>
              </tr>
            {/if}
          {/each}
          {#each serverRows as bot (bot.botID)}
            {@const facts = bot.companion}
            <tr class:selected={selected === `server:${bot.botID}`}>
              <td data-label="Pilot">
                <button
                  type="button"
                  class="link-button"
                  aria-pressed={selected === `server:${bot.botID}`}
                  onclick={() => (selected = `server:${bot.botID}`)}
                >
                  {bot.characterName ?? "Unnamed pilot"}
                </button>
                <span class="note">On the server</span>
              </td>
              <td data-label="Companion">{companionStatusWords(bot.status)}</td>
              <td data-label="In fleet">{inFleetWords(facts?.inFleet ?? null)}</td>
              <td data-label="Following orders from"
                >{orderFromWords(facts?.followingOrderFrom ?? null)}</td
              >
              <td data-label="Last order heard">{facts?.lastOrderHeard ?? "-"}</td>
              <td data-label="Can tag">{canTagWords(facts?.canTag ?? null)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if flow && !serverLoaded}
      <p class="note">Reading the server's companions…</p>
    {/if}
  {/if}
</section>

{#if selectedSession}
  <section class="panel">
    <header class="panel-head">
      <h2>{live[selectedSession.id]?.name ?? "This pilot"}</h2>
      <span class="controls">
        {#if onGoToPilot}
          <button type="button" onclick={() => onGoToPilot?.(selectedSession.id)}>
            Go to pilot
          </button>
        {/if}
      </span>
    </header>
  </section>
  <!--
    THE REAL PANEL, BOUND TO THAT PILOT.

    ⚠ `{#key}` IS LOAD-BEARING. `FleetCompanion.svelte` reads its store's slices
    once at init — it has to, because `$companion` needs a stable top-level
    binding — so handing a live instance a different `store` changes nothing: it
    would go on rendering the pilot it was created for, under another pilot's
    name. CharacterBar.svelte keys its one chip for exactly this reason.
  -->
  {#key selectedSession.id}
    <FleetCompanion store={selectedSession.store} flow={selectedSession.flow} />
  {/key}
{:else if selectedServerBot}
  <section class="panel">
    <header class="panel-head">
      <h2>{selectedServerBot.characterName ?? "Unnamed pilot"}</h2>
      <span class="controls">
        <button
          type="button"
          class="danger"
          disabled={busy}
          onclick={() =>
            run(async () => {
              await stopServerBot(selectedServerBot.botID, flow?.requestOptions() ?? {});
              await refreshServer();
            })}
        >
          Stop
        </button>
      </span>
    </header>
    <!--
      ⚠ NO SETUP FORM, AND THAT IS NOT AN OVERSIGHT. This run is on the server,
      which took its limits when it was started from the Pilot hangar. Offering
      the fields here would let a player change numbers that reach nothing.
    -->
    <p class="note">
      This companion is flying on the server, so it keeps going when this tab is
      closed. Its limits were set when it was started, and the only thing this
      window can do to it from here is stop it.
    </p>
    <p class="stat-line">
      <strong>{selectedServerBot.phase ?? "Working"}</strong>
    </p>
    {#if selectedServerBot.why}
      <p class="note"><strong>Why:</strong> {selectedServerBot.why}</p>
    {/if}
    {#if selectedServerBot.companion && selectedServerBot.companion.fitWarnings.length > 0}
      <p class="note"><strong>Worth knowing about this fit:</strong></p>
      <ul>
        {#each selectedServerBot.companion.fitWarnings as warning (warning)}
          <li class="note">{warning}</li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  /* The chosen row, marked by weight rather than colour alone — the detail
     below carries the pilot's name in its own heading, which is the real
     confirmation of what is open. */
  tr.selected > td {
    border-top: 1px solid currentColor;
    border-bottom: 1px solid currentColor;
  }
  .link-button {
    display: inline;
    padding: 0;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  td .note {
    display: block;
  }
</style>
