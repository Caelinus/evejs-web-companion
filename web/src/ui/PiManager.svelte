<script lang="ts">
  // PLANETARY INDUSTRY (R108 slice 3) — every assigned pilot's colonies on one
  // board, READ-ONLY.
  //
  // ⚠ A GLOBAL WINDOW WITH NO STORE. Every other panel is a view of the mounted
  // pilot. This one is a view of the player's own PI roster, which spans
  // accounts, and it reads through its own throwaway sign-ins
  // (app/piRosterRead.ts) — so it takes no `store` and no `flow`, and a pilot
  // switch does not tear it down (globalWindow.ts).
  //
  // ⚠ NOTHING HERE SELECTS A CHARACTER. Reading a colony needs only ownership,
  // proved live; a select claims a hull, and a bot flying that pilot in another
  // tab would lose its ship without a word. Acting on a colony will go through
  // the bot host, which is the one thing that arbitrates hulls honestly.
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
  import { buildPiBoard, type PilotAttempt } from "../bridge/piBoard.ts";
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

  function keep(next: PiRosterPrefs): void {
    roster = next;
    savePiRoster(next);
  }

  const names = $derived(new Map(known.map((pilot) => [pilot.characterID, pilot.characterName])));
  const readings = $derived(piReadings(roster));
  const board = $derived(
    buildPiBoard({ members: roster.members, names, readings, attempts, browserNowMs, recipes }),
  );
  const addablePilots = $derived(
    known
      .filter((pilot) => !roster.members.includes(pilot.characterID))
      .sort((left, right) => left.characterName.localeCompare(right.characterName)),
  );
  const squadsWithNewPilots = $derived(
    hangar.squads.filter((squad) =>
      (hangar.members[squad.id] ?? []).some((id) => !roster.members.includes(id)),
    ),
  );

  async function refresh(): Promise<void> {
    if (reading || roster.members.length === 0) return;
    reading = true;
    known = loadKnownCharacters();
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

  {#if board.emptyWords}
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

  <!-- THE ROSTER: who is on planetary industry, and what each read said. The
       per-pilot sentence is where the four outcomes are told apart. -->
  <section class="pi-section" aria-labelledby="pi-pilots">
    <h3 id="pi-pilots">Pilots</h3>
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

  <!-- ⚠ SAID, NOT IMPLIED. What the manager cannot see (section 4 of the
       design): a pilot flown in another tab or on another device is invisible
       to everything here. Reading is safe regardless; acting will not be. -->
  <p class="note">
    Colonies are read without bringing any pilot online, so nothing here takes a
    ship from a pilot flying elsewhere.
  </p>
</section>

<style>
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
  }
</style>
