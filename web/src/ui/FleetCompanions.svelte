<script lang="ts">
  // FLEET COMPANIONS — the global window, and the one place companions live.
  //
  // ⚠ WHY IT IS NOT A PANEL IN A PILOT'S DESKTOP. A companion takes its orders
  // from a fleet, and a fleet is a thing several of your pilots are in at once.
  // The questions this window exists to answer — who is following whom, who has
  // stopped, who is not in the fleet yet — are questions about the SQUAD, and a
  // per-pilot panel can only ever answer them one pilot at a time, by switching
  // to each pilot in turn and destroying the view you were reading. So it is
  // hoisted onto App's global layer (globalWindow.ts) and opened from the
  // character bar, which is the only chrome that outlives a pilot switch.
  //
  // ⚠ AND WHY IT IS NOT IN THE BOT MANAGER, where it used to be. A companion is
  // not a bot: it has no script, no library row, no work it picks for itself,
  // nothing to export or share. It was built as the third instance of the
  // mining/mission bot pattern and inherited that furniture; `BotID` no longer
  // lists it (nav/botRegistry.ts) and neither does the Manager.
  //
  // ⚠ IT IS A ROSTER YOU BUILD, NOT A MIRROR OF WHO IS SIGNED IN. It used to
  // list every session in the tab automatically: a pilot brought online to
  // check a contract sat in the fleet roster beside the three you meant, and
  // nothing on screen said which was which. An op is a set of pilots the player
  // CHOSE, so the window holds that choice (app/companionRosterPrefs.ts) and
  // adding a pilot is the act that puts it in the fleet and sets it flying.
  //
  // ⚠ THE JOIN IS THE `join-advertised-fleet` PROTOCOL, NOT A NEW ONE. You name
  // the op's fleet as it appears in the fleet finder; each added pilot then
  // applies, reads the SERVER'S OWN ANSWER, accepts the invite that answer says
  // was minted, and only then is in. An apply does not join you — see
  // docs/join-advertised-fleet-handoff.md, which is what an afternoon of a bot
  // hanging on a healthy fleet bought. The decider is nav/fleetJoinWatch.ts and
  // this file is only its driver: it performs what the decider asks for and
  // hands back what the server said.
  //
  // TWO KINDS OF ROW, both listed here because both are companions:
  //   • a TAB run — a pilot you added, flown by this tab's own loop, and
  //     stopped when the tab closes;
  //   • a SERVER run — started from the Pilot Hangar, flown headless by the BFF,
  //     and still flying when every tab is shut. Those are listed even though
  //     nobody added them: the Manager no longer shows companions, so without
  //     this a headless companion would have no door at all.
  //
  // ⚠ IT EMBEDS THE REAL PANEL AND FORKS NOTHING. The selected pilot's controls
  // and readout are `FleetCompanion.svelte` itself, bound to THAT pilot's store
  // and flow — the same component, the same Start/Pause/Stop, the same checklist
  // that has been live-proven. A second copy of a readout drifts, and a drifted
  // readout does not go quiet: it keeps rendering, confidently, about a
  // companion doing something else.
  import { onMount } from "svelte";
  import FleetCompanion from "./FleetCompanion.svelte";
  import { listServerBots, stopServerBot, type ServerBot } from "../app/api.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { holdsTheShip, type ShipControllerID } from "../nav/botRegistry.ts";
  // ⚠ NO `canTagWords` HERE ANY MORE. The roster dropped its Can tag column;
  // what it says now is a short qualifier in the Companion cell, and only when
  // the answer is not a plain yes. `canTagWords` is still the wording for the
  // per-pilot readout in FleetCompanion.svelte, which is the view that reports
  // every field for one pilot rather than one field for every pilot.
  import { inFleetWords, orderFromWords } from "../bots/companionReadout.ts";
  import {
    companionStatusWords,
    companionSummaryWords,
    inFleetFrom,
    runFactsFor,
    serverCompanions,
    tallyCompanions,
  } from "../nav/companionRoster.ts";
  import {
    EMPTY_JOIN_MEMORY,
    decideFleetJoin,
    type FleetFinderRead,
    type FleetJoinMemory,
    type FleetJoinVerdict,
  } from "../nav/fleetJoinWatch.ts";
  import type { FleetApplication } from "../nav/scriptConditions.ts";
  import {
    EMPTY_COMPANION_ROSTER,
    addRosterMember,
    loadCompanionRoster,
    removeRosterMember,
    saveCompanionRoster,
    setRosterFleetName,
    setRosterSetup,
    type CompanionRosterPrefs,
  } from "../app/companionRosterPrefs.ts";
  import { loadKnownCharacters } from "../app/knownCharacters.ts";
  import {
    MAX_CAPACITOR_FLOOR,
    MAX_DRONE_HEALTH_FLOOR,
    MAX_DRONE_HOLD_OFF_SECONDS,
    MAX_FLEE_ATTEMPTS,
    MAX_FLEE_HEALTH_FLOOR,
    MIN_CAPACITOR_FLOOR,
    MIN_DRONE_HEALTH_FLOOR,
    MIN_DRONE_HOLD_OFF_SECONDS,
    MIN_FLEE_ATTEMPTS,
    MIN_FLEE_HEALTH_FLOOR,
    type CompanionSetup,
  } from "../nav/fleetCompanionLoop.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { Session } from "../app/sessions.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { FleetCompanionState } from "../store/types.ts";

  let {
    flow,
    sessions,
    onGoToPilot,
  }: {
    /**
     * The ACTIVE pilot's flow, used for one thing only: the account-scoped read
     * of the server's bot roster. Every per-pilot action below goes through
     * that pilot's OWN flow, off its own session — this window is never allowed
     * to drive one pilot with another's.
     */
    flow?: AppFlow;
    sessions?: readonly Session[];
    /** Make a pilot the active cockpit. Absent in tests and harnesses. */
    onGoToPilot?: (sessionID: string) => void;
  } = $props();

  const pilots = $derived(sessions ?? []);

  // --- the op ---------------------------------------------------------------

  let roster = $state<CompanionRosterPrefs>(loadCompanionRoster());

  function keepRoster(next: CompanionRosterPrefs): void {
    roster = next;
    saveCompanionRoster(next);
  }

  /**
   * One pilot's live readings, rebuilt from every session on each store tick.
   *
   * ⚠ REBUILT WHOLE, NEVER PATCHED. Writing `live = { ...live, [id]: … }` would
   * READ `live` inside the effect that writes it, and a Svelte effect that reads
   * what it writes re-runs itself forever. There are a handful of pilots; the
   * rebuild is free and the loop it avoids is not.
   *
   * ⚠ AND IT SUBSCRIBES TO EACH SESSION'S OWN SLICES rather than the active
   * pilot's store, which is the same thing BotManagerPilotRow does and for the
   * same reason: a backgrounded pilot is still live on the BFF, and the whole
   * point of this window is to show what it is doing while you are looking at
   * somebody else.
   */
  interface LivePilot {
    readonly name: string;
    readonly where: string;
    readonly characterID: number | null;
    readonly companion: FleetCompanionState;
    readonly holder: ShipControllerID | null;
    /**
     * The Fleet Center's own answer for this pilot.
     *
     * ⚠ WITHOUT IT THE IN-FLEET COLUMN IS DEAD UNTIL SOMETHING RUNS. A
     * companion's slice only carries a fleet reading while it is flying, so a
     * roster that asked only the slice would print "not known" against every
     * idle pilot — and "who is not in the fleet yet" is half of what this
     * window is for. `inFleetFrom` owns which of the two wins.
     */
    readonly fleetAvailability: string | null;
  }
  let live = $state<Record<string, LivePilot>>({});
  $effect(() => {
    const refresh = (): void => {
      const next: Record<string, LivePilot> = {};
      for (const session of pilots) {
        const state = session.store.get();
        next[session.id] = {
          name: state.station.online?.characterName ?? "This pilot",
          where:
            state.station.station?.stationName ??
            state.station.station?.solarSystemName ??
            state.flight.solarSystemName ??
            "Unknown",
          characterID: state.station.online?.characterID ?? null,
          companion: state.companion,
          holder: state.bots.runningBotID,
          fleetAvailability: state.fleet.availability,
        };
      }
      live = next;
    };
    const unsubs: Array<() => void> = [];
    for (const session of pilots) {
      unsubs.push(session.store.station.subscribe(refresh));
      unsubs.push(session.store.flight.subscribe(refresh));
      unsubs.push(session.store.companion.subscribe(refresh));
      unsubs.push(session.store.bots.subscribe(refresh));
      unsubs.push(session.store.fleet.subscribe(refresh));
    }
    refresh();
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });

  /** The signed-in session flying a given character, when there is one. */
  function sessionFor(characterID: number): Session | null {
    for (const session of pilots) {
      if (live[session.id]?.characterID === characterID) {
        return session;
      }
    }
    return null;
  }

  /**
   * A name for a pilot that is on the roster but not signed in here.
   *
   * ⚠ THE ROSTER STORES IDS AND NOTHING ELSE, and R7d forbids showing one. The
   * browser already knows the names of every pilot it has seen
   * (app/knownCharacters.ts), so the name is looked up rather than copied into
   * a second store that would go stale the day somebody is renamed.
   */
  const knownNames = $derived(
    new Map(loadKnownCharacters().map((known) => [known.characterID, known.characterName])),
  );

  // --- the join watch -------------------------------------------------------
  //
  // One watch per added pilot, ticked on a timer. It performs exactly what
  // nav/fleetJoinWatch.ts asks for and feeds back what the server answered;
  // every rule about what to do next lives in that module, where it can be
  // tested without a fleet.

  /** How often each unsettled pilot re-reads its fleet and the finder. */
  const WATCH_TICK_MS = 10_000;

  interface Watch {
    readonly memory: FleetJoinMemory;
    /** What the last apply answered. Only the caller of a write ever sees it. */
    readonly application: FleetApplication | null;
    readonly finder: FleetFinderRead;
    readonly verdict: FleetJoinVerdict | null;
    /**
     * ⚠ THE GUARD THAT KEEPS A STOP STOPPED. Adding a pilot starts it; without
     * this latch the next tick would see a pilot in the fleet not flying and
     * start it again, so the player's own Stop (and Stop all) would undo itself
     * ten seconds later. It is cleared only when the pilot is out of the fleet
     * and looking for it again, which is the op resuming rather than a decision
     * being overridden.
     */
    readonly started: boolean;
    /**
     * ⚠ LATCHED, AND DELIBERATELY STICKY. See `standingDown` in
     * nav/fleetJoinWatch.ts: the abandonment protocol ends by releasing the
     * ship, and a watch that treated that as "not in the fleet" would rejoin,
     * find itself alone again, and stand down again half an hour later, for
     * ever. Cleared when a human puts the companion back to running.
     */
    readonly stoodDown: boolean;
    /**
     * Why the last call was refused, in the player's words.
     *
     * ⚠ THE SWALLOWING IS WHAT COST AN AFTERNOON LAST TIME. A watch that
     * retries for ever shows the same patient sentence whether the fleet is
     * simply not advertised yet or every apply is being refused outright, and
     * the player has no way to tell those apart. Kept beside the row's own
     * words rather than raised as a panel error: it is one pilot's problem, and
     * the roster is where that pilot is.
     */
    readonly refusal: string | null;
  }

  const EMPTY_WATCH: Watch = {
    memory: EMPTY_JOIN_MEMORY,
    application: null,
    finder: { ads: null, ownFleetName: null },
    verdict: null,
    started: false,
    stoodDown: false,
    refusal: null,
  };

  let watches = $state<Record<number, Watch>>({});
  /** Pilots with a call in flight this tick — never two at once for one pilot. */
  const inFlight = new Set<number>();

  function setWatch(characterID: number, next: Watch): void {
    watches = { ...watches, [characterID]: next };
  }

  async function tickWatch(characterID: number): Promise<void> {
    const session = sessionFor(characterID);
    if (!session || inFlight.has(characterID)) {
      return;
    }
    const watch = watches[characterID] ?? EMPTY_WATCH;
    const pilot = live[session.id] ?? null;
    const companion = pilot?.companion ?? null;
    const holding = holdsTheShip(companion?.status ?? "idle");

    // The latch, both ways: an abandonment under way sets it, and a companion
    // a human has put back to running clears it.
    let stoodDown = watch.stoodDown;
    if (companion?.abandonment != null) stoodDown = true;
    else if (companion?.status === "running") stoodDown = false;

    inFlight.add(characterID);
    try {
      // Membership first: the watch's whole first question is whether this
      // pilot is in the fleet yet, and nothing else in this window refreshes a
      // BACKGROUNDED pilot's fleet.
      //
      // ⚠ BUT NOT WHEN THE RUN ALREADY ANSWERS IT. `flow.loadFleet` is five
      // bridge reads, and a companion that is flying reads its own fleet every
      // tick and reports what it saw — fresher than anything this window could
      // fetch. Paying five calls per pilot per beat for an answer already in
      // hand is the poll `skipWhileBusy`'s header warns about, arriving from
      // the other direction. `inFleetFrom` owns which source wins; this only
      // decides whether to pay for the second one.
      const runReading = holding ? (companion?.inFleet ?? null) : null;
      if (runReading !== true) {
        await Promise.resolve(session.flow.loadFleet()).catch(() => {});
      }
      const fleetSlice = session.store.fleet.get();
      const inFleet = inFleetFrom(fleetSlice.availability, companion?.inFleet ?? null, holding);

      // ⚠ THE FINDER IS READ ONLY WHILE IT IS NEEDED. A pilot that is settled in
      // the op's fleet needs no listing, and paying for one per pilot per tick
      // for the whole of an op is a poll nobody asked for. The moment membership
      // drops, the row is unsettled again and the read comes back.
      const settled = watch.verdict?.state === "in" && inFleet === true;
      const finder = settled ? watch.finder : await session.flow.readFleetFinder();

      const verdict = decideFleetJoin(
        {
          wantedName: roster.fleetName,
          inFleet,
          currentFleetID: fleetSlice.authoritativeFleetID,
          currentFleetName: finder.ownFleetName,
          ads: finder.ads,
          application: watch.application,
          standingDown: stoodDown,
        },
        watch.memory,
      );

      let application = watch.application;
      let memory = verdict.memory;
      // A tick that gets as far as deciding has nothing outstanding to explain;
      // whatever refused the last one is either fixed or about to say so again.
      let refusal: string | null = null;
      if (verdict.action.kind === "apply") {
        const applied = verdict.action.fleetID;
        try {
          // ⚠ THE ANSWER IS THE PROTOCOL. `true` means the advert wanted the
          // boss's approval and no invite exists; `false` means one was minted
          // and this client must accept it. Throwing it away is what made the
          // first version of this round trip hang.
          application = { fleetID: applied, outcome: await session.flow.applyToJoinFleet(applied) };
        } catch (cause) {
          // The id is dropped with the answer: the next tick starts the
          // application over rather than waiting on a call that never landed.
          // It is REPORTED, not swallowed — see `refusal`.
          application = null;
          memory = EMPTY_JOIN_MEMORY;
          refusal = panelErrorWords(cause);
        }
      } else if (verdict.action.kind === "accept") {
        try {
          // The fleet id is passed rather than looked up: the accept must not
          // wait on the invite notification being decoded into the slice.
          await session.flow.acceptFleetInvite(verdict.action.fleetID);
        } catch (cause) {
          // The attempt is already counted in `memory`; the bound in the
          // decider is what stops this repeating for ever.
          refusal = panelErrorWords(cause);
        }
      }

      // ⚠ ADDING A PILOT IS WHAT STARTS IT — the one place a start happens
      // without a press. It is gated on the latch above, on the ship being free,
      // and on this tab actually flying the pilot: a hull the SERVER is flying
      // is not ours to take.
      let started = verdict.state === "watching" ? false : watch.started;
      if (
        verdict.state === "in" &&
        !started &&
        !holding &&
        !serverHeldCharacterIDs.has(characterID)
      ) {
        started = true;
        try {
          await session.flow.startFleetCompanion(roster.setup);
        } catch {
          // The start's own refusal lands on the pilot's companion slice and is
          // shown by the embedded panel, which is the view that owns it.
        }
      }

      // ⚠ ONLY IF THE PILOT IS STILL IN THE OP. A tick awaits three calls, and a
      // player who pressed Remove during them would otherwise get the row back.
      if (roster.members.includes(characterID)) {
        setWatch(characterID, {
          memory,
          application,
          finder,
          verdict,
          started,
          stoodDown,
          refusal,
        });
      }
    } finally {
      inFlight.delete(characterID);
    }
  }

  onMount(() => {
    const beat = skipWhileBusy(async () => {
      for (const characterID of roster.members) {
        await tickWatch(characterID);
      }
    });
    void beat();
    const handle = setInterval(() => void beat(), WATCH_TICK_MS);
    return () => clearInterval(handle);
  });

  // --- the server's own companions -----------------------------------------
  //
  // Polled, for BotManager.svelte's reason: a headless companion changes phase,
  // joins a fleet and hits its runtime cap with no local event to notice, so an
  // onMount read alone would freeze this half of the roster at whenever the
  // window was opened — and a stale "Running" is a lie a player acts on.
  const SERVER_ROSTER_POLL_MS = 3000;
  let serverBots = $state<ServerBot[]>([]);
  let serverError = $state<string | null>(null);
  let serverLoaded = $state(false);

  async function refreshServer(): Promise<void> {
    if (!flow) return;
    try {
      serverBots = await listServerBots(flow.requestOptions());
      serverError = null;
    } catch {
      serverError = "Could not read the server's companions — are you still signed in?";
    } finally {
      serverLoaded = true;
    }
  }

  onMount(() => {
    if (!flow) return;
    void refreshServer();
    const beat = skipWhileBusy(refreshServer);
    const handle = setInterval(() => void beat(), SERVER_ROSTER_POLL_MS);
    return () => clearInterval(handle);
  });

  const serverRows = $derived(serverCompanions(serverBots));
  // A server companion flying a pilot whose tab is ALSO open here would
  // otherwise be two rows for one hull. The server holds the ship in that case
  // (bots/pilotRoster.ts's rule), so the tab row defers to it.
  const serverHeldCharacterIDs = $derived(new Set(serverRows.map((bot) => bot.characterID)));

  /** One row of the op: the pilot, its run, and where its joining has got to. */
  const tabRows = $derived(
    roster.members.map((characterID) => {
      const session = sessionFor(characterID);
      const state = session === null ? null : (live[session.id] ?? null);
      const holding = holdsTheShip(state?.companion?.status ?? "idle");
      return {
        characterID,
        session,
        name: state?.name ?? knownNames.get(characterID) ?? "This pilot",
        where: session === null ? "Not signed in here" : (state?.where ?? "Unknown"),
        companion: state?.companion ?? null,
        holder: state?.holder ?? null,
        joining: watches[characterID]?.verdict ?? null,
        joinRefusal: watches[characterID]?.refusal ?? null,
        inFleet: inFleetFrom(
          state?.fleetAvailability ?? null,
          state?.companion?.inFleet ?? null,
          holding,
        ),
        // The run-only columns, silent when no run holds this ship.
        facts: runFactsFor(holding, state?.companion ?? null),
        onServer: serverHeldCharacterIDs.has(characterID),
      };
    }),
  );

  /** Signed-in pilots that are not in the op yet — what Add offers. */
  const addable = $derived(
    pilots
      .map((session) => ({ session, pilot: live[session.id] ?? null }))
      .filter(
        (entry) =>
          entry.pilot?.characterID != null && !roster.members.includes(entry.pilot.characterID),
      ),
  );

  const tally = $derived(
    tallyCompanions([
      ...tabRows.filter((row) => !row.onServer).map((row) => row.companion?.status ?? null),
      ...serverRows.map((bot) => bot.status),
    ]),
  );
  const summary = $derived(companionSummaryWords(tally));

  /** Which row's detail is open: a session id, or `server:<botID>`. */
  let selected = $state<string | null>(null);
  const selectedSession = $derived(pilots.find((session) => session.id === selected) ?? null);
  const selectedServerBot = $derived(
    serverRows.find((bot) => `server:${bot.botID}` === selected) ?? null,
  );

  /**
   * Land on whatever is flying, so a player opening this window sees the run
   * they came to check rather than an arbitrary first pilot. It only ever moves
   * the view to something that IS holding a ship, and only while the player has
   * not chosen otherwise.
   */
  $effect(() => {
    if (selected !== null) return;
    const flying = tabRows.find(
      (row) => row.session !== null && holdsTheShip(row.companion?.status ?? "idle"),
    );
    if (flying?.session) {
      selected = flying.session.id;
      return;
    }
    const headless = serverRows[0];
    if (headless) {
      selected = `server:${headless.botID}`;
      return;
    }
    const first = tabRows.find((row) => row.session !== null);
    if (first?.session) selected = first.session.id;
  });

  let busy = $state(false);
  let error = $state("");

  async function run(action: () => Promise<unknown> | unknown): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }

  // --- adding and removing --------------------------------------------------

  let addChoice = $state<string>("");

  function addPilot(): void {
    const entry = addable.find((candidate) => candidate.session.id === addChoice);
    const characterID = entry?.pilot?.characterID ?? null;
    if (characterID === null) return;
    keepRoster(addRosterMember(roster, characterID));
    // A fresh watch, so a pilot added again after being removed is not held by
    // the latches the last one left behind.
    setWatch(characterID, EMPTY_WATCH);
    selected = entry?.session.id ?? selected;
    addChoice = "";
    void tickWatch(characterID);
  }

  /**
   * Take a pilot out of the op: stop it flying, then take it out of the fleet.
   *
   * ⚠ REMOVING UNDOES THE ADD, MEMBERSHIP INCLUDED, at the operator's call. The
   * add put this pilot in somebody's fleet; leaving it there after the row is
   * gone leaves a ship in a fleet warp chain that nothing on this screen is
   * watching any more.
   *
   * ⚠ NO CONFIRMATION DIALOG, for this window's standing reason: a dialog in
   * front of a fleet that is currently being shot at is worse than either
   * outcome it was guarding.
   */
  async function removePilot(characterID: number): Promise<void> {
    const session = sessionFor(characterID);
    const wasInFleet = session !== null && live[session.id]?.fleetAvailability === "ready";
    keepRoster(removeRosterMember(roster, characterID));
    const rest: Record<number, Watch> = {};
    for (const [key, watch] of Object.entries(watches)) {
      if (Number(key) !== characterID) rest[Number(key)] = watch;
    }
    watches = rest;
    if (session === null) return;
    await run(async () => {
      session.flow.stopFleetCompanion();
      if (wasInFleet) {
        await session.flow.leaveFleet();
      }
    });
  }

  /**
   * Stop every companion this window can reach — the tab runs through each
   * pilot's own flow, the headless ones through the server.
   *
   * ⚠ IT STOPS, IT DOES NOT DISBAND. Nobody is taken out of the fleet: a stop
   * is how you take a ship back by hand mid-op, and pulling it out of the fleet
   * warp chain as well is the one thing you would not want at that moment.
   * Removing a pilot is the act that undoes a join.
   */
  async function stopAll(): Promise<void> {
    await run(async () => {
      for (const row of tabRows) {
        if (row.session !== null && row.companion !== null && holdsTheShip(row.companion.status)) {
          row.session.flow.stopFleetCompanion();
        }
      }
      for (const bot of serverRows) {
        await stopServerBot(bot.botID, flow?.requestOptions() ?? {});
      }
      await refreshServer();
    });
  }

  const anyFlying = $derived(
    tabRows.some((row) => holdsTheShip(row.companion?.status ?? "idle")) || serverRows.length > 0,
  );

  // --- the op's limits ------------------------------------------------------
  //
  // ⚠ ONE SET OF NUMBERS FOR THE OP, NOT ONE PER PILOT, AND THAT IS BECAUSE
  // ADDING A PILOT STARTS IT. A per-pilot form is a form somebody has to fill
  // in before the start it gates, and nobody fills in four of them while a
  // fleet is forming. The embedded panel is handed exactly this and no longer
  // carries a form of its own — two forms for one run is two answers to the
  // same question, and only one of them would reach the loop.

  let fleeHealthFloorPercent = $state(Math.round(roster.setup.fleeHealthFloor * 100));
  let droneHealthFloorPercent = $state(Math.round(roster.setup.droneHealthFloor * 100));
  let capacitorFloorPercent = $state(Math.round(roster.setup.capacitorFloor * 100));
  let maxFleeAttempts = $state(roster.setup.maxFleeAttempts);
  /**
   * Docking gives the shield and the capacitor back but NOT the armour, so a
   * pilot that fled on armour damage cannot get back above its floor by
   * arriving. Ticking this lets it pay the station to fix the difference;
   * leaving it off means such a pilot stays docked and says so.
   */
  let repairsAtStation = $state(roster.setup.repairsAtStation);
  let droneHoldOffSeconds = $state(roster.setup.droneRedeployHoldOffSeconds);

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Write the form back to the op.
   *
   * ⚠ IT CHANGES WHAT THE NEXT START FLIES UNDER, NOT A RUNNING ONE. A
   * companion is started with a request read off its hull at that moment
   * (`flow.startFleetCompanion`), and nothing re-reads these numbers afterwards;
   * pretending otherwise would be the setup form on a server run, which this
   * window already refuses to show for the same reason.
   */
  function keepSetup(): void {
    keepRoster(
      setRosterSetup(roster, {
        fleeHealthFloor:
          clamp(fleeHealthFloorPercent, MIN_FLEE_HEALTH_FLOOR * 100, MAX_FLEE_HEALTH_FLOOR * 100) /
          100,
        capacitorFloor:
          clamp(capacitorFloorPercent, MIN_CAPACITOR_FLOOR * 100, MAX_CAPACITOR_FLOOR * 100) / 100,
        maxFleeAttempts: clamp(maxFleeAttempts, MIN_FLEE_ATTEMPTS, MAX_FLEE_ATTEMPTS),
        repairsAtStation,
        droneHealthFloor:
          clamp(
            droneHealthFloorPercent,
            MIN_DRONE_HEALTH_FLOOR * 100,
            MAX_DRONE_HEALTH_FLOOR * 100,
          ) / 100,
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
    <h2 class="panel-title">Fleet companions</h2>
    <!-- ⚠ NO DESCRIPTION OF WHAT A COMPANION IS. The title says it, the table
         shows it, and a paragraph restating it is a paragraph the player reads
         once and then has to look past every time afterwards. What stays is the
         one line that CHANGES: how many are flying.
         And it sits IN the strip, beside Stop all, rather than on its own line
         under it — the count and the button that acts on the count are one
         thought, and splitting them across the divider made the strip look like
         a toolbar with a caption. -->
    <p class="stat-line">{summary}</p>
    <span class="controls">
      <button type="button" class="danger" disabled={busy || !anyFlying} onclick={stopAll}>
        Stop all
      </button>
    </span>
  </header>
  <!-- THE FLEET THE OP IS. Every pilot added below watches for this name in the
       fleet finder and joins it when it appears, so it is asked for once, here,
       rather than per pilot. Typed as it is advertised: matching is trimmed and
       case-insensitive but never a substring, so an unattended ship cannot end
       up in a stranger's fleet whose name happened to contain the word. -->
  <p class="field">
    <label for="companion-op-fleet">Fleet</label>
    <input
      id="companion-op-fleet"
      type="text"
      placeholder="the name in the fleet finder"
      value={roster.fleetName}
      oninput={(event) =>
        keepRoster(setRosterFleetName(roster, (event.currentTarget as HTMLInputElement).value))}
    />
    <span class="note">
      {#if roster.fleetName.trim().length === 0}
        Pilots added below join this fleet as soon as it is advertised.
      {:else}
        Pilots added below wait for "{roster.fleetName.trim()}" and join it as soon as it is
        advertised.
      {/if}
    </span>
  </p>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if serverError}
    <p class="error">{serverError}</p>
  {/if}
</section>

<section>
  <!-- ⚠ NO "PILOTS" HEADING OVER THE ONLY TABLE HERE. A section heading earns
       its place by telling one block apart from its siblings; this block has
       none, and the table names its own first column "Pilot". A heading over a
       panel's single table is the panel's title said a third time. -->

  <p class="field">
    <label for="companion-add-pilot">Add a pilot</label>
    <select id="companion-add-pilot" bind:value={addChoice}>
      <option value="">Choose a pilot…</option>
      {#each addable as entry (entry.session.id)}
        <option value={entry.session.id}>{entry.pilot?.name ?? "This pilot"}</option>
      {/each}
    </select>
    <button type="button" class="primary" disabled={addChoice === ""} onclick={addPilot}>
      Add
    </button>
    <!-- ⚠ ONLY PILOTS ALREADY SIGNED IN. Bringing one online is the Pilot
         hangar's job and needs an account password; this window takes pilots
         that are already flying and puts them in a fleet. -->
    {#if addable.length === 0}
      <span class="note">Every pilot signed in here is already in this op.</span>
    {/if}
  </p>

  {#if tabRows.length === 0 && serverRows.length === 0}
    {#if pilots.length === 0}
      <p class="note">
        No pilot is signed in here. Bring one online from the Pilot hangar, then add it to this op.
      </p>
    {:else}
      <p class="note">
        Nobody is in this op yet. Add a pilot and it will join the fleet and start flying.
      </p>
    {/if}
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <!-- ⚠ FIVE COLUMNS, AND SHORT ONES. "Following orders from" and
                 "Last order heard" were each about twice the width of the value
                 under them, so two of the five columns were mostly header. A
                 column head is a label, not a sentence.
                 ⚠ AND "CAN TAG" IS NOT ONE OF THEM ANY MORE — see the Companion
                 cell below, which is where that fact went. It was a column that
                 read "yes" for nearly every pilot nearly all the time, and a
                 column whose interesting value is rare is a column a player
                 stops reading before the day it matters. -->
            <th>Pilot</th>
            <th>Companion</th>
            <th>In fleet</th>
            <th>Orders from</th>
            <th>Last order</th>
          </tr>
        </thead>
        <tbody>
          {#each tabRows as row (row.characterID)}
            {@const state = row.companion}
            <!-- A pilot whose hull the SERVER is flying is listed by the server
                 row below instead: that side owns the run, and this tab's
                 companion slice is a stale copy of a run it is not driving. -->
            {#if !row.onServer}
              <tr class:selected={row.session !== null && selected === row.session.id}>
                <td data-label="Pilot">
                  {#if row.session !== null}
                    {@const sessionID = row.session.id}
                    <button
                      type="button"
                      class="link-button"
                      aria-pressed={selected === sessionID}
                      onclick={() => (selected = sessionID)}
                    >
                      {row.name}
                    </button>
                  {:else}
                    <span>{row.name}</span>
                  {/if}
                  <span class="note">{row.where}</span>
                  <button
                    type="button"
                    class="link-button"
                    disabled={busy}
                    onclick={() => removePilot(row.characterID)}
                  >
                    Remove
                  </button>
                </td>
                <td data-label="Companion">
                  {companionStatusWords(state?.status ?? null)}
                  <!-- ⚠ SAID OUT LOUD, THOUGH A BOT IS NOT THIS WINDOW'S
                       BUSINESS. Starting a companion on a hull a bot is flying
                       takes the ship off that bot; a roster that showed only
                       companions would make that look like it came from
                       nowhere. -->
                  {#if state !== null && !holdsTheShip(state.status) && row.holder !== null && row.holder !== "companion"}
                    <span class="note"> — a bot is flying this ship</span>
                  {/if}
                  <!-- ⚠ WHERE THE "CAN TAG" COLUMN WENT, AND WHY IT IS SAID
                       HERE INSTEAD OF EVERYWHERE. The column printed a verdict
                       for every pilot on every row, and for nearly all of them,
                       nearly always, that verdict was "yes" — so the one row
                       that said otherwise had to be spotted in a column nobody
                       had any reason to look at.
                       ⚠ BOTH FAILING STATES SURVIVE, STILL UNFLATTENED. The
                       server drops a non-commander's tag while answering ok, so
                       a pilot that CANNOT tag looks exactly like one with
                       nothing to tag; `null` is "we could not tell" and must
                       never be read as "no". They get different sentences here
                       for the same reason `canTagWords` gives them different
                       words. `row.facts` is already silent unless a run holds
                       this ship, so neither line can appear against an idle
                       pilot. -->
                  {#if row.facts.canTag === false}
                    <span class="note"> — cannot tag, not a fleet commander</span>
                  {:else if row.facts.canTag === null && holdsTheShip(state?.status ?? "idle")}
                    <span class="note"> — tagging not known</span>
                  {/if}
                </td>
                <!-- ⚠ THE JOINING SENTENCE, NOT A BARE YES/NO, and it is the
                     whole reason this column is worth reading now. "no" against
                     a pilot that is applying, and "no" against one waiting for
                     a fleet nobody has advertised yet, are the same word for
                     two situations the player would act on differently. The
                     watch's own words say which. A pilot with no watch yet — one
                     not signed in here — falls back to the plain answer. -->
                <td data-label="In fleet">
                  {row.joining?.words ?? inFleetWords(row.inFleet)}
                  {#if row.joinRefusal}
                    <span class="note">{row.joinRefusal}</span>
                  {/if}
                </td>
                <!-- ⚠ `row.facts`, NOT THE SLICE. The companion slice keeps its
                     last readout after a run ends, so reading it directly left a
                     stopped pilot still claiming to be following orders and
                     still reporting whether it could tag — three confident
                     sentences about a pilot doing nothing. -->
                <td data-label="Orders from">{orderFromWords(row.facts.followingOrderFrom)}</td>
                <td data-label="Last order">{row.facts.lastOrderHeard ?? "-"}</td>
              </tr>
            {/if}
          {/each}
          {#each serverRows as bot (bot.botID)}
            {@const facts = bot.companion}
            <tr class:selected={selected === `server:${bot.botID}`}>
              <td data-label="Pilot">
                <button
                  type="button"
                  class="link-button"
                  aria-pressed={selected === `server:${bot.botID}`}
                  onclick={() => (selected = `server:${bot.botID}`)}
                >
                  {bot.characterName ?? "Unnamed pilot"}
                </button>
                <span class="note">On the server</span>
              </td>
              <td data-label="Companion">
                {companionStatusWords(bot.status)}
                <!-- ⚠ THE SAME TWO SENTENCES AS THE TAB ROWS, and they belong
                     here MORE, not less: this run is on the server, so nobody
                     is sitting in front of it to notice its tags going
                     nowhere. No `holdsTheShip` guard is needed — a row exists
                     in this half of the roster only while the server is flying
                     the hull. -->
                {#if facts?.canTag === false}
                  <span class="note"> — cannot tag, not a fleet commander</span>
                {:else if (facts?.canTag ?? null) === null}
                  <span class="note"> — tagging not known</span>
                {/if}
              </td>
              <td data-label="In fleet">{inFleetWords(facts?.inFleet ?? null)}</td>
              <td data-label="Orders from">{orderFromWords(facts?.followingOrderFrom ?? null)}</td>
              <td data-label="Last order">{facts?.lastOrderHeard ?? "-"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if flow && !serverLoaded}
      <p class="note">Reading the server's companions…</p>
    {/if}
  {/if}
</section>

<section>
  <h2>Limits for every pilot in this op</h2>
  <!-- ⚠ SET HERE, NOT ON EACH PILOT. Adding a pilot starts it, so there is no
       moment at which a per-pilot form would be filled in. A change here
       applies to the next companion that starts; one already flying keeps the
       numbers it was started with. -->
  <p class="field">
    <label for="companion-flee-floor">Flee below</label>
    <input
      id="companion-flee-floor"
      type="number"
      min={Math.round(MIN_FLEE_HEALTH_FLOOR * 100)}
      max={Math.round(MAX_FLEE_HEALTH_FLOOR * 100)}
      step="5"
      bind:value={fleeHealthFloorPercent}
      onchange={keepSetup}
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
      onchange={keepSetup}
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
      onchange={keepSetup}
    />
    <span class="note">flee round trips</span>
  </p>
  <!-- The label carries the whole fact: armour is the only damage a station
       charges for, because docking gives shield and capacitor back by itself. -->
  <label class="check">
    <input type="checkbox" bind:checked={repairsAtStation} onchange={keepSetup} />
    Pay a station to repair armour
  </label>
  <p class="field">
    <label for="companion-drone-floor">Bring a drone home below</label>
    <input
      id="companion-drone-floor"
      type="number"
      min={Math.round(MIN_DRONE_HEALTH_FLOOR * 100)}
      max={Math.round(MAX_DRONE_HEALTH_FLOOR * 100)}
      step="5"
      bind:value={droneHealthFloorPercent}
      onchange={keepSetup}
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
      onchange={keepSetup}
    />
    <span class="note">seconds before relaunching them</span>
  </p>
</section>

{#if selectedSession}
  <section class="panel">
    <header class="panel-head">
      <h2>{live[selectedSession.id]?.name ?? "This pilot"}</h2>
      <span class="controls">
        {#if onGoToPilot}
          <button type="button" onclick={() => onGoToPilot?.(selectedSession.id)}>
            Go to pilot
          </button>
        {/if}
      </span>
    </header>
  </section>
  <!--
    THE REAL PANEL, BOUND TO THAT PILOT.

    ⚠ `{#key}` IS LOAD-BEARING. `FleetCompanion.svelte` reads its store's slices
    once at init — it has to, because `$companion` needs a stable top-level
    binding — so handing a live instance a different `store` changes nothing: it
    would go on rendering the pilot it was created for, under another pilot's
    name. CharacterBar.svelte keys its one chip for exactly this reason.
  -->
  {#key selectedSession.id}
    <FleetCompanion
      store={selectedSession.store}
      flow={selectedSession.flow}
      setup={roster.setup}
    />
  {/key}
{:else if selectedServerBot}
  <section class="panel">
    <header class="panel-head">
      <h2>{selectedServerBot.characterName ?? "Unnamed pilot"}</h2>
      <span class="controls">
        <button
          type="button"
          class="danger"
          disabled={busy}
          onclick={() =>
            run(async () => {
              await stopServerBot(selectedServerBot.botID, flow?.requestOptions() ?? {});
              await refreshServer();
            })}
        >
          Stop
        </button>
      </span>
    </header>
    <!--
      ⚠ NO SETUP FORM, AND THAT IS NOT AN OVERSIGHT. This run is on the server,
      which took its limits when it was started from the Pilot hangar. Offering
      the fields here would let a player change numbers that reach nothing.
    -->
    <p class="note">
      This companion is flying on the server, so it keeps going when this tab is
      closed. Its limits were set when it was started, and the only thing this
      window can do to it from here is stop it.
    </p>
    <p class="stat-line">
      <strong>{selectedServerBot.phase ?? "Working"}</strong>
    </p>
    {#if selectedServerBot.why}
      <p class="note"><strong>Why:</strong> {selectedServerBot.why}</p>
    {/if}
    {#if selectedServerBot.companion && selectedServerBot.companion.fitWarnings.length > 0}
      <p class="note"><strong>Worth knowing about this fit:</strong></p>
      <ul>
        {#each selectedServerBot.companion.fitWarnings as warning (warning)}
          <li class="note">{warning}</li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  /* The chosen row, marked by weight rather than colour alone — the detail
     below carries the pilot's name in its own heading, which is the real
     confirmation of what is open. */
  tr.selected > td {
    border-top: 1px solid currentColor;
    border-bottom: 1px solid currentColor;
  }
  .link-button {
    display: inline;
    padding: 0;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  td .note {
    display: block;
  }
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
</style>
