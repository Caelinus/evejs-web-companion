// How much of a stack fits in a hold. Pure arithmetic over a stack's per-unit
// volume and a hold's free space, so the browser can move exactly what fits
// instead of asking the server to move the whole stack and be refused.
//
// The design rule the operator set: the SERVER judges validity (can this type go
// in this hold at all). This module only decides the QUANTITY, and only when it
// has the numbers — with an unknown volume or an unread capacity it hands the
// whole stack over and lets the server draw the line, never inventing a smaller
// number from missing data.

/** Free m³ in a hold, or null when its capacity has not been read. Never negative. */
export function holdFreeM3(capacity: { readonly capacity: number; readonly used: number } | null | undefined): number | null {
  if (capacity === null || capacity === undefined) {
    return null;
  }
  const free = capacity.capacity - capacity.used;
  return Number.isFinite(free) ? Math.max(0, free) : null;
}

/**
 * How many units of a stack fit in `freeM3` of hold space.
 *
 *   • `quantity`   — units in the stack (the ceiling; we never move more).
 *   • `unitVolume` — m³ per unit, or null/undefined when the static tables do not
 *                    know the type.
 *   • `freeM3`     — the hold's free space in m³, or null when unread.
 *
 * Unknown volume OR unknown free space ⇒ return the WHOLE quantity and let the
 * server judge the fit. Otherwise floor(free / unitVolume), clamped to [0, quantity].
 */
export function unitsThatFit(
  quantity: number,
  unitVolume: number | null | undefined,
  freeM3: number | null,
): number {
  if (!(quantity > 0)) {
    return 0;
  }
  if (
    unitVolume === null ||
    unitVolume === undefined ||
    !(unitVolume > 0) ||
    freeM3 === null ||
    !Number.isFinite(freeM3)
  ) {
    return quantity; // not enough info to compute a fit — the server decides
  }
  const fits = Math.floor(freeM3 / unitVolume);
  return Math.max(0, Math.min(quantity, fits));
}

/**
 * What of `rows` a hold with `freeM3` of room can actually take.
 *
 * ⚠ WHY THIS EXISTS. A transfer is all-or-nothing PER STACK, so asking for a
 * stack bigger than the free space is refused outright — the whole thing, not
 * the part that would have fitted. A bot looting a can holding more than it can
 * carry therefore took NOTHING, was refused, and asked again on the next tick,
 * for ever. Taking a load at a time and coming back is what drains the can.
 *
 * The four buckets are deliberately distinct, because they need different calls
 * and have different failure modes:
 *
 *   • `whole`    — stacks that fit entire. One MultiAdd.
 *   • `split`    — the ONE stack that straddles the boundary, with how many
 *                  units of it fit. A separate Add, because the bridge refuses a
 *                  quantity when more than one stack is named (INVALID_SPLIT).
 *                  At most one: past it the hold is full by construction.
 *   • `unknown`  — volume not in the static tables. Kept SEPARATE so that a
 *                  refusal on these cannot take the computed stacks down with
 *                  it; the server judges them, which is holdFit's standing rule.
 *   • `deferred` — does not fit at all. Left where it is, for the next trip.
 *
 * `freeM3 === null` means the hold's capacity could not be read, so nothing can
 * be computed: every row becomes `unknown` and the server decides, exactly as it
 * did before this function existed.
 */
export interface FitSelection<Row> {
  readonly whole: readonly Row[];
  readonly split: { readonly row: Row; readonly quantity: number } | null;
  readonly unknown: readonly Row[];
  readonly deferred: readonly Row[];
}

export function fitWithin<Row extends { readonly quantity: number; readonly volume?: number | null }>(
  rows: readonly Row[],
  freeM3: number | null,
): FitSelection<Row> {
  if (freeM3 === null || !Number.isFinite(freeM3)) {
    return { whole: [], split: null, unknown: [...rows], deferred: [] };
  }
  const whole: Row[] = [];
  const unknown: Row[] = [];
  const deferred: Row[] = [];
  let split: { row: Row; quantity: number } | null = null;
  let remaining = Math.max(0, freeM3);

  for (const row of rows) {
    const unit = row.volume;
    if (unit === null || unit === undefined || !(unit > 0)) {
      unknown.push(row);
      continue;
    }
    const stack = unit * row.quantity;
    if (stack <= remaining) {
      whole.push(row);
      remaining -= stack;
      continue;
    }
    // Too big for what is left. One stack may still be split into it; after
    // that there is nothing worth measuring, so the rest waits for a trip with
    // an empty hold.
    if (split === null) {
      const fits = unitsThatFit(row.quantity, unit, remaining);
      if (fits > 0) {
        split = { row, quantity: fits };
        remaining -= fits * unit;
        continue;
      }
    }
    deferred.push(row);
  }
  return { whole, split, unknown, deferred };
}
