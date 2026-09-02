// The Bot Builder's DOCUMENT layer: a saved bot in, the editor's state out,
// and back again. These two functions decide what JSON a bot is saved as, so
// they are the last thing that should have lived inside a Svelte component —
// where nothing could test them, because Svelte components in this project are
// neither type-checked (docs/svelte-typecheck-gap.md) nor reachable outside an
// SSR render. `editorDoc.test.ts` now round-trips every bundled example and
// every starter seed through the pair and compares the encodings byte for byte.
//
// ⚠ THE PROPERTY THIS MODULE OWES: opening a bot and saving it without touching
// anything must produce the SAME document. The library is platform-wide and
// `rev`-checked, so a lossy round-trip is not a private annoyance — it rewrites
// a bot other accounts are running, silently, on a save the player thought was
// a no-op.

import {
  type BotScript,
  type InterruptRow,
  type LoopBlock,
  type LoopBodyNode,
  type ProgramNode,
  type Repeat,
  type WorldRef,
  MAX_NOTES_LEN,
  startingStation,
} from "./botScript.ts";
import type { FlatProgramNode } from "./scriptEdit.ts";

/** How the top-level repeat reads in the editor's own control. */
export type RepeatMode = "forever" | "times" | "once";

/**
 * Everything the editor holds about the bot being edited. The plan is ONE flat
 * list of what a loop body may hold (steps and branches) plus sub-bot nodes,
 * which are legal only at the top level — so the same list builds either a
 * looping bot or a run-once one, and `repeatMode` decides which.
 */
export interface EditorState {
  readonly name: string;
  readonly notes: string;
  readonly repeatMode: RepeatMode;
  readonly repeatCount: number;
  readonly home: WorldRef;
  readonly watches: readonly InterruptRow[];
  readonly steps: readonly FlatProgramNode[];
  /**
   * A program the flat list cannot hold — several loops, or a loop beside loose
   * steps — kept VERBATIM so it still runs and still exports unchanged. When
   * this is set the editor renders read-only and `toScript` returns it
   * untouched; adding a step clears it and the flat list takes over.
   */
  readonly advancedProgram: readonly ProgramNode[] | null;
  /**
   * The outer loop's own id and `until`, carried across a round trip.
   *
   * ⚠ NOT COSMETIC, AND NOT ALWAYS "main-loop". The editor used to rebuild the
   * loop as `{ id: "main-loop" }` with no `until` no matter what it had opened,
   * so loading a bot whose loop was named anything else — or which stopped on a
   * condition of its own — and pressing Save rewrote the document. `null` means
   * "there was no loop to preserve", and a new bot gets the historic default.
   */
  readonly loopID: string | null;
  readonly loopUntil: LoopBlock["until"];
}

/** The id a bot that has never held a loop gets when it grows one. */
export const DEFAULT_LOOP_ID = "main-loop";

/** The plan a brand-new bot opens with. Player-facing content: if a test wants
 * different steps, the test is wrong. */
export function newEditorState(): EditorState {
  return {
    name: "My mining bot",
    notes: "",
    repeatMode: "times",
    repeatCount: 20,
    home: startingStation(),
    watches: [{ id: "w-shield", when: { kind: "shield-below", fraction: 0.3 }, respond: "dock-and-pause" }],
    steps: [
      { id: "s-undock", kind: "macro", macro: "undock", args: {} },
      {
        id: "s-mine",
        kind: "macro",
        macro: "mine-at-belt",
        args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
        until: { kind: "ore-hold-at-least", fraction: 0.9 },
      },
      {
        id: "s-haul",
        kind: "macro",
        macro: "deliver-ore",
        args: { station: { kind: "station", ref: startingStation() } },
      },
    ],
    advancedProgram: null,
    loopID: null,
    loopUntil: undefined,
  };
}

/**
 * Open a decoded document in the editor. Three shapes, and the third is the
 * reason the other two can stay simple:
 *
 *  1. exactly one top-level loop — the flat list IS its body, and the repeat
 *     control shows the loop's own repeat;
 *  2. no loop at all — a run-once list the editor holds directly;
 *  3. anything else (several loops, or a loop beside loose steps) — not a shape
 *     one list can hold, so it is preserved verbatim and shown read-only rather
 *     than silently flattened into a different bot.
 */
export function toEditorState(doc: BotScript): EditorState {
  const base = {
    name: doc.name,
    notes: doc.notes,
    home: doc.home,
    watches: [...doc.interrupts],
  };
  const first = doc.program[0];
  if (doc.program.length === 1 && first !== undefined && first.kind === "loop") {
    return {
      ...base,
      repeatMode: first.repeat.kind === "forever" ? "forever" : "times",
      repeatCount: first.repeat.kind === "times" ? first.repeat.count : 20,
      steps: [...first.body],
      advancedProgram: null,
      loopID: first.id,
      loopUntil: first.until,
    };
  }
  if (doc.program.every((node): node is FlatProgramNode => node.kind !== "loop")) {
    return {
      ...base,
      repeatMode: "once",
      repeatCount: 20,
      // No filter: `every` above has already narrowed the whole program to what
      // the flat list may hold, so a filter here would be a comparison the
      // compiler knows can never be true.
      steps: [...doc.program],
      advancedProgram: null,
      loopID: null,
      loopUntil: undefined,
    };
  }
  return {
    ...base,
    repeatMode: "once",
    repeatCount: 20,
    // The flattened contents, so that ADDING a step turns this into a plain
    // flat bot rather than leaving the editor with nothing to show.
    steps: doc.program.flatMap((node): FlatProgramNode[] =>
      node.kind === "macro" || node.kind === "branch" || node.kind === "sub-bot" ? [node] : [...node.body],
    ),
    advancedProgram: doc.program,
    loopID: null,
    loopUntil: undefined,
  };
}

/** True when the plan contains a sub-bot node, which forces a run-once bot. */
export function hasSubBot(steps: readonly FlatProgramNode[]): boolean {
  return steps.some((node) => node.kind === "sub-bot");
}

/**
 * Build the document the editor's state describes.
 *
 * ⚠ A sub-bot node is legal only at the TOP level (an included bot may carry
 * loops of its own), so a plan containing one always builds a run-once bot —
 * the repeat control says as much rather than silently disagreeing with this.
 */
export function toScript(state: EditorState): BotScript {
  return {
    format: "evejs-bot-script",
    version: 1,
    name: state.name,
    notes: state.notes.slice(0, MAX_NOTES_LEN),
    home: state.home,
    interrupts: [...state.watches],
    program: buildProgram(state),
  };
}

function buildProgram(state: EditorState): readonly ProgramNode[] {
  if (state.advancedProgram !== null) {
    return state.advancedProgram;
  }
  if (state.steps.length === 0) {
    return [];
  }
  if (state.repeatMode === "once" || hasSubBot(state.steps)) {
    return [...state.steps];
  }
  const loop: LoopBlock = {
    id: state.loopID ?? DEFAULT_LOOP_ID,
    kind: "loop",
    repeat: buildRepeat(state),
    body: state.steps.filter((node): node is LoopBodyNode => node.kind !== "sub-bot"),
  };
  // `until` is optional on a loop, and an explicit `undefined` key is not the
  // same document as an absent one once it reaches the encoder.
  return [state.loopUntil === undefined ? loop : { ...loop, until: state.loopUntil }];
}

function buildRepeat(state: EditorState): Repeat {
  return state.repeatMode === "forever" ? { kind: "forever" } : { kind: "times", count: state.repeatCount };
}
