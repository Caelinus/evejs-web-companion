<script lang="ts">
  // Planets page (goal R41): the colonies this character has built, and what is
  // on each planet.
  //
  // A pure reader of the store's planets slice. Nothing here shows a planetID,
  // a systemID, a typeID or a pinID (R7d) — a place is its NAME and a structure
  // is its NAME. Raw ids appear only in `{#each}` keys, in TypeIcon's typeID and
  // in onclick arguments, which is exactly where they belong.
  //
  // ⚠ NOTHING HERE SIMULATES A COLONY. Cycle times, quantities per cycle and
  // both instants are the emulator's own numbers. The single judgement this
  // panel makes is whether an expiry has PASSED, and it makes it against the
  // server's clock (clockOffsetMs), not the browser's.
  //
  // ⚠ THREE OUTCOMES, THREE DIFFERENT SENTENCES. "Still loading", "that read
  // failed", and "you genuinely have no colonies" are distinct facts. The last
  // is claimed ONLY from `hasNoColonies`, which the store sets only when the
  // read succeeded AND the gateway actually carried a colony table. A fourth
  // case exists and is worded separately: the read succeeded but the gateway
  // reported no colony table at all — that is not evidence of anything.
  //
  // READ ONLY. The emulator does expose a write (restart the expired
  // extractors); this slice ships looking before it ships acting.
  //
  // ⚠ THE MONITOR IS ALLOWED TO SAY NOTHING. Every "needs you" line comes from
  // bridge/colonyAttention.ts, which raises a finding only from a fact the
  // server actually stated — never from a null. A colony with nothing to say
  // gets no line, and that silence is the part a player has to be able to
  // trust: it is what lets them close the tab.
  import { onMount } from "svelte";
  import {
    attentionByColony,
    attentionSummaryWords,
    colonyAttentionWords,
    pinFill,
  } from "../bridge/colonyAttention.ts";
  import {
    colonyPlaceWords,
    formatDuration,
    pooledContents,
    programHasExpired,
    programProgress,
    serverNow,
    summarizeColony,
  } from "../bridge/planets.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { Colony, ColonyPin } from "../store/types.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const planets = store.planets;

  let busy = $state(false);
  let error = $state("");

  // Ticks so a countdown moves. The INSTANTS never change between reads — only
  // this reference "now" does, so nothing on screen can drift past what the
  // server said.
  let browserNowMs = $state(Date.now());

  const colonies = $derived($planets.colonies ?? []);
  const nowMs = $derived(serverNow($planets.clockOffsetMs, browserNowMs));

  // Only the colonies with something to say, loudest first. Recomputed as the
  // clock ticks, because an expiry passing is exactly what turns a quiet
  // colony into a loud one.
  const attention = $derived(attentionByColony(colonies, nowMs));
  const summaryWords = $derived(attentionSummaryWords(attention));
  const findingsByPlanetID = $derived(
    new Map(attention.map((entry) => [entry.colony.planetID, entry.findings])),
  );

  const openColony = $derived<Colony | null>(
    $planets.selectedPlanetID === null
      ? null
      : (colonies.find((colony) => colony.planetID === $planets.selectedPlanetID) ?? null),
  );

  /** What a structure does, in a player's words rather than a group name. */
  function pinRole(pin: ColonyPin): string {
    switch (pin.kind) {
      case "command":
        return "Command centre";
      case "extractor-control":
        return "Extractor";
      case "extractor":
        return "Extractor head";
      case "factory":
        return "Factory";
      case "storage":
        return "Storage";
      case "launchpad":
        return "Launchpad";
      default:
        return "Structure";
    }
  }

  function units(quantity: number): string {
    return `${quantity.toLocaleString()} unit${quantity === 1 ? "" : "s"}`;
  }

  /** "Running, 7h 12m left" / "Finished" / "Never programmed". */
  function programWords(pin: ColonyPin): string {
    const program = pin.program;
    if (!program || program.expiresAtMs === null) {
      return "No program installed";
    }
    if (programHasExpired(program, nowMs)) {
      return "Finished — this extractor has stopped";
    }
    return `Running — ${formatDuration(program.expiresAtMs - nowMs)} left`;
  }

  function cycleWords(pin: ColonyPin): string {
    const program = pin.program;
    if (!program || program.cycleTimeSeconds <= 0) {
      return "";
    }
    return `${program.quantityPerCycle.toLocaleString()} per ${formatDuration(
      program.cycleTimeSeconds * 1000,
    )} cycle`;
  }

  function headWords(pin: ColonyPin): string {
    const heads = pin.program?.headCount ?? 0;
    return heads === 1 ? "1 head" : `${heads} heads`;
  }

  /** "9,900 of 10,000 m3 - 99% full", or "" when either half is unreadable. */
  function fillWords(pin: ColonyPin): string {
    const fill = pinFill(pin);
    if (fill === null || typeof pin.usedM3 !== "number" || typeof pin.capacityM3 !== "number") {
      return "";
    }
    const used = Math.round(pin.usedM3).toLocaleString();
    const capacity = Math.round(pin.capacityM3).toLocaleString();
    return `${used} of ${capacity} m3 - ${Math.min(100, Math.floor(fill * 100))}% full`;
  }

  /**
   * The one-line state of a colony in the list.
   *
   * What NEEDS the player wins the line when there is any: the old sentence
   * below can only describe extractors, so a colony with a full launchpad and
   * a healthy extractor used to read as simply "Extracting". When nothing is
   * waiting, the old sentence is still the better one and is kept word for
   * word (colonyAttentionWords answers null in exactly that case).
   */
  function colonyWords(colony: Colony): string {
    const waiting = colonyAttentionWords(findingsByPlanetID.get(colony.planetID) ?? []);
    if (waiting !== null) {
      return waiting;
    }
    const summary = summarizeColony(colony, nowMs);
    if (summary.expiredProgramCount > 0) {
      return summary.expiredProgramCount === 1
        ? "1 extractor has finished its program"
        : `${summary.expiredProgramCount} extractors have finished their programs`;
    }
    if (summary.nextExpiryMs !== null) {
      return `Extracting — next program ends in ${formatDuration(summary.nextExpiryMs - nowMs)}`;
    }
    if (summary.extractorCount === 0) {
      return "No extractors here yet";
    }
    return "No programs running";
  }

  function toggle(colony: Colony): void {
    flow.selectColony(
      $planets.selectedPlanetID === colony.planetID ? null : colony.planetID,
    );
  }

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "Your session ended. Pick your character again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void run(() => flow.loadPlanets());
    const timer = setInterval(() => {
      browserNowMs = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Planets</h2>
    <p class="controls">
      <button
        type="button"
        class="primary"
        disabled={busy}
        onclick={() => void run(() => flow.loadPlanets())}
      >
        Refresh
      </button>
    </p>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if !$planets.loaded}
    <p class="note">Looking for your colonies…</p>
  {:else if $planets.error}
    <!-- A FAILED read. Worded deliberately unlike the empty case: "you have no
         colonies" is a claim only a SUCCESSFUL read may make. -->
    <p class="error">
      Your colonies could not be read just now, so there may be planets you
      cannot see here. Try again in a moment.
    </p>
  {:else if $planets.hasNoColonies}
    <!-- ⚠ A FACT FROM A SUCCESSFUL EMPTY READ, not an inference from absence. -->
    <p class="note">
      You have not built on any planet yet. Drop a command centre on a planet
      in-game and the colony will show up here.
    </p>
  {:else if colonies.length === 0}
    <!-- The fourth case: the read worked but carried no colony table at all.
         That says nothing about whether this character has colonies, so this
         must NOT say "you have none". -->
    <p class="note">
      This server did not report any colony information, so there is nothing to
      show. That is not the same as having no colonies.
    </p>
  {:else}
    <p class="note">
      You have {colonies.length === 1 ? "one colony" : `${colonies.length} colonies`}.
    </p>

    <!-- The whole point of the panel: where to go, before any planet is
         opened. Absent entirely when every colony is quiet — no "all good"
         banner, because an empty space says it without being read. -->
    {#if summaryWords}
      <section class="attention">
        <h3>{summaryWords}</h3>
        <ul class="plain-list">
          {#each attention as entry (entry.colony.planetID)}
            <li>
              <span class="asset-place">
                <TypeIcon
                  typeID={entry.colony.planetTypeID}
                  name={entry.colony.planetTypeName ?? colonyPlaceWords(entry.colony)}
                />
                <strong>{colonyPlaceWords(entry.colony)}</strong>
                <span class="muted">{entry.needsYouNow ? "now" : "coming up"}</span>
              </span>
              <ul class="plain-list reasons">
                {#each entry.findings as finding (finding.pinID ?? finding.kind)}
                  <li>
                    {finding.words}{#if finding.dueAtMs !== null && finding.dueAtMs > nowMs}
                      — in {formatDuration(finding.dueAtMs - nowMs)}
                    {:else if finding.dueAtMs !== null}
                      — {formatDuration(nowMs - finding.dueAtMs)} ago
                    {/if}
                  </li>
                {/each}
              </ul>
              <div class="row-actions">
                <button type="button" disabled={busy} onclick={() => toggle(entry.colony)}>
                  {$planets.selectedPlanetID === entry.colony.planetID
                    ? "Hide this colony"
                    : "See this colony"}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- R8: the record table scrolls inside its OWN box and reflows to labelled
         cards below 640px, so the page body never scrolls sideways. -->
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Planet</th>
            <th>System</th>
            <th>State</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each colonies as colony (colony.planetID)}
            <tr>
              <td data-label="Planet">
                <span class="asset-place">
                  <TypeIcon
                    typeID={colony.planetTypeID}
                    name={colony.planetTypeName ?? colonyPlaceWords(colony)}
                  />
                  {colonyPlaceWords(colony)}
                </span>
              </td>
              <td data-label="System">{colony.solarSystemName ?? "an unnamed system"}</td>
              <td data-label="State">{colonyWords(colony)}</td>
              <td data-label="">
                <div class="row-actions">
                  <button type="button" disabled={busy} onclick={() => toggle(colony)}>
                    {$planets.selectedPlanetID === colony.planetID
                      ? "Hide this colony"
                      : "See this colony"}
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if openColony}
      <section class="panel inner">
        <header class="panel-head">
          <h3>{colonyPlaceWords(openColony)}</h3>
          <p class="note">
            {openColony.planetTypeName ?? "an unnamed kind of planet"} ·
            command centre level {openColony.commandCenterLevel} ·
            {openColony.linkCount === 1 ? "1 link" : `${openColony.linkCount} links`} ·
            {openColony.routes.length === 1
              ? "1 route"
              : `${openColony.routes.length} routes`}
          </p>
        </header>

        {#if (findingsByPlanetID.get(openColony.planetID) ?? []).length}
          <h4>What needs you here</h4>
          <ul class="plain-list">
            {#each findingsByPlanetID.get(openColony.planetID) ?? [] as finding (finding.pinID ?? finding.kind)}
              <li>{finding.words}</li>
            {/each}
          </ul>
        {/if}

        <h4>What is on this planet</h4>
        <ul class="plain-list">
          {#each openColony.pins as pin (pin.pinID)}
            <li>
              <span class="asset-place">
                <TypeIcon typeID={pin.typeID} name={pin.typeName} />
                <strong>{pin.typeName}</strong>
                <span class="muted">{pinRole(pin)}</span>
              </span>
              {#if pin.kind === "extractor-control"}
                <p class="note">
                  {programWords(pin)}
                  {#if pin.program?.resourceTypeName}
                    · pulling {pin.program.resourceTypeName}
                  {/if}
                  {#if cycleWords(pin)}
                    · {cycleWords(pin)}
                  {/if}
                  · {headWords(pin)}
                </p>
                {#if pin.program && programProgress(pin.program, nowMs) !== null}
                  <progress
                    max="1"
                    value={programProgress(pin.program, nowMs)}
                    aria-label="Program progress"
                  ></progress>
                {/if}
              {/if}
              {#if pin.kind === "factory"}
                <p class="note">
                  {pin.schematicName
                    ? `Making ${pin.schematicName}`
                    : "No recipe set"}
                  <!-- ⚠ Only an explicit false is an alarm. null means this pin
                       has no such state, and says nothing. -->
                  {#if pin.receivedInputsLastCycle === false}
                    · fed nothing last cycle
                  {/if}
                </p>
              {/if}
              {#if pin.contents.length}
                <p class="note">
                  Holding {pin.contents
                    .map((item) => `${item.typeName} (${units(item.quantity)})`)
                    .join(", ")}
                </p>
              {/if}
              <!-- A volume, not a unit count: 12,000 Aqueous Liquids is the
                   biggest pile on the planet and 0.5% of the hold. -->
              {#if fillWords(pin)}
                <p class="note">{fillWords(pin)}</p>
              {/if}
            </li>
          {/each}
        </ul>

        {#if pooledContents(openColony).length}
          <h4>Everything stored here</h4>
          <ul class="plain-list">
            {#each pooledContents(openColony) as item (item.typeID)}
              <li>
                <span class="asset-place">
                  <TypeIcon typeID={item.typeID} name={item.typeName} />
                  {item.typeName} — {units(item.quantity)}
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if openColony.routes.length}
          <h4>What moves where</h4>
          <ul class="plain-list">
            {#each openColony.routes as route (route.routeID)}
              <li>
                {route.commodityTypeName ?? "an unnamed commodity"} —
                {units(route.commodityQuantity)} per run, across
                {route.path.length === 2
                  ? "one link"
                  : `${route.path.length - 1} links`}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</section>

<style>
  /* Icon and name read as one thing, and wrap together rather than letting the
     name run away from its picture on a narrow screen (R8). */
  .asset-place {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    flex-wrap: wrap;
  }

  .panel.inner {
    margin-top: 1rem;
  }

  /* The attention block reads as a notice, not as another table. It is absent
     entirely when nothing is waiting, so it never becomes furniture the eye
     learns to skip. */
  .attention {
    margin: 0 0 1rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-line, #23303d);
    border-left: 3px solid var(--color-warn, #d4a13a);
    border-radius: 4px;
  }

  .attention h3 {
    margin: 0 0 0.75rem;
    font-size: 15px;
  }

  .attention .reasons {
    margin: 0.25rem 0 0.5rem;
    padding-left: 1rem;
    gap: 0.25rem;
    color: var(--color-muted, #8fa3b8);
    font-size: 13px;
  }

  .attention .reasons > li {
    border-top: 0;
    padding-top: 0;
    list-style: disc;
  }

  .plain-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .plain-list > li {
    border-top: 1px solid var(--color-line, #23303d);
    padding-top: 0.75rem;
  }

  .plain-list > li:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .muted {
    color: var(--color-muted, #8fa3b8);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* A bar the player can read at a glance; the VALUE is the server's, this is
     only how wide it is drawn. */
  progress {
    width: 100%;
    max-width: 320px;
    height: 8px;
  }
</style>
