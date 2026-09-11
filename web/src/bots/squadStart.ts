// Bringing a whole squad's companions online, on the SERVER.
//
// ⚠ THE ONE PLACE IN THIS APP THAT STARTS A BOT FOR A PILOT NOBODY IS FLYING.
// Every other start control reads its character out of a live tab's own station
// slice, so it can only ever act on a pilot that is already signed in here. The
// bot host does not need that at all -- it mints its own session token and
// selects the character itself -- and a squad start depends on it: the point is
// to bring six pilots online without opening six tabs.
//
// PURE ORCHESTRATION. No fetch, no store, no component. The caller passes in
// what to start and how to start one; this decides the order, what happens when
// one refuses, and what the player is told.

import type { CompanionSetup } from "../nav/fleetCompanionLoop.ts";

/** Where one pilot in the squad has got to. */
export type SquadStartState = "queued" | "starting" | "started" | "refused";

export interface SquadStartEntry {
  readonly characterID: number;
  readonly state: SquadStartState;
  /** Why it refused, in the server's own words. Only set on `refused`. */
  readonly sentence?: string;
}

export interface SquadStartDeps {
  /**
   * Start one companion on the host. Rejects with the server's refusal; this
   * module turns that into a sentence and carries on.
   */
  startCompanion(characterID: number, setup: CompanionSetup): Promise<void>;
}

/** One pilot to start, and the setup it flies with. */
export interface SquadStartTarget {
  readonly characterID: number;
  readonly setup: CompanionSetup;
}

/**
 * What the operator should be told BEFORE anything is started.
 *
 * ⚠ ADVISORY, ALL OF IT. Nothing in this module refuses to start a squad --
 * the operator's rule for fit warnings holds here too: say what is wrong and
 * let a human fix it or fly anyway. The one thing that is not a warning is an
 * EMPTY roster, because there is then nothing to start at all.
 *
 * ⚠ BOTH WARNINGS THIS FUNCTION USED TO PRINT ARE GONE, FOR TWO DIFFERENT
 * REASONS, NEITHER OF WHICH IS "NOBODY NEEDS TO KNOW ANY MORE".
 *
 * - The one-tagger warning went because there is no longer a setting to warn
 *   about. Tagging is not a per-pilot toggle now; every pilot tags when it
 *   personally tackles something, and the server -- not this screen -- is the
 *   real gate: only a fleet creator, leader, wing commander or squad commander
 *   may write a tag (`obs.canTag`), so a companion that is a plain member tags
 *   nothing no matter how many of them a squad has. And even between two
 *   commanders, the rung only ever considers a ship that is TACKLING THIS
 *   PILOT, and skips one already carrying a letter -- so two companions can
 *   collide only if the same ship tackled both of them in the same tick,
 *   before either letter was visible to the other. See
 *   docs/fleet-companion-simplification.md, "Tagging".
 * - The fit-mixture warning went because the mixture it described cannot
 *   happen any more. It used to flag a squad where some pilots read their own
 *   fit and some flew a hand-picked module list; there is no longer a
 *   hand-picked list to fly instead -- every companion always reads its own
 *   fit at start -- so there is nothing left for two pilots to disagree about.
 *
 * Nothing has replaced them. If a real advisory turns up again, it belongs
 * here; until then this returns no warnings at all.
 */
export function squadStartWarnings(targets: readonly SquadStartTarget[]): readonly string[] {
  void targets;
  return [];
}

/**
 * Start every configured pilot in the squad, ONE AT A TIME.
 *
 * ⚠ SEQUENTIAL, AND NOT BECAUSE IT IS SIMPLER. `App.svelte`'s `bringOnline`
 * already argues this for signing pilots in and the argument carries: a browser
 * allows about six connections per origin, so six simultaneous starts fill that
 * pool with starts and the seventh request of any kind queues behind them. Each
 * pilot also LANDS separately this way, which is what makes a progress readout
 * honest -- a row flips because that pilot is actually flying, not because a
 * timer fired.
 *
 * ⚠ ONE REFUSAL MUST NOT STRAND THE REST OF A SQUAD. A pilot already flown by a
 * bot, or by a tab, refuses with CHARACTER_IN_USE / BOT_ALREADY_RUNNING; that
 * is a fact about that pilot, not about the operation. It is recorded and the
 * next pilot is tried.
 *
 * ⚠ AND THE GRANT IS BUILT PER PILOT, BY THE CALLER, FROM THAT PILOT'S OWN
 * SETUP. Every companion now reads its own fit unconditionally, so `combat` is
 * an unconditional risk class for all of them -- the fit has not been read yet
 * at grant time and may hold anything. What still varies pilot to pilot is the
 * rest of the setup: one that pays for repairs earns `financial` and one that
 * does not, does not. Reusing one grant across the squad would hand some pilot
 * a grant that does not describe it, and the host re-derives and compares.
 */
export async function startCompanionSquad(
  deps: SquadStartDeps,
  targets: readonly SquadStartTarget[],
  onProgress?: (entries: readonly SquadStartEntry[]) => void,
): Promise<readonly SquadStartEntry[]> {
  const entries: SquadStartEntry[] = targets.map((target) => ({
    characterID: target.characterID,
    state: "queued" as const,
  }));
  const report = (): void => onProgress?.(entries.map((entry) => ({ ...entry })));
  report();

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    entries[index] = { characterID: target.characterID, state: "starting" };
    report();
    try {
      await deps.startCompanion(target.characterID, target.setup);
      entries[index] = { characterID: target.characterID, state: "started" };
    } catch (cause) {
      // The server's own sentence, unwrapped. There is no code-to-words layer
      // on the client for these and there should not be a second one here:
      // CHARACTER_IN_USE already says "A web session is flying this character."
      entries[index] = {
        characterID: target.characterID,
        state: "refused",
        sentence:
          cause instanceof Error && cause.message
            ? cause.message
            : "That pilot could not be started.",
      };
    }
    report();
  }
  return entries;
}

/** Every pilot has reached a final state. */
export function squadStartFinished(entries: readonly SquadStartEntry[]): boolean {
  return entries.every((entry) => entry.state === "started" || entry.state === "refused");
}

/** How the run went, in one line, once it is over. */
export function squadStartSummary(entries: readonly SquadStartEntry[]): string {
  const started = entries.filter((entry) => entry.state === "started").length;
  const refused = entries.filter((entry) => entry.state === "refused").length;
  if (entries.length === 0) {
    return "No pilot in this squad is set up to fly a companion yet.";
  }
  if (refused === 0) {
    return started === 1 ? "One pilot is flying." : `${started} pilots are flying.`;
  }
  if (started === 0) {
    return refused === 1 ? "That pilot could not start." : `None of the ${refused} could start.`;
  }
  return `${started} flying, ${refused} could not start.`;
}
