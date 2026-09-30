<script lang="ts">
  import { untrack } from "svelte";
  // Create a character. Reached from the select screen, and the only way off it
  // on an account with no characters at all.
  //
  // THE PLAYER PICKS FOUR THINGS: race, ancestry, gender, name. Everything else
  // the server decides, and there is a great deal of it — starter corporation,
  // station, rookie ship, 100k ISK, PLEX, 50k SP, attributes, employment
  // history, welcome mail, tutorial state. This screen deliberately does not
  // offer any of that, because none of it is a choice the world would honor.
  //
  // ANCESTRY, NOT BLOODLINE. Retail asks for both; the ancestries here are
  // GROUPED under their bloodline, so picking one names the bloodline too. That
  // is the id the write actually sends — CreateCharacterWithDoll derives race,
  // corp, station and rookie ship from the bloodline — so the grouping is not
  // decoration, it is the thing being chosen. An ancestry is preselected at
  // random so a player who does not care can ignore the whole column.
  //
  // THE NAME IS THE SERVER'S CALL. ValidateNameEx runs as the player types
  // (debounced) so a refusal — including "already taken", which no client-side
  // rule could know — arrives before they commit rather than after. It is still
  // only an early warning: the create runs the same validation server-side and
  // has the last word.
  import {
    loadCharCreationInfo,
    rollRandomCharacterName,
    validateCharacterName,
    loadCharacterCreationState,
    type CharacterCreationState,
  } from "../app/api.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { creationNeedsRecovery } from "../app/characterCreationSafety.ts";
  import {
    bloodlineChoicesForRace,
    bloodlineForAncestry,
    nameValidationMessage,
    type CharCreationTables,
  } from "../bridge/charCreation.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { flow, onCancel, onCreated, initialName = "" }: {
    flow: Pick<AppFlow, "requestOptions" | "createCharacter">;
    /** Back to the character list without creating anything. */
    onCancel: () => void;
    /** The new pilot exists and the roster has been re-read. */
    onCreated: (characterID: number | null) => void;
    /** Convenience prefill only; normal name validation is unchanged. */
    initialName?: string;
  } = $props();

  let tables = $state<CharCreationTables | null>(null);
  let loadError = $state("");

  let raceID = $state(0);
  let ancestryID = $state(0);
  let genderID = $state(1);
  let name = $state(untrack(() => initialName));

  let nameCode = $state<number | null>(null);
  let nameChecking = $state(false);
  let rollingName = $state(false);
  let creating = $state(false);
  let error = $state("");
  let creationState = $state<CharacterCreationState | null>(null);
  let uncertain = $state(false);

  const choices = $derived(tables ? bloodlineChoicesForRace(tables, raceID) : []);
  const bloodline = $derived(tables ? bloodlineForAncestry(tables, ancestryID) : null);
  const race = $derived(tables?.races.find((row) => row.raceID === raceID) ?? null);
  const nameProblem = $derived(nameValidationMessage(nameCode));
  const trimmedName = $derived(name.trim().replace(/\s+/g, " "));
  // Require the account/slot read and a positive name verdict. The BFF repeats
  // these checks at creation time and never retries an ambiguous dispatch.
  const canCreate = $derived(
    !creating && !uncertain && creationState !== null && creationState.freeSlots > 0 && !creationState.pendingName &&
      trimmedName.length > 0 && raceID > 0 && nameCode === 1,
  );

  /**
   * "an Ibis", not "a Ibis". A plain vowel rule, which is right for all four
   * corvettes this world has (Ibis, Impairor, Reaper, Velator) — ship names are
   * data, so a hull whose spelling fights the rule would need a better one.
   */
  function article(word: string): string {
    return /^[aeiou]/i.test(word) ? "an" : "a";
  }

  /** A random ancestry of this race — the "everything else can be random" default. */
  function rollAncestryFor(nextRaceID: number): number {
    if (!tables) {
      return 0;
    }
    const pool = bloodlineChoicesForRace(tables, nextRaceID).flatMap((choice) => choice.ancestries);
    if (pool.length === 0) {
      return 0;
    }
    return pool[Math.floor(Math.random() * pool.length)].ancestryID;
  }

  function chooseRace(nextRaceID: number): void {
    if (nextRaceID === raceID) {
      return;
    }
    raceID = nextRaceID;
    // The old ancestry belongs to the old race's bloodline, so it cannot stand.
    // Rolling rather than blanking keeps the form always-submittable.
    ancestryID = rollAncestryFor(nextRaceID);
  }

  async function load(): Promise<void> {
    loadError = "";
    try {
      creationState = await loadCharacterCreationState(flow.requestOptions());
      if (creationState.recoveredCharacterID) { onCreated(creationState.recoveredCharacterID); return; }
      const loaded = await loadCharCreationInfo(flow.requestOptions());
      tables = loaded;
      if (loaded.races.length > 0) {
        raceID = loaded.races[0].raceID;
        ancestryID = rollAncestryFor(raceID);
      }
    } catch (cause) {
      loadError =
        panelErrorWords(cause);
    }
  }

  // One load, at mount. The creation tables are static config — re-reading them
  // would be a poll against something that cannot change.
  $effect(() => {
    void load();
  });

  // Debounced name check. The timer is cleared on teardown AND on every keystroke,
  // so a burst of typing produces one read rather than one per character.
  $effect(() => {
    const candidate = trimmedName;
    if (!candidate) {
      nameCode = null;
      nameChecking = false;
      return;
    }
    nameChecking = true;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const code = await validateCharacterName(candidate, flow.requestOptions());
          // Ignore a verdict for a name the player has already typed past.
          if (candidate === trimmedName) {
            nameCode = code;
          }
        } catch {
          // A failed check is NOT a rejection — leave the last verdict alone and
          // let the create have the final word.
        } finally {
          if (candidate === trimmedName) {
            nameChecking = false;
          }
        }
      })();
    }, 350);
    return () => clearTimeout(handle);
  });

  async function rollName(): Promise<void> {
    if (rollingName || raceID <= 0) {
      return;
    }
    rollingName = true;
    error = "";
    try {
      const rolled = await rollRandomCharacterName(raceID, flow.requestOptions());
      if (rolled) {
        name = rolled;
      }
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally {
      rollingName = false;
    }
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    creating = true;
    error = "";
    try {
      const created = await flow.createCharacter({
        name: trimmedName,
        raceID,
        genderID,
        // Both are optional at the BFF, which rolls what it is not given. They
        // are sent because this screen HAS chosen them — an ancestry is
        // preselected, so "random" already happened here where it is visible.
        ...(bloodline ? { bloodlineID: bloodline.bloodlineID } : {}),
        ...(ancestryID > 0 ? { ancestryID } : {}),
      });
      onCreated(created.characterID);
    } catch (cause) {
      uncertain = creationNeedsRecovery(cause);
      error =
        cause instanceof BridgeCallError
          ? cause.code === "CharNameInvalid"
            ? "The server refused that name."
            : panelErrorWords(cause)
          : String(cause);
    } finally {
      creating = false;
    }
  }

  async function checkCreation(): Promise<void> {
    if (creating) return;
    creating = true;
    try {
      creationState = await loadCharacterCreationState(flow.requestOptions());
      const found = creationState.characters.find((row) => row.name.toLowerCase() === trimmedName.toLowerCase());
      if (creationState.recoveredCharacterID || found) onCreated(creationState.recoveredCharacterID || found!.characterID);
      else error = "Creation is not confirmed. Do not retry; inspect the account roster.";
    } catch (cause) { error = panelErrorWords(cause); }
    finally { creating = false; }
  }
</script>

<section class="panel">
  <header class="panel-head">
    <h2>New character</h2>
  </header>
  <p>Available slots: {creationState?.freeSlots ?? "UNKNOWN"} / {creationState?.slots ?? "UNKNOWN"}. Creation does not log the pilot in.</p>
  {#if creationState?.pendingName}<p class="error">Unresolved creation: {creationState.pendingName}. Inspect the roster before another create.</p>{/if}
  {#if uncertain || creationState?.pendingName}<button type="button" disabled={creating} onclick={checkCreation}>Check creation result (read only)</button>{/if}

  {#if loadError}
    <p class="error" role="alert">{loadError}</p>
    <p><button type="button" class="minor" onclick={onCancel}>Back to characters</button></p>
  {:else if tables === null}
    <p class="note">Loading the creation tables…</p>
  {:else if tables.races.length === 0}
    <p class="empty">This server has no character-creation tables, so nothing can be created here.</p>
    <p><button type="button" class="minor" onclick={onCancel}>Back to characters</button></p>
  {:else}
    <p class="note">
      Pick a race, a bloodline's ancestry, a gender and a name. Everything else —
      your corporation, station, first ship and starting skills — the server
      decides.
    </p>

    <form onsubmit={submit}>
      <fieldset class="create-group">
        <legend>Race</legend>
        <ul class="race-list">
          {#each tables.races as row (row.raceID)}
            <li>
              <button
                type="button"
                class="race-card"
                class:selected={row.raceID === raceID}
                aria-pressed={row.raceID === raceID}
                disabled={creating}
                onclick={() => chooseRace(row.raceID)}
              >
                <TypeIcon typeID={row.shipTypeID} name={row.shipName} size="sm" />
                <span class="race-text">
                  <span class="name">{row.raceName}</span>
                  <span class="detail">Starts in {article(row.shipName)} {row.shipName}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </fieldset>

      <fieldset class="create-group">
        <legend>Ancestry</legend>
        <p class="note subtle">
          Grouped by bloodline — your pick names the bloodline too. One is chosen
          at random; change it or leave it.
        </p>
        {#each choices as choice (choice.bloodline.bloodlineID)}
          <div class="bloodline-group">
            <h3 class="bloodline-name">{choice.bloodline.bloodlineName}</h3>
            {#if choice.ancestries.length === 0}
              <p class="detail">No ancestries recorded for this bloodline.</p>
            {:else}
              <ul class="ancestry-list">
                {#each choice.ancestries as row (row.ancestryID)}
                  <li>
                    <button
                      type="button"
                      class="ancestry-card"
                      class:selected={row.ancestryID === ancestryID}
                      aria-pressed={row.ancestryID === ancestryID}
                      disabled={creating}
                      onclick={() => (ancestryID = row.ancestryID)}
                    >
                      <span class="name">{row.name}</span>
                      <span class="detail">{row.shortDescription}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      </fieldset>

      <fieldset class="create-group">
        <legend>Gender</legend>
        <div class="gender-row">
          <button
            type="button"
            class="gender-card"
            class:selected={genderID === 1}
            aria-pressed={genderID === 1}
            disabled={creating}
            onclick={() => (genderID = 1)}
          >Male</button>
          <button
            type="button"
            class="gender-card"
            class:selected={genderID === 0}
            aria-pressed={genderID === 0}
            disabled={creating}
            onclick={() => (genderID = 0)}
          >Female</button>
        </div>
      </fieldset>

      <label>
        Name
        <input
          type="text"
          bind:value={name}
          autocomplete="off"
          spellcheck="false"
          placeholder="Three to thirty-seven characters"
          disabled={creating}
        />
      </label>
      <p class="name-status" aria-live="polite">
        {#if !trimmedName}
          <span class="detail">A name is required.</span>
        {:else if nameProblem}
          <span class="error-inline">{nameProblem}</span>
        {:else if nameChecking}
          <span class="detail">Checking that name…</span>
        {:else if nameCode === 1}
          <span class="ok-inline">That name is available.</span>
        {:else}
          <span class="detail">The server will check this name when you create.</span>
        {/if}
      </p>

      <div class="create-actions">
        <button type="button" class="minor" disabled={rollingName || creating} onclick={rollName}>
          {rollingName ? "Rolling…" : "Roll a name"}
        </button>
        <button type="submit" class="primary" disabled={!canCreate}>
          {creating ? "Creating…" : "Create character"}
        </button>
        <button type="button" class="minor" disabled={creating} onclick={onCancel}>Cancel</button>
      </div>
    </form>

    {#if race}
      <p class="detail create-summary">
        {race.raceName}{bloodline ? ` · ${bloodline.bloodlineName}` : ""} · starts in
        {article(race.shipName)} {race.shipName}.
      </p>
    {/if}
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  {/if}
</section>
