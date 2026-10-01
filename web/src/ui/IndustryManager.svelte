<script lang="ts">
  // INDUSTRY MANAGER (R109 slice 2): choose a blueprint, owned by a pilot or
  // any at all, and see everything it takes to build, down to raw materials.
  // Option C of the 2026-10-01 mockups: the blueprints are browsed in the left
  // column, and the right side is only the plan.
  //
  // ⚠ A GLOBAL WINDOW WITH NO STORE, like Planetary Industry. A plan spans
  // every signed-in pilot's blueprints, so it reads each pilot's own industry
  // read on that pilot's own session and takes neither store nor flow.
  //
  // ⚠ NOTHING HERE SELECTS OR SIGNS IN A PILOT. The blueprint list is each
  // already-online pilot's industry read (the same read their Industry panel
  // makes); a pilot not online in this tab contributes nothing, and the picker
  // says so rather than reaching for them.
  //
  // ⚠ THE ARITHMETIC IS NOT HERE. bridge/industryChain.ts works the plan, once
  // per type, with the server's own rounding; this file draws it.
  import { onMount, untrack } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import type { ApiOptions } from "../app/api.ts";
  import { getIndustryRecipeClosure, searchIndustryBlueprints } from "../app/api.ts";
  import {
    decodeBlueprintSearch,
    decodeRecipeClosure,
    type IndustryBlueprintMatch,
    type IndustryRecipeBook,
  } from "../bridge/industryRecipes.ts";
  import {
    resolveIndustryChain,
    shortLines,
    type IndustryLine,
    type IndustryNode,
  } from "../bridge/industryChain.ts";
  import {
    groupOwned,
    groupWords,
    ownedBlueprints,
    ownedTerms,
    ownedWords,
    type OwnedBlueprint,
    type PilotBlueprintRead,
  } from "../bridge/industryOwned.ts";
  import { countWords } from "../bridge/piStock.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { sessions = [] }: { sessions?: readonly Session[] } = $props();

  /** What the plan is built from. */
  interface Target {
    readonly productTypeID: number;
    readonly blueprintName: string | null;
    readonly productName: string | null;
  }

  // Sessions already asked for their blueprints, so a pilot coming online is
  // read once and not on every store change after.
  const askedSessions = new Set<string>();

  // Bumped whenever a pilot's store moves, so the owned list re-reads.
  let storeTick = $state(0);
  let refreshing = $state(false);

  // The "Any" search.
  let query = $state("");
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let matches = $state<readonly IndustryBlueprintMatch[]>([]);
  let searchTotal = $state(0);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSerial = 0;

  // The chosen target and its recipe book.
  let target = $state<Target | null>(null);
  let runsText = $state("1");
  let book = $state<IndustryRecipeBook | null>(null);
  let bookError = $state<string | null>(null);
  let loadingBook = $state(false);
  const books = new Map<number, IndustryRecipeBook>();

  // The player's choices for this plan: buy instead of build, per type.
  let buying = $state<Set<number>>(new Set());
  // Which tree nodes are folded or unfolded by hand; the rest follow depth.
  let treeOverride = $state<Map<string, boolean>>(new Map());

  /** Pilots online in this tab, each with its own session's request options. */
  function onlineSessions(): { session: Session; characterID: number; characterName: string }[] {
    const online: { session: Session; characterID: number; characterName: string }[] = [];
    for (const session of sessions) {
      const character = session.store.station.get().online;
      if (character) {
        online.push({ session, characterID: character.characterID, characterName: character.characterName });
      }
    }
    return online;
  }

  /**
   * Request options for the static reads. Any online pilot's session will do:
   * the answer is the same for everyone. With none online, the tab's own
   * sign-in is used.
   */
  function staticOptions(): ApiOptions {
    const first = onlineSessions()[0];
    return first ? first.session.flow.requestOptions() : {};
  }

  const reads = $derived.by((): PilotBlueprintRead[] => {
    void storeTick;
    return onlineSessions().map(({ session, characterID, characterName }) => {
      const industry = session.store.industry.get();
      return { characterID, characterName, blueprints: industry.blueprints, definitions: industry.definitions };
    });
  });
  const onlineCount = $derived(reads.length);
  /** An online pilot whose blueprints have not been read yet: never say "none" for them. */
  const unreadOnline = $derived.by(() => {
    void storeTick;
    return onlineSessions().some(({ session }) => !session.store.industry.get().loaded);
  });
  const owned = $derived(ownedBlueprints(reads));
  const terms = $derived(ownedTerms(owned));
  /** One row per owned blueprint, however many copies (bridge/industryOwned.ts). */
  const ownedGroups = $derived(groupOwned(owned));
  /** Those whose name holds the filter text. */
  const ownedShown = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    // The name as listed, without the " Blueprint" every one carries: matched
    // against it, "ri" kept them all.
    return needle.length === 0
      ? ownedGroups
      : ownedGroups.filter((group) => (group.blueprintName ?? "").replace(/ Blueprint$/, "").toLowerCase().includes(needle));
  });

  const runs = $derived.by((): number | null => {
    const value = Number(runsText.trim());
    return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value : null;
  });

  const chain = $derived.by(() => {
    if (target === null || book === null || runs === null) {
      return null;
    }
    const obtain = new Map<number, "build" | "buy">();
    for (const typeID of buying) {
      obtain.set(typeID, "buy");
    }
    return resolveIndustryChain({
      book,
      productTypeID: target.productTypeID,
      runs,
      choices: { obtain, blueprints: terms },
    });
  });
  const toBuy = $derived(chain ? shortLines(chain).filter((line) => line.obtain === "buy") : []);
  const jobCount = $derived(
    chain ? [...chain.lines.values()].reduce((sum, line) => sum + line.jobRuns.length, 0) : 0,
  );
  const targetName = $derived(
    (target && book?.types.get(target.productTypeID)?.name) ?? target?.productName ?? target?.blueprintName ?? null,
  );

  /**
   * The plan's terms in one line: which blueprint it is planned with, at what
   * efficiencies, held by whom. The facility is not counted yet, and says so.
   */
  const termsWords = $derived.by((): string | null => {
    if (!chain || target === null) return null;
    const top = chain.lines.get(target.productTypeID)?.blueprint;
    if (!top) return null;
    const efficiencies = `material ${top.materialEfficiency}%, time ${top.timeEfficiency}%`;
    if (!top.assumed) {
      const copy = owned.find((blueprint) => blueprint.blueprintTypeID === top.blueprintTypeID);
      return copy ? `${ownedWords(copy).split(" - ")[0]} - ${efficiencies} - ${copy.characterName}` : `Owned - ${efficiencies}`;
    }
    return top.invention ? `Invented copy - ${efficiencies}` : `No owned blueprint - assumed ${efficiencies}`;
  });

  function nameOf(line: IndustryLine): string {
    return line.name ?? "An unnamed item";
  }

  async function refreshOwned(): Promise<void> {
    const online = onlineSessions();
    if (online.length === 0) {
      return;
    }
    refreshing = true;
    try {
      // Each pilot's own read, on its own session. One failing does not stop
      // the others; its blueprints simply stay as they were.
      await Promise.allSettled(online.map(({ session }) => session.flow.loadIndustry()));
    } finally {
      refreshing = false;
      storeTick += 1;
    }
  }

  async function loadBook(productTypeID: number): Promise<void> {
    const cached = books.get(productTypeID);
    if (cached) {
      book = cached;
      bookError = null;
      return;
    }
    loadingBook = true;
    bookError = null;
    book = null;
    try {
      const decoded = decodeRecipeClosure(await getIndustryRecipeClosure([productTypeID], staticOptions()));
      if (!decoded.readable) {
        bookError = "The recipes could not be read just now.";
        return;
      }
      books.set(productTypeID, decoded);
      if (target?.productTypeID === productTypeID) {
        book = decoded;
      }
    } catch {
      bookError = "The recipes could not be read just now.";
    } finally {
      loadingBook = false;
    }
  }

  function choose(next: Target, defaultRuns: number): void {
    target = next;
    runsText = String(defaultRuns);
    buying = new Set();
    treeOverride = new Map();
    void loadBook(next.productTypeID);
  }

  function chooseOwned(itemID: string): void {
    const blueprint = owned.find((candidate) => String(candidate.itemID) === itemID);
    if (!blueprint) {
      return;
    }
    choose(
      { productTypeID: blueprint.productTypeID, blueprintName: blueprint.blueprintName, productName: null },
      blueprint.runs ?? 1,
    );
  }

  function chooseMatch(match: IndustryBlueprintMatch): void {
    choose(
      { productTypeID: match.productTypeID, blueprintName: match.blueprintName, productName: match.productName },
      1,
    );
  }

  function onQuery(): void {
    if (searchTimer !== null) {
      clearTimeout(searchTimer);
    }
    const text = query.trim();
    if (text.length < 2) {
      matches = [];
      searchTotal = 0;
      searchError = null;
      return;
    }
    searchTimer = setTimeout(() => void runSearch(text), 250);
  }

  async function runSearch(text: string): Promise<void> {
    const serial = ++searchSerial;
    searching = true;
    searchError = null;
    try {
      const result = decodeBlueprintSearch(await searchIndustryBlueprints(text, staticOptions()));
      if (serial !== searchSerial) {
        return;
      }
      matches = result.matches;
      searchTotal = result.total;
    } catch {
      if (serial === searchSerial) {
        searchError = "The search could not be run just now.";
      }
    } finally {
      if (serial === searchSerial) {
        searching = false;
      }
    }
  }

  function setBuying(typeID: number, buy: boolean): void {
    const next = new Set(buying);
    if (buy) {
      next.add(typeID);
    } else {
      next.delete(typeID);
    }
    buying = next;
  }

  /** Open by default to two levels below the target; deeper folds. */
  function isOpen(node: IndustryNode): boolean {
    const forced = treeOverride.get(node.key);
    return forced ?? node.key.split(">").length <= 2;
  }

  function toggle(node: IndustryNode): void {
    const next = new Map(treeOverride);
    next.set(node.key, !isOpen(node));
    treeOverride = next;
  }

  function obtainWord(line: IndustryLine): string {
    return line.obtain === "react" ? "react" : line.obtain;
  }

  /**
   * Read the blueprints of every online pilot not read yet. Runs when the
   * window opens and whenever a pilot comes online in this tab: a pilot
   * signed in after the window opened used to be listed as holding no
   * blueprints, because nothing had read them (seen live, 2026-10-01).
   */
  function readNewcomers(): void {
    const newcomers = onlineSessions().filter(({ session }) => !askedSessions.has(session.id));
    if (newcomers.length === 0) return;
    for (const { session } of newcomers) askedSessions.add(session.id);
    const unread = newcomers.filter(({ session }) => !session.store.industry.get().loaded);
    if (unread.length > 0) {
      refreshing = true;
      void Promise.allSettled(unread.map(({ session }) => session.flow.loadIndustry())).finally(() => {
        refreshing = false;
        storeTick += 1;
      });
    }
  }

  // Each pilot's store, watched so a read made elsewhere (their Industry panel,
  // a Refresh here) shows up in the list without asking again. Re-subscribed
  // when a pilot joins or leaves the tab.
  // ⚠ `subscribe` calls back at once, and the callback reads `storeTick` to
  // bump it; untracked, or this effect would depend on its own write.
  $effect(() => {
    const list = sessions;
    const stops = untrack(() =>
      list.flatMap((session) => [
        session.store.industry.subscribe(() => (storeTick += 1)),
        session.store.station.subscribe(() => {
          storeTick += 1;
          readNewcomers();
        }),
      ]),
    );
    return () => {
      for (const stop of stops) {
        stop();
      }
    };
  });

  onMount(() => {
    readNewcomers();
    return () => {
      if (searchTimer !== null) {
        clearTimeout(searchTimer);
      }
    };
  });
</script>

<section class="panel im-manager">
  <header class="panel-head">
    <h2 class="panel-title">Industry Manager</h2>
    <span class="controls">
      <button type="button" disabled={refreshing || onlineCount === 0} onclick={() => void refreshOwned()}>
        {refreshing ? "Looking..." : "Refresh"}
      </button>
    </span>
  </header>

  <div class="im-body">
    <!-- THE LEFT COLUMN: the blueprints to plan from. -->
    <aside class="im-side" aria-label="Blueprints">
      <input
        type="search"
        class="im-filter"
        aria-label="Filter blueprints"
        placeholder="Filter, or search all"
        bind:value={query}
        oninput={onQuery}
      />
      {#if onlineCount === 0}
        <p class="im-note">Sign a pilot in here to list their blueprints.</p>
      {:else if owned.length === 0}
        <p class="im-note">{unreadOnline || refreshing ? "Looking at your blueprints..." : "None of your signed-in pilots holds a blueprint."}</p>
      {:else if ownedShown.length === 0}
        <p class="im-note">None of your blueprints is called that.</p>
      {:else}
        <h4 class="im-section-title">Yours</h4>
        <ul class="im-list" aria-label="Your blueprints">
          {#each ownedShown as group (group.blueprintTypeID)}
            {@const best = group.copies[0]!}
            <li>
              <button
                type="button"
                class="im-item"
                class:on={target?.productTypeID === group.productTypeID}
                onclick={() => chooseOwned(String(best.itemID))}
              >
                <TypeIcon typeID={group.productTypeID} name={group.blueprintName ?? "An unnamed blueprint"} size="md" />
                <span class="im-item-text">
                  <span class="im-item-name">{(group.blueprintName ?? "An unnamed blueprint").replace(/ Blueprint$/, "")}</span>
                  <span class="im-item-sub">{groupWords(group, best)}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if query.trim().length < 2}
        <p class="im-note">Type two letters to search every blueprint too.</p>
      {:else}
        <h4 class="im-section-title">All blueprints</h4>
        {#if searchError}
          <p class="im-error" role="alert">{searchError}</p>
        {:else if searching && matches.length === 0}
          <p class="im-note">Looking...</p>
        {:else if matches.length === 0}
          <p class="im-note">No blueprint is called that.</p>
        {:else}
          <ul class="im-list" aria-label="All blueprints">
            {#each matches as match (match.blueprintTypeID)}
              <li>
                <button
                  type="button"
                  class="im-item"
                  class:on={target?.productTypeID === match.productTypeID}
                  onclick={() => chooseMatch(match)}
                >
                  <TypeIcon typeID={match.productTypeID} name={match.productName ?? match.blueprintName} size="md" />
                  <span class="im-item-text">
                    <span class="im-item-name">{match.blueprintName.replace(/ (Blueprint|Reaction Formula)$/, "")}</span>
                    <span class="im-item-sub">{match.activity === "reaction" ? "Reaction formula" : "Blueprint"}</span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
          {#if searchTotal > matches.length}
            <p class="im-note">Showing {matches.length} of {countWords(searchTotal)}. Type more to narrow it.</p>
          {/if}
        {/if}
      {/if}
    </aside>

    <div class="im-plan">
      {#if target === null}
        <p class="im-empty">Choose a blueprint and this will work out everything it takes to build.</p>
      {:else}
        <header class="im-head">
          <span class="im-head-icon">
            <TypeIcon typeID={target.productTypeID} name={targetName ?? "An unnamed item"} size="lg" />
          </span>
          <div class="im-head-title">
            <h3><span>{targetName ?? "An unnamed item"}</span></h3>
            {#if termsWords}
              <p class="im-terms">{termsWords} <span class="im-terms-quiet">- no facility bonus counted</span></p>
            {/if}
          </div>
          <div class="im-head-actions">
            <label class="im-runs">
              <span>Runs</span>
              <input inputmode="numeric" bind:value={runsText} aria-invalid={runs === null} />
            </label>
          </div>
        </header>

        {#if runs === null}
          <p class="im-error" role="alert">Enter a number of runs.</p>
        {:else if loadingBook}
          <p class="im-note">Working out the recipes...</p>
        {:else if bookError}
          <p class="im-error" role="alert">{bookError}</p>
        {:else if book?.capped}
          <p class="im-error" role="alert">This tree is too large to show in full.</p>
        {:else if chain}
          <p class="im-verdict">
            {countWords(chain.root.quantity)} {targetName ?? "items"}: {countWords(jobCount)} {jobCount === 1 ? "job" : "jobs"},
            {countWords(toBuy.length)} {toBuy.length === 1 ? "thing" : "things"} to buy.
          </p>

          {#if toBuy.length > 0}
            <h4 class="im-section-title">To buy</h4>
            <ul class="im-buy" aria-label="To buy">
              {#each toBuy as line (line.typeID)}
                <li class="im-buy-row">
                  <span class="im-buy-name">
                    <TypeIcon typeID={line.typeID} name={nameOf(line)} />
                    {nameOf(line)}
                    {#if line.planetary}<span class="im-chip">PI</span>{/if}
                  </span>
                  <span class="im-buy-count">{countWords(line.short)}</span>
                </li>
              {/each}
            </ul>
          {/if}

          <!-- THE TREE. Each type is worked once for the whole plan; a type
               that appears again is marked "above" rather than drawn twice. -->
          {#snippet treeNode(node: IndustryNode, isRoot: boolean)}
            {@const line = node.line}
            {@const open = node.children.length > 0 && isOpen(node)}
            <li role="treeitem" aria-selected="false" aria-expanded={node.children.length > 0 ? open : undefined}>
              <div class="im-node obtain-{line.obtain}">
                {#if node.children.length > 0}
                  <button type="button" class="im-node-name" onclick={() => toggle(node)}>
                    <span class="im-chevron" aria-hidden="true">{open ? "v" : ">"}</span>
                    <TypeIcon typeID={node.typeID} name={nameOf(line)} />
                    <span>{nameOf(line)}</span>
                  </button>
                {:else}
                  <span class="im-node-name">
                    <span class="im-chevron" aria-hidden="true"></span>
                    <TypeIcon typeID={node.typeID} name={nameOf(line)} />
                    <span>{nameOf(line)}</span>
                  </span>
                {/if}
                <span class="im-tags">
                  {#if node.repeat}
                    <span class="im-tag" title="Drawn in full above">above</span>
                  {/if}
                  {#if line.planetary}<span class="im-tag">PI</span>{/if}
                  {#if line.obtain !== "buy" && line.runs > 0}
                    <span class="im-tag">{countWords(line.runs)} {line.runs === 1 ? "run" : "runs"}</span>
                  {/if}
                  {#if line.leftover > 0}
                    <span class="im-tag" title="Whole runs make more than the plan needs">{countWords(line.leftover)} left over</span>
                  {/if}
                  {#if line.blueprint?.invention}
                    <span class="im-tag act" title="Each success gives a copy with {line.blueprint.invention.runsPerCopy} runs">
                      needs {line.blueprint.invention.copies} invented {line.blueprint.invention.copies === 1 ? "copy" : "copies"}
                    </span>
                  {/if}
                  {#if line.blueprint && !isRoot && line.blueprint.assumed && line.obtain === "build" && line.runs > 0}
                    <span class="im-tag" title="No pilot here owns this blueprint">assumed material {line.blueprint.materialEfficiency}%</span>
                  {/if}
                  {#if line.buyReason === "cycle"}
                    <span class="im-tag bad">made from itself</span>
                  {/if}
                </span>
                <span class="im-count">{countWords(node.quantity)}</span>
                {#if !isRoot && line.canBuild && line.buyReason !== "cycle"}
                  <button
                    type="button"
                    class="im-obtain"
                    aria-pressed={line.obtain === "buy"}
                    title={line.obtain === "buy" ? "Build this instead of buying it" : "Buy this instead of building it"}
                    onclick={() => setBuying(node.typeID, line.obtain !== "buy")}
                  >{obtainWord(line)}</button>
                {:else}
                  <span class="im-obtain-fixed">{obtainWord(line)}</span>
                {/if}
              </div>
              {#if open}
                <ul class="im-tree-kids" role="group">
                  {#each node.children as child (child.key)}
                    {@render treeNode(child, false)}
                  {/each}
                </ul>
              {/if}
            </li>
          {/snippet}

          <h4 class="im-section-title">Build tree</h4>
          <ul class="im-tree" role="tree" aria-label="Build tree">
            {@render treeNode(chain.root, true)}
          </ul>
        {/if}
      {/if}
    </div>
  </div>
</section>

<style>
  /* Square, like the rest of the app (R53): corners go through the tokens. */
  .im-body {
    display: grid;
    grid-template-columns: minmax(13rem, 16rem) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
    margin-top: 0.75rem;
  }
  .im-side,
  .im-plan {
    background: var(--color-panel-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-frame);
    min-width: 0;
  }
  .im-side {
    display: grid;
    align-content: start;
    gap: 0.5rem;
    padding: 0.6rem;
  }
  /* ⚠ ITS OWN CONTAINER. The rows inside fold to their narrow layout by the
   * width of THIS pane, not the window: beside the plan list a 700px window
   * leaves the pane about 400px, and measured by the window the tree rows kept
   * their wide grid and scrolled sideways (seen live, 2026-10-01). */
  .im-plan {
    display: grid;
    align-content: start;
    gap: 0.75rem;
    padding: 1rem 1.1rem;
    container-type: inline-size;
  }

  .im-filter {
    width: 100%;
    min-height: 36px;
  }
  .im-section-title {
    margin: 0.2rem 0 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  /* One row in either list: icon, name, and one muted line under it. */
  .im-list,
  .im-buy,
  .im-tree,
  .im-tree-kids {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .im-list {
    display: grid;
    gap: 0.2rem;
  }
  .im-item {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    min-height: 44px;
    padding: 0.4rem 0.5rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
  }
  .im-item:hover:not(.on) {
    background: var(--color-panel);
    border-color: var(--color-line);
  }
  .im-item.on {
    background: var(--color-panel-2);
    border-color: var(--color-accent-dim);
  }
  .im-item-text {
    display: grid;
    min-width: 0;
  }
  .im-item-name {
    color: var(--color-text-bright);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .im-item-sub {
    color: var(--color-muted);
    font-size: 0.8rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .im-note,
  .im-empty {
    margin: 0;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .im-error {
    margin: 0;
    color: var(--color-danger);
    font-size: 0.85rem;
  }
  .im-chip,
  .im-tag {
    font-size: 11px;
    padding: 0 0.4rem;
    border: 1px solid var(--color-line-strong);
    color: var(--color-cell);
    white-space: nowrap;
  }
  .im-tag.act {
    border-color: var(--color-warn);
    color: var(--color-warn);
  }
  .im-tag.bad {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }
  .im-head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.9rem;
  }
  .im-head-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.25rem;
    height: 3.25rem;
    overflow: hidden;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line);
  }
  .im-head-title {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
  }
  .im-head-title h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 1.2rem;
    font-weight: 500;
    color: var(--color-text-bright);
  }
  .im-terms {
    margin: 0;
    color: var(--color-cell);
    font-size: 0.85rem;
  }
  .im-terms-quiet {
    color: var(--color-muted);
  }
  .im-head-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .im-head-actions button {
    min-height: 34px;
  }
  .im-runs {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .im-runs input {
    width: 5.5rem;
    min-height: 34px;
  }
  .im-verdict {
    margin: 0;
    color: var(--color-text);
  }
  .im-buy-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 7rem;
    gap: 0.6rem;
    align-items: center;
    min-height: 36px;
    padding: 0.2rem 0.6rem;
    border-top: 1px solid var(--color-line);
    border-left: 3px solid var(--color-warn);
  }
  .im-buy-name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    color: var(--color-text-bright);
  }
  .im-buy-count,
  .im-count {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }
  .im-tree-kids {
    margin-left: 0.9rem;
    padding-left: 0.8rem;
    border-left: 1px dashed var(--color-line-strong);
  }
  .im-node {
    display: grid;
    grid-template-columns: minmax(12rem, 1.3fr) minmax(0, 1.4fr) 6rem 4.5rem;
    gap: 0.75rem;
    align-items: center;
    margin: 0.3rem 0;
    padding: 0.4rem 0.6rem;
    background: var(--color-panel);
    border-left: 3px solid var(--color-accent-dim);
  }
  .im-node.obtain-react {
    border-left-color: var(--color-powergrid);
  }
  .im-node.obtain-buy {
    border-left-color: var(--color-warn);
  }
  .im-node-name {
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
  button.im-node-name {
    cursor: pointer;
  }
  .im-chevron {
    display: inline-block;
    width: 0.8rem;
    color: var(--color-muted);
    font-size: 11px;
  }
  .im-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .im-obtain,
  .im-obtain-fixed {
    justify-self: end;
    font-size: 11px;
    min-width: 4rem;
    text-align: center;
  }
  .im-obtain {
    min-height: 28px;
    padding: 0 0.5rem;
  }
  .im-obtain-fixed {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--color-muted);
  }
  @container (max-width: 640px) {
    .im-body {
      grid-template-columns: minmax(0, 1fr);
    }
    .im-head {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .im-head-actions {
      grid-column: 1 / -1;
    }
    .im-head-actions button {
      flex: 1 1 auto;
      min-height: 40px;
    }
    /* Name, count and the build/buy button on one line; the tags below. */
    .im-node {
      grid-template-columns: minmax(0, 1fr) auto auto;
    }
    .im-tags {
      grid-column: 1 / -1;
      grid-row: 2;
    }
    .im-obtain,
    .im-obtain-fixed {
      min-height: 40px;
    }
  }
</style>
