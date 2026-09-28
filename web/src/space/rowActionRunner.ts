// TURNING A VERB INTO A SERVER CALL (goal R77) — the single-call half.
//
// WHY THIS LEFT `Overview.svelte`. Until now the switch from a `RowAction` to a
// `flow` call lived inside the overview panel, which was fine while the verb bar
// was the only thing that could dispatch one. The radial menu makes that false:
// the same verbs are now reachable by right-clicking a bracket on the tactical
// view, which is a different component in a different subtree.
//
// ⚠ TWO COPIES OF THIS SWITCH WOULD BE THE WORST KIND OF DUPLICATION. They would
// not diverge loudly — they would diverge in ONE branch, so "Orbit" from the bar
// would hold the configured range and "Orbit" from the radial would hold the
// default, and nothing would look broken. Everything that dispatches a verb goes
// through here.
//
// ⚠ IT DOES NOT OWN BUSY STATE, ERRORS, OR CONFIRMATION. Those belong to the
// surface that dispatched — the overview disables per concern and lands each
// failure on its own control, and a different surface may want to report
// differently. This function calls and returns; it never swallows.

import type { RowActionID } from "./rowActions.ts";
import type { GateLink } from "./gateLinks.ts";

/** The flight verbs this module can dispatch, and what each one needs. */
export interface RowActionSubject {
  readonly itemID: number;
  /** The gate this row is, when it is one — `jump` needs its far side. */
  readonly gateLink: GateLink | null;
}

/** The distances the player has chosen, as numbers of metres. */
export interface FlyingRanges {
  readonly warp: number;
  readonly orbit: number;
  readonly hold: number;
}

/** Just the flow methods this dispatch touches. */
export interface RowActionFlow {
  warpTo(itemID: number, range: number): Promise<unknown>;
  approach(itemID: number): Promise<unknown>;
  orbit(itemID: number, range: number): Promise<unknown>;
  keepAtRange(itemID: number, range: number): Promise<unknown>;
  alignTo(itemID: number): Promise<unknown>;
  dockAt(itemID: number): Promise<unknown>;
  jump(itemID: number, destinationGateID: number): Promise<unknown>;
  lockTarget(itemID: number): Promise<unknown>;
  unlockTarget(itemID: number): Promise<unknown>;
}

/**
 * The verbs that are NOT one server call.
 *
 * `mine` reaches for every powered-up mining laser and each answers separately;
 * `haul` runs a loop with its own per-step reporting; `loot` opens a container
 * and then issues one transfer per bay this hull can take, so what it did is a
 * COUNT (some of it aboard, the rest left in the can) rather than a status code.
 * All three live in the overview with the reporting they need, so this module
 * names them rather than pretending it can run them — a caller can then either
 * delegate or leave them out of its menu, but it cannot silently do nothing.
 */
export const MULTI_STEP_ACTIONS: ReadonlySet<RowActionID> = new Set<RowActionID>([
  "mine",
  "haul",
  "loot",
]);

/** True when `dispatchRowAction` can run this verb. */
export function isSingleCallAction(id: RowActionID): boolean {
  return !MULTI_STEP_ACTIONS.has(id);
}

/**
 * Run one single-call verb against the server.
 *
 * Returns false — WITHOUT calling anything — for a verb this module does not
 * own, so a caller that forgot to filter finds out rather than appearing to work.
 */
export async function dispatchRowAction(
  flow: RowActionFlow,
  id: RowActionID,
  subject: RowActionSubject,
  ranges: FlyingRanges,
): Promise<boolean> {
  switch (id) {
    case "warp":
      await flow.warpTo(subject.itemID, ranges.warp);
      return true;
    case "approach":
      await flow.approach(subject.itemID);
      return true;
    case "orbit":
      await flow.orbit(subject.itemID, ranges.orbit);
      return true;
    case "keepAtRange":
      await flow.keepAtRange(subject.itemID, ranges.hold);
      return true;
    case "align":
      await flow.alignTo(subject.itemID);
      return true;
    // R24 slice B — the LADDER (close the distance, then dock), never the raw
    // single command, which fails unless the ship is already in range.
    case "dock":
      await flow.dockAt(subject.itemID);
      return true;
    case "jump": {
      const link = subject.gateLink;
      // A graph edge with no gate on the far side has nothing honest to send.
      if (!link) {
        return false;
      }
      await flow.jump(subject.itemID, link.destinationGateID);
      return true;
    }
    case "lock":
      await flow.lockTarget(subject.itemID);
      return true;
    case "unlock":
      await flow.unlockTarget(subject.itemID);
      return true;
    default:
      return false;
  }
}
