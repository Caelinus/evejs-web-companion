// What a grid picker offers, and how a filter narrows it.
//
// Pure, so the one rule that matters can be tested without a DOM: a pick that
// is no longer on the list has to be DROPPED. The grid changes every poll — a
// rock is mined out, a ship warps off — and a control still armed with a
// vanished id fails as a refusal for something the player can no longer see.

import { formatDistance } from "../space/overview.ts";
import type { OverviewRow } from "../space/overview.ts";

/** One thing that can be picked. `hint` is the trailing detail — a range, a system. */
export interface PickOption {
  readonly id: number;
  readonly label: string;
  readonly hint?: string;
}

/** The options whose label or hint contains `needle`. Empty needle keeps all. */
export function filterOptions(
  options: readonly PickOption[],
  needle: string,
): readonly PickOption[] {
  const trimmed = needle.trim().toLowerCase();
  if (trimmed.length === 0) {
    return options;
  }
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(trimmed) ||
      (option.hint ?? "").toLowerCase().includes(trimmed),
  );
}

/**
 * The pick to keep, given what is currently offered.
 *
 * ⚠ ZERO IS THE ONLY OTHER ANSWER. A pick still in the list survives; anything
 * else becomes "nothing picked" rather than being carried silently, because a
 * control armed with an id the server can no longer act on produces a refusal
 * for a thing that is not on screen any more.
 */
export function keepPick(value: number, offered: readonly PickOption[]): number {
  return offered.some((option) => option.id === value) ? value : 0;
}

/**
 * Grid rows as pickable options — named, with their range as the hint.
 *
 * ⚠ NAMES ONLY (R7d). A row we cannot name is offered as what KIND of thing it
 * is; it is never offered as its id, which is the whole reason this picker
 * exists. A row with no name and no type name is left out entirely rather than
 * listed as "Unknown object" three times over.
 */
export function rowOptions(
  rows: readonly OverviewRow[],
  nameOf: (row: OverviewRow) => string,
): readonly PickOption[] {
  const options: PickOption[] = [];
  for (const row of rows) {
    const label = nameOf(row).trim();
    if (label.length === 0) {
      continue;
    }
    options.push({ id: row.itemID, label, hint: formatDistance(row.distance) });
  }
  return options;
}
