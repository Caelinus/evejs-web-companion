// C2 — draft validation for the editor. Distinct from the codec: the codec
// REFUSES an untrusted file whole; this LISTS a live draft's fixable problems,
// one plain sentence per place, so the editor can show "3 things to fix" under
// the right rows and disable Start until they are cleared. Never throws.
//
// It shares `MACRO_SPECS` with the codec, so "what a step needs" is defined once.

import {
  MAX_CONDITION_FRACTION,
  MAX_ORE_HOLD_FRACTION,
  MAX_REPEAT_TIMES,
  MIN_CONDITION_FRACTION,
  MIN_REPEAT_TIMES,
  conditionAllowedAt,
  type BotScript,
  type BranchBlock,
  type Condition,
  type ConditionSite,
  type InterruptRow,
  type LoopBlock,
  type MacroStep,
} from "./botScript.ts";
import { MACRO_SPECS } from "./macroSpecs.ts";

/** One fixable problem, anchored to a row by its id (or a script-level key). */
export interface ScriptProblem {
  /** The step / loop / interrupt id, or "name" / "home" / "program". */
  readonly path: string;
  readonly sentence: string;
}

/** Plain words for each argument, for "This step needs …". */
const ARG_LABEL: Readonly<Record<string, string>> = {
  belt: "a belt to work",
  station: "a station to go to",
  equipment: "mining equipment to run",
  item: "an item to trade",
  quantity: "how many to buy",
  price: "a price per unit",
  who: "a pilot to invite",
  channel: "a channel to talk in",
  message: "a message to send",
  destination: "somewhere to go",
};

/** Every fixable problem in a draft, in reading order. Empty means ready to start. */
export function validateScript(script: BotScript): readonly ScriptProblem[] {
  const problems: ScriptProblem[] = [];

  if (script.name.trim().length === 0) {
    problems.push({ path: "name", sentence: "Give your bot a name." });
  }
  const someWatchDocks = script.interrupts.some((row) => row.respond === "dock-and-pause");
  if (
    someWatchDocks &&
    script.home.id === null &&
    script.home.starting !== true &&
    script.home.slot === undefined
  ) {
    problems.push({ path: "home", sentence: "Pick where the bot docks when a watch tells it to." });
  }
  if (script.program.length === 0) {
    problems.push({ path: "program", sentence: "Add at least one step for the bot to do." });
  }

  for (const node of script.program) {
    if (node.kind === "loop") {
      validateLoop(node, problems);
    } else if (node.kind === "branch") {
      validateBranch(node, problems);
    } else if (node.kind === "sub-bot") {
      if (
        (node.scriptID === null || node.scriptID.trim().length === 0) &&
        (node.name === null || node.name.trim().length === 0)
      ) {
        problems.push({ path: node.id, sentence: "Pick which saved bot this step runs." });
      }
    } else {
      validateStep(node, problems);
    }
  }

  for (const row of script.interrupts) {
    validateInterrupt(row, problems);
  }

  return problems;
}

function validateLoop(loop: LoopBlock, problems: ScriptProblem[]): void {
  if (loop.body.length === 0) {
    problems.push({ path: loop.id, sentence: "This loop has no steps inside it." });
  }
  if (loop.repeat.kind === "times") {
    const count = loop.repeat.count;
    if (!Number.isInteger(count) || count < MIN_REPEAT_TIMES || count > MAX_REPEAT_TIMES) {
      problems.push({
        path: loop.id,
        sentence: `A loop can repeat between ${MIN_REPEAT_TIMES} and ${MAX_REPEAT_TIMES} times.`,
      });
    }
  }
  if (loop.until !== undefined) {
    validateCondition(loop.until, "until", loop.id, problems);
  }
  for (const element of loop.body) {
    // A loop body holds steps and branches; both get their own validation.
    if (element.kind === "branch") {
      validateBranch(element, problems);
    } else {
      validateStep(element, problems);
    }
  }
}

function validateStep(step: MacroStep, problems: ScriptProblem[]): void {
  const spec = MACRO_SPECS[step.macro];

  for (const argSpec of spec.args) {
    const arg = step.args[argSpec.key];
    if (arg === undefined) {
      if (argSpec.required) {
        const label = ARG_LABEL[argSpec.key] ?? "something it needs";
        problems.push({ path: step.id, sentence: `This step needs ${label}.` });
      }
      continue;
    }
    // A station is unset only when it is neither pinned NOR a runtime binding
    // (the starting station, or a named board slot an earlier block fills in).
    if (arg.kind === "station" && arg.ref.id === null && arg.ref.starting !== true && arg.ref.slot === undefined) {
      problems.push({ path: step.id, sentence: "Pick the station for this step." });
    }
    if (arg.kind === "belt" && arg.belt.mode === "chosen" && arg.belt.ref.id === null) {
      problems.push({ path: step.id, sentence: "Pick a belt for this step, or choose the nearest one." });
    }
    // An agent slot the player ADDED but never filled. Leaving the slot out
    // entirely is fine — the step then uses the agent the find block remembered.
    if (arg.kind === "bookmark" && arg.bookmarkID === null && (arg.name === null || arg.name === "")) {
      problems.push({ path: step.id, sentence: "Pick the saved spot for this step." });
    }
    if (arg.kind === "itemType" && arg.typeID === null) {
      problems.push({ path: step.id, sentence: "Pick the item for this step." });
    }
    if (arg.kind === "fitting" && arg.fittingID === null && (arg.name === null || arg.name === "")) {
      problems.push({ path: step.id, sentence: "Pick the saved fitting for this step." });
    }
    if (arg.kind === "agent" && arg.ref.id === null) {
      problems.push({ path: step.id, sentence: "Pick the agent for this step, or remove the pick to use the one your bot finds." });
    }
    if (arg.kind === "character" && arg.charID === null) {
      // The invite's pilot is mandatory; a PvP `only` filter left unfilled just
      // needs the half-made pick resolved (pick someone, or clear it for "any").
      problems.push({
        path: step.id,
        sentence:
          argSpec.key === "only"
            ? "Pick the pilot to hunt, or clear the pick to go after any player."
            : "Pick the pilot to invite.",
      });
    }
    if (arg.kind === "destination" && arg.ref.id === null) {
      problems.push({ path: step.id, sentence: "Pick where this step sets the destination to." });
    }
  }

  // The move block: moving a thing onto itself is a no-op the player did not mean.
  const fromArg = step.args["from"];
  const toArg = step.args["to"];
  if (
    fromArg !== undefined && toArg !== undefined &&
    fromArg.kind === "place" && toArg.kind === "place" &&
    fromArg.place === toArg.place
  ) {
    problems.push({ path: step.id, sentence: "This step moves items to the same place they already are." });
  }

  if (spec.untilRequired && step.until === undefined) {
    problems.push({
      path: step.id,
      sentence: "This mining step needs something to stop it, like the ore hold being full.",
    });
  }
  if (step.until !== undefined) {
    validateCondition(step.until, "until", step.id, problems);
  }
}

function validateBranch(branch: BranchBlock, problems: ScriptProblem[]): void {
  validateCondition(branch.when, "until", branch.id, problems);
  if (branch.then.length === 0 && branch.else.length === 0) {
    problems.push({ path: branch.id, sentence: "This branch needs at least one step in one of its choices." });
  }
  for (const step of [...branch.then, ...branch.else]) {
    validateStep(step, problems);
  }
}

function validateInterrupt(row: InterruptRow, problems: ScriptProblem[]): void {
  validateCondition(row.when, "interrupt", row.id, problems);
}

function validateCondition(
  condition: Condition,
  site: ConditionSite,
  path: string,
  problems: ScriptProblem[],
): void {
  if (!conditionAllowedAt(condition.kind, site)) {
    problems.push({
      path,
      sentence: "This check only works out in space, so it can't be used to stop a step.",
    });
    return;
  }
  if ("fraction" in condition) {
    const max = condition.kind === "ore-hold-at-least" ? MAX_ORE_HOLD_FRACTION : MAX_CONDITION_FRACTION;
    if (condition.fraction < MIN_CONDITION_FRACTION || condition.fraction > max) {
      problems.push({
        path,
        sentence: `That percentage must be between ${pct(MIN_CONDITION_FRACTION)} and ${pct(max)}.`,
      });
    }
  }
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
