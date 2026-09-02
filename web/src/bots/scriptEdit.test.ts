// C (pure part) — the editor operations. The two that matter most for safety:
// the safety floor cannot be deleted, and a loop cannot be emptied into a no-op.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, BranchBlock, InterruptRow, LoopBlock, MacroStep, ProgramNode } from "./botScript.ts";
import {
  addInterrupt,
  duplicateNode,
  insertIntoLoop,
  insertNode,
  insertSavedBotSteps,
  moveInLoop,
  moveNode,
  newInterrupt,
  newLoop,
  newMacroStep,
  removeFromLoop,
  removeInterrupt,
  removeNode,
  setInterruptFraction,
  type FlatProgramNode,
} from "./scriptEdit.ts";

// A deterministic id generator for tests.
function counter(): () => string {
  let n = 0;
  return () => `id${(n += 1)}`;
}

const floor: InterruptRow = {
  id: "floor", builtIn: "safety-floor",
  when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause",
};

function ids(program: readonly ProgramNode[]): string[] {
  return program.map((n) => n.id);
}

test("newMacroStep and newLoop produce well-formed, bounded pieces", () => {
  const make = counter();
  const step = newMacroStep("undock", make);
  assert.equal(step.kind, "macro");
  assert.equal(step.macro, "undock");
  const loop = newLoop(step, make);
  assert.equal(loop.kind, "loop");
  assert.equal(loop.repeat.kind, "times", "a new loop is bounded, never forever by default");
  assert.equal(loop.body.length, 1);
});

test("insert, remove, and move reorder the top level without mutating the input", () => {
  const make = counter();
  const a = newMacroStep("undock", make);
  const b = newMacroStep("deliver-ore", make);
  const program: readonly ProgramNode[] = [a];

  const withB = insertNode(program, b);
  assert.deepEqual(ids(withB), [a.id, b.id]);
  assert.deepEqual(ids(program), [a.id], "input unchanged");

  assert.deepEqual(ids(moveNode(withB, 0, 1)), [b.id, a.id]);
  assert.deepEqual(ids(moveNode(withB, 0, -1)), [a.id, b.id], "move up at the top edge is a no-op");
  assert.deepEqual(ids(removeNode(withB, 0)), [b.id]);
});

test("duplicate deep-copies with fresh ids, including a loop's body", () => {
  const make = counter();
  const inner = newMacroStep("mine-at-belt", make);
  const loop = newLoop(inner, make);
  const program: readonly ProgramNode[] = [loop];

  const dup = duplicateNode(program, 0, make);
  assert.equal(dup.length, 2);
  const copy = dup[1] as LoopBlock;
  assert.notEqual(copy.id, loop.id, "the loop copy has a fresh id");
  const copied = copy.body[0];
  assert.notEqual(copied?.id, inner.id, "the body step copy has a fresh id too");
  assert.ok(copied && copied.kind === "macro");
  assert.equal(copied.macro, "mine-at-belt", "contents are preserved");
});

test("duplicate deep-copies with fresh ids, including a nested branch's both sides", () => {
  // Regression: cloneWithFreshIds used to re-id only a node and, for a loop,
  // its direct body elements — it never descended into a BranchBlock's
  // then/else, so duplicating a node containing a branch produced colliding
  // step ids. This pins the fix (mirrors subBots.ts's recursive re-idder).
  const make = counter();
  const thenStep = newMacroStep("repair-ship", make);
  const elseStep = newMacroStep("wait", make);
  const branch: BranchBlock = {
    id: "branch1",
    kind: "branch",
    when: { kind: "shield-below", fraction: 0.3 },
    then: [thenStep],
    else: [elseStep],
  };
  const program: readonly ProgramNode[] = [branch];

  const dup = duplicateNode(program, 0, make);
  assert.equal(dup.length, 2);
  const copy = dup[1] as BranchBlock;
  assert.notEqual(copy.id, branch.id, "the branch copy has a fresh id");
  assert.notEqual(copy.then[0]?.id, thenStep.id, "the then-side step copy has a fresh id");
  assert.notEqual(copy.else[0]?.id, elseStep.id, "the else-side step copy has a fresh id");

  const allIDs = [
    branch.id,
    thenStep.id,
    elseStep.id,
    copy.id,
    copy.then[0]?.id,
    copy.else[0]?.id,
  ];
  assert.equal(new Set(allIDs).size, allIDs.length, "every id across original and copy is unique");
});

test("duplicating a loop whose body holds a branch keeps every id unique", () => {
  const make = counter();
  const thenStep = newMacroStep("repair-ship", make);
  const elseStep = newMacroStep("wait", make);
  const branch: BranchBlock = {
    id: "branch1",
    kind: "branch",
    when: { kind: "shield-below", fraction: 0.3 },
    then: [thenStep],
    else: [elseStep],
  };
  const loop: LoopBlock = { id: "loop1", kind: "loop", repeat: { kind: "times", count: 3 }, body: [branch] };
  const program: readonly ProgramNode[] = [loop];

  const dup = duplicateNode(program, 0, make);
  const copy = dup[1] as LoopBlock;
  const copiedBranch = copy.body[0] as BranchBlock;
  assert.notEqual(copiedBranch.id, branch.id);
  assert.notEqual(copiedBranch.then[0]?.id, thenStep.id);
  assert.notEqual(copiedBranch.else[0]?.id, elseStep.id);

  const allIDs = [
    loop.id,
    branch.id,
    thenStep.id,
    elseStep.id,
    copy.id,
    copiedBranch.id,
    copiedBranch.then[0]?.id,
    copiedBranch.else[0]?.id,
  ];
  assert.equal(new Set(allIDs).size, allIDs.length, "no id collides anywhere in original or copy");
});

test("loop-body edits work, and emptying a loop removes it", () => {
  const make = counter();
  const s1 = newMacroStep("mine-at-belt", make);
  const s2 = newMacroStep("deliver-ore", make);
  const loop: LoopBlock = { id: "L", kind: "loop", repeat: { kind: "times", count: 2 }, body: [s1, s2] };
  const program: readonly ProgramNode[] = [loop];

  const moved = moveInLoop(program, 0, 0, 1);
  assert.deepEqual((moved[0] as LoopBlock).body.map((s) => s.id), [s2.id, s1.id]);

  const s3 = newMacroStep("undock", make);
  const inserted = insertIntoLoop(program, 0, s3, 0);
  assert.deepEqual((inserted[0] as LoopBlock).body.map((s) => s.id), [s3.id, s1.id, s2.id]);

  const afterOne = removeFromLoop(program, 0, 0);
  assert.equal((afterOne[0] as LoopBlock).body.length, 1);
  const afterBoth = removeFromLoop(afterOne, 0, 0);
  assert.equal(afterBoth.length, 0, "removing the loop's last step removes the loop");
});

test("the safety floor cannot be deleted, but other interrupts can", () => {
  const make = counter();
  const shields = newInterrupt({ kind: "shield-below", fraction: 0.3 }, "dock-and-pause", make);
  const list = addInterrupt([floor], shields);
  assert.equal(list.length, 2);

  assert.deepEqual(removeInterrupt(list, floor.id), list, "removing the safety floor is refused");
  assert.deepEqual(removeInterrupt(list, shields.id).map((r) => r.id), [floor.id]);
});

test("setInterruptFraction edits the threshold, including on the safety floor", () => {
  const updated = setInterruptFraction([floor], floor.id, 0.35);
  const row = updated[0];
  assert.ok(row && row.when.kind === "health-below");
  assert.equal(row.when.fraction, 0.35);
});

test("out-of-range indices are no-ops, not crashes", () => {
  const make = counter();
  const a = newMacroStep("undock", make);
  const program: readonly ProgramNode[] = [a];
  assert.deepEqual(ids(removeNode(program, 5)), [a.id]);
  assert.deepEqual(ids(moveNode(program, 5, 1)), [a.id]);
  assert.deepEqual(ids(duplicateNode(program, 5, make)), [a.id]);
});

// ─── insertSavedBotSteps ─────────────────────────────────────────────────────

function sourceScript(program: readonly ProgramNode[], name = "Saved bot"): BotScript {
  return {
    format: "evejs-bot-script",
    version: 1,
    name,
    notes: "",
    home: { entity: "station", id: null, name: null, systemName: null, starting: true },
    interrupts: [],
    program,
  };
}

test("insertSavedBotSteps appends copies of a source bot's steps with fresh ids", () => {
  const make = counter();
  const target: readonly FlatProgramNode[] = [{ id: "s1", kind: "macro", macro: "undock", args: {} }];
  const source = sourceScript([
    { id: "s1", kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "nearest" } } }, until: { kind: "ore-hold-at-least", fraction: 0.9 } },
    { id: "s2", kind: "macro", macro: "deliver-ore", args: {} },
  ]);

  const result = insertSavedBotSteps(target, source, make);
  assert.equal(result.left.length, 0, "nothing needed to be left out");
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[0]?.id, "s1", "the target's own step is untouched");
  const [, copy1, copy2] = result.steps;
  assert.ok(copy1 && copy2);
  // Fresh ids that collide with neither the target's existing "s1" nor the
  // source's own "s1"/"s2".
  assert.notEqual(copy1.id, "s1");
  assert.notEqual(copy2.id, "s2");
  assert.notEqual(copy1.id, copy2.id);
  assert.ok(copy1.kind === "macro" && copy1.macro === "mine-at-belt", "contents are preserved");
});

test("insertSavedBotSteps leaves a top-level loop out and reports it, rather than flattening it", () => {
  const make = counter();
  const loopBody: MacroStep = { id: "b1", kind: "macro", macro: "mine-at-belt", args: {}, until: { kind: "hold-empty" } };
  const source = sourceScript(
    [
      { id: "l1", kind: "loop", repeat: { kind: "times", count: 10 }, body: [loopBody] },
      { id: "s1", kind: "macro", macro: "undock", args: {} },
    ],
    "Mining loop bot",
  );

  const result = insertSavedBotSteps([], source, make);
  // The loop was not silently flattened into its bare body — it is left out...
  assert.equal(result.steps.length, 1, "only the plain top-level step was copied in");
  assert.ok(result.steps[0]?.kind === "macro" && result.steps[0].macro === "undock");
  // ...and reported in plain language so the caller can tell the player.
  assert.equal(result.left.length, 1);
  assert.match(result.left[0] ?? "", /Mining loop bot/);
  assert.match(result.left[0] ?? "", /repeats a group of steps/);
});

test("insertSavedBotSteps respects reservedIDs and never collides across many inserts", () => {
  const make = counter();
  const source = sourceScript([
    { id: "x", kind: "macro", macro: "undock", args: {} },
    { id: "y", kind: "macro", macro: "repair-ship", args: {} },
  ]);
  const reserved = new Set(["main-loop", "watch-1"]);

  const first = insertSavedBotSteps([], source, make, reserved);
  const second = insertSavedBotSteps(first.steps, source, make, reserved);

  const allIDs = [...reserved, ...second.steps.map((s) => s.id)];
  assert.equal(new Set(allIDs).size, allIDs.length, "every id, including reserved ones, is unique");
  assert.equal(second.steps.length, 4);
});

test("insertSavedBotSteps re-ids a copied branch's both sides too", () => {
  const make = counter();
  const branch: BranchBlock = {
    id: "br",
    kind: "branch",
    when: { kind: "shield-below", fraction: 0.3 },
    then: [{ id: "t1", kind: "macro", macro: "repair-ship", args: {} }],
    else: [{ id: "e1", kind: "macro", macro: "wait", args: {} }],
  };
  const source = sourceScript([branch]);

  const result = insertSavedBotSteps([], source, make);
  const copy = result.steps[0] as BranchBlock;
  assert.notEqual(copy.id, "br");
  assert.notEqual(copy.then[0]?.id, "t1");
  assert.notEqual(copy.else[0]?.id, "e1");
});
