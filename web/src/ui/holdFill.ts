// HOW FULL A HOLD IS, in words and as a fraction.
//
// Lifted out of `Mining.svelte` when the HUD grew a cargo readout. Two places
// answering "how full is the ore hold" from two private copies of the same
// arithmetic is two places to get `null` wrong in — and getting `null` wrong
// here is the expensive kind:
//
// ⚠ ABSENT ≠ EMPTY ≠ UNKNOWN, AND THIS FILE IS WHERE THAT IS ENFORCED.
//
//   • A hull that HAS no ore hold is `present: false` and is not drawn at all.
//   • A hold the ship did not measure has `capacity: null`, and reads "not
//     known". It NEVER reads 0, and it never draws an empty bar: an empty bar
//     is how a player decides they have room for another twenty minutes of
//     mining, and they would be wrong.
//   • A hold that measured as empty is 0 of N, which is a fact and looks like
//     one.
//
// Everything here is pure, so the distinction is a thing a test can hold rather
// than something you have to fly a ship to observe.

import type { MiningHold } from "../store/types.ts";

/**
 * A hold's fill, as the SERVER reported it.
 *
 * "not known" rather than 0 for anything the ship did not say — see the header.
 */
export function holdCapacityText(hold: MiningHold): string {
  const capacity = hold.capacity;
  if (!capacity || capacity.capacity === null) {
    return "not known";
  }
  const used = capacity.used === null ? null : capacity.used;
  if (used === null) {
    // The size is known and the contents are not. Say the half that is real
    // rather than implying the bay is empty.
    return `holds ${capacity.capacity.toLocaleString()} m³`;
  }
  return `${used.toLocaleString()} of ${capacity.capacity.toLocaleString()} m³`;
}

/**
 * How full, 0-100, or null when there is no reading to draw.
 *
 * ⚠ NULL IS NOT 0. A caller that draws a bar must draw NOTHING for a null, and
 * say "not known" beside it in words.
 */
export function holdFillPercent(hold: MiningHold): number | null {
  const capacity = hold.capacity;
  if (!capacity || capacity.capacity === null || capacity.used === null || capacity.capacity <= 0) {
    return null;
  }
  return Math.min(100, Math.round((capacity.used / capacity.capacity) * 100));
}

/**
 * The holds this hull actually has.
 *
 * ⚠ `present: false` IS A HULL FACT, NOT A READING. A frigate with no ore hold
 * must not show an ore hold at all — an "Ore hold — not known" row would have a
 * player looking for a bay that does not exist.
 */
export function presentHolds(holds: readonly MiningHold[]): readonly MiningHold[] {
  return holds.filter((hold) => hold.present);
}

/** How full, in one short phrase — for a readout with no room for the m³. */
export function holdFillShort(hold: MiningHold): string {
  const percent = holdFillPercent(hold);
  return percent === null ? "not known" : `${percent}%`;
}

/**
 * The band a fill falls in: "" under 70%, "warn" under 90%, "full" above.
 *
 * ⚠ IT IS PAIRED WITH THE PERCENTAGE EVERYWHERE IT IS USED, never on its own.
 * A colour is the glance; the number is the reading. And an unknown fill has no
 * band at all rather than a reassuring one.
 */
export function holdFillBand(hold: MiningHold): "" | "warn" | "full" {
  const percent = holdFillPercent(hold);
  if (percent === null) {
    return "";
  }
  return percent >= 90 ? "full" : percent >= 70 ? "warn" : "";
}
