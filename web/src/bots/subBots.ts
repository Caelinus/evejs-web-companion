// Expanding "run one of my saved bots here" nodes — the composition step.
//
// ⚠ EXPANSION HAPPENS ONCE, BEFORE THE RUN STARTS. The runner never sees a
// sub-bot node: by the time it starts, every included bot's steps are spliced in
// as ordinary program nodes. That is deliberate — the forward scan, the livelock
// proof and the step caps all keep reasoning about ONE flat program, and none of
// them needed a single change to support composition.
//
// Two things make the splice safe:
//
//   • NO CYCLES. A bot may never include itself, directly or through a chain
//     (A → B → A). The walk carries stable resolved identities on the stack
//     and refuses a repeat, so expansion always terminates. `MAX_SUBBOT_DEPTH`
//     is the second, blunter bound.
//   • NO ID COLLISIONS. Two copies of the same bot would carry the same step
//     ids, and ids are how per-step memory and the readout are keyed — so every
//     inlined node is re-idded under the including node's id.
//
// It is PURE: the caller resolves exact ids / unique names and hands documents
// in, so this module is testable with a plain map and does no I/O.

import {
  MAX_SUBBOT_DEPTH,
  type BotScript,
  type BranchBlock,
  type LoopBlock,
  type LoopBodyNode,
  type MacroStep,
  type ProgramNode,
  type SubBotNode,
} from "./botScript.ts";

export type SubBotReference = Pick<SubBotNode, "scriptID" | "name">;

/** A resolver never guesses: an ambiguous portable name is its own refusal. */
export type BotResolution =
  | { readonly kind: "found"; readonly identity: string; readonly doc: BotScript }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" };

/** Resolve by exact scriptID when present; only a unique name may be a fallback. */
export type ResolveBot = (reference: SubBotReference) => BotResolution;

export interface ExpandResult {
  /** The program with every sub-bot replaced by the steps it stands for. */
  readonly doc: BotScript;
  /** Plain sentences about anything that could not be included (R9a). */
  readonly problems: readonly string[];
  /** True when at least one sub-bot node was replaced. */
  readonly expanded: boolean;
}

const SAY = {
  noPick: "A step said to run a saved bot but none was picked, so it was skipped.",
  missing: (name: string): string =>
    `There is no saved bot called "${name}", so that step was skipped.`,
  missingID: "That saved bot no longer exists, so that step was skipped.",
  ambiguous: (name: string): string =>
    `More than one saved bot is called "${name}". Pick that step again so it has one exact bot, and it was skipped for now.`,
  cycle: (name: string): string =>
    `"${name}" ends up including itself, so that step was skipped.`,
  tooDeep: (name: string): string =>
    `"${name}" is nested too many bots deep, so that step was skipped.`,
} as const;

/**
 * Replace every sub-bot node with the program of the bot it names.
 *
 * Never throws and never refuses the whole document: a sub-bot that cannot be
 * included is SKIPPED with a plain sentence, exactly like the codec's
 * clamp-with-a-warning rule — the rest of the bot still runs. (The caller should
 * still put the result through the codec, which enforces the size caps on the
 * expanded program.)
 */
export function expandSubBots(
  doc: BotScript,
  resolve: ResolveBot,
  rootIdentity: string | null = null,
): ExpandResult {
  const problems: string[] = [];
  let expanded = false;

  function walk(program: readonly ProgramNode[], depth: number, stack: readonly string[], prefix: string): ProgramNode[] {
    const out: ProgramNode[] = [];
    for (const node of program) {
      if (node.kind !== "sub-bot") {
        out.push(reid(node, prefix));
        continue;
      }
      expanded = true;
      const name = node.name?.trim() ?? "";
      const scriptID = node.scriptID?.trim() ?? "";
      if (scriptID.length === 0 && name.length === 0) {
        problems.push(SAY.noPick);
        continue;
      }
      if (depth >= MAX_SUBBOT_DEPTH) {
        problems.push(SAY.tooDeep(name || "That saved bot"));
        continue;
      }
      const resolved = resolve({ scriptID: scriptID || null, name: name || null });
      if (resolved.kind === "missing") {
        problems.push(scriptID.length > 0 ? SAY.missingID : SAY.missing(name));
        continue;
      }
      if (resolved.kind === "ambiguous") {
        problems.push(SAY.ambiguous(name || "that name"));
        continue;
      }
      if (stack.includes(resolved.identity)) {
        problems.push(SAY.cycle(name || resolved.doc.name));
        continue;
      }
      // Splice the included bot's program in, one level deeper, under this
      // node's id so its step ids can never collide with anyone else's.
      out.push(
        ...walk(
          resolved.doc.program,
          depth + 1,
          [...stack, resolved.identity],
          `${prefix}${node.id}~`,
        ),
      );
    }
    return out;
  }

  // ⚠ Seed with the saved root's exact id when the caller knows it; a portable
  // unsaved document falls back to its normalized name identity.
  const rootKey = doc.name.trim().toLowerCase();
  const seeded = rootIdentity ?? (rootKey.length > 0 ? `name:${rootKey}` : null);
  const program = walk(doc.program, 0, seeded === null ? [] : [seeded], "");
  return { doc: { ...doc, program }, problems, expanded };
}

/** True when a document contains any sub-bot node (so expansion is worth doing). */
export function hasSubBots(doc: BotScript): boolean {
  return doc.program.some((node) => node.kind === "sub-bot");
}

/** Every saved-bot NAME a document asks for, in order, de-duplicated. */
export function subBotNames(doc: BotScript): readonly string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const node of doc.program) {
    if (node.kind === "sub-bot" && node.name !== null && node.name.trim().length > 0) {
      const name = node.name.trim();
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        names.push(name);
      }
    }
  }
  return names;
}

/** Every direct saved-bot reference, de-duplicated by id first, then by name. */
export function subBotReferences(doc: BotScript): readonly SubBotReference[] {
  const seen = new Set<string>();
  const references: SubBotReference[] = [];
  for (const node of doc.program) {
    if (node.kind !== "sub-bot") {
      continue;
    }
    const scriptID = node.scriptID?.trim() || null;
    const name = node.name?.trim() || null;
    if (scriptID === null && name === null) {
      continue;
    }
    const key = scriptID !== null ? `id:${scriptID}` : `name:${name!.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      references.push({ scriptID, name });
    }
  }
  return references;
}

// ─── Re-idding ───────────────────────────────────────────────────────────────
// Ids key per-step memory and the run readout, so an inlined copy must not reuse
// the original's. An empty prefix (the top level) leaves everything untouched,
// so a bot with no sub-bots round-trips byte-identical.

function reid(node: ProgramNode, prefix: string): ProgramNode {
  if (prefix.length === 0) {
    return node;
  }
  if (node.kind === "loop") {
    const loop: LoopBlock = {
      ...node,
      id: prefix + node.id,
      body: node.body.map((element) => reidLoopBody(element, prefix)),
    };
    return loop;
  }
  if (node.kind === "branch") {
    return reidBranch(node, prefix);
  }
  // A nested sub-bot node is re-idded like anything else; the walk above will
  // have already replaced it, so this only matters for an unexpanded copy.
  return { ...node, id: prefix + node.id };
}

function reidLoopBody(node: LoopBodyNode, prefix: string): LoopBodyNode {
  return node.kind === "branch" ? reidBranch(node, prefix) : reidStep(node, prefix);
}

function reidBranch(branch: BranchBlock, prefix: string): BranchBlock {
  return {
    ...branch,
    id: prefix + branch.id,
    then: branch.then.map((step) => reidStep(step, prefix)),
    else: branch.else.map((step) => reidStep(step, prefix)),
  };
}

function reidStep(step: MacroStep, prefix: string): MacroStep {
  return { ...step, id: prefix + step.id };
}
