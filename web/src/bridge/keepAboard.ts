// Which items a block is talking about — the rules behind "keep this aboard"
// and "load this".
//
// ── WHY BAY-LEVEL SELECTION IS NOT ENOUGH ──────────────────────────────────
//
// `bayRouting.ts` can keep a whole bay out of an unload, which answers "leave my
// ammo hold alone". It cannot answer "leave my spare mining crystals alone",
// because those sit in the CARGO hold beside the ore and salvage the trip was
// actually for. The cargo hold is the one place where which-bay tells you
// nothing about keep-or-unload, so the only thing that can separate them is the
// item itself. The load side asks the same question from the other end: "take
// the command centres out of this hangar, and nothing else in it".
//
// ── MATCHED ON WHAT THE SERVER SAID IT IS, WHEREVER THAT IS ENOUGH ─────────
//
// A rule names a typeID or a groupID — the game's own classification, as it
// arrives on the row. That is R47's rule (EquipmentArg and OreFamilyArg follow
// it too) and it is still the one to reach for: every grade and variant of a
// mining crystal shares a group, so one GROUP rule covers the lot where a typeID
// list would need a dozen entries and would silently miss the thirteenth. The
// same is true of the thing this file was extended for: every planet's command
// centre is one group.
//
// ── AND A NAME PATTERN, WHICH THE OPERATOR ASKED FOR ───────────────────────
//
// ⚠ A `name` RULE IS THE WEAK ONE, AND IT IS WEAK IN A KNOWN WAY. Names are
// localised and renamed, so "everything called Command Center" is a rule a
// patch — or a client in another language — can quietly empty. It is here
// because a group is not always the line a player wants to draw (two kinds of
// thing can share one group, and one kind can span several), and because the
// only honest alternative was to make them list a dozen types by hand.
//
// It is therefore matched on the name the CLIENT resolved for the row's type,
// case-insensitively, as a substring — and a row whose name could not be
// resolved is UNDECIDABLE rather than "no", the same way a group rule treats an
// unreadable groupID. `whenUnsure` decides what that means, and the callers
// genuinely want opposite answers (see below).

/** One rule: an exact type, every item of a kind, or a name pattern. */
export type KeepRule =
  | { readonly match: "type"; readonly typeID: number }
  | { readonly match: "group"; readonly groupID: number }
  | { readonly match: "name"; readonly pattern: string };

/**
 * A row these rules can be tested against. `name` is the resolved type name
 * where the caller has one — absent means "nobody looked it up", which is what
 * makes a name rule undecidable rather than false.
 */
export interface MatchableRow {
  readonly typeID: number;
  readonly groupID: number | null;
  readonly name?: string | null;
}

/**
 * Does any rule match this row? `unsure` is the answer for a row a rule could
 * not be TESTED against — an unreadable groupID, an unresolved name.
 *
 * A type rule is never undecidable: the row always carries a typeID.
 */
function matchesAny(row: MatchableRow, rules: readonly KeepRule[], unsure: boolean): boolean {
  let undecided = false;
  for (const rule of rules) {
    if (rule.match === "type") {
      if (rule.typeID === row.typeID) {
        return true;
      }
      continue;
    }
    if (rule.match === "group") {
      if (row.groupID === null) {
        undecided = true;
        continue;
      }
      if (rule.groupID === row.groupID) {
        return true;
      }
      continue;
    }
    const pattern = rule.pattern.trim().toLowerCase();
    if (pattern.length === 0) {
      // An empty pattern is not "match everything" — that would turn a
      // half-typed rule into a block that loads the whole hangar.
      continue;
    }
    const name = row.name ?? null;
    if (name === null || name.length === 0) {
      undecided = true;
      continue;
    }
    if (name.toLowerCase().includes(pattern)) {
      return true;
    }
  }
  return undecided ? unsure : false;
}

/**
 * Does this row stay aboard?
 *
 * ⚠ `whenUnsure` IS NOT A DETAIL, AND THE CALLERS WANT OPPOSITE ANSWERS.
 * A row whose groupID could not be read cannot be tested against a group rule,
 * and one whose name nobody resolved cannot be tested against a name rule. What
 * to do about that depends entirely on what happens to the row next:
 *
 *   • UNLOADING — "move". The stack lands in the station hangar, which is
 *     recoverable in one drag, and refusing to move rows we cannot classify
 *     would stall the block's "am I empty yet" check for ever.
 *   • JETTISONING — "keep". The stack goes into a can that despawns. There is
 *     no undo, so "I could not tell" must never be enough to throw something
 *     into space.
 *
 * An empty rule list keeps nothing, which is the shipped behaviour: a step
 * nobody has configured empties the ship exactly as it always did.
 */
export function staysAboard(
  row: MatchableRow,
  keep: readonly KeepRule[],
  whenUnsure: "keep" | "move",
): boolean {
  if (keep.length === 0) {
    return false;
  }
  return matchesAny(row, keep, whenUnsure === "keep");
}

/** The rows a block may move, with everything the rules protect held back. */
export function movableRows<Row extends MatchableRow>(
  rows: readonly Row[],
  keep: readonly KeepRule[],
  whenUnsure: "keep" | "move",
): readonly Row[] {
  if (keep.length === 0) {
    return rows;
  }
  return rows.filter((row) => !staysAboard(row, keep, whenUnsure));
}

/**
 * The rows a LOAD block was asked for — the inverse of `movableRows`, and it
 * defaults the opposite way on purpose.
 *
 * ⚠ AN EMPTY RULE LIST PICKS NOTHING, WHERE AN EMPTY KEEP LIST KEEPS NOTHING.
 * Both are "the safe reading of a step nobody finished configuring", but safe
 * means different things in each direction: an unload with no keep rules empties
 * the ship into a hangar, which is recoverable; a load with no rules would take
 * a station hangar's entire contents — ships, modules, everything — aboard a
 * hauler, which is not.
 *
 * `whenUnsure` is "skip" for the same reason: a row nobody could classify is
 * left in the hangar, where it already safely was.
 */
export function pickedRows<Row extends MatchableRow>(
  rows: readonly Row[],
  rules: readonly KeepRule[],
  whenUnsure: "pick" | "skip",
): readonly Row[] {
  if (rules.length === 0) {
    return [];
  }
  return rows.filter((row) => matchesAny(row, rules, whenUnsure === "pick"));
}
