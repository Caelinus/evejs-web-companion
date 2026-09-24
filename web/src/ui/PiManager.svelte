<script lang="ts">
  // PLANETARY INDUSTRY (R108 slices 3 and 4) — every assigned pilot's colonies
  // on one board, and one action: restarting a pilot's ended extractors.
  //
  // ⚠ A GLOBAL WINDOW WITH NO STORE. Every other panel is a view of the mounted
  // pilot. This one is a view of the player's own PI roster, which spans
  // accounts, and it reads through its own throwaway sign-ins
  // (app/piRosterRead.ts) — so it takes no `store` and no `flow`, and a pilot
  // switch does not tear it down (globalWindow.ts).
  //
  // ⚠ NOTHING HERE SELECTS A CHARACTER. Reading a colony needs only ownership,
  // proved live; a select claims a hull, and a bot flying that pilot in another
  // tab would lose its ship without a word. Acting on a colony goes through the
  // SERVER bot host (app/piDispatch.ts), the one thing that arbitrates hulls
  // honestly: it refuses a pilot already flown, in its own words.
  //
  // ⚠ IT READS WHEN OPENED AND WHEN ASKED, AND NEVER ON A TIMER. The 30-second
  // tick below moves the ages on and touches no network. When to read on its
  // own is the scheduler's job, a later slice.
  //
  // ⚠ EVERY ROW SAYS HOW OLD IT IS. Pilots are read at different moments; the
  // board never presents them as one (bridge/piBoard.ts).
  import { onMount } from "svelte";
  import { loadKnownCharacters, type KnownCharacter } from "../app/knownCharacters.ts";
  import { loadHangarPrefs } from "../app/hangarPrefs.ts";
  import {
    addPiMember,
    addPiMembers,
    loadPiRoster,
    piReadings,
    recordPiAnswer,
    removePiMember,
    savePiRoster,
    type PiRosterPrefs,
  } from "../app/piRosterPrefs.ts";
  import { readPiRoster } from "../app/piRosterRead.ts";
  import { buildPiBoard, type PiDispatchState, type PilotAttempt } from "../bridge/piBoard.ts";
  import { restartExtractorsFor } from "../app/piDispatch.ts";
  import { listActiveServerBots } from "../app/api.ts";
  import { decodeRecipeBook, type PiRecipeBook } from "../bridge/piRecipes.ts";

  let roster = $state<PiRosterPrefs>(loadPiRoster());
  let known = $state<KnownCharacter[]>(loadKnownCharacters());
  // A snapshot at open: squads change in the hangar, and "add everyone in this
  // squad" copies whoever is in it at the moment of the click.
  const hangar = loadHangarPrefs();
  let attempts = $state<Map<number, PilotAttempt>>(new Map());
  let reading = $state(false);
  let browserNowMs = $state(Date.now());
  let choice = $state("");
  // Static, so read once per open window. Without it a starved factory is
  // judged by what its routes bring rather than by its recipe.
  let recipes = $state<PiRecipeBook | null>(null);
  // Who a server bot is flying (a public read), and what this window's own
  // starts did. Read when the window opens, on Refresh and after a start —
  // never on a timer.
  let activeBots = $state<Set<number>>(new Set());
  let dispatch = $state<Map<number, PiDispatchState>>(new Map());

  // One view at a time, picked from the window's own menu. An empty roster
  // opens on Pilots, because adding one is the only thing to do there.
  // ⚠ Every view is RENDERED and the others are `hidden`, not left out: a
  // restart already started keeps saying so while the player looks elsewhere.
  type View = "colonies" | "pilots" | "planner";
  let view = $state<View>(loadPiRoster().members.length === 0 ? "pilots" : "colonies");

  async function loadActiveBots(): Promise<void> {
    try {
      activeBots = new Set((await listActiveServerBots()).map((bot) => bot.characterID));
    } catch {
      // Keep what we had: the server still refuses a start for a flown pilot,
      // in its own words, so a stale list here cannot cause a takeover.
    }
  }

  /**
   * Restart a pilot's ended extractors, as a SERVER run. Never a select from
   * here: the bot host decides whether the pilot is free, and says why not.
   */
  async function restartExtractors(characterID: number): Promise<void> {
    const accountName = known.find((pilot) => pilot.characterID === characterID)?.accountName;
    const set = (state: PiDispatchState) => {
      const next = new Map(dispatch);
      next.set(characterID, state);
      dispatch = next;
    };
    if (!accountName) {
      set({ kind: "refused", sentence: "This pilot is no longer in the hangar, so there is no account to start it with." });
      return;
    }
    set({ kind: "starting" });
    set(await restartExtractorsFor(accountName, characterID));
    await loadActiveBots();
  }

  function keep(next: PiRosterPrefs): void {
    roster = next;
    savePiRoster(next);
  }

  const names = $derived(new Map(known.map((pilot) => [pilot.characterID, pilot.characterName])));
  const readings = $derived(piReadings(roster));
  const board = $derived(
    buildPiBoard({ members: roster.members, names, readings, attempts, browserNowMs, recipes, activeBots, dispatch }),
  );
  const addablePilots = $derived(
    known
      .filter((pilot) => !roster.members.includes(pilot.characterID))
      .sort((left, right) => left.characterName.localeCompare(right.characterName)),
  );
  // The badge is what waits in that view: colonies that need you, pilots
  // with a restart to offer. Nothing waiting, no badge.
  const menu = $derived<{ id: View; label: string; badge: number; urgent: boolean }[]>([
    {
      id: "colonies",
      label: "Colonies",
      badge: board.needsYou.length,
      urgent: board.needsYou.some((item) => item.urgency === "now"),
    },
    {
      id: "pilots",
      label: "Pilots",
      badge: board.pilots.filter((pilot) => pilot.restart?.enabled).length,
      urgent: false,
    },
    { id: "planner", label: "Planner", badge: 0, urgent: false },
  ]);
  const squadsWithNewPilots = $derived(
    hangar.squads.filter((squad) =>
      (hangar.members[squad.id] ?? []).some((id) => !roster.members.includes(id)),
    ),
  );

  async function refresh(): Promise<void> {
    if (reading || roster.members.length === 0) return;
    reading = true;
    known = loadKnownCharacters();
    void loadActiveBots();
    const asked = roster.members;
    attempts = new Map(asked.map((id) => [id, "reading" as const]));
    try {
      await readPiRoster(asked, known, undefined, (result) => {
        let next = roster;
        for (const answer of result.answers) {
          next = recordPiAnswer(next, answer.envelope, answer.browserNowMs);
        }
        keep(next);
        const merged = new Map(attempts);
        for (const [characterID, attempt] of result.attempts) merged.set(characterID, attempt);
        attempts = merged;
        browserNowMs = Date.now();
      }, recipes?.readable ? {} : {
        onRecipes: (raw) => {
          const book = decodeRecipeBook(raw);
          if (book.readable) recipes = book;
        },
      });
    } finally {
      reading = false;
      browserNowMs = Date.now();
    }
  }

  function add(): void {
    const [kind, id] = choice.split(":");
    if (kind === "pilot") {
      keep(addPiMember(roster, Number(id)));
    } else if (kind === "squad" && id) {
      keep(addPiMembers(roster, hangar.members[id] ?? []));
    }
    choice = "";
  }

  /** Off the PI list only: nothing is signed in, selected or undocked. */
  function removePilot(characterID: number): void {
    keep(removePiMember(roster, characterID));
    const next = new Map(attempts);
    next.delete(characterID);
    attempts = next;
    const started = new Map(dispatch);
    started.delete(characterID);
    dispatch = started;
  }

  onMount(() => {
    void refresh();
    const tick = setInterval(() => (browserNowMs = Date.now()), 30_000);
    return () => clearInterval(tick);
  });
</script>

<section class="panel pi-manager">
  <header class="panel-head">
    <h2 class="panel-title">Planetary Industry</h2>
    {#if board.staleWords}
      <p class="stat-line">{board.staleWords}</p>
    {/if}
    <span class="controls">
      <button
        type="button"
        disabled={reading || roster.members.length === 0}
        onclick={() => void refresh()}
      >
        {reading ? "Looking..." : "Refresh"}
      </button>
    </span>
  </header>

  <div class="pi-body">
    <!-- THE WINDOW'S OWN MENU. A side rail while the window is wide, a row across
         the top when it is narrow; the same buttons either way. -->
    <nav class="pi-menu" aria-label="Planetary Industry">
      <div role="tablist" class="pi-menu-list">
        {#each menu as item (item.id)}
          <button
            type="button"
            role="tab"
            id="pi-tab-{item.id}"
            class="pi-menu-item"
            class:on={view === item.id}
            aria-selected={view === item.id}
            aria-controls="pi-view-{item.id}"
            onclick={() => (view = item.id)}
          >
            <span>{item.label}</span>
            {#if item.badge > 0}
              <span class="pi-badge" class:urgent={item.urgent}>{item.badge}</span>
            {/if}
          </button>
        {/each}
      </div>
    </nav>

    <div class="pi-views">
      <section
        class="pi-view"
        id="pi-view-colonies"
        role="tabpanel"
        aria-labelledby="pi-tab-colonies"
        hidden={view !== "colonies"}
      >
        {#if roster.members.length === 0}
          <p class="empty">
            No pilots are on planetary industry yet.
            <button type="button" class="pi-link" onclick={() => (view = "pilots")}>Add one under Pilots</button>
          </p>
        {:else if board.emptyWords}
          <p class="empty">{board.emptyWords}</p>
        {/if}

        <!-- ① NEEDS YOU. A list, not a table: it is read top to bottom, worst first,
             and when nothing is waiting the section is simply absent — an empty space
             says it without being read. -->
        {#if board.needsYou.length > 0}
          <section class="pi-section" aria-labelledby="pi-needs-you">
            <h3 id="pi-needs-you">Needs you</h3>
            <ul class="needs-you">
              {#each board.needsYou as item (item.key)}
                <li class:now={item.urgency === "now"} class:soon={item.urgency === "soon"}>
                  <span class="where"><strong>{item.placeWords}</strong> - {item.pilotName}</span>
                  <span class="what">{item.words}</span>
                  <span class="note">{item.readAgeWords}</span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <!-- ② COLONIES, every pilot's, worst first, each with its own age. -->
        {#if board.colonies.length > 0}
          <section class="pi-section" aria-labelledby="pi-colonies">
            <h3 id="pi-colonies">Colonies</h3>
            <div class="table-wrap overflow-x-auto">
              <table class="guests reflow">
                <thead>
                  <tr>
                    <th>Planet</th>
                    <th>Pilot</th>
                    <th>State</th>
                    <th>Read</th>
                  </tr>
                </thead>
                <tbody>
                  {#each board.colonies as row (row.key)}
                    <tr class:now={row.needsYouNow}>
                      <td data-label="Planet">{row.placeWords}</td>
                      <td data-label="Pilot">{row.pilotName}</td>
                      <td data-label="State">{row.stateWords}</td>
                      <td data-label="Read" class="note">{row.readAgeWords}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </section>
        {/if}

      </section>

      <!-- THE ROSTER: who is on planetary industry, and what each read said. The
           per-pilot sentence is where the four outcomes are told apart. -->
      <section
        class="pi-view"
        id="pi-view-pilots"
        role="tabpanel"
        aria-labelledby="pi-tab-pilots"
        hidden={view !== "pilots"}
      >
        <section class="pi-section" aria-labelledby="pi-pilots">
          <h3 id="pi-pilots">Pilots</h3>
          {#if roster.members.length === 0 && board.emptyWords}
            <p class="empty">{board.emptyWords}</p>
          {/if}
          {#if board.pilots.length > 0}
            <div class="table-wrap overflow-x-auto">
              <table class="guests reflow">
                <thead>
                  <tr>
                    <th>Pilot</th>
                    <th>Colonies</th>
                    <th>Read</th>
                    <th><span class="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {#each board.pilots as pilot (pilot.characterID)}
                    <tr>
                      <td data-label="Pilot">
                        {pilot.pilotName}
                        {#if pilot.noteWords}
                          <span class="note pilot-note">{pilot.noteWords}</span>
                        {/if}
                        {#if pilot.botWords}
                          <span class="note pilot-note">{pilot.botWords}</span>
                        {/if}
                        {#if pilot.restart}
                          <!-- What the run does is said BEFORE the button, so the
                               click is the decision; there is no dialog after it. -->
                          <span class="pilot-note pi-dispatch">
                            <span class="note">{pilot.restart.words}</span>
                            <button
                              type="button"
                              disabled={!pilot.restart.enabled}
                              onclick={() => void restartExtractors(pilot.characterID)}
                            >
                              {pilot.restart.label}
                            </button>
                          </span>
                        {/if}
                        {#if pilot.dispatchWords}
                          <span class="note pilot-note" role="status">{pilot.dispatchWords}</span>
                        {/if}
                      </td>
                      <td data-label="Colonies">
                        {pilot.colonyCount === 0 ? "-" : pilot.colonyCount}
                      </td>
                      <td data-label="Read" class="note">{pilot.readAgeWords ?? "-"}</td>
                      <td data-label="">
                        <button
                          type="button"
                          disabled={pilot.busy}
                          onclick={() => removePilot(pilot.characterID)}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}

          {#if addablePilots.length > 0 || squadsWithNewPilots.length > 0}
            <div class="pi-add">
              <label for="pi-add-choice">Add</label>
              <select id="pi-add-choice" bind:value={choice}>
                <option value="">Choose a pilot or a squad</option>
                {#if addablePilots.length > 0}
                  <optgroup label="Pilots">
                    {#each addablePilots as pilot (pilot.characterID)}
                      <option value={`pilot:${pilot.characterID}`}>{pilot.characterName}</option>
                    {/each}
                  </optgroup>
                {/if}
                {#if squadsWithNewPilots.length > 0}
                  <optgroup label="Everyone in a squad">
                    {#each squadsWithNewPilots as squad (squad.id)}
                      <option value={`squad:${squad.id}`}>{squad.name}</option>
                    {/each}
                  </optgroup>
                {/if}
              </select>
              <button type="button" disabled={choice === ""} onclick={add}>Add</button>
            </div>
          {:else if known.length === 0}
            <p class="note">Pilots come from the Pilot hangar. Add an account there first.</p>
          {/if}
        </section>

        <!-- ⚠ SAID, NOT IMPLIED. Reading brings nobody online. Acting does, and only
             through the server bot host, which refuses a pilot already flown from
             this site or by another bot — so that refusal, not a promise from this
             window, is what keeps a ship from being taken. -->
        <p class="note">
          Colonies are read without bringing any pilot online. A restart runs on the
          server, which will not take a pilot already flown from this site or by
          another bot; if it refuses, its reason is shown on that pilot's row.
        </p>
      </section>

      <!-- ④ THE PLANNER (R108 slice 5) is not built. Its place in the menu is, so
           the view says so plainly rather than pretending to plan. -->
      <section
        class="pi-view"
        id="pi-view-planner"
        role="tabpanel"
        aria-labelledby="pi-tab-planner"
        hidden={view !== "planner"}
      >
        <section class="pi-section" aria-labelledby="pi-planner">
          <h3 id="pi-planner">Planner</h3>
          <p class="empty">The planner is not built yet.</p>
          <p class="note">
            It will take something to make and how much, and work out whether your
            colonies and what you hold can make it, and what is missing if not.
          </p>
        </section>
      </section>
    </div>
  </div>
</section>

<style>
  .pi-body {
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr);
    gap: 1rem;
    margin-top: 0.75rem;
  }
  .pi-menu-list {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--color-line);
    height: 100%;
  }
  /* ⚠ NOT `class:active` — a bare `button.active` is a filled accent control
   * in the app's component layer (see StationPanel's tabs). */
  .pi-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 40px;
    padding: 0 0.75rem;
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    color: var(--color-muted);
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .pi-menu-item:hover:not(.on) {
    color: var(--color-text-bright);
    background: var(--color-panel-3);
  }
  .pi-menu-item.on {
    color: var(--color-text-bright);
    border-left-color: var(--color-accent);
    background: var(--color-panel-3);
  }
  .pi-badge {
    min-width: 1.4rem;
    padding: 0 0.35rem;
    border: 1px solid var(--color-warn);
    color: var(--color-warn);
    font-size: 11px;
    text-align: center;
  }
  .pi-badge.urgent {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }
  .pi-view > :first-child,
  .pi-view > .pi-section:first-of-type {
    margin-top: 0;
  }
  .pi-link {
    background: none;
    border: 0;
    padding: 0;
    min-height: 0;
    color: var(--color-accent);
    text-decoration: underline;
    cursor: pointer;
  }
  .pi-section {
    margin-top: 0.75rem;
  }
  .pi-section h3 {
    margin: 0 0 0.35rem;
    font-size: 0.95rem;
  }
  .needs-you {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.35rem;
  }
  .needs-you li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    padding: 0.35rem 0.5rem;
    border-left: 3px solid var(--color-line);
    background: var(--color-panel-3);
  }
  .needs-you li.now {
    border-left-color: var(--color-danger);
  }
  .needs-you li.soon {
    border-left-color: var(--color-warn);
  }
  tr.now td:first-child {
    box-shadow: inset 3px 0 0 var(--color-danger);
  }
  .pilot-note {
    display: block;
  }
  .pi-dispatch {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0.75rem;
    margin-top: 0.35rem;
  }
  .pi-dispatch button {
    min-height: 40px;
  }
  .pi-add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .pi-add select {
    flex: 1 1 14rem;
    min-height: 40px;
  }
  .pi-add button,
  td button {
    min-height: 40px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @container (max-width: 640px) {
    .pi-add button {
      width: 100%;
    }
    /* Too narrow for a rail: the menu becomes a row across the top. */
    .pi-body {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.5rem;
    }
    .pi-menu-list {
      flex-direction: row;
      flex-wrap: wrap;
      border-right: 0;
      border-bottom: 1px solid var(--color-line);
    }
    .pi-menu-item {
      border-left: 0;
      border-bottom: 2px solid transparent;
    }
    .pi-menu-item.on {
      border-bottom-color: var(--color-accent);
    }
  }
</style>
