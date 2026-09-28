// The distance a ranged flight verb flies at — orbit and keep-at-range — as a
// pure model, so the picker that chooses it and the runner that uses it cannot
// come to disagree.
//
// ⚠ THERE IS EXACTLY ONE PLACE THIS IS STORED, AND IT IS NOT NEW.
//
// `ui/flyingDistances.ts` already holds warp / orbit / hold, persisted per
// browser, read by the Overview's dispatch, by the radial menu and by the
// tactical viewport, and picked in Settings. The in-space redesign moves the
// PICKING to a `▾` on the Orbit and Keep buttons themselves — which is a better
// place for it — but it writes through to the same store. A second, panel-local
// "session" range would mean the button and Settings could quietly disagree
// about how far this ship orbits, and the player would have no way to tell
// which one the ship was about to obey.
//
// So this module is the vocabulary between the two: which stored key an action
// uses, what the ladder offers, how a typed value is read, and how any value —
// on the ladder or not — is named.

import { HOLD_RANGES, type RangeChoice } from "./flyingDistances.ts";

/** The two verbs that fly at a chosen distance. `align` and `approach` do not. */
export type RangeKind = "orbit" | "keep";

/**
 * Which `FlyingDistances` field a kind is stored under.
 *
 * ⚠ The names do not match, and that is not worth "fixing". `keep` is stored as
 * `hold` because that is what the field has always been called and what
 * `rowActionRunner` reads for `keepAtRange`; renaming it would silently reset
 * every player's stored distance, since the loader drops fields it cannot name.
 */
export function rangeStorageKey(kind: RangeKind): "orbit" | "hold" {
  return kind === "orbit" ? "orbit" : "hold";
}

/**
 * The ladder a picker offers.
 *
 * The handoff asks for 1 / 5 / 10 / 20 km; the app already offers 500 m, 1,
 * 2.5, 5, 10, 20 and 30 km. The app's ladder is a strict SUPERSET, so there is
 * nothing to merge — dropping to the handoff's four would only take choices
 * away from a player who already has them.
 */
export const RANGE_PRESETS: readonly RangeChoice[] = HOLD_RANGES;

/** One kilometre, in metres. The unit a player types a custom range in. */
const METRES_PER_KM = 1000;

/**
 * The largest range worth accepting, in metres. Well past any hold a ship can
 * keep, and short of the point where a typo becomes a warp.
 *
 * ⚠ This is a SANITY BOUND, not a game rule. The server decides what a ship can
 * actually hold; this only stops "100000" typed into a kilometre field from
 * being stored as 100,000 km.
 */
export const MAX_RANGE_METRES = 500_000;

/**
 * A custom range typed in KILOMETRES, as metres — or null when it is not a
 * range at all.
 *
 * Blank, zero, negative, non-numeric and absurd all read as null, which the
 * caller shows as "that is not a distance" rather than storing. Fractions are
 * allowed (2.5 km is on the ladder), and the result is rounded to whole metres
 * because that is the unit the bridge takes.
 */
export function parseCustomRange(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") {
    return null;
  }
  const km = Number(trimmed);
  if (!Number.isFinite(km) || km <= 0) {
    return null;
  }
  const metres = Math.round(km * METRES_PER_KM);
  return metres > 0 && metres <= MAX_RANGE_METRES ? metres : null;
}

/**
 * Whether a metre count is one of the ladder's own steps. A picker highlights
 * the chip it matches, and offers the custom field as the answer when it does
 * not.
 */
export function isPresetRange(metres: number): boolean {
  return RANGE_PRESETS.some((choice) => choice.metres === metres);
}

/**
 * What a range is CALLED.
 *
 * ⚠ A LADDER VALUE IS NAMED BY THE LADDER, NOT FORMATTED. "10 km" formatted from
 * 10000 becomes "10.0 km" or "10000" depending on who writes the formatter, and
 * the app already has one right answer for the seven steps it offers. Only a
 * custom value is formatted, and then as briefly as it can be read: metres
 * under a kilometre, kilometres above, with no trailing zero.
 */
export function rangeName(metres: number): string {
  const step = RANGE_PRESETS.find((choice) => choice.metres === metres);
  if (step) {
    return step.label;
  }
  if (!Number.isFinite(metres) || metres <= 0) {
    return "—";
  }
  if (metres < METRES_PER_KM) {
    return `${Math.round(metres)} m`;
  }
  const km = metres / METRES_PER_KM;
  return `${Number(km.toFixed(1))} km`;
}

/**
 * The action button's own label — "ORBIT 5 KM". The distance is on the control
 * that will fly it, so pressing it is never a question about which distance is
 * currently remembered.
 */
export function rangeActionLabel(verb: string, metres: number): string {
  return `${verb} ${rangeName(metres)}`;
}

/**
 * A stored distance read back as a number. `flyingDistances` keeps strings
 * because it grew out of `<select>` values; every caller wants metres.
 *
 * ⚠ An unreadable stored value falls back to `fallback` rather than to 0. A
 * zero-metre orbit is a real instruction — fly into it — and must never be
 * something the app arrives at by failing to parse.
 */
export function storedRangeMetres(stored: string, fallback: number): number {
  const metres = Number(stored);
  return Number.isFinite(metres) && metres > 0 ? metres : fallback;
}
