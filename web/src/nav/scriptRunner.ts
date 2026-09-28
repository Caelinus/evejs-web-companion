// B2 — the script runner controller: the fourth instance of the proven loop
// shape (autopilot / mining / mission), driving the pure `decideScriptAction`
// tick. It owns the run lifecycle and NOTHING about the world — every read, every
// world call, the sleep, and the session-loss test are injected, so the runner
// is the same discipline the three shipping bots already follow and is testable
// with fakes.
//
// ⚠ THE DISCIPLINE, UNCHANGED FROM THE OTHER LOOPS:
//   • ONE call per tick, at most. `decideScriptAction` returns one action.
//   • A `runToken`, bumped on every start/pause/resume/stop, so a stale `run()`
//     that was mid-await when the player pressed pause stops driving.
//   • STATUS IS RE-CHECKED AFTER EVERY await — pause/stop can fire during a read
//     or an issue, and nothing may be issued afterwards.
//   • SETTLE TICKS after ordinary world calls — a few ticks of not-deciding so
//     asynchronous movement/writes can become observable (a 200 is not proof).
//     Ready-returning session changes skip this: their BFF promise resolves only
//     after authoritative location + ship/scene readiness can be re-read.
//   • Session loss is the one error allowed to end the run; any other failed read
//     becomes a wait, never a confident empty.

import type { BotScript, SquadRoleArg } from "../bots/botScript.ts";
import { resolveStationRef } from "./scriptMacros.ts";
import {
  activeMacroID,
  activeSquadRole,
  watchSquadRole,
  decideScriptAction,
  describeBoard,
  initialMemory,
  isWorldCall,
  type HomeTravelDecider,
  type MacroRegistry,
  type ScriptAction,
  type ScriptBoard,
  type ScriptMemory,
} from "./scriptDecide.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import { describeAction, newRunID, type BotLogDraft, type BotLogSink } from "./botLog.ts";
import {
  createRefusalLedger,
  MAX_CONSECUTIVE_REFUSALS,
  refusalKey,
  settleTicksForRefusals,
  type RefusalLedger,
  type RefusalRecord,
} from "./refusalLedger.ts";

/**
 * What the next decide will look at — so `observe` reads ONLY what that macro
 * needs (a mining block never pays for an agent-conversation read, and the
 * agent id the mission reads need rides in on the board).
 */
export interface ObserveHint {
  readonly activeMacro: string | null;
  /** Whether that block follows the fleet's called primary (see activeSquadRole). */
  readonly squadRole: SquadRoleArg;
  /**
   * Whether a fight-back WATCH follows one (see watchSquadRole). Read on every
   * tick, so the flow pairs it with hostiles actually being on grid before it
   * pays for a board read.
   */
  readonly watchSquadRole: SquadRoleArg;
  readonly board: ScriptBoard;
}

export const SCRIPT_CADENCE_MS = 2000;
export const SETTLE_TICKS = 2;
export const MAX_READ_FAILURES = 5;

/**
 * Actions that put items somewhere else, so a hold which had no room may have
 * room now. Their success is the signal that expires every `refused` streak —
 * see `forgetRefused`, without which a can set aside for a full hold would
 * never be tried again after the hold was emptied.
 */
function freesHoldSpace(action: ScriptAction): boolean {
  return action.kind === "unloadOre"
    || action.kind === "unloadHolds"
    || action.kind === "unloadMissionCargo"
    || action.kind === "moveItems"
    || action.kind === "jettison"
    || action.kind === "reprocessOre";
}

/**
 * The world object an action addresses, when it addresses one.
 *
 * Only the loot pair, deliberately. A per-target streak earns its keep where a
 * block walks a LIST of interchangeable objects — one jetcan that will not give
 * up its contents must not spend the budget belonging to the next can, and must
 * not be hidden by it either. Everything else is keyed by step + action kind,
 * which is identity enough for a block that addresses one thing at a time.
 */
function actionTargetID(action: ScriptAction): number | null {
  if (action.kind === "lootWreck") {
    return action.wreckID;
  }
  if (action.kind === "lootContainer") {
    return action.containerID;
  }
  return null;
}

/** Session-changing BFF calls whose successful return includes ready state. */
function returnsAuthoritativeSessionReadiness(action: ScriptAction): boolean {
  return action.kind === "undock"
    || action.kind === "dock"
    || action.kind === "jump"
    || action.kind === "boardShip";
}

export type ScriptRunnerStatus = "idle" | "running" | "paused" | "stopped" | "error";

/** The readout pushed to the store every tick. */
export interface ScriptRunnerSnapshot {
  readonly status: ScriptRunnerStatus;
  readonly phase: string | null;
  readonly why: string | null;
  readonly stepPath: string | null;
  readonly interruptID: string | null;
  readonly pauseReason: string | null;
  /** The run board as one line ("Working with <agent>"), or null. */
  readonly note: string | null;
  /**
   * What the server is currently turning down, worst first. Empty on a healthy
   * run. This is the readout whose ABSENCE let a bot answer 227 refusals over
   * twelve hours while its status line said "Taking what's inside."
   */
  readonly refusals: readonly RefusalRecord[];
}

/**
 * Everything the runner needs from the outside. `observe` builds a fresh
 * observation from live reads (B3); `issue` performs one world call (a wait is a
 * no-op it is never asked to perform); `registry` and `travelHome` are the macro
 * deciders (B1). All injected so the loop itself touches no globals.
 */
export interface ScriptRunnerDeps {
  observe(hint: ObserveHint): Promise<ScriptObservation>;
  issue(action: ScriptAction): Promise<void>;
  sleep(ms: number): Promise<void>;
  onProgress(snapshot: ScriptRunnerSnapshot): void;
  isSessionLost(error: unknown): boolean;
  /**
   * The RAW wire text behind a failed `issue`, code prefix and all — NOT player
   * language. The ledger words it through `describeRefusal` and classifies on
   * the code, so both need the untranslated form. Injected because extracting it
   * from a transport error is the app layer's business, not the runner's.
   */
  refusalReason(error: unknown): string;
  readonly registry: MacroRegistry;
  readonly travelHome: HomeTravelDecider;
  /**
   * The flight recorder (nav/botLog.ts). OPTIONAL: a runner with no sink runs
   * exactly as it always did, which is what keeps every existing caller and
   * every pure test unchanged.
   */
  readonly log?: BotLogSink;
}

export interface ScriptRunnerController {
  start(script: BotScript): void;
  pause(): void;
  resume(): void;
  stop(): void;
  tick(): Promise<void>;
  run(): Promise<void>;
  snapshot(): ScriptRunnerSnapshot;
  getStatus(): ScriptRunnerStatus;
}

const IDLE_SNAPSHOT: ScriptRunnerSnapshot = {
  status: "idle",
  phase: null,
  why: null,
  stepPath: null,
  interruptID: null,
  pauseReason: null,
  note: null,
  refusals: [],
};

const SETTLING = "Waiting between actions — watching your ship.";
const READ_RETRY = "Could not read your ship just now — waiting to try again.";
const READ_GAVE_UP = "Could not read your ship for several tries, so the bot stopped.";
const READ_GAVE_UP_SENT_HOME =
  "Could not read your ship for several tries, so the bot sent it to a station and stopped.";
const SESSION_LOST = "Lost the connection to your ship, so the bot stopped.";
const DECIDE_FAILED = "The bot hit an unexpected problem working out its next move, so it stopped.";

export function createScriptRunner(deps: ScriptRunnerDeps): ScriptRunnerController {
  let status: ScriptRunnerStatus = "idle";
  let runToken = 0;
  let script: BotScript | null = null;
  let memory: ScriptMemory | null = null;
  let settle = 0;
  let readFailures = 0;
  // ⚠ PER RUN, AND THAT IS THE POINT. A macro's own attempt counter lives in
  // step memory, which scriptDecide drops every time the step is left, so a
  // forever-loop hands the same failing target a fresh budget on every lap. This
  // one is replaced only by `start`, so its bound is the one that binds.
  let ledger: RefusalLedger = createRefusalLedger();
  let last: ScriptRunnerSnapshot = IDLE_SNAPSHOT;
  /**
   * The last observation that actually arrived. Kept for ONE reason: when reads
   * stop working there is nothing to decide with, but a station id read a few
   * seconds ago is still a station id — see `sendToStationThenStop`.
   */
  let lastObs: ScriptObservation | null = null;
  /** This run's id, minted by `start` — what groups a log's lines. */
  let runID = "";
  /** The last decision actually written, so a quiet bot writes nothing. */
  let loggedDecision = "";
  /**
   * Whether this run's end line is already written. A run ends ONCE: stopping a
   * bot that has already finished emits another terminal snapshot, and a log
   * that says a run ended twice is a log nobody can count runs in.
   */
  let loggedEnd = false;

  /**
   * ⚠ RULE 4: THE RECORDER NEVER BREAKS THE RUN. A sink that throws — a full
   * disk, a dead route, a bug of its own — loses its line and nothing else. It
   * is never awaited either: a slow writer must not add latency to a tick that
   * is flying a ship.
   */
  function record(draft: BotLogDraft): void {
    const sink = deps.log;
    if (sink === undefined) {
      return;
    }
    try {
      sink.write(draft);
    } catch {
      // A line lost is the correct price; a ship stopped is not.
    }
  }

  function now(): string {
    return new Date().toISOString();
  }

  /**
   * One line per CHANGE, not per tick. At a two-second cadence a verbatim log is
   * an hour of "Mining / Mining / Mining"; what a reader wants is the moments it
   * became something else. A run that ends writes its end line instead.
   */
  function recordProgress(next: ScriptRunnerSnapshot): void {
    if (deps.log === undefined) {
      return;
    }
    if (next.status === "stopped" || next.status === "error") {
      if (loggedEnd) {
        return;
      }
      loggedEnd = true;
      record({
        t: now(), kind: "end", run: runID, status: next.status,
        reason: next.pauseReason ?? next.why ?? null,
      });
      loggedDecision = "";
      return;
    }
    const key = [next.status, next.phase, next.why, next.stepPath, next.interruptID].join(" | ");
    if (key === loggedDecision) {
      return;
    }
    loggedDecision = key;
    record({
      t: now(), kind: "decide", run: runID, status: next.status,
      phase: next.phase, why: next.why, stepPath: next.stepPath, interruptID: next.interruptID,
      reason: next.pauseReason ?? null,
    });
  }

  function emit(next: ScriptRunnerSnapshot): void {
    last = next;
    recordProgress(next);
    deps.onProgress(next);
  }

  function setError(reason: string): void {
    runToken += 1;
    status = "error";
    emit({ ...last, status: "error", why: reason, pauseReason: reason });
  }

  async function tick(): Promise<void> {
    const token = runToken;
    if (status !== "running" || script === null || memory === null) {
      return;
    }

    // Settle: let a just-issued action land before deciding again.
    if (settle > 0) {
      settle -= 1;
      emit({ ...last, status: "running", phase: SETTLING });
      return;
    }

    let obs: ScriptObservation;
    try {
      obs = await deps.observe({
        activeMacro: activeMacroID(script, memory),
        squadRole: activeSquadRole(script, memory),
        watchSquadRole: watchSquadRole(script),
        board: memory.board,
      });
    } catch (error) {
      if (deps.isSessionLost(error)) {
        setError(SESSION_LOST);
        return;
      }
      readFailures += 1;
      if (readFailures >= MAX_READ_FAILURES) {
        await sendToStationThenStop();
        return;
      }
      emit({ ...last, status: "running", phase: READ_RETRY, why: READ_RETRY });
      return;
    }
    if (token !== runToken || status !== "running") {
      return; // pause/stop fired during the read
    }
    readFailures = 0;
    lastObs = obs;

    // Deciding is pure and total BY DESIGN, but a macro adapter reaching into a
    // live snapshot could still throw on a shape the tests never saw. If it does,
    // an unwrapped throw would reject run() and kill the loop SILENTLY — the ship
    // freezes mid-task with no reason on screen. So a throw here becomes a plain
    // pause the player can read and recover from, never a dead loop.
    let result: ReturnType<typeof decideScriptAction>;
    try {
      // ⚠ THE LEDGER RIDES IN ON THE OBSERVATION. A decider's whole interface is
      // "here are the facts, choose" — and "this can has refused me nine times
      // running, across four laps" is a fact about the world exactly like a
      // distance is. Handing it over here rather than as a fifth argument keeps
      // every macro reading one thing, and keeps `decideScriptAction` pure.
      result = decideScriptAction(
        script,
        { ...obs, refusals: ledger.records() },
        memory,
        deps.registry,
        deps.travelHome,
      );
    } catch (error) {
      stopOrHeadHome(`${DECIDE_FAILED} (${String(error)})`);
      return;
    }
    memory = result.memory;

    if (result.status === "paused") {
      pauseWith(result.pauseReason ?? result.why, result);
      return;
    }
    if (result.status === "done") {
      runToken += 1;
      status = "stopped";
      emit(toSnapshot(result, "stopped"));
      return;
    }

    if (isWorldCall(result.action)) {
      const targetID = actionTargetID(result.action);
      const key = refusalKey(result.stepPath, result.action.kind, targetID);
      let issuedSuccessfully = false;
      // Set only by a refusal, so a healthy call keeps the ordinary settle.
      let backoffTicks: number | null = null;
      // ⚠ WRITTEN BEFORE THE CALL, DELIBERATELY. A line after the fact says
      // nothing when the process dies mid-action; this is the one that tells
      // you what the ship was about to do when everything stopped.
      record({
        t: now(), kind: "issue", run: runID, action: result.action, says: describeAction(result.action),
        stepPath: result.stepPath, interruptID: result.interruptID, phase: result.phase, why: result.why,
      });
      try {
        await deps.issue(result.action);
        issuedSuccessfully = true;
        record({ t: now(), kind: "result", run: runID, ok: true, says: describeAction(result.action) });
        // It worked: the streak is over. Without this a key that failed twice
        // and then recovered would carry those two forever and stop the run
        // early on an unrelated blip much later.
        ledger.clear(key);
        if (freesHoldSpace(result.action)) {
          ledger.forgetRefused();
        }
      } catch (error) {
        if (deps.isSessionLost(error)) {
          setError(SESSION_LOST);
          return;
        }
        // A refusal is not a crash — but it is not nothing either, which is what
        // it used to be. It gets counted, worded, slowed down, and eventually
        // acted on rather than retried at full speed until somebody notices.
        //
        // `stillOnGrid` separates a target that has DESPAWNED from one that is
        // merely out of range: both arrive as the same FakeItemNotFound, and an
        // unreadable grid is evidence of neither (see classifyRefusal).
        const snapshot = obs.snapshot ?? null;
        const stillOnGrid =
          targetID === null || snapshot === null
            ? null
            : snapshot.entities.some((entity) => entity.itemID === targetID);
        const reason = deps.refusalReason(error);
        record({
          t: now(), kind: "result", run: runID, ok: false, refusal: reason,
          says: describeAction(result.action), stepPath: result.stepPath,
        });
        const record_ = ledger.note(key, reason, Date.now(), stillOnGrid);
        if (record_.count >= MAX_CONSECUTIVE_REFUSALS) {
          stopOrHeadHome(
            `Stopped after ${record_.count} refusals in a row. ${record_.words}`,
            result,
          );
          return;
        }
        backoffTicks = settleTicksForRefusals(record_.count);
      }
      if (token !== runToken || status !== "running") {
        return;
      }
      // Successful session-changing routes return only after observation is
      // authoritative, so the very next tick should consume that truth. Keep
      // the existing debounce for ordinary calls, and the GROWN one after a
      // refusal.
      settle = issuedSuccessfully
        ? (returnsAuthoritativeSessionReadiness(result.action) ? 0 : SETTLE_TICKS)
        : (backoffTicks ?? SETTLE_TICKS);
    }

    emit(toSnapshot(result, "running", ledger.records()));
  }

  /**
   * The station to send a blind ship to, best first.
   *
   * The script's OWN configured home comes first and needs no reads at all: it
   * is a setting the player pinned, resolved here exactly the way flow.ts
   * resolves it every tick (a fixed id, "where the ship started", or a station an
   * earlier block published on the board). The observation-derived ids are only
   * fallbacks for a home that resolves to nothing.
   *
   * ⚠ IT WILL NOT MOVE A SHIP IT HAS NEVER SEEN. With no observation at all
   * there is no evidence the ship is even in space, and undocking a safe ship to
   * fly it somewhere blind is a worse outcome than stopping and saying so. Same
   * for one last seen docked: it is already where this would send it.
   */
  function stationToSendTo(): number | null {
    const seen = lastObs;
    if (seen === null || seen.flightStatus?.docked === true) {
      return null;
    }
    const configured =
      script === null
        ? null
        : resolveStationRef(script.home, seen.startingStationID ?? null, memory?.board ?? {});
    return configured ?? seen.homeStationID ?? seen.startingStationID ?? seen.flightStatus?.stationID ?? null;
  }

  /**
   * READS HAVE GIVEN UP — and a blind ship still must not be left floating.
   *
   * Nothing can be decided here: there is no observation, so no grid, no health,
   * no target. But the autopilot is not driven by these reads — it runs its own
   * loop with its own reads and its own bounds — so handing it a station id the
   * bot knew a few seconds ago gets the ship moving toward a station even though
   * this runner can no longer see it do so.
   *
   * Then it stops, and says which of the two things happened. It cannot report
   * arrival: watching the ship dock is exactly the thing it has lost the ability
   * to do, and claiming a ship is safe without seeing it is the lie this file
   * avoids everywhere else.
   *
   * ⚠ THE SHIP IS NOT SAVED BY THIS, only pointed the right way. If it is held,
   * the autopilot will be refused and will pause too — blind, there is no
   * fighting free (nav/scriptMacros `fightTheWayOut` needs a grid to read).
   */
  async function sendToStationThenStop(): Promise<void> {
    const stationID = stationToSendTo();
    if (stationID === null) {
      pauseWith(READ_GAVE_UP);
      return;
    }
    const homeRoute = { kind: "startRoute", stationID } as const;
    record({ t: now(), kind: "issue", run: runID, action: homeRoute, says: describeAction(homeRoute), why: "sending the ship home" });
    try {
      await deps.issue(homeRoute);
    } catch {
      pauseWith(READ_GAVE_UP); // could not even ask — say the plain thing
      return;
    }
    pauseWith(READ_GAVE_UP_SENT_HOME);
  }

  /**
   * The runner's OWN faults stop the bot too — a decider that threw, an order the
   * world keeps refusing — and they must not leave the ship parked in space any
   * more than the decider's faults may (nav/scriptDecide `stopSafely`, same rule
   * and the same reason: four ships).
   *
   * So the first one LATCHES instead of pausing: the loop keeps ticking, the
   * decider sees the latch and flies the ship home, and the pause happens on
   * arrival carrying this reason. The flight issues different orders from the
   * one that was being refused, which is usually the whole problem.
   *
   * ⚠ ONLY ONCE. A second fault while already heading home means the way out is
   * failing too, and that is a real stop — otherwise a ship that cannot fly
   * anywhere would loop here forever, never pausing and never telling anyone.
   */
  function stopOrHeadHome(reason: string, result?: ReturnType<typeof decideScriptAction>): void {
    if (memory !== null && memory.latched === null) {
      memory = { ...memory, latched: { interruptID: null, reason } };
      emit({ ...last, status: "running", phase: "Heading home", why: reason, pauseReason: null });
      return;
    }
    pauseWith(reason, result);
  }

  function pauseWith(reason: string, result?: ReturnType<typeof decideScriptAction>): void {
    runToken += 1;
    status = "paused";
    // ⚠ THE REASON MUST SURVIVE THE RESULT. `toSnapshot` words the snapshot from
    // the DECIDER's tick, which knows nothing about a refusal the issue then
    // hit — so passing `result` alone would pause the run and show the cheerful
    // "Taking what's inside." that the decider had chosen. The reason is put
    // back on top, which is the whole point of pausing.
    emit(
      result !== undefined
        ? { ...toSnapshot(result, "paused", ledger.records()), why: reason, pauseReason: reason }
        : { ...last, status: "paused", why: reason, pauseReason: reason, phase: "Stopped" },
    );
  }

  async function run(): Promise<void> {
    const token = runToken;
    while (runToken === token && status === "running") {
      try {
        await tick();
      } catch (error) {
        // The backstop: tick() handles its own read/decide/issue failures, so
        // reaching here means something truly unexpected threw (a store push,
        // say). Pause with a reason rather than let `void run()` die silently.
        pauseWith(`${DECIDE_FAILED} (${String(error)})`);
        return;
      }
      if (runToken !== token || status !== "running") {
        break;
      }
      await deps.sleep(SCRIPT_CADENCE_MS);
    }
  }

  return {
    start(next: BotScript): void {
      runToken += 1;
      script = next;
      memory = initialMemory(next);
      // A fresh run id BEFORE the first emit, so every line of this run —
      // starting with its own header — is grouped under it. The header is also
      // what tells a store to rotate the previous run's log out.
      runID = newRunID(Date.now());
      loggedDecision = "";
      loggedEnd = false;
      record({ t: now(), kind: "start", run: runID, script: next.name, status: "running" });
      settle = 0;
      readFailures = 0;
      lastObs = null;
      // A new run does not inherit the last one's grudges.
      ledger = createRefusalLedger();
      status = "running";
      emit({ status: "running", phase: "Starting", why: null, stepPath: null, interruptID: null, pauseReason: null, note: null, refusals: [] });
    },
    pause(): void {
      if (status === "running") {
        runToken += 1;
        status = "paused";
        emit({ ...last, status: "paused" });
      }
    },
    resume(): void {
      if (status === "paused") {
        runToken += 1;
        status = "running";
        emit({ ...last, status: "running" });
      }
    },
    stop(): void {
      runToken += 1;
      status = "stopped";
      emit({ ...last, status: "stopped" });
    },
    tick,
    run,
    snapshot(): ScriptRunnerSnapshot {
      return last;
    },
    getStatus(): ScriptRunnerStatus {
      return status;
    },
  };
}

function toSnapshot(
  result: ReturnType<typeof decideScriptAction>,
  status: ScriptRunnerStatus,
  refusals: readonly RefusalRecord[] = [],
): ScriptRunnerSnapshot {
  return {
    status,
    phase: result.phase,
    why: result.why,
    stepPath: result.stepPath,
    interruptID: result.interruptID,
    pauseReason: result.pauseReason,
    note: describeBoard(result.memory.board),
    refusals,
  };
}
