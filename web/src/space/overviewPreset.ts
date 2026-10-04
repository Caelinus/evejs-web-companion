// WHICH OVERVIEW PRESET IS SELECTED (goal R79).
//
// Shared for the same reason the selection is (`space/selection.ts`): the
// overview list and the tactical viewport must show the same slice of the grid.
// A player who switches to Mining and then looks at the picture would otherwise
// find rats and stargates still drawn on it, and would have no way to tell
// whether the tab had worked.
//
// It also has to survive a REMOUNT. The overview is a window a player can close
// and reopen, and it is separately mounted as the fixed dock panel; component
// state would reset to All every time either happened, which reads as the
// setting not sticking.
//
// ⚠ VIEW STATE, SO NOT IN THE CLIENT STORE. The store holds what the SERVER
// reports; which tab a player is looking through is a thing they are doing with
// their eyes. Keeping it out means a snapshot poll can never clobber it.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import { DEFAULT_PRESET, presetByID, type OverviewPreset, type OverviewPresetID } from "./overviewPresets.ts";

export interface OverviewPresetChoice {
  readonly id: ReadableSignal<OverviewPresetID>;
  /** The resolved preset, so callers do not each look it up. */
  readonly preset: ReadableSignal<OverviewPreset>;
  choose(id: OverviewPresetID): void;
}

export function createOverviewPresetChoice(): OverviewPresetChoice {
  const id = createSignal<OverviewPresetID>(DEFAULT_PRESET);
  const preset = createSignal<OverviewPreset>(presetByID(DEFAULT_PRESET));
  return {
    id: readonlySignal(id),
    preset: readonlySignal(preset),
    choose: (next: OverviewPresetID): void => {
      const resolved = presetByID(next);
      // Resolve first, then publish BOTH from the resolved value, so the id and
      // the preset can never describe different tabs — an unrecognised id falls
      // back to All in both rather than leaving one of them pointing at nothing.
      id.set(resolved.id);
      preset.set(resolved);
    },
  };
}

/** The app's one preset choice. */
export const overviewPreset: OverviewPresetChoice = createOverviewPresetChoice();
