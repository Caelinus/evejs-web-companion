// Flying-distance preferences — the warp / orbit / keep-at-range distances,
// shared between the Settings panel (where you pick them) and the Overview
// command bar (where they are used on the thing you have selected). A plain
// Svelte store so both read it reactively, persisted locally per browser.
import { writable } from "svelte/store";

export interface RangeChoice {
  readonly metres: number;
  readonly label: string;
}

// Retail's warp-range menu, and retail's own default: right on top.
export const WARP_RANGES: readonly RangeChoice[] = [
  { metres: 0, label: "As close as it can" },
  { metres: 10000, label: "10 km" },
  { metres: 20000, label: "20 km" },
  { metres: 30000, label: "30 km" },
  { metres: 50000, label: "50 km" },
  { metres: 70000, label: "70 km" },
  { metres: 100000, label: "100 km" },
];

// Orbit / keep-at-range distances, defaulting to retail's 1000 m.
export const HOLD_RANGES: readonly RangeChoice[] = [
  { metres: 500, label: "500 m" },
  { metres: 1000, label: "1 km" },
  { metres: 2500, label: "2.5 km" },
  { metres: 5000, label: "5 km" },
  { metres: 10000, label: "10 km" },
  { metres: 20000, label: "20 km" },
  { metres: 30000, label: "30 km" },
];

export interface FlyingDistances {
  readonly warp: string;
  readonly orbit: string;
  readonly hold: string;
}

const DEFAULTS: FlyingDistances = { warp: "0", orbit: "1000", hold: "1000" };
const STORAGE_KEY = "evejs-web-flying-distances";

/**
 * A range's label, read BACK OUT of the fixed menu — never formatted from the
 * raw metre count, which is how "10 km" turns into "10.0 km" or "10000".
 *
 * A value that is not on the menu is a CUSTOM one (see `isRangeMetres`), and it
 * is named rather than dashed: `ui/spaceRanges.ts` owns that formatting, and
 * this file does not import it because the dependency runs the other way.
 * Callers that can show a custom range pass their own `fallback`.
 */
export function rangeLabel(
  choices: readonly RangeChoice[],
  metres: string,
  fallback: (metres: string) => string = () => "—",
): string {
  return choices.find((choice) => String(choice.metres) === metres)?.label ?? fallback(metres);
}

function isChoice(choices: readonly RangeChoice[], value: unknown): value is string {
  return typeof value === "string" && choices.some((choice) => String(choice.metres) === value);
}

/**
 * A stored orbit / keep-at-range distance that is not on the ladder.
 *
 * ⚠ WHY THE LADDER IS NO LONGER THE VALIDATOR for these two. The in-space
 * redesign lets a player type a custom distance on the action itself. Validating
 * the stored value against the fixed menu would accept that number until the
 * next reload and then silently drop it back to 1 km — the worst kind of
 * setting, one that works until you stop watching it.
 *
 * Warp is deliberately left on its menu: nothing offers a custom warp range.
 */
function isRangeMetres(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    return false;
  }
  const metres = Number(value);
  return Number.isFinite(metres) && metres > 0 && metres <= 500_000;
}

function load(): FlyingDistances {
  if (typeof localStorage === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      warp: isChoice(WARP_RANGES, parsed.warp) ? parsed.warp : DEFAULTS.warp,
      orbit: isRangeMetres(parsed.orbit) ? parsed.orbit : DEFAULTS.orbit,
      hold: isRangeMetres(parsed.hold) ? parsed.hold : DEFAULTS.hold,
    };
  } catch {
    return DEFAULTS;
  }
}

export const flyingDistances = writable<FlyingDistances>(load());

// Persist every change (best-effort). The subscriber lives for the app's life —
// this is a single global preference, so it is never torn down.
flyingDistances.subscribe((value) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // A full or blocked store costs persistence across reloads, not the setting.
  }
});

/** Set one distance without disturbing the others. */
export function setDistance(key: keyof FlyingDistances, metres: string): void {
  flyingDistances.update((current) => ({ ...current, [key]: metres }));
}
