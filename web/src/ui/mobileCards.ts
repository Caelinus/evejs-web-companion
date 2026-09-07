// The in-space mobile home: which cards it stacks, and which are folded.
//
// ⚠ WHY A STACK AND NOT THE DESKTOP GRID. On a phone the radar is the first
// thing to go — it is a picture that needs room to mean anything, and there is
// none — and once it goes, the 1C grid is three cells fighting over 380px. The
// handoff's answer (direction 1D) is one column of collapsible cards in a fixed
// order, and the point of the collapse is that a pilot decides what they are
// doing: a miner folds Shots away, someone in a fight folds Mining away.
//
// Pure, because the two rules worth holding are both about what is REMEMBERED:
// an unknown card is OPEN (never quietly folded away), and a stored value that
// is not a boolean is ignored rather than believed.

/** One card in the in-space stack. */
export interface MobileCard {
  /**
   * The card's id.
   *
   * ⚠ IT MATCHES A `TabID` WHERE ONE EXISTS, deliberately — four of these six
   * are also panels the desktop rail can open, and sharing the string lets the
   * mobile nav bar filter out exactly what the stack already shows rather than
   * keeping a second list that drifts out of step.
   *
   * It is NOT typed as `TabID`, because two of them are not tabs: `ship` is the
   * HUD, which is not a panel anywhere, and `overview` was deleted as a tab
   * along with the old cockpit. The card keeps that name because it is what the
   * section IS.
   */
  readonly id: string;
  readonly title: string;
  /**
   * True when the body must cap its own height and scroll inside it.
   *
   * ⚠ NOT "IS A LIST" — "IS LONG". The handoff words the rule as a cap on list
   * bodies, and the reason it gives is what actually decides it: a card that
   * grows without bound turns the page into a scroll where the next card's
   * header is a screen away, and the fold control a pilot is reaching for is
   * the thing that scrolled off.
   *
   * Measured on a 375x812 phone, Flight's body is 1,427px — not a list, and
   * nearly two screens. It caps for the reason, not the letter. Ship's is 453px
   * and is the one thing a pilot glances at, so it is left whole.
   */
  readonly scrolls: boolean;
}

/**
 * The stack, in the handoff's order.
 *
 * ⚠ SHIP IS FIRST AND IS NOT A TAB. It is the gauges and the racks — the thing
 * a pilot glances at — and it is the one card with no full-screen equivalent to
 * open, because the HUD is not a panel anywhere.
 */
export const MOBILE_CARDS: readonly MobileCard[] = [
  { id: "ship", title: "Ship", scrolls: false },
  { id: "overview", title: "Overview", scrolls: true },
  { id: "drones", title: "Drones", scrolls: true },
  { id: "shots", title: "Shots fired", scrolls: true },
  { id: "flight", title: "Navigation & Flight", scrolls: true },
  { id: "mining", title: "Mining", scrolls: true },
] as const;

const STORAGE_KEY = "evejs.mobile.cards.collapsed";

/** Which cards are folded. Anything absent is OPEN. */
export type CollapsedCards = Readonly<Record<string, boolean>>;

/**
 * Read the remembered folds.
 *
 * ⚠ AN UNREADABLE OR ODD-SHAPED STORE READS AS "NOTHING FOLDED". A phone in a
 * private window throws on `localStorage`; a hand-edited value can be anything.
 * Neither may fold a card away, because a folded card is one a pilot cannot see
 * they are missing — the failure is silent in exactly the wrong direction.
 */
export function readCollapsed(storage: Pick<Storage, "getItem"> | null): CollapsedCards {
  if (!storage) {
    return {};
  }
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null || raw.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Only a real `true` folds a card. A "true", a 1, a null — none of those.
      if (value === true) {
        out[key] = true;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember the folds. A storage that refuses is simply not written to. */
export function writeCollapsed(
  storage: Pick<Storage, "setItem"> | null,
  collapsed: CollapsedCards,
): void {
  if (!storage) {
    return;
  }
  try {
    // Only the folded ones are stored, so the default (open) needs no entry and
    // a card added later cannot arrive pre-folded from an old value.
    const folded: Record<string, true> = {};
    for (const [key, value] of Object.entries(collapsed)) {
      if (value === true) {
        folded[key] = true;
      }
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(folded));
  } catch {
    // A phone with site data blocked still works; it just forgets.
  }
}

/** Is this card folded? Absent means open. */
export function isCollapsed(collapsed: CollapsedCards, id: string): boolean {
  return collapsed[id] === true;
}

/** The folds with one card toggled. */
export function toggleCollapsed(collapsed: CollapsedCards, id: string): CollapsedCards {
  return { ...collapsed, [id]: !isCollapsed(collapsed, id) };
}

/**
 * The nav-bar tabs to hide while the in-space stack is on screen.
 *
 * ⚠ TWO WAYS TO OPEN ONE THING IS NOT A FEATURE — the same call the HUD's nav
 * buttons lost. Every card that is also a tab is already on the home screen, so
 * offering it again in the bar costs a tap target and teaches nothing.
 */
export function tabsShownInStack(): ReadonlySet<string> {
  return new Set(MOBILE_CARDS.map((card) => card.id).filter((id) => id !== "ship"));
}
