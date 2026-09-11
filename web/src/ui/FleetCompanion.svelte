<script lang="ts">
  // The fleet companion's controls and readout — the third instance of the
  // MiningBot.svelte / MissionBot.svelte pattern.
  //
  // A pure reader of the store's `companion` slice plus the request's own
  // controls. It decides NOTHING about the companion: the ladder, the order
  // precedence and the reasons all live in nav/fleetCompanionLoop.ts, and every
  // word on screen here came from that loop or from the server.
  //
  // ⚠ THIS IS PHASE 0'S LAUNCHER. The loop itself only waits this phase — no
  // broadcasts are read, no target is tagged, no module is cycled — but the
  // REQUEST already carries every field later phases will act on, because a
  // player set up for phase 0 should not have to redo their settings when the
  // next phase lands. The checklist and the readout are exactly as honest about
  // that as the loop's own comments are.
  import { onMount } from "svelte";
  import { isSessionLost } from "../app/flow.ts";
  import { activatableModules } from "../space/rowActions.ts";
  import { nameKey, resolvedName, type NameRef } from "../store/names.ts";
  import {
    evaluateRequirements,
    FLEET_COMPANION_REQUIREMENTS,
    type FleetCompanionReads,
  } from "../nav/botRegistry.ts";
  import {
    DEFAULT_FLEET_COMPANION_REQUEST,
    FLEET_COMPANION_ORDER_SOURCES,
    FLEET_COMPANION_ROLES,
    FLEET_COMPANION_ABANDONMENT_WAIT_MS,
    MAX_CAPACITOR_FLOOR,
    MAX_DRONE_HOLD_OFF_SECONDS,
    MAX_FLEE_ATTEMPTS,
    MAX_FLEE_HEALTH_FLOOR,
    MIN_CAPACITOR_FLOOR,
    MIN_DRONE_HOLD_OFF_SECONDS,
    MIN_FLEE_ATTEMPTS,
    MIN_FLEE_HEALTH_FLOOR,
    type FleetCompanionOrderSource,
    type FleetCompanionRole,
  } from "../nav/fleetCompanionLoop.ts";
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
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  let busy = $state(false);
  let error = $state("");

  let role = $state<FleetCompanionRole>(DEFAULT_FLEET_COMPANION_REQUEST.role);
  /**
   * The player's OWN pick of defensive equipment, by item id.
   *
   * ⚠ NOTHING IS TICKED FOR YOU. Unlike the mining bot's equipment list, this
   * starts empty and stays empty until the player checks something — a guess
   * here cycles the wrong module (see `FleetCompanionRequest.defenseModuleIDs`'s
   * own comment).
   */
  let picked = $state<number[]>([]);
  /**
   * The player's OWN pick of fitted REMOTE repair modules, one list per
   * family — a shield booster cannot repair armour, so each answers only its
   * own kind of Heal broadcast (see `FleetCompanionRequest.remoteShieldModuleIDs`'s
   * own comment). Same "nothing ticked for you" rule as `picked` above.
   */
  let pickedRemoteShield = $state<number[]>([]);
  let pickedRemoteArmor = $state<number[]>([]);
  let pickedRemoteCapacitor = $state<number[]>([]);
  /**
   * The player's OWN pick of fitted weapons (turrets, launchers), by item id.
   *
   * ⚠ EMPTY IS THE DEFAULT AND A REAL ANSWER. Leave this untouched and the
   * pilot locks whatever the fleet calls and never fires it - see
   * `FleetCompanionRequest.weaponModuleIDs`'s own comment. Same "nothing
   * ticked for you" rule as `picked` above: a wrong guess here fires
   * something you did not choose at whatever the fleet called.
   */
  let pickedWeapon = $state<number[]>([]);
  let fleeHealthFloorPercent = $state(Math.round(DEFAULT_FLEET_COMPANION_REQUEST.fleeHealthFloor * 100));
  let capacitorFloorPercent = $state(Math.round(DEFAULT_FLEET_COMPANION_REQUEST.capacitorFloor * 100));
  let maxFleeAttempts = $state(DEFAULT_FLEET_COMPANION_REQUEST.maxFleeAttempts);
  let useDrones = $state(DEFAULT_FLEET_COMPANION_REQUEST.useDrones);
  let droneHoldOffSeconds = $state(DEFAULT_FLEET_COMPANION_REQUEST.droneRedeployHoldOffSeconds);
  /**
   * ⚠ ONLY ONE PILOT PER SQUAD SHOULD TURN THIS ON. A tag is unique fleet-wide,
   * so two taggers fight over letters and the fleet stops trusting either.
   */
  let attemptsTagging = $state(DEFAULT_FLEET_COMPANION_REQUEST.attemptsTagging);
  let obeys = $state<FleetCompanionOrderSource[]>([...DEFAULT_FLEET_COMPANION_REQUEST.obeys]);
  let chatCommandSendersText = $state("");
  /**
   * Where this pilot runs to if it is ever left alone somewhere with no station
   * on grid. Empty means "nowhere named", which is a real answer: the pilot
   * then stops where it is and says so rather than inventing a hiding place.
   *
   * ⚠ IT IS A BOOKMARK, NOT A CELESTIAL. There is no sun in this game's scene
   * to warp to — no celestial appears among its entity kinds and no read
   * exposes one — so the safe spot is somewhere the player has actually been
   * and saved.
   */
  let safeSpotBookmarkID = $state<number | null>(null);
  let safeSpots = $state<readonly { bookmarkID: number; name: string }[]>([]);

  // Best-effort, and deliberately quiet: a bookmark list that will not load
  // leaves the picker empty and the setting at "nowhere", which is exactly what
  // a player who never set one gets anyway.
  $effect(() => {
    let live = true;
    void flow
      .listBookmarks()
      .then((rows) => {
        if (live) {
          safeSpots = rows;
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  });

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
   * Every module in the fit that is switched on — the pool the player picks
   * defensive equipment from. Any slot, not just one family: a shield booster
   * lives in the mid slots, an armour repairer in the low, and this panel has no
   * business guessing which one a given hull carries.
   */
  interface Equipment {
    readonly itemID: number;
    readonly label: string;
  }
  const equipment = $derived.by<Equipment[]>(() =>
    activatableModules(
      $fitting.slots,
      (typeID) => $names.resolved[nameKey("type", typeID)] ?? null,
      (typeID) => $names.resolved[nameKey("typeGroup", typeID)] ?? null,
    )
      .filter((row) => row.online)
      .map((row) => ({ itemID: row.itemID, label: row.label ?? "Unknown module" })),
  );

  function toggleDefense(itemID: number): void {
    picked = picked.includes(itemID) ? picked.filter((id) => id !== itemID) : [...picked, itemID];
  }

  function toggleRemoteShield(itemID: number): void {
    pickedRemoteShield = pickedRemoteShield.includes(itemID)
      ? pickedRemoteShield.filter((id) => id !== itemID)
      : [...pickedRemoteShield, itemID];
  }

  function toggleRemoteArmor(itemID: number): void {
    pickedRemoteArmor = pickedRemoteArmor.includes(itemID)
      ? pickedRemoteArmor.filter((id) => id !== itemID)
      : [...pickedRemoteArmor, itemID];
  }

  function toggleRemoteCapacitor(itemID: number): void {
    pickedRemoteCapacitor = pickedRemoteCapacitor.includes(itemID)
      ? pickedRemoteCapacitor.filter((id) => id !== itemID)
      : [...pickedRemoteCapacitor, itemID];
  }

  function toggleWeapon(itemID: number): void {
    pickedWeapon = pickedWeapon.includes(itemID)
      ? pickedWeapon.filter((id) => id !== itemID)
      : [...pickedWeapon, itemID];
  }

  function toggleObeys(source: FleetCompanionOrderSource): void {
    obeys = obeys.includes(source) ? obeys.filter((row) => row !== source) : [...obeys, source];
  }

  /**
   * Character ids the player has typed, in addition to whoever the fleet roster
   * already names a commander.
   *
   * ⚠ NEVER POPULATED FROM CHAT TEXT — only from what the player typed here,
   * which is what keeps the list unspoofable (see the request field's own
   * comment).
   */
  function parseChatCommandSenders(text: string): number[] {
    const ids = new Set<number>();
    for (const token of text.split(/[\s,]+/)) {
      if (!/^\d+$/.test(token)) {
        continue;
      }
      const id = Number(token);
      if (Number.isSafeInteger(id) && id > 0) {
        ids.add(id);
      }
    }
    return [...ids];
  }
  const chatCommandSenderIDs = $derived(parseChatCommandSenders(chatCommandSendersText));

  $effect(() => {
    if (chatCommandSenderIDs.length > 0) {
      const refs: NameRef[] = chatCommandSenderIDs.map((id) => ({ kind: "character", id }));
      flow.requestNames(refs);
    }
  });

  const roleLabels: Record<FleetCompanionRole, string> = {
    dps: "DPS",
    logi: "Logistics",
    tackle: "Tackle",
    support: "Support",
  };

  const orderSourceLabels: Record<FleetCompanionOrderSource, string> = {
    broadcast: "Fleet broadcasts",
    tag: "Target tags",
    chat: "Fleet chat commands",
    "squad-board": "The squad board",
  };

  function orderFromWords(value: FleetCompanionState["followingOrderFrom"]): string {
    switch (value) {
      case "broadcast":
        return "a fleet broadcast";
      case "tag":
        return "a target tag";
      case "chat":
        return "a fleet chat command";
      case "squad-board":
        return "the squad board";
      case "own-ladder":
        return "its own judgement";
      default:
        return "nothing yet";
    }
  }

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
   * What the fleet has most recently said, in the player's words.
   *
   * ⚠ THIS READS THE SLICE DIRECTLY, NOT THE COMPANION'S READOUT, and that is
   * the point of having it. The store records every broadcast the session
   * receives whether or not this pilot is configured to obey it, so the panel
   * can show "your FC broadcast Target and this pilot ignores broadcasts"
   * — which is a settings problem the player can fix, and is otherwise
   * indistinguishable from a bot that is simply not working.
   */
  const lastOrder = $derived($fleet.lastBroadcast);
  const orderIsFresh = $derived(
    lastOrder === null ? false : isFleetBroadcastFresh(lastOrder, Date.now()),
  );
  /**
   * ⚠ THIS READS THE SETUP FORM, NOT THE RUNNING PILOT'S REQUEST, and it is
   * only correct because of something that is not obvious.
   *
   * `$companion` is THIS TAB's own store slice, so this readout can only ever
   * be showing a companion this tab started — a headless one's state lives in
   * the BFF's store, not here — and the form is the only way to start one, so
   * `obeys` still holds exactly what was sent. A reload would desynchronise
   * them, but a reload also empties the slice, so `active` goes false and this
   * block does not render at all.
   *
   * The day this panel learns to display a HEADLESS companion, that argument
   * collapses and this warning starts lying — telling a player to go and fix a
   * setting that is already correct, which is worse than saying nothing. Carry
   * `obeys` on the companion readout before that happens.
   */
  const obeysBroadcasts = $derived(obeys.includes("broadcast"));

  // The broadcaster is a character id; the player should read a name. Same
  // shape as the chat-commander lookup above.
  $effect(() => {
    const sender = $fleet.lastBroadcast?.senderCharID ?? null;
    if (sender !== null) {
      flow.requestNames([{ kind: "character", id: sender } as NameRef]);
    }
  });

  /** Plain words for a broadcast name. Never the wire name, which is jargon. */
  const broadcastWords: Record<FleetBroadcastName, string> = {
    // ⚠ NOT "shoot this". Answering a Target call always means LOCKING the
    // ship first, and firing after only happens if a weapon is picked below --
    // saying "shoot" here would promise every pilot something only some of
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

  function canTagWords(value: boolean | null): string {
    if (value === null) {
      return "not known";
    }
    return value ? "yes" : "no - not a fleet commander";
  }

  function inFleetWords(value: boolean | null): string {
    if (value === null) {
      return "not known";
    }
    return value ? "yes" : "no";
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * The checklist's live reads need the fit, the fleet and the flight status.
   * Best-effort, same as `Bots.svelte`: a failed read leaves the requirement at
   * "could not check", which is the honest answer.
   */
  onMount(() => {
    void Promise.resolve(flow.loadFleet()).catch(() => {});
    void Promise.resolve(flow.loadFitting()).catch(() => {});
  });

  $effect(() => {
    const refs = $fitting.slots
      .filter((slot) => slot.module !== null)
      .flatMap((slot) => [
        { kind: "type" as const, id: slot.module!.typeID },
        { kind: "typeGroup" as const, id: slot.module!.typeID },
      ]);
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
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
        role,
        defenseModuleIDs: picked,
        remoteShieldModuleIDs: pickedRemoteShield,
        remoteArmorModuleIDs: pickedRemoteArmor,
        remoteCapacitorModuleIDs: pickedRemoteCapacitor,
        weaponModuleIDs: pickedWeapon,
        fleeHealthFloor: clamp(fleeHealthFloorPercent, MIN_FLEE_HEALTH_FLOOR * 100, MAX_FLEE_HEALTH_FLOOR * 100) / 100,
        capacitorFloor: clamp(capacitorFloorPercent, MIN_CAPACITOR_FLOOR * 100, MAX_CAPACITOR_FLOOR * 100) / 100,
        maxFleeAttempts: clamp(maxFleeAttempts, MIN_FLEE_ATTEMPTS, MAX_FLEE_ATTEMPTS),
        useDrones,
        droneRedeployHoldOffSeconds: clamp(
          droneHoldOffSeconds,
          MIN_DRONE_HOLD_OFF_SECONDS,
          MAX_DRONE_HOLD_OFF_SECONDS,
        ),
        attemptsTagging,
        obeys,
        chatCommandSenders: chatCommandSenderIDs,
        safeSpotBookmarkID,
      }),
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
            <th>Role</th>
            <th>In fleet</th>
            <th>Following orders from</th>
            <th>Last order heard</th>
            <th>Can tag</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Role">{$companion.role ? roleLabels[$companion.role] : "-"}</td>
            <td data-label="In fleet">{inFleetWords($companion.inFleet)}</td>
            <td data-label="Following orders from">{orderFromWords($companion.followingOrderFrom)}</td>
            <td data-label="Last order heard">{$companion.lastOrderHeard ?? "-"}</td>
            <td data-label="Can tag">{canTagWords($companion.canTag)}</td>
          </tr>
        </tbody>
      </table>
    </div>
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
      {:else if !obeysBroadcasts}
        <p class="note warn">
          This pilot is set NOT to listen to broadcasts, so it is ignoring that.
          Stop it and tick "Fleet broadcasts" if you want it answered.
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

    <h3>Role</h3>
    <p class="note">
      Picks the defaults below - it does not gate what the companion can
      actually do.
    </p>
    <p class="field">
      <label for="companion-role">This pilot is</label>
      <select id="companion-role" bind:value={role}>
        {#each FLEET_COMPANION_ROLES as choice (choice)}
          <option value={choice}>{roleLabels[choice]}</option>
        {/each}
      </select>
    </p>

    <h3>Defensive equipment</h3>
    {#if equipment.length === 0}
      <p class="empty">
        Nothing powered up. Power your defensive equipment up under Your
        equipment, then come back.
      </p>
    {:else}
      <p class="note">
        Tick what the companion may run to defend itself. Nothing is picked for
        you - a wrong guess would cycle the wrong module, so this is entirely
        your own call.
      </p>
      {#each equipment as row (row.itemID)}
        <label class="check">
          <input
            type="checkbox"
            checked={picked.includes(row.itemID)}
            onchange={() => toggleDefense(row.itemID)}
          />
          {row.label}
        </label>
      {/each}
    {/if}

    <h3>Remote repair</h3>
    <p class="note">
      Tick what this pilot may run on a fleet-mate who calls for reps. A
      shield booster cannot repair armour, so pick each fitted module under
      the layer it actually reps - nothing is guessed for you here either.
    </p>
    {#if equipment.length === 0}
      <p class="empty">
        Nothing powered up. Power your remote-repair equipment up under Your
        equipment, then come back.
      </p>
    {:else}
      <p><strong>Remote shield boosters</strong> (answers "needs shield reps")</p>
      {#each equipment as row (row.itemID)}
        <label class="check">
          <input
            type="checkbox"
            checked={pickedRemoteShield.includes(row.itemID)}
            onchange={() => toggleRemoteShield(row.itemID)}
          />
          {row.label}
        </label>
      {/each}
      <p><strong>Remote armour repairers</strong> (answers "needs armour reps")</p>
      {#each equipment as row (row.itemID)}
        <label class="check">
          <input
            type="checkbox"
            checked={pickedRemoteArmor.includes(row.itemID)}
            onchange={() => toggleRemoteArmor(row.itemID)}
          />
          {row.label}
        </label>
      {/each}
      <p><strong>Capacitor transfer arrays</strong> (answers "needs capacitor")</p>
      {#each equipment as row (row.itemID)}
        <label class="check">
          <input
            type="checkbox"
            checked={pickedRemoteCapacitor.includes(row.itemID)}
            onchange={() => toggleRemoteCapacitor(row.itemID)}
          />
          {row.label}
        </label>
      {/each}
    {/if}

    <h3>Weapons</h3>
    <p class="note warn">
      Leave this empty and the pilot only LOCKS what the fleet calls - it will
      never fire. Tick a weapon here if you want it to actually shoot the
      target once locked.
    </p>
    {#if equipment.length === 0}
      <p class="empty">
        Nothing powered up. Power your turrets or launchers up under Your
        equipment, then come back.
      </p>
    {:else}
      <p class="note">
        Tick the fitted weapons the companion may fire at a locked target.
        Nothing is picked for you here either - a wrong guess would fire
        something you did not choose.
      </p>
      {#each equipment as row (row.itemID)}
        <label class="check">
          <input
            type="checkbox"
            checked={pickedWeapon.includes(row.itemID)}
            onchange={() => toggleWeapon(row.itemID)}
          />
          {row.label}
        </label>
      {/each}
    {/if}

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
      <input type="checkbox" bind:checked={useDrones} />
      Use drones to defend itself
    </label>
    <p class="field">
      <label for="companion-drone-holdoff">Hold drones in the bay for at least</label>
      <input
        id="companion-drone-holdoff"
        type="number"
        min={MIN_DRONE_HOLD_OFF_SECONDS}
        max={MAX_DRONE_HOLD_OFF_SECONDS}
        step="1"
        disabled={!useDrones}
        bind:value={droneHoldOffSeconds}
      />
      <span class="note">seconds before relaunching them (only matters if it uses drones)</span>
    </p>

    <h3>Target tagging</h3>
    <label class="check">
      <input type="checkbox" bind:checked={attemptsTagging} />
      Let this pilot try to tag targets for the fleet
    </label>
    <p class="note">
      Only one pilot per squad should turn this on. A tag is unique fleet-wide,
      so two taggers fight over letters and the fleet stops trusting them. The
      server drops the write silently if this pilot is not a fleet commander,
      so this is only ever a try.
    </p>

    <h3>What it listens to</h3>
    <p class="note">
      Turning a channel off never changes the order of who wins - the server's
      own fleet warp always comes first, then a broadcast, then a chat command,
      then this pilot's own flee rule, then its own judgement.
    </p>
    {#each FLEET_COMPANION_ORDER_SOURCES as source (source)}
      <label class="check">
        <input
          type="checkbox"
          checked={obeys.includes(source)}
          onchange={() => toggleObeys(source)}
        />
        {orderSourceLabels[source]}
      </label>
    {/each}
    {#if obeys.includes("chat")}
      <p class="field">
        <label for="companion-chat-senders">Also obey chat commands from</label>
        <input
          id="companion-chat-senders"
          type="text"
          placeholder="character IDs, separated by commas"
          bind:value={chatCommandSendersText}
        />
      </p>
      <p class="note">
        Whoever the fleet roster already names a commander is obeyed
        regardless. This is only for anyone else you want heard, by character
        ID - never filled in from chat text itself.
      </p>
      {#if chatCommandSenderIDs.length > 0}
        <p class="note">
          Will also obey:
          {chatCommandSenderIDs
            .map((id) => resolvedName($names.resolved, "character", id, "(name pending)"))
            .join(", ")}
        </p>
      {/if}
    {/if}

    <h3>If it ends up alone</h3>
    <p class="note">
      This pilot only ever works while somebody in the fleet is not being flown
      by this computer. The moment that stops being true it docks at the nearest
      station, leaves the fleet, and waits half an hour for one of the pilots
      who WAS in the fleet to invite it back - then it releases the ship. An
      invite from anybody else is ignored.
    </p>
    <p class="field">
      <label for="companion-safe-spot">If there is no station in sight, warp to</label>
      <select
        id="companion-safe-spot"
        value={safeSpotBookmarkID === null ? "" : String(safeSpotBookmarkID)}
        onchange={(event) => {
          const picked = (event.currentTarget as HTMLSelectElement).value;
          safeSpotBookmarkID = picked === "" ? null : Number(picked);
        }}
      >
        <option value="">nowhere - stop and say so</option>
        {#each safeSpots as spot (spot.bookmarkID)}
          <option value={String(spot.bookmarkID)}>{spot.name}</option>
        {/each}
      </select>
    </p>
    <p class="note">
      Pick a bookmark you have actually checked. Leaving this at "nowhere" is a
      real answer - the pilot stops where it is and tells you, rather than
      warping somewhere neither of you has looked at.
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
  #companion-drone-holdoff {
    width: 5rem;
  }
  #companion-chat-senders {
    min-width: 16rem;
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
