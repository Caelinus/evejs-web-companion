// "SET UP THIS JOB" — the Industry Manager's Start next button, said once to
// the Industry panel of the pilot who holds the blueprint (goal R109 slice 5).
//
// ---------------------------------------------------------------------------
// WHY A SIGNAL AND NOT A PROP — bots/builderTarget.ts's reason exactly. The
// manager is a GLOBAL window; the Industry panel opens on a pilot's desktop,
// and App's open-request plumbing between them addresses a TAB and carries no
// payload. So the window is opened through that plumbing and what to set up
// travels here.
//
// ⚠ IT ONLY PREFILLS. The Industry panel's own three steps stay the only way a
// job starts: the facility is still the player's to choose, the cost is still
// previewed from the server, and the install still needs its confirm. Nothing
// here spends anything.
//
// ⚠ ADDRESSED TO A PILOT, AND CONSUMED. Only the Industry panel of the named
// character serves a request, and serving drops it, so a panel remounted later
// (a minimized window is unmounted) does not set the same job up again.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

export interface InstallRequest {
  /** The pilot whose Industry panel should set it up. */
  readonly characterID: number;
  /** The owned blueprint to install from. */
  readonly blueprintItemID: number;
  /** The facility it sits in: the only one the server will install it in. */
  readonly facilityID: number;
  readonly activity: "manufacturing" | "reaction" | "invention";
  readonly runs: number;
  /** Invention only: the decryptor to add, one per run. */
  readonly decryptorTypeID?: number;
  /** Rises with every ask, so `served` names which one it served. */
  readonly n: number;
}

export interface InstallTarget {
  readonly pending: ReadableSignal<InstallRequest | null>;
  ask(request: Omit<InstallRequest, "n">): void;
  served(n: number): void;
}

export function createInstallTarget(): InstallTarget {
  const pending = createSignal<InstallRequest | null>(null);
  let count = 0;
  return {
    pending: readonlySignal(pending),
    ask(request) {
      count += 1;
      pending.set({ ...request, n: count });
    },
    served(n) {
      const current = pending.get();
      if (current !== null && current.n === n) {
        pending.set(null);
      }
    },
  };
}

/** The app's one "set this job up" request. */
export const installTarget: InstallTarget = createInstallTarget();
