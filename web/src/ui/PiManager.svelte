<script lang="ts">
  // PLANETARY INDUSTRY (R108 slices 3 to 5) — every assigned pilot's colonies
  // on one board, one action (restarting a pilot's ended extractors), what is
  // held across colonies, hangars and corp hangars, and the planner.
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
  import { commodityName, decodeRecipeBook, madeThings, tierOf, type PiRecipeBook, type PiTier } from "../bridge/piRecipes.ts";
  import {
    countWords,
    holdingAgeWords,
    holdingsFromCorpReads,
    holdingsFromReadings,
    isPlayerCorporation,
    stockByTier,
    stockLines,
    stockSources,
    stockSummary,
    tierTag,
    type CorpStockRead,
  } from "../bridge/piStock.ts";
  import { missingByTier, planWithStock, type PlanNode, type PlannerColony } from "../bridge/piPlanner.ts";
  import { readCorpStock, type OnlinePilot } from "../app/piCorpRead.ts";
  import type { Session } from "../app/sessions.ts";
  import TypeIcon from "./TypeIcon.svelte";

  // ⚠ THE SESSIONS ARE FOR CORP HANGARS ONLY. Corp-owned goods are in no
  // pilot's snapshot, so they are read through a pilot of that corporation who
  // is already online in this tab, on that pilot's own session
  // (app/piCorpRead.ts). Nothing here selects, signs in or brings anyone online.
  let { sessions = [] }: { sessions?: readonly Session[] } = $props();

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
  type View = "colonies" | "stock" | "planner" | "pilots";
  let view = $state<View>(loadPiRoster().members.length === 0 ? "pilots" : "colonies");

  // What each corporation's hangars said at the last Refresh (R108 slice 5).
  let corpReads = $state<CorpStockRead[]>([]);
  // The Stock view's own controls. Opening a row shows where every unit is.
  let stockTier = $state<PiTier | "all">("all");
  let stockSearch = $state("");
  let stockOpen = $state<Set<number>>(new Set());
  // The planner's form, and the request its Plan button last made. The plan is
  // derived from the request and the stock as it stands, so a Refresh re-plans.
  let planTarget = $state("");
  let planQuantity = $state("");
  let planError = $state<string | null>(null);
  let planRequest = $state<{ typeID: number; quantity: number } | null>(null);
  // Which tree nodes the player opened; the tree starts folded, because the
  // missing summary above it is what to read first. And which nodes show where
  // their stock is.
  let treeOverride = $state<Map<string, boolean>>(new Map());
  let placesOpen = $state<Set<string>>(new Set());

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
    { id: "stock", label: "Stock", badge: 0, urgent: false },
    { id: "planner", label: "Planner", badge: 0, urgent: false },
    {
      id: "pilots",
      label: "Pilots",
      badge: board.pilots.filter((pilot) => pilot.restart?.enabled).length,
      urgent: false,
    },
  ]);

  // ③ WHAT YOU HOLD. `readings` is already the roster's own pilots only
  // (piReadings), so a removed pilot's goods leave the totals with it.
  const memberReadings = $derived(readings);
  const holdings = $derived([
    ...holdingsFromReadings(memberReadings, names),
    ...holdingsFromCorpReads(corpReads, recipes),
  ]);
  const lines = $derived(stockLines(holdings, recipes));
  const summary = $derived(stockSummary(lines));
  const sources = $derived(
    stockSources({ members: roster.members, readings: memberReadings, names, corpReads, browserNowMs }),
  );
  const shownGroups = $derived(
    stockByTier(
      lines.filter((line) =>
        (stockTier === "all" || line.tier === stockTier)
        && line.typeName.toLowerCase().includes(stockSearch.trim().toLowerCase())),
    ),
  );
  const corpWords = $derived.by(() => {
    const read = corpReads.filter((corp) => corp.state === "read").length;
    if (corpReads.length === 0) return "-";
    return read === corpReads.length ? countWords(summary.inCorp) : `${read} of ${corpReads.length} read`;
  });

  function toggle(set: Set<number>, typeID: number): Set<number> {
    const next = new Set(set);
    if (next.has(typeID)) next.delete(typeID);
    else next.add(typeID);
    return next;
  }

  // ④ THE PLANNER.
  // Everything a factory makes, grouped by tier for the picker. A recipe the
  // book does not classify still appears, under Other, rather than vanishing.
  const targetGroups = $derived.by(() => {
    const book = recipes;
    if (!book) return [];
    const groups = new Map<string, { label: string; rows: { typeID: number; name: string }[] }>();
    for (const row of madeThings(book)) {
      const tier = tierOf(book, row.output.typeID);
      const label = tier === null ? "Other" : `P${tier}`;
      const group = groups.get(label) ?? { label, rows: [] };
      group.rows.push({ typeID: row.output.typeID, name: commodityName(book, row.output.typeID) ?? row.name });
      groups.set(label, group);
    }
    return [...groups.values()];
  });
  const plannerColonies = $derived<PlannerColony[]>(
    [...memberReadings.values()].flatMap((reading) =>
      reading.report.colonies.map((colony) => ({ colony, clockOffsetMs: reading.report.clockOffsetMs }))),
  );
  const plan = $derived(
    planRequest && recipes?.readable
      ? planWithStock({
          book: recipes,
          targetTypeID: planRequest.typeID,
          quantity: planRequest.quantity,
          holdings,
          colonies: plannerColonies,
          browserNowMs,
        })
      : null,
  );

  const missing = $derived(plan ? missingByTier(plan) : []);

  function isTreeOpen(key: string): boolean {
    return treeOverride.get(key) ?? false;
  }

  function toggleTree(key: string): void {
    const next = new Map(treeOverride);
    next.set(key, !isTreeOpen(key));
    treeOverride = next;
  }

  function toggleKey(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  function submitPlan(): void {
    const typeID = Number(planTarget);
    const quantity = Number(planQuantity.replace(/,/g, "").trim());
    if (!Number.isSafeInteger(typeID) || typeID <= 0) {
      planError = "Choose something to make.";
    } else if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      planError = "Enter how many, as a whole number.";
    } else {
      planError = null;
      treeOverride = new Map();
      placesOpen = new Set();
      planRequest = { typeID, quantity };
    }
  }

  /** Pilots online in this tab, read at call time, for the corp hangar read. */
  function onlinePilots(): OnlinePilot[] {
    const pilots: OnlinePilot[] = [];
    for (const session of sessions) {
      const online = session.store.station.get().online;
      if (!online) continue;
      pilots.push({
        characterID: online.characterID,
        corporationID: online.corporationID,
        options: session.flow.requestOptions(),
      });
    }
    return pilots;
  }

  async function refreshCorpStock(): Promise<void> {
    const online = onlinePilots();
    const corporations = [
      ...[...piReadings(roster).values()].map((reading) => reading.corporationID ?? null),
      ...online.map((pilot) => pilot.corporationID),
    ].filter(isPlayerCorporation);
    try {
      corpReads = await readCorpStock(corporations, online);
    } catch {
      // Each corp's outcome is caught inside the read; keep the last answer.
    }
  }
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
      // After the roster, because it names each pilot's corporation.
      await refreshCorpStock();
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

        {#if board.colonies.length > 0}
          <!-- THE STRIP: the whole estate in four numbers, before any row. -->
          <dl class="pi-summary">
            <div>
              <dt>Colonies</dt>
              <dd>{board.summary.colonies}</dd>
            </div>
            <div>
              <dt>Extracting</dt>
              <dd class="good">{board.summary.extracting}</dd>
            </div>
            <div>
              <dt>Need you now</dt>
              <dd class:bad={board.summary.needYouNow > 0}>{board.summary.needYouNow}</dd>
            </div>
            <div>
              <dt>Next program ends</dt>
              <dd>{board.summary.nextEndsWords ?? "-"}</dd>
            </div>
          </dl>

          <!-- ② COLONIES BY PILOT. One reading per pilot, so its age is said
               once, on the pilot's line, and is true of every row under it.
               What needs you is said ON the colony's row, worst first — there
               is no second list to keep in step with this one. -->
          {#each board.groups as group (group.characterID)}
            <section class="pi-group" aria-label={`${group.pilotName}'s colonies`}>
              <header class="pi-group-head">
                <h3>{group.pilotName} <span class="note">- {group.countWords}</span></h3>
                <span class="note">{group.readAgeWords}</span>
              </header>
              <ul class="pi-colonies">
                {#each group.rows as row (row.key)}
                  <li class="pi-colony tone-{row.tone}">
                    <span class="pi-colony-place">
                      <TypeIcon typeID={row.planetTypeID} name={row.kindWords} size="md" />
                      <span>
                        <span class="pi-colony-name">{row.placeWords}</span>
                        <span class="note">{row.kindWords}</span>
                      </span>
                    </span>
                    <span class="pi-colony-resources">
                      {#each row.resources as resource (resource)}
                        <span class="pi-chip">{resource}</span>
                      {/each}
                    </span>
                    <span class="pi-colony-program">
                      {#if row.program}
                        <span class="pi-bar" aria-hidden="true">
                          <span class="pi-bar-fill program" class:ended={row.program.ended} style:width={`${row.program.fraction * 100}%`}></span>
                        </span>
                      {/if}
                      <span class="pi-status">{row.statusWords}</span>
                    </span>
                    <span class="pi-colony-storage">
                      {#if row.storage}
                        <span class="pi-bar" aria-hidden="true">
                          <span class="pi-bar-fill storage" class:high={row.storage.high} style:width={`${row.storage.fraction * 100}%`}></span>
                        </span>
                        <span class="note" class:warn={row.storage.high}>{row.storage.words}</span>
                      {/if}
                    </span>
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
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

      <!-- ③ WHAT YOU HOLD (R108 slice 5). One line per commodity; colony stock is
           its own column because it is already where it is needed. Opening a
           line lists every place it sits, whose it is and when it was read. -->
      <section
        class="pi-view"
        id="pi-view-stock"
        role="tabpanel"
        aria-labelledby="pi-tab-stock"
        hidden={view !== "stock"}
      >
        {#if roster.members.length === 0}
          <p class="empty">
            No pilots are on planetary industry yet.
            <button type="button" class="pi-link" onclick={() => (view = "pilots")}>Add one under Pilots</button>
          </p>
        {:else}
          <dl class="pi-summary">
            <div>
              <dt>Kinds held</dt>
              <dd>{summary.kinds}</dd>
            </div>
            <div>
              <dt>In colonies</dt>
              <dd>{countWords(summary.inColonies)}</dd>
            </div>
            <div>
              <dt>In hangars</dt>
              <dd>{countWords(summary.inHangars)}</dd>
            </div>
            <div>
              <dt>Corp hangars</dt>
              <dd class:warn={corpReads.some((corp) => corp.state !== "read")}>{corpWords}</dd>
            </div>
          </dl>

          <div class="pi-filter">
            <div class="pi-tiers" role="group" aria-label="Tier">
              {#each ["all", 0, 1, 2, 3, 4] as const as tier (tier)}
                <button
                  type="button"
                  class="pi-tier"
                  class:on={stockTier === tier}
                  aria-pressed={stockTier === tier}
                  onclick={() => (stockTier = tier)}
                >
                  {tier === "all" ? "All" : tier === 0 ? "Raw" : `P${tier}`}
                </button>
              {/each}
            </div>
            <input
              type="search"
              class="pi-search"
              placeholder="Find a commodity"
              aria-label="Find a commodity"
              bind:value={stockSearch}
            />
          </div>

          {#if lines.length === 0}
            <p class="empty">
              {reading ? "Reading what you hold..." : "Nothing planetary is held anywhere that was read."}
            </p>
          {:else if shownGroups.length === 0}
            <p class="empty">Nothing held matches that.</p>
          {:else}
            <div class="table-wrap overflow-x-auto">
              <table class="pi-table">
                <thead>
                  <tr>
                    <th>Commodity</th>
                    <th class="num">In colonies</th>
                    <th class="num">In hangars</th>
                    <th class="num">Corp</th>
                    <th class="num">Total</th>
                  </tr>
                </thead>
                {#each shownGroups as group (group.label)}
                  <tbody>
                    <tr class="pi-tier-head">
                      <th colspan="5" scope="rowgroup">{group.label}</th>
                    </tr>
                    {#each group.lines as line (line.typeID)}
                      <tr>
                        <td>
                          <button
                            type="button"
                            class="pi-open"
                            aria-expanded={stockOpen.has(line.typeID)}
                            onclick={() => (stockOpen = toggle(stockOpen, line.typeID))}
                          >
                            <span class="pi-caret" aria-hidden="true">{stockOpen.has(line.typeID) ? "v" : ">"}</span>
                            <TypeIcon typeID={line.typeID} name={line.typeName} />
                            <span>{line.typeName}</span>
                          </button>
                        </td>
                        <td class="num">{line.inColonies > 0 ? countWords(line.inColonies) : "-"}</td>
                        <td class="num">{line.inHangars > 0 ? countWords(line.inHangars) : "-"}</td>
                        <td class="num">{line.inCorp > 0 ? countWords(line.inCorp) : "-"}</td>
                        <td class="num">{countWords(line.total)}</td>
                      </tr>
                      {#if stockOpen.has(line.typeID)}
                        <tr class="pi-where">
                          <td colspan="5">
                            <ul>
                              {#each line.holdings as holding, index (index)}
                                <li>
                                  <span class="pi-source">{holding.source}</span>
                                  {countWords(holding.quantity)} - {holding.placeWords} - {holding.ownerWords}
                                  <span class="note">- {holdingAgeWords(holding, browserNowMs)}</span>
                                </li>
                              {/each}
                            </ul>
                          </td>
                        </tr>
                      {/if}
                    {/each}
                  </tbody>
                {/each}
              </table>
            </div>
          {/if}

          {#if sources.length > 0}
            <section class="pi-section" aria-labelledby="pi-sources">
              <h3 id="pi-sources">Where this came from</h3>
              <ul class="pi-sources">
                {#each sources as source, index (index)}
                  <li class="note" class:warn={source.warn}>{source.words}</li>
                {/each}
              </ul>
            </section>
          {/if}
        {/if}
      </section>

      <!-- ④ THE PLANNER (R108 slice 5). Something to make and how many; the
           verdict, the gaps in the order worth telling, then the chain. Every
           number is recipe arithmetic or a server-stated fact. -->
      <section
        class="pi-view"
        id="pi-view-planner"
        role="tabpanel"
        aria-labelledby="pi-tab-planner"
        hidden={view !== "planner"}
      >
        {#if !recipes?.readable}
          <p class="empty">
            {reading ? "Reading the recipe table..." : "The recipe table has not been read yet. Refresh reads it."}
          </p>
        {:else}
          <form
            class="pi-plan-form"
            onsubmit={(event) => {
              event.preventDefault();
              submitPlan();
            }}
          >
            <label for="pi-plan-quantity">Make</label>
            <input
              id="pi-plan-quantity"
              class="pi-plan-quantity"
              inputmode="numeric"
              placeholder="20"
              bind:value={planQuantity}
              oninput={() => (planError = null)}
            />
            <select
              class="pi-plan-target"
              aria-label="What to make"
              bind:value={planTarget}
              onchange={() => (planError = null)}
            >
              <option value="">Choose a commodity</option>
              {#each targetGroups as group (group.label)}
                <optgroup label={group.label}>
                  {#each group.rows as row (row.typeID)}
                    <option value={String(row.typeID)}>{row.name}</option>
                  {/each}
                </optgroup>
              {/each}
            </select>
            <button type="submit">Plan</button>
          </form>
          {#if planError}
            <p class="pi-plan-error" role="alert">{planError}</p>
          {/if}

          <!-- THE CHAIN AS A TREE. Colour, a bar and short tags say how each step
               stands; the sentence behind a tag is its hover title. A step with
               inputs folds; while folded, one dot per input says how that input
               stands, so a green step hiding a red input still shows it. -->
          {#snippet planNode(node: PlanNode)}
            {@const row = node.row}
            {@const open = node.children.length > 0 && isTreeOpen(node.key)}
            <li role="treeitem" aria-selected="false" aria-expanded={node.children.length > 0 ? open : undefined}>
              <div class="pi-node state-{row.state}">
                {#if node.children.length > 0}
                  <button type="button" class="pi-node-name" onclick={() => toggleTree(node.key)}>
                    <span class="pi-chevron" aria-hidden="true">{open ? "v" : ">"}</span>
                    <TypeIcon typeID={row.typeID} name={row.typeName} />
                    <span>{row.typeName}</span>
                    {#if tierTag(row.tier)}<span class="pi-chip">{tierTag(row.tier)}</span>{/if}
                    {#if !open}
                      <span class="pi-dots" aria-hidden="true">
                        {#each node.children as child (child.key)}
                          <span class="pi-dot state-{child.worst}"></span>
                        {/each}
                      </span>
                    {/if}
                  </button>
                {:else}
                  <span class="pi-node-name">
                    <span class="pi-chevron" aria-hidden="true"></span>
                    <TypeIcon typeID={row.typeID} name={row.typeName} />
                    <span>{row.typeName}</span>
                    {#if tierTag(row.tier)}<span class="pi-chip">{tierTag(row.tier)}</span>{/if}
                  </span>
                {/if}
                <span class="pi-tags">
                  {#if node.repeat}
                    <span class="pi-tag" title="Drawn in full above">above</span>
                  {:else}
                    {#each row.tags as tag, index (index)}
                      <span class="pi-tag" class:act={tag.tone === "act"} class:bad={tag.tone === "bad"} title={tag.title}>{tag.text}</span>
                    {/each}
                  {/if}
                </span>
                <span class="pi-cover">
                  <span class="pi-bar" aria-hidden="true">
                    <span class="pi-bar-fill held" style:width={`${Math.min(1, row.held / row.needed) * 100}%`}></span>
                  </span>
                  <span class="pi-cover-nums">
                    {#if row.holdings.length > 0}
                      <button
                        type="button"
                        class="pi-held"
                        aria-expanded={placesOpen.has(node.key)}
                        title="Where it is"
                        onclick={() => (placesOpen = toggleKey(placesOpen, node.key))}
                      >{countWords(row.held)}</button>
                    {:else}
                      {countWords(row.held)}
                    {/if}
                    / {countWords(row.needed)}
                  </span>
                </span>
              </div>
              {#if placesOpen.has(node.key)}
                <ul class="pi-places">
                  {#each row.holdings as holding, index (index)}
                    <li title={`${holding.ownerWords} - ${holdingAgeWords(holding, browserNowMs)}`}>
                      <span class="pi-source">{holding.source}</span>{countWords(holding.quantity)} {holding.placeWords}
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if open}
                <ul class="pi-tree-kids" role="group">
                  {#each node.children as child (child.key)}
                    {@render planNode(child)}
                  {/each}
                </ul>
              {/if}
            </li>
          {/snippet}

          {#if plan && planRequest}
            <p class="pi-plan-head">
              <span>{countWords(planRequest.quantity)} {plan.tree.row.typeName}</span>
              <span class="pi-tag" class:bad={plan.gaps.length > 0} class:ok={plan.gaps.length === 0} title={plan.verdict}>
                {plan.gaps.length > 0 ? `${plan.gaps.length} blocked` : "covered"}
              </span>
            </p>
            <!-- WHAT IS MISSING, by tier from the ground up: raw first, because an
                 extractor feeds everything above it. Blocked steps lead each tier. -->
            {#if missing.length > 0}
              <div class="pi-missing" aria-label="Missing">
                {#each missing as group (group.tier)}
                  <div class="pi-missing-tier">
                    <h3>{tierTag(group.tier) ?? "other"}</h3>
                    <ul>
                      {#each group.rows as row (row.typeID)}
                        <li class="pi-missing-row state-{row.state}">
                          <TypeIcon typeID={row.typeID} name={row.typeName} />
                          <span class="pi-missing-name">{row.typeName}</span>
                          <span class="pi-missing-count" title={`${countWords(row.held)} held of ${countWords(row.needed)}`}>{countWords(row.toMake)} missing</span>
                          <span class="pi-tags">
                            {#each row.tags as tag, index (index)}
                              <span class="pi-tag" class:act={tag.tone === "act"} class:bad={tag.tone === "bad"} title={tag.title}>{tag.text}</span>
                            {/each}
                          </span>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/each}
              </div>
            {/if}
            <ul class="pi-tree" role="tree" aria-label={plan.verdict}>
              {@render planNode(plan.tree)}
            </ul>
          {/if}
        {/if}
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
  /* ⚠ ONE FRAME, THE WINDOW'S. The app styles every `section` as a framed
   * panel, so this window came out as box in box in box. Its own sections are
   * headings and rules, not cards — the same reset StationPanel makes. A
   * scoped rule is unlayered, so it outranks the components layer outright. */
  .pi-manager,
  .pi-manager section {
    border: 0;
    background: none;
    margin: 0;
    padding: 0;
  }
  .pi-manager::before,
  .pi-manager section::before {
    content: none;
  }

  .pi-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .pi-summary dt {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .pi-summary dd {
    margin: 0;
    font-size: 1.35rem;
    color: var(--color-text-bright);
    font-variant-numeric: tabular-nums;
  }
  .pi-summary dd.good {
    color: var(--color-good);
  }
  .pi-summary dd.bad {
    color: var(--color-danger);
  }

  .pi-group + .pi-group {
    margin-top: 1rem;
  }
  .pi-group-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.25rem 1rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--color-line-strong);
  }
  .pi-group-head h3 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--color-text-bright);
  }
  .pi-colonies {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-colony {
    display: grid;
    grid-template-columns: minmax(11rem, 1.5fr) minmax(8rem, 1.3fr) minmax(9rem, 1.6fr) minmax(7rem, 0.9fr);
    gap: 0.5rem 1rem;
    align-items: center;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-row-line);
    border-left: 3px solid var(--color-good);
  }
  .pi-colony.tone-soon {
    border-left-color: var(--color-warn);
  }
  .pi-colony.tone-stopped {
    border-left-color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 7%, transparent);
  }
  .pi-colony-place {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
  }
  .pi-colony-place > span:last-child {
    display: grid;
    min-width: 0;
  }
  .pi-colony-name {
    color: var(--color-text-bright);
  }
  .pi-colony-resources {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .pi-chip {
    font-size: 11px;
    padding: 0 0.4rem;
    border: 1px solid var(--color-line-strong);
    color: var(--color-cell);
    white-space: nowrap;
  }
  .pi-colony-program,
  .pi-colony-storage {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }
  .pi-bar {
    display: block;
    height: 4px;
    background: var(--color-line);
  }
  .pi-bar-fill {
    display: block;
    height: 100%;
  }
  .pi-bar-fill.program {
    background: var(--color-good);
  }
  .pi-bar-fill.program.ended {
    background: var(--color-danger);
  }
  .pi-bar-fill.storage {
    background: var(--color-accent);
  }
  .pi-bar-fill.storage.high {
    background: var(--color-warn);
  }
  .pi-status {
    font-size: 0.85rem;
    color: var(--color-muted);
  }
  .tone-stopped .pi-status {
    color: var(--color-danger);
  }
  .tone-soon .pi-status {
    color: var(--color-warn);
  }
  .note.warn {
    color: var(--color-warn);
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
  .pi-summary dd.warn {
    color: var(--color-warn);
  }
  .pi-filter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    margin-bottom: 0.5rem;
  }
  .pi-tiers {
    display: flex;
    gap: 0.25rem;
  }
  .pi-tier {
    min-height: 32px;
    padding: 0 0.6rem;
    background: transparent;
    border: 1px solid var(--color-line);
    color: var(--color-muted);
  }
  .pi-tier.on {
    border-color: var(--color-accent);
    color: var(--color-text-bright);
  }
  .pi-search {
    margin-left: auto;
    min-height: 32px;
    flex: 0 1 14rem;
  }
  .pi-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .pi-table th,
  .pi-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--color-row-line);
    text-align: left;
    vertical-align: top;
  }
  .pi-table th {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    font-weight: 500;
  }
  .pi-table .num {
    text-align: right;
    white-space: nowrap;
  }
  .pi-table td.good {
    color: var(--color-good);
  }
  .pi-table td.bad {
    color: var(--color-danger);
  }
  .pi-tier-head th {
    padding-top: 0.75rem;
    border-bottom-color: var(--color-line-strong);
    color: var(--color-text-bright);
  }
  .pi-open {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 0;
    padding: 0;
    background: none;
    border: 0;
    color: var(--color-text-bright);
    text-align: left;
    cursor: pointer;
  }
  .pi-caret {
    display: inline-block;
    width: 0.8rem;
    color: var(--color-muted);
    font-size: 11px;
  }
  .pi-where td {
    padding-left: 2rem;
    background: var(--color-panel-3);
  }
  .pi-where ul,
  .pi-sources {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-where li {
    padding: 0.15rem 0;
    font-size: 0.85rem;
  }
  .pi-source {
    display: inline-block;
    min-width: 4rem;
    margin-right: 0.4rem;
    padding: 0 0.3rem;
    border: 1px solid var(--color-line-strong);
    font-size: 11px;
    text-align: center;
    color: var(--color-cell);
  }
  .pi-sources li {
    padding: 0.1rem 0;
  }
  .pi-plan-form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .pi-plan-form input,
  .pi-plan-form select,
  .pi-plan-form button {
    min-height: 40px;
  }
  .pi-plan-quantity {
    width: 5.5rem;
  }
  .pi-plan-target {
    flex: 1 1 14rem;
  }
  .pi-plan-error {
    margin: 0.35rem 0 0;
    color: var(--color-danger);
    font-size: 0.85rem;
  }
  .pi-plan-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 1rem 0 0.5rem;
    font-size: 1.05rem;
    color: var(--color-text-bright);
  }
  .pi-missing {
    display: grid;
    gap: 0.6rem;
    margin: 0 0 1rem;
  }
  .pi-missing-tier h3 {
    margin: 0 0 0.25rem;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .pi-missing-tier ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-missing-row {
    display: grid;
    grid-template-columns: auto minmax(9rem, 14rem) 8rem minmax(0, 1fr);
    gap: 0.5rem;
    align-items: center;
    padding: 0.2rem 0.6rem;
    border-left: 3px solid var(--color-good);
  }
  .pi-missing-row.state-act {
    border-left-color: var(--color-warn);
  }
  .pi-missing-row.state-bad {
    border-left-color: var(--color-danger);
  }
  .pi-missing-name {
    color: var(--color-text-bright);
  }
  .pi-missing-count {
    font-size: 12px;
    color: var(--color-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .pi-tree,
  .pi-tree-kids,
  .pi-places {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-tree-kids {
    margin-left: 0.9rem;
    padding-left: 0.8rem;
    border-left: 1px dashed var(--color-line-strong);
  }
  .pi-node {
    display: grid;
    grid-template-columns: minmax(12rem, 1.2fr) minmax(0, 1.4fr) 9rem;
    gap: 0.75rem;
    align-items: center;
    margin: 0.3rem 0;
    padding: 0.4rem 0.6rem;
    background: var(--color-panel-3);
    border-left: 3px solid var(--color-good);
  }
  .pi-node.state-act {
    border-left-color: var(--color-warn);
  }
  .pi-node.state-bad {
    border-left-color: var(--color-danger);
  }
  .pi-node-name {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    min-height: 0;
    padding: 0;
    background: none;
    border: 0;
    color: var(--color-text-bright);
    text-align: left;
  }
  button.pi-node-name {
    cursor: pointer;
  }
  .pi-chevron {
    display: inline-block;
    width: 0.8rem;
    color: var(--color-muted);
    font-size: 11px;
  }
  .pi-dots {
    display: inline-flex;
    gap: 3px;
    margin-left: 0.2rem;
  }
  .pi-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-good);
  }
  .pi-dot.state-act {
    background: var(--color-warn);
  }
  .pi-dot.state-bad {
    background: var(--color-danger);
  }
  .pi-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .pi-tag {
    font-size: 11px;
    padding: 0 0.4rem;
    border: 1px solid var(--color-line-strong);
    color: var(--color-cell);
    white-space: nowrap;
  }
  .pi-tag.act {
    border-color: var(--color-warn);
    color: var(--color-warn);
  }
  .pi-tag.bad {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }
  .pi-tag.ok {
    border-color: var(--color-good);
    color: var(--color-good);
  }
  .pi-cover {
    display: grid;
    gap: 0.2rem;
  }
  .pi-bar-fill.held {
    background: var(--color-good);
  }
  .pi-cover-nums {
    font-size: 11px;
    color: var(--color-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .pi-held {
    min-height: 0;
    padding: 0;
    background: none;
    border: 0;
    color: var(--color-text-bright);
    font: inherit;
    text-decoration: underline dotted;
    cursor: pointer;
  }
  .pi-places {
    margin: 0 0 0.3rem 2.2rem;
    font-size: 0.85rem;
  }
  .pi-places li {
    padding: 0.1rem 0;
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
    .pi-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .pi-search {
      margin-left: 0;
      flex: 1 1 100%;
    }
    .pi-node {
      grid-template-columns: minmax(0, 1fr);
    }
    /* A colony becomes a small card: place and resources, then the bars. */
    .pi-colony {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
