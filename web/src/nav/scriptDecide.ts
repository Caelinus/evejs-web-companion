// A4b — the tick orchestrator: given a script, a fresh observation, and the
// running memory, decide the ONE action this tick, and hand back the next
// memory. Pure and total — it always returns exactly one action (wait included)
// with a why, so bounds can dispatch on it and no tick is ever empty of a
// decision.
//
// ─── THE SHAPE OF A TICK ─────────────────────────────────────────────────────
//
//   1. If a "dock and stop" interrupt already fired, the ship is flying home;
//      keep flying it, then pause once docked.
//   2. Otherwise, interrupts first (A4a): a met one fires; a pirate with an
//      unreadable ship pauses.
//   3. Otherwise, the FORWARD SCAN runs the program: consult the active step's
//      macro, and if the step is finished (its `until` met while the macro is
//      armed, or the macro reports itself done) advance to the next node and
//      consult it IN THE SAME TICK — never backwards except a loop re-entering
//      its own body, counted against its repeat.
//
// ─── WHY IT CANNOT LIVELOCK ──────────────────────────────────────────────────
//
// The scan records every position it visits this tick. Coming back to one it
// already tried means the program made a full loop emitting nothing — the exact
// "a tick can legally emit no world call" primitive the phases model died of.
// That is not silently tolerated: it pauses with a plain reason. A step that
// runs too long (a macro-internal counter gap) trips MAX_STEP_TICKS. A read that
// stays unreadable trips the cannot-tell streak. Every way of doing nothing has
// a bound.

import { countSteps } from "../bots/botScript.ts";
import type {
  BotScript,
  BranchBlock,
  Condition,
  LoopBlock,
  MacroID,
  MacroStep,
} from "../bots/botScript.ts";
import { alertSentence, conditionSentence } from "../bots/scriptText.ts";
import {
  SENTENCE as COND_SENTENCE,
  bumpCannotTellStreak,
  cannotTellStreakExhausted,
  evaluateCondition,
  releaseSpentAlerts,
  resolveInterrupt,
  type ScriptObservation,
} from "./scriptConditions.ts";

// ─── The one action a tick emits ─────────────────────────────────────────────

export type ScriptAction =
  | { readonly kind: "wait" }
  | { readonly kind: "undock" }
  | { readonly kind: "dock"; readonly stationID: number }
  | { readonly kind: "warp"; readonly targetID: number }
  | { readonly kind: "approach"; readonly targetID: number }
  | { readonly kind: "align"; readonly targetID: number }
  | { readonly kind: "orbit"; readonly targetID: number; readonly range: number }
  | { readonly kind: "jump"; readonly fromGateID: number; readonly toGateID: number }
  | { readonly kind: "lock"; readonly targetID: number }
  | { readonly kind: "unlock"; readonly targetID: number }
  | { readonly kind: "activate"; readonly moduleID: number; readonly targetID: number }
  | { readonly kind: "deactivate"; readonly moduleID: number }
  | { readonly kind: "launchDrones"; readonly droneItemIDs: readonly number[] }
  | { readonly kind: "engageDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  | { readonly kind: "recallDrones"; readonly droneIDs: readonly number[] }
  | { readonly kind: "unloadOre"; readonly itemIDs: readonly number[] }
  // ── Mission actions (the distribution blocks). Each is one proven mission-bot
  //    operation: a labeled button press in the agent conversation, a handoff to
  //    the shared autopilot, or a package move confirmed by re-read next tick.
  | { readonly kind: "agentButton"; readonly agentID: number; readonly actionID: number; readonly label: string }
  | { readonly kind: "startRoute"; readonly stationID: number }
  | { readonly kind: "loadMissionCargo"; readonly typeID: number; readonly quantity: number }
  | { readonly kind: "unloadMissionCargo"; readonly itemIDs: readonly number[] }
  /** Order salvage drones onto a wreck; targetID 0 = the runtime auto-picks. */
  | { readonly kind: "salvageDrones"; readonly droneIDs: readonly number[]; readonly targetID: number }
  /** Take everything out of ONE wreck (an owned wreck — the decider guarantees it). */
  | { readonly kind: "lootWreck"; readonly wreckID: number }
  /** Take everything out of ONE container (any container on grid — no ownership check). */
  | { readonly kind: "lootContainer"; readonly containerID: number }
  /** Run these hangar stacks through the station refinery (verified server-side). */
  | { readonly kind: "reprocessOre"; readonly itemIDs: readonly number[] }
  /** Warp to a scanned site by its scan-signature label ("QEE-288"). */
  | { readonly kind: "warpScan"; readonly target: string }
  /** Warp to a saved bookmark (the server resolves site/point + mission scope). */
  | { readonly kind: "warpBookmark"; readonly bookmarkID: number }
  /** Board a ship in the station hangar (it becomes the active ship). */
  | { readonly kind: "boardShip"; readonly shipID: number }
  /** Apply a saved fitting to the active ship (modules from this hangar). */
  | { readonly kind: "applyFitting"; readonly fittingID: number }
  /** Restart ONE expired extractor program (same resource it was pulling). */
  | { readonly kind: "restartExtractor"; readonly planetID: number; readonly pinID: number; readonly resourceTypeID: number }
  /** Pay the station repair shop to fix these items. */
  | { readonly kind: "repairItems"; readonly itemIDs: readonly number[] }
  /** Move stacks between docked places (hangar / cargo / ore hold), qty = split. */
  | {
      readonly kind: "moveItems";
      readonly itemIDs: readonly number[];
      readonly from: string;
      readonly to: string;
      readonly qty: number | null;
    }
  /** Place a market BUY order (server confirm-gated; spends ISK + broker fee). */
  | { readonly kind: "placeBuyOrder"; readonly typeID: number; readonly price: number; readonly quantity: number }
  /** Place a market SELL order for one owned stack (server confirm-gated). */
  | {
      readonly kind: "placeSellOrder";
      readonly itemID: number;
      readonly typeID: number;
      readonly price: number;
      readonly quantity: number;
    }
  /** Form a fleet (server confirm-gated). */
  | { readonly kind: "createFleet" }
  /** Invite a character into the session's own fleet (server confirm-gated). */
  | { readonly kind: "inviteToFleet"; readonly charID: number }
  /** Accept a pending fleet invite (server confirm-gated). */
  | { readonly kind: "acceptFleetInvite" }
  /** Hand the SHARED autopilot a system-only route (arrives in space, no dock). */
  | { readonly kind: "startSystemRoute"; readonly systemID: number }
  /**
   * TELL THE PLAYER — a notification, a sound, a line in the readout. The one
   * action that touches nothing in the world; it is carried as an action anyway so
   * it rides the single "one thing per tick" path every other effect rides, and so
   * the flow (in a tab) and the server bot host (headless) can each deliver it the
   * way their surface allows.
   */
  | { readonly kind: "alert"; readonly message: string }
  /** ⚠ Dump these cargo items into space as a container anyone can take. */
  | { readonly kind: "jettison"; readonly itemIDs: readonly number[] }
  /** Stack everything loose in the docked station's hangar. */
  | { readonly kind: "stackHangar" }
  /**
   * Compress ONE ore stack against a support ship on grid. One stack per action:
   * the server answers every refusal with the same silence, so a batch could not
   * report which stack failed — the block re-reads its hold instead.
   */
  | { readonly kind: "compressOre"; readonly itemID: number; readonly facilityID: number }
  /** Product scanner actions carry no IDs; the BFF resolves authority afresh. */
  | { readonly kind: "scannerLaunch" }
  | { readonly kind: "scannerAnalyze" }
  | { readonly kind: "scannerRecover" };

/**
 * Does this action need to be PERFORMED (handed to `issue`)? Everything but a
 * wait. An `alert` is included even though it changes nothing in space: the
 * runner's job here is "is there something to do", and the alert has to be
 * delivered. It is not counted as world progress anywhere — the livelock proof
 * lives in the forward scan, and an alert is decided in the interrupt path above
 * it, so a program cannot satisfy the scan by alerting.
 */
export function isWorldCall(action: ScriptAction): boolean {
  return action.kind !== "wait";
}

const WAIT: ScriptAction = { kind: "wait" };

// ─── The macro contract (concrete macros land in A4c) ────────────────────────

/** Per-step scratch that persists across ticks while the step is active. */
export type MacroMemory = Readonly<Record<string, unknown>>;

/**
 * What a macro reports for one tick.
 *
 *   • outcome "acting"  — it wants to issue `action` (which may be a wait).
 *   • outcome "done"    — it has finished its own job (docked, hold empty); the
 *                         orchestrator advances to the next step this tick.
 *   • outcome "blocked" — it cannot proceed; the bot pauses with the reason.
 *
 * `armed` says whether the player's `until` is meaningful yet — mine-at-belt is
 * unarmed until it has arrived, which is what keeps "ore hold full" from reading
 * true against an empty hold while the ship is still in warp.
 */
export type MacroOutcome =
  | { readonly kind: "acting" }
  | { readonly kind: "done" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * The run-scoped BOARD: facts one block publishes for the blocks after it (the
 * found agent, its station, the mission's pickup/dropoff). Unlike per-step
 * memory it SURVIVES step transitions and loop laps; it dies with the run.
 */
export type ScriptBoard = Readonly<Record<string, number | string | null>>;

export interface MacroTick {
  readonly action: ScriptAction;
  readonly why: string;
  readonly phase: string;
  readonly armed: boolean;
  readonly outcome: MacroOutcome;
  readonly nextMem: MacroMemory;
  /** Facts to publish onto the run's board this tick (merged over what's there). */
  readonly boardPatch?: ScriptBoard;
}

export type MacroDecider = (
  step: MacroStep,
  obs: ScriptObservation,
  mem: MacroMemory,
  board: ScriptBoard,
) => MacroTick;

/** A partial lookup is useful to focused pure tests (an omitted macro pauses plainly). */
export type MacroRegistry = Readonly<Partial<Record<MacroID, MacroDecider>>>;

/** The production registry must implement EVERY format-level MacroID. */
export type CompleteMacroRegistry = Readonly<Record<MacroID, MacroDecider>>;

/** Flies the ship to `home` for a latched dock-and-pause. `done` == docked home. */
export type HomeTravelDecider = (obs: ScriptObservation, mem: MacroMemory) => MacroTick;

// ─── Memory ──────────────────────────────────────────────────────────────────

export const MAX_STEP_TICKS = 1800; // ~1h at the 2s cadence — the R39 backstop

const HOME_MEM_KEY = "__home__";

type Position =
  | { readonly kind: "step"; readonly node: number }
  | { readonly kind: "loop"; readonly node: number; readonly body: number }
  // A branch not yet entered: the next tick evaluates its `when` and commits to a
  // side. Kept distinct from "branch" so the condition is read ONCE on entry, not
  // re-read (and possibly flipped) each tick while a side runs.
  | { readonly kind: "branch-enter"; readonly node: number }
  | { readonly kind: "branch"; readonly node: number; readonly side: "then" | "else"; readonly body: number }
  // The same two states for a branch sitting INSIDE a loop body: `body` is the
  // branch's index in the loop body, `inner` its index within the chosen side.
  // It is re-entered (and so re-evaluated) on every pass — which is the point: a
  // loop that forks each lap.
  | { readonly kind: "loop-branch-enter"; readonly node: number; readonly body: number }
  | {
      readonly kind: "loop-branch";
      readonly node: number;
      readonly body: number;
      readonly side: "then" | "else";
      readonly inner: number;
    }
  | { readonly kind: "done" };

interface Latched {
  readonly interruptID: string;
  readonly reason: string;
}

export interface ScriptMemory {
  readonly position: Position;
  readonly loopPass: number;
  readonly stepTicks: number;
  readonly cannotTellStreak: number;
  readonly latched: Latched | null;
  readonly macroMem: Readonly<Record<string, MacroMemory>>;
  /** The run-scoped board — survives step transitions; dies with the run. */
  readonly board: ScriptBoard;
  /**
   * The ids of "alert me" rows that have already spoken for the episode their
   * condition is currently in. Optional so an older memory (or a test's) reads as
   * "nothing spent yet", which is the safe default: it alerts.
   */
  readonly spentAlerts?: readonly string[];
}

/** The memory a fresh run starts from — positioned at the first node. */
export function initialMemory(script: BotScript): ScriptMemory {
  return {
    position: startOfNode(script, 0),
    loopPass: 0,
    stepTicks: 0,
    cannotTellStreak: 0,
    latched: null,
    macroMem: {},
    board: {},
    spentAlerts: [],
  };
}

/**
 * The board as one R9a line for the readout — who the run is working with, by
 * NAME only (ids on the board never reach the screen, R7d). Null when the board
 * holds nothing a player would want to read.
 */
export function describeBoard(board: ScriptBoard): string | null {
  const agentName = typeof board["agentName"] === "string" ? (board["agentName"] as string) : null;
  const stationName =
    typeof board["agentStationName"] === "string" ? (board["agentStationName"] as string) : null;
  if (agentName === null) {
    return null;
  }
  return stationName !== null && stationName.length > 0
    ? `Working with ${agentName} (${stationName})`
    : `Working with ${agentName}`;
}

/**
 * Which macro the NEXT tick will consult — the runner's observe hint, so the
 * flow reads agent/journal/cargo only when a mission block is active. Null when
 * the program is done or heading home (only the ship reads are needed then).
 */
export function activeMacroID(script: BotScript, mem: ScriptMemory): string | null {
  if (
    mem.position.kind === "done" ||
    mem.position.kind === "branch-enter" ||
    mem.position.kind === "loop-branch-enter" ||
    mem.latched !== null
  ) {
    return null;
  }
  const step = activeStep(script, mem.position);
  return step?.macro ?? null;
}

// ─── The decision returned each tick ─────────────────────────────────────────

export type RunStatus = "running" | "paused" | "done";

export interface ScriptTickResult {
  readonly action: ScriptAction;
  readonly why: string;
  readonly phase: string;
  readonly stepPath: string | null;
  readonly interruptID: string | null;
  readonly status: RunStatus;
  readonly pauseReason: string | null;
  readonly memory: ScriptMemory;
}

// ─── Local sentences (R9a) ───────────────────────────────────────────────────

const SAY = {
  programDone: "The program finished, so the bot stopped.",
  livelock: "This program has nothing it can do right now, so the bot stopped.",
  stepTooLong: "A step ran for a very long time without finishing, so the bot stopped.",
  unknownMacro: "This program uses an action the bot does not know, so it stopped.",
  headingHome: "A watched warning was hit, so the bot is heading home to stop.",
} as const;

function stoppedBecause(clause: string): string {
  return `Stopped because ${clause}.`;
}

// ─── The tick ────────────────────────────────────────────────────────────────

export function decideScriptAction(
  script: BotScript,
  obs: ScriptObservation,
  mem: ScriptMemory,
  registry: MacroRegistry,
  travelHome: HomeTravelDecider,
): ScriptTickResult {
  if (mem.position.kind === "done") {
    return done(mem);
  }

  // 1. A latched "dock and stop" is flying the ship home.
  if (mem.latched !== null) {
    return continueHeadingHome(obs, mem, travelHome);
  }

  // 2. Interrupts. First release any "alert me" row whose condition has passed,
  // so a fresh episode can speak again; then scan, skipping rows still spent.
  const spentAlerts = releaseSpentAlerts(script.interrupts, obs, mem.spentAlerts ?? []);
  const scanMem = spentAlerts === (mem.spentAlerts ?? []) ? mem : { ...mem, spentAlerts };
  const res = resolveInterrupt(script.interrupts, obs, spentAlerts);
  if (res.kind === "safety-override") {
    // No interrupt row caused this — it is the sealed acute rule firing on its
    // own, so there is honestly no interrupt id to report.
    return paused(res.reason, scanMem, null);
  }
  if (res.kind === "fire") {
    return fireInterrupt(script, res.row.id, obs, scanMem, travelHome, registry, false);
  }

  // 2.5 The repair thermostat's OFF half: a repair watch whose condition has
  // RECOVERED (not-met — cannot-tell keeps repairing, blind is when you want the
  // reps most) switches its still-running repairers back off, one per tick, so
  // they stop eating capacitor once the ship is whole.
  const shutdown = repairShutdown(script, obs);
  if (shutdown !== null) {
    return {
      action: { kind: "deactivate", moduleID: shutdown.moduleID },
      why: "Repaired — switching the repairer back off.",
      phase: "Repairing",
      stepPath: shutdown.rowID,
      interruptID: shutdown.rowID,
      status: "running",
      pauseReason: null,
      memory: scanMem,
    };
  }

  // 3. The program, with the forward scan.
  return runProgram(script, obs, scanMem, registry);
}

/**
 * Equipment the CURRENT step switched on that has to be off before the step
 * can actually finish — see the `until`-met branch above for why. Scoped to
 * mine-at-belt for now: the same gap exists for other equipment-activating
 * blocks (salvage-wrecks, hardeners-on, fight-the-rats), but mining is the one
 * that actively refills the very hold the next step tends to be draining.
 */
function equipmentToShutDownBeforeLeaving(step: MacroStep, obs: ScriptObservation): number | null {
  if (step.macro !== "mine-at-belt") {
    return null;
  }
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
  return (obs.miningModuleIDs ?? []).find((id) => active.has(id)) ?? null;
}

/**
 * The rock the CURRENT step locked that has to be released before the step
 * can actually finish — see the `until`-met branch above for why. Reads the
 * rock id back out of the step's OWN memory (already updated with this tick's
 * `nextMem` above) rather than guessing from `lockedTargetIDs` at large, so
 * this only ever releases a lock mine-at-belt itself put on — never a target
 * the player, or some other block, locked for its own reason.
 */
function targetToUnlockBeforeLeaving(
  step: MacroStep,
  obs: ScriptObservation,
  macroMem: Readonly<Record<string, MacroMemory>>,
): number | null {
  if (step.macro !== "mine-at-belt") {
    return null;
  }
  const rockID = macroMem[step.id]?.["rockID"];
  if (typeof rockID !== "number") {
    return null;
  }
  return (obs.lockedTargetIDs ?? []).includes(rockID) ? rockID : null;
}

/** A running repairer whose repair watch has recovered, or null. */
function repairShutdown(
  script: BotScript,
  obs: ScriptObservation,
): { readonly rowID: string; readonly moduleID: number } | null {
  const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
  if (active.size === 0) {
    return null;
  }
  for (const row of script.interrupts) {
    if (row.respond !== "repair") {
      continue;
    }
    if (evaluateCondition(row.when, obs) !== "not-met") {
      continue;
    }
    const running = repairersFor(row.when.kind, obs).find((id) => active.has(id));
    if (running !== undefined) {
      return { rowID: row.id, moduleID: running };
    }
  }
  return null;
}

// ─── Interrupts ──────────────────────────────────────────────────────────────

function fireInterrupt(
  script: BotScript,
  rowID: string,
  obs: ScriptObservation,
  mem: ScriptMemory,
  travelHome: HomeTravelDecider,
  registry: MacroRegistry,
  _reentry: boolean,
): ScriptTickResult {
  const row = script.interrupts.find((r) => r.id === rowID);
  if (row === undefined) {
    return runProgram(script, obs, mem, registry);
  }
  switch (row.respond) {
    case "pause":
      return paused(stoppedBecause(conditionSentence(row.when)), mem, row.id);
    case "dock-and-pause": {
      const latched: Latched = { interruptID: row.id, reason: stoppedBecause(conditionSentence(row.when)) };
      return continueHeadingHome(obs, { ...mem, latched }, travelHome);
    }
    case "launch-drones": {
      if (obs.dronesOut === true) {
        // Already defended — keep working the program.
        return runProgram(script, obs, mem, registry);
      }
      return {
        action: { kind: "launchDrones", droneItemIDs: obs.droneBayItemIDs ?? [] },
        why: "A pirate showed up, so the drones go out to defend the ship.",
        phase: "Defending",
        stepPath: row.id,
        interruptID: row.id,
        status: "running",
        pauseReason: null,
        memory: mem,
      };
    }
    case "repair": {
      // Switch ON one idle repairer for the watched layer — unless the capacitor
      // is too low to feed it, in which case switch one OFF instead (an empty cap
      // repairs nothing and locks the ship up). One action, then the program
      // continues; the watch re-fires next tick while the condition holds.
      const reps = repairersFor(row.when.kind, obs);
      const active = new Set(obs.snapshot?.ship?.activeModuleIDs ?? []);
      const cap = obs.capacitorRatio ?? null;
      if (cap !== null && cap < REPAIR_CAP_FLOOR) {
        const running = reps.find((id) => active.has(id));
        if (running !== undefined) {
          return {
            action: { kind: "deactivate", moduleID: running },
            why: "The capacitor is nearly empty, so the repairer is switched off to let it recover.",
            phase: "Repairing",
            stepPath: row.id,
            interruptID: row.id,
            status: "running",
            pauseReason: null,
            memory: mem,
          };
        }
        return runProgram(script, obs, mem, registry);
      }
      const idle = reps.find((id) => !active.has(id));
      if (idle === undefined) {
        // Nothing to switch on (all running, or none fitted) — keep working.
        return runProgram(script, obs, mem, registry);
      }
      return {
        action: { kind: "activate", moduleID: idle, targetID: 0 },
        why: "Running the repairers.",
        phase: "Repairing",
        stepPath: row.id,
        interruptID: row.id,
        status: "running",
        pauseReason: null,
        memory: mem,
      };
    }
    case "alert": {
      // Say it ONCE, mark the row spent (so it neither repeats nor blocks the
      // rows under it), and keep the program running — an alert changes nothing
      // about the ship. The next tick's scan skips this row and reaches whatever
      // sits below it, which is what makes "tell me AND dock" work as two rows.
      const spent = [...(mem.spentAlerts ?? []), row.id];
      const message = alertSentence(row);
      return {
        action: { kind: "alert", message },
        why: message,
        phase: "Letting you know",
        stepPath: row.id,
        interruptID: row.id,
        status: "running",
        pauseReason: null,
        memory: { ...mem, spentAlerts: spent },
      };
    }
  }
}

/** Don't run a repairer below this — an empty capacitor repairs nothing. */
export const REPAIR_CAP_FLOOR = 0.2;

/** Which fitted repairers answer a given watch: the matching layer, or ALL for a
 * whole-ship (health-below) watch. Non-health watches repair nothing. */
function repairersFor(kind: Condition["kind"], obs: ScriptObservation): readonly number[] {
  switch (kind) {
    case "shield-below":
      return obs.shieldRepairerIDs ?? [];
    case "armor-below":
      return obs.armorRepairerIDs ?? [];
    case "hull-below":
      return obs.hullRepairerIDs ?? [];
    case "health-below":
      return [
        ...(obs.shieldRepairerIDs ?? []),
        ...(obs.armorRepairerIDs ?? []),
        ...(obs.hullRepairerIDs ?? []),
      ];
    default:
      return [];
  }
}

function continueHeadingHome(
  obs: ScriptObservation,
  mem: ScriptMemory,
  travelHome: HomeTravelDecider,
): ScriptTickResult {
  const latched = mem.latched;
  if (latched === null) {
    // Should not happen; nothing to fly. Treat as a plain pause.
    return paused(SAY.headingHome, mem, null);
  }
  const homeMem = mem.macroMem[HOME_MEM_KEY] ?? {};
  const tick = travelHome(obs, homeMem);
  const macroMem = { ...mem.macroMem, [HOME_MEM_KEY]: tick.nextMem };

  if (tick.outcome.kind === "done") {
    // Docked at home — now stop with the reason that sent us here.
    return paused(latched.reason, { ...mem, macroMem, latched: null }, latched.interruptID);
  }
  if (tick.outcome.kind === "blocked") {
    return paused(tick.outcome.reason, { ...mem, macroMem, latched: null }, latched.interruptID);
  }
  return {
    action: tick.action,
    why: tick.why,
    phase: tick.phase,
    stepPath: latched.interruptID,
    interruptID: latched.interruptID,
    status: "running",
    pauseReason: null,
    memory: { ...mem, macroMem },
  };
}

// ─── The forward scan ────────────────────────────────────────────────────────

function runProgram(
  script: BotScript,
  obs: ScriptObservation,
  mem: ScriptMemory,
  registry: MacroRegistry,
): ScriptTickResult {
  let position = mem.position;
  let loopPass = mem.loopPass;
  let macroMem = mem.macroMem;
  let board = mem.board;
  let blindThisTick = false;

  // A loop RE-ENTERING its own body is the only backward edge, and a single one
  // per tick is normal (the last body step finished, so we wrap to the first). A
  // SECOND wrap in one tick means a whole pass completed issuing no world call —
  // a hollow pass, the livelock. `maxHops` is a belt-and-suspenders ceiling.
  let wraps = 0;
  const maxHops = 2 * totalSteps(script) + script.program.length + 4;

  for (let hop = 0; hop <= maxHops; hop += 1) {
    if (position.kind === "done") {
      return done({ ...mem, position, loopPass, macroMem, board });
    }

    // At the top of a loop pass, a loop-level `until` can end the loop early.
    // (The first body element may itself be a branch, so both entry kinds count.)
    if ((position.kind === "loop" || position.kind === "loop-branch-enter") && position.body === 0) {
      const loop = script.program[position.node] as LoopBlock;
      if (loop.until !== undefined && evaluateCondition(loop.until, obs) === "met") {
        position = startOfNode(script, position.node + 1);
        loopPass = 0;
        continue;
      }
    }

    // Entering a branch: read its `when` ONCE and commit to a side (or skip an
    // empty side, or wait when it cannot be read — a side is never chosen blind).
    // Committing on entry is why a `when` that flips mid-side never bounces.
    // Handles a top-level branch and one inside a loop body with the same code.
    if (position.kind === "branch-enter" || position.kind === "loop-branch-enter") {
      // `loopBodyIndex` is the branch's slot in a loop body, or null at top level
      // — one value that both narrows the union and says which case we are in.
      const loopBodyIndex = position.kind === "loop-branch-enter" ? position.body : null;
      const branchNode = position.node;
      const branch =
        loopBodyIndex !== null
          ? ((script.program[branchNode] as LoopBlock).body[loopBodyIndex] as BranchBlock)
          : (script.program[branchNode] as BranchBlock);
      const verdict = evaluateCondition(branch.when, obs);
      if (verdict === "cannot-tell") {
        const samePlace = positionKey(position) === positionKey(mem.position);
        const stepTicks = (samePlace ? mem.stepTicks : 0) + 1;
        if (stepTicks > MAX_STEP_TICKS) {
          return paused(SAY.stepTooLong, { ...mem, position, loopPass, macroMem, board }, branch.id);
        }
        const streak = bumpCannotTellStreak(mem.cannotTellStreak, true);
        if (cannotTellStreakExhausted(streak)) {
          return paused(COND_SENTENCE.cannotTellStreak, { ...mem, position, loopPass, macroMem, board }, branch.id);
        }
        return {
          action: WAIT,
          why: `Working out whether ${conditionSentence(branch.when)}.`,
          phase: "Choosing a branch",
          stepPath: branch.id,
          interruptID: null,
          status: "running",
          pauseReason: null,
          // ⚠ SPREAD `mem` FIRST. This used to build the memory field by field, which
          // silently dropped anything the scan does not itself manage — `spentAlerts`
          // was reset every tick, so an "alert me" watch re-alerted forever.
          memory: { ...mem, position, loopPass, stepTicks, cannotTellStreak: streak, latched: null, macroMem, board },
        };
      }
      const side = verdict === "met" ? "then" : "else";
      const sideBody = side === "then" ? branch.then : branch.else;
      if (sideBody.length === 0) {
        // The chosen side is empty ("do nothing on this branch") — carry on past
        // it: out of the loop body (which may wrap the pass), or past the node.
        if (loopBodyIndex !== null) {
          const next = advanceLoopBody(script, branchNode, loopBodyIndex, loopPass);
          position = next.position;
          loopPass = next.loopPass;
          if (next.wrapped) {
            wraps += 1;
            if (wraps >= 2) {
              return paused(SAY.livelock, { ...mem, position, loopPass, macroMem, board }, null);
            }
          }
        } else {
          position = startOfNode(script, branchNode + 1);
          loopPass = 0;
        }
        continue;
      }
      position =
        loopBodyIndex !== null
          ? { kind: "loop-branch", node: branchNode, body: loopBodyIndex, side, inner: 0 }
          : { kind: "branch", node: branchNode, side, body: 0 };
      continue;
    }

    const step = activeStep(script, position);
    const decider = registry[step.macro];
    if (decider === undefined) {
      return paused(SAY.unknownMacro, { ...mem, position, loopPass, macroMem, board }, step.id);
    }

    const stepMem = macroMem[step.id] ?? {};
    const tick = decider(step, obs, stepMem, board);
    macroMem = { ...macroMem, [step.id]: tick.nextMem };
    if (tick.boardPatch !== undefined) {
      board = { ...board, ...tick.boardPatch };
    }

    if (tick.outcome.kind === "blocked") {
      return paused(tick.outcome.reason, { ...mem, position, loopPass, macroMem, board }, step.id);
    }

    if (tick.outcome.kind === "done") {
      macroMem = omit(macroMem, step.id); // leaving the step — its memory resets
      const next = advance(script, position, loopPass);
      position = next.position;
      loopPass = next.loopPass;
      if (next.wrapped) {
        wraps += 1;
        if (wraps >= 2) {
          return paused(SAY.livelock, { ...mem, position, loopPass, macroMem, board }, null);
        }
      }
      continue;
    }

    // outcome "acting" — the player's `until` can finish the step, but only once
    // the macro is ARMED (so a grid-dependent until cannot read true mid-warp).
    if (step.until !== undefined) {
      const verdict = evaluateCondition(step.until, obs);
      if (verdict === "met" && tick.armed) {
        // The macro's own tick action (computed above) is about to be thrown
        // away in favour of advancing — but equipment it already switched on
        // (mine-at-belt's lasers) keeps cycling regardless of what the program
        // does next, since nothing else ever tells it to stop. Left running, it
        // goes on filling the very hold the next step (typically a jettison) is
        // trying to empty, so that hold never reads empty and the loop never
        // completes. Switch it off first, one module per tick — the same move
        // the interrupt ladder's repair thermostat makes above.
        const runningModuleID = equipmentToShutDownBeforeLeaving(step, obs);
        if (runningModuleID !== null) {
          return {
            action: { kind: "deactivate", moduleID: runningModuleID },
            why: "The until condition is met — switching the mining equipment off before moving on.",
            phase: tick.phase,
            stepPath: step.id,
            interruptID: null,
            status: "running",
            pauseReason: null,
            memory: { ...mem, position, loopPass, macroMem, board },
          };
        }
        // The lock on the rock the step was working outlives the step itself
        // exactly the same way — nothing else ever releases it, so leaving the
        // rock locked and picking a fresh one (usually a different one) next
        // cycle only ADDS a lock, never trades one out. A few of these cycles
        // and the ship is sitting at its max locked targets with old, no-longer-
        // relevant rocks still held, unable to lock the next one at all.
        const lockedTargetID = targetToUnlockBeforeLeaving(step, obs, macroMem);
        if (lockedTargetID !== null) {
          return {
            action: { kind: "unlock", targetID: lockedTargetID },
            why: "The until condition is met — releasing the lock before moving on.",
            phase: tick.phase,
            stepPath: step.id,
            interruptID: null,
            status: "running",
            pauseReason: null,
            memory: { ...mem, position, loopPass, macroMem, board },
          };
        }
        macroMem = omit(macroMem, step.id); // leaving the step — its memory resets
        const next = advance(script, position, loopPass);
        position = next.position;
        loopPass = next.loopPass;
        if (next.wrapped) {
          wraps += 1;
          if (wraps >= 2) {
            return paused(SAY.livelock, { ...mem, position, loopPass, macroMem, board }, null);
          }
        }
        continue;
      }
      if (verdict === "cannot-tell" && tick.armed) {
        blindThisTick = true;
      }
    }

    // Issue the macro's action — the single action of this tick.
    const samePlace = positionKey(position) === positionKey(mem.position);
    const stepTicks = (samePlace ? mem.stepTicks : 0) + 1;
    if (stepTicks > MAX_STEP_TICKS) {
      return paused(SAY.stepTooLong, { ...mem, position, loopPass, macroMem, board }, step.id);
    }
    const streak = bumpCannotTellStreak(mem.cannotTellStreak, blindThisTick);
    if (cannotTellStreakExhausted(streak)) {
      return paused(COND_SENTENCE.cannotTellStreak, { ...mem, position, loopPass, macroMem, board }, step.id);
    }

    return {
      action: tick.action,
      why: tick.why,
      phase: tick.phase,
      stepPath: step.id,
      interruptID: null,
      status: "running",
      pauseReason: null,
      memory: {
        // ⚠ `...mem` first, for the same reason as the branch-wait return above:
        // field-by-field construction drops whatever the scan does not manage, and
        // `spentAlerts` lives outside the scan (it belongs to the interrupt ladder).
        ...mem,
        position,
        loopPass,
        stepTicks,
        cannotTellStreak: streak,
        latched: null,
        macroMem,
        board,
      },
    };
  }

  // The scan is bounded by construction; reaching here means it could not make
  // progress, which is the livelock case under another name.
  return paused(SAY.livelock, { ...mem, position, loopPass, macroMem, board }, null);
}

// ─── Position arithmetic ─────────────────────────────────────────────────────

function startOfNode(script: BotScript, node: number): Position {
  if (node >= script.program.length) {
    return { kind: "done" };
  }
  const target = script.program[node];
  if (target?.kind === "loop") {
    // The first body element may itself be a branch — enter it properly.
    return startOfLoopBody(script, node, 0);
  }
  if (target?.kind === "branch") {
    return { kind: "branch-enter", node };
  }
  return { kind: "step", node };
}

/**
 * The position at a given index of a loop body — a plain step, or the ENTRY to a
 * branch sitting there (so its `when` is read fresh on every pass).
 */
function startOfLoopBody(script: BotScript, node: number, body: number): Position {
  const loop = script.program[node] as LoopBlock;
  return loop.body[body]?.kind === "branch"
    ? { kind: "loop-branch-enter", node, body }
    : { kind: "loop", node, body };
}

interface Advance {
  readonly position: Position;
  readonly loopPass: number;
  /** True when this move was a loop re-entering its own body (the backward edge). */
  readonly wrapped: boolean;
}

/**
 * Leave one loop-body ELEMENT (a step, or a whole branch) and take the next —
 * wrapping the pass against the repeat when the body is finished. The single
 * place the loop's backward edge is produced, for both element kinds.
 */
function advanceLoopBody(script: BotScript, node: number, body: number, loopPass: number): Advance {
  const loop = script.program[node] as LoopBlock;
  if (body + 1 < loop.body.length) {
    return { position: startOfLoopBody(script, node, body + 1), loopPass, wrapped: false };
  }
  // Body finished — one pass done.
  const donePasses = loopPass + 1;
  const another = loop.repeat.kind === "forever" || donePasses < loop.repeat.count;
  if (another) {
    return { position: startOfLoopBody(script, node, 0), loopPass: donePasses, wrapped: true };
  }
  return { position: startOfNode(script, node + 1), loopPass: 0, wrapped: false };
}

/** Move forward one step, wrapping a loop body against its repeat. */
function advance(script: BotScript, position: Position, loopPass: number): Advance {
  if (position.kind === "step") {
    return { position: startOfNode(script, position.node + 1), loopPass: 0, wrapped: false };
  }
  if (position.kind === "loop") {
    return advanceLoopBody(script, position.node, position.body, loopPass);
  }
  if (position.kind === "loop-branch") {
    const loop = script.program[position.node] as LoopBlock;
    const branch = loop.body[position.body] as BranchBlock;
    const side = position.side === "then" ? branch.then : branch.else;
    if (position.inner + 1 < side.length) {
      return {
        position: { kind: "loop-branch", node: position.node, body: position.body, side: position.side, inner: position.inner + 1 },
        loopPass,
        wrapped: false,
      };
    }
    // The chosen side is finished — leave the branch, i.e. leave this loop-body
    // element (which may wrap the pass). Never a backward edge of its own.
    return advanceLoopBody(script, position.node, position.body, loopPass);
  }
  if (position.kind === "branch") {
    const branch = script.program[position.node] as BranchBlock;
    const side = position.side === "then" ? branch.then : branch.else;
    if (position.body + 1 < side.length) {
      return { position: { kind: "branch", node: position.node, side: position.side, body: position.body + 1 }, loopPass, wrapped: false };
    }
    // The chosen side is finished — leave the branch (never a backward edge).
    return { position: startOfNode(script, position.node + 1), loopPass: 0, wrapped: false };
  }
  return { position: { kind: "done" }, loopPass: 0, wrapped: false };
}

function activeStep(script: BotScript, position: Position): MacroStep {
  if (position.kind === "loop") {
    const loop = script.program[position.node] as LoopBlock;
    return loop.body[position.body] as MacroStep;
  }
  if (position.kind === "loop-branch") {
    const loop = script.program[position.node] as LoopBlock;
    const branch = loop.body[position.body] as BranchBlock;
    const side = position.side === "then" ? branch.then : branch.else;
    return side[position.inner] as MacroStep;
  }
  if (position.kind === "branch") {
    const branch = script.program[position.node] as BranchBlock;
    const side = position.side === "then" ? branch.then : branch.else;
    return side[position.body] as MacroStep;
  }
  // position.kind === "step"
  return script.program[(position as { node: number }).node] as MacroStep;
}

function positionKey(position: Position): string {
  if (position.kind === "loop") {
    return `loop:${position.node}:${position.body}`;
  }
  if (position.kind === "branch") {
    return `branch:${position.node}:${position.side}:${position.body}`;
  }
  if (position.kind === "branch-enter") {
    return `branch-enter:${position.node}`;
  }
  if (position.kind === "loop-branch") {
    return `loop-branch:${position.node}:${position.body}:${position.side}:${position.inner}`;
  }
  if (position.kind === "loop-branch-enter") {
    return `loop-branch-enter:${position.node}:${position.body}`;
  }
  if (position.kind === "step") {
    return `step:${position.node}`;
  }
  return "done";
}

function omit(
  map: Readonly<Record<string, MacroMemory>>,
  key: string,
): Readonly<Record<string, MacroMemory>> {
  if (!(key in map)) {
    return map;
  }
  const next: Record<string, MacroMemory> = {};
  for (const k of Object.keys(map)) {
    if (k !== key) {
      const value = map[k];
      if (value !== undefined) {
        next[k] = value;
      }
    }
  }
  return next;
}

function totalSteps(script: BotScript): number {
  return countSteps(script.program);
}

// ─── Result builders ─────────────────────────────────────────────────────────

function done(mem: ScriptMemory): ScriptTickResult {
  return {
    action: WAIT,
    why: SAY.programDone,
    phase: "Finished",
    stepPath: null,
    interruptID: null,
    status: "done",
    pauseReason: null,
    memory: { ...mem, position: { kind: "done" }, latched: null },
  };
}

function paused(reason: string, mem: ScriptMemory, litID: string | null): ScriptTickResult {
  return {
    action: WAIT,
    why: reason,
    phase: "Stopped",
    stepPath: litID,
    interruptID: litID,
    status: "paused",
    pauseReason: reason,
    memory: { ...mem, latched: null },
  };
}
