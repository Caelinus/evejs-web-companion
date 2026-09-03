<script lang="ts">
  // THE PILOT HANGAR — the first screen of the app.
  //
  // What it replaced: one flat list of every character the tab had ever seen,
  // with a login panel under it. That works at three pilots. At fifty it is a
  // wall of identical rows with no structure at all — you scroll past four
  // accounts to find one hauler, and nothing on screen says which pilots belong
  // to the same operation.
  //
  // So this screen does three things the list could not:
  //   • GROUPS BY ACCOUNT. The one grouping the server actually knows about, and
  //     the one that matches how a multiboxer signs in.
  //   • ADDS SQUADS. A second, cross-account grouping the player makes — a
  //     mining op, a scout net — brought online in one click. Squads live only
  //     in this browser (app/hangarPrefs.ts); the server has no idea.
  //   • SHOWS ENOUGH TO CHOOSE. Wallet, skill points, where the pilot is and what
  //     it is training, without bringing it online first. All four come from the
  //     roster (app/knownCharacters.ts), refreshed on mount by a throwaway
  //     sign-in per account (app/rosterRefresh.ts).
  //
  // WHAT THIS FILE OWNS: the screen's own transient state — the search box, the
  // scope chip, the selection, which popover is open, manage mode, and the
  // launch queue. Persisted arrangement goes straight through to hangarPrefs;
  // every filter, sort, count and formatted string is computed in app/hangar.ts,
  // which is pure and tested. Nothing here fetches, and nothing here creates a
  // session: `onLaunch` hands that to App, which owns the multibox roster.
  //
  // "Bring online" means the web client opens that pilot's interface. Several
  // pilots are live in the one tab at once; the switcher between them is the
  // character bar, and is not this screen's business.
  import HangarPilotRow from "./HangarPilotRow.svelte";
  import HangarLoginDialog from "./HangarLoginDialog.svelte";
  import HangarAddCharacter from "./HangarAddCharacter.svelte";
  import HangarSquadEditor from "./HangarSquadEditor.svelte";
  import HangarLaunchProgress from "./HangarLaunchProgress.svelte";
  import {
    loadKnownCharacters,
    forgetKnownCharacter,
    forgetKnownAccount,
    type KnownCharacter,
  } from "../app/knownCharacters.ts";
  import {
    loadHangarPrefs,
    saveHangarPrefs,
    addSquad,
    deleteSquad,
    forgetPilots,
    nextSquadColor,
    nextSquadId,
    squadMemberCount,
    toggleCollapsedAccount,
    togglePinnedPilot,
    togglePinnedSquad,
    toggleSquadMember,
    updateSquad,
    type HangarPrefs,
    type Squad,
  } from "../app/hangarPrefs.ts";
  import {
    groupByAccount,
    pilotCountLabel,
    scopeLabel,
    selectionDetail,
    selectionLabel,
    toHangarPilots,
    totalsLabel,
    visiblePilots,
    MAX_SLOTS,
    type HangarPilot,
    type HangarScope,
  } from "../app/hangar.ts";
  import {
    launchFinished,
    newQueue,
    withEntryState,
    type LaunchEntry,
    type LaunchTarget,
  } from "../app/hangarLaunch.ts";
  import { refreshRoster } from "../app/rosterRefresh.ts";

  let {
    onlineIDs = new Set<number>(),
    onLaunch,
    onGoToFirst,
    onClose = null,
  }: {
    /** Character IDs already in the client, from App's live session list. */
    onlineIDs?: Set<number>;
    /**
     * Bring these pilots online, reporting each one as it lands. App owns the
     * session roster, so it owns this; the hangar only says who.
     */
    onLaunch: (
      targets: readonly LaunchTarget[],
      onProgress: (characterID: number, state: LaunchEntry["state"], note?: string) => void,
    ) => Promise<void>;
    /** Show the first pilot that came online. */
    onGoToFirst: (characterID: number) => void;
    /**
     * Leave the hangar without launching anything. Null when the hangar IS the
     * screen (no pilot is online yet) and there is nowhere to go back to.
     */
    onClose?: (() => void) | null;
  } = $props();

  // --- persisted state, read once and written back on every edit -------------

  let known = $state<KnownCharacter[]>(loadKnownCharacters());
  let prefs = $state<HangarPrefs>(loadHangarPrefs());

  function commit(next: HangarPrefs): void {
    prefs = next;
    saveHangarPrefs(next);
  }

  // --- screen state ----------------------------------------------------------

  let query = $state("");
  let scope = $state<HangarScope>({ kind: "all" });
  let selected = $state<Set<number>>(new Set());
  let manage = $state(false);
  let pickerOpen = $state(false);
  let squadQuery = $state("");
  let squadMenuFor = $state<number | null>(null);
  let editing = $state<Squad | null>(null);
  let editingIsNew = $state(false);
  /**
   * Cancelling the editor should undo the squad it was opened on — but ONLY for
   * "+ New squad", where the squad exists solely because the editor needed
   * something to edit. A squad made by "Save as squad" already holds the pilots
   * that were selected, and throwing that away because the player did not want
   * to rename it would lose the actual work.
   */
  let discardOnCancel = $state(false);
  let loginOpen = $state(false);
  /** The account whose empty slot was clicked, i.e. "put a pilot in here". */
  let addingTo = $state<string | null>(null);
  let queue = $state<LaunchEntry[]>([]);
  let launching = $state(false);

  // The clock the "4d 6h" countdowns are measured against. Re-read once a minute
  // so a hangar left open does not sit there claiming a skill finishes in six
  // hours all evening; a minute is as fine as the coarsest unit it prints.
  let now = $state(Date.now());
  $effect(() => {
    const handle = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(handle);
  });

  // Below 760px a tap on a pilot SELECTS rather than launching. Mis-tap
  // protection: on a phone the row is the only comfortable target on it, and an
  // accidental brush must not sign a pilot in. The selection bar's "Bring
  // online ▶" is the deliberate action there.
  let tapSelects = $state(false);
  $effect(() => {
    const media = globalThis.matchMedia?.("(max-width: 759px)");
    if (!media) return;
    tapSelects = media.matches;
    const onChange = (event: MediaQueryListEvent): void => {
      tapSelects = event.matches;
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  });

  // --- the rows --------------------------------------------------------------

  const pilots = $derived(toHangarPilots(known, prefs, onlineIDs, now));
  const visible = $derived(visiblePilots(pilots, scope, query));
  const padSlots = $derived(scope.kind === "all" && query.trim().length === 0);
  const accounts = $derived(groupByAccount(visible, { padSlots }));
  const knownIDs = $derived(new Set(known.map((row) => row.characterID)));
  const selectedPilots = $derived(pilots.filter((p) => selected.has(p.characterID)));
  const onlineCount = $derived(pilots.filter((p) => p.online).length);
  const idleCount = $derived(pilots.filter((p) => p.training === null).length);
  const pinnedSquads = $derived(prefs.squads.filter((s) => prefs.pinnedSquads.includes(s.id)));
  const pickerSquads = $derived(
    prefs.squads.filter(
      (s) =>
        squadQuery.trim().length === 0 ||
        s.name.toLowerCase().includes(squadQuery.trim().toLowerCase()),
    ),
  );

  // --- refresh on mount ------------------------------------------------------
  //
  // The roster is a snapshot from the last sign-in, so a hangar opened cold shows
  // yesterday's wallets and locations. Re-read every account, one at a time, and
  // repaint each as it lands. Best-effort throughout: an account that fails keeps
  // the rows it already had, because a landing screen that empties itself when a
  // read fails is worse than one showing a slightly stale figure.
  let refreshStarted = false;
  $effect(() => {
    if (refreshStarted) return;
    refreshStarted = true;
    const accountNames = [...new Set(loadKnownCharacters().map((row) => row.accountName))];
    if (accountNames.length === 0) {
      // First run: nothing to refresh, and nothing to look at either — open the
      // login straight away rather than leaving the player on an empty page
      // hunting for the way in.
      loginOpen = true;
      return;
    }
    void refreshRoster(accountNames, () => {
      known = loadKnownCharacters();
    });
  });

  // --- selection -------------------------------------------------------------

  function toggleSelected(characterID: number): void {
    const next = new Set(selected);
    if (next.has(characterID)) next.delete(characterID);
    else next.add(characterID);
    selected = next;
  }

  function setAccountSelected(account: readonly HangarPilot[], on: boolean): void {
    const next = new Set(selected);
    for (const pilot of account) {
      if (on) next.add(pilot.characterID);
      else next.delete(pilot.characterID);
    }
    selected = next;
  }

  function accountAllSelected(account: readonly HangarPilot[]): boolean {
    return account.length > 0 && account.every((p) => selected.has(p.characterID));
  }

  // --- launching -------------------------------------------------------------

  function targetsFor(list: readonly HangarPilot[]): LaunchTarget[] {
    // A pilot already in the client is not launched again — selecting a whole
    // squad when two of it are up must bring the other four, not fail twice.
    return list
      .filter((p) => !p.online)
      .map((p) => ({
        accountName: p.accountName,
        characterID: p.characterID,
        characterName: p.name,
      }));
  }

  async function launch(list: readonly HangarPilot[]): Promise<void> {
    if (manage || launching) return;
    const targets = targetsFor(list);
    if (targets.length === 0) return;
    queue = newQueue(targets);
    launching = true;
    closePopovers();
    try {
      await onLaunch(targets, (characterID, state, note) => {
        queue = withEntryState(queue, characterID, state, note);
      });
    } finally {
      launching = false;
      // Whatever came online is online now; drop the selection so the bar does
      // not keep offering to launch pilots that are already up.
      selected = new Set();
    }
  }

  function squadPilots(squadID: string): HangarPilot[] {
    return pilots.filter((p) => p.squads.some((s) => s.id === squadID));
  }

  function closeLaunchDialog(): void {
    queue = [];
  }

  function goToFirst(): void {
    const first = queue.find((entry) => entry.state === "online");
    queue = [];
    if (first) onGoToFirst(first.characterID);
  }

  // --- popovers --------------------------------------------------------------

  function closePopovers(): void {
    pickerOpen = false;
    squadMenuFor = null;
  }

  function toggleManage(): void {
    manage = !manage;
    selected = new Set();
    closePopovers();
  }

  // --- squads ----------------------------------------------------------------

  // A squad is created BEFORE the editor opens, not on save: the editor edits a
  // squad, and inventing a second "not saved yet" shape for one would mean every
  // colour swatch and member list had two places to read from.
  function newSquad(memberIDs: readonly number[] = []): void {
    const squad: Squad = {
      id: nextSquadId(),
      name: `New squad ${prefs.squads.length + 1}`,
      color: nextSquadColor(prefs),
    };
    commit(addSquad(prefs, squad, memberIDs));
    editing = squad;
    editingIsNew = true;
    discardOnCancel = memberIDs.length === 0;
    closePopovers();
  }

  function saveSquadFromSelection(): void {
    newSquad(selectedPilots.map((p) => p.characterID));
    selected = new Set();
  }

  function saveSquadEdit(patch: { name: string; color: string }): void {
    if (!editing) return;
    commit(updateSquad(prefs, editing.id, patch));
    closeSquadEditor(false);
  }

  function removeSquad(): void {
    if (!editing) return;
    const id = editing.id;
    commit(deleteSquad(prefs, id));
    closeSquadEditor(false);
    if (scope.kind === "squad" && scope.value === id) scope = { kind: "all" };
  }

  function closeSquadEditor(discard: boolean): void {
    const squad = editing;
    editing = null;
    editingIsNew = false;
    if (discard && squad) {
      commit(deleteSquad(prefs, squad.id));
    }
    discardOnCancel = false;
  }

  // --- manage-mode removals --------------------------------------------------
  //
  // Local only: forgetting a pilot drops it from THIS browser's roster. Nothing
  // is deleted on the server, and signing the account in again brings it back.

  function removePilot(characterID: number): void {
    forgetKnownCharacter(characterID);
    known = loadKnownCharacters();
    commit(forgetPilots(prefs, [characterID]));
    const next = new Set(selected);
    next.delete(characterID);
    selected = next;
  }

  function removeAccount(accountName: string): void {
    const gone = forgetKnownAccount(accountName);
    known = loadKnownCharacters();
    commit(forgetPilots(prefs, gone));
    const next = new Set(selected);
    for (const id of gone) next.delete(id);
    selected = next;
  }

  function afterLogin(accountName: string): void {
    loginOpen = false;
    known = loadKnownCharacters();
    // A brand-new account arrives with no characters; say nothing about it here,
    // the empty slots under its header already do.
    void accountName;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="hangar" onclick={closePopovers}>
  <header class="hangar-head">
    <div class="hangar-brand">
      <span class="hangar-wordmark">EveJS Web</span>
      <span class="hangar-online-count">
        <span class="hangar-online-dot" aria-hidden="true"></span>
        <span>{onlineCount} in client</span>
      </span>
    </div>

    <div class="hangar-search">
      <span class="hangar-search-slash" aria-hidden="true">/</span>
      <input
        type="search"
        aria-label="Filter pilots, ships, systems"
        placeholder="Filter pilots, ships, systems"
        bind:value={query}
      />
      <span class="hangar-match">{visible.length}/{pilots.length}</span>
    </div>

    <div class="hangar-head-actions">
      <button
        type="button"
        class="hangar-manage"
        class:is-on={manage}
        aria-pressed={manage}
        onclick={toggleManage}
      >{manage ? "Done" : "Manage"}</button>
      <button type="button" class="hangar-add" onclick={() => (loginOpen = true)}>
        + Add account
      </button>
      {#if onClose}
        <button type="button" class="hangar-manage" onclick={onClose}>Back</button>
      {/if}
    </div>
  </header>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="hangar-chiprow" onclick={(event) => event.stopPropagation()}>
    <div class="hangar-chip" class:is-on={scope.kind === "all"}>
      <button
        type="button"
        class="hangar-chip-select"
        onclick={() => (scope = { kind: "all" })}
      >
        <span class="hangar-chip-name">All pilots</span>
        <span class="hangar-chip-count">{pilots.length}</span>
      </button>
    </div>

    {#each pinnedSquads as squad (squad.id)}
      {@const count = squadMemberCount(prefs, squad.id, knownIDs)}
      <div
        class="hangar-chip"
        class:is-on={scope.kind === "squad" && scope.value === squad.id}
        style:border-color={scope.kind === "squad" && scope.value === squad.id
          ? squad.color
          : undefined}
      >
        <button
          type="button"
          class="hangar-chip-select"
          onclick={() => (scope = { kind: "squad", value: squad.id })}
        >
          <span class="hangar-swatch" style:background={squad.color}></span>
          <span class="hangar-chip-name">{squad.name}</span>
          <span class="hangar-chip-count">{count}</span>
        </button>
        {#if manage}
          <button
            type="button"
            class="hangar-chip-edit"
            title="Rename, recolour or delete"
            onclick={() => {
              editing = squad;
              editingIsNew = false;
            }}
          >edit</button>
        {:else}
          <button
            type="button"
            class="hangar-launch"
            title={`Bring all of ${squad.name} online`}
            onclick={() => launch(squadPilots(squad.id))}
          >▶ ALL</button>
        {/if}
      </div>
    {/each}

    <div
      class="hangar-chip"
      class:is-on={scope.kind === "idle"}
      style:border-color={scope.kind === "idle" ? "#4a3a16" : undefined}
    >
      <button type="button" class="hangar-chip-select" onclick={() => (scope = { kind: "idle" })}>
        <span class="hangar-swatch" style:background="#e0b155"></span>
        <span class="hangar-chip-name">Not training</span>
        <span class="hangar-chip-count">{idleCount}</span>
      </button>
    </div>

    <div
      class="hangar-chip"
      class:is-on={scope.kind === "online"}
      style:border-color={scope.kind === "online" ? "#1e5c45" : undefined}
    >
      <button type="button" class="hangar-chip-select" onclick={() => (scope = { kind: "online" })}>
        <span class="hangar-swatch" style:background="#52d9a3"></span>
        <span class="hangar-chip-name">In client</span>
        <span class="hangar-chip-count">{onlineCount}</span>
      </button>
    </div>

    <!-- The picker is how the chip row scales past about five squads: pin the
         handful you use, keep the rest one click away. -->
    <div class="hangar-picker">
      <div class="hangar-chip" class:is-on={pickerOpen}>
        <button
          type="button"
          class="hangar-chip-select"
          aria-expanded={pickerOpen}
          onclick={() => {
            pickerOpen = !pickerOpen;
            squadQuery = "";
          }}
        >
          <span class="hangar-chip-name">All squads ({prefs.squads.length})</span>
          <span aria-hidden="true">▼</span>
        </button>
      </div>
      {#if pickerOpen}
        <div class="hangar-picker-panel">
          <div class="hangar-picker-search">
            <input
              class="hangar-input"
              type="search"
              aria-label="Search squads"
              placeholder="Search squads"
              bind:value={squadQuery}
            />
          </div>
          <div class="hangar-picker-list">
            {#each pickerSquads as squad (squad.id)}
              {@const isPinned = prefs.pinnedSquads.includes(squad.id)}
              <div class="hangar-picker-row">
                <button
                  type="button"
                  class="hangar-picker-select"
                  onclick={() => {
                    scope = { kind: "squad", value: squad.id };
                    pickerOpen = false;
                  }}
                >
                  <span class="hangar-swatch" style:background={squad.color}></span>
                  <span class="hangar-picker-name">{squad.name}</span>
                  <span class="hangar-picker-count">
                    {pilotCountLabel(squadMemberCount(prefs, squad.id, knownIDs))}
                  </span>
                </button>
                <button
                  type="button"
                  class="hangar-star"
                  class:is-on={isPinned}
                  aria-pressed={isPinned}
                  title={isPinned ? "Unpin from the chip row" : "Pin to the chip row"}
                  onclick={() => commit(togglePinnedSquad(prefs, squad.id))}
                >★</button>
                <button
                  type="button"
                  class="hangar-launch is-picker"
                  title={`Bring all of ${squad.name} online`}
                  onclick={() => launch(squadPilots(squad.id))}
                >▶ ALL</button>
              </div>
            {/each}
            {#if pickerSquads.length === 0}
              <div class="hangar-picker-empty">
                {prefs.squads.length === 0 ? "No squads yet." : "No squad matches that."}
              </div>
            {/if}
          </div>
          <button type="button" class="hangar-picker-new" onclick={() => newSquad()}>
            + New squad
          </button>
        </div>
      {/if}
    </div>
  </div>

  <div class="hangar-summary">
    <span>{scopeLabel(scope, prefs.squads)}</span>
    <span class="hangar-summary-bar" aria-hidden="true">|</span>
    <span>{totalsLabel(visible, pilots)}</span>
    {#if manage}
      <span class="hangar-summary-manage">
        manage mode — remove pilots, remove accounts, assign squads
      </span>
    {/if}
  </div>

  <main class="hangar-grid" class:has-selection={selectedPilots.length > 0}>
    {#each accounts as account (account.name)}
      {@const collapsed = prefs.collapsedAccounts.includes(account.name)}
      <article class="hangar-account">
        <div class="hangar-account-head">
          {#if !manage}
            <input
              type="checkbox"
              checked={accountAllSelected(account.pilots)}
              aria-label={`Select every pilot in ${account.name}`}
              onchange={() =>
                setAccountSelected(account.pilots, !accountAllSelected(account.pilots))}
            />
          {/if}
          <button
            type="button"
            class="hangar-caret"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Show ${account.name}` : `Hide ${account.name}`}
            onclick={() => commit(toggleCollapsedAccount(prefs, account.name))}
          >{collapsed ? "▶" : "▼"}</button>
          <span class="hangar-account-name">{account.name}</span>
          <span class="hangar-account-count">{pilotCountLabel(account.pilots.length)}</span>
          {#if !manage}
            <button
              type="button"
              class="hangar-launch is-account"
              title={`Bring every pilot in ${account.name} online`}
              onclick={() => launch(account.pilots)}
            >▶ ALL</button>
          {:else}
            <button
              type="button"
              class="hangar-remove"
              title={`Remove ${account.name} and its pilots from this list`}
              onclick={() => removeAccount(account.name)}
            >✕</button>
          {/if}
        </div>

        {#if !collapsed}
          <div class="hangar-pilots">
            {#each account.pilots as pilot (pilot.characterID)}
              <HangarPilotRow
                {pilot}
                {manage}
                {tapSelects}
                selected={selected.has(pilot.characterID)}
                squads={prefs.squads}
                squadMenuOpen={squadMenuFor === pilot.characterID}
                onActivate={() => launch([pilot])}
                onToggleSelect={() => toggleSelected(pilot.characterID)}
                onTogglePin={() => commit(togglePinnedPilot(prefs, pilot.characterID))}
                onRemove={() => removePilot(pilot.characterID)}
                onToggleSquadMenu={() =>
                  (squadMenuFor = squadMenuFor === pilot.characterID ? null : pilot.characterID)}
                onToggleSquad={(squadID) =>
                  commit(toggleSquadMember(prefs, squadID, pilot.characterID))}
              />
            {/each}
            {#each { length: account.emptySlots } as _, index (index)}
              <button
                type="button"
                class="hangar-slot"
                onclick={() => (addingTo = account.name)}
              >
                <span>+ Add character</span>
                <span class="hangar-slot-count">
                  slot {account.pilots.length + index + 1}/{MAX_SLOTS}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </article>
    {/each}
  </main>

  {#if pilots.length === 0}
    <div class="hangar-empty-screen">
      <div class="hangar-empty-title">No pilots yet</div>
      <p class="hangar-empty-copy">
        Add an EveJS account and its pilots appear here, grouped by account.
      </p>
      <button type="button" class="hangar-empty-action" onclick={() => (loginOpen = true)}>
        Add your first account
      </button>
    </div>
  {/if}

  {#if selectedPilots.length > 0}
    <div class="hangar-selbar">
      <div class="hangar-selbar-text">
        <span class="hangar-selbar-count">{selectionLabel(selectedPilots.length)}</span>
        <span class="hangar-selbar-detail">{selectionDetail(selectedPilots)}</span>
      </div>
      <div class="hangar-selbar-spacer"></div>
      <button type="button" class="hangar-ghost" onclick={saveSquadFromSelection}>
        Save as squad
      </button>
      <button type="button" class="hangar-ghost" onclick={() => (selected = new Set())}>
        Clear
      </button>
      <button type="button" class="hangar-primary" onclick={() => launch(selectedPilots)}>
        Bring online ▶
      </button>
    </div>
  {/if}
</div>

{#if queue.length > 0}
  <HangarLaunchProgress
    {queue}
    done={launchFinished(queue)}
    onGoToFirst={goToFirst}
    onStay={closeLaunchDialog}
  />
{/if}

{#if addingTo}
  <HangarAddCharacter
    accountName={addingTo}
    onClose={() => (addingTo = null)}
    onCreated={() => {
      addingTo = null;
      known = loadKnownCharacters();
    }}
  />
{/if}

{#if loginOpen}
  <HangarLoginDialog onClose={() => (loginOpen = false)} onAdded={afterLogin} />
{/if}

{#if editing}
  <!-- Keyed on the squad: opening a different one must reset the form, not
       leave the previous squad's name sitting in the field. -->
  {#key editing.id}
    <HangarSquadEditor
      squad={editing}
      isNew={editingIsNew}
      onSave={saveSquadEdit}
      onDelete={removeSquad}
      onCancel={() => closeSquadEditor(discardOnCancel)}
    />
  {/key}
{/if}
