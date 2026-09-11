<script lang="ts">
  // The fleet companion's controls and readout — the third instance of the
  // MiningBot.svelte / MissionBot.svelte pattern.
  //
  // A pure reader of the store's `companion` slice plus the request's own
  // controls. It decides NOTHING about the companion: the ladder, the order
  // precedence and the reasons all live in nav/fleetCompanionLoop.ts, and every
  // word on screen here came from that loop or from the server.
  //
  // ⚠ 2026-09-11 SIMPLIFICATION — SEE docs/fleet-companion-simplification.md.
  // This panel no longer picks a role, a module, or an order channel: a
  // companion now reads its own fit at start and obeys every order channel
  // there is, so there was never anything for a player to disambiguate.
  // `CompanionSetup` (nav/fleetCompanionLoop.ts) is exactly what this panel
  // builds, and its six fields are exactly the controls below.
  import { onMount } from "svelte";
  import { isSessionLost } from "../app/flow.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import {
    evaluateRequirements,
    FLEET_COMPANION_REQUIREMENTS,
    type FleetCompanionReads,
  } from "../nav/botRegistry.ts";
  import {
    DEFAULT_COMPANION_SETUP,
    FLEET_COMPANION_ABANDONMENT_WAIT_MS,
    MAX_CAPACITOR_FLOOR,
    MAX_DRONE_HOLD_OFF_SECONDS,
    MAX_FLEE_ATTEMPTS,
    MAX_FLEE_HEALTH_FLOOR,
    MIN_CAPACITOR_FLOOR,
    MIN_DRONE_HOLD_OFF_SECONDS,
    MIN_FLEE_ATTEMPTS,
    MAX_DRONE_HEALTH_FLOOR,
    MIN_DRONE_HEALTH_FLOOR,
    MIN_FLEE_HEALTH_FLOOR,
    type CompanionSetup,
  } from "../nav/fleetCompanionLoop.ts";
  // The words this readout uses live in the shared layer, because the Bot
  // Manager's per-pilot row says the same things about the same run and the two
  // must not drift. See companionReadout.ts's header.
  import { canTagWords, inFleetWords, orderFromWords } from "../bots/companionReadout.ts";
  import {
    isFleetBroadcastFresh,
    type FleetBroadcastName,
  } from "../bridge/fleetBroadcasts.ts";
  import type { FleetCompanionState } from "../store/types.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const companion = store.companion;
  // svelte-ignore state_referenced_locally
  const fleet = store.fleet;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  let busy = $state(false);
  let error = $state("");

  let fleeHealthFloorPercent = $state(Math.round(DEFAULT_COMPANION_SETUP.fleeHealthFloor * 100));
  let droneHealthFloorPercent = $state(Math.round(DEFAULT_COMPANION_SETUP.droneHealthFloor * 100));
  let capacitorFloorPercent = $state(Math.round(DEFAULT_COMPANION_SETUP.capacitorFloor * 100));
  let maxFleeAttempts = $state(DEFAULT_COMPANION_SETUP.maxFleeAttempts);
  /**
   * Docking gives the shield and the capacitor back but NOT the armour, so a
   * pilot that fled on armour damage cannot get back above its floor by
   * arriving. Ticking this lets it pay the station to fix the difference;
   * leaving it off means such a pilot stays docked and says so.
   */
  let repairsAtStation = $state(DEFAULT_COMPANION_SETUP.repairsAtStation);
  let droneHoldOffSeconds = $state(DEFAULT_COMPANION_SETUP.droneRedeployHoldOffSeconds);

  const running = $derived($companion.status === "running");
  const paused = $derived($companion.status === "paused");
  const active = $derived(running || paused);

  /**
   * The launcher's OWN best-effort reads, taken fresh whenever this panel is on
   * screen. This is the ADVISORY copy (R43's own rule) — `flow.startFleetCompanion`
   * evaluates the same requirements again, against reads taken immediately
   * before the first call, and only that evaluation decides anything. A stale
   * "you are in a fleet" here is exactly the failure that second read exists to
   * catch.
   */
  const inFleet = $derived(
    $fleet.availability === "ready" ? true : $fleet.availability === "not-in-fleet" ? false : null,
  );
  const docked = $derived($flight.status?.docked ?? null);
  const reads = $derived<FleetCompanionReads>({ inFleet, docked });
  const preflight = $derived(evaluateRequirements(FLEET_COMPANION_REQUIREMENTS, reads));
  const canStart = $derived(preflight.canStart && !active);

  /**
   * Roughly how long an abandoned pilot has left, in whole minutes.
   *
   * Rounded UP and described as "about" on purpose: the authority on when the
   * wait ends is the loop itself, which re-decides every couple of seconds, and
   * a countdown that claimed to be exact would be a second wrong answer to a
   * question the panel does not own.
   */
  function abandonmentMinutesLeft(
    abandonment: NonNullable<FleetCompanionState["abandonment"]>,
  ): number {
    const left = FLEET_COMPANION_ABANDONMENT_WAIT_MS - (Date.now() - abandonment.abandonedAtMs);
    return Math.max(0, Math.ceil(left / 60_000));
  }

  // The rejoin allowlist is character ids; the player should read names.
  $effect(() => {
    const ids = $companion.abandonment?.supervisorCharacterIDs ?? [];
    if (ids.length > 0) {
      flow.requestNames(ids.map((id) => ({ kind: "character", id }) as NameRef));
    }
  });

  /**
   * What the fleet has most recently said, in the player's words. Shown even
   * before this pilot can act on any of it: during live QA the first question
   * is always "is the broadcast even arriving".
   */
  const lastOrder = $derived($fleet.lastBroadcast);
  const orderIsFresh = $derived(
    lastOrder === null ? false : isFleetBroadcastFresh(lastOrder, Date.now()),
  );

  // The broadcaster is a character id; the player should read a name. Same
  // shape as the abandonment lookup above.
  $effect(() => {
    const sender = $fleet.lastBroadcast?.senderCharID ?? null;
    if (sender !== null) {
      flow.requestNames([{ kind: "character", id: sender } as NameRef]);
    }
  });

  /** Plain words for a broadcast name. Never the wire name, which is jargon. */
  const broadcastWords: Record<FleetBroadcastName, string> = {
    // ⚠ NOT "shoot this". Answering a Target call always means LOCKING the
    // ship first, and firing after only happens if this hull carries a weapon
    // -- saying "shoot" here would promise every pilot something only some of
    // them can do.
    Target: "lock this target",
    AlignTo: "align to this",
    WarpTo: "warp to this",
    JumpTo: "jump through this gate",
    TravelTo: "travel to this system",
    JumpBeacon: "jump to this beacon",
    HealShield: "needs shield reps",
    HealArmor: "needs armour reps",
    HealCapacitor: "needs capacitor",
    HealTarget: "rep this pilot",
    EnemySpotted: "enemy spotted",
    NeedBackup: "needs backup",
    HoldPosition: "hold position",
    InPosition: "in position",
    Location: "reporting position",
  };

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * The checklist's live reads need the fleet and the flight status.
   * Best-effort, same as `Bots.svelte`: a failed read leaves the requirement at
   * "could not check", which is the honest answer.
   */
  onMount(() => {
    void Promise.resolve(flow.loadFleet()).catch(() => {});
  });

  async function run(action: () => Promise<void> | void): Promise<void> {
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
        error = panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  async function start(): Promise<void> {
    await run(() =>
      flow.startFleetCompanion({
        fleeHealthFloor: clamp(fleeHealthFloorPercent, MIN_FLEE_HEALTH_FLOOR * 100, MAX_FLEE_HEALTH_FLOOR * 100) / 100,
        capacitorFloor: clamp(capacitorFloorPercent, MIN_CAPACITOR_FLOOR * 100, MAX_CAPACITOR_FLOOR * 100) / 100,
        maxFleeAttempts: clamp(maxFleeAttempts, MIN_FLEE_ATTEMPTS, MAX_FLEE_ATTEMPTS),
        repairsAtStation,
        droneHealthFloor:
          clamp(droneHealthFloorPercent, MIN_DRONE_HEALTH_FLOOR * 100, MAX_DRONE_HEALTH_FLOOR * 100) / 100,
        droneRedeployHoldOffSeconds: clamp(
          droneHoldOffSeconds,
          MIN_DRONE_HOLD_OFF_SECONDS,
          MAX_DRONE_HOLD_OFF_SECONDS,
        ),
      } satisfies CompanionSetup),
    );
  }
</script>

<section class="panel">
  <header class="panel-head">
    <h2>Fleet companion</h2>
    <span class="controls">
      {#if running}
        <button type="button" disabled={busy} onclick={() => run(() => flow.pauseFleetCompanion())}>
          Pause
        </button>
        <button type="button" class="danger" disabled={busy} onclick={() => run(() => flow.stopFleetCompanion())}>
          Stop
        </button>
      {:else if paused}
        <button type="button" class="primary" disabled={busy} onclick={() => run(() => flow.resumeFleetCompanion())}>
          Carry on
        </button>
        <button type="button" class="danger" disabled={busy} onclick={() => run(() => flow.stopFleetCompanion())}>
          Stop
        </button>
      {:else}
        <button type="button" class="primary" disabled={busy || !canStart} onclick={start}>
          Start
        </button>
      {/if}
    </span>
  </header>
  <p class="note">
    Flies with your fleet and does what the fleet asks - holds formation,
    answers broadcasts, and looks after itself. It runs in this tab: close it
    and your ship finishes what it was last told to do and sits.
  </p>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $companion.startError}
    <p class="error">{$companion.startError}</p>
  {/if}
</section>

{#if active}
  <!--
    THE READOUT. `why` is the field this whole panel exists for: whatever the
    companion is doing, the player can see the reason for it without asking.
  -->
  <section>
    <h2>What it is doing</h2>
    <p class="stat-line">
      <strong>{$companion.phase ?? "Working"}</strong>
      {#if $companion.action}<span class="note"> - {$companion.action}</span>{/if}
    </p>
    {#if $companion.why}
      <p class="note"><strong>Why:</strong> {$companion.why}</p>
    {/if}
    {#if $companion.failureReason}
      <p class="error">{$companion.failureReason}</p>
    {/if}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>In fleet</th>
            <th>Following orders from</th>
            <th>Last order heard</th>
            <th>Can tag</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="In fleet">{inFleetWords($companion.inFleet)}</td>
            <td data-label="Following orders from">{orderFromWords($companion.followingOrderFrom)}</td>
            <td data-label="Last order heard">{$companion.lastOrderHeard ?? "-"}</td>
            <td data-label="Can tag">{canTagWords($companion.canTag)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    {#if $companion.fitWarnings.length > 0}
      <!--
        WHAT THIS SHIP IS MISSING, measured once when the run started.
        ADVISORY, NEVER A REFUSAL: the operator's rule is that a human either
        loads the missing thing or ignores this and flies. Nothing here stops a
        start, and nothing here nags on an unreadable fit -- an empty list is
        what both "all well" and "could not tell" produce.
      -->
      <p class="note"><strong>Worth knowing about this fit:</strong></p>
      <ul>
        {#each $companion.fitWarnings as warning (warning)}
          <li class="note">{warning}</li>
        {/each}
      </ul>
    {/if}
    <!--
      WHAT THE FLEET IS SAYING. Deliberately shown even before this pilot can
      act on any of it: during live QA the first question is always "is the
      broadcast even arriving", and a panel that only showed what the pilot DID
      cannot answer it.
    -->
    <h3>What the fleet is saying</h3>
    {#if lastOrder === null}
      <p class="note">
        Nothing has come over the fleet yet. Broadcasts and target tags only
        arrive while someone in the fleet is actually sending them.
      </p>
    {:else}
      <p class="stat-line">
        <strong>{broadcastWords[lastOrder.name] ?? lastOrder.name}</strong>
        <span class="note">
          - from {resolvedName($names.resolved, "character", lastOrder.senderCharID, "someone in the fleet")}
        </span>
      </p>
      {#if !orderIsFresh}
        <p class="note">
          That call has lapsed, so this pilot is back on its own judgement. A
          call only stands for about half a minute.
        </p>
      {/if}
    {/if}
    {#if $fleet.targetTags === null}
      <p class="note">No target tags have been read from this fleet.</p>
    {:else if $fleet.targetTags.size === 0}
      <p class="note">The fleet has tagged nothing.</p>
    {:else}
      <p class="note">
        The fleet has tagged {$fleet.targetTags.size} ship(s):
        {[...$fleet.targetTags.values()].join(", ")}.
      </p>
    {/if}

    {#if $companion.abandonment}
      <p class="note warn">
        Nobody is left in this fleet that this computer is not flying, so this
        pilot has got itself safe and dropped fleet. It will wait about
        {abandonmentMinutesLeft($companion.abandonment)} more minute(s) for
        someone to invite it back, then release the ship.
        {#if $companion.abandonment.supervisorCharacterIDs.length > 0}
          It will only accept an invite from
          {$companion.abandonment.supervisorCharacterIDs
            .map((id) => resolvedName($names.resolved, "character", id, "(name pending)"))
            .join(", ")}.
        {:else}
          It has nobody to accept an invite from, so it will simply wait out the
          time.
        {/if}
      </p>
    {/if}
    {#if paused}
      <p class="note">
        Paused. Your ship keeps doing whatever it was last told to - press Carry
        on to pick the run back up, or Stop to leave it alone.
      </p>
    {/if}
  </section>
{:else}
  <section>
    <h2>Set it up</h2>

    <h3>Before it can start</h3>
    <p class="note">
      Required items must be met before Start will work. The others just say
      what it will do on its own.
    </p>
    <ul class="checklist">
      {#each preflight.rows as row (row.id)}
        {@const label = row.verdict === "met" ? "Ready" : row.verdict === "cannot-tell" ? "Unknown" : "Not yet"}
        <li class={`check-${row.verdict}`}>
          <strong>{label}</strong>
          {#if row.verdict !== "met"}
            <span class="note">({row.severity === "blocking" ? "required" : "worth knowing"})</span>
          {/if}
          <span>{row.title}</span>
          {#if row.reason}
            <span class="note"> - {row.reason}</span>
          {/if}
        </li>
      {/each}
    </ul>

    <h3>What it uses</h3>
    <p class="note">
      This pilot reads its own fit when it starts and uses whatever it finds -
      hardeners, repairers, remote repairers and weapons. It listens to fleet
      broadcasts, target tags and chat orders from your fleet commanders, with
      nothing here to switch on.
    </p>

    <h3>Keeping your ship alive</h3>
    <p class="field">
      <label for="companion-flee-floor">Flee below</label>
      <input
        id="companion-flee-floor"
        type="number"
        min={Math.round(MIN_FLEE_HEALTH_FLOOR * 100)}
        max={Math.round(MAX_FLEE_HEALTH_FLOOR * 100)}
        step="5"
        bind:value={fleeHealthFloorPercent}
      />
      <span class="note">% of shield, armour or hull remaining</span>
    </p>
    <p class="field">
      <label for="companion-cap-floor">Do not run repairers below</label>
      <input
        id="companion-cap-floor"
        type="number"
        min={Math.round(MIN_CAPACITOR_FLOOR * 100)}
        max={Math.round(MAX_CAPACITOR_FLOOR * 100)}
        step="5"
        bind:value={capacitorFloorPercent}
      />
      <span class="note">% capacitor</span>
    </p>
    <p class="field">
      <label for="companion-flee-attempts">Stay home after</label>
      <input
        id="companion-flee-attempts"
        type="number"
        min={MIN_FLEE_ATTEMPTS}
        max={MAX_FLEE_ATTEMPTS}
        step="1"
        bind:value={maxFleeAttempts}
      />
      <span class="note">flee round trips</span>
    </p>
    <label class="check">
      <input type="checkbox" bind:checked={repairsAtStation} />
      Pay for repairs when it docks hurt
    </label>
    <p class="note">
      Docking gives back shield and capacitor for free, but not armour. Without this
      a pilot that fled on armour damage stays docked instead of coming back.
    </p>
    <p class="field">
      <label for="companion-drone-floor">Bring a drone home below</label>
      <input
        id="companion-drone-floor"
        type="number"
        min={Math.round(MIN_DRONE_HEALTH_FLOOR * 100)}
        max={Math.round(MAX_DRONE_HEALTH_FLOOR * 100)}
        step="5"
        bind:value={droneHealthFloorPercent}
      />
      <span class="note">% of its shield, armour or hull. Coming home refills its shield</span>
    </p>
    <p class="field">
      <label for="companion-drone-holdoff">Hold drones in the bay for at least</label>
      <input
        id="companion-drone-holdoff"
        type="number"
        min={MIN_DRONE_HOLD_OFF_SECONDS}
        max={MAX_DRONE_HOLD_OFF_SECONDS}
        step="1"
        bind:value={droneHoldOffSeconds}
      />
      <span class="note">seconds before relaunching them</span>
    </p>

    <h3>If it ends up alone</h3>
    <p class="note">
      This pilot only ever works while somebody in the fleet is not being flown
      by this computer. The moment that stops being true it docks at the nearest
      station, leaves the fleet, and waits half an hour for one of the pilots
      who WAS in the fleet to invite it back - then it releases the ship. An
      invite from anybody else is ignored.
    </p>
    <p class="note">
      If there is no station in sight when it needs to hide, it warps to this
      system's star instead - nothing to set for that.
    </p>

    {#if $companion.failureReason}
      <h3>Last time it stopped</h3>
      <p class="error">{$companion.failureReason}</p>
    {/if}
  </section>
{/if}

<style>
  .field {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .check {
    display: block;
    margin: 0.25rem 0;
  }
  #companion-flee-floor,
  #companion-cap-floor,
  #companion-flee-attempts,
  #companion-drone-floor,
  #companion-drone-holdoff {
    width: 5rem;
  }
  .checklist {
    list-style: none;
    margin: 0.25rem 0 0.75rem;
    padding: 0;
  }
  .checklist li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: baseline;
    /* R8 — a comfortable row on a phone. */
    min-height: 40px;
    padding: 0.3rem 0;
  }
  .check-cannot-tell {
    opacity: 0.85;
  }
</style>
