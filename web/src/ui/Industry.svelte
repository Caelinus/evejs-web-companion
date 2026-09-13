<script lang="ts">
  // Industry page (goal R15): the player's blueprints with their efficiencies
  // and runs, the jobs they have running or waiting to collect, and the
  // facilities their region offers — everything BY NAME.
  //
  // A pure reader of the store's industry slice. Every call lives on the BFF
  // and in app/flow.ts; every identifier is translated to a name in
  // bridge/industry.ts before it reaches this file. Nothing here shows an
  // activityID, a status code, a blueprint typeID or a facilityID (R7d), and
  // nothing here computes a job outcome — the status a job shows, including
  // whether it is ready, is the one the SERVER returned.
  import { onMount } from "svelte";
  import {
    ACTIVITY_LABELS,
    ACTIVITY_ORDER,
    STATUS_LABELS,
    formatDuration,
    isActiveJob,
    previewMaterials,
    previewTimeSeconds,
    recipeFor,
    secondsUntil,
  } from "../bridge/industry.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type {
    IndustryActivity,
    IndustryBlueprintRow,
    IndustryJobRow,
  } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  // R27 — the shared item icon: one cached picture per thing, falling back
  // to a name-derived tile whenever the icon cache has no entry (or no cache).
  import TypeIcon from "./TypeIcon.svelte";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const industry = store.industry;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  let busy = $state(false);
  let error = $state("");
  /** Ticks once a second so job countdowns stay live without a server poll. */
  let nowMs = $state(Date.now());

  function typeName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID);
  }

  /** A facility's name. An NPC facility's id IS its station id, so the shared
   * station name cache answers it; a structure the cache does not know reads
   * as "an unnamed facility" rather than falling back to its number —
   * `resolvedName` is the R7d helper that never returns a raw ID. */
  function facilityName(facilityID: number): string {
    return resolvedName($names.resolved, "station", facilityID, "An unnamed facility");
  }

  function systemName(solarSystemID: number): string {
    return resolvedName($names.resolved, "system", solarSystemID, "an unknown system");
  }

  /** What a blueprint makes, from its static recipe. */
  function productName(blueprintTypeID: number): string | null {
    const definition = $industry.definitions[blueprintTypeID];
    if (!definition) {
      return null;
    }
    if (definition.productName) {
      return definition.productName;
    }
    return definition.productTypeID ? typeName(definition.productTypeID) : null;
  }

  /** Which activities a blueprint supports, as names the player can read. */
  function blueprintActivities(blueprintTypeID: number): readonly IndustryActivity[] {
    const definition = $industry.definitions[blueprintTypeID];
    return definition ? definition.recipes.map((recipe) => recipe.activity) : [];
  }

  /**
   * A blueprint's runs, in words. An ORIGINAL never runs out, so showing it a
   * run count would be actively misleading — the server's `runs` field is only
   * meaningful for a copy.
   */
  function runsText(blueprint: IndustryBlueprintRow): string {
    return blueprint.original ? "Unlimited (original)" : `${blueprint.runs} left`;
  }

  /** How long a running job has to go, or why it has no countdown. */
  function jobTimeText(job: IndustryJobRow): string {
    if (job.status === "ready") {
      return "Finished — collect it";
    }
    if (!isActiveJob(job.status)) {
      return "—";
    }
    const remaining = secondsUntil(job.endDate, nowMs);
    if (remaining === null) {
      return "Unknown";
    }
    // A job past its end date that the server still calls "running" is simply
    // waiting to be re-read; say so rather than showing a negative countdown.
    return remaining <= 0 ? "Any moment now" : formatDuration(remaining);
  }

  const activeJobs = $derived.by(() => $industry.jobs.filter((job) => isActiveJob(job.status)));
  const finishedJobs = $derived.by(() =>
    $industry.jobs.filter((job) => !isActiveJob(job.status)),
  );

  /** Job slots in use, by activity name — only the activities actually used. */
  const slotRows = $derived.by(() =>
    ACTIVITY_ORDER.map((activity) => ({
      activity,
      used: $industry.slotsUsed[activity] ?? 0,
    })).filter((row) => row.used > 0),
  );

  /** Facilities that are online and will host at least one activity. */
  const usableFacilities = $derived.by(() =>
    $industry.facilities.filter((facility) => facility.activities.length > 0),
  );

  function taxText(tax: number | null): string {
    if (tax === null) {
      return "Unknown";
    }
    // The server speaks in fractions; players read percentages.
    const percent = tax * 100;
    return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
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

  // --- Starting a job ------------------------------------------------------
  // A three-step flow, because installing SPENDS things: pick a blueprint ->
  // choose the work, where, and how many runs -> see what it will take and
  // confirm. The BFF refuses an install without an explicit confirmation flag
  // too, so neither a stray click nor a stray request can spend anything.

  /** The blueprint the player is setting a job up for, or null. */
  let startingBlueprint = $state<IndustryBlueprintRow | null>(null);
  let chosenActivity = $state<IndustryActivity | null>(null);
  let chosenFacilityID = $state<number | null>(null);
  let chosenRuns = $state(1);
  /** typeID -> how much of it the player HAS, read from the SERVER. */
  let availableMaterials = $state<Readonly<Record<string, number>> | null>(null);
  /** True once the player has asked to see the cost — the second step. */
  let confirming = $state(false);
  /** The job awaiting an explicit "yes, cancel it" — never a one-click loss. */
  let cancellingJobID = $state<number | null>(null);

  /** Facilities that will take the chosen kind of work and are online. */
  const facilityChoices = $derived.by(() =>
    $industry.facilities.filter(
      (facility) =>
        facility.online &&
        (chosenActivity === null || facility.activities.includes(chosenActivity)),
    ),
  );

  const chosenRecipe = $derived.by(() => {
    if (!startingBlueprint || !chosenActivity) {
      return null;
    }
    return recipeFor($industry.definitions[startingBlueprint.typeID], chosenActivity);
  });

  /** Roughly what this job will consume, paired with what the player has. */
  const materialLines = $derived.by(() => {
    if (!startingBlueprint) {
      return [];
    }
    return previewMaterials(
      chosenRecipe,
      chosenRuns,
      startingBlueprint.materialEfficiency,
    ).map((material) => {
      const have =
        availableMaterials === null ? null : availableMaterials[String(material.typeID)] ?? 0;
      return {
        typeID: material.typeID,
        need: material.quantity,
        have,
        short: have !== null && have < material.quantity,
      };
    });
  });

  const previewTime = $derived.by(() =>
    startingBlueprint
      ? previewTimeSeconds(chosenRecipe, chosenRuns, startingBlueprint.timeEfficiency)
      : 0,
  );

  /** The most runs this blueprint could be asked for. A copy is finite. */
  const maxRuns = $derived.by(() => {
    if (!startingBlueprint) {
      return 1;
    }
    return startingBlueprint.original ? 1000 : Math.max(1, startingBlueprint.runs);
  });

  function startJobFor(blueprint: IndustryBlueprintRow): void {
    startingBlueprint = blueprint;
    confirming = false;
    availableMaterials = null;
    chosenRuns = 1;
    const activities = blueprintActivities(blueprint.typeID);
    chosenActivity = activities.length > 0 ? activities[0]! : null;
    chosenFacilityID = null;
  }

  function closeStartJob(): void {
    startingBlueprint = null;
    chosenActivity = null;
    chosenFacilityID = null;
    availableMaterials = null;
    confirming = false;
  }

  /** Step two: ask the SERVER what the player actually has, then confirm. */
  function askToConfirm(): void {
    const blueprint = startingBlueprint;
    const activity = chosenActivity;
    const facilityID = chosenFacilityID;
    if (!blueprint || !activity || facilityID === null) {
      return;
    }
    void run(async () => {
      availableMaterials = await flow.previewIndustryJob({
        blueprintItemID: blueprint.itemID,
        blueprintTypeID: blueprint.typeID,
        activity,
        facilityID,
        runs: chosenRuns,
      });
      confirming = true;
    });
  }

  function confirmInstall(): void {
    const blueprint = startingBlueprint;
    const activity = chosenActivity;
    const facilityID = chosenFacilityID;
    if (!blueprint || !activity || facilityID === null) {
      return;
    }
    void run(async () => {
      await flow.installIndustryJob({
        blueprintItemID: blueprint.itemID,
        blueprintTypeID: blueprint.typeID,
        activity,
        facilityID,
        runs: chosenRuns,
      });
      closeStartJob();
    });
  }

  function deliver(jobID: number): void {
    void run(() => flow.deliverIndustryJob(jobID));
  }

  function cancelJob(jobID: number): void {
    cancellingJobID = null;
    void run(() => flow.cancelIndustryJob(jobID));
  }

  onMount(() => {
    void run(() => flow.loadIndustry());
    const timer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Industry</h2>
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={() => run(() => flow.loadIndustry())}>
        Refresh
      </button>
    </p>
  </header>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $industry.actionError}
    <p class="error">Last change failed: {$industry.actionError}</p>
  {/if}
  {#if !$industry.loaded}
    <p class="note">Loading your industry…</p>
  {/if}
</section>

{#if $industry.loaded}
  <section>
    <h2>Jobs you have running</h2>
    {#if $industry.jobsError}
      <p class="error">Your jobs could not be loaded: {$industry.jobsError}</p>
    {/if}
    {#if slotRows.length > 0}
      <p class="note">
        Job slots in use:
        {#each slotRows as row, index (row.activity)}{index > 0
            ? ", "
            : ""}{ACTIVITY_LABELS[row.activity]} {row.used}{/each}.
      </p>
    {/if}
    {#if activeJobs.length === 0}
      <p class="empty">Nothing in progress right now.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Making</th>
              <th>Work</th>
              <th class="num">Runs</th>
              <th>Where</th>
              <th>Status</th>
              <th class="num">Time left</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each activeJobs as job (job.jobID)}
              <tr>
                <td data-label="Making">{typeName(job.productTypeID)}</td>
                <td data-label="Work">
                  {job.activity ? ACTIVITY_LABELS[job.activity] : "Unknown work"}
                </td>
                <td class="num" data-label="Runs">{job.runs}</td>
                <td data-label="Where">{facilityName(job.facilityID)}</td>
                <td data-label="Status">{STATUS_LABELS[job.status]}</td>
                <td class="num" data-label="Time left">{jobTimeText(job)}</td>
                <td data-label="Action">
                  <div class="row-actions">
                    {#if job.status === "ready"}
                      <button type="button" disabled={busy} onclick={() => deliver(job.jobID)}>
                        Collect the results
                      </button>
                    {/if}
                    {#if cancellingJobID === job.jobID}
                      <button
                        type="button"
                        class="danger"
                        disabled={busy}
                        onclick={() => cancelJob(job.jobID)}
                      >
                        Yes, stop it and lose the materials
                      </button>
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => (cancellingJobID = null)}
                      >
                        Keep it running
                      </button>
                    {:else}
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => (cancellingJobID = job.jobID)}
                      >
                        Stop this job…
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if cancellingJobID !== null}
        <p class="error">
          Stopping a job gives the blueprint back, but the materials it already
          used and the fee you paid to start it are gone for good.
        </p>
      {/if}
    {/if}
  </section>

  {#if finishedJobs.length > 0}
    <section>
      <h2>Jobs you have finished</h2>
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Made</th>
              <th>Work</th>
              <th class="num">Runs</th>
              <th>Where</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {#each finishedJobs as job (job.jobID)}
              <tr>
                <td data-label="Made">{typeName(job.productTypeID)}</td>
                <td data-label="Work">
                  {job.activity ? ACTIVITY_LABELS[job.activity] : "Unknown work"}
                </td>
                <td class="num" data-label="Runs">
                  {job.status === "cancelled" ? "—" : job.successfulRuns || job.runs}
                </td>
                <td data-label="Where">{facilityName(job.facilityID)}</td>
                <td data-label="Outcome">{STATUS_LABELS[job.status]}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}

  <section>
    <h2>Your blueprints</h2>
    {#if $industry.blueprintsError}
      <p class="error">Your blueprints could not be loaded: {$industry.blueprintsError}</p>
    {/if}
    {#if $industry.blueprints.length === 0}
      <p class="empty">You do not own any blueprints.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Blueprint</th>
              <th>Makes</th>
              <th class="num">Runs</th>
              <th class="num">Material efficiency</th>
              <th class="num">Time efficiency</th>
              <th>Can be used for</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each $industry.blueprints as blueprint (blueprint.itemID)}
              <tr class={startingBlueprint?.itemID === blueprint.itemID ? "self" : ""}>
                <td data-label="Blueprint">
                  <span class="cell-item">
                    <TypeIcon typeID={blueprint.typeID} name={typeName(blueprint.typeID)} />
                    {typeName(blueprint.typeID)}
                  </span>
                  {#if blueprint.jobID !== null}
                    <small class="note">in use by a job</small>
                  {/if}
                </td>
                <td data-label="Makes">{productName(blueprint.typeID) ?? "—"}</td>
                <td class="num" data-label="Runs">{runsText(blueprint)}</td>
                <!-- Spelled out, never "ME"/"TE" (R9a). -->
                <td class="num" data-label="Material efficiency">
                  {blueprint.materialEfficiency}% saved
                </td>
                <td class="num" data-label="Time efficiency">{blueprint.timeEfficiency}% faster</td>
                <td data-label="Can be used for">
                  {#if blueprintActivities(blueprint.typeID).length === 0}
                    <span class="note">—</span>
                  {:else}
                    {blueprintActivities(blueprint.typeID)
                      .map((activity) => ACTIVITY_LABELS[activity])
                      .join(", ")}
                  {/if}
                </td>
                <td data-label="Action">
                  {#if blueprint.jobID !== null}
                    <span class="note">Busy</span>
                  {:else if startingBlueprint?.itemID === blueprint.itemID}
                    <button type="button" class="minor" disabled={busy} onclick={closeStartJob}>
                      Never mind
                    </button>
                  {:else}
                    <button type="button" disabled={busy} onclick={() => startJobFor(blueprint)}>
                      Start a job…
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  {#if startingBlueprint}
    <section class="bulk">
      <h2>Start a job with {typeName(startingBlueprint.typeID)}</h2>
      {#if blueprintActivities(startingBlueprint.typeID).length === 0}
        <p class="note">
          Nothing is known about what this blueprint can be used for, so a job
          cannot be set up for it here.
        </p>
      {:else}
        <p class="controls">
          <label>
            Work
            <select bind:value={chosenActivity} disabled={busy || confirming}>
              {#each blueprintActivities(startingBlueprint.typeID) as activity (activity)}
                <option value={activity}>{ACTIVITY_LABELS[activity]}</option>
              {/each}
            </select>
          </label>
          <label>
            Where
            <select bind:value={chosenFacilityID} disabled={busy || confirming}>
              <option value={null}>Choose a facility…</option>
              {#each facilityChoices as facility (facility.facilityID)}
                <option value={facility.facilityID}>
                  {facilityName(facility.facilityID)} — {systemName(facility.solarSystemID)}
                </option>
              {/each}
            </select>
          </label>
          <label>
            Runs
            <input
              type="number"
              min="1"
              max={maxRuns}
              bind:value={chosenRuns}
              disabled={busy || confirming}
            />
          </label>
        </p>

        {#if facilityChoices.length === 0}
          <p class="note">
            No facility where you are will take that kind of work.
          </p>
        {/if}

        {#if !confirming}
          <p class="controls">
            <button
              type="button"
              disabled={busy || chosenActivity === null || chosenFacilityID === null || chosenRuns < 1}
              onclick={askToConfirm}
            >
              See what this will take
            </button>
          </p>
        {:else}
          <h3>What this job will use</h3>
          {#if materialLines.length === 0}
            <p class="empty">This job does not use any materials.</p>
          {:else}
            <div class="table-wrap overflow-x-auto">
              <table class="guests reflow">
                <thead>
                  <tr><th>Material</th><th class="num">It will use about</th><th class="num">You have</th></tr>
                </thead>
                <tbody>
                  {#each materialLines as line (line.typeID)}
                    <tr class={line.short ? "self" : ""}>
                      <td data-label="Material">
                        <span class="cell-item">
                          <TypeIcon typeID={line.typeID} name={typeName(line.typeID)} />
                          {typeName(line.typeID)}
                        </span>
                      </td>
                      <td class="num" data-label="It will use about">{line.need}</td>
                      <td class="num" data-label="You have">
                        {line.have === null ? "—" : line.have}
                        {#if line.short}
                          <small class="note">not enough</small>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          <p class="note">
            It should take about {formatDuration(previewTime)}. The amounts above
            are an estimate — the facility you picked may work out cheaper, and
            the station also charges a fee to start the job. Both are worked out
            by the server when you confirm, and you will see what was actually
            charged straight afterwards.
          </p>
          <p class="error">
            Starting this job spends the materials and the fee immediately.
            Stopping it later does not give either back.
          </p>
          <p class="controls">
            <button type="button" class="danger" disabled={busy} onclick={confirmInstall}>
              Yes, start the job
            </button>
            <button
              type="button"
              class="minor"
              disabled={busy}
              onclick={() => (confirming = false)}
            >
              Go back
            </button>
          </p>
        {/if}
      {/if}
    </section>
  {/if}

  <section>
    <h2>Places you can work</h2>
    {#if $industry.facilitiesError}
      <p class="error">Nearby facilities could not be loaded: {$industry.facilitiesError}</p>
    {/if}
    {#if usableFacilities.length === 0}
      <p class="empty">No industry facilities are available where you are.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Facility</th>
              <th>System</th>
              <th class="num">Work it takes</th>
              <th class="num">Fee</th>
            </tr>
          </thead>
          <tbody>
            {#each usableFacilities as facility (facility.facilityID)}
              <tr>
                <td data-label="Facility">
                  {facilityName(facility.facilityID)}
                  {#if !facility.online}
                    <small class="note">offline</small>
                  {/if}
                </td>
                <td data-label="System">{systemName(facility.solarSystemID)}</td>
                <td class="num" data-label="Work it takes">
                  {facility.activities.map((activity) => ACTIVITY_LABELS[activity]).join(", ")}
                </td>
                <td class="num" data-label="Fee">{taxText(facility.tax)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}
