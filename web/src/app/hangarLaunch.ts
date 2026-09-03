// Pilot Hangar — the shape of "bring these pilots online".
//
// The hangar decides WHICH pilots; App.svelte, which owns the multibox roster,
// is the only thing that can actually create a session and sign one in. This
// module is the vocabulary between them, kept out of both so neither has to
// import the other's component.

/** One pilot the hangar has asked for, named well enough to sign in as. */
export interface LaunchTarget {
  readonly accountName: string;
  readonly characterID: number;
  readonly characterName: string;
}

/**
 * Where one pilot has got to. `connecting` is a real state and not a
 * decoration: the sign-in and the character select are two round trips to the
 * game server, and a roster of six is worked through one at a time.
 */
export type LaunchState = "queued" | "connecting" | "online" | "failed";

export interface LaunchEntry extends LaunchTarget {
  readonly state: LaunchState;
  /** Why it failed, in the player's words. Only set on `failed`. */
  readonly note?: string;
}

/** Every pilot has reached a final state — nothing is still being worked on. */
export function launchFinished(queue: readonly LaunchEntry[]): boolean {
  return queue.every((entry) => entry.state === "online" || entry.state === "failed");
}

/** Replace one pilot's state in the queue, leaving the rest untouched. */
export function withEntryState(
  queue: readonly LaunchEntry[],
  characterID: number,
  state: LaunchState,
  note?: string,
): LaunchEntry[] {
  return queue.map((entry) =>
    entry.characterID === characterID ? { ...entry, state, note } : entry,
  );
}

/** A fresh queue: every pilot waiting, in the order they will be worked. */
export function newQueue(targets: readonly LaunchTarget[]): LaunchEntry[] {
  return targets.map((target) => ({ ...target, state: "queued" as const }));
}
