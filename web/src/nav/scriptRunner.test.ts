// B2 — the runner controller, driven with fake deps so the lifecycle is tested
// without a live ship: selective settle ticks, pause/stop staleness,
// session-loss unwind, the read-failure give-up, and a clean finish.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, MacroStep, ProgramNode } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import { MAX_CONSECUTIVE_REFUSALS } from "./refusalLedger.ts";
import type {
  HomeTravelDecider,
  MacroDecider,
  MacroRegistry,
  MacroTick,
  ScriptAction,
} from "./scriptDecide.ts";
import {
  MAX_READ_FAILURES,
  SETTLE_TICKS,
  createScriptRunner,
  type ScriptRunnerSnapshot,
} from "./scriptRunner.ts";

class SessionLost extends Error {}

function calm(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    ...over,
  };
}

function mt(action: ScriptAction, outcome: MacroTick["outcome"]): MacroTick {
  return { action, why: "why", phase: "phase", armed: true, outcome, nextMem: {} };
}

const undock: MacroDecider = (_s, o) =>
  o.inSpace ? mt({ kind: "wait" }, { kind: "done" }) : mt({ kind: "undock" }, { kind: "acting" });
const deliver: MacroDecider = (_s, o) =>
  o.holdEmpty ? mt({ kind: "wait" }, { kind: "done" }) : mt({ kind: "unloadOre", itemIDs: [1] }, { kind: "acting" });
const home: HomeTravelDecider = (o) =>
  o.docked ? mt({ kind: "wait" }, { kind: "done" }) : mt({ kind: "warp", targetID: 9 }, { kind: "acting" });

const registry = { undock, "deliver-ore": deliver };

function macroStep(id: string, macro: MacroStep["macro"]): MacroStep {
  return { id, kind: "macro", macro, args: {} };
}
function script(program: readonly ProgramNode[]): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null },
    interrupts: [{ id: "floor", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" }],
    program,
  };
}

interface Harness {
  observeThrows?: () => never;
  registry?: MacroRegistry;
  /** Throw from `issue` — the refusal path. Return null to let the call pass. */
  issueThrows?: (action: ScriptAction) => unknown | null;
}

function harness(opts: Harness = {}) {
  const issued: ScriptAction[] = [];
  const progress: ScriptRunnerSnapshot[] = [];
  let obs = calm();
  const runner = createScriptRunner({
    observe: async () => {
      if (opts.observeThrows) {
        opts.observeThrows();
      }
      return obs;
    },
    issue: async (a) => {
      issued.push(a);
      const thrown = opts.issueThrows?.(a) ?? null;
      if (thrown !== null) {
        throw thrown;
      }
    },
    sleep: async () => {},
    onProgress: (s) => progress.push(s),
    isSessionLost: (e) => e instanceof SessionLost,
    refusalReason: (e) => (e instanceof Error ? e.message : String(e)),
    registry: opts.registry ?? registry,
    travelHome: home,
  });
  return { runner, issued, progress, setObs: (o: ScriptObservation) => { obs = o; } };
}

// ── The refusal ledger ──────────────────────────────────────────────────────
//
// THE TEST THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. A bot answered 227
// consecutive refusals over twelve hours because the runner dropped every one
// of them: no count, no readout, no bound, and the same settle as a success.

/** Drive `count` decide-and-issue ticks, skipping whatever settle is imposed. */
async function issueTicks(h: ReturnType<typeof harness>, count: number): Promise<void> {
  let guard = 0;
  while (h.issued.length < count && guard < 500) {
    guard += 1;
    await h.runner.tick();
    if (h.runner.getStatus() !== "running") {
      return;
    }
  }
}

test("a refused call is COUNTED and shows up in the readout", async () => {
  const h = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));

  await issueTicks(h, 2);

  const latest = h.progress[h.progress.length - 1]!;
  assert.equal(latest.refusals.length, 1, "the run says what it is being refused");
  assert.equal(latest.refusals[0]?.count, 2);
  assert.match(latest.refusals[0]!.words, /room/i, "in player language, not a code");
  assert.equal(/NotEnoughCargoSpace/.test(latest.refusals[0]!.words), false);
});

test("a refused call BACKS OFF — it does not retry at the same speed as a success", async () => {
  const refused = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  refused.setObs(calm({ holdEmpty: false }));
  refused.runner.start(script([macroStep("a", "deliver-ore")]));

  // Ticks spent to get from the first issue to the second.
  await issueTicks(refused, 1);
  let ticksBetween = 0;
  while (refused.issued.length < 2 && ticksBetween < 100) {
    ticksBetween += 1;
    await refused.runner.tick();
  }
  assert.ok(
    ticksBetween > SETTLE_TICKS,
    `a refusal waits longer than the ordinary settle (waited ${ticksBetween})`,
  );
});

test("a run being refused over and over STOPS, in the server's own words", async () => {
  const h = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));

  let guard = 0;
  while (h.runner.getStatus() === "running" && guard < 2_000) {
    guard += 1;
    await h.runner.tick();
  }

  assert.equal(h.runner.getStatus(), "paused", "it stopped rather than asking forever");
  const latest = h.progress[h.progress.length - 1]!;
  assert.match(latest.pauseReason ?? "", /refusals in a row/);
  assert.match(latest.pauseReason ?? "", /room/i, "and says WHAT was refused");
  assert.ok(
    h.issued.length <= MAX_CONSECUTIVE_REFUSALS,
    `it gave up after ${h.issued.length} attempts, not 227`,
  );
});

test("the pause reason survives the decider's cheerful why", async () => {
  // The decider's tick knows nothing about a refusal the issue then hit, so a
  // snapshot built from it alone would pause the run and still show "why".
  const h = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));
  let guard = 0;
  while (h.runner.getStatus() === "running" && guard < 2_000) {
    guard += 1;
    await h.runner.tick();
  }
  const latest = h.progress[h.progress.length - 1]!;
  assert.notEqual(latest.why, "why", "the decider's wording must not survive a refusal pause");
  assert.equal(latest.why, latest.pauseReason);
});

test("a call that succeeds ENDS the streak, so an old blip cannot stop the run later", async () => {
  let failNext = true;
  const h = harness({
    issueThrows: () => (failNext ? new Error("CALL_REFUSED: NotEnoughCargoSpace") : null),
  });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));

  await issueTicks(h, 1);
  assert.equal(h.progress[h.progress.length - 1]!.refusals.length, 1);

  failNext = false;
  await issueTicks(h, 2);
  assert.deepEqual(
    h.progress[h.progress.length - 1]!.refusals,
    [],
    "one success clears it",
  );
});

test("a fresh run does not inherit the last one's refusals", async () => {
  const h = harness({ issueThrows: () => new Error("CALL_REFUSED: NotEnoughCargoSpace") });
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));
  await issueTicks(h, 3);
  assert.ok(h.progress[h.progress.length - 1]!.refusals[0]!.count >= 3);

  h.runner.start(script([macroStep("a", "deliver-ore")]));
  assert.deepEqual(h.progress[h.progress.length - 1]!.refusals, []);
});

test("ordinary writes still settle before deciding again", async () => {
  const h = harness();
  h.setObs(calm({ holdEmpty: false }));
  h.runner.start(script([macroStep("a", "deliver-ore")]));

  await h.runner.tick();
  assert.deepEqual(h.issued.map((a) => a.kind), ["unloadOre"]);

  // The next SETTLE_TICKS ticks issue nothing.
  for (let i = 0; i < SETTLE_TICKS; i += 1) {
    await h.runner.tick();
  }
  assert.equal(h.issued.length, 1, "no world call during the settle window");

  // The write has now landed; the next decision can observe completion.
  h.setObs(calm({ holdEmpty: true }));
  await h.runner.tick();
  assert.deepEqual(h.issued.map((a) => a.kind), ["unloadOre"]);
  assert.equal(h.runner.getStatus(), "stopped");
});

const READY_RETURNING_SESSION_ACTIONS: readonly ScriptAction[] = [
  { kind: "undock" },
  { kind: "dock", stationID: 60003760 },
  { kind: "jump", fromGateID: 50000802, toGateID: 50001248 },
  { kind: "boardShip", shipID: 9001 },
];

for (const sessionAction of READY_RETURNING_SESSION_ACTIONS) {
  test(`ready-returning ${sessionAction.kind} immediately advances without duplicating the call`, async () => {
    const sessionChange: MacroDecider = (_step, observation) =>
      observation.inSpace
        ? mt({ kind: "wait" }, { kind: "done" })
        : mt(sessionAction, { kind: "acting" });
    const h = harness({
      registry: { undock: sessionChange, "deliver-ore": deliver },
    });
    h.setObs(calm({ inSpace: false, holdEmpty: false }));
    h.runner.start(script([
      macroStep("session", "undock"),
      macroStep("next", "deliver-ore"),
    ]));

    await h.runner.tick();
    assert.deepEqual(h.issued.map((action) => action.kind), [sessionAction.kind]);

    // The BFF promise has returned with authoritative ready state. The next
    // tick advances straight to the following decision—no fixed settle ticks.
    h.setObs(calm({ inSpace: true, holdEmpty: false }));
    await h.runner.tick();
    assert.deepEqual(
      h.issued.map((action) => action.kind),
      [sessionAction.kind, "unloadOre"],
    );
    assert.equal(
      h.issued.filter((action) => action.kind === sessionAction.kind).length,
      1,
      "the completed session change is not re-issued",
    );
  });
}

test("pause stops the loop and blocks further ticks", async () => {
  const h = harness();
  h.setObs(calm({ inSpace: false, holdEmpty: false }));
  h.runner.start(script([macroStep("a", "undock")]));
  await h.runner.tick();
  const before = h.issued.length;

  h.runner.pause();
  assert.equal(h.runner.getStatus(), "paused");
  await h.runner.tick(); // must do nothing
  assert.equal(h.issued.length, before);
});

test("a lost session ends the run in error", async () => {
  const h = harness({ observeThrows: () => { throw new SessionLost("gone"); } });
  h.runner.start(script([macroStep("a", "undock")]));
  await h.runner.tick();
  assert.equal(h.runner.getStatus(), "error");
  assert.equal(h.progress.at(-1)?.status, "error");
});

test("repeated read failures give up with a plain reason", async () => {
  let fail = true;
  const issued: ScriptAction[] = [];
  const progress: ScriptRunnerSnapshot[] = [];
  const runner = createScriptRunner({
    observe: async () => {
      if (fail) {
        throw new Error("read failed"); // not a session loss
      }
      return calm();
    },
    issue: async (a) => { issued.push(a); },
    refusalReason: (e) => (e instanceof Error ? e.message : String(e)),
    sleep: async () => {},
    onProgress: (s) => progress.push(s),
    isSessionLost: (e) => e instanceof SessionLost,
    registry,
    travelHome: home,
  });
  runner.start(script([macroStep("a", "undock")]));
  for (let i = 0; i < MAX_READ_FAILURES; i += 1) {
    await runner.tick();
  }
  assert.equal(runner.getStatus(), "paused");
  assert.match(progress.at(-1)?.pauseReason ?? "", /several tries/i);
});

test("run() drives to a clean finish and stops", async () => {
  const h = harness();
  h.setObs(calm({ inSpace: true })); // undock already satisfied -> program done at once
  h.runner.start(script([macroStep("a", "undock")]));
  await h.runner.run();
  assert.equal(h.runner.getStatus(), "stopped");
  assert.equal(h.progress.at(-1)?.status, "stopped");
});
