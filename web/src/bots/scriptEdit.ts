// C (pure part) — the editor's operations on a program, as pure array transforms.
// The Svelte editor (later, live) calls these; here they are plain functions with
// a node --test file, so the reorder/insert/delete logic is proven without a DOM.
//
// ⚠ TWO STRUCTURAL RULES ARE ENFORCED HERE, NOT LEFT TO THE UI:
//   • The safety floor cannot be deleted (decision 3). `removeInterrupt` refuses
//     it, so no sequence of clicks can produce a bot with no health cut-off.
//   • A loop cannot be left with an empty body (the codec would refuse it, and an
//     empty loop is a no-op). Removing a loop's last step removes the loop.
//
// Everything is immutable: each function returns a new array, never mutating its
// input, so the editor can keep an undo/draft history cheaply.

import type {
  BotScript,
  BranchBlock,
  Condition,
  InterruptResponse,
  InterruptRow,
  LoopBlock,
  MacroID,
  LoopBodyNode,
  MacroStep,
  ProgramNode,
  SubBotNode,
} from "./botScript.ts";

/** Supplies fresh unique handles. The editor passes a real generator; tests pass a counter. */
export type IdGen = () => string;

// ─── Making new pieces ───────────────────────────────────────────────────────

/** A blank macro step — its args are filled in by the inspector before it can start. */
export function newMacroStep(macro: MacroID, makeId: IdGen): MacroStep {
  return { id: makeId(), kind: "macro", macro, args: {} };
}

/** A new loop wrapping one step, bounded (10 passes) and visible — never forever by default. */
export function newLoop(firstStep: MacroStep, makeId: IdGen): LoopBlock {
  return { id: makeId(), kind: "loop", repeat: { kind: "times", count: 10 }, body: [firstStep] };
}

/** A new "always watching" row. */
export function newInterrupt(when: Condition, respond: InterruptResponse, makeId: IdGen): InterruptRow {
  return { id: makeId(), when, respond };
}

// ─── Generic array moves (shared by top-level nodes and loop bodies) ──────────

function insertAt<T>(arr: readonly T[], item: T, at?: number): readonly T[] {
  const idx = at === undefined ? arr.length : Math.max(0, Math.min(at, arr.length));
  return [...arr.slice(0, idx), item, ...arr.slice(idx)];
}

function removeAt<T>(arr: readonly T[], index: number): readonly T[] {
  if (index < 0 || index >= arr.length) {
    return arr;
  }
  return [...arr.slice(0, index), ...arr.slice(index + 1)];
}

function moveBy<T>(arr: readonly T[], index: number, delta: number): readonly T[] {
  const target = index + delta;
  if (index < 0 || index >= arr.length || target < 0 || target >= arr.length) {
    return arr;
  }
  const copy = arr.slice();
  const a = copy[index];
  const b = copy[target];
  if (a === undefined || b === undefined) {
    return arr;
  }
  copy[index] = b;
  copy[target] = a;
  return copy;
}

// ─── Cloning with fresh ids ──────────────────────────────────────────────────
//
// ⚠ MUST DESCEND INTO A BRANCH'S then/else. A loop's body can hold a branch
// (LoopBodyNode = MacroStep | BranchBlock), and a top-level node can be a branch
// too — either one carries its own nested step ids, which need re-idding exactly
// like a loop's body does. Missing this produced colliding ids the moment a
// duplicated node contained a branch (caught by the test below); the recursive
// shape here matches subBots.ts's re-idder, which had already solved it once.

function cloneWithFreshIds(node: ProgramNode, makeId: IdGen): ProgramNode {
  const cloned = structuredClone(node) as ProgramNode;
  if (cloned.kind === "loop") {
    return {
      ...cloned,
      id: makeId(),
      body: cloned.body.map((element) => cloneLoopBodyWithFreshIds(element, makeId)),
    };
  }
  if (cloned.kind === "branch") {
    return cloneBranchWithFreshIds(cloned, makeId);
  }
  return { ...cloned, id: makeId() };
}

function cloneLoopBodyWithFreshIds(node: LoopBodyNode, makeId: IdGen): LoopBodyNode {
  return node.kind === "branch" ? cloneBranchWithFreshIds(node, makeId) : { ...node, id: makeId() };
}

function cloneBranchWithFreshIds(branch: BranchBlock, makeId: IdGen): BranchBlock {
  return {
    ...branch,
    id: makeId(),
    then: branch.then.map((step) => ({ ...step, id: makeId() })),
    else: branch.else.map((step) => ({ ...step, id: makeId() })),
  };
}

// ─── Top-level program operations ────────────────────────────────────────────

export function insertNode(program: readonly ProgramNode[], node: ProgramNode, at?: number): readonly ProgramNode[] {
  return insertAt(program, node, at);
}

export function removeNode(program: readonly ProgramNode[], index: number): readonly ProgramNode[] {
  return removeAt(program, index);
}

/** Move a node up (delta -1) or down (delta +1); a no-op at the edges. */
export function moveNode(program: readonly ProgramNode[], index: number, delta: number): readonly ProgramNode[] {
  return moveBy(program, index, delta);
}

/** Duplicate a node (deep, with fresh ids) directly after it. */
export function duplicateNode(program: readonly ProgramNode[], index: number, makeId: IdGen): readonly ProgramNode[] {
  const node = program[index];
  if (node === undefined) {
    return program;
  }
  return insertAt(program, cloneWithFreshIds(node, makeId), index + 1);
}

// ─── Loop body operations ────────────────────────────────────────────────────

function withLoopBody(
  program: readonly ProgramNode[],
  loopIndex: number,
  // A loop body holds steps AND branches, so these list ops are over the wider
  // element type; the callers below still insert plain steps.
  transform: (body: readonly LoopBodyNode[]) => readonly LoopBodyNode[],
): readonly ProgramNode[] {
  const node = program[loopIndex];
  if (node === undefined || node.kind !== "loop") {
    return program;
  }
  const body = transform(node.body);
  if (body.length === 0) {
    // A loop must keep at least one step — empty it and the loop goes with it.
    return removeAt(program, loopIndex);
  }
  return program.map((n, i) => (i === loopIndex ? { ...node, body } : n));
}

export function insertIntoLoop(
  program: readonly ProgramNode[],
  loopIndex: number,
  step: MacroStep,
  at?: number,
): readonly ProgramNode[] {
  return withLoopBody(program, loopIndex, (body) => insertAt(body, step, at));
}

export function removeFromLoop(
  program: readonly ProgramNode[],
  loopIndex: number,
  bodyIndex: number,
): readonly ProgramNode[] {
  return withLoopBody(program, loopIndex, (body) => removeAt(body, bodyIndex));
}

export function moveInLoop(
  program: readonly ProgramNode[],
  loopIndex: number,
  bodyIndex: number,
  delta: number,
): readonly ProgramNode[] {
  return withLoopBody(program, loopIndex, (body) => moveBy(body, bodyIndex, delta));
}

// ─── Interrupts ──────────────────────────────────────────────────────────────

export function addInterrupt(interrupts: readonly InterruptRow[], row: InterruptRow): readonly InterruptRow[] {
  return [...interrupts, row];
}

/**
 * Remove an interrupt — EXCEPT the safety floor, which is not deletable. Asking
 * to remove it returns the list unchanged, so no edit path can strip it.
 */
export function removeInterrupt(interrupts: readonly InterruptRow[], id: string): readonly InterruptRow[] {
  const row = interrupts.find((r) => r.id === id);
  if (row !== undefined && row.builtIn === "safety-floor") {
    return interrupts;
  }
  return interrupts.filter((r) => r.id !== id);
}

/** Set the threshold on a fraction-bearing interrupt (including the safety floor). */
export function setInterruptFraction(
  interrupts: readonly InterruptRow[],
  id: string,
  fraction: number,
): readonly InterruptRow[] {
  return interrupts.map((r) => {
    if (r.id !== id || !("fraction" in r.when)) {
      return r;
    }
    return { ...r, when: { ...r.when, fraction } };
  });
}

// ─── Inserting a saved bot's steps by value ──────────────────────────────────
//
// The Bot Builder's flat editor holds an ordered list of MacroStep, BranchBlock
// and SubBotNode — everything a `ProgramNode` can be EXCEPT a top-level LoopBlock
// (the editor supplies its own single outer loop, or none at all for a run-once
// bot; a loop nested inside that list has nowhere to go). Copying steps IN FROM
// a saved bot must respect that same limit rather than quietly flattening a
// LoopBlock's body into loose steps — that would drop its repeat count, and it
// would also flatten any branch riding inside it into two loose step lists, which
// is not the same bot. So a source bot's own top-level loops are left out and
// reported in plain language; everything else it can legally hold is copied.

/** What the flat editor's list may directly contain. */
export type FlatProgramNode = MacroStep | BranchBlock | SubBotNode;

export interface InsertSavedBotResult {
  /** The editor's list with the source bot's copyable steps appended. */
  readonly steps: readonly FlatProgramNode[];
  /**
   * Plain sentences (R9a) about anything from the source bot that could not be
   * copied in, so the caller can tell the player. Empty when nothing was left out.
   */
  readonly left: readonly string[];
}

/** Every id already in use across a program, including nested loop/branch ids. */
function collectProgramIDs(nodes: readonly ProgramNode[], into: Set<string>): void {
  for (const node of nodes) {
    into.add(node.id);
    if (node.kind === "loop") {
      for (const element of node.body) {
        into.add(element.id);
        if (element.kind === "branch") {
          for (const step of element.then) into.add(step.id);
          for (const step of element.else) into.add(step.id);
        }
      }
    } else if (node.kind === "branch") {
      for (const step of node.then) into.add(step.id);
      for (const step of node.else) into.add(step.id);
    }
  }
}

/**
 * Append copies of a saved bot's steps to the program being edited, with FRESH
 * ids that cannot collide with anything already in `steps`, in `reservedIDs`
 * (non-program ids in the same document, such as watch/interrupt ids), or
 * among the copies themselves.
 *
 * Pure and non-destructive: `steps` is returned untouched on the front, the
 * source document is only read, and nothing about the player's name, watches,
 * home or repeat setting is touched here — that stays the caller's job.
 */
export function insertSavedBotSteps(
  steps: readonly FlatProgramNode[],
  source: BotScript,
  makeId: IdGen,
  reservedIDs: ReadonlySet<string> = new Set<string>(),
): InsertSavedBotResult {
  const used = new Set(reservedIDs);
  collectProgramIDs(steps, used);
  const fresh = (): string => {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const candidate = makeId().trim();
      if (candidate.length > 0 && !used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    throw new Error("Could not make a fresh step id.");
  };

  const appended: FlatProgramNode[] = [];
  let loopsLeftOut = 0;
  for (const node of source.program) {
    if (node.kind === "loop") {
      // Not representable in the flat list — see the note above. Skipped, not
      // flattened, and counted so the caller can say so.
      loopsLeftOut += 1;
      continue;
    }
    appended.push(cloneWithFreshIds(node, fresh) as FlatProgramNode);
  }

  const left: string[] = [];
  if (loopsLeftOut > 0) {
    const label = source.name.trim().length > 0 ? `"${source.name.trim()}"` : "That saved bot";
    left.push(
      loopsLeftOut === 1
        ? `${label} repeats a group of steps; that repeating part could not be copied in, so add it by hand if you want it.`
        : `${label} repeats ${loopsLeftOut} groups of steps; those repeating parts could not be copied in, so add them by hand if you want them.`,
    );
  }

  return { steps: [...steps, ...appended], left };
}
