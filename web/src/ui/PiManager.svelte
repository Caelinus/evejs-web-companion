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
  import { missingByTier, planStepCounts, planWithStock, type PlanNode, type PlannerColony } from "../bridge/piPlanner.ts";
  import { readCorpStock, type OnlinePilot } from "../app/piCorpRead.ts";
  import {
    createPiPlan,
    deletePiPlan,
    loadPiPlans,
    updatePiPlan,
    withPlan,
    withoutPlan,
    type SavedPiPlan,
  } from "../app/piPlans.ts";
  import {
    loadPiPlanView,
    prunePiPlanView,
    savePiPlanView,
    withOpenNodes,
    withOpenPlan,
    type PiPlanView,
  } from "../app/piPlanView.ts";
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
  // SAVED PLANS (app/piPlans.ts). The rows live on the server; which one was
  // open and how its tree was unfolded live in this browser (app/piPlanView.ts).
  // Every Plan press saves, so there is no Save button to forget.
  let plans = $state<SavedPiPlan[]>([]);
  let plansLoaded = $state(false);
  let plansError = $state<string | null>(null);
  let planSaving = $state(false);
  let planNote = $state("");
  let planView = $state<PiPlanView>(loadPiPlanView());

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
    const openID = planView.openID;
    if (openID !== null) {
      const keys = [...next].filter(([, open]) => open).map(([nodeKey]) => nodeKey);
      keepView(withOpenNodes(planView, openID, keys));
    }
  }

  // ④ SAVED PLANS.
  const openPlan = $derived(plans.find((entry) => entry.planID === planView.openID) ?? null);
  const activePlans = $derived(plans.filter((entry) => entry.status === "active"));
  const donePlans = $derived(plans.filter((entry) => entry.status === "done"));
  // Each plan's standing, worked out now from the stock as it stands -- the
  // same planner the open plan uses, never a stored verdict.
  const planStanding = $derived.by(() => {
    const out = new Map<string, PlanStanding>();
    const book = recipes;
    if (!book?.readable) return out;
    for (const entry of plans) {
      out.set(entry.planID, standingOf(planWithStock({
        book,
        targetTypeID: entry.typeID,
        quantity: entry.quantity,
        holdings,
        colonies: plannerColonies,
        browserNowMs,
      })));
    }
    return out;
  });
  // The open plan's own counts, for the summary above its missing list.
  const openCounts = $derived(plan ? planStepCounts(plan) : null);

  interface PlanStanding {
    readonly words: string;
    readonly tone: "ok" | "act" | "bad";
    readonly title: string;
    /** Share of steps already covered, 0 to 1, for the bar. */
    readonly share: number;
  }

  function standingOf(result: ReturnType<typeof planWithStock>): PlanStanding {
    if (result === null) {
      return { words: "unknown", tone: "bad", title: "The recipe table has no way to make this.", share: 0 };
    }
    const counts = planStepCounts(result);
    const share = counts.steps > 0 ? counts.ok / counts.steps : 1;
    const title = `${counts.ok} of ${counts.steps} steps covered. ${result.verdict}`;
    if (result.gaps.length > 0) return { words: `${result.gaps.length} blocked`, tone: "bad", title, share };
    if (counts.act > 0) return { words: `${counts.act} to change`, tone: "act", title, share };
    return { words: "covered", tone: "ok", title, share };
  }

  function planName(typeID: number): string {
    return (recipes ? commodityName(recipes, typeID) : null) ?? `Commodity ${typeID}`;
  }

  /** Change the open plan's quantity: planned at once, saved behind it. */
  function commitQuantity(): void {
    const quantity = Number(planQuantity.replace(/,/g, "").trim());
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      planError = "Enter how many, as a whole number.";
      return;
    }
    planError = null;
    if (planRequest === null || planRequest.quantity === quantity) return;
    planRequest = { ...planRequest, quantity };
    if (openPlan !== null) void changePlan(openPlan, { quantity });
  }

  function commitNote(): void {
    const note = planNote.trim();
    if (openPlan !== null && openPlan.note !== note) void changePlan(openPlan, { note });
  }

  function keepView(next: PiPlanView): void {
    planView = next;
    savePiPlanView(next);
  }

  /** The accounts a plan call may sign in with: the roster's own first. */
  function planAccounts(): string[] {
    const byCharacter = new Map(known.map((pilot) => [pilot.characterID, pilot.accountName]));
    const first = roster.members.map((id) => byCharacter.get(id)).filter((name): name is string => !!name);
    return [...first, ...known.map((pilot) => pilot.accountName)];
  }

  function showPlan(entry: SavedPiPlan | null): void {
    planError = null;
    placesOpen = new Set();
    if (entry === null) {
      planTarget = "";
      planQuantity = "";
      planNote = "";
      planRequest = null;
      treeOverride = new Map();
      keepView(withOpenPlan(planView, null));
      return;
    }
    planTarget = String(entry.typeID);
    planQuantity = String(entry.quantity);
    planNote = entry.note;
    planRequest = { typeID: entry.typeID, quantity: entry.quantity };
    treeOverride = new Map((planView.openNodes[entry.planID] ?? []).map((key) => [key, true]));
    keepView(withOpenPlan(planView, entry.planID));
  }

  async function loadPlans(): Promise<void> {
    try {
      plans = await loadPiPlans(planAccounts());
      plansError = null;
      plansLoaded = true;
      keepView(prunePiPlanView(planView, plans.map((entry) => entry.planID)));
      // Where you left off: the plan that was open, unless the form moved on.
      if (planRequest === null && openPlan !== null) showPlan(openPlan);
    } catch (error) {
      plansError = error instanceof Error ? error.message : String(error);
    }
  }

  async function changePlan(entry: SavedPiPlan, fields: Parameters<typeof updatePiPlan>[2]): Promise<void> {
    planSaving = true;
    try {
      plans = withPlan(plans, await updatePiPlan(planAccounts(), entry, fields));
      plansError = null;
    } catch (error) {
      plansError = error instanceof Error ? error.message : String(error);
      // Most likely changed elsewhere: take the server's copy.
      void loadPlans();
    } finally {
      planSaving = false;
    }
  }

  /** Done, or back to active. Leaving a plan open when it is marked done is fine. */
  function setPlanStatus(entry: SavedPiPlan, status: "active" | "done"): void {
    void changePlan(entry, { status });
  }

  /** For good -- offered only on a plan already marked done. */
  async function removePlan(entry: SavedPiPlan): Promise<void> {
    planSaving = true;
    try {
      await deletePiPlan(planAccounts(), entry.planID);
      plans = withoutPlan(plans, entry.planID);
      plansError = null;
      if (planView.openID === entry.planID) showPlan(null);
      keepView(prunePiPlanView(planView, plans.map((row) => row.planID)));
    } catch (error) {
      plansError = error instanceof Error ? error.message : String(error);
    } finally {
      planSaving = false;
    }
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
      const note = planNote.trim();
      const current = openPlan;
      // A different commodity is a different plan; the same one is this plan
      // with a new number or note.
      if (current === null || current.typeID !== typeID) {
        treeOverride = new Map();
        placesOpen = new Set();
      }
      // Planned at once, from what is held: the save is bookkeeping, and a
      // server that cannot take it right now must not stop the planning.
      planRequest = { typeID, quantity };
      void savePlan(current, { typeID, quantity, note });
    }
  }

  async function savePlan(
    current: SavedPiPlan | null,
    fields: { typeID: number; quantity: number; note: string },
  ): Promise<void> {
    if (current !== null && current.typeID === fields.typeID) {
      if (current.quantity === fields.quantity && current.note === fields.note) return;
      await changePlan(current, { quantity: fields.quantity, note: fields.note });
      return;
    }
    planSaving = true;
    try {
      const created = await createPiPlan(planAccounts(), fields);
      plans = withPlan(plans, created);
      plansError = null;
      keepView(withOpenPlan(planView, created.planID));
    } catch (error) {
      plansError = `Not saved: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      planSaving = false;
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
    void loadPlans();
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
          <!-- SAVED PLANS, LIST AND DETAIL. Plans on the left, each with its
               standing worked out now from the stock as it stands; the open one
               on the right. Each plan is judged on its own, so two plans can both
               count the same units. -->
          <div class="pi-planner">
            <aside class="pi-plans" aria-label="Your plans">
              <div class="pi-plans-head">
                <h3>Your plans</h3>
                <button type="button" class="pi-new" onclick={() => showPlan(null)}>+ New</button>
              </div>
              {#snippet planRow(entry: SavedPiPlan)}
                {@const standing = planStanding.get(entry.planID)}
                <li>
                  <button
                    type="button"
                    class="pi-plan-card"
                    class:on={entry.planID === planView.openID}
                    aria-current={entry.planID === planView.openID ? "true" : undefined}
                    onclick={() => showPlan(entry)}
                    title={standing?.title}
                  >
                    <span class="pi-plan-card-top">
                      <TypeIcon typeID={entry.typeID} name={planName(entry.typeID)} size="md" />
                      <span class="pi-plan-card-text">
                        <span class="pi-plan-card-name">{planName(entry.typeID)}</span>
                        <span class="pi-plan-card-sub">{countWords(entry.quantity)}{entry.note ? ` - ${entry.note}` : ""}</span>
                      </span>
                    </span>
                    {#if standing}
                      <span class="pi-plan-card-foot">
                        <span class="pi-meter" aria-hidden="true">
                          <span class="pi-meter-fill tone-{standing.tone}" style:width={`${Math.round(standing.share * 100)}%`}></span>
                        </span>
                        <span class="pi-pill tone-{standing.tone}">{standing.words}</span>
                      </span>
                    {/if}
                  </button>
                </li>
              {/snippet}
              {#if !plansLoaded && !plansError}
                <p class="pi-plans-empty">Reading your saved plans...</p>
              {:else if activePlans.length === 0}
                <p class="pi-plans-empty">No plans yet. Start one with New.</p>
              {:else}
                <ul class="pi-plan-list">
                  {#each activePlans as entry (entry.planID)}
                    {@render planRow(entry)}
                  {/each}
                </ul>
              {/if}
              {#if donePlans.length > 0}
                <details class="pi-plans-done">
                  <summary>Done ({donePlans.length})</summary>
                  <ul class="pi-plan-list">
                    {#each donePlans as entry (entry.planID)}
                      {@render planRow(entry)}
                    {/each}
                  </ul>
                </details>
              {/if}
            </aside>

            <div class="pi-plan-detail">
              {#if plansError}
                <p class="pi-plan-error" role="alert">{plansError}</p>
              {/if}

              {#if planRequest === null}
                <!-- A NEW PLAN. It is kept the moment it is planned. -->
                <form
                  class="pi-compose"
                  onsubmit={(event) => {
                    event.preventDefault();
                    submitPlan();
                  }}
                >
                  <h3 class="pi-compose-title">New plan</h3>
                  <div class="pi-compose-row">
                    <label class="pi-field pi-field-qty">
                      <span>Make</span>
                      <input
                        id="pi-plan-quantity"
                        inputmode="numeric"
                        placeholder="20"
                        bind:value={planQuantity}
                        oninput={() => (planError = null)}
                      />
                    </label>
                    <label class="pi-field pi-field-grow">
                      <span>Commodity</span>
                      <select bind:value={planTarget} onchange={() => (planError = null)}>
                        <option value="">Choose a commodity</option>
                        {#each targetGroups as group (group.label)}
                          <optgroup label={group.label}>
                            {#each group.rows as row (row.typeID)}
                              <option value={String(row.typeID)}>{row.name}</option>
                            {/each}
                          </optgroup>
                        {/each}
                      </select>
                    </label>
                  </div>
                  <label class="pi-field">
                    <span>Note</span>
                    <input placeholder="For mining foreman boosters" maxlength="500" bind:value={planNote} />
                  </label>
                  <div class="pi-compose-actions">
                    <button type="submit" class="primary" disabled={planSaving}>Create plan</button>
                  </div>
                  {#if planError}
                    <p class="pi-plan-error" role="alert">{planError}</p>
                  {/if}
                </form>
              {:else}
                <header class="pi-detail-head">
                  <span class="pi-detail-icon">
                    <TypeIcon typeID={planRequest.typeID} name={planName(planRequest.typeID)} size="lg" />
                  </span>
                  <div class="pi-detail-title">
                    <h3>
                      {planName(planRequest.typeID)}
                      {#if recipes && tierTag(tierOf(recipes, planRequest.typeID))}
                        <span class="pi-chip">{tierTag(tierOf(recipes, planRequest.typeID))}</span>
                      {/if}
                      {#if openPlan?.status === "done"}<span class="pi-pill">done</span>{/if}
                    </h3>
                    <input
                      class="pi-detail-note"
                      aria-label="Note"
                      placeholder={openPlan ? "Add a note" : "Not saved"}
                      maxlength="500"
                      disabled={openPlan === null}
                      bind:value={planNote}
                      onchange={commitNote}
                    />
                  </div>
                  <div class="pi-detail-actions">
                    <label class="pi-detail-qty">
                      <span>Make</span>
                      <input
                        inputmode="numeric"
                        bind:value={planQuantity}
                        oninput={() => (planError = null)}
                        onchange={commitQuantity}
                        onkeydown={(event) => event.key === "Enter" && commitQuantity()}
                      />
                    </label>
                    {#if openPlan?.status === "active"}
                      <button type="button" disabled={planSaving} onclick={() => openPlan && setPlanStatus(openPlan, "done")}>Mark done</button>
                    {:else if openPlan?.status === "done"}
                      <button type="button" disabled={planSaving} onclick={() => openPlan && setPlanStatus(openPlan, "active")}>Reopen</button>
                      <button type="button" class="danger" disabled={planSaving} onclick={() => openPlan && removePlan(openPlan)}>Delete</button>
                    {/if}
                  </div>
                </header>
                {#if planError}
                  <p class="pi-plan-error" role="alert">{planError}</p>
                {/if}

                {#if plan && openCounts}
                  <div class="pi-stats" title={plan.verdict}>
                    <div class="pi-stat tone-ok">
                      <span class="pi-stat-label">Covered</span>
                      <span class="pi-stat-value">{openCounts.ok} of {openCounts.steps} steps</span>
                    </div>
                    <div class="pi-stat tone-act">
                      <span class="pi-stat-label">Can fix now</span>
                      <span class="pi-stat-value">{openCounts.act}</span>
                    </div>
                    <div class="pi-stat tone-bad">
                      <span class="pi-stat-label">Blocked</span>
                      <span class="pi-stat-value">{plan.gaps.length}</span>
                    </div>
                  </div>
                  <p class="pi-verdict">{plan.verdict}</p>

                  <!-- WHAT IS MISSING, by tier from the ground up: raw first,
                       because an extractor feeds everything above it. Blocked
                       steps lead each tier. -->
                  {#if missing.length > 0}
                    <h4 class="pi-section-title">Missing, from the ground up</h4>
                    <ul class="pi-missing" aria-label="Missing">
                      {#each missing as group (group.tier)}
                        {#each group.rows as row (row.typeID)}
                          <li class="pi-missing-row state-{row.state}">
                            <span class="pi-chip">{tierTag(group.tier) ?? "other"}</span>
                            <span class="pi-missing-name">
                              <TypeIcon typeID={row.typeID} name={row.typeName} />
                              {row.typeName}
                            </span>
                            <span class="pi-missing-count" title={`${countWords(row.held)} held of ${countWords(row.needed)}`}>{countWords(row.toMake)}</span>
                            <span class="pi-tags">
                              {#each row.tags as tag, index (index)}
                                <span class="pi-pill" class:tone-act={tag.tone === "act"} class:tone-bad={tag.tone === "bad"} title={tag.title}>{tag.text}</span>
                              {/each}
                            </span>
                          </li>
                        {/each}
                      {/each}
                    </ul>
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

                  <details class="pi-chain">
                    <summary>Full chain ({openCounts.steps} steps)</summary>
                    <ul class="pi-tree" role="tree" aria-label={plan.verdict}>
                      {@render planNode(plan.tree)}
                    </ul>
                  </details>
                {/if}
              {/if}
            </div>
          </div>
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
  /* THE PLANNER: plans on the left, the open plan on the right. Square like
   * the rest of the app (R53): every corner goes through the radius tokens. */
  .pi-planner {
    display: grid;
    grid-template-columns: minmax(13rem, 16rem) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }
  .pi-plans,
  .pi-plan-detail {
    background: var(--color-panel-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-frame);
  }
  .pi-plans {
    padding: 0.6rem;
  }
  .pi-plan-detail {
    padding: 1rem 1.1rem;
    min-width: 0;
  }
  .pi-plans-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .pi-plans-head h3,
  .pi-section-title,
  .pi-stat-label {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .pi-new {
    min-height: 28px;
    padding: 0 0.6rem;
  }
  .pi-plans-empty {
    margin: 0.5rem 0.2rem;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .pi-plan-list {
    display: grid;
    gap: 0.3rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-plan-card {
    display: grid;
    gap: 0.45rem;
    width: 100%;
    padding: 0.5rem 0.55rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
  }
  .pi-plan-card:hover:not(.on) {
    background: var(--color-panel);
    border-color: var(--color-line);
  }
  .pi-plan-card.on {
    background: var(--color-panel-2);
    border-color: var(--color-accent-dim);
  }
  .pi-plan-card-top {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
  }
  .pi-plan-card-text {
    display: grid;
    min-width: 0;
  }
  .pi-plan-card-name {
    color: var(--color-text-bright);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pi-plan-card-sub {
    color: var(--color-muted);
    font-size: 0.8rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pi-plan-card-foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .pi-meter {
    flex: 1 1 auto;
    height: 4px;
    background: var(--color-line);
    overflow: hidden;
  }
  .pi-meter-fill {
    display: block;
    height: 100%;
    background: var(--color-good);
  }
  .pi-meter-fill.tone-act {
    background: var(--color-warn);
  }
  .pi-meter-fill.tone-bad {
    background: var(--color-danger);
  }
  .pi-plans-done {
    margin-top: 0.6rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--color-line);
  }
  .pi-plans-done summary {
    margin-bottom: 0.3rem;
    color: var(--color-muted);
    font-size: 0.85rem;
    cursor: pointer;
  }
  .pi-pill {
    display: inline-block;
    padding: 0.05rem 0.45rem;
    border: 1px solid var(--color-line-strong);
    border-radius: var(--radius-control);
    color: var(--color-cell);
    font-size: 11px;
    white-space: nowrap;
  }
  .pi-pill.tone-ok {
    border-color: color-mix(in srgb, var(--color-good) 55%, transparent);
    background: color-mix(in srgb, var(--color-good) 12%, transparent);
    color: var(--color-good);
  }
  .pi-pill.tone-act {
    border-color: color-mix(in srgb, var(--color-warn) 55%, transparent);
    background: color-mix(in srgb, var(--color-warn) 12%, transparent);
    color: var(--color-warn);
  }
  .pi-pill.tone-bad {
    border-color: color-mix(in srgb, var(--color-danger) 55%, transparent);
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    color: var(--color-danger);
  }

  /* A new plan. */
  .pi-compose {
    display: grid;
    gap: 0.75rem;
    max-width: 40rem;
  }
  .pi-compose-title {
    margin: 0;
    font-size: 1.05rem;
    color: var(--color-text-bright);
  }
  .pi-compose-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .pi-field {
    display: grid;
    gap: 0.25rem;
    color: var(--color-muted);
    font-size: 0.8rem;
  }
  .pi-field input,
  .pi-field select {
    min-height: 38px;
  }
  .pi-field-qty input {
    width: 6rem;
  }
  .pi-field-grow {
    flex: 1 1 16rem;
  }
  .pi-compose-actions {
    display: flex;
    justify-content: flex-end;
  }
  .pi-plan-error {
    margin: 0.35rem 0 0;
    color: var(--color-danger);
    font-size: 0.85rem;
  }

  /* The open plan. */
  .pi-detail-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.9rem;
  }
  .pi-detail-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.25rem;
    height: 3.25rem;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line);
  }
  .pi-detail-title {
    display: grid;
    flex: 1 1 14rem;
    gap: 0.2rem;
    min-width: 0;
  }
  .pi-detail-title h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 1.2rem;
    font-weight: 500;
    color: var(--color-text-bright);
  }
  .pi-detail-note {
    min-height: 28px;
    padding: 0 0.3rem;
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .pi-detail-note:hover:not(:disabled),
  .pi-detail-note:focus {
    border-color: var(--color-line-strong);
    background: var(--color-field);
    color: var(--color-text);
  }
  .pi-detail-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .pi-detail-actions button {
    min-height: 34px;
  }
  .pi-detail-qty {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .pi-detail-qty input {
    width: 5.5rem;
    min-height: 34px;
  }
  .pi-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.6rem;
    margin: 1rem 0 0.4rem;
  }
  .pi-stat {
    display: grid;
    gap: 0.2rem;
    padding: 0.55rem 0.75rem;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-top-width: 2px;
  }
  .pi-stat.tone-ok {
    border-top-color: var(--color-good);
  }
  .pi-stat.tone-act {
    border-top-color: var(--color-warn);
  }
  .pi-stat.tone-bad {
    border-top-color: var(--color-danger);
  }
  .pi-stat-value {
    font-size: 1.15rem;
    color: var(--color-text-bright);
  }
  .pi-verdict {
    margin: 0 0 1rem;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .pi-section-title {
    margin-bottom: 0.35rem;
  }
  .pi-missing {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
  }
  .pi-missing-row {
    display: grid;
    grid-template-columns: 3rem minmax(9rem, 16rem) 6rem minmax(0, 1fr);
    gap: 0.6rem;
    align-items: center;
    min-height: 36px;
    padding: 0.2rem 0.6rem;
    border-top: 1px solid var(--color-line);
    border-left: 3px solid var(--color-good);
  }
  .pi-missing-row.state-act {
    border-left-color: var(--color-warn);
  }
  .pi-missing-row.state-bad {
    border-left-color: var(--color-danger);
  }
  .pi-missing-row .pi-chip {
    justify-self: start;
  }
  .pi-missing-name {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--color-text-bright);
  }
  .pi-missing-count {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }
  .pi-chain summary {
    color: var(--color-muted);
    cursor: pointer;
    margin-bottom: 0.5rem;
  }
  @media (max-width: 760px) {
    .pi-planner {
      grid-template-columns: minmax(0, 1fr);
    }
    .pi-missing-row {
      grid-template-columns: 2.6rem minmax(0, 1fr) auto;
    }
    .pi-missing-row .pi-tags {
      grid-column: 2 / -1;
    }
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
