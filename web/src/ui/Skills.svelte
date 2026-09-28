<script lang="ts">
  // Goal R28: the character sheet, and the queue of what to train next.
  //
  // Skills were the one major retail system with a complete server-side
  // implementation and no client surface at all: R9b deleted the legacy UI and
  // nothing replaced it. This is the replacement.
  //
  // THIS PANEL COMPUTES NO GAME MECHANIC. The SP required for each level, the
  // training rate, the prerequisite tree and the Omega/Alpha rules are all the
  // server's; they arrive already evaluated on the sheet. What happens here is
  // arrangement: skills into their groups, SP between two thresholds, and a bar
  // interpolated between two reads.
  //
  // THE CLOCK MOVES, AND IT IS NOT OURS. `nowMs` ticks once a second purely to
  // redraw; every value it feeds is derived from the SERVER's start/end instants
  // and its own SP-per-minute, offset by the difference between the two machines'
  // clocks measured at read time. Nothing is ever advanced past what the server
  // said, and when the current skill's finish time passes, the panel RE-READS
  // rather than declaring the skill trained on its own authority.
  import { onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  // R27's shared item icon. This is the panel it was waiting for: the icon
  // cache covers every skill type, so here — uniquely — the pictures are the
  // normal case and the lettered tile is the exception.
  import TypeIcon from "./TypeIcon.svelte";
  import {
    formatDuration,
    formatSkillPoints,
    freeSkillPointsPlan,
    groupSkills,
    levelSquares,
    romanLevel,
    serverNow,
    skillProgress,
    trainingReadout,
  } from "../bridge/skills.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { SkillRow } from "../store/types.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const skills = store.skills;

  let busy = $state(false);
  let error = $state("");
  let filter = $state("");
  /**
   * Groups the player has FOLDED AWAY.
   *
   * Deliberately the inverse of an "open" list: the sheet opens showing
   * everything, because "what do I know" is the question the panel exists to
   * answer and a wall of closed headers answers it with nothing. Folding is
   * there for the player who wants to get past Spaceship Command's ninety-one
   * rows, not a state they have to escape from first.
   */
  let collapsed = $state<string[]>([]);
  /** Redraw tick. Display only — never a source of truth about SP or time. */
  let nowMs = $state(Date.now());
  /** The finish instant we have already asked the server to confirm. */
  let confirmedFinishAt = $state<number | null>(null);

  const sheet = $derived($skills);
  const queue = $derived(sheet.queue);
  const allSkills = $derived(sheet.skills ?? []);
  const groups = $derived(groupSkills(allSkills));

  /** What the SERVER would call now, on this browser's clock. */
  const serverNowMs = $derived(serverNow(sheet.clockOffsetMs, nowMs));
  const training = $derived(trainingReadout(queue, serverNowMs));

  const byTypeID = $derived(new Map(allSkills.map((skill) => [skill.typeID, skill])));

  function skillName(typeID: number): string {
    return byTypeID.get(typeID)?.name ?? "—";
  }

  const needle = $derived(filter.trim().toLowerCase());
  const matchingGroups = $derived(
    needle === ""
      ? groups
      : groups
          .map((group) => ({
            ...group,
            skills: group.skills.filter(
              (skill) =>
                skill.name.toLowerCase().includes(needle) ||
                group.groupName.toLowerCase().includes(needle),
            ),
          }))
          .filter((group) => group.skills.length > 0),
  );

  /**
   * The level a "train the next one" button would ask for: one above whatever
   * the character has OR has already planned. Null when there is nothing left.
   *
   * This is arithmetic on two numbers the server gave us, not a judgement about
   * whether the level is trainable — prerequisites, Omega gating and the SP cap
   * are the server's to refuse, and it does, in words the player can act on.
   */
  function nextLevelFor(skill: SkillRow): number | null {
    const planned = (queue?.entries ?? []).reduce(
      (highest, entry) => (entry.typeID === skill.typeID ? Math.max(highest, entry.toLevel) : highest),
      skill.level,
    );
    return planned >= 5 ? null : planned + 1;
  }

  /** The queue as the wire wants it: position order, typeID and level only. */
  function currentEntries(): { typeID: number; toLevel: number }[] {
    return (queue?.entries ?? []).map((entry) => ({
      typeID: entry.typeID,
      toLevel: entry.toLevel,
    }));
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error =
          panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  // Every edit below is the SAME call: save the whole list. That is how the
  // server models a queue, and inventing add/remove/move verbs on top of it
  // would only create three ways to disagree with it.
  async function addNextLevel(skill: SkillRow): Promise<void> {
    const level = nextLevelFor(skill);
    if (level === null) {
      return;
    }
    await run(() =>
      flow.saveSkillQueue(
        [...currentEntries(), { typeID: skill.typeID, toLevel: level }],
        `Added ${skill.name} ${romanLevel(level)} to the queue`,
        skill.name,
      ),
    );
  }

  /** Unallocated skill points the sheet says the character is holding. */
  const freeSkillPoints = $derived(sheet.freeSkillPoints ?? 0);

  async function applyFreePoints(skill: SkillRow, points: number): Promise<void> {
    if (points <= 0) {
      return;
    }
    await run(() => flow.applyFreeSkillPoints(skill.typeID, points));
  }

  async function removeAt(index: number): Promise<void> {
    const entries = currentEntries();
    const removed = entries[index];
    if (!removed) {
      return;
    }
    await run(() =>
      flow.saveSkillQueue(
        entries.filter((_, position) => position !== index),
        `Took ${skillName(removed.typeID)} off the queue`,
        skillName(removed.typeID),
      ),
    );
  }

  async function move(index: number, delta: number): Promise<void> {
    const entries = currentEntries();
    const target = index + delta;
    if (!entries[index] || !entries[target]) {
      return;
    }
    const reordered = [...entries];
    reordered[index] = entries[target]!;
    reordered[target] = entries[index]!;
    await run(() =>
      flow.saveSkillQueue(
        reordered,
        `Moved ${skillName(entries[index]!.typeID)} ${delta < 0 ? "up" : "down"}`,
        skillName(entries[index]!.typeID),
      ),
    );
  }

  async function pauseTraining(): Promise<void> {
    await run(() => flow.saveSkillQueue([], "Stopped training", "your queue"));
  }

  function finishText(endTimeMs: number | null): string {
    if (endTimeMs === null) {
      return "not known";
    }
    return `${formatDuration(Math.max(0, endTimeMs - serverNowMs))} from now`;
  }

  onMount(() => {
    void run(() => flow.loadSkills());
    // One second is the coarsest tick that still reads as a moving clock. The
    // interval only redraws; it never advances a number by itself.
    const handle = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    return () => clearInterval(handle);
  });

  // ⚠ THE SERVER FINISHES SKILLS, NOT US. When the current entry's end time
  // passes, this asks for a fresh sheet exactly once per finish instant instead
  // of promoting the skill locally. If the re-read disagrees with what the
  // countdown showed, the re-read is what the player sees.
  $effect(() => {
    const readout = training;
    if (readout === null || readout.remainingMs > 0 || busy) {
      return;
    }
    if (confirmedFinishAt === readout.finishAtMs) {
      return;
    }
    confirmedFinishAt = readout.finishAtMs;
    void run(() => flow.loadSkills());
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Skills</h2>
    <span class="controls">
      <button type="button" disabled={busy} onclick={() => run(() => flow.loadSkills())}>
        Refresh
      </button>
    </span>
  </header>
  <!-- ⚠ THE DESCRIPTION WENT, THE CLOCK STAYED. "What you know, and what you
       are learning next" is the window's own title in a longer form; where the
       training actually runs is the thing a player would otherwise assume
       wrongly, and assume expensively. -->
  <p class="note">
    Training runs on the server's clock — it keeps going whether or not this
    page is open.
  </p>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if sheet.error}
    <p class="error">{sheet.error}</p>
  {/if}
  {#if sheet.actionError}
    <p class="error">{sheet.actionError}</p>
  {/if}
  {#if sheet.lastAction && !sheet.actionError}
    <p class="note">{sheet.lastAction}.</p>
  {/if}

  {#if sheet.loaded}
    <ul class="hold-strip">
      <li><span class="hold-name">Skill points</span>
        <span class="hold-fill">{formatSkillPoints(sheet.totalSkillPoints ?? 0)}</span></li>
      <li><span class="hold-name">Skills known</span>
        <span class="hold-fill">{allSkills.length}</span></li>
      <li><span class="hold-name">Groups</span>
        <span class="hold-fill">{groups.length}</span></li>
      {#if (sheet.freeSkillPoints ?? 0) > 0}
        <li><span class="hold-name">Unallocated</span>
          <span class="hold-fill">{formatSkillPoints(sheet.freeSkillPoints ?? 0)}</span></li>
      {/if}
    </ul>
  {/if}
</section>

<section>
  <h2>Training now</h2>
  {#if !sheet.loaded}
    <p class="note">Reading your skill sheet…</p>
  {:else if queue === null}
    <p class="error">
      Your training queue could not be read, so what you are learning is unknown.
    </p>
  {:else if training === null}
    <p class="empty">
      Nothing is training. Pick a skill below and add it to the queue.
    </p>
  {:else}
    <div class="hud-gauge">
      <div class="hud-head">
        <span class="cell-item">
          <TypeIcon typeID={training.typeID} name={skillName(training.typeID)} size="md" />
          <span class="hud-label">{skillName(training.typeID)} {romanLevel(training.toLevel)}</span>
        </span>
        <span class="hud-value">{formatDuration(training.remainingMs)} left</span>
      </div>
      <div
        class="hud-track"
        role="meter"
        aria-label={`${skillName(training.typeID)} ${romanLevel(training.toLevel)} training progress`}
        aria-valuenow={Math.round(training.fraction * 100)}
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <span class="hud-fill" style={`width: ${training.fraction * 100}%`}></span>
      </div>
      <p class="note">
        {formatSkillPoints(training.skillPoints)} of
        {formatSkillPoints(training.destinationSP)} skill points,
        at {formatSkillPoints(training.skillPointsPerMinute)} a minute.
      </p>
    </div>
  {/if}
</section>

<section>
  <header class="panel-head">
    <h2>Up next</h2>
    <span class="controls">
      {#if (queue?.entries.length ?? 0) > 0}
        <button type="button" disabled={busy} onclick={pauseTraining}>Stop training</button>
      {/if}
    </span>
  </header>
  {#if queue === null}
    <p class="error">The queue could not be read.</p>
  {:else if queue.entries.length === 0}
    <p class="empty">The queue is empty.</p>
  {:else}
    <p class="note">
      {queue.entries.length} of {queue.maxEntries} places used. Everything on the
      queue finishes {finishText(queue.endTimeMs)}.
    </p>
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Skill</th>
            <th>To</th>
            <th class="num">Finishes</th>
            <th>Order</th>
          </tr>
        </thead>
        <tbody>
          {#each queue.entries as entry, index (`${entry.typeID}-${entry.toLevel}-${index}`)}
            <tr>
              <td data-label="Skill">
                <span class="cell-item">
                  <TypeIcon typeID={entry.typeID} name={skillName(entry.typeID)} />
                  <span>{skillName(entry.typeID)}</span>
                </span>
              </td>
              <td data-label="To">{romanLevel(entry.toLevel)}</td>
              <td data-label="Finishes" class="num">{finishText(entry.endTimeMs)}</td>
              <td data-label="Order">
                <span class="queue-controls">
                  <button
                    type="button"
                    disabled={busy || index === 0}
                    aria-label={`Move ${skillName(entry.typeID)} earlier`}
                    onclick={() => move(index, -1)}
                  >Up</button>
                  <button
                    type="button"
                    disabled={busy || index === queue.entries.length - 1}
                    aria-label={`Move ${skillName(entry.typeID)} later`}
                    onclick={() => move(index, 1)}
                  >Down</button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Take ${skillName(entry.typeID)} off the queue`}
                    onclick={() => removeAt(index)}
                  >Remove</button>
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<section>
  <header class="panel-head">
    <h2>What you know</h2>
    <span class="controls">
      <label>
        Find a skill
        <input type="search" bind:value={filter} placeholder="Gunnery, Shields…" />
      </label>
    </span>
  </header>
  {#if !sheet.loaded}
    <p class="note">Reading your skill sheet…</p>
  {:else if sheet.skills === null}
    <p class="error">Your skills could not be read.</p>
  {:else if matchingGroups.length === 0}
    <p class="empty">No skill matches that.</p>
  {:else}
    {#each matchingGroups as group (group.groupName)}
      <h3>
        <button
          type="button"
          class="group-toggle"
          aria-expanded={!collapsed.includes(group.groupName)}
          onclick={() => (collapsed = collapsed.includes(group.groupName)
            ? collapsed.filter((name) => name !== group.groupName)
            : [...collapsed, group.groupName])}
        >
          {group.groupName}
        </button>
        <small class="note">
          {group.maxedCount} of {group.skills.length} at V ·
          {formatSkillPoints(group.totalSkillPoints)} skill points
        </small>
      </h3>
      {#if !collapsed.includes(group.groupName)}
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Level</th>
                <th class="num">Skill points</th>
                <th>Train</th>
              </tr>
            </thead>
            <tbody>
              {#each group.skills as skill (skill.typeID)}
                <tr>
                  <td data-label="Skill">
                    <span class="cell-item">
                      <TypeIcon typeID={skill.typeID} name={skill.name} />
                      <span>{skill.name}</span>
                    </span>
                  </td>
                  <td data-label="Level">
                    <span class="rank" role="img" aria-label={`Level ${romanLevel(skill.level) || "zero"}`}>
                      {#each levelSquares(skill, queue) as state}
                        <span class="rank-pip rank-{state}"></span>
                      {/each}
                    </span>
                  </td>
                  <td data-label="Skill points" class="num">
                    {formatSkillPoints(skill.skillPoints)}
                    {#if skillProgress(skill).nextLevelSkillPoints !== null}
                      <small class="note">
                        of {formatSkillPoints(skillProgress(skill).nextLevelSkillPoints ?? 0)}
                        for {romanLevel(skillProgress(skill).nextLevel ?? 0)}
                      </small>
                    {/if}
                  </td>
                  <td data-label="Train">
                    {#if nextLevelFor(skill) === null}
                      <span class="badge good">Finished</span>
                    {:else}
                      <button
                        type="button"
                        disabled={busy}
                        onclick={() => addNextLevel(skill)}
                      >Queue {romanLevel(nextLevelFor(skill) ?? 0)}</button>
                    {/if}
                    <!--
                      Unallocated SP had no way to be spent at all: the sheet
                      counted them and offered nothing. The button appears only
                      on rows where the server would accept them, and says the
                      AMOUNT — which is capped by what the level still needs and
                      by what is actually held, whichever is smaller.
                    -->
                    {#if freeSkillPoints > 0}
                      {@const plan = freeSkillPointsPlan(skill, freeSkillPoints)}
                      {#if plan.points > 0}
                        <button
                          type="button"
                          class="minor"
                          disabled={busy}
                          title={`Spend ${formatSkillPoints(plan.points)} of your unallocated skill points on ${skill.name}`}
                          onclick={() => applyFreePoints(skill, plan.points)}
                        >Apply {formatSkillPoints(plan.points)} SP</button>
                      {/if}
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/each}
  {/if}
</section>
