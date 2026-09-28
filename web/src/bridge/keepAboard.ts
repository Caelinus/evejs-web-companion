// What stays on the ship when a block empties it.
//
// ── WHY BAY-LEVEL PROTECTION IS NOT ENOUGH ─────────────────────────────────
//
// `bayRouting.ts` can keep a whole bay out of an unload, which answers "leave my
// ammo hold alone". It cannot answer "leave my spare mining crystals alone",
// because those sit in the CARGO hold beside the ore and salvage the trip was
// actually for. The cargo hold is the one place where which-bay tells you
// nothing about keep-or-unload, so the only thing that can separate them is the
// item itself.
//
// ── MATCHED ON WHAT THE SERVER SAID IT IS ──────────────────────────────────
//
// A rule names a typeID or a groupID — the game's own classification, as it
// arrives on the row. Never a name pattern (R47, the rule EquipmentArg and
// OreFamilyArg already follow): names are localised, renamed and ambiguous, and
// a bot that keeps "everything called Veldspar" is one patch away from keeping
// nothing.
//
// A GROUP rule is the one worth reaching for. Every grade and variant of a
// mining crystal shares a group, so one entry covers the lot, where a typeID
// list would need a dozen and would silently miss the thirteenth.

/** One rule: an exact type, or every item of a kind. */
export type KeepRule =
  | { readonly match: "type"; readonly typeID: number }
  | { readonly match: "group"; readonly groupID: number };

/**
 * Does this row stay aboard?
 *
 * ⚠ `whenUnsure` IS NOT A DETAIL, AND THE TWO CALLERS WANT OPPOSITE ANSWERS.
 * A row whose groupID could not be read cannot be tested against a group rule.
 * What to do about that depends entirely on what happens to the row next:
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
  row: { readonly typeID: number; readonly groupID: number | null },
  keep: readonly KeepRule[],
  whenUnsure: "keep" | "move",
): boolean {
  if (keep.length === 0) {
    return false;
  }
  let hasGroupRule = false;
  for (const rule of keep) {
    if (rule.match === "type") {
      if (rule.typeID === row.typeID) {
        return true;
      }
      continue;
    }
    hasGroupRule = true;
    if (row.groupID !== null && rule.groupID === row.groupID) {
      return true;
    }
  }
  // Only a GROUP rule can be defeated by an unreadable groupID; a type rule
  // always has a typeID to test against, so an unclassifiable row is only
  // genuinely undecidable when the list asks about kinds.
  if (hasGroupRule && row.groupID === null) {
    return whenUnsure === "keep";
  }
  return false;
}

/** The rows a block may move, with everything the rules protect held back. */
export function movableRows<Row extends { readonly typeID: number; readonly groupID: number | null }>(
  rows: readonly Row[],
  keep: readonly KeepRule[],
  whenUnsure: "keep" | "move",
): readonly Row[] {
  if (keep.length === 0) {
    return rows;
  }
  return rows.filter((row) => !staysAboard(row, keep, whenUnsure));
}
