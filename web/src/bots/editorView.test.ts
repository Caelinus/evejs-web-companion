import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProblemIndex,
  filterMacroPicker,
  findSelectedNode,
  flattenProgram,
  pathHasBlockingProblem,
  problemsForPath,
} from "./editorView.ts";
import type { BranchBlock, LoopBlock, MacroStep, ProgramNode, SubBotNode } from "./botScript.ts";
import type { ScriptProblem } from "./validateScript.ts";
import { MACRO_CATALOG_LIST } from "./macroCatalogView.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────
//
// Minimal but real shapes — real MacroIDs and condition kinds, so a fixture
// doubles as a smoke test that `stepSentence`/`branchSentence`/`repeatSentence`
// don't throw on the args editorView actually hands them.

function step(id: string, macro: MacroStep["macro"] = "undock"): MacroStep {
  return { id, kind: "macro", macro, args: {} };
}

function branch(id: string, then: readonly MacroStep[], elseSteps: readonly MacroStep[]): BranchBlock {
  return {
    id,
    kind: "branch",
    when: { kind: "shield-below", fraction: 0.3 },
    then,
    else: elseSteps,
  };
}

function loop(id: string, body: LoopBlock["body"]): LoopBlock {
  return { id, kind: "loop", repeat: { kind: "forever" }, body };
}

function subBot(id: string, name: string | null = "Mining day"): SubBotNode {
  return { id, kind: "sub-bot", scriptID: null, name };
}

// ─── 1. flattenProgram ───────────────────────────────────────────────────────

test("only top-level rows are numbered", () => {
  const program: readonly ProgramNode[] = [
    step("s1"),
    branch("b1", [step("s2")], [step("s3")]),
    step("s4"),
  ];
  const rows = flattenProgram(program);
  const numbers = rows.map((r) => r.number);
  // s1=1, b1 header=2, s2 (then, unnumbered)=null, s3 (else, unnumbered)=null, s4=3
  assert.deepEqual(numbers, [1, 2, null, null, 3]);
});

test("a branch's two sides are distinguishable and labelled", () => {
  const program: readonly ProgramNode[] = [branch("b1", [step("s2")], [step("s3")])];
  const rows = flattenProgram(program);
  const thenRow = rows.find((r) => r.nodeId === "s2");
  const elseRow = rows.find((r) => r.nodeId === "s3");
  assert.equal(thenRow?.branchSide, "then");
  assert.equal(elseRow?.branchSide, "else");
  const headerRow = rows.find((r) => r.nodeId === "b1");
  assert.equal(headerRow?.branchSide, null);
});

test("an empty branch side contributes no rows of its own", () => {
  const program: readonly ProgramNode[] = [branch("b1", [step("s2")], [])];
  const rows = flattenProgram(program);
  assert.deepEqual(
    rows.map((r) => r.nodeId),
    ["b1", "s2"],
  );
});

test("a loop's body rows appear in order, indented and unnumbered", () => {
  const program: readonly ProgramNode[] = [loop("l1", [step("s1"), step("s2")])];
  const rows = flattenProgram(program);
  assert.deepEqual(
    rows.map((r) => [r.nodeId, r.number, r.depth]),
    [
      ["l1", 1, 0],
      ["s1", null, 1],
      ["s2", null, 1],
    ],
  );
});

test("a branch nested inside a loop body nests one level deeper still", () => {
  const program: readonly ProgramNode[] = [loop("l1", [branch("b1", [step("s1")], [step("s2")])])];
  const rows = flattenProgram(program);
  assert.deepEqual(
    rows.map((r) => [r.nodeId, r.depth, r.branchSide]),
    [
      ["l1", 0, null],
      ["b1", 1, null],
      ["s1", 2, "then"],
      ["s2", 2, "else"],
    ],
  );
});

test("a sub-bot row reads its saved-bot sentence", () => {
  const program: readonly ProgramNode[] = [subBot("sb1", "Mining day")];
  const rows = flattenProgram(program);
  assert.equal(rows[0]?.kind, "sub-bot");
  assert.match(rows[0]?.sentence ?? "", /Mining day/);
});

// ─── 2. problem index ────────────────────────────────────────────────────────

function problem(path: string, severity: ScriptProblem["severity"], sentence = "A problem."): ScriptProblem {
  return { path, sentence, severity };
}

test("the problem index finds a row's problems by path", () => {
  const index = buildProblemIndex([problem("s1", "blocking"), problem("s1", "advisory"), problem("s2", "advisory")]);
  assert.equal(problemsForPath(index, "s1").length, 2);
  assert.equal(problemsForPath(index, "s2").length, 1);
  assert.deepEqual(problemsForPath(index, "unknown"), []);
});

test("blocking and advisory problems are kept distinguishable per row", () => {
  const index = buildProblemIndex([problem("s1", "advisory")]);
  assert.equal(pathHasBlockingProblem(index, "s1"), false);
  const index2 = buildProblemIndex([problem("s1", "advisory"), problem("s1", "blocking")]);
  assert.equal(pathHasBlockingProblem(index2, "s1"), true);
});

test("a document with only advisories does NOT report as blocking", () => {
  const index = buildProblemIndex([problem("s1", "advisory"), problem("l1", "advisory")]);
  assert.equal(index.hasBlocking, false);
});

test("a single blocking problem anywhere makes the whole document report as blocking", () => {
  const index = buildProblemIndex([problem("s1", "advisory"), problem("s2", "blocking")]);
  assert.equal(index.hasBlocking, true);
});

test("no problems at all is not blocking", () => {
  const index = buildProblemIndex([]);
  assert.equal(index.hasBlocking, false);
  assert.deepEqual(index.byPath.size, 0);
});

// ─── 3. picker filtering ─────────────────────────────────────────────────────

test("an empty query returns the whole catalogue", () => {
  assert.equal(filterMacroPicker("", null).length, MACRO_CATALOG_LIST.length);
  assert.equal(filterMacroPicker("   ", null).length, MACRO_CATALOG_LIST.length);
});

test("search matches on the macro's name", () => {
  const results = filterMacroPicker("mine at a belt", null);
  assert.ok(results.some((e) => e.id === "mine-at-belt"));
});

test("search matches on the macro's 'does' text", () => {
  // "mine-at-belt" does text mentions "locks rocks" — not in its name.
  const results = filterMacroPicker("locks rocks", null);
  assert.ok(results.some((e) => e.id === "mine-at-belt"));
});

test("search matches on the category label", () => {
  const results = filterMacroPicker("cargo & hauling", null);
  assert.ok(results.length > 0);
  assert.ok(results.every((e) => e.category === "hauling"));
});

test("search is case-insensitive", () => {
  const lower = filterMacroPicker("mine at a belt", null);
  const upper = filterMacroPicker("MINE AT A BELT", null);
  assert.deepEqual(lower.map((e) => e.id), upper.map((e) => e.id));
});

test("a category filter composes with a search query", () => {
  // "belt" appears in several movement/mining entries; narrowing to "mining"
  // must return a strict subset of the unfiltered search.
  const unfiltered = filterMacroPicker("belt", null);
  const filtered = filterMacroPicker("belt", "mining");
  assert.ok(filtered.length > 0);
  assert.ok(filtered.length <= unfiltered.length);
  assert.ok(filtered.every((e) => e.category === "mining"));
});

test("a category filter alone (empty query) narrows to just that category", () => {
  const results = filterMacroPicker("", "combat");
  assert.ok(results.length > 0);
  assert.ok(results.every((e) => e.category === "combat"));
});

test("a query matching nothing in the given category returns empty, not a fallback", () => {
  const results = filterMacroPicker("refine the ore", "combat");
  assert.deepEqual(results, []);
});

// ─── 4. selection resolution ─────────────────────────────────────────────────

test("selection resolves a top-level step", () => {
  const program: readonly ProgramNode[] = [step("s1")];
  const found = findSelectedNode(program, "s1");
  assert.equal(found?.node.id, "s1");
  assert.equal(found?.branchSide, null);
  assert.equal(found?.inLoop, false);
});

test("selection resolves a node inside a top-level branch side", () => {
  const program: readonly ProgramNode[] = [branch("b1", [step("s1")], [step("s2")])];
  const thenFound = findSelectedNode(program, "s1");
  assert.equal(thenFound?.branchSide, "then");
  assert.equal(thenFound?.inLoop, false);
  const elseFound = findSelectedNode(program, "s2");
  assert.equal(elseFound?.branchSide, "else");
});

test("selection resolves a node inside a loop body", () => {
  const program: readonly ProgramNode[] = [loop("l1", [step("s1")])];
  const found = findSelectedNode(program, "s1");
  assert.equal(found?.node.id, "s1");
  assert.equal(found?.inLoop, true);
  assert.equal(found?.branchSide, null);
});

test("selection resolves a node inside a branch that itself sits inside a loop body", () => {
  const program: readonly ProgramNode[] = [loop("l1", [branch("b1", [step("s1")], [step("s2")])])];
  const found = findSelectedNode(program, "s1");
  assert.equal(found?.inLoop, true);
  assert.equal(found?.branchSide, "then");
  const foundElse = findSelectedNode(program, "s2");
  assert.equal(foundElse?.inLoop, true);
  assert.equal(foundElse?.branchSide, "else");
});

test("an id that does not exist resolves to null rather than throwing", () => {
  const program: readonly ProgramNode[] = [step("s1"), loop("l1", [step("s2")])];
  assert.equal(findSelectedNode(program, "nope"), null);
});
