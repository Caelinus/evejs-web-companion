// A1 — the Bot Builder format. These tests guard the SHAPE and the structural
// helpers, and they pin the operator's decisions into the type layer so a later
// change that quietly drops one fails here:
//
//   • a loop repeats a bounded count OR forever (decision 1);
//   • a belt is a runtime "nearest" binding or a chosen one (decision 2);
//   • a hostile interrupt can answer with drones or with a run (decision 5).
//
// (Decision 3 — a non-deletable, auto-injected safety-floor interrupt — was
// reversed on 2026-07-23: watches are entirely the player's now.)
//
// There is no runtime behaviour to test yet — the codec (A2) and the decide
// function (A4) come next. What is testable is that the golden document is
// well-formed under the types, and that every helper reads it correctly.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ORE_HOLD_FRACTION,
  MAX_REPEAT_TIMES,
  SCRIPT_FORMAT,
  SCRIPT_VERSION,
  conditionAllowedAt,
  conditionSites,
  countSteps,
  findStep,
  isLoop,
  isMacroStep,
  repeatCountInRange,
  type BotScript,
  type InterruptRow,
  type LoopBlock,
  type MacroStep,
} from "./botScript.ts";

// ─── The golden document ─────────────────────────────────────────────────────
// "Belt runner" — the example from the design doc §6 and the UI mockup. A loop
// of [mine until nearly full, haul home], guarded by the safety floor and a
// shields interrupt.

function beltRunner(): BotScript {
  return {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: "Belt runner",
    notes: "Mines until 90% then hauls.",
    home: { entity: "station", id: 60000004, name: "Home Station", systemName: "Aunia" },
    interrupts: [
      {
        id: "i0",
        when: { kind: "health-below", fraction: 0.5 },
        respond: "dock-and-pause",
      },
      {
        id: "i1",
        when: { kind: "shield-below", fraction: 0.3 },
        respond: "dock-and-pause",
      },
    ],
    program: [
      {
        id: "s1",
        kind: "loop",
        repeat: { kind: "times", count: 50 },
        body: [
          {
            id: "s2",
            kind: "macro",
            macro: "mine-at-belt",
            args: {
              belt: { kind: "belt", belt: { mode: "nearest" } },
              equipment: { kind: "equipment", equipment: { groupID: 17482, label: "Strip Miners" } },
            },
            until: { kind: "ore-hold-at-least", fraction: 0.9 },
          },
          {
            id: "s3",
            kind: "macro",
            macro: "deliver-ore",
            args: {
              station: {
                kind: "station",
                ref: { entity: "station", id: 60000004, name: "Home Station", systemName: "Aunia" },
              },
            },
          },
        ],
      },
    ],
  };
}

test("golden document carries the format identity", () => {
  const s = beltRunner();
  assert.equal(s.format, "evejs-bot-script");
  assert.equal(s.version, 1);
  assert.equal(s.home.entity, "station");
});

test("countSteps counts loop bodies, not nodes", () => {
  const s = beltRunner();
  assert.equal(s.program.length, 1, "one top-level node (the loop)");
  assert.equal(countSteps(s.program), 2, "two macro steps inside it");
});

test("findStep reaches a step inside a loop body", () => {
  const s = beltRunner();
  const mine = findStep(s, "s2");
  assert.ok(mine, "s2 is inside the loop and must be found");
  assert.equal(mine.macro, "mine-at-belt");
  assert.equal(findStep(s, "nope"), null);
});

test("the mine step is bound to the nearest belt (decision 2 groundwork)", () => {
  const mine = findStep(beltRunner(), "s2");
  assert.ok(mine);
  const belt = mine.args["belt"];
  assert.ok(belt && belt.kind === "belt");
  assert.equal(belt.belt.mode, "nearest");
});

test("node guards discriminate loop from macro", () => {
  const loop = beltRunner().program[0];
  assert.ok(loop);
  assert.ok(isLoop(loop));
  assert.equal(isMacroStep(loop), false);
  const body = (loop as LoopBlock).body[0];
  assert.ok(body);
  assert.ok(isMacroStep(body));
});

test("a loop may repeat forever (decision 1)", () => {
  const forever: LoopBlock = {
    id: "s1",
    kind: "loop",
    repeat: { kind: "forever" },
    body: [
      {
        id: "s2",
        kind: "macro",
        macro: "mine-at-belt",
        args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
        until: { kind: "ore-hold-at-least", fraction: 0.9 },
      },
    ],
  };
  assert.ok(repeatCountInRange(forever.repeat), "forever is always in range");
});

test("repeatCountInRange bounds a times count", () => {
  assert.ok(repeatCountInRange({ kind: "times", count: 1 }));
  assert.ok(repeatCountInRange({ kind: "times", count: MAX_REPEAT_TIMES }));
  assert.equal(repeatCountInRange({ kind: "times", count: 0 }), false);
  assert.equal(repeatCountInRange({ kind: "times", count: MAX_REPEAT_TIMES + 1 }), false);
  assert.equal(repeatCountInRange({ kind: "times", count: 2.5 }), false);
});

test("a hostile interrupt can answer with drones or a run (decision 5)", () => {
  const drones: InterruptRow = {
    id: "i2",
    when: { kind: "hostile-on-grid" },
    respond: "launch-drones",
  };
  const run: InterruptRow = {
    id: "i3",
    when: { kind: "hostile-on-grid" },
    respond: "dock-and-pause",
  };
  assert.equal(drones.respond, "launch-drones");
  assert.equal(run.respond, "dock-and-pause");
});

test("hostile-on-grid is interrupt-only; own-ship reads work at both sites", () => {
  // The structural guard on the belt-empty class: a grid read must not sit in an
  // `until`, where it would read false mid-warp and pass trivially.
  assert.deepEqual(conditionSites("hostile-on-grid"), ["interrupt"]);
  assert.equal(conditionAllowedAt("hostile-on-grid", "until"), false);
  assert.equal(conditionAllowedAt("hostile-on-grid", "interrupt"), true);

  assert.deepEqual(conditionSites("ore-hold-at-least"), ["until", "interrupt"]);
  assert.ok(conditionAllowedAt("shield-below", "until"));
  assert.ok(conditionAllowedAt("shield-below", "interrupt"));
});

test("the ore-hold ceiling stays at 0.9 (the mixed-hold trap stays shut)", () => {
  assert.equal(MAX_ORE_HOLD_FRACTION, 0.9);
});
