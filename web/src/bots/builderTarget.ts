// WHICH BOT THE BUILDER IS FOR — the Bot Manager's Edit/New button, said once.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// The Bot Manager owns the library: it lists every saved bot and offers Edit,
// Export and Delete on each row. The Bot Builder edits ONE bot. Before this
// module the Edit button only opened the builder's window — the bot it named
// never arrived — so the builder carried a second copy of the library with a
// Load button on every row, and "edit this one" meant finding the same bot
// again in a different list. Two lists of the same rows, and the one with the
// Edit button could not act on it.
//
// ---------------------------------------------------------------------------
// WHY A SIGNAL AND NOT A PROP
//
// `showInfo.ts`'s reason, with an extra turn of the screw. The manager is a
// GLOBAL window (globalWindow.ts) living on App's layer, and the builder opens
// as a window on the active pilot's desktop — two different subtrees, with
// App's open-request plumbing between them, and that plumbing addresses a TAB
// and carries no payload. Threading a script id through it would mean teaching
// every window in the app to hold an argument so that one of them could.
//
// ⚠ THE REQUEST IS CONSUMED, NOT MERELY OBSERVED. A minimized window is
// unmounted (App renders only `!minimized`), so the builder remounts every time
// it is put away and brought back. A request left standing would be re-served
// on each of those remounts and reload the bot from the server — quietly
// throwing away whatever the player had typed since. So `ask` sets a pending
// request, the builder `served`s it, and what is left is nothing to replay.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

/** "Open this bot", or with a null id, "open a bot that does not exist yet". */
export interface BuilderRequest {
  readonly scriptID: string | null;
  /**
   * Rises with every ask. It is not an ordering device — the pending request is
   * the only one there is — but `served` needs to name WHICH request it served,
   * so that a second ask arriving while the first is being loaded is not
   * cleared away unserved.
   */
  readonly n: number;
}

export interface BuilderTarget {
  /** The request waiting to be served, or null when there is none. */
  readonly pending: ReadableSignal<BuilderRequest | null>;
  /** Ask the builder to open `scriptID` (null = a new, unsaved bot). */
  ask(scriptID: string | null): void;
  /** Drop request `n`, if it is still the pending one. */
  served(n: number): void;
}

export function createBuilderTarget(): BuilderTarget {
  const pending = createSignal<BuilderRequest | null>(null);
  let count = 0;
  return {
    pending: readonlySignal(pending),
    ask: (scriptID: string | null): void => {
      count += 1;
      pending.set({ scriptID, n: count });
    },
    served: (n: number): void => {
      const current = pending.get();
      if (current !== null && current.n === n) {
        pending.set(null);
      }
    },
  };
}

/** The app's one "open this bot in the builder" request. */
export const builderTarget: BuilderTarget = createBuilderTarget();

// ── The wire back: the library changed ─────────────────────────────────────
//
// ⚠ THE MANAGER'S LIST DOES NOT POLL, AND NOW IT CANNOT SEE ITS OWN CHANGES.
// Its library is a poll-free list on purpose (a saved bot is not a self-moving
// thing like a running one), which was true while every write to it happened
// in that panel. It is not true any more: the builder is the only place a bot
// can be created or renamed, and it is a different window — so a player who
// saves a new bot and looks back at the Manager would find a list that does
// not have it, and no reason on screen to think of reopening the window.
//
// A counter and not a payload: the Manager already knows how to read the
// library, and re-reading it is how another account's save arrives anyway.
const libraryChanges = createSignal(0);

/** Rises every time a bot is written to the shared library. */
export const libraryChanged: ReadableSignal<number> = readonlySignal(libraryChanges);

/** Say that the library now holds something different. */
export function noteLibraryChanged(): void {
  libraryChanges.update((count) => count + 1);
}

/**
 * Is the bot the builder has open still in the library?
 *
 * ⚠ ONLY ASK THIS OF A READ THAT SUCCEEDED. The builder empties its list when
 * the read throws, and an empty list run through here would report every open
 * bot as deleted — the same "a failed read is never zero" rule the Manager's
 * library states, at the one place where getting it wrong silently unpicks a
 * player's bot from the row it belongs to.
 *
 * A draft that has never been saved (`null`) is not deleted; it was never
 * there.
 */
export function isStillSaved(
  currentID: string | null,
  rows: readonly { readonly scriptID: string }[],
): boolean {
  if (currentID === null) return true;
  return rows.some((row) => row.scriptID === currentID);
}

/** Convenience: the Bot Manager's Edit button. */
export function editInBuilder(scriptID: string): void {
  builderTarget.ask(scriptID);
}

/** Convenience: the Bot Manager's New bot button. */
export function newInBuilder(): void {
  builderTarget.ask(null);
}

/** What the builder is holding when a request arrives. */
export interface BuilderHolding {
  /** The saved bot open in the builder, or null when the draft is unsaved. */
  readonly currentID: string | null;
  /** Has the draft been changed since it was last loaded or saved? */
  readonly dirty: boolean;
}

/**
 * What the builder does with an incoming request.
 *
 *  • `load`   — open it now.
 *  • `ignore` — the bot asked for is the one already being edited; opening it
 *               again would only re-read the server over the player's own
 *               unsaved edits to that same bot.
 *  • `wait`   — there are unsaved changes to a DIFFERENT bot. Loading would
 *               destroy them with no way back.
 *
 * ⚠ `wait` IS A CONDITION, NOT A DIALOG. The builder does not ask "are you
 * sure" and block on an answer; it says what is in the way, leaves both exits
 * in reach (Save, or discard), and completes the handoff by itself the moment
 * the draft stops being dirty — which is what pressing Save does. A player who
 * meant to keep editing simply carries on, and the note is the only trace.
 */
export type Handoff =
  | { readonly kind: "load"; readonly scriptID: string | null }
  | { readonly kind: "ignore" }
  | { readonly kind: "wait"; readonly scriptID: string | null };

export function decideHandoff(request: BuilderRequest, holding: BuilderHolding): Handoff {
  // Asked for the bot already open. A clean draft reloads (cheap, and it picks
  // up an edit somebody else saved to this shared row); a dirty one does not.
  if (holding.currentID !== null && request.scriptID === holding.currentID) {
    return holding.dirty ? { kind: "ignore" } : { kind: "load", scriptID: request.scriptID };
  }
  if (!holding.dirty) {
    return { kind: "load", scriptID: request.scriptID };
  }
  return { kind: "wait", scriptID: request.scriptID };
}

/**
 * How the waiting request is referred to.
 *
 * ⚠ THREE CASES, NOT TWO. "New bot" is not a nameless bot: it is a different
 * request, and the sentence has to read as one. A saved bot whose name the
 * builder does not hold — the library read is in flight, or failed, or the row
 * was saved in another tab since — is the third, and calling it "a new bot"
 * because the name came back null would describe the opposite of what the
 * button does.
 */
export function wantedLabel(scriptID: string | null, name: string | null): string {
  if (scriptID === null) {
    return "a new bot";
  }
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0 ? `“${trimmed}”` : "the bot you chose";
}

/**
 * What the builder says while a handoff is waiting.
 *
 * It names BOTH bots — what is being kept and what is being asked for —
 * because the window in front of the player is showing neither answer: it
 * shows the draft, and the button they pressed was in another window entirely.
 */
export function waitingSentence(holdingName: string, wanted: string): string {
  const kept = holdingName.trim().length > 0 ? `“${holdingName.trim()}”` : "this bot";
  return `${kept} has unsaved changes, so ${wanted} was not opened. Save it and ${wanted} opens by itself — or discard the changes below.`;
}
