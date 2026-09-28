// THE GLOBAL WINDOW — the one window that does not belong to a pilot.
//
// Every other panel is a view of ONE character's store, so it is right that
// switching pilots tears it down: App mounts a Workspace per active pilot under
// a `{#key active.id}`, and the desktop, its windows and their saved layout all
// live inside that. The Bot Manager is the exception, and not by preference:
//
//   • its pilots region is a table of EVERY held session plus every character
//     with a server bot and no session here — it is a view of the roster, not
//     of a pilot;
//   • its library is the account-wide saved-bot list, the same rows whichever
//     pilot is active;
//   • and a bot it is watching keeps flying while you switch away. Being torn
//     down mid-run is not a cosmetic loss: the roster refetches from scratch,
//     the search box empties, an open export box closes, and — because the
//     poll restarts — a server bot's alert can go unseen through the gap.
//
// So it is hoisted ABOVE that key, into App, and lives on its own layer over
// whichever workspace is showing. This module is that window's model: which
// tabs get this treatment, and where the one window sits. Pure data, same
// shape and the same storage discipline as desktop.ts, whose `WinState` it
// deliberately reuses so DesktopWindow.svelte can draw it with no special case.
//
// ⚠ DESKTOP ONLY. A phone has no floating windows at all — MobileWorkspace is
// one panel at a time — so there is nothing for this layer to hold there and
// App does not mount it. On mobile the Bot Manager is a panel selection like
// any other; see App.svelte.

// ⚠ A TYPE-ONLY IMPORT FROM desktop.ts, AND IT HAS TO STAY ONE. desktop.ts
// imports `isGlobalTab` from here, so the two modules form a cycle; a type is
// erased and cannot participate in one, but a VALUE read at module init could —
// pulling desktop.ts's `DEFAULT_W` into the constants below would evaluate it
// before desktop.ts had finished initialising whenever that module loads first.
// Hence the sizes below are written out rather than derived from its defaults.
import type { WinState } from "./desktop.ts";
import type { TabID } from "./tabs.ts";

/**
 * The tabs that open as THE global window rather than a workspace window.
 *
 * ⚠ A SET, FOR ONE MEMBER, ON PURPOSE. The rule "is this tab global?" is asked
 * in four places (the rail's open-state, both open paths in Workspace, and
 * desktop.ts's guard); a set makes adding a second one a single edit here
 * instead of four `=== "botManager"` comparisons to find and keep in step.
 */
export const GLOBAL_TABS: ReadonlySet<TabID> = new Set<TabID>(["botManager"]);

/** True when this tab opens as the global window, not a workspace window. */
export function isGlobalTab(id: TabID): boolean {
  return GLOBAL_TABS.has(id);
}

/**
 * Where the global window first appears: offset from the top-left of its layer,
 * and roomier than a default workspace window because its first region is a
 * five-column table of pilots.
 */
export const DEFAULT_GLOBAL_POS = { x: 64, y: 48 };
const DEFAULT_GLOBAL_W = 720;
const DEFAULT_GLOBAL_H = 520;

/**
 * Open `id` as the global window, keeping where it already sat if it is the
 * same window reopening. `z` is a constant: there is one window on this layer,
 * so there is no stack to order — the field exists only because `WinState` is
 * shared with the desktop model.
 */
export function openGlobal(current: WinState | null, id: TabID): WinState {
  if (current !== null && current.id === id) {
    // Reopening what is already open un-puts-it-away rather than moving it —
    // the rail entry is a toggle onto a window that may simply be in the strip.
    return { ...current, minimized: false };
  }
  return {
    id,
    x: DEFAULT_GLOBAL_POS.x,
    y: DEFAULT_GLOBAL_POS.y,
    w: DEFAULT_GLOBAL_W,
    h: DEFAULT_GLOBAL_H,
    z: 1,
    minimized: false,
  };
}

// ── persistence ────────────────────────────────────────────────────────────
//
// ⚠ NOT KEYED BY CHARACTER, AND THAT IS THE WHOLE POINT. desktop.ts stores a
// layout per characterID because a desktop belongs to a pilot. This window does
// not belong to one, so a per-character key would give a player one Bot Manager
// position per pilot — the same window jumping around as they switch, which is
// exactly the behaviour being removed.

const STORAGE_KEY = "evejs-web-global-window:v1";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Read the saved global window, or null when there is none or it is unusable.
 *
 * Rebuilt field by field rather than spread, for desktop.ts's reason: a stale
 * key riding in on a `{ ...parsed }` is written straight back out on the next
 * save and lives forever. An id that is no longer global is dropped — that is
 * the migration path if a tab ever leaves `GLOBAL_TABS`.
 */
export function loadGlobalWindow(): WinState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object") return null;
    const w = o as Record<string, unknown>;
    if (typeof w.id !== "string" || !isGlobalTab(w.id as TabID)) return null;
    if (!isFiniteNumber(w.x) || !isFiniteNumber(w.y) || !isFiniteNumber(w.w) || !isFiniteNumber(w.h)) {
      return null;
    }
    return {
      id: w.id as TabID,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      z: 1,
      minimized: w.minimized === true,
    };
  } catch {
    return null;
  }
}

/** Persist the global window (null clears it). Best-effort, never fatal. */
export function saveGlobalWindow(win: WinState | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (win === null) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(win));
    }
  } catch {
    // storage full or blocked — window persistence is best-effort.
  }
}
